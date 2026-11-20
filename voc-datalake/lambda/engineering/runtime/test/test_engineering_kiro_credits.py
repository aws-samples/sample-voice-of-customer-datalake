"""A Kiro session's spend (7.58.00): each turn's credits, as kiro-cli reports them on either ACP engine, counted once
per turn on the session's status (``kiro:<model>``'s ``micro_credits``), recorded in the transcript, and ledgered by the
runtime at the deployment's price per credit (``-c engineeringKiroCreditPrice``), so the run's cost cap, its flow's
budget and the hard cap count them.

The shapes are kiro-cli's own, from live probes on 2026-11-20: the v3 engine (the harness's) reports a turn in a
``session_info_update`` of kind ``turn_completion`` (``promptTurnSummaries``) and the session's running total in one of
kind ``session_usage``; the v2 engine in ``_kiro.dev/metadata`` (``meteringUsage``, ``turnDurationMs``)."""
from __future__ import annotations

import json
from dataclasses import replace
from datetime import UTC, datetime
from decimal import Decimal
from pathlib import Path
from typing import Any

import pytest

from engineering.runtime import unit_runner
from engineering.runtime.caps import (
    DEFAULT_KIRO_CREDIT_PRICE,
    MAX_USD_PER_CREDIT,
    UNPRICED,
    SessionPricing,
    credit_usd,
    kiro_credit_price,
)
from engineering.runtime.harness.kiro import METADATA_METHOD, TurnCredits, session_credits, turn_credits
from engineering.runtime.harness.ports import PAUSE, InboxMessage
from engineering.runtime.interface import MICRO_CREDITS, RuntimeRefused
from engineering.runtime.runs import RunCaps, RunStore
from engineering.runtime.sessions import SessionStore
from engineering.runtime.test.harness_fakes import World, world
from engineering.runtime.test.test_engineering_kiro_harness import _adapter, _events, _fake, _finish, _transcribed
from engineering.runtime.test.test_engineering_sessions import KEY, SESSION, _ledger, capped_budgets
from engineering.spend import Usage, month_spend, token_deltas

#: kiro-cli's own numbers, as the probes saw them (v2's on Haiku 5.5 at its default model, v3's on Haiku 5.5).
V2_TURN = {'sessionId': 's', 'contextUsagePercentage': 1.5, 'turnDurationMs': 2230,
           'meteringUsage': [{'value': 0.20801140762852402, 'unit': 'credit', 'unitPlural': 'credits'}],
           'reasoning': {'support': 'none', 'effortLevels': []}}
V3_TURN = {'kind': 'turn_completion', 'status': 'success', 'elapsedTime': 2469, 'turnId': 'turn-1',
           'executionId': 'turn-1', 'requestIds': ['r-1'],
           'promptTurnSummaries': [{'unit': 'credit', 'unitPlural': 'credits', 'usage': 0.03551446766169154}]}
V3_TOTAL = {'kind': 'session_usage', 'credits': [{'usage': 0.03551446766169154, 'unit': 'credit',
                                                  'unitPlural': 'credits'}]}


def _v3(kiro: dict[str, Any]) -> dict[str, Any]:
    """A v3 ``session/update``'s params with these ``_meta.kiro`` fields."""
    return {'sessionId': 's', 'update': {'sessionUpdate': 'session_info_update', '_meta': {'kiro': kiro}}}


# -- the shapes ------------------------------------------------------------------------------------------------------


def test_a_v2_turns_metadata_is_its_credits_in_millionths_rounded_up():
    assert turn_credits(METADATA_METHOD, V2_TURN) == TurnCredits(208_012, 2230, '', 'v2')


def test_a_v3_turn_completion_is_its_credits_and_its_id():
    assert turn_credits('session/update', _v3(V3_TURN)) == TurnCredits(35_515, 2469, 'turn-1', 'v3')


