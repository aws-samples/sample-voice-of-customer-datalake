"""Tests for research step functions (initialize, analyze, synthesize, validate, save)."""
import pytest
from unittest.mock import patch, MagicMock
from decimal import Decimal


@pytest.fixture
def mock_tables():
    """Mock both feedback and projects tables."""
    mock_fb = MagicMock()
    mock_proj = MagicMock()
    with patch('research_step_handler._get_feedback_table', return_value=mock_fb), \
         patch('research_step_handler._get_projects_table', return_value=mock_proj):
        yield {'feedback': mock_fb, 'projects': mock_proj}


@pytest.fixture
def mock_job_status():
    """Mock update_job_status."""
    with patch('research_step_handler.update_job_status') as m:
        yield m


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

    @patch('research_step_handler.get_feedback_context')
    @patch('research_step_handler.format_feedback_for_llm', return_value='formatted feedback')
    @patch('research_step_handler.get_feedback_statistics', return_value='stats')
    def test_successful_init(self, mock_stats, mock_format, mock_get_fb,
                              mock_tables, mock_job_status, feedback_items):
        from research_step_handler import step_initialize
        mock_get_fb.return_value = feedback_items

        event = {
            'project_id': 'proj_1', 'job_id': 'job_1',
            'research_config': {
                'question': 'What are pain points?',
                'sources': [], 'categories': [], 'sentiments': [], 'days': 30,
                'selected_persona_ids': [], 'selected_document_ids': [],
            }
        }

        result = step_initialize(event)

        assert result['feedback_count'] == 2
        assert result['feedback_context'] == 'formatted feedback'
        assert result['feedback_stats'] == 'stats'
        assert mock_job_status.call_count >= 3

    @patch('research_step_handler.get_feedback_context')
    def test_raises_on_no_feedback(self, mock_get_fb, mock_tables, mock_job_status):
        from research_step_handler import step_initialize
        mock_get_fb.return_value = []

        event = {
            'project_id': 'p1', 'job_id': 'j1',
            'research_config': {'sources': [], 'categories': [], 'sentiments': [], 'days': 30}
        }

        with pytest.raises(ValueError, match="No feedback data found"):
            step_initialize(event)

    @patch('research_step_handler.get_feedback_context')
    @patch('research_step_handler.format_feedback_for_llm')
    @patch('research_step_handler.get_feedback_statistics', return_value='s')
    def test_truncates_large_feedback(self, mock_stats, mock_format, mock_get_fb,
                                       mock_tables, mock_job_status, feedback_items):
        from research_step_handler import step_initialize
        mock_get_fb.return_value = feedback_items
        mock_format.return_value = 'x' * 60000

        event = {
            'project_id': 'p1', 'job_id': 'j1',
            'research_config': {'sources': [], 'categories': [], 'sentiments': [], 'days': 30,
                                'selected_persona_ids': [], 'selected_document_ids': []}
        }

        result = step_initialize(event)
        assert len(result['feedback_context']) <= 50025  # 50000 + "\n\n[... truncated ...]"

    @patch('research_step_handler.get_feedback_context')
    @patch('research_step_handler.format_feedback_for_llm', return_value='fb')
    @patch('research_step_handler.get_feedback_statistics', return_value='s')
    def test_includes_personas_context(self, mock_stats, mock_format, mock_get_fb,
                                        mock_tables, mock_job_status, feedback_items):
        from research_step_handler import step_initialize
        mock_get_fb.return_value = feedback_items

        mock_tables['projects'].query.return_value = {
            'Items': [
                {'sk': 'PERSONA#p1', 'persona_id': 'p1', 'name': 'User A',
                 'tagline': 'Tag', 'goals': ['g1'], 'frustrations': ['f1'], 'quote': 'Q'},
            ]
        }

        event = {
            'project_id': 'proj_1', 'job_id': 'job_1',
            'research_config': {
                'sources': [], 'categories': [], 'sentiments': [], 'days': 30,
                'selected_persona_ids': ['p1'], 'selected_document_ids': [],
            }
        }

        result = step_initialize(event)
        assert 'User A' in result['personas_context']

    @patch('research_step_handler.get_feedback_context')
    @patch('research_step_handler.format_feedback_for_llm', return_value='fb')
    @patch('research_step_handler.get_feedback_statistics', return_value='s')
    def test_includes_documents_context(self, mock_stats, mock_format, mock_get_fb,
                                         mock_tables, mock_job_status, feedback_items):
        from research_step_handler import step_initialize
        mock_get_fb.return_value = feedback_items

        mock_tables['projects'].query.return_value = {
            'Items': [
                {'sk': 'DOC#d1', 'document_id': 'd1', 'title': 'Doc Title',
                 'document_type': 'research', 'content': 'Doc content here'},
            ]
        }

        event = {
            'project_id': 'proj_1', 'job_id': 'job_1',
            'research_config': {
                'sources': [], 'categories': [], 'sentiments': [], 'days': 30,
                'selected_persona_ids': [], 'selected_document_ids': ['d1'],
            }
        }

        result = step_initialize(event)
        assert 'Doc Title' in result['documents_context']


