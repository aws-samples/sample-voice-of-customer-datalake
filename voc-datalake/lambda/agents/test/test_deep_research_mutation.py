"""Mutation hardening for `agents/nodes/deep_research.py`.

No earlier test imported the node, so a mutation run found every literal in it
unobserved: the research-route body could lose any key, the `[:2000]`, `[:80]`
and `[:20]` caps could move by one, `DEFAULT_DAYS` could become 31, the
`use_web_search` default could flip to `False`, and the three-way fallback for
the question could turn its `or`s into `and`s — all without a failing test.
What the node owns is exactly the body it POSTs to `/projects/{id}/research`
and the two summaries it answers. Pinned here, as literals:

* `start` POSTs that body once, with the question taken from the node's
  instructions, else the aggregate's `research_question`, else the stock
  question — the first 2000 characters only — a title built from the aggregate's
  title (else the question) cut at 80, the agent's category scope, `days` from
  the node params only when it is an int (else 30), the first 20 persona ids,
  and `use_web_search` true only when the param is literally `True` (absent =
  on); it answers the pending result whose summary is `Research started`;
* `finish` answers the done result whose summary is `Research report written`,
  whose artifacts claim `document_type: 'research'`, and whose updates file the
  document under `documents.research` next to the documents already on the run;
* without a project, and when the route starts no job, the exact refusal and
  the absence of (or the single) POST.

`JOB_FINISHED` / `JOBS_WITHOUT_A_DOCUMENT`, the run-context builder and the
`projects` fake accessor come from `document_node_fixtures`; the node context
itself is built locally because this node does not delegate to the shared
document writer and its POST body is its own.
"""
from __future__ import annotations

from typing import Any
from unittest.mock import Mock

import pytest

from agents.graph import Node
from agents.nodes import deep_research
from agents.nodes.base import NodeContext, NodeFailure
from agents.test.document_node_fixtures import (
    JOB_FINISHED,
    JOB_STARTED,
    JOBS_WITHOUT_A_DOCUMENT,
    PERSONAS,
    projects_fake,
    run_context,
)

STOCK_QUESTION = 'What are the main customer pain points and how could we solve them?'
AGENT = {'agent_id': 'ag_1', 'scope': {'all': False, 'categories': ['checkout', 'shipping']}}
AGGREGATE = {'title': 'Checkout is slow', 'research_question': 'Why do carts get abandoned?'}
ROUTE = '/projects/p1/research'


def node_ctx(*, instructions: str = '', params: dict[str, Any] | None = None, project_id: str | None = 'p1',
             aggregate: Any = AGGREGATE, persona_ids: Any = PERSONAS, documents: dict | None = None,
             job: Any = JOB_STARTED) -> NodeContext:
    """The context the conductor hands a `deep_research` node (id `n_research`), its `projects`
    call recording into a `Mock` that answers ``job``."""
    node = Node(id='n_research', type='deep_research', title='Deep research (with web)',
                instructions=instructions, role='worker', params=params or {})
    context = run_context(aggregate=aggregate, persona_ids=persona_ids, project_id=project_id, documents=documents)
    ctx = NodeContext(agent=AGENT, run={'run_id': 'ar_1', 'context': context}, node=node,
                      envelope='', claims={'sub': 'owner-sub'})
    ctx.projects = Mock(return_value=job)
    return ctx


def posted_body(ctx: NodeContext) -> dict:
    """The one research POST's body, after asserting the method, route and path parameters."""
    fake = projects_fake(ctx)
    assert fake.call_count == 1
    args, kwargs = fake.call_args
    assert args == ('POST', ROUTE)
    assert kwargs['path_parameters'] == {'project_id': 'p1'}
    assert set(kwargs) == {'body', 'path_parameters'}
    return kwargs['body']


def research_body(**overrides: Any) -> dict:
    return {
        'question': 'Why do carts get abandoned?',
        'title': 'Research: Checkout is slow',
        'categories': ['checkout', 'shipping'],
        'days': 30,
        'selected_persona_ids': ['per_1', 'per_2'],
        'use_web_search': True,
        **overrides,
    }


