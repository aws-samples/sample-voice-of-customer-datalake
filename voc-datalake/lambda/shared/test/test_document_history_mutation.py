"""Mutation hardening for `shared/document_history.py`.

`api/test/test_document_history_moto.py` drives the module end to end through
`projects` against moto: a managed edit is the next version, an unmanaged edit
saves what it replaced, a stale save is a 409. A mutation run found what those
round trips cannot see:

* the exact WRITES. Which fields of the edited row carry into the new version
  (`_ROW_IDENTITY_FIELDS`), the allocation ids that make a retried save replay
  its version (``edit:{id}:{edit_id}`` / ``restore:{id}:{edit_id}``), and every
  part of the unmanaged transaction — the snapshot item, its condition, the
  update expression, the revision condition with and without a stored
  ``revision`` — are pinned here as literals on a mocked table.
* the exact READS: the consistent queries, their pagination, the 24 revision
  rows a list fetches beside the current one, the 25-version cap.
* every refusal's wording and status class, and the ACCEPTED side of each
  bound (a 64-character edit id, ``expected_revision`` 1, ``r999999``).
* `_revision_of` on every stored shape: Decimal, a non-whole Decimal, 0,
  negatives, a float, a string.
"""
from collections.abc import Iterator
from decimal import Decimal
from typing import Any
from unittest.mock import MagicMock, patch

import pytest
from boto3.dynamodb.conditions import Key
from botocore.exceptions import ClientError

import shared.document_history as dh
from shared.document_versions import STALE_SERIES_MESSAGE as STALE
from shared.exceptions import ConflictError, NotFoundError, ValidationError

NOW = '2026-06-01T00:00:00+00:00'
VERSIONS_PK = 'DOCUMENT_VERSIONS#PROJECT#p1'


def _table(pages: list[dict] | None = None) -> MagicMock:
    table = MagicMock()
    table.name = 'projects'
    table.query.side_effect = list(pages or [])
    return table


@pytest.fixture
def persist() -> Iterator[MagicMock]:
    with patch.object(dh, 'persist_versioned_document', return_value={'document_id': 'new'}) as fake:
        yield fake


def _prd(document_id: str, version: int, content: str | None, **extra: Any) -> dict:
    return {'pk': 'PROJECT#p1', 'sk': f'PRD#{document_id}', 'document_id': document_id, 'document_type': 'prd',
            'title': f'Launch (v{version})', 'base_title': 'Launch', 'version': version, 'content': content,
            'created_at': f'2026-0{version}-01', **extra}


def _custom(**extra: Any) -> dict:
    return {'pk': 'PROJECT#p1', 'sk': 'DOC#d1', 'document_id': 'd1', 'document_type': 'custom',
            'title': 'Notes', 'content': 'old', 'created_at': 'c0', **extra}


class TestEditIds:
    def test_absent_is_the_first_32_hex_of_the_content_digest(self):
        assert dh.validated_edit_id(None, 'abc') == 'ba7816bf8f01cfea414140de5dae2223'

    @pytest.mark.parametrize('raw', ['a', 'A-z_9', 'x' * 64])
    def test_a_well_formed_id_is_kept(self, raw):
        assert dh.validated_edit_id(raw, 'ignored') == raw

    @pytest.mark.parametrize('raw', [5, '', 'x' * 65, 'a b', 'a.b', 'é'])
    def test_anything_else_is_a_400_naming_the_rule(self, raw):
        with pytest.raises(ValidationError) as caught:
            dh.validated_edit_id(raw, 'c')
        assert str(caught.value) == 'edit_id must be 1-64 letters, digits, "-" or "_"'


class TestExpectedRevision:
    @pytest.mark.parametrize(('raw', 'expected'), [(None, None), (1, 1), (7, 7)])
    def test_accepted(self, raw, expected):
        assert dh.validated_expected_revision(raw) == expected

    @pytest.mark.parametrize('raw', [0, -1, True, False, '2', 1.5])
    def test_refused_with_its_wording(self, raw):
        with pytest.raises(ValidationError) as caught:
            dh.validated_expected_revision(raw)
        assert str(caught.value) == 'expected_revision must be the revision you loaded (a whole number ≥ 1)'


