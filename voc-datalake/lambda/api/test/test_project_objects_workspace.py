"""A project's objects per workspace (docs/multi-workspace.md, the project plan, 3e; 7.37.00).

Every key builder of a project's objects takes a keyword-only ``workspace``: the avatars (shared/avatar.py), the
prototypes (shared/prototypes.py, api/projects.py ``prototype_project_prefix``) and the product documents
(api/product_context.py ``product_doc_raw_key``, api/projects.py ``product_docs_project_prefix``). In a workspace each
key is the deployment's under ``ws/{ws}/`` (shared/ws_repo.py ``s3_prefix``, through shared/scoped_keys.py
``scoped_object_key``); without one it is exactly the deployment's key. No route passes a workspace yet; since 3f
(7.38.00) the product-doc extractor takes a workspace's upload key too (its own suite: test_workspace_uploads.py).
"""
from __future__ import annotations

from collections.abc import Iterator
from typing import Any, Final
from unittest.mock import patch

import boto3
import pytest
from moto import mock_aws

import product_context
import projects
from shared import avatar
from shared.prototypes import prototype_s3_key, prototype_signed_url
from shared.ws_repo import WorkspaceScope

A = WorkspaceScope('ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D8')
B = WorkspaceScope('ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D9')
BUCKET = 'test-raw-data-bucket'
PROJECT = 'proj_shared_id'


@pytest.fixture
def s3() -> Iterator[Any]:
    """The raw data bucket (moto), which holds every scope's avatars here."""
    with mock_aws():
        client = boto3.client('s3', region_name='us-east-1')
        client.create_bucket(Bucket=BUCKET)
        yield client


def test_the_deployments_object_keys_are_the_ones_written_before():
    assert avatar.avatar_object_key('persona_1', b'img', 'jpeg').startswith('avatars/persona_1/')
    assert 'avatars/persona_1.jpeg' in avatar.avatar_object_keys('persona_1')
    assert prototype_s3_key(PROJECT, 'doc_1') == f'prototypes/{PROJECT}/doc_1.html'
    assert product_context.product_doc_raw_key(PROJECT, 'doc_1', 'pdf') == (
        f'projects/{PROJECT}/product_docs/raw/doc_1.pdf')


def test_a_workspaces_object_keys_are_the_same_keys_under_its_prefix():
    prefix = f'ws/{A.ws}/'
    assert avatar.avatar_object_key('persona_1', b'img', 'jpeg', workspace=A) == (
        f"{prefix}{avatar.avatar_object_key('persona_1', b'img', 'jpeg')}")
    assert prototype_s3_key(PROJECT, 'doc_1', workspace=A) == f'{prefix}prototypes/{PROJECT}/doc_1.html'
    assert product_context.product_doc_raw_key(PROJECT, 'doc_1', 'pdf', workspace=A) == (
        f'{prefix}projects/{PROJECT}/product_docs/raw/doc_1.pdf')
    # A workspace has no legacy flat avatar keys (they predate it).
    assert avatar.avatar_object_keys('persona_1', workspace=A) == ()


@pytest.mark.parametrize('scope', [None, A], ids=['deployment', 'workspace'])
def test_the_sweep_prefixes_hold_the_writers_keys_in_each_scope(scope):
    assert prototype_s3_key(PROJECT, 'doc_1', workspace=scope).startswith(
        projects.prototype_project_prefix(PROJECT, workspace=scope))
    assert product_context.product_doc_raw_key(PROJECT, 'doc_1', 'pdf', workspace=scope).startswith(
        projects.product_docs_project_prefix(PROJECT, workspace=scope))
    other = B if scope is not None else A
    assert not prototype_s3_key(PROJECT, 'doc_1', workspace=other).startswith(
        projects.prototype_project_prefix(PROJECT, workspace=scope))


def test_the_extractor_reads_each_scopes_upload_key_with_its_own_pattern():
    """Since 3f (7.38.00) the extractor takes a workspace's upload key too, with a pattern of its own; the deployment's
    pattern still matches the deployment's key only. (Imported here, not at collection: the extractor reads its
    configuration when it is first imported, after its own suite's conftest has set it.)"""
    from product_doc_extractor import handler as extractor

    deployment = product_context.product_doc_raw_key(PROJECT, 'doc_1', 'md')
    workspace = product_context.product_doc_raw_key(PROJECT, 'doc_1', 'md', workspace=A)
    assert [bool(extractor.RAW_KEY_PATTERN.fullmatch(key)) for key in (deployment, workspace)] == [True, False]
    match = extractor.WORKSPACE_RAW_KEY_PATTERN.fullmatch(workspace)
    assert match is not None
    assert match.group('workspace_id', 'project_id', 'doc_id') == (A.ws, PROJECT, 'doc_1')


