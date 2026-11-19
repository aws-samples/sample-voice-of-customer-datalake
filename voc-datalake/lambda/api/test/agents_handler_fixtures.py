"""The arrange block shared by the `api/agents_handler.py` route suites.

`test_agents_handler.py` drives every route end to end and the mutation suite
pins the literals it cannot see; both call the SAME handler through the same
API Gateway event, under the same moto tables, as the same two principals. That
one definition lives here so the event shape, the admin and plain-user claims,
and the handler call cannot drift apart between the two files.
"""
from __future__ import annotations

import json
from collections.abc import Generator, Iterable
from contextlib import contextmanager
from typing import Any
from unittest.mock import patch

import pytest

import agents_handler
from shared import agent_seed, workflow_schema
from shared.test.agents_fixtures import AgentsEnv, agent_body, agents_env

ADMIN = {'sub': 'admin-sub', 'cognito:username': 'alice', 'cognito:groups': 'admins'}
USER = {'sub': 'user-sub', 'cognito:username': 'bob'}


def event(method: str, path: str, *, claims: dict = ADMIN, body: object = None,
          query: dict | None = None, headers: dict | None = None) -> dict:
    """The REST API Gateway proxy event the handler resolves: ``path`` doubles as the resource
    (the resolver matches on it), ``body`` is JSON-encoded only when given; ``headers`` adds request headers."""
    return {
        'httpMethod': method, 'path': path, 'resource': path,
        'headers': {'Content-Type': 'application/json', **(headers or {})},
        'requestContext': {'authorizer': {'claims': claims}, 'requestId': 'r', 'stage': 'test',
                           'httpMethod': method, 'path': path},
        'body': json.dumps(body) if body is not None else None,
        'queryStringParameters': query, 'multiValueQueryStringParameters': None,
        'pathParameters': None, 'stageVariables': None, 'multiValueHeaders': {}, 'isBase64Encoded': False,
    }


@contextmanager
def api(**env_kwargs: Any) -> Generator[AgentsEnv, None, None]:
    """The agents tables under moto, with the handler's aggregates lookup pointed at them.

    The default-agent seed's warm-container memo is reset, so each test starts as a fresh deployment.
    """
    agent_seed._settled.clear()
    with agents_env(**env_kwargs) as env, \
            patch.object(agents_handler, 'get_aggregates_table', return_value=env.aggregates):
        yield env


def engineering_agents(monkeypatch: pytest.MonkeyPatch) -> Generator[AgentsEnv, None, None]:
    """``api()`` with the engineering agents on, their table named ``test-engineering``: a suite's fixture
    (``env = pytest.fixture(engineering_agents, name='env')``). Through ``monkeypatch``, so a test's own change of the
    same variables is undone with it."""
    with api() as env:
        monkeypatch.setenv('ENGINEERING_AGENTS', 'on')
        monkeypatch.setenv('ENGINEERING_TABLE', 'test-engineering')
        yield env


def call(lambda_context: Any, method: str, path: str, **kwargs: Any) -> tuple[int, dict]:
    """One handler call; the status code and the decoded JSON body."""
    response = agents_handler.lambda_handler(event(method, path, **kwargs), lambda_context)
    return response['statusCode'], json.loads(response['body'])


def route_statuses(lambda_context: Any, routes: Iterable[tuple[str, str]], claims: dict) -> dict[tuple[str, str], int]:
    """Each of ``routes`` (method, path) and the status it answers ``claims``, with an empty body."""
    return {(method, path): call(lambda_context, method, path, body={}, claims=claims)[0] for method, path in routes}


def create(lambda_context: Any, **overrides: Any) -> dict:
    """An agent created through the route as the admin; the agent the 201 answers."""
    status, body = call(lambda_context, 'POST', '/agents', body=agent_body(**overrides))
    if status != 201:
        raise AssertionError(f'POST /agents answered {status}: {body}')
    return body['agent']


def create_workflow(lambda_context: Any, name: str = 'Research flow') -> dict:
    """A library workflow created through the route as the admin (the built-in template, renamed);
    the workflow the 201 answers."""
    definition = {**workflow_schema.default_template(), 'name': name}
    status, body = call(lambda_context, 'POST', '/workflows', body={'definition': definition})
    if status != 201:
        raise AssertionError(f'POST /workflows answered {status}: {body}')
    return body['workflow']
