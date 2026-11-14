"""shared/usage_meter.py: one `bedrock_usage` line per successful model call, counted to the right workspace.

docs/multi-workspace.md, "Cost per workspace" (slice A). The calls go through real bedrock-runtime clients made by
shared/model_config.py ``scope_bedrock_client`` (a fresh one, shared/aws.py's and the capacity probe's): botocore's
Stubber for Converse (and an InvokeModel whose answer has no token headers), a ``before-send`` answer for an
InvokeModel with its headers (the Stubber's response has none).
"""
import ast
import contextvars
import io
import threading
from collections.abc import Callable, Iterator
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import boto3
import pytest
from botocore.awsrequest import AWSResponse, HTTPHeaders
from botocore.response import StreamingBody
from botocore.stub import Stubber
from moto import mock_aws

from shared import aws, model_capacity, usage_meter
from shared.concurrency import concurrently, ordered_map
from shared.exceptions import NotFoundError
from shared.invocation_cost import measure_invocation_cost
from shared.model_config import scope_bedrock_client
from shared.request_workspace import request_workspace
from shared.test.moto_tables import create_pk_sk_table
from shared.usage_meter import DEPLOYMENT, UNATTRIBUTED, USAGE_FIELDS, attribute, current_attribution
from shared.workspace import MembershipCache, resolve_workspace
from shared.ws_repo import message_scope, scope_from_message

WS = 'ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D8'
OTHER_WS = 'ws_7ZZZZZZZZZZZZZZZZZZZZZZZZZ'
MODEL = 'global.anthropic.claude-sonnet-5-5'
EMBEDDING_MODEL = 'amazon.titan-embed-text-v2:0'
PROMPT = 'A fictional question about the Harbor Lane store'
ANSWER = 'A fictional answer about the Harbor Lane store'
LAMBDA_ROOT = Path(__file__).resolve().parents[2]
#: The only functions that may set the attribution: where a workspace resolves (shared/usage_meter.py docstring).
ATTRIBUTING_FUNCTIONS = {
    ('shared/workspace.py', 'resolve_workspace'),
    ('shared/ws_repo.py', 'message_scope'),
    ('shared/request_workspace.py', 'request_workspace'),
}


@pytest.fixture(autouse=True)
def fresh_invocation() -> Iterator[None]:
    """Each test starts as a new invocation (nothing attributed)."""
    usage_meter.reset()
    yield
    usage_meter.reset()


@pytest.fixture
def log() -> Iterator[MagicMock]:
    with patch.object(usage_meter, 'logger') as logger:
        yield logger


@pytest.fixture
def client(monkeypatch):
    monkeypatch.delenv('BEDROCK_INFERENCE_SCOPE', raising=False)
    return scope_bedrock_client(boto3.client('bedrock-runtime', region_name='us-east-1'))


def _converse_response(**extra) -> dict:
    return {'output': {'message': {'role': 'assistant', 'content': [{'text': ANSWER}]}}, 'stopReason': 'end_turn',
            'usage': {'inputTokens': 1200, 'outputTokens': 340, 'totalTokens': 1540}, 'metrics': {'latencyMs': 90},
            **extra}


def _converse(client, response: dict, **params) -> dict:
    with Stubber(client) as stub:
        stub.add_response('converse', response)
        return client.converse(modelId=MODEL, messages=[{'role': 'user', 'content': [{'text': PROMPT}]}], **params)


def _line(log: MagicMock) -> dict:
    assert log.info.call_count == 1
    assert log.info.call_args.args == ('bedrock_usage',)
    return log.info.call_args.kwargs['extra']


def _assert_no_content(line: dict) -> None:
    assert tuple(line) == USAGE_FIELDS
    for value in line.values():
        assert isinstance(value, (str, int))
        assert 'fictional' not in str(value)


def _converse_call(context: dict | None = None) -> None:
    """The hook as botocore calls it after one successful Converse."""
    usage_meter.log_usage(http_response=SimpleNamespace(status_code=200),
                          parsed={'usage': {'inputTokens': 1, 'outputTokens': 1}},
                          model=SimpleNamespace(name='Converse'),
                          context=context if context is not None else {'voc_usage_model_id': MODEL})


# ── Converse ─────────────────────────────────────────────────────────────────

def test_a_converse_call_logs_one_line_of_numbers_and_ids(client, log):
    attribute(WS)
    _converse(client, _converse_response())
    line = _line(log)
    _assert_no_content(line)
    assert line == {'workspace_id': WS, 'model_id': MODEL, 'operation': 'Converse', 'service_tier': 'default',
                    'input_tokens': 1200, 'output_tokens': 340, 'cache_read_tokens': 0, 'cache_write_tokens': 0}


