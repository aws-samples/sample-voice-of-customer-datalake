"""Voice sessions (7.69.00, shared/voice_sessions.py): the settings, the voices, the 60-second presigned URL and every
check a start makes before the relay is reached, on moto's DynamoDB and S3 so the conditions are really evaluated.

The refusals the S-15 spike lists for the API side are here: consent, a person only, a company persona, the
month's budget, the rate limit, the day's cap, a busy deployment, and a URL whose session id and scope are signed.
"""
from __future__ import annotations

import json
import re
from collections.abc import Mapping
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any
from unittest.mock import patch
from urllib.parse import parse_qs, urlsplit

import boto3
import pytest
from botocore.credentials import Credentials
from moto import mock_aws

from shared import voice_sessions as voice
from shared.category_access import UNRESTRICTED
from shared.exceptions import (
    AuthorizationError,
    ConflictError,
    NotFoundError,
    TooManyRequestsError,
    ValidationError,
)
from shared.project_access import Caller
from shared.test.moto_tables import create_pk_sk_table

CDK_ROOT = Path(__file__).resolve().parents[3]
NOW = datetime(2026, 11, 21, 10, 30, tzinfo=UTC)
ARN = 'arn:aws:bedrock-agentcore:us-west-2:111111111111:runtime/voc_persona_voice-AbCdEf1234'
CONFIG = voice.VoiceConfig(runtime_arn=ARN, model_id='amazon.nova-2-5-sonic', monthly_minutes=300,
                           session_minutes=15, max_concurrent=2, region='us-west-2')
PERSON = Caller(subject='sub-ada', username='ada')
OTHER = Caller(subject='sub-bo', username='bo')
ADMIN = Caller(subject='sub-admin', is_admin=True)
PACK = {'personas': [{'persona_id': 'persona_1', 'evidence': [
    {'feedback_id': 'fb1', 'text': 'Nine days for a parcel.', 'verbatim': True, 'source_platform': 'web',
     'category': 'delivery', 'sentiment_label': 'negative', 'date': '2026-11-01', 'origin': 'cited'}]}]}
FAKE_CREDENTIALS = Credentials('test-access-key-id', 'test-secret-access-key', 'session-token-example')


@pytest.fixture
def stores():
    with mock_aws():
        resource = boto3.resource('dynamodb', region_name='us-east-1')
        projects = create_pk_sk_table('voc-projects', resource)
        aggregates = create_pk_sk_table('voc-aggregates', resource)
        s3 = boto3.client('s3', region_name='us-east-1')
        s3.create_bucket(Bucket='raw')
        projects.put_item(Item={'pk': 'PROJECT#p1', 'sk': 'META', 'project_id': 'p1', 'name': 'Checkout'})
        projects.put_item(Item={'pk': 'PROJECT#p1', 'sk': 'PERSONA#persona_1', 'persona_id': 'persona_1',
                                'name': 'Maria', 'tagline': 'Busy parent', 'quotes': ['Where is it?'],
                                'confidence': 'high', 'research_notes': [{'text': 'private'}]})
        ids = iter(f'00000000-0000-4000-8000-00000000000{n}' for n in range(10))
        clock = {'now': NOW}
        yield voice.Stores(projects=projects, aggregates=aggregates, feedback=object(), s3=s3, bucket='raw',
                           now=lambda: clock['now'], credentials=lambda: FAKE_CREDENTIALS, new_id=lambda: next(ids)), clock


def _mint(store: voice.Stores, caller: Caller = PERSON, body: dict | None = None, persona: str = 'persona_1',
          project: str = 'p1') -> dict[str, Any]:
    with patch.object(voice.persona_grounding, 'evidence_pack', return_value=PACK):
        return voice.mint(store, CONFIG, project, persona, caller, body or {'consent': True}, UNRESTRICTED)


def _item(table: Any, pk: str, sk: str) -> dict[str, Any]:
    return table.get_item(Key={'pk': pk, 'sk': sk}).get('Item') or {}


