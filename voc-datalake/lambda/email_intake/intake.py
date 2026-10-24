"""One received email, from the SES object in ``inbound/`` to at most one processing-queue message.

Cheapest first, so nothing is spent on mail that is dropped (docs/email-intake.md):

1. parse; guards (spam / virus verdicts, automatic and bulk mail, system senders);
2. a forward is resolved to its original (author = the customer, not the forwarder);
3. the same Message-ID already ingested -> ``duplicate_message``;
4. the per-sender daily cap (``sender_cap``, dropped: the full address when SPF or DKIM
   passed, else one shared bucket per sender DOMAIN), then the overall daily cap: past it
   the email is DEFERRED like a spent model budget (kept in ``inbound/``, retried the
   next day), so a flood of rotating senders can delay real feedback but never lose it;
5. the thread (References / In-Reply-To, else the ``Re:`` subject + domain within 14 days);
   the same new text already seen in the thread -> ``seen_in_thread``; the same forwarded
   original -> ``forward_duplicate`` (the forwarder's domain is added to ``forwarded_by``);
6. a reply is gated: a one-liner or a model ``no_new_info`` -> ``no_new_info``;
7. attachments are read in ONE model call; past the daily model budget the email is
   DEFERRED (left in ``inbound/``, retried the next day), never lost;
8. the message goes through the source policy (``pii: redact`` by default) and the queue
   schema, the original is kept under ``inbound-raw/<item id>/`` (90-day lifecycle) and the
   ``inbound/`` copy is deleted.
"""
from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field
from email.message import EmailMessage
from email.utils import parseaddr
from typing import Any, Final

from botocore.exceptions import BotoCoreError, ClientError

from email_intake import compose, guards, mime, model_calls, text_cleanup
from email_intake.state import IntakeState
from shared.converse import BedrockThrottlingError
from shared.ingest_schemas import validate_message
from shared.logging import logger
from shared.source_policy import policy_message

__all__ = [
    'MAX_RAW_BYTES',
    'DeferredError',
    'IntakeContext',
    'Outcome',
    'drop',
    'process_email',
]

RAW_PREFIX: Final = 'inbound-raw/'
#: An email larger than this is never read (``too_large``): the handler checks the object's size
#: before downloading it, and the parser never sees more. SES itself stores up to 40 MB.
MAX_RAW_BYTES: Final = 25_000_000
_AUTH_HEADERS: Final = {'spf': 'X-SES-SPF-Verdict', 'dkim': 'X-SES-DKIM-Verdict', 'dmarc': 'X-SES-DMARC-Verdict'}
#: A message with less own text than this, carrying a ``.eml``, is a forward-as-attachment.
_FORWARD_NOTE_MAX_CHARS: Final = 500


class DeferredError(Exception):
    """Keep the email in ``inbound/`` and try again tomorrow (``reason`` says why)."""

    reason = 'deferred'


class BudgetSpentError(DeferredError):
    """The daily model budget is spent: keep the email and try again tomorrow."""

    reason = 'model_budget'


class DailyCapError(DeferredError):
    """The overall daily cap is reached: keep the email and try again tomorrow."""

    reason = 'daily_cap'


@dataclass
class IntakeContext:
    s3: Any
    sqs: Any
    bedrock: Any
    state: IntakeState
    bucket: str
    queue_url: str
    inbox_domain: str


@dataclass(frozen=True)
class Outcome:
    status: str  # accepted | dropped | deduped
    reason: str = ''
    item_id: str = ''


@dataclass
class _Content:
    """What the email says, once a forward is resolved to its original."""

    text: str
    author: str
    email: str
    forwarded: bool = False
    forwarder_domain: str = ''
    attachments: list[mime.Attachment] = field(default_factory=list)


def _hash(value: str | bytes) -> str:
    data = value.encode('utf-8') if isinstance(value, str) else value
    return hashlib.sha256(data).hexdigest()[:32]


