"""What the broker reads of a run's own record (records.py): its META, the board's final-go GO for exactly a tree, and
a person's go, on moto; nothing written."""
from __future__ import annotations

import json
from collections.abc import Iterator
from typing import Any

import boto3
import pytest
from moto import mock_aws

from engineering.board.store import BoardStore
from engineering.board.test.table import TABLE, create_table
from engineering.connectors.hosts import NoConnection, Unavailable
from engineering.connectors.patches import AUTHOR
from engineering.connectors.records import RunRecords
from engineering.connectors.test.fakes import BASE, RUN, TREE, FakeHost
from engineering.flow import ledger as go_ledger
from engineering.workspace.store import WorkspaceStore

BUCKET = 'voc-eng-workspace'
PK = f'WS#default#RUN#{RUN}'
OTHER_TREE = 'e' * 40


def gate_record(verdict: str = 'GO', tree: str = TREE, stop: str = '') -> dict[str, Any]:
    go = verdict == 'GO'
    return {'schema': 'voc-gate-record/1', 'verdict': verdict, 'stop_reason': stop, 'tree_hash': tree, 'packs': [],
            'max_rounds': 3, 'reviewers': [], 'model_calls': 2, 'rounds': [], 'findings': [],
            'final_go': None if verdict == 'STOPPED' else {'agent': 'final-go-4', 'model_id': 'm', 'verdict':
                                                            'GO' if go else 'NO-GO', 'reasons': ['checked']}}


@pytest.fixture
def stores() -> Iterator[tuple[Any, Any]]:
    with mock_aws():
        client = create_table()
        s3 = boto3.client('s3', region_name='us-east-1')
        s3.create_bucket(Bucket=BUCKET)
        yield client, s3


def meta(client: Any, **attributes: str) -> None:
    item = {'run_id': RUN, 'status': 'active', 'connection': 'conn-1', 'commit': BASE, 'started_by': 'person-sub-1',
            **attributes}
    client.put_item(TableName=TABLE, Item={'pk': {'S': PK}, 'sk': {'S': 'META'},
                                           **{k: {'S': v} for k, v in item.items()}})


def final_go(client: Any, s3: Any, task: str, record: dict[str, Any] | str | None, *, state: str = 'done',
             updated_at: str = '2026-11-13T10:00:00+00:00', attempt: int = 1, role: str = 'final-go',
             holder: str = 'final-go-4', writer: str = 'final-go-4') -> str:
    """A final-go task as the board leaves it (held by ``holder``), with the gate record ``writer`` wrote under its
    own keys (``None``: never written)."""
    key = f'ws/default/runs/{RUN}/{writer}/commits/{BASE}/_gate/attempt-{attempt}/record.json'
    if record is not None:
        s3.put_object(Bucket=BUCKET, Key=key, Body=record if isinstance(record, str) else json.dumps(record))
    client.put_item(TableName=TABLE, Item={
        'pk': {'S': PK}, 'sk': {'S': f'TASK#{task}'}, 'task_id': {'S': task}, 'role': {'S': role},
        'state': {'S': state}, 'attempt': {'N': str(attempt)}, 'updated_at': {'S': updated_at},
        'lease_agent': {'S': holder},
        'result_keys': {'SS': [key, f'ws/default/runs/{RUN}/final-go-4/commits/{BASE}/_logs/attempt-1/x.txt']}})
    return key


def checked(client: Any, s3: Any, task: str = 'g1', tree: str = TREE, verdict: str = 'GO', *, stop: str = '',
            state: str = 'done', updated_at: str = '2026-11-13T08:00:00+00:00', status: str = 'pass') -> str:
    """A gate runner's task, ended ``state``, with its own record: ``verdict`` on ``tree``, one check ``status``."""
    return final_go(client, s3, task, checked_record(verdict, tree, stop=stop, status=status), state=state,
                    updated_at=updated_at, role='gate-runner', holder='gate-runner-3', writer='gate-runner-3')