@pytest.mark.parametrize(('method', 'params'), [
    (METADATA_METHOD, {'sessionId': 's', 'contextUsagePercentage': 1.5}),   # (v2's other metadata in a turn)
    ('session/update', _v3({'kind': 'context_usage', 'usagePercentage': 3.0})),
    ('session/update', _v3(V3_TOTAL)),   # (the running total: never a turn's)
    ('session/update', {'sessionId': 's', 'update': {'sessionUpdate': 'plan'}}),
    ('session/update', {'sessionId': 's', 'update': 'not a mapping'}),
    ('_kiro/sessions/changed', {'upserted': []}),
])
def test_a_notification_that_reports_no_turn_says_none(method: str, params: dict[str, Any]):
    assert turn_credits(method, params) is None


def test_a_turns_entries_are_summed_and_other_units_and_odd_amounts_are_kept_not_counted():
    entries = [{'value': 0.5, 'unit': 'credit'}, {'value': 0.25, 'unit': 'credit'}, {'value': 3, 'unit': 'request'},
               {'value': -1, 'unit': 'credit'}, {'value': True, 'unit': 'credit'}, {'value': '0.1', 'unit': 'credit'},
               {'value': 1e9, 'unit': 'credit'}, 'odd']
    found = turn_credits(METADATA_METHOD, {'meteringUsage': entries, 'turnDurationMs': -5})
    assert found is not None
    assert (found.micro_credits, found.turn_ms) == (750_000, None)
    assert [entry.get('unit') for entry in found.ignored] == ['request', 'credit', 'credit', 'credit', 'credit']
    one = turn_credits(METADATA_METHOD, {'meteringUsage': {'value': 1, 'unit': 'credit'}})
    assert one is not None
    assert one.micro_credits == 1_000_000   # (a lone entry, not in a list)


def test_v3s_running_total_is_read_beside_its_turns():
    assert session_credits(_v3(V3_TOTAL)) == Decimal('0.03551446766169154')
    assert session_credits(_v3(V3_TURN)) is None
    assert session_credits(_v3({'kind': 'session_usage', 'credits': 'odd'})) == Decimal(0)


# -- the adapter, on the fake ------------------------------------------------------------------------------------------


def _kiro_run(tmp_path: Path, turns: list[list[dict[str, Any]]]) -> tuple[World, list[dict[str, Any]]]:
    w = world(tmp_path)
    _transcribed(w)
    binary, _ = _fake(tmp_path, {'turns': turns})
    assert _adapter(binary, w).run(w.session) == 'done'
    return w, _events(w)


def test_each_v3_turns_credits_are_counted_once_on_the_sessions_kiro_model_and_recorded(tmp_path):
    second = {**V3_TURN, 'turnId': 'turn-2', 'elapsedTime': 900,
              'promptTurnSummaries': [{'unit': 'credit', 'usage': 0.5}, {'unit': 'request', 'usage': 2}]}
    w, events = _kiro_run(tmp_path, [
        [{'say': 'looking'}, {'info': V3_TURN}, {'info': V3_TURN}, {'info': V3_TOTAL}],   # (a turn said twice)
        [_finish(), {'info': second}]])
    # The fake's session model is kiro-cli's default; the credits ride on its tokens as a third count.
    assert w.session.context.status.tokens == {'kiro:claude-sonnet-4.5': {'in': 0, 'out': 0,
                                                                          MICRO_CREDITS: 35_515 + 500_000}}
    turns = [event for event in events if event['kind'] == 'kiro_credits']
    assert [(event['micro_credits'], event['turn_id'], event['counted'], event['turn_ms']) for event in turns] == [
        (35_515, 'turn-1', True, 2469), (35_515, 'turn-1', False, 2469), (500_000, 'turn-2', True, 900)]
    assert turns[2]['ignored'] == [{'unit': 'request', 'usage': 2}]
    assert {event['model'] for event in turns} == {'kiro:claude-sonnet-4.5'}
    (total,) = [event for event in events if event['kind'] == 'kiro_session_credits']
    assert (total['credits'], total['counted_credits']) == (0.03551446766169154, 0.035515)