class TestRevisionOf:
    @pytest.mark.parametrize(('stored', 'expected'), [
        (None, 1), (3, 3), (1, 1), (Decimal('4'), 4), (Decimal('2.5'), 1), (0, 1), (-3, 1),
        (Decimal('-2'), 1), (2.0, 1), ('3', 1), (True, 1), (False, 1),
    ])
    def test_each_stored_shape(self, stored, expected):
        assert dh._revision_of({'revision': stored}) == expected

    def test_unset_is_one(self):
        assert dh._revision_of({}) == 1


class TestTheEditBody:
    def test_no_content_key_keeps_the_stored_content_and_none_is_empty(self):
        document = _custom(content=None)
        assert dh.edit_document(_table(), 'p1', document, {}, now=NOW) == {
            'success': True, 'unchanged': True, 'document': document}

    def test_a_rename_without_content_keeps_the_stored_text(self):
        saved = dh.edit_document(_table(), 'p1', _custom(), {}, now=NOW, title='Renamed')['document']
        assert (saved['content'], saved['title']) == ('old', 'Renamed')

    def test_non_string_content_is_a_400(self):
        with pytest.raises(ValidationError) as caught:
            dh.edit_document(_table(), 'p1', _custom(), {'content': 5}, now=NOW)
        assert str(caught.value) == 'content must be a string'

    def test_same_content_but_a_new_title_saves(self):
        table = _table()
        result = dh.edit_document(table, 'p1', _custom(), {'content': 'old'}, now=NOW, title='Renamed')
        assert result['document']['title'] == 'Renamed'
        table.meta.client.transact_write_items.assert_called_once()

    def test_no_title_and_no_stored_title_is_unchanged_when_content_is(self):
        document = _custom()
        del document['title']
        assert dh.edit_document(_table(), 'p1', document, {'content': 'old'}, now=NOW)['unchanged'] is True

    def test_an_unmanaged_edit_still_validates_its_edit_id(self):
        table = _table()
        with pytest.raises(ValidationError):
            dh.edit_document(table, 'p1', _custom(), {'content': 'new', 'edit_id': 'a b'}, now=NOW)
        table.meta.client.transact_write_items.assert_not_called()

    @pytest.mark.parametrize(('stored', 'expected'), [({}, 2), ({'revision': 3}, 1), ({'revision': 3}, 4)])
    def test_a_stale_expected_revision_is_a_409_before_any_write(self, stored, expected):
        table = _table()
        with pytest.raises(ConflictError) as caught:
            dh.edit_document(table, 'p1', _custom(**stored), {'content': 'new', 'expected_revision': expected},
                             now=NOW)
        assert str(caught.value) == STALE
        table.meta.client.transact_write_items.assert_not_called()


