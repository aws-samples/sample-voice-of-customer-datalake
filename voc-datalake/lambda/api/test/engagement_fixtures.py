"""The arrange block shared by the engagement API suites (api/engagement_handler.py).

``engagement_world()`` runs moto with the participants, feature-requests, projects and
aggregates tables, points the engagement modules at them, and replaces the two calls
that leave the process: SES (``participant_mailer.get_sesv2_client``) and the async
self-invoke (``participants_send.invoke_lambda_async``), both MagicMocks the tests read.
``call`` drives the real handler through an API Gateway REST event as one of the
callers below (app admin, app user, board user, outsider pool).
"""
from __future__ import annotations

import json
import os
from collections.abc import Generator
from contextlib import contextmanager
from dataclasses import dataclass
from typing import Any
from unittest.mock import MagicMock, patch

import boto3
from moto import mock_aws
from moto_helpers import pk_sk_table

APP_POOL = 'us-east-1_AppPool1'
BOARD_POOL = 'us-east-1_BoardPool1'
ISSUER = 'https://cognito-idp.us-east-1.amazonaws.com/'
API_HOST = 'abc123.execute-api.us-east-1.amazonaws.com'
FRONTEND = 'https://voc.example.com'
EMAIL_FROM = 'noreply@voc.example.com'

ADMIN = {'sub': 'admin-sub', 'cognito:groups': 'admins', 'cognito:username': 'ada', 'email': 'ada@example.com',
         'email_verified': 'true', 'iss': ISSUER + APP_POOL, 'name': 'Ada Admin'}
USER = {'sub': 'user-sub', 'cognito:username': 'bob', 'email': 'bob@example.com', 'email_verified': 'true',
        'iss': ISSUER + APP_POOL, 'name': 'Bob User'}
OWNER = {'sub': 'owner-sub', 'cognito:username': 'olga', 'email': 'olga@example.com', 'email_verified': 'true',
         'iss': ISSUER + APP_POOL}
BOARD = {'sub': 'board-sub', 'email': 'Sam@Acme.example', 'email_verified': 'true', 'iss': ISSUER + BOARD_POOL,
         'cognito:groups': 'admins'}
BOARD_2 = {'sub': 'board-sub-2', 'email': 'kim@acme.example', 'email_verified': 'true', 'iss': ISSUER + BOARD_POOL}
STRANGER = {'sub': 'x-sub', 'email': 'eve@example.com', 'email_verified': 'true',
            'iss': ISSUER + 'us-east-1_Elsewhere'}

PUBLIC_PROJECT = 'proj-public'
PRIVATE_PROJECT = 'proj-private'
FORM_ID = 'form-1'


@dataclass
class World:
    participants: Any
    requests: Any
    projects: Any
    aggregates: Any
    ses: MagicMock
    invoke: MagicMock


def _seed(projects: Any, aggregates: Any) -> None:
    projects.put_item(Item={'pk': f'PROJECT#{PUBLIC_PROJECT}', 'sk': 'META', 'visibility': 'public',
                            'owner_sub': 'owner-sub'})
    projects.put_item(Item={'pk': f'PROJECT#{PRIVATE_PROJECT}', 'sk': 'META', 'visibility': 'private',
                            'owner_sub': 'owner-sub', 'members': {'user-sub': {'role': 'viewer'}}})
    aggregates.put_item(Item={'pk': 'SETTINGS#brand', 'sk': 'config', 'brand_name': 'Example Air'})
    aggregates.put_item(Item={'pk': 'FEEDBACK_FORM', 'sk': f'FORM#{FORM_ID}', 'name': 'Survey', 'enabled': True})


