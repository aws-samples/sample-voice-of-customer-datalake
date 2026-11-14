"""Property tests of what an Incorporate pass may select from (shared/prototype_feedback.py ``series_pins``).

The rule, in words: the pins a pass can take are exactly the pins the Feedback view lists for the series: every
status, of the newest 25 versions only, each carrying the version it was left on (whatever the stored pin says);
a prototype row outside any series is its own version (its number, else 1).
"""
from __future__ import annotations

from decimal import Decimal
from typing import Any
from unittest.mock import patch

import pytest
from hypothesis import given
from hypothesis import strategies as st

from shared import prototype_feedback as feedback
from shared import prototype_pins
from shared.test.property_settings import PROPERTY

PINS_PER_VERSION = st.lists(st.integers(0, 3), min_size=1, max_size=32)


def _run(series: list[dict], head: dict, counts: dict[str, int]) -> tuple[list[dict], list[tuple]]:
    forms = {prototype_pins.pin_form_id(row['document_id']): row['document_id'] for row in [*series, head]}
    calls: list[tuple] = []

    def list_pins(_table: Any, form_id: str, status: str | None = None) -> list[dict]:
        document_id = forms[form_id]
        calls.append((document_id, status))
        return [{'pin_id': f'pin_{document_id}x{n}', 'document_id': 'stale', 'version': 99, 'status': status_n}
                for n, status_n in zip(range(counts.get(document_id, 0)), ['open', 'addressed', 'resolved'] * 2,
                                       strict=False)]

    with (patch.object(feedback, 'series_versions', return_value=series) as versions,
          patch.object(prototype_pins, 'list_pins', side_effect=list_pins)):
        pins = feedback.series_pins('projects', 'pins', 'proj_1', head)
    versions.assert_called_once_with('projects', 'proj_1', head)
    return pins, calls


class TestAPassSelectsFromTheNewestVersionsPinsOnly:
    """Invariant: the pins are those of the newest 25 versions of the series, newest version first, of every status
    (no status filter), each one's document_id and version the version it was left on."""

    @PROPERTY
    @given(counts=PINS_PER_VERSION)
    def test_the_newest_twenty_five_versions_every_status_each_pin_its_version(self, counts: list[int]) -> None:
        size = len(counts)
        series = [{'document_id': f'v{n}', 'version': Decimal(n)} for n in range(size, 0, -1)]
        by_doc = {row['document_id']: count for row, count in zip(series, counts, strict=True)}
        pins, calls = _run(series, {'document_id': series[0]['document_id']}, by_doc)
        read = series[:25]
        assert calls == [(row['document_id'], None) for row in read]
        assert [(pin['pin_id'], pin['document_id'], pin['version']) for pin in pins] == [
            (f"pin_{row['document_id']}x{n}", row['document_id'], int(row['version']))
            for row in read for n in range(by_doc[row['document_id']])]
        assert all(type(pin['version']) is int for pin in pins)

    @PROPERTY
    @given(version=st.one_of(st.none(), st.integers(1, 40).map(Decimal), st.just(True)), count=st.integers(0, 3),
           series=st.lists(st.sampled_from(['other_a', 'other_b']), unique=True, max_size=2))
    def test_a_row_outside_any_series_is_its_own_version(self, version, count: int, series: list[str]) -> None:
        head = {'document_id': 'lone', **({} if version is None else {'version': version})}
        rows = [{'document_id': document_id, 'version': Decimal(n)} for n, document_id in enumerate(series, start=1)]
        pins, calls = _run(rows, head, {'lone': count})
        own = int(version) if isinstance(version, Decimal) else 1
        assert calls == [('lone', None)]
        assert [(pin['document_id'], pin['version']) for pin in pins] == [('lone', own)] * count


# ── Positions, the order pins are taken in, and the series read's partial mark ──────────────────────────────

SIDES = ('x', 'y', 'w', 'h')
JUNK = st.one_of(st.none(), st.booleans(), st.text(max_size=3), st.just([1]), st.just({'v': 1}))
SIDE = st.one_of(st.integers(0, 100), st.integers(0, 100).map(Decimal), st.integers(0, 200).map(lambda n: n / 2))


