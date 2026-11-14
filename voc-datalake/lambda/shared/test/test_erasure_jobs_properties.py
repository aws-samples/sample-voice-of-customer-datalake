"""Properties of a workspace's one-live-job lock (shared/erasure_jobs.py on shared/source_erasure.py's lock rule).

Two erasures of one workspace at once can each think the other's rows are theirs to sweep, and an export started
during an erasure can package what is being erased; so each workspace holds one live job of each kind through a lock
row. Random runs of starts, renewals and releases by several jobs, at increasing times, are checked against a plain
model after every step: the lock row in the (moto) table is exactly what the model says.

One moto table serves the whole module: every generated run gets a workspace of its own (a lock is one row, so the
table stays small without clearing it).
"""
from __future__ import annotations

from collections.abc import Iterator
from datetime import UTC, datetime, timedelta
from itertools import count
from unittest.mock import MagicMock, patch

import pytest
from botocore.exceptions import ClientError, EndpointConnectionError
from hypothesis import given
from hypothesis import strategies as st

from shared.erasure_jobs import (
    WORKSPACE_LOCK_SK,
    WorkspaceErasureRunning,
    acquire_workspace_lock,
    job_key,
    job_partition,
    refresh_workspace_lock,
    release_quietly,
    release_workspace_lock,
)
from shared.retention import ERASURE_JOB_PK
from shared.source_erasure import STALE_AFTER
from shared.test.ws_properties import KEY_PARTS, PROPERTY, moto_pk_sk_table, workspace_ids
from shared.ws_repo import WorkspaceScope

JOBS = ('er_000000000001', 'er_000000000002', 'er_000000000003')
START = datetime(2026, 11, 14, 8, 0, tzinfo=UTC)
#: One step: (what, which job, minutes since the step before). Gaps reach past STALE_AFTER (60 min).
STEPS = st.lists(st.tuples(st.sampled_from(['acquire', 'refresh', 'release']), st.sampled_from(JOBS),
                           st.sampled_from([0, 1, 30, 59, 60, 61, 90, 200])), min_size=1, max_size=10)
_RUNS = count()


@pytest.fixture(scope='module')
def table() -> Iterator:
    yield from moto_pk_sk_table('aggregates')


def _lock_row(table, scope: WorkspaceScope) -> dict | None:
    return table.get_item(Key={'pk': job_partition(scope), 'sk': WORKSPACE_LOCK_SK}, ConsistentRead=True).get('Item')


def _free(lock: dict | None, now: datetime) -> bool:
    """The lock rule: free when there is no row, it was released, or it was taken more than STALE_AFTER ago."""
    return lock is None or 'released_at' in lock or lock['locked_at'] < (now - STALE_AFTER).isoformat()


# Whatever starts, renewals and releases several jobs make, and however long between them, the lock row is the
# model's: a start takes a free lock (and only a free one: a held one answers "running"), a renewal and a release
# touch only the holder's own row (a release by a job whose stale lock was taken over never frees its successor's),
# and a released lock is never renewed.
@PROPERTY
@given(STEPS)
def test_one_live_job_holds_the_lock_and_only_it_frees_it(table, steps):
    scope = WorkspaceScope(f'ws_0{next(_RUNS):025d}')
    model: dict | None = None
    now = START
    for what, job, minutes in steps:
        now += timedelta(minutes=minutes)
        if what == 'acquire':
            if _free(model, now):
                acquire_workspace_lock(table, scope, job, now)
                model = {'job_id': job, 'locked_at': now.isoformat()}
            else:
                with pytest.raises(WorkspaceErasureRunning) as refused:
                    acquire_workspace_lock(table, scope, job, now)
                assert refused.value.args == (scope.ws,)
        elif what == 'refresh':
            refresh_workspace_lock(table, scope, job, now)
            if model is not None and model['job_id'] == job and 'released_at' not in model:
                model = {**model, 'locked_at': now.isoformat()}
        else:
            release_workspace_lock(table, scope, job, now)
            if model is not None and model['job_id'] == job:
                model = {**model, 'released_at': now.isoformat()}
        stored = _lock_row(table, scope)
        expected = None if model is None else {'pk': job_partition(scope), 'sk': WORKSPACE_LOCK_SK, **model}
        assert stored == expected