class TestStepAnalyze:

    def test_successful_analysis(self, mock_tables, mock_job_status, mock_converse):
        from research_step_handler import step_analyze

        event = {
            'project_id': 'p1', 'job_id': 'j1',
            'research_config': {'question': 'What are pain points?'},
            'feedback_context': 'Customer feedback data',
            'feedback_stats': 'Stats here',
        }

        result = step_analyze(event)
        assert result['analysis'] == 'AI analysis result'
        mock_converse.assert_called_once()

    def test_includes_personas_context(self, mock_tables, mock_job_status, mock_converse):
        from research_step_handler import step_analyze

        event = {
            'project_id': 'p1', 'job_id': 'j1',
            'research_config': {'question': 'Q?'},
            'feedback_context': 'fb', 'feedback_stats': 's',
            'personas_context': 'Persona info here',
        }

        step_analyze(event)
        prompt = mock_converse.call_args.kwargs.get('prompt', '')
        assert 'Persona info' in prompt

    def test_with_response_language(self, mock_tables, mock_job_status, mock_converse):
        from research_step_handler import step_analyze

        event = {
            'project_id': 'p1', 'job_id': 'j1',
            'research_config': {'question': 'Q?', 'response_language': 'es'},
            'feedback_context': 'fb', 'feedback_stats': 's',
        }

        step_analyze(event)
        system_prompt = mock_converse.call_args.kwargs.get('system_prompt', '')
        assert 'Spanish' in system_prompt


class TestStepSynthesize:

    def test_successful_synthesis(self, mock_tables, mock_job_status, mock_converse):
        from research_step_handler import step_synthesize

        event = {
            'project_id': 'p1', 'job_id': 'j1',
            'analysis': 'Previous analysis text',
            'research_config': {},
        }

        result = step_synthesize(event)
        assert result['synthesis'] == 'AI analysis result'

    def test_with_language(self, mock_tables, mock_job_status, mock_converse):
        from research_step_handler import step_synthesize

        event = {
            'project_id': 'p1', 'job_id': 'j1',
            'analysis': 'Analysis',
            'research_config': {'response_language': 'fr'},
        }

        step_synthesize(event)
        system_prompt = mock_converse.call_args.kwargs.get('system_prompt', '')
        assert 'French' in system_prompt


class TestStepValidate:

    def test_successful_validation(self, mock_tables, mock_job_status, mock_converse):
        from research_step_handler import step_validate

        event = {
            'project_id': 'p1', 'job_id': 'j1',
            'analysis': 'Analysis text', 'synthesis': 'Synthesis text',
            'research_config': {},
        }

        result = step_validate(event)
        assert result['validation'] == 'AI analysis result'

    def test_with_language(self, mock_tables, mock_job_status, mock_converse):
        from research_step_handler import step_validate

        event = {
            'project_id': 'p1', 'job_id': 'j1',
            'analysis': 'A', 'synthesis': 'S',
            'research_config': {'response_language': 'de'},
        }

        step_validate(event)
        system_prompt = mock_converse.call_args.kwargs.get('system_prompt', '')
        assert 'German' in system_prompt


