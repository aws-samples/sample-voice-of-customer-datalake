"""The whole owned-artifact lifecycle of a project delete, against real services.

`test_projects.py` holds the projects-partition request SHAPE against a MagicMock
table. That is the one thing a mock is good for and the one thing it cannot answer
here: whether the sweep actually EMPTIED what it swept. Two of the artifacts a
project owns live outside its DynamoDB partition and were previously left behind:

  * **job rows**, in their own table. They sat there until their TTL — up to 30
    days, seven for a completed or failed one — so recreating a project id showed a
    stranger's job history and the panel polled work with no project.
  * **prototype HTML**, in S3 under `prototypes/{project_id}/`. Deleting the
    `PROTOTYPE#` rows left the objects, so links minted before the delete resolved
    for the rest of their signature TTL and the bytes were billed indefinitely.

moto rather than a fake: pagination (`LastEvaluatedKey`, `IsTruncated` /
`NextContinuationToken`) and `delete_objects`' partial-failure envelope are exactly
what a hand-rolled fake would get to define for itself.
"""
import os
from unittest.mock import patch

import boto3
import pytest
from boto3.dynamodb.conditions import Key
from moto import mock_aws
from shared.document_versions import version_partition_key
from shared.project_writes import PROJECT_DELETION_ATTRIBUTE
from shared.prototypes import prototype_s3_key

BUCKET = 'test-raw-data-bucket'
PROJECT = 'proj-1'
NEIGHBOUR = 'proj-10'


def _key_schema() -> dict:
    return {
        'KeySchema': [
            {'AttributeName': 'pk', 'KeyType': 'HASH'},
            {'AttributeName': 'sk', 'KeyType': 'RANGE'},
        ],
        'AttributeDefinitions': [
            {'AttributeName': 'pk', 'AttributeType': 'S'},
            {'AttributeName': 'sk', 'AttributeType': 'S'},
        ],
        'BillingMode': 'PAY_PER_REQUEST',
    }


@pytest.fixture
def deployment():
    """A projects table, a jobs table and a prototypes bucket, all populated."""
    with mock_aws():
        dynamodb = boto3.resource('dynamodb', region_name='us-east-1')
        projects = dynamodb.create_table(TableName='test-projects', **_key_schema())
        jobs = dynamodb.create_table(TableName='test-jobs', **_key_schema())
        s3 = boto3.client('s3', region_name='us-east-1')
        s3.create_bucket(Bucket=BUCKET)

        projects.put_item(Item={
            'pk': f'PROJECT#{PROJECT}', 'sk': 'META',
            'project_id': PROJECT, 'name': 'Doomed', 'document_count': 2,
        })
        projects.put_item(Item={
            'pk': f'PROJECT#{PROJECT}', 'sk': 'PERSONA#persona_1',
            'persona_id': 'persona_1',
        })
        for index in (1, 2):
            projects.put_item(Item={
                'pk': f'PROJECT#{PROJECT}', 'sk': f'PROTOTYPE#proto_{index}',
                'document_id': f'proto_{index}', 'document_type': 'prototype',
            })
            s3.put_object(
                Bucket=BUCKET,
                Key=prototype_s3_key(PROJECT, f'proto_{index}'),
                Body=b'<html>prototype</html>',
            )
        projects.put_item(Item={
            'pk': version_partition_key(PROJECT), 'sk': 'PROTOTYPE#counter',
            'last_version': 2,
        })
        for index in (1, 2, 3):
            jobs.put_item(Item={
                'pk': f'PROJECT#{PROJECT}', 'sk': f'JOB#job_{index}',
                'job_id': f'job_{index}', 'status': 'completed',
            })

        # A neighbour whose id has this project's id as a prefix, plus its own
        # job row. Nothing below may touch either.
        projects.put_item(Item={
            'pk': f'PROJECT#{NEIGHBOUR}', 'sk': 'META',
            'project_id': NEIGHBOUR, 'name': 'Innocent',
        })
        s3.put_object(
            Bucket=BUCKET,
            Key=prototype_s3_key(NEIGHBOUR, 'proto_9'),
            Body=b'<html>neighbour</html>',
        )
        jobs.put_item(Item={
            'pk': f'PROJECT#{NEIGHBOUR}', 'sk': 'JOB#job_9', 'job_id': 'job_9',
        })

        import projects as projects_module

        # The accessors are patched rather than `shared.tables`' cache cleared,
        # because `shared.aws` also caches its boto3 resource and client at module
        # scope: an earlier test file in the same worker can have created both
        # OUTSIDE this `mock_aws` block, and clearing only the table cache then
        # hands back a table bound to the real endpoint. Patching what the module
        # under test calls makes these cases independent of collection order.
        with (
            patch.dict(os.environ, {
                'PROJECTS_TABLE': 'test-projects',
                'JOBS_TABLE': 'test-jobs',
                'RAW_DATA_BUCKET': BUCKET,
            }),
            patch.object(projects_module, 'projects_table', projects),
            patch.object(projects_module, 'get_jobs_table', return_value=jobs),
            patch.object(projects_module, 'get_s3_client', return_value=s3),
        ):
            yield {'projects': projects, 'jobs': jobs, 's3': s3}


