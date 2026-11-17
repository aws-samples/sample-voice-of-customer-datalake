"""Who is calling the broker (docs/autonomous-engineering.md, "Nobody can speak for someone else").

The broker is reached only through a Lambda function URL with IAM authentication, so the event carries the
caller's assumed-role ARN, ``arn:aws:sts::<account>:assumed-role/<role name>/<session name>``:

* the account is the broker's own (from its function ARN);
* the role name is one of the fixed agent roles' IAM names (the pattern CDK hands down, ``{role}`` in it);
* the session name, which the runtime's launcher sets and no agent can change, is ``<run id>.<agent index>``: a
  26-character run id (a ULID) and a short index, inside the 64 characters a session name allows.

The caller's role, run and agent come from there and from nowhere else: never from the request body.

One more caller (7.10.00): voc-engineering-runtime itself, for the reactions read alone (``REACTIONS``). Its Lambda
execution role's session, ``arn:aws:sts::<account>:assumed-role/<the runtime's role name>/<its function name>`` (Lambda
names the session after the function, and no agent can assume that role), checked the same way: the broker's own
account, the role name and the function name the stack hands the broker (``runtime_caller_from_event``). It speaks for
no run of its own (``RUNTIME_ROLE``, ``run_id`` ''): the run it asks about is the request's, and the broker reads
everything else from that run's record.

And one more (7.47.00): voc-engineering-start, for the ``head`` read alone (``HEAD``, ``START_ROLE``): its own execution
role, in the session Lambda names after its function, checked the same way (``runtime_caller_from_event`` with the
start's names). It too speaks for no run: a start that resolves its commit asks for the head of a connection's stored
default branch, before its run is written. Since 7.52.00 voc-engineering-start also asks for ``push_approved_docs``
(``PUSH_APPROVED_DOCS``, its ``publish_docs``: an administrator's request to open the pull request of the docs they
approved), which no agent role may make.
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
#: The understander's labels on its run's issue (7.50.00): ``outputs.TRIAGE_LABELS`` only, once per attempt.
LABEL_ISSUE: Final = 'label_issue'
#: The runtime's one operation (7.10.00): people's reactions to an ended run's pull request, read only.
REACTIONS: Final = 'reactions'
#: voc-engineering-start's one operation (7.47.00): a connection's default branch's head commit, and an issue's state,
#: read only, for a start that resolves its commit (an engineering agent's run).
HEAD: Final = 'head'
#: voc-engineering-start's other operation (7.52.00): the approved knowledge docs or tenets of a connection written as
#: one commit on their own branch and a pull request, at an administrator's request. Never an agent's.
PUSH_APPROVED_DOCS: Final = 'push_approved_docs'
#: The read kind an agent asks for its run's connection's accepted tenets with (7.52.00, the broker's ``read``).
TENETS_READ: Final = 'tenets'
#: The role a runtime caller has (never an agent role, so no agent operation is ``permitted`` for it).
RUNTIME_ROLE: Final = 'runtime'
#: The role voc-engineering-start has as a caller (7.47.00): its ``head`` operation and, since 7.52.00,
#: ``push_approved_docs``, alone.
START_ROLE: Final = 'start'
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


def runtime_caller_from_event(event: Mapping[str, object], role_name: str, function_name: str, account: str,
                              role: str = RUNTIME_ROLE) -> Caller:
    """voc-engineering-runtime of ``account`` (the broker's own), its execution role ``role_name`` in the session
    Lambda names ``function_name``; ``UnknownCaller`` for anything else, and when either name is unset. The same check
    admits voc-engineering-start (7.47.00) with ``role`` ``START_ROLE``: its own role and function names."""
    arn = _ASSUMED_ROLE.fullmatch(_user_arn(event))
    if (arn is None or not (account and role_name and function_name) or arn.group('account') != account
            or arn.group('role') != role_name or arn.group('session') != function_name):
        raise UnknownCaller
    return Caller(role=role, run_id='', agent_index=0)
