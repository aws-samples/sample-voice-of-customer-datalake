"""The roles' and the runs' model choices as the Agents API shows, checks and saves them (7.58.00).

A choice is ``runtime/harness/model_choice.py``'s (``auto``, ``opus``, ``sonnet``, ``haiku`` or another model id). Each
role has at most one in this deployment (the Registry's, ``settings.py`` ``ROLE_MODELS_KEY``), over its card's
``model.id`` (the default: a card names no choice); a run may name one for every role (Run now's ``model``). Which harness a role runs on is the deployment's switch (``-c engineeringHarness``,
``runtime/harness_switch.py``), so a choice is checked for it:

- the shape, always (``ModelChoiceError``, 400);
- on the native harness, a choice's Bedrock model must be one this deployment grants and prices
  (``harness_switch.native_models``, from the Agents API's own ``ENGINEERING_MODEL_PRICES``): refused when it is saved,
  and again at the run's start (``runtime/handler.py`` ``_start_models``), never by widening a grant;
- on Kiro, any id Kiro's model service takes: Kiro checks it when the session starts (``harness/kiro.py``).
"""
from __future__ import annotations

from collections.abc import Iterable, Mapping
from typing import Any, Literal

from engineering.runtime.harness.model_choice import ModelChoiceError, bedrock_model, checked, not_enabled
from engineering.runtime.harness_switch import HARNESS_ENV, kiro_roles, native_models
from engineering.runtime.interface import RuntimeRefused
from engineering.settings import RoleModel

Harness = Literal['native', 'kiro']


def on_kiro(env: Mapping[str, str]) -> frozenset[str]:
    """The roles this deployment runs on Kiro (none for a switch off its shape: the stack refuses one at synth)."""
    try:
        return kiro_roles(env.get(HARNESS_ENV))
    except RuntimeRefused:
        return frozenset()


def runs_on(role: str, env: Mapping[str, str]) -> Harness:
    return 'kiro' if role in on_kiro(env) else 'native'


def enabled_models(env: Mapping[str, str]) -> list[str]:
    """The Bedrock models the native harness may run here, sorted ([] when the price setting is off its shape)."""
    try:
        return sorted(native_models(env))
    except RuntimeRefused:
        return []


def check(value: object, roles: Iterable[str], env: Mapping[str, str]) -> str:
    """``value`` as a choice for ``roles`` ('' for none), or ``ModelChoiceError``: off its shape, or a Bedrock model
    this deployment does not enable when one of the roles runs on the native harness."""
    choice = checked(value)
    if not choice or set(roles) <= on_kiro(env):
        return choice
    model = bedrock_model(choice, '')
    if model and model not in enabled_models(env):
        raise ModelChoiceError(not_enabled(model))
    return choice


def deployment_choices(stored: Mapping[str, RoleModel]) -> dict[str, str]:
    """Each role's choice here (the Registry's); only the roles that have one."""
    return {role: model.choice for role, model in stored.items() if model.choice}


def card_fields(role: str, stored: Mapping[str, RoleModel], env: Mapping[str, str]) -> dict[str, Any]:
    """What a Registry card says of its role's model choice (a made card: its base role's)."""
    found = stored.get(role)
    return {'model_choice': found.choice if found is not None and found.choice else None,
            'model_choice_updated_at': found.updated_at if found is not None else None,
            'model_choice_updated_by': found.updated_by if found is not None else None,
            'runs_on': runs_on(role, env)}
