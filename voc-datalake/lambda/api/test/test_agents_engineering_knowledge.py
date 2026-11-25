"""The knowledge flows' routes (7.52.00, shared/agents_engineering_knowledge_routes.py through api/agents_handler.py):
the knowledge pack and its approval with the docs it renders, the tenets and their acceptance, the docs' preview and
their pull request through voc-engineering-start. Administrators acting for themselves only; 404 while the module is
off; on moto, the start function a fake."""
from __future__ import annotations

import io
import json
from collections.abc import Iterator
from dataclasses import dataclass, field
from typing import Any
from unittest.mock import patch

import boto3
import pytest
from agents_handler_fixtures import USER
from agents_handler_fixtures import api as _api
from agents_handler_fixtures import call as _call

from engineering.board.test.table import TABLE, create_table
from engineering.knowledge.notes import Note
from engineering.knowledge.reduce import reduce_package
from engineering.knowledge.store import Actor, PackStore
from engineering.knowledge.tenets import TenetsStore
from engineering.workspace.store import WorkspaceStore
from shared import agents_engineering_knowledge_routes as routes
from shared.ai_mode import ai_mode_key
from shared.engineering_agent_runs import connection_key
from shared.test.agents_fixtures import AgentsEnv

CONN = 'conn-harbor'
BUCKET = 'test-eng-workspace'
SHA = 'a' * 40
AGENT = Actor('understander-0', 'agent')
DELEGATED_ADMIN = {'sub': 'mcp:tok_1', 'cognito:username': 'alice', 'voc:acting_subject': 'admin-sub',
                   'cognito:groups': 'admins'}
TENETS = {'tenets': [{'id': 'T1', 'title': 'Fail closed', 'statement': 'An unknown state refuses.'}]}


@dataclass
class StartClient:
    """voc-engineering-start as the API invokes it: each request kept, ``answer`` given back."""

    answer: Any = None
    error: str = ''
    asked: list[dict[str, Any]] = field(default_factory=list)

    def invoke(self, **request: Any) -> dict[str, Any]:
        self.asked.append(json.loads(request['Payload']))
        response: dict[str, Any] = {'Payload': io.BytesIO(json.dumps(self.answer).encode())}
        if self.error:
            response['FunctionError'] = 'Unhandled'
        return response


@dataclass
class World:
    env: AgentsEnv
    client: Any
    packs: PackStore
    tenets: TenetsStore
    start: StartClient


@pytest.fixture
def world(monkeypatch: pytest.MonkeyPatch) -> Iterator[World]:
    with _api() as env:
        client = create_table()
        s3 = boto3.client('s3', region_name='us-east-1')
        s3.create_bucket(Bucket=BUCKET)
        for name, value in (('ENGINEERING_AGENTS', 'on'), ('ENGINEERING_TABLE', TABLE),
                            ('ENGINEERING_WORKSPACE_BUCKET', BUCKET), ('ENGINEERING_START_FUNCTION', 'voc-start')):
            monkeypatch.setenv(name, value)
        start = StartClient()
        monkeypatch.setattr(routes, '_start_client', lambda: start)
        with patch('shared.aws.get_dynamodb_client', return_value=client), \
                patch('shared.aws.get_s3_client', return_value=s3), \
                patch('shared.tables.get_aggregates_table', return_value=env.aggregates):
            yield World(env, client, PackStore(client, TABLE, WorkspaceStore(s3, BUCKET)), TenetsStore(client, TABLE),
                        start)


def _draft_pack(world: World, claim: str = 'Two spaces.') -> None:
    pack = reduce_package('.', [Note('convention', '.', claim, (SHA,), 'indent')])
    world.packs.publish('default', CONN, pack, author=AGENT, reason='refresh', built_from=SHA)


def _connection(world: World) -> None:
    world.env.agents.put_item(Item={**connection_key(CONN), 'repository': 'example-org/harbor',
                                    'default_branch': 'main'})


def _mode(world: World, mode: str) -> None:
    world.env.aggregates.put_item(Item={**ai_mode_key('admin-sub'), 'mode': mode})


