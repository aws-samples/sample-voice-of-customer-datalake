"""The company context and design system reach PRD / PR-FAQ and prototype prompts
as DATA blocks — and leave the prompts untouched when nothing is configured (the
byte-identical case is also pinned by the golden prototype prompt)."""
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

COMPANY = '<company_context>\nDATA\n\nCompany vision:\nBe loved\n</company_context>'
DESIGN = '<design_system>\nDATA\n\nDesign tokens:\nColours: primary = #FF5A5F\n</design_system>'


def _blocks(company='', design=''):
    return patch.object(handler, '_org_context_blocks', return_value=(company, design))


class TestWithOrgContext:
    def test_unchanged_when_nothing_configured(self):
        with _blocks():
            assert handler._with_org_context('PRODUCT') == 'PRODUCT'

    def test_appends_present_blocks_in_order(self):
        with _blocks(COMPANY, DESIGN):
            assert handler._with_org_context('PRODUCT') == f'PRODUCT\n\n{COMPANY}\n\n{DESIGN}'
        with _blocks(design=DESIGN):
            assert handler._with_org_context('PRODUCT') == f'PRODUCT\n\n{DESIGN}'

    def test_reads_the_aggregates_table(self, monkeypatch):
        monkeypatch.setenv('AGGREGATES_TABLE', 'agg')
        with patch.object(handler, 'company_context_block', return_value=COMPANY) as company, \
                patch.object(handler, 'design_system_block', return_value='') as design, \
                patch.object(handler, 'get_dynamodb_resource') as resource:
            assert handler._org_context_blocks() == (COMPANY, '')
        resource.return_value.Table.assert_called_once_with('agg')
        company.assert_called_once()
        design.assert_called_once()

    def test_no_table_env_means_no_blocks(self, monkeypatch):
        monkeypatch.delenv('AGGREGATES_TABLE', raising=False)
        assert handler._org_context_blocks() == ('', '')


class TestPrdChain:
    def test_build_steps_carry_the_blocks(self, monkeypatch):
        captured = {}

        def builder(**kwargs):
            captured.update(kwargs)
            return [{'system': '', 'user': 'u'}]

        monkeypatch.setattr(handler, 'get_prd_generation_steps', builder)
        monkeypatch.setattr(handler, 'get_versioned_document_by_allocation', lambda *_a, **_k: None)
        monkeypatch.setattr(handler, '_gather_context', lambda *_a, **_k: handler.GatheredContext('', '', {
            'sources': [], 'selected_document_count': 0, 'feedback_count': 0, 'persona_ids': []},
            handler.NO_FEEDBACK))
        monkeypatch.setattr(handler, '_product_context', lambda _pid: (handler.NO_PRODUCT_CONTEXT, False))
        monkeypatch.setattr(handler, '_put_text', lambda key, _text: key)
        monkeypatch.setattr(handler, 'get_dynamodb_resource', MagicMock)
        monkeypatch.setattr(handler.JobContext, 'update_progress', lambda *_a, **_k: None)
        with _blocks(COMPANY, DESIGN):
            handler._build_steps('p1', 'j1', {'doc_type': 'prd', 'feature_idea': 'x'})
        assert captured['product_context'] == f'{handler.NO_PRODUCT_CONTEXT}\n\n{COMPANY}\n\n{DESIGN}'


class TestPrototypePrompt:
    @pytest.mark.usefixtures('mock_jobs_table', 'mock_s3')
    def test_design_system_and_company_context_reach_the_prompt(
        self, mock_dynamodb, mock_converse, sample_job_event, lambda_context,
    ):
        wire_projects_table(mock_dynamodb, prd_pages=[{'Items': [PRD_NEW]}], prfaq_pages=[{'Items': []}])
        mock_converse.return_value = HTML
        with _blocks(COMPANY, DESIGN):
            run_prototype_build(sample_job_event, lambda_context, brand='ACME')
        prompt = prompt_sent(mock_converse)
        assert DESIGN in prompt
        assert handler.DESIGN_SYSTEM_INSTRUCTION in prompt
        assert COMPANY in prompt
        assert handler.COMPANY_CONTEXT_INSTRUCTION in prompt
        # Beside BRAND, before the spec it styles.
        assert prompt.index('BRAND: ACME') < prompt.index('<design_system>') < prompt.index('PRD:')
        # The system prompt is untouched: the binding instruction is user-turn DATA guidance.
        assert mock_converse.call_args.kwargs['system_prompt'] == handler.PROTOTYPE_HTML_SYSTEM_PROMPT

    @pytest.mark.usefixtures('mock_jobs_table', 'mock_s3')
    def test_nothing_configured_adds_nothing(self, mock_dynamodb, mock_converse, sample_job_event, lambda_context):
        wire_projects_table(mock_dynamodb, prd_pages=[{'Items': [PRD_NEW]}], prfaq_pages=[{'Items': []}])
        mock_converse.return_value = HTML
        with _blocks():
            run_prototype_build(sample_job_event, lambda_context)
        prompt = prompt_sent(mock_converse)
        assert '<design_system>' not in prompt
        assert '<company_context>' not in prompt
        assert handler.DESIGN_SYSTEM_INSTRUCTION not in prompt