class TestStartPostsTheResearchRequest:
    def test_the_research_route_is_asked_once_with_the_whole_body(self):
        ctx = node_ctx()

        deep_research.start(ctx)

        projects_fake(ctx).assert_called_once_with(
            'POST', ROUTE, body=research_body(), path_parameters={'project_id': 'p1'})

    def test_the_pending_result_names_the_research(self):
        result = deep_research.start(node_ctx())

        assert result == {
            'node_id': 'n_research', 'status': 'pending',
            'summary': 'Research started',
            'pending': {'project_id': 'p1', 'job_id': 'job_9'},
        }

    def test_without_a_project_nothing_is_posted(self):
        ctx = node_ctx(project_id=None)

        with pytest.raises(NodeFailure, match=r'^no project has been chosen for this run yet$'):
            deep_research.start(ctx)

        projects_fake(ctx).assert_not_called()

    @pytest.mark.parametrize('job', [None, {}, {'job_id': ''}, {'job_id': 7}, 'job_9'])
    def test_a_route_that_starts_no_job_is_refused_after_the_one_post(self, job):
        ctx = node_ctx(job=job)

        with pytest.raises(NodeFailure, match=r'^the route did not start a job$'):
            deep_research.start(ctx)

        assert projects_fake(ctx).call_count == 1


class TestTheQuestionFallsBackInOrder:
    def test_the_node_instructions_win_over_the_aggregate_question(self):
        ctx = node_ctx(instructions='Why is checkout slow on mobile?')

        deep_research.start(ctx)

        body = posted_body(ctx)
        assert body['question'] == 'Why is checkout slow on mobile?'
        assert body['title'] == 'Research: Checkout is slow'

    def test_the_aggregate_question_is_used_when_the_instructions_are_empty(self):
        ctx = node_ctx(instructions='')

        deep_research.start(ctx)

        assert posted_body(ctx)['question'] == 'Why do carts get abandoned?'

    @pytest.mark.parametrize('aggregate', [{}, {'research_question': None}, {'research_question': ''}, None, 'text'])
    def test_the_stock_question_is_used_when_neither_is_set(self, aggregate):
        ctx = node_ctx(aggregate=aggregate)

        deep_research.start(ctx)

        body = posted_body(ctx)
        assert body['question'] == STOCK_QUESTION
        assert body['title'] == f'Research: {STOCK_QUESTION}'

    def test_a_non_string_aggregate_question_is_stringified(self):
        ctx = node_ctx(aggregate={'research_question': 42})

        deep_research.start(ctx)

        body = posted_body(ctx)
        assert body['question'] == '42'
        assert body['title'] == 'Research: 42'

    @pytest.mark.parametrize(('length', 'sent'), [(1999, 1999), (2000, 2000), (2001, 2000), (5000, 2000)])
    def test_the_question_is_cut_at_two_thousand_characters(self, length, sent):
        question = 'q' * length
        ctx = node_ctx(instructions=question)

        deep_research.start(ctx)

        assert posted_body(ctx)['question'] == 'q' * sent


class TestTheTitleComesFromTheAggregate:
    def test_the_aggregate_title_is_prefixed(self):
        ctx = node_ctx(instructions='Why?', aggregate={'title': 'Returns'})

        deep_research.start(ctx)

        assert posted_body(ctx)['title'] == 'Research: Returns'

    @pytest.mark.parametrize('aggregate', [{}, {'title': ''}, {'title': None}])
    def test_without_an_aggregate_title_the_question_is_the_title(self, aggregate):
        ctx = node_ctx(instructions='Why do returns spike in January?', aggregate=aggregate)

        deep_research.start(ctx)

        assert posted_body(ctx)['title'] == 'Research: Why do returns spike in January?'

    def test_a_non_string_title_is_stringified(self):
        ctx = node_ctx(aggregate={'title': 12})

        deep_research.start(ctx)

        assert posted_body(ctx)['title'] == 'Research: 12'

    @pytest.mark.parametrize(('length', 'kept'), [(79, 79), (80, 80), (81, 80), (300, 80)])
    def test_the_title_is_cut_at_eighty_characters_after_the_prefix(self, length, kept):
        ctx = node_ctx(aggregate={'title': 't' * length})

        deep_research.start(ctx)

        assert posted_body(ctx)['title'] == 'Research: ' + 't' * kept

    @pytest.mark.parametrize('length', [81, 2500])
    def test_a_question_used_as_title_is_cut_at_eighty_too(self, length):
        ctx = node_ctx(instructions='x' * length, aggregate={})

        deep_research.start(ctx)

        body = posted_body(ctx)
        assert body['title'] == 'Research: ' + 'x' * 80
        assert body['question'] == 'x' * min(length, 2000)


