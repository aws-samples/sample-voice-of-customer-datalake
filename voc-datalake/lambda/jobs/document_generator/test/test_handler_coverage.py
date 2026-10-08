"""
Additional coverage tests for document_generator/handler.py.
Covers: feedback gathering with filtering, personas gathering with selection,
documents/research gathering, and no-context fallback.
"""
from datetime import UTC, datetime, timedelta

import pytest

from jobs.test.project_tables_fixtures import project_and_feedback_tables

# Use a recent date so items stay within the handler's rolling lookback window
# (avoids date-drift failures from hardcoded fixtures aging out).
_RECENT_DATE = (datetime.now(UTC) - timedelta(days=1)).strftime('%Y-%m-%d')


def _generate_prd(prd_generation_event, lambda_context, mock_prompt_steps) -> dict:
    """Run the PRD job and return the kwargs the PRD step builder received."""
    from jobs.document_generator.handler import lambda_handler
    result = lambda_handler(prd_generation_event, lambda_context)

    assert result['success'] is True
    return mock_prompt_steps['prd'].call_args.kwargs


class TestDocumentGeneratorFeedbackGathering:
    """Cover feedback gathering with source/category filtering."""

    @pytest.mark.usefixtures("mock_dynamodb", "mock_jobs_table", "mock_converse_chain")
    def test_filters_feedback_by_source(
        self, mock_dynamodb, mock_prompt_steps,
        prd_generation_event, lambda_context
    ):
        """Cover feedback_sources filtering branch."""
        project_and_feedback_tables(mock_dynamodb, feedback_items=[
            {'original_text': 'App review', 'source_platform': 'app_store', 'sentiment_label': 'positive'},
            {'original_text': 'Web review', 'source_platform': 'webscraper', 'sentiment_label': 'negative'},
        ])

        prd_generation_event['doc_config']['feedback_sources'] = ['app_store']
        prd_generation_event['doc_config']['feedback_categories'] = []

        call_kwargs = _generate_prd(prd_generation_event, lambda_context, mock_prompt_steps)
        # Feedback context is passed to the step builder
        assert 'App review' in call_kwargs['feedback_context']

    @pytest.mark.usefixtures("mock_dynamodb", "mock_jobs_table", "mock_converse_chain")
    def test_filters_feedback_by_category(
        self, mock_dynamodb, mock_prompt_steps,
        prd_generation_event, lambda_context
    ):
        """Cover feedback_categories filtering branch."""
        _, mock_feedback_table = project_and_feedback_tables(mock_dynamodb, feedback_items=[
            {'original_text': 'Billing issue', 'source_platform': 'ws', 'sentiment_label': 'negative', 'date': _RECENT_DATE},
        ])

        prd_generation_event['doc_config']['feedback_categories'] = ['billing']

        call_kwargs = _generate_prd(prd_generation_event, lambda_context, mock_prompt_steps)
        assert mock_feedback_table.query.called
        assert 'Billing issue' in call_kwargs['feedback_context']


