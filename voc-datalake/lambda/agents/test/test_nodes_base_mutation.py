"""Mutation-hardening suite for ``agents/nodes/base.py`` — what every node executor receives and returns.

The node suites only consume these helpers through the happy path, and the one existing unit test
(`test_runtime_units.py::TestHelpers::test_scope_categories`) covers a single dedupe. The mutation run
showed nothing pinned: the 500-character summary cap, the 10-category scope cap, the 4,000-character
aggregate cap, the defaults `ask` forwards to the model (``max_tokens=2000``, ``system_prompt=''``,
``step_name='agent_<type>'``), the defaults an aggregate problem renders with, which optional keys
`done` adds (and when it leaves them out), and the exact refusal each guard records on the run.
"""
from __future__ import annotations

from typing import Any
from unittest.mock import MagicMock, patch

import pytest

from agents import llm, principal
from agents.graph import Node
from agents.nodes.base import (
    MAX_SUMMARY_CHARS,
    NodeContext,
    NodeFailure,
    document_updates,
    done,
    failed,
    job_document_id,
    pending,
    scope_categories,
    started_job,
)
from agents.test.document_node_fixtures import AGENT, AGGREGATE, JOBS_WITHOUT_A_DOCUMENT


def _ctx(context: Any = None, *, params: dict | None = None, claims: dict | None = None) -> NodeContext:
    node = Node(id='n_1', type='aggregate_reviews', title='Aggregate', instructions='', role='worker',
                params=params or {})
    run: dict = {'run_id': 'ar_1'}
    if context is not None:
        run['context'] = context
    if claims is None:
        return NodeContext(agent=AGENT, run=run, node=node, envelope='env')
    return NodeContext(agent=AGENT, run=run, node=node, envelope='env', claims=claims)


class TestTheContextReadsTheRun:
    def test_ids_come_from_the_agent_and_the_run(self):
        ctx = _ctx({})
        assert (ctx.agent_id, ctx.run_id) == ('ag_1', 'ar_1')

    def test_claims_default_to_an_empty_dict(self):
        assert _ctx({}).claims == {}

    @pytest.mark.parametrize('context', [None, 'x', ['project_id']])
    def test_a_missing_or_non_dict_context_reads_empty(self, context):
        ctx = _ctx(context)
        assert ctx.context == {}
        assert ctx.project_id is None

    def test_the_context_dict_is_returned_as_stored(self):
        context = {'project_id': 'p1'}
        assert _ctx(context).context is context

    @pytest.mark.parametrize(('value', 'expected'), [('p1', 'p1'), ('', None), (7, None), (None, None)])
    def test_project_id_must_be_a_non_empty_string(self, value, expected):
        assert _ctx({'project_id': value}).project_id == expected

    def test_require_project_returns_the_project(self):
        assert _ctx({'project_id': 'p1'}).require_project() == 'p1'

    def test_require_project_refuses_without_one(self):
        with pytest.raises(NodeFailure) as error:
            _ctx({'project_id': ''}).require_project()
        assert str(error.value) == 'no project has been chosen for this run yet'

    @pytest.mark.parametrize(('documents', 'expected'), [
        ({'prd': 'doc_1'}, 'doc_1'),
        ({'prd': ''}, None),
        ({'prd': 3}, None),
        ({'prfaq': 'doc_2'}, None),
        (['prd'], None),
        (None, None),
    ])
    def test_document_is_the_kind_s_non_empty_id(self, documents, expected):
        assert _ctx({'documents': documents}).document('prd') == expected

    def test_param_reads_the_node_params_with_a_default(self):
        ctx = _ctx({}, params={'days': 14})
        assert ctx.param('days') == 14
        assert ctx.param('missing') is None
        assert ctx.param('missing', 'fallback') == 'fallback'


class TestAskAndProjectsForwardExactly:
    def test_ask_defaults(self):
        ctx = _ctx({})
        with patch.object(llm, 'ask', return_value='answer') as ask:
            assert ctx.ask('prompt') == 'answer'
        assert isinstance(ask, MagicMock)
        ask.assert_called_once_with(AGENT, 'ar_1', 'worker', 'prompt', system_prompt='', max_tokens=2000,
                                    step_name='agent_aggregate_reviews')

    def test_ask_overrides(self):
        ctx = _ctx({})
        with patch.object(llm, 'ask', return_value='answer') as ask:
            ctx.ask('prompt', system_prompt='sys', max_tokens=50, role='reviewer')
        assert isinstance(ask, MagicMock)
        ask.assert_called_once_with(AGENT, 'ar_1', 'reviewer', 'prompt', system_prompt='sys', max_tokens=50,
                                    step_name='agent_aggregate_reviews')

    def test_projects_acts_with_the_run_claims(self):
        ctx = _ctx({}, claims={'sub': 'owner-sub'})
        with patch.object(principal, 'projects', return_value={'ok': 1}) as projects:
            assert ctx.projects('POST', '/projects/p1', body={'a': 1}) == {'ok': 1}
        assert isinstance(projects, MagicMock)
        projects.assert_called_once_with('POST', '/projects/p1', {'sub': 'owner-sub'}, body={'a': 1})


