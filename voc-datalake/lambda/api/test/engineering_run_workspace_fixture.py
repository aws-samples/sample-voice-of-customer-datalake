"""The run workspace's answers as the Agents API gives them (7.51.00), for the shared fixture
``frontend/src/test/engineeringRunWorkspace.json``.

Every route of the run workspace is called through ``agents_handler.lambda_handler`` (the API Gateway event, an
administrator acting for themselves) on one fixed run (engineering/test/run_workspace_world.py): the overview of the
run, of an ended run and of its child, the runs list, an agent's thread (its start, a later page, its tail) and one item,
its changes (its submitted patch, a checkpoint's, one file), its files, the gate runner's gate, its memory, the
assertions, and the three actions (a person's steering, a restart signal, an ended run's restart as a child run), each
with its method, path, query, body, status and answer. The web app builds against the file (the run workspace's zod
schemas, its mock); ``test_engineering_run_workspace.py`` holds the file to what this gives.

When the server's answers change on purpose, rewrite it and read the diff (from voc-datalake):
``REWRITE_RUN_WORKSPACE_FIXTURE=1 .venv/bin/python -m pytest --no-cov lambda/api/test/test_engineering_run_workspace.py
-k shared_fixture``.
"""
from __future__ import annotations

import io
import json
import os
from collections.abc import Iterator
from contextlib import ExitStack, contextmanager
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from unittest.mock import MagicMock, patch

FIXTURE = Path(__file__).resolve().parents[3] / 'frontend' / 'src' / 'test' / 'engineeringRunWorkspace.json'
#: The ids the actions mint (an event's, a child run's), fixed for the file.
EVENT_ID = '01JDAB0000000000000000STER'
CHILD_ID = '01JDAC0000000000000000RSTR'
NOW = datetime(2026, 11, 17, 9, 45, tzinfo=UTC)


class _FixedClock(datetime):
    """``datetime`` whose ``now`` is the file's (the monitor's records are timed by it)."""

    @classmethod
    def now(cls, tz: Any = None) -> datetime:  # type: ignore[override]
        return NOW if tz is None else NOW.astimezone(tz)


class Bus:
    """EventBridge as the routes see it: records each entry."""

    def __init__(self) -> None:
        self.entries: list[dict[str, Any]] = []

    def put_events(self, Entries: list[dict[str, Any]]) -> dict[str, Any]:  # (boto3's keyword)
        self.entries.extend(Entries)
        return {'FailedEntryCount': 0, 'Entries': [{'EventId': 'e-1'}]}


class Lambdas:
    """The Lambda function the actions invoke: voc-engineering-start, its ``signal_run`` (7.51.02: a person's signals
    go through it, never the runtime's own function) and its ``restart_run``."""

    def __init__(self) -> None:
        self.requests: list[dict[str, Any]] = []

    def invoke(self, **request: Any) -> dict[str, Any]:
        payload = json.loads(request['Payload'])
        self.requests.append(payload)
        if payload.get('action') == 'restart_run':
            answer: dict[str, Any] = {'run_id': payload['child_run_id'], 'status': 'active'}
        else:   # (signal_run: recorded on the run's RUNLOG# rows and handed on to the supervisor)
            answer = {'run_id': payload['run_id'], 'signal': payload['signal'], 'agent_id': payload.get('agent_id'),
                      'task_id': payload.get('task_id'), 'attempt': payload.get('attempt', 0), 'status': 'sent',
                      'at': NOW.strftime('%Y-%m-%dT%H:%M:%SZ')}
        return {'StatusCode': 200, 'Payload': io.BytesIO(json.dumps(answer).encode())}


@contextmanager
def workspace_api() -> Iterator[tuple[Any, Bus, Lambdas]]:
    """The Agents API on moto with the world in it, the module on, its bus and functions faked; the world."""
    from agents_handler_fixtures import api

    from engineering.test import run_workspace_world as world

    bus, lambdas = Bus(), Lambdas()
    env = {'ENGINEERING_AGENTS': 'on', 'ENGINEERING_TABLE': world.TABLE, 'ENGINEERING_WORKSPACE_BUCKET': world.BUCKET,
           'ENGINEERING_BUS_NAME': 'voc-engineering', 'ENGINEERING_START_FUNCTION': 'voc-engineering-start'}
    with api(), patch.dict(os.environ, env), ExitStack() as stack:
        built = world.build()
        for target, value in (('shared.aws.get_dynamodb_client', built.client), ('shared.aws.get_s3_client', built.s3),
                              ('shared.aws.get_eventbridge_client', bus), ('shared.aws.get_lambda_client', lambdas),
                              ('shared.agents_engineering_run_routes._start_client', lambdas),
                              ('agents_handler._start_client', lambdas)):
            stack.enter_context(patch(target, return_value=value))
        stack.enter_context(patch('engineering.monitor.new_event_id', return_value=EVENT_ID))
        stack.enter_context(patch('engineering.monitor.datetime', _FixedClock))
        stack.enter_context(patch('shared.engineering_agent_runs.new_run_id', return_value=CHILD_ID))
        yield built, bus, lambdas


