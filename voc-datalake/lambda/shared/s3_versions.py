"""Deleting an S3 object for good: every version and every delete marker.

The raw-data bucket is versioned, so a plain ``DeleteObject`` only hides an object
behind a delete marker: the bytes stay as a noncurrent version. When an owner deletes
a workspace artifact (an avatar, a prototype, a product doc, a company-context file)
the object really goes (TENETS.md D5, docs/project-workspace.md → Deleting): these
helpers list the versions and markers and delete each by version id. On an
unversioned bucket the listing returns the one ``null`` version, so they work there too.

They never raise on a refused delete: they return how many entries S3 refused, and the
caller logs it (the rows were already deleted, a retry finds what is left).
Needs ``s3:ListBucketVersions`` on the bucket and ``s3:DeleteObjectVersion`` on the keys.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping
from typing import Any, Final

__all__ = ['delete_every_version', 'delete_every_version_of_keys']

#: S3's cap on keys per ``DeleteObjects`` request.
_DELETE_BATCH: Final = 1000


def _targeted(key: str, prefix: str, exact: bool) -> bool:
    """The listed ``key`` is one the call deletes: the key itself (``exact``), else any key under ``prefix``."""
    return key == prefix if exact else key.startswith(prefix)


def _version_entries(page: Mapping[str, Any], prefix: str, exact: bool) -> list[dict[str, str]]:
    """``{Key, VersionId}`` of each version and marker on one listing page that the call targets."""
    listed = [*(page.get('Versions') or []), *(page.get('DeleteMarkers') or [])]
    entries: list[dict[str, str]] = []
    for entry in listed:
        key, version_id = entry.get('Key'), entry.get('VersionId')
        if not isinstance(key, str) or not isinstance(version_id, str) or not version_id:
            continue
        if _targeted(key, prefix, exact):
            entries.append({'Key': key, 'VersionId': version_id})
    return entries


def delete_every_version(client: Any, bucket: str, prefix: str, *, exact: bool = False) -> int:
    """Delete every version and marker under ``prefix`` (``exact``: of that one key); the refused count.

    A ``prefix`` that names a folder must end in ``/``: ``prototypes/p1`` also matches
    ``prototypes/p10/…``. ``exact`` matches the key itself only (a listing by prefix
    also returns longer keys, which are skipped).
    """
    if not prefix:
        raise ValueError('An empty prefix would name the whole bucket')
    refused = 0
    for page in client.get_paginator('list_object_versions').paginate(Bucket=bucket, Prefix=prefix):
        entries = _version_entries(page, prefix, exact)
        for start in range(0, len(entries), _DELETE_BATCH):
            response = client.delete_objects(
                Bucket=bucket, Delete={'Objects': entries[start:start + _DELETE_BATCH], 'Quiet': True})
            errors = response.get('Errors') if isinstance(response, Mapping) else None
            refused += len(errors) if isinstance(errors, list) else 0
    return refused


def delete_every_version_of_keys(client: Any, bucket: str, keys: Iterable[str]) -> int:
    """``delete_every_version(..., exact=True)`` for each key; the refused count in total."""
    return sum(delete_every_version(client, bucket, key, exact=True) for key in dict.fromkeys(keys) if key)
