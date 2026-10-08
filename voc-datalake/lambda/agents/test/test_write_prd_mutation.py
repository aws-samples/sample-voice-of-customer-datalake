"""Mutation hardening for `agents/nodes/write_prd.py`.

No earlier test imported the node at all, so a mutation run found its whole
contribution unobserved: both `'prd'` literals could be replaced (by `'XXprdXX'`,
which `start_document` refuses, or by `None`) and every test stayed green. The
node is two one-line delegations to the shared document writer, so what it owns
is exactly the document type it passes. Pinned here, as literals:

* `start` POSTs `/projects/{id}/document` once with `doc_type: 'prd'` (and the
  rest of the body the shared writer builds) and answers the pending result
  whose summary is `Writing of the PRD started`;
* `finish` answers the done result whose summary is `PRD written`, whose
  artifacts claim `document_type: 'prd'`, and whose updates file the document
  under `documents.prd` next to the documents already on the run;
* without a project both the refusal message and the absence of any POST.

The run context, the recording `projects` fake and the POST body the shared
writer builds come from `document_node_fixtures` (the PR/FAQ suite drives the
same writer through the same context).
"""
from __future__ import annotations

import pytest

from agents.nodes import write_prd
from agents.nodes.base import NodeFailure
from agents.test.document_node_fixtures import (
    JOB_FINISHED,
    JOBS_WITHOUT_A_DOCUMENT,
    document_post_body,
    node_ctx,
    projects_fake,
    stubbed_context_blocks,
)


@pytest.fixture(autouse=True)
def blocks():
    with stubbed_context_blocks():
        yield


class TestStartWritesAPrd:
    def test_the_document_route_is_asked_for_a_prd(self):
        ctx = node_ctx('prd', documents={'research': 'd_r'})

        write_prd.start(ctx)

        projects_fake(ctx).assert_called_once_with(
            'POST', '/projects/p1/document', body=document_post_body('prd'), path_parameters={'project_id': 'p1'})

    def test_the_pending_result_names_the_prd(self):
        result = write_prd.start(node_ctx('prd'))

        assert result == {
            'node_id': 'n_prd', 'status': 'pending',
            'summary': 'Writing of the PRD started',
            'pending': {'project_id': 'p1', 'job_id': 'job_9'},
        }

    def test_without_a_project_nothing_is_posted(self):
        ctx = node_ctx('prd', project_id=None)

        with pytest.raises(NodeFailure, match=r'^no project has been chosen for this run yet$'):
            write_prd.start(ctx)

        projects_fake(ctx).assert_not_called()


class TestFinishClaimsThePrd:
    def test_the_done_result_files_the_document_as_the_prd(self):
        ctx = node_ctx('prd', documents={'prfaq': 'd_f'})

        result = write_prd.finish(ctx, JOB_FINISHED)

        assert result == {
            'node_id': 'n_prd', 'status': 'done', 'summary': 'PRD written',
            'artifacts': {'project_id': 'p1', 'document_id': 'doc_7', 'document_type': 'prd'},
            'updates': {'documents': {'prfaq': 'd_f', 'prd': 'doc_7'}},
        }

    def test_a_second_prd_replaces_the_first_in_the_run_context(self):
        result = write_prd.finish(node_ctx('prd', documents={'prd': 'doc_old'}), JOB_FINISHED)

        assert result['updates'] == {'documents': {'prd': 'doc_7'}}

    @pytest.mark.parametrize('job', JOBS_WITHOUT_A_DOCUMENT)
    def test_a_job_without_a_document_is_refused(self, job):
        with pytest.raises(NodeFailure, match=r'^the job finished without a document$'):
            write_prd.finish(node_ctx('prd'), job)
