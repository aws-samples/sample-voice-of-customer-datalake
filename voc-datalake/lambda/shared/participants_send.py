"""The async send job of an ask: ``{"engagement_job": "send_ask", "ask_id", "cursor"?}``.

``POST /participants/asks`` writes the ask and its ``queued`` recipients, then invokes
the engagement Lambda ITSELF with this event (``lambda_handler`` routes it before the
resolver). One invocation sends at most ``SEND_BATCH`` recipients, at most
``MAX_SENDS_PER_SECOND``, and stops early when the Lambda's time runs low; it then
re-invokes itself with the last recipient it settled as ``cursor``.

Per recipient: an erased person fails with ``erased``, an unsubscribed one is
``skipped_unsubscribed``, today's cap reached fails with ``daily_cap``; otherwise a
fresh response token (form links) and unsubscribe token are minted and the email is
sent. A refused send records the SES error CODE only (``MessageRejected``), never
the exception text, which can carry the address. A recipient is settled only from
``queued``, so a repeated event never sends twice to anyone already settled.
"""
from __future__ import annotations

import re
import time
from collections.abc import Mapping
from typing import Any, Final
from urllib.parse import quote

from botocore.exceptions import BotoCoreError, ClientError

from shared import engagement_config, participant_mailer
from shared.aws import invoke_lambda_async
from shared.engagement_common import is_id, now_iso
from shared.logging import logger
from shared.participants_asks import (
    ASK_FAILED,
    ASK_SENDING,
    ASK_SENT,
    CAP_SENDER_FIELD,
    RCPT_FAILED,
    RCPT_QUEUED,
    RCPT_SENT,
    RCPT_SKIPPED,
    bump_count,
    claim_send,
    get_ask,
    mint_response_token,
    mint_unsubscribe_token,
    recipient_rows,
    set_ask_status,
    settle_recipient,
)
from shared.participants_settings import load_settings
from shared.participants_store import get_people, is_active

SEND_JOB: Final = 'send_ask'
JOB_FIELD: Final = 'engagement_job'
SEND_BATCH: Final = 200
MAX_SENDS_PER_SECOND: Final = 10
# Stop with this much of the invocation left: one send plus the re-invoke fit easily.
MIN_REMAINING_MS: Final = 10_000
ERROR_ERASED: Final = 'erased'
ERROR_SEND: Final = 'send_error'
_ERROR_CODE: Final = re.compile(r'^[A-Za-z][A-Za-z0-9_.]{0,63}\Z')


def is_send_event(event: object) -> bool:
    return isinstance(event, dict) and event.get(JOB_FIELD) == SEND_JOB and 'httpMethod' not in event


def start(ask_id: str, cursor: str | None = None) -> None:
    payload: dict[str, Any] = {JOB_FIELD: SEND_JOB, 'ask_id': ask_id}
    if cursor:
        payload['cursor'] = cursor
    invoke_lambda_async(engagement_config.engagement_function(), payload)


class Pacer:
    """Keeps sends at most ``per_second`` apart."""

    def __init__(self, per_second: int) -> None:
        self._interval = 1.0 / per_second
        self._last: float | None = None

    def wait(self) -> None:
        now = time.monotonic()
        if self._last is not None and now - self._last < self._interval:
            time.sleep(self._interval - (now - self._last))
        self._last = time.monotonic()


def error_code(error: Exception) -> str:
    """A short, safe code for a failed send: the AWS error code, never the message."""
    code = error.response.get('Error', {}).get('Code') if isinstance(error, ClientError) else None
    return code if isinstance(code, str) and _ERROR_CODE.match(code) else ERROR_SEND


def _links(ask: Mapping[str, Any], response_token: str | None, unsubscribe_token: str) -> tuple[str, str, str]:
    """``(the ask's link, the unsubscribe page, the one-click unsubscribe POST url)``."""
    link = ask.get('link') or {}
    url = str(link.get('url', ''))
    if response_token:
        url = f'{url}?r={quote(response_token)}'
    token = quote(unsubscribe_token)
    return (url, f'{engagement_config.frontend_url()}/unsubscribe?t={token}',
            f'{ask.get("api_base", "")}/unsubscribe?t={token}')