def test_each_scope_lists_only_its_own_avatars(s3):
    for key in ('avatars/persona_1/aa.jpeg', f'ws/{A.ws}/avatars/persona_1/bb.jpeg',
                f'ws/{B.ws}/avatars/persona_1/cc.jpeg'):
        s3.put_object(Bucket=BUCKET, Key=key, Body=b'img')
    assert avatar.persona_avatar_keys(s3, BUCKET, 'persona_1', workspace=A) == [f'ws/{A.ws}/avatars/persona_1/bb.jpeg']
    assert avatar.persona_avatar_keys(s3, BUCKET, 'persona_1')[-1] == 'avatars/persona_1/aa.jpeg'
    assert f'ws/{A.ws}/avatars/persona_1/bb.jpeg' not in avatar.persona_avatar_keys(s3, BUCKET, 'persona_1')


@pytest.mark.parametrize(('scope', 'expected'), [
    (A, f'ws/{A.ws}/avatars/persona_1/bb.jpeg'), (B, None), (None, None),
], ids=['own', 'other-workspace', 'deployment'])
def test_an_avatar_uri_is_read_in_its_own_scope_only(scope, expected):
    uri = f's3://{BUCKET}/ws/{A.ws}/avatars/persona_1/bb.jpeg'
    assert avatar.avatar_key_from_uri(uri, BUCKET, workspace=scope) == expected


CDN = 'https://cdn.example.com/avatars'


OWN_AVATAR = f'ws/{A.ws}/avatars/persona_1/bb.jpeg'


def _signing(key: str, reader, **options) -> tuple[str | None, list[str]]:
    """The URL for ``key`` and the keys that reached the workspace serving seam (``_workspace_avatar_url``)."""
    reached: list[str] = []
    with patch('shared.cloudfront_signing.sign_url', side_effect=lambda url: url), \
            patch.object(avatar, '_workspace_avatar_url', side_effect=reached.append):
        return avatar.get_avatar_cdn_url(f"s3://{options.pop('uri_bucket', BUCKET)}/{key}", CDN, workspace=reader,
                                         **options), reached


def test_a_workspace_avatar_gets_no_url_until_the_switch():
    """3h adds the serving path; until then even the reader's own avatar gives None."""
    with patch('shared.cloudfront_signing.sign_url', side_effect=lambda url: url):
        assert avatar.get_avatar_cdn_url(f's3://{BUCKET}/{OWN_AVATAR}', CDN, workspace=A, bucket=BUCKET) is None


@pytest.mark.parametrize(('key', 'reader', 'signed'), [
    ('avatars/persona_1/aa.jpeg', None, f'{CDN}/persona_1/aa.jpeg'),
    ('avatars/persona_1.jpeg', None, f'{CDN}/persona_1.jpeg'),
    (OWN_AVATAR, None, None),
], ids=['deployment', 'legacy', 'workspace-key-for-the-deployment'])
def test_the_deployments_reader_signs_its_own_keys_as_before_and_no_workspaces(key, reader, signed):
    assert _signing(key, reader, bucket=BUCKET) == (signed, [])


@pytest.mark.parametrize(('key', 'options', 'reached'), [
    (OWN_AVATAR, {'bucket': BUCKET}, [OWN_AVATAR]),
    # A persona's avatar_url is editable: only a key of the reader's own scope, in the avatars bucket, gets through.
    (f'ws/{B.ws}/avatars/persona_1/cc.jpeg', {'bucket': BUCKET}, []),
    ('avatars/persona_1/aa.jpeg', {'bucket': BUCKET}, []),
    (f'ws/{A.ws}/raw/x.json', {'bucket': BUCKET}, []),
    (OWN_AVATAR, {'bucket': BUCKET, 'uri_bucket': 'other-bucket'}, []),
    (OWN_AVATAR, {}, []),
], ids=['own', 'other-workspace', 'deployment-key', 'not-an-avatar', 'another-bucket', 'no-bucket-known'])
def test_only_the_readers_own_avatar_reaches_the_serving_seam(key, options, reached, monkeypatch):
    monkeypatch.delenv('RAW_DATA_BUCKET', raising=False)
    assert _signing(key, A, **options) == (None, reached)


