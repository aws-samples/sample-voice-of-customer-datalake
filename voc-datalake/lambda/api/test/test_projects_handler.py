"""
Tests for projects_handler.py - /projects/* endpoints.
"""
import json
from unittest.mock import patch

import pytest


class TestValidatePersonaCount:
    """Tests for validate_persona_count helper function."""

    def test_returns_default_when_value_is_none(self):
        """Returns default value when input is None."""
        from projects_handler import validate_persona_count
        
        assert validate_persona_count(None, default=3) == 3

    def test_clamps_to_min_value(self):
        """Clamps values below minimum (hardcoded to 1)."""
        from projects_handler import validate_persona_count
        
        assert validate_persona_count(0, default=3) == 1
        assert validate_persona_count(-1, default=3) == 1

    def test_clamps_to_max_value(self):
        """Clamps values above maximum (hardcoded to 10)."""
        from projects_handler import validate_persona_count
        
        assert validate_persona_count(20, default=3) == 10

    def test_accepts_valid_count(self):
        """Accepts valid count within range."""
        from projects_handler import validate_persona_count
        
        assert validate_persona_count(5, default=3) == 5
        assert validate_persona_count('7', default=3) == 7


class TestGetConfigEndpoint:
    """Tests for GET /projects/config endpoint."""

    @patch.dict('os.environ', {'CHAT_STREAM_URL': 'wss://stream.example.com'})
    def test_returns_config_with_stream_url(self, api_gateway_event, lambda_context):
        """Returns configuration including streaming endpoint."""
        from projects_handler import lambda_handler
        
        event = api_gateway_event(method='GET', path='/projects/config')
        
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        
        assert 'chat_stream_url' in body
        assert body['chat_stream_url'] == 'wss://stream.example.com'


class TestListProjectsEndpoint:
    """Tests for GET /projects endpoint."""

    @patch('projects_handler.list_projects')
    def test_returns_list_of_projects(
        self, mock_list_projects, api_gateway_event, lambda_context
    ):
        """Returns list of all projects."""
        mock_list_projects.return_value = {
            'success': True,
            'projects': [
                {'project_id': 'proj-1', 'name': 'Project 1'},
                {'project_id': 'proj-2', 'name': 'Project 2'}
            ]
        }
        
        from projects_handler import lambda_handler
        
        event = api_gateway_event(method='GET', path='/projects')
        
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        
        assert 'projects' in body
        mock_list_projects.assert_called_once()


class TestCreateProjectEndpoint:
    """Tests for POST /projects endpoint."""

    @patch('projects_handler.create_project')
    def test_creates_project_successfully(
        self, mock_create_project, api_gateway_event, lambda_context
    ):
        """Creates a new project."""
        mock_create_project.return_value = {
            'success': True,
            'project': {
                'project_id': 'proj-new',
                'name': 'New Project',
                'description': 'A new project'
            }
        }
        
        from projects_handler import lambda_handler
        
        event = api_gateway_event(
            method='POST',
            path='/projects',
            body={'name': 'New Project', 'description': 'A new project'}
        )
        
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        
        assert body['success'] is True
        assert body['project']['name'] == 'New Project'
        mock_create_project.assert_called_once()


class TestGetProjectEndpoint:
    """Tests for GET /projects/<project_id> endpoint."""

    @patch('projects_handler.get_project')
    def test_returns_project_details(
        self, mock_get_project, api_gateway_event, lambda_context
    ):
        """Returns project details for existing project."""
        mock_get_project.return_value = {
            'success': True,
            'project': {
                'project_id': 'proj-123',
                'name': 'Test Project',
                'personas': [],
                'documents': []
            }
        }
        
        from projects_handler import lambda_handler
        
        event = api_gateway_event(
            method='GET',
            path='/projects/proj-123',
            path_params={'project_id': 'proj-123'}
        )
        
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        
        mock_get_project.assert_called_once_with('proj-123')
        assert body['project']['project_id'] == 'proj-123'


