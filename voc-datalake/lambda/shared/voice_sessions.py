"""Voice sessions: talk to a project's personas out loud (7.69.00, ``-c voicePersonas=true``; docs/voice-personas.md).

The projects API (shared/voice_session_routes.py) decides everything about a session before it starts and the relay
(lambda/stream/src/voice/, an AgentCore Runtime) only carries it out:

* **The offer** (``offer``): the persona's voice, the languages, this month's minutes left, today's sessions left and
  the estimated cost per minute, for the consent dialog.
* **The start** (``mint``), in this order: the flag; consent; a project persona (never a company persona); a person
  acting for themselves (never an MCP credential or an agent); a minute left in the deployment's month
  (``VOICEUSE#DEPLOYMENT#<yyyy-mm>``); a free stream (at most ``max_concurrent`` live sessions, ``VOICEUSE#LIVE``); at
  most ``CREATES_PER_MINUTE`` starts a minute and ``DAILY_SESSIONS`` sessions a day per person (``VOICERATE#`` and
  ``VOICEDAY#`` rows, kept 2 days). Then the persona's evidence pack (shared/persona_grounding.py, read as the person:
  their category and source access) and profile go to ``scratch/voice/<session>/evidence.json`` (scratch/ expires
  after 2 days), the session row ``VOICE#<session>`` / ``SESSION`` is written (its own partition, so IAM can hold the
  relay to it: ``dynamodb:LeadingKeys``) with a listing pointer under the project, and the browser gets a WebSocket URL
  presigned with this function's own credentials (SigV4 query auth, ``bedrock-agentcore``) for **60 seconds**, for
  this one session id and this one project, both signed. The browser never holds AWS credentials, and the relay
  accepts the URL once (``status: minted -> live``).
* **The end** (``end``): the relay ends a session itself (End, the time limit, the session's cost cap, the month's
  budget, a disconnect); the person's End also stops the runtime session and marks the row, then the transcript is
  saved by an assist job (shared/voice_transcripts.py). A session whose End never came (a closed tab, an End that
  failed) is saved by its starter's next read of it or of the project's offer (``_save_left_sessions``). **Audio is
  never stored**, by either side.
* **Spend:** the month's minutes and a cost cap (``MAX_CENTS_PER_MINUTE`` a minute of them), and each session's own
  cost cap at the same rate, are checked at the start and by the relay (every minute for the month, at every usage
  event for the session).

Projects are the deployment's until phase 3 (docs/multi-workspace.md), so every key here is the deployment's: a
session's partition, the month's usage and the live set have no ``WS#`` variant yet, and ``require_deployment``
refuses a workspace as the persona grounding does.
"""
from __future__ import annotations

import hashlib
import json
import os
import uuid
from collections.abc import Callable, Iterable, Mapping
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any, Final
from urllib.parse import quote, urlencode

import boto3
from botocore.auth import SigV4QueryAuth
from botocore.awsrequest import AWSRequest

from shared import persona_grounding
from shared.aws import get_agentcore_client, is_conditional_check_failure
from shared.category_access import CategoryScope
from shared.company_personas import is_company_container
from shared.dynamo_paging import query_all
from shared.dynamo_values import as_count, plain
from shared.engagement_common import conditional_write
from shared.exceptions import (
    AuthorizationError,
    ConflictError,
    NotFoundError,
    TooManyRequestsError,
    ValidationError,
)
from shared.logging import logger
from shared.project_access import Caller
from shared.project_keys import PROJECT_GATE_STORE, project_pk, require_deployment
from shared.project_writes import project_meta_key
from shared.ws_repo import WorkspaceScope

#: The one env var the deployment's voice settings come in (lib/utils/voice-personas.ts ``voiceApiEnvironment``).
VOICE_PERSONAS_ENV: Final = 'VOICE_PERSONAS'
#: The model ids the flag takes (lib/utils/voice-personas.ts VOICE_MODEL_IDS; a lockstep test pins both lists).
VOICE_MODEL_IDS: Final = ('amazon.nova-2-5-sonic', 'amazon.nova-2-sonic-v1:0')
#: Nova Sonic's voices and the grammatical gender each speaks with (lambda/stream/src/voice/protocol.ts VOICES).
VOICES: Final[Mapping[str, str]] = {
    'tiffany': 'feminine', 'matthew': 'masculine', 'amy': 'feminine', 'olivia': 'feminine', 'kiara': 'feminine',
    'arjun': 'masculine', 'ambre': 'feminine', 'florian': 'masculine', 'beatrice': 'feminine', 'lorenzo': 'masculine',
    'tina': 'feminine', 'lennart': 'masculine', 'lupe': 'feminine', 'carlos': 'masculine', 'carolina': 'feminine',
    'leo': 'masculine',
}
#: The deterministic default: the two voices that speak every supported language, by a hash of the persona's id,
#: never by its name, picture or anything that could stereotype.
DEFAULT_VOICE_PAIR: Final = ('tiffany', 'matthew')
#: Our UI locales the model speaks, and those it does not (protocol.ts VOICE_LANGUAGES).
VOICE_LANGUAGES: Final = ('en', 'de', 'es', 'fr', 'pt')
UNSUPPORTED_LANGUAGES: Final = ('ja', 'ko', 'pl', 'zh')
UI_LANGUAGES: Final = (*VOICE_LANGUAGES, *UNSUPPORTED_LANGUAGES)

