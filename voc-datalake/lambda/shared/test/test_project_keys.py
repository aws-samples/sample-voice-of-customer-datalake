"""shared/project_keys.py: the one place a project's keys are spelled; their values are the stored rows' keys."""
from shared.project_keys import (
    PROJECT_PREFIX,
    PROJECT_TYPE_PK,
    document_keys,
    document_listing,
    personas_index_pk,
    project_pk,
)


def test_the_keys_are_the_stored_rows_keys():
    assert (PROJECT_PREFIX, PROJECT_TYPE_PK) == ('PROJECT#', 'TYPE#PROJECT')
    assert project_pk('proj_1') == 'PROJECT#proj_1'
    assert personas_index_pk('proj_1') == 'PROJECT#proj_1#PERSONAS'


def test_a_documents_keys_list_it_among_its_projects_documents():
    assert document_listing('proj_1', '2026-11-13T10:00:00+00:00') == {
        'gsi1pk': 'PROJECT#proj_1#DOCUMENTS', 'gsi1sk': '2026-11-13T10:00:00+00:00'}
    assert document_keys('proj_1', 'DOC#doc_1', '2026-11-13T10:00:00+00:00') == {
        'pk': 'PROJECT#proj_1', 'sk': 'DOC#doc_1', 'gsi1pk': 'PROJECT#proj_1#DOCUMENTS',
        'gsi1sk': '2026-11-13T10:00:00+00:00'}
