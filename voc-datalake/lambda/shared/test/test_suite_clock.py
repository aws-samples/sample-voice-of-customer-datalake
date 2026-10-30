"""The suite clock (voc-datalake/conftest.py): every test sees 12:00 UTC of the run's own day, still ticking."""
import os
from datetime import UTC, datetime, timedelta, timezone

import pytest
import time_machine
from suite_clock import MIDDAY_ENV, MIDDAY_FORCE_ENV, controller_midday, midday_of, publish_midday, suite_midday

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
    with pytest.raises(ValueError, match=r'is not 12:00 UTC|is not an ISO date-time'):
        suite_midday()


def test_this_run_travelled_to_today_s_published_noon():
    # Against the REAL clock: the published noon is the real UTC day's (12 hours before it to 23 hours after,
    # allowing a run that crosses midnight). This alone cannot tell yesterday's noon from today's in the first
    # 11 hours of a day; the overwrite itself is pinned by test_the_controller_overwrites_a_stale_noon.
    if MIDDAY_ENV not in os.environ:
        pytest.fail(f'{MIDDAY_ENV} is not set: the root voc-datalake/conftest.py was not loaded')
    if os.environ.get(MIDDAY_FORCE_ENV):
        pytest.skip(f'{MIDDAY_FORCE_ENV} is set: this run reproduces another day on purpose')
    published = datetime.fromisoformat(os.environ[MIDDAY_ENV])
    real_now = time_machine.escape_hatch.datetime.datetime.now(UTC)
    assert timedelta(hours=-12) <= real_now - published < timedelta(hours=23)


def test_a_forced_noon_is_what_the_controller_publishes(monkeypatch):
    monkeypatch.setenv(MIDDAY_FORCE_ENV, '2026-03-01T12:00:00+00:00')
    assert controller_midday() == datetime(2026, 3, 1, 12, tzinfo=UTC)


def test_without_a_forced_noon_the_controller_takes_midday_of_now(monkeypatch):
    monkeypatch.delenv(MIDDAY_FORCE_ENV, raising=False)
    assert controller_midday() == midday_of(datetime.now(UTC))


def test_the_controller_overwrites_a_stale_noon():
    environ = {MIDDAY_ENV: '2020-01-01T12:00:00+00:00'}
    assert publish_midday(environ) == midday_of(datetime.now(UTC))
    assert environ[MIDDAY_ENV] == midday_of(datetime.now(UTC)).isoformat()


def test_publishing_reads_the_forced_noon_from_the_same_mapping():
    environ = {MIDDAY_FORCE_ENV: '2026-03-01T12:00:00+00:00'}
    assert publish_midday(environ) == datetime(2026, 3, 1, 12, tzinfo=UTC)
    assert environ[MIDDAY_ENV] == '2026-03-01T12:00:00+00:00'


def test_a_malformed_forced_noon_names_its_variable(monkeypatch):
    monkeypatch.setenv(MIDDAY_FORCE_ENV, 'tomorrow')
    with pytest.raises(ValueError, match=f'{MIDDAY_FORCE_ENV}=.* is not an ISO date-time'):
        controller_midday()


def test_a_forced_noon_that_is_not_noon_is_refused(monkeypatch):
    monkeypatch.setenv(MIDDAY_FORCE_ENV, '2026-03-01T23:59:00+00:00')
    with pytest.raises(ValueError, match=f'{MIDDAY_FORCE_ENV}=.* is not 12:00 UTC'):
        controller_midday()


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
