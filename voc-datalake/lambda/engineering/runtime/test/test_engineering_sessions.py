"""Session rows: the board's AGENT# rows, listed through the active runs, conditional moves, never another's attributes."""
import json
from dataclasses import replace
from datetime import UTC, datetime
from decimal import Decimal
from typing import Any

import pytest
from botocore.exceptions import ClientError

from engineering.runtime.caps import (
    BUILD_SIZES,
    DEFAULT_RATES,
    UNPRICED,
    SessionPricing,
    SessionRates,
    build_size,
    session_rates,
)
from engineering.runtime.interface import RuntimeRefused, RuntimeSession
from engineering.runtime.runs import RunCaps, RunNotActive, RunStore
from engineering.runtime.sessions import AgentSession, LostSession, SessionStore, StaleSession
from engineering.runtime.test.conftest import RUN

SESSION = AgentSession(run_id=RUN, agent_id='fixer-1', role='fixer', task_id='task-1', language='python',
                       egress=('pypi.org',), connection='repo-1', commit='a' * 40, paths=('src',),
                       harness=('python3', '-m', 'harness'), vm_id='vm-1', endpoint='https://vm-1.example.org',
                       started_at=1000)
KEY = {'pk': f'WS#default#RUN#{RUN}', 'sk': 'AGENT#fixer-1'}


def _per_second(usd: Decimal) -> SessionPricing:
    """Rates that make a running standard session (2 vCPU, 8 GB) cost ``usd`` a second: its vCPUs only."""
    return SessionPricing(rates=SessionRates(usd * 1800, Decimal(0), Decimal(0), Decimal(0)))


PER_SECOND = _per_second(Decimal('0.0001'))


def _store(table: Any) -> tuple[SessionStore, RunStore]:
    runs = RunStore(table)
    runs.start(RUN, caps=RunCaps(max_tasks=10), now=0)
    return SessionStore(table, runs), runs


def test_a_created_session_is_listed_until_its_ended_run_is_released(aws):
    store, runs = _store(aws[1])
    created = store.create(SESSION)
    assert store.get(RUN, 'fixer-1') == created
    assert list(store.active()) == [created]
    runs.end(RUN, 'done', now=10)
    # Still live: the supervisor must see it to end its session.
    assert list(store.active()) == [created]
    runs.release(RUN)
    assert list(store.active()) == []


def test_no_session_is_created_once_its_run_has_ended_nor_twice(aws):
    store, runs = _store(aws[1])
    store.create(SESSION)
    with pytest.raises(StaleSession, match='exists'):
        store.create(SESSION)
    runs.end(RUN, 'stopped', now=10)
    with pytest.raises(RunNotActive, match='no agent is launched'):
        store.create(replace(SESSION, agent_id='fixer-2'))
    assert [session.agent_id for session in store.of_run(RUN)] == ['fixer-1']


def test_an_ended_session_leaves_the_active_list(aws):
    store, _ = _store(aws[1])
    store.save(replace(store.create(SESSION), status='done'))
    assert list(store.active()) == []
    assert store.of_run(RUN)[0].status == 'done'


def test_the_row_is_the_boards_agent_row_with_the_totals_the_reports_read(aws):
    store, _ = _store(aws[1])
    created = store.create(SESSION, {'model': 'model-a', 'skill_version': 'fixer@3'})
    store.save(replace(created, tokens={'model-a': {'in': 10, 'out': 4}, 'model-b': {'in': 1, 'out': 2}},
                       microvm_seconds=60))
    row = aws[1].get_item(Key=KEY)['Item']
    assert (row['role'], row['model'], row['skill_version'], row['microvm_seconds']) == ('fixer', 'model-a',
                                                                                         'fixer@3', 60)
    assert (row['input_tokens'], row['output_tokens']) == (11, 6)


def test_the_store_never_writes_over_what_others_add_to_the_row(aws):
    store, _ = _store(aws[1])
    created = store.create(SESSION)
    # The brokers add the cost they priced to the same row.
    aws[1].update_item(Key=KEY, UpdateExpression='ADD cost_usd :cost', ExpressionAttributeValues={':cost': 2})
    store.save(replace(created, status='working', exec_id=None, asked_at=None))
    assert aws[1].get_item(Key=KEY)['Item']['cost_usd'] == 2


