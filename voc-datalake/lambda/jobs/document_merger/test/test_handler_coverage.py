"""
Additional coverage tests for document_merger/handler.py.
Covers: use_feedback=True path (lines 80-107), feedback filtering (line 115).
"""
from datetime import UTC, datetime, timedelta

import pytest

from jobs.test.project_tables_fixtures import project_and_feedback_tables

# Use a recent date so items stay within the handler's rolling lookback window
# (avoids date-drift failures from hardcoded fixtures aging out).
_RECENT_DATE = (datetime.now(UTC) - timedelta(days=1)).strftime('%Y-%m-%d')


def _managed_prd(document_id: str, title: str, content: str) -> dict[str, object]:
    """Canonical persisted shape; these tests are not migration tests."""
    return {
        'sk': f'PRD#{document_id}',
        'document_id': document_id,
        'document_type': 'prd',
        'base_title': title,
        'version': 1,
        'title': f'{title} (v1)',
        'content': content,
    }


TWO_PRDS = [
    _managed_prd('doc_1', 'PRD 1', 'C1'),
    _managed_prd('doc_2', 'PRD 2', 'C2'),
]


class TestDocumentMergerFeedbackPath:
    """Cover the use_feedback=True branch (lines 80-107, 115)."""

    @staticmethod
    def _tables(mock_dynamodb, *, project_items, feedback_items):
        """Separate projects/feedback doubles whose transactions replay through
        the shared `mock_dynamodb` table's fake writer."""
        return project_and_feedback_tables(
            mock_dynamodb,
            project_items=project_items,
            feedback_items=feedback_items,
            transact_write_items=mock_dynamodb['table'].meta.client.transact_write_items.side_effect,
        )

    @staticmethod
    def _merge_with_feedback(merge_documents_event, lambda_context, **config) -> dict:
        merge_documents_event['merge_config'].update({'use_feedback': True, 'days': 7, **config})

        from jobs.document_merger.handler import lambda_handler
        return lambda_handler(merge_documents_event, lambda_context)

    @pytest.mark.usefixtures("mock_dynamodb", "mock_jobs_table")
    def test_includes_feedback_when_use_feedback_enabled(
        self, mock_dynamodb, mock_converse, merge_documents_event, lambda_context
    ):
        """Cover the use_feedback=True path with feedback items."""
        _, mock_feedback_table = self._tables(
            mock_dynamodb,
            project_items=[
                _managed_prd('doc_1', 'PRD 1', 'Content 1'),
                {'sk': 'RESEARCH#doc_2', 'document_id': 'doc_2', 'document_type': 'research', 'title': 'Research', 'content': 'Content 2'},
            ],
            feedback_items=[
                {'original_text': 'Great app!', 'source_platform': 'app_store', 'sentiment_label': 'positive'},
                {'original_text': 'Needs work', 'source_platform': 'webscraper', 'sentiment_label': 'negative'},
            ],
        )

        result = self._merge_with_feedback(
            merge_documents_event, lambda_context,
            feedback_sources=['app_store'], feedback_categories=[],
        )

        assert result['success'] is True
        assert mock_feedback_table.query.called
        # Verify feedback was included in prompt
        call_kwargs = mock_converse.call_args.kwargs
        prompt = call_kwargs.get('prompt', '')
        assert 'Great app!' in prompt

    @pytest.mark.usefixtures("mock_dynamodb", "mock_jobs_table")
    def test_filters_feedback_by_category(
        self, mock_dynamodb, mock_converse, merge_documents_event, lambda_context
    ):
        """Cover feedback_categories filtering branch (line 115)."""
        self._tables(
            mock_dynamodb,
            project_items=TWO_PRDS,
            feedback_items=[
                {'original_text': 'Billing issue', 'source_platform': 'ws', 'sentiment_label': 'negative', 'category': 'billing', 'date': _RECENT_DATE},
                {'original_text': 'Good delivery', 'source_platform': 'ws', 'sentiment_label': 'positive', 'category': 'delivery', 'date': _RECENT_DATE},
            ],
        )

        result = self._merge_with_feedback(
            merge_documents_event, lambda_context, feedback_categories=['billing'],
        )

        assert result['success'] is True
        # Only billing feedback should be in prompt
        call_kwargs = mock_converse.call_args.kwargs
        prompt = call_kwargs.get('prompt', '')
        assert 'Billing issue' in prompt

    @pytest.mark.usefixtures("mock_dynamodb", "mock_jobs_table")
    def test_reads_feedback_within_the_starters_category_scope(
        self, mock_dynamodb, mock_converse, merge_documents_event, lambda_context
    ):
        """The scope captured at job start hides categories the starter cannot see."""
        self._tables(
            mock_dynamodb,
            project_items=TWO_PRDS,
            feedback_items=[
                {'original_text': 'Billing issue', 'source_platform': 'ws', 'category': 'billing', 'date': _RECENT_DATE},
                {'original_text': 'Good delivery', 'source_platform': 'ws', 'category': 'delivery', 'date': _RECENT_DATE},
            ],
        )

        result = self._merge_with_feedback(
            merge_documents_event, lambda_context,
            category_scope={'all': False, 'categories': ['delivery']},
        )

        assert result['success'] is True
        prompt = mock_converse.call_args.kwargs.get('prompt', '')
        assert 'Good delivery' in prompt
        assert 'Billing issue' not in prompt
