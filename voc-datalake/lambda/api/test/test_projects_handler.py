"""
Tests for projects_handler.py - /projects/* endpoints.
"""
import json
import os
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


class TestGenerateDocumentDocType:
    """POST /projects/<id>/document validates `doc_type` against an allowlist.

    The field arrived unchecked and steered three things at once: the job type
    (`generate_{doc_type}`), the execution path (`doc_type in ('prd','prfaq')`
    decides Step Functions vs a single-shot Lambda invoke) and the generator's
    DynamoDB sort key (`{doc_type.upper()}#{doc_id}`) — with every attempt
    billing a Bedrock call.

    The allowlist is TWO values on purpose. `build_prototype` and
    `product_report` reach the generator through their own routes, which build
    their own doc_config, and this handler has no internal callers — so
    narrowing it cannot affect them. Reverting the guard fails the rejection
    tests below; widening it to four fails them too.

    The body SHAPE is checked here too: a body that parses to a list or a scalar
    used to raise AttributeError on `body.get` and answer 500, which reads as a
    server fault for what is a malformed request.
    """

    @staticmethod
    def _post(api_gateway_event, lambda_context, body):
        """POST the generation route with create_job and the invoke both mocked.

        Returns (response, mock_create_job, mock_invoke) so a test can assert on
        the refusal AND on the absence of a job row.
        """
        from projects_handler import lambda_handler

        event = api_gateway_event(
            method='POST',
            path='/projects/proj-123/document',
            path_params={'project_id': 'proj-123'},
            body=body,
        )
        with patch('projects_handler.create_job', return_value=('job-1', {})) as mock_create_job, \
                patch('projects_handler.invoke_lambda_async') as mock_invoke:
            response = lambda_handler(event, lambda_context)
        return response, mock_create_job, mock_invoke

    @pytest.mark.parametrize('doc_type', ['prd', 'prfaq'])
    def test_an_accepted_doc_type_still_starts_a_job(
        self, api_gateway_event, lambda_context, doc_type
    ):
        """The positive control: the guard refuses unknown values, it does not
        refuse the field. Without this, rejecting everything would still pass
        the refusal tests below."""
        response, mock_create_job, mock_invoke = self._post(
            api_gateway_event, lambda_context,
            {'doc_type': doc_type, 'title': 'A feature'},
        )
        body = json.loads(response['body'])
        assert body['success'] is True
        assert body['job_id'] == 'job-1'
        # The job type carries the doc_type through, which is the interpolation
        # the unvalidated field used to reach.
        assert mock_create_job.call_args.args[1] == f'generate_{doc_type}'
        assert mock_create_job.call_args.args[3]['doc_type'] == doc_type
        # No state machine ARN in the test environment, so the single-shot path
        # is what runs; either way the request was accepted.
        mock_invoke.assert_called_once()

    def test_an_absent_doc_type_still_defaults_to_prd(
        self, api_gateway_event, lambda_context
    ):
        """Pinning the pre-existing default: a request that says nothing about
        doc_type behaves exactly as it did before the guard."""
        response, mock_create_job, _ = self._post(
            api_gateway_event, lambda_context, {'title': 'A feature'},
        )
        assert json.loads(response['body'])['success'] is True
        assert mock_create_job.call_args.args[1] == 'generate_prd'
        assert mock_create_job.call_args.args[3]['doc_type'] == 'prd'

    def test_an_explicit_null_doc_type_is_resolved_not_forwarded(
        self, api_gateway_event, lambda_context
    ):
        """`dict.get` cannot tell JSON null from a missing key, so null means
        `prd` here too — and the RESOLVED value has to reach the stored config.
        The generator's own `doc_config.get('doc_type', 'prd')` reads a present
        null as null, and a null doc_type crashes it on `.upper()` after the job
        row already exists."""
        response, mock_create_job, _ = self._post(
            api_gateway_event, lambda_context, {'doc_type': None, 'title': 'A feature'},
        )
        assert json.loads(response['body'])['success'] is True
        assert mock_create_job.call_args.args[1] == 'generate_prd'
        assert mock_create_job.call_args.args[3]['doc_type'] == 'prd'

    @pytest.mark.parametrize('bad', [
        # The two doc types the generator also serves, which have their own
        # routes: this route must not be a second, unvalidated door to them.
        'build_prototype',
        'product_report',
        # A value carrying the sort-key delimiter — the reason this field is a
        # trust boundary at all, since the generator writes
        # f'{doc_type.upper()}#{doc_id}' as a DynamoDB sort key.
        'prd#injected',
        '#',
        '../prd',
        # Case and whitespace are NOT folded: the generator compares with `==`,
        # so a value it does not recognise still becomes half of a sort key.
        'PRD',
        ' prd',
        'prd ',
        # Wrong types, which would blow up on `.upper()` or serialise into the
        # job type as a repr.
        '',
        [],
        {},
        7,
        True,
    ])
    def test_a_rejected_doc_type_answers_400_and_creates_no_job(
        self, api_gateway_event, lambda_context, bad
    ):
        """A 400 BEFORE create_job: refusing afterwards would leave a job row
        describing a request that was rejected, and each attempt bills a Bedrock
        call."""
        response, mock_create_job, mock_invoke = self._post(
            api_gateway_event, lambda_context, {'doc_type': bad, 'title': 'A feature'},
        )
        assert response['statusCode'] == 400
        # The field must be NAMED in the error, so the caller is not left
        # guessing which of the body's fields it was.
        assert 'doc_type' in json.loads(response['body'])['error']
        mock_create_job.assert_not_called()
        mock_invoke.assert_not_called()

    def test_the_refusal_names_the_received_type(
        self, api_gateway_event, lambda_context
    ):
        """The type is the diagnostic a caller sending the wrong shape needs, and
        `validate_bool` in shared/api.py records the same reasoning: name the
        type, never echo the value back."""
        response, _, _ = self._post(
            api_gateway_event, lambda_context, {'doc_type': 7, 'title': 'A feature'},
        )
        error = json.loads(response['body'])['error']
        assert 'got int' in error
        # The value itself stays out of the response: it is unbounded caller
        # input and echoing it buys the caller nothing they do not have.
        assert '7' not in error

    @pytest.mark.parametrize('raw_body', [
        # TRUTHY non-objects: these reached `body.get` and raised AttributeError.
        '[1, 2]',       # a JSON array
        '"prd"',        # a bare JSON string
        '7',            # a bare JSON number
        'true',         # a bare JSON boolean
        # FALSY non-objects, which are the interesting half. The obvious
        # `json_body or {}` collapses each of these into `{}` BEFORE any
        # isinstance check can see it, so they were accepted as an empty body and
        # started a default `prd` generation — a billed Bedrock call from a body
        # that is not an object at all. They only fail if the shape is inspected
        # before the falsy coercion.
        '[]',           # an empty JSON array
        'false',
        '0',
        '""',           # an empty JSON string as the WHOLE body, not as a value
    ], ids=['array', 'string', 'number', 'boolean',
            'empty_array', 'false', 'zero', 'empty_string'])
    def test_a_non_object_body_answers_400_not_500(
        self, api_gateway_event, lambda_context, raw_body
    ):
        """A malformed body is the caller's fault, so it gets a 400 naming the
        problem. Before the isinstance guard these raised AttributeError on
        `body.get` and the handler's catch-all answered 500 — which reads as a
        server fault and which a client retries differently."""
        from projects_handler import lambda_handler

        event = api_gateway_event(
            method='POST',
            path='/projects/proj-123/document',
            path_params={'project_id': 'proj-123'},
        )
        # Set verbatim rather than through the fixture's `body=`, which JSON-encodes
        # a dict: the point is a payload that parses to a NON-dict.
        event['body'] = raw_body

        with patch('projects_handler.create_job', return_value=('job-1', {})) as mock_create_job, \
                patch('projects_handler.invoke_lambda_async') as mock_invoke:
            response = lambda_handler(event, lambda_context)

        assert response['statusCode'] == 400
        assert 'JSON object' in json.loads(response['body'])['error']
        mock_create_job.assert_not_called()
        mock_invoke.assert_not_called()

    @pytest.mark.parametrize('raw_body', [
        '{not json',        # never parses at all
        '   ',              # whitespace only: truthy, so it IS parsed, and fails
    ], ids=['malformed', 'whitespace'])
    def test_an_unparseable_body_answers_400_not_500(
        self, api_gateway_event, lambda_context, raw_body
    ):
        """The third way this body can fail, which a hand-rolled shape check misses.

        `json_body` is a cached_property calling `json.loads`, so unparseable JSON
        raises `JSONDecodeError` AT THE ATTRIBUTE READ — before any isinstance
        check can run — and reaches the handler's catch-all as a 500. Only reading
        the body through `_json_object_body`, whose `except ValueError` branch owns
        this case, turns it into the 400 the caller can act on.
        """
        from projects_handler import lambda_handler

        event = api_gateway_event(
            method='POST',
            path='/projects/proj-123/document',
            path_params={'project_id': 'proj-123'},
        )
        event['body'] = raw_body

        with patch('projects_handler.create_job', return_value=('job-1', {})) as mock_create_job, \
                patch('projects_handler.invoke_lambda_async') as mock_invoke:
            response = lambda_handler(event, lambda_context)

        assert response['statusCode'] == 400
        # Names the body as the problem, not the shape: this one never parsed.
        assert 'must be JSON' in json.loads(response['body'])['error']
        mock_create_job.assert_not_called()
        mock_invoke.assert_not_called()

    @pytest.mark.parametrize('raw_body', [
        'null',     # an explicit JSON null body
        None,       # no body at all
        '{}',       # an empty JSON object
        # A ZERO-LENGTH body, which is what a real client sends with
        # Content-Length: 0 — different bytes on the wire from the JSON string
        # `""` two tests up, and the opposite answer. It defaults, but NOT via the
        # `body is None` branch: powertools' `json_body` returns None for a falsy
        # `decoded_body` without parsing it, so `''` never reaches the shape check.
        # That makes this route's answer here rest on a library detail, which is
        # exactly why it is pinned rather than left to be rediscovered.
        '',
    ], ids=['json_null', 'absent', 'empty_object', 'zero_length'])
    def test_an_absent_body_still_defaults_to_prd(
        self, api_gateway_event, lambda_context, raw_body
    ):
        """The counterpart to the refusals above, and the reason the shape check
        cannot simply refuse everything falsy.

        A body that is absent — no body, or a literal JSON `null` — has always
        meant "generate a PRD with the defaults", and the SPA relies on it. Only
        a body that IS something, and that something is not an object, is a 400.
        Without this case a guard that also refused the absent body would look
        correct.
        """
        from projects_handler import lambda_handler

        event = api_gateway_event(
            method='POST',
            path='/projects/proj-123/document',
            path_params={'project_id': 'proj-123'},
        )
        event['body'] = raw_body

        with patch('projects_handler.create_job', return_value=('job-1', {})) as mock_create_job, \
                patch('projects_handler.invoke_lambda_async') as mock_invoke:
            response = lambda_handler(event, lambda_context)

        assert json.loads(response['body'])['success'] is True
        assert mock_create_job.call_args.args[1] == 'generate_prd'
        assert mock_create_job.call_args.args[3]['doc_type'] == 'prd'
        mock_invoke.assert_called_once()

    def test_the_request_body_is_not_mutated_by_the_write_back(
        self, api_gateway_event, lambda_context
    ):
        """The resolved doc_type reaches the stored config through a COPY.

        `json_body` is a cached_property, so writing into it would rewrite the
        request as received for the rest of the invocation — any later read
        (middleware, an audit log) would see this route's resolution rather than
        what the caller sent.
        """
        from projects_handler import app, lambda_handler

        event = api_gateway_event(
            method='POST',
            path='/projects/proj-123/document',
            path_params={'project_id': 'proj-123'},
            body={'doc_type': None, 'title': 'A feature'},
        )
        with patch('projects_handler.create_job', return_value=('job-1', {})) as mock_create_job, \
                patch('projects_handler.invoke_lambda_async'):
            lambda_handler(event, lambda_context)

        # The STORED config carries the resolved value...
        assert mock_create_job.call_args.args[3]['doc_type'] == 'prd'
        # ...while the parsed request still carries the null the caller sent.
        assert app.current_event.json_body['doc_type'] is None

    @pytest.mark.parametrize('doc_type', ['prd', 'prfaq'])
    def test_an_accepted_doc_type_reaches_the_state_machine(
        self, api_gateway_event, lambda_context, doc_type
    ):
        """The chain path, which the other cases never reach.

        With no DOCUMENT_STATE_MACHINE_ARN in the test environment every other
        test here lands on the single-shot invoke, so without this the validated
        value was never observed reaching the Step Functions input — the path
        production actually runs.
        """
        from projects_handler import lambda_handler

        event = api_gateway_event(
            method='POST',
            path='/projects/proj-123/document',
            path_params={'project_id': 'proj-123'},
            body={'doc_type': doc_type, 'title': 'A feature'},
        )
        with patch.dict(os.environ, {'DOCUMENT_STATE_MACHINE_ARN': 'arn:aws:states:us-east-1:1:sm/doc'}), \
                patch('projects_handler.create_job', return_value=('job-1', {})), \
                patch('projects_handler.boto3.client') as mock_client, \
                patch('projects_handler.invoke_lambda_async') as mock_invoke:
            response = lambda_handler(event, lambda_context)

        assert json.loads(response['body'])['success'] is True
        start_execution = mock_client.return_value.start_execution
        start_execution.assert_called_once()
        # The validated value reaches the state machine's input, not just the job row.
        sfn_input = json.loads(start_execution.call_args.kwargs['input'])
        assert sfn_input['doc_config']['doc_type'] == doc_type
        # is_chain is true for every accepted value, so the single-shot fallback
        # is not taken when the ARN is configured.
        mock_invoke.assert_not_called()

    def test_the_allowlist_stays_at_two_values(self):
        """The allowlist is the assertion, not an implementation detail: growing
        it to the generator's four doc types is exactly the regression the
        comment beside it argues against."""
        from projects_handler import DEFAULT_GENERATED_DOC_TYPE, GENERATED_DOC_TYPES

        assert GENERATED_DOC_TYPES == ('prd', 'prfaq')
        # Stated directly, though the `generate_prd` assertions elsewhere in this
        # class would also notice: a default outside the allowlist would make the
        # route refuse its own fallback for every request that omits the field, and
        # naming the invariant means that failure describes itself instead of
        # arriving as seven tests complaining about an unexpected job type.
        assert DEFAULT_GENERATED_DOC_TYPE in GENERATED_DOC_TYPES

    def test_the_routing_predicate_reads_the_allowlist_constant(self):
        """`is_chain` must not re-declare the allowlist.

        A second copy of the literal can disagree with the set the route
        validates against, which would route a newly accepted value down the
        single-shot path silently. Asserting on the source is crude, but the
        alternative — a behavioural test — cannot see the difference while the
        two sets agree, which is precisely when the drift would be introduced.

        Scoped to the assignment STATEMENT rather than the whole function, whose
        source includes the docstring and the surrounding comments: those discuss
        which doc types take which path and would quote the pair legitimately, so
        a whole-function match fails for a reason it does not name. This survives
        reformatting and a rename of the variable.

        Comments are excluded from what is asserted on, for that same reason one
        level down: a trailing `# ... 'prd' ...` on the statement is commentary
        about the predicate, not a second copy of the allowlist, and failing on it
        would again blame a predicate that is correct.
        A re-declared literal counts however it is QUOTED. Python spells a string
        literal two ways and ruff's configuration here enforces neither, so checking
        one spelling left the case only this assertion can catch — a predicate that
        reads the constant and carries a disagreeing copy beside it — passing on the
        other. The literals are derived from GENERATED_DOC_TYPES for the same
        reason: a hardcoded pair stops covering the allowlist the moment it changes.
        """
        import inspect

        from projects_handler import GENERATED_DOC_TYPES, api_generate_document

        source = inspect.getsource(api_generate_document)
        lines = source.splitlines()
        first = next(
            (i for i, line in enumerate(lines) if line.strip().startswith('is_chain')),
            None,
        )
        assert first is not None, 'no is_chain assignment found in api_generate_document'
        # The whole STATEMENT, not just its first line: wrapped as
        # `is_chain = (\n    doc_type in ...)` a line-only check would inspect the
        # `is_chain = (` half and a re-declared literal on the continuation would
        # pass unseen. So consume lines until the brackets balance — but count
        # brackets on the CODE only, because an unbalanced `(` in a trailing
        # comment (`# see api_build_prototype( for the twin`) would otherwise keep
        # the loop swallowing lines until it happened to balance, pulling in the
        # comments below that legitimately quote the pair and failing with a
        # message blaming a predicate that is perfectly correct.
        assignment = ''
        code = ''
        for line in lines[first:first + 10]:
            assignment += line
            code += line.split('#')[0]
            if code.count('(') == code.count(')'):
                break
        else:
            raise AssertionError(
                f'the is_chain statement never closed its brackets within 10 lines, '
                f'so it could not be checked: {assignment.strip()}'
            )
        assert 'GENERATED_DOC_TYPES' in code, (
            f'the routing predicate must read the allowlist constant, not a second '
            f'copy of its literal: {assignment.strip()}'
        )
        # No quoted doc type in the CODE, which is what a re-declared literal would
        # look like however it were spelled, spaced or wrapped — including which
        # QUOTE it is spelled with. Python has two spellings of a string literal and
        # ruff's configuration here is defaults-only (`F` + `E4/E7/E9`), so no rule
        # enforces one. Checking single quotes alone let through the case only this
        # assertion can catch: a predicate that reads the constant AND carries a
        # second, disagreeing copy beside it (`... or doc_type in ("legacy", "prd")`)
        # — the assertion above catches a REPLACEMENT of the constant, this one
        # catches an ADDITION, so there was nothing else standing behind it.
        #
        # Derived from GENERATED_DOC_TYPES rather than hardcoded, so the check
        # cannot quietly stop covering a value the allowlist gains.
        redeclared = sorted(
            f'{quote}{doc_type}{quote}'
            for doc_type in GENERATED_DOC_TYPES
            for quote in ('"', "'")
            if f'{quote}{doc_type}{quote}' in code
        )
        assert not redeclared, (
            f'the routing predicate re-declares the allowlist literal {redeclared} '
            f'instead of reading GENERATED_DOC_TYPES: {assignment.strip()}'
        )


