"""A moto-backed world for the global MCP tests, driven the way an external client drives it.

``global_mcp_world()`` builds, inside one ``mock_aws``: the projects table (with
its type index), the jobs table (audit), the agents/aggregates tables
(``agents_env``), the feedback table (its date and feedback-id indexes) with one
feedback form's response (``_form_item``, its respondent's contact fields included; an email inbox item,
``inbox_item``, is for a test to add),
a user directory with ``alice`` (a user), ``bob`` (a user)
and ``root`` (an admin) — ``FakeDirectory``, because moto's Cognito backend needs
a package this venv lacks — three projects and one agent.

Delegation is REAL: ``shared.mcp_delegate``'s Lambda client is replaced by
``InProcessLambda``, which runs the named domain handler module's
``lambda_handler`` on the synthesized proxy event — so the projects gate, the
agents admin check and every route validator run exactly as deployed.

``McpClient`` speaks MCP Streamable HTTP as API Gateway delivers it to the Lambda
(REST proxy event, ``POST /mcp/global``, the token authorizer's context rather
than Cognito claims). No ``mcp`` client package is installed in this venv, so the
JSON-RPC frames are written by hand, following the 2025-06-18 transport.
"""
from __future__ import annotations

import io
import json
import os
import uuid
from collections.abc import Generator
from contextlib import ExitStack, contextmanager
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from typing import Any
from unittest.mock import patch

from botocore.exceptions import ClientError
from moto_helpers import indexed_table, pk_sk_table, rest_event

import agents_handler
import mcp_global_handler
import mcp_tokens_handler
import metrics_handler
import projects
import projects_handler
from shared import mcp_global_tokens as gt
from shared.indexes import FEEDBACK_BY_DATE_INDEX, FEEDBACK_BY_ID_INDEX, PROJECTS_BY_TYPE_INDEX
from shared.test.agents_fixtures import agent_body, agents_env

PROTOCOL_VERSION = '2025-06-18'
FUNCTIONS = {'PROJECTS_FUNCTION': 'projects-fn', 'AGENTS_FUNCTION': 'agents-fn',
             'METRICS_FUNCTION': 'metrics-fn', 'SETTINGS_FUNCTION': 'settings-fn',
             'MEMORY_FUNCTION': 'memory-fn'}
ALPHA, BETA, GAMMA = 'proj_alpha', 'proj_beta', 'proj_gamma'
ALPHA_DOC = 'doc_alpha_brief'
FORM_FEEDBACK_ID = 'fb_form_1'
#: A feedback form's response as the processor stores it (shared/forms_v2_responses.py answers) under the allow
#: policy: its respondent's contact fields in ``metadata`` (the submit route's ``submitter_email`` /
#: ``submitter_name``, and ``email``, the key the inbox keeps its sender's address under) and in its contact_info
#: answer, ``q_contact``; and an open-text question whose input is email-typed, ``q_reply``, answered with an address:
#: the respondent's own words like any open answer, so also in the item's text (response_text).
FORM_CONTACT_ANSWER = {'name': 'Ana Example', 'email': 'ana@example.com', 'phone': '+1 555 0100', 'company': 'Example Co'}
FORM_TYPED_EMAIL = 'ana.work@example.com'
FORM_TEXT = f'Why?\nRefunds take too long\n\nYour work email\n{FORM_TYPED_EMAIL}'
FORM_METADATA = {
    'form_id': 'ff_checkout', 'form_name': 'Checkout survey', 'form_version': '3.0', 'form_revision': 1,
    'form_language': 'en', 'form_path': ['q_why', 'q_reason', 'q_rate', 'q_reply', 'q_contact'],
    'form_answers': {'q_why': 'Refunds take too long', 'q_reason': {'code': 'slow'}, 'q_rate': 2,
                     'q_reply': FORM_TYPED_EMAIL, 'q_contact': FORM_CONTACT_ANSWER},
    'submitter_email': 'ana@example.com', 'submitter_name': 'Ana Example', 'email': 'ana@example.com',
}
INBOX_FEEDBACK_ID = 'fb_inbox_1'
#: The email inbox's sender as an item of it keeps them under the allow policy (email_intake/compose.py
#: build_message): the name, else the address, as the top-level ``author``, the address as ``metadata.email``.
INBOX_SENDER = {'author': 'Ben Sender', 'email': 'ben.sender@example.com'}