def test_microvm_seconds_are_priced_once_into_cost_usd_beside_the_brokers(aws):
    runs = RunStore(aws[1])
    runs.start(RUN, caps=RunCaps(max_tasks=10), now=0)
    store = SessionStore(aws[1], runs, PER_SECOND)
    created = store.create(SESSION)
    aws[1].update_item(Key=KEY, UpdateExpression='ADD cost_usd :cost', ExpressionAttributeValues={':cost': 2})
    moved = store.save(replace(created, microvm_seconds=600))
    # The same seconds again (a save that moved nothing else) are not priced twice.
    moved = store.save(moved)
    claimed = store.claim(replace(moved, microvm_seconds=900), 1000, 60)
    assert aws[1].get_item(Key=KEY)['Item']['cost_usd'] == Decimal('2.09')
    assert (claimed.priced_seconds, runs.spend(RUN)) == (900, (0, 2.09))
    # A write that loses its race prices nothing: the move it would have priced did not happen.
    with pytest.raises(StaleSession):
        store.save(replace(created, microvm_seconds=5000))
    assert aws[1].get_item(Key=KEY)['Item']['cost_usd'] == Decimal('2.09')


def _ledger(table: Any, prefix: str = 'DAY#') -> dict[str, dict[str, Any]]:
    """The month's ledger rows (``prefix``: ``FLOW#`` for the flows' month totals)."""
    rows = table.query(KeyConditionExpression='pk = :pk AND begins_with(sk, :prefix)',
                       ExpressionAttributeValues={':pk': 'WS#default#SPEND#2026-11', ':prefix': prefix})['Items']
    return {str(row['sk']): row for row in rows}


def test_each_metered_write_adds_its_seconds_cost_and_new_tokens_to_the_spend_ledger_in_the_same_write(aws):
    runs = RunStore(aws[1])
    runs.start(RUN, caps=RunCaps(max_tasks=10), now=0, flow='wf_hunt', repo='example/app')
    at = datetime(2026, 11, 13, 9, 0, tzinfo=UTC)
    store = SessionStore(aws[1], runs, PER_SECOND, clock=lambda: at)
    created = store.create(SESSION)
    moved = store.save(replace(created, microvm_seconds=600, tokens={'model-a': {'in': 10, 'out': 4}}))
    # The same again adds nothing; more of both adds only the difference.
    moved = store.save(moved)
    store.claim(replace(moved, microvm_seconds=900, tokens={'model-a': {'in': 15, 'out': 4}}), 1000, 60)
    prefix = f'DAY#13#WF#wf_hunt#RUN#{RUN}#AGENT#fixer-1#MODEL#'
    ledger = _ledger(aws[1])
    assert sorted(ledger) == [f'{prefix}microvm', f'{prefix}model-a']
    microvm, model = ledger[f'{prefix}microvm'], ledger[f'{prefix}model-a']
    assert (microvm['usd'], microvm['microvm_seconds'], microvm['repo']) == (Decimal('0.09'), 900, 'example/app')
    # Who, when and which version (D4): the session write whose ADD it was last (the claim: seq 4).
    assert (microvm['updated_by'], microvm['updated_at'], microvm['session_seq']) == (
        'runtime/sessions', at.isoformat(), 4)
    assert (model['tokens_in'], model['tokens_out'], model['usd']) == (15, 4, 0)
    # The flow's month total, in the same writes: the sum of its rows.
    (total,) = _ledger(aws[1], 'FLOW#').values()
    assert (total['sk'], total['usd']) == ('FLOW#wf_hunt', Decimal('0.09'))
    # A write that loses its race adds nothing: the ledger and the session never drift.
    with pytest.raises(StaleSession):
        store.save(replace(created, microvm_seconds=5000, tokens={'model-a': {'in': 99, 'out': 9}}))
    assert _ledger(aws[1]) == ledger
    assert _ledger(aws[1], 'FLOW#')['FLOW#wf_hunt']['usd'] == Decimal('0.09')


def _ledgering(aws: Any, price: Decimal = Decimal(0)) -> tuple[SessionStore, AgentSession]:
    runs = RunStore(aws[1])
    runs.start(RUN, caps=RunCaps(max_tasks=10), now=0, flow='wf_hunt', repo='example/app')
    store = SessionStore(aws[1], runs, _per_second(price), clock=lambda: datetime(2026, 11, 13, tzinfo=UTC))
    return store, store.create(SESSION)