class TestDaysComeFromTheParams:
    def test_the_default_is_thirty(self):
        ctx = node_ctx(params={})

        deep_research.start(ctx)

        assert posted_body(ctx)['days'] == 30

    @pytest.mark.parametrize('days', [0, 1, 7, 29, 31, 90, 9999])
    def test_an_int_is_passed_through(self, days):
        ctx = node_ctx(params={'days': days})

        deep_research.start(ctx)

        assert posted_body(ctx)['days'] == days

    @pytest.mark.parametrize('days', ['7', 7.5, None, [7], {'days': 7}])
    def test_anything_else_falls_back_to_thirty(self, days):
        ctx = node_ctx(params={'days': days})

        deep_research.start(ctx)

        assert posted_body(ctx)['days'] == 30

    def test_the_module_default_is_thirty(self):
        assert deep_research.DEFAULT_DAYS == 30


class TestWebSearchIsOnOnlyWhenLiterallyTrue:
    def test_absent_means_on(self):
        ctx = node_ctx(params={})

        deep_research.start(ctx)

        assert posted_body(ctx)['use_web_search'] is True

    def test_true_means_on(self):
        ctx = node_ctx(params={'use_web_search': True})

        deep_research.start(ctx)

        assert posted_body(ctx)['use_web_search'] is True

    @pytest.mark.parametrize('value', [False, None, 1, 'true', 'yes', [True]])
    def test_anything_but_true_means_off(self, value):
        ctx = node_ctx(params={'use_web_search': value})

        deep_research.start(ctx)

        assert posted_body(ctx)['use_web_search'] is False


class TestScopeAndPersonasAreForwarded:
    def test_the_agent_scope_is_the_category_list(self):
        ctx = node_ctx()

        deep_research.start(ctx)

        assert posted_body(ctx)['categories'] == ['checkout', 'shipping']

    def test_an_all_categories_scope_sends_an_empty_list(self):
        ctx = node_ctx()
        ctx.agent = {'agent_id': 'ag_1', 'scope': {'all': True, 'categories': ['checkout']}}

        deep_research.start(ctx)

        assert posted_body(ctx)['categories'] == []

    @pytest.mark.parametrize(('count', 'sent'), [(0, 0), (19, 19), (20, 20), (21, 20), (50, 20)])
    def test_at_most_twenty_persona_ids_are_sent_in_order(self, count, sent):
        ids = [f'per_{n}' for n in range(count)]
        ctx = node_ctx(persona_ids=ids)

        deep_research.start(ctx)

        assert posted_body(ctx)['selected_persona_ids'] == ids[:sent]

    @pytest.mark.parametrize('persona_ids', [None, 'per_1', {'per_1': True}])
    def test_persona_ids_that_are_not_a_list_send_none(self, persona_ids):
        ctx = node_ctx(persona_ids=persona_ids)

        deep_research.start(ctx)

        assert posted_body(ctx)['selected_persona_ids'] == []


class TestFinishClaimsTheResearchReport:
    def test_the_done_result_files_the_document_as_the_research(self):
        ctx = node_ctx(documents={'prd': 'd_p'})

        result = deep_research.finish(ctx, JOB_FINISHED)

        assert result == {
            'node_id': 'n_research', 'status': 'done', 'summary': 'Research report written',
            'artifacts': {'project_id': 'p1', 'document_id': 'doc_7', 'document_type': 'research'},
            'updates': {'documents': {'prd': 'd_p', 'research': 'doc_7'}},
        }

    def test_a_second_report_replaces_the_first_in_the_run_context(self):
        result = deep_research.finish(node_ctx(documents={'research': 'doc_old'}), JOB_FINISHED)

        assert result['updates'] == {'documents': {'research': 'doc_7'}}

    def test_without_documents_on_the_run_the_report_is_the_only_one(self):
        result = deep_research.finish(node_ctx(), JOB_FINISHED)

        assert result['updates'] == {'documents': {'research': 'doc_7'}}

    @pytest.mark.parametrize('job', JOBS_WITHOUT_A_DOCUMENT)
    def test_a_job_without_a_document_is_refused(self, job):
        with pytest.raises(NodeFailure, match=r'^the job finished without a document$'):
            deep_research.finish(node_ctx(), job)

    def test_without_a_project_the_finish_is_refused(self):
        with pytest.raises(NodeFailure, match=r'^no project has been chosen for this run yet$'):
            deep_research.finish(node_ctx(project_id=None), JOB_FINISHED)
