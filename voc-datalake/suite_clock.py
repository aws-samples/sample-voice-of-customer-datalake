"""The pytest suite's clock: 12:00 UTC of the run's own day (used by conftest.py's pytest_configure hook)."""
import os
from collections.abc import MutableMapping
from datetime import UTC, datetime, time

# Set once by the controlling pytest process, so every pytest-xdist worker travels to the SAME noon even when
# the workers start on either side of midnight.
MIDDAY_ENV = 'VOC_TEST_MIDDAY'
# Optional, set by a person: travel to THIS noon instead of today's, to reproduce a run from another day.
MIDDAY_FORCE_ENV = 'VOC_TEST_MIDDAY_FORCE'


def midday_of(now: datetime) -> datetime:
    """12:00 UTC on ``now``'s UTC day: the farthest point from both midnights. ``now`` must be timezone-aware."""
    if now.tzinfo is None:
        raise ValueError('midday_of needs a timezone-aware datetime')
    return datetime.combine(now.astimezone(UTC).date(), time(12), tzinfo=UTC)


def parse_midday(name: str, value: str) -> datetime:
    """``value`` as a timezone-aware 12:00 UTC, or ValueError naming the variable it came from."""
    try:
        noon = datetime.fromisoformat(value)
    except ValueError as exc:
        raise ValueError(f'{name}={value!r} is not an ISO date-time') from exc
    if noon.tzinfo is None or midday_of(noon) != noon:
        raise ValueError(f'{name}={value!r} is not 12:00 UTC with a timezone')
    return noon


def controller_midday() -> datetime:
    """The noon the controlling process publishes: a forced one when a person set it, else today's."""
    forced = os.environ.get(MIDDAY_FORCE_ENV)
    return parse_midday(MIDDAY_FORCE_ENV, forced) if forced else midday_of(datetime.now(UTC))


def publish_midday(environ: MutableMapping[str, str]) -> datetime:
    """On the controller: (over)write ``MIDDAY_ENV`` with this run's noon, whatever a shell left there, and return it."""
    noon = controller_midday()
    environ[MIDDAY_ENV] = noon.isoformat()
    return noon


def suite_midday(*, require_published: bool = False) -> datetime:
    """The noon this run travels to: the controller's published one, else today's.

    A published value must be a timezone-aware 12:00 UTC, or the run stops (a stray shell variable must not move
    the suite to another time). ``require_published`` is for pytest-xdist workers: a worker that finds nothing
    published must not pick its own noon, or workers started on either side of midnight would split the day.
    """
    published = os.environ.get(MIDDAY_ENV)
    if not published:
        if require_published:
            raise RuntimeError(f'{MIDDAY_ENV} is not set: the controlling pytest process publishes it for its workers')
        return midday_of(datetime.now(UTC))
    return parse_midday(MIDDAY_ENV, published)
