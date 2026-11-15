"""The harness's broker: its ``ports.Broker`` on the connector broker's function URL (docs/autonomous-engineering.md,
"Repository connectors").

As the board's client does (``board_client.py``): inside the session, as the agent's own session (the launcher's role
session, ``credential_process``), every call is an IAM-signed POST (SigV4, service ``lambda``) to the broker's function
URL, whose host the runtime adds to the agent's egress by name (``VOC_BROKER_URL``), and to the agent's proxy only:
repository code never reaches a function URL (``egress.split``). The body is ``{"operation": ..., "args": {...}}`` and
nothing else (connectors/handler.py). The broker takes the caller's role, run and agent from the session, never from
the body, so nothing a session sends can speak for another, and it alone decides what a role may do and when
(connectors/broker.py: the role, the run, the dial, the CI attestation, the GO ledger, the write rules).

- ``read``: a page of a file, a history, an issue or a pull request (every role's). Retried on a 503 or a lost
  connection, twice, backing off: reading twice reads once.
- ``push`` (the committer's ``push_bundle``), ``open_draft_pr`` (the PR author's ``open_or_update_draft_pr``) and
  ``comment`` (the PR reviewer's ``post_comment``): sent once and never retried, each with the agent's attempt, so
  the broker makes it at most once for the agent's attempt and answers a repeat with the first outcome
  (connectors/broker.py ``_once``). A write whose outcome the client cannot know (its answer lost, cut or
  unreadable, a timeout, or a 5xx other than the broker's own 503, which says nothing was written) is
  ``ports.WriteOutcomeUnknown``: never a refusal, never a crash.
- ``submit``: the broker defines no call for it. The submission is the patch ``submit_work`` wrote under the agent's
  own keys, which the broker reads at the committer's push (connectors/patches.py); this checks that the key is one
  the broker takes (a fixer's or builder's submitted patch of the run at its commit, the agent's own) and answers what
  happens to it next.

Any other answer but a 200 is a ``ports.BrokerRefused`` with the broker's status and its plain reason (at most 500
characters), which the tools hand the model as a refusal it reads. Every wait is bounded: past the broker function's
own limit, so its answer, a refusal included, always comes first. No body, answer or credential is ever logged.
"""
from __future__ import annotations

import http.client
import time
import urllib.error
import urllib.request
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from typing import Any, Final, Protocol

from engineering.connectors.identity import OPEN_OR_UPDATE_DRAFT_PR, POST_COMMENT, PUSH_BUNDLE, READ
from engineering.runtime.checkpoints import agent_prefix
from engineering.runtime.harness.board_client import RETRY_WAITS, json_object, signed_post
from engineering.runtime.harness.ports import BrokerRefused, WriteOutcomeUnknown
from engineering.runtime.outputs import is_submitted_patch

#: What a read reads (connectors/handler.py ``_READ_KINDS``: a test holds them equal; the images do not ship it).
READ_KINDS: Final = frozenset({'file', 'history', 'issue', 'pull_request'})
#: Every call's wait: above the broker function's own limit (120 s, engineering-broker.ts), so the broker's answer
#: always arrives first.
TIMEOUT_SECONDS: Final = 125
#: A function URL answers at most 6 MB (the broker keeps its answers under 5.5 MB: handler.py ``MAX_ANSWER_BYTES``).
MAX_ANSWER_BYTES: Final = 6 * 1024 * 1024
MAX_REASON: Final = 500
#: Lost on the way (no status): what a read retries (a write's is ``WriteOutcomeUnknown``).
LOST: Final = 0
_RETRIED: Final = frozenset({LOST, 503})
#: An answer that never came whole: a lost connection, a timeout, a cut body (``IncompleteRead``).
_LOST_ON_THE_WAY: Final = (urllib.error.URLError, TimeoutError, ConnectionError, http.client.HTTPException)
#: The broker's own 5xx that says it wrote nothing: no connection, its records unreadable, a busy host before the
#: write (handler.py). Every other 5xx of a write (the broker's 502: a host error, the outcome unknown; the function
#: URL's own 502 or 504: the function failed or timed out mid-write) may hide a write.
_NOTHING_WRITTEN: Final = 503


