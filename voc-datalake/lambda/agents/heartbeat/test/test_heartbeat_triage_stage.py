"""Issue claims per stage (7.50.00): an Issue triage agent's own claim beside the act one, an act trigger's
``requires_triage`` read from the issue's trusted triage row while a triage agent watches the connection, and the
fallback to 7.47.00's rule without one (moto)."""
from __future__ import annotations

from datetime import timedelta
from typing import Any

import pytest

from agents.heartbeat import handler as hb
from agents.heartbeat import issues
from agents.heartbeat.test.test_heartbeat_engineering import (
    CONNECTION,
    ISSUE,
    NOW,
    REPO,
    _agent,
    _context,
    _env,
    _found_number,
    _issue,
    _runs,
)
from shared import agents_store as store
from shared import engineering_agent_runs as eng_runs
from shared.exceptions import ValidationError

TRIAGE = {**ISSUE, 'stage': 'triage'}
REQUIRES_BUG = {**ISSUE, 'requires_triage': 'bug'}


def _triaged(env: Any, number: int, kind: str) -> None:
    env.agents.put_item(Item={**store.issue_triage_key(REPO, number), 'kind': kind, 'severity': 'S2',
                              'priority': 'P2', 'run_id': 'R', 'written_by': 'voc-engineering-runtime'})


class TestTheTrigger:
    def test_a_triage_trigger_keeps_its_stage_and_an_act_trigger_its_required_triage(self) -> None:
        assert store._trigger(TRIAGE)['stage'] == 'triage'
        assert store._trigger(REQUIRES_BUG)['requires_triage'] == 'bug'
        # (an act trigger with nothing new keeps 7.47.00's shape exactly)
        assert store._trigger(ISSUE) == ISSUE
        assert store._trigger({**ISSUE, 'stage': 'act'}) == ISSUE
        assert store.issue_stage(TRIAGE) == 'triage'
        assert store.issue_stage(ISSUE) == 'act'

    @pytest.mark.parametrize('trigger', [
        {**ISSUE, 'stage': 'review'}, {**ISSUE, 'requires_triage': 'investigation'},
        {**TRIAGE, 'requires_triage': 'bug'},
    ])
    def test_a_trigger_off_its_shape_is_refused(self, trigger: dict[str, Any]) -> None:
        with pytest.raises(ValidationError):
            store._trigger(trigger)


def test_the_triage_claim_sits_beside_the_act_claim_and_never_takes_its_key() -> None:
    assert store.issue_claim_key('Example-Org/Shop', 4) == {'pk': 'ISSUE_RUN#default', 'sk': 'example-org/shop#4'}
    assert store.issue_claim_key('Example-Org/Shop', 4, 'triage') == {'pk': 'ISSUE_RUN#default',
                                                                       'sk': 'example-org/shop#4#triage'}
    assert store.issue_triage_key('Example-Org/Shop', 4) == {'pk': 'ISSUE_TRIAGE#default', 'sk': 'example-org/shop#4'}


