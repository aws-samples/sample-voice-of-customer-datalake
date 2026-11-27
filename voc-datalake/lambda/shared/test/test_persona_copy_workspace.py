"""Persona copy and the company-persona promote per workspace (docs/multi-workspace.md, the project plan, 3d;
7.31.00), on moto DynamoDB and S3: three scopes (the deployment and two workspaces) hold the same project ids,
persona ids and avatar names. A copy stays inside one scope, its rows that scope's keys and its avatar under that
scope's object prefix (``avatars/…``, ``ws/{ws}/avatars/…``); a copy naming two scopes is refused before any read.
"""
from __future__ import annotations

import os
from collections.abc import Iterator
from datetime import UTC, datetime
from typing import Any
from unittest.mock import patch

import boto3
import pytest
from moto import mock_aws

from shared import company_personas_routes, persona_copy, persona_copy_routes
from shared.company_personas import COMPANY_PERSONAS_CONTAINER, ensure_company_personas_meta
from shared.exceptions import AuthorizationError
from shared.project_access import Caller
from shared.project_keys import NotPerWorkspaceError, project_pk
from shared.test.moto_tables import create_pk_sk_table
from shared.ws_repo import OutOfScopeError, WorkspaceScope, s3_prefix

BUCKET = 'raw-bucket'
NOW = datetime(2026, 11, 15, 9, 30, tzinfo=UTC)
A = WorkspaceScope('ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D8')
B = WorkspaceScope('ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D9')
SCOPES = (None, A, B)


def _avatars(scope: WorkspaceScope | None) -> str:
    return 'avatars/' if scope is None else f'{s3_prefix(scope)}avatars/'


@pytest.fixture
def world() -> Iterator[tuple[Any, Any]]:
    """In each scope: projects p1 and p2, and p1's persona ``persona_src`` with its avatar in the scope's prefix."""
    with mock_aws():
        table = create_pk_sk_table('projects')
        s3 = boto3.client('s3', region_name='us-east-1')
        s3.create_bucket(Bucket=BUCKET)
        for scope in SCOPES:
            for project_id in ('p1', 'p2'):
                table.put_item(Item={'pk': project_pk(project_id, workspace=scope), 'sk': 'META',
                                     'project_id': project_id, 'name': f'Project {project_id}', 'persona_count': 1})
            key = f'{_avatars(scope)}persona_src/abc123.png'
            s3.put_object(Bucket=BUCKET, Key=key, Body=b'png', ContentType='image/png')
            table.put_item(Item={'pk': project_pk('p1', workspace=scope), 'sk': 'PERSONA#persona_src',
                                 'persona_id': 'persona_src', 'name': 'Budget Traveller',
                                 'avatar_url': f's3://{BUCKET}/{key}'})
        yield table, s3


def _copy(table: Any, s3: Any, scope: WorkspaceScope | None, source_scope: WorkspaceScope | None,
          target: str = 'p2') -> list[dict]:
    return persona_copy.copy_personas(
        table, s3, BUCKET, source_container='p1', source_scope='project', source_project_name='Project p1',
        persona_ids=['persona_src'], target_container=target, copied_by='admin-sub', now=NOW, workspace=scope,
        source_workspace=source_scope)


def _snapshot(table: Any, s3: Any) -> tuple[list, set]:
    rows = sorted(table.scan()['Items'], key=str)
    return rows, {obj['Key'] for obj in s3.list_objects_v2(Bucket=BUCKET).get('Contents', [])}


@pytest.mark.parametrize('scope', SCOPES)
def test_a_copy_stays_in_its_scope_with_its_avatar_under_the_scopes_prefix(world, scope):
    table, s3 = world
    rows_before, keys_before = _snapshot(table, s3)
    [copy] = _copy(table, s3, scope, scope)
    assert (copy['pk'], copy['gsi1pk']) == (project_pk('p2', workspace=scope),
                                            f'{project_pk("p2", workspace=scope)}#PERSONAS')
    new_key = f"{_avatars(scope)}{copy['persona_id']}/abc123.png"
    assert copy['avatar_url'] == f's3://{BUCKET}/{new_key}'
    rows_after, keys_after = _snapshot(table, s3)
    # Only the scope's own target partition changed (the copy and its count), and one object was added.
    partition = project_pk('p2', workspace=scope)
    assert ([row for row in rows_after if row['pk'] != partition], keys_after - keys_before) == (
        [row for row in rows_before if row['pk'] != partition], {new_key})


