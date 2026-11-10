"""Which reviews a generated persona cites (ported from #429 by @aws-bryan).

The persona prompt numbers its feedback by position (``### Review 1``, ``### Review 2``,
... — ``shared.feedback.format_feedback_for_llm``) and asks the model to cite its evidence
as ``"Review #N"`` in ``supporting_evidence``. Those numbers mean something only against
the list formatted for that one run, so they are resolved to feedback ids while the list
still exists and stored as ``evidence_feedback_ids``. ``supporting_evidence`` itself is
kept as the model wrote it, so a reference that names no review (prose, a number past
what the model read) stays readable as text.

Pure functions, no AWS.
"""
from __future__ import annotations

import re
from collections.abc import Mapping, Sequence
from typing import Any, Final

from shared.feedback_sampling import MAX_INPUT_FEEDBACK_IDS

#: The persona field holding the resolved citations.
EVIDENCE_FEEDBACK_IDS_FIELD: Final = 'evidence_feedback_ids'

# "Review #12", "Review 12", "review#12", "Reviews #12, #14": the shapes the model writes.
# Anchored on the word so a stray number in prose ("3 of them") is never read as a citation;
# a list after it ("Reviews #3, #7 and #9") is followed by ``_LISTED``.
_CITATION = re.compile(r'\breviews?\s*#?\s*(\d+)((?:\s*(?:,|and|&)\s*#?\s*\d+)*)', re.IGNORECASE)
_LISTED = re.compile(r'\d+')


def _feedback_id(item: Mapping[str, Any]) -> str | None:
    value = item.get('feedback_id')
    return value if isinstance(value, str) and value else None


def _positions(reference: str) -> list[int]:
    positions: list[int] = []
    for match in _CITATION.finditer(reference):
        positions.append(int(match.group(1)))
        positions.extend(int(number) for number in _LISTED.findall(match.group(2) or ''))
    return positions


def resolve_evidence_ids(evidence: object, items: Sequence[Mapping[str, Any]], items_seen: int) -> list[str]:
    """The feedback ids ``supporting_evidence`` cites, distinct, in first-cited order (capped).

    ``items`` are the feedback items in prompt order (the order the numbers refer to);
    ``items_seen`` is how many of them reached the model. A number past it, or below 1,
    names a review the model never read, so it resolves to nothing rather than to whatever
    sat at that position. Anything that is not a list of strings (untrusted model output)
    resolves to nothing.
    """
    if not isinstance(evidence, list):
        return []
    limit = min(max(items_seen, 0), len(items))
    ids: list[str] = []
    seen: set[str] = set()
    for reference in evidence:
        if not isinstance(reference, str):
            continue
        for position in _positions(reference):
            feedback_id = _feedback_id(items[position - 1]) if 1 <= position <= limit else None
            if feedback_id and feedback_id not in seen:
                seen.add(feedback_id)
                ids.append(feedback_id)
    # Bounded like input_feedback_ids: a cited id is always one of the reviews the model read.
    return ids[:MAX_INPUT_FEEDBACK_IDS]