class TestStepSave:

    def test_successful_save(self, mock_tables, mock_job_status):
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

    def test_truncates_large_report(self, mock_tables, mock_job_status):
        from research_step_handler import step_save

        event = {
            'project_id': 'p1', 'job_id': 'j1',
            'research_config': {'question': 'Q?', 'title': 'T', 'filters': {}},
            'feedback_count': 5,
            'analysis': 'x' * 200000,
            'synthesis': 'y' * 200000,
            'validation': 'z' * 200000,
        }

        result = step_save(event)
        assert result['success'] is True
        put_call = mock_tables['projects'].put_item.call_args
        content = put_call.kwargs['Item']['content']
        assert len(content) <= 360000


class TestLambdaHandlerRouting:

    @patch('research_step_handler.step_synthesize')
    def test_routes_synthesize(self, mock_step, lambda_context):
        from research_step_handler import lambda_handler
        mock_step.return_value = {'synthesis': 'test'}
        event = {'step': 'synthesize', 'project_id': 'p1', 'job_id': 'j1'}
        lambda_handler(event, lambda_context)
        mock_step.assert_called_once()

    @patch('research_step_handler.step_validate')
    def test_routes_validate(self, mock_step, lambda_context):
        from research_step_handler import lambda_handler
        mock_step.return_value = {'validation': 'test'}
        event = {'step': 'validate', 'project_id': 'p1', 'job_id': 'j1'}
        lambda_handler(event, lambda_context)
        mock_step.assert_called_once()

    @patch('research_step_handler.step_save')
    def test_routes_save(self, mock_step, lambda_context):
        from research_step_handler import lambda_handler
        mock_step.return_value = {'success': True}
        event = {'step': 'save', 'project_id': 'p1', 'job_id': 'j1'}
        lambda_handler(event, lambda_context)
        mock_step.assert_called_once()

    def test_bedrock_throttling_propagates(self, lambda_context):
        from research_step_handler import lambda_handler, BedrockThrottlingException
        with patch('research_step_handler.step_analyze',
                   side_effect=BedrockThrottlingException("Throttled")):
            with pytest.raises(BedrockThrottlingException):
                lambda_handler({'step': 'analyze'}, lambda_context)


class TestTableAccessors:

    @patch('research_step_handler.get_feedback_table')
    def test_get_feedback_table_lazy(self, mock_get):
        import research_step_handler as rsh
        rsh.feedback_table = None
        mock_get.return_value = MagicMock()
        result = rsh._get_feedback_table()
        assert result is not None
        mock_get.assert_called_once()

    @patch('research_step_handler.get_projects_table')
    def test_get_projects_table_lazy(self, mock_get):
        import research_step_handler as rsh
        rsh.projects_table = None
        mock_get.return_value = MagicMock()
        result = rsh._get_projects_table()
        assert result is not None
        mock_get.assert_called_once()



