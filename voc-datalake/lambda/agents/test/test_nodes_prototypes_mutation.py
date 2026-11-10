"""Mutation hardening for `agents/nodes/prototypes.py` (shared by build_prototype / revise_prototype).

`test_revise_prototype_mutation.py` pins the one revision body its context
builds, and `test_prototype_pins_flow.py` checks only that the pins reach the
revision brief. A mutation run found the shared job builder's own decisions
unobserved:

* the POSTed body: the `Prototype: ` title cut at 120 characters AFTER the
  prefix, the PR/FAQ and PRD sources dropped when the run has none (`None`
  values are filtered, nothing else is), the research flag and id list driven
  by the run's research document;
* a revision only when `base_prototype_id` is non-empty, its feedback the
  envelope cut at exactly 6000 characters joined to the extra feedback by one
  blank line, an empty part left out (no stray separator);
* the pending summary (`Prototype build started` / `Prototype revision
  started`), the refusal when the route starts no job, and the finished result
  (`Prototype built`, the prototype artifacts, the documents update).

Every expectation is the literal body, call or result the module emits.
"""
from __future__ import annotations

import pytest

from agents.nodes import prototypes
from agents.nodes.base import NodeContext, NodeFailure
from agents.test.document_node_fixtures import (
    JOB_FINISHED,
    JOBS_WITHOUT_A_DOCUMENT,
    PROJECT,
    node_ctx,
    projects_fake,
)

ALL_DOCUMENTS = {'prfaq': 'd_pf', 'prd': 'd_prd', 'research': 'd_r'}
TITLE = 'Prototype: Checkout is slow'


def _ctx(documents: dict | None = None, *, envelope: str | None = None, title: str | None = None) -> NodeContext:
    ctx = node_ctx('prd', documents=documents)
    if envelope is not None:
        ctx.envelope = envelope
    if title is not None:
        ctx.run['context']['aggregate'] = {'title': title}
    return ctx


def _posted_body(ctx: NodeContext) -> dict:
    return projects_fake(ctx).call_args.kwargs['body']


class TestTheBuildBody:
    def test_every_source_on_the_run_is_posted(self):
        ctx = _ctx(ALL_DOCUMENTS)
        result = prototypes.start_prototype(ctx)
        projects_fake(ctx).assert_called_once_with(
            'POST', f'/projects/{PROJECT}/build-prototype',
            body={'title': TITLE, 'source_prfaq_id': 'd_pf', 'source_prd_id': 'd_prd',
                  'use_product_context': True, 'use_research': True, 'selected_research_ids': ['d_r']},
            path_parameters={'project_id': PROJECT})
        assert result == {'node_id': 'n_prd', 'status': 'pending', 'summary': 'Prototype build started',
                          'pending': {'project_id': PROJECT, 'job_id': 'job_9'}}

    def test_missing_sources_are_dropped_and_research_is_off(self):
        ctx = _ctx()
        prototypes.start_prototype(ctx)
        assert _posted_body(ctx) == {'title': TITLE, 'use_product_context': True, 'use_research': False,
                                     'selected_research_ids': []}

    @pytest.mark.parametrize(('length', 'expected'), [(108, 'x' * 108), (109, 'x' * 109), (110, 'x' * 109)])
    def test_the_title_is_cut_at_120_characters_with_its_prefix(self, length, expected):
        ctx = _ctx(title='x' * length)
        prototypes.start_prototype(ctx)
        assert _posted_body(ctx)['title'] == f'Prototype: {expected}'

    @pytest.mark.parametrize('base', [None, ''])
    def test_without_a_base_prototype_there_is_no_revision(self, base):
        ctx = _ctx(ALL_DOCUMENTS)
        result = prototypes.start_prototype(ctx, base_prototype_id=base, extra_feedback='ignored')
        body = _posted_body(ctx)
        assert 'base_prototype_id' not in body
        assert 'feedback' not in body
        assert result['summary'] == 'Prototype build started'


class TestTheRevisionBrief:
    def test_the_envelope_then_one_blank_line_then_the_extra_feedback(self):
        ctx = _ctx()
        result = prototypes.start_prototype(ctx, base_prototype_id='proto_1', extra_feedback='PINS')
        assert _posted_body(ctx) == {'title': TITLE, 'use_product_context': True, 'use_research': False,
                                     'selected_research_ids': [], 'base_prototype_id': 'proto_1',
                                     'feedback': 'Write it for mobile shoppers.\n\nPINS'}
        assert result['summary'] == 'Prototype revision started'

    @pytest.mark.parametrize(('envelope', 'extra', 'feedback'), [
        ('E', '', 'E'),
        ('', 'PINS', 'PINS'),
        ('', '', ''),
    ])
    def test_an_empty_part_leaves_no_separator(self, envelope, extra, feedback):
        ctx = _ctx(envelope=envelope)
        prototypes.start_prototype(ctx, base_prototype_id='proto_1', extra_feedback=extra)
        assert _posted_body(ctx)['feedback'] == feedback

    @pytest.mark.parametrize(('length', 'kept'), [(6000, 6000), (6001, 6000)])
    def test_the_envelope_is_cut_at_6000_characters(self, length, kept):
        ctx = _ctx(envelope='e' * (length - 1) + 'Z')
        prototypes.start_prototype(ctx, base_prototype_id='proto_1')
        assert _posted_body(ctx)['feedback'] == ('e' * (length - 1) + 'Z')[:kept]


class TestTheJob:
    @pytest.mark.parametrize('payload', [{}, {'job_id': ''}, None])
    def test_a_route_that_starts_no_job_is_refused(self, payload):
        ctx = _ctx()
        projects_fake(ctx).return_value = payload
        with pytest.raises(NodeFailure) as exc:
            prototypes.start_prototype(ctx)
        assert str(exc.value) == 'the route did not start a job'

    def test_a_run_without_a_project_is_refused_before_any_call(self):
        ctx = node_ctx('prd', project_id=None)
        with pytest.raises(NodeFailure) as exc:
            prototypes.start_prototype(ctx)
        assert str(exc.value) == 'no project has been chosen for this run yet'
        projects_fake(ctx).assert_not_called()

    def test_the_finished_job_records_the_prototype(self):
        assert prototypes.finish_prototype(_ctx(ALL_DOCUMENTS), JOB_FINISHED) == {
            'node_id': 'n_prd', 'status': 'done', 'summary': 'Prototype built',
            'artifacts': {'project_id': PROJECT, 'document_id': 'doc_7', 'document_type': 'prototype'},
            'updates': {'documents': {**ALL_DOCUMENTS, 'prototype': 'doc_7'}},
        }

    @pytest.mark.parametrize('job', JOBS_WITHOUT_A_DOCUMENT)
    def test_a_job_without_a_document_is_refused(self, job):
        with pytest.raises(NodeFailure) as exc:
            prototypes.finish_prototype(_ctx(), job)
        assert str(exc.value) == 'the job finished without a document'