# Two workspaces' locks never meet: one workspace holding its lock leaves another's free.
@PROPERTY
@given(st.sampled_from(JOBS), st.sampled_from(JOBS))
def test_a_workspace_lock_holds_that_workspace_only(table, first, second):
    mine, theirs = WorkspaceScope(f'ws_0{next(_RUNS):025d}'), WorkspaceScope(f'ws_0{next(_RUNS):025d}')
    acquire_workspace_lock(table, mine, first, START)
    acquire_workspace_lock(table, theirs, second, START)
    release_workspace_lock(table, theirs, first if first != second else 'er_999999999999', START)
    held, other = _lock_row(table, mine), _lock_row(table, theirs)
    assert held is not None
    assert other is not None
    assert held['job_id'] == first
    assert 'released_at' not in other
    with pytest.raises(WorkspaceErasureRunning):
        acquire_workspace_lock(table, mine, second, START + timedelta(minutes=1))


# Renewing and releasing send one UpdateItem of the workspace's own lock row through the workspace layer, conditional
# on the job still holding it (and, for a renewal, on its not being released): the exact request, so the condition
# that keeps a job from touching its successor's lock is the one stated, word for word.
@PROPERTY
@given(workspace_ids(), st.sampled_from(JOBS), st.integers(min_value=0, max_value=10_000))
def test_renew_and_release_name_the_holder_in_their_condition(ws, job, minutes):
    scope = WorkspaceScope(ws)
    now = START + timedelta(minutes=minutes)
    backing = MagicMock()
    refresh_workspace_lock(backing, scope, job, now)
    release_workspace_lock(backing, scope, job, now)
    key = {'pk': f'WS#{ws}#JOB#erasure', 'sk': WORKSPACE_LOCK_SK}
    values = {':now': now.isoformat(), ':job': job}
    assert [call.kwargs for call in backing.update_item.call_args_list] == [
        {'Key': key, 'UpdateExpression': 'SET locked_at = :now',
         'ConditionExpression': 'attribute_exists(pk) AND job_id = :job AND attribute_not_exists(released_at)',
         'ExpressionAttributeValues': values},
        {'Key': key, 'UpdateExpression': 'SET released_at = :now',
         'ConditionExpression': 'attribute_exists(pk) AND job_id = :job', 'ExpressionAttributeValues': values},
    ]


# A lock freed on an error path is best effort: a failed release is logged (what, and the error's type only) and
# swallowed, so the caller's own error is the one reported; any other fault, and a release that works, log nothing.
@PROPERTY
@given(st.sampled_from(['erasure', 'export', 'reprocess']),
       st.sampled_from(['client', 'botocore', 'other', 'none']))
def test_a_quiet_release_logs_its_own_failure_only(what, failure):
    errors = {'client': ClientError({'Error': {'Code': 'ProvisionedThroughputExceededException', 'Message': ''}},
                                    'UpdateItem'),
              'botocore': EndpointConnectionError(endpoint_url='https://dynamodb'),
              'other': RuntimeError('a bug'), 'none': None}
    error = errors[failure]

    def release() -> None:
        if error is not None:
            raise error

    with patch('shared.erasure_jobs.logger') as logger:
        if failure == 'other':
            with pytest.raises(RuntimeError, match='a bug'):
                release_quietly(release, what)
        else:
            release_quietly(release, what)
    if failure in ('client', 'botocore'):
        logger.warning.assert_called_once_with(f'Could not release the {what} lock',
                                               extra={'error_type': type(error).__name__})
    else:
        assert not logger.warning.called


# A job's row is in its own partition: the deployment's ``JOB#erasure``, or the workspace's ``WS#{ws}#JOB#erasure``,
# and never another workspace's; the lock row's sort key is no job id, so no job list shows it.
@PROPERTY
@given(workspace_ids(), KEY_PARTS)
def test_a_job_row_lives_in_its_own_partition(ws, job_id):
    scope = WorkspaceScope(ws)
    assert job_key(job_id, None) == {'pk': ERASURE_JOB_PK, 'sk': job_id}
    assert job_key(job_id, scope) == {'pk': f'WS#{ws}#JOB#erasure', 'sk': job_id}
    assert scope.owns(job_partition(scope))
    assert not WORKSPACE_LOCK_SK.startswith(('er_', 'ex_'))
