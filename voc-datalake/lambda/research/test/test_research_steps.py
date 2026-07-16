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


    @patch('research_step_handler.get_feedback_context')
    @patch('research_step_handler.format_feedback_for_llm', return_value='fb')
    @patch('research_step_handler.get_feedback_statistics', return_value='s')
    def test_documents_context_key_always_present(self, mock_stats, mock_format, mock_get_fb,
                                                  mock_tables, mock_job_status, feedback_items):
        """Contract for the Step Functions resultSelector (issue #157): it
        references $.Payload.documents_context unconditionally, so the key
        must exist (as '') even when no reference documents are selected —
        a missing key would fail the InitializeResearch state outright."""
        from research_step_handler import step_initialize
        mock_get_fb.return_value = feedback_items

        event = {
            'project_id': 'p1', 'job_id': 'j1',
            'research_config': {'sources': [], 'categories': [], 'sentiments': [], 'days': 30,
                                'selected_persona_ids': [], 'selected_document_ids': []}
        }

        result = step_initialize(event)
        assert result['documents_context'] == ''


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

    def test_includes_documents_context(self, mock_tables, mock_job_status, mock_converse):
        """Selected reference documents must reach the analysis prompt
        (issue #157: the SF resultSelector used to drop them silently)."""
        from research_step_handler import step_analyze

        event = {
            'project_id': 'p1', 'job_id': 'j1',
            'research_config': {'question': 'Q?'},
            'feedback_context': 'fb', 'feedback_stats': 's',
            'documents_context': '## Reference Documents\n\n### Doc Title (PRD)\n\nDoc body',
        }

        step_analyze(event)
        prompt = mock_converse.call_args.kwargs.get('prompt', '')
        assert 'Doc Title' in prompt

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
    """Web search grounding in step_initialize (issue #68 / AgentCore; agentic
    loop since #207).

    Contract pinned here: 'web_context' AND 'web_search_queries' are ALWAYS
    present in the return value — the Step Functions resultSelector references
    both unconditionally, so a missing key would fail the whole state, and a
    web search failure must degrade to ''/[] instead of failing the research
    job.
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
    def test_web_keys_always_present_when_disabled(self, mock_stats, mock_format, mock_get_fb,
                                                   mock_tables, mock_job_status, feedback_items):
        from research_step_handler import step_initialize
        mock_get_fb.return_value = feedback_items

        result = step_initialize(self._event(use_web_search=False))

        assert result['web_context'] == ''
        assert result['web_search_queries'] == []

    @patch('research_step_handler.run_agentic_web_search')
    @patch('research_step_handler.is_web_search_configured', return_value=True)
    @patch('research_step_handler.get_feedback_context')
    @patch('research_step_handler.format_feedback_for_llm', return_value='fb')
    @patch('research_step_handler.get_feedback_statistics', return_value='stats-hint')
    def test_runs_agentic_search_with_question_and_stats_hint(self, mock_stats, mock_format, mock_get_fb,
                                                              mock_configured, mock_agentic,
                                                              mock_tables, mock_job_status, feedback_items):
        """The loop gets the research question plus the feedback stats as a
        domain hint, and its outcome lands in web_context/web_search_queries."""
        from research_step_handler import step_initialize
        from shared.agentic_search import AgenticSearchOutcome
        mock_get_fb.return_value = feedback_items
        mock_agentic.return_value = AgenticSearchOutcome(
            context='### Search: "q1"\n\n1. T\n   Source: https://t.example\n   Snippet',
            queries=['q1', 'q2'],
            result_count=1,
        )

        result = step_initialize(self._event(use_web_search=True))

        mock_agentic.assert_called_once_with('What are pain points?', context_hint='stats-hint')
        assert 'https://t.example' in result['web_context']
        assert result['web_search_queries'] == ['q1', 'q2']

    @patch('research_step_handler.run_agentic_web_search')
    @patch('research_step_handler.is_web_search_configured', return_value=True)
    @patch('research_step_handler.get_feedback_context')
    @patch('research_step_handler.format_feedback_for_llm', return_value='fb')
    @patch('research_step_handler.get_feedback_statistics', return_value='s')
    def test_search_failure_degrades_to_empty_context(self, mock_stats, mock_format, mock_get_fb,
                                                      mock_configured, mock_agentic,
                                                      mock_tables, mock_job_status, feedback_items):
        """run_agentic_web_search degrades internally, but even if it raises
        (any exception class — the loop spans Bedrock AND the gateway), the
        job must proceed without web context."""
        from research_step_handler import step_initialize
        mock_get_fb.return_value = feedback_items
        mock_agentic.side_effect = RuntimeError('planner and gateway both down')

        result = step_initialize(self._event(use_web_search=True))

        assert result['web_context'] == ''
        assert result['web_search_queries'] == []
        assert result['feedback_count'] == 2  # research proceeded

    @patch('research_step_handler.run_agentic_web_search')
    @patch('research_step_handler.is_web_search_configured', return_value=True)
    @patch('research_step_handler.get_feedback_context')
    @patch('research_step_handler.format_feedback_for_llm', return_value='fb')
    @patch('research_step_handler.get_feedback_statistics', return_value='s')
    def test_non_boolean_truthy_values_do_not_enable_web_search(self, mock_stats, mock_format, mock_get_fb,
                                                                mock_configured, mock_agentic,
                                                                mock_tables, mock_job_status, feedback_items):
        """Strict-boolean parity with projects_handler: replayed or foreign
        state-machine inputs carrying the STRING \"false\" (or \"true\") must
        not trigger a billed search."""
        from research_step_handler import step_initialize
        mock_get_fb.return_value = feedback_items

        for value in ('false', 'true', 1, 'yes'):
            event = self._event(use_web_search=value)
            result = step_initialize(event)
            assert result['web_context'] == ''
            assert result['web_search_queries'] == []

        mock_agentic.assert_not_called()

    @patch('research_step_handler.run_agentic_web_search')
    @patch('research_step_handler.is_web_search_configured', return_value=False)
    @patch('research_step_handler.get_feedback_context')
    @patch('research_step_handler.format_feedback_for_llm', return_value='fb')
    @patch('research_step_handler.get_feedback_statistics', return_value='s')
    def test_requested_but_unconfigured_skips_without_calling(self, mock_stats, mock_format, mock_get_fb,
                                                              mock_configured, mock_agentic,
                                                              mock_tables, mock_job_status, feedback_items):
        from research_step_handler import step_initialize
        mock_get_fb.return_value = feedback_items

        result = step_initialize(self._event(use_web_search=True))

        mock_agentic.assert_not_called()
        assert result['web_context'] == ''
        assert result['web_search_queries'] == []


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
    """The saved report discloses that (and how) web search was used."""

    def _event(self, use_web_search, web_search_queries=None):
        event = {
            'project_id': 'p1', 'job_id': 'j1',
            'research_config': {'question': 'Q?', 'title': 'T', 'filters': {}, 'use_web_search': use_web_search},
            'feedback_count': 2, 'analysis': 'a', 'synthesis': 's', 'validation': 'v',
        }
        if web_search_queries is not None:
            event['web_search_queries'] = web_search_queries
        return event

    def test_report_notes_web_search_when_enabled(self, mock_tables, mock_job_status):
        """Executions pinned to a pre-#207 state-machine definition don't pass
        web_search_queries — the header must still disclose 'enabled'."""
        from research_step_handler import step_save

        step_save(self._event(use_web_search=True))

        saved = mock_tables['projects'].put_item.call_args.kwargs['Item']
        assert 'Web search: enabled' in saved['content']

    def test_report_discloses_query_count_and_lists_searches(self, mock_tables, mock_job_status):
        from research_step_handler import step_save

        step_save(self._event(use_web_search=True, web_search_queries=['acme churn 2026', 'app redesign backlash']))

        saved = mock_tables['projects'].put_item.call_args.kwargs['Item']
        assert 'Web search: enabled (2 queries)' in saved['content']
        assert '## Web Searches' in saved['content']
        assert '1. "acme churn 2026"' in saved['content']
        assert '2. "app redesign backlash"' in saved['content']

    def test_single_query_disclosed_in_singular(self, mock_tables, mock_job_status):
        from research_step_handler import step_save

        step_save(self._event(use_web_search=True, web_search_queries=['acme churn 2026']))

        saved = mock_tables['projects'].put_item.call_args.kwargs['Item']
        assert 'Web search: enabled (1 query)' in saved['content']

    def test_report_silent_when_disabled(self, mock_tables, mock_job_status):
        from research_step_handler import step_save

        step_save(self._event(use_web_search=False))

        saved = mock_tables['projects'].put_item.call_args.kwargs['Item']
        assert 'Web search' not in saved['content']

    def test_report_silent_for_string_false(self, mock_tables, mock_job_status):
        """Disclosure parity with the strict gating in step_initialize: a
        foreign \"false\" string skips the search, so the report must not
        claim web search was used — even if a queries list is present."""
        from research_step_handler import step_save

        step_save(self._event(use_web_search='false', web_search_queries=['q']))

        saved = mock_tables['projects'].put_item.call_args.kwargs['Item']
        assert 'Web search' not in saved['content']
        assert '## Web Searches' not in saved['content']

    def test_non_string_queries_are_ignored_in_disclosure(self, mock_tables, mock_job_status):
        """State-machine input is an unvalidated boundary; junk entries must
        not crash the save step or leak into the report."""
        from research_step_handler import step_save

        step_save(self._event(use_web_search=True, web_search_queries=[None, 42, '  ', 'real query']))

        saved = mock_tables['projects'].put_item.call_args.kwargs['Item']
        assert 'Web search: enabled (1 query)' in saved['content']
        assert '1. "real query"' in saved['content']

    def test_multiline_query_is_flattened_in_disclosure(self, mock_tables, mock_job_status):
        """Queries land verbatim in report markdown — embedded newlines must
        not break the numbered-list layout."""
        from research_step_handler import step_save

        step_save(self._event(use_web_search=True, web_search_queries=['line one\nline   two']))

        saved = mock_tables['projects'].put_item.call_args.kwargs['Item']
        assert '1. "line one line two"' in saved['content']
