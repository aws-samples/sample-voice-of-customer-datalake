"""Documents that cited a deleted source say so (shared/deleted_sources.py)."""
from unittest.mock import MagicMock

import pytest
from botocore.exceptions import ClientError
from moto import mock_aws

from shared.deleted_sources import MAX_DELETED_SOURCES, DeletedSource, mark_citing_documents
from shared.test.moto_tables import create_pk_sk_table

NOW = '2026-11-03T12:00:00+00:00'
PK = 'PROJECT#p1'


@pytest.fixture
def table():
    with mock_aws():
        yield create_pk_sk_table('projects')


def _put(table, sk: str, **fields) -> None:
    table.put_item(Item={'pk': PK, 'sk': sk, **fields})


def _deleted(table, sk: str) -> list[dict] | None:
    return table.get_item(Key={'pk': PK, 'sk': sk})['Item'].get('deleted_sources')


def test_each_kind_is_matched_on_its_own_ids_legacy_fields_included(table):
    _put(table, 'PRD#a', document_id='a', derivation={'sources': [{'document_id': 'gone', 'role': 'reference'}]})
    _put(table, 'PROTOTYPE#b', document_id='b', source_prd_id='gone')
    _put(table, 'DOC#c', document_id='c', source_documents=['x', 'gone'])
    _put(table, 'DOC#d', document_id='d', derivation={'visual_document_ids': ['img']})
    _put(table, 'DOC#e', document_id='e', derivation={'persona_ids': ['gone']})  # a persona id, not a document
    _put(table, 'PERSONA#gone', persona_id='gone', derivation={'persona_ids': ['gone']})  # not a document row

    assert mark_citing_documents(table, 'p1', [DeletedSource('document', 'gone')], deleted_at=NOW) == 3
    assert mark_citing_documents(table, 'p1', [DeletedSource('product_doc', 'img')], deleted_at=NOW) == 1

    assert _deleted(table, 'PRD#a') == [{'kind': 'document', 'id': 'gone', 'deleted_at': NOW}]
    assert _deleted(table, 'PROTOTYPE#b')
    assert _deleted(table, 'DOC#c')
    assert _deleted(table, 'DOC#d') == [{'kind': 'product_doc', 'id': 'img', 'deleted_at': NOW}]
    assert _deleted(table, 'DOC#e') is None
    assert _deleted(table, 'PERSONA#gone') is None


def test_a_name_is_kept_for_a_persona_only(table):
    _put(table, 'DOC#a', document_id='a', derivation={'persona_ids': ['x']}, source_documents=['y'])
    mark_citing_documents(table, 'p1', [DeletedSource('persona', 'x', 'Budget Ben'),
                                        DeletedSource('document', 'y', 'A title')], deleted_at=NOW)
    assert _deleted(table, 'DOC#a') == [
        {'kind': 'persona', 'id': 'x', 'name': 'Budget Ben', 'deleted_at': NOW},
        {'kind': 'document', 'id': 'y', 'deleted_at': NOW},
    ]


def test_a_second_mark_of_the_same_source_changes_nothing(table):
    _put(table, 'DOC#a', document_id='a', derivation={'persona_ids': ['x']})
    source = [DeletedSource('persona', 'x')]
    assert mark_citing_documents(table, 'p1', source, deleted_at=NOW) == 1
    assert mark_citing_documents(table, 'p1', source, deleted_at='later') == 0
    assert _deleted(table, 'DOC#a') == [{'kind': 'persona', 'id': 'x', 'deleted_at': NOW}]


def test_the_list_keeps_the_newest_entries_only(table):
    ids = [f'p{i}' for i in range(MAX_DELETED_SOURCES + 5)]
    _put(table, 'DOC#a', document_id='a', derivation={'persona_ids': ids})
    mark_citing_documents(table, 'p1', [DeletedSource('persona', i) for i in ids], deleted_at=NOW)
    stored = _deleted(table, 'DOC#a')
    assert stored is not None
    assert [e['id'] for e in stored] == ids[-MAX_DELETED_SOURCES:]


def test_a_document_never_cites_itself(table):
    _put(table, 'DOC#a', document_id='a', source_documents=['a'])
    assert mark_citing_documents(table, 'p1', [DeletedSource('document', 'a')], deleted_at=NOW) == 0


def test_a_document_deleted_meanwhile_is_skipped():
    table = MagicMock()
    table.query.return_value = {'Items': [{'pk': PK, 'sk': 'DOC#a', 'document_id': 'a',
                                           'derivation': {'persona_ids': ['x']}}]}
    table.update_item.side_effect = ClientError(
        {'Error': {'Code': 'ConditionalCheckFailedException', 'Message': 'gone'}}, 'UpdateItem')
    assert mark_citing_documents(table, 'p1', [DeletedSource('persona', 'x')], deleted_at=NOW) == 0


def test_a_failure_is_logged_never_raised():
    table = MagicMock()
    table.query.side_effect = ClientError({'Error': {'Code': 'Throttling', 'Message': 'slow'}}, 'Query')
    assert mark_citing_documents(table, 'p1', [DeletedSource('persona', 'x')], deleted_at=NOW) == 0


def test_nothing_deleted_or_no_table_reads_nothing():
    table = MagicMock()
    assert mark_citing_documents(table, 'p1', [], deleted_at=NOW) == 0
    assert mark_citing_documents(None, 'p1', [DeletedSource('persona', 'x')], deleted_at=NOW) == 0
    table.query.assert_not_called()
