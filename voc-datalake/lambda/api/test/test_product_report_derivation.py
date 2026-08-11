"""A product report records that it was built from the project's product context.

It is the one generated document with no document, feedback or persona inputs at
all, so without this it would read as "built from nothing" — which is exactly the
gap the derivation contract closes.
"""
from unittest.mock import MagicMock, patch

CONTEXT = {
    'product_name': 'Acme',
    'one_liner': 'Does the thing',
    'current_state': 'ga',
    'target_users': '',
    'problem_solved': '',
    'key_features': '',
    'differentiators': '',
    'known_limitations': '',
    'non_goals': '',
    'success_metrics': '',
    'free_form_notes': '',
}


def _generate(table):
    import product_context
    with patch.object(product_context, 'projects_table', table), \
         patch.object(product_context, 'get_context', return_value={'context': CONTEXT}), \
         patch.object(product_context, 'build_product_context_block', return_value='### Structured product context\n**Product**: Acme'), \
         patch('shared.converse.converse', return_value='# Product description\n\nAcme does the thing.'):
        return product_context.generate_report('proj-1', {})


class TestProductReportDerivation:
    def test_records_the_product_context_as_its_input(self):
        table = MagicMock()

        result = _generate(table)

        derivation = table.put_item.call_args.kwargs['Item']['derivation']
        assert derivation['product_context_included'] is True
        assert result['document']['derivation'] is derivation

    def test_records_no_documents_feedback_or_personas(self):
        table = MagicMock()

        _generate(table)

        derivation = table.put_item.call_args.kwargs['Item']['derivation']
        assert derivation['sources'] == []
        assert derivation['selected_document_count'] == 0
        assert derivation['feedback_count'] == 0
        assert derivation['persona_ids'] == []
