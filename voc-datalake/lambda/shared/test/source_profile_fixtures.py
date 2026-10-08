"""Seed `shared.source_profiles`' container cache so ingestion tests never read DynamoDB.

Every producer resolves its source's profile through ``cached_source_profile``
(``shared/source_policy.py``). With ``AGGREGATES_TABLE`` set by the conftests that
would be a real ``GetItem``; seeding the cache stands in for the stored row.
"""
import os
from collections.abc import Iterator
from contextlib import contextmanager

from shared import source_profiles


@contextmanager
def seeded_source_profiles(profiles: list[dict] | None = None) -> Iterator[None]:
    """Serve ``profiles`` (default: none configured) from the cache for the block.

    Nests: the previous cache state comes back on exit, so a test can seed its
    own profiles inside an autouse "no profiles" seeding.
    """
    previous = dict(source_profiles._cache)
    previous_table = os.environ.get('AGGREGATES_TABLE')
    # The cache is consulted only when a table is configured.
    os.environ['AGGREGATES_TABLE'] = previous_table or 'test-aggregates'
    source_profiles._cache['profiles'] = list(profiles or [])
    source_profiles._cache['expires'] = float('inf')
    source_profiles._cache['failed'] = False
    try:
        yield
    finally:
        source_profiles._cache.update(previous)
        if previous_table is None:
            os.environ.pop('AGGREGATES_TABLE', None)
        else:
            os.environ['AGGREGATES_TABLE'] = previous_table


@contextmanager
def unreadable_source_profiles() -> Iterator[None]:
    """The cache holds a FAILED read for the block: lenient readers get defaults, strict ones raise."""
    with seeded_source_profiles():
        source_profiles._cache['failed'] = True
        yield


def unconfigured_upload_profile(_table: object, source_id: object = None) -> dict:
    """Stand-in for ``shared.ingest_archive.upload_profile`` with no profiles stored."""
    return source_profiles.profile_for([], source_id if isinstance(source_id, str) and source_id else 'manual_import')


def no_source_profiles() -> Iterator[None]:
    """Fixture body: "no profiles configured" for the whole test.

    Not decorated here, so each test module can register it under its own
    autouse fixture: ``_no_profiles = pytest.fixture(autouse=True)(no_source_profiles)``.
    """
    with seeded_source_profiles():
        yield