#: The URL's life: the browser connects within it (an established connection outlives it).
CONNECT_SECONDS: Final = 60
#: How long after the row's ``connect_by`` the relay still takes a first connection, for the two clocks (store.ts
#: ``CONNECT_SKEW_SECONDS``, the same 10 s; a test pins both): a row still minted is ended only once it has passed
#: too, so ``status`` never ends a session the relay would still start.
CONNECT_SKEW_SECONDS: Final = 10
#: The approved per-person limits: sessions a day, and starts a minute (a rate limit on creation).
DAILY_SESSIONS: Final = 5
CREATES_PER_MINUTE: Final = 3
#: What the consent dialog shows before a session (Nova 2.5 Sonic in us-west-2, the S-15 spike's measured mix); the
#: session's own cost is the relay's, from the model's usage events.
ESTIMATED_CENTS_PER_MINUTE: Final = 2
#: The cost caps' rate: 2.5 times the estimate, which a conversation does not reach (the microphone is held to real
#: time, the persona speaks at most the whole minute). A session's cap is its minutes at this rate (75 cents for 15
#: minutes), the month's its minutes at it ($15 for 300): at the session's the relay ends it (``cost_limit``), at the
#: month's it ends it (``budget``) and the month refuses a start.
MAX_CENTS_PER_MINUTE: Final = 5
MICRO_USD_PER_CENT: Final = 10_000
#: The caller's newest sessions of a project an offer saves when they ended without End (every start reads the offer
#: first, so a session left unsaved is among them).
LEFT_SESSIONS: Final = DAILY_SESSIONS
#: A live-set entry outlives its session by this much (the relay removes it at the end; this covers a relay that died).
LIVE_SLACK_SECONDS: Final = 120
#: How long the counters are kept: a day's and a minute's for 2 days, a month's usage for 400 days.
COUNTER_TTL: Final = timedelta(days=2)
USAGE_TTL: Final = timedelta(days=400)

#: AgentCore's signed query parameters: the session id (one microVM) and the one custom header the runtime forwards.
SESSION_PARAM: Final = 'X-Amzn-Bedrock-AgentCore-Runtime-Session-Id'
SCOPE_PARAM: Final = 'X-Amzn-Bedrock-AgentCore-Runtime-Custom-Voc-Scope'

SESSION_SK: Final = 'SESSION'
SESSION_PREFIX: Final = 'VOICE#'
USAGE_SK: Final = 'USAGE'
LIVE_KEY: Final[Mapping[str, str]] = {'pk': 'VOICEUSE#LIVE', 'sk': 'LIVE'}
SCRATCH_PREFIX: Final = 'scratch/voice/'
REASON: Final = 'voice_interview'

STATUS_MINTED: Final = 'minted'
STATUS_LIVE: Final = 'live'
STATUS_ENDED: Final = 'ended'
STATUS_FINALIZING: Final = 'finalizing'
STATUS_FINALIZED: Final = 'finalized'
STATUS_FAILED: Final = 'failed'
#: Why the API ended a session itself (the relay's reasons: protocol.ts VOICE_END_REASONS).
END_BY_PERSON: Final = 'ended_by_person'
END_NEVER_CONNECTED: Final = 'disconnected'


@dataclass(frozen=True)
class VoiceConfig:
    """The deployment's voice settings (``-c voicePersonas`` and its companions), and its Region."""

    runtime_arn: str
    model_id: str
    monthly_minutes: int
    session_minutes: int
    max_concurrent: int
    region: str

    @classmethod
    def from_env(cls) -> VoiceConfig | None:
        """The settings, or None when the deployment has no voice (the flag off, or the value unreadable)."""
        raw = os.environ.get(VOICE_PERSONAS_ENV, '')
        if not raw:
            return None
        try:
            value = json.loads(raw)
            config = cls(
                runtime_arn=str(value['runtime_arn']), model_id=str(value['model_id']),
                monthly_minutes=int(value['monthly_minutes']), session_minutes=int(value['session_minutes']),
                max_concurrent=int(value['max_concurrent']),
                region=os.environ.get('AWS_REGION', '') or os.environ.get('AWS_DEFAULT_REGION', ''),
            )
        except (ValueError, KeyError, TypeError):
            logger.exception('VOICE_PERSONAS is unreadable: voice sessions are off')
            return None
        if config.model_id not in VOICE_MODEL_IDS or not config.runtime_arn.startswith('arn:') or not config.region:
            logger.error('VOICE_PERSONAS names no usable runtime, model or Region: voice sessions are off')
            return None
        return config


