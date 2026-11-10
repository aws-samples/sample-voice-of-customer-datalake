"""shared.timestamps.now_iso: the one aware-UTC ISO timestamp writer (it replaced ten local copies)."""
from datetime import UTC, datetime, timedelta, timezone
from unittest.mock import patch

import pytest

from shared import timestamps
from shared.timestamps import ISO_DAY_RE, now_iso, parse_iso


def test_formats_a_given_moment_as_written():
    moment = datetime(2026, 10, 25, 9, 30, 0, 123456, tzinfo=UTC)
    assert now_iso(moment) == '2026-10-25T09:30:00.123456+00:00'
    local = datetime(2026, 10, 25, 11, 30, tzinfo=timezone(timedelta(hours=2)))
    assert now_iso(local) == '2026-10-25T11:30:00+02:00'


def test_defaults_to_one_utc_reading_of_now():
    before = datetime.now(UTC)
    parsed = datetime.fromisoformat(now_iso())
    assert parsed.utcoffset() == timedelta(0)
    assert timedelta(0) <= parsed - before < timedelta(seconds=5)


def test_reads_the_clock_in_utc_once():
    frozen = datetime(2026, 1, 2, 3, 4, 5, tzinfo=UTC)
    with patch.object(timestamps, 'datetime') as clock:
        clock.now.return_value = frozen
        assert now_iso() == '2026-01-02T03:04:05+00:00'
    clock.now.assert_called_once_with(UTC)


@pytest.mark.parametrize('value', [None, '', 7, b'2026-01-15', 'not a date', '2026-13-45T00:00:00'])
def test_parse_iso_refuses_what_is_not_a_timestamp(value):
    assert parse_iso(value) is None


def test_parse_iso_reads_a_naive_value_as_utc_and_keeps_an_offset():
    naive = parse_iso('2026-01-15T12:00:00')
    assert naive == datetime(2026, 1, 15, 12, tzinfo=UTC)
    assert naive is not None
    assert naive.tzinfo is UTC
    aware = parse_iso('2026-01-15T14:00:00+02:00')
    assert aware is not None
    assert aware.utcoffset() == timedelta(hours=2)
    assert aware == naive


@pytest.mark.parametrize(('value', 'ok'), [('2026-10-15', True), ('2026-10-15\n', False), ('2026-1-15', False),
                                           ('2026-10-15T00:00:00', False)])
def test_iso_day_is_exactly_ten_characters(value, ok):
    assert bool(ISO_DAY_RE.match(value)) is ok