class TestMergeDocumentsBody:
    """POST /projects/<id>/documents/merge validates the body before billing."""

    @staticmethod
    def _post(api_gateway_event, lambda_context, raw_body=None):
        from projects_handler import lambda_handler

        event = api_gateway_event(
            method='POST',
            path='/projects/proj-123/documents/merge',
            path_params={'project_id': 'proj-123'},
        )
        event['body'] = raw_body

        with patch(
            'projects_handler.create_job', return_value=('job-1', {})
        ) as mock_create_job, patch(
            'projects_handler.invoke_lambda_async'
        ) as mock_invoke:
            response = lambda_handler(event, lambda_context)
        return response, mock_create_job, mock_invoke

    def test_an_object_body_still_starts_a_merge_job(
        self, api_gateway_event, lambda_context
    ):
        response, mock_create_job, mock_invoke = self._post(
            api_gateway_event,
            lambda_context,
            '{"output_type": "prd"}',
        )

        assert response['statusCode'] == 200
        assert json.loads(response['body'])['job_id'] == 'job-1'
        assert mock_create_job.call_args.args[3] == {'output_type': 'prd'}
        assert mock_invoke.call_args.args[1]['merge_config'] == {
            'output_type': 'prd'
        }

    @pytest.mark.parametrize(
        'raw_body',
        [None, 'null'],
        ids=['absent', 'json_null'],
    )
    def test_an_absent_or_null_body_keeps_the_empty_config_default(
        self, api_gateway_event, lambda_context, raw_body
    ):
        response, mock_create_job, mock_invoke = self._post(
            api_gateway_event, lambda_context, raw_body
        )

        assert response['statusCode'] == 200
        assert mock_create_job.call_args.args[3] == {}
        assert mock_invoke.call_args.args[1]['merge_config'] == {}

    @pytest.mark.parametrize(
        'raw_body',
        ['[1, 2]', '"hi"', '7', 'true', '[]', 'false', '0', '""'],
        ids=[
            'array',
            'string',
            'number',
            'boolean',
            'empty_array',
            'false',
            'zero',
            'empty_string',
        ],
    )
    def test_a_non_object_body_is_refused_before_job_creation(
        self, api_gateway_event, lambda_context, raw_body
    ):
        response, mock_create_job, mock_invoke = self._post(
            api_gateway_event, lambda_context, raw_body
        )

        assert response['statusCode'] == 400
        assert 'JSON object' in json.loads(response['body'])['error']
        mock_create_job.assert_not_called()
        mock_invoke.assert_not_called()

    @pytest.mark.parametrize(
        'raw_body',
        ['{not json', '   '],
        ids=['malformed', 'whitespace'],
    )
    def test_unparseable_json_is_refused_before_job_creation(
        self, api_gateway_event, lambda_context, raw_body
    ):
        response, mock_create_job, mock_invoke = self._post(
            api_gateway_event, lambda_context, raw_body
        )

        assert response['statusCode'] == 400
        assert 'must be JSON' in json.loads(response['body'])['error']
        mock_create_job.assert_not_called()
        mock_invoke.assert_not_called()


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





