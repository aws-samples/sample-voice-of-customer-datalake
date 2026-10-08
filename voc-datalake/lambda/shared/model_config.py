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
example, keep enrichment on cheap Haiku while running chat on Sonnet 5.5 and
prototypes on Opus 5.5. The legacy global ``model_id`` is still honoured as a
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

from shared.aws import BEDROCK_MODEL_ID, get_dynamodb_resource
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
#   omit_temperature  — the model rejects the `temperature` inference param.
#                       converse() drops temperature automatically for these so
#                       any surface can point at them.
#   adaptive_thinking — the model runs adaptive thinking always-on and rejects
#                       an explicit `thinking.budget_tokens` with a 400 (true
#                       for Sonnet 5 / 5.5, Haiku 5.5 and Opus 4.7 and later). converse()
#                       and the streaming client skip the `thinking` field for
#                       these. Declared per-model rather than hand-listed in a
#                       separate set below: keeping both capability flags as
#                       data on the same row is what stops a newly added model
#                       from landing in one set and not the other.
#   supports_flex     — Bedrock serves the model on the Flex service tier
#                       (Converse `serviceTier: {type: 'flex'}`). Source: the
#                       "Service Tiers" table on each Bedrock model card
#                       (docs.aws.amazon.com/bedrock/latest/userguide/
#                       model-card-anthropic-<model>.html): every Claude model
#                       below lists Flex as NOT supported (checked 2026-10-06;
#                       Opus 5.5 / Haiku 5.5 refuse it when probed).
#                       converse() never puts Flex on the wire for a model
#                       without it — it sends 'default' instead — because a
#                       refused Flex request costs a failed round trip per call
#                       (Haiku 4.5 on the memory surface did exactly that).
#                       Unknown means False: set True only from the model card.
#   context_window    — input context window in tokens. Read by
#                       context_window_tokens() so callers that assemble large
#                       prompts can derive a character budget from the model
#                       actually resolved for their surface instead of assuming
#                       one (issue #231). A literal budget tuned for 200 K
#                       tokens overflows a smaller-window model as a hard
#                       Bedrock ValidationException.
ALLOWED_MODELS = [
    {
        "key": "opus55",
        "id": "global.anthropic.claude-opus-5-5",
        "label": "Claude Opus 5.5",
        "description": "Deepest reasoning — default for prototypes and the agent conductor and reviewer",
        "omit_temperature": True,
        "adaptive_thinking": True,
        "supports_flex": False,
        # Not verified on the model card yet: 200 K is the conservative choice
        # (an over-estimate would overflow the window as a hard 400).
        "context_window": 200_000,
    },
    {
        "key": "sonnet55",
        "id": "global.anthropic.claude-sonnet-5-5",
        "label": "Claude Sonnet 5.5",
        "description": "Newest Sonnet with a 1M-token context — default for the AI assistant, documents and utilities",
        "omit_temperature": True,
        "adaptive_thinking": True,
        "supports_flex": False,
        # 1M per the Bedrock model card. The only consumer today is the
        # persona-generation budget on the 'documents' surface
        # (projects.persona_context_budget), which fills at most
        # CONTEXT_UTILISATION of the window — so pinning documents to this
        # model deliberately grows that corpus ~5x. The 200 K fallback for
        # unknown ids (min of the windows) is unchanged.
        "context_window": 1_000_000,
    },
    {
        "key": "sonnet5",
        "id": "global.anthropic.claude-sonnet-5",
        "label": "Claude Sonnet 5",
        "description": "Previous-generation Sonnet — strong analysis and generation",
        "omit_temperature": True,
        "adaptive_thinking": True,
        "supports_flex": False,
        "context_window": 200_000,
    },
    {
        "key": "sonnet46",
        "id": "global.anthropic.claude-sonnet-4-6",
        "label": "Claude Sonnet 4.6",
        "description": "Previous-generation Sonnet (4.6) — strong quality, accepts temperature tuning",
        "omit_temperature": False,
        # Manual extended thinking is deprecated here but still accepted; only
        # Opus 4.7+ and Sonnet 5 hard-reject it.
        "adaptive_thinking": False,
        "supports_flex": False,
        "context_window": 200_000,
    },
    {
        "key": "opus5",
        "id": "global.anthropic.claude-opus-5",
        "label": "Claude Opus 5",
        "description": "Previous-generation Opus — also the automatic fallback when Opus 5.5 declines a request",
        "omit_temperature": True,
        "adaptive_thinking": True,
        "supports_flex": False,
        "context_window": 200_000,
    },
    {
        "key": "opus48",
        "id": "global.anthropic.claude-opus-4-8",
        "label": "Claude Opus 4.8",
        "description": "Previous-generation Opus (4.8) — the automatic fallback when Opus 5 declines a request",
        "omit_temperature": True,
        "adaptive_thinking": True,
        "supports_flex": False,
        "context_window": 200_000,
    },
    {
        "key": "haiku55",
        "id": "global.anthropic.claude-haiku-5-5",
        "label": "Claude Haiku 5.5",
        "description": "Fastest and cheapest — default for high-volume enrichment and memory",
        "omit_temperature": True,
        "adaptive_thinking": True,
        # Probed: Bedrock refuses the Flex tier for Haiku 5.5, so the memory
        # surface's Flex request is sent as 'default' (converse()).
        "supports_flex": False,
        # Not verified on the model card yet: 200 K is the conservative choice.
        "context_window": 200_000,
    },
    {
        "key": "haiku45",
        "id": "global.anthropic.claude-haiku-4-5-20251001-v1:0",
        "label": "Claude Haiku 4.5",
        "description": "Previous-generation Haiku — fast and cheap, accepts temperature tuning",
        "omit_temperature": False,
        "adaptive_thinking": False,
        "supports_flex": False,
        "context_window": 200_000,
    },
]
ALLOWED_MODEL_IDS = {m["id"] for m in ALLOWED_MODELS}

