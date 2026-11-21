"""The deployment's own models (7.65.00, docs/deployment.md "Bring your own model (-c customModels)").

A deployment may add up to four Bedrock models, system inference profiles or Custom Model Import models to the AI
surfaces' picker, beside the Claude allowlist (shared/model_config.py), never instead of it. The registry is checked
at synth (lib/utils/custom-models.ts: the id's shape, the residency rules, the price, the surfaces and their
capabilities, no provisioned throughput) and reaches each Lambda of a stack that grants the models as
``CUSTOM_MODELS``, a JSON list of::

    {key, id, label, source: model|profile|imported, surfaces: [...], eu: bool, regions: [...] (where its
     inference may run; [] = any commercial Region), capabilities: {tools, documents, json, temperature},
     price: {in, out} (USD per million tokens), contextWindow?, maxOutputTokens?}

(``kind`` is implied by ``source``: ``imported`` for an imported model, ``bedrock`` otherwise; an absent window is its
default.)

The capability flags drive every request to the model (shared/converse.py): ``temperature`` only when it takes one,
never a ``thinking`` field, the JSON instruction (``JSON_INSTRUCTION``) in the system prompt when it returns JSON,
no document or image block unless it reads them (such a request goes to the surface's built-in Claude default) and
``maxTokens`` at most its ``maxOutputTokens``. Python sends no tools outside the engineering harness, which is
Claude-only: the surfaces whose callers send tools (the stream Lambda's assistant and plan steps) are refused at
synth for a model without ``tools``.

Read leniently here: the synth already checked the list, so an entry this module cannot read (an older or newer
shape) is skipped with a warning, never raised. No env, or ``[]``: no custom model (the default).
"""
from __future__ import annotations

import json
import os
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation
from functools import lru_cache
from typing import Any, Final

from shared.logging import logger

CUSTOM_MODELS_ENV: Final = 'CUSTOM_MODELS'
#: In lockstep with lib/utils/custom-models.ts (shared/test/test_custom_models_lockstep.py).
MAX_CUSTOM_MODELS: Final = 4
CUSTOM_MODEL_SURFACES: Final = (
    'chat', 'documents', 'prototype', 'enrichment', 'utility', 'memory',
    'agent_orchestrator', 'agent_worker', 'agent_reviewer', 'agent_persona',
)
TOOL_SURFACES: Final = ('chat', 'agent_worker')
JSON_SURFACES: Final = (
    'documents', 'enrichment', 'utility', 'memory', 'agent_orchestrator', 'agent_worker', 'agent_reviewer',
    'agent_persona',
)
DEFAULT_CONTEXT_WINDOW: Final = 32_000
DEFAULT_MAX_OUTPUT_TOKENS: Final = 4_096
KINDS: Final = ('bedrock', 'imported')
SOURCES: Final = ('model', 'profile', 'imported')
CAPABILITIES: Final = ('tools', 'documents', 'json', 'temperature')
#: Added to the system prompt of every request to a custom model that returns JSON: the prompts were written for
#: Claude, which answers a JSON request with the JSON alone; other models often wrap it in prose or a code fence.
JSON_INSTRUCTION: Final = ('When the request asks for JSON, answer with that JSON alone: no text before or after it, '
                           'and no Markdown code fence.')


@dataclass(frozen=True)
class CustomModel:
    """One registry entry as the runtime uses it."""

    key: str
    id: str
    label: str
    kind: str
    source: str
    surfaces: tuple[str, ...]
    eu: bool
    regions: tuple[str, ...]
    tools: bool
    documents: bool
    json: bool
    temperature: bool
    price_in: Decimal
    price_out: Decimal
    context_window: int
    max_output_tokens: int

    def serves(self, surface: str) -> bool:
        """Whether it may serve ``surface``: declared, with tools where the callers send tools and JSON where they
        parse JSON (the synth refuses anything else; checked again here, so a hand-edited env cannot widen it)."""
        return (surface in self.surfaces and (self.tools or surface not in TOOL_SURFACES)
                and (self.json or surface not in JSON_SURFACES))

    def picker_row(self) -> dict[str, Any]:
        """The model as ``GET /settings/model`` lists it (``custom_models``)."""
        return {
            'key': self.key, 'id': self.id, 'label': self.label, 'description': '', 'kind': self.kind,
            'source': self.source, 'surfaces': [surface for surface in self.surfaces if self.serves(surface)],
            'eu': self.eu, 'regions': list(self.regions),
            'capabilities': {name: getattr(self, name) for name in CAPABILITIES},
            'price': {'in': float(self.price_in), 'out': float(self.price_out)},
        }


def _text(entry: dict, name: str) -> str:
    value = entry.get(name)
    if not isinstance(value, str) or not value:
        raise ValueError(name)
    return value