def test_a_restored_sessions_replayed_turn_adds_no_credits_and_its_new_turn_counts_once(tmp_path):
    """R2-5 (7.58.01): the first session's turn (``turn-1``) is counted there. Its continuation loads the saved
    session, whose history kiro-cli replays, that turn's ``turn_completion`` with it: it adds nothing (the session that
    lived it counted it), and the continuation's own turn (``turn-2``), reported twice, is counted once."""
    first = world(tmp_path / 'first')
    _transcribed(first)
    first.inbox.queued = [[], [], [InboxMessage(kind=PAUSE, event_id='ev-pause')]]
    binary, _ = _fake(tmp_path / 'first', {'turns': [[{'info': V3_TURN}, {'tool': '@voc/save_checkpoint',
                                                                          'notes': 'half done'}, {'hold': True}]]})
    assert _adapter(binary, first).run(first.session) == 'paused'
    assert first.session.context.status.tokens['kiro:claude-sonnet-4.5'][MICRO_CREDITS] == 35_515
    second = world(tmp_path / 'second')
    _transcribed(second)
    second.store.objects.update(first.store.objects)
    second.session.restored = [json.loads(body) for key, body in sorted(first.store.objects.items())
                               if '/_checkpoints/' in key][-1]
    turn_2 = {**V3_TURN, 'turnId': 'turn-2', 'promptTurnSummaries': [{'unit': 'credit', 'usage': 0.5}]}
    binary, _ = _fake(tmp_path / 'second', {'turns': [[{'info': turn_2}, {'info': turn_2}, _finish()]]})
    assert _adapter(binary, second).run(second.session) == 'done'
    events = _events(second)
    loaded = next(event for event in events if event['kind'] == 'acp_session')
    assert (loaded['loaded'], loaded['replayed']) == (True, 2)   # (the first prompt, and turn-1's completion)
    assert second.session.context.status.tokens == {'kiro:claude-sonnet-4.5': {'in': 0, 'out': 0,
                                                                               MICRO_CREDITS: 500_000}}
    assert [(event['turn_id'], event['counted']) for event in events if event['kind'] == 'kiro_credits'] == [
        ('turn-2', True), ('turn-2', False)]


def test_a_v2_turns_metadata_is_counted_and_its_other_metadata_and_another_sessions_are_not(tmp_path):
    w, events = _kiro_run(tmp_path, [[
        {'metadata': {'contextUsagePercentage': 1.5}},
        {'metadata': {key: value for key, value in V2_TURN.items() if key != 'sessionId'}},
        {'metadata': {**V2_TURN, 'sessionId': 'sess_another'}},
        _finish()]])
    assert w.session.context.status.tokens['kiro:claude-sonnet-4.5'][MICRO_CREDITS] == 208_012
    assert [(event['engine'], event['counted']) for event in events if event['kind'] == 'kiro_credits'] == [
        ('v2', True)]


def test_a_session_with_no_metering_reports_no_credits(tmp_path):
    w, events = _kiro_run(tmp_path, [[{'say': 'done'}, _finish()]])
    assert w.session.context.status.tokens == {}
    assert not [event for event in events if event['kind'].startswith('kiro_') and 'credits' in event['kind']]


# -- from the harness to the ledger ----------------------------------------------------------------------------------


def test_the_runner_keeps_a_sessions_credits_and_drops_a_count_off_its_shape():
    assert unit_runner.MICRO_CREDITS == MICRO_CREDITS   # (the runner ships alone: it names the count itself)
    report = {'tokens': {'kiro:a': {'in': 0, 'out': 0, MICRO_CREDITS: 7}, 'kiro:b': {MICRO_CREDITS: -1},
                         'kiro:c': {MICRO_CREDITS: True}, 'kiro:d': {MICRO_CREDITS: 1.5},
                         'kiro:e': {MICRO_CREDITS: unit_runner.MAX_MICRO_CREDITS + 1}, 'm': {'in': 1, 'out': 2}}}
    assert unit_runner.bounded_status(report)['tokens'] == {
        'kiro:a': {'in': 0, 'out': 0, MICRO_CREDITS: 7}, 'kiro:b': {'in': 0, 'out': 0},
        'kiro:c': {'in': 0, 'out': 0}, 'kiro:d': {'in': 0, 'out': 0}, 'kiro:e': {'in': 0, 'out': 0},
        'm': {'in': 1, 'out': 2}}


