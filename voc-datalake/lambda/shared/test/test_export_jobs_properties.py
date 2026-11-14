"""Properties of a workspace export job's row (shared/export_jobs.py), against a moto table.

An export runs as a chain of invocations, each claiming the next generation of its job row; a duplicate, stale or
late delivery that still wrote would run an export twice or revive one an erasure marked erased, and an erased export
whose row reads completed would hand out a link to data that was deleted. So random deliveries of claims, progress,
endings and erasures, at increasing times, are checked against a plain model of the documented rules after every
step; and what a reader sees of a row (``job_view``) is checked against the rules for every row shape.

One moto table serves each test: every generated run gets a workspace of its own and its rows are removed after it.
"""
from __future__ import annotations

from collections.abc import Iterator
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from itertools import count
from typing import Any
from unittest.mock import MagicMock

import pytest
from hypothesis import example, given
from hypothesis import strategies as st

from shared.export_jobs import (
    ERASED_DURING_EXPORT,
    EXPORT_COMPLETED,
    EXPORT_ERASED,
    EXPORT_EXPIRED,
    EXPORT_FAILED,
    EXPORT_QUEUED,
    EXPORT_RUNNING,
    NOT_STARTED_ERROR,
    STALLED_ERROR,
    awaits_generation,
    claim_generation,
    fail_awaited,
    finish_job,
    hold_for_erasure,
    job_key,
    job_view,
    latest_job,
    mark_erased,
    record_progress,
)
from shared.source_erasure import STALE_AFTER
from shared.test.ws_properties import CROCKFORD, PROPERTY, EmptiedAfter, exactly, moto_pk_sk_table, workspace_ids
from shared.ws_repo import WorkspaceScope, ws_table

#: Each generated run's own workspace number (the module's one moto table serves every run).
_RUNS = count()


@pytest.fixture(scope='module')
def table() -> Iterator:
    yield from moto_pk_sk_table('aggregates')


START = datetime(2026, 11, 14, 8, 0, tzinfo=UTC)
EXPORT = 'ex_01JC3Q8ZK6V7W9X2Y4A5B6C7D8'
#: One delivery: (what, the generation it names, minutes since the one before). Gaps reach past STALE_AFTER.
STEPS = st.lists(st.tuples(st.sampled_from(['claim', 'progress', 'finish', 'fail', 'erase']),
                           st.integers(min_value=0, max_value=3), st.sampled_from([0, 1, 30, 59, 60, 61, 120])),
                 min_size=1, max_size=10)


def _fresh(stamp: str | None, now: datetime) -> bool:
    return stamp is not None and stamp > (now - STALE_AFTER).isoformat()


Row = dict[str, Any]


def _claim(row: Row, generation: int, at: str, now: datetime) -> tuple[Row, object]:
    status, held = row['status'], row.get('generation')
    claims = (status == EXPORT_QUEUED and held is None and _fresh(row['created_at'], now)) if generation == 0 \
        else (status == EXPORT_RUNNING and held == generation - 1 and _fresh(row.get('progress_at'), now))
    if not claims:
        return row, None
    claimed = {**row, 'status': EXPORT_RUNNING, 'generation': generation, 'progress_at': at,
               'started_at': row.get('started_at', at)}
    return claimed, claimed


def _progress(row: Row, generation: int, at: str, _now: datetime) -> tuple[Row, object]:
    if row['status'] == EXPORT_RUNNING and row.get('generation') == generation:
        return {**row, 'phase': f'phase {generation}', 'progress_at': at}, True
    return row, False


def _finish(row: Row, _generation: int, at: str, _now: datetime) -> tuple[Row, object]:
    if row['status'] in (EXPORT_QUEUED, EXPORT_RUNNING):
        return {**row, 'status': EXPORT_COMPLETED, 'completed_at': at}, True
    return row, False


def _fail(row: Row, generation: int, _at: str, _now: datetime) -> tuple[Row, object]:
    status, held = row['status'], row.get('generation')
    waits = (status == EXPORT_QUEUED and held is None) if generation == 0 \
        else (status == EXPORT_RUNNING and held == generation - 1)
    return ({**row, 'status': EXPORT_FAILED, 'error': 'stopped'}, True) if waits else (row, False)


def _erase(row: Row, _generation: int, at: str, _now: datetime) -> tuple[Row, object]:
    status = row['status']
    if status not in (EXPORT_QUEUED, EXPORT_RUNNING, EXPORT_COMPLETED):
        return row, None
    erased = {**row, 'status': EXPORT_ERASED, 'erased_at': at}
    return ({**erased, 'error': ERASED_DURING_EXPORT} if status != EXPORT_COMPLETED else erased), None