class TestSettings:
    def test_no_env_is_no_voice(self, monkeypatch):
        monkeypatch.delenv(voice.VOICE_PERSONAS_ENV, raising=False)
        assert voice.VoiceConfig.from_env() is None
        with pytest.raises(NotFoundError) as refused:
            voice.require_config()
        assert refused.value.code == 'voice_off'

    def test_reads_the_cdk_json(self, monkeypatch):
        monkeypatch.setenv(voice.VOICE_PERSONAS_ENV, json.dumps({
            'runtime_arn': ARN, 'model_id': 'amazon.nova-2-sonic-v1:0', 'monthly_minutes': 60,
            'session_minutes': 7, 'max_concurrent': 3}))
        monkeypatch.setenv('AWS_REGION', 'us-west-2')
        assert voice.VoiceConfig.from_env() == voice.VoiceConfig(ARN, 'amazon.nova-2-sonic-v1:0', 60, 7, 3, 'us-west-2')

    @pytest.mark.parametrize('raw', ['not json', '{}', json.dumps({
        'runtime_arn': ARN, 'model_id': 'amazon.titan', 'monthly_minutes': 1, 'session_minutes': 1,
        'max_concurrent': 1})], ids=['text', 'empty', 'model'])
    def test_an_unreadable_value_turns_voice_off(self, monkeypatch, raw):
        monkeypatch.setenv(voice.VOICE_PERSONAS_ENV, raw)
        monkeypatch.setenv('AWS_REGION', 'us-west-2')
        assert voice.VoiceConfig.from_env() is None


class TestVoices:
    def test_a_chosen_voice_is_one_of_the_model_s(self):
        assert [voice.validated_voice_id(v) for v in (None, '', 'amy')] == [None, None, 'amy']
        with pytest.raises(ValidationError):
            voice.validated_voice_id('alexa')

    def test_the_default_is_the_polyglot_pair_by_the_id_alone(self):
        picks = {voice.default_voice(f'persona_{n}') for n in range(40)}
        assert picks == {'tiffany', 'matthew'}
        assert voice.default_voice('persona_1') == voice.default_voice('persona_1')
        assert voice.persona_voice({'persona_id': 'persona_1', 'voice_id': 'leo'}) == 'leo'
        assert voice.persona_voice({'persona_id': 'persona_1', 'voice_id': 'nope'}) == voice.default_voice('persona_1')

    def test_the_catalogue_matches_the_relay_and_the_cdk(self):
        protocol = (CDK_ROOT / 'lambda/stream/src/voice/protocol.ts').read_text(encoding='utf-8')
        cdk = (CDK_ROOT / 'lib/utils/voice-personas.ts').read_text(encoding='utf-8')
        assert dict(re.findall(r"\{ id: '(\w+)', gender: '(\w+)'", protocol)) == dict(voice.VOICES)
        listed = re.search(r"VOICE_MODEL_IDS = \[([^\]]+)\]", cdk)
        assert listed is not None
        assert listed.group(1).replace("'", '').split(', ') == list(voice.VOICE_MODEL_IDS)
        assert f"VOICE_LANGUAGES = {list(voice.VOICE_LANGUAGES)}".replace("'", '').replace(' ', '') in protocol.replace(
            "'", '').replace(' ', '').replace('asconst', '')


def test_a_project_delete_finds_its_sessions_rows_through_its_pointers():
    keys = [{'pk': 'PROJECT#p1', 'sk': 'META'}, {'pk': 'PROJECT#p1', 'sk': 'VOICE#s-1'},
            {'pk': 'PROJECT#p1', 'sk': 'PERSONA#persona_1'}]
    assert voice.session_keys_of_pointers(keys) == [{'pk': 'VOICE#s-1', 'sk': 'SESSION'}]


