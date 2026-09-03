"""The whole owned-artifact lifecycle of a project delete, against real services.

`test_projects.py` holds the projects-partition request SHAPE against a MagicMock
table. That is the one thing a mock is good for and the one thing it cannot answer
here: whether the sweep actually EMPTIED what it swept. Four of the artifacts a
project owns live outside its DynamoDB partition and were previously left behind:

  * **job rows**, in their own table. They sat there until their TTL — up to 30
    days, seven for a completed or failed one — so recreating a project id showed a
    stranger's job history and the panel polled work with no project.
  * **prototype HTML**, in S3 under `prototypes/{project_id}/`. Deleting the
    `PROTOTYPE#` rows left the objects, so links minted before the delete resolved
    for the rest of their signature TTL and the bytes were billed indefinitely.
  * **product docs**, in S3 under `projects/{project_id}/product_docs/` — both the
    raw upload and the extractor's text. `PRODUCT_DOC#` rows are in the project
    partition and were swept; only the per-document route ever deleted the objects.
  * **persona avatars**, in S3 at `avatars/{persona_id}.{ext}`. Keyed by PERSONA,
    so there is no prefix to list and the ids must be read before the rows go.

The last two matter for the same two reasons as the first: `rawDataBucket` has NO
lifecycle expiration, so unlike a job row nothing eventually collects them, and
`/avatars/*` and the presigned reads keep resolving for the rest of a signature's
TTL. The delete-confirmation copy also tells the user all of it goes.

moto rather than a fake: pagination (`LastEvaluatedKey`, `IsTruncated` /
`NextContinuationToken`) and `delete_objects`' partial-failure envelope are exactly
what a hand-rolled fake would get to define for itself.
"""
import os
from unittest.mock import patch

import boto3
import pytest
from boto3.dynamodb.conditions import Key
from botocore.exceptions import (
    ClientError,
    EndpointConnectionError,
    NoCredentialsError,
    ParamValidationError,
)
from moto import mock_aws
from product_context import product_docs_project_prefix
from shared.avatar import AVATAR_OWNER_METADATA_KEY, avatar_object_keys
from shared.document_versions import version_partition_key
from shared.project_writes import PROJECT_DELETION_ATTRIBUTE
from shared.prototypes import prototype_s3_key

BUCKET = 'test-raw-data-bucket'
PROJECT = 'proj-1'
NEIGHBOUR = 'proj-10'
# The persona whose avatar the fixture writes. Named here because the avatar sweep
# is the one that cannot derive its keys from a prefix.
PERSONA = 'persona_1'
# One persona id held by BOTH projects, which is reachable in production: two
# personas created in the same wall-clock second in different projects get the same
# `persona_{YYYYMMDDHHMMSS}`, and therefore the same avatar key.
SHARED_PERSONA = 'persona_20260101120000'
# A persona whose avatar object predates the ownership metadata.
LEGACY_PERSONA = 'persona_legacy'


