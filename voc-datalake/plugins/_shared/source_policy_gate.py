"""The source-policy choke point every plugin transport passes through.

``BaseIngestor`` and ``BaseWebhook`` (and every subclass, however it builds its
messages) hand their batch to ``policy_messages`` immediately before SQS, and
``archive_raw_item`` asks ``raw_archive_permitted`` before it writes anything,
so a redact / summary-only source never archives a raw copy and never queues
the author or unredacted text (``shared/source_policy.py``).

Both FAIL CLOSED: when the source profiles cannot be read they raise
``SourceProfilesUnavailable`` — the ingestor run / webhook delivery fails and is
retried — instead of archiving or queueing under the allow default.
"""

from shared.source_policy import policy_message, raw_archive_allowed
from shared.source_profiles import cached_source_profile_strict

__all__ = ["policy_messages", "raw_archive_permitted"]


def policy_messages(items: list[dict]) -> list[dict]:
    """Each message under its source's policy; a message without text is dropped."""
    out: list[dict] = []
    for item in items:
        message, _profile = policy_message(item)
        if message is not None:
            out.append(message)
    return out


def raw_archive_permitted(source_platform: str) -> bool:
    """True when ``source_platform``'s profile lets it keep a raw copy; raises when it cannot be read."""
    return raw_archive_allowed(cached_source_profile_strict(source_platform))