def checked_record(verdict: str = 'GO', tree: str = TREE, *, stop: str = '', status: str = 'pass') -> dict[str, Any]:
    """A gate runner's record as the harness writes it: ``verdict`` on ``tree``, one check ``status``, no final go."""
    return {'schema': 'voc-gate-record/1', 'verdict': verdict, 'stop_reason': stop, 'tree_hash': tree, 'packs': [],
            'max_rounds': 1, 'reviewers': [], 'model_calls': 0, 'findings': [], 'final_go': None,
            'rounds': [{'number': 1, 'checks': [{'name': 'pytest -q', 'status': status}], 'reviewed': False,
                        'complete': True, 'finding_ids': []}]}


def ledger(client: Any, s3: Any, host: FakeHost | None = None) -> RunRecords:
    return RunRecords(client, TABLE, WorkspaceStore(s3, BUCKET, denied_is_missing=True),
                      (host or FakeHost()).default_branch)


def test_the_run_is_its_meta_with_the_hosts_default_branch(stores: tuple[Any, Any]) -> None:
    client, s3 = stores
    meta(client)
    host = FakeHost()
    run = ledger(client, s3, host).run(RUN)
    assert run is not None
    assert (run.connection_id, run.default_branch, run.status, run.commit, run.started_by) == (
        'conn-1', 'main', 'active', BASE, 'person-sub-1')
    # Nothing records an attestation, the run's issue or pull request, or its reviews yet: none is made up.
    assert (run.ci_attested, run.issue_number, run.pull_request_number, run.cited_reviews) == (False, None, None, ())
    assert run.bot_addresses == (AUTHOR,)
    assert host.calls == [('default_branch', 'conn-1')]


@pytest.mark.parametrize('status', ['stopped', 'needs_human', 'done'])
def test_a_run_that_is_not_active_is_read_without_the_host(stores: tuple[Any, Any], status: str) -> None:
    client, s3 = stores
    meta(client, status=status, connection='')
    host = FakeHost()
    run = ledger(client, s3, host).run(RUN)
    assert (run is not None and run.status, host.calls) == (status, [])


def test_an_unknown_run_or_a_meta_of_another_run_is_no_run(stores: tuple[Any, Any]) -> None:
    client, s3 = stores
    assert ledger(client, s3).run(RUN) is None
    meta(client, run_id='01JC8Z3K4M5N6P7Q8R9S0T1V2X')
    assert ledger(client, s3).run(RUN) is None


def test_an_active_run_without_a_connection_has_none(stores: tuple[Any, Any]) -> None:
    client, s3 = stores
    meta(client, connection='')
    with pytest.raises(NoConnection):
        ledger(client, s3).run(RUN)


def test_the_latest_final_go_decides_and_only_a_go_for_exactly_the_tree_counts(stores: tuple[Any, Any]) -> None:
    client, s3 = stores
    records_ = ledger(client, s3)
    assert not records_.has_go(RUN, TREE)   # (no final go yet)
    checked(client, s3, 'g1', OTHER_TREE, updated_at='2026-11-13T08:00:00+00:00')
    final_go(client, s3, 't1', gate_record('GO', OTHER_TREE), updated_at='2026-11-13T09:00:00+00:00')
    assert (records_.has_go(RUN, OTHER_TREE), records_.has_go(RUN, TREE)) == (True, False)
    checked(client, s3, 'g2', TREE, updated_at='2026-11-13T09:30:00+00:00')
    final_go(client, s3, 't2', gate_record('GO', TREE), updated_at='2026-11-13T10:00:00+00:00')
    # The newer verdict is the run's: the older tree's GO no longer counts.
    assert (records_.has_go(RUN, TREE), records_.has_go(RUN, OTHER_TREE), records_.has_go(RUN, '')) == (
        True, False, False)
    final_go(client, s3, 't3', gate_record('NO-GO', TREE), state='needs_human',
             updated_at='2026-11-13T11:00:00+00:00')
    assert not records_.has_go(RUN, TREE)


