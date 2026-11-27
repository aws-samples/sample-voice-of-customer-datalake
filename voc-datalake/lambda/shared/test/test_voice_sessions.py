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
from shared import voice_subjects as subjects
from shared.category_access import UNRESTRICTED
from shared.exceptions import (
    AuthorizationError,
    ConflictError,
    NotFoundError,
    TooManyRequestsError,
    ValidationError,
)
from shared.product_fields import FIELD_LABELS
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
PERSONA = subjects.persona('persona_1')
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
        return voice.mint(store, CONFIG, project, subjects.persona(persona), caller, body or {'consent': True},
                          UNRESTRICTED, workspace=None)


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
        # F5 (7.71.04): ``connect_by`` is the relay's own deadline, the URL's minute and 10 s for the clocks; the live
        # set's entry outlives the latest session it allows by the slack.
        assert {k: row[k] for k in ('status', 'project_id', 'persona_id', 'starter_sub', 'language', 'connect_by')} \
            == {'status': 'minted', 'project_id': 'p1', 'persona_id': 'persona_1', 'starter_sub': 'sub-ada',
                'language': 'de', 'connect_by': int(NOW.timestamp()) + 70}
        assert _item(store.aggregates, 'VOICEUSE#LIVE', 'LIVE')['live'] == {sid: int(NOW.timestamp()) + 70 + 900 + 120}
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


def _no_job(_row: Mapping[str, Any]) -> str:
    return 'job'


def _recorded_jobs() -> tuple[list[str], voice.StartFinalize]:
    """A job starter that records the sessions it was started for."""
    jobs: list[str] = []

    def start(row: Mapping[str, Any]) -> str:
        jobs.append(str(row['session_id']))
        return 'job-left'

    return jobs, start


class TestOffer:
    def test_without_voice_is_disabled(self, stores):
        store, _ = stores
        assert voice.offer(store, None, 'p1', PERSONA, PERSON, start_finalize=_no_job, workspace=None) == {'enabled': False}

    def test_answers_the_consent_dialog_s_figures(self, stores):
        store, _ = stores
        offer = voice.offer(store, CONFIG, 'p1', PERSONA, PERSON, start_finalize=_no_job, workspace=None)
        assert {k: offer[k] for k in ('enabled', 'session_minutes', 'minutes_left', 'sessions_left_today',
                                      'estimated_cents_per_minute')} == {
            'enabled': True, 'session_minutes': 15, 'minutes_left': 300.0, 'sessions_left_today': 5,
            'estimated_cents_per_minute': 2}
        assert offer['languages']['unsupported'] == ['ja', 'ko', 'pl', 'zh']


class TestCostCaps:
    def test_the_session_and_the_month_caps_reach_the_relay(self, stores):
        store, _ = stores
        sid = _mint(store)['session_id']
        evidence = json.loads(store.s3.get_object(Bucket='raw', Key=f'scratch/voice/{sid}/evidence.json')['Body'].read())
        # 15 minutes and 300 minutes at 5 cents a minute, in micro-dollars.
        assert (evidence['session_cost_cap_microusd'], evidence['monthly_cost_cap_microusd']) == (750_000, 15_000_000)

    def test_the_month_s_cost_cap_refuses_a_start_and_leaves_no_minutes(self, stores):
        store, _ = stores
        store.aggregates.put_item(Item={'pk': 'VOICEUSE#DEPLOYMENT#2026-11', 'sk': 'USAGE', 'seconds': 600,
                                        'cost_microusd': 15_000_000})
        with pytest.raises(ConflictError) as refused:
            _mint(store)
        assert refused.value.code == 'budget_exhausted'
        assert voice.offer(store, CONFIG, 'p1', PERSONA, PERSON, start_finalize=_no_job, workspace=None)['minutes_left'] == 0
        assert voice.usage(store, CONFIG)['minutes_left'] == 0


