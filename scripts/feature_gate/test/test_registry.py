"""The registry's files, slices and schema."""
from __future__ import annotations

from pathlib import Path
from typing import Any

import planted
import pytest
from feature_gate import registry


@pytest.mark.parametrize(('version', 'name'), [
    ('6.05.00', 'phase1-2'), ('7.14.00', 'phase1-2'), ('7.15.00', 'phase3a-4'), ('7.49.00', 'phase3a-4'),
    ('7.50.00', 'product-7.5x-7.7x'), ('7.75.03', 'product-7.5x-7.7x'), ('7.76.00', 'phase3-switch'),
    ('7.104.00', 'phase3-switch'),
])
def test_a_version_belongs_to_one_slice(version: str, name: str):
    assert registry.slice_for(version).name == name


def test_versions_compare_by_number_not_text():
    assert registry.parse_version('7.100.00') > registry.parse_version('7.99.00')
    assert registry.semver('7.05.00') == '7.5.0'
    for bad in ('7.5', '7.05.00\n', ' 7.05.00'):
        with pytest.raises(ValueError, match='not a release'):
            registry.parse_version(bad)


def test_a_slice_file_round_trips(repo: Path):
    loaded = registry.load(repo)
    assert [it['id'] for it in loaded.items] == ['6.05.00', '7.75.01', '7.76.00']
    assert loaded.slice_of['7.76.00'].name == 'phase3-switch'
    assert loaded.problems == []
    data = planted.load_json(repo / 'docs/feature-tests/phase1-2.json')
    assert (data['slice'], data['from'], data['until']) == ('phase1-2', '6.05.00', '7.15.00')


def test_malformed_json_is_a_problem_not_a_traceback(repo: Path):
    planted.write(repo, 'docs/feature-tests/phase1-2.json', '{"slice": "phase1-2", "items": [')
    loaded = registry.load(repo)
    assert [it['id'] for it in loaded.items] == ['7.75.01', '7.76.00']
    assert len(loaded.problems) == 1
    assert loaded.problems[0].startswith('docs/feature-tests/phase1-2.json: not JSON')


def test_items_must_be_a_list_of_objects(repo: Path):
    planted.write(repo, 'docs/feature-tests/phase1-2.json', '{"slice": "phase1-2", "items": [3]}')
    assert registry.load(repo).problems == ['docs/feature-tests/phase1-2.json: "items" must be a list of objects']


def problems_of(entry: dict[str, Any]) -> list[str]:
    return registry.item_problems(entry)


def test_a_seeded_item_has_no_schema_problem():
    assert problems_of(planted.item('7.76.00', 'feature')) == []


@pytest.mark.parametrize(('change', 'message'), [
    ({'kind': 'big'}, 'kind must be one of'),
    ({'status': 'shipped'}, 'status must be one of'),
    ({'unit': 'x'}, 'unit must be a list'),
    ({'aliases': [3]}, 'aliases must be a list of strings'),
    ({'source': {'changelog': '7.76.00'}}, 'source must be {changelog, doc}'),
    ({'exemption': {'layer': 'e2e'}}, 'exemption must have exactly'),
    ({'id': '../7.76.00'}, 'id must be'),
    ({'id': '7.76.00/Big Slice'}, 'id must be'),
])
def test_schema_problems_name_the_field(change: dict[str, Any], message: str):
    found = problems_of(planted.item('7.76.00', 'feature') | change)
    assert len(found) == 1, found
    assert found[0].startswith(message), found


@pytest.mark.parametrize('good', ['7.76.00', '7.76.00/card-menu', 'plan-3h-s4', 'plan-3h-s4/ui'])
def test_good_ids(good: str):
    assert problems_of(planted.item('7.76.00', 'feature') | {'id': good}) == []


def test_a_missing_key_is_a_problem():
    entry = planted.item('7.76.00', 'feature')
    del entry['e2e']
    assert problems_of(entry) == ["missing key 'e2e'"]