def _context() -> Any:
    context = MagicMock()
    context.function_name = 'test-voc-api'
    context.memory_limit_in_mb = 256
    context.invoked_function_arn = 'arn:aws:lambda:us-east-1:123456789012:function:test-voc-api'
    context.aws_request_id = 'fixture'
    context.get_remaining_time_in_millis.return_value = 30000
    return context


def exchange(method: str, path: str, *, query: dict[str, str] | None = None, body: Any = None) -> dict[str, Any]:
    """One request as the fixture keeps it: what was asked and what the API answered."""
    from agents_handler_fixtures import call

    status, answer = call(_context(), method, path, query=query, body=body)
    entry: dict[str, Any] = {'method': method, 'path': path}
    if query:
        entry['query'] = query
    if body is not None:
        entry['body'] = body
    return {**entry, 'status': status, 'answer': answer}


def answers() -> dict[str, Any]:
    """Every exchange of the fixture, inside ``workspace_api``."""
    from engineering.test import run_workspace_world as world

    base = f'/agents/engineering/{world.RUN}'
    fixer, gate = f'{base}/agents/{world.FIXER}', f'{base}/agents/{world.GATE_RUNNER}'
    found: dict[str, Any] = {'run_id': world.RUN, 'agent': world.FIXER, 'gate_agent': world.GATE_RUNNER,
                             'ended_run_id': world.ENDED_RUN, 'child_run_id': world.CHILD_RUN}
    found['overview'] = exchange('GET', base)
    found['ended_overview'] = exchange('GET', f'/agents/engineering/{world.ENDED_RUN}')
    found['child_overview'] = exchange('GET', f'/agents/engineering/{world.CHILD_RUN}')
    found['runs'] = exchange('GET', '/agents/engineering/runs', query={'month': world.MONTH})
    found['thread'] = exchange('GET', f'{fixer}/thread', query={'limit': '8'})
    found['thread_next'] = exchange('GET', f'{fixer}/thread', query={'after': found['thread']['answer']['next']})
    cursor = next(agent['transcript_cursor'] for agent in found['overview']['answer']['agents']
                  if agent['agent'] == world.FIXER)
    found['thread_tail'] = exchange('GET', f'{fixer}/thread', query={'after': cursor, 'limit': '6'})
    run_call = next(item['ref'] for item in found['thread_next']['answer']['items']
                    if item.get('tool', {}).get('name') == 'run')
    found['thread_item'] = exchange('GET', f'{fixer}/thread/{run_call}')
    found['changes'] = exchange('GET', f'{fixer}/changes')
    found['changes_checkpoint'] = exchange('GET', f'{fixer}/changes', query={'source': 'checkpoint'})
    found['change_file'] = exchange('GET', f'{fixer}/changes/file', query={'key': world.SUBMITTED_KEY,
                                                                            'path': 'src/paging.py'})
    found['files'] = exchange('GET', f'{fixer}/files')
    found['gate'] = exchange('GET', f'{gate}/gate')
    found['memory'] = exchange('GET', f'{fixer}/memory')
    found['assertions'] = exchange('GET', f'{base}/assertions')
    found['steer'] = exchange('POST', f'{base}/steer', body={'text': 'Leave the docs for a later change.',
                                                            'about': world.FIXER})
    found['signal_restart'] = exchange('POST', f'{base}/signals', body={
        'signal': 'restart', 'from': 'checkpoint', 'task_id': world.FIX_TASK, 'attempt': 2, 'confirm': True})
    found['restart'] = exchange('POST', f'/agents/engineering/{world.ENDED_RUN}/restart',
                                body={'mode': 'resume', 'base': 'same', 'confirm': True})
    return found


def expected() -> dict[str, Any]:
    with workspace_api():
        return answers()