def test_a_continuations_credits_add_to_the_earlier_sessions_and_never_drop():
    earlier = replace(SESSION, tokens={'kiro:m': {'in': 0, 'out': 0, MICRO_CREDITS: 100}})
    continued = replace(earlier, tokens_before=earlier.tokens)
    assert continued.reported({'kiro:m': {'in': 0, 'out': 0, MICRO_CREDITS: 40}})['kiro:m'][MICRO_CREDITS] == 140
    # (a report below what was saved, or negative, never talks the total down)
    saved = replace(continued, tokens={'kiro:m': {'in': 0, 'out': 0, MICRO_CREDITS: 140}})
    assert saved.reported({'kiro:m': {'in': 0, 'out': 0, MICRO_CREDITS: -5}})['kiro:m'][MICRO_CREDITS] == 140
    # A model with no credits keeps its two counts only.
    assert continued.reported({'native': {'in': 1, 'out': 2}})['native'] == {'in': 1, 'out': 2}
    assert token_deltas({'kiro:m': {MICRO_CREDITS: 140}}, {'kiro:m': {MICRO_CREDITS: 100}}) == {
        'kiro:m': Usage(micro_credits=40)}


def test_a_kiro_sessions_credits_are_ledgered_at_the_price_per_credit_on_its_row_the_session_and_the_flow(aws):
    runs = RunStore(aws[1])
    runs.start(SESSION.run_id, caps=RunCaps(max_tasks=10), now=0, flow='wf_hunt', repo='example/app')
    store = SessionStore(aws[1], runs, SessionPricing(rates=UNPRICED, credit_price=Decimal('0.04')),
                         clock=lambda: datetime(2026, 11, 13, tzinfo=UTC))
    created = store.create(SESSION)
    moved = store.save(replace(created, tokens={'kiro:claude-sonnet-5.5': {'in': 0, 'out': 0, MICRO_CREDITS: 2_500_000}}))
    moved = store.save(moved)   # (the same credits again add nothing)
    store.save(replace(moved, tokens={'kiro:claude-sonnet-5.5': {'in': 0, 'out': 0, MICRO_CREDITS: 3_000_000}}))
    (row,) = _ledger(aws[1]).values()
    # 3 credits at $0.04: $0.12, on the model's row with its credits, the session's cost and the flow's month.
    assert (row['model'], row[MICRO_CREDITS], row['usd'], row['tokens_in']) == (
        'kiro:claude-sonnet-5.5', 3_000_000, Decimal('0.12'), 0)
    assert aws[1].get_item(Key=KEY)['Item']['cost_usd'] == Decimal('0.12')
    assert _ledger(aws[1], 'FLOW#')['FLOW#wf_hunt']['usd'] == Decimal('0.12')
    assert runs.spend(SESSION.run_id) == (0, 0.12)   # (credits are never tokens: the token cap is not spent)
    view = month_spend(aws[1], '2026-11', 'model').view()
    assert view['groups'] == [{'key': 'kiro:claude-sonnet-5.5', 'usd': 0.12, 'tokens_in': 0, 'tokens_out': 0,
                               'microvm_seconds': 0, 'credits': 3.0}]


def test_a_runs_cost_cap_is_spent_by_a_kiro_sessions_credits(aws):
    """The supervisor's budget path (``TableRunControl.budget``, as for tokens: its agents are then held for a person):
    a Kiro run passes its ``max_cost_usd`` once its credits' price does."""
    before, after = capped_budgets(aws, 0.1, SessionPricing(rates=UNPRICED),   # (the default price per credit: $0.04)
                                   {'kiro:auto': {'in': 0, 'out': 0, MICRO_CREDITS: 2_000_000}},    # $0.08
                                   {'kiro:auto': {'in': 0, 'out': 0, MICRO_CREDITS: 3_000_000}})    # $0.12 in all
    assert not before.exceeded
    assert (after.exceeded, round(after.cost_usd, 6)) == (True, 0.12)
    # Unpriced (the store's default), the same credits never reach the cap.
    assert SessionStore(aws[1], RunStore(aws[1])).pricing.credit_price == 0


