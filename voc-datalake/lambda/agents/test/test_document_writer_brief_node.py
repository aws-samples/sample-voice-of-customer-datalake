"""The agent's document step sends a clean feature idea, its prompt blocks apart, and its brief.

5.34.00 live: the PR/FAQ heading was the agent's whole prompt (its DATA blocks were the
``feature_idea``), and "Keep documents short" never reached the writing steps (PR/FAQs of
21-27k characters).
"""
from __future__ import annotations

from dataclasses import replace

import pytest

from agents.nodes import documents
from agents.test.document_node_fixtures import node_ctx, projects_fake, stubbed_context_blocks


def _body(*, agent_instructions: str = '', step_instructions: str = '', params: dict | None = None) -> dict:
    ctx = node_ctx('prfaq')
    ctx.agent = {**ctx.agent, 'instructions': agent_instructions}
    ctx.node = replace(ctx.node, instructions=step_instructions, params={**ctx.node.params, **(params or {})})
    with stubbed_context_blocks():
        documents.start_document(ctx, 'prfaq')
    return projects_fake(ctx).call_args.kwargs['body']


def test_the_feature_idea_is_plain_text_and_the_blocks_travel_as_writer_context():
    body = _body()

    assert '<' not in body['feature_idea']
    assert body['feature_idea'].startswith('Checkout is slow')
    assert body['writer_context'].startswith('<reviews>')
    assert 'writer_instructions' not in body
    assert 'length_budget_words' not in body


def test_keep_documents_short_reaches_the_writer_with_a_length_budget():
    body = _body(agent_instructions='Keep documents short.', step_instructions='Use the research.')

    assert body['writer_instructions'] == 'Keep documents short.\n\nUse the research.'
    assert body['length_budget_words'] == documents.BRIEF_LENGTH_WORDS


@pytest.mark.parametrize('text', ['Sé breve.', 'Bitte kurz halten.', '簡潔に', '짧게 써 주세요', 'Pisz zwięźle.'])
def test_brevity_is_recognised_in_other_languages(text):
    assert _body(agent_instructions=text)['length_budget_words'] == documents.BRIEF_LENGTH_WORDS


def test_a_word_that_only_starts_like_short_is_not_brevity():
    assert 'length_budget_words' not in _body(agent_instructions='List the shortcomings.')


@pytest.mark.parametrize(('max_words', 'sent'), [(800, 800), (50, 200), (99999, 8000)])
def test_the_step_max_words_param_wins_and_is_clamped(max_words, sent):
    body = _body(agent_instructions='Keep it short.', params={'max_words': max_words})

    assert body['length_budget_words'] == sent
