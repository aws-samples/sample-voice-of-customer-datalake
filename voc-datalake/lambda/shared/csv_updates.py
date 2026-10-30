"""In-place update of a stored CSV row the uploader confirmed as corrected (issue #411).

A ``csv_replace`` record (``shared.csv_datasets.is_csv_replace``) names an item stored by an
earlier upload of the same dataset. The processor updates that item instead of skipping it
as a duplicate, so a corrected spreadsheet amends its rows rather than doubling them.

* The decision is the content digest: the stored ``csv_content_hash`` equal to the incoming
  one is ``unchanged`` (a redelivery, or a second confirm of the same file) and writes nothing.
* The row's own fields are replaced: rating, author, title, link, review date, channel,
  metadata, the lookup id, the digest. The text and every enriched field are replaced only
  when the text changed (``reenriched`` from the processor, enriched exactly like a new row).
* What a person did in the app wins, as for an issue refresh (``shared.source_updates``):
  a manual category is never moved, locked dimensions are kept, ``tags`` are never touched,
  and dimension / tag COLUMNS of the file are not applied to a stored row.
* The keys and the import date stay (``pk``/``sk``, ``gsi1*``, ``date``), so the aggregator
  rebuckets the stream's MODIFY on the item's own day (category, sentiment, urgency, channel).
* Conditional on the stored ``csv_dataset`` being the record's (a replace never touches an item
  another dataset, or no dataset, stored), on the digest still being what was read (and, when
  re-enriched, on the dimensions and on nobody having corrected the category meanwhile): a
  failed condition fails the update and SQS retries it against the new state. Nothing is
  created or deleted.
* A failed model call (``enrichment_failed``) writes the row's own fields only and keeps the
  stored text, enrichment and digest, as an issue refresh keeps them.
* ``s3_raw_uri`` follows the newest archive and is never removed: the API rewrites a
  per-item archive at the stored key, so retention still finds (and deletes) it.
"""
from __future__ import annotations

from collections.abc import Mapping
from decimal import Decimal
from typing import Any

from shared.source_profiles import PII_ALLOW, PII_SUMMARY_ONLY
from shared.source_updates import UPDATE_APPLY, UPDATE_UNCHANGED, ItemUpdate, text_changed

__all__ = ['csv_update', 'csv_update_decision', 'needs_reenrichment']

def csv_update_decision(stored: Mapping[str, Any], raw_record: Mapping[str, Any]) -> str:
    """``apply`` unless the stored digest already is the incoming one."""
    same = stored.get('csv_content_hash') == raw_record.get('csv_content_hash')
    return UPDATE_UNCHANGED if same else UPDATE_APPLY


def needs_reenrichment(stored: Mapping[str, Any], raw_record: Mapping[str, Any], pii_policy: str) -> bool:
    """Whether the text (and so the enrichment) is replaced.

    A summary-only item stores no text to compare with, so a changed digest re-enriches it.
    """
    if PII_SUMMARY_ONLY in (pii_policy, stored.get('pii_policy')):
        return True
    return text_changed(stored, raw_record, pii_policy)


def _row_fields(raw_record: Mapping[str, Any], pii_policy: str, now_iso: str) -> dict[str, Any]:
    """The stored fields a CSV row itself carries (None = REMOVE), under ``pii_policy``."""
    rating = raw_record.get('rating')
    fields: dict[str, Any] = {
        'csv_content_hash': raw_record['csv_content_hash'],
        'csv_dataset': raw_record['csv_dataset'],
        'csv_row_id': raw_record.get('csv_row_id'),
        'rating': Decimal(str(rating)) if rating is not None else None,
        'source_url': raw_record.get('url'),
        'source_created_at': raw_record.get('created_at'),
        'source_channel': raw_record.get('source_channel') or 'unknown',
        'pii_policy': None if pii_policy == PII_ALLOW else pii_policy,
        'source_refreshed_at': now_iso,
    }
    if raw_record.get('s3_raw_uri'):
        fields['s3_raw_uri'] = raw_record['s3_raw_uri']
    summary_only = pii_policy == PII_SUMMARY_ONLY
    fields['author'] = None if summary_only else raw_record.get('author') or None
    fields['title'] = None if summary_only else raw_record.get('title') or None
    fields['metadata'] = None if summary_only else raw_record.get('metadata') or None
    return fields


def csv_update(
    stored: Mapping[str, Any], raw_record: Mapping[str, Any], pii_policy: str, now_iso: str,
    reenriched: Mapping[str, Any] | None = None, moves_category: bool = False,
    enrichment_failed: bool = False,
) -> dict:
    """``update_item`` kwargs for a confirmed CSV correction.

    ``reenriched`` are the text + enrichment fields when the text changed (they win over
    the row's own ``title``); ``moves_category`` guards the move against a manual correction.
    ``enrichment_failed`` (the text changed but the model call failed): only the row's own
    fields are written and the STORED digest is kept, so the stored text and enrichment stay
    as they were and the row still previews as changed (a later confirmed upload retries it).
    """
    update = ItemUpdate(stored)
    fields = _row_fields(raw_record, pii_policy, now_iso)
    if enrichment_failed:
        fields.pop('csv_content_hash')
    update.assign({**fields, **(reenriched or {})})
    update.require_unchanged(stored, 'csv_content_hash')
    # Only an item the same dataset stored: a replace that merely shares a key with a
    # non-CSV item (no csv_dataset) or another dataset's row fails the condition, writing nothing.
    update.require_equal('csv_dataset', raw_record['csv_dataset'])
    if reenriched is not None:
        update.require_unchanged(stored, 'dimensions')
        if moves_category:
            update.require_not_manual_category()
    return update.kwargs()
