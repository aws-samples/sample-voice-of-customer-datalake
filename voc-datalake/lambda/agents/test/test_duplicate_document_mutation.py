"""Mutation hardening for `agents/nodes/duplicate_document.py`.

The one earlier test (`test_runtime_units.py::TestNodeGuards`) asked the node to
copy a document into its own project and caught *a* `NodeFailure`. A mutation
run found 36 of the module's 39 mutants alive behind it: every refusal message
could be reworded, every accepted kind could be renamed, the default kind could
stop being `prfaq`, the param keys could be misspelt, and the POST, its body,
its path parameters and the done result could all change shape. Pinned here,
as literals:

* each of `prfaq`, `prd`, `prototype`, `research` is accepted, `prfaq` is the
  default when the node carries no `document` param, and anything else is
  refused as `duplicate_document: unknown document kind` before the target is
  looked at;
* a target that is missing, empty, not a string or the run's own project is
  refused as `duplicate_document needs a different target_project_id`, and a
  run without that kind of document as `there is no <kind> to duplicate yet`,
  each before any POST;
* the one POST is `/projects/{project}/documents/{document}/duplicate` with
  `body={'target_project_id': target}` and both path parameters named;
* a payload that is not a dict, has no `document`, or whose document carries
  no string `document_id` is refused as `the duplicate route returned no
  document`;
* the done result is `<KIND> copied into <target>` with artifacts naming the
  target project, the copy's id and the kind.
"""
from __future__ import annotations

from unittest.mock import Mock

import pytest

from agents.graph import Node
from agents.nodes import duplicate_document
from agents.nodes.base import NodeContext, NodeFailure

PROJECT = 'p1'
TARGET = 'p2'
DOCUMENTS = {'prfaq': 'd_f', 'prd': 'd_p', 'prototype': 'd_t', 'research': 'd_r'}
COPIED = {'document': {'document_id': 'd_copy'}}
# Every shape of an answer from the duplicate route that carries no copied document id.
PAYLOADS_WITHOUT_A_COPY = [None, 'd_copy', {}, {'document': 'd_copy'}, {'document': {}},
                           {'document': {'document_id': ''}}, {'document': {'document_id': 7}}]


def _ctx(params: dict, *, project_id: str | None = PROJECT, documents: dict | None = None,
         payload: object = COPIED) -> NodeContext:
    node = Node(id='n_dup', type='duplicate_document', title='Duplicate', instructions='',
                role='orchestrator', params=params)
    context: dict = {'documents': DOCUMENTS if documents is None else documents}
    if project_id is not None:
        context['project_id'] = project_id
    ctx = NodeContext(agent={'agent_id': 'ag_1'}, run={'run_id': 'ar_1', 'context': context},
                      node=node, envelope='')
    ctx.projects = Mock(return_value=payload)
    return ctx


def _projects(ctx: NodeContext) -> Mock:
    projects = ctx.projects
    assert isinstance(projects, Mock)
    return projects


def _refused(ctx: NodeContext, message: str) -> None:
    with pytest.raises(NodeFailure, match=f'^{message}$'):
        duplicate_document.start(ctx)
    _projects(ctx).assert_not_called()


class TestEveryRefusalNamesItsCause:
    @pytest.mark.parametrize('project_id', [None, ''])
    def test_without_a_project_nothing_is_posted(self, project_id):
        _refused(_ctx({'target_project_id': TARGET}, project_id=project_id),
                 'no project has been chosen for this run yet')

    @pytest.mark.parametrize('kind', ['memo', 'PRD', '', None])
    def test_an_unknown_kind_is_refused_before_the_target_is_checked(self, kind):
        _refused(_ctx({'document': kind, 'target_project_id': TARGET}),
                 'duplicate_document: unknown document kind')

    @pytest.mark.parametrize('params', [
        {}, {'target_project_id': None}, {'target_project_id': ''}, {'target_project_id': 7},
        {'target_project_id': PROJECT},
    ])
    def test_a_missing_empty_foreign_or_own_target_is_refused(self, params):
        _refused(_ctx(params), 'duplicate_document needs a different target_project_id')

    @pytest.mark.parametrize('kind', list(DOCUMENTS))
    def test_a_run_without_that_document_is_refused_by_kind(self, kind):
        documents = {other: DOCUMENTS[other] for other in DOCUMENTS if other != kind}
        _refused(_ctx({'document': kind, 'target_project_id': TARGET}, documents=documents),
                 f'there is no {kind} to duplicate yet')

    @pytest.mark.parametrize('payload', PAYLOADS_WITHOUT_A_COPY)
    def test_an_answer_without_a_copy_is_refused(self, payload):
        ctx = _ctx({'target_project_id': TARGET}, payload=payload)

        with pytest.raises(NodeFailure, match=r'^the duplicate route returned no document$'):
            duplicate_document.start(ctx)

        assert _projects(ctx).call_count == 1


class TestTheCopyIsRequestedAndReported:
    @pytest.mark.parametrize(('kind', 'document_id'), list(DOCUMENTS.items()))
    def test_the_duplicate_route_is_posted_once_for_that_kind(self, kind, document_id):
        ctx = _ctx({'document': kind, 'target_project_id': TARGET})

        duplicate_document.start(ctx)

        _projects(ctx).assert_called_once_with(
            'POST', f'/projects/p1/documents/{document_id}/duplicate',
            body={'target_project_id': 'p2'},
            path_parameters={'project_id': 'p1', 'document_id': document_id})

    @pytest.mark.parametrize(('kind', 'summary'), [
        ('prfaq', 'PRFAQ copied into p2'), ('prd', 'PRD copied into p2'),
        ('prototype', 'PROTOTYPE copied into p2'), ('research', 'RESEARCH copied into p2'),
    ])
    def test_the_done_result_names_the_kind_the_target_and_the_copy(self, kind, summary):
        result = duplicate_document.start(_ctx({'document': kind, 'target_project_id': TARGET}))

        assert result == {
            'node_id': 'n_dup', 'status': 'done', 'summary': summary,
            'artifacts': {'project_id': 'p2', 'document_id': 'd_copy', 'document_type': kind},
        }

    def test_without_a_document_param_the_prfaq_is_copied(self):
        ctx = _ctx({'target_project_id': TARGET}, documents={'prfaq': 'd_f'})

        result = duplicate_document.start(ctx)

        _projects(ctx).assert_called_once_with(
            'POST', '/projects/p1/documents/d_f/duplicate', body={'target_project_id': 'p2'},
            path_parameters={'project_id': 'p1', 'document_id': 'd_f'})
        assert result['summary'] == 'PRFAQ copied into p2'
        assert result['artifacts']['document_type'] == 'prfaq'