class TestTheUnmanagedTransaction:
    def test_without_a_stored_revision(self):
        table = _table()
        document = _custom(updated_at='u0', edit_kind='restore', restored_from_version=2)

        result = dh.edit_document(table, 'p1', document, {'content': 'new', 'expected_revision': 1}, now=NOW,
                                  title='T2')

        table.meta.client.transact_write_items.assert_called_once_with(TransactItems=[
            {'Put': {'TableName': 'projects', 'Item': {
                'pk': VERSIONS_PK, 'sk': 'REVISION#d1#000001', 'document_id': 'd1', 'revision': 1,
                'title': 'Notes', 'content': 'old', 'saved_at': 'u0', 'replaced_at': NOW,
                'edit_kind': 'restore', 'restored_from_version': 2},
                'ConditionExpression': 'attribute_not_exists(pk) AND attribute_not_exists(sk)'}},
            {'Update': {
                'TableName': 'projects', 'Key': {'pk': 'PROJECT#p1', 'sk': 'DOC#d1'},
                'UpdateExpression': ('SET #content = :v0, #title = :v1, #updated = :v2, #revision = :v3, '
                                     '#kind = :v4, #restored = :v5'),
                'ConditionExpression': 'attribute_exists(pk) AND document_id = :document_id AND '
                                       'attribute_not_exists(#revision)',
                'ExpressionAttributeNames': {'#content': 'content', '#title': 'title', '#updated': 'updated_at',
                                             '#revision': 'revision', '#kind': 'edit_kind',
                                             '#restored': 'restored_from_version'},
                'ExpressionAttributeValues': {':v0': 'new', ':v1': 'T2', ':v2': NOW, ':v3': 2, ':v4': 'edit',
                                              ':v5': None, ':document_id': 'd1'},
            }},
        ])
        assert result == {'success': True, 'document': {**document, 'content': 'new', 'title': 'T2',
                                                         'updated_at': NOW, 'revision': 2, 'edit_kind': 'edit'}}

    def test_with_a_stored_revision_the_update_is_conditioned_on_it(self):
        table = _table()
        document = {'pk': 'PROJECT#p1', 'sk': 'DOC#d1', 'document_id': 'd1', 'revision': Decimal('12'),
                    'created_at': 'c0'}

        dh.edit_document(table, 'p1', document, {'content': 'new'}, now=NOW)

        put, update = table.meta.client.transact_write_items.call_args.kwargs['TransactItems']
        assert put['Put']['Item'] == {
            'pk': VERSIONS_PK, 'sk': 'REVISION#d1#000012', 'document_id': 'd1', 'revision': 12, 'title': '',
            'content': '', 'saved_at': 'c0', 'replaced_at': NOW, 'edit_kind': None, 'restored_from_version': None}
        assert update['Update']['ConditionExpression'] == (
            'attribute_exists(pk) AND document_id = :document_id AND #revision = :observed')
        assert update['Update']['ExpressionAttributeValues'][':observed'] == 12
        assert update['Update']['ExpressionAttributeValues'][':v3'] == 13

    def test_a_cancelled_transaction_is_the_stale_409(self):
        table = _table()
        table.meta.client.transact_write_items.side_effect = ClientError(
            {'Error': {'Code': 'TransactionCanceledException', 'Message': 'x'}}, 'TransactWriteItems')
        with pytest.raises(ConflictError) as caught:
            dh.edit_document(table, 'p1', _custom(), {'content': 'new'}, now=NOW)
        assert str(caught.value) == STALE

    def test_any_other_client_error_propagates(self):
        table = _table()
        error = ClientError({'Error': {'Code': 'ThrottlingException', 'Message': 'x'}}, 'TransactWriteItems')
        table.meta.client.transact_write_items.side_effect = error
        with pytest.raises(ClientError) as caught:
            dh.edit_document(table, 'p1', _custom(), {'content': 'new'}, now=NOW)
        assert caught.value is error


