"""Asks (an email asking people for feedback), their recipients, tokens and the send counter.

``ASK#{id}`` / ``META`` is the ask, ``ASK#{id}`` / ``RCPT#{person}`` one recipient, and
``PERSON#{person}`` / ``ASK#{id}`` its mirror (the person's asks, and what erasure walks).
Tokens are minted at SEND time, one per email: ``TOKEN#{sha256}`` / ``RESPONSE``
(attributes a form answer to the recipient) and ``TOKEN#{sha256}`` / ``UNSUB``
(unsubscribes the person). Only the hash is stored; the plaintext is in the email.
``SENDCOUNT#{day}`` / ``COUNT`` counts the emails sent per UTC day and ``SENDCOUNT#{day}`` /
``SENDER#{sub}`` those of one sender's asks (TTL +3 days).
"""
from __future__ import annotations

from collections.abc import Mapping
from datetime import UTC, datetime, timedelta
from typing import Any, Final

from botocore.exceptions import BotoCoreError, ClientError

from shared.batch_get import batch_get_all
from shared.digests import sha256_hex
from shared.dynamo_paging import iter_query, query_all
from shared.engagement_common import (
    conditional_write,
    new_id,
    new_token,
    now_iso,
    public_fields,
)
from shared.exceptions import ServiceError
from shared.indexes import PARTICIPANTS_LISTING_INDEX
from shared.logging import logger
from shared.participants_store import remember_token

ASK_PREFIX: Final = 'ask'
ASKS_PARTITION: Final = 'ASKS'
MAX_ASKS_LISTED: Final = 200
MAX_RECIPIENTS: Final = 500
# Emails one person's asks may send per UTC day (BE-4): any signed-in user can send an ask, so one
# account cannot use the deployment's whole daily cap (default 500) on outside addresses.
PER_SENDER_DAILY_CAP: Final = 50
# The ask's attribute naming whose cap its emails count against: the creator's sub for a
# non-administrator, absent for an administrator (and for asks created before the cap existed).
# Fixed when the ask is created: a later promotion or demotion does not change an ask already queued.
CAP_SENDER_FIELD: Final = 'cap_sender'
SENDER_CAP_REFUSAL: Final = 'sender_daily_cap'
DAILY_CAP_REFUSAL: Final = 'daily_cap'
SEND_COUNT_TTL: Final = timedelta(days=3)
RCPT_QUEUED: Final = 'queued'
RCPT_SENT: Final = 'sent'
RCPT_FAILED: Final = 'failed'
RCPT_SKIPPED: Final = 'skipped_unsubscribed'
RCPT_RESPONDED: Final = 'responded'
ASK_QUEUED: Final = 'queued'
ASK_SENDING: Final = 'sending'
ASK_SENT: Final = 'sent'
ASK_FAILED: Final = 'failed'
RESPONSE_SK: Final = 'RESPONSE'
UNSUBSCRIBE_SK: Final = 'UNSUB'
# What a presented token may look like before it costs a read (token_urlsafe(24) is 32 characters).
MIN_TOKEN_CHARS: Final = 16
MAX_TOKEN_CHARS: Final = 128
COUNT_FIELDS: Final = ('recipients', 'sent', 'failed', 'skipped', 'responded')
_HIDDEN: Final = frozenset({'created_by_email', 'api_base', CAP_SENDER_FIELD})


def ask_key(ask_id: str) -> dict[str, str]:
    return {'pk': f'ASK#{ask_id}', 'sk': 'META'}


def recipient_key(ask_id: str, person_id: str) -> dict[str, str]:
    return {'pk': f'ASK#{ask_id}', 'sk': f'RCPT#{person_id}'}


def token_key(token: str, kind: str) -> dict[str, str]:
    return hashed_token_key(sha256_hex(token), kind)


def hashed_token_key(token_hash: str, kind: str) -> dict[str, str]:
    return {'pk': f'TOKEN#{token_hash}', 'sk': kind}


def ask_view(item: Mapping[str, Any]) -> dict[str, Any]:
    view = public_fields(item, _HIDDEN)
    stored = view.get('counts')
    counts: Mapping[str, Any] = stored if isinstance(stored, dict) else {}
    view['counts'] = {field: int(counts.get(field) or 0) for field in COUNT_FIELDS}
    return view


def create_ask(table: Any, fields: Mapping[str, Any], recipient_ids: list[str], created_by: str) -> dict[str, Any]:
    """Write the ask (status ``queued``), one ``queued`` recipient row per person and their mirrors."""
    ask_id = new_id(ASK_PREFIX)
    now = now_iso()
    item = {**ask_key(ask_id), 'ask_id': ask_id, **fields, 'status': ASK_QUEUED,
            'counts': {field: (len(recipient_ids) if field == 'recipients' else 0) for field in COUNT_FIELDS},
            'created_by': created_by, 'created_at': now, 'updated_at': now,
            'gsi1pk': ASKS_PARTITION, 'gsi1sk': f'{now}#{ask_id}'}
    with table.batch_writer() as batch:
        for person_id in recipient_ids:
            batch.put_item(Item={**recipient_key(ask_id, person_id), 'person_id': person_id, 'status': RCPT_QUEUED})
            batch.put_item(Item={'pk': f'PERSON#{person_id}', 'sk': f'ASK#{ask_id}', 'ask_id': ask_id,
                                 'added_at': now})
    # META last: a half-written ask (a failed batch) is never listed.
    table.put_item(Item=item)
    return item


