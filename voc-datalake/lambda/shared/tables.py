"""
Shared DynamoDB table accessors for VoC Lambda functions.
Provides centralized table access with connection reuse.
"""

import os
from typing import Any

from shared.aws import get_dynamodb_resource

# boto3 resources are built dynamically at runtime; typing these as the
# mypy_boto3 `Table` stub is a cross-module migration (every caller's
# Key/Item shapes would need TypedDicts), so they stay dynamically typed.
_cache: dict[str, Any] = {}


def _get_table(env_var: str) -> Any:
    """Get a DynamoDB table resource by env var name, with connection reuse."""
    if env_var not in _cache:
        table_name = os.environ.get(env_var, '')
        if table_name:
            _cache[env_var] = get_dynamodb_resource().Table(table_name)
    return _cache.get(env_var)


def get_jobs_table():
    """Get jobs table resource. Requires JOBS_TABLE env var."""
    return _get_table('JOBS_TABLE')


def get_aggregates_table():
    """Get aggregates table resource. Requires AGGREGATES_TABLE env var."""
    return _get_table('AGGREGATES_TABLE')


def get_feedback_table():
    """Get feedback table resource. Requires FEEDBACK_TABLE env var."""
    return _get_table('FEEDBACK_TABLE')


def get_projects_table():
    """Get projects table resource. Requires PROJECTS_TABLE env var."""
    return _get_table('PROJECTS_TABLE')
