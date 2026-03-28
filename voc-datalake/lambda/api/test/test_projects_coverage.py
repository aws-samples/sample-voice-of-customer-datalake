"""
Additional tests for projects.py to reach 100% coverage.
Covers: generate_personas, generate_prd, generate_prfaq, create_document,
update_document, delete_document, create_persona, update_persona,
add_persona_note, update_persona_note, delete_persona_note,
regenerate_persona_avatar, delete_persona, run_research,
_slugify, _persona_to_markdown, _document_to_markdown,
_build_steering_file, autoseed_project, generate_persona_avatar wrapper,
get_feedback_context wrapper.
"""
import json
import pytest
from unittest.mock import patch, MagicMock


@pytest.fixture
def mock_projects_table():
    table = MagicMock()
    table.put_item.return_value = {}
    table.update_item.return_value = {}
    table.delete_item.return_value = {}
    table.get_item.return_value = {}
    table.query.return_value = {'Items': []}
    batch = MagicMock()
    batch.__enter__ = MagicMock(return_value=batch)
    batch.__exit__ = MagicMock(return_value=False)
    table.batch_writer.return_value = batch
    return table


@pytest.fixture
def mock_feedback_table():
    table = MagicMock()
    table.query.return_value = {'Items': []}
    return table


class TestGeneratePersonaAvatar:
    """Test the wrapper function."""

    @patch('projects.get_bedrock_client')
    @patch('projects._generate_persona_avatar')
    def test_calls_shared_with_bedrock_client(self, mock_gen, mock_client):
        from projects import generate_persona_avatar
        mock_client.return_value = 'bedrock'
        mock_gen.return_value = {'avatar_url': 'url', 'avatar_prompt': 'p'}
        result = generate_persona_avatar({'name': 'Test'})
        mock_gen.assert_called_once_with({'name': 'Test'}, 'bedrock', None)
        assert result['avatar_url'] == 'url'


class TestGetFeedbackContext:
    """Test the wrapper function."""

    @patch('projects._get_feedback_context')
    @patch('projects.feedback_table', 'fb_table')
    def test_delegates_to_shared(self, mock_get):
        from projects import get_feedback_context
        mock_get.return_value = [{'id': '1'}]
        result = get_feedback_context({'days': 7}, limit=10)
        mock_get.assert_called_once_with('fb_table', {'days': 7}, 10)
        assert len(result) == 1


