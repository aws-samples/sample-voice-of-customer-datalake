"""Which harness a launch runs (7.53.00): the native one (the skill's own adapter, the Bedrock Converse loop for every
shipped skill) or Kiro CLI over ACP (``harness/kiro.py``), per deployment and per role.

The deployment's switch is ``-c engineeringHarness`` (lib/stacks/engineering-runtime.ts, to this function as
``ENGINEERING_HARNESS``): ``native`` (the default: nothing changes until a live run proves Kiro), ``kiro`` (every
launchable role), or ``kiro:<role>,<role>`` (only those roles; the others stay native). A launch of a role on Kiro
has its skill's argv rewritten to ``--adapter kiro`` with the pinned kiro-cli version and the deployment's key parameter
(``ENGINEERING_KIRO_KEY_PARAMETER``: ``/[<prefix>-]voc/engineering-kiro/api-key``); its egress gains the Kiro service
and SSM (``egress.kiro_hosts``). The session row keeps the argv, so a continuation runs on the harness its agent
started on, whatever the switch says by then.
"""
from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Final

from engineering.connectors.identity import AGENT_ROLES
from engineering.runtime.harness.kiro_pin import KEY_PARAMETER_RE, KIRO_CLI_VERSION, kiro_model
from engineering.runtime.harness.model_choice import bedrock_model, not_enabled
from engineering.runtime.interface import RuntimeRefused

HARNESS_ENV: Final = 'ENGINEERING_HARNESS'
KEY_PARAMETER_ENV: Final = 'ENGINEERING_KIRO_KEY_PARAMETER'
NATIVE: Final = 'native'
KIRO: Final = 'kiro'
#: The roles a deployment may run on Kiro: every launchable one (the coach is Learn's, never launched).
KIRO_ROLES: Final = frozenset(AGENT_ROLES - {'coach'})


def kiro_roles(value: str | None) -> frozenset[str]:
    """The roles ``value`` (the switch) runs on Kiro: none for ``native`` (or unset), all for ``kiro``, the named ones
    for ``kiro:<role>,…``; anything else is refused (the stack checks it at synth too)."""
    text = (value or NATIVE).strip()
    if text == NATIVE:
        return frozenset()
    if text == KIRO:
        return KIRO_ROLES
    named = text.removeprefix(f'{KIRO}:')
    roles = frozenset(role.strip() for role in named.split(',') if role.strip())
    if not text.startswith(f'{KIRO}:') or not roles or not roles <= KIRO_ROLES:
        raise RuntimeRefused(f'{HARNESS_ENV} is native, kiro, or kiro:<role>,<role> (roles: {sorted(KIRO_ROLES)})')
    return roles


def is_kiro(argv: Sequence[str]) -> bool:
    """Whether a launch's harness argv runs the Kiro adapter."""
    return any(argv[index] == '--adapter' and argv[index + 1] == KIRO for index in range(len(argv) - 1))


def harness_for(argv: Sequence[str], role: str, env: Mapping[str, str], model: str = '') -> tuple[str, ...]:
    """The argv a launch of ``role`` runs: its skill's as it is, or (the role on Kiro) the same with ``--adapter kiro``,
    the pinned kiro-cli, the key's parameter and (7.58.00) ``--kiro-model`` when the launch chose one. Refused when the
    role is on Kiro without a key parameter, or with an argv that names no adapter."""
    if role not in kiro_roles(env.get(HARNESS_ENV)):
        return tuple(argv)
    parameter = env.get(KEY_PARAMETER_ENV, '')
    if not KEY_PARAMETER_RE.fullmatch(parameter):
        raise RuntimeRefused(f'the {role} runs on Kiro, but this deployment names no Kiro key parameter')
    if '--adapter' not in argv[:-1]:
        raise RuntimeRefused(f'the {role}\'s harness names no adapter to run on Kiro')
    at = list(argv).index('--adapter')
    return (*argv[:at], '--adapter', KIRO, *argv[at + 2:], '--kiro-version', KIRO_CLI_VERSION,
            '--kiro-key-parameter', parameter, *(('--kiro-model', model) if model else ()))


# -- the model a launch runs (7.58.00) -------------------------------------------------------------------------------

#: The deployment's model prices (``-c engineeringModelPrices`` over ``caps.DEFAULT_TOKEN_PRICES``), the runtime's and
#: the Agents API's environment.
MODEL_PRICES_ENV: Final = 'ENGINEERING_MODEL_PRICES'


def native_models(env: Mapping[str, str]) -> frozenset[str]:
    """The Bedrock models the native harness may run here: the ones the agents' roles are granted (the Claude
    allowlist, ``shared/model_config.py`` ``ALLOWED_MODEL_IDS``, in lockstep with the stacks' grant) that think
    adaptively (the allowlist's ``adaptive_thinking``: the Converse loop asks every session's model for adaptive,
    summarized thinking, ``converse_loop.CLAUDE_THINKING``, which an older Claude refuses) and that the deployment also
    prices (``caps.model_prices``), so no model is run that the cost caps cannot price, and no grant is widened for
    one."""
    from engineering.runtime.caps import model_prices
    from shared.model_config import ALLOWED_MODEL_IDS, uses_adaptive_thinking
    adaptive = frozenset(model for model in ALLOWED_MODEL_IDS if uses_adaptive_thinking(model))
    return adaptive & frozenset(model_prices(env.get(MODEL_PRICES_ENV)).prices)


def not_native(model: str) -> str:
    """Why the native harness cannot run ``model`` here, as a person reads it: a granted Claude model that does not
    think adaptively cannot run on it at all (``native_models``); any other, the deployment neither grants and prices
    it (``model_choice.not_enabled``)."""
    from shared.model_config import ALLOWED_MODEL_IDS, uses_adaptive_thinking
    if model in ALLOWED_MODEL_IDS and not uses_adaptive_thinking(model):
        return (f"{model} can't run on the native harness: it doesn't think adaptively, which the harness asks of "
                'every model. Choose another model.')
    return not_enabled(model)


def argv_model(argv: Sequence[str]) -> str:
    """The ``--model`` an argv names ('' for none)."""
    items = list(argv)
    return items[items.index('--model') + 1] if '--model' in items[:-1] else ''


def with_model(argv: Sequence[str], role: str, env: Mapping[str, str], choice: str) -> tuple[tuple[str, ...], str]:
    """A launch's argv with the model ``choice`` applied (``model_choice.py``), and the model it asks for: on Kiro,
    ``harness_for`` with the choice's Kiro model (``kiro_pin.kiro_model``; no choice: none, and the session asks for
    Kiro's name for the skill's model, or stops when Kiro has none: ``harness/kiro.py``); on the native harness, the
    skill's argv with ``--model`` the choice's Bedrock model, refused (``RuntimeRefused``) unless the deployment grants
    and prices it (``native_models``). No choice: the argv as before 7.58.00."""
    default = argv_model(argv)
    if role in kiro_roles(env.get(HARNESS_ENV)):
        chosen = (kiro_model(choice, chosen=True) or '') if choice else ''
        return harness_for(argv, role, env, chosen), chosen or kiro_model(default) or default
    model = bedrock_model(choice, default)
    if model == default:
        return tuple(argv), default
    if model not in native_models(env):
        raise RuntimeRefused(not_native(model))
    if not default:
        raise RuntimeRefused(f'the {role}\'s harness names no model to replace with {model}')
    items = list(argv)
    items[items.index('--model') + 1] = model
    return tuple(items), model