class TestCreateTokenExpiry:
    """POST /projects/{id}/api-tokens — optional expires_in_days.

    Absent (or JSON null) mints a non-expiring token with NO expires_at
    attribute, byte-compatible with every pre-expiry row.  When present the
    value is validated STRICTLY rather than clamped: this is a credential
    lifetime a human chose, so validate_int's fall-back-to-default contract
    would silently mint a lifetime nobody picked.  Reverting the strict check
    to validate_int fails test_rejects_bool and test_rejects_fractional —
    isinstance(True, int) is True, and int(30.5) truncates.
    """

    def _post(self, api_gateway_event, lambda_context, body, *, with_scopes=True):
        """POST the mint route.

        `scopes` is REQUIRED by the route, so it is supplied unless a test is
        specifically about its absence — otherwise every test here would be
        asserting the same 400.
        """
        from projects_handler import lambda_handler
        from shared.mcp_tokens import ALL_READ_SCOPES
        if with_scopes and 'scopes' not in body:
            body = {**body, 'scopes': list(ALL_READ_SCOPES)}
        with patch('projects_handler.get_projects_table') as mock_get_table:
            mock_table = mock_get_table.return_value
            mock_table.get_item.return_value = {'Item': {'pk': 'PROJECT#proj-1', 'sk': 'META'}}
            mock_table.put_item.return_value = {}
            event = api_gateway_event(
                method='POST',
                path='/projects/proj-1/api-tokens',
                body=body,
            )
            response = lambda_handler(event, lambda_context)
            return response, mock_table

    def test_scopes_are_required_not_defaulted(self, api_gateway_event, lambda_context):
        """Omitting `scopes` is a 400, NOT a credential holding everything.

        The mint boundary must not be fail-open while enforcement is fail-closed:
        defaulting here would mean `POST {"name": "x"}` yields the widest
        possible credential, so the laziest request would produce the most
        dangerous token. `read_reach` is deliberately different — it HAS a
        chosen default the UI warns about; `scopes` has no least-privilege
        fallback, so there is nothing honest to default to.
        """
        response, mock_table = self._post(
            api_gateway_event, lambda_context, {'name': 't'}, with_scopes=False,
        )
        assert response['statusCode'] == 400, response['body']
        # This API reports validation failures under `error`, not `message`.
        body = json.loads(response['body'])
        assert 'scopes' in body.get('error', ''), body
        mock_table.put_item.assert_not_called()

    def test_absent_expiry_stores_no_attribute(self, api_gateway_event, lambda_context):
        """Omitting the field keeps today's exact row shape — attribute absent."""
        response, mock_table = self._post(api_gateway_event, lambda_context, {'name': 't'})
        assert response['statusCode'] == 200
        stored = mock_table.put_item.call_args.kwargs['Item']
        assert 'expires_at' not in stored
        assert json.loads(response['body'])['expires_at'] is None

    def test_valid_expiry_is_stored_and_echoed(self, api_gateway_event, lambda_context):
        from datetime import datetime, timedelta, timezone
        response, mock_table = self._post(
            api_gateway_event, lambda_context, {'name': 't', 'expires_in_days': 30}
        )
        assert response['statusCode'] == 200
        stored = mock_table.put_item.call_args.kwargs['Item']['expires_at']
        assert json.loads(response['body'])['expires_at'] == stored
        # ~30 days out, parseable, timezone-aware
        parsed = datetime.fromisoformat(stored)
        delta = parsed - datetime.now(timezone.utc)
        assert timedelta(days=29, hours=23) < delta <= timedelta(days=30)

    @pytest.mark.parametrize('bad', [0, -1, 366, 'thirty', 30.5, True, False, [30], {}])
    def test_rejects_out_of_range_and_non_integer(self, api_gateway_event, lambda_context, bad):
        """Strict 400, never a clamp: an unreadable lifetime must not mint."""
        response, mock_table = self._post(
            api_gateway_event, lambda_context, {'name': 't', 'expires_in_days': bad}
        )
        assert response['statusCode'] == 400
        mock_table.put_item.assert_not_called()

    def test_json_null_means_absent(self, api_gateway_event, lambda_context):
        """An explicit null is 'no preference', same as omitting the field."""
        response, mock_table = self._post(
            api_gateway_event, lambda_context, {'name': 't', 'expires_in_days': None}
        )
        assert response['statusCode'] == 200
        assert 'expires_at' not in mock_table.put_item.call_args.kwargs['Item']

    def _list(self, api_gateway_event, lambda_context, items, project='proj-1'):
        from projects_handler import lambda_handler
        with patch('projects_handler.get_projects_table') as mock_get_table:
            mock_get_table.return_value.query.return_value = {'Items': items}
            event = api_gateway_event(method='GET', path=f'/projects/{project}/api-tokens')
            response = lambda_handler(event, lambda_context)
        return response, mock_get_table.return_value

    def test_list_returns_expires_at(self, api_gateway_event, lambda_context):
        """GET .../api-tokens surfaces the deadline; a row without one reads None."""
        response, _ = self._list(api_gateway_event, lambda_context, [
            {'token_id': 'tok_new', 'name': 'n', 'created_at': 'c',
             'projects': ['proj-1'], 'expires_at': '2027-01-01T00:00:00+00:00'},
            {'token_id': 'tok_forever', 'name': 'l', 'created_at': 'c',
             'projects': ['proj-1']},
        ])
        tokens = {t['token_id']: t for t in json.loads(response['body'])['tokens']}
        assert tokens['tok_new']['expires_at'] == '2027-01-01T00:00:00+00:00'
        assert tokens['tok_forever']['expires_at'] is None

    def test_list_shows_only_tokens_whose_project_set_includes_this_project(
        self, api_gateway_event, lambda_context
    ):
        """Tokens live in one partition, so the tab filters by membership.

        A credential is workspace-level now; the project tab shows the ones
        minted for (or reaching) that project. Getting this filter wrong would
        show every project's credentials in every tab.
        """
        response, table = self._list(api_gateway_event, lambda_context, [
            {'token_id': 'tok_mine', 'name': 'a', 'created_at': 'c', 'projects': ['proj-1']},
            {'token_id': 'tok_theirs', 'name': 'b', 'created_at': 'c', 'projects': ['proj-2']},
            {'token_id': 'tok_both', 'name': 'c', 'created_at': 'c',
             'projects': ['proj-1', 'proj-2']},
            {'token_id': 'tok_none', 'name': 'd', 'created_at': 'c', 'projects': []},
        ])
        ids = {t['token_id'] for t in json.loads(response['body'])['tokens']}
        assert ids == {'tok_mine', 'tok_both'}, (
            'the tab must show exactly the tokens whose project set names this project'
        )
        # One Query of the token partition, not a per-project range scan.
        table.query.assert_called_once()

    def test_list_follows_pagination_to_the_end(self, api_gateway_event, lambda_context):
        """A truncated first page would make credentials unrevocable.

        All tokens share ONE partition and a Query page is capped at 1 MB, so a
        single-page read starts silently dropping rows as the workspace grows.
        The list is the only revoke path, so a dropped row is a credential that
        cannot be revoked through the UI — the exact invariant the mint route is
        written to guarantee.

        Revert story: deleting the LastEvaluatedKey loop in `_query_all_tokens`
        fails this test, because only `tok_page1` comes back.
        """
        from projects_handler import lambda_handler
        page1 = {
            'Items': [{'token_id': 'tok_page1', 'name': 'a', 'created_at': 'c',
                       'projects': ['proj-1']}],
            'LastEvaluatedKey': {'pk': {'S': 'MCPTOKEN'}, 'sk': {'S': 'TOKEN#tok_page1'}},
        }
        page2 = {
            'Items': [{'token_id': 'tok_page2', 'name': 'b', 'created_at': 'c',
                       'projects': ['proj-1']}],
        }
        with patch('projects_handler.get_projects_table') as mock_get_table:
            table = mock_get_table.return_value
            table.query.side_effect = [page1, page2]
            event = api_gateway_event(method='GET', path='/projects/proj-1/api-tokens')
            response = lambda_handler(event, lambda_context)

        ids = {t['token_id'] for t in json.loads(response['body'])['tokens']}
        assert ids == {'tok_page1', 'tok_page2'}, (
            'the second page was dropped — those credentials would be unrevocable'
        )
        assert table.query.call_count == 2
        # The follow-up Query must resume from where the first stopped.
        assert table.query.call_args_list[1].kwargs['ExclusiveStartKey'] == (
            page1['LastEvaluatedKey']
        )

    def test_list_never_returns_the_secret_hash(self, api_gateway_event, lambda_context):
        response, _ = self._list(api_gateway_event, lambda_context, [
            {'token_id': 'tok_1', 'name': 'n', 'created_at': 'c', 'projects': ['proj-1'],
             'secret_hash': 'THE-STORED-HASH', 'created_by': 'a-cognito-sub'},
        ])
        body = response['body']
        assert 'THE-STORED-HASH' not in body
        assert 'secret_hash' not in body
        # created_by identifies a person; it is stored for audit, not displayed.
        assert 'a-cognito-sub' not in body

    def test_mint_stores_the_new_credential_shape(self, api_gateway_event, lambda_context):
        """The row carries a secret hash, a scope set, a project set and a reach."""
        from shared.mcp_tokens import (
            ALL_READ_SCOPES,
            DEFAULT_READ_REACH,
            MCP_TOKEN_PK,
            parse_token,
        )
        response, mock_table = self._post(api_gateway_event, lambda_context, {'name': 't'})
        assert response['statusCode'] == 200
        stored = mock_table.put_item.call_args.kwargs['Item']
        body = json.loads(response['body'])

        # Stored outside any project partition: a credential is workspace-level.
        assert stored['pk'] == MCP_TOKEN_PK
        assert not stored['pk'].startswith('PROJECT#')
        assert stored['sk'] == f"TOKEN#{stored['token_id']}"
        assert stored['scopes'] == list(ALL_READ_SCOPES)
        assert stored['projects'] == ['proj-1']
        assert stored['read_reach'] == DEFAULT_READ_REACH
        assert stored['created_by']

        # The returned credential parses back to the row that was stored, and
        # the row holds a hash of the secret rather than the credential itself.
        parsed = parse_token(body['token'])
        assert parsed is not None, f"minted credential does not parse: {body['token']!r}"
        assert parsed[0] == stored['token_id']
        assert stored['secret_hash'] not in body['token']
        assert 'token_hash' not in stored, 'the retired field must not be written'

    def test_mint_accepts_a_narrower_scope_set(self, api_gateway_event, lambda_context):
        from shared.mcp_tokens import SCOPE_FEEDBACK_READ
        response, mock_table = self._post(
            api_gateway_event, lambda_context,
            {'name': 't', 'scopes': [SCOPE_FEEDBACK_READ]},
        )
        assert response['statusCode'] == 200
        assert mock_table.put_item.call_args.kwargs['Item']['scopes'] == [SCOPE_FEEDBACK_READ]

    @pytest.mark.parametrize('bad_scopes', [
        [], 'projects:read', ['nope:read'], ['projects:write'], [123], {}, ['projects:read', 'x'],
    ])
    def test_mint_rejects_an_unusable_scope_set(
        self, api_gateway_event, lambda_context, bad_scopes
    ):
        """Unknown scopes are refused rather than dropped.

        Silently ignoring one would mint a credential narrower than the caller
        asked for, which they discover as a permission error much later.
        `projects:write` is in the list on purpose: it does not exist yet, and
        accepting it would recreate the phantom-permission bug the old
        `read-write` scope was.
        """
        response, mock_table = self._post(
            api_gateway_event, lambda_context, {'name': 't', 'scopes': bad_scopes},
        )
        assert response['statusCode'] == 400, response['body']
        mock_table.put_item.assert_not_called()

    def test_mint_deduplicates_scopes_without_reordering(self, api_gateway_event, lambda_context):
        from shared.mcp_tokens import SCOPE_FEEDBACK_READ, SCOPE_PROJECTS_READ
        response, mock_table = self._post(
            api_gateway_event, lambda_context,
            {'name': 't', 'scopes': [SCOPE_PROJECTS_READ, SCOPE_FEEDBACK_READ,
                                     SCOPE_PROJECTS_READ]},
        )
        assert response['statusCode'] == 200
        assert mock_table.put_item.call_args.kwargs['Item']['scopes'] == [
            SCOPE_PROJECTS_READ, SCOPE_FEEDBACK_READ,
        ]

    @pytest.mark.parametrize('reach', ['workspace', 'project-set', 'none'])
    def test_mint_accepts_each_valid_read_reach(
        self, api_gateway_event, lambda_context, reach
    ):
        response, mock_table = self._post(
            api_gateway_event, lambda_context, {'name': 't', 'read_reach': reach},
        )
        assert response['statusCode'] == 200
        assert mock_table.put_item.call_args.kwargs['Item']['read_reach'] == reach

    @pytest.mark.parametrize('bad', ['all', 'WORKSPACE', '', 'write-set', 1, [], None])
    def test_mint_rejects_an_unknown_read_reach(
        self, api_gateway_event, lambda_context, bad
    ):
        """Including 'write-set', an earlier name for 'project-set'.

        A stale client sending the old value must be refused rather than
        silently defaulted to workspace — the widest reach is the last thing to
        grant by accident.
        """
        response, mock_table = self._post(
            api_gateway_event, lambda_context, {'name': 't', 'read_reach': bad},
        )
        if bad is None:
            # JSON null means "no preference" and takes the default, like an
            # absent field. Every other bad value is a 400.
            assert response['statusCode'] == 200
            return
        assert response['statusCode'] == 400, response['body']
        mock_table.put_item.assert_not_called()

    def test_revoke_addresses_the_token_partition(self, api_gateway_event, lambda_context):
        from projects_handler import lambda_handler
        from shared.mcp_tokens import MCP_TOKEN_PK
        with patch('projects_handler.get_projects_table') as mock_get_table:
            table = mock_get_table.return_value
            table.get_item.return_value = {
                'Item': {'token_id': 'tok_x', 'projects': ['proj-1']}
            }
            event = api_gateway_event(
                method='DELETE', path='/projects/proj-1/api-tokens/tok_x',
            )
            response = lambda_handler(event, lambda_context)
        assert response['statusCode'] == 200, response['body']
        assert table.delete_item.call_args.kwargs['Key'] == {
            'pk': MCP_TOKEN_PK, 'sk': 'TOKEN#tok_x',
        }

    def test_revoke_refuses_a_token_outside_this_project(
        self, api_gateway_event, lambda_context
    ):
        """404, and nothing is deleted.

        Tokens share one partition, so without this check any project's route
        could revoke any other project's credential by id.
        """
        from projects_handler import lambda_handler
        with patch('projects_handler.get_projects_table') as mock_get_table:
            table = mock_get_table.return_value
            table.get_item.return_value = {
                'Item': {'token_id': 'tok_x', 'projects': ['proj-2']}
            }
            event = api_gateway_event(
                method='DELETE', path='/projects/proj-1/api-tokens/tok_x',
            )
            response = lambda_handler(event, lambda_context)
        assert response['statusCode'] == 404, response['body']
        table.delete_item.assert_not_called()
