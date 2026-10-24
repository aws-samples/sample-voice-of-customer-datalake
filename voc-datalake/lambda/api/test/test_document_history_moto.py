"""Every document edit is a new version; earlier versions stay retrievable (QA s3 F4).

Editing a PRD in the page editor, or through the assistant's ``update_document``,
used to overwrite the stored content in place: the previous text was lost and
nothing listed a document's history. Against moto (real conditional writes and
transactions), through the same ``projects`` functions the routes call:

* a PRD / PR/FAQ edit allocates the next version of the series, as regeneration
  does, and leaves the edited version untouched; a retried save replays the
  version it made; an edit that changes nothing saves nothing;
* a research / custom edit keeps its id and saves what it replaced as a revision;
  a stale edit (someone saved in between) is refused rather than silently lost;
* the versions list returns every version newest first with its content, and a
  restore is a NEW version carrying the old content — history is only added to;
* deleting a custom document removes its saved revisions.
"""
from collections.abc import Iterator
from typing import Any
from unittest.mock import patch

import pytest
from moto import mock_aws
from moto_helpers import pk_sk_table

from shared.document_versions import persist_versioned_document
from shared.exceptions import ConflictError, NotFoundError, ValidationError

PROJECT = 'proj-1'
NOW = '2026-05-01T00:00:00+00:00'


@pytest.fixture
def table() -> Iterator[Any]:
    with mock_aws():
        projects_table = pk_sk_table('history-projects')
        projects_table.put_item(Item={'pk': f'PROJECT#{PROJECT}', 'sk': 'META', 'project_id': PROJECT,
                                      'document_count': 0})
        with patch('projects.projects_table', projects_table):
            yield projects_table


def _generated_prd(table: Any, content: str = '# v1 text') -> dict:
    return persist_versioned_document(table, PROJECT, 'prd', 'Launch', 'job_1', {
        'content': content, 'created_at': '2026-04-01T00:00:00+00:00', 'source_prd_id': None,
        'feedback_count': 12,
    })


def _custom_doc(table: Any, content: str = 'first draft') -> dict:
    item = {'pk': f'PROJECT#{PROJECT}', 'sk': 'DOC#doc_1', 'document_id': 'doc_1', 'document_type': 'custom',
            'title': 'Notes', 'content': content, 'created_at': '2026-04-01T00:00:00+00:00'}
    table.put_item(Item=item)
    return item


def _row(table: Any, sk: str) -> dict:
    return table.get_item(Key={'pk': f'PROJECT#{PROJECT}', 'sk': sk})['Item']


def _edit(document_id: str, body: dict) -> dict:
    from projects import update_document

    return update_document(PROJECT, document_id, body)


def _versions(document_id: str) -> list[dict]:
    from projects import get_document_versions

    return get_document_versions(PROJECT, document_id)['versions']


def _restore(document_id: str, version_id: str) -> dict:
    from projects import restore_document

    return restore_document(PROJECT, document_id, version_id, {})


class TestAManagedEditIsTheNextVersion:
    def test_the_edit_is_v2_and_v1_keeps_its_content(self, table):
        v1 = _generated_prd(table)

        saved = _edit(v1['document_id'], {'content': '# edited', 'edit_id': 'save-1'})['document']

        assert (saved['version'], saved['title'], saved['content']) == (2, 'Launch (v2)', '# edited')
        assert saved['document_id'] != v1['document_id']
        assert saved['edited_from_id'] == v1['document_id']
        assert saved['feedback_count'] == 12
        assert _row(table, v1['sk'])['content'] == '# v1 text'

    def test_a_retried_save_replays_its_version_and_a_new_save_makes_another(self, table):
        v1 = _generated_prd(table)

        first = _edit(v1['document_id'], {'content': '# edited', 'edit_id': 'save-1'})['document']
        retried = _edit(v1['document_id'], {'content': '# edited', 'edit_id': 'save-1'})['document']
        again = _edit(first['document_id'], {'content': '# edited again', 'edit_id': 'save-2'})['document']

        assert retried['document_id'] == first['document_id']
        assert again['version'] == 3

    def test_an_edit_that_changes_nothing_saves_nothing(self, table):
        v1 = _generated_prd(table)

        result = _edit(v1['document_id'], {'content': '# v1 text'})

        assert result['unchanged'] is True
        assert [v['version'] for v in _versions(v1['document_id'])] == [1]

    def test_the_versions_list_is_newest_first_with_content_and_restore_adds_a_version(self, table):
        v1 = _generated_prd(table)
        v2 = _edit(v1['document_id'], {'content': '# edited', 'edit_id': 'save-1'})['document']

        listed = _versions(v2['document_id'])
        assert [(v['version'], v['current'], v['content']) for v in listed] == [
            (2, True, '# edited'), (1, False, '# v1 text')]

        restored = _restore(v2['document_id'], v1['document_id'])['document']

        assert (restored['version'], restored['content']) == (3, '# v1 text')
        assert (restored['edit_kind'], restored['restored_from_version']) == ('restore', 1)
        assert [v['version'] for v in _versions(restored['document_id'])] == [3, 2, 1]

    def test_restoring_an_unknown_version_is_a_404(self, table):
        v1 = _generated_prd(table)
        with pytest.raises(NotFoundError):
            _restore(v1['document_id'], 'prd_not_in_this_series')


