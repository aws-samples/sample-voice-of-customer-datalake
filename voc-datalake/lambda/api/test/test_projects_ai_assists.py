"""
Tests for the AI authoring assists in projects.py (prd-fix #17-5/6, shipped in
PR #132 without dedicated coverage — added as the P8 test-coverage rider):

- suggest_research_questions  (POST /projects/{id}/research/suggest-questions)
- suggest_document_brief      (POST /projects/{id}/suggest-document-brief)
- autofill_prfaq_questions    (POST /projects/{id}/prfaq-autofill)

All three are synchronous single-call Bedrock helpers; converse() is mocked at
the shared.converse boundary (the functions import it at call time).
"""
import json
import pytest
from unittest.mock import patch, MagicMock


PROJECT_DATA = {
    'project': {'project_id': 'proj-1', 'name': 'Test', 'filters': {'days': 30}},
    'personas': [{
        'name': 'Kim Jisu', 'tagline': 'Power user', 'quote': 'I love it',
        'goals': ['speed'], 'frustrations': ['crashes'],
    }],
}


def _common_patches():
    """Context managers shared by all three assist functions."""
    return [
        patch('projects.projects_table', MagicMock()),
        patch('projects.get_project', return_value=PROJECT_DATA),
        patch('projects.get_feedback_context', return_value=[{'text': 'app crashes'}]),
        patch('projects.format_feedback_for_llm', return_value='- app crashes'),
        patch('projects.get_feedback_statistics', return_value='1 review'),
        patch('product_context.build_product_context_block', return_value='A mobile app.'),
    ]


class _Assists:
    """Helper to run an assist with all context patches + a converse stub."""

    def run(self, func_name: str, body: dict, converse_return: str):
        patches = _common_patches()
        with patch('shared.converse.converse', return_value=converse_return) as mock_converse:
            for p in patches:
                p.start()
            try:
                import projects
                result = getattr(projects, func_name)('proj-1', body)
            finally:
                for p in patches:
                    p.stop()
        return result, mock_converse


class TestSuggestResearchQuestions(_Assists):
    def test_returns_parsed_suggestions(self):
        raw = json.dumps({'suggestions': [
            {'title': 'Crash root causes', 'question': 'What causes the crashes?'},
            {'title': 'Feature priorities', 'question': 'Which features matter most?'},
            {'title': 'Churn drivers', 'question': 'Why do users leave?'},
        ]})
        result, mock_converse = self.run('suggest_research_questions', {}, raw)
        assert len(result['suggestions']) == 3
        assert result['suggestions'][0] == {
            'title': 'Crash root causes', 'question': 'What causes the crashes?',
        }
        assert mock_converse.call_args.kwargs['step_name'] == 'research_suggest'

    def test_tolerates_markdown_fences(self):
        raw = '```json\n' + json.dumps({'suggestions': [
            {'title': 'T', 'question': 'Q?'},
        ]}) + '\n```'
        result, _ = self.run('suggest_research_questions', {}, raw)
        assert result['suggestions'] == [{'title': 'T', 'question': 'Q?'}]

    def test_returns_empty_on_malformed_json(self):
        result, _ = self.run('suggest_research_questions', {}, 'not json at all')
        assert result['suggestions'] == []

    def test_drops_invalid_entries_and_caps_at_three(self):
        raw = json.dumps({'suggestions': [
            'not-a-dict',
            {'title': 'No question here'},
            {'title': 'A', 'question': 'Q1?'},
            {'title': 'B', 'question': 'Q2?'},
            {'title': 'C', 'question': 'Q3?'},
            {'title': 'D', 'question': 'Q4?'},
        ]})
        result, _ = self.run('suggest_research_questions', {}, raw)
        questions = [s['question'] for s in result['suggestions']]
        assert questions == ['Q1?', 'Q2?', 'Q3?']

    def test_raises_when_table_not_configured(self):
        from shared.exceptions import ConfigurationError
        with patch('projects.projects_table', None):
            import projects
            with pytest.raises(ConfigurationError):
                projects.suggest_research_questions('proj-1', {})