def _domain(address: str) -> str:
    return address.rpartition('@')[2]


def _from_header(message: EmailMessage) -> tuple[str, str]:
    name, address = parseaddr(str(message.get('From', '')))
    return name.strip(), address.strip().lower()


def _nested_forward(parsed: mime.ParsedEmail, own_text: str) -> _Content | None:
    """A forward sent as an attached ``.eml``: the nested message is the customer's email."""
    if not parsed.nested:
        return None
    if not text_cleanup.is_forward_subject(parsed.subject) and len(own_text) > _FORWARD_NOTE_MAX_CHARS:
        return None
    nested = parsed.nested[0]
    name, address = _from_header(nested)
    return _Content(text=text_cleanup.clean_new_text(mime.body_text(nested)), author=name or address,
                    email=address, forwarded=True)


def _content(parsed: mime.ParsedEmail, sender: str) -> _Content:
    own_text = text_cleanup.clean_new_text(parsed.body)
    nested = _nested_forward(parsed, own_text)
    if nested is not None and nested.text:
        nested.forwarder_domain = _domain(sender)
        return nested
    original = text_cleanup.split_forward(parsed.body) if text_cleanup.is_forward_subject(parsed.subject) else None
    if original is not None:
        return _Content(text=original.body, author=original.sender_name or original.sender,
                        email=original.sender or sender, forwarded=True, forwarder_domain=_domain(sender))
    name, _address = _from_header(parsed.message)
    return _Content(text=own_text, author=name or sender, email=sender)


def _thread(parsed: mime.ParsedEmail, ctx: IntakeContext, sender: str, own_id: str,
            content_hash: str) -> tuple[str, bool]:
    """``(thread_id, is_reply)``."""
    root = mime.thread_root_id(parsed.message)
    if root:
        return f'thr_{_hash(root)}', True
    if text_cleanup.is_reply_subject(parsed.subject):
        known = ctx.state.subject_thread(text_cleanup.normalise_subject(parsed.subject), _domain(sender))
        if known:
            return known, True
    # The same text from the same sender under a new Message-ID joins its first thread, where
    # the content hash is already recorded (``seen_in_thread``).
    resent = ctx.state.content_thread(sender, content_hash)
    if resent:
        return resent, False
    return f'thr_{own_id}', False


def drop(ctx: IntakeContext, reason: str) -> Outcome:
    """Count ``dropped_<reason>`` for today; the dropped Outcome."""
    ctx.state.count(f'dropped_{reason}')
    return Outcome('dropped', reason)


def _dedupe(ctx: IntakeContext, reason: str, item_id: str = '') -> Outcome:
    ctx.state.count(f'deduped_{reason}')
    return Outcome('deduped', reason, item_id)


def _spend(ctx: IntakeContext) -> None:
    if not ctx.state.spend_model_call():
        raise BudgetSpentError


def _gated_out(ctx: IntakeContext, text: str) -> bool:
    """True when a reply's new text adds nothing (``no_new_info``)."""
    if model_calls.is_trivial_reply(text):
        return True
    _spend(ctx)
    try:
        return model_calls.relevance_label(text) == model_calls.LABEL_NONE
    except (BedrockThrottlingError, BotoCoreError, ClientError) as error:
        # Fail open: when the gate cannot answer, the reply is kept as feedback.
        logger.warning('Relevance gate failed; keeping the reply', extra={'error_type': type(error).__name__})
        return False


def _summaries(ctx: IntakeContext, subject: str, attachments: list[mime.Attachment]) -> dict:
    readable = [attachment for attachment in attachments if attachment.kind in ('document', 'image')]
    if not readable:
        return {}
    _spend(ctx)
    return model_calls.summarise_attachments(ctx.bedrock, subject, readable)