class Opener(Protocol):
    def open(self, request: urllib.request.Request, /, *, timeout: float) -> Any: ...


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """A redirect is a refusal: the signed request (its Authorization) never follows one to another host."""

    def redirect_request(self, req: Any, fp: Any, code: int, msg: str, headers: Any, newurl: str) -> None:
        del req, fp, msg, headers, newurl
        raise BrokerRefused(code, 'the broker answered with a redirect, which is never followed')


_OPENER: Final = urllib.request.build_opener(_NoRedirect)


class BrokerTransport(Protocol):
    def call(self, operation: str, args: Mapping[str, Any]) -> dict[str, Any]:
        """One operation of the broker: its ``result``, or ``BrokerRefused``."""
        ...


def _parsed(raw: bytes) -> dict[str, Any]:
    """An answer's JSON object; ``BrokerRefused`` (502) for anything else."""
    return json_object(raw, MAX_ANSWER_BYTES, lambda reason: BrokerRefused(502, reason))


@dataclass(frozen=True)
class SignedBroker:
    """POSTs to the broker's function URL, signed with the agent's own credentials (botocore's chain)."""

    url: str
    region: str
    credentials: Any
    sleep: Callable[[float], None] = time.sleep
    opener: Opener = field(default_factory=lambda: _OPENER)

    def call(self, operation: str, args: Mapping[str, Any]) -> dict[str, Any]:
        """The broker's ``result``; a read retried on a 503 or a lost connection (the board's waits,
        ``RETRY_WAITS``), a write sent once."""
        waits = RETRY_WAITS if operation == READ else ()
        for wait in (*waits, None):
            try:
                return self._call(operation, args)
            except BrokerRefused as refused:
                if wait is None or refused.status not in _RETRIED:
                    raise
            self.sleep(wait)
        raise AssertionError('unreachable')  # pragma: no cover

    def _call(self, operation: str, args: Mapping[str, Any]) -> dict[str, Any]:
        """One call: its ``result``. A refusal is ``BrokerRefused``; for a write, an outcome the client cannot know
        (no whole answer, a 5xx that may hide a write, a 200 it cannot read) is ``WriteOutcomeUnknown``."""
        write = operation != READ
        request = signed_post(self.url, self.region, self.credentials, {'operation': operation, 'args': dict(args)})
        try:
            with self.opener.open(request, timeout=TIMEOUT_SECONDS) as answer:
                raw = answer.read(MAX_ANSWER_BYTES + 1)
        except urllib.error.HTTPError as error:
            raise _refusal(error, write=write) from error
        except _LOST_ON_THE_WAY as error:
            if write:
                raise WriteOutcomeUnknown from error
            raise BrokerRefused(LOST, "the broker's answer never came") from error
        try:
            result = _parsed(raw).get('result')
        except BrokerRefused as unreadable:
            if write:
                raise WriteOutcomeUnknown from unreadable
            raise
        if isinstance(result, dict):
            return result
        if write:
            raise WriteOutcomeUnknown
        raise BrokerRefused(502, 'the broker answered no result')


def _refusal(error: urllib.error.HTTPError, *, write: bool) -> Exception:
    """What a non-200 answer means: the broker's own reason (or the function URL's: its IAM check answers
    ``{"Message": ...}``) as ``BrokerRefused``, or, for a write that may have been made, ``WriteOutcomeUnknown``."""
    try:
        answer = _parsed(error.read(MAX_ANSWER_BYTES + 1))
    except (BrokerRefused, *_LOST_ON_THE_WAY):
        answer = {}
    own = isinstance(answer.get('error'), str)
    if write and error.code >= 500 and not (own and error.code == _NOTHING_WRITTEN):
        return WriteOutcomeUnknown()
    reason = answer.get('error') or answer.get('Message') or 'refused'
    return BrokerRefused(error.code, str(reason)[:MAX_REASON])


