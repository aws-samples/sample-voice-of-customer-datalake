"""
Pytest fixtures for custom resource handler tests.
"""
import os
import sys
from pathlib import Path
from unittest.mock import MagicMock

import pytest

# Make the handler module importable (it lives one directory above this one)
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

# boto3.client() at module import needs a region
os.environ['AWS_DEFAULT_REGION'] = 'us-east-1'


@pytest.fixture
def cognito(monkeypatch):
    """Mocked cognito client injected into admin_bootstrap (both of its suites)."""
    import admin_bootstrap  # lazy: only the admin_bootstrap suites need its real boto3 client

    from custom_resources.test.admin_bootstrap_fakes import UserNotFound

    client = MagicMock()
    client.exceptions.UserNotFoundException = UserNotFound
    monkeypatch.setattr(admin_bootstrap, 'cognito', client)
    return client