def require_config() -> VoiceConfig:
    """The settings, or a 404 ``voice_off`` (the flag is off in this deployment)."""
    config = VoiceConfig.from_env()
    if config is None:
        raise NotFoundError('Voice sessions are not available in this deployment', code='voice_off')
    return config


# ── Voices and languages ─────────────────────────────────────────────────────────────────────────────────────────

def validated_voice_id(value: object) -> str | None:
    """A persona's chosen voice (``PUT …/personas/{id}`` ``voice_id``): one of ``VOICES``, or None for the default."""
    if value is None or value == '':
        return None
    if not isinstance(value, str) or value not in VOICES:
        raise ValidationError(f'voice_id must be one of {", ".join(VOICES)}, or null for the default')
    return value


def default_voice(persona_id: str) -> str:
    """The persona's default voice: the polyglot pair, picked by the first byte of its id's SHA-256."""
    return DEFAULT_VOICE_PAIR[hashlib.sha256(persona_id.encode('utf-8')).digest()[0] % len(DEFAULT_VOICE_PAIR)]


def persona_voice(persona: Mapping[str, Any]) -> str:
    """The voice a persona speaks with: its chosen one, else its default."""
    chosen = persona.get('voice_id')
    return chosen if isinstance(chosen, str) and chosen in VOICES else default_voice(str(persona.get('persona_id')))


def languages() -> dict[str, list[str]]:
    return {'supported': list(VOICE_LANGUAGES), 'unsupported': list(UNSUPPORTED_LANGUAGES)}


def _language(value: object) -> str:
    """The person's UI language, the prompt's fallback when the model cannot tell (``en`` when absent)."""
    if value is None:
        return 'en'
    if not isinstance(value, str) or value not in UI_LANGUAGES:
        raise ValidationError(f'language must be one of {", ".join(UI_LANGUAGES)}')
    return value


# ── Keys ─────────────────────────────────────────────────────────────────────────────────────────────────────────

def session_key(session_id: str) -> dict[str, str]:
    return {'pk': f'{SESSION_PREFIX}{session_id}', 'sk': SESSION_SK}


def pointer_key(project_id: str, session_id: str) -> dict[str, str]:
    """The project's listing pointer to its session (the projects API's alone: the relay cannot reach ``PROJECT#``)."""
    return {'pk': project_pk(project_id), 'sk': f'{SESSION_PREFIX}{session_id}'}


def session_keys_of_pointers(keys: Iterable[Mapping[str, str]]) -> list[dict[str, str]]:
    """The session rows a project's partition points to (its ``VOICE#<session>`` sort keys): a project delete
    removes them with the pointers."""
    return [session_key(key['sk'].removeprefix(SESSION_PREFIX)) for key in keys
            if str(key.get('sk', '')).startswith(SESSION_PREFIX)]


def usage_key(now: datetime) -> dict[str, str]:
    return {'pk': f'VOICEUSE#DEPLOYMENT#{now:%Y-%m}', 'sk': USAGE_SK}


def _day_key(subject: str, now: datetime) -> dict[str, str]:
    return {'pk': f'VOICEDAY#{subject}#{now:%Y-%m-%d}', 'sk': 'COUNT'}


def _rate_key(subject: str, now: datetime) -> dict[str, str]:
    return {'pk': f'VOICERATE#{subject}#{now:%Y%m%d%H%M}', 'sk': 'COUNT'}


def scratch_prefix(session_id: str) -> str:
    return f'{SCRATCH_PREFIX}{session_id}/'


def evidence_key(session_id: str) -> str:
    return f'{scratch_prefix(session_id)}evidence.json'


def transcript_key(session_id: str, part: int) -> str:
    return f'{scratch_prefix(session_id)}transcript/part-{part:04d}.json'


# ── The presigned URL ────────────────────────────────────────────────────────────────────────────────────────────

def connect_url(config: VoiceConfig, session_id: str, scope: str, credentials: Any) -> str:
    """The browser's ``wss://`` URL to the relay for this one session: SigV4 query auth for ``bedrock-agentcore``
    (as the AgentCore SDK's ``generate_presigned_url``), valid ``CONNECT_SECONDS``, the session id and the scope among
    the signed parameters, so neither can be changed. No AWS call is made."""
    host = f'bedrock-agentcore.{config.region}.amazonaws.com'
    path = f'/runtimes/{quote(config.runtime_arn, safe="")}/ws'
    query = urlencode({SESSION_PARAM: session_id, SCOPE_PARAM: scope})
    request = AWSRequest(method='GET', url=f'https://{host}{path}?{query}', headers={'host': host})
    SigV4QueryAuth(credentials, 'bedrock-agentcore', config.region, expires=CONNECT_SECONDS).add_auth(request)
    return 'wss://' + str(request.url).removeprefix('https://')