class TestGeneratePersonas:
    """Tests for generate_personas function."""

    @patch('projects.projects_table', None)
    def test_raises_when_table_not_configured(self):
        from projects import generate_personas
        from shared.exceptions import ConfigurationError
        with pytest.raises(ConfigurationError):
            generate_personas('p1', {})

    @patch('projects.get_feedback_context', return_value=[])
    def test_raises_when_no_feedback(self, mock_fb, mock_projects_table):
        from projects import generate_personas
        from shared.exceptions import ValidationError
        with patch('projects.projects_table', mock_projects_table):
            with pytest.raises(ValidationError, match="No feedback data"):
                generate_personas('p1', {})

    @patch('projects.generate_persona_avatar')
    @patch('projects.converse_chain')
    @patch('projects.get_persona_generation_steps', return_value=[{'step': 1}])
    @patch('projects.get_feedback_statistics', return_value='stats')
    @patch('projects.format_feedback_for_llm', return_value='formatted')
    @patch('projects.get_feedback_context')
    def test_successful_generation(self, mock_fb, mock_format, mock_stats,
                                    mock_steps, mock_chain, mock_avatar,
                                    mock_projects_table):
        from projects import generate_personas
        mock_fb.return_value = [
            {'source_platform': 'web', 'feedback_id': 'f1', 'original_text': 'Great'},
            {'source_platform': 'web', 'feedback_id': 'f2', 'original_text': 'Bad'},
        ]
        personas_json = json.dumps([
            {'name': 'TestUser', 'tagline': 'Tag', 'confidence': 'high',
             'identity': {}, 'goals_motivations': {}, 'pain_points': {},
             'behaviors': {}, 'context_environment': {}, 'quotes': [],
             'scenario': {}, 'supporting_evidence': [], 'feedback_count': 2}
        ])
        mock_chain.return_value = ['research', f'Here are personas: {personas_json}', 'validation']
        mock_avatar.return_value = {'avatar_url': 'https://cdn/avatar.png', 'avatar_prompt': 'prompt'}

        with patch('projects.projects_table', mock_projects_table):
            result = generate_personas('p1', {'persona_count': 1})

        assert result['success'] is True
        assert len(result['personas']) == 1
        assert result['personas'][0]['name'] == 'Test User'
        mock_projects_table.put_item.assert_called()
        mock_projects_table.update_item.assert_called()

    @patch('projects.converse_chain')
    @patch('projects.get_persona_generation_steps', return_value=[{'step': 1}])
    @patch('projects.get_feedback_statistics', return_value='stats')
    @patch('projects.format_feedback_for_llm', return_value='formatted')
    @patch('projects.get_feedback_context')
    def test_raises_when_parse_fails(self, mock_fb, mock_format, mock_stats,
                                      mock_steps, mock_chain, mock_projects_table):
        from projects import generate_personas
        from shared.exceptions import ServiceError
        mock_fb.return_value = [{'source_platform': 'web', 'feedback_id': 'f1'}]
        mock_chain.return_value = ['no json', 'still no json', 'nope']

        with patch('projects.projects_table', mock_projects_table):
            with pytest.raises(ServiceError, match="Failed to generate personas"):
                generate_personas('p1', {})

    @patch('projects.generate_persona_avatar')
    @patch('projects.converse_chain')
    @patch('projects.get_persona_generation_steps', return_value=[{'step': 1}])
    @patch('projects.get_feedback_statistics', return_value='stats')
    @patch('projects.format_feedback_for_llm')
    @patch('projects.get_feedback_context')
    def test_truncates_large_feedback(self, mock_fb, mock_format, mock_stats,
                                       mock_steps, mock_chain, mock_avatar,
                                       mock_projects_table):
        from projects import generate_personas
        mock_fb.return_value = [{'source_platform': 'web', 'feedback_id': 'f1'}]
        mock_format.return_value = 'x' * 40000
        personas_json = json.dumps([{'name': 'User', 'tagline': 'T'}])
        mock_chain.return_value = ['r', personas_json, 'v']
        mock_avatar.return_value = {'avatar_url': None, 'avatar_prompt': None}

        with patch('projects.projects_table', mock_projects_table):
            result = generate_personas('p1', {'generate_avatars': False})
        assert result['success'] is True

    @patch('projects.generate_persona_avatar', side_effect=Exception('avatar fail'))
    @patch('projects.converse_chain')
    @patch('projects.get_persona_generation_steps', return_value=[{'step': 1}])
    @patch('projects.get_feedback_statistics', return_value='stats')
    @patch('projects.format_feedback_for_llm', return_value='fb')
    @patch('projects.get_feedback_context')
    def test_avatar_failure_does_not_break(self, mock_fb, mock_format, mock_stats,
                                            mock_steps, mock_chain, mock_avatar,
                                            mock_projects_table):
        from projects import generate_personas
        mock_fb.return_value = [{'source_platform': 'web', 'feedback_id': 'f1'}]
        personas_json = json.dumps([{'name': 'User'}])
        mock_chain.return_value = ['r', personas_json, 'v']

        with patch('projects.projects_table', mock_projects_table):
            result = generate_personas('p1', {'generate_avatars': True})
        assert result['success'] is True

    @patch('projects.get_feedback_context')
    def test_progress_callback_called(self, mock_fb, mock_projects_table):
        from projects import generate_personas
        from shared.exceptions import ValidationError
        mock_fb.return_value = []
        callback = MagicMock()

        with patch('projects.projects_table', mock_projects_table):
            with pytest.raises(ValidationError):
                generate_personas('p1', {}, progress_callback=callback)
        callback.assert_called()

    @patch('projects.get_feedback_context')
    def test_progress_callback_error_handled(self, mock_fb, mock_projects_table):
        from projects import generate_personas
        from shared.exceptions import ValidationError
        mock_fb.return_value = []
        callback = MagicMock(side_effect=Exception('cb fail'))

        with patch('projects.projects_table', mock_projects_table):
            with pytest.raises(ValidationError):
                generate_personas('p1', {}, progress_callback=callback)