def get_ask(table: Any, ask_id: str) -> dict[str, Any] | None:
    item = table.get_item(Key=ask_key(ask_id), ConsistentRead=True).get('Item')
    return item if isinstance(item, dict) else None


def list_asks(table: Any) -> list[dict[str, Any]]:
    """Asks, newest first."""
    return query_all(table, {
        'IndexName': PARTICIPANTS_LISTING_INDEX, 'KeyConditionExpression': 'gsi1pk = :p',
        'ExpressionAttributeValues': {':p': ASKS_PARTITION}, 'ScanIndexForward': False,
    }, max_items=MAX_ASKS_LISTED)


def recipient_rows(table: Any, ask_id: str, after: str | None = None,
                   limit: int | None = None) -> list[dict[str, Any]]:
    """Recipient rows in person-id order, after the recipient sort key ``after`` when given."""
    request: dict[str, Any] = {
        'KeyConditionExpression': 'pk = :pk AND begins_with(sk, :r)',
        'ExpressionAttributeValues': {':pk': f'ASK#{ask_id}', ':r': 'RCPT#'},
        'ConsistentRead': True,
    }
    if after:
        request['ExclusiveStartKey'] = {'pk': f'ASK#{ask_id}', 'sk': after}
    return query_all(table, request, max_items=limit)


def asks_of_person(table: Any, person_id: str) -> list[dict[str, Any]]:
    """``[{ask_id, subject, status, sent_at, responded_at}]`` for every ask the person received."""
    ask_ids = [str(row['ask_id']) for row in iter_query(table, {
        'KeyConditionExpression': 'pk = :pk AND begins_with(sk, :a)',
        'ExpressionAttributeValues': {':pk': f'PERSON#{person_id}', ':a': 'ASK#'},
    }, max_items=MAX_ASKS_LISTED) if row.get('ask_id')]
    failure = ServiceError('Could not read the asks. Please retry.')
    metas = {row['ask_id']: row for row in batch_get_all(table, [ask_key(a) for a in ask_ids], failure=failure)}
    rcpts = {row['pk'].removeprefix('ASK#'): row for row in batch_get_all(
        table, [recipient_key(a, person_id) for a in ask_ids], failure=failure)}
    newest_first = sorted(metas, key=lambda a: str(metas[a].get('created_at', '')), reverse=True)
    return [_person_ask(metas[ask_id], rcpts.get(ask_id, {})) for ask_id in newest_first]


def _person_ask(meta: Mapping[str, Any], rcpt: Mapping[str, Any]) -> dict[str, Any]:
    return {'ask_id': meta['ask_id'], 'subject': meta.get('subject', ''), 'status': rcpt.get('status'),
            'sent_at': rcpt.get('sent_at'), 'responded_at': rcpt.get('responded_at')}


def set_ask_status(table: Any, ask_id: str, status: str) -> None:
    table.update_item(Key=ask_key(ask_id), UpdateExpression='SET #s = :s, updated_at = :now',
                      ExpressionAttributeNames={'#s': 'status'},
                      ExpressionAttributeValues={':s': status, ':now': now_iso()})


def bump_count(table: Any, ask_id: str, field: str) -> None:
    table.update_item(Key=ask_key(ask_id), UpdateExpression='ADD #c.#f :one',
                      ExpressionAttributeNames={'#c': 'counts', '#f': field}, ExpressionAttributeValues={':one': 1})


def settle_recipient(table: Any, ask_id: str, person_id: str, status: str, **fields: Any) -> bool:
    """Move a ``queued`` recipient to ``status`` (+ ``fields``); False when it was already settled."""
    names = {'#s': 'status', **{f'#f{i}': name for i, name in enumerate(fields)}}
    values = {':s': status, ':q': RCPT_QUEUED, **{f':v{i}': value for i, value in enumerate(fields.values())}}
    sets = ['#s = :s', *(f'#f{i} = :v{i}' for i in range(len(fields)))]
    return conditional_write(table.update_item, Key=recipient_key(ask_id, person_id),
                             UpdateExpression='SET ' + ', '.join(sets), ConditionExpression='#s = :q',
                             ExpressionAttributeNames=names, ExpressionAttributeValues=values)