def _own_credentials() -> Any:
    """This function's role's credentials, frozen (the URL carries its session token, never its secret)."""
    credentials = boto3.Session().get_credentials()
    if credentials is None:
        raise AuthorizationError('Voice sessions cannot be signed here')
    return credentials.get_frozen_credentials()


# ── The stores a session touches ─────────────────────────────────────────────────────────────────────────────────

@dataclass(frozen=True)
class Stores:
    """The tables, the bucket and the clock (each injectable for a test)."""

    projects: Any
    aggregates: Any
    feedback: Any
    s3: Any
    bucket: str
    now: Callable[[], datetime] = field(default=lambda: datetime.now(UTC))
    credentials: Callable[[], Any] = _own_credentials
    new_id: Callable[[], str] = field(default=lambda: str(uuid.uuid4()))


def _project_persona(stores: Stores, project_id: str, persona_id: str) -> dict[str, Any]:
    if is_company_container(project_id):
        raise ValidationError('Only a project\'s personas can be talked to by voice')
    persona = stores.projects.get_item(Key={'pk': project_pk(project_id), 'sk': f'PERSONA#{persona_id}'}).get('Item')
    if not isinstance(persona, dict):
        raise NotFoundError('Persona not found')
    return persona


@dataclass(frozen=True)
class _Month:
    """The deployment's month so far: its seconds and its cost."""

    seconds: int
    cost_microusd: int


def _month_of(item: Mapping[str, Any]) -> _Month:
    return _Month(seconds=as_count(item.get('seconds')), cost_microusd=as_count(item.get('cost_microusd')))


def _month_used(stores: Stores, now: datetime) -> _Month:
    return _month_of(stores.aggregates.get_item(Key=usage_key(now), ConsistentRead=True).get('Item') or {})


def _monthly_cost_cap(config: VoiceConfig) -> int:
    """The month's cost cap in micro-dollars: its minutes at ``MAX_CENTS_PER_MINUTE``."""
    return config.monthly_minutes * MAX_CENTS_PER_MINUTE * MICRO_USD_PER_CENT


def _session_cost_cap(session_seconds: int) -> int:
    """One session's cost cap in micro-dollars: its minutes at ``MAX_CENTS_PER_MINUTE``."""
    return session_seconds * MAX_CENTS_PER_MINUTE * MICRO_USD_PER_CENT // 60


def _seconds_left(config: VoiceConfig, month: _Month) -> int:
    """The month's seconds left: none once its cost reached the cap."""
    if month.cost_microusd >= _monthly_cost_cap(config):
        return 0
    return max(0, config.monthly_minutes * 60 - month.seconds)


def _minutes_left(config: VoiceConfig, month: _Month) -> float:
    return round(_seconds_left(config, month) / 60, 1)


def _sessions_today(stores: Stores, subject: str, now: datetime) -> int:
    return as_count((stores.aggregates.get_item(Key=_day_key(subject, now)).get('Item') or {}).get('count'))


def _require_person(caller: Caller) -> str:
    """The person starting or ending a session: never a delegated credential or an agent (a voice is a person's)."""
    if caller.delegated or caller.agent_id or not caller.subject:
        raise AuthorizationError('A voice session is started by a person signed in to the app', code='person_only')
    return caller.subject


def offer(stores: Stores, config: VoiceConfig | None, project_id: str, persona_id: str, caller: Caller, *,
          start_finalize: StartFinalize, workspace: WorkspaceScope | None = None) -> dict[str, Any]:
    """What a session with this persona would be (the consent dialog's figures), or ``{enabled: false}``; first the
    caller's sessions of this project that ended without End are saved (``start_finalize`` starts each one's job)."""
    require_deployment(workspace, PROJECT_GATE_STORE)
    if config is None:
        return {'enabled': False}
    persona = _project_persona(stores, project_id, persona_id)
    now = stores.now()
    voice = persona_voice(persona)
    _save_left_sessions(stores, project_id, caller, start_finalize)
    return {
        'enabled': True, 'voice_id': voice, 'voice_gender': VOICES[voice], 'languages': languages(),
        'session_minutes': config.session_minutes, 'minutes_left': _minutes_left(config, _month_used(stores, now)),
        'sessions_left_today': max(0, DAILY_SESSIONS - _sessions_today(stores, caller.subject, now)),
        'estimated_cents_per_minute': ESTIMATED_CENTS_PER_MINUTE,
    }


