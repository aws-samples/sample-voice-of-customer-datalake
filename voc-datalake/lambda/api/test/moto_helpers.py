"""Builders shared by the moto-backed handler tests.

Call these inside an active ``mock_aws()`` context. The conftest
``api_gateway_event`` fixture serves fixture-injected tests; ``rest_event`` is
the plain-function equivalent for module-level helpers, and additionally carries
the ``requestContext.identity.sourceIp`` the public ballot routes read.
"""
from __future__ import annotations

import json
from collections.abc import Generator
from contextlib import ExitStack, contextmanager
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any
from unittest.mock import patch

import boto3
from moto import mock_aws

if TYPE_CHECKING:
    from mypy_boto3_dynamodb.service_resource import Table
    from mypy_boto3_dynamodb.type_defs import (
        AttributeDefinitionTypeDef,
        GlobalSecondaryIndexTypeDef,
        KeySchemaElementTypeDef,
    )


def _key_schema(hash_key: str, range_key: str) -> list[KeySchemaElementTypeDef]:
    return [
        {'AttributeName': hash_key, 'KeyType': 'HASH'},
        {'AttributeName': range_key, 'KeyType': 'RANGE'},
    ]


def pk_sk_table(name: str, *, gsi1_index: str | None = None) -> Table:
    """A pay-per-request table keyed on (pk, sk), optionally with a gsi1pk/gsi1sk index."""
    attributes = ['pk', 'sk'] + (['gsi1pk', 'gsi1sk'] if gsi1_index else [])
    attribute_definitions: list[AttributeDefinitionTypeDef] = [
        {'AttributeName': a, 'AttributeType': 'S'} for a in attributes
    ]
    dynamodb = boto3.resource('dynamodb', region_name='us-east-1')
    if not gsi1_index:
        return dynamodb.create_table(
            TableName=name,
            KeySchema=_key_schema('pk', 'sk'),
            AttributeDefinitions=attribute_definitions,
            BillingMode='PAY_PER_REQUEST',
        )
    gsi: GlobalSecondaryIndexTypeDef = {
        'IndexName': gsi1_index,
        'KeySchema': _key_schema('gsi1pk', 'gsi1sk'),
        'Projection': {'ProjectionType': 'ALL'},
    }
    return dynamodb.create_table(
        TableName=name,
        KeySchema=_key_schema('pk', 'sk'),
        AttributeDefinitions=attribute_definitions,
        BillingMode='PAY_PER_REQUEST',
        GlobalSecondaryIndexes=[gsi],
    )


def feedback_by_id_table(name: str = 'feedback') -> Table:
    """A (pk, sk) feedback table with the real ``gsi4-by-feedback-id`` index."""
    return boto3.resource('dynamodb', region_name='us-east-1').create_table(
        TableName=name,
        KeySchema=_key_schema('pk', 'sk'),
        AttributeDefinitions=[
            {'AttributeName': a, 'AttributeType': 'S'} for a in ('pk', 'sk', 'feedback_id')
        ],
        BillingMode='PAY_PER_REQUEST',
        GlobalSecondaryIndexes=[{
            'IndexName': 'gsi4-by-feedback-id',
            'KeySchema': [{'AttributeName': 'feedback_id', 'KeyType': 'HASH'}],
            'Projection': {'ProjectionType': 'ALL'},
        }],
    )


# The admin caller and the seeded feedback row the category-edit suites share.
CATEGORY_EDIT_ADMIN_CLAIMS = {'sub': 'sub-admin', 'cognito:groups': 'admins', 'cognito:username': 'ada'}
CATEGORY_EDIT_ITEM = {
    'pk': 'SOURCE#web', 'sk': 'FEEDBACK#f1', 'feedback_id': 'f1',
    'category': 'delivery', 'subcategory': 'late', 'original_text': 'late parcel',
    'gsi2pk': 'CATEGORY#delivery', 'gsi2sk': '-0.5#2026-01-01T00:00:00Z',
}


def seeded_category_edit_tables(item: dict, categories_config: dict) -> tuple[Table, Table]:
    """(feedback, aggregates) for category-edit tests: ``item`` in feedback (with the
    by-id index) and ``categories_config`` in aggregates. Call inside ``mock_aws()``."""
    feedback, aggregates = feedback_by_id_table(), pk_sk_table('aggregates')
    feedback.put_item(Item=item)
    aggregates.put_item(Item=categories_config)
    return feedback, aggregates