class TestSessionsLeftUnsaved:
    """Q3: a session whose End never came (a closed tab, an End that failed) is saved by its starter's next offer."""

    @staticmethod
    def _relay_ended(store: voice.Stores, sid: str) -> None:
        """What the relay's own end writes (lambda/stream/src/voice/store.ts markEnded): no End route is called."""
        store.projects.update_item(Key=voice.session_key(sid), UpdateExpression='SET #s = :ended, end_reason = :reason',
                                   ExpressionAttributeNames={'#s': 'status'},
                                   ExpressionAttributeValues={':ended': 'ended', ':reason': 'disconnected'})

    def test_the_offer_saves_a_session_the_relay_ended_with_no_end_call(self, stores):
        store, _ = stores
        sid = _mint(store)['session_id']
        self._relay_ended(store, sid)
        jobs, start = _recorded_jobs()
        voice.offer(store, CONFIG, 'p1', PERSONA, PERSON, start_finalize=start, workspace=None)
        row = _item(store.projects, f'VOICE#{sid}', 'SESSION')
        assert (jobs, row['status'], row['finalize_job_id']) == ([sid], 'finalizing', 'job-left')
        voice.offer(store, CONFIG, 'p1', PERSONA, PERSON, start_finalize=start, workspace=None)
        assert jobs == [sid]

    def test_only_the_caller_s_own_sessions_and_only_a_person_s_read(self, stores):
        store, _ = stores
        sid = _mint(store)['session_id']
        self._relay_ended(store, sid)
        jobs, start = _recorded_jobs()
        for caller in (OTHER, Caller(subject='sub-ada', delegated=True), Caller(subject='sub-ada', agent_id='agent-1')):
            voice.offer(store, CONFIG, 'p1', PERSONA, caller, start_finalize=start, workspace=None)
        assert (jobs, _item(store.projects, f'VOICE#{sid}', 'SESSION')['status']) == ([], 'ended')

    def test_an_unused_url_is_ended_and_saved_and_a_failing_job_leaves_the_offer_answered(self, stores):
        store, clock = stores
        unused = _mint(store)['session_id']
        clock['now'] = NOW + timedelta(seconds=90)

        def failing(_row: Mapping[str, Any]) -> str:
            raise RuntimeError('lambda invoke refused')

        assert voice.offer(store, CONFIG, 'p1', PERSONA, PERSON, start_finalize=failing, workspace=None)['enabled'] is True
        row = _item(store.projects, f'VOICE#{unused}', 'SESSION')
        assert (row['status'], row['end_reason']) == ('ended', 'disconnected')

    def test_a_listing_that_fails_leaves_the_offer_answered(self, stores):
        store, _ = stores
        with patch.object(voice, 'query_all', side_effect=RuntimeError('throttled')):
            assert voice.offer(store, CONFIG, 'p1', PERSONA, PERSON, start_finalize=_no_job, workspace=None)['enabled'] is True


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

        ended = voice.end(store, CONFIG, 'p1', PERSONA, sid, PERSON, start, stop=lambda _c, s: stopped.append(s))
        assert (ended['status'], ended['job_id'], ended['end_reason']) == ('finalizing', 'job-1', 'ended_by_person')
        voice.end(store, CONFIG, 'p1', PERSONA, sid, PERSON, start, stop=lambda _c, s: stopped.append(s))
        assert (jobs, stopped) == ([sid], [sid])
        assert sid not in _item(store.aggregates, 'VOICEUSE#LIVE', 'LIVE')['live']

    def test_only_its_starter_or_an_admin_ends_it(self, stores):
        store, _ = stores
        sid = self._live(store)
        with pytest.raises(AuthorizationError):
            voice.end(store, CONFIG, 'p1', PERSONA, sid, OTHER, lambda _row: 'job', stop=lambda *_: None)
        assert voice.end(store, CONFIG, 'p1', PERSONA, sid, ADMIN, lambda _row: 'job-2',
                         stop=lambda *_: None)['job_id'] == 'job-2'

    def test_a_session_is_found_only_under_its_own_project_and_persona(self, stores):
        store, _ = stores
        sid = self._live(store)
        for project, persona in (('p2', 'persona_1'), ('p1', 'persona_2')):
            with pytest.raises(NotFoundError):
                voice.status(store, project, subjects.persona(persona), sid, PERSON, lambda _row: 'job')
        assert voice.status(store, 'p1', PERSONA, sid, PERSON, lambda _row: 'job')['status'] == 'live'

    def test_an_unused_url_ends_and_its_starter_s_read_saves_it(self, stores):
        store, clock = stores
        sid = _mint(store)['session_id']
        clock['now'] = NOW + timedelta(seconds=90)
        assert voice.status(store, 'p1', PERSONA, sid, OTHER, lambda _row: 'job')['status'] == 'ended'
        status = voice.status(store, 'p1', PERSONA, sid, PERSON, lambda _row: 'job-3')
        assert (status['status'], status['end_reason'], status['job_id']) == ('finalizing', 'disconnected', 'job-3')

    def test_an_unused_url_stays_minted_while_the_relay_would_still_take_it(self, stores):
        """F3 (7.71.03), F5 (7.71.04): the relay takes a first connection until the row's ``connect_by`` (the URL's
        minute and 10 s for the clocks, the one deadline), so a row still minted is ended only once it passed: a read
        in those 10 s never ends a session that is about to start."""
        store, clock = stores
        sid = _mint(store)['session_id']
        last = int(_item(store.projects, f'VOICE#{sid}', 'SESSION')['connect_by'])
        clock['now'] = datetime.fromtimestamp(last, tz=UTC)
        assert voice.status(store, 'p1', PERSONA, sid, OTHER, lambda _row: 'job')['status'] == 'minted'
        clock['now'] += timedelta(seconds=1)
        assert voice.status(store, 'p1', PERSONA, sid, OTHER, lambda _row: 'job')['end_reason'] == 'disconnected'

    def test_a_failed_job_start_leaves_it_ended_to_retry(self, stores):
        store, _ = stores
        sid = self._live(store)
        def failing(_row: Mapping[str, Any]) -> str:
            raise RuntimeError('lambda invoke refused')

        with pytest.raises(RuntimeError):
            voice.end(store, CONFIG, 'p1', PERSONA, sid, PERSON, failing, stop=lambda *_: None)
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


