"""The Silver contract (TENETS.md D1, D2, D4): how an item was made, and every version it had.

Every processed feedback item (``voc-feedback``, the Silver tier) says how it was made:

- ``pipeline_version``: the app release that wrote it (env ``APP_VERSION``, the same source as
  the raw archive's ``connector-version``, ``shared/raw_versions.py``); ``'unknown'`` when unset;
- ``enrichment_mode``: ``llm`` (the model answered), ``defaults`` (the model call failed and the
  fallback values were stored), ``manual`` (a person edited it), ``reprocess_*`` (a category
  reprocess job), ``source_update`` (a newer copy from the source, a CSV correction);
- ``enriched_at`` and ``llm_metadata`` ``{model_name, requested_model, prompt_version, latency_ms,
  error?}``: ``model_name`` is the model that ANSWERED (after a capacity fallback it differs from
  ``requested_model``).

An in-place change of a stored item keeps the item AS IT WAS first (``keep_silver_version``):
a write-once JSON object in the raw bucket,
``silver/{source_platform}/{feedback_id}/{YYYYMMDDTHHMMSSffffffZ}-{sha8}.json``, holding the item,
the actor ``{sub, kind}``, the reason and the changed fields. The item then carries
``updated_by`` / ``updated_at`` / ``change_reason`` (``change_stamp``). A kept version is a copy of
the Silver row, which is already policy-applied, so a redact / summary-only source's version
holds only what its item holds. Only ``voc-retention`` deletes these objects, with the item
(``silver_item_prefix``).

Keeping a version never fails the change: a failed put is logged (no content) and counted
(``SilverVersionFailures``), and the caller goes on.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
from collections.abc import Mapping, Sequence
from datetime import UTC, datetime
from typing import Any, Final, Literal

from botocore.exceptions import ClientError

from shared.archive_keys import archive_key_stem
from shared.dynamo_values import plain
from shared.logging import logger, metrics
from shared.raw_versions import UNKNOWN_VERSION

# Also part of the contract, imported by name (the reprocess worker, tests): PIPELINE_VERSION,
# REASON_REPROCESS, EnrichmentMode, contract_llm_metadata.
__all__ = [
    'REASON_CATEGORY_EDIT',
    'REASON_CSV_CORRECTION',
    'REASON_DATA_EXPLORER_EDIT',
    'REASON_DIMENSIONS_EDIT',
    'REASON_SOURCE_UPDATE',
    'SILVER_PREFIX',
    'SYSTEM_ACTOR',
    'change_stamp',
    'fields_of_update',
    'keep_silver_version',
    'provenance',
    'silver_item_prefix',
]

PIPELINE_VERSION: Final[str] = os.environ.get('APP_VERSION') or UNKNOWN_VERSION
SILVER_PREFIX: Final = 'silver/'

EnrichmentMode = Literal[
    'llm', 'defaults', 'manual', 'reprocess_processed', 'reprocess_raw', 'reprocess_dimensions', 'source_update',
]

REASON_CATEGORY_EDIT: Final = 'category_edit'
REASON_DIMENSIONS_EDIT: Final = 'dimensions_edit'
REASON_DATA_EXPLORER_EDIT: Final = 'data_explorer_edit'
REASON_CSV_CORRECTION: Final = 'csv_correction'
REASON_SOURCE_UPDATE: Final = 'source_update'
REASON_REPROCESS: Final = 'reprocess'
#: Every reason a change may give: a kept version with another one is still kept, and logged.
CHANGE_REASONS: Final = frozenset({
    REASON_CATEGORY_EDIT, REASON_DIMENSIONS_EDIT, REASON_DATA_EXPLORER_EDIT, REASON_CSV_CORRECTION,
    REASON_SOURCE_UPDATE, REASON_REPROCESS,
})

#: The actor of a change no person made (a source update, a CSV correction the queue applies).
SYSTEM_ACTOR: Final = {'sub': 'system', 'kind': 'system'}

_LLM_METADATA_FIELDS: Final = ('model_name', 'requested_model', 'prompt_version', 'latency_ms', 'error')
_MAX_ACTOR_CHARS: Final = 200
_MAX_REASON_CHARS: Final = 64
_SHA_CHARS: Final = 8
_ALREADY_KEPT: Final = 'PreconditionFailed'
FAILURE_METRIC: Final = 'SilverVersionFailures'
#: The change stamp ``change_stamp`` writes: not a change of the item's content.
_STAMP_FIELDS: Final = frozenset({'updated_by', 'updated_at', 'change_reason'})
#: An attribute-name placeholder in an UpdateExpression.
_ALIAS_RE: Final = re.compile(r'#\w+')


def _now() -> datetime:
    return datetime.now(UTC)


def contract_llm_metadata(metadata: Mapping[str, Any]) -> dict[str, Any]:
    """The contract's ``llm_metadata`` fields of ``metadata`` (absent ones left out)."""
    return {name: metadata[name] for name in _LLM_METADATA_FIELDS if metadata.get(name) is not None}


