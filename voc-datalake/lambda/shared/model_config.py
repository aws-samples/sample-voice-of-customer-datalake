"""
Runtime Bedrock model selection, per AI surface (issue #96).

Admins pick the active model for each AI *surface* (chat, document
generation, prototype builder, feedback enrichment, misc utility) from a
curated allowlist in Settings. Choices are stored in the aggregates table
and resolved here with a short per-container cache.

Resolution order for a surface ``S``::

    explicit model_id argument
    > per-surface override      (settings.surfaces[S])
    > legacy global override    (settings.model_id — applies to every surface)
    > built-in default for S    (SURFACE_DEFAULTS[S])
    > BEDROCK_MODEL_ID

The per-surface design replaces the single global toggle: an admin can, for
example, keep enrichment on cheap Haiku while running chat on Sonnet 5 and
prototypes on Opus 4.8. The legacy global ``model_id`` is still honoured as a
fallback so a value written by the older single-model picker keeps working.

The allowlist is deliberately narrow: prompt templates in this project are
tuned for Claude, and every entry is covered by the model agreements the
BedrockAccessStack creates. Free-form model IDs are rejected server-side.

Lambdas without the AGGREGATES_TABLE environment variable, or without read
access to the table, silently use the surface default — the lookup must
never break an inference path.
"""
import os
import time

from shared.aws import get_dynamodb_resource, BEDROCK_MODEL_ID
from shared.logging import logger

MODEL_SETTINGS_PK = "SETTINGS#model"
MODEL_SETTINGS_SK = "config"

# --- Curated allowlist -------------------------------------------------------
# MUST stay in lockstep with:
#   - lambda/stream/src/bedrock/model-override.ts        (streaming-chat lookup)
#   - lib/stacks/api-stack.ts::allowlistedModelArns       (IAM invoke grants)
#   - lib/stacks/processing-stack-consolidated.ts         (processor/aggregator/research grants)
# A model that is selectable but not invocable AccessDenies the whole surface,
# so the Python lockstep tests read the TS mirror and the CDK helper and assert
# all three agree (a model added to one place fails the build until all match).
#
# Field notes:
#   key               — stable id the frontend translates labels under.
#   id                — global cross-region inference profile ID (verified
#                       against the Bedrock model cards).
#   omit_temperature  — the model rejects the `temperature` inference param
#                       (Sonnet 5 runs adaptive thinking always-on; Opus 4.8
#                       deprecates temperature). converse() drops temperature
#                       automatically for these so any surface can point at them.
ALLOWED_MODELS = [
    {
        "key": "sonnet5",
        "id": "global.anthropic.claude-sonnet-5",
        "label": "Claude Sonnet 5",
        "description": "Latest, highest-quality Sonnet — best for analysis and generation",
        "omit_temperature": True,
    },
    {
        "key": "sonnet46",
        "id": "global.anthropic.claude-sonnet-4-6",
        "label": "Claude Sonnet 4.6",
        "description": "Previous-generation Sonnet — strong quality, accepts temperature tuning",
        "omit_temperature": False,
    },
    {
        "key": "opus48",
        "id": "global.anthropic.claude-opus-4-8",
        "label": "Claude Opus 4.8",
        "description": "Deepest reasoning — best for prototypes and complex documents",
        "omit_temperature": True,
    },
    {
        "key": "haiku45",
        "id": "global.anthropic.claude-haiku-4-5-20251001-v1:0",
        "label": "Claude Haiku 4.5",
        "description": "Fastest and cheapest — good for high-volume enrichment",
        "omit_temperature": False,
    },
]
ALLOWED_MODEL_IDS = {m["id"] for m in ALLOWED_MODELS}
_OMIT_TEMPERATURE_IDS = {m["id"] for m in ALLOWED_MODELS if m["omit_temperature"]}

# Short aliases for the surface-default table below.
_SONNET5 = "global.anthropic.claude-sonnet-5"
_OPUS48 = "global.anthropic.claude-opus-4-8"
_HAIKU45 = "global.anthropic.claude-haiku-4-5-20251001-v1:0"

# Models that run adaptive thinking always-on: they don't accept an explicit
# extended-thinking budget (Sonnet 5). converse() and the streaming client skip
# the `thinking` request field for these so pointing a surface at them can't 400.
_ADAPTIVE_THINKING_IDS = {_SONNET5}

