"""A Prioritization row's "these versions are kept together on purpose" mark (#399).

The page labels a row `Crosses generations` when it holds two versions of one document
type (PRD v1 + PRD v2) or a document built from another version of a type the row also
holds. That label is advisory and the row stays scorable, but a row composed that way ON
PURPOSE had no way to say so. A reviewer can now acknowledge the label on one row; the
page then shows a quiet "kept on purpose" state instead of the warning.

STORED ON THE ROW RECORD, beside `document_ids`:

    lineage_ack = {document_ids: [sorted ids], acknowledged_at: iso, acknowledged_by: sub}

THE ACKNOWLEDGEMENT NAMES THE SET IT WAS GIVEN FOR, and that is what makes it lapse on
its own. A recompose changes `document_ids` and leaves this record alone, so the page
(which compares the two sets, `pages/Prioritization/lineageAck.ts`) shows the warning
again for a composition nobody acknowledged. Nothing has to remember to clear it, and a
write path added later cannot carry a stale acknowledgement onto a new set. A row
recomposed BACK to exactly the acknowledged set reads as acknowledged again, by design:
the mark is about the set, and that set was marked (pinned in
`lambda/api/test/test_prioritization_row_lineage_ack.py`).

The ids are stored SORTED: the acknowledgement is about a set, and the row's own order
is the reviewer's choice of which document leads — not something a set comparison should
depend on.

`acknowledged_by` is stored for the audit trail and never published: the page needs to
know THAT the set was acknowledged, not whose Cognito subject did it.

The validators answer a refusal by rule rather than echoing caller input, the same
reasoning `_validated_row_document_ids` records in `projects_handler.py`.
"""
from __future__ import annotations

from collections import Counter
from typing import Any, Final

from shared.exceptions import ValidationError

LINEAGE_ACK_FIELD: Final = 'lineage_ack'


def validated_ack_request(body: dict, max_document_ids: int) -> tuple[bool, list[str]]:
    """`(acknowledged, document_ids)` from a `PUT .../lineage-ack` body, or a 400.

    `acknowledged` is REQUIRED and must be a real boolean: the request either marks the
    row or withdraws the mark, and guessing which one an absent or `"false"` value meant
    would do the opposite of what somebody asked half the time.

    `document_ids` is the set the reviewer was LOOKING AT, required for both directions
    so the request always states what it is about. The route compares it with the row's
    stored set, so an acknowledgement cannot land on a composition that changed under
    the reviewer's feet. Distinct, non-empty strings, at most `max_document_ids` — the
    same bound a row's own composition has.
    """
    acknowledged = body.get('acknowledged')
    if not isinstance(acknowledged, bool):
        raise ValidationError('acknowledged must be true or false')
    raw = body.get('document_ids')
    if not isinstance(raw, list) or not raw:
        raise ValidationError('document_ids must be a non-empty list of document id strings')
    if len(raw) > max_document_ids:
        raise ValidationError(f'document_ids must name at most {max_document_ids} documents')
    if not all(isinstance(entry, str) and entry.strip() for entry in raw):
        raise ValidationError('document_ids must be non-empty document id strings')
    document_ids = [entry.strip() for entry in raw]
    if len(set(document_ids)) != len(document_ids):
        raise ValidationError('document_ids must name distinct documents')
    return acknowledged, sorted(document_ids)


def same_document_set(left: list[str], right: list[str]) -> bool:
    """Do two id lists name the same documents, whatever their order?

    A multiset comparison, so a list holding an id twice (a legacy or hand-edited row)
    never matches a different list of the same length. The page's twin
    (`lineageAck.ts: sameDocumentSet`) refuses duplicates the same way.
    """
    return Counter(left) == Counter(right)


def ack_record(document_ids: list[str], subject: str, now: str) -> dict:
    """The stored acknowledgement for `document_ids`, as of `now`, by `subject`."""
    return {
        'document_ids': sorted(document_ids),
        'acknowledged_at': now,
        'acknowledged_by': subject,
    }


def published_ack(row: Any) -> dict | None:
    """The acknowledgement as the page receives it, or None when there is none to read.

    Read defensively, like every other field `_row_payload` publishes: a malformed stored
    value is silence (None) rather than a raised read that takes the page down. Published
    AS STORED, set included, even when it no longer matches the row's documents — the page
    is the one place that decides whether an acknowledgement still applies, so a stale one
    reaching it is the expected input rather than a leak.
    """
    if not isinstance(row, dict):
        return None
    stored = row.get(LINEAGE_ACK_FIELD)
    if not isinstance(stored, dict):
        return None
    ids = stored.get('document_ids')
    if not isinstance(ids, list):
        return None
    # All or nothing: dropping a malformed entry would publish a SMALLER set than the
    # one acknowledged, which could then match a row that holds only that subset.
    if not ids or not all(isinstance(value, str) and value for value in ids):
        return None
    document_ids = list(ids)
    acknowledged_at = stored.get('acknowledged_at')
    return {
        'document_ids': document_ids,
        'acknowledged_at': acknowledged_at if isinstance(acknowledged_at, str) else '',
    }
