"""shared/project_keys.py: the one place a project's keys are spelled; their values are the stored rows' keys."""
import pytest

from shared.project_keys import (
    PROJECT_PREFIX,
    PROJECT_TYPE_PK,
    REVIEWER_ROUTES_STORE,
    NotPerWorkspaceError,
    ProjectPartition,
    comment_series_key,
    comments_pk,
    document_keys,
    document_listing,
    document_revision_key,
    document_revisions_prefix,
    job_status_pk,
    legacy_assignment_key,
    legacy_assignment_prefix,
    personas_index_pk,
    project_id_of,
    project_partitions,
    project_pk,
    project_type_pk,
    require_deployment,
    review_link_key,
    review_link_registry_key,
    reviewer_rate_pk,
    version_allocation_key,
    version_counter_key,
    version_partition_key,
)
from shared.review_share_audience import share_key
from shared.test.document_versions_fixtures import sha
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
    require_deployment(None, REVIEWER_ROUTES_STORE)
    with pytest.raises(NotPerWorkspaceError, match=r'^Review link reviewers is not per workspace yet$'):
        require_deployment(A, REVIEWER_ROUTES_STORE)


SERIES = 'ser_' + 'a' * 24
SHARE = 'shr_' + 'b' * 32


def test_the_comment_and_link_keys_are_the_deployments_stored_keys():
    assert comments_pk('proj_1', SERIES) == f'DCOMMENTS#proj_1#{SERIES}'
    assert comments_pk('proj_1', SERIES, workspace=None) == f'DCOMMENTS#proj_1#{SERIES}'
    assert review_link_key(SHARE) == {'pk': f'DOCSHARE#{SHARE}', 'sk': 'META'}
    assert review_link_key(SHARE, workspace=None) == share_key(SHARE)
    assert reviewer_rate_pk(SHARE, 'd' * 24) == f"DCRATE#{SHARE}#{'d' * 24}"


def test_a_workspaces_comment_and_link_keys_are_the_same_keys_inside_it():
    assert comments_pk('proj_1', SERIES, workspace=A) == f'WS#{WS_A}#DCOMMENTS#proj_1#{SERIES}'
    assert comment_series_key('proj_1', SERIES, workspace=A) == {
        'pk': f'WS#{WS_A}#PROJECT#proj_1', 'sk': f'COMMENT_SERIES#{SERIES}'}
    assert review_link_registry_key(SHARE, workspace=A) == {'pk': f'WS#{WS_A}#DOCSHARE_IDS', 'sk': SHARE}
    assert reviewer_rate_pk(SHARE, 'd' * 24, workspace=A) == f"WS#{WS_A}#DCRATE#{SHARE}#{'d' * 24}"


def test_a_workspaces_link_key_is_inside_it():
    assert review_link_key(SHARE, workspace=A) == {'pk': f'WS#{WS_A}#DOCSHARE#{SHARE}', 'sk': 'META'}
    assert A.owns(review_link_key(SHARE, workspace=A)['pk'])
    assert not B.owns(review_link_key(SHARE, workspace=A)['pk'])


@pytest.mark.parametrize('call', [
    lambda: comment_series_key('proj_1', '', workspace=A),
    lambda: review_link_registry_key('', workspace=A),
], ids=['series', 'registry'])
def test_a_listing_row_names_its_id(call):
    with pytest.raises(ValueError, match='names'):
        call()


COUNTER_SK = 'PRD#1fef41e791b4745c34c15e7d36a86b18613c4711303ef591186f6c8605c53304'   # sha256 of 'trail map'
ALLOCATION_SK = f"ALLOCATION#PRD#{sha('job_1')}"


def test_the_version_keys_are_the_deployments_stored_keys():
    assert version_partition_key('proj_1') == 'DOCUMENT_VERSIONS#PROJECT#proj_1'
    assert version_partition_key('proj_1', workspace=None) == 'DOCUMENT_VERSIONS#PROJECT#proj_1'
    counter = version_counter_key('proj_1', 'prd', 'trail map')
    assert counter == {'pk': 'DOCUMENT_VERSIONS#PROJECT#proj_1', 'sk': COUNTER_SK}
    assert version_allocation_key('proj_1', 'prd', 'job_1', workspace=None) == {
        'pk': 'DOCUMENT_VERSIONS#PROJECT#proj_1', 'sk': ALLOCATION_SK}
    assert legacy_assignment_prefix(counter) == f'LEGACY_ASSIGNMENT#{COUNTER_SK}#'
    assert legacy_assignment_key(counter, 'PRD#legacy_1') == {
        'pk': 'DOCUMENT_VERSIONS#PROJECT#proj_1', 'sk': f"LEGACY_ASSIGNMENT#{COUNTER_SK}#{sha('PRD#legacy_1')}"}
    assert document_revisions_prefix('doc_1') == 'REVISION#doc_1#'
    assert document_revision_key('proj_1', 'doc_1', 7) == {
        'pk': 'DOCUMENT_VERSIONS#PROJECT#proj_1', 'sk': 'REVISION#doc_1#000007'}


def test_a_workspaces_version_keys_are_the_same_keys_inside_it():
    partition = f'WS#{WS_A}#DOCUMENT_VERSIONS#PROJECT#proj_1'
    assert version_partition_key('proj_1', workspace=A) == partition
    counter = version_counter_key('proj_1', 'prd', 'trail map', workspace=A)
    assert counter == {'pk': partition, 'sk': COUNTER_SK}
    assert version_allocation_key('proj_1', 'prd', 'job_1', workspace=A) == {'pk': partition, 'sk': ALLOCATION_SK}
    # A legacy assignment sits in its counter's partition, so in the counter's scope.
    assert legacy_assignment_key(counter, 'PRD#legacy_1') == {
        'pk': partition, 'sk': f"LEGACY_ASSIGNMENT#{COUNTER_SK}#{sha('PRD#legacy_1')}"}
    assert document_revision_key('proj_1', 'doc_1', 7, workspace=A) == {'pk': partition, 'sk': 'REVISION#doc_1#000007'}
    assert A.owns(partition)
    assert not B.owns(partition)
    assert not A.owns(version_partition_key('proj_1'))


def test_a_projects_partitions_are_listed_with_their_tables():
    assert project_partitions('proj_1') == (
        ProjectPartition('project', 'PROJECTS_TABLE', 'PROJECT#proj_1'),
        ProjectPartition('versions', 'PROJECTS_TABLE', 'DOCUMENT_VERSIONS#PROJECT#proj_1'),
        ProjectPartition('jobs', 'JOBS_TABLE', 'PROJECT#proj_1'),
        ProjectPartition('lists', 'PARTICIPANTS_TABLE', 'PROJECT#proj_1'),
    )
    assert project_partitions('proj_1', workspace=A) == (
        ProjectPartition('project', 'PROJECTS_TABLE', f'WS#{WS_A}#PROJECT#proj_1'),
        ProjectPartition('versions', 'PROJECTS_TABLE', f'WS#{WS_A}#DOCUMENT_VERSIONS#PROJECT#proj_1'),
        ProjectPartition('jobs', 'JOBS_TABLE', f'WS#{WS_A}#PROJECT#proj_1'),
        ProjectPartition('lists', 'PARTICIPANTS_TABLE', f'WS#{WS_A}#PROJECT#proj_1'),
    )


def test_a_jobs_status_partition_is_the_stored_one():
    assert job_status_pk('running') == 'STATUS#running'
    assert job_status_pk('failed', workspace=None) == 'STATUS#failed'
    assert job_status_pk('running', workspace=A) == f'WS#{WS_A}#STATUS#running'
