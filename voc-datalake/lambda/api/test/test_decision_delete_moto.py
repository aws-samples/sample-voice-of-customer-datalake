"""A decision record is deleted through the ordinary document delete
(``DELETE /projects/{id}/documents/{document_id}``, edit access by the project middleware),
which the Decisions tab's Delete calls. Against moto: the decision row goes, the project's
document count follows, and the rest of the project is untouched."""
from collections.abc import Iterator
from typing import Any
from unittest.mock import patch

import pytest
from moto import mock_aws
from moto_helpers import pk_sk_table

from shared import decision_records
from shared.project_access import Caller

PROJECT = 'proj-1'
CALLER = Caller(subject='sub-owner', username='owner')


@pytest.fixture
def table() -> Iterator[Any]:
    with mock_aws():
        projects_table = pk_sk_table('decision-delete-projects')
        projects_table.put_item(Item={'pk': f'PROJECT#{PROJECT}', 'sk': 'META', 'project_id': PROJECT,
                                      'document_count': 1, 'doc_counter': 1})
        projects_table.put_item(Item={'pk': f'PROJECT#{PROJECT}', 'sk': 'DOC#doc_notes', 'document_id': 'doc_notes',
                                      'document_type': 'custom', 'title': 'Notes', 'content': 'x',
                                      'created_at': '2026-04-01T00:00:00+00:00'})
        with patch('projects.projects_table', projects_table):
            yield projects_table


def test_deleting_a_decision_removes_only_that_record(table):
    from projects import delete_document

    created = decision_records.create_decision(table, PROJECT, {
        'title': 'Offline mode', 'verdict': 'park', 'rationale': 'Few asks',
    }, CALLER)['document']
    document_id = created['document_id']
    assert table.get_item(Key={'pk': f'PROJECT#{PROJECT}', 'sk': f'DOC#{document_id}'}).get('Item')

    delete_document(PROJECT, document_id)

    assert table.get_item(Key={'pk': f'PROJECT#{PROJECT}', 'sk': f'DOC#{document_id}'}).get('Item') is None
    assert table.get_item(Key={'pk': f'PROJECT#{PROJECT}', 'sk': 'DOC#doc_notes'}).get('Item') is not None
    meta = table.get_item(Key={'pk': f'PROJECT#{PROJECT}', 'sk': 'META'})['Item']
    assert meta['document_count'] == 1
