"""
Feedback Edit API Lambda - Handles PUT /feedback/{id}/category and PUT /feedback/{id}/dimensions.

Lets a user correct the category a review was filed under, from the UI or via
the AI assistant's approval-gated ``set_feedback_category`` tool. A separate
Lambda from the read-only metrics API so the write grant on the feedback table
stays off every read path (least privilege, 20 KB policy limit).

The edit is an in-place, conditional ``update_item`` — never a delete or a new
item. It keeps the item's keys and ``gsi2sk`` and moves only ``gsi2pk``; the
aggregator's MODIFY path rebuckets the per-category counters. The previous
value and who changed it are recorded in ``category_override``.

Rules:
- the caller must be able to see the item's CURRENT category and the NEW one
  (``shared.category_access``), else 404 — the same answer as a missing item;
- the new category must exist in the categories config (400), and a given
  subcategory must belong to it when the category lists subcategories (400);
- a concurrent change of the category between the read and the write is 409.
"""

from collections.abc import Mapping
from typing import Any

from boto3.dynamodb.conditions import Attr, ConditionBase, Key
from botocore.exceptions import BotoCoreError, ClientError

from shared import category_access
from shared.api import api_handler, create_api_resolver
from shared.category_access import CategoryScope
from shared.category_gate import scope_for_caller
from shared.category_override import public_override
from shared.dimension_config import load_dimensions_config, validate_tags
from shared.exceptions import ConfigurationError, NotFoundError, ServiceError, ValidationError
from shared.feedback_category import (
    CATEGORY_SOURCE_MANUAL,
    apply_conditional_update,
    categories_config,
    category_change,
    category_label,
    item_exists,
    override_record,
    update_expression,
    validate_target,
)
from shared.feedback_dimensions import apply_dimension_edit
from shared.indexes import FEEDBACK_BY_ID_INDEX
from shared.logging import logger, tracer
from shared.project_gate import caller_from_event
from shared.request_body import json_body_value
from shared.tables import get_aggregates_table, get_feedback_table

FEEDBACK_NOT_FOUND = 'Feedback not found'

app = create_api_resolver()


def _tables() -> tuple[Any, Any]:
    feedback_table, aggregates_table = get_feedback_table(), get_aggregates_table()
    if not feedback_table or not aggregates_table:
        raise ConfigurationError('Feedback tables not configured')
    return feedback_table, aggregates_table


def _current_item(feedback_table: Any, feedback_id: str) -> dict:
    """The item with ``feedback_id``, strongly read from the base table, or 404."""
    try:
        hits = feedback_table.query(
            IndexName=FEEDBACK_BY_ID_INDEX,
            KeyConditionExpression=Key('feedback_id').eq(feedback_id),
            Limit=1,
        ).get('Items', [])
        if not hits:
            raise NotFoundError(FEEDBACK_NOT_FOUND)
        key = {'pk': hits[0]['pk'], 'sk': hits[0]['sk']}
        item = feedback_table.get_item(Key=key, ConsistentRead=True).get('Item')
    except (ClientError, BotoCoreError) as exc:
        logger.exception('Feedback read failed')
        raise ServiceError('Could not read feedback. Please retry.') from exc
    if not item:
        raise NotFoundError(FEEDBACK_NOT_FOUND)
    return item


def _require_visible(scope: CategoryScope, item: Mapping[str, Any], new_category: str) -> None:
    if not category_access.admits_item(scope, item) or not category_access.admits(scope, new_category):
        raise NotFoundError(FEEDBACK_NOT_FOUND)


def _update_kwargs(item: Mapping[str, Any], category: str, subcategory: str | None, override: dict) -> dict:
    """The conditional ``update_item`` that moves ``item`` to ``category`` (``shared.feedback_category``)."""
    change = category_change(item, category, subcategory, override)
    return {
        'Key': {'pk': item['pk'], 'sk': item['sk']},
        'UpdateExpression': update_expression(change.sets, change.removes),
        'ConditionExpression': change.condition,
        'ExpressionAttributeNames': change.names,
        'ExpressionAttributeValues': change.values,
        'ReturnValues': 'ALL_NEW',
    }


@app.put('/feedback/<feedback_id>/category')
@tracer.capture_method
def set_feedback_category(feedback_id: str):
    """Correct one review's category: ``{category, subcategory?}``."""
    event = app.current_event.raw_event
    caller = caller_from_event(event)
    body = json_body_value(app)
    if not isinstance(body, dict):
        raise ValidationError('Request body must be a JSON object')
    category = category_label(body.get('category'), 'category', required=True)
    subcategory = category_label(body.get('subcategory'), 'subcategory', required=False)
    feedback_table, aggregates_table = _tables()

    scope = scope_for_caller(caller, aggregates_table)
    item = _current_item(feedback_table, feedback_id)
    _require_visible(scope, item, category)
    validate_target(categories_config(aggregates_table), category, subcategory)

    override = override_record(item, caller)
    updated = apply_conditional_update(feedback_table, _update_kwargs(item, category, subcategory, override))

    return {
        'success': True,
        'feedback': {
            'feedback_id': feedback_id,
            'category': updated.get('category', category),
            'subcategory': updated.get('subcategory'),
            'category_source': updated.get('category_source', CATEGORY_SOURCE_MANUAL),
            # Projected here AND by the resolver-wide sanitiser: never `by_sub`.
            'category_override': public_override(updated.get('category_override', override)),
        },
    }


