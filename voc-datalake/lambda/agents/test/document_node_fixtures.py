"""The run context and recording fakes shared by the document-writing node suites.

`write_prd` and `write_prfaq` are each two one-line delegations to the shared
document writer (`agents/nodes/documents.py`), so the two mutation suites drive
the SAME context through the same writer and differ only in the document type
the node passes and the summaries it answers. What is common lives here: the
aggregate and personas on the run, the node the conductor dispatches, the
`projects` fake that records the one POST, the context-block stubs that make the
POSTed `feature_idea` a literal, and the body the writer builds from all of it.
"""
from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager
from typing import Any
from unittest.mock import Mock, patch

from agents import context_blocks
from agents.graph import Node
from agents.nodes.base import NodeContext

PROJECT = 'p1'
AGENT = {'agent_id': 'ag_1', 'scope': {'all': False, 'categories': ['checkout']}}
AGGREGATE = {
    'title': 'Checkout is slow',
    'problem_summary': 'Users wait at payment.',
    'top_problems': [{'title': 'Slow payment', 'category': 'checkout', 'evidence_count': 3}],
}
PERSONAS = ['per_1', 'per_2']
JOB_STARTED = {'job_id': 'job_9'}
JOB_FINISHED = {'status': 'completed', 'result': {'document_id': 'doc_7'}}
# Every shape of a finished job that carries no document id; each node's `finish` must refuse them all.
JOBS_WITHOUT_A_DOCUMENT = [{}, {'result': {}}, {'result': {'document_id': ''}}, {'result': 'doc_7'}]
_NODE_TITLES = {'prd': 'Write the PRD', 'prfaq': 'Write the PR/FAQ'}


def run_context(*, aggregate: Any = AGGREGATE, persona_ids: Any = PERSONAS, project_id: str | None = PROJECT,
                documents: dict | None = None) -> dict:
    """The `context` of run `ar_1`: the aggregate and persona ids always, the project id only when
    given (a node without a project must refuse), the documents only when the caller has some."""
    context: dict = {'aggregate': aggregate, 'persona_ids': persona_ids}
    if project_id:
        context['project_id'] = project_id
    if documents is not None:
        context['documents'] = documents
    return context


def node_ctx(doc_type: str, *, project_id: str | None = PROJECT, documents: dict | None = None) -> NodeContext:
    """The context the conductor hands a `write_<doc_type>` node (id `n_<doc_type>`), its `projects`
    call recording into a `Mock` that answers the started job."""
    node = Node(id=f'n_{doc_type}', type=f'write_{doc_type}', title=_NODE_TITLES[doc_type], instructions='',
                role='worker', params={})
    ctx = NodeContext(agent=AGENT, run={'run_id': 'ar_1', 'context': run_context(project_id=project_id,
                                                                                  documents=documents)},
                      node=node, envelope='Write it for mobile shoppers.', claims={'sub': 'owner-sub'})
    ctx.projects = Mock(return_value=JOB_STARTED)
    return ctx


def projects_fake(ctx: NodeContext) -> Mock:
    """The recording `projects` fake `node_ctx` installed, narrowed back to its `Mock` type."""
    projects = ctx.projects
    if not isinstance(projects, Mock):
        raise TypeError(f'ctx.projects is not the recording fake node_ctx installs: {type(projects).__name__}')
    return projects


@contextmanager
def stubbed_context_blocks() -> Iterator[None]:
    """The context blocks stubbed so the POSTed ``feature_idea`` is a literal."""
    with (
        patch.object(context_blocks, 'memories', return_value='<memory>M</memory>'),
        patch.object(context_blocks, 'wrap', side_effect=lambda tag, _text, limit: f'<{tag}>{limit}</{tag}>'),
    ):
        yield


def document_post_body(doc_type: str) -> dict:
    """The body the shared writer POSTs to `/projects/p1/document` for the context `node_ctx`
    builds with `documents={'research': 'd_r'}`; `doc_type` is the one key the node owns."""
    return {
        'doc_type': doc_type,
        'title': 'Checkout is slow',
        'feature_idea': '<reviews>4000</reviews>\n\n<memory>M</memory>\n\n'
                        '<conductor_message>6000</conductor_message>',
        'data_sources': {'feedback': True, 'personas': True, 'research': True, 'documents': True},
        'feedback_categories': ['checkout'],
        'days': 30,
        'selected_persona_ids': ['per_1', 'per_2'],
        'selected_document_ids': ['d_r'],
    }
