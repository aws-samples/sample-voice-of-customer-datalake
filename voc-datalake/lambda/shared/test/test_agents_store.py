"""Tests for shared/agents_store.py: the agent model and the voc-agents data access (moto)."""
from datetime import UTC, datetime, timedelta

import pytest

from shared import agents_store as store
from shared import workflow_schema
from shared.category_access import UNRESTRICTED, CategoryScope
from shared.exceptions import ConflictError, ValidationError
from shared.test.agents_fixtures import CATEGORIES, agent_body, agents_env

NOW = datetime(2026, 10, 4, 12, 0, tzinfo=UTC)


def _agent(env, **overrides):
    fields = store.normalize_agent(agent_body(**overrides), CATEGORIES)
    fields['workflow_id'] = workflow_schema.DEFAULT_WORKFLOW_ID
    return store.create_agent(env.agents, fields, created_by='admin-sub', now=NOW)


def _present[T](value: T | None) -> T:
    """``value``, asserting it is there — for store reads the test just wrote."""
    assert value is not None
    return value


def _stored(env, agent_id: str) -> dict:
    return _present(store.get_agent(env.agents, agent_id))


def _start(env, agent, *, scheduled=False, cap=2, now=NOW):
    request = store.RunStart(trigger='schedule' if scheduled else 'manual', requested_by='x', workflow_revision=1,
                             review_since=store.iso(now), counts_against_daily_cap=scheduled, daily_cap=cap)
    return store.start_run(env.agents, _stored(env, agent['agent_id']), request, now=now)


class TestNormalizeAgent:
    def test_defaults(self):
        fields = store.normalize_agent({'name': ' Crew ', 'scope': {'all': True}}, CATEGORIES)
        assert fields['name'] == 'Crew'
        assert fields['enabled'] is False
        assert fields['budget'] == {'max_scheduled_runs_per_day': 2, 'max_model_calls_per_run': 150,
                                    'monthly_call_cap': store.DEFAULT_MONTHLY_CALL_CAP}
        assert fields['output'] == {'visibility': 'private'}
        assert fields['personas'] == {'fixed': [], 'allow_generate': True}
        assert fields['models'] == {'orchestrator': None, 'worker': None, 'reviewer': None, 'persona': None}

    def test_an_explicit_null_cap_is_uncapped(self):
        fields = store.normalize_agent({'name': 'n', 'budget': {'monthly_call_cap': None}}, CATEGORIES)
        assert fields['budget']['monthly_call_cap'] is None

    @pytest.mark.parametrize('body', [
        {'name': ''},
        {'name': 'n', 'scope': {'all': False}},
        {'name': 'n', 'scope': {'all': False, 'categories': ['unknown']}},
        {'name': 'n', 'scope': {'all': False, 'subcategories': [{'category': 'shipping', 'name': 'nope'}]}},
        {'name': 'n', 'budget': {'max_scheduled_runs_per_day': 3}},
        {'name': 'n', 'budget': {'max_model_calls_per_run': True}},
        {'name': 'n', 'models': {'worker': 'gpt-9'}},
        {'name': 'n', 'models': {'janitor': None}},
        {'name': 'n', 'triggers': [{'kind': 'schedule', 'every': 'cron', 'cron': '61 * * * *'}]},
        {'name': 'n', 'triggers': [{'kind': 'schedule', 'every': '24h', 'timezone': 'Mars/Olympus'}]},
        {'name': 'n', 'triggers': [{'kind': 'threshold', 'per': 'product'}]},
        {'name': 'n', 'triggers': [{'kind': 'sometimes'}]},
        {'name': 'n', 'personas': {'fixed': [{'project_id': 'a#b', 'persona_id': 'p'}]}},
        {'name': 'n', 'workflow_id': 'nope'},
        {'name': 'n', 'stats': {}},
        {'name': 'n', 'instructions': 'x' * 8001},
    ])
    def test_invalid_bodies(self, body):
        with pytest.raises(ValidationError):
            store.normalize_agent(body, CATEGORIES)

    def test_subcategory_scope_and_triggers(self):
        fields = store.normalize_agent({
            'name': 'n',
            'scope': {'all': False, 'subcategories': [{'category': 'shipping', 'name': 'late'}]},
            'triggers': [{'kind': 'schedule', 'every': 'cron', 'cron': '0  9 * * 1-5', 'timezone': 'Europe/Paris'},
                         {'kind': 'threshold', 'count': 5, 'per': 'subcategory'}],
        }, CATEGORIES)
        assert fields['scope']['subcategories'] == [{'category': 'shipping', 'name': 'late'}]
        assert fields['triggers'][0]['cron'] == '0 9 * * 1-5'
        assert fields['triggers'][1] == {'kind': 'threshold', 'count': 5, 'per': 'subcategory', 'window_days': 7}

    def test_update_keeps_omitted_fields(self):
        base = store.normalize_agent(agent_body(instructions='Be brief'), CATEGORIES)
        merged = store.normalize_agent({'enabled': True}, CATEGORIES, base=base)
        assert merged['instructions'] == 'Be brief'
        assert merged['enabled'] is True