def _choice(entry: dict, name: str, allowed: tuple[str, ...]) -> str:
    value = _text(entry, name)
    if value not in allowed:
        raise ValueError(name)
    return value


def _strings(value: object, name: str, allowed: tuple[str, ...] | None = None) -> tuple[str, ...]:
    if not isinstance(value, list) or not all(isinstance(item, str) for item in value):
        raise ValueError(name)
    return tuple(item for item in value if allowed is None or item in allowed)


def _flag(mapping: dict, name: str) -> bool:
    value = mapping.get(name)
    if not isinstance(value, bool):
        raise ValueError(name)
    return value


def _price(value: object) -> Decimal:
    try:
        price = Decimal(str(value))
    except InvalidOperation as error:
        raise ValueError('price') from error
    if isinstance(value, bool) or not price.is_finite() or price < 0:
        raise ValueError('price')
    return price


def _count(entry: dict, name: str, default: int) -> int:
    value = entry.get(name, default)
    if isinstance(value, bool) or not isinstance(value, int) or value < 1:
        raise ValueError(name)
    return value


def _model(entry: object) -> CustomModel:
    """One entry, or ValueError naming the field it cannot read."""
    if not isinstance(entry, dict):
        raise ValueError('entry')
    capabilities = entry.get('capabilities')
    price = entry.get('price')
    if not isinstance(capabilities, dict) or not isinstance(price, dict):
        raise ValueError('capabilities' if not isinstance(capabilities, dict) else 'price')
    surfaces = _strings(entry.get('surfaces'), 'surfaces', CUSTOM_MODEL_SURFACES)
    if not surfaces:
        raise ValueError('surfaces')
    source = _choice(entry, 'source', SOURCES)
    return CustomModel(
        key=_text(entry, 'key'), id=_text(entry, 'id'), label=_text(entry, 'label'),
        kind=KINDS[1] if source == 'imported' else KINDS[0], source=source, surfaces=surfaces,
        eu=_flag(entry, 'eu'), regions=_strings(entry.get('regions'), 'regions'),
        tools=_flag(capabilities, 'tools'), documents=_flag(capabilities, 'documents'),
        json=_flag(capabilities, 'json'), temperature=_flag(capabilities, 'temperature'),
        price_in=_price(price.get('in')), price_out=_price(price.get('out')),
        context_window=_count(entry, 'contextWindow', DEFAULT_CONTEXT_WINDOW),
        max_output_tokens=_count(entry, 'maxOutputTokens', DEFAULT_MAX_OUTPUT_TOKENS),
    )


@lru_cache(maxsize=4)
def _parse(raw: str) -> tuple[CustomModel, ...]:
    """The readable entries of one env value (each unreadable one logged once per value and container)."""
    try:
        entries = json.loads(raw) if raw.strip() else []
    except json.JSONDecodeError:
        logger.warning(f'{CUSTOM_MODELS_ENV} is not valid JSON; no custom model is offered')
        return ()
    if not isinstance(entries, list):
        logger.warning(f'{CUSTOM_MODELS_ENV} is not a list; no custom model is offered')
        return ()
    models: list[CustomModel] = []
    for index, entry in enumerate(entries[:MAX_CUSTOM_MODELS]):
        try:
            model = _model(entry)
        except ValueError as error:
            logger.warning(f'{CUSTOM_MODELS_ENV} entry {index + 1} skipped: its {error} cannot be read')
            continue
        if any(known.id == model.id or known.key == model.key for known in models):
            logger.warning(f'{CUSTOM_MODELS_ENV} entry {index + 1} skipped: its key or id repeats an earlier one')
            continue
        models.append(model)
    return tuple(models)


def custom_models() -> tuple[CustomModel, ...]:
    """The deployment's custom models, in the registry's order (none without ``CUSTOM_MODELS``)."""
    return _parse(os.environ.get(CUSTOM_MODELS_ENV, ''))


def custom_model(model_id: object) -> CustomModel | None:
    """The custom model whose id is ``model_id`` (its id as sent, too: custom ids are never scope-mapped)."""
    return next((model for model in custom_models() if model.id == model_id), None)


def custom_model_ids() -> frozenset[str]:
    """Every custom model's id."""
    return frozenset(model.id for model in custom_models())


def custom_ids_for(surface: str) -> frozenset[str]:
    """The ids of the custom models that may serve ``surface`` (``CustomModel.serves``)."""
    return frozenset(model.id for model in custom_models() if model.serves(surface))


def picker_rows() -> list[dict[str, Any]]:
    """``GET /settings/model``'s ``custom_models``."""
    return [model.picker_row() for model in custom_models()]