def _count_once(table: Any, key: Mapping[str, str], limit: int, now: datetime, code: str, message: str) -> None:
    """``count`` + 1 on ``key`` unless it is already ``limit`` (429 ``code``); the row expires after 2 days."""
    try:
        table.update_item(
            Key=dict(key), UpdateExpression='ADD #count :one SET #ttl = :ttl',
            ConditionExpression='attribute_not_exists(#count) OR #count < :limit',
            ExpressionAttributeNames={'#count': 'count', '#ttl': 'ttl'},
            ExpressionAttributeValues={':one': 1, ':limit': limit, ':ttl': int((now + COUNTER_TTL).timestamp())})
    except Exception as error:
        if is_conditional_check_failure(error):
            raise TooManyRequestsError(message, code=code) from error
        raise


def _uncount(table: Any, key: Mapping[str, str]) -> None:
    """Give back a day's session a start counted and could not finish (best effort: the count is a ceiling)."""
    try:
        table.update_item(Key=dict(key), UpdateExpression='ADD #count :minus',
                          ExpressionAttributeNames={'#count': 'count'}, ExpressionAttributeValues={':minus': -1})
    except Exception:  # noqa: BLE001 - the session did not start either way
        logger.warning('A voice session start could not give back its daily count')


def _claim_stream(stores: Stores, config: VoiceConfig, session_id: str, session_seconds: int, now: datetime) -> None:
    """Add the session to the live set unless ``max_concurrent`` are live (429 ``busy``); expired entries go.

    One read and one conditional write on the set's ``version``, so two starts at once cannot both take the last
    stream (the one that loses answers ``busy``). The relay removes its own entry at the end (``REMOVE live.<id>``,
    which leaves the version alone); an entry it could not remove expires ``LIVE_SLACK_SECONDS`` after its session.
    """
    item = stores.aggregates.get_item(Key=dict(LIVE_KEY), ConsistentRead=True).get('Item') or {}
    entries = item.get('live') if isinstance(item.get('live'), dict) else None
    epoch = int(now.timestamp())
    live = [sid for sid, expires in (entries or {}).items() if as_count(expires) > epoch]
    if len(live) >= config.max_concurrent:
        raise TooManyRequestsError('Voice is busy: every stream is in use. Try again in a few minutes.', code='busy')
    version = as_count(item.get('version'))
    expires = epoch + CONNECT_SECONDS + session_seconds + LIVE_SLACK_SECONDS
    names = {'#live': 'live', '#version': 'version'}
    values: dict[str, Any] = {':next': version + 1, ':version': version}
    if entries is None:
        update = 'SET #live = :live, #version = :next'
        values[':live'] = {session_id: expires}
    else:
        expired = [sid for sid in entries if sid not in live]
        names |= {'#sid': session_id, **{f'#x{index}': sid for index, sid in enumerate(expired)}}
        removes = ', '.join(f'#live.#x{index}' for index in range(len(expired)))
        update = 'SET #live.#sid = :expires, #version = :next' + (f' REMOVE {removes}' if removes else '')
        values[':expires'] = expires
    try:
        stores.aggregates.update_item(
            Key=dict(LIVE_KEY), UpdateExpression=update, ExpressionAttributeNames=names,
            ExpressionAttributeValues=values, ConditionExpression='attribute_not_exists(#version) OR #version = :version')
    except Exception as error:
        if is_conditional_check_failure(error):
            raise TooManyRequestsError('Voice is busy. Try again in a moment.', code='busy') from error
        raise


def release_stream(stores: Stores, session_id: str) -> None:
    """Take the session out of the live set (the relay does at its end; End does too). Never raises."""
    try:
        stores.aggregates.update_item(Key=dict(LIVE_KEY), UpdateExpression='REMOVE #live.#sid',
                                      ExpressionAttributeNames={'#live': 'live', '#sid': session_id})
    except Exception:  # noqa: BLE001 - an entry left behind expires by itself
        logger.warning('A voice session could not leave the live set', extra={'session_id': session_id})


# ── Start ────────────────────────────────────────────────────────────────────────────────────────────────────────

#: The profile fields the relay's prompt reads (lambda/stream/src/context/persona-fields.ts), nothing else of the row.
PROFILE_FIELDS: Final = ('persona_id', 'name', 'tagline', 'quotes', 'goals_motivations', 'pain_points')


def _evidence(stores: Stores, project_id: str, persona: Mapping[str, Any], scope: CategoryScope) -> list[dict]:
    """The persona's evidence pack, read as the person (their category and source access): its cited reviews and the
    fresh ones that match it, at most ``MAX_STORED_EVIDENCE`` + ``MAX_FRESH``, each an id and a screened, clipped
    quote."""
    reader = persona_grounding.Reader(projects_table=stores.projects, feedback_table=stores.feedback, scope=scope)
    pack = persona_grounding.evidence_pack(reader, project_id, [str(persona['persona_id'])], '',
                                           persona_grounding.MAX_FRESH)
    personas = pack.get('personas') or []
    return list(personas[0].get('evidence') or []) if personas else []


