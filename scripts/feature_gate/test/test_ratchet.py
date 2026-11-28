"""The ratchet: what each kind needs, the gaps, and the allowed list that only shrinks."""
from __future__ import annotations

from pathlib import Path
from typing import Any

import planted
import pytest
from feature_gate import ratchet


def never(_item_id: str, _entry: dict[str, Any]) -> bool:
    return False


def always(_item_id: str, _entry: dict[str, Any]) -> bool:
    return True


def reviewed(_item: dict[str, Any]) -> bool:
    return True


@pytest.mark.parametrize(('kind', 'needs'), [
    ('feature', ['unit', 'e2e']), ('fix', ['regression']), ('plumbing', ['unit']), ('no-behaviour', ['review']),
])
def test_each_kind_needs_its_layers(kind: str, needs: list[str]):
    assert ratchet.needs(kind) == needs


def test_a_done_feature_without_tests_has_both_gaps():
    assert ratchet.item_gaps(planted.item('7.76.00', 'feature'), never) == ['unit', 'e2e']


def test_a_planned_item_has_no_gap():
    assert ratchet.item_gaps(planted.item('7.76.00', 'feature', status='planned'), never) == []


def test_only_an_accepted_test_closes_a_gap():
    feature = planted.item('7.76.00', 'feature', unit=[{'runner': 'pytest'}], e2e=[{'runner': 'playwright'}])
    assert ratchet.item_gaps(feature, never) == ['unit', 'e2e']
    assert ratchet.item_gaps(feature, always) == []
    seen: list[str] = []
    ratchet.item_gaps(feature, lambda item_id, _e: seen.append(item_id) is not None)
    assert set(seen) == {'7.76.00'}


def test_a_fix_is_closed_by_a_regression_test_of_either_layer():
    fix = planted.item('7.77.00', 'fix', e2e=[{'runner': 'playwright'}])
    assert ratchet.item_gaps(fix, never) == ['regression']
    assert ratchet.item_gaps(fix, always) == []


def ex(**change: Any) -> dict[str, Any]:
    return {'layer': 'e2e', 'kind': 'no-user-flow', 'reason': 'r', 'proposed_by': 'h2/a', 'reviewed_by': 'r/1',
            'reviewed_at': 'abcdef1'} | change


def test_a_reviewed_exemption_closes_its_own_layer_only():
    assert ratchet.item_gaps(planted.item('7.76.00', 'feature', exemption=ex()), never, reviewed) == ['unit']
    every = ex(layer='all', kind='no-behaviour')
    assert ratchet.item_gaps(planted.item('7.75.01', 'no-behaviour', exemption=every), never, reviewed) == []


def test_an_exemption_not_reviewed_closes_nothing():
    assert ratchet.item_gaps(planted.item('7.76.00', 'feature', exemption=ex()), never) == ['unit', 'e2e']


@pytest.mark.parametrize('kind', ['platform-only', 'live-only'])
def test_checked_elsewhere_closes_no_gap(kind: str):
    item = planted.item('7.76.00', 'feature', exemption=ex(kind=kind, layer='all'))
    assert ratchet.item_gaps(item, never, reviewed) == ['unit', 'e2e']
    assert ratchet.elsewhere(item) == kind


GAPS = {'6.05.00': ['unit', 'e2e'], '7.75.01': ['review']}


def test_gaps_within_the_allowed_list_pass():
    assert ratchet.compare(GAPS, GAPS, None) == []


def test_a_new_gap_fails():
    problems = ratchet.compare(GAPS | {'7.76.00': ['e2e']}, GAPS, None)
    assert problems == ['7.76.00: new gap e2e (register an accepted test or a reviewed exemption)']


def test_a_closed_gap_still_allowed_asks_for_a_shrink():
    problems = ratchet.compare({'6.05.00': ['unit', 'e2e']}, GAPS, None)
    assert problems == ['7.75.01: review is no longer a gap; run `python3 scripts/feature_gate.py baseline --shrink`']


def test_the_allowed_list_may_not_grow_past_the_base_branch():
    problems = ratchet.compare(GAPS, GAPS, {'6.05.00': ['unit', 'e2e']})
    assert problems == ['7.75.01: allowed gap review is not allowed on the base branch (the list only shrinks)']


def test_a_refined_item_hands_its_allowed_gaps_to_its_slices():
    refined = {'6.05.00': ['6.05.00/a', '6.05.00/b']}
    current = {'6.05.00/a': ['unit', 'e2e'], '6.05.00/b': ['e2e'], '7.75.01': ['review']}
    assert ratchet.expand(GAPS, refined) == {'6.05.00/a': ['unit', 'e2e'], '6.05.00/b': ['unit', 'e2e'],
                                             '7.75.01': ['review']}
    assert ratchet.compare(current, ratchet.expand(ratchet.shrink(ratchet.expand(GAPS, refined), current), {}),
                           ratchet.expand(GAPS, refined)) == []
    assert ratchet.shrink(ratchet.expand(GAPS, refined), current) == current


def test_count_and_shrink():
    assert ratchet.count(GAPS) == 3
    assert ratchet.shrink(GAPS, {'6.05.00': ['e2e'], '7.76.00': ['unit']}) == {'6.05.00': ['e2e']}


def test_the_allowed_file_round_trips_without_a_count(tmp_path: Path):
    ratchet.save_allowed(tmp_path, GAPS)
    assert ratchet.load_allowed(tmp_path) == GAPS
    assert set(planted.load_json(tmp_path / ratchet.ALLOWED)) == {'$comment', 'gaps'}


def test_a_malformed_allowed_list_is_refused():
    with pytest.raises(ValueError, match=r'allowed-gaps\.json: "gaps" must map each item to a list of layers'):
        ratchet.read_allowed('{"gaps": {"6.05.00": "unit"}}')
