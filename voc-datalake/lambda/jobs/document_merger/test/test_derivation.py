"""A merge output records the documents that were actually merged.

The merger has always stored `source_documents` — the ids it was ASKED for — so
this is the one path where used and requested can differ without any cap: a
requested document that no longer exists is silently skipped. The shared
derivation records the ones that reached the model, and the selected count keeps
the missing one visible.
"""
import pytest

from jobs.test.project_tables_fixtures import feedback_table_beside, negative_webscraper_reviews


def _saved_item(mock_dynamodb):
    return mock_dynamodb['table'].put_item.call_args.kwargs['Item']


class TestMergeProvenance:
    @pytest.fixture
    def event(self, sample_job_event):
        return {
            **sample_job_event,
            'merge_config': {
                'output_type': 'prd',
                'title': 'Merged PRD',
                'instructions': 'Combine the key insights',
                # Three requested; doc_gone was deleted after the wizard listed it.
                'selected_document_ids': ['doc_1', 'doc_gone', 'doc_2'],
                'selected_persona_ids': ['persona_1'],
                'use_feedback': False,
            },
        }

    @pytest.fixture(autouse=True)
    def wire_project(self, mock_dynamodb, mock_project_documents):
        mock_dynamodb['table'].query.return_value = {
            'Items': [
                *mock_project_documents,
                {'sk': 'PERSONA#persona_1', 'persona_id': 'persona_1', 'name': 'Ana'},
            ],
        }

    @pytest.mark.usefixtures("mock_dynamodb", "mock_jobs_table", "mock_converse")
    def test_records_the_documents_merged_not_the_ones_requested(
        self, mock_dynamodb, event, lambda_context,
    ):
        from jobs.document_merger.handler import lambda_handler

        lambda_handler(event, lambda_context)

        item = _saved_item(mock_dynamodb)
        assert item['derivation']['sources'] == [
            {'document_id': 'doc_1', 'role': 'merge_input'},
            {'document_id': 'doc_2', 'role': 'merge_input'},
        ]
        assert item['derivation']['selected_document_count'] == 3

    @pytest.mark.usefixtures("mock_dynamodb", "mock_jobs_table", "mock_converse")
    def test_keeps_writing_its_original_shape_unchanged(
        self, mock_dynamodb, event, lambda_context,
    ):
        """Additive: `source_documents` and `merge_instructions` are untouched,
        so every existing reader keeps working."""
        from jobs.document_merger.handler import lambda_handler

        lambda_handler(event, lambda_context)

        item = _saved_item(mock_dynamodb)
        assert item['source_documents'] == ['doc_1', 'doc_gone', 'doc_2']
        assert item['merge_instructions'] == 'Combine the key insights'

    @pytest.mark.usefixtures("mock_dynamodb", "mock_jobs_table", "mock_converse")
    def test_records_the_personas_used(
        self, mock_dynamodb, event, lambda_context,
    ):
        from jobs.document_merger.handler import lambda_handler

        lambda_handler(event, lambda_context)

        assert _saved_item(mock_dynamodb)['derivation']['persona_ids'] == ['persona_1']

    @pytest.mark.usefixtures("mock_dynamodb", "mock_jobs_table", "mock_converse")
    def test_records_the_feedback_items_used(
        self, mock_dynamodb, event, lambda_context,
    ):
        event['merge_config']['use_feedback'] = True
        # One day of lookback, so the mocked table answers the date loop once.
        event['merge_config']['days'] = 1
        feedback_table_beside(mock_dynamodb, negative_webscraper_reviews(3))

        from jobs.document_merger.handler import lambda_handler

        lambda_handler(event, lambda_context)

        derivation = _saved_item(mock_dynamodb)['derivation']
        assert derivation['feedback_count'] == 3
        assert derivation['product_context_included'] is False
