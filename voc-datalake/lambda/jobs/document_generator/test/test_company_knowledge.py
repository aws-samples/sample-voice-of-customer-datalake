"""PR/FAQ, PRD and prototypes carry company knowledge — and only company knowledge.

The grounding (company context + COMPANY memories, shared.job_knowledge) is
asked for under the job starter's category scope, reaches the user prompt as
DATA beside the design system, adds GROUNDING_GUIDANCE to every system prompt,
and is recorded in the derivation. A shared document never reads a user's own
objectives: the company context is read without a sub.
"""
import json
from unittest.mock import MagicMock, patch

import pytest

from jobs.document_generator import handler
from jobs.document_generator.test.prototype_table_fixtures import (
    HTML,
    PRD_NEW,
    prompt_sent,
    run_prototype_build,
    wire_projects_table,
)
from shared.grounding import GROUNDING_GUIDANCE, Grounding

KNOWLEDGE = '<company_context>\nVision\n</company_context>\n\n<memory>\n- (company) Refunds in 48 h\n</memory>'
GROUNDED = Grounding(text=KNOWLEDGE, memory_ids=['mem_1'], company_context_included=True)
SCOPE = {'all': False, 'categories': ['billing']}


class TestDocumentGrounding:
    def test_asked_for_the_feature_idea_under_the_starter_scope(self, no_company_knowledge):
        handler._document_grounding({'feature_idea': 'Faster refunds', 'title': 'T', 'category_scope': SCOPE})
        no_company_knowledge.assert_called_once_with('Faster refunds', SCOPE)

    def test_falls_back_to_the_title_then_the_given_query(self, no_company_knowledge):
        handler._document_grounding({'title': 'Refund PRD'})
        handler._document_grounding({}, fallback_query='Prototype: Shop')
        assert [c.args for c in no_company_knowledge.call_args_list] == [('Refund PRD', None), ('Prototype: Shop', None)]

    def test_the_legacy_company_block_is_read_without_a_sub(self, monkeypatch):
        monkeypatch.setenv('AGGREGATES_TABLE', 'agg')
        with patch.object(handler, 'company_context_block', return_value='C') as company, \
                patch.object(handler, 'design_system_block', return_value=''), \
                patch.object(handler, 'get_dynamodb_resource'):
            handler._org_context_blocks()
        assert (len(company.call_args.args), company.call_args.kwargs) == (1, {})

    def test_a_grounding_replaces_the_company_block(self):
        with patch.object(handler, 'company_context_block') as company, \
                patch.object(handler, 'design_system_block', return_value='<design_system/>'):
            assert handler._org_context_blocks(GROUNDED) == (KNOWLEDGE, '<design_system/>')
        company.assert_not_called()


class TestChainSteps:
    def test_guidance_joins_every_system_prompt_only_when_grounded(self):
        steps = [{'system': 'A', 'user': 'u'}, {'user': 'v'}]
        assert handler._with_step_guidance(steps, Grounding()) is steps
        guided = handler._with_step_guidance(steps, GROUNDED)
        assert [s['system'] for s in guided] == [f'A\n\n{GROUNDING_GUIDANCE}', GROUNDING_GUIDANCE]

    def test_gather_stashes_the_knowledge_in_the_prompt_and_the_derivation(self, monkeypatch, no_company_knowledge):
        no_company_knowledge.return_value = GROUNDED
        captured, puts = {}, {}

        def builder(**kwargs):
            captured.update(kwargs)
            return [{'system': 'SYS', 'user': 'u'}]

        empty_inputs = {'sources': [], 'persona_ids': []}
        stubs = {
            'get_prd_generation_steps': builder,
            'get_versioned_document_by_allocation': MagicMock(return_value=None),
            '_gather_context': MagicMock(return_value=handler.GatheredContext(
                '', '', empty_inputs, handler.NO_FEEDBACK)),
            '_product_context': MagicMock(return_value=('PRODUCT', False)),
            '_put_text': puts.__setitem__,
            'design_system_block': MagicMock(return_value=''),
            'get_dynamodb_resource': MagicMock(),
            'JobContext': MagicMock(),
        }
        for name, value in stubs.items():
            monkeypatch.setattr(handler, name, value)
        handler._build_steps('p1', 'j1', {'doc_type': 'prd', 'feature_idea': 'x'})
        steps = json.loads(puts['scratch/document_jobs/j1/steps.txt'])
        derivation = json.loads(puts['scratch/document_jobs/j1/derivation.txt'])
        assert captured['product_context'] == f'PRODUCT\n\n{KNOWLEDGE}'
        assert steps[0]['system'] == f'SYS\n\n{GROUNDING_GUIDANCE}'
        assert (derivation['memory_ids'], derivation['company_context_included']) == (['mem_1'], True)


class TestPrototype:
    @pytest.mark.usefixtures('mock_jobs_table', 'mock_s3')
    def test_knowledge_reaches_the_prompt_the_guidance_and_the_derivation(
        self, mock_dynamodb, mock_converse, sample_job_event, lambda_context, no_company_knowledge,
    ):
        no_company_knowledge.return_value = GROUNDED
        wire_projects_table(mock_dynamodb, prd_pages=[{'Items': [PRD_NEW]}], prfaq_pages=[{'Items': []}])
        mock_converse.return_value = HTML
        with patch.object(handler, 'design_system_block', return_value=''), \
                patch.object(handler, 'persist_versioned_document',
                             return_value={'document_id': 'd', 'title': 't'}) as persist:
            run_prototype_build(sample_job_event, lambda_context)
        assert KNOWLEDGE in prompt_sent(mock_converse)
        assert mock_converse.call_args.kwargs['system_prompt'].endswith(GROUNDING_GUIDANCE)
        derivation = persist.call_args.args[5][handler.DERIVATION_FIELD]
        assert (derivation['memory_ids'], derivation['company_context_included']) == (['mem_1'], True)
