"""Who is calling the broker (docs/autonomous-engineering.md, "Nobody can speak for someone else").

The broker is reached only through a Lambda function URL with IAM authentication, so the event carries the
caller's assumed-role ARN, ``arn:aws:sts::<account>:assumed-role/<role name>/<session name>``:

* the account is the broker's own (from its function ARN);
* the role name is one of the fixed agent roles' IAM names (the pattern CDK hands down, ``{role}`` in it);
* the session name, which the runtime's launcher sets and no agent can change, is ``<run id>.<agent index>``: a
  26-character run id (a ULID) and a short index, inside the 64 characters a session name allows.

The caller's role, run and agent come from there and from nowhere else: never from the request body.
"""
from __future__ import annotations

import re
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Final

#: The workspace dimension (the board's and the bus's ``ws``, the runtime's ``ws`` session tag), ``default`` until
#: multi-workspace lands (plan v3, 4.3).
WORKSPACE: Final = 'default'
ROLE_PLACEHOLDER: Final = '{role}'
#: The operations an agent asks the broker for (broker.py says which role may make which), here so that the
#: harness's client, which the agents' images ship with this module and not the broker, names them from one home.
READ: Final = 'read'
POST_COMMENT: Final = 'post_comment'
PUSH_BUNDLE: Final = 'push_bundle'
OPEN_OR_UPDATE_DRAFT_PR: Final = 'open_or_update_draft_pr'
#: The agent catalog's roles, as their IAM role names spell them.
AGENT_ROLES: Final = frozenset({
    'mapper', 'understander', 'hunter', 'fixer', 'builder', 'committer', 'commit-reviewer', 'gate-runner',
    'pr-author', 'pr-reviewer', 'final-go', 'coordinator', 'coach',
})
_ASSUMED_ROLE: Final = re.compile(
    r'arn:aws(?:-[a-z]+)*:sts::(?P<account>\d{12}):assumed-role/(?P<role>[\w+=,.@-]{1,64})/(?P<session>[\w+=,.@-]{2,64})',
    re.ASCII)
_ACCOUNT: Final = re.compile(r'[0-9]{12}')
#: A ULID (Crockford base32, upper case) and an agent index of one to three digits, no leading zero.
_SESSION: Final = re.compile(r'(?P<run>[0-9A-HJKMNP-TV-Z]{26})\.(?P<agent>0|[1-9][0-9]{0,2})')


class UnknownCaller(Exception):
    """The caller is not one of the run's agents (or the event carries no IAM identity)."""


@dataclass(frozen=True)
class Caller:
    """An agent of a run, from its assumed-role identity."""

    role: str
    run_id: str
    agent_index: int


def agent_id(caller: Caller) -> str:
    """The agent's id on the board, the bus and in the workspace's keys: ``<role>-<index>`` (its run comes with it)."""
    return f'{caller.role}-{caller.agent_index}'


def _user_arn(event: Mapping[str, object]) -> str:
    node: object = event
    for key in ('requestContext', 'authorizer', 'iam', 'userArn'):
        if not isinstance(node, Mapping):
            raise UnknownCaller
        node = node.get(key)
    if not isinstance(node, str):
        raise UnknownCaller
    return node


def agent_role(role_name: str, role_name_pattern: str) -> str:
    """The agent role an IAM role name stands for, by ``role_name_pattern`` (``voc-eng-{role}-<acct>-<region>``)."""
    if role_name_pattern.count(ROLE_PLACEHOLDER) != 1:
        raise UnknownCaller
    prefix, suffix = role_name_pattern.split(ROLE_PLACEHOLDER)
    if not (role_name.startswith(prefix) and role_name.endswith(suffix)) or len(role_name) <= len(prefix + suffix):
        raise UnknownCaller
    role = role_name[len(prefix):len(role_name) - len(suffix)]
    if role not in AGENT_ROLES:
        raise UnknownCaller
    return role


def own_account(function_arn: object) -> str:
    """The account of the broker's own function ARN (``context.invoked_function_arn``), or ``''``."""
    parts = function_arn.split(':') if isinstance(function_arn, str) else []
    return parts[4] if len(parts) >= 7 and parts[2] == 'lambda' and _ACCOUNT.fullmatch(parts[4]) else ''


def caller_from_event(event: Mapping[str, object], role_name_pattern: str, account: str) -> Caller:
    """The calling agent of ``account`` (the broker's own), or ``UnknownCaller`` for anything else."""
    arn = _ASSUMED_ROLE.fullmatch(_user_arn(event))
    if arn is None or not account or arn.group('account') != account:
        raise UnknownCaller
    session = _SESSION.fullmatch(arn.group('session'))
    if session is None:
        raise UnknownCaller
    return Caller(role=agent_role(arn.group('role'), role_name_pattern), run_id=session.group('run'),
                  agent_index=int(session.group('agent')))
