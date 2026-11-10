"""The build dialog's "Design system" option (``use_design_system``) on the prototype prompt.

On (or absent — every caller before the option existed) → the ``<design_system>`` DATA block
and its binding instruction reach the prompt; explicit False → neither does, while the company
context still does; nothing configured → no block and no error. The derivation records the
outcome so a revision can inherit it.
"""
from unittest.mock import patch

import pytest

from jobs.document_generator import handler
from jobs.document_generator.test.prototype_table_fixtures import (
    HTML,
    PRD_NEW,
    prompt_sent,
    run_prototype_build,
    saved_item,
    wire_projects_table,
)
from shared.grounding import Grounding
from shared.scope_names import HIDE_ALL

COMPANY = '<company_context>\nDATA\n\nCompany vision:\nBe loved\n</company_context>'
DESIGN = '<design_system>\nDATA\n\nDesign tokens:\nColours: primary = #FF5A5F\n</design_system>'


def _blocks(company='', design=''):
    return patch.object(handler, '_org_context_blocks', return_value=(company, design))


def _build(mock_dynamodb, mock_converse, sample_job_event, lambda_context, **config):
    wire_projects_table(mock_dynamodb, prd_pages=[{'Items': [PRD_NEW]}], prfaq_pages=[{'Items': []}])
    mock_converse.return_value = HTML
    run_prototype_build(sample_job_event, lambda_context, **config)
    return prompt_sent(mock_converse), saved_item(mock_dynamodb)[handler.DERIVATION_FIELD]


@pytest.mark.usefixtures('mock_jobs_table', 'mock_s3')
class TestUseDesignSystem:
    @pytest.mark.parametrize('config', [{}, {'use_design_system': True}])
    def test_on_or_absent_puts_the_block_and_instruction_in_the_prompt(
        self, config, mock_dynamodb, mock_converse, sample_job_event, lambda_context,
    ):
        with _blocks(COMPANY, DESIGN):
            prompt, derivation = _build(mock_dynamodb, mock_converse, sample_job_event, lambda_context, **config)
        assert f'{DESIGN}\n\n{handler.DESIGN_SYSTEM_INSTRUCTION}' in prompt
        assert derivation['design_system_included'] is True

    def test_off_leaves_the_design_system_out_but_keeps_the_company_context(
        self, mock_dynamodb, mock_converse, sample_job_event, lambda_context,
    ):
        with _blocks(COMPANY, DESIGN):
            prompt, derivation = _build(mock_dynamodb, mock_converse, sample_job_event, lambda_context,
                                        use_design_system=False)
        assert '<design_system>' not in prompt
        assert handler.DESIGN_SYSTEM_INSTRUCTION not in prompt
        assert COMPANY in prompt
        assert derivation['design_system_included'] is False

    def test_none_configured_adds_nothing_and_records_nothing(
        self, mock_dynamodb, mock_converse, sample_job_event, lambda_context,
    ):
        with _blocks(COMPANY, ''):
            prompt, derivation = _build(mock_dynamodb, mock_converse, sample_job_event, lambda_context,
                                        use_design_system=True)
        assert '<design_system>' not in prompt
        assert handler.DESIGN_SYSTEM_INSTRUCTION not in prompt
        assert 'design_system_included' not in derivation


class TestScopedDesignBlock:
    def test_the_jobs_scope_reaches_the_design_system_read(self, monkeypatch):
        monkeypatch.setenv('AGGREGATES_TABLE', 'agg')
        with patch.object(handler, 'design_system_block', return_value='') as design, \
                patch.object(handler, 'get_dynamodb_resource'):
            handler._org_context_blocks(Grounding(text=COMPANY, hidden=HIDE_ALL))
        assert design.call_args.args[1] is HIDE_ALL

    def test_no_grounding_reads_unscoped(self, monkeypatch):
        monkeypatch.setenv('AGGREGATES_TABLE', 'agg')
        with patch.object(handler, 'design_system_block', return_value='') as design, \
                patch.object(handler, 'company_context_block', return_value=''), \
                patch.object(handler, 'get_dynamodb_resource'):
            handler._org_context_blocks()
        assert design.call_args.args[1] is None
