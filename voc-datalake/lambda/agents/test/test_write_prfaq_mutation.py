"""Mutation hardening for `agents/nodes/write_prfaq.py`.

The one earlier test that imported the node (`test_runtime_units.py::
TestNodeGuards::test_nodes_need_a_project`) called `start` without a project and
expected `NodeFailure` — which `start_document` also raises for an UNKNOWN
document type, before it ever looks at the project. So a mutation run found the
node's whole contribution unobserved: both `'prfaq'` literals could be replaced
and every test stayed green. Pinned here, as literals:

* `start` POSTs `/projects/{id}/document` once with `doc_type: 'prfaq'` (and the
  rest of the body the shared writer builds) and answers the pending result
  whose summary is `Writing of the PRFAQ started`;
* `finish` answers the done result whose summary is `PRFAQ written`, whose
  artifacts claim `document_type: 'prfaq'`, and whose updates file the document
  under `documents.prfaq` next to the documents already on the run;
* without a project both the refusal message and the absence of any POST.

The run context, the recording `projects` fake and the POST body the shared
writer builds come from `document_node_fixtures` (the PRD suite drives the same
writer through the same context).
"""
from __future__ import annotations

import pytest

from agents.nodes import write_prfaq
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


class TestStartWritesAPrfaq:
    def test_the_document_route_is_asked_for_a_prfaq(self):
        ctx = node_ctx('prfaq', documents={'research': 'd_r'})

        write_prfaq.start(ctx)

        projects_fake(ctx).assert_called_once_with(
            'POST', '/projects/p1/document', body=document_post_body('prfaq'), path_parameters={'project_id': 'p1'})

    def test_the_pending_result_names_the_prfaq(self):
        result = write_prfaq.start(node_ctx('prfaq'))

        assert result == {
            'node_id': 'n_prfaq', 'status': 'pending',
            'summary': 'Writing of the PRFAQ started',
            'pending': {'project_id': 'p1', 'job_id': 'job_9'},
        }

    def test_without_a_project_nothing_is_posted(self):
        ctx = node_ctx('prfaq', project_id=None)

        with pytest.raises(NodeFailure, match=r'^no project has been chosen for this run yet$'):
            write_prfaq.start(ctx)

        projects_fake(ctx).assert_not_called()


class TestFinishClaimsThePrfaq:
    def test_the_done_result_files_the_document_as_the_prfaq(self):
        ctx = node_ctx('prfaq', documents={'research': 'd_r'})

        result = write_prfaq.finish(ctx, JOB_FINISHED)

        assert result == {
            'node_id': 'n_prfaq', 'status': 'done', 'summary': 'PRFAQ written',
            'artifacts': {'project_id': 'p1', 'document_id': 'doc_7', 'document_type': 'prfaq'},
            'updates': {'documents': {'research': 'd_r', 'prfaq': 'doc_7'}},
        }

    def test_a_second_prfaq_replaces_the_first_in_the_run_context(self):
        result = write_prfaq.finish(node_ctx('prfaq', documents={'prfaq': 'doc_old'}), JOB_FINISHED)

        assert result['updates'] == {'documents': {'prfaq': 'doc_7'}}

    @pytest.mark.parametrize('job', JOBS_WITHOUT_A_DOCUMENT)
    def test_a_job_without_a_document_is_refused(self, job):
        with pytest.raises(NodeFailure, match=r'^the job finished without a document$'):
            write_prfaq.finish(node_ctx('prfaq'), job)