def exemption(**change: Any) -> dict[str, Any]:
    base = {'layer': 'e2e', 'kind': 'no-user-flow', 'reason': 'An internal key.', 'proposed_by': 'h2/a',
            'reviewed_by': 'r/1', 'reviewed_at': '8c345fb96'}
    return base | change


@pytest.mark.parametrize(('change', 'ok'), [
    ({}, True),
    ({'reviewed_by': None, 'reviewed_at': None}, True),   # proposed, not reviewed yet
    ({'reviewed_by': 'r/1', 'reviewed_at': None}, False),  # half a review
    ({'layer': 'unit'}, False),          # no-user-flow speaks of the e2e layer only
    ({'reviewed_by': ''}, False),
    ({'reviewed_at': 'yesterday'}, False),
    ({'reviewed_at': '8c345fb96\n'}, False),
    ({'reason': ' '}, False),
    ({'proposed_by': 'not a session'}, False),
    ({'kind': 'platform-only', 'layer': 'all'}, True),
    ({'kind': 'mac-only', 'layer': 'all'}, False),   # the old name (P-6): platform-only now
])
def test_an_exemption_names_its_proposer_and_its_review(change: dict[str, Any], ok: bool):
    found = problems_of(planted.item('7.76.00', 'feature', exemption=exemption(**change)))
    assert (found == []) is ok, found


def test_a_no_behaviour_exemption_fits_only_an_item_without_behaviour():
    ex = exemption(kind='no-behaviour', layer='all')
    assert problems_of(planted.item('7.75.01', 'no-behaviour', exemption=ex)) == []
    assert problems_of(planted.item('7.76.00', 'feature', exemption=ex)) == [
        'exemption no-behaviour fits only a no-behaviour or plumbing item']


def test_kinds_are_ranked():
    assert [registry.KIND_RANK[k] for k in ('feature', 'fix', 'plumbing', 'no-behaviour')] == [3, 2, 1, 0]


def test_session_ids_and_roots():
    assert registry.session_root('h2/sub-1') == 'h2'
    assert registry.is_session('h2/sub-1')
    for bad in ('', 'a b', 'h2/', '/h2', 'h2\n'):
        assert not registry.is_session(bad), bad


def test_save_slice_keeps_items_in_version_order(tmp_path: Path):
    sl = registry.slice_for('7.76.00')
    registry.save_slice(tmp_path, sl, [planted.item('7.100.00', 'feature'), planted.item('7.99.00', 'fix')])
    data = planted.load_json(tmp_path / sl.file)
    assert [it['id'] for it in data['items']] == ['7.99.00', '7.100.00']


def test_a_registry_is_read_from_texts_too():
    sl = registry.slice_for('7.76.00')
    text = '{"slice": "phase3-switch", "items": [{"id": "7.76.00"}]}'
    reg = registry.from_texts({sl.file: text})
    assert list(reg.by_id) == ['7.76.00']
    assert reg.problems == []


@pytest.mark.parametrize(('version', 'after'), [
    (None, False), ('plan-3h-s4', False), ('7.104.00', False), ('7.104.99', False), ('7.105.00', False),
    ('7.105.01', True), ('7.106.00', True), ('8.00.00', True), ('7.105.0', False), ('7.106.000', False),
    ('07.106.00', False)])
def test_after_the_gate_at_its_boundary(version: str | None, after: bool):
    assert registry.after_gate(version) is after


@pytest.mark.parametrize(('version', 'canonical'), [('7.105.000', '7.105.00'), ('07.105.00', '7.105.00'),
                                                    ('7.0105.00', '7.105.00')])
def test_a_version_not_in_canonical_two_digit_form_is_no_release(version: str, canonical: str):
    assert not registry.is_release(version)
    assert registry.item_problems(planted.item(version, 'feature')) == [
        f'id {version} is not a release number in canonical form ({canonical})']
