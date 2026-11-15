"""The run store's edges (runtime/runs.py ``RunStore``): what a start writes and refuses in its own words, what a read
gives back for every field (an old row's missing ones too), the run's spend, the status history's rows, and the
status change's tries when another write of META races it (never a silent give-up, never more than three)."""
from __future__ import annotations

import re
from typing import Any

import pytest
from botocore.exceptions import ClientError

from engineering.runtime import runs as runs_module
from engineering.runtime.interface import RuntimeRefused
from engineering.runtime.runs import RunCaps, RunExists, RunNotActive, RunStore, transaction_conflict
from engineering.runtime.test.conftest import RUN
from engineering.runtime.test.test_engineering_run_flow import UNDERSTAND, _start
from engineering.runtime.test.test_engineering_runs import META, OTHER, _history

PK = META['pk']
COMMIT = 'b' * 40


def _exact(message: str) -> str:
    """A ``pytest.raises`` match for exactly ``message`` (a refusal's sentence is part of the contract)."""
    return f'^{re.escape(message)}$'


def _meta(table: Any) -> dict[str, Any]:
    return table.get_item(Key=META)['Item']


def _cancelled(*codes: str) -> ClientError:
    """A cancelled transaction, with one reason per item."""
    return ClientError({'Error': {'Code': 'TransactionCanceledException', 'Message': 'cancelled'},
                        'CancellationReasons': [{'Code': code} for code in codes]}, 'TransactWriteItems')


# ---- the start ----

def test_a_start_writes_the_run_id_repository_and_toolchain_on_meta(aws: Any) -> None:
    RunStore(aws[1]).start(RUN, caps=RunCaps(max_tasks=5), now=0, repo='example/app', language='python')
    meta = _meta(aws[1])
    assert (meta['run_id'], meta['repo'], meta['language']) == (RUN, 'example/app', 'python')


def test_a_start_given_nothing_more_records_empty_fields_never_placeholders(aws: Any) -> None:
    RunStore(aws[1]).start(RUN, caps=RunCaps(max_tasks=5), now=0)
    meta = _meta(aws[1])
    assert (meta['goal'], meta['repo'], meta['flow'], meta['connection'], meta['commit'], meta['language']) == (
        '', '', '', '', '', '')


def test_the_coordinators_task_is_stamped_with_the_starts_time(aws: Any) -> None:
    RunStore(aws[1]).start(RUN, caps=RunCaps(max_tasks=5), now=86_400)
    task = aws[1].get_item(Key={'pk': PK, 'sk': 'TASK#coordinate'})['Item']
    assert task['updated_at'] == '1970-01-02T00:00:00Z'


def test_a_flow_copy_without_its_revision_is_refused(aws: Any) -> None:
    with pytest.raises(RuntimeRefused, match=_exact("the flow's revision is a whole number from 1")):
        RunStore(aws[1]).start(RUN, caps=RunCaps(max_tasks=5), now=0, flow='wf_understand',
                               flow_definition=UNDERSTAND)
    assert RunStore(aws[1]).get(RUN) is None


@pytest.mark.parametrize(('kwargs', 'message'), [
    ({'connection': 'conn 1'}, 'connection must be 1-63 letters, digits or "-"'),
    ({'commit': 'abc123'}, 'a commit is a full hexadecimal object id'),
    ({'language': 'cobol'}, "no toolchain image for language 'cobol'"),
    ({'flow': '', 'budget_usd': 10.0}, "a budget is a flow's: the run names its workflow id"),
    ({'flow': '', 'flow_definition': UNDERSTAND, 'flow_revision': 4},
     "a flow's copy is a flow's: the run names its workflow id"),
    ({'flow': 'wf_x', 'flow_definition': '{', 'flow_revision': 4},
     "the run's flow is not an engineering flow the server's rules pass: save it again"),
], ids=['connection', 'commit', 'language', 'budget-without-flow', 'copy-without-flow', 'copy-not-a-flow'])
def test_a_refused_start_says_why_in_its_own_words(aws: Any, kwargs: dict[str, Any], message: str) -> None:
    with pytest.raises(RuntimeRefused, match=_exact(message)):
        RunStore(aws[1]).start(RUN, caps=RunCaps(max_tasks=5), now=0, **kwargs)
    assert RunStore(aws[1]).get(RUN) is None


def test_a_second_start_says_the_run_was_started_already(aws: Any) -> None:
    runs = RunStore(aws[1])
    runs.start(RUN, caps=RunCaps(max_tasks=5), now=0)
    with pytest.raises(RunExists, match=_exact(f'run {RUN} was started already')):
        runs.start(RUN, caps=RunCaps(max_tasks=5), now=1)