@pytest.mark.parametrize(('record', 'state', 'role'), [
    (gate_record('NO-GO'), 'done', 'final-go'),
    (gate_record('STOPPED', stop='verification'), 'done', 'final-go'),
    (gate_record('GO'), 'needs_human', 'final-go'),     # (ended at a person's decision: not a GO of the board)
    (gate_record('GO'), 'in_progress', 'final-go'),     # (not ended)
    (gate_record('GO'), 'done', 'pr-reviewer'),         # (another role's record is no verdict)
    ({**gate_record('GO'), 'stop_reason': 'verification'}, 'done', 'final-go'),
    ({**gate_record('GO'), 'final_go': None}, 'done', 'final-go'),
    ({**gate_record('GO'), 'schema': 'voc-gate-record/0'}, 'done', 'final-go'),
    ('not json', 'done', 'final-go'),
    ('[' * 100_000 + ']' * 100_000, 'done', 'final-go'),   # (nested past what json reads)
    (None, 'done', 'final-go'),                          # (recorded, never written: S3 answers 403)
])
def test_anything_but_a_final_gos_clean_go_is_no_go(stores: tuple[Any, Any], record: dict[str, Any] | str | None,
                                                     state: str, role: str) -> None:
    client, s3 = stores
    final_go(client, s3, 't1', record, state=state, role=role)
    assert not ledger(client, s3).has_go(RUN, TREE)


@pytest.mark.parametrize(('state', 'record', 'holder'), [
    ('needs_human', None, ''),                         # a person blocked it: its holder cleared, no record
    ('failed', None, 'final-go-4'),
    ('needs_human', gate_record('NO-GO'), 'final-go-4'),
    ('done', gate_record('NO-GO'), 'final-go-4'),
    ('done', None, 'final-go-4'),                      # ended done with no record of its own
], ids=['blocked', 'failed', 'needs a person', 'NO-GO', 'no record'])
def test_the_newest_final_go_decides_and_an_older_go_never_stands_in(stores: tuple[Any, Any], state: str,
                                                                    record: dict[str, Any] | None,
                                                                    holder: str) -> None:
    client, s3 = stores
    checked(client, s3)
    final_go(client, s3, 't1', gate_record('GO'), updated_at='2026-11-13T09:00:00+00:00', attempt=1)
    assert ledger(client, s3).has_go(RUN, TREE)
    final_go(client, s3, 't2', record, state=state, updated_at='2026-11-13T10:00:00+00:00', attempt=2, holder=holder)
    assert not ledger(client, s3).has_go(RUN, TREE)


@pytest.mark.parametrize(('verdict', 'stop', 'state', 'tree', 'status'), [
    ('STOPPED', 'tool_missing', 'done', TREE, 'fail'),
    ('NO-GO', '', 'done', TREE, 'fail'),
    ('GO', '', 'failed', TREE, 'pass'),           # (its task did not end done)
    ('GO', '', 'done', OTHER_TREE, 'pass'),       # (a GO for another tree)
    ('GO', '', 'done', TREE, 'fail'),             # (a GO a failed check contradicts)
], ids=['stopped', 'no-go', 'failed-task', 'other-tree', 'failed-check'])
def test_a_final_gos_go_after_a_gate_runner_that_did_not_pass_on_its_tree_is_no_go(
        stores: tuple[Any, Any], verdict: str, stop: str, state: str, tree: str, status: str) -> None:
    client, s3 = stores
    checked(client, s3, 'g1', tree, verdict, stop=stop, state=state, status=status)
    final_go(client, s3, 't1', gate_record('GO'), updated_at='2026-11-13T09:00:00+00:00')
    assert not ledger(client, s3).has_go(RUN, TREE)
    # No gate runner at all: no GO either; a newer gate runner's GO on the tree makes the final go's GO count.
    checked(client, s3, 'g2', TREE, updated_at='2026-11-13T08:30:00+00:00')
    assert ledger(client, s3).has_go(RUN, TREE)


