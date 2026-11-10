"""Comment threads on a PR/FAQ or PRD series (docs/document-review.md -> Comments).

One row per thread in the projects table, in the series' own partition (never the project's,
whose bounded document queries must not page through comments):

    pk ``DCOMMENTS#{project_id}#{series_id}``   sk ``C#{comment_id}``

A thread carries the version it was made on (``document_id`` + ``version``), an optional
``anchor`` (a W3C text-quote selector: ``exact`` + ``prefix`` + ``suffix``, plus the nearest
``heading``; none = a comment on the whole document), the ``author`` (``user`` | ``persona`` |
``reviewer``), ``status`` (``open`` | ``resolved``) and up to ``MAX_REPLIES`` replies. The SPA
re-anchors a thread on a newer version by its quote; one it cannot place is listed as "not
found in this version" and kept.

Text is type-checked and capped here; text that reads like an instruction to a model is kept
but ``flagged`` (shared.prompt_safety), as prototype pins are. Nothing here logs content.
"""
from __future__ import annotations

import hashlib
import re
import secrets
from collections.abc import Iterable, Mapping
from datetime import UTC, datetime
from itertools import islice
from typing import Any, Final

from boto3.dynamodb.conditions import Key

from shared.dynamo_paging import iter_query
from shared.dynamo_values import plain
from shared.exceptions import ValidationError
from shared.prompt_safety import injection_findings
from shared.request_body import validated_text
from shared.timestamps import now_iso

COMMENTS_PK_PREFIX: Final = 'DCOMMENTS#'
COMMENT_SK_PREFIX: Final = 'C#'
STATUS_OPEN: Final = 'open'
STATUS_RESOLVED: Final = 'resolved'
AUTHOR_USER: Final = 'user'
AUTHOR_PERSONA: Final = 'persona'
AUTHOR_REVIEWER: Final = 'reviewer'

MAX_COMMENT_CHARS: Final = 2000
MAX_REPLY_CHARS: Final = 2000
MAX_REPLIES: Final = 50
MAX_EXACT_CHARS: Final = 500
MAX_CONTEXT_CHARS: Final = 64
MAX_HEADING_CHARS: Final = 200
MAX_NAME_CHARS: Final = 120
MAX_THREADS_LISTED: Final = 500
COMMENT_NOT_FOUND: Final = 'Comment not found'

_COMMENT_ID_PREFIX: Final = 'dc_'
_COMMENT_ID_RE: Final = re.compile(r'^dc_[0-9]{20}[0-9a-f]{6}\Z')


def comments_pk(project_id: str, series_id: str) -> str:
    return f'{COMMENTS_PK_PREFIX}{project_id}#{series_id}'


def comment_key(project_id: str, series_id: str, comment_id: str) -> dict[str, str]:
    return {'pk': comments_pk(project_id, series_id), 'sk': f'{COMMENT_SK_PREFIX}{comment_id}'}


def new_comment_id(now: datetime | None = None) -> str:
    """``dc_`` + 20 digits of microseconds since the epoch + 6 hex: sorts by creation time."""
    moment = now or datetime.now(UTC)
    return f'{_COMMENT_ID_PREFIX}{int(moment.timestamp() * 1_000_000):020d}{secrets.token_hex(3)}'


def is_comment_id(value: object) -> bool:
    return isinstance(value, str) and _COMMENT_ID_RE.match(value) is not None


def email_digest(email_lc: str) -> str:
    """A reviewer's address as a key part (never the address itself)."""
    return hashlib.sha256(email_lc.encode()).hexdigest()[:24]


# ── Validation ──────────────────────────────────────────────────────────────

def validate_anchor(raw: object) -> dict[str, str] | None:
    """``{exact, prefix, suffix, heading}`` or None (a comment on the whole document)."""
    if raw is None:
        return None
    if not isinstance(raw, Mapping) or set(raw) - {'exact', 'prefix', 'suffix', 'heading'}:
        raise ValidationError('anchor must be {exact, prefix?, suffix?, heading?}')
    return {
        'exact': validated_text(raw.get('exact'), 'anchor.exact', MAX_EXACT_CHARS, required=True),
        'prefix': _context(raw.get('prefix'), 'anchor.prefix'),
        'suffix': _context(raw.get('suffix'), 'anchor.suffix'),
        'heading': validated_text(raw.get('heading'), 'anchor.heading', MAX_HEADING_CHARS),
    }