def test_unpriced_microvm_time_is_still_ledgered_with_no_dollars(aws):
    store, created = _ledgering(aws)
    store.save(replace(created, microvm_seconds=600))
    (row,) = _ledger(aws[1]).values()
    assert (row['microvm_seconds'], row['usd'], 'cost_usd' in aws[1].get_item(Key=KEY)['Item']) == (600, 0, False)


def test_a_harness_model_named_microvm_is_its_own_row_never_the_microvm_time(aws):
    store, created = _ledgering(aws, Decimal('0.0001'))
    store.save(replace(created, microvm_seconds=100, tokens={'microvm': {'in': 1000, 'out': 0}}))
    rows = {str(row['model']): row for row in _ledger(aws[1]).values()}
    assert (rows['microvm']['microvm_seconds'], rows['microvm']['usd'], rows['microvm']['tokens_in']) == (
        100, Decimal('0.01'), 0)
    assert rows['microvm-reported']['tokens_in'] == 1000


def test_a_session_ledgers_its_first_models_by_name_and_the_rest_on_one_row(aws):
    # (each continuation's report may add names, from inside the session: no session opens rows without end)
    store, created = _ledgering(aws)
    tokens = {f'model-{number:03}': {'in': 1, 'out': 0} for number in range(150)}
    moved = store.save(replace(created, microvm_seconds=10, tokens=tokens))
    store.save(replace(moved, tokens={**tokens, 'model-new': {'in': 4, 'out': 0}}))
    rows = {str(row['model']): int(row['tokens_in']) for row in _ledger(aws[1]).values()}
    assert sorted(rows) == ['-', 'microvm', *[f'model-{number:03}' for number in range(8)]]
    assert (rows['-'], sum(rows.values())) == (142 + 4, 154)


def test_a_continuation_never_counts_tokens_twice_and_a_row_from_before_books_none_of_its_past(aws):
    store, _ = _ledgering(aws)
    # A row written before the ledger: its tokens as read are counted already, never booked again.
    aws[1].update_item(Key=KEY, UpdateExpression='SET tokens = :t',
                       ExpressionAttributeValues={':t': {'model-a': {'in': 50, 'out': 5}}})
    read = store.get(RUN, 'fixer-1')
    assert read is not None
    moved = store.save(replace(read, tokens={'model-a': {'in': 60, 'out': 5}}))
    # A continuation: its session reports from zero, the session's totals carry on.
    continued = replace(moved, tokens_before=moved.tokens, tokens=moved.tokens)
    store.save(replace(continued, tokens=continued.reported({'model-a': {'in': 5, 'out': 0}})))
    (row,) = _ledger(aws[1]).values()
    assert (row['tokens_in'], row['tokens_out']) == (15, 0)


def test_a_run_started_without_a_workflow_books_under_none_and_a_missing_meta_is_read_again(
        aws, monkeypatch: pytest.MonkeyPatch):
    runs = RunStore(aws[1])
    runs.start(RUN, caps=RunCaps(max_tasks=10), now=0)   # (no flow, no repo)
    store = SessionStore(aws[1], runs, clock=lambda: datetime(2026, 11, 13, tzinfo=UTC))
    moved = store.save(replace(store.create(SESSION), microvm_seconds=60))
    (sk,) = _ledger(aws[1])
    assert sk.startswith(f'DAY#13#WF#-#RUN#{RUN}#')
    # A run whose META cannot be read is not remembered as without one: each write reads it again.
    reads: list[str] = []

    def unread(run_id: str) -> None:
        reads.append(run_id)

    monkeypatch.setattr(runs, 'get', unread)
    other = SessionStore(aws[1], runs, clock=lambda: datetime(2026, 11, 13, tzinfo=UTC))
    for seconds in (120, 180):
        moved = other.save(replace(moved, microvm_seconds=seconds))
    assert reads == [RUN, RUN]