@contextmanager
def engagement_world(**env: str) -> Generator[World, None, None]:
    """moto tables + patched AWS edges for one test (``env`` overrides the Lambda environment)."""
    values = {'PARTICIPANTS_TABLE': 'participants', 'FEATURE_REQUESTS_TABLE': 'requests',
              'EMAIL_FROM': EMAIL_FROM, 'FRONTEND_URL': FRONTEND, 'APP_USER_POOL_ID': APP_POOL,
              'BOARD_USER_POOL_ID': BOARD_POOL, 'ENGAGEMENT_FUNCTION': 'voc-engagement-api', **env}
    from shared import engagement_config
    with mock_aws(), patch.dict(os.environ, values):
        resource = boto3.resource('dynamodb', region_name='us-east-1')
        world = World(
            participants=pk_sk_table('participants', gsi1_index='gsi1'),
            requests=pk_sk_table('requests', gsi1_index='gsi1'),
            projects=pk_sk_table('projects'), aggregates=pk_sk_table('aggregates'),
            ses=MagicMock(), invoke=MagicMock(),
        )
        world.ses.send_email.return_value = {'MessageId': 'm-1'}
        _seed(world.projects, world.aggregates)
        engagement_config._table.cache_clear()
        with patch('shared.engagement_config.get_dynamodb_resource', return_value=resource), \
                patch('shared.engagement_config.get_aggregates_table', return_value=world.aggregates), \
                patch('shared.participants_ask_routes.get_aggregates_table', return_value=world.aggregates), \
                patch('shared.engagement_identity.get_projects_table', return_value=world.projects), \
                patch('shared.participant_mailer.get_sesv2_client', return_value=world.ses), \
                patch('shared.participants_send.invoke_lambda_async', world.invoke), \
                patch('shared.participants_send.time.sleep'):
            yield world
        engagement_config._table.cache_clear()


COMPANY_DOMAIN = 'acme.example'


@contextmanager
def boards_world() -> Generator[World, None, None]:
    """``engagement_world`` with the company domain set (the boards' ``company`` audience)."""
    from shared.participants_settings import SETTINGS_KEY
    with engagement_world() as world:
        world.participants.put_item(Item={**SETTINGS_KEY, 'company_domains': [COMPANY_DOMAIN]})
        yield world


def event(method: str, path: str, *, claims: dict | None = None, body: object = None,
          query: dict | None = None, raw_body: str | None = None) -> dict:
    """A REST proxy event; ``claims=None`` is an unauthenticated (public route) caller."""
    context: dict[str, Any] = {'requestId': 'r', 'stage': 'v1', 'domainName': API_HOST, 'httpMethod': method,
                               'path': path}
    if claims is not None:
        context['authorizer'] = {'claims': claims}
    return {
        'httpMethod': method, 'path': path, 'resource': path,
        'headers': {'Content-Type': 'application/json'},
        'requestContext': context,
        'body': raw_body if raw_body is not None else (json.dumps(body) if body is not None else None),
        'queryStringParameters': query, 'multiValueQueryStringParameters': None,
        'pathParameters': None, 'stageVariables': None, 'multiValueHeaders': {}, 'isBase64Encoded': False,
    }


def call(lambda_context: Any, method: str, path: str, *, claims: dict | None = ADMIN, **kwargs: Any) -> tuple[int, Any]:
    """One handler call; the status code and the decoded JSON body."""
    import engagement_handler
    response = engagement_handler.lambda_handler(event(method, path, claims=claims, **kwargs), lambda_context)
    body = response.get('body')
    return response['statusCode'], json.loads(body) if body else None


def ok(lambda_context: Any, method: str, path: str, expected: int = 200, **kwargs: Any) -> Any:
    """``call`` that fails the test unless the status is ``expected``; the body."""
    status, body = call(lambda_context, method, path, **kwargs)
    if status != expected:
        raise AssertionError(f'{method} {path} answered {status}: {body}')
    return body


def run_send_job(lambda_context: Any, world: World) -> list[dict]:
    """Run every queued self-invoke (and the ones they queue); the events, in order."""
    import engagement_handler
    events: list[dict] = []
    while world.invoke.call_count > len(events):
        payload = world.invoke.call_args_list[len(events)].args[1]
        events.append(payload)
        engagement_handler.lambda_handler(payload, lambda_context)
    return events