def put_avatar(s3, key: str, owner: str) -> None:
    """Write an avatar object stamped with its owning project.

    Mirrors what `shared.avatar.generate_persona_avatar` does at write time, which
    is the only moment the owner is known: the key itself carries no project.
    """
    s3.put_object(
        Bucket=BUCKET,
        Key=key,
        Body=b'avatar',
        Metadata={AVATAR_OWNER_METADATA_KEY: owner},
    )


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
            'pk': f'PROJECT#{PROJECT}', 'sk': f'PERSONA#{PERSONA}',
            'persona_id': PERSONA,
            'avatar_url': f's3://{BUCKET}/avatars/{PERSONA}.jpeg',
        })
        # Two extensions for ONE persona: the key embeds the image format, so a
        # persona regenerated across an `output_format` change leaves an object
        # under the older extension that its stored `avatar_url` no longer names.
        # A url-derived sweep would leave exactly that one behind.
        #
        # Both carry the owner metadata the avatar WRITER stamps. That is what makes
        # them deletable: the key space is flat and persona ids are not unique across
        # projects, so the sweep deletes only what names this project.
        for extension in ('jpeg', 'png'):
            put_avatar(s3, f'avatars/{PERSONA}.{extension}', owner=PROJECT)
        # One row, two objects. The row is written once — the sweep it feeds is
        # prefix-based and never reads it, and putting it inside the loop below read
        # as "two docs" to anyone extending the fixture.
        projects.put_item(Item={
            'pk': f'PROJECT#{PROJECT}', 'sk': 'PRODUCT_DOC#doc_1',
            'doc_id': 'doc_1',
        })
        for kind, name in (('raw', 'doc_1.pdf'), ('extracted', 'doc_1.txt')):
            s3.put_object(
                Bucket=BUCKET,
                Key=f'{product_docs_project_prefix(PROJECT)}{kind}/{name}',
                Body=b'product doc',
            )
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
        s3.put_object(
            Bucket=BUCKET,
            Key=f'{product_docs_project_prefix(NEIGHBOUR)}raw/doc_9.pdf',
            Body=b'neighbour product doc',
        )
        put_avatar(s3, 'avatars/persona_9.jpeg', owner=NEIGHBOUR)
        # The COLLISION, and the reason the sweep checks ownership at all: this id is
        # one this project also used, because `create_persona` and the persona
        # importer both mint `persona_{YYYYMMDDHHMMSS}` with no project component —
        # two personas created in the same second in different projects name one
        # object. The row belongs to the neighbour; only the metadata can say so.
        put_avatar(s3, f'avatars/{SHARED_PERSONA}.jpeg', owner=NEIGHBOUR)
        projects.put_item(Item={
            'pk': f'PROJECT#{NEIGHBOUR}', 'sk': f'PERSONA#{SHARED_PERSONA}',
            'persona_id': SHARED_PERSONA,
            'avatar_url': f's3://{BUCKET}/avatars/{SHARED_PERSONA}.jpeg',
        })
        projects.put_item(Item={
            'pk': f'PROJECT#{PROJECT}', 'sk': f'PERSONA#{SHARED_PERSONA}',
            'persona_id': SHARED_PERSONA,
            'avatar_url': f's3://{BUCKET}/avatars/{SHARED_PERSONA}.jpeg',
        })
        # An avatar with NO owner metadata: written before the ownership stamp
        # existed. The sweep must decline it rather than guess, because guessing is
        # what deletes a neighbour's object.
        s3.put_object(
            Bucket=BUCKET, Key=f'avatars/{LEGACY_PERSONA}.jpeg', Body=b'legacy avatar',
        )
        projects.put_item(Item={
            'pk': f'PROJECT#{PROJECT}', 'sk': f'PERSONA#{LEGACY_PERSONA}',
            'persona_id': LEGACY_PERSONA,
        })
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
    assert object_keys(deployment['s3'], product_docs_project_prefix(PROJECT)) == []
    assert object_keys(deployment['s3'], f'avatars/{PERSONA}.') == []


def test_both_halves_of_the_product_doc_layout_are_swept(deployment):
    """`raw/` is the upload and `extracted/` is the extractor's text.

    Two writers, one subtree. Sweeping the `product_docs/` prefix rather than the
    two leaves means a layout that grows a third kind is covered without a change
    here — and asserted as a positive control first, so an empty
    `product_docs/` before the delete could not make this pass vacuously.
    """
    prefix = product_docs_project_prefix(PROJECT)
    assert object_keys(deployment['s3'], prefix) == [
        f'{prefix}extracted/doc_1.txt', f'{prefix}raw/doc_1.pdf',
    ]

    assert delete() == {'success': True}

    assert object_keys(deployment['s3'], prefix) == []


