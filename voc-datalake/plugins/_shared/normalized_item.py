"""
The common raw-item schema every plugin hands to the processing queue.

``BaseIngestor.normalize_item`` and ``BaseWebhook.normalize_item`` build the
same core record and then add their own transport-specific fields (S3 raw
pointer vs. ``is_webhook``). The shared core lives here so the two cannot
drift apart.
"""

from datetime import UTC, datetime

from shared.producer_labels import message_labels


def normalized_item_fields(
    item: dict, *, source_platform: str, default_channel: str, brand_name: str
) -> dict:
    """Return the core normalized fields shared by ingestors and webhooks.

    ``issue_attributes`` (issue-tracker sources, see ``schemas.IssueAttributes``)
    is carried only when the item has it, so every other source's message keeps
    exactly the shape it had.
    """
    issue_attributes = item.get("issue_attributes")
    return {
        "id": item.get("id", ""),
        "source_platform": source_platform,
        "source_channel": item.get("channel", default_channel),
        "url": item.get("url", ""),
        "text": item.get("text", ""),
        "rating": item.get("rating"),
        "created_at": item.get(
            "created_at", datetime.now(UTC).isoformat()
        ),
        "ingested_at": datetime.now(UTC).isoformat(),
        "brand_name": brand_name,
        "brand_handles_matched": item.get("brand_handles_matched", []),
        **({"issue_attributes": issue_attributes} if issue_attributes else {}),
        **_optional_fields(item),
    }


# Optional producer fields carried only when the item has them (string values
# bounded to the queue schema's limits), so a source that sets none keeps
# exactly the message shape it had.
_OPTIONAL_TEXT_LIMITS = {"author": 256, "title": 500}


def _optional_fields(item: dict) -> dict:
    out: dict = {}
    for key, limit in _OPTIONAL_TEXT_LIMITS.items():
        value = item.get(key)
        if isinstance(value, str) and value.strip():
            out[key] = value.strip()[:limit]
    return {**out, **message_labels(item.get("dimensions"), item.get("tags"))}
