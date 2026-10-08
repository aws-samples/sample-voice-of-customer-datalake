"""Mutation hardening for `agents/nodes/select_or_create_project.py`.

`test_runtime_units.py` pinned three owner resolutions and one evidence
weighting; `start` — the node itself — was reached only through the scripted
conductor runs, which assert that a run finishes. A mutation run found
unobserved:

* the evidence weighting — every problem counts at least once, a zero / absent
  count weighs 1, counts accumulate per category, ties go to the first seen,
  and non-dict problems or non-string / empty categories are skipped;
* the owner hand-off — the categories config is read only when there is a
  category, the FIRST matching entry wins, malformed owners are dropped, the
  first owner owns and the rest edit, and the ``SETTINGS#fallback_owner`` row
  (its exact key, a non-string ``sub`` read as none) is the fallback;
* the reuse path — the listing and the exact ``decide_project`` arguments, the
  purpose filled in only when the reused project has none (absent, empty or
  blank), the exact PUT, summary, artifacts and ``project_created: False``;
* the create path — the claims built from the hand-off, the exact POST body and
  visibility (``public`` only when asked), every malformed answer refused with
  the same message, and ``all`` / ``''`` when no category dominates.

Every expectation here is the literal string, call or dict the module emits.
"""
from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager
from typing import Any
from unittest.mock import MagicMock, call, patch

import pytest

from agents import principal
from agents.conductor import planning
from agents.graph import Node
from agents.nodes import select_or_create_project as soc
from agents.nodes.base import NodeContext, NodeFailure
from agents.test.document_node_fixtures import AGENT, AGGREGATE

AGGREGATE_TEXT = 'Checkout is slow\nUsers wait at payment.\n- Slow payment (checkout): 3 reviews'
ENVELOPE = 'Reuse what fits.'
FALLBACK_KEY = {'pk': 'SETTINGS#fallback_owner', 'sk': 'config'}
CATEGORIES_READ = call(Key={'pk': 'SETTINGS#categories', 'sk': 'config'}, ConsistentRead=True)
CREATE = {'action': 'create', 'project_id': None, 'name': 'Checkout', 'description': 'Slow checkout',
          'purpose': 'Fix checkout', 'reason': 'nothing fits'}


def _table(*, categories: Any = None, fallback: Any = None) -> MagicMock:
    """An aggregates table holding the categories config and the fallback-owner row when given."""
    rows: dict[str, Any] = {}
    if categories is not None:
        rows['SETTINGS#categories'] = {'categories': categories}
    if fallback is not None:
        rows['SETTINGS#fallback_owner'] = fallback
    table = MagicMock()
    table.get_item.side_effect = lambda Key, **_: {'Item': rows[Key['pk']]} if Key['pk'] in rows else {}
    return table


@contextmanager
def _aggregates(table: Any) -> Iterator[None]:
    with patch.object(soc, 'get_aggregates_table', return_value=table):
        yield


def _ctx(*, agent: dict | None = None, aggregate: Any = AGGREGATE,
         listing: Any = None) -> tuple[NodeContext, MagicMock]:
    node = Node(id='n_project', type='select_or_create_project', title='Pick a project', instructions='',
                role='orchestrator', params={})
    ctx = NodeContext(agent=agent or AGENT, run={'run_id': 'ar_1', 'context': {'aggregate': aggregate}},
                      node=node, envelope=ENVELOPE, claims={'sub': 'owner-sub'})
    projects = MagicMock(side_effect=[listing, {}])
    ctx.projects = projects
    return ctx, projects


class TestTheDominantCategoryWeighsEvidence:
    @pytest.mark.parametrize(('problems', 'expected'), [
        ([{'category': 'a', 'evidence_count': 1}, {'category': 'b', 'evidence_count': 5},
          {'category': 'a', 'evidence_count': 2}], 'b'),
        ([{'category': 'a', 'evidence_count': 2}, {'category': 'a', 'evidence_count': 2},
          {'category': 'b', 'evidence_count': 3}], 'a'),
        ([{'category': 'a', 'evidence_count': 0}, {'category': 'a'},
          {'category': 'b', 'evidence_count': 1}], 'a'),
        ([{'category': 'a', 'evidence_count': 0}, {'category': 'b', 'evidence_count': 2}], 'b'),
        ([{'category': 'a', 'evidence_count': -4}, {'category': 'b', 'evidence_count': 1}], 'a'),
        ([{'category': 'a', 'evidence_count': 2}, {'category': 'b', 'evidence_count': 2}], 'a'),
        (['a', None, {'category': 5, 'evidence_count': 9}, {'category': '', 'evidence_count': 9},
          {'evidence_count': 9}, {'category': 'z'}], 'z'),
    ])
    def test_the_heaviest_category_wins(self, problems, expected):
        assert soc.dominant_category({'top_problems': problems}) == expected

    @pytest.mark.parametrize('aggregate', [{}, {'top_problems': None}, {'top_problems': []},
                                           {'top_problems': ['a', {'category': ''}]}])
    def test_no_usable_problem_means_no_category(self, aggregate):
        assert soc.dominant_category(aggregate) is None