class TestCron:
    def test_weekday_mornings(self):
        spec = store.parse_cron('30 9 * * 1-5')
        assert spec.matches(datetime(2026, 10, 5, 9, 30))  # Monday
        assert not spec.matches(datetime(2026, 10, 4, 9, 30))  # Sunday
        assert not spec.matches(datetime(2026, 10, 5, 9, 31))

    def test_steps_lists_and_sunday_as_7(self):
        spec = store.parse_cron('*/15 0,12 * * 7')
        assert spec.minutes == frozenset({0, 15, 30, 45})
        assert spec.weekdays == frozenset({0})

    def test_either_day_field_matches_when_both_are_restricted(self):
        spec = store.parse_cron('0 0 1 * 1')
        assert spec.matches(datetime(2026, 10, 1, 0, 0))  # the 1st, a Thursday
        assert spec.matches(datetime(2026, 10, 5, 0, 0))  # a Monday


class TestVisibility:
    def test_unrestricted_sees_everything(self):
        assert store.agent_visible(UNRESTRICTED, {'scope': {'all': True}})

    def test_restricted_needs_the_whole_scope(self):
        viewer = CategoryScope(all=False, categories=frozenset({'shipping'}))
        assert store.agent_visible(viewer, {'scope': {'all': False, 'categories': ['shipping']}})
        assert not store.agent_visible(viewer, {'scope': {'all': False, 'categories': ['shipping', 'billing']}})
        assert not store.agent_visible(viewer, {'scope': {'all': True}})
        assert not store.agent_visible(viewer, {})

    def test_item_in_scope(self):
        scope = {'all': False, 'categories': ['billing'], 'subcategories': [{'category': 'shipping', 'name': 'late'}]}
        assert store.item_in_scope(scope, {'category': 'billing'})
        assert store.item_in_scope(scope, {'category': 'shipping', 'subcategory': 'late'})
        assert not store.item_in_scope(scope, {'category': 'shipping', 'subcategory': 'damaged'})
        assert not store.item_in_scope(scope, {})


class TestRunLock:
    def test_one_active_run_per_agent(self):
        with agents_env() as env:
            agent = _agent(env)
            run = _present(_start(env, agent))
            assert run['status'] == 'queued'
            assert run['gsi1pk'] == 'RUNS_ACTIVE'
            assert _start(env, agent) is None
            stored = _stored(env, agent['agent_id'])
            assert stored['active_run_id'] == run['run_id']
            assert stored['runs_total'] == 1

    def test_finishing_releases_the_lock_and_counts(self):
        with agents_env() as env:
            agent = _agent(env)
            run = _present(_start(env, agent))
            finished = _present(store.finish_run(env.agents, agent['agent_id'], run['run_id'], 'completed', now=NOW))
            assert finished['status'] == 'completed'
            assert 'gsi1pk' not in finished
            assert store.finish_run(env.agents, agent['agent_id'], run['run_id'], 'failed', now=NOW) is None
            stored = _stored(env, agent['agent_id'])
            assert 'active_run_id' not in stored
            assert stored['runs_completed'] == 1
            assert stored['last_run_status'] == 'completed'
            assert _start(env, agent) is not None

    def test_scheduled_runs_stop_at_the_daily_cap_but_manual_runs_do_not(self):
        with agents_env() as env:
            agent = _agent(env)
            for minute in range(2):
                run = _present(_start(env, agent, scheduled=True, now=NOW + timedelta(minutes=minute)))
                store.finish_run(env.agents, agent['agent_id'], run['run_id'], 'completed', now=NOW)
            assert _start(env, agent, scheduled=True, now=NOW + timedelta(minutes=5)) is None
            assert _start(env, agent, now=NOW + timedelta(minutes=6)) is not None

    def test_the_daily_counter_resets_the_next_day(self):
        with agents_env() as env:
            agent = _agent(env)
            run = _present(_start(env, agent, scheduled=True, cap=1))
            store.finish_run(env.agents, agent['agent_id'], run['run_id'], 'completed', now=NOW)
            assert _start(env, agent, scheduled=True, cap=1) is None
            assert _start(env, agent, scheduled=True, cap=1, now=NOW + timedelta(days=1)) is not None

    def test_an_archived_agent_cannot_start(self):
        with agents_env() as env:
            agent = _agent(env)
            store.update_agent(env.agents, agent['agent_id'], {'status': 'archived'}, updated_by='a', now=NOW)
            assert _start(env, agent) is None

    def test_run_ids_are_time_ordered_and_unique(self):
        ids = {store.new_run_id(NOW) for _ in range(50)}
        assert len(ids) == 50
        assert all(store.is_run_id(run_id) for run_id in ids)
        assert store.new_run_id(NOW) < store.new_run_id(NOW + timedelta(seconds=1))

    def test_a_run_id_carries_four_random_bytes_and_older_two_byte_ids_stay_valid(self):
        # Two random bytes collided ~2% of the time for 50 runs in one millisecond.
        assert len(store.new_run_id(NOW)) == len('ar_') + 12 + 8
        assert store.is_run_id('ar_01a106c906000b7f')
        assert not store.is_run_id('ar_01a106c90600' + 'f' * 9)