def _project_name(stores: Stores, project_id: str) -> str:
    meta = stores.projects.get_item(Key=project_meta_key(project_id)).get('Item') or {}
    return str(meta.get('name') or '')


@dataclass(frozen=True)
class _Start:
    """One start's decided values."""

    session_id: str
    subject: str
    voice_id: str
    language: str
    session_seconds: int
    minutes_left: float
    now: datetime


def _write_scratch_and_rows(stores: Stores, config: VoiceConfig, project_id: str, persona: Mapping[str, Any],
                            start: _Start, scope: CategoryScope) -> None:
    sid, now = start.session_id, start.now
    usage = usage_key(now)
    evidence = {
        'version': 1, 'session_id': sid, 'project_id': project_id, 'project_name': _project_name(stores, project_id),
        'persona': {name: persona[name] for name in PROFILE_FIELDS if name in persona},
        'evidence': _evidence(stores, project_id, persona, scope),
        'voice_id': start.voice_id, 'voice_gender': VOICES[start.voice_id], 'language': start.language,
        'session_seconds': start.session_seconds, 'monthly_seconds': config.monthly_minutes * 60,
        'minutes_left': start.minutes_left, 'usage_key': usage['pk'],
        'session_cost_cap_microusd': _session_cost_cap(start.session_seconds),
        'monthly_cost_cap_microusd': _monthly_cost_cap(config),
    }
    stores.s3.put_object(Bucket=stores.bucket, Key=evidence_key(sid), ContentType='application/json',
                         Body=json.dumps(plain(evidence)).encode('utf-8'))
    at = now.isoformat()
    stores.projects.put_item(Item={
        **session_key(sid), 'session_id': sid, 'project_id': project_id, 'persona_id': persona['persona_id'],
        'starter_sub': start.subject, 'status': STATUS_MINTED, 'created_at': at, 'consent_at': at, 'reason': REASON,
        'connect_by': int(now.timestamp()) + CONNECT_SECONDS, 'voice_id': start.voice_id, 'model_id': config.model_id,
        'language': start.language, 'session_seconds': start.session_seconds,
        'monthly_seconds': config.monthly_minutes * 60, 'usage_key': usage['pk'], 'evidence_key': evidence_key(sid),
        'seconds': 0, 'transcript_parts': 0, 'streams': 0,
    }, ConditionExpression='attribute_not_exists(pk)')
    stores.projects.put_item(Item={
        **pointer_key(project_id, sid), 'session_id': sid, 'persona_id': persona['persona_id'],
        'starter_sub': start.subject, 'created_at': at,
    })
    stores.aggregates.update_item(
        Key=usage, UpdateExpression='ADD sessions :one SET #ttl = if_not_exists(#ttl, :ttl)',
        ExpressionAttributeNames={'#ttl': 'ttl'},
        ExpressionAttributeValues={':one': 1, ':ttl': int((now + USAGE_TTL).timestamp())})


def mint(stores: Stores, config: VoiceConfig, project_id: str, persona_id: str, caller: Caller, body: Mapping[str, Any],
         scope: CategoryScope, *, workspace: WorkspaceScope | None = None) -> dict[str, Any]:
    """Start a session (the module's checks, in their order) and answer its 60-second URL."""
    require_deployment(workspace, PROJECT_GATE_STORE)
    subject = _require_person(caller)
    if body.get('consent') is not True:
        raise ValidationError('Consent is required: the transcript is kept, the audio never is, and the voice is '
                              'synthetic', code='consent_required')
    language = _language(body.get('language'))
    persona = _project_persona(stores, project_id, persona_id)
    now = stores.now()
    month = _month_used(stores, now)
    remaining = _seconds_left(config, month)
    if remaining < 60:
        raise ConflictError('This month\'s voice minutes are used up', code='budget_exhausted')
    _count_once(stores.aggregates, _rate_key(subject, now), CREATES_PER_MINUTE, now, 'rate_limited',
                'Too many voice sessions started in a minute. Wait a moment and try again.')
    day = _day_key(subject, now)
    _count_once(stores.aggregates, day, DAILY_SESSIONS, now, 'daily_limit',
                f'You have had today\'s {DAILY_SESSIONS} voice sessions. Try again tomorrow.')
    start = _Start(session_id=stores.new_id(), subject=subject, voice_id=persona_voice(persona), language=language,
                   session_seconds=min(config.session_minutes * 60, remaining),
                   minutes_left=_minutes_left(config, month), now=now)
    try:
        _claim_stream(stores, config, start.session_id, start.session_seconds, now)
    except TooManyRequestsError:
        _uncount(stores.aggregates, day)
        raise
    try:
        _write_scratch_and_rows(stores, config, project_id, persona, start, scope)
    except Exception:
        _uncount(stores.aggregates, day)
        release_stream(stores, start.session_id)
        raise
    url = connect_url(config, start.session_id, project_id, stores.credentials())
    logger.info('Voice session started', extra={
        'project_id': project_id, 'persona_id': persona_id, 'session_id': start.session_id})
    return {
        'session_id': start.session_id, 'connect_url': url, 'expires_in': CONNECT_SECONDS,
        'minutes_left': start.minutes_left, 'session_minutes': round(start.session_seconds / 60, 1),
        'voice_id': start.voice_id, 'voice_gender': VOICES[start.voice_id], 'languages': languages(),
        'estimated_cents_per_minute': ESTIMATED_CENTS_PER_MINUTE,
    }