class TestConnectUrl:
    def _url(self, scope: str = 'p1', session: str = 's-1') -> str:
        with patch('botocore.auth.get_current_datetime', return_value=NOW.replace(tzinfo=None)):
            return voice.connect_url(CONFIG, session, scope, FAKE_CREDENTIALS)

    def test_names_the_runtime_s_websocket_for_60_seconds(self):
        url = urlsplit(self._url())
        query = parse_qs(url.query)
        assert (url.scheme, url.netloc) == ('wss', 'bedrock-agentcore.us-west-2.amazonaws.com')
        assert url.path == ('/runtimes/arn%3Aaws%3Abedrock-agentcore%3Aus-west-2%3A111111111111%3Aruntime%2F'
                            'voc_persona_voice-AbCdEf1234/ws')
        assert {k: query[k] for k in (voice.SESSION_PARAM, voice.SCOPE_PARAM, 'X-Amz-Expires', 'X-Amz-SignedHeaders')} \
            == {voice.SESSION_PARAM: ['s-1'], voice.SCOPE_PARAM: ['p1'], 'X-Amz-Expires': ['60'],
                'X-Amz-SignedHeaders': ['host']}

    def test_carries_the_session_token_never_the_secret(self):
        url = self._url()
        assert 'X-Amz-Security-Token=session-token-example' in url
        assert FAKE_CREDENTIALS.secret_key not in url
        assert parse_qs(urlsplit(url).query)['X-Amz-Credential'][0].endswith('/us-west-2/bedrock-agentcore/aws4_request')

    def _signature(self, **change: str) -> str:
        return parse_qs(urlsplit(self._url(**change)).query)['X-Amz-Signature'][0]

    def test_the_session_id_and_the_scope_are_signed(self):
        assert self._signature() == self._signature()
        assert self._signature(scope='p2') != self._signature()
        assert self._signature(session='s-2') != self._signature()


class TestStart:
    def test_writes_the_session_its_pointer_and_its_evidence_and_answers_its_url(self, stores):
        store, _ = stores
        started = _mint(store, body={'consent': True, 'language': 'de'})
        sid = started['session_id']
        row = _item(store.projects, f'VOICE#{sid}', 'SESSION')
        assert {k: row[k] for k in ('status', 'project_id', 'persona_id', 'starter_sub', 'language', 'connect_by')} \
            == {'status': 'minted', 'project_id': 'p1', 'persona_id': 'persona_1', 'starter_sub': 'sub-ada',
                'language': 'de', 'connect_by': int(NOW.timestamp()) + 60}
        assert _item(store.projects, 'PROJECT#p1', f'VOICE#{sid}')['starter_sub'] == 'sub-ada'
        assert started['connect_url'].startswith('wss://bedrock-agentcore.us-west-2.amazonaws.com/runtimes/')
        assert (started['expires_in'], started['session_minutes'], started['minutes_left']) == (60, 15.0, 300.0)

    def test_the_evidence_holds_the_profile_and_the_pack_only(self, stores):
        store, _ = stores
        sid = _mint(store)['session_id']
        evidence = json.loads(store.s3.get_object(Bucket='raw', Key=f'scratch/voice/{sid}/evidence.json')['Body'].read())
        assert evidence['persona'] == {'persona_id': 'persona_1', 'name': 'Maria', 'tagline': 'Busy parent',
                                       'quotes': ['Where is it?']}
        assert [item['feedback_id'] for item in evidence['evidence']] == ['fb1']
        assert (evidence['project_name'], evidence['usage_key'], evidence['session_id']) == (
            'Checkout', 'VOICEUSE#DEPLOYMENT#2026-11', sid)

    def test_counts_the_session_and_claims_a_stream(self, stores):
        store, _ = stores
        sid = _mint(store)['session_id']
        assert _item(store.aggregates, 'VOICEUSE#DEPLOYMENT#2026-11', 'USAGE')['sessions'] == 1
        assert _item(store.aggregates, 'VOICEDAY#sub-ada#2026-11-21', 'COUNT')['count'] == 1
        assert sid in _item(store.aggregates, 'VOICEUSE#LIVE', 'LIVE')['live']

    def test_refuses_without_consent_and_writes_nothing(self, stores):
        store, _ = stores
        with pytest.raises(ValidationError) as refused:
            _mint(store, body={'consent': 'yes'})
        assert refused.value.code == 'consent_required'
        assert store.aggregates.scan()['Items'] == []

    @pytest.mark.parametrize('caller', [Caller(subject='sub-ada', delegated=True),
                                        Caller(subject='sub-ada', agent_id='agent-1')], ids=['mcp', 'agent'])
    def test_refuses_anyone_but_a_person(self, stores, caller):
        store, _ = stores
        with pytest.raises(AuthorizationError) as refused:
            _mint(store, caller=caller)
        assert refused.value.code == 'person_only'

    def test_refuses_a_company_persona_and_a_missing_one(self, stores):
        store, _ = stores
        with pytest.raises(ValidationError):
            _mint(store, project='company_personas')
        with pytest.raises(NotFoundError):
            _mint(store, persona='persona_9')

    def test_refuses_an_unknown_language(self, stores):
        store, _ = stores
        with pytest.raises(ValidationError):
            _mint(store, body={'consent': True, 'language': 'xx'})


