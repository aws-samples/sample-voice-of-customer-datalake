"""
Runtime Bedrock model selection (issue #96).

Admins pick the active model from a curated allowlist in Settings; the
choice is stored in the aggregates table and resolved here with a short
per-container cache. Resolution order:

    explicit ``model_id`` argument > configured selection > built-in default

The allowlist is deliberately narrow: prompt templates in this project are
tuned for Claude, and both entries are covered by the model agreements the
BedrockAccessStack creates. Free-form model IDs are rejected server-side.

Lambdas without the AGGREGATES_TABLE environment variable or without read
access to the table silently use the default — the lookup must never break
an inference path.
"""
import os
import time

from shared.aws import get_dynamodb_resource, BEDROCK_MODEL_ID
from shared.logging import logger

MODEL_SETTINGS_PK = "SETTINGS#model"
MODEL_SETTINGS_SK = "config"

# Curated allowlist. Both models have agreements created by the
# BedrockAccessStack. MUST stay in lockstep with:
#   - lambda/stream/src/bedrock/model-override.ts (streaming chat lookup)
#   - lib/stacks/api-stack.ts::allowlistedModelArns (IAM invoke grants —
#     a selectable-but-not-invocable model AccessDenies every AI feature)
# `key` is the stable identifier the frontend translates labels under.
ALLOWED_MODELS = [
    {
        "key": "sonnet",
        "id": "global.anthropic.claude-sonnet-4-5-20250929-v1:0",
        "label": "Claude Sonnet 4.5",
        "description": "Highest quality — default for analysis and document generation",
    },
    {
        "key": "haiku",
        "id": "global.anthropic.claude-haiku-4-5-20251001-v1:0",
        "label": "Claude Haiku 4.5",
        "description": "Faster and cheaper — good for high-volume workloads",
    },
]

ALLOWED_MODEL_IDS = {model["id"] for model in ALLOWED_MODELS}

# Per-container cache so hot Lambdas don't hit DynamoDB on every inference.
# Lookup failures are cached for a shorter window: a throttling blip should
# not silently pin inference to the default for the full TTL.
_CACHE_TTL_SECONDS = 60
_ERROR_CACHE_TTL_SECONDS = 10
_cache: dict = {"value": None, "expires": 0.0}


def clear_model_cache() -> None:
    """Reset the container cache (used by tests and after saving settings)."""
    _cache["value"] = None
    _cache["expires"] = 0.0


def get_active_model_id() -> str:
    """Resolve the model to use for Bedrock inference.

    Returns the admin-selected model when one is configured, valid, and
    readable; otherwise the built-in default. Never raises.
    """
    table_name = os.environ.get("AGGREGATES_TABLE", "")
    if not table_name:
        return BEDROCK_MODEL_ID

    now = time.time()
    if _cache["value"] is not None and now < _cache["expires"]:
        return _cache["value"]

    value = BEDROCK_MODEL_ID
    ttl = _CACHE_TTL_SECONDS
    try:
        table = get_dynamodb_resource().Table(table_name)
        item = table.get_item(
            Key={"pk": MODEL_SETTINGS_PK, "sk": MODEL_SETTINGS_SK}
        ).get("Item")
        configured = item.get("model_id") if item else None
        if configured in ALLOWED_MODEL_IDS:
            value = configured
        elif configured:
            logger.warning(f"Configured model '{str(configured)[:80]}' not in allowlist; using default")
    except Exception as e:  # noqa: BLE001 — model lookup must never break inference
        logger.warning(f"Model settings lookup failed; using default: {e}")
        ttl = _ERROR_CACHE_TTL_SECONDS

    _cache["value"] = value
    _cache["expires"] = now + ttl
    return value