def test_every_extension_a_persona_avatar_may_occupy_is_deleted(deployment):
    """The avatar key embeds the image format, so one persona can own two objects.

    A sweep derived from the stored `avatar_url` would delete only the current
    extension and leave the superseded one billed forever with nothing referencing
    it — which is the orphan `_delete_superseded_avatars` already exists to fight.
    Both are present before the delete, which is what makes the emptiness after it
    a real assertion.
    """
    keys = avatar_object_keys(PERSONA)
    assert object_keys(deployment['s3'], f'avatars/{PERSONA}.') == sorted(
        [f'avatars/{PERSONA}.jpeg', f'avatars/{PERSONA}.png'],
    )
    assert set(keys) >= {f'avatars/{PERSONA}.jpeg', f'avatars/{PERSONA}.png'}

    assert delete() == {'success': True}

    assert object_keys(deployment['s3'], f'avatars/{PERSONA}.') == []


def test_an_avatar_a_neighbour_owns_survives_a_shared_persona_id(deployment):
    """The one sweep whose key space is shared across projects, so ownership is read.

    `avatars/{persona_id}.{ext}` carries no project component, and persona ids are
    not globally unique: `create_persona` and `jobs/persona_importer/handler.py` both
    mint `persona_{YYYYMMDDHHMMSS}` with no project part and no randomness, so two
    personas created in the same second in DIFFERENT projects name ONE object. Both
    projects hold a `PERSONA#{SHARED_PERSONA}` row here for exactly that reason.

    Deleting on the id alone therefore removed a live avatar from a project nobody
    deleted, leaving a surviving persona row pointing at a 404 — data loss outside
    the deleted project, which retry-safety does not excuse. The object's own
    metadata names its owner, so the sweep can tell them apart.
    """
    shared_key = f'avatars/{SHARED_PERSONA}.jpeg'
    # The positive control: the object exists and the deleted project does claim a
    # persona by that id, so this cannot pass by the sweep never reaching it.
    assert object_keys(deployment['s3'], shared_key) == [shared_key]
    assert any(
        item['sk'] == f'PERSONA#{SHARED_PERSONA}'
        for item in partition(deployment['projects'], f'PROJECT#{PROJECT}')
    )

    assert delete() == {'success': True}

    assert object_keys(deployment['s3'], shared_key) == [shared_key]
    # And the neighbour's row still names it, which is what made the loss visible.
    assert any(
        item['sk'] == f'PERSONA#{SHARED_PERSONA}'
        for item in partition(deployment['projects'], f'PROJECT#{NEIGHBOUR}')
    )


def test_an_avatar_with_no_recorded_owner_is_left_alone(deployment):
    """"Cannot tell" is not "mine".

    An object written before the ownership stamp existed answers nothing, and the
    two readings of that are not symmetric: deleting it risks a neighbour's live
    avatar, while keeping it costs one orphan in a bucket that has no lifecycle
    expiration anyway. A regeneration re-stamps the owner and the next delete
    collects it.
    """
    legacy_key = f'avatars/{LEGACY_PERSONA}.jpeg'
    assert object_keys(deployment['s3'], legacy_key) == [legacy_key]

    assert delete() == {'success': True}

    assert object_keys(deployment['s3'], legacy_key) == [legacy_key]