ROUTES = [('GET', f'/agents/engineering/knowledge/{CONN}'),
          ('GET', f'/agents/engineering/knowledge/{CONN}/=2E/versions/1'),
          ('POST', f'/agents/engineering/knowledge/{CONN}/=2E/versions/1/approve'),
          ('GET', f'/agents/engineering/tenets/{CONN}'),
          ('GET', f'/agents/engineering/tenets/{CONN}/versions/1'),
          ('POST', f'/agents/engineering/tenets/{CONN}/versions/1/accept'),
          ('POST', f'/agents/engineering/tenets/{CONN}/versions/1/reject'),
          ('GET', f'/agents/engineering/docs/{CONN}/preview'),
          ('POST', f'/agents/engineering/docs/{CONN}/publish')]


@pytest.mark.parametrize(('method', 'path'), ROUTES)
def test_administrators_only_acting_for_themselves(lambda_context: Any, world: World, method: str,
                                                   path: str) -> None:
    del world
    assert _call(lambda_context, method, path, claims=USER)[0] == 403
    assert _call(lambda_context, method, path, claims=DELEGATED_ADMIN)[0] == 403


@pytest.mark.parametrize(('method', 'path'), ROUTES)
def test_404_while_the_module_is_off(lambda_context: Any, monkeypatch: pytest.MonkeyPatch, method: str,
                                     path: str) -> None:
    with _api():
        monkeypatch.delenv('ENGINEERING_AGENTS', raising=False)
        assert _call(lambda_context, method, path)[0] == 404


def test_an_approval_records_the_docs_and_the_preview_renders_them_again(lambda_context: Any, world: World) -> None:
    _draft_pack(world)
    status, overview = _call(lambda_context, 'GET', f'/agents/engineering/knowledge/{CONN}')
    assert (status, overview['rendering']) == (200, None)
    (root,) = overview['packages']
    assert (root['package'], root['segment'], root['approved_version'], root['versions'][0]['status']) == (
        '.', '=2E', None, 'draft')
    status, version = _call(lambda_context, 'GET', f'/agents/engineering/knowledge/{CONN}/%3D2E/versions/1')
    assert status == 200
    assert 'Two spaces.' in version['documents']['convention']
    assert _call(lambda_context, 'GET', f'/agents/engineering/docs/{CONN}/preview', query={'kind': 'knowledge'})[0] \
        == 404
    status, approved = _call(lambda_context, 'POST', f'/agents/engineering/knowledge/{CONN}/=2E/versions/1/approve',
                             body={})
    assert status == 200
    assert approved['version']['status'] == 'approved'
    assert approved['version']['approved_by'] == 'admin-sub'
    assert approved['rendering_digest'] == approved['rendering']['digest']
    assert approved['rendering']['version'] == 1
    status, preview = _call(lambda_context, 'GET', f'/agents/engineering/docs/{CONN}/preview',
                            query={'kind': 'knowledge'})
    assert status == 200
    assert (preview['digest'], preview['approved_digest'], preview['matches']) == (
        approved['rendering_digest'], approved['rendering_digest'], True)
    assert preview['branch'] == 'voc-agent/docs-knowledge-v1'
    assert [f['path'] for f in preview['files']] == ['docs/agents/index.md', 'docs/agents/repository.md']
    assert 'new file mode 100644' in preview['patch']
    assert preview['patch_truncated'] is False
    again = _call(lambda_context, 'GET', f'/agents/engineering/knowledge/{CONN}')[1]
    assert again['packages'][0]['approved_version'] == 1
    assert again['rendering']['digest'] == approved['rendering_digest']


def test_unknown_versions_packages_and_kinds(lambda_context: Any, world: World) -> None:
    del world
    assert _call(lambda_context, 'GET', f'/agents/engineering/knowledge/{CONN}/=2E/versions/9')[0] == 404
    assert _call(lambda_context, 'GET', f'/agents/engineering/knowledge/{CONN}/_x/versions/1')[0] == 404
    assert _call(lambda_context, 'GET', f'/agents/engineering/knowledge/{CONN}/=2E/versions/0')[0] == 404
    assert _call(lambda_context, 'GET', f'/agents/engineering/docs/{CONN}/preview', query={'kind': 'code'})[0] == 400
    assert _call(lambda_context, 'POST', f'/agents/engineering/knowledge/{CONN}/=2E/versions/1/approve',
                 body={'force': True})[0] == 400