def partition(table, pk: str) -> list[dict]:
    return table.query(
        KeyConditionExpression=Key('pk').eq(pk), ConsistentRead=True,
    )['Items']


def object_keys(s3, prefix: str) -> list[str]:
    listing = s3.list_objects_v2(Bucket=BUCKET, Prefix=prefix)
    return sorted(entry['Key'] for entry in listing.get('Contents') or [])


def delete() -> dict:
    from projects import delete_project
    return delete_project(PROJECT)


def test_the_delete_empties_every_owned_partition_and_prefix(deployment):
    assert delete() == {'success': True}

    survivors = partition(deployment['projects'], f'PROJECT#{PROJECT}')
    assert [item['sk'] for item in survivors] == ['META']
    assert partition(deployment['projects'], version_partition_key(PROJECT)) == []
    assert partition(deployment['jobs'], f'PROJECT#{PROJECT}') == []
    assert object_keys(deployment['s3'], 'prototypes/') == [
        prototype_s3_key(NEIGHBOUR, 'proto_9'),
    ]


def test_the_meta_tombstone_survives_permanently_and_unindexed(deployment):
    delete()

    tombstone = deployment['projects'].get_item(
        Key={'pk': f'PROJECT#{PROJECT}', 'sk': 'META'}, ConsistentRead=True,
    )['Item']
    assert tombstone['status'] == 'deleted'
    assert tombstone['deleted_at']
    # The write fence is a MARKER, not just a status: `is_project_tombstone`
    # accepts either, and a guarded writer's condition reads the marker.
    assert tombstone[PROJECT_DELETION_ATTRIBUTE]
    # Unindexed: the GSI keys are what would keep it in the projects list.
    assert 'gsi1pk' not in tombstone
    assert 'gsi1sk' not in tombstone


def test_a_neighbouring_project_whose_id_shares_the_prefix_is_untouched(deployment):
    """`prototypes/proj-1` also matches `prototypes/proj-10/...`, so the sweep
    lists on a prefix that ends in a slash."""
    delete()

    assert object_keys(deployment['s3'], f'prototypes/{NEIGHBOUR}/') == [
        prototype_s3_key(NEIGHBOUR, 'proto_9'),
    ]
    assert [item['sk'] for item in partition(
        deployment['jobs'], f'PROJECT#{NEIGHBOUR}',
    )] == ['JOB#job_9']
    assert [item['sk'] for item in partition(
        deployment['projects'], f'PROJECT#{NEIGHBOUR}',
    )] == ['META']


def test_repeating_the_delete_is_idempotent(deployment):
    delete()

    assert delete() == {'success': True}
    assert partition(deployment['jobs'], f'PROJECT#{PROJECT}') == []
    assert object_keys(deployment['s3'], f'prototypes/{PROJECT}/') == []
    tombstone = deployment['projects'].get_item(
        Key={'pk': f'PROJECT#{PROJECT}', 'sk': 'META'}, ConsistentRead=True,
    )['Item']
    assert tombstone['status'] == 'deleted'


def test_a_retry_after_a_failed_object_sweep_resumes_and_finishes(deployment):
    """The sweep lists what REMAINS, so a partial failure is resumable."""
    from projects import delete_project

    real_delete_objects = deployment['s3'].delete_objects
    calls = {'count': 0}

    def fail_once(**kwargs):
        calls['count'] += 1
        if calls['count'] == 1:
            raise RuntimeError('S3 unavailable')
        return real_delete_objects(**kwargs)

    with patch.object(deployment['s3'], 'delete_objects', side_effect=fail_once), \
            patch('projects.get_s3_client', return_value=deployment['s3']):
        with pytest.raises(RuntimeError):
            delete_project(PROJECT)
        # The tombstone is not finalized yet — the sweep raised before it.
        assert deployment['projects'].get_item(
            Key={'pk': f'PROJECT#{PROJECT}', 'sk': 'META'}, ConsistentRead=True,
        )['Item']['status'] == 'deleting'

        assert delete_project(PROJECT) == {'success': True}

    assert object_keys(deployment['s3'], f'prototypes/{PROJECT}/') == []
    assert deployment['projects'].get_item(
        Key={'pk': f'PROJECT#{PROJECT}', 'sk': 'META'}, ConsistentRead=True,
    )['Item']['status'] == 'deleted'


def test_more_prototype_objects_than_one_listing_page_are_all_deleted(deployment):
    """`list_objects_v2` caps at 1000 keys; a project can exceed that."""
    from projects import delete_project

    for index in range(3):
        deployment['s3'].put_object(
            Bucket=BUCKET,
            Key=prototype_s3_key(PROJECT, f'page_{index}'),
            Body=b'<html/>',
        )
    real_list = deployment['s3'].list_objects_v2

    def one_key_per_page(**kwargs):
        return real_list(**{**kwargs, 'MaxKeys': 1})

    with patch.object(deployment['s3'], 'list_objects_v2', side_effect=one_key_per_page), \
            patch('projects.get_s3_client', return_value=deployment['s3']):
        assert delete_project(PROJECT) == {'success': True}

    assert object_keys(deployment['s3'], f'prototypes/{PROJECT}/') == []