# -- the price per credit --------------------------------------------------------------------------------------------


@pytest.mark.parametrize(('raw', 'price'), [(None, DEFAULT_KIRO_CREDIT_PRICE), ('', Decimal('0.04')),
                                            (' 0.05 ', Decimal('0.05')), ('0', Decimal(0)), ('10', Decimal(10)),
                                            ('0.000000000001', Decimal('1E-12'))])
def test_the_price_per_credit_is_the_deployments_else_kiros_add_on_price(raw: str | None, price: Decimal):
    assert kiro_credit_price(raw) == price


@pytest.mark.parametrize('raw', ['abc', '-0.01', '10.01', '0.0000000000001', 'NaN', 'Infinity', '1e3', '{"a": 1}'])
def test_a_price_per_credit_off_its_shape_is_refused(raw: str):
    with pytest.raises(RuntimeRefused, match=r'ENGINEERING_KIRO_CREDIT_PRICE is 0-10 USD per credit'):
        kiro_credit_price(raw)


def test_credits_cost_their_price_rounded_up_never_below_what_was_used():
    assert credit_usd(Decimal('0.04'), 208_012) == Decimal('0.00832048')
    assert credit_usd(Decimal('0.03'), 1) == Decimal('3E-8')
    assert credit_usd(Decimal(0), 5_000_000) == 0
    assert str(credit_usd(Decimal('0.04'), 0)) == '0'
    with pytest.raises(ValueError, match='never below zero'):
        credit_usd(Decimal('0.04'), -1)


# -- what the run page reads -----------------------------------------------------------------------------------------


def test_the_run_page_shows_a_kiro_sessions_credits_and_their_cost_at_the_deployments_price(monkeypatch):
    from engineering.monitor import _agent_view, _by_model
    monkeypatch.setenv('ENGINEERING_KIRO_CREDIT_PRICE', '0.05')
    kiro = replace(SESSION, tokens={'kiro:claude-haiku-5.5': {'in': 0, 'out': 0, MICRO_CREDITS: 2_500_000},
                                    'model-a': {'in': 10, 'out': 2}})
    other = replace(SESSION, agent_id='fixer-2', tokens={'kiro:claude-haiku-5.5': {'in': 0, 'out': 0,
                                                                                    MICRO_CREDITS: 500_000}})
    agents = [_agent_view(kiro), _agent_view(other)]
    assert agents[0]['tokens'] == [
        {'model': 'kiro:claude-haiku-5.5', 'input_tokens': 0, 'output_tokens': 0, 'credits': 2.5, 'credits_usd': 0.125},
        {'model': 'model-a', 'input_tokens': 10, 'output_tokens': 2}]   # (a native model's row as before)
    assert _by_model(agents)[0] == {'model': 'kiro:claude-haiku-5.5', 'input_tokens': 0, 'output_tokens': 0,
                                    'credits': 3.0, 'credits_usd': 0.15}
    monkeypatch.setenv('ENGINEERING_KIRO_CREDIT_PRICE', 'not a price')   # (the default, never a failed overview)
    assert _agent_view(kiro)['tokens'][0]['credits_usd'] == 0.1


def test_the_stack_and_the_runtime_agree_on_a_kiro_credits_default_price_and_its_bound():
    stack = (Path(__file__).resolve().parents[4] / 'lib' / 'stacks' / 'engineering-agentcore.ts').read_text()
    assert f"DEFAULT_KIRO_CREDIT_PRICE = '{DEFAULT_KIRO_CREDIT_PRICE}'" in stack
    assert f'MAX_USD_PER_CREDIT = {MAX_USD_PER_CREDIT}' in stack
