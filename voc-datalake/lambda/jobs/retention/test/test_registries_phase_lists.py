"""7.97.00 (3g-ui round 3, s3-1): every phase list that checks the review registries also runs the deployment's lineage
pass. The web app reads a later run whose registries are complete and owes nothing as having made what an earlier
run owed (frontend/src/components/SourcesManager/erasureOutcome.ts ``madeLineage``): that holds only while a run that
checks the registries always reaches its lineage phase. Pure: ``handler._phases`` of stand-in walks."""
from __future__ import annotations

import itertools
from types import SimpleNamespace
from typing import Any

import pytest

from jobs.retention import boards, handler, members, runs

_STORES = ('projects', handler.STORE_RADAR, boards.STORE_BOARDS, members.STORE_MEMBERS, 'participants', 'workspaces')
_RUNS = [
    {'mode': runs.MODE_RETENTION},
    {'mode': runs.MODE_ERASE, 'field': 'email'},
    {'mode': runs.MODE_ERASE, 'field': 'email', 'source': 'tickets'},
    {'mode': runs.MODE_ERASE, 'field': 'author'},
    {'mode': runs.MODE_ERASE, 'field': 'source', 'source': 'tickets'},
    {'mode': runs.MODE_ERASE, 'field': 'email', 'workspace_id': 'ws_1'},
]


def _walks():
    for run, owed_only, size in itertools.product(_RUNS, (False, True), range(len(_STORES) + 1)):
        for stores in itertools.combinations(_STORES, size):
            yield SimpleNamespace(run=dict(run), owed_only=owed_only, tables=dict.fromkeys(stores, object()))


def _phases_of(walk: Any) -> list[str]:
    """``handler._phases`` of a stand-in walk (it reads only ``run``, ``owed_only`` and ``tables``)."""
    return handler._phases(walk)


@pytest.mark.parametrize('walk', list(_walks()), ids=lambda walk: f"{walk.run}-{walk.owed_only}-{sorted(walk.tables)}")
def test_a_run_that_checks_the_registries_also_runs_the_lineage_pass(walk):
    phases = handler._phases(walk)
    if handler.PHASE_REGISTRIES in phases:
        assert handler.PHASE_LINEAGE in phases
        assert phases.index(handler.PHASE_REGISTRIES) < phases.index(handler.PHASE_LINEAGE)


def test_some_walk_checks_the_registries():
    """The test above is not vacuous: the stand-in walks reach the registries phase, deleting and replay-only."""
    reached = [walk for walk in _walks() if handler.PHASE_REGISTRIES in _phases_of(walk)]
    assert {walk.owed_only for walk in reached} == {False, True}