def mint_response_token(table: Any, ask: Mapping[str, Any], person_id: str) -> str:
    """A fresh form-attribution token for one recipient of ``ask`` (only its hash is stored)."""
    token = new_token()
    token_hash = sha256_hex(token)
    item: dict[str, Any] = {**hashed_token_key(token_hash, RESPONSE_SK), 'ask_id': ask['ask_id'],
                            'person_id': person_id}
    if ask.get('project_id'):
        item['project_id'] = ask['project_id']
    table.put_item(Item=item)
    table.update_item(Key=recipient_key(str(ask['ask_id']), person_id), UpdateExpression='SET response_token_hash = :h',
                      ExpressionAttributeValues={':h': token_hash})
    remember_token(table, person_id, token_hash, unsubscribe=False)
    return token


def mint_unsubscribe_token(table: Any, person_id: str) -> str:
    token = new_token()
    token_hash = sha256_hex(token)
    table.put_item(Item={**hashed_token_key(token_hash, UNSUBSCRIBE_SK), 'person_id': person_id})
    remember_token(table, person_id, token_hash, unsubscribe=True)
    return token


def resolve_token(table: Any, token: object, kind: str) -> dict[str, Any] | None:
    """The token row, or None for anything that is not a live token of ``kind``."""
    if not isinstance(token, str) or not MIN_TOKEN_CHARS <= len(token) <= MAX_TOKEN_CHARS:
        return None
    item = table.get_item(Key=token_key(token, kind)).get('Item')
    return item if isinstance(item, dict) and isinstance(item.get('person_id'), str) else None


def mark_responded(table: Any, ask_id: str, person_id: str) -> bool:
    """The recipient answered: ``responded`` once (counted once); False when already counted or gone."""
    if not conditional_write(table.update_item, Key=recipient_key(ask_id, person_id),
                             UpdateExpression='SET #s = :r, responded_at = :now',
                             ConditionExpression='attribute_exists(pk) AND #s <> :r',
                             ExpressionAttributeNames={'#s': 'status'},
                             ExpressionAttributeValues={':r': RCPT_RESPONDED, ':now': now_iso()}):
        return False
    bump_count(table, ask_id, 'responded')
    return True


# ── The daily send counter ────────────────────────────────────────────────────

def _count_key(day: str) -> dict[str, str]:
    return {'pk': f'SENDCOUNT#{day}', 'sk': 'COUNT'}


def _sender_count_key(day: str, sender: str) -> dict[str, str]:
    return {'pk': f'SENDCOUNT#{day}', 'sk': f'SENDER#{sender}'}


def _today() -> datetime:
    return datetime.now(UTC)


def _sent(table: Any, key: Mapping[str, str]) -> int:
    item = table.get_item(Key=dict(key), ConsistentRead=True).get('Item')
    return int(item.get('count') or 0) if item else 0


def sent_today(table: Any) -> int:
    return _sent(table, _count_key(_today().date().isoformat()))


def sent_today_by(table: Any, sender: str) -> int:
    """Emails counted today against one person's own cap (PER_SENDER_DAILY_CAP)."""
    return _sent(table, _sender_count_key(_today().date().isoformat(), sender))


def _claim(table: Any, key: Mapping[str, str], cap: int, now: datetime) -> bool:
    return conditional_write(
        table.update_item,
        Key=dict(key),
        UpdateExpression='ADD #c :one SET #t = if_not_exists(#t, :ttl)',
        ConditionExpression='attribute_not_exists(#c) OR #c < :cap',
        ExpressionAttributeNames={'#c': 'count', '#t': 'ttl'},
        ExpressionAttributeValues={':one': 1, ':cap': cap, ':ttl': int((now + SEND_COUNT_TTL).timestamp())},
    )


def claim_send(table: Any, cap: int, sender: str) -> str | None:
    """Count one email from ``sender`` against their own cap and today's cap.

    None when it was counted; otherwise the cap that refused it (``'sender_daily_cap'`` or
    ``'daily_cap'``), with nothing left counted: a sender claim the deployment cap then refuses
    (or fails on) is given back. An ask without a capped sender (an administrator's, or one created
    before 5.62) counts against the deployment cap only, never one shared empty-sender bucket.
    """
    now = _today()
    day = now.date().isoformat()
    if not sender:
        return None if _claim(table, _count_key(day), cap, now) else DAILY_CAP_REFUSAL
    sender_key = _sender_count_key(day, sender)
    if not _claim(table, sender_key, PER_SENDER_DAILY_CAP, now):
        return SENDER_CAP_REFUSAL
    try:
        counted = _claim(table, _count_key(day), cap, now)
    except Exception:
        _give_back(table, sender_key)
        raise
    if counted:
        return None
    _give_back(table, sender_key)
    return DAILY_CAP_REFUSAL


def _give_back(table: Any, sender_key: Mapping[str, str]) -> None:
    """Undo one sender claim; a failure only leaves that sender one email short today (logged)."""
    try:
        table.update_item(Key=dict(sender_key), UpdateExpression='ADD #c :minus',
                          ExpressionAttributeNames={'#c': 'count'}, ExpressionAttributeValues={':minus': -1})
    except (ClientError, BotoCoreError):
        logger.warning('Could not give back a sender send claim', extra={'day_key': sender_key.get('pk')})
