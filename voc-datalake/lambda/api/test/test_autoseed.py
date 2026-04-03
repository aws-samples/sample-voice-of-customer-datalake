"""
Tests for autoseed_project and its helper functions in projects.py.
"""
import pytest
from unittest.mock import patch


class TestSlugify:
    """Tests for _slugify helper."""

    def test_converts_to_lowercase(self):
        from projects import _slugify
        assert _slugify('My Project') == 'my-project'

    def test_replaces_spaces_with_dashes(self):
        from projects import _slugify
        assert _slugify('hello world test') == 'hello-world-test'

    def test_removes_special_characters(self):
        from projects import _slugify
        assert _slugify('Project (v2.0)!') == 'project-v20'

    def test_collapses_multiple_dashes(self):
        from projects import _slugify
        assert _slugify('a---b') == 'a-b'

    def test_truncates_to_80_chars(self):
        from projects import _slugify
        long_name = 'a' * 100
        assert len(_slugify(long_name)) <= 80

    def test_strips_leading_trailing_dashes(self):
        from projects import _slugify
        assert _slugify('--hello--') == 'hello'

    def test_handles_empty_string(self):
        from projects import _slugify
        assert _slugify('') == ''


class TestPersonaToMarkdown:
    """Tests for _persona_to_markdown helper."""

    def test_includes_name_as_heading(self):
        from projects import _persona_to_markdown
        result = _persona_to_markdown({'name': 'Marcus Weber'})
        assert result.startswith('# Marcus Weber')

    def test_includes_tagline(self):
        from projects import _persona_to_markdown
        result = _persona_to_markdown({'name': 'Test', 'tagline': 'Price-Sensitive Buyer'})
        assert '**Price-Sensitive Buyer**' in result

    def test_includes_quotes(self):
        from projects import _persona_to_markdown
        result = _persona_to_markdown({
            'name': 'Test',
            'quotes': [{'text': 'I love this product'}],
        })
        assert '> "I love this product"' in result

    def test_includes_demographics(self):
        from projects import _persona_to_markdown
        result = _persona_to_markdown({
            'name': 'Test',
            'identity': {'age_range': '25-34', 'location': 'Berlin'},
        })
        assert '## Demographics' in result
        assert '**Age Range:** 25-34' in result
        assert '**Location:** Berlin' in result

    def test_includes_goals(self):
        from projects import _persona_to_markdown
        result = _persona_to_markdown({
            'name': 'Test',
            'goals_motivations': {'primary_goal': 'Find affordable housing'},
        })
        assert '## Goals & Motivations' in result
        assert 'Find affordable housing' in result

    def test_includes_pain_points(self):
        from projects import _persona_to_markdown
        result = _persona_to_markdown({
            'name': 'Test',
            'pain_points': {'current_challenges': ['Slow delivery', 'High prices']},
        })
        assert '## Pain Points & Frustrations' in result
        assert '- Slow delivery' in result
        assert '- High prices' in result

    def test_includes_scenario(self):
        from projects import _persona_to_markdown
        result = _persona_to_markdown({
            'name': 'Test',
            'scenario': {'title': 'Morning Search', 'narrative': 'Marcus opens the app...'},
        })
        assert '## Scenario' in result
        assert '**Morning Search**' in result

    def test_handles_minimal_persona(self):
        from projects import _persona_to_markdown
        result = _persona_to_markdown({'name': 'Minimal'})
        assert '# Minimal' in result


class TestDocumentToMarkdown:
    """Tests for _document_to_markdown helper."""

    def test_returns_content_as_is_if_starts_with_heading(self):
        from projects import _document_to_markdown
        content = '# My PRD\n\nSome content'
        result = _document_to_markdown({'title': 'My PRD', 'content': content})
        assert result == content

    def test_adds_heading_if_content_has_none(self):
        from projects import _document_to_markdown
        result = _document_to_markdown({'title': 'My PRD', 'content': 'Some content'})
        assert result == '# My PRD\n\nSome content'

    def test_handles_empty_content(self):
        from projects import _document_to_markdown
        result = _document_to_markdown({'title': 'Empty', 'content': ''})
        assert result == '# Empty\n\n'


