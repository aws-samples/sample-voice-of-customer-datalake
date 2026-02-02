"""
Shared DynamoDB table accessors for VoC Lambda functions.
Provides centralized table access with connection reuse.
"""

import os
from shared.aws import get_dynamodb_resource

# Module-level cached table references
_jobs_table = None
_aggregates_table = None
_feedback_table = None
_projects_table = None


def get_jobs_table():
    """Get jobs table resource with connection reuse.
    
    Requires JOBS_TABLE environment variable to be set.
    
    Returns:
        DynamoDB Table resource or None if not configured
    """
    global _jobs_table
    if _jobs_table is None:
        table_name = os.environ.get('JOBS_TABLE', '')
        if table_name:
            _jobs_table = get_dynamodb_resource().Table(table_name)
    return _jobs_table


def get_aggregates_table():
    """Get aggregates table resource with connection reuse.
    
    Requires AGGREGATES_TABLE environment variable to be set.
    
    Returns:
        DynamoDB Table resource or None if not configured
    """
    global _aggregates_table
    if _aggregates_table is None:
        table_name = os.environ.get('AGGREGATES_TABLE', '')
        if table_name:
            _aggregates_table = get_dynamodb_resource().Table(table_name)
    return _aggregates_table


def get_feedback_table():
    """Get feedback table resource with connection reuse.
    
    Requires FEEDBACK_TABLE environment variable to be set.
    
    Returns:
        DynamoDB Table resource or None if not configured
    """
    global _feedback_table
    if _feedback_table is None:
        table_name = os.environ.get('FEEDBACK_TABLE', '')
        if table_name:
            _feedback_table = get_dynamodb_resource().Table(table_name)
    return _feedback_table


def get_projects_table():
    """Get projects table resource with connection reuse.
    
    Requires PROJECTS_TABLE environment variable to be set.
    
    Returns:
        DynamoDB Table resource or None if not configured
    """
    global _projects_table
    if _projects_table is None:
        table_name = os.environ.get('PROJECTS_TABLE', '')
        if table_name:
            _projects_table = get_dynamodb_resource().Table(table_name)
    return _projects_table


def clear_table_cache():
    """Clear all cached table references. Useful for testing."""
    global _jobs_table, _aggregates_table, _feedback_table, _projects_table
    _jobs_table = None
    _aggregates_table = None
    _feedback_table = None
    _projects_table = None
