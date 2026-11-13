"""Reading and writing the workspace bucket: reads are bounded, writes are create-only (objects are immutable).

The bucket is private and encrypted by default (the CDK stack); a write never overwrites: ``put_once`` sends
``If-None-Match: *`` and answers False when the key already exists, so a retried write is harmless and a second
writer cannot replace what the first one wrote. S3's 409 ``ConditionalRequestConflict`` (another conditional write
to the same key still in flight) is not "already exists": the write is tried again after a short wait, and the
conflict raised as it came after the last try. A read longer than ``MAX_READ_BYTES`` is cut, and the cut is logged with the object's
size. A reader without ListBucket may take a denied read as missing; each one is logged and counted.
"""
from __future__ import annotations

import time
from collections.abc import Callable, Mapping
from typing import Any

from botocore.exceptions import ClientError

from shared.logging import logger, metrics

MAX_READ_BYTES = 4 * 1024 * 1024
#: The count of reads a ``denied_is_missing`` reader took as missing after S3 denied them (the shared namespace).
DENIED_AS_MISSING_METRIC = 'EngineeringWorkspaceDeniedReads'
_EXISTS = frozenset({'PreconditionFailed', '412'})
_IN_FLIGHT = frozenset({'ConditionalRequestConflict', '409'})
#: How many times a write meeting another conditional write in flight is tried.
WRITE_TRIES = 3
#: The wait before a write's next try, times the tries made (seconds).
WRITE_BACKOFF_S = 0.2
_MISSING = frozenset({'NoSuchKey', '404'})
#: What S3 answers a missing key to a role without ListBucket on it.
_DENIED = frozenset({'AccessDenied', '403'})


def _code(exc: ClientError) -> object:
    response: Mapping[str, Any] = exc.response
    return response.get('Error', {}).get('Code')


class WorkspaceStore:
    def __init__(self, s3: Any, bucket: str, *, denied_is_missing: bool = False,
                 sleep: Callable[[float], None] = time.sleep) -> None:
        """``denied_is_missing``: a reader whose role may read every key it asks for but holds no unconditioned
        ``s3:ListBucket`` (S3 then answers a missing key 403, not 404) reads a denied object as missing, and logs
        and counts each such read (``DENIED_AS_MISSING_METRIC``: a KMS or policy denial looks the same). ``sleep``:
        the wait between a write's tries (a test's records them)."""
        self.s3 = s3
        self.sleep = sleep
        self.bucket = bucket
        self.missing = _MISSING | _DENIED if denied_is_missing else _MISSING

    def read_text(self, key: str) -> str | None:
        """The object's text (at most ``MAX_READ_BYTES``; more is cut), or None when it does not exist."""
        try:
            answer = self.s3.get_object(Bucket=self.bucket, Key=key, Range=f'bytes=0-{MAX_READ_BYTES - 1}')
        except ClientError as exc:
            code = _code(exc)
            if code in self.missing:
                if code in _DENIED:
                    # Most likely a missing key, but a KMS or policy denial reads the same: logged and counted, so
                    # a broken policy shows as a rising count rather than as reports quietly missing their parts.
                    logger.warning('workspace: a denied read taken as missing', extra={'key': key, 'code': code})
                    metrics.add_metric(name=DENIED_AS_MISSING_METRIC, unit='Count', value=1)
                return None
            if code == 'InvalidRange':   # an empty object: S3 has no byte 0 to range over
                return ''
            raise
        total = str(answer.get('ContentRange', '')).rpartition('/')[2]
        if total.isdigit() and int(total) > MAX_READ_BYTES:
            logger.warning('workspace: a read was cut', extra={'key': key, 'size': int(total), 'read': MAX_READ_BYTES})
        return answer['Body'].read().decode('utf-8', errors='replace')

    def put_once(self, key: str, body: str, content_type: str) -> bool:
        """Create the object; False when it already exists (left as it was). Another conditional write to it in
        flight: tried again, waiting longer each time, and its ``ClientError`` raised after the last try."""
        tries = 0
        while True:
            tries += 1
            try:
                self.s3.put_object(Bucket=self.bucket, Key=key, Body=body.encode(), ContentType=content_type,
                                   IfNoneMatch='*')
            except ClientError as exc:
                if _code(exc) in _EXISTS:
                    return False
                if _code(exc) not in _IN_FLIGHT or tries == WRITE_TRIES:
                    raise
                self.sleep(WRITE_BACKOFF_S * tries)
                continue
            return True
