"""Test fixture for the shared/assist_jobs.py specs: a moto jobs table the module reads and writes."""
from __future__ import annotations

from collections.abc import Generator
from contextlib import contextmanager
from typing import Any
from unittest.mock import patch

from moto import mock_aws

from shared import assist_jobs
from shared.test.moto_tables import create_pk_sk_table


@contextmanager
def assist_jobs_table() -> Generator[Any, None, None]:
    """Yield a moto ``test-jobs`` table that ``shared.assist_jobs.get_jobs_table`` answers."""
    with mock_aws():
        created = create_pk_sk_table('test-jobs')
        with patch.object(assist_jobs, 'get_jobs_table', return_value=created):
            yield created