def _mint_product(store: voice.Stores, body: dict | None = None, caller: Caller = PERSON,
                  project: str = 'p1') -> dict[str, Any]:
    return voice.mint(store, CONFIG, project, subjects.PRODUCT, caller, body or {'consent': True}, UNRESTRICTED, workspace=None)


def _evidence_of(store: voice.Stores, sid: str) -> dict[str, Any]:
    return json.loads(store.s3.get_object(Bucket='raw', Key=f'scratch/voice/{sid}/evidence.json')['Body'].read())


def _context(store: voice.Stores, **fields: object) -> None:
    store.projects.put_item(Item={'pk': 'PROJECT#p1', 'sk': 'PRODUCT_CONTEXT', **fields})


class TestProductInterview:
    """7.104.00 (shared/voice_subjects.py): the product team talks its own product through with an AI interviewer, on
    the persona sessions' checks, counters and budget."""

    def test_writes_a_product_row_and_pointer_with_no_persona(self, stores):
        store, _ = stores
        sid = _mint_product(store, {'consent': True, 'language': 'fr'})['session_id']
        row = _item(store.projects, f'VOICE#{sid}', 'SESSION')
        pointer = _item(store.projects, 'PROJECT#p1', f'VOICE#{sid}')
        assert (row['kind'], row['language'], row['status'], 'persona_id' in row) == (
            'product_interview', 'fr', 'minted', False)
        assert (pointer['kind'], 'persona_id' in pointer, pointer['starter_sub']) == ('product_interview', False, 'sub-ada')

    def test_the_evidence_holds_the_questions_and_what_the_form_says(self, stores):
        store, _ = stores
        _context(store, product_name=' Parcel Tracker ', one_liner='', key_features='x' * 600, current_state='beta')
        sid = _mint_product(store)['session_id']
        evidence = _evidence_of(store, sid)
        assert (evidence['kind'], evidence['project_name'], evidence['session_id']) == ('product_interview', 'Checkout', sid)
        assert 'persona' not in evidence
        assert 'evidence' not in evidence
        assert evidence['known'] == {'product_name': 'Parcel Tracker', 'current_state': 'beta', 'key_features': 'x' * 500}
        asked = [one['field'] for one in evidence['questions']]
        assert asked == ['one_liner', 'product_summary', 'target_users', 'problem_solved', 'differentiators',
                         'known_limitations', 'non_goals', 'success_metrics', 'free_form_notes']
        assert {one['question'] for one in evidence['questions']} == {''}
        assert (evidence['session_cost_cap_microusd'], evidence['usage_key']) == (750_000, 'VOICEUSE#DEPLOYMENT#2026-11')

    def test_a_list_stored_under_the_old_schema_is_known_as_its_lines(self, stores):
        # Review F1 (7.104.00 round 1): the interviewer read the context with its own reader, which took a list-valued
        # field for '' (asked again, and left out of what the form says). Now the one reader, context_state.
        store, _ = stores
        _context(store, key_features=['Search', 'Sync'])
        evidence = _evidence_of(store, _mint_product(store)['session_id'])
        assert evidence['known'] == {'key_features': 'Search\nSync'}
        assert 'key_features' not in [one['field'] for one in evidence['questions']]

    def test_asks_the_person_s_own_questions_as_given(self, stores):
        store, _ = stores
        questions = [{'field': 'target_users', 'question': ' Who buys it? '}, {'field': 'non_goals', 'question': ''}]
        sid = _mint_product(store, {'consent': True, 'questions': questions})['session_id']
        assert _evidence_of(store, sid)['questions'] == [
            {'field': 'target_users', 'question': 'Who buys it?'}, {'field': 'non_goals', 'question': ''}]

    def test_asks_every_field_when_none_is_empty_or_the_context_is_missing(self, stores):
        store, _ = stores
        first = _evidence_of(store, _mint_product(store)['session_id'])
        assert (len(first['questions']), first['known']) == (12, {})
        _context(store, **{field: 'set' for field, _label in FIELD_LABELS})
        second = _evidence_of(store, _mint_product(store)['session_id'])
        assert [one['field'] for one in second['questions']] == [field for field, _label in FIELD_LABELS]
        assert len(second['known']) == 12

    def test_asks_only_the_first_question_of_a_field_named_twice(self, stores):
        # Review Q1 / S2 (7.104.00 round 2): a proposal stored before its extract kept one question per field may name
        # a field twice; its questions still start the interview, the field asked once, as first asked.
        store, _ = stores
        questions = [{'field': 'non_goals', 'question': 'What is out of scope?'},
                     {'field': 'target_users', 'question': 'Who buys it?'},
                     {'field': 'non_goals', 'question': 'What will it never do?'}]
        sid = _mint_product(store, {'consent': True, 'questions': questions})['session_id']
        assert _evidence_of(store, sid)['questions'] == [
            {'field': 'non_goals', 'question': 'What is out of scope?'},
            {'field': 'target_users', 'question': 'Who buys it?'}]

    @pytest.mark.parametrize('questions', [
        'who?', [{'field': 'colour', 'question': 'Which?'}], [{'field': 'non_goals', 'question': 'x' * 201}],
        [{'field': 'non_goals', 'question': 7}], [{'field': 'non_goals'}] * 13, ['non_goals'],
        [{'field': ['non_goals'], 'question': 'Which?'}], [{'field': {'non_goals': 1}, 'question': 'Which?'}],
    ], ids=['text', 'unknown-field', 'too-long', 'not-text', 'too-many', 'not-an-object', 'field-a-list',
            'field-a-map'])
    def test_refuses_malformed_questions_before_counting_anything(self, stores, questions):
        store, _ = stores
        with pytest.raises(ValidationError) as refused:
            _mint_product(store, {'consent': True, 'questions': questions})
        assert refused.value.code == 'invalid_questions'
        assert store.aggregates.scan()['Items'] == []

    def test_speaks_with_the_project_s_default_voice(self, stores):
        store, _ = stores
        started = _mint_product(store)
        assert (started['voice_id'], started['voice_gender']) == (
            voice.default_voice('p1'), voice.VOICES[voice.default_voice('p1')])
        offer = voice.offer(store, CONFIG, 'p1', subjects.PRODUCT, PERSON, start_finalize=_no_job, workspace=None)
        assert (offer['enabled'], offer['voice_id'], offer['sessions_left_today']) == (True, started['voice_id'], 4)

    def test_consent_says_the_interviewer_is_an_ai(self, stores):
        store, _ = stores
        with pytest.raises(ValidationError) as refused:
            _mint_product(store, {'consent': False})
        assert (refused.value.code, 'the interviewer is an AI' in str(refused.value)) == ('consent_required', True)
        assert store.aggregates.scan()['Items'] == []

    def test_a_person_only_and_never_in_the_company_library(self, stores):
        store, _ = stores
        with pytest.raises(AuthorizationError) as refused:
            _mint_product(store, caller=Caller(subject='sub-ada', delegated=True))
        assert refused.value.code == 'person_only'
        with pytest.raises(ValidationError):
            _mint_product(store, project='company_personas')

    def test_shares_the_persona_sessions_day_minute_and_streams(self, stores):
        store, clock = stores
        store.aggregates.put_item(Item={'pk': 'VOICEDAY#sub-ada#2026-11-21', 'sk': 'COUNT', 'count': 4})
        _mint(store)
        with pytest.raises(TooManyRequestsError) as refused:
            _mint_product(store)
        assert refused.value.code == 'daily_limit'
        store.aggregates.put_item(Item={'pk': 'VOICEDAY#sub-ada#2026-11-21', 'sk': 'COUNT', 'count': 0})
        _mint_product(store)
        with pytest.raises(TooManyRequestsError) as rate:
            _mint_product(store)
        assert rate.value.code == 'rate_limited'
        clock['now'] = NOW + timedelta(minutes=1)
        with pytest.raises(TooManyRequestsError) as busy:
            _mint_product(store)
        assert busy.value.code == 'busy'

    def test_a_project_with_its_20_sources_is_refused_before_counting_anything_and_its_offer_says_so(self, stores):
        # Its transcript becomes a source: an interview the project could not save is never started.
        store, _ = stores
        assert voice.offer(store, CONFIG, 'p1', subjects.PRODUCT, PERSON, start_finalize=_no_job, workspace=None)['sources_full'] is False
        for n in range(20):
            store.projects.put_item(Item={'pk': 'PROJECT#p1', 'sk': f'PRODUCT_DOC#pd_{n:02d}', 'status': 'ready'})
        with pytest.raises(ValidationError) as refused:
            _mint_product(store)
        assert (refused.value.code, 'Delete a source first' in str(refused.value)) == ('too_many_sources', True)
        assert store.aggregates.scan()['Items'] == []
        assert voice.offer(store, CONFIG, 'p1', subjects.PRODUCT, PERSON, start_finalize=_no_job, workspace=None)['sources_full'] is True

    def test_a_persona_session_does_not_count_the_sources(self, stores):
        store, _ = stores
        for n in range(20):
            store.projects.put_item(Item={'pk': 'PROJECT#p1', 'sk': f'PRODUCT_DOC#pd_{n:02d}', 'status': 'ready'})
        assert _mint(store)['session_id']
        assert voice.offer(store, CONFIG, 'p1', PERSONA, PERSON, start_finalize=_no_job, workspace=None)['sources_full'] is False

    def test_the_month_s_budget_refuses_it_as_a_persona_s(self, stores):
        store, _ = stores
        store.aggregates.put_item(Item={'pk': 'VOICEUSE#DEPLOYMENT#2026-11', 'sk': 'USAGE', 'seconds': 300 * 60 - 30})
        with pytest.raises(ConflictError) as refused:
            _mint_product(store)
        assert refused.value.code == 'budget_exhausted'


