"""Reading and writing the workspace bucket: reads are bounded, writes are create-only (objects are immutable).

The bucket is private and encrypted by default (the CDK stack); a write never overwrites: ``put_once`` sends
``If-None-Match: *`` and answers False when the key already exists, so a retried write is harmless and a second
writer cannot replace what the first one wrote.
"""
from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from botocore.exceptions import ClientError

MAX_READ_BYTES = 4 * 1024 * 1024
_EXISTS = frozenset({'PreconditionFailed', '412', 'ConditionalRequestConflict'})
_MISSING = frozenset({'NoSuchKey', '404'})
#: What S3 answers a missing key to a role without ListBucket on it.
_DENIED = frozenset({'AccessDenied', '403'})


class WorkspaceStore:
    def __init__(self, s3: Any, bucket: str, *, denied_is_missing: bool = False) -> None:
        """``denied_is_missing``: a reader whose role may read every key it asks for but holds no unconditioned
        ``s3:ListBucket`` (S3 then answers a missing key 403, not 404) reads a denied object as missing."""
        self.s3 = s3
        self.bucket = bucket
        self.missing = _MISSING | _DENIED if denied_is_missing else _MISSING

    def read_text(self, key: str) -> str | None:
        """The object's text (at most ``MAX_READ_BYTES``; more is cut), or None when it does not exist."""
        try:
            answer = self.s3.get_object(Bucket=self.bucket, Key=key, Range=f'bytes=0-{MAX_READ_BYTES - 1}')
        except ClientError as exc:
            response: Mapping[str, Any] = exc.response
            code = response.get('Error', {}).get('Code')
            if code in self.missing:
                return None
            if code == 'InvalidRange':   # an empty object: S3 has no byte 0 to range over
                return ''
            raise
        return answer['Body'].read().decode('utf-8', errors='replace')

    def put_once(self, key: str, body: str, content_type: str) -> bool:
        """Create the object; False when it already exists (left as it was)."""
        try:
            self.s3.put_object(Bucket=self.bucket, Key=key, Body=body.encode(), ContentType=content_type,
                               IfNoneMatch='*')
        except ClientError as exc:
            response: Mapping[str, Any] = exc.response
            if response.get('Error', {}).get('Code') in _EXISTS:
                return False
            raise
        return True