def provenance(
    mode: EnrichmentMode, *, llm_metadata: Mapping[str, Any] | None = None, at: str | None = None,
) -> dict[str, Any]:
    """The provenance fields an enriched or changed item carries (``llm_metadata`` omitted when None)."""
    fields: dict[str, Any] = {
        'pipeline_version': PIPELINE_VERSION,
        'enrichment_mode': mode,
        'enriched_at': at or _now().isoformat(),
    }
    if llm_metadata is not None:
        fields['llm_metadata'] = contract_llm_metadata(llm_metadata)
    return fields


def _actor(actor: Mapping[str, str]) -> dict[str, str]:
    sub, kind = actor.get('sub'), actor.get('kind')
    return {
        'sub': sub[:_MAX_ACTOR_CHARS] if isinstance(sub, str) and sub else SYSTEM_ACTOR['sub'],
        'kind': kind[:_MAX_ACTOR_CHARS] if isinstance(kind, str) and kind else SYSTEM_ACTOR['kind'],
    }


def change_stamp(actor: Mapping[str, str], reason: str, at: str | None = None) -> dict[str, Any]:
    """``updated_by`` ``{sub, kind}``, ``updated_at`` and ``change_reason`` of an in-place change."""
    return {'updated_by': _actor(actor), 'updated_at': at or _now().isoformat(), 'change_reason': reason}


def _source_of(item: Mapping[str, Any]) -> str:
    source = item.get('source_platform')
    if isinstance(source, str) and source:
        return source
    pk = item.get('pk')
    return pk.removeprefix('SOURCE#') if isinstance(pk, str) and pk.startswith('SOURCE#') else 'unknown'


def silver_item_prefix(item: Mapping[str, Any]) -> str | None:
    """``silver/{source}/{feedback_id}/``: the folder of every kept version of ``item`` (None without an id)."""
    feedback_id = item.get('feedback_id')
    if not isinstance(feedback_id, str) or not feedback_id:
        return None
    return f'{SILVER_PREFIX}{archive_key_stem(_source_of(item))}/{archive_key_stem(feedback_id)}/'


def fields_of_update(update_kwargs: Mapping[str, Any]) -> list[str]:
    """The item fields an ``update_item`` call SETs or REMOVEs (its change stamp left out), sorted."""
    expression = update_kwargs.get('UpdateExpression')
    names = update_kwargs.get('ExpressionAttributeNames')
    if not isinstance(expression, str) or not isinstance(names, Mapping):
        return []
    fields = {str(names.get(alias, alias)) for alias in _ALIAS_RE.findall(expression)}
    return sorted(fields - _STAMP_FIELDS)


def _version_body(
    item: Mapping[str, Any], actor: Mapping[str, str], reason: str, changed_fields: Sequence[str], kept_at: str,
) -> str:
    return json.dumps({
        'item': plain(item),
        'actor': _actor(actor),
        'reason': reason[:_MAX_REASON_CHARS],
        'changed_fields': sorted({str(name) for name in changed_fields}),
        'kept_at': kept_at,
    }, sort_keys=True, default=str)


def _is_already_kept(error: ClientError) -> bool:
    return str(error.response.get('Error', {}).get('Code', '')) == _ALREADY_KEPT


def _s3() -> Any:
    from shared.aws import get_s3_client  # lazy: only the writers need the client

    return get_s3_client()


def keep_silver_version(
    item: Mapping[str, Any], *, actor: Mapping[str, str], reason: str, changed_fields: Sequence[str],
) -> str | None:
    """Write ``item`` as it is NOW (before the caller's change) write-once; its ``s3://`` URI or None.

    A 412 (the same version already kept) is a success. Any failure is logged, counted
    (``SilverVersionFailures``) and returns None: it never fails the change.
    """
    if reason not in CHANGE_REASONS:
        logger.warning('Silver version kept with an undeclared reason', extra={'reason': reason[:_MAX_REASON_CHARS]})
    bucket = os.environ.get('RAW_DATA_BUCKET', '')
    prefix = silver_item_prefix(item)
    if not bucket or prefix is None:
        logger.warning('Silver version not kept: no bucket or no feedback id', extra={'reason': reason})
        metrics.add_metric(name=FAILURE_METRIC, unit='Count', value=1)
        return None
    moment = _now()
    body = _version_body(item, actor, reason, changed_fields, moment.isoformat())
    digest = hashlib.sha256(body.encode('utf-8')).hexdigest()[:_SHA_CHARS]
    key = f"{prefix}{moment.strftime('%Y%m%dT%H%M%S%fZ')}-{digest}.json"
    try:
        _s3().put_object(Bucket=bucket, Key=key, Body=body.encode('utf-8'),
                         ContentType='application/json', IfNoneMatch='*')
    except ClientError as exc:
        if not _is_already_kept(exc):
            _count_failure(reason, exc)
            return None
    except Exception as exc:  # noqa: BLE001 - keeping a version never fails the change
        _count_failure(reason, exc)
        return None
    return f's3://{bucket}/{key}'


def _count_failure(reason: str, exc: BaseException) -> None:
    logger.warning('Silver version not kept', extra={'reason': reason, 'error_type': type(exc).__name__})
    metrics.add_metric(name=FAILURE_METRIC, unit='Count', value=1)
