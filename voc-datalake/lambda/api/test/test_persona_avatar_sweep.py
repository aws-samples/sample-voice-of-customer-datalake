"""Removed personas take their avatar objects with them (QA track s3).

Regenerating personas (replace semantics) and deleting one persona removed the
PERSONA# rows but left `avatars/{persona_id}.*` in the raw-data bucket. The
project delete sweep finds avatar keys only through the rows that still exist,
and the bucket has no lifecycle expiration, so those objects were orphaned for
good (observed on production: a regenerated project left 4 avatars behind).
"""
from unittest.mock import MagicMock, patch

import pytest

import projects

BUCKET = 'voc-raw-data-test'


def _table_with_rows(rows: list[dict]) -> MagicMock:
    table = MagicMock()
    table.query.return_value = {'Items': rows}
    table.batch_writer.return_value.__enter__ = MagicMock(return_value=MagicMock())
    table.batch_writer.return_value.__exit__ = MagicMock(return_value=False)
    return table


@pytest.fixture
def bucket_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv('RAW_DATA_BUCKET', BUCKET)


@pytest.mark.usefixtures('bucket_env')
class TestRegenerationSweepsTheReplacedAvatars:
    def test_the_cleared_personas_avatars_are_deleted_for_this_project(self):
        rows = [
            {'pk': 'PROJECT#proj-1', 'sk': 'PERSONA#persona_a'},
            {'pk': 'PROJECT#proj-1', 'sk': 'PERSONA#persona_b'},
        ]
        with patch.object(projects, 'projects_table', _table_with_rows(rows)), \
                patch.object(projects, '_delete_project_avatar_objects') as sweep:
            projects._clear_existing_personas('proj-1')
        sweep.assert_called_once_with('proj-1', BUCKET, ['persona_a', 'persona_b'])

    def test_nothing_cleared_means_no_sweep(self):
        with patch.object(projects, 'projects_table', _table_with_rows([])), \
                patch.object(projects, '_delete_project_avatar_objects') as sweep:
            projects._clear_existing_personas('proj-1')
        sweep.assert_not_called()

    def test_a_failed_sweep_is_logged_and_generation_continues(self):
        rows = [{'pk': 'PROJECT#proj-1', 'sk': 'PERSONA#persona_a'}]
        with patch.object(projects, 'projects_table', _table_with_rows(rows)), \
                patch.object(projects, '_delete_project_avatar_objects', side_effect=RuntimeError('s3 down')), \
                patch.object(projects, 'logger') as log:
            assert projects._clear_existing_personas('proj-1') is None
        assert log.exception.call_args.args[0].startswith('[PERSONA] Failed to delete the avatars of removed personas')


@pytest.mark.usefixtures('bucket_env')
class TestDeletingOnePersonaSweepsItsAvatar:
    def test_the_deleted_personas_avatar_is_swept(self):
        table = MagicMock()
        with patch.object(projects, 'projects_table', table), \
                patch.object(projects, 'projects_table_name', return_value='voc-projects'), \
                patch.object(projects, '_delete_project_avatar_objects') as sweep:
            assert projects.delete_persona('proj-1', 'persona_a') == {'success': True}
        table.meta.client.transact_write_items.assert_called_once()
        sweep.assert_called_once_with('proj-1', BUCKET, ['persona_a'])

    def test_a_failed_row_delete_sweeps_nothing(self):
        table = MagicMock()
        table.meta.client.transact_write_items.side_effect = RuntimeError('conditional check failed')
        with patch.object(projects, 'projects_table', table), \
                patch.object(projects, 'projects_table_name', return_value='voc-projects'), \
                patch.object(projects, '_delete_project_avatar_objects') as sweep, \
                pytest.raises(projects.ServiceError):
            projects.delete_persona('proj-1', 'persona_a')
        sweep.assert_not_called()


def test_without_a_bucket_nothing_is_swept(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.delenv('RAW_DATA_BUCKET', raising=False)
    with patch.object(projects, '_delete_project_avatar_objects') as sweep:
        projects._sweep_removed_persona_avatars('proj-1', ['persona_a'])
    sweep.assert_not_called()


def test_persona_ids_skip_rows_that_are_not_exact_persona_keys():
    keys = [{'sk': 'PERSONA#p1'}, {'sk': 'PERSONA#p2#note'}, {'sk': 'META'}, {}]
    assert projects._persona_ids_of(keys) == ['p1']