# Every capability set derives from the rows above so a model can never be
# added to one and forgotten in another.
_OMIT_TEMPERATURE_IDS = {m["id"] for m in ALLOWED_MODELS if m["omit_temperature"]}
_ADAPTIVE_THINKING_IDS = {m["id"] for m in ALLOWED_MODELS if m["adaptive_thinking"]}
_FLEX_IDS = {m["id"] for m in ALLOWED_MODELS if m["supports_flex"]}
_CONTEXT_WINDOWS = {m["id"]: m["context_window"] for m in ALLOWED_MODELS}

# Window assumed for a model ID that is not in the allowlist — i.e. a legacy
# BEDROCK_MODEL_ID value, or an override written before an allowlist change.
# The smallest window any allowlisted model has, so an unknown model is assumed
# no roomier than the narrowest known one rather than the widest.
FALLBACK_CONTEXT_WINDOW_TOKENS = min(_CONTEXT_WINDOWS.values())

# Short aliases for the surface-default table below.
_OPUS55 = "global.anthropic.claude-opus-5-5"
_SONNET55 = "global.anthropic.claude-sonnet-5-5"
_SONNET5 = "global.anthropic.claude-sonnet-5"
_SONNET46 = "global.anthropic.claude-sonnet-4-6"
_HAIKU55 = "global.anthropic.claude-haiku-5-5"
_HAIKU45 = "global.anthropic.claude-haiku-4-5-20251001-v1:0"

# --- Capacity fallback -------------------------------------------------------
# Bedrock can grant access to a model and still give the account ZERO capacity
# for it (a new account cannot even request quota until it has some history), so
# "subscribed" is not "runnable". When the resolved model cannot serve right now,
# converse() and the streaming assistant walk this order. Opus is deliberately
# absent: it is reached only as a surface's configured model or built-in default,
# never as a stand-in for a cheaper one.
#
# MUST stay in lockstep with MODEL_FALLBACK_ORDER in
# lambda/stream/src/bedrock/model-fallback.ts (test_model_fallback_lockstep.py).
MODEL_FALLBACK_ORDER = (_SONNET55, _SONNET5, _SONNET46, _HAIKU55, _HAIKU45)