class TestBuildSteeringFile:
    """Tests for _build_steering_file helper."""

    def test_includes_project_name(self):
        from projects import _build_steering_file
        result = _build_steering_file({'name': 'Immoscout'}, [], [])
        assert '# Immoscout — Implementation Context' in result

    def test_includes_description(self):
        from projects import _build_steering_file
        result = _build_steering_file({'name': 'Test', 'description': 'A great project'}, [], [])
        assert 'A great project' in result

    def test_includes_persona_list(self):
        from projects import _build_steering_file
        personas = [
            {'name': 'Marcus', 'tagline': 'Price-Sensitive'},
            {'name': 'Sarah', 'tagline': 'Investor'},
        ]
        result = _build_steering_file({'name': 'Test'}, personas, [])
        assert '## Personas' in result
        assert '2 personas' in result
        assert '**Marcus** — Price-Sensitive' in result
        assert '**Sarah** — Investor' in result

    def test_includes_document_list(self):
        from projects import _build_steering_file
        docs = [
            {'title': 'Search PRD', 'document_type': 'prd'},
            {'title': 'Launch PR/FAQ', 'document_type': 'prfaq'},
        ]
        result = _build_steering_file({'name': 'Test'}, [], docs)
        assert '## Documents' in result
        assert 'Search PRD (prd)' in result
        assert 'Launch PR/FAQ (prfaq)' in result

    def test_includes_kiro_export_prompt(self):
        from projects import _build_steering_file
        result = _build_steering_file(
            {'name': 'Test', 'kiro_export_prompt': 'Use React + TypeScript'},
            [], [],
        )
        assert '## Custom Instructions' in result
        assert 'Use React + TypeScript' in result

    def test_omits_sections_when_empty(self):
        from projects import _build_steering_file
        result = _build_steering_file({'name': 'Test'}, [], [])
        assert '## Personas' not in result
        assert '## Documents' not in result
        assert '## Custom Instructions' not in result


class TestAutoseedProject:
    """Tests for autoseed_project function."""

    @patch('projects.projects_table')
    def test_returns_project_metadata(self, mock_table):
        mock_table.query.return_value = {
            'Items': [
                {'pk': 'PROJECT#p1', 'sk': 'META', 'project_id': 'p1', 'name': 'My Project', 'description': 'Desc'},
            ]
        }
        from projects import autoseed_project
        result = autoseed_project('p1')
        assert result['project']['name'] == 'My Project'
        assert result['project']['description'] == 'Desc'

    @patch('projects.projects_table')
    def test_generates_steering_file(self, mock_table):
        mock_table.query.return_value = {
            'Items': [
                {'pk': 'PROJECT#p1', 'sk': 'META', 'project_id': 'p1', 'name': 'My Project'},
            ]
        }
        from projects import autoseed_project
        result = autoseed_project('p1')
        steering = next(f for f in result['files'] if 'steering' in f['path'])
        assert steering['path'] == '.kiro/steering/project-my-project.md'
        assert '# My Project' in steering['content']

    @patch('projects.projects_table')
    def test_generates_persona_files(self, mock_table):
        mock_table.query.return_value = {
            'Items': [
                {'pk': 'PROJECT#p1', 'sk': 'META', 'project_id': 'p1', 'name': 'Test'},
                {'pk': 'PROJECT#p1', 'sk': 'PERSONA#per1', 'persona_id': 'per1', 'name': 'Marcus Weber', 'tagline': 'Buyer'},
            ]
        }
        from projects import autoseed_project
        result = autoseed_project('p1')
        persona_files = [f for f in result['files'] if 'personas' in f['path']]
        assert len(persona_files) == 1
        assert persona_files[0]['path'] == '.kiro/personas/marcus-weber.md'
        assert '# Marcus Weber' in persona_files[0]['content']

    @patch('projects.projects_table')
    def test_generates_document_files(self, mock_table):
        mock_table.query.return_value = {
            'Items': [
                {'pk': 'PROJECT#p1', 'sk': 'META', 'project_id': 'p1', 'name': 'Test'},
                {'pk': 'PROJECT#p1', 'sk': 'PRD#d1', 'document_id': 'd1', 'title': 'Search PRD', 'document_type': 'prd', 'content': '# Search PRD\n\nContent'},
            ]
        }
        from projects import autoseed_project
        result = autoseed_project('p1')
        doc_files = [f for f in result['files'] if 'docs' in f['path']]
        assert len(doc_files) == 1
        assert doc_files[0]['path'] == '.kiro/docs/search-prd.md'

    @patch('projects.projects_table')
    def test_steering_file_is_first(self, mock_table):
        mock_table.query.return_value = {
            'Items': [
                {'pk': 'PROJECT#p1', 'sk': 'META', 'project_id': 'p1', 'name': 'Test'},
                {'pk': 'PROJECT#p1', 'sk': 'PERSONA#per1', 'persona_id': 'per1', 'name': 'User', 'tagline': 'T'},
                {'pk': 'PROJECT#p1', 'sk': 'PRD#d1', 'document_id': 'd1', 'title': 'Doc', 'document_type': 'prd', 'content': 'C'},
            ]
        }
        from projects import autoseed_project
        result = autoseed_project('p1')
        assert 'steering' in result['files'][0]['path']

    @patch('projects.projects_table')
    def test_raises_not_found_for_missing_project(self, mock_table):
        mock_table.query.return_value = {'Items': []}
        from projects import autoseed_project
        from shared.exceptions import NotFoundError
        with pytest.raises(NotFoundError):
            autoseed_project('nonexistent')

    @patch('projects.projects_table')
    def test_includes_kiro_prompt_in_steering(self, mock_table):
        mock_table.query.return_value = {
            'Items': [
                {'pk': 'PROJECT#p1', 'sk': 'META', 'project_id': 'p1', 'name': 'Test', 'kiro_export_prompt': 'Use TDD'},
            ]
        }
        from projects import autoseed_project
        result = autoseed_project('p1')
        steering = result['files'][0]
        assert 'Use TDD' in steering['content']
