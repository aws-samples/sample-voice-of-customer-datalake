"""Which harness a launch runs (7.53.00): the native one (the skill's own adapter, the Bedrock Converse loop for every
shipped skill) or Kiro CLI over ACP (``harness/kiro.py``), per deployment and per role.

The deployment's switch is ``-c engineeringHarness`` (lib/stacks/engineering-runtime.ts, to this function as
``ENGINEERING_HARNESS``): ``native`` (the default: nothing changes until a live run proves Kiro), ``kiro`` (every
launchable role), or ``kiro:<role>,<role>`` (only those roles; the others stay native). A launch of a role on Kiro
has its skill's argv rewritten to ``--adapter kiro`` with the pinned kiro-cli version and the deployment's key parameter
(``ENGINEERING_KIRO_KEY_PARAMETER``: ``/[<prefix>-]voc/engineering/_kiro/api-key``); its egress gains the Kiro service
and SSM (``egress.kiro_hosts``). The session row keeps the argv, so a continuation runs on the harness its agent
started on, whatever the switch says by then.
"""
from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Final

from engineering.connectors.identity import AGENT_ROLES
from engineering.runtime.harness.kiro import KEY_PARAMETER_RE, KIRO_CLI_VERSION
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


def harness_for(argv: Sequence[str], role: str, env: Mapping[str, str]) -> tuple[str, ...]:
    """The argv a launch of ``role`` runs: its skill's as it is, or (the role on Kiro) the same with ``--adapter kiro``,
    the pinned kiro-cli and the key's parameter. Refused when the role is on Kiro without a key parameter, or with an
    argv that names no adapter."""
    if role not in kiro_roles(env.get(HARNESS_ENV)):
        return tuple(argv)
    parameter = env.get(KEY_PARAMETER_ENV, '')
    if not KEY_PARAMETER_RE.fullmatch(parameter):
        raise RuntimeRefused(f'the {role} runs on Kiro, but this deployment names no Kiro key parameter')
    if '--adapter' not in argv[:-1]:
        raise RuntimeRefused(f'the {role}\'s harness names no adapter to run on Kiro')
    at = list(argv).index('--adapter')
    return (*argv[:at], '--adapter', KIRO, *argv[at + 2:], '--kiro-version', KIRO_CLI_VERSION,
            '--kiro-key-parameter', parameter)
