"""One user's brief end to end (build.py), the dispatcher (dispatch.py) and the queue handler."""
import copy
import json
from datetime import timedelta
from unittest.mock import MagicMock

import pytest

from briefing import build, handler, mailer, writer
from briefing.dispatch import dispatch, due_day
from briefing.identity import DirectoryUnavailable
from briefing.test.conftest import NOW
from briefing.todos import Reader
from shared import briefing_store as store
from shared.briefing_requests import build_message
from shared.test import strict_iam

ANA = Reader(sub='sub-ana', username='ana', name='Ana', is_admin=False)
REFRESH = build.BuildRequest(sub='sub-ana', username='ana', reason='refresh')
SCHEDULED = build.BuildRequest(sub='sub-ana', username='ana', reason='scheduled', site_url='https://voc.example.com')


@pytest.fixture
def model(monkeypatch):
    fake = MagicMock(return_value=json.dumps({'headline': 'Morning, Ana', 'summary': 'Quiet', 'cards': []}))
    monkeypatch.setattr(writer, 'converse', fake)
    return fake


@pytest.fixture
def reader(monkeypatch):
    holder = {'reader': ANA}
    monkeypatch.setattr(build, 'lookup_reader', lambda *_: holder['reader'])
    return holder


@pytest.fixture
def no_memory(monkeypatch):
    """Grounding without embeddings: company context only (no Bedrock in tests)."""
    monkeypatch.setattr('shared.grounding._recall', lambda *_, **__: [])


def _activity(world) -> None:
    for days_ago in range(14):
        day = (NOW - timedelta(days=days_ago)).strftime('%Y-%m-%d')
        world.counter('METRIC#daily_category#shipping', day, 3)
        world.counter('METRIC#daily_category#billing', day, 2)


def _email_on(world) -> None:
    world.tables.aggregates.put_item(Item={'pk': 'USERCTX#sub-ana', 'sk': 'briefing', 'enabled': True,
                                           'email': True, 'subscription_arn': 'arn:aws:sns:x:1:t:s'})


def _brief(world, sub='sub-ana') -> dict:
    row = store.latest_brief(world.tables.aggregates, sub)
    assert row is not None
    return row


@pytest.mark.usefixtures('reader', 'no_memory', 'model')
class TestBuild:
    def test_a_brief_is_stored_ready_with_two_model_calls(self, world, model):
        _activity(world)
        result = build.build_for_user(world.tables, REFRESH, NOW)
        row = _brief(world)
        assert (result['outcome'], result['model_calls'], model.call_count) == ('built', 2, 2)
        assert (row['status'], row['headline'], row['sk']) == ('ready', 'Morning, Ana', '2026-10-17')
        assert row['card_state'] == {}

    def test_the_org_layer_is_reused_by_the_next_build(self, world, model):
        _activity(world)
        build.build_for_user(world.tables, REFRESH, NOW)
        second = build.build_for_user(world.tables, REFRESH, NOW + timedelta(minutes=20))
        assert (second['model_calls'], model.call_count) == (1, 3)

    def test_card_states_survive_a_rebuild(self, world):
        _activity(world)
        build.build_for_user(world.tables, REFRESH, NOW)
        card = _brief(world)['cards'][0]['id']
        store.set_card_states(world.tables.aggregates, 'sub-ana', '2026-10-17', {card: 'dismissed'})
        build.build_for_user(world.tables, REFRESH, NOW + timedelta(minutes=20))
        assert _brief(world)['card_state'] == {card: 'dismissed'}

    def test_a_restricted_reader_never_sees_a_hidden_category(self, world, model):
        _activity(world)
        world.tables.aggregates.put_item(Item={'pk': 'CATEGORY_ACCESS', 'sk': 'USER#sub-ana', 'categories': ['shipping']})
        build.build_for_user(world.tables, REFRESH, NOW)
        assert 'billing' not in json.dumps(_brief(world)['cards'], default=str)
        assert 'billing' not in model.call_args_list[0].kwargs['prompt']

    def test_a_gone_reader_gets_no_brief_and_no_call(self, world, model, reader):
        reader['reader'] = None
        assert build.build_for_user(world.tables, REFRESH, NOW)['outcome'] == 'reader_gone'
        model.assert_not_called()

    def test_a_built_brief_is_up_to_date_only_for_the_settings_it_was_written_for(self, world):
        # Regression (5.05.01): the build must record the settings fingerprint, or a Refresh after a
        # language / instructions change answered "up to date" with the old words.
        _activity(world)
        build.build_for_user(world.tables, REFRESH, NOW)
        row = _brief(world)
        marker = store.feedback_marker(world.tables.aggregates, NOW)
        same = store.settings_marker({'language': 'en', 'instructions': ''})
        changed = store.settings_marker({'language': 'de', 'instructions': ''})
        assert store.is_up_to_date(row, marker, NOW + timedelta(minutes=1), same)
        assert not store.is_up_to_date(row, marker, NOW + timedelta(minutes=1), changed)

    def test_a_scheduled_build_is_mailed_only_when_email_is_on(self, world, monkeypatch):
        sent = MagicMock()
        monkeypatch.setattr(mailer, 'publish', sent)
        build.build_for_user(world.tables, SCHEDULED, NOW)
        sent.assert_not_called()
        _email_on(world)
        build.build_for_user(world.tables, SCHEDULED, NOW)
        assert sent.call_args.args[0] == 'sub-ana'

    def test_a_refresh_is_never_mailed(self, world, monkeypatch):
        sent = MagicMock()
        monkeypatch.setattr(mailer, 'publish', sent)
        _email_on(world)
        build.build_for_user(world.tables, REFRESH, NOW)
        sent.assert_not_called()

    @pytest.mark.parametrize('source', ['chosen', 'ui', None])
    def test_the_scheduled_build_writes_and_mails_in_the_stored_language(self, world, monkeypatch, source):
        # No reader is in front of the screen: whatever the source, the stored language is the one used.
        sent = MagicMock()
        monkeypatch.setattr(mailer, 'publish', sent)
        _email_on(world)
        row = world.tables.aggregates.get_item(Key={'pk': 'USERCTX#sub-ana', 'sk': 'briefing'})['Item']
        source_field = {} if source is None else {'language_source': source}
        world.tables.aggregates.put_item(Item={**row, 'language': 'pl', **source_field})
        build.build_for_user(world.tables, SCHEDULED, NOW)
        assert (_brief(world)['language'], 'Otwórz' in str(sent.call_args.args)) == ('pl', True)


