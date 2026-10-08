"""Mutation hardening for `agents/nodes/revise_document.py`.

The only dedicated test before (`test_runtime_units.py`) checked that a revision
without a document raises *some* `NodeFailure`. A mutation run found every
decision of the node unobserved:

* TARGET — `params.target` wins over the run's `last_review_target`, which wins
  over the `prfaq` default; anything outside `prfaq`/`prd` is refused with
  `revise_document can revise a prfaq or a prd` before any POST;
* START — no current version of the target is refused with
  `there is no <target> to revise yet`; otherwise the shared writer is asked for
  a REVISION of exactly that version (it joins the selected documents after the
  research, and the summary says `Revision of the <TARGET> started`);
* FINISH — the job's document is recorded under the SAME resolved target, so a
  revision of the PRD never overwrites the PR/FAQ.

Every expectation is the literal string, dict or call the module emits.
"""
from __future__ import annotations

from typing import Any
from unittest.mock import Mock

import pytest

from agents.graph import Node
from agents.nodes import revise_document
from agents.nodes.base import NodeContext, NodeFailure
from agents.test.document_node_fixtures import (
    AGENT,
    JOB_FINISHED,
    JOB_STARTED,
    JOBS_WITHOUT_A_DOCUMENT,
    PROJECT,
    document_post_body,
    projects_fake,
    run_context,
    stubbed_context_blocks,
)

DOCUMENTS = {'research': 'd_r', 'prfaq': 'prfaq_3', 'prd': 'prd_2'}


def _ctx(*, params: dict[str, Any] | None = None, last_review_target: str | None = None,
         documents: dict | None = None) -> NodeContext:
    """The context the conductor hands a `revise_document` node, its `projects` call recorded."""
    context = run_context(documents=DOCUMENTS if documents is None else documents)
    if last_review_target is not None:
        context['last_review_target'] = last_review_target
    node = Node(id='n_revise', type='revise_document', title='Revise', instructions='', role='worker',
                params=params or {})
    ctx = NodeContext(agent=AGENT, run={'run_id': 'ar_1', 'context': context}, node=node,
                      envelope='Write it for mobile shoppers.', claims={'sub': 'owner-sub'})
    ctx.projects = Mock(return_value=JOB_STARTED)
    return ctx


class TestTheTargetIsResolvedParamThenLastReviewThenPrfaq:
    @pytest.mark.parametrize(('params', 'last_review_target', 'expected'), [
        ({'target': 'prd'}, 'prfaq', 'prd'),
        ({'target': 'prfaq'}, 'prd', 'prfaq'),
        ({}, 'prd', 'prd'),
        ({'target': ''}, 'prd', 'prd'),
        ({}, None, 'prfaq'),
        ({}, '', 'prfaq'),
    ])
    def test_the_revised_document_type(self, params, last_review_target, expected):
        ctx = _ctx(params=params, last_review_target=last_review_target)
        with stubbed_context_blocks():
            result = revise_document.start(ctx)
        assert projects_fake(ctx).call_args.kwargs['body']['doc_type'] == expected
        assert result['summary'] == f'Revision of the {expected.upper()} started'

    @pytest.mark.parametrize(('params', 'last_review_target'), [
        ({'target': 'prototype'}, None),
        ({}, 'prototype'),
        ({'target': 'research'}, 'prd'),
    ])
    def test_anything_but_a_prfaq_or_prd_is_refused_before_any_post(self, params, last_review_target):
        ctx = _ctx(params=params, last_review_target=last_review_target)
        with pytest.raises(NodeFailure) as exc:
            revise_document.start(ctx)
        assert str(exc.value) == 'revise_document can revise a prfaq or a prd'
        projects_fake(ctx).assert_not_called()

    def test_finish_refuses_an_unknown_target_too(self):
        with pytest.raises(NodeFailure) as exc:
            revise_document.finish(_ctx(params={'target': 'prototype'}), JOB_FINISHED)
        assert str(exc.value) == 'revise_document can revise a prfaq or a prd'


class TestStartRevisesTheCurrentVersion:
    @pytest.mark.parametrize(('target', 'documents'), [
        ('prfaq', {'research': 'd_r', 'prd': 'prd_2'}),
        ('prd', {'research': 'd_r', 'prfaq': 'prfaq_3'}),
        ('prd', {'prd': ''}),
    ])
    def test_without_a_current_version_the_refusal_names_the_target(self, target, documents):
        ctx = _ctx(params={'target': target}, documents=documents)
        with pytest.raises(NodeFailure) as exc:
            revise_document.start(ctx)
        assert str(exc.value) == f'there is no {target} to revise yet'
        projects_fake(ctx).assert_not_called()

    @pytest.mark.parametrize(('target', 'previous'), [('prfaq', 'prfaq_3'), ('prd', 'prd_2')])
    def test_the_previous_version_is_selected_after_the_research(self, target, previous):
        ctx = _ctx(params={'target': target})
        with stubbed_context_blocks():
            result = revise_document.start(ctx)
        projects_fake(ctx).assert_called_once_with(
            'POST', f'/projects/{PROJECT}/document',
            body={**document_post_body(target), 'selected_document_ids': ['d_r', previous]},
            path_parameters={'project_id': PROJECT})
        assert result == {'node_id': 'n_revise', 'status': 'pending',
                          'summary': f'Revision of the {target.upper()} started',
                          'pending': {'project_id': PROJECT, 'job_id': 'job_9'}}


class TestFinishRecordsTheRevisionUnderTheResolvedTarget:
    @pytest.mark.parametrize(('params', 'last_review_target', 'target'), [
        ({'target': 'prd'}, 'prfaq', 'prd'),
        ({}, 'prd', 'prd'),
        ({}, None, 'prfaq'),
    ])
    def test_the_new_document_replaces_only_its_own_type(self, params, last_review_target, target):
        result = revise_document.finish(_ctx(params=params, last_review_target=last_review_target), JOB_FINISHED)
        assert result == {
            'node_id': 'n_revise', 'status': 'done', 'summary': f'{target.upper()} written',
            'artifacts': {'project_id': PROJECT, 'document_id': 'doc_7', 'document_type': target},
            'updates': {'documents': {**DOCUMENTS, target: 'doc_7'}},
        }

    @pytest.mark.parametrize('job', JOBS_WITHOUT_A_DOCUMENT)
    def test_a_job_without_a_document_is_refused(self, job):
        with pytest.raises(NodeFailure) as exc:
            revise_document.finish(_ctx(), job)
        assert str(exc.value) == 'the job finished without a document'