#: Keys whose prefix looks right but which name another place, or carry an escape, a backslash or a query.
CLIMBING: Final = (f'ws/{A.ws}/avatars/../../{B.ws}/avatars/p/x.jpeg', f'ws/{A.ws}/avatars/./p/x.jpeg',
                   f'ws/{A.ws}/avatars//p/x.jpeg', f'ws/{A.ws}/avatars/p/', f'ws/{A.ws}/avatars/%2e%2e/p/x.jpeg',
                   f'ws/{A.ws}/avatars/p\\..\\x.jpeg', f'ws/{A.ws}/avatars/p/x.jpeg?v=1')


@pytest.mark.parametrize('key', CLIMBING, ids=['dot-dot', 'dot', 'empty', 'trailing', 'escape', 'backslash', 'query'])
def test_a_workspace_avatar_key_that_is_not_a_plain_path_is_refused(key):
    assert avatar.avatar_key_from_uri(f's3://{BUCKET}/{key}', BUCKET, workspace=A) is None
    assert _signing(key, A, bucket=BUCKET) == (None, [])


@pytest.mark.parametrize('key', ['avatars/../ws/x/avatars/p.jpeg', '/ws/x/avatars/p.jpeg', 'avatars/p/../q.jpeg',
                                 'avatars/p//q.jpeg', 'avatars/p%2Fq.jpeg', 'avatars/p\\q.jpeg', 'avatars/p.jpeg?x'],
                         ids=['climbs-to-ws', 'leading-slash', 'dot-dot', 'empty', 'escape', 'backslash', 'query'])
def test_the_deployments_reader_refuses_a_key_that_is_not_a_plain_path(key):
    assert avatar.avatar_key_from_uri(f's3://{BUCKET}/{key}', BUCKET) is None
    assert _signing(key, None, bucket=BUCKET) == (None, [])


def test_the_avatars_bucket_defaults_to_the_raw_data_bucket(monkeypatch):
    monkeypatch.setenv('RAW_DATA_BUCKET', BUCKET)
    assert _signing(OWN_AVATAR, A) == (None, [OWN_AVATAR])
    assert _signing(OWN_AVATAR, A, uri_bucket='other-bucket') == (None, [])
    assert avatar.avatar_key_from_uri(f's3://other-bucket/{OWN_AVATAR}', BUCKET, workspace=A) is None


def test_a_workspaces_prototype_is_never_signed_until_the_switch():
    with patch('shared.cloudfront_signing.sign_url', side_effect=lambda url: url):
        assert prototype_signed_url(PROJECT, 'doc_1', 'https://cdn.example.com/prototypes', workspace=A) is None
        assert prototype_signed_url(PROJECT, 'doc_1', 'https://cdn.example.com/prototypes') == (
            f'https://cdn.example.com/prototypes/{PROJECT}/doc_1.html')


def test_a_workspaces_avatar_is_stored_under_its_prefix(s3):
    with patch('shared.aws.get_s3_client', return_value=s3):
        uri = avatar._store_avatar_image(b'img', 'jpeg', 'persona_1', BUCKET, PROJECT, workspace=A)
    key = uri.removeprefix(f's3://{BUCKET}/')
    assert key.startswith(f'ws/{A.ws}/avatars/persona_1/')
    assert [entry['Key'] for entry in s3.list_objects_v2(Bucket=BUCKET)['Contents']] == [key]


def test_a_workspaces_superseded_avatars_are_its_own_only(s3):
    """A regeneration in a workspace sweeps that workspace's earlier images of the persona, never the deployment's
    or another workspace's (the same persona id, stamped by the same project)."""
    metadata = {avatar.AVATAR_OWNER_METADATA_KEY: PROJECT}
    keys = ['avatars/persona_1/aa.jpeg', f'ws/{A.ws}/avatars/persona_1/old.jpeg',
            f'ws/{A.ws}/avatars/persona_1/new.jpeg', f'ws/{B.ws}/avatars/persona_1/cc.jpeg']
    for key in keys:
        s3.put_object(Bucket=BUCKET, Key=key, Body=b'img', Metadata=metadata)
    avatar.delete_superseded_avatars(s3, BUCKET, 'persona_1', keep=keys[2], project_id=PROJECT, workspace=A)
    left = sorted(entry['Key'] for entry in s3.list_objects_v2(Bucket=BUCKET)['Contents'])
    assert left == sorted([keys[0], keys[2], keys[3]])