def test_the_tenets_are_accepted_or_rejected_with_who_and_when(lambda_context: Any, world: World) -> None:
    world.tenets.draft('default', CONN, TENETS, author=AGENT, run_id='01JD3R4NZXQ7Y2W8K4M6P9T0AB')
    world.tenets.draft('default', CONN, TENETS, author=AGENT, run_id='01JD3R4NZXQ7Y2W8K4M6P9T0AC')
    status, listed = _call(lambda_context, 'GET', f'/agents/engineering/tenets/{CONN}')
    assert (status, [v['version'] for v in listed['versions']], listed['head']['accepted_version']) == (
        200, [2, 1], None)
    assert 'record' not in listed['versions'][0]
    # (7.52.00's integration: the accepted version the screen showed; another one is 409 and nothing is decided)
    stale = _call(lambda_context, 'POST', f'/agents/engineering/tenets/{CONN}/versions/2/accept',
                  body={'expected_accepted': 1})
    assert (stale[0], 'read it again' in stale[1]['error']) == (409, True)
    assert _call(lambda_context, 'POST', f'/agents/engineering/tenets/{CONN}/versions/2/accept', body={})[0] == 400
    status, accepted = _call(lambda_context, 'POST', f'/agents/engineering/tenets/{CONN}/versions/2/accept',
                             body={'reason': 'Reads true.', 'expected_accepted': 0})
    assert status == 200
    assert (accepted['version']['status'], accepted['version']['current'], accepted['version']['decided_by']) == (
        'accepted', True, 'admin-sub')
    assert [event['event'] for event in accepted['log']] == ['accepted', 'drafted']
    assert _call(lambda_context, 'POST', f'/agents/engineering/tenets/{CONN}/versions/1/reject',
                 body={'expected_accepted': 0})[0] == 409   # (v2 is accepted now)
    status, rejected = _call(lambda_context, 'POST', f'/agents/engineering/tenets/{CONN}/versions/1/reject',
                             body={'expected_accepted': 2})
    assert (status, rejected['version']['status']) == (200, 'rejected')
    assert _call(lambda_context, 'POST', f'/agents/engineering/tenets/{CONN}/versions/1/accept',
                 body={'expected_accepted': 2})[0] == 409
    status, preview = _call(lambda_context, 'GET', f'/agents/engineering/docs/{CONN}/preview',
                            query={'kind': 'tenets'})
    assert (status, [f['path'] for f in preview['files']], preview['digest']) == (
        200, ['TENETS.md'], accepted['version']['rendering_digest'])
    # (each file's text beside the one patch, 7.52.00's integration)
    assert (preview['files'][0]['text'].startswith('# '), preview['texts_truncated']) == (True, False)
    assert preview['files'][0]['bytes'] == len(preview['files'][0]['text'].encode())
    assert _call(lambda_context, 'GET', f'/agents/engineering/tenets/{CONN}/versions/2')[1]['version']['record'][
        'tenets'][0]['id'] == 'T1'
    assert _call(lambda_context, 'POST', f'/agents/engineering/tenets/{CONN}/versions/2/accept',
                 body={'reason': 'x' * 501, 'expected_accepted': 2})[0] == 400


def _approve(lambda_context: Any, world: World) -> str:
    _draft_pack(world)
    _connection(world)
    return _call(lambda_context, 'POST', f'/agents/engineering/knowledge/{CONN}/=2E/versions/1/approve',
                 body={})[1]['rendering_digest']


PR = {'number': 12, 'url': 'https://github.com/example-org/harbor/pull/12', 'branch': 'voc-agent/docs-knowledge-v1'}


def test_human_driven_gets_409_and_the_patch_never_a_start(lambda_context: Any, world: World) -> None:
    digest = _approve(lambda_context, world)
    for mode in (None, 'human_driven'):
        if mode:
            _mode(world, mode)
        status, body = _call(lambda_context, 'POST', f'/agents/engineering/docs/{CONN}/publish',
                             body={'kind': 'knowledge', 'digest': digest})
        assert (status, body['code']) == (409, 'human_driven')
        assert f'/agents/engineering/docs/{CONN}/preview?kind=knowledge' in body['error']
    assert world.start.asked == []


