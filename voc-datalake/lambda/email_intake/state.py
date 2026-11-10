"""The inbox's own state: caps, daily counters, threads and dedupe markers.

Two tables, no new one (plan, "Dedupe and threading"):

- ``voc-watermarks`` (key ``source``), rows prefixed ``email_intake#``, each with a ``ttl``:
  - ``email_intake#thread#<thread_id>``: ``hashes`` (string set of the content hashes
    seen in the thread), ``messages`` / ``repeats`` / ``no_new_info`` counters, ``last_seen``.
  - ``email_intake#subject#<hash>``: the subject fallback (normalised subject + sender
    domain) -> ``thread_id``, honoured for ``SUBJECT_WINDOW`` only.
  - ``email_intake#content#<hash>``: sender address + content hash -> ``thread_id`` for
    ``SUBJECT_WINDOW``, so a re-sent copy under a new ``Message-ID`` joins its first thread.
  - ``email_intake#message#<item_id>``: this Message-ID was already ingested.
  - ``email_intake#forward#<content hash>``: the item made from a forwarded original,
    ``forwarded_by`` (a set of forwarder DOMAINS, never addresses) and ``forwards``.
  - ``email_intake#sender#<sender hash>#<day>``: the per-sender daily count, keyed on the
    address when SPF or DKIM passed, else on ``domain:<sender domain>`` (``intake._sender_bucket``).
- ``voc-aggregates``: the caps row and the day's counters (``shared.email_intake_settings``).

Every counter is an atomic ``ADD``; a cap is a conditional ``ADD``, so concurrent workers
cannot overshoot it.
"""
from __future__ import annotations

import hashlib
import time
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any, Final

from botocore.exceptions import ClientError

from shared.aws import is_conditional_check_failure
from shared.email_intake_settings import CONFIG_KEY, caps_from_row, stats_key
from shared.timestamps import now_iso

__all__ = ['IntakeState']

_PREFIX: Final = 'email_intake#'
THREAD_TTL: Final = timedelta(days=90)
SUBJECT_WINDOW: Final = timedelta(days=14)
MESSAGE_TTL: Final = timedelta(days=30)
FORWARD_TTL: Final = timedelta(days=180)
SENDER_TTL: Final = timedelta(days=2)
STATS_TTL: Final = timedelta(days=90)


def _hash(value: str) -> str:
    return hashlib.sha256(value.encode('utf-8')).hexdigest()[:32]


def _key(kind: str, *parts: str) -> dict[str, str]:
    """The watermarks key of one inbox row, ``email_intake#<kind>#<part>[#<part>]``."""
    return {'source': '#'.join((f'{_PREFIX}{kind}', *parts))}


def _subject_key(normalised_subject: str, domain: str) -> dict[str, str]:
    return _key('subject', _hash(f'{normalised_subject}|{domain}'))


def _content_key(sender: str, content_hash: str) -> dict[str, str]:
    return _key('content', _hash(f'{sender.lower()}|{content_hash}'))


def _epoch(delta: timedelta) -> int:
    return int(time.time() + delta.total_seconds())


@dataclass(frozen=True)
class ThreadView:
    """What the thread already holds."""

    exists: bool
    hashes: frozenset[str]


