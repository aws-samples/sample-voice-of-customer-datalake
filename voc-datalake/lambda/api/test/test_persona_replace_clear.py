"""Replace-mode regeneration clears EVERY persona, and one failed delete does not stop the rest.

The old ``_clear_existing_personas`` read one query page (a project whose personas
spilled past 1 MB kept the second page) and deleted through a batch writer, so the
first failed batch skipped every later delete. Each test here fails on that code.
"""
from unittest.mock import MagicMock, patch

import pytest
from botocore.exceptions import ClientError

import projects

BUCKET = 'voc-raw-data-test'
PK = 'PROJECT#proj-1'


def _row(persona_id: str) -> dict:
    return {'pk': PK, 'sk': f'PERSONA#{persona_id}'}


def _paged_table(*pages: list[dict]) -> MagicMock:
    """A table whose query answers ``pages`` in turn, each but the last with a cursor."""
    responses = [
        {'Items': page, **({'LastEvaluatedKey': {'pk': PK, 'sk': page[-1]['sk']}} if i < len(pages) - 1 else {})}
        for i, page in enumerate(pages)
    ]
    table = MagicMock()
    table.query.side_effect = responses
    return table


def _deleted(table: MagicMock) -> list[str]:
    return [c.kwargs['Key']['sk'] for c in table.delete_item.call_args_list]


@pytest.fixture(autouse=True)
def bucket_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv('RAW_DATA_BUCKET', BUCKET)


def test_every_query_page_is_cleared():
    table = _paged_table([_row('a'), _row('b')], [_row('c')])
    with patch.object(projects, 'projects_table', table), \
            patch.object(projects, '_delete_project_avatar_objects') as sweep:
        projects._clear_existing_personas('proj-1')
    assert _deleted(table) == ['PERSONA#a', 'PERSONA#b', 'PERSONA#c']
    assert table.query.call_args_list[1].kwargs['ExclusiveStartKey'] == {'pk': PK, 'sk': 'PERSONA#b'}
    sweep.assert_called_once_with('proj-1', BUCKET, ['a', 'b', 'c'])


def test_one_failed_delete_does_not_stop_the_rest_and_keeps_its_avatar():
    table = _paged_table([_row('a'), _row('b'), _row('c')])
    throttled = ClientError({'Error': {'Code': 'ProvisionedThroughputExceededException'}}, 'DeleteItem')
    table.delete_item.side_effect = [None, throttled, None]
    with patch.object(projects, 'projects_table', table), \
            patch.object(projects, '_delete_project_avatar_objects') as sweep, \
            patch.object(projects, 'logger') as log:
        projects._clear_existing_personas('proj-1')
    assert _deleted(table) == ['PERSONA#a', 'PERSONA#b', 'PERSONA#c']
    sweep.assert_called_once_with('proj-1', BUCKET, ['a', 'c'])
    assert log.warning.call_args.kwargs['extra']['failed'] == ['PERSONA#b']


def test_a_failed_read_is_logged_and_deletes_nothing():
    table = MagicMock()
    table.query.side_effect = RuntimeError('dynamodb down')
    with patch.object(projects, 'projects_table', table), \
            patch.object(projects, '_delete_project_avatar_objects') as sweep, \
            patch.object(projects, 'logger') as log:
        assert projects._clear_existing_personas('proj-1') is None
    table.delete_item.assert_not_called()
    sweep.assert_not_called()
    assert log.exception.call_args.args[0].startswith('[PERSONA] Failed to read the existing personas')


def test_every_delete_failing_sweeps_nothing():
    table = _paged_table([_row('a')])
    table.delete_item.side_effect = RuntimeError('denied')
    with patch.object(projects, 'projects_table', table), \
            patch.object(projects, '_delete_project_avatar_objects') as sweep:
        projects._clear_existing_personas('proj-1')
    sweep.assert_not_called()
