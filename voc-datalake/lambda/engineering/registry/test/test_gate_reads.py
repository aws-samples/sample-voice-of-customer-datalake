"""A run's gate as the run workspace reads it (7.52.00, registry/views.py): each check's pack and language from the
bundle's steps, a gate record's stop named by ``GET …/gates``' stop codes, a final go's decision, and the tools'
versions a connection's newest gate record recorded, per pack."""
from __future__ import annotations

from typing import Any

import pytest

from engineering.registry.views import (
    GATE_STOPS,
    check_place,
    final_go_view,
    pack_tool_versions,
    step_places,
    stop_code,
    stop_view,
)
from shared.engineering_templates import bundle


def _record(verdict: str, stop: str = '', *statuses: str, final: dict[str, Any] | None = None) -> dict[str, Any]:
    return {'schema': 'voc-gate-record/1', 'verdict': verdict, 'stop_reason': stop, 'final_go': final,
            'rounds': [{'number': 1, 'checks': [{'name': f'c{n}', 'status': status}
                                                for n, status in enumerate(statuses)]}]}


def test_each_check_is_placed_in_its_pack_and_language_by_its_step() -> None:
    places = step_places(bundle()['gates'])
    assert check_place('py.ruff@.', places) == {'pack': 'python', 'language': 'python'}
    assert check_place('ts.lint@web', places) == {'pack': 'typescript', 'language': 'ts'}
    # (the repository's own gate is no pack's; a step no pack has is placed nowhere)
    assert check_place('own:validate.sh', places) == {'pack': None, 'language': 'repo'}
    assert check_place('nope@.', places) == {'pack': None, 'language': None}


@pytest.mark.parametrize(('record', 'code'), [
    (_record('GO', '', 'pass'), None),
    (_record('NO-GO', final={'verdict': 'NO-GO', 'agent': 'final-go-1', 'model_id': 'm', 'reasons': ['x']}),
     'review_blocked'),
    (_record('STOPPED', 'no_fail_path', 'pass'), 'review_blocked'),
    (_record('STOPPED', 'loop_exhausted', 'pass', 'fail'), 'check_failed'),
    (_record('STOPPED', 'loop_exhausted', 'pass'), 'rounds_used_up'),
    (_record('STOPPED', 'own_gate_changed'), 'own_gate_changed'),
    (_record('NO-GO', '', 'pass', 'empty'), 'looked_at_nothing'),
    (_record('NO-GO', ''), 'looked_at_nothing'),
    (_record('NO-GO', '', 'pass', 'timeout'), 'check_failed'),
    (_record('NO-GO', '', 'pass'), None),
    # (a verification stop: no check applied, the own gate, the diff's size or a model's failure; not told apart)
    (_record('STOPPED', 'verification'), None),
])
def test_a_records_stop_is_named_by_the_gates_stop_codes(record: dict[str, Any], code: str | None) -> None:
    assert stop_code(record) == code
    assert code is None or code in {stop['code'] for stop in GATE_STOPS}


def test_the_stop_and_the_final_gos_decision_as_the_run_workspace_reads_them() -> None:
    assert stop_view(_record('STOPPED', 'loop_exhausted', 'fail')) == {
        'code': 'check_failed', 'text_key': 'gates.stops.check_failed', 'recorded': 'loop_exhausted'}
    assert stop_view(_record('STOPPED', 'verification')) == {'code': None, 'text_key': None,
                                                             'recorded': 'verification'}
    assert [stop_view(record) for record in (None, {'unreadable': True}, _record('GO', '', 'pass'))] == [None] * 3
    final = {'verdict': 'NO-GO', 'agent': 'final-go-1', 'model_id': 'model-large', 'reasons': ['R1 is open']}
    assert final_go_view(_record('NO-GO', final=final)) == final
    assert [final_go_view(record) for record in (None, _record('GO'), _record('GO', final={'verdict': 'maybe'}))] == [
        None] * 3


def test_a_connections_tool_versions_are_its_newest_records_per_pack() -> None:
    gates = bundle()['gates']
    recorded = {'tool_versions': {'python': 'Python 3.14.0', 'node': 'v24.15.0', 'gone': '1'},
                'run_id': 'run-1', 'at': '2026-11-17T09:30:00Z', 'key': 'k'}
    found = pack_tool_versions(gates, recorded)
    assert found['python'] == {'tool_versions': {'python': 'Python 3.14.0'}, 'run_id': 'run-1',
                               'at': '2026-11-17T09:30:00Z'}
    assert found['typescript'] == {'tool_versions': {'node': 'v24.15.0'}, 'run_id': 'run-1',
                                   'at': '2026-11-17T09:30:00Z'}
    # (a pack none of whose tools the record names: none recorded, never a version made up)
    assert (found['java'], found['rust']) == (None, None)
    assert pack_tool_versions(gates, None) == {pack['id']: None for pack in gates['packs']}
