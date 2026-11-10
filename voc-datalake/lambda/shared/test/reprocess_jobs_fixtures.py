"""Arrange helpers shared by the `shared/reprocess_jobs.py` suites."""
from datetime import UTC, datetime

import pytest

from shared import reprocess_jobs as jobs

NOW = datetime(2026, 3, 1, 12, 0, tzinfo=UTC)


def present(item: dict | None) -> dict:
    """Fail the test unless a job operation returned an item, and hand it back narrowed."""
    if item is None:
        pytest.fail('expected the job operation to return an item, got None')
    return item


def start(table, now: datetime = NOW, **overrides) -> dict | None:
    """``start_job`` with a 30-day processed run by ``admin`` unless ``overrides`` say otherwise."""
    kwargs = {'mode': 'processed', 'days': 30, 'include_manual': False, 'started_by': 'admin'}
    kwargs.update(overrides)
    return jobs.start_job(table, now=now, **kwargs)
