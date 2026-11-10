"""Deleting every version of an S3 object (shared/s3_versions.py)."""
from unittest.mock import MagicMock

import boto3
import pytest
from moto import mock_aws

from shared.s3_versions import delete_every_version, delete_every_version_of_keys
from shared.test.moto_s3 import create_versioned_bucket

BUCKET = 'raw'


@pytest.fixture
def s3():
    with mock_aws():
        yield create_versioned_bucket(BUCKET)


def _entries(client, prefix: str = '') -> list[str]:
    page = client.list_object_versions(Bucket=BUCKET, Prefix=prefix)
    return sorted(e['Key'] for e in [*page.get('Versions', []), *page.get('DeleteMarkers', [])])


def _put_twice_and_hide(client, key: str) -> None:
    client.put_object(Bucket=BUCKET, Key=key, Body=b'1')
    client.put_object(Bucket=BUCKET, Key=key, Body=b'2')
    client.delete_object(Bucket=BUCKET, Key=key)  # a delete marker over two versions


def test_a_prefix_loses_every_version_and_marker_and_nothing_beside_it(s3):
    _put_twice_and_hide(s3, 'prototypes/p1/a.html')
    s3.put_object(Bucket=BUCKET, Key='prototypes/p1/b.html', Body=b'x')
    s3.put_object(Bucket=BUCKET, Key='prototypes/p10/c.html', Body=b'x')
    assert delete_every_version(s3, BUCKET, 'prototypes/p1/') == 0
    assert _entries(s3, 'prototypes/') == ['prototypes/p10/c.html']


def test_exact_deletes_the_key_only_not_longer_keys(s3):
    _put_twice_and_hide(s3, 'avatars/x.png')
    s3.put_object(Bucket=BUCKET, Key='avatars/x.png.bak', Body=b'x')
    assert delete_every_version(s3, BUCKET, 'avatars/x.png', exact=True) == 0
    assert _entries(s3) == ['avatars/x.png.bak']


def test_of_keys_deletes_each_key_once(s3):
    for key in ('a/1', 'a/2', 'a/3'):
        _put_twice_and_hide(s3, key)
    assert delete_every_version_of_keys(s3, BUCKET, ['a/1', 'a/2', 'a/1', '']) == 0
    assert _entries(s3) == ['a/3', 'a/3', 'a/3']


def test_an_unversioned_bucket_works_too():
    with mock_aws():
        client = boto3.client('s3', region_name='us-east-1')
        client.create_bucket(Bucket=BUCKET)
        client.put_object(Bucket=BUCKET, Key='k/1', Body=b'x')
        assert delete_every_version(client, BUCKET, 'k/') == 0
        assert client.list_objects_v2(Bucket=BUCKET).get('KeyCount') == 0


def test_refused_entries_are_counted_not_raised():
    client = MagicMock()
    client.get_paginator.return_value.paginate.return_value = [{
        'Versions': [{'Key': 'p/a', 'VersionId': 'v1'}, {'Key': 'p/b', 'VersionId': 'v2'}],
        'DeleteMarkers': [{'Key': 'p/a', 'VersionId': 'm1'}, {'Key': 'p/c'}],
    }]
    client.delete_objects.return_value = {'Errors': [{'Key': 'p/a'}]}
    assert delete_every_version(client, BUCKET, 'p/') == 1
    objects = client.delete_objects.call_args.kwargs['Delete']['Objects']
    assert objects == [{'Key': 'p/a', 'VersionId': 'v1'}, {'Key': 'p/b', 'VersionId': 'v2'},
                       {'Key': 'p/a', 'VersionId': 'm1'}]


def test_an_empty_page_sends_no_delete():
    client = MagicMock()
    client.get_paginator.return_value.paginate.return_value = [{}]
    assert delete_every_version(client, BUCKET, 'p/') == 0
    client.delete_objects.assert_not_called()


def test_an_empty_prefix_is_refused():
    with pytest.raises(ValueError, match='whole bucket'):
        delete_every_version(MagicMock(), BUCKET, '')
