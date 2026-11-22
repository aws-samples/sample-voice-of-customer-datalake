"""The heartbeat's engineering agents (7.47.00): the github_issue trigger's filters and label rule, one run per issue,
the owner's re-check, the lock held by a live engineering run, and their reviews of one kind (moto)."""
from __future__ import annotations

import io
import json
from collections.abc import Generator
from contextlib import contextmanager
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from typing import Any
from unittest.mock import MagicMock, patch

import pytest
from botocore.exceptions import ClientError

from agents import plan_identity
from agents.heartbeat import engineering, issues
from agents.heartbeat import handler as hb
from shared import agents_store as store
from shared import engineering_agent_runs as eng_runs
from shared.agent_seed import seeded_flow
from shared.test.agents_fixtures import CATEGORIES, agents_env, stored_agent

NOW = datetime(2026, 11, 16, 9, 30, tzinfo=UTC)
CREATED = NOW - timedelta(days=3)
REPO = 'example-org/shop'
CONNECTION = {'pk': 'CONNECTIONS#default', 'sk': 'CONNECTION#shop', 'connection_id': 'shop', 'host': 'github',
              'repository': REPO, 'default_branch': 'main', 'version': 1}
ISSUE = {'kind': 'github_issue', 'label': 'voc-agent', 'trusted_authors': False, 'lookback_days': 7}


class Start:
    """voc-engineering-start as the heartbeat's client sees it (``error``: a refusal's type)."""

    def __init__(self, error: str = '') -> None:
        self.error, self.sent = error, []

    def invoke(self, **request: Any) -> dict[str, Any]:
        sent = json.loads(request['Payload'])
        self.sent.append(sent)
        if self.error:
            body = {'errorType': self.error, 'errorMessage': 'refused'}
            return {'FunctionError': 'Unhandled', 'Payload': io.BytesIO(json.dumps(body).encode())}
        return {'Payload': io.BytesIO(json.dumps({'run_id': sent['run_id'], 'status': 'active'}).encode())}


def _context(remaining_ms: int = 300_000) -> MagicMock:
    context = MagicMock()
    context.get_remaining_time_in_millis.return_value = remaining_ms
    return context


def _index(name: str, pk: str) -> dict[str, Any]:
    return {'IndexName': name, 'Projection': {'ProjectionType': 'ALL'},
            'KeySchema': [{'AttributeName': pk, 'KeyType': 'HASH'}, {'AttributeName': 'gsi1sk', 'KeyType': 'RANGE'}]}


def _feedback_table(resource: Any) -> Any:
    """voc-feedback's two indexes the heartbeat reads: by date and by channel."""
    keys = ['pk', 'sk', 'gsi1pk', 'gsi1sk', 'gsi5pk']
    index = _index
    return resource.create_table(
        TableName='test-feedback-engineering', BillingMode='PAY_PER_REQUEST',
        KeySchema=[{'AttributeName': 'pk', 'KeyType': 'HASH'}, {'AttributeName': 'sk', 'KeyType': 'RANGE'}],
        AttributeDefinitions=[{'AttributeName': name, 'AttributeType': 'S'} for name in keys],
        GlobalSecondaryIndexes=[index('gsi1-by-date', 'gsi1pk'), index('gsi5-by-channel', 'gsi5pk')])


@contextmanager
def _env(*, owner_admin: bool = True, start: Start | None = None) -> Generator[tuple[Any, Any, Start], None, None]:
    client = start or Start()
    with agents_env() as env:
        feedback = _feedback_table(env.resource)
        with patch.object(hb, 'FEEDBACK_TABLE', feedback.name), patch.object(hb, 'AGGREGATES_TABLE', env.aggregates.name), \
                patch.object(hb, 'get_dynamodb_resource', return_value=env.resource), \
                patch.dict('os.environ', {'ENGINEERING_AGENTS': 'on', 'ENGINEERING_START_FUNCTION': 'voc-engineering-start',
                                          'ENGINEERING_TABLE': 'voc-engineering'}), \
                patch.object(engineering, 'start_client', return_value=client), \
                patch.object(engineering, 'owner_is_admin', return_value=owner_admin):
            env.agents.put_item(Item=CONNECTION)
            yield env, feedback, client