def test_a_publish_asks_the_start_and_answers_its_pull_request(lambda_context: Any, world: World) -> None:
    digest = _approve(lambda_context, world)
    _mode(world, 'ai_driven')
    world.start.answer = {'status': 'opened', 'pr': PR, 'kind': 'knowledge', 'version': 1, 'digest': digest,
                          'draft': False}
    status, body = _call(lambda_context, 'POST', f'/agents/engineering/docs/{CONN}/publish',
                         body={'kind': 'knowledge', 'digest': digest})
    assert (status, body) == (202, {'pr': PR, 'kind': 'knowledge', 'version': 1, 'digest': digest, 'draft': False})
    assert world.start.asked == [{'action': 'publish_docs', 'connection': CONN, 'repository': 'example-org/harbor',
                                  'default_branch': 'main', 'kind': 'knowledge', 'digest': digest, 'draft': False,
                                  'actor': 'admin-sub'}]
    _call(lambda_context, 'POST', f'/agents/engineering/docs/{CONN}/publish',
          body={'kind': 'knowledge', 'digest': digest, 'pr': 'draft'})
    assert world.start.asked[-1]['draft'] is True


@pytest.mark.parametrize(('answer', 'status', 'code'), [
    ({'status': 'repeated', 'pr': PR, 'version': 1, 'draft': False}, 409, 'already_published'),
    ({'status': 'refused', 'http_status': 409, 'reason': 'Not the approval\'s.', 'code': 'digest_mismatch'}, 409,
     'digest_mismatch'),
    ({'status': 'refused', 'http_status': 422, 'reason': 'Not a docs path.', 'code': ''}, 409, 'refused'),
    ({'status': 'refused', 'http_status': 503, 'reason': 'Busy.', 'code': ''}, 503, None),
])
def test_the_starts_other_answers(lambda_context: Any, world: World, answer: dict[str, Any], status: int,
                                  code: str | None) -> None:
    digest = _approve(lambda_context, world)
    _mode(world, 'ai_assisted')
    world.start.answer = answer
    found, body = _call(lambda_context, 'POST', f'/agents/engineering/docs/{CONN}/publish',
                        body={'kind': 'knowledge', 'digest': digest})
    assert (found, body.get('code')) == (status, code)
    if code == 'already_published':
        assert body['pr'] == PR


def test_a_start_refusal_or_failure(lambda_context: Any, world: World) -> None:
    digest = _approve(lambda_context, world)
    _mode(world, 'ai_driven')
    world.start.answer, world.start.error = {'errorType': 'RuntimeRefused', 'errorMessage': 'no such kind'}, 'x'
    assert _call(lambda_context, 'POST', f'/agents/engineering/docs/{CONN}/publish',
                 body={'kind': 'knowledge', 'digest': digest})[0] == 409
    world.start.answer = {'errorType': 'DocsUnavailable', 'errorMessage': 'lost'}
    assert _call(lambda_context, 'POST', f'/agents/engineering/docs/{CONN}/publish',
                 body={'kind': 'knowledge', 'digest': digest})[0] == 503


@pytest.mark.parametrize('body', [{}, {'kind': 'knowledge'}, {'kind': 'code', 'digest': 'a' * 64},
                                  {'kind': 'knowledge', 'digest': 'abc'},
                                  {'kind': 'knowledge', 'digest': 'a' * 64, 'pr': 'merged'},
                                  {'kind': 'knowledge', 'digest': 'a' * 64, 'paths': ['README.md']}])
def test_400_for_a_body_that_is_not_a_publish(lambda_context: Any, world: World, body: dict[str, Any]) -> None:
    _connection(world)
    assert _call(lambda_context, 'POST', f'/agents/engineering/docs/{CONN}/publish', body=body)[0] == 400


def test_a_publish_for_a_connection_not_stored_is_404(lambda_context: Any, world: World) -> None:
    del world
    assert _call(lambda_context, 'POST', '/agents/engineering/docs/conn-other/publish',
                 body={'kind': 'tenets', 'digest': 'a' * 64})[0] == 404


def test_each_kind_follows_its_flows_pr_setting() -> None:
    assert (routes.flow_pr('knowledge'), routes.flow_pr('tenets')) == ('ready', 'ready')