#: The documented outcome of each delivery: the row after it, and what the call answers.
MODEL = {'claim': _claim, 'progress': _progress, 'finish': _finish, 'fail': _fail, 'erase': _erase}


def _model_step(row: Row, what: str, generation: int, now: datetime) -> tuple[Row, object]:
    return MODEL[what](row, generation, now.isoformat(), now)


def _deliver(view, what: str, generation: int, now: datetime) -> object:
    at = now.isoformat()
    if what == 'claim':
        return claim_generation(view, EXPORT, generation, now)
    if what == 'progress':
        return record_progress(view, EXPORT, generation, {'phase': f'phase {generation}', 'progress_at': at})
    if what == 'finish':
        return finish_job(view, EXPORT, EXPORT_COMPLETED, {'completed_at': at})
    if what == 'fail':
        return fail_awaited(view, EXPORT, generation, {'error': 'stopped'})
    mark_erased(view, now)
    return None


# Whatever deliveries arrive, duplicated, late or out of order, the job row is the model's: a generation is claimed
# once, only from the state just before it and only while that state is fresh; progress is written only by the
# generation that holds the job; an ending lands only on an unfinished job; a failure only while the job still waits
# for that generation; an erasure marks every export whose objects may exist, and nothing revives an erased one.
@PROPERTY
@given(STEPS)
def test_a_job_row_follows_its_generations_only(table, steps):
    scope = WorkspaceScope(f'ws_0{next(_RUNS):025d}')
    with EmptiedAfter(table):
        view = ws_table(scope, table)
        key = {'pk': f'WS#{scope.ws}#JOB#export', 'sk': EXPORT}
        model: dict[str, Any] = {'export_id': EXPORT, 'status': EXPORT_QUEUED, 'created_at': START.isoformat()}
        table.put_item(Item={**key, **model})
        now = START
        for what, generation, minutes in steps:
            now += timedelta(minutes=minutes)
            awaited = awaits_generation(model, generation)
            model, expected = _model_step(model, what, generation, now)
            answer = _deliver(view, what, generation, now)
            stored = table.get_item(Key=key, ConsistentRead=True)['Item']
            assert stored == {**key, **model}
            assert answer == ({**key, **expected} if isinstance(expected, dict) else expected)
            if what == 'fail':
                assert answer is awaited


def _sent(backing: MagicMock) -> list[dict[str, Any]]:
    return [call.kwargs for call in backing.update_item.call_args_list]


# Each step sends exactly the documented conditional UpdateItem of the job's own row: a claim names the state just
# before it and its freshness, a progress write the generation that holds the job, an ending the unfinished states, a
# failure the generation awaited; a claim answers the row as it now is, or None when DynamoDB answers no row.
@PROPERTY
@given(workspace_ids(), st.integers(min_value=0, max_value=5), st.integers(min_value=0, max_value=10_000),
       st.sampled_from([EXPORT_COMPLETED, EXPORT_FAILED, 'cancelled']), st.booleans())