def test_a_final_gos_go_with_no_gate_runner_is_no_go(stores: tuple[Any, Any]) -> None:
    client, s3 = stores
    final_go(client, s3, 't1', gate_record('GO'))
    assert not ledger(client, s3).has_go(RUN, TREE)


@pytest.mark.parametrize(('holder', 'writer'), [('final-go-4', 'final-go-5'), ('human:admin-sub', 'human:admin-sub'),
                                                ('fixer-2', 'fixer-2')])
def test_only_the_final_go_holders_own_record_counts(stores: tuple[Any, Any], holder: str, writer: str) -> None:
    client, s3 = stores
    final_go(client, s3, 't1', gate_record('GO'), holder=holder, writer=writer)
    assert not ledger(client, s3).has_go(RUN, TREE)


def test_the_latest_attempt_of_a_task_wins_and_only_its_record_is_read(stores: tuple[Any, Any],
                                                                        monkeypatch: pytest.MonkeyPatch) -> None:
    client, s3 = stores
    gate = checked(client, s3)
    final_go(client, s3, 't1', gate_record('NO-GO'), attempt=1)
    key = final_go(client, s3, 't1', gate_record('GO'), attempt=2)
    read: list[str] = []
    store = WorkspaceStore(s3, BUCKET)
    original = store.read_bytes
    monkeypatch.setattr(store, 'read_bytes', lambda k, limit: read.append(k) or original(k, limit))
    assert RunRecords(client, TABLE, store, FakeHost().default_branch).has_go(RUN, TREE)
    # The deciding final go's record, then the newest gate runner's: no other.
    assert read == [key, gate]


def test_a_gate_record_over_its_bound_is_no_go(stores: tuple[Any, Any], monkeypatch: pytest.MonkeyPatch) -> None:
    client, s3 = stores
    final_go(client, s3, 't1', gate_record('GO'))
    monkeypatch.setattr(go_ledger, 'MAX_GATE_RECORD_BYTES', 10)   # (the GO ledger's own bound, flow/ledger.py)
    assert not ledger(client, s3).has_go(RUN, TREE)


def test_a_persons_go_is_the_row_an_administrators_go_wrote(stores: tuple[Any, Any]) -> None:
    client, s3 = stores
    meta(client)
    records_ = ledger(client, s3)
    assert not records_.person_go(RUN)
    BoardStore(client, TABLE, new_id=lambda: 'x').person_go('default', RUN, actor='human:admin-sub')
    assert records_.person_go(RUN)


def test_a_go_row_not_made_by_a_person_is_no_go(stores: tuple[Any, Any]) -> None:
    client, s3 = stores
    client.put_item(TableName=TABLE, Item={'pk': {'S': PK}, 'sk': {'S': 'GO#person'}, 'by': {'S': 'fixer-1'}})
    assert not ledger(client, s3).person_go(RUN)


class Down:
    def __getattr__(self, name: str) -> Any:
        from botocore.exceptions import ClientError

        def fail(**_: Any) -> Any:
            raise ClientError({'Error': {'Code': 'ProvisionedThroughputExceededException', 'Message': 'x'}}, name)
        return fail


@pytest.mark.parametrize('read', [lambda r: r.run(RUN), lambda r: r.person_go(RUN), lambda r: r.has_go(RUN, TREE)])
def test_a_table_that_cannot_be_read_is_unavailable(read: Any) -> None:
    with pytest.raises(Unavailable):
        read(RunRecords(Down(), TABLE, WorkspaceStore(Down(), BUCKET), FakeHost().default_branch))


def test_a_workspace_that_cannot_be_read_is_unavailable(stores: tuple[Any, Any]) -> None:
    client, s3 = stores
    final_go(client, s3, 't1', gate_record('GO'))
    with pytest.raises(Unavailable):
        RunRecords(client, TABLE, WorkspaceStore(Down(), BUCKET), FakeHost().default_branch).has_go(RUN, TREE)
