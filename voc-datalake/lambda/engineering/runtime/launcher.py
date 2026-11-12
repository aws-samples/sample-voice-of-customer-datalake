"""The launcher: the only code that gives an agent's MicroVM AWS credentials.

It runs outside every MicroVM (in voc-engineering-runtime and voc-engineering-delivery). For each agent it assumes that agent role's ONE
fixed execution role (never a role per run), with session tags naming the workspace, the run, the agent and the
connection (``ws``, ``run``, ``agent``, ``connection``: the roles' IAM conditions read them) and the session name
``<run ULID>.<agent index>`` (the broker and the board's API read identity from it: connectors/identity.py). Sessions last 15 minutes; the supervisor renews them each tick through
the launcher, which refuses the agents of a stopped run, so a stop cuts that run's sessions within 15
minutes although the roles are shared, and its MicroVMs are ended at once anyway.

A ``RoleSession`` is never stored: no readable ``repr``, refuses pickling; only the MicroVM's runner gets it.
"""
from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any, Final, NoReturn

from engineering.connectors.identity import WORKSPACE
from engineering.runtime.interface import (
    MAX_SESSION_NAME,
    ROLES,
    RuntimeRefused,
    agent_index,
    check_id,
    check_run_id,
)
from engineering.runtime.tokens import TokenNotStorable

SESSION_SECONDS: Final = 15 * 60
MAX_AGENT_INDEX: Final = 999
#: A session with less than this left is renewed at the next tick.
RENEW_MARGIN_SECONDS: Final = 6 * 60


class RunStopped(RuntimeRefused):
    """The launcher refuses the agents of a stopped run."""


@dataclass(frozen=True, repr=False, eq=False)
class RoleSession:
    access_key_id: str
    secret_access_key: str
    session_token: str
    expires_at: float

    def __repr__(self) -> str:
        return f'RoleSession(<hidden>, expires_at={self.expires_at:.0f})'

    def __reduce__(self) -> NoReturn:
        raise TokenNotStorable('a role session is never stored')

    def process_credentials(self) -> dict[str, Any]:
        """The ``credential_process`` JSON the runner keeps for the agent user (and the cache mount)."""
        return {'Version': 1, 'AccessKeyId': self.access_key_id, 'SecretAccessKey': self.secret_access_key,
                'SessionToken': self.session_token,
                'Expiration': datetime.fromtimestamp(self.expires_at, UTC).isoformat()}


def session_name(run_id: str, index: int) -> str:
    """``<run ULID>.<agent index>``, as the broker and the board read it (connectors/identity.py); refused, never
    cut, past IAM's 64 characters, so no two agents share one identity."""
    if not 0 <= index <= MAX_AGENT_INDEX:
        raise RuntimeRefused(f'an agent index is 0-{MAX_AGENT_INDEX}')
    name = f'{check_run_id(run_id)}.{index}'
    if len(name) > MAX_SESSION_NAME:
        raise RuntimeRefused(f'session name {name!r} is over {MAX_SESSION_NAME} characters')
    return name


class Launcher:
    def __init__(self, sts: Any, role_arns: Mapping[str, str]) -> None:
        missing = ROLES - role_arns.keys()
        if missing:
            raise RuntimeRefused(f'no execution role for {sorted(missing)}')
        self._sts = sts
        self._roles = dict(role_arns)

    def session_for(self, *, role: str, connection: str, run_id: str, agent_id: str, stopped: bool) -> RoleSession:
        if stopped:
            raise RunStopped(f'run {run_id} is stopped: its agents get no new session')
        # The tags the roles' conditions read (the bus source, the S3 prefixes, the queues); the session name the
        # broker and the board read. Both from the same ids, so they never disagree.
        answer = self._sts.assume_role(
            RoleArn=self._roles[role], RoleSessionName=session_name(run_id, agent_index(agent_id, role)),
            DurationSeconds=SESSION_SECONDS,
            Tags=[{'Key': 'ws', 'Value': WORKSPACE}, {'Key': 'run', 'Value': run_id},
                  {'Key': 'agent', 'Value': agent_id}, {'Key': 'connection', 'Value': check_id('connection', connection)}])
        credentials = answer['Credentials']
        expiration = credentials['Expiration']
        expires = expiration.timestamp() if isinstance(expiration, datetime) else float(expiration)
        return RoleSession(access_key_id=credentials['AccessKeyId'], secret_access_key=credentials['SecretAccessKey'],
                           session_token=credentials['SessionToken'], expires_at=expires)