class TestEventsAndCalls:
    def test_execution_arn_is_recorded_or_derived_from_the_run_id(self, monkeypatch):
        monkeypatch.setenv(store.STATE_MACHINE_ENV, 'arn:aws:states:us-west-2:1:stateMachine:voc-agent-run')
        run_id = store.new_run_id(NOW)
        assert store.execution_arn_for({'run_id': run_id, 'execution_arn': 'arn:recorded'}) == 'arn:recorded'
        assert store.execution_arn_for({'run_id': run_id}) == f'arn:aws:states:us-west-2:1:execution:voc-agent-run:{run_id}'
        assert store.execution_arn_for({'run_id': 'not-a-run'}) == ''
        monkeypatch.setenv(store.STATE_MACHINE_ENV, '')
        assert store.execution_arn_for({'run_id': run_id}) == ''

    def test_launching_a_run_attaches_the_execution_and_journals_it(self):
        # E2E s2 F3: attach_execution / append_event sent ExpressionAttributeNames={}, which DynamoDB
        # refuses (moto did not, until shared/test/strict_dynamodb.py) — every Run now answered 500.
        with agents_env() as env:
            agent = _agent(env)
            run = _present(_start(env, agent))
            launched = store.launch_run(env.agents, run, now=NOW)
            arn = launched['execution_arn']
            assert arn.endswith(f":{run['run_id']}")
            stored = _present(store.get_run(env.agents, agent['agent_id'], run['run_id']))
            assert stored['execution_arn'] == arn
            assert stored['status'] == 'queued'
            [event] = store.list_events(env.agents, run['run_id'], after=0, limit=10)
            assert event['summary'] == 'Run queued (manual)'

    def test_events_are_sequenced_and_paged(self):
        with agents_env() as env:
            agent = _agent(env)
            run = _present(_start(env, agent))
            for i in range(3):
                store.append_event(env.agents, agent['agent_id'], run['run_id'], 'message', f'step {i}',
                                   now=NOW, role='worker', ref={'project_id': 'p1', 'bogus': 'x'})
            events = store.list_events(env.agents, run['run_id'], after=1, limit=10)
            assert [e['seq'] for e in events] == [2, 3]
            assert events[0]['ref'] == {'project_id': 'p1'}

    def test_unknown_event_kind(self):
        with agents_env() as env:
            agent = _agent(env)
            run = _present(_start(env, agent))
            with pytest.raises(ValueError, match='unknown run event kind: gossip'):
                store.append_event(env.agents, agent['agent_id'], run['run_id'], 'gossip', 's', now=NOW)

    def test_model_calls_count_against_the_month_and_roll_over(self):
        with agents_env() as env:
            agent = _agent(env)
            store.count_month_calls(env.agents, agent, 3, now=NOW)
            # A stale in-memory agent (month_key not yet seen) still adds, never resets.
            store.count_month_calls(env.agents, agent, 2, now=NOW)
            stats = store.agent_stats(_stored(env, agent['agent_id']), NOW)
            assert stats['model_calls_this_month'] == 5
            assert store.agent_stats(_stored(env, agent['agent_id']),
                                     NOW + timedelta(days=40))['model_calls_this_month'] == 0


class TestWorkflows:
    def test_revisions_and_stale_saves(self):
        with agents_env() as env:
            created = store.create_workflow(env.agents, workflow_schema.default_template(), created_by='a',
                                            username='alice', now=NOW, derived_from='wf_default')
            workflow_id = created['workflow_id']
            changed = workflow_schema.default_template()
            changed['name'] = 'Mine'
            saved = store.save_revision(env.agents, workflow_id, changed, expected_revision=1, saved_by='a',
                                        username='alice', now=NOW)
            assert saved['revision'] == 2
            assert saved['name'] == 'Mine'
            with pytest.raises(ConflictError):
                store.save_revision(env.agents, workflow_id, changed, expected_revision=1, saved_by='a',
                                    username='alice', now=NOW)
            assert [r['revision'] for r in store.list_revisions(env.agents, workflow_id)] == [2, 1]
            assert [w['workflow_id'] for w in store.list_workflows(env.agents)] == ['wf_default', workflow_id]

    def test_the_builtin_is_read_only(self):
        with agents_env() as env:
            with pytest.raises(ConflictError):
                store.save_revision(env.agents, 'wf_default', workflow_schema.default_template(),
                                    expected_revision=1, saved_by='a', username='a', now=NOW)
            builtin = _present(store.get_workflow(env.agents, 'wf_default'))
            assert workflow_schema.decode_definition(builtin['definition']) == workflow_schema.default_template()
