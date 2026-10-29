"""A PR/FAQ or PRD written by a person, started from a blank template (docs/ways-of-working.md).

``POST /projects/{id}/documents`` with ``document_type: 'prfaq' | 'prd'`` files the
document as version 1 (or the next version) of its series, exactly like a
generated one, so editing, versions, compare, review and export all work the same.
It is marked ``origin: 'human'`` with the creator's ``created_by_sub``; nothing
here calls a model. Allowed in every way of working: the person writes.

``content`` is optional: without it the document starts from ``TEMPLATES`` (the
SPA normally sends the template in the reader's language). ``create_id`` is the
caller's idempotency key for one click, so a retried request is one document.
"""
from __future__ import annotations

import uuid
from typing import Any, Final

from shared.ai_writing import GATED_DOC_TYPES
from shared.document_versions import persist_versioned_document
from shared.exceptions import ValidationError
from shared.request_body import validated_text
from shared.row_ids import OPAQUE_ID_RE
from shared.timestamps import now_iso

HUMAN_DOC_TYPES: Final = GATED_DOC_TYPES
ORIGIN_HUMAN: Final = 'human'
MAX_TITLE_CHARS: Final = 200
MAX_CONTENT_CHARS: Final = 200_000

TEMPLATES: Final = {
    'prfaq': (
        '# Press release\n\n'
        '## Headline\n\n_One sentence a customer would understand._\n\n'
        '## Subheading\n\n_Who the customer is and the benefit they get._\n\n'
        '## Summary\n\n_The product and the benefit, in a paragraph._\n\n'
        '## Problem\n\n_The problem, in the customer\'s words, with evidence._\n\n'
        '## Solution\n\n_How the product solves it._\n\n'
        '## Quote from us\n\n_Why we built it._\n\n'
        '## How to get started\n\n_What the customer does first._\n\n'
        '## Customer quote\n\n_What a customer would say after using it._\n\n'
        '# FAQ\n\n## External FAQ\n\n**Q:** \n\n**A:** \n\n'
        '## Internal FAQ\n\n**Q:** \n\n**A:** \n'
    ),
    'prd': (
        '# Overview\n\n_What we are building and why now._\n\n'
        '# Problem and evidence\n\n_The customer problem, with the feedback behind it._\n\n'
        '# Goals and non-goals\n\n- Goal: \n- Non-goal: \n\n'
        '# Users and personas\n\n_Who it is for._\n\n'
        '# Requirements\n\n| # | Requirement | Priority |\n|---|---|---|\n| 1 | | |\n\n'
        '# Success metrics\n\n- \n\n'
        '# Risks and open questions\n\n- \n'
    ),
}


def _title(body: dict) -> str:
    title = body.get('title')
    if not isinstance(title, str) or not title.strip():
        raise ValidationError('title is required')
    return validated_text(title, 'title', MAX_TITLE_CHARS)


def _content(body: dict, doc_type: str) -> str:
    content = body.get('content')
    if content is None or content == '':
        return TEMPLATES[doc_type]
    if not isinstance(content, str):
        raise ValidationError('content must be a string')
    if len(content) > MAX_CONTENT_CHARS:
        raise ValidationError(f'content must be at most {MAX_CONTENT_CHARS} characters')
    return content


def _create_id(body: dict) -> str:
    raw = body.get('create_id')
    if raw is None:
        return uuid.uuid4().hex
    if not isinstance(raw, str) or not OPAQUE_ID_RE.fullmatch(raw):
        raise ValidationError('create_id must be 1-64 letters, digits, "-" or "_"')
    return raw


def create_human_document(table: Any, project_id: str, doc_type: str, body: dict, *, creator_sub: str) -> dict:
    """File a hand-written PR/FAQ / PRD as the next version of its series; answers the item."""
    if doc_type not in HUMAN_DOC_TYPES:
        raise ValidationError('document_type must be prfaq or prd')
    title = _title(body)
    content = _content(body, doc_type)
    now = now_iso()
    fields = {
        'gsi1pk': f'PROJECT#{project_id}#DOCUMENTS',
        'gsi1sk': now,
        'content': content,
        'origin': ORIGIN_HUMAN,
        'created_at': now,
        'updated_at': now,
        **({'created_by_sub': creator_sub} if creator_sub else {}),
    }
    return persist_versioned_document(table, project_id, doc_type, title, f'human:{_create_id(body)}', fields)