class TestAggregateText:
    def test_the_aggregate_renders_title_summary_and_problems(self):
        assert _ctx({'aggregate': AGGREGATE}).aggregate_text() == (
            'Checkout is slow\nUsers wait at payment.\n- Slow payment (checkout): 3 reviews')

    @pytest.mark.parametrize('aggregate', [None, 'text', ['x']])
    def test_a_non_dict_aggregate_is_empty(self, aggregate):
        assert _ctx({'aggregate': aggregate}).aggregate_text() == ''

    def test_a_problem_without_fields_renders_its_defaults_and_non_dicts_are_skipped(self):
        aggregate = {'title': None, 'problem_summary': '', 'top_problems': [{}, 'x', None]}
        assert _ctx({'aggregate': aggregate}).aggregate_text() == '-  (): 0 reviews'

    def test_missing_problems_leave_only_the_header(self):
        aggregate = {'title': 'T', 'problem_summary': 'S', 'top_problems': None}
        assert _ctx({'aggregate': aggregate}).aggregate_text() == 'T\nS'

    def test_the_text_is_capped_at_4000_by_default(self):
        ctx = _ctx({'aggregate': {'title': 'a' * 5000}})
        assert ctx.aggregate_text() == 'a' * 4000
        assert ctx.aggregate_text(limit=3) == 'aaa'


class TestScopeCategories:
    @pytest.mark.parametrize(('scope', 'expected'), [
        ({'all': True, 'categories': ['x']}, []),
        ({'all': 1, 'categories': ['x']}, ['x']),
        ({'all': False, 'categories': ['a', 'a', '', 3, 'b']}, ['a', 'b']),
        ({'subcategories': [{'category': 'b'}, {'category': 'a'}, 'c', {'category': ''}, {'category': 4}],
          'categories': ['a']}, ['a', 'b']),
        ({'categories': None, 'subcategories': None}, []),
        ('not a dict', []),
    ])
    def test_scope(self, scope, expected):
        assert scope_categories({'scope': scope}) == expected

    def test_at_most_ten_categories(self):
        names = [f'c{i}' for i in range(12)]
        assert scope_categories({'scope': {'categories': names}}) == names[:10]


class TestResults:
    def test_summaries_are_stripped_and_capped(self):
        assert MAX_SUMMARY_CHARS == 500
        result = done(_ctx({}), '  ' + 'x' * 600)
        assert result == {'node_id': 'n_1', 'status': 'done', 'summary': 'x' * 500}

    def test_done_adds_every_optional_key_given(self):
        result = done(_ctx({}), ' ok ', outcome='approved', artifacts={'project_id': 'p1'},
                      updates={'k': 1}, halt=True)
        assert result == {'node_id': 'n_1', 'status': 'done', 'summary': 'ok', 'outcome': 'approved',
                          'artifacts': {'project_id': 'p1'}, 'updates': {'k': 1}, 'halt': True}

    def test_done_leaves_out_empty_optionals(self):
        result = done(_ctx({}), 'ok', outcome='', artifacts={}, updates={}, halt=False)
        assert result == {'node_id': 'n_1', 'status': 'done', 'summary': 'ok'}

    def test_pending(self):
        assert pending(_ctx({}), 'p1', 'job_9', ' waiting ') == {
            'node_id': 'n_1', 'status': 'pending', 'summary': 'waiting',
            'pending': {'project_id': 'p1', 'job_id': 'job_9'}}

    def test_failed_bounds_summary_and_error(self):
        assert failed('n_2', ' ' + 'e' * 501) == {
            'node_id': 'n_2', 'status': 'failed', 'summary': 'e' * 500, 'error': 'e' * 500}

    def test_a_none_text_is_an_empty_summary(self):
        no_text: Any = None  # a model or route can hand back None where a string is declared
        assert failed('n_2', no_text) == {
            'node_id': 'n_2', 'status': 'failed', 'summary': '', 'error': ''}


class TestJobsAndDocuments:
    def test_started_job_is_pending_on_the_job(self):
        assert started_job(_ctx({}), {'job_id': 'job_9'}, 'p1', 'started') == {
            'node_id': 'n_1', 'status': 'pending', 'summary': 'started',
            'pending': {'project_id': 'p1', 'job_id': 'job_9'}}

    @pytest.mark.parametrize('payload', [None, 'job_9', {}, {'job_id': ''}, {'job_id': 9}])
    def test_started_job_refuses_a_route_that_started_nothing(self, payload):
        with pytest.raises(NodeFailure) as error:
            started_job(_ctx({}), payload, 'p1', 'started')
        assert str(error.value) == 'the route did not start a job'

    def test_document_updates_keep_the_other_kinds(self):
        ctx = _ctx({'documents': {'research': 'd_r', 'prd': 'old'}})
        assert document_updates(ctx, 'prd', 'doc_7') == {'documents': {'research': 'd_r', 'prd': 'doc_7'}}

    def test_document_updates_start_from_nothing(self):
        assert document_updates(_ctx({'documents': 'x'}), 'prd', 'doc_7') == {'documents': {'prd': 'doc_7'}}

    def test_job_document_id(self):
        assert job_document_id({'result': {'document_id': 'doc_7'}}) == 'doc_7'

    @pytest.mark.parametrize('job', [*JOBS_WITHOUT_A_DOCUMENT, {'result': {'document_id': 7}}])
    def test_a_job_without_a_document_is_refused(self, job):
        with pytest.raises(NodeFailure) as error:
            job_document_id(job)
        assert str(error.value) == 'the job finished without a document'
