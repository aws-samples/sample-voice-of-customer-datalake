"""The agents' own objects of a run, as the run workspace reads them (7.51.00): listed under one prefix, read by range.

The Agents API's role (lib/stacks/api-engineering-run-reads.ts) reads the agents' transcripts, patches and gate records
and the runs' manifests (``s3:GetObject``), and lists only under an agent's transcript and patch prefixes
(``s3:ListBucket`` with ``s3:prefix`` held to ``…/_transcripts/*`` and ``…/_patches/*``). So a key is read only when a
listing named it, the board recorded it or the layout spells it; S3 answers a key that is not there with 403 (the role
has no unconditioned ListBucket), read here as missing. A denial of a key that should be there (a listed one, a recorded
one) is logged and counted (``ENGINEERING_DENIED_READS_METRIC``, which alerting's alarm watches: a KMS or policy denial
reads the same); a probe that expects to miss (``quiet``: the manifest's next version) counts nothing.

Reads are bounded: a listing at most ``MAX_LISTED`` keys, a read at most the bytes its caller asks for.
"""
from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any, Final

from botocore.exceptions import ClientError

from engineering.workspace.store import DENIED_CODES, MISSING_CODES
from engineering.workspace.store import client_error_code as _code
from shared.logging import logger, metrics
from shared.ops_alerts import ENGINEERING_DENIED_READS_METRIC

#: The most keys one listing reads (ten pages): more than an attempt's transcript chunks or patches ever are.
MAX_LISTED: Final = 10_000
_PAGE: Final = 1_000


@dataclass(frozen=True)
class Listed:
    key: str
    size: int
    #: When S3 last wrote it (ISO 8601, UTC; '' when S3 named no time).
    at: str


@dataclass(frozen=True)
class Read:
    """Bytes of an object: ``body`` from byte ``start``, of an object of ``total`` bytes."""

    body: bytes
    start: int
    total: int

    @property
    def end(self) -> int:
        """The offset just past the bytes read."""
        return self.start + len(self.body)


def _iso(value: object) -> str:
    isoformat = getattr(value, 'isoformat', None)
    return str(isoformat()).replace('+00:00', 'Z') if callable(isoformat) else ''


class RunObjects:
    """``s3`` is boto3's S3 client; ``bucket`` the workspace bucket (voc-eng-workspace)."""

    def __init__(self, s3: Any, bucket: str) -> None:
        self.s3 = s3
        self.bucket = bucket

    def listed(self, prefix: str, *, limit: int = MAX_LISTED) -> list[Listed]:
        """The keys under ``prefix`` in key order, at most ``limit`` (a prefix the role may not list raises)."""
        found: list[Listed] = []
        request: dict[str, Any] = {'Bucket': self.bucket, 'Prefix': prefix, 'MaxKeys': _PAGE}
        while len(found) < limit:
            page = self.s3.list_objects_v2(**request)
            found += [Listed(str(item['Key']), int(item.get('Size', 0)), _iso(item.get('LastModified')))
                      for item in page.get('Contents', []) if isinstance(item, Mapping) and 'Key' in item]
            token = page.get('NextContinuationToken')
            if not page.get('IsTruncated') or not token:
                break
            request['ContinuationToken'] = token
        return found[:limit]

    def read(self, key: str, start: int = 0, length: int | None = None, *, quiet: bool = False) -> Read | None:
        """``length`` bytes of ``key`` from ``start`` (to its end when None), or None when it is not there (an empty
        object, or a start past its end, reads as no bytes)."""
        span = f'bytes={start}-' if length is None else f'bytes={start}-{start + max(length, 1) - 1}'
        return self._get(key, span, quiet=quiet)

    def tail(self, key: str, length: int) -> Read | None:
        """The last ``length`` bytes of ``key`` (all of it when it is shorter), or None when it is not there."""
        return self._get(key, f'bytes=-{max(length, 1)}', quiet=False)

    def _get(self, key: str, span: str, *, quiet: bool) -> Read | None:
        try:
            answer = self.s3.get_object(Bucket=self.bucket, Key=key, Range=span)
        except ClientError as exc:
            code = _code(exc)
            if code == 'InvalidRange':   # (an empty object, or a start at or past its end: nothing to read)
                return Read(b'', 0, 0)
            if code in DENIED_CODES and not quiet:
                logger.warning('workspace: a denied read taken as missing', extra={'key': key, 'code': code})
                metrics.add_metric(name=ENGINEERING_DENIED_READS_METRIC, unit='Count', value=1)
            if code in MISSING_CODES | DENIED_CODES:
                return None
            raise
        body = answer['Body'].read()
        start, _, total = str(answer.get('ContentRange', '')).removeprefix('bytes ').partition('/')
        first = start.partition('-')[0]
        offset = int(first) if first.isdigit() else 0
        return Read(body, offset, int(total) if total.isdigit() else offset + len(body))
