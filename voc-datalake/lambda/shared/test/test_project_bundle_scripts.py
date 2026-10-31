"""`scripts/project-export.py` + `scripts/project-import.py`: a project between two deployments.

Two moto "deployments" (tables + bucket each) and a fake Cognito directory per target pool
(moto's Cognito backend needs a package the CI requirements do not carry). The scripts are
loaded by path because `scripts/` is not a package; `resolve` (CloudFormation outputs) is
replaced by the two fixed deployments. Ported from PR #429 by @aws-bryan, whose round-trip
tests covered the Decimal codec.
"""
import json
import sys
from collections.abc import Iterator
from decimal import Decimal
from pathlib import Path
from types import ModuleType
from typing import Any

import boto3
import pytest
from boto3.dynamodb.conditions import Key
from moto import mock_aws

from shared.document_series import series_id
from shared.document_versions import versioned_document_id
from shared.prototype_pins import pin_form_id
from shared.test.moto_tables import create_pk_sk_table
from shared.test.repo_paths import load_module_from_path, repo_root

REGION = 'us-east-1'
PID = 'proj_20260101000000_aaaa1111'
OTHER_PID = 'proj_20260101000000_bbbb2222'
PERSONAS = ('persona_20260101000000_cccc3333_1', 'persona_20260101000000_cccc3333_10')
PRD_ID = versioned_document_id(PID, 'prd', 'alloc_1')
PROTO_ID = 'prototype_20260101000000_dddd4444'
FORM_ID = pin_form_id(PROTO_ID)
SERIES = series_id(PID, 'prd', 'Checkout PRD')
SRC_API = 'https://abcdefghij.execute-api.us-east-1.amazonaws.com/v1'
TGT_API = 'https://klmnopqrst.execute-api.us-east-1.amazonaws.com/v1'
SUBMIT_URL = f'{SRC_API}/feedback-forms/{FORM_ID}/submit'
AVATAR_KEY = f'avatars/{PERSONAS[0]}/0123abcd.png'
OWNER, EDITOR, GONE = 'sub-src-owner', 'sub-src-editor', 'sub-src-gone'


class FakeCognito:
    """`list_users` with the `email = "…"` filter, over a fixed {email: (username, sub)} pool."""

    def __init__(self, users: dict[str, tuple[str, str]]) -> None:
        self.users = users

    def list_users(self, **kwargs: Any) -> dict[str, Any]:
        email = kwargs['Filter'].removeprefix('email = "').removesuffix('"')
        found = self.users.get(email)
        if found is None:
            return {'Users': []}
        return {'Users': [{'Username': found[0], 'Attributes': [{'Name': 'sub', 'Value': found[1]},
                                                                {'Name': 'email', 'Value': email}]}]}


class FakeSession:
    """A real (moto) boto3 session, except Cognito."""

    def __init__(self, cognito: FakeCognito) -> None:
        self._session: Any = boto3.session.Session(region_name=REGION)
        self.cognito = cognito

    def resource(self, name: str) -> Any:
        return self._session.resource(name)

    def client(self, name: str) -> Any:
        return self.cognito if name == 'cognito-idp' else self._session.client(name)


def _load(name: str) -> ModuleType:
    return load_module_from_path(name, repo_root() / 'scripts' / f'{name.replace("_", "-")}.py')


@pytest.fixture(scope='module')
def scripts() -> Iterator[dict[str, ModuleType]]:
    loaded = {'export': _load('project_export'), 'import': _load('project_import')}
    try:
        yield loaded
    finally:
        for name in [n for n in sys.modules if n.startswith(('project_bundle', 'project_export', 'project_import'))]:
            sys.modules.pop(name, None)


def _remap() -> Any:
    return sys.modules['project_bundle.remap']