def test_each_step_sends_its_documented_condition(ws, generation, minutes, ending, answered):
    now = START + timedelta(minutes=minutes)
    at, fresh = now.isoformat(), (now - STALE_AFTER).isoformat()
    backing = MagicMock()
    backing.update_item.return_value = {'Attributes': {'status': EXPORT_RUNNING}} if answered else {}
    view = ws_table(WorkspaceScope(ws), backing)
    key = {'pk': f'WS#{ws}#JOB#export', 'sk': EXPORT}
    names = {'#status': 'status', '#generation': 'generation'}
    claimed = claim_generation(view, EXPORT, generation, now)
    assert claimed == ({'status': EXPORT_RUNNING} if answered else None)
    assert record_progress(view, EXPORT, generation, {'phase': 'zip'}) is True
    assert finish_job(view, EXPORT, ending, {'size_bytes': 7}) is True
    assert fail_awaited(view, EXPORT, generation, {'error': 'stopped'}) is True
    claim_condition = ('attribute_exists(pk) AND #status = :queued AND attribute_not_exists(#generation) '
                       'AND created_at > :fresh') if generation == 0 else \
        'attribute_exists(pk) AND #status = :running AND #generation = :previous AND progress_at > :fresh'
    fail_condition = 'attribute_exists(pk) AND #status = :queued AND attribute_not_exists(#generation)' \
        if generation == 0 else 'attribute_exists(pk) AND #status = :running AND #generation = :awaited'
    assert _sent(backing) == [
        {'Key': key, 'UpdateExpression': 'SET #status = :running, #generation = :generation, progress_at = :now, '
                                         'started_at = if_not_exists(started_at, :now)',
         'ConditionExpression': claim_condition, 'ExpressionAttributeNames': names,
         'ExpressionAttributeValues': {**({':queued': EXPORT_QUEUED} if generation == 0 else
                                          {':previous': generation - 1}),
                                       ':running': EXPORT_RUNNING, ':generation': generation, ':now': at,
                                       ':fresh': fresh},
         'ReturnValues': 'ALL_NEW'},
        {'Key': key, 'UpdateExpression': 'SET #f0 = :f0', 'ConditionExpression':
            '#status = :running AND #generation = :generation',
         'ExpressionAttributeNames': {'#f0': 'phase', **names},
         'ExpressionAttributeValues': {':f0': 'zip', ':running': EXPORT_RUNNING, ':generation': generation}},
        {'Key': key, 'UpdateExpression': 'SET #f0 = :f0, #f1 = :f1',
         'ConditionExpression': 'attribute_exists(pk) AND #status IN (:queued, :running)',
         'ExpressionAttributeNames': {'#f0': 'status', '#f1': 'size_bytes', '#status': 'status'},
         'ExpressionAttributeValues': {':f0': ending, ':f1': 7, ':queued': EXPORT_QUEUED, ':running': EXPORT_RUNNING}},
        {'Key': key, 'UpdateExpression': 'SET #f0 = :f0, #f1 = :f1', 'ConditionExpression': fail_condition,
         'ExpressionAttributeNames': {'#f0': 'status', '#f1': 'error', **names},
         'ExpressionAttributeValues': {':f0': EXPORT_FAILED, ':f1': 'stopped',
                                       **({':queued': EXPORT_QUEUED} if generation == 0 else
                                          {':running': EXPORT_RUNNING, ':awaited': generation - 1})}},
    ]


# An erasure takes the workspace's export lock whoever holds it (and renews it), then marks erased every export
# whose objects may exist, by its own export id only: a row with another status, or an id that is not an export id,
# is left alone. The newest export is one strongly consistent read of one row.
@PROPERTY
@given(workspace_ids(), st.lists(st.tuples(st.sampled_from([EXPORT_QUEUED, EXPORT_RUNNING, EXPORT_COMPLETED,
                                                            EXPORT_FAILED, EXPORT_ERASED, None]), st.booleans()),
                                 max_size=5))
def test_an_erasure_marks_its_exports_by_their_own_ids(ws, rows):
    now = START
    backing = MagicMock()
    stored = [{'export_id': f'ex_0{n:025d}' if well_formed else f'bad{n}', 'status': status}
              for n, (status, well_formed) in enumerate(rows)]
    backing.query.side_effect = [{'Items': stored}, {'Items': stored[-1:]}]
    view = ws_table(WorkspaceScope(ws), backing)
    hold_for_erasure(view, 'erasure-run1', now)
    mark_erased(view, now)
    erased = [row for row in stored if row['status'] in (EXPORT_QUEUED, EXPORT_RUNNING, EXPORT_COMPLETED)
              and row['export_id'].startswith('ex_')]
    lock = {'Key': {'pk': f'WS#{ws}#JOB#export', 'sk': 'LOCK'},
            'UpdateExpression': 'SET job_id = :holder, locked_at = :now REMOVE released_at',
            'ExpressionAttributeValues': {':holder': 'erasure-run1', ':now': now.isoformat()}}
    marks = [{'Key': {'pk': f'WS#{ws}#JOB#export', 'sk': row['export_id']},
              'UpdateExpression': 'SET #f0 = :f0, #f1 = :f1' + (', #f2 = :f2' if row['status'] != EXPORT_COMPLETED
                                                               else ''),
              'ConditionExpression': '#status IN (:queued, :running, :completed)',
              'ExpressionAttributeNames': {'#f0': 'status', '#f1': 'erased_at',
                                           **({'#f2': 'error'} if row['status'] != EXPORT_COMPLETED else {}),
                                           '#status': 'status'},
              'ExpressionAttributeValues': {':f0': EXPORT_ERASED, ':f1': now.isoformat(),
                                            **({':f2': ERASED_DURING_EXPORT} if row['status'] != EXPORT_COMPLETED
                                               else {}),
                                            ':queued': EXPORT_QUEUED, ':running': EXPORT_RUNNING,
                                            ':completed': EXPORT_COMPLETED}} for row in erased]
    assert _sent(backing) == [lock, *marks]
    newest = latest_job(view)
    assert newest == (dict(stored[-1]) if stored else None)
    assert backing.query.call_args.kwargs == {
        'KeyConditionExpression': '#p = :p AND begins_with(#sk, :ex)',
        'ExpressionAttributeNames': {'#sk': 'sk', '#p': 'pk'},
        'ExpressionAttributeValues': {':ex': 'ex_', ':p': f'WS#{ws}#JOB#export'},
        'ScanIndexForward': False, 'Limit': 1, 'ConsistentRead': True}