class TestProductSessions:
    def test_a_session_is_answered_only_through_its_own_subject(self, stores):
        store, _ = stores
        product = _mint_product(store)['session_id']
        persona = _mint(store)['session_id']
        with pytest.raises(NotFoundError):
            voice.status(store, 'p1', PERSONA, product, PERSON, _no_job)
        with pytest.raises(NotFoundError):
            voice.status(store, 'p1', subjects.PRODUCT, persona, PERSON, _no_job)
        view = voice.status(store, 'p1', subjects.PRODUCT, product, PERSON, _no_job)
        assert {k: view[k] for k in ('kind', 'persona_id', 'status', 'transcript_document_id', 'source_doc_id')} == {
            'kind': 'product_interview', 'persona_id': None, 'status': 'minted', 'transcript_document_id': None,
            'source_doc_id': None}
        assert voice.status(store, 'p1', PERSONA, persona, PERSON, _no_job)['kind'] == 'persona_interview'

    def test_a_row_written_before_7_72_is_a_persona_s(self, stores):
        store, _ = stores
        sid = _mint(store)['session_id']
        for key in (voice.session_key(sid), voice.pointer_key('p1', sid)):
            store.projects.update_item(Key=key, UpdateExpression='REMOVE #kind', ExpressionAttributeNames={'#kind': 'kind'})
        assert voice.status(store, 'p1', PERSONA, sid, PERSON, _no_job)['kind'] == 'persona_interview'
        with pytest.raises(NotFoundError):
            voice.status(store, 'p1', subjects.PRODUCT, sid, PERSON, _no_job)

    def test_end_and_the_offer_save_a_product_session_like_a_persona_s(self, stores):
        store, _ = stores
        ended = _mint_product(store)['session_id']
        left = _mint_product(store)['session_id']
        rows: list[dict[str, Any]] = []

        def start(row: Mapping[str, Any]) -> str:
            rows.append(dict(row))
            return f'job-{len(rows)}'

        store.projects.update_item(Key=voice.session_key(ended), UpdateExpression='SET #s = :live',
                                   ExpressionAttributeNames={'#s': 'status'}, ExpressionAttributeValues={':live': 'live'})
        view = voice.end(store, CONFIG, 'p1', subjects.PRODUCT, ended, PERSON, start, stop=lambda *_: None)
        assert (view['status'], view['kind'], view['job_id']) == ('finalizing', 'product_interview', 'job-1')
        TestSessionsLeftUnsaved._relay_ended(store, left)
        voice.offer(store, CONFIG, 'p1', PERSONA, PERSON, start_finalize=start, workspace=None)
        assert [(row['session_id'], row['kind']) for row in rows] == [
            (ended, 'product_interview'), (left, 'product_interview')]
