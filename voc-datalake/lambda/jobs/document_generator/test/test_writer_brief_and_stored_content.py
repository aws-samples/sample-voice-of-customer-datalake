"""A PR/FAQ never starts with the writer's prompt, and the writer reads the requester's brief.

5.34.00 live: every agent-written PR/FAQ began with ``# PR/FAQ: <reviews>…</reviews><memory>…
<conductor_message>Run ar_… project proj_…`` — the agent sent its DATA blocks as the
``feature_idea`` and the generator used the feature idea as the document heading. The heading is
now the title, the blocks travel as ``writer_context`` (prompt only), and the save strips any DATA
block whatever echoed it. The agent's "Keep documents short" reached only the first, analysis,
step; ``writer_instructions`` and ``length_budget_words`` now reach every writing step.
"""
from __future__ import annotations

from unittest.mock import MagicMock, patch

from jobs.document_generator import handler as H
from shared.document_writer_brief import clean_stored_text, with_writer_brief
from shared.prompts import get_prfaq_generation_steps

AGENT_CONTEXT = (
    '<reviews>\nRefunds take weeks\n</reviews>\n\n<memory>\n- (company) refunds matter\n</memory>\n\n'
    '<conductor_message>\n[sent by conductor]\nRun ar_1 · step 7: Write the PR/FAQ (write_prfaq)\n'
    'Run so far: project proj_1\n</conductor_message>'
)
RESULTS = ['thinking', '### Refunds in a day\n\nThe release.', 'Q: When?\nA: Now.', 'Q: Cost?\nA: Low.']


def _generate(doc_config: dict) -> tuple[str, MagicMock]:
    chain = MagicMock(return_value=RESULTS)
    with patch.object(H, 'converse_chain', chain):
        content, _ = H._generate_chain_document(
            MagicMock(), H.CHAIN_DOC_TYPES['prfaq'], str(doc_config.get('feature_idea') or ''),
            'feedback', 'personas', doc_config, 'product',
        )
    return content, chain


class TestAnAgentPrfaqStartsWithItsTitle:
    def test_the_heading_is_the_title_and_no_prompt_block_reaches_the_content(self):
        content, chain = _generate({'title': 'Refunds in a day', 'feature_idea': 'Refunds are slow.',
                                    'writer_context': AGENT_CONTEXT})

        assert content.startswith('# PR/FAQ: Refunds in a day\n\n## Press Release')
        for leaked in ('<reviews', 'ar_1', 'proj_1'):
            assert leaked not in content
        first_prompt = chain.call_args.args[0][0]['user']
        assert 'Refunds take weeks' in first_prompt  # the context still reaches the writer

    def test_a_feature_idea_carrying_blocks_never_becomes_the_heading(self):
        content, _ = _generate({'title': 'Refunds in a day', 'feature_idea': AGENT_CONTEXT})

        assert content.splitlines()[0] == '# PR/FAQ: Refunds in a day'


class TestTheSaveGuard:
    def test_a_stored_document_keeps_no_data_block(self):
        fields = H._document_item_fields(
            'p1', 'job_1', AGENT_CONTEXT, f'# PR/FAQ: {AGENT_CONTEXT}\n\n## Press Release\n\nText < 5 days.',
            {}, {}, {}, {},
        )

        for key in ('content', 'feature_idea'):
            for tag in ('<reviews', '</reviews', '<memory', '<conductor_message'):
                assert tag not in fields[key]
        assert fields['content'].endswith('## Press Release\n\nText < 5 days.')

    def test_text_without_a_data_tag_is_stored_unchanged(self):
        text = '# PR/FAQ: Fast\n\nUse <b>bold</b> and a < b.\n'
        assert clean_stored_text(text) == text

    def test_a_stray_or_unclosed_tag_is_removed(self):
        assert clean_stored_text('A <Memory > B </ reviews> C') == 'A  B  C'


class TestTheWriterBrief:
    def test_instructions_and_the_length_budget_reach_every_writing_step(self):
        steps = with_writer_brief(
            get_prfaq_generation_steps(feature_idea='x', personas_context='', feedback_context=''),
            {'writer_instructions': 'Keep documents short.', 'length_budget_words': 1200},
        )
        by_name = {step['step_name']: step for step in steps}

        for name in ('customer_thinking', 'press_release', 'customer_faq', 'internal_faq'):
            assert 'Keep documents short.' in by_name[name]['user']
        assert 'about 1200 words in total, and this part within about 600 words' in by_name['press_release']['system']
        assert 'this part within about 300 words' in by_name['internal_faq']['system']
        assert 'LENGTH BUDGET' not in by_name['customer_thinking']['system']

    def test_an_out_of_range_budget_or_a_non_int_is_ignored(self):
        steps = get_prfaq_generation_steps(feature_idea='x', personas_context='', feedback_context='')
        for budget in (10, 99999, '1200', True):
            assert with_writer_brief(steps, {'length_budget_words': budget}) == steps

    def test_the_chain_runs_with_the_brief(self):
        _, chain = _generate({'title': 'T', 'feature_idea': 'f', 'writer_instructions': 'Two pages at most.',
                              'length_budget_words': 900})

        press = chain.call_args.args[0][1]
        assert 'Two pages at most.' in press['user']
        assert 'about 900 words' in press['system']