class IntakeState:
    """Reads and writes of one worker invocation (tables injected for tests)."""

    def __init__(self, watermarks: Any, aggregates: Any, *, day: str) -> None:
        self._watermarks = watermarks
        self._aggregates = aggregates
        self.day = day
        self._caps: dict[str, int] | None = None

    # -- caps and counters ---------------------------------------------------------------

    def caps(self) -> dict[str, int]:
        if self._caps is None:
            row = self._aggregates.get_item(Key=CONFIG_KEY).get('Item')
            self._caps = caps_from_row(row)
        return self._caps

    def count(self, counter: str, amount: int = 1) -> None:
        """``ADD counter :amount`` on today's stats row."""
        self._aggregates.update_item(
            Key=stats_key(self.day),
            UpdateExpression='ADD #c :n SET #t = if_not_exists(#t, :ttl)',
            ExpressionAttributeNames={'#c': counter, '#t': 'ttl'},
            ExpressionAttributeValues={':n': amount, ':ttl': _epoch(STATS_TTL)},
        )

    def _capped_add(self, table: Any, key: dict, counter: str, cap: int, ttl: int) -> bool:
        """``ADD counter 1`` unless it already reached ``cap``; False when the cap holds."""
        try:
            table.update_item(
                Key=key,
                UpdateExpression='ADD #c :one SET #t = if_not_exists(#t, :ttl)',
                ConditionExpression='attribute_not_exists(#c) OR #c < :cap',
                ExpressionAttributeNames={'#c': counter, '#t': 'ttl'},
                ExpressionAttributeValues={':one': 1, ':cap': cap, ':ttl': ttl},
            )
        except ClientError as error:
            if is_conditional_check_failure(error):
                return False
            raise
        return True

    def admit_daily(self) -> bool:
        """Count one more received email today; False past the overall daily cap."""
        return self._capped_add(self._aggregates, stats_key(self.day), 'received',
                                self.caps()['daily_cap'], _epoch(STATS_TTL))

    def admit_sender(self, sender_bucket: str) -> bool:
        """Count one more email for ``sender_bucket`` (an address or ``domain:<d>``) today; False past the cap."""
        key = _key('sender', _hash(sender_bucket), self.day)
        return self._capped_add(self._watermarks, key, 'count',
                                self.caps()['sender_daily_cap'], _epoch(SENDER_TTL))

    def spend_model_call(self) -> bool:
        """Take one model call from today's budget; False when it is spent."""
        budget = self.caps()['daily_model_calls']
        if budget <= 0:
            return False
        return self._capped_add(self._aggregates, stats_key(self.day), 'model_calls', budget, _epoch(STATS_TTL))

    # -- dedupe markers -------------------------------------------------------------------

    def message_seen(self, item_id: str) -> bool:
        item = self._watermarks.get_item(Key=_key('message', item_id)).get('Item')
        return bool(item) and int(item.get('ttl', 0)) > time.time()

    def mark_message(self, item_id: str) -> None:
        self._watermarks.put_item(Item={
            **_key('message', item_id), 'ttl': _epoch(MESSAGE_TTL),
            'seen_at': now_iso(),
        })

    def subject_thread(self, normalised_subject: str, domain: str) -> str | None:
        """The thread a ``Re:`` without headers belongs to: same subject + domain within 14 days."""
        if not normalised_subject:
            return None
        item = self._watermarks.get_item(Key=_subject_key(normalised_subject, domain)).get('Item') or {}
        last_seen = item.get('last_seen')
        if not isinstance(last_seen, str) or not isinstance(item.get('thread_id'), str):
            return None
        try:
            stale = datetime.fromisoformat(last_seen) < datetime.now(UTC) - SUBJECT_WINDOW
        except (TypeError, ValueError):
            return None
        if stale:
            return None
        return item['thread_id']

    def remember_subject(self, normalised_subject: str, domain: str, thread_id: str) -> None:
        if not normalised_subject:
            return
        self._watermarks.put_item(Item={
            **_subject_key(normalised_subject, domain),
            'thread_id': thread_id, 'last_seen': now_iso(), 'ttl': _epoch(SUBJECT_WINDOW),
        })

    def content_thread(self, sender: str, content_hash: str) -> str | None:
        """The thread a fresh email's text already landed in, from the same sender within 14 days.

        Catches a re-sent copy under a new ``Message-ID`` (a client re-send, a relay that rewrites
        ids, a copy to a second alias) that the Message-ID marker cannot see.
        """
        if not sender or not content_hash:
            return None
        item = self._watermarks.get_item(Key=_content_key(sender, content_hash)).get('Item') or {}
        thread_id = item.get('thread_id')
        if not isinstance(thread_id, str) or int(item.get('ttl', 0)) <= time.time():
            return None
        return thread_id

    def remember_content(self, sender: str, content_hash: str, thread_id: str) -> None:
        if not sender or not content_hash:
            return
        self._watermarks.put_item(Item={
            **_content_key(sender, content_hash), 'thread_id': thread_id, 'ttl': _epoch(SUBJECT_WINDOW),
        })

    # -- threads --------------------------------------------------------------------------

    def thread(self, thread_id: str) -> ThreadView:
        item = self._watermarks.get_item(Key=_key('thread', thread_id)).get('Item')
        if not item:
            return ThreadView(exists=False, hashes=frozenset())
        hashes = item.get('hashes') or set()
        return ThreadView(exists=True, hashes=frozenset(str(value) for value in hashes))

    def bump_thread(self, thread_id: str, counter: str, content_hash: str | None = None) -> None:
        """Count ``counter`` on the thread; with ``content_hash``, record it as seen too."""
        names = {'#c': counter, '#t': 'ttl', '#l': 'last_seen'}
        values: dict[str, Any] = {':one': 1, ':ttl': _epoch(THREAD_TTL), ':now': now_iso()}
        expression = 'ADD #c :one'
        if content_hash:
            expression += ', hashes :h'
            values[':h'] = {content_hash}
        self._watermarks.update_item(
            Key=_key('thread', thread_id),
            UpdateExpression=f'{expression} SET #t = :ttl, #l = :now',
            ExpressionAttributeNames=names,
            ExpressionAttributeValues=values,
        )

    # -- forwards -------------------------------------------------------------------------

    def forward_item(self, original_hash: str) -> str | None:
        item = self._watermarks.get_item(Key=_key('forward', original_hash)).get('Item') or {}
        item_id = item.get('item_id')
        return item_id if isinstance(item_id, str) else None

    def record_forward(self, original_hash: str, item_id: str, forwarder_domain: str) -> None:
        """One more forward of the original: its item id, the forwarder's domain, the count."""
        self._watermarks.update_item(
            Key=_key('forward', original_hash),
            UpdateExpression='ADD forwards :one, forwarded_by :d SET item_id = if_not_exists(item_id, :id), #t = :ttl',
            ExpressionAttributeNames={'#t': 'ttl'},
            ExpressionAttributeValues={':one': 1, ':d': {forwarder_domain or 'unknown'}, ':id': item_id,
                                       ':ttl': _epoch(FORWARD_TTL)},
        )
