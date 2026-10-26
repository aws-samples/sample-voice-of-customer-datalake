"""Mutation hardening for `agents/nodes/build_prototype.py`.

The node is two one-line delegations to the shared prototype job
(`agents/nodes/prototypes.py`, pinned by `test_nodes_prototypes_mutation.py`).
No suite imported the node itself: the graph and handler suites only name its
type. What the node owns, and what these tests pin through it, is that it
starts a FRESH build — no `base_prototype_id`, no `feedback`, even with an
envelope on the context — answering `Prototype build started`, and that its
finish answers the shared `Prototype built` result for the job's document.

The node is compared with the shared job it must equal; every other
expectation is the literal key set, summary, result or refusal it emits.
"""
from __future__ import annotations

import pytest

from agents.nodes import build_prototype, prototypes
from agents.nodes.base import NodeFailure
from agents.test.document_node_fixtures import (
    JOB_FINISHED,
    JOBS_WITHOUT_A_DOCUMENT,
    PROJECT,
    node_ctx,
    projects_fake,
)

DOCUMENTS = {'prfaq': 'd_pf', 'prd': 'd_prd', 'research': 'd_r'}


class TestStartBuildsAFreshPrototype:
    def test_the_node_is_the_shared_job_with_no_revision_arguments(self):
        node, shared = (node_ctx('prd', documents=DOCUMENTS) for _ in range(2))
        assert build_prototype.start(node) == prototypes.start_prototype(shared)
        assert projects_fake(node).call_args_list == projects_fake(shared).call_args_list

    def test_the_envelope_never_becomes_revision_feedback(self):
        ctx = node_ctx('prd', documents=DOCUMENTS)
        result = build_prototype.start(ctx)
        assert sorted(projects_fake(ctx).call_args.kwargs['body']) == [
            'selected_research_ids', 'source_prd_id', 'source_prfaq_id', 'title', 'use_product_context',
            'use_research']
        assert result['summary'] == 'Prototype build started'

    def test_a_run_without_a_project_is_refused(self):
        ctx = node_ctx('prd', project_id=None)
        with pytest.raises(NodeFailure, match=r'^no project has been chosen for this run yet$'):
            build_prototype.start(ctx)
        projects_fake(ctx).assert_not_called()


class TestFinishRecordsThePrototype:
    def test_the_finished_job_becomes_the_runs_prototype(self):
        ctx = node_ctx('prd', documents={'prfaq': 'd_pf'})
        assert build_prototype.finish(ctx, JOB_FINISHED) == {
            'node_id': 'n_prd', 'status': 'done', 'summary': 'Prototype built',
            'artifacts': {'project_id': PROJECT, 'document_id': 'doc_7', 'document_type': 'prototype'},
            'updates': {'documents': {'prfaq': 'd_pf', 'prototype': 'doc_7'}},
        }

    @pytest.mark.parametrize('job', JOBS_WITHOUT_A_DOCUMENT)
    def test_a_job_without_a_document_is_refused(self, job):
        with pytest.raises(NodeFailure, match=r'^the job finished without a document$'):
            build_prototype.finish(node_ctx('prd'), job)
