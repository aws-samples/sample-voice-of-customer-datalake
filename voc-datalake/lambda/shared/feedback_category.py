"""One review's category change, shared by every path that can make one.

``PUT /feedback/{id}/category`` (feedback_edit_handler) and the admin data
explorer's ``PUT /data-explorer/feedback`` both move a review to another
category. Both MUST: validate the target against the categories config, move
``gsi2pk`` with the category (the by-category index would otherwise keep
serving the item under its old category, past the category-access filter),
record ``category_source='manual'`` plus a ``category_override`` audit, and be
conditional on the item still existing with the category that was read.

This module builds those pieces; callers run the ``update_item``. The stored
audit keeps the editor's Cognito ``by_sub``; the client projection lives in
``shared.category_override``.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any, Literal, overload

from boto3.dynamodb.conditions import Attr, ConditionBase
from botocore.exceptions import BotoCoreError, ClientError

from shared.api import DEFAULT_CATEGORIES
from shared.category_gate import read_categories_config
from shared.exceptions import ApiError, ConflictError, ServiceError, ValidationError
from shared.logging import logger
from shared.project_access import Caller

CATEGORY_SOURCE_MANUAL = 'manual'
MAX_LABEL_CHARS = 64

@overload
def category_label(value: object, key: str, *, required: Literal[True]) -> str: ...


@overload
def category_label(value: object, key: str, *, required: bool) -> str | None: ...


def category_label(value: object, key: str, *, required: bool) -> str | None:
    """A category/subcategory name, trimmed; None when absent/empty and optional; else 400."""
    if value is None or value == '':
        if required:
            raise ValidationError(f'{key} is required')
        return None
    text = value.strip() if isinstance(value, str) else ''
    if not 0 < len(text) <= MAX_LABEL_CHARS:
        raise ValidationError(f'{key} must be a string of 1-{MAX_LABEL_CHARS} characters')
    return text


def categories_config(aggregates_table: Any) -> list[dict]:
    """The configured categories, read fresh; the defaults when none are configured."""
    configured = read_categories_config(aggregates_table)
    return configured or [{'name': name} for name in DEFAULT_CATEGORIES]


def validate_target(config: list[dict], category: str, subcategory: str | None) -> None:
    """400 unless ``category`` is configured and ``subcategory`` (if any) belongs to it."""
    entry = next((c for c in config if c.get('name') == category), None)
    if entry is None:
        raise ValidationError('category is not a configured category')
    if subcategory is None:
        return
    subs = entry.get('subcategories')
    names = {s.get('name') for s in subs if isinstance(s, dict)} if isinstance(subs, list) else set()
    if names and subcategory not in names:
        raise ValidationError('subcategory does not belong to this category')


def override_record(item: Mapping[str, Any], caller: Caller) -> dict:
    """The stored audit of a manual change (keeps ``by_sub``; see ``shared.category_override``)."""
    return {
        'previous_category': item.get('category'),
        'previous_subcategory': item.get('subcategory'),
        'by_sub': caller.subject,
        'by_username': caller.username,
        'at': datetime.now(UTC).isoformat(),
    }


def item_exists() -> ConditionBase:
    """The guard on every in-place feedback edit: an update can never create an item."""
    return Attr('pk').exists()


@dataclass
class CategoryChange:
    """The ``SET``/``REMOVE`` clauses, names, values and condition of one category move."""

    sets: list[str] = field(default_factory=list)
    removes: list[str] = field(default_factory=list)
    names: dict[str, str] = field(default_factory=dict)
    values: dict[str, Any] = field(default_factory=dict)
    condition: ConditionBase | None = None


def category_change(
    item: Mapping[str, Any], category: str, subcategory: str | None, override: dict,
) -> CategoryChange:
    """Move ``item`` to ``category``/``subcategory`` (None removes it), conditionally.

    The condition holds only while the item exists and still has the category
    that was read — otherwise the write is a lost update (callers answer 409).
    Keys and ``gsi2sk`` are untouched; only ``gsi2pk`` moves.
    """
    change = CategoryChange(
        sets=['#cat_c = :cat_c', '#cat_g = :cat_g', '#cat_src = :cat_src', '#cat_o = :cat_o'],
        names={'#cat_c': 'category', '#cat_s': 'subcategory', '#cat_g': 'gsi2pk',
               '#cat_src': 'category_source', '#cat_o': 'category_override'},
        values={':cat_c': category, ':cat_g': f'CATEGORY#{category}',
                ':cat_src': CATEGORY_SOURCE_MANUAL, ':cat_o': override},
    )
    if subcategory is None:
        change.removes.append('#cat_s')
    else:
        change.sets.append('#cat_s = :cat_s')
        change.values[':cat_s'] = subcategory
    previous = item.get('category')
    change.condition = item_exists() & (
        Attr('category').eq(previous) if previous is not None else Attr('category').not_exists()
    )
    return change


def update_expression(sets: list[str], removes: list[str]) -> str:
    """``SET a, b REMOVE c`` from clause lists (either may be empty, not both)."""
    parts = [f"SET {', '.join(sets)}"] if sets else []
    if removes:
        parts.append(f"REMOVE {', '.join(removes)}")
    return ' '.join(parts)


LOST_UPDATE_MESSAGE = 'This review was changed by someone else. Reload and retry.'


def apply_conditional_update(
    feedback_table: Any, kwargs: dict, *, on_condition_failed: ApiError | None = None,
) -> dict:
    """Run a conditional ``update_item``; the new attributes.

    A failed condition raises ``on_condition_failed`` (default: 409, a lost
    update); any other failure is a 500 that never echoes the AWS error.
    """
    try:
        return feedback_table.update_item(**kwargs).get('Attributes', {})
    except (ClientError, BotoCoreError) as exc:
        code = exc.response.get('Error', {}).get('Code') if isinstance(exc, ClientError) else None
        if code == 'ConditionalCheckFailedException':
            raise (on_condition_failed or ConflictError(LOST_UPDATE_MESSAGE)) from exc
        logger.exception('Feedback update failed')
        raise ServiceError('Could not update the feedback. Please retry.') from exc