def _agent(env: Any, *, kind: str = 'bug', triggers: list | None = None, scope: dict | None = None,
           budget: float | None = 50) -> dict:
    definition = seeded_flow('bug-fixer')
    definition = {k: v for k, v in definition.items() if k != 'budget'} if budget is None else \
        {**definition, 'budget': {'monthly_usd': budget}}
    flow = store.create_workflow(env.agents, definition, created_by='admin-sub', username='alice', now=CREATED)
    fields = store.normalize_agent({
        'name': 'Bug fixer', 'enabled': True, 'scope': scope or {'all': True}, 'instructions': '',
        'triggers': triggers if triggers is not None else [ISSUE],
        'engineering': {'connection': 'shop', 'language': 'python', 'feedback_type': kind}}, CATEGORIES)
    fields.update(workflow_id=flow['workflow_id'], owner_sub='admin-sub')
    agent = store.create_agent(env.agents, fields, created_by='admin-sub', now=CREATED)
    store.set_agent_attributes(env.agents, agent['agent_id'], {'owner_username': 'alice'})
    return store.get_agent(env.agents, agent['agent_id']) or agent


def _issue(feedback: Any, number: int, *, at: datetime, labels: tuple[str, ...] = ('voc-agent',),
           kind: str = 'bug', state: str = 'open', repo: str = REPO, association: str = 'NONE',
           source: str = 'github_issues', item_kind: str = 'issue', category: str = 'shipping') -> None:
    feedback.put_item(Item={
        'pk': f'SOURCE#{source}', 'sk': f'FEEDBACK#{repo}#{number}', 'feedback_id': f'{repo}#{number}',
        'gsi5pk': 'CHANNEL#issue', 'gsi1sk': f'{at.isoformat()}#{number}', 'source_platform': source,
        'category': category, 'dimensions': {'feedback_type': kind},
        'issue_attributes': {'kind': item_kind, 'repo': repo, 'number': Decimal(number), 'state': state,
                             'labels': list(labels), 'author_association': association}})


def _found_number(found: eng_runs.IssueRef | None) -> int:
    """The number of the issue ``find_issue`` found (one is expected)."""
    assert found is not None
    return found.number


def _review(feedback: Any, feedback_id: str, *, at: datetime, kind: str = 'bug', category: str = 'shipping') -> None:
    feedback.put_item(Item={'pk': 'SOURCE#web', 'sk': f'FEEDBACK#{feedback_id}', 'feedback_id': feedback_id,
                            'gsi1pk': f"DATE#{at.strftime('%Y-%m-%d')}", 'gsi1sk': f'{at.isoformat()}#{feedback_id}',
                            'category': category, 'dimensions': {'feedback_type': kind}, 'source_platform': 'web'})


def _runs(env: Any, agent: dict) -> list[dict]:
    return store.list_runs(env.agents, agent['agent_id'], limit=10)[0]


class TestTheLabelRule:
    @pytest.mark.parametrize(('labels', 'association', 'trusted', 'private', 'label', 'starts'), [
        (['voc-agent'], 'NONE', False, False, 'voc-agent', True),
        (['VOC-Agent'], 'NONE', False, False, 'voc-agent', True),         # (GitHub's labels: no case)
        ([], 'OWNER', True, False, 'voc-agent', False),                   # (public: the label alone)
        ([], 'MEMBER', True, True, 'voc-agent', True),                    # (private: a trusted author too)
        ([], 'NONE', True, True, 'voc-agent', False),
        ([], 'NONE', False, True, 'voc-agent', False),
        ([], 'NONE', False, True, '', True),                              # (private, no label set: any issue)
        (['voc-agent'], 'NONE', False, False, '', False),                 # (public, no label set: none)
    ])
    def test_who_may_start_a_run(self, labels: list, association: str, trusted: bool, private: bool, label: str,
                                 starts: bool) -> None:
        attributes = {'labels': labels, 'author_association': association}
        trigger = {'label': label, 'trusted_authors': trusted}
        assert issues.may_start(attributes, trigger, private=private) is starts