# --- Surfaces ----------------------------------------------------------------
# Every independently selectable AI surface with its built-in default (the
# "Automatic" behaviour when the admin hasn't pinned a model). The default is
# chosen for the surface's workload: cheap Haiku on the high-volume enrichment
# path, deep Opus on the prototype builder, flagship Sonnet everywhere else.
#
# "default" is an internal fallback bucket for any converse() caller that
# doesn't name a surface; it is NOT exposed in the picker.
SURFACE_DEFAULTS = {
    "default": _SONNET55,
    # The unified AI assistant (floating bubble + /chat page, streamed over
    # /chat/stream). Mirrored by the stream Lambda's BEDROCK_MODEL_ID env.
    "chat": _SONNET55,
    "documents": _SONNET55,
    "prototype": _OPUS55,
    "enrichment": _HAIKU55,
    "utility": _SONNET55,
    # Memory extraction from finished sessions / imports. High volume and not
    # interactive, so it runs on Haiku and asks for the Flex tier
    # (SURFACE_SERVICE_TIERS below) — sent only to a model that supports it, so
    # on Haiku 5.5 (no Flex) the request goes out as 'default'.
    "memory": _HAIKU55,
    # Autonomous agents (crews). The conductor and the final reviewer decide and
    # verify, so they get the deepest model; the crewmates doing the work and
    # the persona panel run on the flagship Sonnet.
    "agent_orchestrator": _OPUS55,
    "agent_worker": _SONNET55,
    "agent_reviewer": _OPUS55,
    "agent_persona": _SONNET55,
}
DEFAULT_SURFACE = "default"

# Surfaces exposed in the Settings picker, in display order. Each carries a
# short description key the frontend translates under `aiModel.surfaces.<key>`.
PICKER_SURFACES = (
    "chat", "documents", "prototype", "enrichment", "utility",
    "memory", "agent_orchestrator", "agent_worker", "agent_reviewer", "agent_persona",
)

# Bedrock service tiers converse() may request (Converse `serviceTier.type`).
# 'priority' and 'reserved' exist in the API but need capacity this platform
# does not buy, so they are not offered.
SERVICE_TIERS = ("flex", "default")

# Per-surface default tier when the caller does not pass one. Only
# non-interactive surfaces belong here: Flex may queue behind Standard under
# load. Flex support is per model (``supports_flex`` on the allowlist rows):
# converse() sends 'default' instead of Flex for a model without it, and if
# Bedrock still refuses Flex it falls back to 'default' — and says so
# (FlexFallback metric + resolved_tier), never silently.
SURFACE_SERVICE_TIERS = {
    "memory": "flex",
}


# --- Inference scope (docs/eu-deployment.md) ---------------------------------
# Stored, allowlisted and compared ids stay CANONICAL (`global.…`). Only the id
# put on the wire changes: an EU deployment (`-c inferenceScope=eu`) sets
# BEDROCK_INFERENCE_SCOPE=eu on every Lambda and is granted ONLY the `eu.`
# profiles, so every Bedrock call must go through invocation_model_id().
# Mirrored by lib/utils/model-allowlist.ts::scopedModelId and the stream
# Lambda's invocationModelId (model-override.ts).
INFERENCE_SCOPE_ENV = "BEDROCK_INFERENCE_SCOPE"
_GLOBAL_PREFIX = "global."
_SCOPE_PREFIXES = {"eu": "eu."}


def inference_scope() -> str:
    """'eu' or 'global' (default; an unknown value is treated as global and logged)."""
    scope = os.environ.get(INFERENCE_SCOPE_ENV, "").strip().lower()
    if scope and scope != "global" and scope not in _SCOPE_PREFIXES:
        logger.warning(f"Unknown {INFERENCE_SCOPE_ENV} '{scope[:20]}'; using global")
    return scope if scope in _SCOPE_PREFIXES else "global"


def invocation_model_id(model_id: str) -> str:
    """The id to send to Bedrock for a canonical ``model_id`` under the scope in force.

    ``global.x`` -> ``eu.x`` when BEDROCK_INFERENCE_SCOPE=eu; anything else
    (global scope, a non-``global.`` id such as an in-region foundation model, an
    already-scoped id) is returned unchanged, so the mapping is idempotent.
    """
    prefix = _SCOPE_PREFIXES.get(inference_scope())
    if prefix is None or not model_id.startswith(_GLOBAL_PREFIX):
        return model_id
    return prefix + model_id[len(_GLOBAL_PREFIX):]


