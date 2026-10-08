"""Tests for research step functions (initialize, analyze, save) through their real collaborators.

The step-by-step contract (progress trail, boundaries, defaults, report layout) is pinned in
test_research_step_handler_mutation.py; these keep the paths that run the shared helpers
unstubbed: persona prompt fields, the transactional project write, and the web-search hand-off.
"""
from decimal import Decimal
from unittest.mock import MagicMock, patch

import pytest


def _initialize_event(**config) -> dict:
    """A step_initialize event for project p1/job j1 selecting nothing, plus *config*."""
    return {
        'project_id': 'p1', 'job_id': 'j1',
        'research_config': {
            'sources': [], 'categories': [], 'sentiments': [], 'days': 30,
            'selected_persona_ids': [], 'selected_document_ids': [],
            **config,
        },
    }


@pytest.fixture
def mock_converse():
    """Mock converse function."""
    with patch('research_step_handler.converse', return_value='AI analysis result') as m:
        yield m


@pytest.fixture
def feedback_items():
    """Sample feedback items."""
    return [
        {
            'pk': 'SOURCE#test', 'sk': 'FEEDBACK#1',
            'source_platform': 'test', 'source_created_at': '2026-01-01T00:00:00Z',
            'sentiment_label': 'positive', 'sentiment_score': Decimal('0.9'),
            'category': 'product', 'rating': Decimal('5'), 'urgency': 'low',
            'original_text': 'Great product!', 'direct_customer_quote': 'Great!',
        },
        {
            'pk': 'SOURCE#test', 'sk': 'FEEDBACK#2',
            'source_platform': 'test', 'source_created_at': '2026-01-02T00:00:00Z',
            'sentiment_label': 'negative', 'sentiment_score': Decimal('-0.8'),
            'category': 'delivery', 'rating': Decimal('1'), 'urgency': 'high',
            'original_text': 'Late delivery.', 'direct_customer_quote': 'Late!',
        },
    ]


class TestStepInitialize:
    """Tests for step_initialize function."""

    @pytest.mark.usefixtures("mock_tables", "mock_job_status")
    @patch('research_step_handler.get_feedback_context')
    @patch('research_step_handler.format_feedback_for_llm', MagicMock(return_value='fb'))
    @patch('research_step_handler.get_feedback_statistics', MagicMock(return_value='s'))
    def test_includes_personas_context(self, mock_get_fb,
                                        mock_tables, feedback_items):
        from research_step_handler import step_initialize
        mock_get_fb.return_value = feedback_items

        mock_tables['projects'].query.return_value = {
            'Items': [
                {'sk': 'PERSONA#p1', 'persona_id': 'p1', 'name': 'User A',
                 'tagline': 'Tag',
                 # Canonical shape. Was flat `goals`/`frustrations`/`quote`, none
                 # of which any writer produces, so the assertion below (name
                 # only) passed while the research prompt got empty headings.
                 'goals_motivations': {'primary_goal': 'g1'},
                 'pain_points': {'current_challenges': ['f1']},
                 'quotes': [{'text': 'Q'}]},
            ]
        }

        event = _initialize_event(selected_persona_ids=['p1'])

        result = step_initialize(event)
        personas_context = result['personas_context']
        assert 'User A' in personas_context
        # The name alone was the whole assertion, and it passes whether or not the
        # persona's content arrives. Reverting to `p.get('goals', [])` fails these.
        assert 'g1' in personas_context, 'the persona goal never reached the prompt'
        assert 'f1' in personas_context, 'the persona frustration never reached the prompt'
        assert 'Q' in personas_context, 'the persona quote never reached the prompt'


class TestStepSave:

    @pytest.mark.usefixtures("mock_tables", "mock_job_status")
    def test_successful_save(self, mock_tables):
        from research_step_handler import step_save

        event = {
            'project_id': 'p1', 'job_id': 'j1',
            'research_config': {'question': 'What?', 'title': 'Test', 'filters': {}},
            'feedback_count': 10,
            'analysis': 'Analysis', 'synthesis': 'Synthesis', 'validation': 'Validation',
        }

        result = step_save(event)

        assert result['success'] is True
        assert 'document_id' in result
        assert result['feedback_count'] == 10
        mock_tables['projects'].put_item.assert_called_once()
        mock_tables['projects'].update_item.assert_called_once()

    @pytest.mark.parametrize('basis', ['review', 'imported'])
    @pytest.mark.usefixtures("mock_job_status")
    def test_the_report_and_the_item_record_the_date_basis(self, mock_tables, basis):
        """#258: the artifact says which dates the window applied to."""
        from research_step_handler import step_save

        step_save({
            'project_id': 'p1', 'job_id': 'j1',
            'research_config': {'question': 'Q?', 'filters': {}, 'date_basis': basis},
            'feedback_count': 1, 'analysis': 'a', 'synthesis': 's', 'validation': 'v',
        })

        item = mock_tables['projects'].put_item.call_args.kwargs['Item']
        assert item['date_basis'] == basis
        assert f'| Date basis: {basis}' in item['content']


@pytest.mark.usefixtures("mock_tables", "mock_job_status")
class TestStepInitializeWebSearch:
    """Web search grounding in step_initialize (issue #68 / AgentCore; agentic loop since #207)."""

    @patch('research_step_handler.is_web_search_configured', MagicMock(return_value=True))
    def test_runs_agentic_search_with_question_and_stats_hint(self, feedback_items):
        """The loop gets the research question plus the feedback stats as a
        domain hint, and its outcome lands in web_context/web_search_queries."""
        from research_step_handler import step_initialize

        from shared.agentic_search import AgenticSearchOutcome
        outcome = AgenticSearchOutcome(
            context='### Search: "q1"\n\n1. T\n   Source: https://t.example\n   Snippet',
            queries=['q1', 'q2'],
            result_count=1,
        )
        with patch('research_step_handler.get_feedback_context', return_value=feedback_items), \
                patch('research_step_handler.format_feedback_for_llm', return_value='fb'), \
                patch('research_step_handler.get_feedback_statistics', return_value='stats-hint'), \
                patch('research_step_handler.run_agentic_web_search', return_value=outcome) as mock_agentic:
            result = step_initialize(_initialize_event(question='What are pain points?', use_web_search=True))

        mock_agentic.assert_called_once_with('What are pain points?', context_hint='stats-hint')
        assert 'https://t.example' in result['web_context']
        assert result['web_search_queries'] == ['q1', 'q2']


class TestStepAnalyzeWebContext:
    """Web results reach the analysis prompt with attribution rules."""

    @pytest.mark.usefixtures("mock_job_status")
    def test_web_section_included_with_citation_instructions(self, mock_converse):
        from research_step_handler import step_analyze

        step_analyze({
            'project_id': 'p1', 'job_id': 'j1',
            'research_config': {'question': 'Q?'},
            'feedback_context': 'fb', 'feedback_stats': 's',
            'web_context': '1. [Title](https://t.example)\n   Snippet',
        })

        prompt = mock_converse.call_args.kwargs['prompt']
        assert 'PUBLIC WEB SEARCH RESULTS' in prompt
        assert 'https://t.example' in prompt
        assert 'cite its source URL' in prompt
