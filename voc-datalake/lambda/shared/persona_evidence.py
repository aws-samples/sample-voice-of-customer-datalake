"""
Which feedback a generated persona rests on.

The persona prompt numbers its input positionally (`### Review 1`, `### Review 2`,
... — see shared/feedback.py::format_feedback_for_llm) and asks the model to cite
its evidence as `"Review #N"`. Those numbers mean something only against the list
that was formatted for that one run, and nothing used to keep that list: a stored
`"Review #47"` pointed at nothing once the job finished. This module turns the
citations into feedback ids while the list still exists, so they can be stored
on the persona and resolved later.

Pure functions, no AWS: both the persona generator Lambda and the projects API
import it, and its behaviour is the part worth testing exhaustively.
"""
from __future__ import annotations

import re
from collections.abc import Mapping, Sequence
from typing import Any

# "Review #12", "Review 12", "review#12", "Reviews #12" — the shapes the model
# has actually produced (the stored corpus holds both "Review #N" and
# "Review N"). Anchored on the word so a stray number in prose ("3 of them")
# is never read as a citation.
_CITATION = re.compile(r'\breviews?\s*#?\s*(\d+)', re.IGNORECASE)


def _feedback_id(item: Mapping[str, Any]) -> str | None:
    value = item.get('feedback_id')
    return value if isinstance(value, str) and value else None


def resolve_evidence_ids(
    evidence: Any, items: Sequence[Mapping[str, Any]], items_seen: int,
) -> list[str]:
    """The feedback ids a persona's ``supporting_evidence`` cites.

    Args:
        evidence: The model's ``supporting_evidence`` value. Untrusted model
            output, so anything that is not a list of strings yields nothing.
        items: The feedback items in the order they were formatted for the
            prompt — the order the citation numbers refer to.
        items_seen: How many of ``items`` actually reached the model. A number
            above it cites a review the model never saw (truncated away), so it
            is dropped rather than attributed to whatever sat at that position.

    Returns:
        Distinct ids in first-cited order.
    """
    if not isinstance(evidence, list):
        return []
    limit = min(items_seen, len(items))
    ids: list[str] = []
    seen: set[str] = set()
    for reference in evidence:
        if not isinstance(reference, str):
            continue
        for match in _CITATION.finditer(reference):
            position = int(match.group(1))
            if not 1 <= position <= limit:
                continue
            feedback_id = _feedback_id(items[position - 1])
            if feedback_id and feedback_id not in seen:
                seen.add(feedback_id)
                ids.append(feedback_id)
    return ids


def input_feedback_ids(items: Sequence[Mapping[str, Any]], items_seen: int) -> list[str]:
    """Ids of the items that reached the model, in prompt order."""
    return [fid for item in items[:items_seen] if (fid := _feedback_id(item))]