class TestUpdateProjectEndpoint:
    """Tests for PUT /projects/<project_id> endpoint."""

    @patch('projects_handler.update_project')
    def test_updates_project_successfully(
        self, mock_update_project, api_gateway_event, lambda_context
    ):
        """Updates project with new data."""
        mock_update_project.return_value = {
            'success': True,
            'project': {
                'project_id': 'proj-123',
                'name': 'Updated Name',
                'description': 'Updated description'
            }
        }
        
        from projects_handler import lambda_handler
        
        event = api_gateway_event(
            method='PUT',
            path='/projects/proj-123',
            path_params={'project_id': 'proj-123'},
            body={'name': 'Updated Name', 'description': 'Updated description'}
        )
        
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        
        assert body['success'] is True


class TestDeleteProjectEndpoint:
    """Tests for DELETE /projects/<project_id> endpoint."""

    @patch('projects_handler.delete_project')
    def test_deletes_project_successfully(
        self, mock_delete_project, api_gateway_event, lambda_context
    ):
        """Deletes project successfully."""
        mock_delete_project.return_value = {'success': True}
        
        from projects_handler import lambda_handler
        
        event = api_gateway_event(
            method='DELETE',
            path='/projects/proj-123',
            path_params={'project_id': 'proj-123'}
        )
        
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        
        assert body['success'] is True
        mock_delete_project.assert_called_once_with('proj-123')


class TestPersonaCRUDEndpoints:
    """Tests for persona CRUD endpoints."""

    @patch('projects_handler.create_persona')
    def test_create_persona(
        self, mock_create_persona, api_gateway_event, lambda_context
    ):
        """Creates a new persona."""
        mock_create_persona.return_value = {
            'success': True,
            'persona': {
                'persona_id': 'persona-123',
                'name': 'Tech Enthusiast',
                'description': 'Early adopter of technology'
            }
        }
        
        from projects_handler import lambda_handler
        
        event = api_gateway_event(
            method='POST',
            path='/projects/proj-123/personas',
            path_params={'project_id': 'proj-123'},
            body={'name': 'Tech Enthusiast', 'description': 'Early adopter of technology'}
        )
        
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        
        assert body['success'] is True
        assert body['persona']['name'] == 'Tech Enthusiast'

    @patch('projects_handler.update_persona')
    def test_update_persona(
        self, mock_update_persona, api_gateway_event, lambda_context
    ):
        """Updates an existing persona."""
        mock_update_persona.return_value = {
            'success': True,
            'persona': {
                'persona_id': 'persona-123',
                'name': 'Updated Name'
            }
        }
        
        from projects_handler import lambda_handler
        
        event = api_gateway_event(
            method='PUT',
            path='/projects/proj-123/personas/persona-123',
            path_params={'project_id': 'proj-123', 'persona_id': 'persona-123'},
            body={'name': 'Updated Name'}
        )
        
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        
        assert body['success'] is True
        assert body['persona']['name'] == 'Updated Name'

    @patch('projects_handler.delete_persona')
    def test_delete_persona(
        self, mock_delete_persona, api_gateway_event, lambda_context
    ):
        """Deletes a persona."""
        mock_delete_persona.return_value = {'success': True}
        
        from projects_handler import lambda_handler
        
        event = api_gateway_event(
            method='DELETE',
            path='/projects/proj-123/personas/persona-123',
            path_params={'project_id': 'proj-123', 'persona_id': 'persona-123'}
        )
        
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        
        assert body['success'] is True


