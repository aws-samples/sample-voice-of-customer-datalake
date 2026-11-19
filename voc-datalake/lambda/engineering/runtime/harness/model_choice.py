"""The model an engineering agent runs on (7.58.00): one choice per role (and per run), for both harnesses.

A choice is a string: one of the named choices (``auto``, ``opus``, ``sonnet``, ``haiku``), or another model id a
person typed ("Other model…", ``MODEL_ID``: letters, digits and ``._:/-``, at most 128 characters, no spaces and no
``//``, so never a URL). '' is no choice: the role's default, as before 7.58.00. Each harness maps it its own way:

- **Kiro** (``kiro_pin.kiro_model(choice, chosen=True)``): the named ones to Kiro's own ids (``claude-opus-5.5``…, and
  ``auto``, Kiro choosing per task), a Claude Bedrock id to Kiro's name for it, another id as it is. Kiro checks it
  when the session starts (``session/set_config_option`` ``model``): ``harness/kiro.py`` stops the step for a person
  when Kiro does not take it (``ModelRefused``), never running another model.
- **Native** (``bedrock_model``, the Bedrock Converse loop): the named ones to the Claude 5.5 global inference
  profiles; ``auto`` is Kiro's alone, so on the native harness it is the role's default; another id as it is, which
  the launch refuses unless the deployment both grants it (the agents' Claude allowlist) and prices it
  (``runtime/caps.py`` ``DEFAULT_TOKEN_PRICES`` and ``-c engineeringModelPrices``): least privilege, never a wider
  grant.

Standard library only, as ``kiro_pin.py``: the harness in each image and the Lambdas that launch an agent, check one
(readiness) or save a choice (the Agents API) share it.
"""
from __future__ import annotations

import re
from collections.abc import Mapping
from typing import Final

#: Kiro's own choice per task (the named choices with their Kiro names: ``kiro_pin.KIRO_CHOICES``).
AUTO: Final = 'auto'
#: Each named choice on the native harness (Bedrock's global inference profiles; ``auto`` has none: the default).
BEDROCK_MODELS: Final[Mapping[str, str]] = {'opus': 'global.anthropic.claude-opus-5-5',
                                            'sonnet': 'global.anthropic.claude-sonnet-5-5',
                                            'haiku': 'global.anthropic.claude-haiku-5-5'}
#: Another model id a person typed: the shape of ``runtime/caps.py`` ``MODEL_ID``, at most 128 characters.
MODEL_ID: Final = re.compile(r'[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}\Z')
SHAPE: Final = ('a model is auto, opus, sonnet or haiku, or a model id (letters, digits and ._:/-, at most 128 '
                'characters, no spaces, no URL)')


class ModelChoiceError(ValueError):
    """A choice off its shape."""


def checked(value: object) -> str:
    """``value`` as a choice ('' for none: None or ''), stripped; ``ModelChoiceError`` for anything off its shape."""
    if value is None:
        return ''
    if not isinstance(value, str):
        raise ModelChoiceError(SHAPE)
    text = value.strip()
    if text and (not MODEL_ID.fullmatch(text) or '//' in text):
        raise ModelChoiceError(SHAPE)
    return text


def bedrock_model(choice: str, default: str) -> str:
    """The model a native session runs: a named choice's profile, ``default`` (the role's) for none or ``auto``, else
    the id itself (``harness_switch.native_models`` says whether the deployment may run it)."""
    if not choice or choice == AUTO:
        return default
    return BEDROCK_MODELS.get(choice, choice)


def not_enabled(model: str) -> str:
    """Why a native session cannot run ``model``, as a person reads it."""
    return (f"{model} isn't enabled in this deployment. An admin adds it with -c engineeringModelPrices "
            '(docs/deployment.md).')


def chosen(run_choice: str, role_choice: str, template_choice: str) -> str:
    """The choice a launch applies: the run's (one model for every role), else the role's (the Registry's), else its
    template card's; '' for none."""
    return run_choice or role_choice or template_choice