class TestGeneratePrd:
    """Tests for generate_prd function."""

    @patch('projects.projects_table', None)
    def test_raises_when_table_not_configured(self):
        from projects import generate_prd
        from shared.exceptions import ConfigurationError
        with pytest.raises(ConfigurationError):
            generate_prd('p1', {})

    @patch('projects.converse_chain')
    @patch('projects.get_prd_generation_steps', return_value=[{'step': 1}])
    @patch('projects.format_feedback_for_llm', return_value='fb')
    @patch('projects.get_feedback_context', return_value=[{'text': 'fb'}])
    @patch('projects.get_project')
    def test_successful_prd_generation(self, mock_get, mock_fb, mock_format,
                                        mock_steps, mock_chain, mock_projects_table):
        from projects import generate_prd
        mock_get.return_value = {
            'project': {'filters': {'days': 7}},
            'personas': [{'name': 'U', 'tagline': 'T', 'quote': 'Q', 'goals': ['g'], 'frustrations': ['f']}],
            'documents': []
        }
        mock_chain.return_value = ['problem', 'solution', 'prd content']

        with patch('projects.projects_table', mock_projects_table):
            result = generate_prd('p1', {'feature_idea': 'New feature'})
        assert result['success'] is True
        assert result['document']['document_type'] == 'prd'

    @patch('projects.converse_chain', side_effect=Exception('LLM fail'))
    @patch('projects.get_prd_generation_steps', return_value=[])
    @patch('projects.format_feedback_for_llm', return_value='fb')
    @patch('projects.get_feedback_context', return_value=[{'text': 'fb'}])
    @patch('projects.get_project')
    def test_raises_on_chain_failure(self, mock_get, mock_fb, mock_format,
                                      mock_steps, mock_chain, mock_projects_table):
        from projects import generate_prd
        from shared.exceptions import ServiceError
        mock_get.return_value = {'project': {'filters': {}}, 'personas': [], 'documents': []}

        with patch('projects.projects_table', mock_projects_table):
            with pytest.raises(ServiceError, match="Failed to generate PRD"):
                generate_prd('p1', {})


class TestGeneratePrfaq:
    """Tests for generate_prfaq function."""

    @patch('projects.projects_table', None)
    def test_raises_when_table_not_configured(self):
        from projects import generate_prfaq
        from shared.exceptions import ConfigurationError
        with pytest.raises(ConfigurationError):
            generate_prfaq('p1', {})

    @patch('projects.converse_chain')
    @patch('projects.get_prfaq_generation_steps', return_value=[{'step': 1}])
    @patch('projects.format_feedback_for_llm', return_value='fb')
    @patch('projects.get_feedback_context', return_value=[{'text': 'fb'}])
    @patch('projects.get_project')
    def test_successful_prfaq_generation(self, mock_get, mock_fb, mock_format,
                                          mock_steps, mock_chain, mock_projects_table):
        from projects import generate_prfaq
        mock_get.return_value = {
            'project': {'filters': {}},
            'personas': [{'name': 'U', 'tagline': 'T', 'quote': 'Q'}],
            'documents': []
        }
        mock_chain.return_value = ['insights', 'press release', 'customer faq', 'internal faq']

        with patch('projects.projects_table', mock_projects_table):
            result = generate_prfaq('p1', {'feature_idea': 'Feature X'})
        assert result['success'] is True
        assert result['document']['document_type'] == 'prfaq'
        assert 'Press Release' in result['document']['content']

    @patch('projects.converse_chain', side_effect=Exception('fail'))
    @patch('projects.get_prfaq_generation_steps', return_value=[])
    @patch('projects.format_feedback_for_llm', return_value='fb')
    @patch('projects.get_feedback_context', return_value=[])
    @patch('projects.get_project')
    def test_raises_on_chain_failure(self, mock_get, mock_fb, mock_format,
                                      mock_steps, mock_chain, mock_projects_table):
        from projects import generate_prfaq
        from shared.exceptions import ServiceError
        mock_get.return_value = {'project': {'filters': {}}, 'personas': [], 'documents': []}

        with patch('projects.projects_table', mock_projects_table):
            with pytest.raises(ServiceError, match="Failed to generate PR/FAQ"):
                generate_prfaq('p1', {})