def _point(x: float, y: float, route: str = '/r') -> dict:
    return {'anchor': {'route': route, 'selector': '', 'bbox': {'x': x, 'y': y, 'w': 0, 'h': 0}}}


def _side(sides: dict, key: str) -> float:
    value = sides.get(key)
    return float(value) if isinstance(value, int | float | Decimal) and not isinstance(value, bool) else 0.0


class TestABoxIsAtItsCentre:
    """Invariant: a selector-less pin's position is its box centre, (x + w / 2, y + h / 2) in percent of the
    viewport, a side that is missing or not a number counting as 0; another pin is at the same position exactly
    when both centres are within 5 points on each axis (5 is in, 5.5 is out)."""

    @PROPERTY
    @given(sides=st.fixed_dictionaries({}, optional={key: st.one_of(SIDE, JUNK) for key in SIDES}))
    def test_the_centre_and_its_five_point_neighbourhood(self, sides: dict) -> None:
        box = {'anchor': {'route': '/r', 'selector': '', 'bbox': sides}}
        cx, cy = _side(sides, 'x') + _side(sides, 'w') / 2, _side(sides, 'y') + _side(sides, 'h') / 2
        assert feedback.same_position(box, _point(cx, cy))
        for dx, dy in ((5, 0), (-5, 0), (0, 5), (0, -5), (5, 5), (-5, -5)):
            assert feedback.same_position(box, _point(cx + dx, cy + dy)), (dx, dy)
            assert feedback.same_position(_point(cx + dx, cy + dy), box), (dx, dy)
        for dx, dy in ((5.5, 0), (-5.5, 0), (0, 5.5), (0, -5.5)):
            assert not feedback.same_position(box, _point(cx + dx, cy + dy)), (dx, dy)
        assert not feedback.same_position(box, _point(cx, cy, route='/other'))

    def test_a_missing_side_is_zero_not_one(self) -> None:
        lacking_x = {'anchor': {'route': '/r', 'selector': '', 'bbox': {'y': 0, 'w': 0, 'h': 0}}}
        assert feedback.same_position(lacking_x, _point(5, 0))
        assert feedback.same_position(lacking_x, _point(-5, 0))
        assert not feedback.same_position(lacking_x, _point(5.5, 0))


class TestTheFivePercentIsComparedToSixPlaces:
    """Invariant: the centres' distance is rounded to 6 decimal places of the viewport before it meets the 5 %
    tolerance, on each axis: 0.0500004 is 0.05 (in), 0.050001 is over (out)."""

    @pytest.mark.parametrize(('offset', 'same'), [(5.00004, True), (5.0001, False)])
    def test_each_axis(self, offset: float, same: bool) -> None:
        assert feedback.same_position(_point(0, 0), _point(offset, 0)) is same
        assert feedback.same_position(_point(0, 0), _point(0, offset)) is same


TIMES = [f'2026-11-13T10:0{n}:00+00:00' for n in range(4)]
TEXTS = ['The total is hidden', 'the TOTAL is hidden!', 'The pay button is broken']
PIN = st.tuples(st.sampled_from(['p1', 'p2', 'p3']), st.sampled_from(TIMES), st.sampled_from(TEXTS),
                st.sampled_from(['', '#total']), st.sampled_from(['doc_v1', 'doc_v2']), st.sampled_from([10, 30]),
                st.sampled_from(['/r', '/s']))
PINS = st.lists(PIN, max_size=7, unique_by=lambda row: (row[0], row[4]))
STRAY_KEYS = st.sampled_from([None, 'ROUTE', 'XXrouteXX', 'SELECTOR', 'XXselectorXX', 'CREATED_AT',
                              'XXcreated_atXX', 'DOCUMENT_ID', 'XXdocument_idXX', 'PIN_ID'])
STRAYS = st.dictionaries(STRAY_KEYS, st.sampled_from(['', 'a', 'zzz']), max_size=4)


