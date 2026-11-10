"""The one processing-queue message an accepted email becomes (``shared.ingest_schemas.IngestMessage``).

Nothing new in the contract: ``title`` is the subject, ``text`` the new content plus an
``Attachments:`` section (so the source policy redacts the summaries with the body),
``source_channel`` the alias, ``dimensions.feedback_type`` the alias's or subject tag's
type, and the rest rides in flat ``metadata``.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Final

from email_intake.mime import Attachment
from email_intake.model_calls import AttachmentSummary
from shared.email_intake_settings import ALIASES, EMAIL_INTAKE_SOURCE
from shared.ingest_schemas import MAX_TEXT_LENGTH

__all__ = ['EmailItem', 'attachments_section', 'build_message', 'channel_and_type', 'item_text']

#: Subject tags -> values of the built-in ``feedback_type`` (shared.feedback_types). A tag beats the
#: alias (it is the sender's own label); an unknown tag such as ``[review]`` leaves the alias or the model to decide.
SUBJECT_TAG_TYPES: Final = {
    'bug': 'bug', 'bugs': 'bug', 'idea': 'feature_request', 'ideas': 'feature_request',
    'feature': 'feature_request', 'feature request': 'feature_request', 'request': 'feature_request',
    'question': 'question', 'praise': 'praise', 'kudos': 'praise',
}
DEFAULT_CHANNEL: Final = 'feedback'
_SECTION_HEADER: Final = 'Attachments:'


@dataclass(frozen=True)
class EmailItem:
    item_id: str
    created_at: str
    subject: str
    text: str
    author: str
    email: str
    channel: str
    feedback_type: str | None
    thread_id: str
    message_hash: str
    attachment_count: int
    attachments_key: str
    is_reply: bool
    forwarded: bool
    auth: dict[str, str]


def channel_and_type(aliases: list[str], tags: list[str]) -> tuple[str, str | None]:
    """The channel (the first known alias, else the first alias) and the ``feedback_type``."""
    known = [alias for alias in aliases if alias in ALIASES]
    channel = (known or aliases or [DEFAULT_CHANNEL])[0][:64]
    tagged = next((SUBJECT_TAG_TYPES[tag] for tag in tags if tag in SUBJECT_TAG_TYPES), None)
    return channel, tagged or ALIASES.get(channel)


def _not_read_label(attachment: Attachment) -> str:
    return f'- {attachment.filename} (not read)'


def attachments_section(attachments: list[Attachment], summaries: dict[int, AttachmentSummary]) -> str:
    """Each listed attachment: its summary when relevant, its name only otherwise."""
    lines: list[str] = []
    readable = 0
    for attachment in attachments:
        if attachment.kind not in ('document', 'image'):
            lines.append(_not_read_label(attachment))
            continue
        readable += 1
        summary = summaries.get(readable)
        if summary is None:
            lines.append(_not_read_label(attachment))
        elif summary.relevant:
            lines.append(f'- {attachment.filename}: {summary.summary}')
        else:
            lines.append(f'- {attachment.filename} (not relevant)')
    return '\n'.join([_SECTION_HEADER, *lines]) if lines else ''


def item_text(new_text: str, section: str) -> str:
    """The body, then the attachments section, bounded to the queue schema's text limit."""
    if not section:
        return new_text[:MAX_TEXT_LENGTH]
    room = MAX_TEXT_LENGTH - len(section) - 2
    body = new_text[:max(room, 0)]
    return f'{body}\n\n{section}'.strip()[:MAX_TEXT_LENGTH]


def build_message(item: EmailItem) -> dict[str, Any]:
    """The raw queue message (before the source policy and schema validation)."""
    metadata: dict[str, Any] = {
        'email': item.email,
        'thread_id': item.thread_id,
        'message_hash': item.message_hash,
        'attachment_count': item.attachment_count,
        'is_reply': item.is_reply,
        'forwarded': item.forwarded,
        **{f'{check}_verdict': verdict for check, verdict in item.auth.items()},
    }
    if item.attachments_key:
        metadata['attachments_key'] = item.attachments_key
    message: dict[str, Any] = {
        'id': item.item_id,
        'source_platform': EMAIL_INTAKE_SOURCE,
        'source_channel': item.channel,
        'text': item.text,
        'created_at': item.created_at,
        'ingestion_method': 'email',
        'metadata': metadata,
    }
    if item.subject:
        message['title'] = item.subject
    if item.author:
        message['author'] = item.author[:256]
    if item.feedback_type:
        message['dimensions'] = {'feedback_type': item.feedback_type}
    return message