@pytest.mark.parametrize(('scope', 'source_scope'), [(A, B), (A, None), (None, A)])
def test_a_copy_across_scopes_is_refused_before_any_read(world, scope, source_scope):
    table, s3 = world
    before = _snapshot(table, s3)
    with pytest.raises(OutOfScopeError, match='within one workspace'):
        _copy(table, s3, scope, source_scope)
    assert _snapshot(table, s3) == before


def test_a_workspace_source_whose_avatar_is_elsewhere_is_copied_without_one(world):
    table, s3 = world
    table.update_item(Key={'pk': project_pk('p1', workspace=A), 'sk': 'PERSONA#persona_src'},
                      UpdateExpression='SET avatar_url = :u',
                      ExpressionAttributeValues={':u': f's3://{BUCKET}/avatars/persona_src/abc123.png'})
    [copy] = _copy(table, s3, A, A)
    assert copy['avatar_url'] is None


@pytest.mark.parametrize('caller', [Caller(subject='user-sub'), Caller(subject='admin-sub', is_admin=True,
                                                                       delegated=True)])
def test_the_promote_refuses_anyone_but_an_admin_acting_for_themselves_before_any_read(world, caller):
    table, s3 = world
    before = _snapshot(table, s3)
    with patch.object(persona_copy_routes, '_caller', return_value=caller), \
            patch.object(company_personas_routes, 'get_projects_table') as projects, \
            pytest.raises(AuthorizationError, match='Admin access required'):
        persona_copy_routes.promote('p1', 'persona_src', workspace=None)
    assert (projects.mock_calls, _snapshot(table, s3)) == ([], before)


@pytest.mark.parametrize('scope', [A, B])
def test_the_promote_refuses_a_workspace_before_any_read(world, scope):
    """The deployment's admin decides the promote; a workspace's admin role is not decided by any helper yet."""
    table, s3 = world
    before = _snapshot(table, s3)
    with patch.object(persona_copy_routes, '_caller', return_value=Caller(subject='admin-sub', is_admin=True)), \
            patch.object(company_personas_routes, 'get_projects_table') as projects, \
            pytest.raises(NotPerWorkspaceError, match='Project gate'):
        persona_copy_routes.promote('p1', 'persona_src', workspace=scope)
    assert (projects.mock_calls, _snapshot(table, s3)) == ([], before)


def test_the_promote_copies_into_the_deployments_library(world):
    table, s3 = world
    caller = Caller(subject='admin-sub', is_admin=True)
    with patch.object(company_personas_routes, 'get_projects_table', return_value=table), \
            patch.object(persona_copy_routes, 'get_s3_client', return_value=s3), \
            patch.object(persona_copy_routes, '_caller', return_value=caller), \
            patch.dict(os.environ, {'RAW_DATA_BUCKET': BUCKET}):
        [copy] = persona_copy_routes.promote('p1', 'persona_src', workspace=None)
    _assert_in_its_library(table, copy, None)


@pytest.mark.parametrize('scope', [A, B])
def test_a_library_copy_in_a_workspace_stays_in_its_library(world, scope):
    """What the promote will write once a workspace's admin decides it: the workspace's own library, its avatar
    under the workspace's prefix."""
    table, s3 = world
    ensure_company_personas_meta(table, workspace=scope)
    [copy] = _copy(table, s3, scope, scope, target=COMPANY_PERSONAS_CONTAINER)
    _assert_in_its_library(table, copy, scope)


def _assert_in_its_library(table: Any, copy: dict, scope: WorkspaceScope | None) -> None:
    library = project_pk(COMPANY_PERSONAS_CONTAINER, workspace=scope)
    assert copy['pk'] == library
    assert table.get_item(Key={'pk': library, 'sk': 'META'})['Item']['persona_count'] == 1
    assert str(copy['avatar_url']).startswith(f's3://{BUCKET}/{_avatars(scope)}')
    others = [other for other in SCOPES if other != scope]
    assert all('Item' not in table.get_item(Key={'pk': project_pk(COMPANY_PERSONAS_CONTAINER, workspace=other),
                                                 'sk': 'META'}) for other in others)