class TestTheHandoffOwner:
    def test_the_first_owner_owns_and_the_rest_edit(self):
        table = _table(categories=[{'name': 'c', 'owners': [{'sub': 'a'}, {'sub': 'b'}, {'sub': 'c'}]}])
        with _aggregates(table):
            assert soc.resolve_handoff('c') == ('a', ('b', 'c'))
        assert table.get_item.call_args_list == [CATEGORIES_READ]

    def test_the_first_matching_entry_wins_and_malformed_owners_are_dropped(self):
        table = _table(categories=[
            {'name': 'other', 'owners': [{'sub': 'x'}]},
            {'name': 'c', 'owners': ['a', {'sub': 5}, {'sub': ''}, {}, {'sub': 'b'}, {'sub': 'd'}]},
            {'name': 'c', 'owners': [{'sub': 'y'}]},
        ])
        with _aggregates(table):
            assert soc.resolve_handoff('c') == ('b', ('d',))

    def test_a_single_owner_has_no_editors(self):
        with _aggregates(_table(categories=[{'name': 'c', 'owners': [{'sub': 'a'}]}])):
            assert soc.resolve_handoff('c') == ('a', ())

    @pytest.mark.parametrize('owners', [None, [], [{'sub': ''}]])
    def test_an_ownerless_category_uses_the_fallback_owner(self, owners):
        table = _table(categories=[{'name': 'c', 'owners': owners}], fallback={'sub': 'admin-sub'})
        with _aggregates(table):
            assert soc.resolve_handoff('c') == ('admin-sub', ())
        assert table.get_item.call_args_list == [CATEGORIES_READ, call(Key=FALLBACK_KEY)]

    @pytest.mark.parametrize('category', [None, ''])
    def test_no_category_reads_only_the_fallback_owner(self, category):
        table = _table(categories=[{'name': '', 'owners': [{'sub': 'x'}]}], fallback={'sub': 'admin-sub'})
        with _aggregates(table):
            assert soc.resolve_handoff(category) == ('admin-sub', ())
        assert table.get_item.call_args_list == [call(Key=FALLBACK_KEY)]

    @pytest.mark.parametrize('fallback', [None, {'sub': 5}, {'other': 'admin-sub'}])
    def test_no_usable_fallback_means_the_agent_owner(self, fallback):
        with _aggregates(_table(fallback=fallback)):
            assert soc.resolve_handoff('c') == ('', ())

    def test_no_aggregates_table_means_the_agent_owner(self):
        with _aggregates(None):
            assert soc.resolve_handoff('c') == ('', ())


@contextmanager
def _decided(decision: dict) -> Iterator[MagicMock]:
    with patch.object(planning, 'decide_project', return_value=decision) as decide:
        yield decide


REUSE = {'action': 'reuse', 'project_id': 'p9', 'name': 'n', 'description': 'd',
         'purpose': 'Agent purpose', 'reason': 'it fits'}
LISTED = call('GET', '/projects')
PURPOSE_PUT = call('PUT', '/projects/p9', body={'purpose': 'Agent purpose'}, path_parameters={'project_id': 'p9'})


