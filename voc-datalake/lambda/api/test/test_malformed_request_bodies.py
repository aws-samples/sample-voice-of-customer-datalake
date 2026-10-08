"""A malformed request body is the caller's 400 on every API write route, never a 5xx.

E2e security probes (2026-10-06) found it on the scrapers routes first
(`test_scrapers_malformed_requests.py`); the root cause was every handler reading
`app.current_event.json_body` itself. Unparseable JSON raised `JSONDecodeError`
at the attribute read, and a JSON array or string died on `.get` — neither has a
registered exception handler, so the request surfaced as a 500 (or a 502).
Every route below now reads its body through `shared.request_body`.

Each route is driven through its handler's real `lambda_handler` with three
bodies (invalid JSON, a JSON array, a JSON string), and the AWS SDK is replaced
at its one choke point (`BaseClient._make_api_call`) by a recorder that answers
every call with an empty response. That makes "nothing happened" checkable for
every route alike: no write, enqueue, invoke, model call or Cognito change was
SENT — a read the route makes first (an access gate) is allowed.
"""
from __future__ import annotations

import importlib
import json
from collections.abc import Iterator
from contextlib import ExitStack
from dataclasses import dataclass, field
from typing import Any
from unittest.mock import patch

import boto3
import pytest

MALFORMED_BODIES = [
    pytest.param('{"not": json', id='invalid-json'),
    pytest.param('[{"name": "x"}]', id='json-array'),
    pytest.param('"just a string"', id='json-string'),
]

# Operation-name prefixes that only read. Anything else the SDK is asked to do
# (a put or update, an enqueue, an invoke, a model call, a Cognito change) is a
# side effect, and must not happen for a request that never had a usable body.
_READ_PREFIXES = ('Get', 'List', 'Describe', 'Query', 'Scan', 'BatchGet', 'Head', 'AdminGet', 'AdminList')


@dataclass(frozen=True)
class Route:
    module: str
    method: str
    path: str
    # Module attributes a route consults BEFORE its body (a configured function
    # name or bucket, the row it edits), set so the request reaches the body read.
    config: dict[str, object] = field(default_factory=dict)
    project: bool = False

    def id(self) -> str:
        return f'{self.module.removesuffix("_handler")}:{self.method} {self.path}'


_P = '/projects/proj-123'

# A company memory waiting for review, so the edit/resolve routes get past their
# 404 and state checks to the body read; the table is a real boto3 resource, so
# whatever it is asked goes through the recorder below.
_STORED_MEMORY: dict[str, object] = {
    '_memory_or_404': lambda _memory_id, _caller: {
        'pk': 'MEM#company', 'sk': 'MEM#mem-1', 'memory_id': 'mem-1', 'scope': 'company', 'status': 'proposed',
    },
    'get_memory_table': lambda: boto3.resource('dynamodb', region_name='us-east-1').Table('test-memory'),
}

ROUTES = [
    Route('chat_handler', 'POST', '/chat/conversations/conv-1'),
    Route('data_explorer_handler', 'PUT', '/data-explorer/s3'),
    Route('data_explorer_handler', 'PUT', '/data-explorer/feedback'),
    Route('feedback_edit_handler', 'PUT', '/feedback/fb-1/category'),
    Route('feedback_form_handler', 'POST', '/feedback-forms'),
    Route('feedback_form_handler', 'PUT', '/feedback-forms/form_1'),
    Route('feedback_form_handler', 'POST', '/feedback-forms/form_1/submit'),
    Route('integrations_handler', 'PUT', '/integrations/webscraper/credentials'),
    Route('integrations_handler', 'POST', '/integrations/app_reviews_ios/apps'),
    Route('manual_import_handler', 'POST', '/scrapers/manual/parse',
          config={'MANUAL_IMPORT_PROCESSOR_FUNCTION': 'voc-manual-import-processor'}),
    Route('manual_import_handler', 'POST', '/scrapers/manual/confirm'),
    Route('manual_import_handler', 'POST', '/scrapers/manual/csv-upload'),
    Route('manual_import_handler', 'POST', '/scrapers/manual/json-upload'),
    Route('memory_handler', 'POST', '/memory'),
    Route('memory_handler', 'PUT', '/memory/mem-1', config=_STORED_MEMORY),
    Route('memory_handler', 'POST', '/memory/merge'),
    Route('memory_handler', 'POST', '/memory/review/mem-1/resolve', config=_STORED_MEMORY),
    Route('memory_handler', 'POST', '/memory/imports',
          config={'RAW_DATA_BUCKET': 'test-raw', 'MEMORY_QUEUE_URL': 'https://sqs.example/memory-extract'}),
    Route('memory_handler', 'POST', '/memory/retrieve'),
    # A GET, but with no `statement` query parameter it reads the statement from the body.
    Route('memory_handler', 'GET', '/memory/conflict-check'),
    Route('s3_import_handler', 'POST', '/s3-import/sources', config={'S3_IMPORT_BUCKET': 'test-import'}),
    Route('s3_import_handler', 'POST', '/s3-import/upload-url', config={'S3_IMPORT_BUCKET': 'test-import'}),
    Route('settings_handler', 'PUT', '/settings/model'),
    Route('settings_handler', 'POST', '/settings/model/test'),
    Route('settings_handler', 'PUT', '/settings/resolved-problems'),
    Route('settings_handler', 'PUT', '/settings/brand'),
    Route('settings_handler', 'PUT', '/settings/categories'),
    Route('settings_handler', 'POST', '/settings/categories/generate'),
    Route('settings_handler', 'POST', '/settings/categories/reprocess',
          config={'CATEGORY_REPROCESS_FUNCTION': 'voc-category-reprocess'}),
    Route('users_handler', 'POST', '/users'),
    Route('users_handler', 'PUT', '/users/someone'),
    Route('users_handler', 'PUT', '/users/someone/group'),
    Route('users_handler', 'PUT', '/users/someone/category-access'),
    Route('projects_handler', 'POST', '/projects'),
    *(Route('projects_handler', method, f'{_P}{suffix}', project=True) for method, suffix in [
        ('PUT', ''),
        ('PUT', '/visibility'),
        ('POST', '/members'),
        ('PUT', '/members/sub-1'),
        ('POST', '/owner'),
        ('POST', '/personas'),
        ('POST', '/personas/import'),
        ('PUT', '/personas/persona-1'),
        ('POST', '/personas/persona-1/notes'),
        ('PUT', '/personas/persona-1/notes/note-1'),
        ('POST', '/personas/generate'),
        ('POST', '/research'),
        ('POST', '/documents'),
        ('PUT', '/documents/doc-1'),
        ('PUT', '/product-context'),
        ('POST', '/product-context/interview'),
        ('POST', '/product-docs/upload-url'),
        ('POST', '/prfaq-autofill'),
        ('POST', '/research/suggest-questions'),
        ('POST', '/documents/suggest-brief'),
        ('POST', '/product-report'),
    ]),
]