# ── A session's state, its end and its transcript's start ────────────────────────────────────────────────────────

StartFinalize = Callable[[Mapping[str, Any]], str]
"""Start the transcript's assist job for a session row; its job id (the routes' ``assist_jobs.start``)."""


def session_row(stores: Stores, project_id: str, persona_id: str, session_id: str) -> dict[str, Any]:
    """The session, only through the project's own pointer (the relay can write a session row, never a pointer), so a
    session is answered and saved only under the project and persona that started it; 404 otherwise."""
    pointer = stores.projects.get_item(Key=pointer_key(project_id, session_id), ConsistentRead=True).get('Item')
    row = stores.projects.get_item(Key=session_key(session_id), ConsistentRead=True).get('Item')
    if (not isinstance(pointer, dict) or not isinstance(row, dict) or pointer.get('persona_id') != persona_id
            or row.get('project_id') != project_id or row.get('persona_id') != persona_id):
        raise NotFoundError('Voice session not found')
    return row


def view(row: Mapping[str, Any]) -> dict[str, Any]:
    """What a session answers: its state and meter, never its evidence or its transcript."""
    return {
        'session_id': row.get('session_id'), 'persona_id': row.get('persona_id'), 'status': row.get('status'),
        'seconds': as_count(row.get('seconds')), 'cost_cents': round(as_count(row.get('cost_microusd')) / 10_000, 2),
        'end_reason': row.get('end_reason'), 'started_at': row.get('connected_at') or row.get('created_at'),
        'ended_at': row.get('ended_at'), 'transcript_document_id': row.get('transcript_document_id'),
        'job_id': row.get('finalize_job_id'),
    }


def _mark_ended(stores: Stores, session_id: str, reason: str, now: datetime) -> None:
    """``ended`` for a session still minted or live (the relay may have ended it first: then it stays as it says)."""
    conditional_write(
        stores.projects.update_item, Key=session_key(session_id),
        UpdateExpression='SET #status = :ended, ended_at = if_not_exists(ended_at, :at), '
                         'end_reason = if_not_exists(end_reason, :reason)',
        ConditionExpression='#status IN (:minted, :live)', ExpressionAttributeNames={'#status': 'status'},
        ExpressionAttributeValues={':ended': STATUS_ENDED, ':at': now.isoformat(), ':reason': reason,
                                   ':minted': STATUS_MINTED, ':live': STATUS_LIVE})


def _finalize(stores: Stores, row: dict[str, Any], start_finalize: StartFinalize) -> dict[str, Any]:
    """Claim an ended session's transcript (``ended -> finalizing``, once) and start its assist job."""
    sid = str(row['session_id'])
    if not conditional_write(
            stores.projects.update_item, Key=session_key(sid), UpdateExpression='SET #status = :finalizing',
            ConditionExpression='#status = :ended', ExpressionAttributeNames={'#status': 'status'},
            ExpressionAttributeValues={':finalizing': STATUS_FINALIZING, ':ended': STATUS_ENDED}):
        return row
    try:
        job_id = start_finalize(row)
    except Exception:
        stores.projects.update_item(
            Key=session_key(sid), UpdateExpression='SET #status = :ended', ExpressionAttributeNames={'#status': 'status'},
            ExpressionAttributeValues={':ended': STATUS_ENDED})
        raise
    stores.projects.update_item(Key=session_key(sid), UpdateExpression='SET finalize_job_id = :job',
                                ExpressionAttributeValues={':job': job_id})
    return {**row, 'status': STATUS_FINALIZING, 'finalize_job_id': job_id}


def stop_runtime_session(config: VoiceConfig, session_id: str) -> None:
    """End the relay's microVM for this session (End, or the API's own stop). Never raises: it also ends by itself
    after 2 minutes without a frame."""
    try:
        get_agentcore_client(config.region).stop_runtime_session(
            runtimeSessionId=session_id, agentRuntimeArn=config.runtime_arn, qualifier='DEFAULT')
    except Exception:  # noqa: BLE001 - the runtime's idle timeout ends it anyway
        logger.warning('The voice relay session could not be stopped', extra={'session_id': session_id})


