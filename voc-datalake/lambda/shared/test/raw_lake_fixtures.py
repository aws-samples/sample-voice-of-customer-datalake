"""A moto raw bucket the API-side raw writers (``shared/raw_copy.py`` ``app_json_copy``) write into."""
from __future__ import annotations

import os
from collections.abc import Generator
from contextlib import contextmanager
from typing import Any
from unittest.mock import patch

import boto3
from moto import mock_aws

RAW_BUCKET = 'raw-bucket'
APP_VERSION = '9.1.0'


@contextmanager
def raw_lake_client(bucket: str = RAW_BUCKET) -> Generator[Any, None, None]:
    """Inside an active moto mock: create ``bucket``, point ``RAW_DATA_BUCKET`` / ``APP_VERSION`` at it
    and have ``shared.raw_copy`` use this client; yields the client."""
    with patch.dict(os.environ, {'RAW_DATA_BUCKET': bucket, 'APP_VERSION': APP_VERSION}):
        client = boto3.client('s3', region_name='us-east-1')
        client.create_bucket(Bucket=bucket)
        with patch('shared.raw_copy.get_s3_client', return_value=client):
            yield client


@contextmanager
def raw_lake(bucket: str = RAW_BUCKET) -> Generator[Any, None, None]:
    """``raw_lake_client`` under its own moto mock."""
    with mock_aws(), raw_lake_client(bucket) as client:
        yield client


def raw_keys(client: Any, bucket: str = RAW_BUCKET) -> list[str]:
    return [o['Key'] for o in client.list_objects_v2(Bucket=bucket).get('Contents', [])]