class TestCreateDocument:

    @patch('projects.projects_table', None)
    def test_raises_when_table_not_configured(self):
        from projects import create_document
        from shared.exceptions import ConfigurationError
        with pytest.raises(ConfigurationError):
            create_document('p1', {})

    def test_raises_when_no_content(self, mock_projects_table):
        from projects import create_document
        from shared.exceptions import ValidationError
        with patch('projects.projects_table', mock_projects_table):
            with pytest.raises(ValidationError, match="Content is required"):
                create_document('p1', {'title': 'T', 'content': ''})

    def test_successful_creation(self, mock_projects_table):
        from projects import create_document
        with patch('projects.projects_table', mock_projects_table):
            result = create_document('p1', {'title': 'Doc', 'content': 'Body', 'document_type': 'custom'})
        assert result['success'] is True
        assert result['document']['title'] == 'Doc'
        mock_projects_table.put_item.assert_called_once()


class TestUpdateDocument:

    @patch('projects.projects_table', None)
    def test_raises_when_table_not_configured(self):
        from projects import update_document
        from shared.exceptions import ConfigurationError
        with pytest.raises(ConfigurationError):
            update_document('p1', 'd1', {})

    def test_raises_when_not_found(self, mock_projects_table):
        from projects import update_document
        from shared.exceptions import NotFoundError
        mock_projects_table.query.return_value = {'Items': []}
        with patch('projects.projects_table', mock_projects_table):
            with pytest.raises(NotFoundError):
                update_document('p1', 'd1', {'title': 'New'})

    def test_successful_update_with_content(self, mock_projects_table):
        from projects import update_document
        mock_projects_table.query.return_value = {'Items': [{'sk': 'DOC#d1', 'document_id': 'd1'}]}
        with patch('projects.projects_table', mock_projects_table):
            result = update_document('p1', 'd1', {'title': 'New', 'content': 'Updated'})
        assert result['success'] is True
        mock_projects_table.update_item.assert_called_once()


class TestDeleteDocument:

    @patch('projects.projects_table', None)
    def test_raises_when_table_not_configured(self):
        from projects import delete_document
        from shared.exceptions import ConfigurationError
        with pytest.raises(ConfigurationError):
            delete_document('p1', 'd1')

    def test_raises_when_not_found(self, mock_projects_table):
        from projects import delete_document
        from shared.exceptions import NotFoundError
        mock_projects_table.query.return_value = {'Items': []}
        with patch('projects.projects_table', mock_projects_table):
            with pytest.raises(NotFoundError):
                delete_document('p1', 'd1')

    def test_successful_delete(self, mock_projects_table):
        from projects import delete_document
        mock_projects_table.query.return_value = {'Items': [{'sk': 'DOC#d1'}]}
        with patch('projects.projects_table', mock_projects_table):
            result = delete_document('p1', 'd1')
        assert result['success'] is True
        mock_projects_table.delete_item.assert_called_once()


class TestCreatePersona:

    @patch('projects.projects_table', None)
    def test_raises_when_table_not_configured(self):
        from projects import create_persona
        from shared.exceptions import ConfigurationError
        with pytest.raises(ConfigurationError):
            create_persona('p1', {})

    def test_successful_creation(self, mock_projects_table):
        from projects import create_persona
        with patch('projects.projects_table', mock_projects_table):
            result = create_persona('p1', {'name': 'Persona A', 'tagline': 'Tag'})
        assert result['success'] is True
        assert result['persona']['name'] == 'Persona A'