def _queue(ctx: IntakeContext, message: dict[str, Any]) -> bool:
    """Policy, schema, queue. False when the policy leaves nothing to queue."""
    policed, _profile = policy_message(message)
    if policed is None:
        return False
    validated = validate_message(policed)
    body = validated.model_dump(mode='json', exclude_none=True)
    ctx.sqs.send_message(QueueUrl=ctx.queue_url, MessageBody=json.dumps(body))
    return True


def _archive(ctx: IntakeContext, key: str, item_id: str) -> str:
    prefix = f'{RAW_PREFIX}{item_id}/'
    ctx.s3.copy_object(Bucket=ctx.bucket, Key=f'{prefix}message.eml',
                       CopySource={'Bucket': ctx.bucket, 'Key': key})
    return prefix


def _auth_verdicts(message: EmailMessage) -> dict[str, str]:
    verdicts = {check: str(message.get(header, '')).strip().upper()[:16] for check, header in _AUTH_HEADERS.items()}
    return {check: verdict for check, verdict in verdicts.items() if verdict}


def _own_id(parsed: mime.ParsedEmail, raw: bytes) -> str:
    """A hash of the Message-ID, or of the whole message when it has none."""
    return _hash(parsed.message_id) if parsed.message_id else _hash(raw)


def _item_id(parsed: mime.ParsedEmail, raw: bytes, content: _Content, content_hash: str) -> str:
    if content.forwarded:
        return f'em_{_hash(f"forward|{content_hash}")}'
    return f'em_{_own_id(parsed, raw)}'


def _sender_bucket(message: EmailMessage, sender: str) -> str:
    """What the per-sender cap counts: the address when SPF or DKIM passed, else the sender's domain.

    An unauthenticated From is free to rotate, so all of them at one domain share one bucket.
    """
    verdicts = _auth_verdicts(message)
    if 'PASS' in (verdicts.get('spf'), verdicts.get('dkim')):
        return sender
    return f'domain:{_domain(sender)}'


def _admitted(ctx: IntakeContext, prepared: _Prepared) -> bool:
    """False when the per-sender cap refuses the email; raises DailyCapError past the daily cap."""
    if not ctx.state.admit_sender(_sender_bucket(prepared.parsed.message, prepared.sender)):
        return False
    if not ctx.state.admit_daily():
        raise DailyCapError
    return True


@dataclass(frozen=True)
class _Prepared:
    parsed: mime.ParsedEmail
    sender: str
    content: _Content
    content_hash: str
    item_id: str


def _prepare(raw: bytes, ctx: IntakeContext) -> _Prepared | Outcome:
    """Parse and guard; the dropped Outcome, or what the email says."""
    if len(raw) > MAX_RAW_BYTES:
        return drop(ctx, 'too_large')
    try:
        parsed = mime.parse_email(raw)
    except (ValueError, LookupError, RecursionError, MemoryError):
        # A hostile structure (deep nesting, a decompression-bomb-sized part) is not an email we read.
        return drop(ctx, 'unparseable')
    reason = guards.drop_reason(parsed.message, ctx.inbox_domain)
    if reason:
        return drop(ctx, reason)
    if parsed.skipped_count:
        logger.info('Attachments skipped (logos, invites, archives, executables)',
                    extra={'skipped': parsed.skipped_count})
    sender = guards.sender_address(parsed.message)
    content = _content(parsed, sender)
    content.attachments = parsed.attachments
    if not content.text and not parsed.attachments:
        return drop(ctx, 'no_text')
    content_hash = text_cleanup.content_hash(content.text or ' '.join(a.filename for a in parsed.attachments))
    return _Prepared(parsed, sender, content, content_hash, _item_id(parsed, raw, content, content_hash))


