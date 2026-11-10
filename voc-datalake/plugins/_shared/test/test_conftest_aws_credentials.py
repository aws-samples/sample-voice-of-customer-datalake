"""`plugins/conftest.py` replaces inherited AWS credentials with placeholders.

The conftest's environment block is the belt behind the autouse fixture that
refuses real AWS calls: if a call ever escapes that fixture, it must be signed
with placeholders that resolve to no account. A `setdefault` there kept whatever
the developer's shell or the CI runner exported, so in exactly the case the belt
exists for it was absent. The conftest is re-executed here with live-looking
values in the environment, which must not survive it.
"""
import os
import sys
from pathlib import Path
from unittest.mock import patch

import pytest

from _shared.test.fresh_import import load_fresh

CONFTEST = Path(__file__).resolve().parents[2] / 'conftest.py'

# Live-looking values a developer's shell might export; none may survive.
INHERITED = {
    'AWS_ACCESS_KEY_ID': 'inherited-access-key-example',
    'AWS_SECRET_ACCESS_KEY': 'inherited-secret-example',
    'AWS_SESSION_TOKEN': 'inherited-session-example',
    'AWS_SECURITY_TOKEN': 'inherited-security-example',
    'AWS_EC2_METADATA_DISABLED': 'false',
    'AWS_CONFIG_FILE': '/home/dev/.aws/config',
    'AWS_SHARED_CREDENTIALS_FILE': '/home/dev/.aws/credentials',
}

EXPECTED = {
    'AWS_ACCESS_KEY_ID': 'testing',
    'AWS_SECRET_ACCESS_KEY': 'testing',
    'AWS_SESSION_TOKEN': 'testing',
    'AWS_SECURITY_TOKEN': 'testing',
    'AWS_EC2_METADATA_DISABLED': 'true',
    'AWS_CONFIG_FILE': os.devnull,
    'AWS_SHARED_CREDENTIALS_FILE': os.devnull,
}


@pytest.fixture
def rerun_conftest():
    """Re-execute the conftest as a session start would; its `sys.path` inserts are undone afterwards."""
    original_path = list(sys.path)
    yield lambda: load_fresh('_shared.test._conftest_rerun', CONFTEST)
    sys.path[:] = original_path


@pytest.mark.parametrize('name', sorted(EXPECTED))
def test_an_inherited_aws_setting_is_replaced_by_the_placeholder(rerun_conftest, name):
    with patch.dict(os.environ, INHERITED):
        rerun_conftest()
        assert os.environ[name] == EXPECTED[name], (
            f'{name} kept the inherited value; plugin tests could sign a '
            'request with real credentials'
        )


def test_an_inherited_profile_is_discarded(rerun_conftest):
    with patch.dict(os.environ, {'AWS_PROFILE': 'dev', 'AWS_DEFAULT_PROFILE': 'dev'}):
        rerun_conftest()
        assert 'AWS_PROFILE' not in os.environ
        assert 'AWS_DEFAULT_PROFILE' not in os.environ