def _shaped(result: Mapping[str, Any], shape: Mapping[str, type]) -> dict[str, Any]:
    """A write's ``result`` when it has each of ``shape``'s fields with its type (a bool is no number): one off its
    shape came back from a write the broker may have made, so it is ``WriteOutcomeUnknown``."""
    if any(type(result.get(name)) is not kind for name, kind in shape.items()):
        raise WriteOutcomeUnknown
    return {name: result[name] for name in shape}


@dataclass(frozen=True)
class BrokerHttp:
    """``ports.Broker`` on the broker's function URL, for one agent of one run (its session is the caller), at the
    run's commit (``VOC_COMMIT``: where its submitted patches are) and its task's attempt (``VOC_ATTEMPT``: with the
    caller and the operation, the key each write is made once for, so a continuation's repeat is never made twice)."""

    transport: BrokerTransport
    run_id: str
    agent_id: str
    commit: str
    attempt: int = 1

    def _own(self, run_id: str, agent_id: str) -> None:
        if (run_id, agent_id) != (self.run_id, self.agent_id):
            raise ValueError('the harness asks the broker as its own agent only')

    def read(self, *, kind: str, target: str, cursor: str | None = None) -> dict[str, Any]:
        """One page of ``target`` (``kind``: a file, a history, an issue or a pull request) and the next page's
        cursor (None: the last)."""
        if kind not in READ_KINDS:
            raise ValueError(f'a read is of one of {", ".join(sorted(READ_KINDS))}')
        args: dict[str, Any] = {'kind': kind, 'target': target, **({'cursor': cursor} if cursor else {})}
        result = self.transport.call(READ, args)
        if not isinstance(result.get('content'), str) or not isinstance(result.get('next_cursor'), str | None):
            raise BrokerRefused(502, 'the broker answered no page')
        return {'content': result['content'], 'next_cursor': result['next_cursor']}

    def submit(self, run_id: str, agent_id: str, task_id: str, patch_key: str, summary: str) -> str:
        """The receipt of the agent's submitted patch: no call (the broker reads the patch at the committer's push),
        the key checked first, by the broker's own rule for what it pushes. ``task_id`` and ``summary`` stay with the
        task (its recorded outputs, its finish)."""
        del task_id, summary
        self._own(run_id, agent_id)
        if not (patch_key.startswith(agent_prefix(run_id, agent_id)) and is_submitted_patch(patch_key, run_id,
                                                                                               self.commit)):
            raise ValueError('the broker pushes only a patch a fixer or builder of this run submitted at its commit, '
                             'under its own keys; this one is not')
        return ('submitted: the committer has the broker push this patch after the quality gate\'s GO, and only for '
                'the tree the gate judged')

    def push(self, run_id: str, agent_id: str, *, branch: str, patch_key: str, tree_hash: str,
             message: str) -> dict[str, Any]:
        self._own(run_id, agent_id)
        result = self.transport.call(PUSH_BUNDLE, {'branch': branch, 'patch': patch_key, 'tree_hash': tree_hash,
                                                   'message': message, 'attempt': self.attempt})
        return _shaped(result, {'branch': str, 'tree_hash': str})

    def open_draft_pr(self, run_id: str, agent_id: str, *, branch: str, title: str, body: str) -> dict[str, Any]:
        self._own(run_id, agent_id)
        result = self.transport.call(OPEN_OR_UPDATE_DRAFT_PR, {'branch': branch, 'title': title, 'body': body,
                                                               'attempt': self.attempt})
        return _shaped(result, {'number': int, 'url': str})

    def comment(self, run_id: str, agent_id: str, *, number: int, body: str) -> dict[str, Any]:
        self._own(run_id, agent_id)
        result = self.transport.call(POST_COMMENT, {'on': 'pull_request', 'number': number, 'body': body,
                                                    'attempt': self.attempt})
        return _shaped(result, {'url': str})