def test_another_project_s_product_docs_and_avatars_survive(deployment):
    """The neighbour owns objects under both new prefixes. Neither may move.

    `projects/proj-1` also matches `projects/proj-10/...` without the trailing
    slash, and the avatar sweep works from an explicit id list rather than a prefix
    precisely so it cannot reach a persona it does not own.
    """
    delete()

    assert object_keys(
        deployment['s3'], product_docs_project_prefix(NEIGHBOUR),
    ) == [f'{product_docs_project_prefix(NEIGHBOUR)}raw/doc_9.pdf']
    # Only the neighbour's own key, so this fails when the avatar sweep OVERREACHES
    # and not when it is missing — that is what the sibling case covers.
    assert object_keys(deployment['s3'], 'avatars/persona_9.') == [
        'avatars/persona_9.jpeg',
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
    # EVERY row, including the neighbour's persona under the id this project also
    # used — the shared id is what the avatar sweep has to disambiguate, and its row
    # is a neighbour row like any other.
    assert [item['sk'] for item in partition(
        deployment['projects'], f'PROJECT#{NEIGHBOUR}',
    )] == ['META', f'PERSONA#{SHARED_PERSONA}']


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


def test_a_reported_partial_failure_is_resumable_and_does_not_abort_the_delete(deployment):
    """`delete_objects` REPORTS per-key failures instead of raising them.

    The other branch. `test_a_retry_after_a_failed_object_sweep_resumes_and_finishes`
    covers a RAISED `delete_objects`, which aborts the sweep before the tombstone is
    finalized. Under throttling S3 instead returns 200 with an `Errors` list naming
    the keys it did not delete — and the sweep logs and continues, because the
    durable work has all committed by then and failing would leave the tombstone at
    `status='deleting'` over an object the next retry will collect anyway.

    Both halves of that claim are asserted: the delete finalizes NOW, and a second
    delete_project empties the prefix — which is the resumability the "log and
    continue" choice is trading on.
    """
    from projects import delete_project

    real_delete_objects = deployment['s3'].delete_objects
    calls = {'count': 0}

    def report_failure_once(**kwargs):
        calls['count'] += 1
        if calls['count'] == 1:
            # 200 with an Errors envelope, and the object deliberately LEFT in
            # place: a response that claimed failure while deleting anyway would
            # make the second-delete assertion below pass vacuously.
            return {
                'Errors': [
                    {'Key': entry['Key'], 'Code': 'SlowDown', 'Message': 'throttled'}
                    for entry in kwargs['Delete']['Objects']
                ],
            }
        return real_delete_objects(**kwargs)

    with patch.object(deployment['s3'], 'delete_objects', side_effect=report_failure_once), \
            patch('projects.get_s3_client', return_value=deployment['s3']):
        assert delete_project(PROJECT) == {'success': True}

        # Reported, not raised: the tombstone is final even though the object survived.
        assert deployment['projects'].get_item(
            Key={'pk': f'PROJECT#{PROJECT}', 'sk': 'META'}, ConsistentRead=True,
        )['Item']['status'] == 'deleted'
        assert object_keys(deployment['s3'], f'prototypes/{PROJECT}/') != []

        assert delete_project(PROJECT) == {'success': True}

    assert object_keys(deployment['s3'], f'prototypes/{PROJECT}/') == []


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
    """An emptied bucket is not an unreachable object.

    Both behaviors that serve deleted bytes — `/prototypes/*` and `/avatars/*` —
    run CACHING_OPTIMIZED because each object is immutable per id, so a signed URL
    minted before the delete keeps getting an edge HIT: the object is gone while the
    page still renders for the rest of the signature's TTL. CACHING_OPTIMIZED also
    forwards no query string, so the signature is not part of the cache key and a
    cached copy is shareable across viewers. The delete therefore evicts both.

    Product docs need no entry: they are read through presigned S3 URLs rather than
    the distribution, so the empty bucket is the whole story for them.

    A real CloudFront client is not used: moto's CloudFront support does not model
    invalidation against a distribution created in another stack, and what needs
    proving is the REQUEST — narrowly scoped paths, on the configured distribution,
    and never fatal.
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
        assert f'/prototypes/{PROJECT}/*' in batch['Paths']['Items']
        # A wildcard over the behavior would evict every OTHER project's
        # prototypes, and invalidation paths are billed past a free allowance.
        assert '/prototypes/*' not in batch['Paths']['Items']

    def test_it_invalidates_the_avatar_paths_it_deleted(self, deployment):
        """The copy promises the images are gone; the edge has to agree.

        `/avatars/*` is the SAME distribution and the same CACHING_OPTIMIZED policy
        whose consequence this class exists for, so emptying the bucket left a signed
        avatar URL resolving from the edge for the rest of its cache lifetime — while
        the delete confirmation said the images were permanently deleted.
        """
        items = self.invalidate().call_args.kwargs['InvalidationBatch']['Paths']['Items']

        # Both extensions, because the sweep deleted both — one object per format the
        # persona was ever generated under.
        assert f'/avatars/{PERSONA}.jpeg' in items
        assert f'/avatars/{PERSONA}.png' in items
        # NOT a wildcard: avatar keys carry no project component, so `/avatars/*`
        # would evict every other project's avatars — the same reason the prototype
        # path names the project rather than the behavior.
        assert '/avatars/*' not in items

    def test_it_names_no_path_for_an_object_it_did_not_delete(self, deployment):
        """The batch is what was deleted, not what was considered.

        The neighbour's avatar under the shared persona id was declined by the
        ownership check, so invalidating its path would evict a live object from the
        edge — a cache eviction is cheap, but it would mean the batch no longer
        describes this project's own artifacts.
        """
        items = self.invalidate().call_args.kwargs['InvalidationBatch']['Paths']['Items']

        assert f'/avatars/{SHARED_PERSONA}.jpeg' not in items
        assert f'/avatars/{LEGACY_PERSONA}.jpeg' not in items

    def test_the_quantity_matches_the_paths(self, deployment):
        """CloudFront rejects a batch whose Quantity disagrees with Items.

        Worth its own case now that the count is variable: it was a literal 1 when
        the only path was the prototype prefix, and a hardcoded number would fail in
        production rather than here.
        """
        paths = self.invalidate().call_args.kwargs['InvalidationBatch']['Paths']

        assert paths['Quantity'] == len(paths['Items'])
        assert paths['Quantity'] > 1

    def test_it_carries_a_caller_reference(self, deployment):
        batch = self.invalidate().call_args.kwargs['InvalidationBatch']

        assert batch['CallerReference'].startswith(f'delete-{PROJECT}-')

    def test_an_unconfigured_distribution_skips_invalidation(self, deployment):
        create = self.invalidate(PROTOTYPES_DISTRIBUTION_ID='')

        create.assert_not_called()

    # Every failure mode botocore raises for this call, not just the modelled
    # service errors. `EndpointConnectionError`, `NoCredentialsError` and
    # `ParamValidationError` are NOT ClientError subclasses, so a handler catching
    # only ClientError let them propagate out of `delete_project` and skip the
    # `update_item` that finalizes the tombstone — leaving the project at
    # `status='deleting'` with its rows and objects already gone, for a CACHE miss.
    # The client pins us-east-1 (CloudFront's control plane is global), so a
    # VPC/DNS hiccup reaching it is the realistic instance of that.
    @pytest.mark.parametrize('failure', [
        pytest.param(
            ClientError(
                {'Error': {'Code': 'TooManyInvalidationsInProgress'}}, 'CreateInvalidation',
            ),
            id='a modelled service error',
        ),
        pytest.param(
            EndpointConnectionError(endpoint_url='https://cloudfront.amazonaws.com'),
            id='an unreachable endpoint',
        ),
        pytest.param(
            NoCredentialsError(),
            id='no resolvable credentials',
        ),
        pytest.param(
            ParamValidationError(report='DistributionId is required'),
            id='a malformed request',
        ),
    ])
    def test_a_failed_invalidation_does_not_fail_the_delete(self, deployment, failure):
        """The bucket is already empty; this is a cache, not the authority."""
        from projects import delete_project

        with patch.dict(os.environ, {'PROTOTYPES_DISTRIBUTION_ID': 'E1DISTRIBUTION'}), \
                patch('projects.get_cloudfront_client') as factory:
            factory.return_value.create_invalidation.side_effect = failure

            assert delete_project(PROJECT) == {'success': True}

        assert deployment['projects'].get_item(
            Key={'pk': f'PROJECT#{PROJECT}', 'sk': 'META'}, ConsistentRead=True,
        )['Item']['status'] == 'deleted'
