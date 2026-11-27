"""``projects_handler`` (with api/projects.py and shared/jobs.py) on a test's moto tables: the patches a test needs
that sends a request through the handler on its job path, the async invoke doubled."""
from __future__ import annotations

from collections.abc import Generator
from contextlib import contextmanager
from typing import Any
from unittest.mock import MagicMock, patch


@contextmanager
def handler_on_tables(projects_table: Any, jobs_table: Any, aggregates_table: Any) -> Generator[MagicMock]:
    """The handler, the projects store and the job store on these tables; yields ``invoke_lambda_async``'s double."""
    import projects
    import projects_handler
    from shared import jobs

    with (
        patch.object(projects_handler, 'get_projects_table', return_value=projects_table),
        patch.object(projects_handler, 'get_aggregates_table', return_value=aggregates_table),
        patch.object(projects, 'projects_table', projects_table),
        patch.object(jobs, 'get_jobs_table', return_value=jobs_table),
        patch.object(projects_handler, 'get_jobs_table', return_value=jobs_table),
        patch.object(projects_handler, 'invoke_lambda_async') as invoke,
    ):
        yield invoke