@pytest.mark.parametrize('make_client', [
    aws.get_bedrock_client,
    model_capacity._bedrock_probe_client,
], ids=['shared-client', 'capacity-probe'])
def test_one_converse_on_each_production_client_logs_exactly_one_line(log, monkeypatch,
                                                                     make_client: Callable[[], object]):
    monkeypatch.setenv('AWS_DEFAULT_REGION', 'us-east-1')
    monkeypatch.delenv('BEDROCK_INFERENCE_SCOPE', raising=False)
    monkeypatch.setattr(aws, '_bedrock_client', None)
    monkeypatch.setattr(model_capacity, '_clients', {})
    attribute(WS)
    _converse(make_client(), _converse_response())
    assert _line(log)['workspace_id'] == WS


def test_the_cache_counts_and_the_tier_bedrock_answered_with_are_logged(client, log):
    usage = {'inputTokens': 10, 'outputTokens': 2, 'totalTokens': 12, 'cacheReadInputTokens': 800,
             'cacheWriteInputTokens': 50}
    _converse(client, _converse_response(usage=usage, serviceTier={'type': 'flex'}), serviceTier={'type': 'default'})
    line = _line(log)
    assert (line['cache_read_tokens'], line['cache_write_tokens'], line['service_tier']) == (800, 50, 'flex')


def test_the_tier_asked_for_stands_when_bedrock_names_none(client, log):
    _converse(client, _converse_response(), serviceTier={'type': 'flex'})
    assert _line(log)['service_tier'] == 'flex'


def test_the_model_id_is_the_one_sent_after_the_inference_scope(client, log, monkeypatch):
    monkeypatch.setenv('BEDROCK_INFERENCE_SCOPE', 'eu')
    _converse(client, _converse_response())
    assert _line(log)['model_id'] == 'eu.anthropic.claude-sonnet-5-5'


def test_a_failed_call_logs_nothing(client, log):
    with Stubber(client) as stub:
        stub.add_client_error('converse', service_error_code='ThrottlingException', http_status_code=429)
        with pytest.raises(client.exceptions.ThrottlingException):
            client.converse(modelId=MODEL, messages=[{'role': 'user', 'content': [{'text': PROMPT}]}])
    log.info.assert_not_called()
    log.warning.assert_not_called()


@pytest.mark.parametrize('operation', ['CountTokens', 'ConverseStream'])
def test_an_operation_that_is_not_metered_logs_nothing(log, operation):
    usage_meter.log_usage(http_response=SimpleNamespace(status_code=200), parsed={},
                          model=SimpleNamespace(name=operation), context={'voc_usage_model_id': MODEL})
    log.info.assert_not_called()
    log.warning.assert_not_called()


# ── InvokeModel ──────────────────────────────────────────────────────────────

def _answer_with_headers(headers: dict):
    def answer(request, **_kwargs):
        body = b'{"embedding": [0.1, 0.2]}'
        sent = HTTPHeaders()
        for name, value in {'content-type': 'application/json', **headers}.items():
            sent[name] = value
        return AWSResponse(request.url, 200, sent, io.BytesIO(body))
    return answer


@pytest.fixture
def signed(monkeypatch):
    """Credentials to sign with: a ``before-send`` answer comes after the request is signed."""
    monkeypatch.setenv('AWS_ACCESS_KEY_ID', 'testing')
    monkeypatch.setenv('AWS_SECRET_ACCESS_KEY', 'testing')


def _invoke(client, headers: dict, **params) -> None:
    client.meta.events.register('before-send.bedrock-runtime.InvokeModel', _answer_with_headers(headers))
    response = client.invoke_model(modelId=EMBEDDING_MODEL, body=b'{"inputText": "fictional"}', **params)
    assert response['body'].read()


@pytest.mark.usefixtures('signed')
def test_an_invoke_model_call_logs_its_token_headers(client, log):
    attribute(None)
    _invoke(client, {'x-amzn-bedrock-input-token-count': '42', 'x-amzn-bedrock-output-token-count': '7',
                     'x-amzn-bedrock-cache-read-input-token-count': '5'})
    line = _line(log)
    _assert_no_content(line)
    assert line == {'workspace_id': DEPLOYMENT, 'model_id': EMBEDDING_MODEL,
                    'operation': 'InvokeModel', 'service_tier': 'default', 'input_tokens': 42, 'output_tokens': 7,
                    'cache_read_tokens': 5, 'cache_write_tokens': 0}