def _deliver(table: Any, ask: Mapping[str, Any], person: Mapping[str, Any], sender_name: str) -> str | None:
    """Send to one active person; None on success, else the error code to record."""
    person_id = str(person['person_id'])
    is_form = (ask.get('link') or {}).get('kind') == 'form'
    response_token = mint_response_token(table, ask, person_id) if is_form else None
    link, page, post = _links(ask, response_token, mint_unsubscribe_token(table, person_id))
    email = participant_mailer.AskEmail(
        to=str(person['email']), subject=str(ask.get('subject', '')), message=str(ask.get('message', '')),
        link=link, sender_name=sender_name, unsubscribe_page=page, unsubscribe_post=post,
        reply_to=str(ask.get('created_by_email') or ''), recipient_name=str(person.get('name') or ''))
    try:
        participant_mailer.send(email, engagement_config.email_from())
    except (ClientError, BotoCoreError) as error:
        code = error_code(error)
        logger.warning('Ask email not sent', extra={'ask_id': ask['ask_id'], 'person_id': person_id, 'code': code})
        return code
    return None


def _settle(table: Any, ask_id: str, person_id: str, status: str, counter: str, **fields: Any) -> None:
    if settle_recipient(table, ask_id, person_id, status, **fields):
        bump_count(table, ask_id, counter)


def _send_one(table: Any, ask: Mapping[str, Any], row: Mapping[str, Any], person: Mapping[str, Any] | None,
              settings: Mapping[str, Any], pacer: Pacer) -> None:
    ask_id, person_id = str(ask['ask_id']), str(row['person_id'])
    if person is None:
        _settle(table, ask_id, person_id, RCPT_FAILED, 'failed', error=ERROR_ERASED)
    elif not is_active(person):
        _settle(table, ask_id, person_id, RCPT_SKIPPED, 'skipped')
    elif (refusal := claim_send(table, int(settings['daily_send_cap']), str(ask.get(CAP_SENDER_FIELD) or ''))) is not None:
        _settle(table, ask_id, person_id, RCPT_FAILED, 'failed', error=refusal)
    else:
        pacer.wait()
        code = _deliver(table, ask, person, str(settings['sender_name']))
        if code:
            _settle(table, ask_id, person_id, RCPT_FAILED, 'failed', error=code)
        else:
            _settle(table, ask_id, person_id, RCPT_SENT, 'sent', sent_at=now_iso())


def _finish(table: Any, ask_id: str) -> str:
    counts = (get_ask(table, ask_id) or {}).get('counts') or {}
    status = ASK_FAILED if not counts.get('sent') and counts.get('failed') else ASK_SENT
    set_ask_status(table, ask_id, status)
    logger.info('Ask sent', extra={'ask_id': ask_id, 'status': status,
                                   **{key: int(value) for key, value in counts.items()}})
    return status


def _out_of_time(context: Any) -> bool:
    remaining = getattr(context, 'get_remaining_time_in_millis', None)
    if not callable(remaining):
        return False
    left = remaining()
    return isinstance(left, int | float) and left < MIN_REMAINING_MS


def _send_batch(table: Any, ask: Mapping[str, Any], rows: list[dict[str, Any]], context: Any) -> str | None:
    """Settle ``rows`` in order; the sort key to continue after when time ran out, else None."""
    settings = load_settings(table, engagement_config.brand_name())
    queued = [row for row in rows if row.get('status') == RCPT_QUEUED]
    people = get_people(table, [str(row['person_id']) for row in queued])
    pacer = Pacer(MAX_SENDS_PER_SECOND)
    last: str | None = None
    for row in rows:
        if _out_of_time(context) and last is not None:
            return last
        if row.get('status') == RCPT_QUEUED:
            _send_one(table, ask, row, people.get(str(row['person_id'])), settings, pacer)
        last = str(row['sk'])
    return None


def run(event: Mapping[str, Any], context: Any) -> dict[str, Any]:
    """One invocation of the send job (see the module docstring)."""
    raw_id = event.get('ask_id')
    cursor = event.get('cursor') if isinstance(event.get('cursor'), str) else None
    if not isinstance(raw_id, str) or not is_id(raw_id, 'ask'):
        logger.warning('Send job without a valid ask id')
        return {'status': 'ignored'}
    ask_id: str = raw_id
    table = engagement_config.participants_table()
    ask = get_ask(table, ask_id)
    if ask is None or ask.get('status') in (ASK_SENT, ASK_FAILED):
        return {'status': 'ignored'}
    if not engagement_config.email_from():
        set_ask_status(table, ask_id, ASK_FAILED)
        return {'status': ASK_FAILED}
    set_ask_status(table, ask_id, ASK_SENDING)
    rows = recipient_rows(table, ask_id, after=cursor, limit=SEND_BATCH + 1)
    batch = rows[:SEND_BATCH]
    stopped_at = _send_batch(table, ask, batch, context)
    if stopped_at is None and len(rows) > SEND_BATCH:
        stopped_at = str(batch[-1]['sk'])
    if stopped_at is not None:
        start(ask_id, stopped_at)
        return {'status': ASK_SENDING, 'cursor': stopped_at}
    return {'status': _finish(table, ask_id)}