class TestAReusedProject:
    def _start(self, candidates: list) -> tuple[dict, MagicMock]:
        ctx, projects = _ctx(listing={'projects': candidates})
        with _decided(REUSE) as decide, patch.object(principal, 'projects') as post:
            result = soc.start(ctx)
        post.assert_not_called()
        decide.assert_called_once_with(AGENT, 'ar_1', AGGREGATE_TEXT, candidates, ENVELOPE)
        return result, projects

    def test_a_purpose_a_person_wrote_is_kept(self):
        result, projects = self._start(['p9', {'project_id': 'p1'}, {'project_id': 'p9', 'purpose': 'Owned by a person'},
                                        {'project_id': 'p9', 'purpose': ''}])
        assert projects.call_args_list == [LISTED]
        assert result == {'node_id': 'n_project', 'status': 'done', 'summary': 'Reusing project p9: it fits',
                          'artifacts': {'project_id': 'p9'},
                          'updates': {'project_id': 'p9', 'project_created': False}}

    @pytest.mark.parametrize('candidates', [
        [{'project_id': 'p9'}], [{'project_id': 'p9', 'purpose': None}],
        [{'project_id': 'p9', 'purpose': '  \n '}], [{'project_id': 'p1', 'purpose': 'x'}],
    ])
    def test_a_missing_purpose_is_filled_in(self, candidates):
        result, projects = self._start(candidates)
        assert projects.call_args_list == [LISTED, PURPOSE_PUT]
        assert result['updates'] == {'project_id': 'p9', 'project_created': False}

    @pytest.mark.parametrize('listing', [None, ['p9'], {'projects': 'p9'}, {'other': []}])
    def test_a_listing_without_projects_offers_no_candidates(self, listing):
        ctx, projects = _ctx(listing=listing)
        with _decided(REUSE) as decide:
            soc.start(ctx)
        decide.assert_called_once_with(AGENT, 'ar_1', AGGREGATE_TEXT, [], ENVELOPE)
        assert projects.call_args_list == [LISTED, PURPOSE_PUT]


class TestACreatedProject:
    def _start(self, *, answer: Any, agent: dict | None = None, aggregate: Any = AGGREGATE,
               handoff: tuple[str, tuple[str, ...]] = ('a', ('b',))) -> tuple[dict, MagicMock, MagicMock]:
        ctx, projects = _ctx(agent=agent, aggregate=aggregate, listing={'projects': []})
        with (
            _decided(CREATE),
            patch.object(soc, 'resolve_handoff', return_value=handoff) as resolve,
            patch.object(principal, 'agent_claims', return_value={'sub': 'agent:ag_1'}) as claims,
            patch.object(principal, 'projects', return_value=answer) as post,
        ):
            result = soc.start(ctx)
        assert projects.call_args_list == [call('GET', '/projects')]
        claims.assert_called_once_with(ctx.agent, owner_sub=handoff[0], editor_subs=handoff[1])
        return result, resolve, post

    def test_the_dominant_category_owner_gets_the_new_project(self):
        result, resolve, post = self._start(answer={'project': {'project_id': 'p_new'}})
        resolve.assert_called_once_with('checkout')
        post.assert_called_once_with('POST', '/projects', {'sub': 'agent:ag_1'}, body={
            'name': 'Checkout', 'description': 'Slow checkout', 'purpose': 'Fix checkout',
            'visibility': 'private'})
        assert result == {'node_id': 'n_project', 'status': 'done',
                          'summary': 'Created project p_new for category checkout',
                          'artifacts': {'project_id': 'p_new'},
                          'updates': {'project_id': 'p_new', 'project_created': True,
                                      'dominant_category': 'checkout'}}

    def test_no_dominant_category_is_all_categories(self):
        result, resolve, _ = self._start(answer={'project': {'project_id': 'p_new'}}, aggregate=None,
                                         handoff=('', ()))
        resolve.assert_called_once_with(None)
        assert result['summary'] == 'Created project p_new for category all'
        assert result['updates'] == {'project_id': 'p_new', 'project_created': True, 'dominant_category': ''}

    @pytest.mark.parametrize(('output', 'visibility'), [
        ({'visibility': 'public'}, 'public'), ({'visibility': 'private'}, 'private'),
        ({'visibility': 'PUBLIC'}, 'private'), ({}, 'private'), ('public', 'private'),
    ])
    def test_the_project_is_public_only_when_the_agent_asks(self, output, visibility):
        _, _, post = self._start(answer={'project': {'project_id': 'p_new'}},
                                 agent={**AGENT, 'output': output})
        assert post.call_args.kwargs['body']['visibility'] == visibility

    @pytest.mark.parametrize('answer', [None, ['p_new'], {}, {'project': 'p_new'}, {'project': {}},
                                        {'project': {'project_id': ''}}, {'project': {'project_id': 5}}])
    def test_an_answer_without_a_project_id_fails_the_node(self, answer):
        with pytest.raises(NodeFailure) as failure:
            self._start(answer=answer)
        assert str(failure.value) == 'the project could not be created'