def test_a_conflicted_transaction_is_tried_again_after_a_pause_then_is_a_stale_session(
        aws, monkeypatch: pytest.MonkeyPatch):
    from botocore.exceptions import ClientError

    store, created = _ledgering(aws)
    pauses: list[float] = []
    store._pause = pauses.append
    conflict = ClientError({'Error': {'Code': 'TransactionCanceledException', 'Message': 'x'},
                            'CancellationReasons': [{'Code': 'None'}, {'Code': 'TransactionConflict'}]},
                           'TransactWriteItems')
    real = aws[1].meta.client.transact_write_items
    tries: list[int] = []

    def conflicted(times: int):
        def write(**request: Any) -> Any:
            tries.append(1)
            if len(tries) <= times:
                raise conflict
            return real(**request)
        return write

    # Three times (another agent's write of the flow's month total, say): the fourth try lands.
    monkeypatch.setattr(aws[1].meta.client, 'transact_write_items', conflicted(3))
    moved = store.save(replace(created, microvm_seconds=60))
    assert (len(tries), _ledger(aws[1])[f'DAY#13#WF#wf_hunt#RUN#{RUN}#AGENT#fixer-1#MODEL#microvm']['microvm_seconds']) == (
        4, 60)
    # Each pause is short and grows: about 20, 40, 60 ms, jittered.
    assert len(pauses) == 3
    assert all(0.02 * n <= pause < 0.04 * n for n, pause in enumerate(pauses, start=1))
    # Four times: the move did not happen; the next tick reads the row again.
    tries.clear()
    monkeypatch.setattr(aws[1].meta.client, 'transact_write_items', conflicted(4))
    with pytest.raises(StaleSession):
        store.save(replace(moved, microvm_seconds=120))
    assert len(tries) == 4
    # A conflict beside a failed condition: one try (it can never land).
    tries.clear()
    both = ClientError({'Error': {'Code': 'TransactionCanceledException', 'Message': 'x'},
                        'CancellationReasons': [{'Code': 'ConditionalCheckFailed'}, {'Code': 'TransactionConflict'}]},
                       'TransactWriteItems')

    def refused(**_request: Any) -> Any:
        tries.append(1)
        raise both

    monkeypatch.setattr(aws[1].meta.client, 'transact_write_items', refused)
    with pytest.raises(StaleSession):
        store.save(replace(moved, microvm_seconds=120))
    assert len(tries) == 1


def _cancelled(*codes: str) -> Any:
    from botocore.exceptions import ClientError

    return ClientError({'Error': {'Code': 'TransactionCanceledException', 'Message': 'x'},
                        'CancellationReasons': [{'Code': code} for code in codes]}, 'TransactWriteItems')


def _under_way() -> Any:
    from botocore.exceptions import ClientError

    return ClientError({'Error': {'Code': 'TransactionInProgressException', 'Message': 'x'}}, 'TransactWriteItems')


def test_a_priced_write_keeps_one_request_token_through_its_tries_and_a_try_under_way_is_waited_for(
        aws, monkeypatch: pytest.MonkeyPatch):
    store, created = _ledgering(aws)
    store._pause = lambda _seconds: None
    real = aws[1].meta.client.transact_write_items
    tokens: list[str] = []
    answers = [_cancelled('None', 'TransactionConflict'), _under_way()]

    def write(**request: Any) -> Any:
        tokens.append(request['ClientRequestToken'])
        if answers:
            raise answers.pop(0)
        return real(**request)

    monkeypatch.setattr(aws[1].meta.client, 'transact_write_items', write)
    moved = store.save(replace(created, microvm_seconds=60))
    # A conflict (that try did not land: a new token), then that token's earlier try still under way (the same
    # token, answered as it ended): the third try lands.
    assert (len(tokens), tokens[0] != tokens[1], tokens[1] == tokens[2]) == (3, True, True)
    # The next write is a request of its own.
    store.save(replace(moved, microvm_seconds=120))
    assert (len(tokens), tokens[3] not in tokens[:3]) == (4, True)
    # A try still under way past the last: a StaleSession (the next tick's read says whether it landed).
    tokens.clear()
    answers.extend([_under_way() for _ in range(4)])
    with pytest.raises(StaleSession):
        store.save(replace(moved, microvm_seconds=180))
    assert len(tokens) == 4


