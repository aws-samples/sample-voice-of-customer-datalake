"""Read back the kept Silver versions (``shared/silver_provenance.py``) a test wrote to a moto bucket."""
import json

import boto3


def kept_versions(bucket: str) -> list[dict]:
    """Every current object under ``silver/`` in ``bucket``, decoded, with its ``key``; call inside ``mock_aws``."""
    s3 = boto3.client('s3', region_name='us-east-1')
    listed = s3.list_objects_v2(Bucket=bucket, Prefix='silver/').get('Contents', [])
    keys = [entry.get('Key', '') for entry in listed]
    return [{'key': key, **json.loads(s3.get_object(Bucket=bucket, Key=key)['Body'].read())} for key in keys]
