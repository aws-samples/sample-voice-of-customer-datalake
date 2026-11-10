"""The company design system is PROTOTYPE input only.

Research reports and personas read company knowledge through ``shared.job_knowledge``;
with both a company context and a design system configured (moto, real reads), their
grounding carries the company context and never the ``<design_system>`` block. The
PRD / PR-FAQ and prototype cases live in
``jobs/document_generator/test/test_org_context_injection.py``.
"""
from unittest.mock import patch

import pytest
from moto import mock_aws

from research import research_step_handler
from shared import company_context as cc
from shared import tables
from shared.persona_knowledge import persona_grounding
from shared.test.moto_tables import create_pk_sk_table


@pytest.fixture
def configured_aggregates(monkeypatch):
    """An aggregates table with a company vision AND a design system with a ready reference."""
    with mock_aws():
        table = create_pk_sk_table('agg-design-scope')
        table.put_item(Item={'pk': cc.COMPANY_CONTEXT_PK, 'sk': 'config', 'vision': 'Be loved', 'objectives': []})
        table.put_item(Item={'pk': cc.DESIGN_SYSTEM_PK, 'sk': 'config', 'guidelines': 'Dark cards.',
                             'tokens': {'colors': [{'name': 'primary', 'value': '#101010'}], 'typography': []}})
        table.put_item(Item={'pk': cc.DESIGN_SYSTEM_PK, 'sk': 'REF#ref_00000000000a', 'id': 'ref_00000000000a',
                             'kind': 'screenshot', 'title': 'Console', 'status': 'ready', 'created_at': '2026',
                             'extracted_summary': 'A dark-theme developer dashboard'})
        monkeypatch.setenv('AGGREGATES_TABLE', 'agg-design-scope')
        monkeypatch.delenv('MEMORY_TABLE', raising=False)
        monkeypatch.setattr(tables, '_cache', {})
        # Precondition: the design system really is configured and would render.
        assert cc.design_system_block(table)
        yield table


def _assert_company_only(text: str) -> None:
    assert 'Be loved' in text
    assert '<design_system>' not in text
    assert 'developer dashboard' not in text
    assert '#101010' not in text


@pytest.mark.usefixtures('configured_aggregates')
class TestDesignSystemStaysOutOfWrittenDocuments:
    def test_a_persona_generation_reads_the_company_context_without_the_design_system(self):
        _assert_company_only(persona_grounding({}).text)

    def test_a_research_report_reads_the_company_context_without_the_design_system(self):
        with patch.object(research_step_handler, 'get_s3_client'):
            grounding = research_step_handler._research_grounding('job-1', {'question': 'Why churn?'})
        _assert_company_only(grounding.text)
