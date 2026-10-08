"""
Shared pytest fixtures for shared module tests.
"""
import os
import sys

import pytest

# Add shared module to path
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# Set environment variables
os.environ['AWS_DEFAULT_REGION'] = 'us-east-1'
os.environ['POWERTOOLS_SERVICE_NAME'] = 'test-shared'


@pytest.fixture(autouse=True)
def _reset_image_model_client_cache():
    """Drop shared.avatar's cached region-pinned Bedrock clients between tests.

    That client is built once per execution environment (so a batch of personas
    doesn't rebuild it per avatar), which means the cache outlives a single
    test: without this, a test that patches `shared.avatar.boto3` would be
    handed a client another test built and its assertions on client creation
    would pass or fail for the wrong reason.

    Scoped to this directory, not the repo-root conftest. At root it ran for all ~1,400
    Python tests — processor, ingestors, stream, aggregator, none of which touch avatars —
    which made any future import-time problem in shared.avatar a collection error for the
    whole suite. That module deliberately keeps a narrow import graph (it has its own
    guard test that importing it must not pull in `cryptography`), so widening who depends
    on it importing cleanly is the opposite of what the module is built for.
    """
    from shared import avatar

    def _clear():
        with avatar._image_model_clients_lock:
            avatar._image_model_clients.clear()

    _clear()
    yield
    _clear()


@pytest.fixture
def reset_table_cache():
    """Drop shared.tables' cached Table resources before the test.

    The accessors cache one resource per env var for the life of the execution
    environment, so a test that patches `get_dynamodb_resource` or the table env
    vars would otherwise be served a table an earlier test built.
    """
    from shared import tables
    tables._cache.clear()