class TestDispatch:
    @pytest.mark.parametrize(('row', 'expected'), [
        ({'hour': 8, 'time_zone': 'UTC'}, '2026-10-17'),
        ({'hour': 10, 'time_zone': 'UTC'}, None),
        ({'hour': 8, 'time_zone': 'UTC', 'last_day': '2026-10-17'}, None),
        ({'hour': 17, 'time_zone': 'Asia/Tokyo'}, '2026-10-17'),
        ({'hour': 7, 'time_zone': 'America/Los_Angeles'}, None),
    ])
    def test_due_day(self, row, expected):
        assert due_day(row, NOW) == expected

    def test_a_subscriber_is_queued_once_per_local_day(self, world):
        world.tables.aggregates.put_item(Item={**store.subscriber_key('sub-ana'), 'sub': 'sub-ana',
                                               'username': 'ana', 'hour': 8, 'time_zone': 'UTC'})
        first = dispatch(world.tables.aggregates, world.sqs, world.queue_url, NOW)
        second = dispatch(world.tables.aggregates, world.sqs, world.queue_url, NOW + timedelta(minutes=15))
        assert (first['queued'], second['queued']) == (1, 0)
        [message] = world.sqs.receive_message(QueueUrl=world.queue_url).get('Messages', [])
        assert json.loads(message['Body'])['reason'] == 'scheduled'

    def test_nobody_subscribed_queues_nothing(self, world):
        assert dispatch(world.tables.aggregates, world.sqs, world.queue_url, NOW) == {'subscribers': 0, 'queued': 0}


def _record(body: str, message_id: str = 'm1') -> dict:
    return {'eventSource': 'aws:sqs', 'messageId': message_id, 'body': body}


class TestHandler:
    @pytest.fixture(autouse=True)
    def wired(self, world, monkeypatch):
        monkeypatch.setattr(handler, 'tables', lambda: world.tables)

    def test_an_unreadable_message_is_dropped(self, monkeypatch):
        built = MagicMock()
        monkeypatch.setattr(handler, 'build_for_user', built)
        result = handler.consume({'Records': [_record('{"kind": "other"}'), _record('not json', 'm2')]}, NOW)
        assert result == {'batchItemFailures': []}
        built.assert_not_called()

    def test_a_transient_fault_is_retried(self, monkeypatch):
        monkeypatch.setattr(handler, 'build_for_user', MagicMock(side_effect=DirectoryUnavailable('cognito')))
        result = handler.consume({'Records': [_record(build_message('sub-ana', 'ana', 'refresh'))]}, NOW)
        assert result == {'batchItemFailures': [{'itemIdentifier': 'm1'}]}

    def test_the_stored_site_link_reaches_the_build(self, world, monkeypatch):
        built = MagicMock()
        monkeypatch.setattr(handler, 'build_for_user', built)
        world.tables.aggregates.put_item(Item={**store.subscriber_key('sub-ana'), 'site_url': 'https://voc.example.com'})
        handler.consume({'Records': [_record(build_message('sub-ana', 'ana', 'scheduled'))]}, NOW)
        assert built.call_args.args[1].site_url == 'https://voc.example.com'

    def test_a_schedule_event_dispatches(self):
        assert handler.run_dispatch(NOW) == {'subscribers': 0, 'queued': 0}


def _run_real_build(world, monkeypatch) -> dict:
    monkeypatch.setenv('MEMORY_TABLE', 'test-memory')
    monkeypatch.setenv('AGENTS_TABLE', 'test-agents')
    monkeypatch.setattr(handler, 'tables', lambda: world.tables)
    _activity(world)
    return handler.lambda_handler({'Records': [_record(build_message('sub-ana', 'ana', 'refresh'))]}, MagicMock())


@pytest.mark.usefixtures('reader', 'no_memory', 'model')
def test_a_real_build_stays_inside_the_worker_roles_grants(world, monkeypatch):
    """Runs under lambda/shared/test/strict_iam.py: every DynamoDB call is judged against
    BriefingWorkerBriefingRole in memory-agents-dynamodb-grants.json."""
    assert _run_real_build(world, monkeypatch) == {'batchItemFailures': []}
    assert _brief(world)['status'] == 'ready'


@pytest.mark.usefixtures('reader', 'no_memory', 'model')
def test_the_same_build_is_refused_without_its_grant(world, monkeypatch):
    revoked = copy.deepcopy(strict_iam.manifest())
    revoked['roles']['BriefingWorkerBriefingRole']['grants']['Aggregates'].remove('dynamodb:UpdateItem')
    monkeypatch.setattr(strict_iam, 'manifest', lambda: revoked)
    assert _run_real_build(world, monkeypatch) == {'batchItemFailures': [{'itemIdentifier': 'm1'}]}