class TestAManagedEdit:
    def test_carries_lineage_drops_row_identity_and_allocates_by_edit_id(self, persist: MagicMock):
        stale = ('pk', 'sk', 'version', 'version_allocation_id', 'created_at', 'updated_at', 'content',
                 'edited_from_id', 'edit_kind', 'restored_from_id', 'restored_from_version')
        document = {**{key: f'old-{key}' for key in stale}, 'document_id': 'prd_1', 'document_type': 'prd',
                    'title': 'Wrong (v3)', 'base_title': 'Launch (v3)', 'feedback_count': 9, 'source_prd_id': 'x'}

        table = _table()
        result = dh.edit_document(table, 'p1', document, {'content': 'new', 'edit_id': 'e1',
                                                          'expected_revision': 3}, now=NOW)

        persist.assert_called_once_with(
            table, 'p1', 'prd', 'Launch', 'edit:prd_1:e1',
            {'document_type': 'prd', 'feedback_count': 9, 'source_prd_id': 'x', 'content': 'new',
             'created_at': NOW, 'updated_at': NOW, 'edit_kind': 'edit', 'edited_from_id': 'prd_1'},
            expected_last_version=3)
        assert result == {'success': True, 'document': {'document_id': 'new'}}

    def test_without_an_edit_id_the_content_digest_allocates(self, persist: MagicMock):
        document = {'sk': 'PRFAQ#f1', 'document_id': 'f1', 'title': '', 'content': 'old'}

        dh.edit_document(_table(), 'p1', document, {'content': 'abc'}, now=NOW)

        args = persist.call_args
        assert args.args[2:5] == ('prfaq', 'Untitled', 'edit:f1:ba7816bf8f01cfea414140de5dae2223')
        assert args.kwargs == {'expected_last_version': None}

    def test_a_titled_row_without_base_title_takes_its_series_from_the_title(self, persist: MagicMock):
        document = {'sk': 'PRD#p', 'document_id': 'p', 'title': 'Launch (v4)', 'content': 'old'}

        dh.edit_document(_table(), 'p1', document, {'content': 'new', 'edit_id': 'e'}, now=NOW)

        assert persist.call_args.args[3] == 'Launch'


def _series_table() -> MagicMock:
    """Two pages: v1 + an unrelated custom doc, then v2 + another series' PRD."""
    return _table([
        {'Items': [_prd('a', 1, 'one'), _custom()], 'LastEvaluatedKey': {'pk': 'k1'}},
        {'Items': [_prd('b', 2, None, edit_kind='restore', restored_from_version=1), _prd('z', 1, 'other', title='Other (v1)', base_title='Other')]},
    ])


class TestManagedVersionList:
    def test_newest_first_one_series_only_across_pages(self):
        table = _series_table()

        listed = dh.list_document_versions(table, 'p1', _prd('b', 2, None))

        assert listed == {'managed': True, 'versions': [
            {'version_id': 'b', 'document_id': 'b', 'version': 2, 'title': 'Launch (v2)', 'content': '',
             'created_at': '2026-02-01', 'current': True, 'edit_kind': 'restore', 'restored_from_version': 1},
            {'version_id': 'a', 'document_id': 'a', 'version': 1, 'title': 'Launch (v1)', 'content': 'one',
             'created_at': '2026-01-01', 'current': False, 'edit_kind': None, 'restored_from_version': None},
        ]}
        assert [c.kwargs for c in table.query.call_args_list] == [
            {'KeyConditionExpression': Key('pk').eq('PROJECT#p1'), 'ConsistentRead': True},
            {'KeyConditionExpression': Key('pk').eq('PROJECT#p1'), 'ConsistentRead': True,
             'ExclusiveStartKey': {'pk': 'k1'}},
        ]

    def test_a_page_without_items_reads_as_empty(self):
        table = _table([{}])
        assert dh.list_document_versions(table, 'p1', _prd('a', 1, 'x')) == {'managed': True, 'versions': []}

    def test_the_list_stops_at_25(self):
        rows = [_prd(f'd{n:02d}', n, f'c{n}', created_at=f'2026-01-{n:02d}') for n in range(1, 27)]
        listed = dh.list_document_versions(_table([{'Items': rows}]), 'p1', rows[-1])['versions']
        assert [v['version'] for v in listed] == list(range(26, 1, -1))
        assert [v['current'] for v in listed] == [True] + [False] * 24


