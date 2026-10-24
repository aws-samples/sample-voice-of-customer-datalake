"""moto-backed tests for shared/company_context.py: reads and prompt blocks against a real
DynamoDB table (validation and exact wording live in test_company_context_mutation.py)."""
import pytest
from moto import mock_aws

from shared import company_context as cc
from shared.test.moto_tables import create_pk_sk_table


@pytest.fixture
def table():
    with mock_aws():
        yield create_pk_sk_table('test-aggregates')


def _objective(**overrides):
    return {'title': 'Grow retention', 'description': 'Keep users', 'horizon': 'quarter', **overrides}


class TestReads:
    def test_defaults_when_nothing_stored(self, table):
        assert cc.get_company_context(table) == {
            'vision': '', 'objectives': [], 'updated_at': None, 'updated_by_username': None}
        assert cc.get_my_context(table, 'sub-1') == {'objectives': [], 'updated_at': None}
        design = cc.get_design_system(table)
        assert design['tokens'] == {'colors': [], 'typography': []}
        assert design['references'] == []

    def test_references_hide_archived_and_sort_by_creation(self, table):
        for ref_id, created, status in (('ref_00000000000b', '2026-01-02', 'ready'),
                                        ('ref_00000000000a', '2026-01-01', 'pending'),
                                        ('ref_00000000000c', '2026-01-03', 'archived')):
            table.put_item(Item={'pk': cc.DESIGN_SYSTEM_PK, 'sk': f'REF#{ref_id}', 'id': ref_id,
                                 'kind': 'github', 'title': ref_id, 'status': status, 'created_at': created})
        assert [r['id'] for r in cc.list_references(table)] == ['ref_00000000000a', 'ref_00000000000b']
        assert len(cc.list_references(table, include_archived=True)) == 3

class TestBlocks:
    def test_empty_when_nothing_configured(self, table):
        assert cc.company_context_block(table) == ''
        assert cc.design_system_block(table) == ''
        assert cc.company_context_block(None) == ''

    def test_company_block_contents(self, table):
        table.put_item(Item={'pk': cc.COMPANY_CONTEXT_PK, 'sk': 'config', 'vision': 'Be loved',
                             'objectives': [_objective(id='obj_0123456789ab', horizon='date', due='2027-01-01')]})
        table.put_item(Item={'pk': cc.user_context_pk('sub-1'), 'sk': 'config', 'objectives': [
            {'id': 'obj_aaaaaaaaaaaa', 'title': 'Cut churn', 'description': '', 'kpis': [{'name': 'Churn', 'target': '2', 'unit': '%'}]}]})
        block = cc.company_context_block(table, 'sub-1')
        assert block.startswith('<company_context>')
        assert 'Company vision:\nBe loved' in block
        assert '- Grow retention (dated, due 2027-01-01): Keep users' in block
        assert "The requesting user's own objectives" in block
        assert 'KPI Churn: target 2 %' in block
        # Without a sub, nothing personal.
        assert 'Cut churn' not in cc.company_context_block(table)

    def test_design_block_uses_tokens_and_ready_summaries_only(self, table):
        table.put_item(Item={'pk': cc.DESIGN_SYSTEM_PK, 'sk': 'config', 'guidelines': 'Use cards.', 'tokens': {
            'colors': [{'name': 'primary', 'value': '#FF5A5F'}],
            'typography': [{'role': 'body', 'family': 'Inter', 'size': '16px'}]}})
        for ref_id, status in (('ref_00000000000a', 'ready'), ('ref_00000000000b', 'error')):
            table.put_item(Item={'pk': cc.DESIGN_SYSTEM_PK, 'sk': f'REF#{ref_id}', 'id': ref_id, 'kind': 'figma',
                                 'title': f'T-{status}', 'status': status, 'extracted_summary': f'S-{status}',
                                 'created_at': '2026'})
        block = cc.design_system_block(table)
        assert 'Colours: primary = #FF5A5F' in block
        assert 'Typography: body = Inter (16px)' in block
        assert 'Guidelines:\nUse cards.' in block
        assert 'S-ready' in block
        assert 'S-error' not in block
