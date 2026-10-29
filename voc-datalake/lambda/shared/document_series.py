"""A PR/FAQ or PRD as a SERIES of versions, for comments and review links (docs/document-review.md).

Editing a managed document writes a NEW document id per version, so a comment or a review link
keys on the series: the project, the type and the normalized base title
(``shared.document_versions.normalized_base_title``). ``series_id`` is a stable digest of the
three, so it never carries the title into a key or a URL.

Also here: ``plain_text`` (markdown -> the text a reader sees), the space comment anchors and
persona quotes are matched in. The SPA matches the same anchors against the rendered document's
text with whitespace collapsed (frontend ``documentComments/anchors.ts``).
"""
from __future__ import annotations

import hashlib
import re
from typing import Any, Final

from boto3.dynamodb.conditions import Key

from shared.document_history import series_base, series_versions
from shared.document_versions import (
    MERGE_VERSIONED_DOCUMENT_TYPES,
    managed_document_type,
    normalized_base_title,
)
from shared.dynamo_paging import iter_query
from shared.exceptions import NotFoundError, ValidationError

COMMENTABLE_TYPES: Final = MERGE_VERSIONED_DOCUMENT_TYPES
DOCUMENT_NOT_FOUND: Final = 'Document not found'
NOT_COMMENTABLE: Final = 'Comments are available on PR/FAQ and PRD documents only'


def find_document(table: Any, project_id: str, document_id: str) -> dict:
    """The stored document row (content included); 404 when absent."""
    query = {
        'KeyConditionExpression': Key('pk').eq(f'PROJECT#{project_id}'),
        'ConsistentRead': True,
        'ProjectionExpression': 'pk, sk, document_id',
    }
    match = next((row for row in iter_query(table, query) if row.get('document_id') == document_id), None)
    if match is None:
        raise NotFoundError(DOCUMENT_NOT_FOUND)
    item = table.get_item(Key={'pk': match['pk'], 'sk': match['sk']}, ConsistentRead=True).get('Item')
    if not isinstance(item, dict) or item.get('document_id') != document_id:
        raise NotFoundError(DOCUMENT_NOT_FOUND)
    return item


def commentable_type(document: dict) -> str:
    """``prfaq`` / ``prd``; 400 for any other document."""
    document_type = managed_document_type(document)
    if document_type not in COMMENTABLE_TYPES:
        raise ValidationError(NOT_COMMENTABLE)
    return str(document_type)


def series_id(project_id: str, document_type: str, title: str) -> str:
    """``ser_`` + 24 hex: one per (project, type, normalized base title)."""
    normalized = normalized_base_title(title, document_type)
    digest = hashlib.sha256(f'{project_id}\n{document_type}\n{normalized}'.encode()).hexdigest()
    return f'ser_{digest[:24]}'


def series_of(project_id: str, document: dict) -> dict[str, str]:
    """``{series_id, document_type, base_title}`` of a PR/FAQ / PRD row (400 for another type)."""
    document_type = commentable_type(document)
    base = series_base(document)
    return {'series_id': series_id(project_id, document_type, base), 'document_type': document_type,
            'base_title': base}


def latest_version(table: Any, project_id: str, document_type: str, base: str) -> dict | None:
    """The newest stored version of the series, or None when every version was deleted."""
    versions = series_versions(table, project_id, {'document_type': document_type, 'base_title': base})
    return versions[0] if versions else None


# ── Plain text (anchors and persona quotes) ─────────────────────────────────

_FENCE_RE: Final = re.compile(r'^\s*(```|~~~).*$', re.MULTILINE)
_IMAGE_RE: Final = re.compile(r'!\[([^\]]*)\]\([^)]*\)')
_LINK_RE: Final = re.compile(r'\[([^\]]*)\]\([^)]*\)')
_HEADING_RE: Final = re.compile(r'^\s{0,3}#{1,6}\s+', re.MULTILINE)
_QUOTE_RE: Final = re.compile(r'^\s{0,3}>\s?', re.MULTILINE)
_LIST_RE: Final = re.compile(r'^\s*(?:[-*+]|\d{1,9}[.)])\s+(?:\[[ xX]\]\s+)?', re.MULTILINE)
_RULE_RE: Final = re.compile(r'^\s*(?:[-*_]\s*){3,}$', re.MULTILINE)
_TABLE_SEPARATOR_RE: Final = re.compile(r'^\s*\|?\s*:?-{2,}:?\s*(?:\|\s*:?-{2,}:?\s*)*\|?\s*$', re.MULTILINE)
_EMPHASIS_RE: Final = re.compile(r'(\*\*|__|~~|`)')
_SINGLE_STAR_RE: Final = re.compile(r'(?<![\w*])\*(?=\S)|(?<=\S)\*(?![\w*])')
_HTML_TAG_RE: Final = re.compile(r'</?[A-Za-z][^>]*>')
_WS_RE: Final = re.compile(r'\s+')


def collapse(text: str) -> str:
    """Every whitespace run as one space, trimmed (how both sides compare text)."""
    return _WS_RE.sub(' ', text).strip()


def plain_text(markdown: object) -> str:
    """The text a reader sees in the rendered markdown, whitespace collapsed.

    An approximation on purpose: block markers, emphasis, links, images and table pipes go, the
    words stay. A quote that crosses a table cell may not match the rendered text; it is then
    shown as "not found in this version" in the SPA, never lost.
    """
    if not isinstance(markdown, str):
        return ''
    text = _FENCE_RE.sub(' ', markdown)
    text = _TABLE_SEPARATOR_RE.sub(' ', text)
    text = _IMAGE_RE.sub(r'\1', text)
    text = _LINK_RE.sub(r'\1', text)
    for pattern in (_HEADING_RE, _QUOTE_RE, _LIST_RE, _RULE_RE, _HTML_TAG_RE):
        text = pattern.sub(' ', text)
    text = _EMPHASIS_RE.sub('', text)
    text = _SINGLE_STAR_RE.sub('', text)
    return collapse(text.replace('|', ' '))