class TestSuggestDocumentBrief(_Assists):
    def test_returns_title_and_feature_idea(self):
        raw = json.dumps({'title': 'Crash-free login', 'feature_idea': 'Fix the login crash.'})
        result, mock_converse = self.run('suggest_document_brief', {}, raw)
        assert result == {'title': 'Crash-free login', 'feature_idea': 'Fix the login crash.'}
        assert mock_converse.call_args.kwargs['step_name'] == 'document_brief_suggest'

    def test_prfaq_doc_type_steers_the_prompt(self):
        raw = json.dumps({'title': 'T', 'feature_idea': 'F'})
        _, mock_converse = self.run('suggest_document_brief', {'doc_type': 'prfaq'}, raw)
        assert 'PR-FAQ' in mock_converse.call_args.kwargs['system_prompt']

    def test_returns_empty_strings_on_malformed_json(self):
        result, _ = self.run('suggest_document_brief', {}, '¯\\_(ツ)_/¯')
        assert result == {'title': '', 'feature_idea': ''}

    def test_tolerates_markdown_fences(self):
        raw = '```json\n{"title": "T", "feature_idea": "F"}\n```'
        result, _ = self.run('suggest_document_brief', {}, raw)
        assert result == {'title': 'T', 'feature_idea': 'F'}

    def test_raises_when_table_not_configured(self):
        from shared.exceptions import ConfigurationError
        with patch('projects.projects_table', None):
            import projects
            with pytest.raises(ConfigurationError):
                projects.suggest_document_brief('proj-1', {})


class TestAutofillPrfaqQuestions(_Assists):
    def test_returns_five_answers(self):
        raw = json.dumps({'answers': ['a1', 'a2', 'a3', 'a4', 'a5']})
        result, mock_converse = self.run('autofill_prfaq_questions', {}, raw)
        assert result['answers'] == ['a1', 'a2', 'a3', 'a4', 'a5']
        assert mock_converse.call_args.kwargs['step_name'] == 'prfaq_autofill'

    def test_pads_short_answer_lists_to_five(self):
        raw = json.dumps({'answers': ['only one']})
        result, _ = self.run('autofill_prfaq_questions', {}, raw)
        assert result['answers'] == ['only one', '', '', '', '']

    def test_truncates_long_answer_lists_to_five(self):
        raw = json.dumps({'answers': [f'a{i}' for i in range(8)]})
        result, _ = self.run('autofill_prfaq_questions', {}, raw)
        assert len(result['answers']) == 5
        assert result['answers'][-1] == 'a4'

    def test_non_string_entries_become_empty(self):
        raw = json.dumps({'answers': ['ok', 42, None, {'x': 1}, 'fine']})
        result, _ = self.run('autofill_prfaq_questions', {}, raw)
        assert result['answers'] == ['ok', '', '', '', 'fine']

    def test_returns_five_empties_on_malformed_json(self):
        result, _ = self.run('autofill_prfaq_questions', {}, 'nope')
        assert result['answers'] == ['', '', '', '', '']

    def test_feature_context_reaches_the_prompt(self):
        raw = json.dumps({'answers': ['a'] * 5})
        _, mock_converse = self.run(
            'autofill_prfaq_questions',
            {'title': 'Dark mode', 'feature_idea': 'Add a dark theme'},
            raw,
        )
        prompt = mock_converse.call_args.kwargs['prompt']
        assert 'Dark mode' in prompt
        assert 'Add a dark theme' in prompt

    def test_raises_when_table_not_configured(self):
        from shared.exceptions import ConfigurationError
        with patch('projects.projects_table', None):
            import projects
            with pytest.raises(ConfigurationError):
                projects.autofill_prfaq_questions('proj-1', {})


class TestStrictJsonTokenHeadroom(_Assists):
    """Regression: strict-JSON assists must fit their output in ONE Bedrock call.

    Live-caught on voc-deploy (PR #166): adaptive-thinking models (Sonnet 5)
    spend output budget on thinking, so a tight max_tokens truncated the JSON
    and the auto-continuation resume seam dropped a comma → JSONDecodeError →
    500. These floors would fail if the headroom fix were reverted; raising
    max_continuations instead is NOT a fix here — continuation is unreliable
    mid-JSON by design.
    """

    RAW_SUGGESTIONS = json.dumps({'suggestions': [{'title': 't', 'question': 'q'}]})
    RAW_ANSWERS = json.dumps({'answers': {'q1': 'a'}})

    def test_research_suggest_requests_one_call_headroom(self):
        _, mock_converse = self.run('suggest_research_questions', {}, self.RAW_SUGGESTIONS)
        assert mock_converse.call_args.kwargs['max_tokens'] >= 2048

    def test_document_brief_requests_one_call_headroom(self):
        _, mock_converse = self.run('suggest_document_brief', {'doc_type': 'prd'}, self.RAW_SUGGESTIONS)
        assert mock_converse.call_args.kwargs['max_tokens'] >= 2048

    def test_prfaq_autofill_requests_one_call_headroom(self):
        _, mock_converse = self.run('autofill_prfaq_questions', {'feature_idea': 'x'}, self.RAW_ANSWERS)
        assert mock_converse.call_args.kwargs['max_tokens'] >= 4096