class TestUnmanagedVersionList:
    def test_the_current_row_then_up_to_24_saved_revisions(self):
        table = _table([{'Items': [
            {'document_id': 'd1', 'revision': Decimal('2'), 'title': 'T2', 'saved_at': 's2', 'edit_kind': 'edit',
             'restored_from_version': None},
            {'document_id': 'd1', 'revision': 1, 'title': 'T1', 'content': 'first', 'saved_at': 's1',
             'edit_kind': None, 'restored_from_version': None},
        ]}])
        document = _custom(revision=3, updated_at='u3', edit_kind='restore', restored_from_version=1)

        listed = dh.list_document_versions(table, 'p1', document)

        assert listed == {'managed': False, 'versions': [
            {'version_id': 'r3', 'document_id': 'd1', 'version': 3, 'title': 'Notes', 'content': 'old',
             'created_at': 'u3', 'current': True, 'edit_kind': 'restore', 'restored_from_version': 1},
            {'version_id': 'r2', 'document_id': 'd1', 'version': 2, 'title': 'T2', 'content': '',
             'created_at': 's2', 'current': False, 'edit_kind': 'edit', 'restored_from_version': None},
            {'version_id': 'r1', 'document_id': 'd1', 'version': 1, 'title': 'T1', 'content': 'first',
             'created_at': 's1', 'current': False, 'edit_kind': None, 'restored_from_version': None},
        ]}
        table.query.assert_called_once_with(
            KeyConditionExpression=Key('pk').eq(VERSIONS_PK) & Key('sk').begins_with('REVISION#d1#'),
            ScanIndexForward=False, Limit=24, ConsistentRead=True)

    def test_never_saved_reads_its_created_at_and_no_items_is_empty(self):
        listed = dh.list_document_versions(_table([{}]), 'p1', _custom())['versions']
        assert [(v['version_id'], v['created_at']) for v in listed] == [('r1', 'c0')]


class TestManagedRestore:
    def test_a_prototype_is_refused(self):
        with pytest.raises(ValidationError) as caught:
            dh.restore_document_version(_table(), 'p1', {'sk': 'PROTOTYPE#x'}, 'x', {}, now=NOW)
        assert str(caught.value) == 'Prototypes are restored through the prototype revision workflow'

    def test_an_unknown_version_is_a_404(self):
        with pytest.raises(NotFoundError) as caught:
            dh.restore_document_version(_series_table(), 'p1', _prd('b', 2, None), 'z', {}, now=NOW)
        assert str(caught.value) == 'Version not found'

    def test_restoring_the_head_content_saves_nothing(self, persist: MagicMock):
        table = _table([{'Items': [_prd('a', 1, 'same'), _prd('b', 2, 'same')]}])

        result = dh.restore_document_version(table, 'p1', _prd('a', 1, 'same'), 'a', {}, now=NOW)

        assert result == {'success': True, 'unchanged': True, 'document': {**_prd('b', 2, 'same')}}
        persist.assert_not_called()

    def test_an_empty_version_restored_onto_a_head_without_content_saves_nothing(self, persist: MagicMock):
        table = _table([{'Items': [_prd('a', 1, ''), _prd('b', 2, None)]}])

        assert dh.restore_document_version(table, 'p1', _prd('b', 2, None), 'a', {}, now=NOW)['unchanged'] is True
        persist.assert_not_called()

    def test_a_restore_is_the_next_version_of_the_head(self, persist: MagicMock):
        table = _table([{'Items': [_prd('a', 1, None, feedback_count=1), _prd('b', 2, 'two', feedback_count=2)]}])

        result = dh.restore_document_version(table, 'p1', _prd('a', 1, None), 'a', {'edit_id': 'r9'}, now=NOW)

        persist.assert_called_once_with(
            table, 'p1', 'prd', 'Launch', 'restore:a:r9',
            {'document_type': 'prd', 'feedback_count': 2, 'content': '', 'created_at': NOW, 'updated_at': NOW,
             'edit_kind': 'restore', 'edited_from_id': 'b', 'restored_from_id': 'a', 'restored_from_version': 1},
            expected_last_version=None)
        assert result == {'success': True, 'document': {'document_id': 'new'}}