class InProcessLambda:
    """A Lambda client whose ``invoke`` runs the domain handler in this process."""

    def __init__(self, handlers: dict[str, Any], context: Any):
        self.handlers = handlers
        self.context = context
        self.calls: list[tuple[str, dict]] = []

    def invoke(self, *, FunctionName: str, InvocationType: str, Payload: str) -> dict:
        assert InvocationType == 'RequestResponse'
        event = json.loads(Payload)
        self.calls.append((FunctionName, event))
        response = self.handlers[FunctionName].lambda_handler(event, self.context)
        return {'StatusCode': 200, 'Payload': io.BytesIO(json.dumps(response).encode())}


class FakeDirectory:
    """The Cognito calls the global MCP handler makes, over an in-memory user list.

    moto's cognito-idp backend needs `joserfc`, which this venv does not ship, so
    the directory is faked at the boto3 client surface instead — same method
    names, same response shapes, same `UserNotFoundException` ClientError.
    """

    def __init__(self, usernames: tuple[str, ...], admins: set[str]):
        self.users = {name: {'sub': str(uuid.uuid4()), 'enabled': True} for name in usernames}
        self.admins = set(admins)

    def _user(self, username: str) -> dict:
        if username not in self.users:
            raise ClientError({'Error': {'Code': 'UserNotFoundException', 'Message': 'no such user'}},
                              'AdminGetUser')
        return self.users[username]

    def admin_get_user(self, *, Username: str, **_pool: Any) -> dict:
        user = self._user(Username)
        return {'Username': Username, 'Enabled': user['enabled'],
                'UserAttributes': [{'Name': 'sub', 'Value': user['sub']}]}

    def admin_list_groups_for_user(self, *, Username: str, **_pool_and_paging: Any) -> dict:
        self._user(Username)
        return {'Groups': [{'GroupName': 'admins'}] if Username in self.admins else []}

    def disable(self, username: str) -> None:
        self.users[username]['enabled'] = False

    def demote(self, username: str) -> None:
        self.admins.discard(username)


@dataclass
class McpReply:
    status: int
    body: dict | None
    headers: dict


@dataclass
class McpClient:
    """Hand-rolled MCP client: one JSON-RPC message per POST, JSON responses."""

    token: str | None
    context: Any
    negotiated: str | None = None
    _next_id: int = 0
    log: list[McpReply] = field(default_factory=list)

    def post(self, message: dict) -> McpReply:
        headers = {'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream'}
        if self.token:
            headers['Authorization'] = f'Bearer {self.token}'
        if self.negotiated:
            headers['MCP-Protocol-Version'] = self.negotiated
        event = {
            'httpMethod': 'POST', 'path': '/mcp/global', 'resource': '/mcp/global',
            'headers': headers, 'multiValueHeaders': {},
            'queryStringParameters': None, 'pathParameters': None, 'stageVariables': None,
            # A TOKEN authorizer's context, as API Gateway passes it: no Cognito claims.
            'requestContext': {'authorizer': {'principalId': 'mcp-client'}, 'stage': 'v1',
                               'requestId': 'req', 'httpMethod': 'POST', 'path': '/v1/mcp/global'},
            'body': json.dumps(message), 'isBase64Encoded': False,
        }
        raw = mcp_global_handler.lambda_handler(event, self.context)
        reply = McpReply(raw['statusCode'], json.loads(raw['body']) if raw['body'] else None, raw['headers'])
        self.log.append(reply)
        return reply

    def request(self, method: str, params: dict | None = None) -> McpReply:
        self._next_id += 1
        return self.post({'jsonrpc': '2.0', 'id': self._next_id, 'method': method, 'params': params or {}})

    def connect(self) -> McpReply:
        """initialize → notifications/initialized, as every MCP client opens a session."""
        reply = self.request('initialize', {
            'protocolVersion': PROTOCOL_VERSION, 'capabilities': {},
            'clientInfo': {'name': 'e2e-test-client', 'version': '1.0'},
        })
        if reply.status == 200 and reply.body and 'result' in reply.body:
            self.negotiated = reply.body['result']['protocolVersion']
            notified = self.post({'jsonrpc': '2.0', 'method': 'notifications/initialized'})
            assert notified.status == 202
            assert notified.body is None
        return reply

    def tool_names(self) -> list[str]:
        reply = self.request('tools/list')
        assert reply.status == 200, reply.body
        assert reply.body is not None
        return [tool['name'] for tool in reply.body['result']['tools']]

    def call(self, name: str, arguments: dict | None = None) -> McpReply:
        return self.request('tools/call', {'name': name, 'arguments': arguments or {}})


