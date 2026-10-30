"""moto-backed S3 helpers for tests that need real object versions (deletes of
every version, delete markers). Call these inside an active ``moto.mock_aws()`` context.
"""
import boto3


def create_versioned_bucket(bucket: str, region: str = 'us-east-1'):
    """Create ``bucket`` with versioning enabled; returns the S3 client."""
    s3 = boto3.client('s3', region_name=region)
    s3.create_bucket(Bucket=bucket)
    s3.put_bucket_versioning(Bucket=bucket, VersioningConfiguration={'Status': 'Enabled'})
    return s3


def version_keys(s3, bucket: str) -> set[str]:
    """Every key that still has an object version or a delete marker in ``bucket``."""
    page = s3.list_object_versions(Bucket=bucket)
    return {entry['Key'] for entry in [*page.get('Versions', []), *page.get('DeleteMarkers', [])]}