class TestPersonaCeilingIsShared:
    """The persona ceiling is read by three places: this route's validator, the avatar
    fan-out's worker count and the image client's connection pool. They used to be
    independent literals linked only by a comment, and a comment does not fail CI —
    raising one silently halved the fan-out benefit with every test still passing.
    """

    def test_the_route_enforces_the_shared_ceiling(self):
        from projects_handler import validate_persona_count
        from shared.api import MAX_PERSONAS_PER_GENERATION

        assert validate_persona_count(MAX_PERSONAS_PER_GENERATION) == MAX_PERSONAS_PER_GENERATION
        assert (
            validate_persona_count(MAX_PERSONAS_PER_GENERATION + 1)
            == MAX_PERSONAS_PER_GENERATION
        ), 'the route admits more personas than the fan-out and the client pool are sized for'

    def test_the_worker_ceiling_is_the_persona_ceiling(self):
        """Lives here, not beside the pool assertion in shared/test/test_avatar.py: this
        one has to import `api.projects`, and the shared tree should not depend on the api
        tree importing cleanly. Same isolation argument that moved the avatar cache fixture
        out of the root conftest, applied in the other direction.
        """
        # Top-level `projects`, not `api.projects`: that is how projects_handler imports
        # it, and mixing the two paths would give this tree two module objects for one
        # file, each re-running the module's client and table wiring.
        from projects import AVATAR_MAX_CONCURRENCY
        from shared.api import MAX_PERSONAS_PER_GENERATION

        assert AVATAR_MAX_CONCURRENCY == MAX_PERSONAS_PER_GENERATION


class TestPersonaPromptVersionIsStamped:
    """Every persona stores llm_metadata.prompt_version so it stays attributable to the
    chain that produced it. The value is a literal in api/projects.py (house style, cf.
    processor/handler.py's PROMPT_VERSION) rather than read back out of the prompt file,
    so nothing but this test stops the two from drifting — and a drifted pair means stored
    personas name a prompt version that never generated them.

    In the api test tree because it imports `api.projects`; the sibling assertion about the
    file's step list lives in shared/test/test_prompt_utils.py, which needs nothing from
    the api tree.
    """

    def test_the_stamped_version_matches_the_prompt_file(self, monkeypatch):
        from projects import PERSONA_PROMPT_VERSION
        from shared import prompts as prompts_module

        # Pin the loader at the repo's prompt directory rather than letting
        # get_prompts_dir() fall through to a CWD-relative path, and clear the lru_cache
        # on both sides so neither an earlier test's cached config is read here nor this
        # one's is left behind. Mirrors the fixture in shared/test/test_prompt_utils.py.
        repo_prompts = prompts_module.REPO_PROMPTS_DIR
        assert repo_prompts.exists(), f'prompts directory moved? expected it at {repo_prompts}'
        monkeypatch.setattr(prompts_module, 'get_prompts_dir', lambda: repo_prompts)
        prompts_module.load_prompt_file.cache_clear()
        try:
            config = prompts_module.load_prompt_file('persona-generation.json')
        finally:
            prompts_module.load_prompt_file.cache_clear()

        assert config['version'] == PERSONA_PROMPT_VERSION, (
            'persona-generation.json and the stamped prompt_version disagree — personas '
            'would record a version that did not generate them'
        )