@dataclass
class World:
    context: Any
    projects: Any
    jobs: Any
    agents_env: Any
    cognito: FakeDirectory
    pool_id: str
    subs: dict[str, str]
    agent_id: str
    lambdas: InProcessLambda
    feedback: Any

    def claims(self, username: str) -> dict:
        claims = {'sub': self.subs[username], 'cognito:username': username, 'email': f'{username}@example.com'}
        if username == 'root':
            claims['cognito:groups'] = 'admins'
        return claims

    def tokens_api(self, username: str, method: str, path: str, body: dict | None = None,
                   query: dict | None = None) -> tuple[int, dict]:
        event = rest_event(method, path, claims=self.claims(username), body=body)
        event['queryStringParameters'] = query
        response = mcp_tokens_handler.lambda_handler(event, self.context)
        return response['statusCode'], json.loads(response['body'])

    def mint(self, username: str, **body: Any) -> dict:
        status, minted = self.tokens_api(username, 'POST', '/connect/tokens', {'name': 'e2e', **body})
        assert status == 200, minted
        return minted

    def expire(self, minted: dict) -> None:
        """Moves the token's ``expires_at`` one second into the past."""
        self.projects.update_item(
            Key={'pk': gt.GLOBAL_TOKEN_PK, 'sk': gt.token_sk(minted['token_id'])},
            UpdateExpression='SET expires_at = :past',
            ExpressionAttributeValues={':past': (datetime.now(UTC) - timedelta(seconds=1)).isoformat()},
        )

    def client(self, minted: dict | str | None) -> McpClient:
        token = minted['token'] if isinstance(minted, dict) else minted
        return McpClient(token=token, context=self.context)

    def audit(self, username: str, token_id: str) -> list[dict]:
        status, body = self.tokens_api(username, 'GET', f'/connect/tokens/{token_id}')
        assert status == 200, body
        return body['events']


def _project(table: Any, project_id: str, *, owner: str, visibility: str, name: str) -> None:
    table.put_item(Item={
        'pk': f'PROJECT#{project_id}', 'sk': 'META', 'project_id': project_id, 'name': name,
        'gsi1pk': 'TYPE#PROJECT', 'gsi1sk': f'2026-01-01#{project_id}', 'status': 'active',
        'visibility': visibility, 'owner_sub': owner, 'owner_username': name, 'members': {},
        'created_at': '2026-01-01T00:00:00+00:00', 'document_count': 1,
    })


def _form_item() -> dict[str, Any]:
    """Today's response of a feedback form, in its source partition and both indexes."""
    today = datetime.now(UTC).strftime('%Y-%m-%d')
    return {
        'pk': 'SOURCE#feedback_form', 'sk': f'FEEDBACK#{FORM_FEEDBACK_ID}', 'feedback_id': FORM_FEEDBACK_ID,
        'gsi4pk': f'FEEDBACK#{FORM_FEEDBACK_ID}', 'gsi1pk': f'DATE#{today}', 'gsi1sk': f'{today}T09:00:00+00:00',
        'date': today, 'source_platform': 'feedback_form', 'source_channel': 'form_ff_checkout',
        'created_at': f'{today}T09:00:00+00:00', 'original_text': FORM_TEXT, 'category': 'billing',
        'sentiment_label': 'negative', 'sentiment_score': Decimal('-0.6'), 'problem_summary': 'Slow refunds',
        'metadata': FORM_METADATA,
    }


def inbox_item() -> dict[str, Any]:
    """Today's email to the inbox, in its source partition and both indexes, an hour after the form's response."""
    today = datetime.now(UTC).strftime('%Y-%m-%d')
    return {
        'pk': 'SOURCE#email_intake', 'sk': f'FEEDBACK#{INBOX_FEEDBACK_ID}', 'feedback_id': INBOX_FEEDBACK_ID,
        'gsi4pk': f'FEEDBACK#{INBOX_FEEDBACK_ID}', 'gsi1pk': f'DATE#{today}', 'gsi1sk': f'{today}T10:00:00+00:00',
        'date': today, 'source_platform': 'email_intake', 'source_channel': 'feedback',
        'created_at': f'{today}T10:00:00+00:00', 'original_text': 'The export button crashes the app',
        'category': 'bugs', 'sentiment_label': 'negative', 'sentiment_score': Decimal('-0.7'),
        'problem_summary': 'Export crashes', 'author': INBOX_SENDER['author'],
        'metadata': {'email': INBOX_SENDER['email'], 'thread_id': 'thr_1', 'is_reply': False, 'forwarded': False},
    }


