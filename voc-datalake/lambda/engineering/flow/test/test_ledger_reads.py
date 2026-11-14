"""The GO ledger's own reads (flow/ledger.py): a record is a GO only with every part of a GO at once, and a gate record
that cannot be read as one is no GO, said in the log with its key, read at most to its bound."""
from __future__ import annotations

import itertools
import json
from typing import cast

import pytest

from engineering.connectors.test.test_records import gate_record
from engineering.flow import ledger
from engineering.quality_gate.record import FinalGoRecord, GateRecord
from engineering.workspace.store import ObjectTooLarge, WorkspaceStore

KEY = 'ws/default/runs/01JC8Z3K4M5N6P7Q8R9S0T1V2W/final-go-4/commits/a/_gate/attempt-1/record.json'
TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'


def record(verdict: str, final_go: FinalGoRecord | None, stop: str) -> GateRecord:
    return GateRecord(verdict=verdict, tree_hash=TREE, packs=(), max_rounds=3, rounds=(), findings=(), outcomes={},
                      reviewers=(), model_calls=2, final_go=final_go, stop_reason=stop)


FINAL_GOES = [None, FinalGoRecord(agent='final-go-4', model_id='m', go=True, reasons=('checked',)),
              FinalGoRecord(agent='final-go-4', model_id='m', go=False, reasons=('not yet',))]


@pytest.mark.parametrize(('verdict', 'final_go', 'stop'),
                         list(itertools.product(['GO', 'NO-GO', 'STOPPED'], FINAL_GOES, ['', 'verification'])))
def test_a_record_is_a_go_only_with_a_go_verdict_the_final_gos_own_go_and_no_stop(
        verdict: str, final_go: FinalGoRecord | None, stop: str) -> None:
    expected = verdict == 'GO' and final_go is not None and final_go.go and not stop
    assert ledger.is_go(record(verdict, final_go, stop)) is expected


def test_no_record_is_no_go() -> None:
    assert not ledger.is_go(None)


class Workspace:
    """A workspace that answers ``body`` (``None``: missing), or finds it over the bound (``too_large``), recording
    each read."""

    def __init__(self, body: bytes | None, *, too_large: bool = False) -> None:
        self.body = body
        self.too_large = too_large
        self.reads: list[tuple[str, int]] = []

    def read_bytes(self, key: str, limit: int) -> bytes | None:
        self.reads.append((key, limit))
        if self.too_large:
            raise ObjectTooLarge('the object is 2000000 bytes, over the 1048576 read')
        return self.body


def read(workspace: Workspace) -> GateRecord | None:
    return ledger.read_gate_record(cast('WorkspaceStore', workspace), KEY)


class Warnings:
    """The module logger's warning calls, as made."""

    def __init__(self) -> None:
        self.calls: list[tuple[tuple[object, ...], dict[str, object]]] = []

    def warning(self, *args: object, **kwargs: object) -> None:
        self.calls.append((args, kwargs))


@pytest.fixture
def warnings(monkeypatch: pytest.MonkeyPatch) -> Warnings:
    recorder = Warnings()
    monkeypatch.setattr(ledger, 'logger', recorder)
    return recorder


def test_a_gate_record_is_read_whole_up_to_one_mebibyte(warnings: Warnings) -> None:
    workspace = Workspace(json.dumps(gate_record('GO', TREE)).encode('utf-8'))
    got = read(workspace)
    assert got is not None
    assert (got.verdict, got.tree_hash) == ('GO', TREE)
    assert workspace.reads == [(KEY, 1024 * 1024)]
    assert warnings.calls == []


def test_a_gate_record_in_utf_8_keeps_its_words(warnings: Warnings) -> None:
    body = {**gate_record('GO', TREE), 'final_go': {'agent': 'final-go-4', 'model_id': 'm', 'verdict': 'GO',
                                                    'reasons': ['vérifié']}}
    got = read(Workspace(json.dumps(body, ensure_ascii=False).encode('utf-8')))
    assert got is not None
    assert got.final_go is not None
    assert got.final_go.reasons == ('vérifié',)
    assert warnings.calls == []


def test_a_missing_gate_record_is_none_and_not_logged(warnings: Warnings) -> None:
    assert read(Workspace(None)) is None
    assert warnings.calls == []


def test_a_gate_record_over_its_bound_is_no_go_said_in_the_log_with_its_key(warnings: Warnings) -> None:
    assert read(Workspace(None, too_large=True)) is None
    assert warnings.calls == [(('engineering: a gate record over its bound is no GO',), {'extra': {'key': KEY}})]


@pytest.mark.parametrize('body', [
    b'not json',
    b'\xff\xfe not utf-8',
    b'[' * 100_000 + b']' * 100_000,
    json.dumps({**gate_record('GO', TREE), 'schema': 'voc-gate-record/0'}).encode('utf-8'),
], ids=['not-json', 'not-utf-8', 'too-deep', 'off-schema'])
def test_a_gate_record_off_its_schema_is_no_go_said_in_the_log_with_its_key(warnings: Warnings, body: bytes) -> None:
    assert read(Workspace(body)) is None
    assert warnings.calls == [(('engineering: a gate record off its schema is no GO',), {'extra': {'key': KEY}})]