class TestGeneratePersonasEndpoint:
    """POST /projects/<id>/personas/generate assembles the filters dict.

    generate_personas has always read `generate_avatars` out of that dict, but
    this route never put it there, so the flag was unreachable from the API and
    every request paid for an image-model call per persona.
    """

    @classmethod
    def _start(cls, api_gateway_event, lambda_context, body):
        """Submit and return the filters dict, asserting the request succeeded."""
        response, mock_invoke = cls._post_raw(api_gateway_event, lambda_context, body)
        assert json.loads(response['body'])['success'] is True
        return mock_invoke.call_args.args[1]['filters']

    def test_generate_avatars_false_is_forwarded(self, api_gateway_event, lambda_context):
        filters = self._start(
            api_gateway_event, lambda_context,
            {'persona_count': 2, 'generate_avatars': False},
        )
        assert filters['generate_avatars'] is False

    def test_omitting_generate_avatars_keeps_avatars_on(self, api_gateway_event, lambda_context):
        """The pre-existing default: a request that says nothing about avatars
        behaves exactly as before and gets them."""
        filters = self._start(api_gateway_event, lambda_context, {'persona_count': 2})
        assert filters['generate_avatars'] is True

    def test_generate_avatars_true_is_forwarded(self, api_gateway_event, lambda_context):
        filters = self._start(
            api_gateway_event, lambda_context,
            {'persona_count': 2, 'generate_avatars': True},
        )
        assert filters['generate_avatars'] is True

    @staticmethod
    def _post_raw(api_gateway_event, lambda_context, body):
        """Submit without asserting success, for the cases that must be refused."""
        from projects_handler import lambda_handler

        event = api_gateway_event(
            method='POST',
            path='/projects/proj-123/personas/generate',
            path_params={'project_id': 'proj-123'},
            body=body,
        )
        with patch('projects_handler.create_job', return_value=('job-1', {})), \
                patch('projects_handler.invoke_lambda_async') as mock_invoke:
            response = lambda_handler(event, lambda_context)
        return response, mock_invoke

    @pytest.mark.parametrize('bad', ['false', 'true', 0, 1, 'no', []])
    def test_a_non_boolean_generate_avatars_is_refused(
        self, api_gateway_event, lambda_context, bad
    ):
        """A non-boolean is a 400, not a coercion.

        Coercing picks one of the two behaviours silently, and this flag gates billed
        image-model calls: `"false"` from a form post or an over-eager serialiser means
        "no avatars" to the caller, so reading it as True bills a generation per persona
        that nobody asked for. Every other field on this route is defaulted or validated.

        The job must not be created either — refusing after enqueuing would leave a job
        row describing a request that was rejected.
        """
        response, mock_invoke = self._post_raw(
            api_gateway_event, lambda_context,
            {'persona_count': 2, 'generate_avatars': bad},
        )
        assert response['statusCode'] == 400
        # The field must be NAMED in the error: a bare "validation failed" leaves the
        # caller guessing which of eight fields it was.
        assert 'generate_avatars' in json.loads(response['body'])['error']
        mock_invoke.assert_not_called()

    def test_a_real_boolean_still_reaches_the_job(self, api_gateway_event, lambda_context):
        """The positive control for the refusal above: the guard rejects the wrong TYPE,
        it does not reject the field. Without this, making validate_bool refuse
        everything would still pass the test above."""
        assert self._start(
            api_gateway_event, lambda_context,
            {'persona_count': 2, 'generate_avatars': False},
        )['generate_avatars'] is False


class TestDocumentCRUDEndpoints:
    """Tests for document CRUD endpoints."""

    @patch('projects_handler.create_document')
    def test_create_document(
        self, mock_create_document, api_gateway_event, lambda_context
    ):
        """Creates a new document."""
        mock_create_document.return_value = {
            'success': True,
            'document': {
                'document_id': 'doc-123',
                'title': 'Product Requirements',
                'doc_type': 'prd'
            }
        }
        
        from projects_handler import lambda_handler
        
        event = api_gateway_event(
            method='POST',
            path='/projects/proj-123/documents',
            path_params={'project_id': 'proj-123'},
            body={'title': 'Product Requirements', 'doc_type': 'prd'}
        )
        
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        
        assert body['success'] is True
        assert body['document']['title'] == 'Product Requirements'

    @patch('projects_handler.update_document')
    def test_update_document(
        self, mock_update_document, api_gateway_event, lambda_context
    ):
        """Updates an existing document."""
        mock_update_document.return_value = {
            'success': True,
            'document': {
                'document_id': 'doc-123',
                'title': 'Updated Title',
                'content': 'Updated content'
            }
        }
        
        from projects_handler import lambda_handler
        
        event = api_gateway_event(
            method='PUT',
            path='/projects/proj-123/documents/doc-123',
            path_params={'project_id': 'proj-123', 'document_id': 'doc-123'},
            body={'title': 'Updated Title', 'content': 'Updated content'}
        )
        
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        
        assert body['success'] is True
        assert body['document']['title'] == 'Updated Title'

    @patch('projects_handler.delete_document')
    def test_delete_document(
        self, mock_delete_document, api_gateway_event, lambda_context
    ):
        """Deletes a document."""
        mock_delete_document.return_value = {'success': True}
        
        from projects_handler import lambda_handler
        
        event = api_gateway_event(
            method='DELETE',
            path='/projects/proj-123/documents/doc-123',
            path_params={'project_id': 'proj-123', 'document_id': 'doc-123'}
        )
        
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        
        assert body['success'] is True