def _users() -> tuple[FakeDirectory, dict[str, str]]:
    directory = FakeDirectory(('alice', 'bob', 'root'), admins={'root'})
    return directory, {name: user['sub'] for name, user in directory.users.items()}


def _seed(projects_table: Any, subs: dict[str, str]) -> None:
    _project(projects_table, ALPHA, owner=subs['alice'], visibility='private', name='Alpha')
    _project(projects_table, BETA, owner=subs['bob'], visibility='private', name='Beta')
    _project(projects_table, GAMMA, owner=subs['bob'], visibility='public', name='Gamma')
    projects_table.put_item(Item={
        'pk': f'PROJECT#{ALPHA}', 'sk': f'DOC#{ALPHA_DOC}', 'document_id': ALPHA_DOC,
        'document_type': 'custom', 'title': 'Brief', 'content': 'Customers want faster refunds.',
        'created_at': '2026-01-02T00:00:00+00:00', 'updated_at': '2026-01-02T00:00:00+00:00',
    })


@contextmanager
def global_mcp_world(lambda_context: Any) -> Generator[World, None, None]:
    with agents_env() as env, ExitStack() as stack:
        projects_table = pk_sk_table('e2e-projects', gsi1_index=PROJECTS_BY_TYPE_INDEX)
        jobs_table = pk_sk_table('e2e-jobs')
        feedback_table = indexed_table(env.resource, 'e2e-feedback', {FEEDBACK_BY_DATE_INDEX: ('gsi1pk', 'gsi1sk'),
                                                                     FEEDBACK_BY_ID_INDEX: ('gsi4pk', None)})
        feedback_table.put_item(Item=_form_item())
        cognito, subs = _users()
        pool_id = 'us-east-1_e2e'
        _seed(projects_table, subs)

        lambdas = InProcessLambda({'projects-fn': projects_handler, 'agents-fn': agents_handler,
                                   'metrics-fn': metrics_handler}, lambda_context)
        stack.enter_context(patch.dict(os.environ, {**FUNCTIONS, 'USER_POOL_ID': pool_id}))
        for module in (mcp_global_handler, mcp_tokens_handler, projects_handler):
            stack.enter_context(patch.object(module, 'get_projects_table', return_value=projects_table))
        for module in (mcp_global_handler, mcp_tokens_handler):
            stack.enter_context(patch.object(module, 'get_jobs_table', return_value=jobs_table))
        stack.enter_context(patch.object(projects, 'projects_table', projects_table))
        stack.enter_context(patch.object(agents_handler, 'get_aggregates_table', return_value=env.aggregates))
        stack.enter_context(patch.object(metrics_handler, 'feedback_table', feedback_table))
        stack.enter_context(patch.object(metrics_handler, 'aggregates_table', env.aggregates))
        stack.enter_context(patch.object(mcp_global_handler, '_cognito_client', return_value=cognito))
        stack.enter_context(patch('shared.mcp_delegate.get_delegate_lambda_client', return_value=lambdas))
        # A fresh table has no backfill marker: never inherit a warm "index complete".
        stack.enter_context(patch.dict(mcp_tokens_handler._index_state, {'complete': False}))

        created = agents_handler.lambda_handler(_agent_event(subs['root']), lambda_context)
        assert created['statusCode'] == 201, created['body']
        agent_id = json.loads(created['body'])['agent']['agent_id']
        yield World(lambda_context, projects_table, jobs_table, env, cognito, pool_id, subs, agent_id, lambdas,
                    feedback_table)


def _agent_event(admin_sub: str) -> dict:
    claims = {'sub': admin_sub, 'cognito:username': 'root', 'cognito:groups': 'admins'}
    return rest_event('POST', '/agents', claims=claims, body=agent_body(scope={'all': True}))


def tool_payload(reply: McpReply) -> tuple[bool, Any]:
    """(isError, decoded text content) of a successful JSON-RPC tools/call reply."""
    assert reply.status == 200, reply.body
    assert reply.body, reply.body
    assert 'result' in reply.body, reply.body
    result = reply.body['result']
    text = result['content'][0]['text']
    try:
        decoded: Any = json.loads(text)
    except json.JSONDecodeError:
        decoded = text
    return result['isError'], decoded