def _context(value: object, field: str) -> str:
    """A prefix/suffix as sent (not stripped: the spaces next to the quote are part of it)."""
    if value is None:
        return ''
    if not isinstance(value, str) or len(value) > MAX_CONTEXT_CHARS:
        raise ValidationError(f'{field} must be a string of at most {MAX_CONTEXT_CHARS} characters')
    return value


def validate_new_comment(body: Mapping[str, Any]) -> dict[str, Any]:
    """The ``{text, anchor}`` of a new thread."""
    if set(body) - {'text', 'anchor'}:
        raise ValidationError('body must be {text, anchor?}')
    return {'text': validated_text(body.get('text'), 'text', MAX_COMMENT_CHARS, required=True),
            'anchor': validate_anchor(body.get('anchor'))}


def validate_reply(body: Mapping[str, Any]) -> str:
    if set(body) - {'text'}:
        raise ValidationError('body must be {text}')
    return validated_text(body.get('text'), 'text', MAX_REPLY_CHARS, required=True)


# ── Authors ─────────────────────────────────────────────────────────────────

def user_author(subject: str, name: str) -> dict[str, str]:
    return {'kind': AUTHOR_USER, 'sub': subject, 'name': (name or 'Team member')[:MAX_NAME_CHARS]}


def persona_author(persona_id: str, name: str) -> dict[str, str]:
    return {'kind': AUTHOR_PERSONA, 'persona_id': persona_id, 'name': (name or 'Persona')[:MAX_NAME_CHARS]}


def reviewer_author(email_lc: str, name: str = '') -> dict[str, str]:
    return {'kind': AUTHOR_REVIEWER, 'email': email_lc, 'email_digest': email_digest(email_lc),
            'name': (name or email_lc)[:MAX_NAME_CHARS]}


# ── Rows ────────────────────────────────────────────────────────────────────

def thread_item(*, project_id: str, series_id: str, document: Mapping[str, Any], author: Mapping[str, Any],
                text: str, anchor: Mapping[str, str] | None, share_id: str = '',
                extra: Mapping[str, Any] | None = None) -> dict[str, Any]:
    """A new thread row on the version ``document``."""
    moment = datetime.now(UTC)
    comment_id = new_comment_id(moment)
    at = moment.isoformat()
    return {
        **comment_key(project_id, series_id, comment_id),
        'comment_id': comment_id, 'project_id': project_id, 'series_id': series_id,
        'document_id': str(document.get('document_id', '')), 'version': document.get('version'),
        'author': dict(author), 'text': text, 'anchor': dict(anchor) if anchor else None,
        'status': STATUS_OPEN, 'flagged': bool(injection_findings(text)),
        'share_id': share_id, 'replies': [], 'created_at': at, 'updated_at': at,
        **(extra or {}),
    }


def reply_item(author: Mapping[str, Any], text: str) -> dict[str, Any]:
    return {'reply_id': secrets.token_hex(6), 'author': dict(author), 'text': text,
            'flagged': bool(injection_findings(text)), 'at': now_iso()}


def put_thread(table: Any, item: Mapping[str, Any]) -> None:
    table.put_item(Item=dict(item), ConditionExpression='attribute_not_exists(sk)')


def get_thread(table: Any, project_id: str, series_id: str, comment_id: str) -> dict[str, Any] | None:
    if not is_comment_id(comment_id):
        return None
    item = table.get_item(Key=comment_key(project_id, series_id, comment_id), ConsistentRead=True).get('Item')
    return item if isinstance(item, dict) else None


