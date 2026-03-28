"""
Shared utilities for VoC Lambda functions.

Import directly from submodules:
    from shared.logging import logger, tracer, metrics
    from shared.aws import get_dynamodb_resource, get_s3_client
    from shared.converse import converse, converse_chain
    from shared.exceptions import NotFoundError, ValidationError
    from shared.tables import get_feedback_table, get_projects_table
    from shared.jobs import job_handler, JobContext
    from shared.api import create_api_resolver, api_handler
    from shared.tokens import hash_token
"""