def _seed_source(projects: Any, aggregates: Any, s3: Any) -> None:
    pk = f'PROJECT#{PID}'
    rows = [
        {'pk': pk, 'sk': 'META', 'project_id': PID, 'name': 'Example Air checkout', 'owner_sub': OWNER,
         'owner_username': 'owner-src', 'owner_email': 'owner@example.com', 'visibility': 'private',
         'created_by_agent': 'agent_x', 'persona_count': Decimal('2'),
         'members': {EDITOR: {'role': 'editor', 'email': 'editor@example.com', 'username': 'ed', 'added_by': OWNER},
                     GONE: {'role': 'viewer', 'email': 'gone@example.com', 'username': 'gone'}}},
        {'pk': pk, 'sk': f'PERSONA#{PERSONAS[0]}', 'persona_id': PERSONAS[0], 'name': 'Frequent flyer',
         'avg_sentiment': Decimal('-0.55'), 'avatar_url': f's3://src-bucket/{AVATAR_KEY}'},
        {'pk': pk, 'sk': f'PERSONA#{PERSONAS[1]}', 'persona_id': PERSONAS[1], 'name': 'Family traveller'},
        {'pk': pk, 'sk': f'PRD#{PRD_ID}', 'document_id': PRD_ID, 'document_type': 'prd', 'version': 1,
         'title': 'Checkout PRD (v1)', 'base_title': 'Checkout PRD', 'created_by': OWNER,
         'content': f'Personas: {PERSONAS[0]}, {PERSONAS[1]}.'},
        {'pk': pk, 'sk': f'PROTOTYPE#{PROTO_ID}', 'document_id': PROTO_ID, 'document_type': 'prototype',
         'source_document_id': PRD_ID, 's3_key': f'prototypes/{PID}/{PROTO_ID}.html'},
        {'pk': pk, 'sk': 'TOKEN#tok_1', 'token_hash': 'deadbeef'},
        {'pk': f'DOCUMENT_VERSIONS#PROJECT#{PID}', 'sk': 'ALLOCATION#PRD#a1', 'allocation_id': 'alloc_1',
         'document_id': PRD_ID, 'document_type': 'prd', 'document_pk': pk, 'document_sk': f'PRD#{PRD_ID}'},
        {'pk': f'DCOMMENTS#{PID}#{SERIES}', 'sk': 'C#dc_00000000000000000001abcdef', 'document_id': PRD_ID,
         'author': {'kind': 'persona', 'persona_id': PERSONAS[0]}, 'text': 'Too many steps'},
        {'pk': f'DCOMMENTS#{PID}#{SERIES}', 'sk': 'SHARE', 'share_id': 'shr_1'},
        {'pk': 'DOCSHARE#shr_1', 'sk': 'META', 'project_id': PID},
        {'pk': f'PROJECT#{OTHER_PID}', 'sk': 'META', 'project_id': OTHER_PID, 'name': 'Another'},
    ]
    for row in rows:
        projects.put_item(Item=row)
    aggregates.put_item(Item={'pk': 'FEEDBACK_FORM', 'sk': f'FORM#{FORM_ID}', 'form_id': FORM_ID,
                              'project_id': PID, 'document_id': PROTO_ID})
    aggregates.put_item(Item={'pk': f'PINS#{FORM_ID}', 'sk': 'PIN#pin_1', 'comment': 'Button is hidden'})
    s3.put_object(Bucket='src-bucket', Key=f'prototypes/{PID}/{PROTO_ID}.html', ContentType='text/html',
                  Body=f'<script>{json.dumps(SUBMIT_URL)}</script>'.encode(), Metadata={'pin-submit-url': SUBMIT_URL})
    s3.put_object(Bucket='src-bucket', Key=f'projects/{PID}/product_docs/raw/brief.pdf', Body=b'%PDF')
    s3.put_object(Bucket='src-bucket', Key=AVATAR_KEY, Body=b'png', Metadata={'project-id': PID})


