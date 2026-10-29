"""Every PR/FAQ writing step reads the scope's review count, its quotes and the revision brief.

5.35.02 live (run ar_01a1749837876c21150a): the aggregate step read 108 reviews, yet PR/FAQ v3's
Internal FAQ said "I have no customer feedback from the last 30 days, so I can't show complaint
volumes", and no version cited a review count. The agent's ``<reviews>`` block held no count and
no quotes, and the generator put the writer context only into the first (analysis) step: the press
release and both FAQs read only the previous step's output. The same held for a revision's brief
(the persona objections in ``<conductor_message>``).

The prompt is assembled end to end here: the node's POST body (``agents/nodes/documents.py``) into
the generator's chain (``shared/prompts.py`` + ``shared/document_writer_brief.py``).
"""
from __future__ import annotations

from dataclasses import replace
from unittest.mock import patch

import pytest

from agents import context_blocks
from agents.nodes import aggregate_reviews, documents, revise_document, write_prfaq
from agents.test.document_node_fixtures import node_ctx, projects_fake
from shared.document_writer_brief import prompt_feature_idea, with_writer_brief
from shared.prompts import get_prfaq_generation_steps

QUOTE = 'Nobody rebooked me and I slept at the gate'
AGGREGATE = {
    'title': 'Stranded after disruptions',
    'problem_summary': 'Disrupted passengers get no rebooking or care.',
    'top_problems': [{'title': 'No rebooking', 'category': 'support', 'evidence_count': 41}],
    'review_count': 108,
    'days': 30,
    'quotes': [{'problem': 'No rebooking', 'text': QUOTE}],
}
BRIEF = 'Define the delay threshold that assigns a case owner.'
WRITING_STEPS = ('press_release', 'customer_faq', 'internal_faq')
#: The node id of the workflow step → how it starts (write_prfaq or revise_document).
NODES = {
    'prfaq': write_prfaq.start,
    'prfaq_revise': revise_document.start,
    'prfaq_rework': revise_document.start,
}


def _assembled_steps(node_id: str) -> dict[str, dict]:
    ctx = node_ctx('prfaq', documents={'research': 'd_r', 'prfaq': 'd_v1'})
    ctx.context['aggregate'] = AGGREGATE
    ctx.node = replace(ctx.node, id=node_id, params={'target': 'prfaq'})
    ctx.envelope = f'Persona objections to fix: {BRIEF}'
    with patch.object(context_blocks, 'memories', return_value=''):
        NODES[node_id](ctx)
    body = projects_fake(ctx).call_args.kwargs['body']
    steps = with_writer_brief(get_prfaq_generation_steps(
        feature_idea=prompt_feature_idea(body), personas_context='personas', feedback_context='feedback',
    ), body)
    return {step['step_name']: step for step in steps}


@pytest.mark.parametrize('node_id', list(NODES))
@pytest.mark.parametrize('step_name', WRITING_STEPS)
def test_every_writing_step_reads_the_review_count_the_quotes_and_the_brief(node_id, step_name):
    user = _assembled_steps(node_id)[step_name]['user']

    assert '108 customer reviews in scope from the last 30 days' in user
    assert QUOTE in user
    assert '41 reviews' in user
    assert BRIEF in user


@pytest.mark.parametrize('step_name', WRITING_STEPS)
def test_the_writing_steps_ask_for_evidence_backed_numbers_in_a_neutral_voice(step_name):
    system = _assembled_steps('prfaq')[step_name]['system']

    assert 'Never speak as the writer' in system
    assert 'cite its review counts and quote its reviews' in system
    assert 'never claim there is no customer feedback' in system


def test_the_analysis_step_still_reads_the_evidence_once():
    user = _assembled_steps('prfaq')['customer_thinking']['user']

    assert user.count('108 customer reviews in scope') == 1


def test_a_full_brief_is_never_cut_off_by_the_total_budget():
    ctx = node_ctx('prfaq')
    # Every block at (or over) its own cap: far more quotes than fit, the fullest memory block.
    quote = {'problem': 'P', 'text': 'q' * aggregate_reviews.MAX_QUOTE_CHARS}
    ctx.context['aggregate'] = {**AGGREGATE, 'quotes': [quote] * 40}
    ctx.envelope = 'b' * (documents.CONDUCTOR_MESSAGE_CHARS * 2)
    fullest_memory = '<memory>\n' + 'm' * context_blocks.MAX_MEMORY_CHARS + '\n</memory>'
    with patch.object(context_blocks, 'memories', return_value=fullest_memory):
        write_prfaq.start(ctx)
    writer_context = projects_fake(ctx).call_args.kwargs['body']['writer_context']

    assert writer_context.startswith('<reviews>\n108 customer reviews in scope')
    assert writer_context.endswith('</conductor_message>')