class TestUnmanagedRestore:
    @pytest.mark.parametrize('version_id', ['x', 'r0', 'r01', 'r1234567', '1', 'r1x', 'ar1'])
    def test_a_malformed_version_id_is_a_404_without_a_read(self, version_id):
        table = _table()
        with pytest.raises(NotFoundError) as caught:
            dh.restore_document_version(table, 'p1', _custom(revision=2), version_id, {}, now=NOW)
        assert str(caught.value) == 'Version not found'
        table.get_item.assert_not_called()

    def test_restoring_the_current_revision_saves_nothing(self):
        table = _table()
        document = _custom(revision=2)
        assert dh.restore_document_version(table, 'p1', document, 'r2', {}, now=NOW) == {
            'success': True, 'unchanged': True, 'document': document}
        table.get_item.assert_not_called()

    def test_a_missing_revision_row_is_a_404(self):
        table = _table()
        table.get_item.return_value = {}
        with pytest.raises(NotFoundError) as caught:
            dh.restore_document_version(table, 'p1', _custom(revision=2), 'r999999', {}, now=NOW)
        assert str(caught.value) == 'Version not found'
        table.get_item.assert_called_once_with(Key={'pk': VERSIONS_PK, 'sk': 'REVISION#d1#999999'},
                                               ConsistentRead=True)

    def test_a_restore_writes_the_old_text_as_a_new_revision(self):
        table = _table()
        table.get_item.return_value = {'Item': {'content': 'v1 text', 'title': 'Old title'}}

        result = dh.restore_document_version(table, 'p1', _custom(revision=2), 'r1', {}, now=NOW)

        assert result == {'success': True, 'document': {
            **_custom(revision=3), 'content': 'v1 text', 'title': 'Old title', 'updated_at': NOW,
            'edit_kind': 'restore', 'restored_from_version': 1}}
        update = table.meta.client.transact_write_items.call_args.kwargs['TransactItems'][1]['Update']
        assert update['ExpressionAttributeValues'][':v5'] == 1

    def test_a_revision_row_without_title_or_content_falls_back(self):
        table = _table()
        table.get_item.return_value = {'Item': {'sk': 'REVISION#d1#000001'}}

        document = dh.restore_document_version(table, 'p1', _custom(revision=2), 'r1', {}, now=NOW)['document']

        assert (document['content'], document['title']) == ('', 'Notes')

    def test_no_title_anywhere_is_empty(self):
        table = _table()
        table.get_item.return_value = {'Item': {'content': 'x'}}
        document = _custom(revision=2)
        del document['title']

        assert dh.restore_document_version(table, 'p1', document, 'r1', {}, now=NOW)['document']['title'] == ''


class TestDeletingRevisions:
    def test_every_page_of_this_documents_rows_is_deleted(self):
        table = _table([
            {'Items': [{'pk': 'P', 'sk': 'S1'}], 'LastEvaluatedKey': {'pk': 'P', 'sk': 'S1'}},
            {'Items': [{'pk': 'P', 'sk': 'S2'}, {'pk': 'P', 'sk': 'S3'}]},
        ])
        batch = table.batch_writer.return_value.__enter__.return_value

        assert dh.delete_document_revisions(table, 'p1', 'd1') is None

        condition = Key('pk').eq(VERSIONS_PK) & Key('sk').begins_with('REVISION#d1#')
        base = {'KeyConditionExpression': condition, 'ProjectionExpression': 'pk, sk', 'ConsistentRead': True}
        assert [c.kwargs for c in table.query.call_args_list] == [
            base, {**base, 'ExclusiveStartKey': {'pk': 'P', 'sk': 'S1'}}]
        assert [c.kwargs for c in batch.delete_item.call_args_list] == [
            {'Key': {'pk': 'P', 'sk': f'S{n}'}} for n in (1, 2, 3)]

    def test_a_page_without_items_deletes_nothing(self):
        table = _table([{}])
        dh.delete_document_revisions(table, 'p1', 'd1')
        table.batch_writer.return_value.__enter__.return_value.delete_item.assert_not_called()
