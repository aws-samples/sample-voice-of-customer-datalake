"""The Documents Library's objects in the raw-data bucket (docs/documents-library.md), seen through one scope.

Every call names a key under the scope's own library prefix (shared/library_keys.py ``library_prefix``: ``library/``,
a workspace's ``ws/{ws}/library/``) with no empty, ``.`` or ``..`` segment, checked before anything reaches S3
(``OutOfScopeError``), as the workspace layer's own object views check theirs (shared/ws_repo.py ``ExportObjects``).
So no library route can read, sign or delete an object of another scope, nor anything outside the library.

* ``upload_url``: a 15-minute presigned PUT of an item's original, bound to its exact length and content type and
  to ``If-None-Match: *`` (a write-once object: a second PUT of the same item is refused by S3);
* ``download_url``: a presigned GET (5 minutes for the person's preview, the stream Lambda's own fetch of a native
  document) that downloads under the item's file name;
* ``head`` / ``read`` / ``put_text``: the extraction's reads of the upload and its one write, the extracted text;
* ``delete_item``: every version and delete marker of every object of one item (TENETS.md D5: a deleted workspace
  artifact is really deleted).
"""
from __future__ import annotations

import os
from typing import TYPE_CHECKING, Any, Final

from botocore.exceptions import ClientError

from shared.aws import is_missing_s3_object
from shared.library_keys import extracted_key, item_object_prefix, library_prefix, original_key
from shared.s3_versions import delete_every_version
from shared.ws_repo import OutOfScopeError, has_plain_segments

if TYPE_CHECKING:
    from shared.ws_repo import WorkspaceScope

__all__ = ['LibraryObjects']

UPLOAD_SECONDS: Final = 15 * 60
DOWNLOAD_SECONDS: Final = 5 * 60
_client: list[Any] = []


def _s3() -> Any:
    """SigV4 in the bucket's region (a KMS-encrypted bucket refuses an older signature; the regional host a
    region-pinned client signs for spares the browser's PUT a redirect), built once per container."""
    if not _client:
        import boto3
        from botocore.config import Config

        _client.append(boto3.client('s3', region_name=os.environ.get('AWS_REGION', 'us-east-1'),
                                    config=Config(signature_version='s3v4')))
    return _client[0]


def content_disposition(filename: str) -> str:
    """``attachment`` under ``filename``, ASCII-safe (RFC 6266's ``filename*`` carries the UTF-8 name)."""
    from urllib.parse import quote

    ascii_name = ''.join(char if 32 <= ord(char) < 127 and char not in '"\\' else '_' for char in filename) or 'file'
    return f'attachment; filename="{ascii_name}"; filename*=UTF-8\'\'{quote(filename, safe="")}'


class LibraryObjects:
    """One scope's library objects in ``bucket`` (``RAW_DATA_BUCKET`` when not given)."""

    def __init__(self, scope: WorkspaceScope | None, bucket: str | None = None, client: Any = None) -> None:
        self.scope = scope
        self._bucket = bucket if bucket is not None else os.environ.get('RAW_DATA_BUCKET', '')
        if not self._bucket:
            raise ValueError('the library needs RAW_DATA_BUCKET')
        self._s3 = client

    @property
    def s3(self) -> Any:
        return self._s3 if self._s3 is not None else _s3()

    def _checked(self, key: str) -> str:
        rest = key.removeprefix(library_prefix(workspace=self.scope))
        if rest == key or not has_plain_segments(rest):
            raise OutOfScopeError("a key outside the scope's library")
        return key

    def original(self, item_id: str) -> str:
        return self._checked(original_key(item_id, workspace=self.scope))

    def extracted(self, item_id: str) -> str:
        return self._checked(extracted_key(item_id, workspace=self.scope))

    def upload_url(self, item_id: str, *, content_type: str, length: int) -> dict[str, Any]:
        """``{url, headers, expires_in}``: the browser PUTs the file with exactly these headers (its length is the
        body's, which the browser sets itself; it is signed, so another length is refused)."""
        url = self.s3.generate_presigned_url(
            ClientMethod='put_object',
            Params={'Bucket': self._bucket, 'Key': self.original(item_id), 'ContentType': content_type,
                    'ContentLength': length, 'IfNoneMatch': '*'},
            ExpiresIn=UPLOAD_SECONDS,
        )
        return {'url': url, 'headers': {'Content-Type': content_type, 'If-None-Match': '*'},
                'expires_in': UPLOAD_SECONDS}

    def download_url(self, item_id: str, *, filename: str, content_type: str) -> str:
        return str(self.s3.generate_presigned_url(
            ClientMethod='get_object',
            Params={'Bucket': self._bucket, 'Key': self.original(item_id),
                    'ResponseContentDisposition': content_disposition(filename),
                    'ResponseContentType': content_type},
            ExpiresIn=DOWNLOAD_SECONDS,
        ))

    def head(self, item_id: str) -> dict[str, Any] | None:
        """The uploaded original's ``{length, content_type}``, or None while nothing was uploaded."""
        try:
            response = self.s3.head_object(Bucket=self._bucket, Key=self.original(item_id))
        except ClientError as exc:
            if is_missing_s3_object(exc):
                return None
            raise
        return {'length': int(response.get('ContentLength') or 0), 'content_type': response.get('ContentType')}

    def read(self, key: str, *, max_bytes: int) -> bytes:
        """The object's bytes, at most ``max_bytes`` (a longer one is refused with ValueError, never cut)."""
        body = self.s3.get_object(Bucket=self._bucket, Key=self._checked(key))['Body']
        data = body.read(max_bytes + 1)
        if len(data) > max_bytes:
            raise ValueError('the object is larger than allowed')
        return bytes(data)

    def read_text(self, item_id: str, *, max_bytes: int) -> str | None:
        """The extracted text, or None when there is none (yet)."""
        try:
            return self.read(self.extracted(item_id), max_bytes=max_bytes).decode('utf-8', errors='replace')
        except ClientError as exc:
            if is_missing_s3_object(exc):
                return None
            raise

    def put_text(self, item_id: str, text: str) -> None:
        self.s3.put_object(Bucket=self._bucket, Key=self.extracted(item_id), Body=text.encode('utf-8'),
                           ContentType='text/plain; charset=utf-8')

    def delete_text(self, item_id: str) -> int:
        """Every version of the item's extracted text (an extraction whose item went away); the count refused."""
        return delete_every_version(self.s3, self._bucket, self.extracted(item_id), exact=True)

    def delete_item(self, item_id: str) -> int:
        """Every version and marker of the item's objects; the count S3 refused."""
        prefix = item_object_prefix(item_id, workspace=self.scope)
        self._checked(prefix.removesuffix('/'))
        return delete_every_version(self.s3, self._bucket, prefix)