def _scope_model_id_param(params: dict[str, object], **_kwargs: object) -> None:
    """botocore ``provide-client-params`` hook (fires before validation): map ``modelId`` in place."""
    model_id = params.get("modelId")
    if isinstance(model_id, str):
        params["modelId"] = invocation_model_id(model_id)


def scope_bedrock_client[ClientT](client: ClientT) -> ClientT:
    """Make every call on a ``bedrock-runtime`` client send the scoped model id.

    Covers the raw ``converse`` / ``invoke_model`` call sites that bypass
    shared/converse.py (image input, invoke bodies). Idempotent with
    invocation_model_id, so a caller that already maps is unaffected.
    """
    events = getattr(getattr(client, "meta", None), "events", None)
    if events is not None:
        events.register("provide-client-params.bedrock-runtime", _scope_model_id_param,
                        unique_id="voc-inference-scope")
    return client


def surface_service_tier(surface: str) -> str | None:
    """Default Bedrock service tier for a surface, or None (= don't send one)."""
    return SURFACE_SERVICE_TIERS.get(surface)


def surface_default(surface: str) -> str:
    """Built-in default model ID for a surface. Never raises."""
    return SURFACE_DEFAULTS.get(surface, BEDROCK_MODEL_ID)


def fallback_chain(primary: str, surface: str = DEFAULT_SURFACE) -> tuple[str, ...]:
    """Models to try, in order, when ``primary`` cannot serve for ``surface``.

    ``primary`` (the resolved or explicitly passed model) first, then the
    surface's built-in default when it is allowlisted, then MODEL_FALLBACK_ORDER
    — de-duplicated, order kept. Only ``primary`` may be outside the allowlist (a
    legacy BEDROCK_MODEL_ID): every fallback is a model the stacks grant.
    """
    candidates = [primary, surface_default(surface), *MODEL_FALLBACK_ORDER]
    chain: list[str] = []
    for index, model in enumerate(candidates):
        allowed = index == 0 or model in ALLOWED_MODEL_IDS
        if allowed and model and model not in chain:
            chain.append(model)
    return tuple(chain)


def omits_temperature(model_id: str) -> bool:
    """True when the model rejects the `temperature` inference parameter."""
    return model_id in _OMIT_TEMPERATURE_IDS


def uses_adaptive_thinking(model_id: str) -> bool:
    """True when the model runs adaptive thinking always-on and rejects an
    explicit extended-thinking budget (skip the `thinking` request field)."""
    return model_id in _ADAPTIVE_THINKING_IDS


def supports_flex(model_id: str) -> bool:
    """True when Bedrock serves the model on the Flex service tier.

    Unknown ids (a legacy BEDROCK_MODEL_ID, an explicit override) are False:
    a Flex request the model refuses costs a failed round trip, while sending
    'default' to a model that could have run Flex only forgoes a discount.
    """
    return model_id in _FLEX_IDS


def context_window_tokens(model_id: str) -> int:
    """Input context window, in tokens, for a model ID. Never raises.

    Unknown IDs get FALLBACK_CONTEXT_WINDOW_TOKENS — the narrowest allowlisted
    window — so a caller sizing a prompt against an unrecognised model
    under-fills rather than overflowing it.
    """
    return _CONTEXT_WINDOWS.get(model_id, FALLBACK_CONTEXT_WINDOW_TOKENS)


def surface_context_window_tokens(surface: str) -> int:
    """Context window of the model currently resolved for ``surface``.

    Wraps get_active_model_id so a prompt-assembling caller gets a budget that
    follows the admin's runtime model choice. Falls back to the narrowest
    allowlisted window if resolution fails for any reason — sizing a prompt
    must never be the thing that breaks an inference path.
    """
    try:
        return context_window_tokens(get_active_model_id(surface))
    except Exception as e:  # noqa: BLE001 - budget sizing must never raise
        logger.warning(f"Could not resolve model for surface '{surface}': {e}")
        return FALLBACK_CONTEXT_WINDOW_TOKENS


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
