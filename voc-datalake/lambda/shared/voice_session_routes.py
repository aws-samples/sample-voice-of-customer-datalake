"""The voice sessions' routes (7.69.00, ``-c voicePersonas=true``; docs/voice-personas.md), on the projects API's
``/projects/{proxy+}``: no new API Gateway resource. Included by ``api/projects_handler.py``, whose project-access
middleware has already gated the project in the path (GET is view, POST is edit: shared.project_access):

- ``GET /projects/{id}/personas/{persona_id}/voice-sessions`` (view) — the offer: the persona's voice, the languages,
  the month's minutes and the day's sessions left, the estimated cost per minute; ``{enabled: false}`` without voice;
- ``POST …/voice-sessions`` ``{consent: true, language?}`` (edit; a person, never an MCP credential or an agent) —
  201 ``{session_id, connect_url, expires_in: 60, …}``: the checks of shared/voice_sessions.py ``mint``;
- ``GET …/voice-sessions/{session_id}`` (view) — its state; its starter's read of an ended session saves its
  transcript;
- ``POST …/voice-sessions/{session_id}/end`` (edit; its starter or an admin) — 202: stop, mark ended, save;
- ``GET /projects/voice/usage`` — the deployment's month, for admins acting as themselves (``voice`` is no project id:
  shared/project_access.py ``NON_PROJECT_SEGMENTS``).

Saving a transcript is the assist job ``assist_voice_finalize`` (shared/voice_transcripts.py), run by the projects
assist twin (``ASSIST_WORK`` in the handler); the client polls the session or the job.
"""
from __future__ import annotations

import json
import os
from collections.abc import Mapping
from typing import Any, Final

from aws_lambda_powertools.event_handler import Response, content_types
from aws_lambda_powertools.event_handler.api_gateway import Router

from shared import assist_jobs, category_gate, company_personas_routes, voice_sessions, voice_transcripts
from shared.aws import get_s3_client
from shared.logging import tracer
from shared.project_gate import require_admin_caller
from shared.project_keys import project_pk
from shared.request_body import json_object_body
from shared.tables import configured_table, get_aggregates_table, get_feedback_table, get_projects_table
from shared.voice_sessions import StartFinalize, Stores, VoiceConfig

app = Router()

#: The transcript's assist job (``ASSIST_WORK`` in api/projects_handler.py).
ASSIST_VOICE_FINALIZE: Final = 'assist_voice_finalize'
FINALIZE_FAILED: Final = 'The interview transcript could not be saved.'


def _stores() -> Stores:
    return Stores(
        projects=configured_table(get_projects_table(), 'Projects'),
        aggregates=configured_table(get_aggregates_table(), 'Aggregates'),
        feedback=configured_table(get_feedback_table(), 'Feedback'),
        s3=get_s3_client(), bucket=os.environ.get('RAW_DATA_BUCKET', ''),
    )


def _start_finalize(project_id: str) -> StartFinalize:
    """Start a session's transcript job in its project's partition (polled like every project assist job)."""
    def start(row: Mapping[str, Any]) -> str:
        started = assist_jobs.start(
            project_pk(project_id), ASSIST_VOICE_FINALIZE,
            {'project_id': project_id, 'persona_id': str(row['persona_id']), 'session_id': str(row['session_id'])},
            worker_function=assist_jobs.worker_function(), initiated_by=str(row.get('starter_sub') or ''),
            project_id=project_id)
        return str(started['job_id'])
    return start


def finalize_work(config: dict) -> dict:
    """``assist_voice_finalize``: the session's transcript as a ``persona_interview`` document."""
    return voice_transcripts.finalize(_stores(), config)


@app.get("/projects/<project_id>/personas/<persona_id>/voice-sessions")
@tracer.capture_method
def voice_session_offer(project_id: str, persona_id: str) -> dict[str, Any]:
    caller = company_personas_routes.caller_of(app)
    return voice_sessions.offer(_stores(), VoiceConfig.from_env(), project_id, persona_id, caller)


@app.post("/projects/<project_id>/personas/<persona_id>/voice-sessions")
@tracer.capture_method
def start_voice_session(project_id: str, persona_id: str):
    config = voice_sessions.require_config()
    caller = company_personas_routes.caller_of(app)
    scope = category_gate.scope_for_event(app.current_event.raw_event, get_aggregates_table())
    started = voice_sessions.mint(_stores(), config, project_id, persona_id, caller, json_object_body(app), scope)
    return Response(status_code=201, content_type=content_types.APPLICATION_JSON, body=json.dumps(started))


@app.get("/projects/<project_id>/personas/<persona_id>/voice-sessions/<session_id>")
@tracer.capture_method
def voice_session_status(project_id: str, persona_id: str, session_id: str) -> dict[str, Any]:
    voice_sessions.require_config()
    caller = company_personas_routes.caller_of(app)
    return voice_sessions.status(_stores(), project_id, persona_id, session_id, caller, _start_finalize(project_id))


@app.post("/projects/<project_id>/personas/<persona_id>/voice-sessions/<session_id>/end")
@tracer.capture_method
def end_voice_session(project_id: str, persona_id: str, session_id: str):
    config = voice_sessions.require_config()
    caller = company_personas_routes.caller_of(app)
    ended = voice_sessions.end(_stores(), config, project_id, persona_id, session_id, caller,
                               _start_finalize(project_id))
    return Response(status_code=202, content_type=content_types.APPLICATION_JSON, body=json.dumps(ended))


@app.get("/projects/voice/usage")
@tracer.capture_method
def voice_usage() -> dict[str, Any]:
    require_admin_caller(company_personas_routes.caller_of(app))
    return voice_sessions.usage(_stores(), VoiceConfig.from_env())