class TestUpdatePersona:

    @patch('projects.projects_table', None)
    def test_raises_when_table_not_configured(self):
        from projects import update_persona
        from shared.exceptions import ConfigurationError
        with pytest.raises(ConfigurationError):
            update_persona('p1', 'per1', {})

    def test_successful_update(self, mock_projects_table):
        from projects import update_persona
        with patch('projects.projects_table', mock_projects_table):
            result = update_persona('p1', 'per1', {'name': 'NewName', 'tagline': 'T'})
        assert result['success'] is True

    def test_update_failure_raises(self, mock_projects_table):
        from projects import update_persona
        from shared.exceptions import ServiceError
        mock_projects_table.update_item.side_effect = Exception('DDB error')
        with patch('projects.projects_table', mock_projects_table):
            with pytest.raises(ServiceError, match="Failed to update persona"):
                update_persona('p1', 'per1', {'name': 'X'})


class TestAddPersonaNote:

    @patch('projects.projects_table', None)
    def test_raises_when_table_not_configured(self):
        from projects import add_persona_note
        from shared.exceptions import ConfigurationError
        with pytest.raises(ConfigurationError):
            add_persona_note('p1', 'per1', {})

    def test_raises_when_no_text(self, mock_projects_table):
        from projects import add_persona_note
        from shared.exceptions import ValidationError
        with patch('projects.projects_table', mock_projects_table):
            with pytest.raises(ValidationError, match="Note text is required"):
                add_persona_note('p1', 'per1', {'text': ''})

    def test_successful_add(self, mock_projects_table):
        from projects import add_persona_note
        with patch('projects.projects_table', mock_projects_table):
            result = add_persona_note('p1', 'per1', {'text': 'A note', 'author': 'me', 'tags': ['t1']})
        assert result['success'] is True
        assert result['note']['text'] == 'A note'

    def test_add_failure_raises(self, mock_projects_table):
        from projects import add_persona_note
        from shared.exceptions import ServiceError
        mock_projects_table.update_item.side_effect = Exception('fail')
        with patch('projects.projects_table', mock_projects_table):
            with pytest.raises(ServiceError, match="Failed to add note"):
                add_persona_note('p1', 'per1', {'text': 'note'})


class TestUpdatePersonaNote:

    @patch('projects.projects_table', None)
    def test_raises_when_table_not_configured(self):
        from projects import update_persona_note
        from shared.exceptions import ConfigurationError
        with pytest.raises(ConfigurationError):
            update_persona_note('p1', 'per1', 'n1', {})

    def test_raises_when_persona_not_found(self, mock_projects_table):
        from projects import update_persona_note
        from shared.exceptions import NotFoundError
        mock_projects_table.get_item.return_value = {}
        with patch('projects.projects_table', mock_projects_table):
            with pytest.raises(NotFoundError, match="Persona not found"):
                update_persona_note('p1', 'per1', 'n1', {'text': 'x'})

    def test_raises_when_note_not_found(self, mock_projects_table):
        from projects import update_persona_note
        from shared.exceptions import NotFoundError
        mock_projects_table.get_item.return_value = {
            'Item': {'research_notes': [{'note_id': 'other'}]}
        }
        with patch('projects.projects_table', mock_projects_table):
            with pytest.raises(NotFoundError, match="Note not found"):
                update_persona_note('p1', 'per1', 'n1', {'text': 'x'})

    def test_successful_update_text_and_tags(self, mock_projects_table):
        from projects import update_persona_note
        mock_projects_table.get_item.return_value = {
            'Item': {'research_notes': [{'note_id': 'n1', 'text': 'old'}]}
        }
        with patch('projects.projects_table', mock_projects_table):
            result = update_persona_note('p1', 'per1', 'n1', {'text': 'new', 'tags': ['t']})
        assert result['success'] is True

    def test_update_failure_raises(self, mock_projects_table):
        from projects import update_persona_note
        from shared.exceptions import ServiceError
        mock_projects_table.get_item.return_value = {
            'Item': {'research_notes': [{'note_id': 'n1'}]}
        }
        mock_projects_table.update_item.side_effect = Exception('fail')
        with patch('projects.projects_table', mock_projects_table):
            with pytest.raises(ServiceError, match="Failed to update note"):
                update_persona_note('p1', 'per1', 'n1', {'text': 'x'})


