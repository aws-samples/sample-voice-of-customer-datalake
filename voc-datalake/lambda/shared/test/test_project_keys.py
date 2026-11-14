"""shared/project_keys.py: the one place a project's keys are spelled; their values are the stored rows' keys."""
import pytest

from shared.project_keys import (
    PROJECT_PREFIX,
    PROJECT_TYPE_PK,
    NotPerWorkspaceError,
    document_keys,
    document_listing,
    personas_index_pk,
    project_id_of,
    project_pk,
    project_type_pk,
    require_deployment,
)
from shared.ws_repo import WorkspaceScope

WS_A = 'ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D8'
A = WorkspaceScope(WS_A)
B = WorkspaceScope('ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D9')
LISTED_AT = '2026-11-13T10:00:00+00:00'


def test_the_keys_are_the_stored_rows_keys():
    assert (PROJECT_PREFIX, PROJECT_TYPE_PK) == ('PROJECT#', 'TYPE#PROJECT')
    assert project_pk('proj_1') == 'PROJECT#proj_1'
    assert personas_index_pk('proj_1') == 'PROJECT#proj_1#PERSONAS'


def test_a_documents_keys_list_it_among_its_projects_documents():
    assert document_listing('proj_1', LISTED_AT) == {
        'gsi1pk': 'PROJECT#proj_1#DOCUMENTS', 'gsi1sk': LISTED_AT}
    assert document_keys('proj_1', 'DOC#doc_1', LISTED_AT) == {
        'pk': 'PROJECT#proj_1', 'sk': 'DOC#doc_1', 'gsi1pk': 'PROJECT#proj_1#DOCUMENTS',
        'gsi1sk': LISTED_AT}


def test_workspace_none_is_the_deployments_literal_keys():
    assert project_pk('proj_1', workspace=None) == 'PROJECT#proj_1'
    assert personas_index_pk('proj_1', workspace=None) == 'PROJECT#proj_1#PERSONAS'
    assert project_type_pk(workspace=None) == 'TYPE#PROJECT'
    assert document_keys('proj_1', 'DOC#doc_1', LISTED_AT, workspace=None) == {
        'pk': 'PROJECT#proj_1', 'sk': 'DOC#doc_1', 'gsi1pk': 'PROJECT#proj_1#DOCUMENTS', 'gsi1sk': LISTED_AT}


def test_a_workspaces_keys_are_the_same_keys_inside_it():
    assert project_pk('proj_1', workspace=A) == f'WS#{WS_A}#PROJECT#proj_1'
    assert personas_index_pk('proj_1', workspace=A) == f'WS#{WS_A}#PROJECT#proj_1#PERSONAS'
    assert project_type_pk(workspace=A) == f'WS#{WS_A}#TYPE#PROJECT'
    assert document_listing('proj_1', LISTED_AT, workspace=A) == {
        'gsi1pk': f'WS#{WS_A}#PROJECT#proj_1#DOCUMENTS', 'gsi1sk': LISTED_AT}
    assert document_keys('proj_1', 'DOC#doc_1', LISTED_AT, workspace=A) == {
        'pk': f'WS#{WS_A}#PROJECT#proj_1', 'sk': 'DOC#doc_1', 'gsi1pk': f'WS#{WS_A}#PROJECT#proj_1#DOCUMENTS',
        'gsi1sk': LISTED_AT}


def test_every_workspace_key_is_owned_by_its_workspace_only():
    for key in (project_pk('proj_1', workspace=A), personas_index_pk('proj_1', workspace=A),
                project_type_pk(workspace=A), document_listing('proj_1', LISTED_AT, workspace=A)['gsi1pk']):
        assert A.owns(key)
        assert not B.owns(key)
    assert not A.owns(project_pk('proj_1'))


@pytest.mark.parametrize(('partition_key', 'scope', 'expected'), [
    ('PROJECT#proj_1', None, 'proj_1'),
    (f'WS#{WS_A}#PROJECT#proj_1', A, 'proj_1'),
    # Another scope's partition is never one of this scope's projects.
    (f'WS#{WS_A}#PROJECT#proj_1', None, None),
    ('PROJECT#proj_1', A, None),
    (f'WS#{WS_A}#PROJECT#proj_1', B, None),
    # An id with a `#` (an index partition, or anything after the id), an empty id, another kind of key or a
    # non-string is not a project partition.
    ('PROJECT#proj_1#DOCUMENTS', None, None),
    ('PROJECT#proj#1', None, None),
    (f'WS#{WS_A}#PROJECT#proj#1', A, None),
    ('PROJECT#', None, None),
    ('TYPE#PROJECT', None, None),
    (None, None, None),
])
def test_project_id_of_reads_a_partition_for_one_scope(partition_key, scope, expected):
    assert project_id_of(partition_key, workspace=scope) == expected


def test_a_store_not_per_workspace_refuses_one():
    require_deployment(None, 'Document versions')
    with pytest.raises(NotPerWorkspaceError, match='Document versions is not per workspace yet'):
        require_deployment(A, 'Document versions')