class TestFindIssue:
    def test_only_an_open_issue_of_the_repository_of_the_agents_kind_in_scope_starts(self) -> None:
        with _env() as (env, feedback, _):
            agent = _agent(env, scope={'all': False, 'categories': ['shipping']})
            at = NOW - timedelta(days=1)
            _issue(feedback, 1, at=at, kind='feature_request')
            _issue(feedback, 2, at=at, state='closed')
            _issue(feedback, 3, at=at, repo='example-org/other')
            _issue(feedback, 4, at=at, source='web')
            _issue(feedback, 5, at=at, item_kind='comment')
            _issue(feedback, 6, at=at, category='billing')
            _issue(feedback, 7, at=at, labels=('bug',))
            _issue(feedback, 8, at=NOW - timedelta(days=8))   # (past the look-back)
            assert issues.find_issue(feedback, env.agents, agent, ISSUE, CONNECTION, NOW) is None
            _issue(feedback, 9, at=at)
            assert issues.find_issue(feedback, env.agents, agent, ISSUE, CONNECTION, NOW) == eng_runs.IssueRef(
                REPO, 9, f'{REPO}#9')

    def test_the_oldest_unclaimed_issue_starts_first(self) -> None:
        with _env() as (env, feedback, _):
            agent = _agent(env)
            _issue(feedback, 10, at=NOW - timedelta(hours=1))
            _issue(feedback, 11, at=NOW - timedelta(days=2))
            env.agents.put_item(Item={**store.issue_claim_key(REPO, 11), 'agent_run_id': 'ar_x'})
            assert _found_number(issues.find_issue(feedback, env.agents, agent, ISSUE, CONNECTION, NOW)) == 10

    def test_a_gitlab_connection_has_no_github_issues(self) -> None:
        with _env() as (env, feedback, _):
            agent = _agent(env)
            _issue(feedback, 1, at=NOW - timedelta(hours=1))
            assert issues.find_issue(feedback, env.agents, agent, ISSUE, {**CONNECTION, 'host': 'gitlab'}, NOW) is None


class TestTick:
    def test_a_labelled_bug_issue_starts_one_run_ever_as_the_agents_owner(self) -> None:
        with _env() as (env, feedback, client):
            agent = _agent(env)
            _issue(feedback, 42, at=NOW - timedelta(hours=2))
            assert hb.run_heartbeat(_context(), now=NOW)['outcomes'] == {'started': 1}
            (run,) = _runs(env, agent)
            assert (run['kind'], run['status'], run['trigger'], run['issue']) == (
                'engineering', 'running', 'github_issue', {'repository': REPO, 'number': 42})
            (sent,) = client.sent
            assert (sent['actor'], sent['goal'], sent['issue'], sent['resolve_commit'], sent['hard_cap']) == (
                'admin-sub', f'Fix the bug reported in issue #42 of {REPO}.', 42, True, True)
            assert sent['via'] == {'agent_id': agent['agent_id'], 'agent_run_id': run['run_id'],
                                   'trigger': 'github_issue'}
            # While the engineering run is live the lock holds; once it is done, the issue is never started again.
            with patch.object(engineering, '_meta_status', return_value='needs_human'):
                assert hb.run_heartbeat(_context(), now=NOW)['outcomes'] == {'active_run': 1}
            with patch.object(engineering, '_meta_status', return_value='done'):
                later = NOW + timedelta(days=1)
                assert hb.run_heartbeat(_context(), now=later)['outcomes'] == {'not_due': 1}
            done = store.get_run(env.agents, agent['agent_id'], run['run_id'])
            assert done is not None
            assert done['status'] == 'completed'
            assert len(client.sent) == 1

    def test_an_owner_who_is_no_longer_an_admin_starts_nothing(self) -> None:
        with _env(owner_admin=False) as (env, feedback, client):
            agent = _agent(env)
            _issue(feedback, 42, at=NOW - timedelta(hours=2))
            assert hb.run_heartbeat(_context(), now=NOW)['outcomes'] == {'owner_not_admin': 1}
            assert (_runs(env, agent), client.sent) == ([], [])
            assert stored_agent(env.agents, agent['agent_id'])['last_skip_reason'] == 'owner_not_admin'
            assert not store.issue_claimed(env.agents, REPO, 42)

    def test_a_directory_that_cannot_answer_starts_nothing(self) -> None:
        with _env() as (env, feedback, client), \
                patch.object(engineering, 'owner_is_admin', side_effect=engineering.DirectoryUnavailable('x')):
            _agent(env)
            _issue(feedback, 42, at=NOW - timedelta(hours=2))
            assert hb.run_heartbeat(_context(), now=NOW)['outcomes'] == {'error': 1}
            assert client.sent == []

    def test_an_agent_whose_connection_was_removed_is_not_set_up(self) -> None:
        with _env() as (env, feedback, client):
            agent = _agent(env)
            env.agents.put_item(Item={**CONNECTION, 'removed': True})
            _issue(feedback, 42, at=NOW - timedelta(hours=2))
            assert hb.run_heartbeat(_context(), now=NOW)['outcomes'] == {'not_set_up': 1}
            assert stored_agent(env.agents, agent['agent_id'])['last_skip_reason'] == 'not_set_up'
            assert client.sent == []

    def test_an_expired_fine_grained_token_skips_and_writes_no_run_lock_or_claim(self) -> None:
        """7.71.00 (Q16): the start's token refusal (``run_connection``, a ``ConflictError``) is the tick's skip reason
        on every due tick, never an error, and nothing is written: no run, no lock, no issue claim."""
        with _env() as (env, feedback, client):
            agent = _agent(env)   # (the bug fixer's flow pushes)
            env.agents.put_item(Item={**CONNECTION, 'connection_kind': 'fine_grained', 'credential_set': True,
                                      'token_expires_at': '2026-11-01'})
            _issue(feedback, 42, at=NOW - timedelta(hours=2))
            assert hb.run_heartbeat(_context(), now=NOW)['outcomes'] == {'token_expired': 1}
            stored = stored_agent(env.agents, agent['agent_id'])
            assert (_runs(env, agent), client.sent, stored.get('active_run_id'), stored['last_skip_reason']) == (
                [], [], None, 'token_expired')
            assert not store.issue_claimed(env.agents, REPO, 42)
            assert hb.run_heartbeat(_context(), now=NOW + timedelta(hours=1))['outcomes'] == {'token_expired': 1}

    def test_a_refused_start_fails_the_run_and_keeps_the_issue_claimed(self) -> None:
        with _env(start=Start('RuntimeRefused')) as (env, feedback, client):
            agent = _agent(env)
            _issue(feedback, 42, at=NOW - timedelta(hours=2))
            assert hb.run_heartbeat(_context(), now=NOW)['outcomes'] == {'start_refused': 1}
            (run,) = _runs(env, agent)
            assert run['status'] == 'failed'
            assert store.issue_claimed(env.agents, REPO, 42)
            assert hb.run_heartbeat(_context(), now=NOW + timedelta(days=1))['outcomes'] == {'not_due': 1}
            assert len(client.sent) == 1

    def test_one_run_a_day_by_default(self) -> None:
        with _env() as (env, feedback, client):
            agent = _agent(env)
            _issue(feedback, 1, at=NOW - timedelta(hours=3))
            _issue(feedback, 2, at=NOW - timedelta(hours=2))
            assert hb.run_heartbeat(_context(), now=NOW)['outcomes'] == {'started': 1}
            with patch.object(engineering, '_meta_status', return_value='done'):
                assert hb.run_heartbeat(_context(), now=NOW + timedelta(minutes=15))['outcomes'] == {'daily_cap': 1}
            assert len(client.sent) == 1
            assert len(_runs(env, agent)) == 1

    def test_too_little_time_left_starts_nothing(self) -> None:
        with _env() as (env, feedback, client):
            _agent(env)
            _issue(feedback, 1, at=NOW - timedelta(hours=3))
            assert hb.run_heartbeat(_context(30_000), now=NOW)['outcomes'] == {'out_of_time': 1}
            assert client.sent == []