class TestAnUnmanagedEditSavesWhatItReplaces:
    def test_each_edit_keeps_the_id_and_saves_the_previous_text(self, table):
        _custom_doc(table)

        _edit('doc_1', {'content': 'second draft'})
        current = _edit('doc_1', {'content': 'third draft', 'title': 'Notes v3'})['document']

        assert (current['document_id'], current['revision'], current['content']) == ('doc_1', 3, 'third draft')
        assert [(v['version_id'], v['title'], v['content'], v['current']) for v in _versions('doc_1')] == [
            ('r3', 'Notes v3', 'third draft', True),
            ('r2', 'Notes', 'second draft', False),
            ('r1', 'Notes', 'first draft', False),
        ]

    def test_restore_is_a_new_revision_with_the_old_text(self, table):
        _custom_doc(table)
        _edit('doc_1', {'content': 'second draft'})

        restored = _restore('doc_1', 'r1')['document']

        assert (restored['revision'], restored['content'], restored['edit_kind']) == (3, 'first draft', 'restore')
        assert [v['version_id'] for v in _versions('doc_1')] == ['r3', 'r2', 'r1']

    def test_a_stale_edit_is_refused_not_lost(self, table):
        stale = _custom_doc(table)
        _edit('doc_1', {'content': 'saved by someone else'})

        from shared.document_history import edit_document

        with pytest.raises(ConflictError):
            edit_document(table, PROJECT, {**stale}, {'content': 'mine'}, now=NOW)
        assert _row(table, 'DOC#doc_1')['content'] == 'saved by someone else'

    def test_deleting_the_document_removes_its_saved_revisions(self, table):
        from projects import delete_document
        from shared.document_versions import version_partition_key

        _custom_doc(table)
        _edit('doc_1', {'content': 'second draft'})

        delete_document(PROJECT, 'doc_1')

        left = table.scan()['Items']
        assert not [item for item in left if item['pk'] == version_partition_key(PROJECT)]


class TestASecondTabsStaleSaveIsAConflictNotAnOverwrite:
    """`expected_revision`: the revision a tab loaded. Without it, the second tab's save
    used to land on top of the first (e2e concurrency.spec, two tabs, one document)."""

    def test_an_unmanaged_save_of_a_stale_revision_is_refused_and_keeps_the_first(self, table):
        _custom_doc(table)
        _edit('doc_1', {'content': 'tab A', 'expected_revision': 1})

        with pytest.raises(ConflictError):
            _edit('doc_1', {'content': 'tab B', 'expected_revision': 1})

        assert (_row(table, 'DOC#doc_1')['content'], _row(table, 'DOC#doc_1')['revision']) == ('tab A', 2)
        assert [v['version_id'] for v in _versions('doc_1')] == ['r2', 'r1']

    def test_the_current_revision_saves(self, table):
        _custom_doc(table)
        _edit('doc_1', {'content': 'tab A', 'expected_revision': 1})

        saved = _edit('doc_1', {'content': 'tab B', 'expected_revision': 2})['document']

        assert (saved['content'], saved['revision']) == ('tab B', 3)

    def test_a_managed_save_of_a_stale_version_is_refused_and_makes_no_version(self, table):
        v1 = _generated_prd(table)
        _edit(v1['document_id'], {'content': '# tab A', 'edit_id': 'a', 'expected_revision': 1})

        with pytest.raises(ConflictError):
            _edit(v1['document_id'], {'content': '# tab B', 'edit_id': 'b', 'expected_revision': 1})

        assert [(v['version'], v['content']) for v in _versions(v1['document_id'])] == [
            (2, '# tab A'), (1, '# v1 text')]

    def test_a_managed_save_of_the_head_version_is_the_next_version(self, table):
        v1 = _generated_prd(table)
        v2 = _edit(v1['document_id'], {'content': '# tab A', 'edit_id': 'a', 'expected_revision': 1})['document']

        v3 = _edit(v2['document_id'], {'content': '# tab B', 'edit_id': 'b', 'expected_revision': 2})['document']

        assert (v3['version'], v3['content']) == (3, '# tab B')

    def test_a_series_that_moves_while_the_save_is_in_flight_is_a_conflict_not_a_retry(self, table):
        """The counter is read, then another save takes the next version, then this write
        lands: the conditional counter update refuses it, and the usual retry onto
        v(n+2) would be exactly the silent overwrite, so it is a 409 instead."""
        import shared.document_versions as versions

        v1 = _generated_prd(table)
        real_wait = versions._wait_for_legacy_migration
        raced: list[bool] = []

        def counter_then_race(*args, **kwargs):
            counter = real_wait(*args, **kwargs)
            if not raced:
                raced.append(True)
                _edit(v1['document_id'], {'content': '# racing tab', 'edit_id': 'race'})
            return counter

        with patch.object(versions, '_wait_for_legacy_migration', side_effect=counter_then_race), \
                pytest.raises(ConflictError):
            _edit(v1['document_id'], {'content': '# late tab', 'edit_id': 'late', 'expected_revision': 1})

        assert [v['content'] for v in _versions(v1['document_id'])] == ['# racing tab', '# v1 text']

    def test_without_expected_revision_there_is_no_check(self, table):
        """The assistant's and MCP's update_document send no revision: unchanged behaviour."""
        _custom_doc(table)
        _edit('doc_1', {'content': 'tab A'})

        assert _edit('doc_1', {'content': 'assistant edit'})['document']['revision'] == 3

    @pytest.mark.parametrize('bad', [0, -1, True, '2', 1.5])
    def test_a_malformed_expected_revision_is_a_400(self, table, bad):
        _custom_doc(table)
        with pytest.raises(ValidationError, match='expected_revision'):
            _edit('doc_1', {'content': 'x', 'expected_revision': bad})