@app.put('/feedback/<feedback_id>/dimensions')
@tracer.capture_method
def set_feedback_dimensions(feedback_id: str):
    """Correct one review's dimensions and/or tags: ``{dimensions?: {key: value|null}, tags?: [str]}``.

    Each edited key becomes ``dimension_sources[key] = 'manual'`` (a re-inference
    never overwrites it); null removes it. ``tags`` replaces the list. 400 on an
    unknown key/value, 404 when the review is not visible to the caller, 409 when
    its dimensions or tags changed since they were read.
    """
    event = app.current_event.raw_event
    caller = caller_from_event(event)
    edits, tags = _dimensions_body(json_body_value(app))
    feedback_table, aggregates_table = _tables()

    scope = scope_for_caller(caller, aggregates_table)
    item = _current_item(feedback_table, feedback_id)
    if not category_access.admits_item(scope, item):
        raise NotFoundError(FEEDBACK_NOT_FOUND)
    try:
        dimensions, sources = apply_dimension_edit(_dimensions_config(aggregates_table), item, edits)
    except ValueError as exc:
        raise ValidationError(str(exc)) from exc
    new_tags = item.get('tags') if tags is None else tags
    updated = apply_conditional_update(feedback_table, _dimensions_update_kwargs(item, dimensions, sources, new_tags))
    return {
        'success': True,
        'feedback_id': feedback_id,
        'dimensions': updated.get('dimensions', {}),
        'tags': updated.get('tags', []),
    }


def _dimensions_body(body: object) -> tuple[dict[str, Any], list[str] | None]:
    """``(dimension edits, new tags or None)`` from the request body, or 400."""
    if not isinstance(body, dict):
        raise ValidationError('Request body must be a JSON object')
    edits = body.get('dimensions', {})
    if not isinstance(edits, dict):
        raise ValidationError('dimensions must be an object of dimension keys to a value or null')
    raw_tags = body.get('tags')
    if not edits and raw_tags is None:
        raise ValidationError('Nothing to change: send dimensions and/or tags')
    try:
        tags = None if raw_tags is None else validate_tags(raw_tags)
    except ValueError as exc:
        raise ValidationError(str(exc)) from exc
    return edits, tags


def _dimensions_config(aggregates_table: Any) -> list[dict]:
    """The dimensions config on this write path; a corrupt stored row is a 500."""
    try:
        return load_dimensions_config(aggregates_table)
    except ValueError as exc:
        logger.warning('Stored dimensions config is invalid')
        raise ServiceError('The dimensions configuration is invalid. Ask an admin to save it again.') from exc
    except (ClientError, BotoCoreError) as exc:
        logger.exception('Dimensions config read failed')
        raise ServiceError('Could not read the dimensions configuration. Please retry.') from exc


def _unchanged_since_read(item: Mapping[str, Any], field: str) -> ConditionBase:
    return Attr(field).eq(item[field]) if field in item else Attr(field).not_exists()


def _dimensions_update_kwargs(
    item: Mapping[str, Any], dimensions: dict, sources: dict, tags: object,
) -> dict:
    """The conditional in-place update; empty values are REMOVEd (the processor never stores them)."""
    names = {'#d': 'dimensions', '#ds': 'dimension_sources', '#t': 'tags'}
    values: dict[str, Any] = {}
    sets: list[str] = []
    removes: list[str] = []
    for alias, value in (('#d', dimensions), ('#ds', sources), ('#t', tags)):
        if value:
            values[f':{alias[1:]}'] = value
            sets.append(f'{alias} = :{alias[1:]}')
        else:
            removes.append(alias)
    condition = item_exists()
    for field in ('dimensions', 'dimension_sources', 'tags'):
        condition = condition & _unchanged_since_read(item, field)
    kwargs: dict[str, Any] = {
        'Key': {'pk': item['pk'], 'sk': item['sk']},
        'UpdateExpression': update_expression(sets, removes),
        'ConditionExpression': condition,
        'ExpressionAttributeNames': names,
        'ReturnValues': 'ALL_NEW',
    }
    if values:
        kwargs['ExpressionAttributeValues'] = values
    return kwargs


@api_handler
def lambda_handler(event: dict, context: Any) -> dict:
    """Main Lambda handler."""
    return app.resolve(event, context)