def test_a_ledger_row_the_table_refuses_stops_the_sessions_move(aws):
    from botocore.exceptions import ClientError

    store, created = _ledgering(aws)
    sk = f'DAY#13#WF#wf_hunt#RUN#{RUN}#AGENT#fixer-1#MODEL#microvm'
    # A ledger row whose seconds are not a number: the ADD to it is refused, and with it the whole write.
    aws[1].put_item(Item={'pk': 'WS#default#SPEND#2026-11', 'sk': sk, 'microvm_seconds': 'many'})
    before = aws[1].get_item(Key=KEY)['Item']
    # (not a StaleSession: no condition failed, the write itself is refused, and says why; DynamoDB cancels the
    # transaction with a ValidationError reason, the local stand-in answers ValidationException)
    with pytest.raises(ClientError, match='TransactWriteItems'):
        store.save(replace(created, microvm_seconds=60))
    after = aws[1].get_item(Key=KEY)['Item']
    assert (after['seq'], after['microvm_seconds'], after.get('priced_seconds', 0)) == (
        before['seq'], before['microvm_seconds'], before.get('priced_seconds', 0))
    assert _ledger(aws[1])[sk]['microvm_seconds'] == 'many'


def test_a_refusal_as_dynamodb_answers_it_is_tried_once_and_is_never_a_stale_session(
        aws, monkeypatch: pytest.MonkeyPatch):
    from botocore.exceptions import ClientError

    store, created = _ledgering(aws)
    tries: list[int] = []

    def refused(**_request: Any) -> Any:
        tries.append(1)
        raise _cancelled('None', 'ValidationError')

    monkeypatch.setattr(aws[1].meta.client, 'transact_write_items', refused)
    with pytest.raises(ClientError) as raised:
        store.save(replace(created, microvm_seconds=60))
    assert (raised.type, len(tries)) == (ClientError, 1)


def test_without_a_price_microvm_time_adds_nothing_and_a_later_price_applies_from_then_on(aws):
    runs = RunStore(aws[1])
    runs.start(RUN, caps=RunCaps(max_tasks=10), now=0)
    moved = SessionStore(aws[1], runs).save(replace(SessionStore(aws[1], runs).create(SESSION), microvm_seconds=600))
    row = aws[1].get_item(Key=KEY)['Item']
    assert ('cost_usd' in row, row['priced_seconds']) == (False, 600)
    # A price set later prices the time after it only, never the 600 seconds used before.
    SessionStore(aws[1], runs, PER_SECOND).save(replace(moved, microvm_seconds=700))
    assert aws[1].get_item(Key=KEY)['Item']['cost_usd'] == Decimal('0.01')


def test_the_deployments_rates_default_to_agentcores_published_ones_and_a_zero_rate_prices_nothing():
    assert session_rates(None) == session_rates('') == SessionRates() == session_rates(json.dumps(DEFAULT_RATES))
    assert (SessionRates().vcpu_hour, SessionRates().gb_hour) == (Decimal('0.1276'), Decimal('0.0169'))
    unpriced = session_rates(json.dumps(dict.fromkeys(DEFAULT_RATES, '0')))
    assert unpriced == UNPRICED
    assert SessionPricing(rates=unpriced).cost('fixer', running=600, held=60).usd == 0


@pytest.mark.parametrize('raw', ['free', '[]', json.dumps({'vcpuHour': '0.1'}),
                                 json.dumps({**DEFAULT_RATES, 'diskHour': '1'}),
                                 json.dumps({**DEFAULT_RATES, 'vcpuHour': '-0.1'}),
                                 json.dumps({**DEFAULT_RATES, 'gbHour': 'NaN'}),
                                 json.dumps({**DEFAULT_RATES, 'gbHour': '11'}),
                                 json.dumps({**DEFAULT_RATES, 'gbHour': True}),
                                 json.dumps({**DEFAULT_RATES, 'gbHour': '0.0000000000001'})],
                         ids=['not-json', 'not-object', 'missing', 'unknown', 'negative', 'nan', 'too-high', 'bool',
                              'too-many-digits'])
def test_rates_that_are_not_four_amounts_are_refused(raw: str):
    with pytest.raises(RuntimeRefused, match='ENGINEERING_SESSION_RATES'):
        session_rates(raw)


