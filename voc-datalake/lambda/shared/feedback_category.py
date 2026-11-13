"""One review's category change, shared by every path that can make one.

``PUT /feedback/{id}/category`` (feedback_edit_handler) and the admin data
explorer's ``PUT /data-explorer/feedback`` both move a review to another
category. Both MUST: validate the target against the categories config, move
``gsi2pk`` with the category (the by-category index would otherwise keep
serving the item under its old category, past the category-access filter),
record ``category_source='manual'`` plus a ``category_override`` audit, and be
conditional on the item still existing with the category that was read.

Every edit also keeps the item as it was (``keep_before_edit``, ``silver/`` in the raw
bucket) and stamps ``updated_by {sub, kind}``,
``updated_at`` and ``change_reason`` (``manual_edit_fields``).

This module builds those pieces; callers run the ``update_item``. The stored
audit keeps the editor's Cognito ``by_sub``; the client projection lives in
``shared.category_override``.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any, Literal, overload

from boto3.dynamodb.conditions import Attr, ConditionBase
from botocore.exceptions import BotoCoreError, ClientError

from shared.api import DEFAULT_CATEGORIES
from shared.category_gate import read_categories_config
from shared.exceptions import ApiError, ConflictError, ServiceError, ValidationError
from shared.feedback_partitions import category_partition
from shared.logging import logger
from shared.project_access import Caller
from shared.silver_provenance import change_stamp, fields_of_update, keep_silver_version
from shared.timestamps import now_iso
from shared.ws_repo import WorkspaceScope

CATEGORY_SOURCE_MANUAL = 'manual'
# What a category reprocess job stamps (lambda/jobs/category_reprocess); one home for the worker and the catalogue.
CATEGORY_SOURCE_REPROCESS = 'reprocess'
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


def _entry_for(entries: object, ref: str) -> dict | None:
    """The config entry whose ``name`` (preferred) or ``id`` is ``ref``."""
    rows = [e for e in entries if isinstance(e, dict)] if isinstance(entries, list) else []
    return next((e for e in rows if e.get('name') == ref), None) or next((e for e in rows if e.get('id') == ref), None)


def routed_names(config: list[dict], category: str, subcategory: str) -> tuple[str, str]:
    """``(category, subcategory)`` as the NAMES reviews store, given a form's stored routing.

    Before 5.25.00 the form editor stored the config entries' ``id`` (``cat_<uuid>`` for a
    category added on the Categories page), so those forms tagged submissions with an id no
    review filter matches. A stored id is mapped back to its entry's name; a name, or a
    value no entry knows (a since-removed category), is kept as it is.
    """
    entry = _entry_for(config, category) if category else None
    name = str(entry.get('name') or category) if entry else category
    sub_entry = _entry_for(entry.get('subcategories'), subcategory) if entry and subcategory else None
    sub_name = str(sub_entry.get('name') or subcategory) if sub_entry else subcategory
    return name, sub_name


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
        'at': now_iso(),
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
    scope: WorkspaceScope | None = None,
) -> CategoryChange:
    """Move ``item`` to ``category``/``subcategory`` (None removes it), conditionally.

    The condition holds only while the item exists and still has the category
    that was read — otherwise the write is a lost update (callers answer 409).
    Keys and ``gsi2sk`` are untouched; only ``gsi2pk`` moves: to ``CATEGORY#{category}``, or for an item of the
    workspace ``scope`` to its ``WS#{ws}#CATEGORY#…`` (shared/feedback_partitions.py).
    """
    change = CategoryChange(
        sets=['#cat_c = :cat_c', '#cat_g = :cat_g', '#cat_src = :cat_src', '#cat_o = :cat_o'],
        names={'#cat_c': 'category', '#cat_s': 'subcategory', '#cat_g': 'gsi2pk',
               '#cat_src': 'category_source', '#cat_o': 'category_override'},
        values={':cat_c': category, ':cat_g': category_partition(scope, category),
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


@dataclass(frozen=True)
class ManualEdit:
    """Who made a person's in-place edit and why: the kept version and the stamp (TENETS.md D1, D4)."""

    actor: Mapping[str, str]
    reason: str


def manual_edit_fields(edit: ManualEdit, at: str) -> dict[str, Any]:
    """The fields a person's edit writes besides its own: the change stamp only.

    The enrichment provenance (``pipeline_version``, ``enrichment_mode``, ``enriched_at``, ``llm_metadata``)
    keeps describing how the item was enriched; ``updated_by`` / ``updated_at`` / ``change_reason`` describe
    the edit, and ``category_source`` / ``dimension_sources`` say which values a person set.
    """
    return change_stamp(edit.actor, edit.reason, at)


def assignment_clauses(fields: Mapping[str, Any], prefix: str) -> tuple[list[str], dict[str, str], dict[str, Any]]:
    """``(SET clauses, names, values)`` assigning each of ``fields``; aliases are ``#{prefix}{i}``."""
    sets: list[str] = []
    names: dict[str, str] = {}
    values: dict[str, Any] = {}
    for index, (name, value) in enumerate(fields.items()):
        sets.append(f'#{prefix}{index} = :{prefix}{index}')
        names[f'#{prefix}{index}'] = name
        values[f':{prefix}{index}'] = value
    return sets, names, values


def keep_before_edit(item: Mapping[str, Any], edit: ManualEdit, update_kwargs: Mapping[str, Any],
                     scope: WorkspaceScope | None = None) -> None:
    """Keep ``item`` as it was before ``update_kwargs`` ran (``shared.silver_provenance``; never raises); an item of
    the workspace ``scope`` under ``ws/{ws}/silver/``.

    Called once the conditional update succeeded, so a refused edit leaves no version.
    """
    keep_silver_version(item, actor=edit.actor, reason=edit.reason, changed_fields=fields_of_update(update_kwargs),
                        scope=scope)


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