class TestStepInitializeWebSearch:
    """Web search grounding in step_initialize (issue #68 / AgentCore).

    Contract pinned here: 'web_context' is ALWAYS present in the return
    value — the Step Functions resultSelector references it unconditionally,
    so a missing key would fail the whole state, and a web search failure
    must degrade to '' instead of failing the research job.
    """

    def _event(self, use_web_search):
        return {
            'project_id': 'p1', 'job_id': 'j1',
            'research_config': {
                'question': 'What are pain points?',
                'sources': [], 'categories': [], 'sentiments': [], 'days': 30,
                'selected_persona_ids': [], 'selected_document_ids': [],
                'use_web_search': use_web_search,
            }
        }

    @patch('research_step_handler.get_feedback_context')
    @patch('research_step_handler.format_feedback_for_llm', return_value='fb')
    @patch('research_step_handler.get_feedback_statistics', return_value='s')
    def test_web_context_key_always_present_when_disabled(self, mock_stats, mock_format, mock_get_fb,
                                                          mock_tables, mock_job_status, feedback_items):
        from research_step_handler import step_initialize
        mock_get_fb.return_value = feedback_items

        result = step_initialize(self._event(use_web_search=False))

        assert result['web_context'] == ''

    @patch('research_step_handler.search_web')
    @patch('research_step_handler.is_web_search_configured', return_value=True)
    @patch('research_step_handler.get_feedback_context')
    @patch('research_step_handler.format_feedback_for_llm', return_value='fb')
    @patch('research_step_handler.get_feedback_statistics', return_value='s')
    def test_searches_the_research_question_when_enabled(self, mock_stats, mock_format, mock_get_fb,
                                                         mock_configured, mock_search,
                                                         mock_tables, mock_job_status, feedback_items):
        from research_step_handler import step_initialize
        mock_get_fb.return_value = feedback_items
        mock_search.return_value = [
            {'title': 'T', 'url': 'https://t.example', 'text': 'Snippet', 'published_date': '2026-01-01'},
        ]

        result = step_initialize(self._event(use_web_search=True))

        mock_search.assert_called_once_with('What are pain points?')
        assert 'https://t.example' in result['web_context']

    @patch('research_step_handler.search_web')
    @patch('research_step_handler.is_web_search_configured', return_value=True)
    @patch('research_step_handler.get_feedback_context')
    @patch('research_step_handler.format_feedback_for_llm', return_value='fb')
    @patch('research_step_handler.get_feedback_statistics', return_value='s')
    def test_search_failure_degrades_to_empty_context(self, mock_stats, mock_format, mock_get_fb,
                                                      mock_configured, mock_search,
                                                      mock_tables, mock_job_status, feedback_items):
        from research_step_handler import step_initialize
        from shared.web_search import WebSearchError
        mock_get_fb.return_value = feedback_items
        mock_search.side_effect = WebSearchError('gateway down')

        result = step_initialize(self._event(use_web_search=True))

        assert result['web_context'] == ''
        assert result['feedback_count'] == 2  # research proceeded

    @patch('research_step_handler.search_web')
    @patch('research_step_handler.is_web_search_configured', return_value=False)
    @patch('research_step_handler.get_feedback_context')
    @patch('research_step_handler.format_feedback_for_llm', return_value='fb')
    @patch('research_step_handler.get_feedback_statistics', return_value='s')
    def test_requested_but_unconfigured_skips_without_calling(self, mock_stats, mock_format, mock_get_fb,
                                                              mock_configured, mock_search,
                                                              mock_tables, mock_job_status, feedback_items):
        from research_step_handler import step_initialize
        mock_get_fb.return_value = feedback_items

        result = step_initialize(self._event(use_web_search=True))

        mock_search.assert_not_called()
        assert result['web_context'] == ''


class TestStepAnalyzeWebContext:
    """Web results reach the analysis prompt with attribution rules."""

    def _event(self, web_context):
        return {
            'project_id': 'p1', 'job_id': 'j1',
            'research_config': {'question': 'Q?'},
            'feedback_context': 'fb', 'feedback_stats': 's',
            'web_context': web_context,
        }

    def test_web_section_included_with_citation_instructions(self, mock_job_status, mock_converse):
        from research_step_handler import step_analyze

        step_analyze(self._event('1. [Title](https://t.example)\n   Snippet'))

        prompt = mock_converse.call_args.kwargs['prompt']
        assert 'PUBLIC WEB SEARCH RESULTS' in prompt
        assert 'https://t.example' in prompt
        assert 'cite its source URL' in prompt

    def test_no_web_section_when_context_empty(self, mock_job_status, mock_converse):
        from research_step_handler import step_analyze

        step_analyze(self._event(''))

        prompt = mock_converse.call_args.kwargs['prompt']
        assert 'PUBLIC WEB SEARCH RESULTS' not in prompt


class TestStepSaveWebSearchNote:
    """The saved report header discloses that web search was used."""

    def _event(self, use_web_search):
        return {
            'project_id': 'p1', 'job_id': 'j1',
            'research_config': {'question': 'Q?', 'title': 'T', 'filters': {}, 'use_web_search': use_web_search},
            'feedback_count': 2, 'analysis': 'a', 'synthesis': 's', 'validation': 'v',
        }

    def test_report_notes_web_search_when_enabled(self, mock_tables, mock_job_status):
        from research_step_handler import step_save

        step_save(self._event(use_web_search=True))

        saved = mock_tables['projects'].put_item.call_args.kwargs['Item']
        assert 'Web search: enabled' in saved['content']

    def test_report_silent_when_disabled(self, mock_tables, mock_job_status):
        from research_step_handler import step_save

        step_save(self._event(use_web_search=False))

        saved = mock_tables['projects'].put_item.call_args.kwargs['Item']
        assert 'Web search' not in saved['content']