def test_a_session_counts_every_vcpu_while_it_runs_and_only_its_memory_while_it_is_held():
    pricing = SessionPricing()
    running = pricing.cost('fixer', running=3600, held=0)
    held = pricing.cost('fixer', running=0, held=3600)
    # 2 vCPU and 8 GB at the consumption rates; held, its memory only (a held agent uses no CPU).
    assert (running.usd, running.vcpu_seconds, running.gb_seconds) == (
        Decimal('0.2552') + Decimal('0.1352'), 7200, 28800)
    assert (held.usd, held.vcpu_seconds, held.gb_seconds) == (Decimal('0.1352'), 0, 28800)


def test_the_roles_that_build_and_test_count_their_baseline_at_the_committed_rates_and_their_burst_at_consumption():
    pricing = SessionPricing(build_roles=frozenset({'gate-runner'}), build_size=build_size('8192'))
    hour = pricing.cost('gate-runner', running=3600, held=0)
    # 2 vCPU and 8 GB committed, bursting to 8 vCPU and 32 GB.
    assert (hour.vcpu_seconds, hour.gb_seconds) == (8 * 3600, 32 * 3600)
    assert hour.usd == Decimal('0.1994') + Decimal('0.1056') + 6 * Decimal('0.1276') + 24 * Decimal('0.0169')
    # Held: the committed baseline (CPU and memory) and the memory it may burst to.
    assert pricing.cost('gate-runner', running=0, held=3600).usd == (
        Decimal('0.1994') + Decimal('0.1056') + 24 * Decimal('0.0169'))
    assert pricing.size('fixer') == SessionPricing().size('fixer')
    assert SessionPricing(build_roles=frozenset({'gate-runner'})).size('gate-runner') == pricing.size('fixer')


@pytest.mark.parametrize(('raw', 'size'), [(None, None), ('0', None), ('8192', BUILD_SIZES[8192])])
def test_the_build_size_is_none_or_the_8192_resource_configuration(raw: str | None, size: object):
    assert build_size(raw) == size


@pytest.mark.parametrize('raw', ['4096', '16384', 'big', '-1'])
def test_a_build_size_below_the_floor_or_unknown_is_refused(raw: str):
    with pytest.raises(RuntimeRefused, match='ENGINEERING_BUILD_MEMORY_MIB'):
        build_size(raw)


def test_held_seconds_are_priced_once_and_their_vcpu_and_gb_seconds_recorded(aws):
    runs = RunStore(aws[1])
    runs.start(RUN, caps=RunCaps(max_tasks=10), now=0)
    store = SessionStore(aws[1], runs, SessionPricing())
    created = store.create(SESSION)
    moved = store.save(replace(created, microvm_seconds=3600, held_seconds=3600))
    moved = store.save(moved)
    row = aws[1].get_item(Key=KEY)['Item']
    assert row['cost_usd'] == Decimal('0.2552') + 2 * Decimal('0.1352')
    assert (row['vcpu_seconds'], row['gb_seconds'], row['priced_held_seconds']) == (7200, 57600, 3600)
    assert (moved.vcpu_seconds, moved.gb_seconds) == (7200, 57600)


def test_an_attribute_the_session_no_longer_has_is_removed(aws):
    store, _ = _store(aws[1])
    moved = store.save(replace(store.create(SESSION), exec_id='e1', asked_at=5))
    store.save(replace(moved, exec_id=None, asked_at=None))
    row = aws[1].get_item(Key=KEY)['Item']
    assert 'exec_id' not in row
    assert 'asked_at' not in row


def test_a_row_metered_before_the_session_was_written_is_no_session_until_it_is(aws):
    store, _ = _store(aws[1])
    aws[1].put_item(Item={**KEY, 'cost_usd': 1})
    assert (store.get(RUN, 'fixer-1'), store.of_run(RUN)) == (None, [])
    created = store.create(SESSION)
    assert store.get(RUN, 'fixer-1') == created
    assert aws[1].get_item(Key=KEY)['Item']['cost_usd'] == 1


def test_a_second_session_for_the_same_agent_is_refused(aws):
    store, _ = _store(aws[1])
    store.create(SESSION)
    with pytest.raises(StaleSession):
        store.create(SESSION)