class TestDocumentGeneratorPersonasGathering:
    """Cover personas gathering with selected_persona_ids."""

    @pytest.mark.usefixtures("mock_dynamodb", "mock_jobs_table", "mock_converse_chain")
    def test_gathers_selected_personas(
        self, mock_dynamodb, mock_prompt_steps,
        prd_generation_event, lambda_context
    ):
        """Cover the personas gathering branch with selected IDs."""
        project_and_feedback_tables(mock_dynamodb, project_items=[
            # Canonical `schemas/persona.schema.json` shape. These fixtures
            # used flat `goals`/`frustrations`, keys no writer produces — which
            # is why the assertion below (persona NAME only) passed while the
            # generated PRD received empty Goals and Frustrations lines.
            {'sk': 'PERSONA#p1', 'persona_id': 'p1', 'name': 'Power User',
             'tagline': 'Uses daily',
             'goals_motivations': {'primary_goal': 'Speed'},
             'pain_points': {'current_challenges': ['Bugs']}},
            {'sk': 'PERSONA#p2', 'persona_id': 'p2', 'name': 'Casual User',
             'tagline': 'Occasional',
             'goals_motivations': {'primary_goal': 'Simple'},
             'pain_points': {'current_challenges': ['Complex']}},
        ])

        prd_generation_event['doc_config']['data_sources']['personas'] = True
        prd_generation_event['doc_config']['selected_persona_ids'] = ['p1']

        call_kwargs = _generate_prd(prd_generation_event, lambda_context, mock_prompt_steps)
        personas_context = call_kwargs['personas_context']
        assert 'Power User' in personas_context
        # p2 should be filtered out
        assert 'Casual User' not in personas_context

        # 🔑 The assertions that make this test worth having. Asserting the NAME
        # alone is what let a PRD be generated from persona blocks whose Goals and
        # Frustrations lines were empty: the name is present either way. Reverting
        # the builder to `p.get('goals', [])` fails these two.
        assert 'Speed' in personas_context, 'the persona goal never reached the prompt'
        assert 'Bugs' in personas_context, 'the persona frustration never reached the prompt'


class TestDocumentGeneratorDocumentsGathering:
    """Cover documents/research gathering."""

    @pytest.mark.usefixtures("mock_dynamodb", "mock_jobs_table", "mock_converse_chain")
    def test_gathers_reference_documents(
        self, mock_dynamodb, mock_prompt_steps,
        prd_generation_event, lambda_context
    ):
        """Cover the documents gathering branch — appended to feedback_context."""
        project_and_feedback_tables(mock_dynamodb, project_items=[
            {'sk': 'RESEARCH#r1', 'document_id': 'r1', 'title': 'Research Report', 'content': 'Research findings...'},
            {
                'sk': 'PRD#d1', 'document_id': 'd1', 'document_type': 'prd',
                'base_title': 'Existing PRD', 'version': 1,
                'title': 'Existing PRD (v1)', 'content': 'PRD content...',
            },
        ])

        prd_generation_event['doc_config']['data_sources']['feedback'] = False
        prd_generation_event['doc_config']['data_sources']['personas'] = False
        prd_generation_event['doc_config']['data_sources']['documents'] = True
        prd_generation_event['doc_config']['selected_document_ids'] = ['r1']

        call_kwargs = _generate_prd(prd_generation_event, lambda_context, mock_prompt_steps)
        assert 'Research Report' in call_kwargs['feedback_context']

    @pytest.mark.usefixtures("mock_dynamodb", "mock_jobs_table", "mock_converse_chain")
    def test_gathers_research_documents(
        self, mock_dynamodb, mock_prompt_steps,
        prd_generation_event, lambda_context
    ):
        """Cover the research data_source branch."""
        project_and_feedback_tables(mock_dynamodb, project_items=[
            {'sk': 'RESEARCH#r1', 'document_id': 'r1', 'title': 'Analysis', 'content': 'Analysis content'},
        ])

        prd_generation_event['doc_config']['data_sources'] = {'research': True}

        call_kwargs = _generate_prd(prd_generation_event, lambda_context, mock_prompt_steps)
        assert 'Analysis' in call_kwargs['feedback_context']

    @pytest.mark.usefixtures("mock_dynamodb", "mock_jobs_table", "mock_converse_chain")
    def test_no_context_when_all_sources_disabled(
        self, mock_dynamodb, mock_prompt_steps,
        prd_generation_event, lambda_context
    ):
        """When all data sources are disabled, empty strings are passed to step builders."""
        mock_dynamodb['table'].query.return_value = {'Items': []}

        prd_generation_event['doc_config']['data_sources'] = {}

        call_kwargs = _generate_prd(prd_generation_event, lambda_context, mock_prompt_steps)
        assert call_kwargs['feedback_context'] == ''
        assert call_kwargs['personas_context'] == ''