# --- Surfaces ----------------------------------------------------------------
# Every independently selectable AI surface with its built-in default (the
# "Automatic" behaviour when the admin hasn't pinned a model). The default is
# chosen for the surface's workload: cheap Haiku on the high-volume enrichment
# path, deep Opus on the prototype builder, flagship Sonnet everywhere else.
#
# "default" is an internal fallback bucket for any converse() caller that
# doesn't name a surface; it is NOT exposed in the picker.
SURFACE_DEFAULTS = {
    "default": _SONNET5,
    "chat": _SONNET5,
    "documents": _SONNET5,
    "prototype": _OPUS48,
    "enrichment": _HAIKU45,
    "utility": _SONNET5,
}
DEFAULT_SURFACE = "default"

# Surfaces exposed in the Settings picker, in display order. Each carries a
# short description key the frontend translates under `aiModel.surfaces.<key>`.
PICKER_SURFACES = ("chat", "documents", "prototype", "enrichment", "utility")


def surface_default(surface: str) -> str:
    """Built-in default model ID for a surface. Never raises."""
    return SURFACE_DEFAULTS.get(surface, BEDROCK_MODEL_ID)


def omits_temperature(model_id: str) -> bool:
    """True when the model rejects the `temperature` inference parameter."""
    return model_id in _OMIT_TEMPERATURE_IDS


def uses_adaptive_thinking(model_id: str) -> bool:
    """True when the model runs adaptive thinking always-on and rejects an
    explicit extended-thinking budget (skip the `thinking` request field)."""
    return model_id in _ADAPTIVE_THINKING_IDS


# --- Per-container cache -----------------------------------------------------
# Cache the whole settings item (surfaces map + legacy global) so hot Lambdas
# don't read DynamoDB on every inference. Failures cache for a shorter window
# so a throttling blip doesn't pin inference to defaults for the full minute.
_CACHE_TTL_SECONDS = 60
_ERROR_CACHE_TTL_SECONDS = 10
_cache: dict = {"value": None, "expires": 0.0}


def clear_model_cache() -> None:
    """Reset the container cache (used by tests and after saving settings)."""
    _cache["value"] = None
    _cache["expires"] = 0.0


def _load_settings() -> dict:
    """Return the cached model-settings item, or {} when absent/unreadable.

    Shape: ``{'surfaces': {surface: model_id}, 'model_id': <legacy global>}``.
    Never raises — a missing table env, missing item, or read failure all
    resolve to an empty dict so callers fall back to surface defaults.
    """
    table_name = os.environ.get("AGGREGATES_TABLE", "")
    if not table_name:
        return {}
    now = time.time()
    if _cache["value"] is not None and now < _cache["expires"]:
        return _cache["value"]
    value: dict = {}
    ttl = _CACHE_TTL_SECONDS
    try:
        table = get_dynamodb_resource().Table(table_name)
        item = table.get_item(
            Key={"pk": MODEL_SETTINGS_PK, "sk": MODEL_SETTINGS_SK}
        ).get("Item")
        if isinstance(item, dict):
            value = item
    except Exception as e:  # noqa: BLE001 — model lookup must never break inference
        logger.warning(f"Model settings lookup failed; using defaults: {e}")
        ttl = _ERROR_CACHE_TTL_SECONDS
    _cache["value"] = value
    _cache["expires"] = now + ttl
    return value


def _allowlisted(model_id) -> str | None:
    """Return model_id when it is a valid allowlisted string, else None.

    A configured value outside the allowlist (tampered/stale DB row) is
    logged and ignored so it can never reach Bedrock.
    """
    if isinstance(model_id, str) and model_id in ALLOWED_MODEL_IDS:
        return model_id
    if model_id:
        logger.warning(f"Configured model '{str(model_id)[:80]}' not in allowlist; ignoring")
    return None


def get_active_model_id(surface: str = DEFAULT_SURFACE) -> str:
    """Resolve the Bedrock model ID to use for a given AI surface.

    Never raises. Precedence: per-surface override > legacy global override >
    built-in surface default > BEDROCK_MODEL_ID.
    """
    settings = _load_settings()
    surfaces = settings.get("surfaces")
    if isinstance(surfaces, dict):
        per_surface = _allowlisted(surfaces.get(surface))
        if per_surface:
            return per_surface
    legacy_global = _allowlisted(settings.get("model_id"))
    if legacy_global:
        return legacy_global
    return surface_default(surface)