class TestReviewsOfItsKind:
    def test_new_reviews_counts_only_the_agents_kind_and_carries_their_ids(self) -> None:
        with _env() as (env, feedback, client):
            agent = _agent(env, triggers=[{'kind': 'new_reviews', 'min_new': 2, 'cooldown_hours': 0}])
            _review(feedback, 'a', at=NOW - timedelta(hours=1))
            _review(feedback, 'b', at=NOW - timedelta(hours=1), kind='praise')
            assert hb.run_heartbeat(_context(), now=NOW)['outcomes'] == {'not_due': 1}
            _review(feedback, 'c', at=NOW - timedelta(minutes=5), category='billing')
            assert hb.run_heartbeat(_context(), now=NOW)['outcomes'] == {'started': 1}
            (sent,) = client.sent
            assert sent['goal'] == 'Hunt the defects behind 2 bug reports in all reviews.'
            assert (sorted(sent['feedback']['ids']), sent['feedback']['count']) == (['a', 'c'], 2)
            assert 'issue' not in sent
            assert _runs(env, agent)[0]['feedback_count'] == 2

    def test_a_threshold_with_no_bug_report_in_its_window_skips_and_moves_its_baseline(self) -> None:
        with _env() as (env, feedback, client):
            agent = _agent(env, triggers=[{'kind': 'threshold', 'count': 1, 'per': 'category', 'window_days': 7}])
            env.aggregates.put_item(Item={'pk': 'METRIC#daily_category#shipping', 'sk': NOW.strftime('%Y-%m-%d'),
                                          'count': Decimal(3)})
            _review(feedback, 'p', at=NOW - timedelta(hours=1), kind='praise')
            assert hb.run_heartbeat(_context(), now=NOW)['outcomes'] == {'no_bug_reports': 1}
            stored = stored_agent(env.agents, agent['agent_id'])
            assert (stored['last_skip_reason'], stored['threshold_baseline']) == ('no_bug_reports', {'shipping': 3})
            assert client.sent == []