def end(stores: Stores, config: VoiceConfig, project_id: str, persona_id: str, session_id: str, caller: Caller,
        start_finalize: StartFinalize, *, stop: Callable[[VoiceConfig, str], None] = stop_runtime_session) -> dict:
    """The person's End: stop the relay if it still runs, mark the session ended, save its transcript."""
    subject = _require_person(caller)
    row = session_row(stores, project_id, persona_id, session_id)
    if row.get('starter_sub') != subject and not caller.is_admin:
        raise AuthorizationError('Only the person who started this voice session can end it')
    if row.get('status') in (STATUS_MINTED, STATUS_LIVE):
        stop(config, session_id)
        _mark_ended(stores, session_id, END_BY_PERSON, stores.now())
        release_stream(stores, session_id)
    return view(_finalize(stores, session_row(stores, project_id, persona_id, session_id), start_finalize))


def status(stores: Stores, project_id: str, persona_id: str, session_id: str, caller: Caller,
           start_finalize: StartFinalize) -> dict[str, Any]:
    """A session's state. A URL never used is ended once the relay would no longer take it (``connect_by`` and
    ``CONNECT_SKEW_SECONDS``); for its starter, an ended session's transcript is saved now (End may never have been
    called: a closed tab)."""
    row = session_row(stores, project_id, persona_id, session_id)
    now = stores.now()
    if (row.get('status') == STATUS_MINTED
            and int(now.timestamp()) > as_count(row.get('connect_by')) + CONNECT_SKEW_SECONDS):
        _mark_ended(stores, session_id, END_NEVER_CONNECTED, now)
        release_stream(stores, session_id)
        row = session_row(stores, project_id, persona_id, session_id)
    if row.get('status') == STATUS_ENDED and caller.subject == row.get('starter_sub'):
        row = _finalize(stores, row, start_finalize)
    return view(row)


def _save_left_sessions(stores: Stores, project_id: str, caller: Caller, start_finalize: StartFinalize) -> None:
    """Save the caller's sessions of this project whose End never came (a closed tab, an End that failed): the relay
    marked them ended, or their URL expired unused, and nothing asked for their transcript. Through the project's own
    pointers, the newest ``LEFT_SESSIONS`` of the caller's, each as its starter's read of it (``status``). For a person
    acting for themselves only; never raises (the offer is answered either way)."""
    if caller.delegated or caller.agent_id or not caller.subject:
        return
    try:
        pointers = query_all(stores.projects, {
            'KeyConditionExpression': 'pk = :pk AND begins_with(sk, :voice)', 'FilterExpression': 'starter_sub = :sub',
            'ProjectionExpression': 'session_id, persona_id, created_at',
            'ExpressionAttributeValues': {':pk': project_pk(project_id), ':voice': SESSION_PREFIX, ':sub': caller.subject},
        })
    except Exception:  # noqa: BLE001 - the next offer tries again
        logger.warning('The voice sessions left unsaved could not be listed', extra={'project_id': project_id})
        return
    newest = sorted(pointers, key=lambda pointer: str(pointer.get('created_at') or ''), reverse=True)[:LEFT_SESSIONS]
    for pointer in newest:
        session_id = str(pointer.get('session_id') or '')
        try:
            status(stores, project_id, str(pointer.get('persona_id') or ''), session_id, caller, start_finalize)
        except Exception:  # noqa: BLE001 - one session's failure leaves the others and the offer alone
            logger.warning('A voice session left unsaved could not be saved', extra={'session_id': session_id})


def usage(stores: Stores, config: VoiceConfig | None) -> dict[str, Any]:
    """The deployment's month (``GET /projects/voice/usage``, admins): minutes, sessions, cost, the live streams."""
    if config is None:
        return {'enabled': False}
    now = stores.now()
    month = stores.aggregates.get_item(Key=usage_key(now), ConsistentRead=True).get('Item') or {}
    live = (stores.aggregates.get_item(Key=dict(LIVE_KEY), ConsistentRead=True).get('Item') or {}).get('live')
    epoch = int(now.timestamp())
    used = _month_of(month)
    return {
        'enabled': True, 'month': f'{now:%Y-%m}', 'minutes_used': round(used.seconds / 60, 1),
        'monthly_minutes': config.monthly_minutes, 'minutes_left': _minutes_left(config, used),
        'sessions': as_count(month.get('sessions')), 'cost_cents': round(used.cost_microusd / MICRO_USD_PER_CENT, 2),
        'live_sessions': sum(1 for expires in (live if isinstance(live, dict) else {}).values()
                             if as_count(expires) > epoch),
        'max_concurrent': config.max_concurrent, 'session_minutes': config.session_minutes,
        'daily_sessions': DAILY_SESSIONS, 'model_id': config.model_id,
    }
