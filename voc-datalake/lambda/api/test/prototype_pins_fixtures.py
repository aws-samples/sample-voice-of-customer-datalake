"""Shared pieces of the prototype pin and feedback route tests: the tables with a private project, and one call of
the projects API on them."""
import json
from collections.abc import Generator
from contextlib import contextmanager
from typing import Any
from unittest.mock import patch

from moto import mock_aws
from moto_helpers import pk_sk_table


@contextmanager
def project_tables(project_id: str, members: dict) -> Generator[tuple[Any, Any]]:
    """Moto's projects and aggregates tables, with a private project owned by ``owner-sub`` and ``members``
    (sub → {role, username})."""
    with mock_aws():
        projects = pk_sk_table('test-projects')
        aggregates = pk_sk_table('test-aggregates')
        projects.put_item(Item={
            'pk': f'PROJECT#{project_id}', 'sk': 'META', 'project_id': project_id, 'name': 'P', 'status': 'active',
            'owner_sub': 'owner-sub', 'visibility': 'private', 'members': members,
        })
        yield projects, aggregates


def call_projects_api(projects, aggregates, event, lambda_context) -> tuple[int, dict]:
    """The projects API's answer to ``event`` on these tables: its status and JSON body."""
    import projects_handler
    with (
        patch.object(projects_handler, 'get_projects_table', return_value=projects),
        patch.object(projects_handler, 'get_aggregates_table', return_value=aggregates),
    ):
        response = projects_handler.lambda_handler(event, lambda_context)
    return response['statusCode'], json.loads(response['body'])
