"""The suite clock (voc-datalake/conftest.py): every test sees 12:00 UTC of the run's own day, still ticking."""
import os
from datetime import UTC, datetime, timedelta, timezone

import pytest
import time_machine
from suite_clock import MIDDAY_ENV, midday_of, suite_midday

IMPORTED_AT = datetime.now(UTC)


@pytest.mark.parametrize('now', [
    datetime(2026, 10, 29, 23, 59, 59, tzinfo=UTC),
    datetime(2026, 10, 30, 0, 0, 1, tzinfo=UTC),
    datetime(2026, 10, 30, 12, 0, tzinfo=UTC),
])
def test_midday_is_noon_utc_of_the_same_utc_day(now):
    assert midday_of(now) == datetime(now.year, now.month, now.day, 12, tzinfo=UTC)


def test_a_non_utc_time_is_read_on_its_utc_day():
    late_in_utc = datetime(2026, 10, 30, 1, 30, tzinfo=timezone(timedelta(hours=2)))  # 23:30 UTC on the 29th
    assert midday_of(late_in_utc) == datetime(2026, 10, 29, 12, tzinfo=UTC)


def test_a_naive_datetime_is_refused():
    with pytest.raises(ValueError, match='timezone-aware'):
        midday_of(datetime(2026, 10, 30, 12))  # noqa: DTZ001 - naive on purpose


def test_every_worker_shares_the_noon_the_controller_published(monkeypatch):
    monkeypatch.setenv(MIDDAY_ENV, '2026-10-29T12:00:00+00:00')
    assert suite_midday() == datetime(2026, 10, 29, 12, tzinfo=UTC)


def test_without_a_published_noon_the_run_takes_today_s(monkeypatch):
    monkeypatch.delenv(MIDDAY_ENV, raising=False)
    assert suite_midday() == midday_of(datetime.now(UTC))


def test_a_worker_without_a_published_noon_stops(monkeypatch):
    monkeypatch.delenv(MIDDAY_ENV, raising=False)
    with pytest.raises(RuntimeError, match='publishes it for its workers'):
        suite_midday(require_published=True)


@pytest.mark.parametrize('value', ['2026-10-29T12:00:00', '2026-10-29T09:00:00+00:00', 'not a date'])
def test_a_naive_off_noon_or_malformed_published_value_is_refused(monkeypatch, value):
    monkeypatch.setenv(MIDDAY_ENV, value)
    with pytest.raises(ValueError, match=r'is not 12:00 UTC|Invalid isoformat'):
        suite_midday()


def test_this_run_travelled_to_today_s_published_noon():
    # The controller overwrites any stale shell value with today's noon, so the published value and the
    # fake clock agree on the day.
    if MIDDAY_ENV not in os.environ:
        pytest.fail(f'{MIDDAY_ENV} is not set: the root voc-datalake/conftest.py was not loaded')
    published = datetime.fromisoformat(os.environ[MIDDAY_ENV])
    assert published == midday_of(datetime.now(UTC))


def test_a_module_level_now_is_taken_on_the_fake_clock_too():
    # pytest_configure travels BEFORE collection, so dates computed at import (this module's IMPORTED_AT)
    # are on the same day as dates computed inside a test.
    assert IMPORTED_AT.date() == datetime.now(UTC).date()
    assert IMPORTED_AT.hour >= 12


def test_tests_run_in_the_middle_of_the_utc_day():
    # Fails without the travelling clock (nothing travels). Reads only the FAKE clock: recomputing noon from
    # the real clock would jump a day when a run crosses midnight, the very case the clock exists for.
    # Assumes the run lasts under 11 hours of ticking time.
    assert time_machine.escape_hatch.is_travelling()
    assert 12 <= datetime.now(UTC).hour < 23