class TestLimits:
    def test_the_month_s_budget_caps_the_session_and_then_refuses(self, stores):
        store, _ = stores
        store.aggregates.put_item(Item={'pk': 'VOICEUSE#DEPLOYMENT#2026-11', 'sk': 'USAGE', 'seconds': 300 * 60 - 120})
        assert _mint(store)['session_minutes'] == 2.0
        store.aggregates.put_item(Item={'pk': 'VOICEUSE#DEPLOYMENT#2026-11', 'sk': 'USAGE', 'seconds': 300 * 60 - 30})
        with pytest.raises(ConflictError) as refused:
            _mint(store)
        assert refused.value.code == 'budget_exhausted'

    def test_three_starts_a_minute(self, stores):
        store, clock = stores
        store.aggregates.put_item(Item={'pk': 'VOICERATE#sub-ada#202611211030', 'sk': 'COUNT', 'count': 3})
        with pytest.raises(TooManyRequestsError) as refused:
            _mint(store)
        assert refused.value.code == 'rate_limited'
        clock['now'] = NOW + timedelta(minutes=1)
        assert _mint(store)['session_id']

    def test_five_sessions_a_day(self, stores):
        store, _ = stores
        store.aggregates.put_item(Item={'pk': 'VOICEDAY#sub-ada#2026-11-21', 'sk': 'COUNT', 'count': 5})
        with pytest.raises(TooManyRequestsError) as refused:
            _mint(store)
        assert refused.value.code == 'daily_limit'

    def test_a_busy_deployment_refuses_and_gives_the_day_s_count_back(self, stores):
        store, _ = stores
        later = int(NOW.timestamp()) + 600
        store.aggregates.put_item(Item={'pk': 'VOICEUSE#LIVE', 'sk': 'LIVE', 'version': 4,
                                        'live': {'a': later, 'b': later}})
        with pytest.raises(TooManyRequestsError) as refused:
            _mint(store)
        assert refused.value.code == 'busy'
        assert _item(store.aggregates, 'VOICEDAY#sub-ada#2026-11-21', 'COUNT')['count'] == 0

    def test_expired_streams_are_freed(self, stores):
        store, _ = stores
        store.aggregates.put_item(Item={'pk': 'VOICEUSE#LIVE', 'sk': 'LIVE', 'version': 1,
                                        'live': {'old': int(NOW.timestamp()) - 1, 'b': int(NOW.timestamp()) + 600}})
        sid = _mint(store)['session_id']
        assert set(_item(store.aggregates, 'VOICEUSE#LIVE', 'LIVE')['live']) == {'b', sid}

    def test_a_failed_start_gives_back_its_stream_and_its_count(self, stores):
        store, _ = stores
        with patch.object(store.s3, 'put_object', side_effect=RuntimeError('s3 down')), pytest.raises(RuntimeError):
            _mint(store)
        assert _item(store.aggregates, 'VOICEUSE#LIVE', 'LIVE')['live'] == {}
        assert _item(store.aggregates, 'VOICEDAY#sub-ada#2026-11-21', 'COUNT')['count'] == 0


class TestOffer:
    def test_without_voice_is_disabled(self, stores):
        store, _ = stores
        assert voice.offer(store, None, 'p1', 'persona_1', PERSON) == {'enabled': False}

    def test_answers_the_consent_dialog_s_figures(self, stores):
        store, _ = stores
        offer = voice.offer(store, CONFIG, 'p1', 'persona_1', PERSON)
        assert {k: offer[k] for k in ('enabled', 'session_minutes', 'minutes_left', 'sessions_left_today',
                                      'estimated_cents_per_minute')} == {
            'enabled': True, 'session_minutes': 15, 'minutes_left': 300.0, 'sessions_left_today': 5,
            'estimated_cents_per_minute': 2}
        assert offer['languages']['unsupported'] == ['ja', 'ko', 'pl', 'zh']


