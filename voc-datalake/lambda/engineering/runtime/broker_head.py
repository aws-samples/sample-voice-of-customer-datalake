"""voc-engineering-start's one call of the connector broker (7.47.00): its ``head`` operation, for a start that
resolves its commit (an engineering agent's run: shared/engineering_agent_runs.py ``start_request``, ``resolve_commit``).

A POST of ``{"operation": "head", "args": {"connection", "repository", "branch", "issue"?}}`` to the broker's function
URL (``ENGINEERING_BROKER_URL``), SigV4-signed with the start function's own execution role's credentials, which the
broker admits for this operation alone (``connectors/identity.py`` ``runtime_caller_from_event``, the start's role
and function: ``START_ROLE``); sent once (``learning/reactions_broker.py`` ``signed_call``). It answers the head commit of
the connection's stored default branch and, with an ``issue``, the issue's state on the host (``open``, ``closed``, or
None when the repository has no such issue: a pull request's number is none). The broker reads only: no write, no
claim.
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any, Final

from engineering.connectors.hosts import OBJECT_ID
from engineering.connectors.identity import HEAD
from engineering.learning import reactions_broker
from engineering.learning.reactions_broker import BrokerUnavailable, signed_call

#: The wait for the broker's answer: a token mint and three small reads, inside the start's 30 s.
TIMEOUT_SECONDS: Final = 15
ISSUE_STATES: Final = frozenset({'open', 'closed'})


@dataclass(frozen=True)
class Head:
    """The branch's head commit and the issue's state (None: no such issue, or none asked about)."""

    commit: str
    issue_state: str | None = None


def _head(raw: bytes, issue: int | None) -> Head:
    """The answer's ``result``; ``BrokerUnavailable`` for one off its shape."""
    try:
        parsed = json.loads(raw)
    except ValueError as error:
        raise BrokerUnavailable('the broker\'s answer is not JSON') from error
    result = parsed.get('result') if isinstance(parsed, dict) else None
    commit = result.get('commit') if isinstance(result, dict) else None
    if not isinstance(result, dict) or not isinstance(commit, str) or not OBJECT_ID.fullmatch(commit):
        raise BrokerUnavailable('the broker answered no head commit')
    found = result.get('issue')
    state = found.get('state') if isinstance(found, dict) and found.get('number') == issue else None
    return Head(commit=commit, issue_state=state if state in ISSUE_STATES else None)


@dataclass(frozen=True)
class BrokerHead:
    """The broker's ``head`` answer, called as the start function's own role (``credentials``: botocore's)."""

    url: str
    region: str
    credentials: Any
    opener: Any = field(default_factory=reactions_broker.default_opener)

    def __call__(self, connection: str, repository: str, branch: str, issue: int | None = None) -> Head:
        args: dict[str, object] = {'connection': connection, 'repository': repository, 'branch': branch}
        if issue is not None:
            args['issue'] = issue
        raw = signed_call(self.url, self.region, self.credentials, HEAD, args, opener=self.opener,
                          timeout=TIMEOUT_SECONDS)
        if len(raw) > reactions_broker.MAX_ANSWER_BYTES:
            raise BrokerUnavailable('the broker\'s answer is over its bound')
        return _head(raw, issue)
