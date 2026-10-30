"""The pytest suite's clock: 12:00 UTC of the run's own day (used by conftest.py's session fixture)."""
import os
from datetime import UTC, datetime, time

# Set once by the controlling pytest process, so every pytest-xdist worker travels to the SAME noon even when
# the workers start on either side of midnight.
MIDDAY_ENV = 'VOC_TEST_MIDDAY'


def midday_of(now: datetime) -> datetime:
    """12:00 UTC on ``now``'s UTC day: the farthest point from both midnights. ``now`` must be timezone-aware."""
    if now.tzinfo is None:
        raise ValueError('midday_of needs a timezone-aware datetime')
    return datetime.combine(now.astimezone(UTC).date(), time(12), tzinfo=UTC)


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
    noon = datetime.fromisoformat(published)
    if noon.tzinfo is None or midday_of(noon) != noon:
        raise ValueError(f'{MIDDAY_ENV}={published!r} is not 12:00 UTC with a timezone')
    return noon