@pytest.mark.usefixtures('signed')
@pytest.mark.parametrize(('answered', 'logged'), [({'x-amzn-bedrock-service-tier': 'default'}, 'default'), ({}, 'flex')],
                         ids=['answered-with-a-tier', 'answered-without-one'])
def test_an_invoke_model_call_sent_as_flex_logs_the_tier_answered_else_the_one_sent(client, log, answered, logged):
    _invoke(client, {'x-amzn-bedrock-input-token-count': '3', **answered}, serviceTier='flex')
    assert _line(log)['service_tier'] == logged


def test_an_invoke_model_answer_without_token_headers_is_unreadable_and_the_call_succeeds(client, log):
    with Stubber(client) as stub:
        stub.add_response('invoke_model', {'body': StreamingBody(io.BytesIO(b'{}'), 2),
                                           'contentType': 'application/json'})
        response = client.invoke_model(modelId=MODEL, body=b'{}')
    assert response['body'].read() == b'{}'
    log.info.assert_not_called()
    assert log.warning.call_args.args == ('bedrock_usage_unreadable',)
    assert log.warning.call_args.kwargs['extra'] == {'operation': 'InvokeModel',
                                                     'reason': 'no input token count header'}


# ── Malformed answers never raise ────────────────────────────────────────────

@pytest.mark.parametrize(('parsed', 'context'), [
    ({'usage': {'inputTokens': 'many', 'outputTokens': 1}}, {'voc_usage_model_id': MODEL}),
    ({'usage': {'inputTokens': -3, 'outputTokens': 1}}, {'voc_usage_model_id': MODEL}),
    ({'usage': {'inputTokens': True, 'outputTokens': 1}}, {'voc_usage_model_id': MODEL}),
    ({'usage': {'outputTokens': 1}}, {'voc_usage_model_id': MODEL}),
    (None, {'voc_usage_model_id': MODEL}),
    ({'usage': {'inputTokens': 1, 'outputTokens': 1}}, {}),
    ({'usage': {'inputTokens': 1, 'outputTokens': 1}}, None),
], ids=['text-count', 'negative', 'bool', 'no-input', 'no-response', 'no-model', 'no-context'])
def test_a_malformed_response_logs_unreadable_with_the_operation_and_does_not_raise(log, parsed, context):
    usage_meter.log_usage(http_response=SimpleNamespace(status_code=200), parsed=parsed,
                          model=SimpleNamespace(name='Converse'), context=context)
    log.info.assert_not_called()
    assert log.warning.call_args.args == ('bedrock_usage_unreadable',)
    assert log.warning.call_args.kwargs['extra']['operation'] == 'Converse'


def test_an_unexpected_error_names_its_kind_never_its_text(log):
    class Exploding(dict):
        def get(self, *_args):
            raise RuntimeError(ANSWER)
    usage_meter.log_usage(http_response=SimpleNamespace(status_code=200), parsed=Exploding(),
                          model=SimpleNamespace(name='Converse'), context={'voc_usage_model_id': MODEL})
    assert log.warning.call_args.kwargs['extra'] == {'operation': 'Converse', 'reason': 'RuntimeError'}


def test_a_usage_line_that_fails_to_log_is_reported_unreadable_never_raised(log):
    log.info.side_effect = TypeError('a field the sink cannot write')
    _converse_call()
    assert log.warning.call_args.kwargs['extra'] == {'operation': 'Converse', 'reason': 'TypeError'}


# ── Attribution ──────────────────────────────────────────────────────────────

def test_nothing_attributed_is_unattributed():
    assert contextvars.Context().run(current_attribution) == UNATTRIBUTED
    assert current_attribution() == UNATTRIBUTED


def test_none_is_the_deployment_and_a_value_that_is_not_a_workspace_id_is_unattributed():
    attribute(None)
    assert current_attribution() == DEPLOYMENT
    attribute(WS)
    assert current_attribution() == WS
    for value in (UNATTRIBUTED, 'ws_lowercase', 'DEPLOYMENT', f'WS#{WS}', ''):
        attribute(WS)
        attribute(value)
        assert current_attribution() == UNATTRIBUTED


def test_a_message_s_workspace_and_a_deployment_wide_message():
    message_scope({'workspace_id': WS})
    assert current_attribution() == WS
    assert message_scope({'records': []}) == (False, None)
    assert current_attribution() == DEPLOYMENT
    message_scope({'workspace_id': OTHER_WS})
    assert current_attribution() == OTHER_WS