# ---- the status history ----

def test_a_history_row_is_a_run_status_row_keyed_by_time_status_and_eight_hex_digits(aws: Any) -> None:
    RunStore(aws[1]).start(RUN, caps=RunCaps(max_tasks=5), now=0)
    (row,) = aws[1].query(KeyConditionExpression='pk = :pk AND begins_with(sk, :log)',
                          ExpressionAttributeValues={':pk': PK, ':log': 'RUNLOG#'})['Items']
    assert re.fullmatch(r'RUNLOG#1970-01-01T00:00:00Z#active#[0-9a-f]{8}', row['sk'])
    assert row['kind'] == 'run_status'


def test_an_end_or_a_resume_naming_nobody_is_unattributed(aws: Any) -> None:
    runs = RunStore(aws[1])
    runs.start(RUN, caps=RunCaps(max_tasks=5), now=0, actor='admin-1')
    runs.needs_human(RUN, 'budget', now=60)
    runs.resume(RUN, now=120)
    runs.end(RUN, 'done', now=180)
    assert [actor for _status, actor, _reason, _at in _history(aws[1])] == [
        'admin-1', 'supervisor', 'unattributed', 'unattributed']


def test_a_persons_decision_on_a_step_is_keyed_by_its_time_and_eight_hex_digits(aws: Any) -> None:
    runs = _start(aws[1])
    runs.needs_human(RUN, 'flow:approval', now=90_000)
    runs.resume(RUN, now=90_060, actor='admin-2')
    (decision,) = aws[1].query(KeyConditionExpression='pk = :pk AND begins_with(sk, :p)',
                               ExpressionAttributeValues={':pk': PK, ':p': 'STEP#'})['Items']
    assert re.fullmatch(r'STEP#approval#decision#1970-01-02T01:01:00Z#[0-9a-f]{8}', decision['sk'])


# ---- the status changes and their refusals ----

def test_a_status_that_is_not_an_end_is_refused_naming_the_ends(aws: Any) -> None:
    runs = RunStore(aws[1])
    runs.start(RUN, caps=RunCaps(max_tasks=5), now=0)
    with pytest.raises(RuntimeRefused, match=_exact("a run ends as one of ['done', 'failed', 'stopped']")):
        runs.end(RUN, 'paused', now=1)


def test_a_change_of_a_run_never_started_says_it_is_not_active(aws: Any) -> None:
    runs = RunStore(aws[1])
    with pytest.raises(RunNotActive, match=_exact(f'run {OTHER} is not active')):
        runs.end(OTHER, 'done', now=1)
    with pytest.raises(RunNotActive, match=_exact(f'run {OTHER} is not active')):
        runs.needs_human(OTHER, 'budget', now=1)
    with pytest.raises(RunNotActive, match=_exact(f'run {OTHER} is not active')):
        runs.resume(OTHER, now=1)


