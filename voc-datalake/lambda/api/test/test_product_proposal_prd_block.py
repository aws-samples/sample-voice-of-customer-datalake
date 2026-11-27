"""An accepted proposal reaches PRD and PR/FAQ generation through the product context (7.104.00, owner decision 6):
the accepted fields and the summary are in the block ``build_product_context_block`` builds, the summary as "What it
does" only once it is set, and who wrote each field (``field_meta``) never is."""
from __future__ import annotations

from unittest.mock import patch

from moto import mock_aws
from moto_helpers import pk_sk_table

import product_context
from shared import product_proposals as proposals
from shared.prompt_safety import DATA_NOTICE

PROJECT = 'p1'


def _proposal(table) -> str:
    from datetime import UTC, datetime

    proposal_id, key = proposals.new_proposal_key(PROJECT, datetime(2026, 11, 26, tzinfo=UTC), workspace=None)
    entry = {'status': 'proposed', 'citations': [], 'confidence': 'high', 'note': '', 'seen': '', 'accepted': False}
    fields = {name: {**entry, 'status': 'gap', 'value': ''} for name in proposals.FIELD_ORDER}
    fields['product_name'] = {**entry, 'value': 'Orbit'}
    fields['product_summary'] = {**entry, 'value': 'Orbit plans team trips for remote companies.'}
    table.put_item(Item={**key, 'proposal_id': proposal_id, 'status': 'open', 'fields': fields, 'sources': [],
                         'model': {'id': 'global.anthropic.claude-sonnet-5-5'}})
    return proposal_id


def test_the_accepted_fields_and_summary_reach_the_prd_block_and_field_meta_does_not(monkeypatch):
    monkeypatch.delenv('RAW_DATA_BUCKET', raising=False)
    with mock_aws():
        table = pk_sk_table('prd-projects')
        table.put_item(Item={'pk': f'PROJECT#{PROJECT}', 'sk': 'META', 'project_id': PROJECT})
        with patch.object(product_context, 'projects_table', table):
            assert product_context.build_product_context_block(PROJECT) == '(No product context provided.)'
            proposals.accept(table, PROJECT, _proposal(table), {'fields': {
                'product_name': {'seen': ''}, 'product_summary': {'seen': ''}}},
                proposals.Actor('editor-sub', 'user', autonomous=False), workspace=None)
            block = product_context.build_product_context_block(PROJECT)
    assert block == (f'### Structured product context\n<product_context>\n{DATA_NOTICE}\n\n**Product**: Orbit\n\n'
                     '**What it does**: Orbit plans team trips for remote companies.\n</product_context>')
    assert 'extract' not in block