def test_a_failing_record_after_a_good_one_logs_unattributed(log):
    assert message_scope({'workspace_id': WS})[1] is not None
    _converse_call()
    assert message_scope({'workspace_id': 'ws_bad'}) == (True, None)
    _converse_call()
    assert [c.kwargs['extra']['workspace_id'] for c in log.info.call_args_list] == [WS, UNATTRIBUTED]


def test_a_loop_of_scope_from_message_leaves_the_attribution_untouched():
    attribute(WS)
    scopes = [scope_from_message({'workspace_id': ws}) for ws in (OTHER_WS, OTHER_WS)]
    assert [s.ws for s in scopes] == [OTHER_WS, OTHER_WS]
    with pytest.raises(ValueError, match='not a workspace id'):
        scope_from_message({'workspace_id': 'ws_bad'})
    assert current_attribution() == WS


def test_a_request_that_names_no_workspace_is_the_deployment():
    assert request_workspace({'headers': {}}, 'Could not load') is None
    assert current_attribution() == DEPLOYMENT


def test_a_resolved_request_is_its_workspace_and_a_failed_resolve_leaves_unattributed():
    with mock_aws():
        table = create_pk_sk_table('workspaces')
        table.put_item(Item={'pk': f'WS#{WS}', 'sk': 'META', 'name': 'Acme Outfitters', 'slug': 'acme',
                             'status': 'active'})
        table.put_item(Item={'pk': f'WS#{WS}', 'sk': 'MEMBER#sub-ana', 'role': 'editor'})

        def event(ws: str) -> dict:
            return {'headers': {'X-Workspace-Id': ws},
                    'requestContext': {'authorizer': {'claims': {'sub': 'sub-ana', 'cognito:groups': 'users'}}}}

        resolve_workspace(table, event(WS), MembershipCache(), confirm_platform_admin=lambda _e: False)
        assert current_attribution() == WS
        with pytest.raises(NotFoundError):
            resolve_workspace(table, event(OTHER_WS), MembershipCache(), confirm_platform_admin=lambda _e: False)
        assert current_attribution() == UNATTRIBUTED


#: The names production may import from shared.usage_meter by name: never ``attribute`` or ``_attribution``, so
#: every attribution reads ``usage_meter.attribute(`` and the pin below sees it.
IMPORTABLE_NAMES = frozenset({'log_usage', 'remember_request', 'DEPLOYMENT', 'UNATTRIBUTED', 'USAGE_FIELDS'})


class _AttributeCalls(ast.NodeVisitor):
    """The innermost function around each ``usage_meter.attribute(…)`` call, and every way the module is reached
    that the pin could not follow (an alias, a by-name import of ``attribute``, ``_attribution``)."""

    def __init__(self) -> None:
        self.stack: list[str] = []
        self.sites: set[str] = set()
        self.unpinned: list[str] = []

    def visit_Import(self, node: ast.Import) -> None:
        self.unpinned += [f'import {a.name}' for a in node.names if a.name.startswith('shared.usage_meter')]

    def visit_ImportFrom(self, node: ast.ImportFrom) -> None:
        if node.module == 'shared':
            self.unpinned += [f'from shared import usage_meter as {a.asname}' for a in node.names
                              if a.name == 'usage_meter' and a.asname]
        elif node.module == 'shared.usage_meter':
            self.unpinned += [f'from shared.usage_meter import {a.name}' + (f' as {a.asname}' if a.asname else '')
                              for a in node.names if a.asname or a.name not in IMPORTABLE_NAMES]

    def visit_Name(self, node: ast.Name) -> None:
        if node.id == '_attribution':
            self.unpinned.append('_attribution')

    def visit_Attribute(self, node: ast.Attribute) -> None:
        if node.attr == '_attribution':
            self.unpinned.append('._attribution')
        self.generic_visit(node)

    def _function(self, node: ast.FunctionDef | ast.AsyncFunctionDef) -> None:
        self.stack.append(node.name)
        self.generic_visit(node)
        self.stack.pop()

    visit_FunctionDef = _function
    visit_AsyncFunctionDef = _function

    def visit_Call(self, node: ast.Call) -> None:
        func = node.func
        if (isinstance(func, ast.Attribute) and func.attr == 'attribute'
                and isinstance(func.value, ast.Name) and func.value.id == 'usage_meter'):
            self.sites.add(self.stack[-1] if self.stack else '<module>')
        self.generic_visit(node)


