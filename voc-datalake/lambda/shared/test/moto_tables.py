"""moto-backed DynamoDB tables in this app's key shapes, for tests that need
DynamoDB to really evaluate a condition expression (a mock cannot refuse a write).

Call these inside an active ``moto.mock_aws()`` context.
"""
import boto3


def create_pk_sk_table(table_name: str, resource=None):
    """Create an on-demand table keyed by ``pk`` (HASH) + ``sk`` (RANGE) — the
    shape of the projects and aggregates tables — and return it."""
    if resource is None:
        resource = boto3.resource('dynamodb', region_name='us-east-1')
    return resource.create_table(
        TableName=table_name,
        KeySchema=[
            {'AttributeName': 'pk', 'KeyType': 'HASH'},
            {'AttributeName': 'sk', 'KeyType': 'RANGE'},
        ],
        AttributeDefinitions=[
            {'AttributeName': 'pk', 'AttributeType': 'S'},
            {'AttributeName': 'sk', 'AttributeType': 'S'},
        ],
        BillingMode='PAY_PER_REQUEST',
    )


def create_aggregates_table_with_metric_index(table_name: str, resource=None):
    """voc-aggregates as in core-stack.ts: ``pk`` + ``sk`` plus the ``gsi1-by-metric-type`` index
    (``metric_type`` HASH, ``pk`` RANGE, all attributes projected)."""
    if resource is None:
        resource = boto3.resource('dynamodb', region_name='us-east-1')
    return resource.create_table(
        TableName=table_name, BillingMode='PAY_PER_REQUEST',
        KeySchema=[{'AttributeName': 'pk', 'KeyType': 'HASH'}, {'AttributeName': 'sk', 'KeyType': 'RANGE'}],
        AttributeDefinitions=[{'AttributeName': a, 'AttributeType': 'S'} for a in ('metric_type', 'pk', 'sk')],
        GlobalSecondaryIndexes=[{
            'IndexName': 'gsi1-by-metric-type', 'Projection': {'ProjectionType': 'ALL'},
            'KeySchema': [{'AttributeName': 'metric_type', 'KeyType': 'HASH'},
                          {'AttributeName': 'pk', 'KeyType': 'RANGE'}]}],
    )


def create_projects_table_with_meta(table_name: str, project_id: str = 'p1'):
    """A projects table holding one project's META row (no documents yet) —
    the starting state of the document-version allocation tests."""
    table = create_pk_sk_table(table_name)
    table.put_item(Item={
        'pk': f'PROJECT#{project_id}', 'sk': 'META', 'project_id': project_id, 'document_count': 0,
    })
    return table
