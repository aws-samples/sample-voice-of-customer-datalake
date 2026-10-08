"""The arrange block shared by the `api/agents_handler.py` route suites.

`test_agents_handler.py` drives every route end to end and the mutation suite
pins the literals it cannot see; both call the SAME handler through the same
API Gateway event, under the same moto tables, as the same two principals. That
one definition lives here so the event shape, the admin and plain-user claims,
and the handler call cannot drift apart between the two files.
"""
from __future__ import annotations

import json
from collections.abc import Iterator
from contextlib import contextmanager
from typing import Any
from unittest.mock import patch

import agents_handler
from shared.test.agents_fixtures import AgentsEnv, agent_body, agents_env

ADMIN = {'sub': 'admin-sub', 'cognito:username': 'alice', 'cognito:groups': 'admins'}
USER = {'sub': 'user-sub', 'cognito:username': 'bob'}


def event(method: str, path: str, *, claims: dict = ADMIN, body: object = None,
          query: dict | None = None) -> dict:
    """The REST API Gateway proxy event the handler resolves: ``path`` doubles as the resource
    (the resolver matches on it), ``body`` is JSON-encoded only when given."""
    return {
        'httpMethod': method, 'path': path, 'resource': path,
        'headers': {'Content-Type': 'application/json'},
        'requestContext': {'authorizer': {'claims': claims}, 'requestId': 'r', 'stage': 'test',
                           'httpMethod': method, 'path': path},
        'body': json.dumps(body) if body is not None else None,
        'queryStringParameters': query, 'multiValueQueryStringParameters': None,
        'pathParameters': None, 'stageVariables': None, 'multiValueHeaders': {}, 'isBase64Encoded': False,
    }


@contextmanager
def api(**env_kwargs: Any) -> Iterator[AgentsEnv]:
    """The agents tables under moto, with the handler's aggregates lookup pointed at them."""
    with agents_env(**env_kwargs) as env, \
            patch.object(agents_handler, 'get_aggregates_table', return_value=env.aggregates):
        yield env


def call(lambda_context: Any, method: str, path: str, **kwargs: Any) -> tuple[int, dict]:
    """One handler call; the status code and the decoded JSON body."""
    response = agents_handler.lambda_handler(event(method, path, **kwargs), lambda_context)
    return response['statusCode'], json.loads(response['body'])


def create(lambda_context: Any, **overrides: Any) -> dict:
    """An agent created through the route as the admin; the agent the 201 answers."""
    status, body = call(lambda_context, 'POST', '/agents', body=agent_body(**overrides))
    if status != 201:
        raise AssertionError(f'POST /agents answered {status}: {body}')
    return body['agent']