@contextmanager
def projects_module_world(bucket: str, *, also_shared_jobs: bool = False) -> Generator[tuple[Table, Table, Any], None, None]:
    """``(projects, jobs, s3)`` moto resources with the ``projects`` module wired to them (its table, jobs
    table, S3 client and ``RAW_DATA_BUCKET``); ``also_shared_jobs`` points ``shared.jobs`` at the jobs table too.
    Call inside ``mock_aws()``."""
    s3 = boto3.client('s3', region_name='us-east-1')
    s3.create_bucket(Bucket=bucket)
    projects, jobs = pk_sk_table('projects'), pk_sk_table('jobs')
    with ExitStack() as stack:
        stack.enter_context(patch('projects.projects_table', projects))
        stack.enter_context(patch('projects.get_jobs_table', return_value=jobs))
        stack.enter_context(patch('projects.get_s3_client', return_value=s3))
        if also_shared_jobs:
            stack.enter_context(patch('shared.jobs.get_jobs_table', return_value=jobs))
        stack.enter_context(patch.dict('os.environ', {'RAW_DATA_BUCKET': bucket}))
        yield projects, jobs, s3


def rest_event(method, path, *, claims, body=None, path_params=None):
    """An API Gateway REST proxy event for ``method path`` as the caller ``claims``."""
    return {
        'httpMethod': method,
        'path': path,
        'resource': path,
        'headers': {'Content-Type': 'application/json'},
        'requestContext': {
            'authorizer': {'claims': claims},
            'requestId': 'test-request', 'stage': 'test',
            'httpMethod': method, 'path': path,
            'identity': {'sourceIp': '1.2.3.4'},
        },
        'body': json.dumps(body) if body is not None else None,
        'queryStringParameters': None,
        'multiValueQueryStringParameters': None,
        'pathParameters': path_params,
        'stageVariables': None,
        'multiValueHeaders': {},
        'isBase64Encoded': False,
    }


def invoke(handler_module, event, context, **tables):
    """Run ``handler_module.lambda_handler`` with each ``get_<name>_table`` patched.

    ``invoke(projects_handler, event, ctx, aggregates=a, projects=p)`` patches
    ``get_aggregates_table`` and ``get_projects_table``; returns (status, body).
    """
    with ExitStack() as stack:
        for name, table in tables.items():
            stack.enter_context(
                patch.object(handler_module, f'get_{name}_table', return_value=table))
        response = handler_module.lambda_handler(event, context)
    return response['statusCode'], json.loads(response['body'])


def seed_project_personas(table: Table, project_id: str, personas: dict[str, dict[str, Any]]) -> None:
    """A project's META plus one persona row per ``{persona_id: attributes}`` (each gets a tagline from its name)."""
    table.put_item(Item={'pk': f'PROJECT#{project_id}', 'sk': 'META', 'project_id': project_id})
    for persona_id, attributes in personas.items():
        name = attributes['name']
        table.put_item(Item={'pk': f'PROJECT#{project_id}', 'sk': f'PERSONA#{persona_id}', 'persona_id': persona_id,
                             'tagline': f'The reviewed {name}', **attributes})


def project_personas(table: Table, project_id: str) -> dict[str, dict]:
    """The project's persona rows by persona id."""
    rows = table.query(
        KeyConditionExpression='pk = :pk AND begins_with(sk, :p)',
        ExpressionAttributeValues={':pk': f'PROJECT#{project_id}', ':p': 'PERSONA#'},
    )['Items']
    return {str(row['persona_id']): row for row in rows}


@dataclass
class PersonaWorld:
    """One project's personas in a mocked projects table (the persona generation suites)."""

    projects: Table
    project_id: str

    def personas(self) -> dict[str, dict]:
        return project_personas(self.projects, self.project_id)


@contextmanager
def mocked_projects_table(bucket: str) -> Generator[Table, None, None]:
    """The projects module wired to mocked tables and ``bucket``; yields the projects table."""
    with mock_aws(), projects_module_world(bucket) as (projects_table, _jobs, _s3):
        yield projects_table