@pytest.fixture
def world(scripts: dict[str, ModuleType], monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> Iterator[dict[str, Any]]:
    deployment = sys.modules['project_bundle.deployment'].Deployment
    with mock_aws():
        dynamodb = boto3.resource('dynamodb', region_name=REGION)
        s3 = boto3.client('s3', region_name=REGION)
        tables = {name: create_pk_sk_table(name, dynamodb) for name in ('src-p', 'src-a', 'tgt-p', 'tgt-a')}
        for bucket in ('src-bucket', 'tgt-bucket'):
            s3.create_bucket(Bucket=bucket)
        _seed_source(tables['src-p'], tables['src-a'], s3)
        deployments = {'src': deployment('src-p', 'src-a', 'src-bucket', 'pool-src', SRC_API),
                       'tgt': deployment('tgt-p', 'tgt-a', 'tgt-bucket', 'pool-tgt', TGT_API)}
        for module in scripts.values():
            monkeypatch.setattr(module, 'resolve', lambda _session, prefix: deployments[prefix])
        cognito = FakeCognito({'owner@example.com': ('owner-tgt', 'sub-tgt-owner'),
                               'editor@example.com': ('ed-tgt', 'sub-tgt-editor'),
                               'admin@example.com': ('admin-tgt', 'sub-tgt-admin')})
        yield {'tables': tables, 's3': s3, 'session': FakeSession(cognito), 'cognito': cognito,
               'bundle': tmp_path / 'bundle', 'scripts': scripts}


def _export(world: dict[str, Any], *projects: str) -> int:
    argv = ['--prefix', 'src', '--region', REGION, '--out', str(world['bundle'])]
    for project in projects:
        argv += ['--project', project]
    return world['scripts']['export'].main(argv, session=world['session'])


def _import(world: dict[str, Any], *extra: str) -> int:
    argv = ['--prefix', 'tgt', '--region', REGION, '--bundle', str(world['bundle']), *extra]
    return world['scripts']['import'].main(argv, session=world['session'])


def _rows(table: Any) -> list[dict[str, Any]]:
    return table.scan()['Items']


def _partition(table: Any, pk: str) -> list[dict[str, Any]]:
    return table.query(KeyConditionExpression=Key('pk').eq(pk))['Items']


def _target_keys(world: dict[str, Any]) -> list[str]:
    return [o['Key'] for o in world['s3'].list_objects_v2(Bucket='tgt-bucket').get('Contents', [])]


class TestRoundTrip:
    def test_export_writes_a_versioned_bundle_without_credentials(self, world):
        assert _export(world, PID) == 0
        manifest = json.loads((world['bundle'] / 'manifest.json').read_text())
        assert (manifest['format'], manifest['version']) == ('voc-project-bundle', 1)
        assert manifest['source']['bucket'] == 'src-bucket'
        assert manifest['projects'][0]['skipped_credentials'] == 2  # the TOKEN# row and the SHARE index
        exported = (world['bundle'] / 'items.jsonl').read_text()
        assert 'token_hash' not in exported
        assert 'DOCSHARE#' not in exported
        assert OTHER_PID not in exported

    def test_import_carries_every_row_type_and_object_with_subs_and_bucket_remapped(self, world):
        _export(world, PID)
        assert _import(world) == 0
        projects = world['tables']['tgt-p']
        meta = projects.get_item(Key={'pk': f'PROJECT#{PID}', 'sk': 'META'})['Item']
        assert (meta['owner_sub'], meta['owner_username'], meta['owner_email']) == (
            'sub-tgt-owner', 'owner-tgt', 'owner@example.com')
        assert set(meta['members']) == {'sub-tgt-editor'}  # gone@ is not in the target pool
        assert meta['members']['sub-tgt-editor']['added_by'] == 'sub-tgt-owner'
        assert 'created_by_agent' not in meta
        persona = projects.get_item(Key={'pk': f'PROJECT#{PID}', 'sk': f'PERSONA#{PERSONAS[0]}'})['Item']
        assert persona['avatar_url'] == f's3://tgt-bucket/{AVATAR_KEY}'
        assert persona['avg_sentiment'] == Decimal('-0.55')
        prd = projects.get_item(Key={'pk': f'PROJECT#{PID}', 'sk': f'PRD#{PRD_ID}'})['Item']
        assert prd['created_by'] == 'sub-tgt-owner'
        assert len(_partition(projects, f'DOCUMENT_VERSIONS#PROJECT#{PID}')) == 1
        assert [r['sk'] for r in _partition(projects, f'DCOMMENTS#{PID}#{SERIES}')] == [
            'C#dc_00000000000000000001abcdef']
        assert {r['pk'] for r in _rows(world['tables']['tgt-a'])} == {'FEEDBACK_FORM', f'PINS#{FORM_ID}'}
        assert sorted(_target_keys(world)) == sorted(
            [AVATAR_KEY, f'prototypes/{PID}/{PROTO_ID}.html', f'projects/{PID}/product_docs/raw/brief.pdf'])

    def test_the_prototype_pin_url_points_at_the_target_api(self, world):
        _export(world, PID)
        _import(world)
        got = world['s3'].get_object(Bucket='tgt-bucket', Key=f'prototypes/{PID}/{PROTO_ID}.html')
        assert got['Metadata']['pin-submit-url'] == f'{TGT_API}/feedback-forms/{FORM_ID}/submit'
        assert got['ContentType'] == 'text/html'
        assert TGT_API in got['Body'].read().decode()

    def test_dry_run_writes_nothing(self, world, capsys):
        _export(world, PID)
        assert _import(world, '--dry-run') == 0
        assert _rows(world['tables']['tgt-p']) == []
        assert _target_keys(world) == []
        out = capsys.readouterr().out
        assert 'member gone@example.com is not in the target pool' in out
        assert 'dry run' in out


class TestRefusals:
    def test_an_owner_the_target_pool_does_not_know_is_refused(self, world, capsys):
        del world['cognito'].users['owner@example.com']
        _export(world, PID)
        assert _import(world) == 2
        assert 'pass --owner-email' in capsys.readouterr().out
        assert _rows(world['tables']['tgt-p']) == []

    def test_owner_email_is_the_fallback(self, world):
        del world['cognito'].users['owner@example.com']
        _export(world, PID)
        assert _import(world, '--owner-email', 'admin@example.com') == 0
        meta = world['tables']['tgt-p'].get_item(Key={'pk': f'PROJECT#{PID}', 'sk': 'META'})['Item']
        assert meta['owner_sub'] == 'sub-tgt-admin'

    def test_an_unknown_owner_email_is_refused(self, world, capsys):
        del world['cognito'].users['owner@example.com']
        _export(world, PID)
        assert _import(world, '--owner-email', 'nobody@example.com') == 2
        assert 'matches no single user' in capsys.readouterr().out

    def test_an_existing_project_id_is_refused_without_new_ids(self, world, capsys):
        world['tables']['tgt-p'].put_item(Item={'pk': f'PROJECT#{PID}', 'sk': 'META', 'status': 'deleted'})
        _export(world, PID)
        assert _import(world) == 2
        assert 'already exists on the target' in capsys.readouterr().out
        assert len(_rows(world['tables']['tgt-p'])) == 1

    def test_export_refuses_a_missing_or_deleted_project(self, world, capsys):
        world['tables']['src-p'].put_item(Item={'pk': f'PROJECT#{OTHER_PID}', 'sk': 'META', 'status': 'deleted'})
        assert _export(world, OTHER_PID) == 2
        assert 'tombstone' in capsys.readouterr().err

    def test_a_newer_bundle_version_and_an_escaping_object_key_are_refused(self, world, capsys):
        _export(world, PID)
        manifest_path = world['bundle'] / 'manifest.json'
        manifest = json.loads(manifest_path.read_text())
        manifest_path.write_text(json.dumps({**manifest, 'version': 2}))
        assert _import(world) == 2
        manifest_path.write_text(json.dumps(manifest))
        objects = world['bundle'] / 'objects.jsonl'
        objects.write_text(objects.read_text() + json.dumps({'project_id': PID, 'key': '../../etc/passwd'}) + '\n')
        assert _import(world) == 2
        assert 'leaves the bundle directory' in capsys.readouterr().err


class TestNewIds:
    def test_every_reference_is_rewritten_consistently(self, world):
        world['tables']['tgt-p'].put_item(Item={'pk': f'PROJECT#{PID}', 'sk': 'META', 'name': 'Taken'})
        _export(world, PID)
        assert _import(world, '--new-ids') == 0
        rows = [r for r in _rows(world['tables']['tgt-p']) if r.get('name') != 'Taken']
        new_pid = next(r['project_id'] for r in rows if r['sk'] == 'META')
        assert new_pid != PID
        dumped = json.dumps(rows, default=str) + json.dumps(_rows(world['tables']['tgt-a']), default=str)
        for old in (PID, *PERSONAS, PRD_ID, PROTO_ID, FORM_ID, SERIES):
            assert old not in dumped, old
        prd = next(r for r in rows if r['sk'].startswith('PRD#'))
        assert prd['document_id'] == versioned_document_id(new_pid, 'prd', 'alloc_1')
        assert any(r['pk'] == f'DCOMMENTS#{new_pid}#{series_id(new_pid, "prd", "Checkout PRD")}' for r in rows)
        proto = next(r for r in rows if r['sk'].startswith('PROTOTYPE#'))
        assert proto['source_document_id'] == prd['document_id']
        form = world['tables']['tgt-a'].get_item(Key={'pk': 'FEEDBACK_FORM', 'sk': f'FORM#{pin_form_id(proto["document_id"])}'})
        assert form['Item']['project_id'] == new_pid
        avatar = next(k for k in _target_keys(world) if k.startswith('avatars/'))
        assert world['s3'].head_object(Bucket='tgt-bucket', Key=avatar)['Metadata']['project-id'] == new_pid


@pytest.mark.usefixtures('scripts')
class TestPieces:
    def test_decimals_survive_exactly_and_floats_become_decimals(self):
        codec = sys.modules['project_bundle.codec']
        item = {'score': Decimal('0.333333'), 'count': Decimal('3'), 'nested': [Decimal('2.5'), {'x': {'a'}}]}
        assert codec.decode(json.loads(json.dumps(codec.encode(item)))) == item
        assert codec.decode(1.5) == Decimal('1.5')

    def test_ids_are_rewritten_as_whole_tokens_only(self):
        rewrite = _remap().Rewriter({'persona_x_1': 'persona_y_1', '': 'ignored'})
        assert rewrite.text('persona_x_1 persona_x_10 avatars/persona_x_1/a.png') == (
            'persona_y_1 persona_x_10 avatars/persona_y_1/a.png')
        assert rewrite.value({'persona_x_1': ['persona_x_1'], 'n': 1}) == {'persona_y_1': ['persona_y_1'], 'n': 1}

    def test_a_legacy_assignment_key_follows_its_source_document(self):
        fixed = _remap().fix_legacy_assignment({'sk': 'LEGACY_ASSIGNMENT#PRD#abc#old', 'source_document_sk': 'PRD#d2'})
        assert fixed['sk'].startswith('LEGACY_ASSIGNMENT#PRD#abc#')
        assert not fixed['sk'].endswith('#old')