def _scan_production() -> tuple[set[tuple[str, str]], list[str]]:
    """Every production ``usage_meter.attribute(`` call, as (path under lambda/, enclosing function), and every
    reach of the module the pin cannot follow, as ``path: what``."""
    sites: set[tuple[str, str]] = set()
    unpinned: list[str] = []
    root = LAMBDA_ROOT.parent
    for path in sorted([*LAMBDA_ROOT.rglob('*.py'), *(root / 'plugins').rglob('*.py')]):
        parts = path.relative_to(root).parts
        if 'test' in parts or 'node_modules' in parts or path.name.startswith('test_') or path.name == 'usage_meter.py':
            continue
        source = path.read_text(encoding='utf-8')
        if 'usage_meter' not in source and '_attribution' not in source:
            continue
        visitor = _AttributeCalls()
        visitor.visit(ast.parse(source))
        shown = path.relative_to(LAMBDA_ROOT if path.is_relative_to(LAMBDA_ROOT) else root).as_posix()
        sites |= {(shown, name) for name in visitor.sites}
        unpinned += [f'{shown}: {what}' for what in visitor.unpinned]
    return sites, unpinned


def test_only_the_resolve_functions_set_the_attribution():
    """A task inside a raw pool, a loop over scopes or a handler of its own never sets it: each new site is a
    reviewed change to this list (and to docs/multi-workspace.md, "Cost per workspace"). No alias, by-name import of
    ``attribute`` or use of ``_attribution`` outside usage_meter.py, so no call can hide from the pin."""
    sites, unpinned = _scan_production()
    assert unpinned == []
    assert sites == ATTRIBUTING_FUNCTIONS


@pytest.mark.parametrize('source', [
    'from shared import usage_meter as meter\n',
    'import shared.usage_meter\n',
    'from shared.usage_meter import attribute\n',
    'from shared.usage_meter import log_usage as hook\n',
    'from shared.usage_meter import _attribution\n',
    'from shared import usage_meter\nusage_meter._attribution.set("ws")\n',
])
def test_the_pin_refuses_a_reach_it_cannot_follow(source):
    visitor = _AttributeCalls()
    visitor.visit(ast.parse(source))
    assert visitor.unpinned


def test_the_pin_follows_the_plain_forms():
    visitor = _AttributeCalls()
    visitor.visit(ast.parse('from shared import usage_meter\nfrom shared.usage_meter import log_usage\n'
                            'def resolve():\n    usage_meter.attribute(None)\n'))
    assert (visitor.unpinned, visitor.sites) == ([], {'resolve'})


# ── Isolation ────────────────────────────────────────────────────────────────

def _sees_then_sets(value: str) -> str:
    seen = current_attribution()
    attribute(value)
    return seen


def test_every_ordered_map_task_sees_the_caller_s_workspace_and_none_leaks():
    attribute(WS)
    assert ordered_map(_sees_then_sets, [OTHER_WS, OTHER_WS, OTHER_WS, OTHER_WS], max_workers=2) == [WS] * 4
    assert current_attribution() == WS


def test_one_ordered_map_task_inline_does_not_leak_either():
    attribute(WS)
    assert ordered_map(_sees_then_sets, [OTHER_WS]) == [WS]
    assert current_attribution() == WS


def test_concurrently_tasks_see_the_caller_s_workspace_and_none_leaks():
    attribute(WS)
    seen = concurrently(lambda: _sees_then_sets(OTHER_WS), current_attribution)
    assert seen == (WS, WS)
    assert current_attribution() == WS


def test_concurrent_tasks_each_count_their_own_calls(log):
    """Two tasks that attribute different workspaces and call Bedrock at once each get their own line."""
    barrier = threading.Barrier(2)

    def call(ws: str) -> None:
        attribute(ws)
        barrier.wait(timeout=5)
        _converse_call()

    ordered_map(call, [WS, OTHER_WS])
    assert sorted(c.kwargs['extra']['workspace_id'] for c in log.info.call_args_list) == sorted([WS, OTHER_WS])


def test_a_raw_pool_thread_starts_with_its_own_empty_context():
    attribute(WS)
    with ThreadPoolExecutor(max_workers=1) as pool:
        assert pool.submit(current_attribution).result() == UNATTRIBUTED


# ── Reset between invocations ────────────────────────────────────────────────

def test_each_invocation_starts_unattributed():
    seen: list[str] = []

    @measure_invocation_cost
    def handler(event, _context):
        seen.append(current_attribution())
        attribute(event['ws'])

    handler({'ws': WS}, None)
    handler({'ws': OTHER_WS}, None)
    assert seen == [UNATTRIBUTED, UNATTRIBUTED]