class _SdkRecorder:
    """Stands in for every boto3 client: records each operation, answers ``{}``."""

    def __init__(self) -> None:
        self.operations: list[str] = []

    def __call__(self, _client: object, operation_name: str, _params: object) -> dict:
        self.operations.append(operation_name)
        return {}

    def side_effects(self) -> list[str]:
        return [op for op in self.operations if not op.startswith(_READ_PREFIXES)]


@pytest.fixture
def sdk() -> Iterator[_SdkRecorder]:
    recorder = _SdkRecorder()
    with patch('botocore.client.BaseClient._make_api_call', autospec=True, side_effect=recorder):
        yield recorder


def _call(route: Route, raw_body: str, api_gateway_event: Any, lambda_context: Any) -> tuple[int, dict]:
    handler = importlib.import_module(route.module)
    event = api_gateway_event(method=route.method, path=route.path)
    event['body'] = raw_body
    with ExitStack() as stack:
        for name, value in route.config.items():
            stack.enter_context(patch.object(handler, name, value))
        if route.project:
            from handler_events_fixtures import project_meta_table
            stack.enter_context(
                patch.object(handler, 'get_projects_table', return_value=project_meta_table('proj-123')),
            )
        response = handler.lambda_handler(event, lambda_context)
    return response['statusCode'], json.loads(response['body'])


@pytest.mark.parametrize('raw_body', MALFORMED_BODIES)
@pytest.mark.parametrize('route', ROUTES, ids=Route.id)
def test_a_malformed_body_is_a_400_and_nothing_is_written(
    route, raw_body, sdk, api_gateway_event, lambda_context,
):
    status, body = _call(route, raw_body, api_gateway_event, lambda_context)

    assert status == 400, body
    assert body.get('success') is False
    assert sdk.side_effects() == []


# Routes whose own refusal of a valid-JSON non-object body predates the shared
# helper keep that wording; only the unparseable case is the helper's.
KEPT_NON_OBJECT_MESSAGES = [
    (Route('memory_handler', 'POST', '/memory'), 'Request body must be a JSON object'),
    (Route('projects_handler', 'PUT', f'{_P}/product-context', project=True), 'patch must be an object'),
    (Route('projects_handler', 'PUT', f'{_P}/visibility', project=True), 'Request body must be a JSON object'),
    (Route('feedback_form_handler', 'POST', '/feedback-forms/form_1/submit'), 'Request body must be a JSON object'),
    (Route('settings_handler', 'POST', '/settings/categories/reprocess',
           config={'CATEGORY_REPROCESS_FUNCTION': 'voc-category-reprocess'}), 'Request body must be a JSON object'),
]


@pytest.mark.parametrize(('route', 'message'), KEPT_NON_OBJECT_MESSAGES, ids=lambda v: v.id() if isinstance(v, Route) else '')
def test_a_route_keeps_its_own_non_object_message(route, message, sdk, api_gateway_event, lambda_context):
    status, body = _call(route, '["x"]', api_gateway_event, lambda_context)

    assert (status, body.get('error')) == (400, message)
    assert sdk.side_effects() == []


@pytest.mark.parametrize('route', [r for r, _ in KEPT_NON_OBJECT_MESSAGES], ids=Route.id)
def test_unparseable_json_gets_the_shared_message(route, sdk, api_gateway_event, lambda_context):
    status, body = _call(route, '{"not": json', api_gateway_event, lambda_context)

    assert (status, body.get('error')) == (400, 'the request body must be JSON')
    assert sdk.side_effects() == []


def test_the_recorder_does_see_a_write(sdk):
    """Control: the tripwire is live, so an empty `side_effects()` above means
    the route sent nothing, not that the recorder was bypassed."""
    boto3.client('sqs', region_name='us-east-1').send_message(QueueUrl='https://q', MessageBody='{}')
    assert sdk.side_effects() == ['SendMessage']
