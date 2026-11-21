"""A focus group saved as a project document (docs/project-workspace.md → Persona focus groups).

``POST /projects/{id}/documents`` with ``document_type: 'focus_group'`` files the transcript, the synthesis and their
citations as a document of the Documents section. It is a reference, never evidence (the owner's decision for
7.64.00): personas speaking are synthetic, so the row is always ``synthetic: true`` (whatever the body says), the
methodology never counts it (its ``DOC#`` key is no step's, shared/methodology.py), and only the review ids it cites
are lineage.

What it records (TENETS.md D4): ``created_by_sub`` and ``created_at``, and ``derivation`` — the personas that took
part, how many reviews they cited, the project documents and library items they read, and the rounds. The cited
reviews themselves are the row's ``input_feedback_ids``, where an erasure removes them as it does a persona's
(``jobs/retention/lineage.py``, which reads no id inside a derivation): only the ids the saver may see (their category
and source access, checked by the route) are kept. A ``[fb:<id>]`` citation in the text that names no kept review is
removed before the save, until none is left, so a saved transcript cannot point at a review its lineage does not
name; an edit's text (``PUT``) and a Revise from comments pass's changes are kept to the row's stored ids alike
(``citable_ids``, 7.66.00). The transcript holds the personas' words and the citations, never a review's text.
"""
from __future__ import annotations

import re
from collections.abc import Callable, Mapping, Sequence
from typing import Any, Final

from shared.exceptions import ValidationError
from shared.feedback_sampling import INPUT_FEEDBACK_IDS_FIELD
from shared.request_body import validated_text

FOCUS_GROUP_TYPE: Final = 'focus_group'
MAX_TITLE_CHARS: Final = 200
MAX_CONTENT_CHARS: Final = 200_000
MAX_ID_CHARS: Final = 128
#: A focus group's bounds (stream contract FOCUS_GROUP_LIMITS): personas, rounds, project documents, library items.
MAX_PERSONAS: Final = 6
MAX_ROUNDS: Final = 3
MAX_DOCUMENTS: Final = 3
MAX_LIBRARY_ITEMS: Final = 3
#: Six personas citing at most 20 reviews each, the synthesis's among them.
MAX_FEEDBACK_IDS: Final = 120
#: A review citation as the personas write it (lambda/stream/src/assistant/contract.ts FEEDBACK_CITATION).
CITATION: Final = re.compile(r'\[fb:([A-Za-z0-9_-]{1,128})\]')


def _ids(derivation: Mapping[str, Any], name: str, limit: int) -> list[str]:
    value = derivation.get(name, [])
    if not isinstance(value, list) or len(value) > limit:
        raise ValidationError(f'derivation.{name} must be a list of at most {limit} ids')
    ids: list[str] = []
    for one in value:
        if not isinstance(one, str) or not one or one != one.strip() or len(one) > MAX_ID_CHARS:
            raise ValidationError(f'derivation.{name} must hold ids of 1 to {MAX_ID_CHARS} characters')
        ids.append(one)
    return list(dict.fromkeys(ids))


def validated_derivation(value: object) -> tuple[dict[str, Any], list[str]]:
    """The derivation a focus group document stores (bounded id lists and its rounds) and the review ids it names,
    or a 400."""
    if not isinstance(value, Mapping):
        raise ValidationError('derivation must be an object')
    persona_ids = _ids(value, 'persona_ids', MAX_PERSONAS)
    if not persona_ids:
        raise ValidationError('derivation.persona_ids must name the personas that took part')
    rounds = value.get('rounds')
    if isinstance(rounds, bool) or not isinstance(rounds, int) or not 1 <= rounds <= MAX_ROUNDS:
        raise ValidationError(f'derivation.rounds must be a whole number from 1 to {MAX_ROUNDS}')
    return {
        'kind': FOCUS_GROUP_TYPE,
        'persona_ids': persona_ids,
        'document_ids': _ids(value, 'document_ids', MAX_DOCUMENTS),
        'library_item_ids': _ids(value, 'library_item_ids', MAX_LIBRARY_ITEMS),
        'rounds': rounds,
    }, _ids(value, 'feedback_ids', MAX_FEEDBACK_IDS)


def cited_only(content: str, feedback_ids: Sequence[str]) -> str:
    """``content`` without the ``[fb:<id>]`` citations whose id ``feedback_ids`` does not list, repeated until none
    is left (removing ``[fb:x]`` from ``[fb:[fb:x]y]`` would otherwise leave a new ``[fb:y]``)."""
    allowed = set(feedback_ids)
    while True:
        cleaned = CITATION.sub(lambda match: match.group(0) if match.group(1) in allowed else '', content)
        if cleaned == content:
            return cleaned
        content = cleaned


def citable_ids(document: Mapping[str, Any]) -> list[str] | None:
    """The review ids a stored focus group document's text may cite (its ``input_feedback_ids``, its lineage), so an
    edit or a revise pass is ``cited_only`` to them; None for any other document (its citations are its own)."""
    if document.get('document_type') != FOCUS_GROUP_TYPE:
        return None
    stored = document.get(INPUT_FEEDBACK_IDS_FIELD)
    return [one for one in stored if isinstance(one, str)] if isinstance(stored, list | set | tuple) else []


def focus_group_fields(body: Mapping[str, Any], visible: Callable[[Sequence[str]], list[str]]) -> dict[str, Any]:
    """The fields of a focus group document row (beside its keys and id), from the request body, or a 400.

    ``visible`` keeps the review ids the saver may see (``shared.persona_grounding.visible_ids`` with their scope).
    """
    title = body.get('title')
    if not isinstance(title, str) or not title.strip():
        raise ValidationError('title is required')
    content = body.get('content')
    if not isinstance(content, str) or not content.strip():
        raise ValidationError('content is required')
    if len(content) > MAX_CONTENT_CHARS:
        raise ValidationError(f'content must be at most {MAX_CONTENT_CHARS} characters')
    derivation, named = validated_derivation(body.get('derivation'))
    cited = visible(named)
    return {
        'document_type': FOCUS_GROUP_TYPE,
        'title': validated_text(title, 'title', MAX_TITLE_CHARS),
        'content': cited_only(content, cited),
        # Synthetic statements, never evidence: set here, never taken from the body.
        'synthetic': True,
        'derivation': {**derivation, 'feedback_count': len(cited)},
        INPUT_FEEDBACK_IDS_FIELD: cited,
    }