class TestDeletePersonaNote:

    @patch('projects.projects_table', None)
    def test_raises_when_table_not_configured(self):
        from projects import delete_persona_note
        from shared.exceptions import ConfigurationError
        with pytest.raises(ConfigurationError):
            delete_persona_note('p1', 'per1', 'n1')

    def test_raises_when_persona_not_found(self, mock_projects_table):
        from projects import delete_persona_note
        from shared.exceptions import NotFoundError
        mock_projects_table.get_item.return_value = {}
        with patch('projects.projects_table', mock_projects_table):
            with pytest.raises(NotFoundError, match="Persona not found"):
                delete_persona_note('p1', 'per1', 'n1')

    def test_raises_when_note_not_found(self, mock_projects_table):
        from projects import delete_persona_note
        from shared.exceptions import NotFoundError
        mock_projects_table.get_item.return_value = {
            'Item': {'research_notes': [{'note_id': 'other'}]}
        }
        with patch('projects.projects_table', mock_projects_table):
            with pytest.raises(NotFoundError, match="Note not found"):
                delete_persona_note('p1', 'per1', 'n1')

    def test_successful_delete(self, mock_projects_table):
        from projects import delete_persona_note
        mock_projects_table.get_item.return_value = {
            'Item': {'research_notes': [{'note_id': 'n1'}]}
        }
        with patch('projects.projects_table', mock_projects_table):
            result = delete_persona_note('p1', 'per1', 'n1')
        assert result['success'] is True

    def test_delete_failure_raises(self, mock_projects_table):
        from projects import delete_persona_note
        from shared.exceptions import ServiceError
        mock_projects_table.get_item.return_value = {
            'Item': {'research_notes': [{'note_id': 'n1'}]}
        }
        mock_projects_table.update_item.side_effect = Exception('fail')
        with patch('projects.projects_table', mock_projects_table):
            with pytest.raises(ServiceError, match="Failed to delete note"):
                delete_persona_note('p1', 'per1', 'n1')


class TestRegeneratePersonaAvatar:

    @patch('projects.projects_table', None)
    def test_raises_when_table_not_configured(self):
        from projects import regenerate_persona_avatar
        from shared.exceptions import ConfigurationError
        with pytest.raises(ConfigurationError):
            regenerate_persona_avatar('p1', 'per1')

    def test_raises_when_persona_not_found(self, mock_projects_table):
        from projects import regenerate_persona_avatar
        from shared.exceptions import NotFoundError
        mock_projects_table.get_item.return_value = {}
        with patch('projects.projects_table', mock_projects_table):
            with pytest.raises(NotFoundError):
                regenerate_persona_avatar('p1', 'per1')

    @patch('projects.generate_persona_avatar', return_value={'avatar_url': None})
    def test_raises_when_avatar_gen_fails(self, mock_gen, mock_projects_table):
        from projects import regenerate_persona_avatar
        from shared.exceptions import ServiceError
        mock_projects_table.get_item.return_value = {'Item': {'name': 'Test'}}
        with patch('projects.projects_table', mock_projects_table):
            with pytest.raises(ServiceError, match="Avatar generation failed"):
                regenerate_persona_avatar('p1', 'per1')

    @patch('projects.generate_persona_avatar')
    def test_successful_regeneration(self, mock_gen, mock_projects_table):
        from projects import regenerate_persona_avatar
        mock_projects_table.get_item.return_value = {'Item': {'name': 'Test'}}
        mock_gen.return_value = {'avatar_url': 'https://cdn/new.png', 'avatar_prompt': 'prompt'}
        with patch('projects.projects_table', mock_projects_table):
            result = regenerate_persona_avatar('p1', 'per1')
        assert result['success'] is True
        assert result['avatar_url'] == 'https://cdn/new.png'


class TestDeletePersona:

    @patch('projects.projects_table', None)
    def test_raises_when_table_not_configured(self):
        from projects import delete_persona
        from shared.exceptions import ConfigurationError
        with pytest.raises(ConfigurationError):
            delete_persona('p1', 'per1')

    def test_successful_delete(self, mock_projects_table):
        from projects import delete_persona
        with patch('projects.projects_table', mock_projects_table):
            result = delete_persona('p1', 'per1')
        assert result['success'] is True

    def test_delete_failure_raises(self, mock_projects_table):
        from projects import delete_persona
        from shared.exceptions import ServiceError
        mock_projects_table.delete_item.side_effect = Exception('fail')
        with patch('projects.projects_table', mock_projects_table):
            with pytest.raises(ServiceError, match="Failed to delete persona"):
                delete_persona('p1', 'per1')