class TestLockHeal:
    def _queued(self, env: Any, agent: dict, *, at: datetime) -> dict:
        run = store.start_run(env.agents, agent, store.RunStart(
            trigger='manual', requested_by='a', workflow_revision=1,
            run_fields={'kind': 'engineering', 'engineering_run_id': '01JDA7K3M9Q2R5T8V0W4X6Y1Z3'}), now=at)
        assert run is not None
        return run

    def test_a_run_whose_engineering_run_was_never_written_fails_after_the_grace(self) -> None:
        with _env() as (env, _feedback, _):
            agent = _agent(env, triggers=[])
            run = self._queued(env, agent, at=NOW - timedelta(minutes=5))
            with patch.object(engineering, '_meta_status', return_value=None):
                assert hb.run_heartbeat(_context(), now=NOW)['outcomes'] == {'active_run': 1}
                assert hb.run_heartbeat(_context(), now=NOW + engineering.START_GRACE)['outcomes'] == {'not_due': 1}
            failed = store.get_run(env.agents, agent['agent_id'], run['run_id'])
            assert failed is not None
            assert failed['status'] == 'failed'

    @pytest.mark.parametrize(('status', 'ended'), [('failed', 'failed'), ('stopped', 'cancelled')])
    def test_an_ended_engineering_run_ends_the_agents_run_even_when_disabled(self, status: str, ended: str) -> None:
        with _env() as (env, _feedback, _):
            agent = _agent(env, triggers=[])
            run = self._queued(env, agent, at=NOW - timedelta(days=3))   # (never the 24 hours of an agents run)
            store.update_agent(env.agents, agent['agent_id'], {'enabled': False}, updated_by='a', now=NOW)
            with patch.object(engineering, '_meta_status', return_value=status):
                hb.run_heartbeat(_context(), now=NOW)
            finished = store.get_run(env.agents, agent['agent_id'], run['run_id'])
            assert finished is not None
            assert finished['status'] == ended
            assert stored_agent(env.agents, agent['agent_id']).get('active_run_id') is None


class TestTheOwnersRecheck:
    def _cognito(self, *, enabled: bool = True, sub: str = 'admin-sub', groups: tuple[str, ...] = ('admins',),
                 missing: bool = False) -> MagicMock:
        cognito = MagicMock()
        if missing:
            cognito.admin_get_user.side_effect = ClientError({'Error': {'Code': 'UserNotFoundException'}}, 'AdminGetUser')
        cognito.admin_get_user.return_value = {'Enabled': enabled, 'UserAttributes': [{'Name': 'sub', 'Value': sub}]}
        cognito.admin_list_groups_for_user.return_value = {'Groups': [{'GroupName': g} for g in groups]}
        return cognito

    @pytest.mark.parametrize(('cognito', 'admin'), [
        ({}, True), ({'enabled': False}, False), ({'sub': 'another'}, False), ({'groups': ('users',)}, False),
        ({'missing': True}, False),
    ])
    def test_the_owner_is_an_enabled_admin_of_the_same_account(self, cognito: dict, admin: bool,
                                                               monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv('USER_POOL_ID', 'pool')
        with patch.object(plan_identity, '_cognito', return_value=self._cognito(**cognito)):
            assert engineering.owner_is_admin({'owner_sub': 'admin-sub', 'owner_username': 'alice'}) is admin
        assert engineering.owner_is_admin({'owner_sub': 'admin-sub'}) is False

    def test_a_directory_fault_is_closed(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv('USER_POOL_ID', 'pool')
        cognito = MagicMock()
        cognito.admin_get_user.side_effect = ClientError({'Error': {'Code': 'InternalErrorException'}}, 'AdminGetUser')
        with patch.object(plan_identity, '_cognito', return_value=cognito), \
                pytest.raises(engineering.DirectoryUnavailable):
            engineering.owner_is_admin({'owner_sub': 'admin-sub', 'owner_username': 'alice'})