def test_more_job_rows_than_one_query_page_are_all_deleted(deployment):
    """The jobs query paginates: a busy project holds more rows than one page."""
    from projects import delete_project

    for index in range(10, 16):
        deployment['jobs'].put_item(Item={
            'pk': f'PROJECT#{PROJECT}', 'sk': f'JOB#job_{index}',
            'job_id': f'job_{index}',
        })
    real_query = deployment['jobs'].query

    def one_row_per_page(**kwargs):
        return real_query(**{**kwargs, 'Limit': 1})

    with patch.object(deployment['jobs'], 'query', side_effect=one_row_per_page), \
            patch('projects.get_jobs_table', return_value=deployment['jobs']):
        assert delete_project(PROJECT) == {'success': True}

    assert partition(deployment['jobs'], f'PROJECT#{PROJECT}') == []


def test_a_delete_still_finalizes_when_no_jobs_table_is_configured(deployment):
    """Missing configuration must not abort the rest of the lifecycle."""
    from projects import delete_project

    with patch('projects.get_jobs_table', return_value=None):
        assert delete_project(PROJECT) == {'success': True}

    assert object_keys(deployment['s3'], f'prototypes/{PROJECT}/') == []
    assert deployment['projects'].get_item(
        Key={'pk': f'PROJECT#{PROJECT}', 'sk': 'META'}, ConsistentRead=True,
    )['Item']['status'] == 'deleted'


def test_a_delete_still_finalizes_when_no_bucket_is_configured(deployment):
    from projects import delete_project

    with patch.dict(os.environ, {'RAW_DATA_BUCKET': ''}):
        assert delete_project(PROJECT) == {'success': True}

    assert partition(deployment['jobs'], f'PROJECT#{PROJECT}') == []
    assert deployment['projects'].get_item(
        Key={'pk': f'PROJECT#{PROJECT}', 'sk': 'META'}, ConsistentRead=True,
    )['Item']['status'] == 'deleted'


class TestThePrototypeEdgeCacheIsEvicted:
    """An emptied bucket is not an unreachable prototype.

    `/prototypes/*` runs CACHING_OPTIMIZED because a prototype is immutable per
    document id, so a signed URL minted before the delete keeps getting an edge HIT
    — the object is gone while the page still renders for the rest of the
    signature's TTL. The delete therefore evicts the project's paths too.

    A real CloudFront client is not used: moto's CloudFront support does not model
    invalidation against a distribution created in another stack, and what needs
    proving is the REQUEST — one narrowly scoped path, on the configured
    distribution, and never fatal.
    """

    @staticmethod
    def invalidate(**environment):
        from projects import delete_project

        client = patch('projects.get_cloudfront_client')
        with patch.dict(os.environ, {
            'PROTOTYPES_DISTRIBUTION_ID': 'E1DISTRIBUTION', **environment,
        }), client as factory:
            assert delete_project(PROJECT) == {'success': True}
            return factory.return_value.create_invalidation

    def test_it_invalidates_only_this_project_s_prototype_paths(self, deployment):
        create = self.invalidate()

        create.assert_called_once()
        batch = create.call_args.kwargs['InvalidationBatch']
        assert create.call_args.kwargs['DistributionId'] == 'E1DISTRIBUTION'
        assert batch['Paths'] == {
            'Quantity': 1, 'Items': [f'/prototypes/{PROJECT}/*'],
        }
        # A wildcard over the behavior would evict every OTHER project's
        # prototypes, and invalidation paths are billed past a free allowance.
        assert '/prototypes/*' not in batch['Paths']['Items']

    def test_it_carries_a_caller_reference(self, deployment):
        batch = self.invalidate().call_args.kwargs['InvalidationBatch']

        assert batch['CallerReference'].startswith(f'delete-{PROJECT}-')

    def test_an_unconfigured_distribution_skips_invalidation(self, deployment):
        create = self.invalidate(PROTOTYPES_DISTRIBUTION_ID='')

        create.assert_not_called()

    def test_a_failed_invalidation_does_not_fail_the_delete(self, deployment):
        """The bucket is already empty; this is a cache, not the authority."""
        from botocore.exceptions import ClientError
        from projects import delete_project

        failure = ClientError(
            {'Error': {'Code': 'TooManyInvalidationsInProgress'}}, 'CreateInvalidation',
        )
        with patch.dict(os.environ, {'PROTOTYPES_DISTRIBUTION_ID': 'E1DISTRIBUTION'}), \
                patch('projects.get_cloudfront_client') as factory:
            factory.return_value.create_invalidation.side_effect = failure

            assert delete_project(PROJECT) == {'success': True}

        assert deployment['projects'].get_item(
            Key={'pk': f'PROJECT#{PROJECT}', 'sk': 'META'}, ConsistentRead=True,
        )['Item']['status'] == 'deleted'