class TestFindIssueByStage:
    def test_a_triage_trigger_takes_any_kind_of_issue_and_its_own_claim_only(self) -> None:
        with _env() as (env, feedback, _):
            agent = _agent(env, triggers=[TRIAGE])
            _issue(feedback, 5, at=NOW - timedelta(hours=2), kind='feature_request')
            found = issues.find_issue(feedback, env.agents, agent, TRIAGE, CONNECTION, NOW)
            assert found == eng_runs.IssueRef(REPO, 5, f'{REPO}#5')
            # An act run of the issue never keeps its triage from it; its own triage claim does.
            env.agents.put_item(Item={**store.issue_claim_key(REPO, 5), 'agent_run_id': 'ar_act'})
            assert issues.find_issue(feedback, env.agents, agent, TRIAGE, CONNECTION, NOW) == found
            env.agents.put_item(Item={**store.issue_claim_key(REPO, 5, 'triage'), 'agent_run_id': 'ar_triage'})
            assert issues.find_issue(feedback, env.agents, agent, TRIAGE, CONNECTION, NOW) is None

    def test_a_triage_trigger_still_needs_its_label(self) -> None:
        with _env() as (env, feedback, _):
            agent = _agent(env, triggers=[TRIAGE])
            _issue(feedback, 6, at=NOW - timedelta(hours=2), labels=('bug',))
            assert issues.find_issue(feedback, env.agents, agent, TRIAGE, CONNECTION, NOW) is None

    def test_an_act_trigger_that_requires_triage_waits_for_the_trusted_row_while_triage_watches(self) -> None:
        with _env() as (env, feedback, _):
            agent = _agent(env, triggers=[REQUIRES_BUG])
            # (the feedback type says feature: the trusted triage decides, not the item's dimensions)
            _issue(feedback, 7, at=NOW - timedelta(hours=2), kind='feature_request')
            watched = frozenset({'shop'})
            assert issues.find_issue(feedback, env.agents, agent, REQUIRES_BUG, CONNECTION, NOW, watched) is None
            _triaged(env, 7, 'feature')
            assert issues.find_issue(feedback, env.agents, agent, REQUIRES_BUG, CONNECTION, NOW, watched) is None
            triaged = {**store.issue_triage_key(REPO, 7), 'kind': 'bug'}
            env.agents.put_item(Item=triaged)
            found = issues.find_issue(feedback, env.agents, agent, REQUIRES_BUG, CONNECTION, NOW, watched)
            assert _found_number(found) == 7

    def test_with_no_triage_agent_watching_the_act_trigger_keeps_the_feedback_types_rule(self) -> None:
        with _env() as (env, feedback, _):
            agent = _agent(env, triggers=[REQUIRES_BUG])
            _issue(feedback, 8, at=NOW - timedelta(hours=2), kind='feature_request')
            _issue(feedback, 9, at=NOW - timedelta(hours=1))
            # (no row is read: the bug issue starts, the feature one never does)
            assert _found_number(issues.find_issue(feedback, env.agents, agent, REQUIRES_BUG, CONNECTION, NOW)) == 9

    def test_a_triage_label_on_github_never_stands_in_for_the_row(self) -> None:
        with _env() as (env, feedback, _):
            agent = _agent(env, triggers=[REQUIRES_BUG])
            _issue(feedback, 10, at=NOW - timedelta(hours=2), labels=('voc-agent', 'voc-triage/bug'))
            assert issues.find_issue(feedback, env.agents, agent, REQUIRES_BUG, CONNECTION, NOW,
                                     frozenset({'shop'})) is None


def test_the_connections_an_enabled_triage_agent_watches() -> None:
    triage = {'enabled': True, 'status': 'active', 'engineering': {'connection': 'shop'}, 'triggers': [TRIAGE]}
    assert issues.triage_connections([
        triage, {**triage, 'engineering': {'connection': 'other'}, 'enabled': False},
        {**triage, 'engineering': {'connection': 'archived'}, 'status': store.AGENT_STATUS_ARCHIVED},
        {**triage, 'engineering': {'connection': 'acting'}, 'triggers': [ISSUE]},
        {'enabled': True, 'status': 'active', 'engineering': None, 'triggers': [TRIAGE]},
    ]) == {'shop'}


def test_a_tick_starts_the_triage_and_then_the_fix_of_the_same_issue_once_it_is_triaged() -> None:
    with _env() as (env, feedback, client):
        triage = _agent(env, triggers=[TRIAGE])
        _issue(feedback, 42, at=NOW - timedelta(hours=2))
        fixer = _agent(env, triggers=[REQUIRES_BUG])
        outcomes = hb.run_heartbeat(_context(), now=NOW)['outcomes']
        # The triage agent takes the issue under its own claim; the fixer waits for its triage (none yet).
        assert outcomes == {'started': 1, 'not_due': 1}
        (run,) = _runs(env, triage)
        assert run['trigger_detail'] == {'issue': 42, 'repository': REPO, 'stage': 'triage'}
        (sent,) = client.sent
        assert sent['goal'].startswith(f'Triage issue #42 of {REPO}')
        claim = env.agents.get_item(Key=store.issue_claim_key(REPO, 42, 'triage'))['Item']
        assert (claim['stage'], claim['agent_id']) == ('triage', triage['agent_id'])
        assert 'Item' not in env.agents.get_item(Key=store.issue_claim_key(REPO, 42))
        assert _runs(env, fixer) == []
        _triaged(env, 42, 'bug')
        assert hb.run_heartbeat(_context(), now=NOW + timedelta(minutes=5))['outcomes'].get('started') == 1
        (fix,) = _runs(env, fixer)
        assert fix['issue'] == {'repository': REPO, 'number': 42}
        assert env.agents.get_item(Key=store.issue_claim_key(REPO, 42))['Item']['stage'] == 'act'
