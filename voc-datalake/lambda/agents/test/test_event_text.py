"""Run events name projects by name (read once per run) and keep a failure's technical detail apart."""
from __future__ import annotations

from unittest.mock import MagicMock

from agents import principal, store
from agents.event_text import MAX_CACHED_NAMES, project_name, project_ref, remember_project_name
from agents.graph import Node
from agents.nodes.base import NodeContext


def _ctx(context: dict, answer: object = None) -> tuple[NodeContext, MagicMock]:
    node = Node(id='n', type='handoff', title='Hand off', instructions='', role='worker', params={})
    ctx = NodeContext(agent={'agent_id': 'ag_1'}, run={'run_id': 'ar_1', 'context': context}, node=node, envelope='')
    projects = MagicMock(return_value=answer)
    ctx.projects = projects
    return ctx, projects


class TestProjectNames:
    def test_a_name_reads_quoted_and_a_missing_one_never_shows_the_id(self):
        assert [project_ref('Loyalty  app'), project_ref(''), project_ref(None)] == [
            'the project "Loyalty app"', 'the project', 'the project']

    def test_the_first_lookup_reads_the_project_and_returns_the_cache_update(self):
        ctx, projects = _ctx({}, {'project': {'name': 'Loyalty'}})
        assert project_name(ctx, 'p1') == ('the project "Loyalty"', {'project_names': {'p1': 'Loyalty'}})
        projects.assert_called_once_with('GET', '/projects/p1', path_parameters={'project_id': 'p1'})

    def test_a_cached_name_is_not_read_again(self):
        ctx, projects = _ctx({'project_names': {'p1': 'Loyalty'}})
        assert project_name(ctx, 'p1') == ('the project "Loyalty"', {})
        projects.assert_not_called()

    def test_an_unreadable_project_reads_as_the_project_and_never_fails(self):
        ctx, projects = _ctx({})
        projects.side_effect = principal.RouteError(404, 'Not found')
        assert project_name(ctx, 'p1') == ('the project', {})

    def test_the_cache_keeps_the_newest_names(self):
        names = {f'p{i}': f'Name {i}' for i in range(MAX_CACHED_NAMES)}
        update = remember_project_name({'project_names': names}, 'p_new', 'New')['project_names']
        assert (len(update), 'p0' in update, update['p_new']) == (MAX_CACHED_NAMES, False, 'New')

    def test_an_unchanged_or_empty_name_needs_no_update(self):
        assert [remember_project_name({'project_names': {'p1': 'A'}}, 'p1', 'A'),
                remember_project_name({}, 'p1', '')] == [{}, {}]


def test_a_failed_event_keeps_its_masked_technical_detail(monkeypatch):
    table = MagicMock()
    monkeypatch.setattr(store, '_table', lambda: table)
    monkeypatch.setattr(store, '_next_seq', lambda *_args: 3)
    store.append_event('ag_1', 'ar_1', 'node_failed', 'The review analysis came back in an unexpected format.',
                       detail='route refused arn:aws:lambda:us-west-2:111122223333:function:x')
    item = table.put_item.call_args.kwargs['Item']
    assert (item['summary'], item['detail']) == (
        'The review analysis came back in an unexpected format.', 'route refused [redacted]')


def test_an_event_without_detail_has_no_detail_attribute(monkeypatch):
    table = MagicMock()
    monkeypatch.setattr(store, '_table', lambda: table)
    monkeypatch.setattr(store, '_next_seq', lambda *_args: 4)
    store.append_event('ag_1', 'ar_1', 'message', 'Run started.', detail='   ')
    assert 'detail' not in table.put_item.call_args.kwargs['Item']