def _stored(row: tuple, strays: dict | None = None, anchor_strays: dict | None = None) -> dict:
    pin_id, at, text, selector, document_id, x, route = row
    return {'pin_id': pin_id, 'created_at': at, 'comment': text, 'status': 'open', 'flagged': False,
            'document_id': document_id, 'version': int(document_id[-1]), 'replies': [],
            'anchor': {'route': route, 'selector': selector, 'text_snippet': 'Total',
                       'bbox': {'x': x, 'y': 10, 'w': 0, 'h': 0}, **(anchor_strays or {})},
            **(strays or {})}


class TestTheSamePinsInAnyOrderGiveTheSameAnswer:
    """Invariant: the answer depends on the pins, never on the order they come in, even when two versions'
    pins share an id and a time (the document id settles the tie)."""

    @PROPERTY
    @given(data=st.data(), rows=PINS)
    def test_any_permutation(self, data: st.DataObject, rows: list[tuple]) -> None:
        shuffled = data.draw(st.permutations(rows))
        assert feedback.group_pins([_stored(row) for row in shuffled]) == feedback.group_pins(
            [_stored(row) for row in rows])

    def test_two_versions_pins_with_one_id_and_time_fold_in_document_order(self) -> None:
        rows = [('p1', TIMES[0], TEXTS[0], '#total', doc, 10, '/r') for doc in ('doc_v2', 'doc_v1')]
        for order in (rows, rows[::-1]):
            [group] = feedback.group_pins([_stored(row) for row in order])
            [item] = group['items']
            assert [(pin['document_id'], pin['version']) for pin in item['pins']] == [('doc_v1', 1), ('doc_v2', 2)]


class TestAnItemStartsAtItsEarliestPin:
    """Invariant: an item's pins are listed oldest first (then by id, then by version's document), its first pin is
    the oldest, and the item is named and dated by that first pin, whatever the pins' ids."""

    @PROPERTY
    @given(rows=PINS)
    def test_oldest_first(self, rows: list[tuple]) -> None:
        for group in feedback.group_pins([_stored(row) for row in rows]):
            for item in group['items']:
                keys = [(pin['created_at'], pin['pin_id'], pin['document_id']) for pin in item['pins']]
                assert keys == sorted(keys)
                assert item['first_at'] == keys[0][0]
                assert item['item_id'] == item['pin_ids'][0] == keys[0][1]

    def test_the_later_pin_with_the_smaller_id_folds_into_the_earlier_one(self) -> None:
        rows = [('p2', TIMES[0], TEXTS[0], '', 'doc_v1', 10, '/r'), ('p1', TIMES[1], TEXTS[1], '', 'doc_v1', 10, '/r')]
        [group] = feedback.group_pins([_stored(row) for row in rows])
        assert [(item['item_id'], item['first_at'], item['pin_ids'], item['text']) for item in group['items']] == [
            ('p2', TIMES[0], ['p2', 'p1'], TEXTS[0])]


class TestOnlyThePinsOwnFieldsCount:
    """Invariant: keys a pin or its anchor carries beyond the ones the feedback reads (other spellings, other
    cases, a key that is not a string) never change the answer."""

    @PROPERTY
    @given(data=st.data(), rows=PINS)
    def test_stray_keys(self, data: st.DataObject, rows: list[tuple]) -> None:
        strayed = [_stored(row, data.draw(STRAYS), data.draw(STRAYS)) for row in rows]
        assert feedback.group_pins(strayed) == feedback.group_pins([_stored(row) for row in rows])


def _read(versions: int) -> dict:
    series = [{'document_id': f'doc_v{n}', 'version': Decimal(n)} for n in range(versions, 0, -1)]
    with (patch.object(feedback, 'series_versions', return_value=series),
          patch.object(prototype_pins, 'list_pins', return_value=[])):
        return feedback.read_feedback('projects', 'pins', 'proj_1', {'document_id': series[0]['document_id']})


class TestOneUnreadVersionIsPartial:
    """Invariant: the answer is partial as soon as one version of the series is left unread."""

    @pytest.mark.parametrize(('versions', 'partial', 'unread'), [(25, False, 0), (26, True, 1), (27, True, 2)])
    def test_the_limit_and_one_over(self, versions: int, partial: bool, unread: int) -> None:
        answer = _read(versions)
        assert (answer['partial'], answer['older_versions_unread'], answer['cut']) == (partial, unread, [])