class TestRunResearch:

    @patch('projects.projects_table', None)
    def test_raises_when_table_not_configured(self):
        from projects import run_research
        from shared.exceptions import ConfigurationError
        with pytest.raises(ConfigurationError):
            run_research('p1', {})

    @patch('projects.get_feedback_context', return_value=[])
    @patch('projects.get_project')
    def test_raises_when_no_feedback(self, mock_get, mock_fb, mock_projects_table):
        from projects import run_research
        from shared.exceptions import ValidationError
        mock_get.return_value = {'project': {'filters': {}}, 'personas': [], 'documents': []}
        with patch('projects.projects_table', mock_projects_table):
            with pytest.raises(ValidationError, match="No feedback data found"):
                run_research('p1', {})

    @patch('projects.converse_chain')
    @patch('projects.get_research_analysis_steps', return_value=[{'step': 1}])
    @patch('projects.get_feedback_statistics', return_value='stats')
    @patch('projects.format_feedback_for_llm', return_value='fb')
    @patch('projects.get_feedback_context')
    @patch('projects.get_project')
    def test_successful_research(self, mock_get, mock_fb, mock_format, mock_stats,
                                  mock_steps, mock_chain, mock_projects_table):
        from projects import run_research
        mock_get.return_value = {'project': {'filters': {}}, 'personas': [], 'documents': []}
        mock_fb.return_value = [{'text': 'fb1'}, {'text': 'fb2'}]
        mock_chain.return_value = ['analysis', 'summary', 'validation']

        with patch('projects.projects_table', mock_projects_table):
            result = run_research('p1', {'question': 'What?', 'title': 'Research'})
        assert result['success'] is True
        assert result['document']['document_type'] == 'research'

    @patch('projects.converse_chain', side_effect=Exception('fail'))
    @patch('projects.get_research_analysis_steps', return_value=[])
    @patch('projects.get_feedback_statistics', return_value='s')
    @patch('projects.format_feedback_for_llm', return_value='fb')
    @patch('projects.get_feedback_context', return_value=[{'text': 'fb'}])
    @patch('projects.get_project')
    def test_raises_on_chain_failure(self, mock_get, mock_fb, mock_format,
                                      mock_stats, mock_steps, mock_chain,
                                      mock_projects_table):
        from projects import run_research
        from shared.exceptions import ServiceError
        mock_get.return_value = {'project': {'filters': {}}, 'personas': [], 'documents': []}
        with patch('projects.projects_table', mock_projects_table):
            with pytest.raises(ServiceError, match="Failed to run research"):
                run_research('p1', {})

    @patch('projects.converse_chain')
    @patch('projects.get_research_analysis_steps', return_value=[{'step': 1}])
    @patch('projects.get_feedback_statistics', return_value='stats')
    @patch('projects.format_feedback_for_llm', return_value='fb')
    @patch('projects.get_feedback_context')
    @patch('projects.get_project')
    def test_uses_project_filters_as_fallback(self, mock_get, mock_fb, mock_format,
                                               mock_stats, mock_steps, mock_chain,
                                               mock_projects_table):
        from projects import run_research
        mock_get.return_value = {
            'project': {'filters': {'sources': ['web'], 'categories': ['bug'], 'sentiments': [], 'days': 14}},
            'personas': [], 'documents': []
        }
        mock_fb.return_value = [{'text': 'fb'}]
        mock_chain.return_value = ['a', 's', 'v']

        with patch('projects.projects_table', mock_projects_table):
            # No sources/categories/sentiments in body -> falls back to project filters
            run_research('p1', {'question': 'Q?'})
        assert mock_fb.called


# Utility tests (_slugify, _persona_to_markdown, _document_to_markdown,
# _build_steering_file, autoseed_project) live in test_autoseed.py — single source of truth.
