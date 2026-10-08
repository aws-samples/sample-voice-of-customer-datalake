"""Mutation hardening for `agents/nodes/documents.py` (the shared PR/FAQ / PRD writer).

The write_prd, write_prfaq and revise_document suites already pin the POST body
the writer builds for an ordinary run, the summaries and the finished result. A
mutation run over them left nine mutants alive, all at the writer's limits and
overrides, which no ordinary run reaches:

* the ``feature_idea`` is cut at exactly 12,000 characters, and the memories are
  retrieved with the first 800 characters of the aggregate;
* ``params.title`` wins over the aggregate's title, and a title is cut at 120;
* ``params.days`` is sent when it is an int and replaced by 30 otherwise;
* at most 20 persona ids are selected;
* an unsupported document type is refused, naming the type, before any POST.
"""
from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest

from agents import context_blocks
from agents.nodes import documents
from agents.nodes.base import NodeContext, NodeFailure
from agents.test.document_node_fixtures import node_ctx, projects_fake, stubbed_context_blocks


def _posted_body(ctx: NodeContext) -> dict:
    """The body of the one POST the writer made for `ctx`, after starting a PRD."""
    with stubbed_context_blocks():
        documents.start_document(ctx, 'prd')
    return projects_fake(ctx).call_args.kwargs['body']


def _long_reviews_only(tag: str, _text: str, _limit: int) -> str:
    """A `wrap` stub: a 13,000-character reviews block, every other block empty."""
    return 'r' * 13000 if tag == 'reviews' else ''


class TestTheFeatureIdeaIsBounded:
    def test_it_is_cut_at_exactly_twelve_thousand_characters(self):
        ctx = node_ctx('prd')
        with (
            patch.object(context_blocks, 'memories', return_value=''),
            patch.object(context_blocks, 'wrap', side_effect=_long_reviews_only),
        ):
            documents.start_document(ctx, 'prd')

        assert projects_fake(ctx).call_args.kwargs['body']['feature_idea'] == 'r' * 12000

    def test_the_memories_are_retrieved_with_the_first_800_characters_of_the_aggregate(self):
        ctx = node_ctx('prd')
        ctx.context['aggregate'] = {'title': 'T', 'problem_summary': 's' * 1000}
        memories = MagicMock(return_value='')
        with patch.object(context_blocks, 'memories', memories):
            documents.start_document(ctx, 'prd')

        memories.assert_called_once_with({'sub': 'owner-sub'}, 'T\n' + 's' * 798, 'p1')


class TestTheTitle:
    def test_the_node_param_wins_over_the_aggregate(self):
        ctx = node_ctx('prd')
        ctx.node.params['title'] = 'From the param'

        assert _posted_body(ctx)['title'] == 'From the param'

    @pytest.mark.parametrize(('length', 'sent'), [(120, 120), (121, 120)])
    def test_it_is_cut_at_120_characters(self, length, sent):
        ctx = node_ctx('prd')
        ctx.node.params['title'] = 't' * length

        assert _posted_body(ctx)['title'] == 't' * sent


class TestTheDays:
    @pytest.mark.parametrize(('days', 'sent'), [(7, 7), (0, 0), ('7', 30), (None, 30)])
    def test_an_int_param_is_sent_and_anything_else_is_thirty(self, days, sent):
        ctx = node_ctx('prd')
        ctx.node.params['days'] = days

        assert _posted_body(ctx)['days'] == sent


class TestThePersonas:
    def test_at_most_twenty_are_selected(self):
        ctx = node_ctx('prd')
        ctx.context['persona_ids'] = [f'per_{i}' for i in range(21)]

        assert _posted_body(ctx)['selected_persona_ids'] == [f'per_{i}' for i in range(20)]


class TestAnUnsupportedTypeIsRefused:
    def test_the_refusal_names_the_type_and_nothing_is_posted(self):
        ctx = node_ctx('prd')

        with pytest.raises(NodeFailure, match=r'^unsupported document type prototype$'):
            documents.start_document(ctx, 'prototype')

        projects_fake(ctx).assert_not_called()