# A job key is built from an export id only (``ex_`` + a ULID): a near miss of one (a character outside the
# alphabet, one more or less, a first character past 7, another prefix, text around it) builds no key.
@PROPERTY
@given(workspace_ids(), st.integers(min_value=0, max_value=28), st.sampled_from('ILOUilou_-#/ .\n'),
       st.sampled_from('89' + CROCKFORD[10:]), st.text(max_size=10))
def test_a_job_key_needs_an_export_id(ws, position, char, high, other):
    scope = WorkspaceScope(ws)
    assert job_key(scope, EXPORT) == {'pk': f'WS#{ws}#JOB#export', 'sk': EXPORT}
    changed = char if char != EXPORT[position] else 'I'  # a change, never the character already there
    near_misses = [EXPORT[:position] + changed + EXPORT[position + 1:], EXPORT[:position] + EXPORT[position + 1:],
                   EXPORT + EXPORT[-1], f'ex_{high}{EXPORT[4:]}', f'er_{EXPORT[3:]}', f'{EXPORT}{char}',
                   f'{char}{EXPORT}', other]
    for value in near_misses:
        with pytest.raises(ValueError, match=exactly('not an export id')):
            job_key(scope, value)


# A reader sees the job, never its keys, upload or starter: a completed export past its download window (or with no
# window) reads expired; an unfinished one that has not moved for STALE_AFTER reads failed, saying whether it ever
# started; every other row reads as it is stored.
@PROPERTY
@given(st.sampled_from([EXPORT_QUEUED, EXPORT_RUNNING, EXPORT_COMPLETED, EXPORT_FAILED, EXPORT_ERASED]),
       st.integers(min_value=0, max_value=200), st.one_of(st.none(), st.integers(min_value=-100, max_value=100)),
       st.one_of(st.none(), st.integers(min_value=0, max_value=3)), st.booleans())
# Boundaries: exactly STALE_AFTER without moving is not yet stalled (created, then last moved, 60 minutes ago).
@example(EXPORT_QUEUED, 60, None, None, False)
@example(EXPORT_RUNNING, 120, None, 1, True)
def test_a_reader_sees_the_job_as_the_rules_say(status, age, expires_in, generation, moved):
    now = START + timedelta(days=30)
    created = now - timedelta(minutes=age)
    shown_fields = {'phase': 'zip', 'counts': {'feedback': Decimal(3)}, 'size_bytes': Decimal(7),
                    'started_at': created.isoformat()}
    row: dict[str, Any] = {'pk': 'WS#x#JOB#export', 'sk': EXPORT, 'export_id': EXPORT, 'status': status,
                           'created_at': created.isoformat(), 'started_by_sub': 'sub-ana', 'upload_id': 'u1',
                           'workspace_id': 'ws_x', 'completed_at': None, **shown_fields}
    if generation is not None:
        row['generation'] = generation
    if moved:
        row['progress_at'] = (now - timedelta(minutes=age // 2)).isoformat()
    if expires_in is not None:
        row['expires_at'] = (now + timedelta(minutes=expires_in)).isoformat()
    shown = job_view(row, now)
    last_moved = now - timedelta(minutes=age // 2) if moved else created
    stalled = status in (EXPORT_QUEUED, EXPORT_RUNNING) and now - last_moved > STALE_AFTER
    # Every view field the row holds (a None one left out), plain JSON values; never a key, the upload, the starter.
    expected: dict[str, Any] = {'id': EXPORT, 'status': status, 'created_at': row['created_at'], 'phase': 'zip',
                                'counts': {'feedback': 3}, 'size_bytes': 7, 'started_at': row['started_at'],
                                **({'expires_at': row['expires_at']} if expires_in is not None else {})}
    if status == EXPORT_COMPLETED and (expires_in is None or expires_in <= 0):
        expected['status'] = EXPORT_EXPIRED
    elif stalled:
        never_started = status == EXPORT_QUEUED and generation is None
        expected.update(status=EXPORT_FAILED, error=NOT_STARTED_ERROR if never_started else STALLED_ERROR)
    assert shown == expected
