"""An in-memory S3 for a workspace's export (shared/ws_repo.py ``ExportObjects`` and ``WorkspaceObjects``): objects
with their tags and content types, listings, multipart uploads with their parts, and presigned links. Every call is recorded, so a test can assert that each key stayed
under the workspace's exports and that every object was tagged."""
from __future__ import annotations

import io
from dataclasses import dataclass, field
from typing import Any

from botocore.exceptions import ClientError


def _require(holds: bool, what: str) -> None:
    """The double's own check of a call S3 would refuse (an AssertionError fails the test that made it)."""
    if not holds:
        raise AssertionError(f'the export S3 double expected {what}')


def _s3_order(key: str) -> bytes:
    """S3 lists keys in the order of their UTF-8 bytes."""
    return key.encode('utf-8', 'surrogatepass')


@dataclass
class Upload:
    key: str
    tagging: str
    parts: dict[int, bytes] = field(default_factory=dict)


class ExportS3:
    """The calls ``ExportObjects`` makes, on one bucket. ``fail_on`` names a method that raises ``error`` once."""

    def __init__(self, bucket: str, min_part: int = 5 * 1024 * 1024) -> None:
        self.bucket = bucket
        self.min_part = min_part
        self.objects: dict[str, tuple[bytes, str]] = {}
        self.uploads: dict[str, Upload] = {}
        self.aborted: list[str] = []
        self.calls: list[tuple[str, str]] = []
        self.fail_on: str | None = None
        self.error: Exception | None = None
        self.last_presign: dict[str, Any] = {}
        self.content_types: dict[str, str] = {}
        self.listings: list[dict[str, Any]] = []
        self._next_upload = 0

    def _record(self, method: str, bucket: str, key: str) -> None:
        _require(bucket == self.bucket, 'the export bucket')
        self.calls.append((method, key))
        if self.fail_on == method and self.error is not None:
            error, self.fail_on = self.error, None
            raise error

    def create_multipart_upload(self, *, Bucket: str, Key: str, ContentType: str, Tagging: str) -> dict[str, Any]:
        self._record('create_multipart_upload', Bucket, Key)
        _require(bool(ContentType), 'a content type')
        self._next_upload += 1
        upload_id = f'upload-{self._next_upload}'
        self.uploads[upload_id] = Upload(Key, Tagging)
        return {'UploadId': upload_id}

    def upload_part(self, *, Bucket: str, Key: str, UploadId: str, PartNumber: int, Body: bytes) -> dict[str, Any]:
        self._record('upload_part', Bucket, Key)
        upload = self.uploads[UploadId]
        _require(upload.key == Key, "the upload's own key")
        _require(1 <= PartNumber <= 10_000, 'a part number S3 takes')
        upload.parts[PartNumber] = bytes(Body)
        return {'ETag': f'"etag-{PartNumber}"'}

    def list_parts(self, *, Bucket: str, Key: str, UploadId: str, MaxParts: int,
                   PartNumberMarker: int = 0) -> dict[str, Any]:
        self._record('list_parts', Bucket, Key)
        numbers = sorted(number for number in self.uploads[UploadId].parts if number > PartNumberMarker)
        page = numbers[:MaxParts]
        truncated = len(numbers) > MaxParts
        return {'Parts': [{'PartNumber': number, 'ETag': f'"etag-{number}"'} for number in page],
                'IsTruncated': truncated, **({'NextPartNumberMarker': page[-1]} if truncated else {})}

    def complete_multipart_upload(self, *, Bucket: str, Key: str, UploadId: str,
                                  MultipartUpload: dict[str, Any]) -> dict[str, Any]:
        self._record('complete_multipart_upload', Bucket, Key)
        upload = self.uploads[UploadId]
        parts = MultipartUpload['Parts']
        _require([part['PartNumber'] for part in parts] == sorted(upload.parts), 'every uploaded part, in order')
        _require(all(part['ETag'] == f'"etag-{part["PartNumber"]}"' for part in parts), "each part's own ETag")
        if any(len(upload.parts[part['PartNumber']]) < self.min_part for part in parts[:-1]):
            # S3's own refusal: every part but the last is at least the minimum (5 MiB unless the test sets less).
            raise ClientError({'Error': {'Code': 'EntityTooSmall', 'Message': 'Your proposed upload is smaller than '
                                         'the minimum allowed size'}}, 'CompleteMultipartUpload')
        del self.uploads[UploadId]
        self.objects[Key] = (b''.join(upload.parts[part['PartNumber']] for part in parts), upload.tagging)
        return {}

    def list_multipart_uploads(self, *, Bucket: str, Prefix: str) -> dict[str, Any]:
        """One page holding every open upload under ``Prefix`` (never truncated)."""
        self._record('list_multipart_uploads', Bucket, Prefix)
        uploads = sorted((upload.key, upload_id) for upload_id, upload in self.uploads.items()
                         if upload.key.startswith(Prefix))
        return {'Uploads': [{'Key': key, 'UploadId': upload_id} for key, upload_id in uploads], 'IsTruncated': False}

    def abort_multipart_upload(self, *, Bucket: str, Key: str, UploadId: str) -> dict[str, Any]:
        self._record('abort_multipart_upload', Bucket, Key)
        self.uploads.pop(UploadId, None)
        self.aborted.append(UploadId)
        return {}

    def put_object(self, *, Bucket: str, Key: str, Body: bytes, Tagging: str) -> dict[str, Any]:
        self._record('put_object', Bucket, Key)
        self.objects[Key] = (bytes(Body), Tagging)
        return {}

    def delete_object(self, *, Bucket: str, Key: str) -> dict[str, Any]:
        self._record('delete_object', Bucket, Key)
        self.objects.pop(Key, None)
        return {}

    def get_object(self, *, Bucket: str, Key: str) -> dict[str, Any]:
        self._record('get_object', Bucket, Key)
        if Key not in self.objects:
            # What S3 answers a role whose s3:ListBucket carries an s3:prefix condition (the export job's): 403, not
            # 404, since the request names no prefix that would allow it to learn the key is missing.
            raise ClientError({'Error': {'Code': 'AccessDenied', 'Message': 'Access Denied'}}, 'GetObject')
        body = self.objects[Key][0]
        return {'Body': io.BytesIO(body), 'ContentLength': len(body),
                'ContentType': self.content_types.get(Key, 'binary/octet-stream')}

    def seed(self, key: str, body: bytes, content_type: str = 'binary/octet-stream') -> None:
        """An object the workspace already has (written by its ingestion, not by the export: no call recorded)."""
        self.objects[key] = (bytes(body), '')
        self.content_types[key] = content_type

    def list_objects_v2(self, *, Bucket: str, Prefix: str, MaxKeys: int, StartAfter: str = '') -> dict[str, Any]:
        """One page of the current objects under ``Prefix`` in S3's order (UTF-8 bytes), after ``StartAfter``."""
        self._record('list_objects_v2', Bucket, Prefix)
        self.listings.append({'Prefix': Prefix, 'StartAfter': StartAfter, 'MaxKeys': MaxKeys})
        keys = sorted((key for key in self.objects if key.startswith(Prefix)), key=_s3_order)
        after = [key for key in keys if _s3_order(key) > _s3_order(StartAfter)]
        page = after[:MaxKeys]
        return {'Contents': [{'Key': key, 'Size': len(self.objects[key][0])} for key in page],
                'IsTruncated': len(after) > MaxKeys, 'KeyCount': len(page)}

    def generate_presigned_url(self, ClientMethod: str, *, Params: dict[str, Any], ExpiresIn: int) -> str:
        self._record('generate_presigned_url', Params['Bucket'], Params['Key'])
        _require(ClientMethod == 'get_object', 'a download, never an upload link')
        self.last_presign = {**Params, 'ExpiresIn': ExpiresIn}
        return f'https://{Params["Bucket"]}.s3.example.com/{Params["Key"]}?X-Amz-Expires={ExpiresIn}'