def list_threads(table: Any, project_id: str, series_id: str) -> list[dict[str, Any]]:
    """The series' threads, oldest first, at most ``MAX_THREADS_LISTED``."""
    query = {'KeyConditionExpression': Key('pk').eq(comments_pk(project_id, series_id))
             & Key('sk').begins_with(COMMENT_SK_PREFIX), 'ConsistentRead': True}
    return list(islice(iter_query(table, query), MAX_THREADS_LISTED))


def append_reply(table: Any, item: Mapping[str, Any], reply: Mapping[str, Any]) -> dict[str, Any]:
    """Add ``reply`` to the thread (capped); raises the conditional failure past ``MAX_REPLIES``."""
    response = table.update_item(
        Key={'pk': item['pk'], 'sk': item['sk']},
        UpdateExpression='SET replies = list_append(if_not_exists(replies, :empty), :reply), updated_at = :now',
        ConditionExpression='attribute_exists(sk) AND (attribute_not_exists(replies) OR size(replies) < :max)',
        ExpressionAttributeValues={':empty': [], ':reply': [dict(reply)], ':now': reply['at'], ':max': MAX_REPLIES},
        ReturnValues='ALL_NEW',
    )
    return response.get('Attributes', {})


def set_status(table: Any, item: Mapping[str, Any], status: str, actor_name: str) -> dict[str, Any]:
    """Resolve or reopen; raises the conditional failure when the thread is gone."""
    response = table.update_item(
        Key={'pk': item['pk'], 'sk': item['sk']},
        UpdateExpression='SET #status = :status, status_by = :by, updated_at = :now',
        ConditionExpression='attribute_exists(sk)',
        ExpressionAttributeNames={'#status': 'status'},
        ExpressionAttributeValues={':status': status, ':by': actor_name[:MAX_NAME_CHARS], ':now': now_iso()},
        ReturnValues='ALL_NEW',
    )
    return response.get('Attributes', {})


def delete_thread(table: Any, item: Mapping[str, Any]) -> None:
    table.delete_item(Key={'pk': item['pk'], 'sk': item['sk']})


# ── Views ───────────────────────────────────────────────────────────────────

def _author_view(author: object, *, team: bool) -> dict[str, Any]:
    if not isinstance(author, Mapping):
        return {'kind': AUTHOR_USER, 'name': ''}
    view = {key: author.get(key) for key in ('kind', 'name', 'persona_id') if author.get(key) is not None}
    if team and author.get('kind') == AUTHOR_USER and isinstance(author.get('sub'), str):
        # The team's own subjects (the member list shows them too): the SPA offers Delete on your own thread.
        view['sub'] = author['sub']
    if team and author.get('kind') == AUTHOR_REVIEWER and isinstance(author.get('email'), str):
        view['email'] = author['email']
    return view


def thread_view(item: Mapping[str, Any], *, team: bool) -> dict[str, Any]:
    """A thread as the API returns it. Only the project's team sees a reviewer's address."""
    raw_replies = item.get('replies')
    replies = raw_replies if isinstance(raw_replies, list) else []
    view = {key: item.get(key) for key in (
        'comment_id', 'series_id', 'document_id', 'version', 'text', 'anchor', 'status', 'flagged',
        'created_at', 'updated_at', 'status_by', 'verdict',
    ) if key in item}
    view['author'] = _author_view(item.get('author'), team=team)
    view['replies'] = [
        {'reply_id': r.get('reply_id'), 'author': _author_view(r.get('author'), team=team), 'text': r.get('text'),
         'flagged': r.get('flagged') is True, 'at': r.get('at')}
        for r in replies if isinstance(r, Mapping)
    ]
    view['from_review_link'] = bool(item.get('share_id'))
    return plain(view)


def is_reviewer_thread(item: Mapping[str, Any], email_lc: str) -> bool:
    """A thread a review-link reviewer started (the only threads that reviewer sees)."""
    author = item.get('author')
    return (isinstance(author, Mapping) and author.get('kind') == AUTHOR_REVIEWER
            and author.get('email_digest') == email_digest(email_lc))


def threads_view(items: Iterable[Mapping[str, Any]], *, team: bool) -> list[dict[str, Any]]:
    return [thread_view(item, team=team) for item in items]