def _deduped(ctx: IntakeContext, prepared: _Prepared, thread_id: str, is_reply: bool) -> Outcome | None:
    """The dedupe Outcome for a forward, a repeat or a reply without news; None for new feedback."""
    content = prepared.content
    if prepared.content_hash in ctx.state.thread(thread_id).hashes:
        ctx.state.bump_thread(thread_id, 'repeats')
        return _dedupe(ctx, 'seen_in_thread')
    if is_reply and not content.forwarded and content.text and _gated_out(ctx, content.text):
        ctx.state.bump_thread(thread_id, 'no_new_info')
        return _dedupe(ctx, 'no_new_info')
    return None


def _forward_duplicate(ctx: IntakeContext, prepared: _Prepared) -> Outcome | None:
    """A forward of an original already ingested: one more forwarder on that item.

    Checked BEFORE the Message-ID marker: a forwarded original's item id is derived from
    its content, so the second forwarder's email would otherwise read as a re-delivery.
    """
    if not prepared.content.forwarded:
        return None
    existing = ctx.state.forward_item(prepared.content_hash)
    if not existing:
        return None
    ctx.state.record_forward(prepared.content_hash, existing, prepared.content.forwarder_domain)
    return _dedupe(ctx, 'forward_duplicate', existing)


def _accept(ctx: IntakeContext, prepared: _Prepared, key: str, thread_id: str, is_reply: bool) -> Outcome:
    parsed, content = prepared.parsed, prepared.content
    summaries = _summaries(ctx, parsed.subject, content.attachments)
    section = compose.attachments_section(content.attachments, summaries)
    channel, feedback_type = compose.channel_and_type(
        mime.recipient_aliases(parsed.message, ctx.inbox_domain), text_cleanup.subject_tags(parsed.subject))
    attachments_key = _archive(ctx, key, prepared.item_id)
    item = compose.EmailItem(
        item_id=prepared.item_id, created_at=parsed.created_at, subject=parsed.subject,
        text=compose.item_text(content.text, section), author=content.author, email=content.email,
        channel=channel, feedback_type=feedback_type, thread_id=thread_id, message_hash=prepared.content_hash,
        attachment_count=len(content.attachments), attachments_key=attachments_key if content.attachments else '',
        is_reply=is_reply, forwarded=content.forwarded, auth=_auth_verdicts(parsed.message),
    )
    if not _queue(ctx, compose.build_message(item)):
        return drop(ctx, 'no_text')
    _remember(ctx, prepared, thread_id)
    ctx.state.count('accepted')
    return Outcome('accepted', item_id=prepared.item_id)


def _remember(ctx: IntakeContext, prepared: _Prepared, thread_id: str) -> None:
    ctx.state.mark_message(prepared.item_id)
    ctx.state.bump_thread(thread_id, 'messages', prepared.content_hash)
    ctx.state.remember_subject(text_cleanup.normalise_subject(prepared.parsed.subject),
                               _domain(prepared.sender), thread_id)
    ctx.state.remember_content(prepared.sender, prepared.content_hash, thread_id)
    if prepared.content.forwarded:
        ctx.state.record_forward(prepared.content_hash, prepared.item_id, prepared.content.forwarder_domain)


def process_email(raw: bytes, key: str, ctx: IntakeContext) -> Outcome:
    """Decide one email. Raises a ``DeferredError`` when it must wait for tomorrow (model budget, daily cap)."""
    prepared = _prepare(raw, ctx)
    if isinstance(prepared, Outcome):
        return prepared
    forward = _forward_duplicate(ctx, prepared)
    if forward is not None:
        return forward
    if ctx.state.message_seen(prepared.item_id):
        return _dedupe(ctx, 'duplicate_message', prepared.item_id)
    if not _admitted(ctx, prepared):
        return drop(ctx, 'sender_cap')
    thread_id, is_reply = _thread(prepared.parsed, ctx, prepared.sender, _own_id(prepared.parsed, raw),
                                  prepared.content_hash)
    deduped = _deduped(ctx, prepared, thread_id, is_reply)
    if deduped is not None:
        return deduped
    return _accept(ctx, prepared, key, thread_id, is_reply)
