"""The voice sessions' routes through the projects API's handler (7.69.00, shared/voice_session_routes.py).

The project middleware gates each route before it runs (the offer and a session's state are view, a start and End
are edit); the month's usage is for admins acting as themselves; ``voice`` is never a project id; the transcript's
assist job is registered with the worker. The checks inside a start are shared/test/test_voice_sessions.py's.
"""
from __future__ import annotations

import json
from contextlib import ExitStack
from unittest.mock import patch

import pytest
from test_persona_grounding_routes import FakeTable
from test_project_permissions import ADMIN, EDITOR, STRANGER, VIEWER

OFFER = '/projects/p1/personas/persona_1/voice-sessions'
SESSION = f'{OFFER}/s-1'
ENV = json.dumps({'runtime_arn': 'arn:aws:bedrock-agentcore:us-west-2:111111111111:runtime/voc_persona_voice-X',
                  'model_id': 'amazon.nova-2-5-sonic', 'monthly_minutes': 300, 'session_minutes': 15,
                  'max_concurrent': 8})


#: What each route's logic is replaced by: the routes are under test, not shared/voice_sessions.py.
ANSWERS = {'offer': {'enabled': True}, 'mint': {'session_id': 's-1'}, 'status': {'status': 'live'},
           'end': {'status': 'finalizing'}, 'usage': {'enabled': True}}


@pytest.fixture
def call(api_gateway_event, lambda_context, monkeypatch):
    import projects_handler

    monkeypatch.setenv('VOICE_PERSONAS', ENV)
    monkeypatch.setenv('AWS_REGION', 'us-west-2')
    monkeypatch.setattr(projects_handler, 'get_projects_table', FakeTable)
    monkeypatch.setattr('shared.voice_session_routes._stores', lambda: 'stores')

    def _call(claims: dict, method: str, path: str, body: dict | None = None) -> tuple[int, dict, dict]:
        with ExitStack() as stack:
            mocks = {name: stack.enter_context(patch(f'shared.voice_sessions.{name}', return_value=answer))
                     for name, answer in ANSWERS.items()}
            mocks['scope'] = stack.enter_context(patch('shared.voice_session_routes.category_gate.scope_for_event'))
            response = projects_handler.lambda_handler(
                api_gateway_event(method=method, path=path, body=body, claims=claims), lambda_context)
        return response['statusCode'], json.loads(response['body']), mocks

    return _call


class TestLevels:
    def test_a_viewer_reads_the_offer_and_a_session(self, call):
        assert call(VIEWER, 'GET', OFFER)[:2] == (200, {'enabled': True})
        assert call(VIEWER, 'GET', SESSION)[:2] == (200, {'status': 'live'})

    def test_a_viewer_may_not_start_or_end(self, call):
        for path in (OFFER, f'{SESSION}/end'):
            status, _body, mocks = call(VIEWER, 'POST', path, {'consent': True})
            assert status == 403
            mocks['mint'].assert_not_called()
            mocks['end'].assert_not_called()

    def test_a_stranger_reaches_nothing(self, call):
        status, _body, mocks = call(STRANGER, 'GET', OFFER)
        assert status in (403, 404)
        mocks['offer'].assert_not_called()

    def test_an_editor_starts_as_themselves_with_their_own_scope(self, call):
        status, body, mocks = call(EDITOR, 'POST', OFFER, {'consent': True, 'language': 'fr'})
        assert (status, body) == (201, {'session_id': 's-1'})
        _stores, _config, project_id, persona_id, caller, request, scope = mocks['mint'].call_args.args
        assert (project_id, persona_id, caller.subject, request) == ('p1', 'persona_1', EDITOR['sub'],
                                                                    {'consent': True, 'language': 'fr'})
        assert scope is mocks['scope'].return_value

    def test_an_editor_ends_with_202(self, call):
        status, body, mocks = call(EDITOR, 'POST', f'{SESSION}/end')
        assert (status, body) == (202, {'status': 'finalizing'})
        assert mocks['end'].call_args.args[2:5] == ('p1', 'persona_1', 's-1')


class TestTheMonth:
    def test_admins_only(self, call):
        assert call(ADMIN, 'GET', '/projects/voice/usage')[:2] == (200, {'enabled': True})
        status, _body, mocks = call(EDITOR, 'GET', '/projects/voice/usage')
        assert status == 403
        mocks['usage'].assert_not_called()

    def test_voice_is_never_a_project_id(self, call):
        status, _body, mocks = call(ADMIN, 'GET', '/projects/voice/personas/persona_1/voice-sessions')
        assert status == 404
        mocks['offer'].assert_not_called()


class TestAPersonOnly:
    def test_an_mcp_credential_is_never_an_admin_of_the_month(self, call):
        delegated = {'sub': 'mcp:tok1', 'cognito:groups': 'admins', 'email': 'mcp:tok1',
                     'voc:acting_subject': ADMIN['sub']}
        status, _body, mocks = call(delegated, 'GET', '/projects/voice/usage')
        assert status == 403
        mocks['usage'].assert_not_called()


class TestWithoutTheFlag:
    def test_a_start_answers_voice_off(self, call, monkeypatch):
        monkeypatch.delenv('VOICE_PERSONAS')
        with patch('shared.voice_sessions.mint') as mint:
            status, body, _mocks = call(EDITOR, 'POST', OFFER, {'consent': True})
        assert (status, body.get('code')) == (404, 'voice_off')
        mint.assert_not_called()


def test_the_transcript_job_is_the_assist_worker_s():
    import projects_handler
    from shared import voice_session_routes

    work = projects_handler.ASSIST_WORK[voice_session_routes.ASSIST_VOICE_FINALIZE]
    with patch('shared.voice_transcripts.finalize', return_value={'document_id': 'doc_1'}) as finalize, \
            patch('shared.voice_session_routes._stores', return_value='stores'):
        assert work.run({'project_id': 'p1'}) == {'document_id': 'doc_1'}
    finalize.assert_called_once_with('stores', {'project_id': 'p1'})