def test_a_write_from_a_stale_read_is_refused(aws):
    store, _ = _store(aws[1])
    read = store.create(SESSION)
    store.save(replace(read, asked_at=1100))
    with pytest.raises(StaleSession):
        store.save(replace(read, status='done'))
    found = store.get(RUN, 'fixer-1')
    assert found is not None
    assert (found.asked_at, found.status, found.seq) == (1100, 'booting', 2)


def test_a_continuation_boots_again_in_the_new_microvm_from_its_checkpoint():
    later = replace(SESSION, status='working', boot_index=3, exec_id='e', asked_at=5, pause_requested_at=6)
    continued = later.on(RuntimeSession('vm-2', 'fixer-1', 'https://vm-2.example.org'), 2000, 'ckpt-key')
    assert (continued.vm_id, continued.started_at, continued.status, continued.continuation) == ('vm-2', 2000,
                                                                                                'booting', 1)
    assert (continued.boot_index, continued.exec_id, continued.asked_at, continued.restore_key) == (0, None, None,
                                                                                                    'ckpt-key')
    assert continued.spec('ckpt-key').restore_key == 'ckpt-key'


def _lost_store(aws: Any) -> tuple[SessionStore, RunStore]:
    runs = RunStore(aws[1])
    runs.start(RUN, caps=RunCaps(max_tasks=10), now=0, flow='wf_hunt', repo='example/app')
    return SessionStore(aws[1], runs, PER_SECOND, clock=lambda: datetime(2026, 11, 13, tzinfo=UTC)), runs


LOST_VM = RuntimeSession(vm_id='voc-lost-1', agent_id='fixer-1', endpoint='arn:aws:bedrock-agentcore:runtime/x')


def _lost_counted_once(aws: Any) -> tuple[SessionStore, RunStore, LostSession]:
    """fixer-1's session, a lost session of it recorded at 1000, and its first 600 seconds counted."""
    store, runs = _lost_store(aws)
    store.create(SESSION)
    store.record_lost(RUN, 'fixer-1', 'fixer', LOST_VM, 1000)
    (lost,) = store.lost(RUN)
    store.lost_tick(lost, 1600, stopped=False)
    return store, runs, lost


def test_a_lost_sessions_cost_goes_to_its_agent_the_spend_ledger_and_its_flows_month_in_one_write(aws):
    _, runs, _ = _lost_counted_once(aws)
    prefix = f'DAY#13#WF#wf_hunt#RUN#{RUN}#AGENT#fixer-1#MODEL#'
    ledger = _ledger(aws[1])
    # 600 seconds at 0.0001 a second: on the run's cost (its agent's row), the ledger's row and the flow's month.
    assert (runs.spend(RUN)[1], ledger[f'{prefix}microvm']['usd'], ledger[f'{prefix}microvm']['microvm_seconds']) == (
        0.06, Decimal('0.06'), 600)
    assert _ledger(aws[1], 'FLOW#')['FLOW#wf_hunt']['usd'] == Decimal('0.06')


def test_a_lost_tick_that_loses_its_race_counts_nothing_anywhere(aws):
    store, runs, lost = _lost_counted_once(aws)
    # The same stretch again (another tick read the row before the first wrote): refused whole, nothing added twice.
    with pytest.raises(ClientError):
        store.lost_tick(lost, 1600, stopped=False)
    assert (runs.spend(RUN)[1], _ledger(aws[1], 'FLOW#')['FLOW#wf_hunt']['usd']) == (0.06, Decimal('0.06'))


def test_a_lost_session_of_an_agent_with_no_row_makes_no_cost_only_agent_row(aws):
    store, _ = _lost_store(aws)
    store.record_lost(RUN, 'fixer-9', 'fixer', LOST_VM, 1000)
    (lost,) = store.lost(RUN)
    store.lost_tick(lost, 1600, stopped=True)
    # No AGENT# row a reader would take for an agent without a role; the cost is on its own row and the ledger.
    assert aws[1].get_item(Key={'pk': f'WS#default#RUN#{RUN}', 'sk': 'AGENT#fixer-9'}).get('Item') is None
    row = aws[1].get_item(Key={'pk': f'WS#default#RUN#{RUN}', 'sk': 'LOST#voc-lost-1'})['Item']
    assert (row['cost_usd'], 'stopped_at' in row, store.lost(RUN)) == (Decimal('0.06'), True, [])
