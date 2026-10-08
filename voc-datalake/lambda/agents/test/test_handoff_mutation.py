"""Mutation hardening for `agents/nodes/handoff.py`.

`test_conductor_run.py` reaches ``handoff`` only as the last node of a scripted
run and pins that the run finishes; the node had no suite of its own. A
mutation run found everything it does unobserved:

* the two project calls — the ``GET /projects/{id}`` read and the
  ``PUT /projects/{id}`` purpose refresh, each with its ``path_parameters``;
* the purpose line — ``Agent run <run_id>: <aggregate title>`` with the
  ``research`` fallback, and the delivered documents upper-cased, joined with
  ``, `` in the fixed PRFAQ → PRD → PROTOTYPE order, in parentheses;
* the refresh rules — no PUT when the line is already in the purpose, an
  absent / non-string / malformed purpose read as empty, the new line appended
  after a newline and the whole stripped, then clipped to its LAST 2,000
  characters;
* the result — the exact summary (``with <docs>`` only when some were
  delivered) and ``artifacts.project_id``.

Every expectation here is the literal string, call or dict the module emits.
"""
from __future__ import annotations

from typing import Any
from unittest.mock import MagicMock, call

import pytest

from agents.graph import Node
from agents.nodes import handoff
from agents.nodes.base import NodeContext, NodeFailure

PROJECT = 'p1'
RUN_ID = 'ar_1'
TITLE = 'Checkout is slow'
ALL_DOCUMENTS = {'prfaq': 'd_f', 'prd': 'd_p', 'prototype': 'd_t', 'research': 'd_r'}
GET = call('GET', '/projects/p1', path_parameters={'project_id': 'p1'})


def _ctx(project: Any, *, documents: dict | None = None, aggregate: Any = None,
         project_id: str | None = PROJECT) -> tuple[NodeContext, MagicMock]:
    """The handoff node's context on run `ar_1`; its `projects` fake answers `project` to the GET."""
    context: dict = {'aggregate': {'title': TITLE} if aggregate is None else aggregate}
    if project_id:
        context['project_id'] = project_id
    if documents is not None:
        context['documents'] = documents
    node = Node(id='n_handoff', type='handoff', title='Hand off', instructions='', role='worker', params={})
    ctx = NodeContext(agent={'agent_id': 'ag_1'}, run={'run_id': RUN_ID, 'context': context}, node=node,
                      envelope='', claims={'sub': 'owner-sub'})
    projects = MagicMock(side_effect=[project, {}])
    ctx.projects = projects
    return ctx, projects


def _put(purpose: str) -> Any:
    return call('PUT', '/projects/p1', body={'purpose': purpose}, path_parameters={'project_id': 'p1'})


class TestTheRunIsRecordedOnTheProject:
    def test_every_delivered_document_is_named_in_order_in_the_purpose_and_the_summary(self):
        ctx, projects = _ctx({'project': {'purpose': 'Old purpose'}}, documents=ALL_DOCUMENTS)

        result = handoff.start(ctx)

        assert projects.call_args_list == [
            GET, _put('Old purpose\nAgent run ar_1: Checkout is slow (PRFAQ, PRD, PROTOTYPE)')]
        assert result == {'node_id': 'n_handoff', 'status': 'done',
                          'summary': 'Handed off project p1 with PRFAQ, PRD, PROTOTYPE',
                          'artifacts': {'project_id': 'p1'}}

    @pytest.mark.parametrize(('documents', 'delivered'), [
        ({'prd': 'd_p'}, 'PRD'),
        ({'prototype': 'd_t', 'prfaq': 'd_f'}, 'PRFAQ, PROTOTYPE'),
        ({'prfaq': 'd_f', 'prd': '', 'prototype': 7}, 'PRFAQ'),
    ])
    def test_only_the_documents_the_run_holds_are_named(self, documents: dict, delivered: str):
        ctx, projects = _ctx({'project': {'purpose': 'Old'}}, documents=documents)

        result = handoff.start(ctx)

        assert projects.call_args_list == [GET, _put(f'Old\nAgent run ar_1: Checkout is slow ({delivered})')]
        assert result['summary'] == f'Handed off project p1 with {delivered}'

    @pytest.mark.parametrize('aggregate', [{}, {'title': ''}, 'not a dict'])
    def test_no_documents_and_no_title_record_a_bare_research_line(self, aggregate: Any):
        ctx, projects = _ctx({'project': {'purpose': 'Old'}}, documents={'research': 'd_r'}, aggregate=aggregate)

        result = handoff.start(ctx)

        assert projects.call_args_list == [GET, _put('Old\nAgent run ar_1: research')]
        assert result == {'node_id': 'n_handoff', 'status': 'done', 'summary': 'Handed off project p1',
                          'artifacts': {'project_id': 'p1'}}


class TestThePurposeRefresh:
    @pytest.mark.parametrize('project', [
        {'project': {}},
        {'project': {'purpose': None}},
        {'project': {'purpose': '   '}},
        {'project': 'not a dict'},
        {},
        None,
    ])
    def test_a_missing_or_malformed_purpose_is_replaced_by_the_line_alone(self, project: Any):
        ctx, projects = _ctx(project)

        handoff.start(ctx)

        assert projects.call_args_list == [GET, _put('Agent run ar_1: Checkout is slow')]

    def test_a_line_already_in_the_purpose_is_not_written_again(self):
        ctx, projects = _ctx({'project': {'purpose': 'Intro\nAgent run ar_1: Checkout is slow\nMore'}})

        result = handoff.start(ctx)

        assert projects.call_args_list == [GET]
        assert result['summary'] == 'Handed off project p1'

    def test_the_purpose_keeps_only_its_last_2000_characters(self):
        purpose = 'a' + 'x' * 1999
        ctx, projects = _ctx({'project': {'purpose': purpose}})

        handoff.start(ctx)

        line = 'Agent run ar_1: Checkout is slow'
        written = 'x' * (2000 - len(line) - 1) + '\n' + line
        assert len(written) == 2000
        assert projects.call_args_list == [GET, _put(written)]


def test_a_run_without_a_project_refuses_before_any_call():
    ctx, projects = _ctx({}, project_id=None)

    with pytest.raises(NodeFailure) as refusal:
        handoff.start(ctx)
    assert str(refusal.value) == 'no project has been chosen for this run yet'
    assert projects.call_args_list == []