def test_a_change_that_keeps_losing_the_race_is_tried_three_times_with_growing_pauses_then_raised(
        aws: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    runs = RunStore(aws[1])
    runs.start(RUN, caps=RunCaps(max_tasks=5), now=0)
    calls: list[dict[str, Any]] = []
    pauses: list[float] = []

    def always_racing(**kwargs: Any) -> Any:
        calls.append(kwargs)
        raise _cancelled('TransactionConflict', 'None')

    monkeypatch.setattr(aws[1].meta.client, 'transact_write_items', always_racing)
    monkeypatch.setattr(runs_module.time, 'sleep', pauses.append)
    with pytest.raises(ClientError):
        runs.end(RUN, 'stopped', now=60)
    assert len(calls) == 3
    assert pauses == [0.05, 0.1]


def test_a_change_refused_for_another_reason_is_raised_at_once_never_tried_again(
        aws: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    runs = RunStore(aws[1])
    runs.start(RUN, caps=RunCaps(max_tasks=5), now=0)
    calls: list[dict[str, Any]] = []

    def refused(**kwargs: Any) -> Any:
        calls.append(kwargs)
        raise _cancelled('None', 'ConditionalCheckFailed')   # (the history row's key, not META)

    monkeypatch.setattr(aws[1].meta.client, 'transact_write_items', refused)
    monkeypatch.setattr(runs_module.time, 'sleep', lambda _seconds: None)
    with pytest.raises(ClientError):
        runs.end(RUN, 'stopped', now=60)
    assert len(calls) == 1


def test_a_throttled_change_is_raised_at_once(aws: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    runs = RunStore(aws[1])
    runs.start(RUN, caps=RunCaps(max_tasks=5), now=0)
    calls: list[dict[str, Any]] = []

    def throttled(**kwargs: Any) -> Any:
        calls.append(kwargs)
        raise ClientError({'Error': {'Code': 'ThrottlingException', 'Message': 'slow down'}}, 'TransactWriteItems')

    monkeypatch.setattr(aws[1].meta.client, 'transact_write_items', throttled)
    with pytest.raises(ClientError, match='slow down'):
        runs.needs_human(RUN, 'budget', now=60)
    assert len(calls) == 1


@pytest.mark.parametrize(('codes', 'conflict'), [
    (('None', 'TransactionConflict'), True), (('None', 'ConditionalCheckFailed'), False), ((), False)],
    ids=['a-conflict', 'another-refusal', 'no-reasons'])
def test_only_a_transaction_conflict_is_worth_another_try(codes: tuple[str, ...], conflict: bool) -> None:
    assert transaction_conflict(_cancelled(*codes)) is conflict


# ---- the read ----

def test_a_read_gives_back_every_field_the_start_and_the_changes_wrote(aws: Any) -> None:
    runs = RunStore(aws[1])
    runs.start(RUN, caps=RunCaps(max_tasks=5), now=100, repo='example/app', flow='wf_fix', connection='conn-1',
               commit=COMMIT, language='python', budget_usd=10.0)
    runs.needs_human(RUN, 'budget', now=200)
    runs.resume(RUN, now=300)
    run = runs.get(RUN)
    assert run is not None
    assert (run.run_id, run.status, run.started_at, run.repo, run.flow, run.connection, run.commit) == (
        RUN, 'active', 100, 'example/app', 'wf_fix', 'conn-1', COMMIT)
    assert (run.language, run.budget_usd, run.resumed_at, run.waiting_at) == ('python', 10.0, 300, '')


def test_a_run_never_resumed_reads_as_resumed_at_zero(aws: Any) -> None:
    runs = RunStore(aws[1])
    runs.start(RUN, caps=RunCaps(max_tasks=5), now=100)
    run = runs.get(RUN)
    assert run is not None
    assert run.resumed_at == 0


def test_an_old_meta_without_the_newer_fields_reads_as_empty_ones(aws: Any) -> None:
    aws[1].put_item(Item={**META, 'status': 'needs_human', 'started_epoch': 5, 'max_tasks': 3})
    run = RunStore(aws[1]).get(RUN)
    assert run is not None
    assert (run.connection, run.commit, run.language, run.flow, run.repo) == ('', '', '', '', '')
    assert (run.resumed_at, run.waiting_at, run.budget_usd, run.budget_alert, run.budget_alert_month) == (
        0, '', None, 0, '')


def test_an_ended_run_waits_at_no_decision_point_though_meta_keeps_its_last_reason(aws: Any) -> None:
    runs = RunStore(aws[1])
    runs.start(RUN, caps=RunCaps(max_tasks=5), now=0)
    runs.needs_human(RUN, 'budget', now=1)
    runs.end(RUN, 'stopped', now=2)
    run = runs.get(RUN)
    assert _meta(aws[1])['needs_human'] == 'budget'
    assert run is not None
    assert run.waiting_at == ''


# ---- the spend ----

def test_a_runs_spend_adds_every_agents_tokens_in_and_out_and_its_cost_a_missing_count_as_none(aws: Any) -> None:
    runs = RunStore(aws[1])
    runs.start(RUN, caps=RunCaps(max_tasks=5), now=0)
    for agent, counts in (('fixer-1', {'input_tokens': 30, 'output_tokens': 20, 'cost_usd': '0.25'}),
                          ('hunter-2', {'output_tokens': 7}), ('mapper-3', {'input_tokens': 5})):
        aws[1].put_item(Item={'pk': PK, 'sk': f'AGENT#{agent}', **counts})
    assert runs.spend(RUN) == (62, 0.25)


# ---- the reads are strongly consistent ----

def test_the_lists_the_spend_and_the_plans_rows_are_read_strongly(aws: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    """A run just started is listed, and an agent's spend just written is counted, on the very next read."""
    runs = _start(aws[1])
    real, asked = aws[1].query, []

    def recording(**kwargs: Any) -> Any:
        asked.append(kwargs)
        return real(**kwargs)

    monkeypatch.setattr(aws[1], 'query', recording)
    runs.listed()
    runs.spend(RUN)
    runs.flow_plan(RUN)
    assert len(asked) == 4   # (the list, the spend, the plan's tasks and its step rows)
    assert all(query['ConsistentRead'] is True for query in asked)