class TestEndAndStatus:
    def _live(self, store: voice.Stores) -> str:
        sid = _mint(store)['session_id']
        store.projects.update_item(Key=voice.session_key(sid), UpdateExpression='SET #s = :live',
                                   ExpressionAttributeNames={'#s': 'status'}, ExpressionAttributeValues={':live': 'live'})
        return sid

    def test_end_stops_the_relay_and_saves_the_transcript_once(self, stores):
        store, _ = stores
        sid = self._live(store)
        jobs: list[str] = []
        stopped: list[str] = []

        def start(row: Mapping[str, Any]) -> str:
            jobs.append(row['session_id'])
            return 'job-1'

        ended = voice.end(store, CONFIG, 'p1', 'persona_1', sid, PERSON, start, stop=lambda _c, s: stopped.append(s))
        assert (ended['status'], ended['job_id'], ended['end_reason']) == ('finalizing', 'job-1', 'ended_by_person')
        voice.end(store, CONFIG, 'p1', 'persona_1', sid, PERSON, start, stop=lambda _c, s: stopped.append(s))
        assert (jobs, stopped) == ([sid], [sid])
        assert sid not in _item(store.aggregates, 'VOICEUSE#LIVE', 'LIVE')['live']

    def test_only_its_starter_or_an_admin_ends_it(self, stores):
        store, _ = stores
        sid = self._live(store)
        with pytest.raises(AuthorizationError):
            voice.end(store, CONFIG, 'p1', 'persona_1', sid, OTHER, lambda _row: 'job', stop=lambda *_: None)
        assert voice.end(store, CONFIG, 'p1', 'persona_1', sid, ADMIN, lambda _row: 'job-2',
                         stop=lambda *_: None)['job_id'] == 'job-2'

    def test_a_session_is_found_only_under_its_own_project_and_persona(self, stores):
        store, _ = stores
        sid = self._live(store)
        for project, persona in (('p2', 'persona_1'), ('p1', 'persona_2')):
            with pytest.raises(NotFoundError):
                voice.status(store, project, persona, sid, PERSON, lambda _row: 'job')
        assert voice.status(store, 'p1', 'persona_1', sid, PERSON, lambda _row: 'job')['status'] == 'live'

    def test_an_unused_url_ends_and_its_starter_s_read_saves_it(self, stores):
        store, clock = stores
        sid = _mint(store)['session_id']
        clock['now'] = NOW + timedelta(seconds=90)
        assert voice.status(store, 'p1', 'persona_1', sid, OTHER, lambda _row: 'job')['status'] == 'ended'
        status = voice.status(store, 'p1', 'persona_1', sid, PERSON, lambda _row: 'job-3')
        assert (status['status'], status['end_reason'], status['job_id']) == ('finalizing', 'disconnected', 'job-3')

    def test_a_failed_job_start_leaves_it_ended_to_retry(self, stores):
        store, _ = stores
        sid = self._live(store)
        def failing(_row: Mapping[str, Any]) -> str:
            raise RuntimeError('lambda invoke refused')

        with pytest.raises(RuntimeError):
            voice.end(store, CONFIG, 'p1', 'persona_1', sid, PERSON, failing, stop=lambda *_: None)
        assert _item(store.projects, f'VOICE#{sid}', 'SESSION')['status'] == 'ended'


class TestUsage:
    def test_the_month_for_admins(self, stores):
        store, _ = stores
        store.aggregates.put_item(Item={'pk': 'VOICEUSE#DEPLOYMENT#2026-11', 'sk': 'USAGE', 'seconds': 1530,
                                        'sessions': 4, 'cost_microusd': 512_345})
        usage = voice.usage(store, CONFIG)
        assert {k: usage[k] for k in ('month', 'minutes_used', 'minutes_left', 'sessions', 'cost_cents')} == {
            'month': '2026-11', 'minutes_used': 25.5, 'minutes_left': 274.5, 'sessions': 4, 'cost_cents': 51.23}
        assert voice.usage(store, None) == {'enabled': False}

    def test_stop_never_raises(self):
        with patch.object(voice.boto3, 'client', side_effect=RuntimeError('no endpoint')):
            assert voice.stop_runtime_session(CONFIG, 's-1') is None
