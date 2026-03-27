"""
Shared DynamoDB table accessors for VoC Lambda functions.
Provides centralized table access with connection reuse.
"""

import os
from shared.aws import get_dynamodb_resource

_cache: dict[str, object] = {}


def _get_table(env_var: str):
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


def get_conversations_table():
    """Get conversations table resource. Requires CONVERSATIONS_TABLE env var."""
    return _get_table('CONVERSATIONS_TABLE')


def clear_table_cache():
    """Clear all cached table references. Useful for testing."""
    _cache.clear()
