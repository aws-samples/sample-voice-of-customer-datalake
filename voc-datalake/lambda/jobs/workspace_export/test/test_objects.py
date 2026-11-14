"""voc-workspace-export, slice 4b (jobs/workspace_export/objects.py): every current object of the workspace outside its
exports, in the zip as ``objects/<key without ws/{ws}/>``, whole, DEFLATE or STORE, resumed across invocations by its
last key; a key the zip cannot name, an object too large, too slow or gone is listed in the manifest instead; another
workspace's objects and the workspace's own exports are never listed or read."""
from __future__ import annotations

import gzip
import io
import json
import re
import zipfile
from datetime import timedelta
from pathlib import Path
from typing import Any
from unittest.mock import patch

import pytest
from botocore.exceptions import ResponseStreamingError

from jobs.workspace_export import handler, objects
from jobs.workspace_export.objects import ObjectsState, entry_for, stored
from jobs.workspace_export.test.conftest import EXPORT_ID, OTHER, WS, World, queue, seed
from shared import export_jobs, ws_repo
from shared.test.export_s3_double import ExportS3
from shared.ws_repo import OutOfScopeError, WorkspaceObjects, WorkspaceScope

ZIP_KEY = f'ws/{WS}/exports/{EXPORT_ID}/workspace-export.zip'
PREFIX = f'ws/{WS}/'
#: The workspace's objects: compressible JSON in raw/ and silver/, a gzip and a PNG (STORE), an SVG (DEFLATE), a file
#: in a folder of its own, and a key with spaces and non-ASCII characters.
OBJECTS: dict[str, tuple[bytes, str]] = {
    f'{PREFIX}raw/web/2026/11/13/item/a1.json': (b'{"text": "the checkout page"}' * 40, 'application/json'),
    f'{PREFIX}raw/web/2026/11/13/item/a2.json': (b'{"text": "a slow phone"}' * 40, 'application/json'),
    f'{PREFIX}raw/csv_upload/run1/reviews.csv.gz': (gzip.compress(b'id,text\n1,fast\n' * 50, mtime=0),
                                                    'application/octet-stream'),
    f'{PREFIX}raw/email/logo.png': (bytes(range(256)) * 4, 'image/png'),
    f'{PREFIX}raw/email/chart.svg': (b'<svg xmlns="http://www.w3.org/2000/svg"></svg>' * 20, 'image/svg+xml'),
    f'{PREFIX}memory-imports/notes.txt': (b'a note for the workspace\n' * 30, 'text/plain'),
    f'{PREFIX}silver/web/fb-1/20261113T090000000000Z-0a0b0c0d.json': (b'{"v": 1}' * 30, 'application/json'),
    f'{PREFIX}silver/web/café résumé.json': (b'{"v": 2}' * 30, 'application/json'),
}


def _name(key: str) -> str:
    return f'objects/{key.removeprefix(PREFIX)}'


def _seed_objects(world: World, extra: dict[str, tuple[bytes, str]] | None = None) -> None:
    for key, (body, content_type) in {**OBJECTS, **(extra or {})}.items():
        world.s3.seed(key, body, content_type)
    # Another workspace's objects, and this workspace's own earlier export: never listed into this one, never read.
    world.s3.seed(f'ws/{OTHER}/raw/web/2026/11/13/item/z.json', b'{"other": true}', 'application/json')
    world.s3.seed(f'{PREFIX}exports/ex_01JC3Q8ZK6V7W9X2Y4A5B6C7AA/workspace-export.zip', b'PK old', 'application/zip')


class _Budget:
    """A Lambda context whose time runs low once this invocation has read ``per_invocation`` objects (or always
    reads ``remaining`` milliseconds)."""

    function_name = 'voc-workspace-export'

    def __init__(self, s3: ExportS3, per_invocation: int | None, remaining: int = 900_000) -> None:
        self._s3 = s3
        self._limit = per_invocation
        self._remaining = remaining
        self._start = len(s3.calls)

    def read(self) -> int:
        return sum(1 for method, key in self._s3.calls[self._start:]
                   if method == 'get_object' and key.startswith(PREFIX) and '/exports/' not in key)

    def get_remaining_time_in_millis(self) -> int:
        # Low once the invocation opens one object more than its budget (it then hands over before copying it).
        return 60_000 if self._limit is not None and self.read() > self._limit else self._remaining


def _run(world: World, per_invocation: int | None = None, remaining: int = 900_000,
         events: list[dict[str, Any]] | None = None, reads: list[int] | None = None) -> list[dict[str, Any]]:
    """Every invocation of one export, each with its own budget; ``events`` gets each hand-over's payload and
    ``reads`` each invocation's object reads."""
    event, results = queue(world), []
    for _ in range(100):
        world.invoke.reset_mock()
        budget = _Budget(world.s3, per_invocation, remaining)
        result = handler.handle_event(event, budget)
        results.append(result)
        if reads is not None:
            reads.append(budget.read())
        if result['status'] != 'continued':
            return results
        [(_fn, event)] = [call.args for call in world.invoke.call_args_list]
        if events is not None:
            events.append(event)
    raise AssertionError('the export did not end')


def _archive(world: World) -> zipfile.ZipFile:
    archive = zipfile.ZipFile(io.BytesIO(world.s3.objects[ZIP_KEY][0]))
    assert archive.testzip() is None, 'every CRC checks'
    return archive


def _manifest(archive: zipfile.ZipFile) -> dict[str, Any]:
    return json.loads(archive.read('manifest.json'))


def _object_names(archive: zipfile.ZipFile) -> list[str]:
    return [name for name in archive.namelist() if name.startswith('objects/')]


def test_every_object_is_in_the_zip_byte_for_byte_across_several_invocations(world):
    seed(world)
    _seed_objects(world)
    results = _run(world, per_invocation=2)
    assert len(results) >= 4  # the objects alone take at least four
    assert results[-1]['status'] == 'completed'
    archive = _archive(world)
    names = _object_names(archive)
    assert sorted(names) == sorted(_name(key) for key in OBJECTS)
    assert len(names) == len(set(names))  # none twice across the hand-overs
    for key, (body, _type) in OBJECTS.items():
        assert archive.read(_name(key)) == body
    section = _manifest(archive)['objects']
    assert (section['count'], section['bytes']) == (len(OBJECTS), sum(len(body) for body, _ in OBJECTS.values()))
    assert (section['not_included'], section['not_included_count']) == ([], 0)
    assert {'folder', 'not_included_listed'}.isdisjoint(section)
    assert 'when the export' in section['versions']
    assert 'data descriptor' in section['reading']
    assert 'letter case' in section['reading']


def test_the_listing_resumes_mid_page_after_the_last_object_written(world):
    """Pages of three, two objects an invocation: a hand-over falls inside a page, and the next invocation lists
    from right after the last key it wrote, never repeating or skipping one."""
    seed(world)
    _seed_objects(world)
    with patch.object(ws_repo, '_LIST_OBJECTS_PAGE', 3):
        _run(world, per_invocation=2)
    ordered = sorted(OBJECTS, key=lambda key: key.encode())
    starts = [listing['StartAfter'] for listing in world.s3.listings]
    # The second object of the first page of three: a hand-over mid-page, resumed right after it.
    assert ordered[1] in starts
    assert all(listing['Prefix'] == PREFIX and listing['MaxKeys'] == 3 for listing in world.s3.listings)
    assert _object_names(_archive(world)) == [_name(key) for key in ordered]


def test_a_page_of_only_exports_keys_while_more_follow_goes_on_to_the_next(world):
    seed(world)
    first, last = f'{PREFIX}a-first.json', f'{PREFIX}zz-last.json'
    world.s3.seed(first, b'{"a": 1}', 'application/json')
    for n in range(4):
        world.s3.seed(f'{PREFIX}exports/ex_01JC3Q8ZK6V7W9X2Y4A5B6C7A{n}/workspace-export.zip', b'PK', 'application/zip')
    world.s3.seed(last, b'{"z": 1}', 'application/json')
    reader = WorkspaceObjects(WorkspaceScope(WS), world.s3, 'test-raw-data-bucket')
    with patch.object(ws_repo, '_LIST_OBJECTS_PAGE', 2):
        pages = [reader.list_page(None)]
        while pages[-1].following is not None:
            pages.append(reader.list_page(pages[-1].following))
        assert [[listed.key for listed in page.objects] for page in pages] == [[first], [], [last]]
        assert pages[1].following is not None  # a page of exports only, and more follow
        _run(world)
    assert _object_names(_archive(world)) == [_name(first), _name(last)]


@pytest.mark.parametrize(('key', 'why'), [
    (f'{PREFIX}raw/../../{OTHER}/raw/x.json', '".."'),
    (f'{PREFIX}raw//double.json', 'empty'),
    (f'{PREFIX}/absolute.json', 'empty'),
    (f'{PREFIX}raw/.. /x.json', 'dots and spaces'),
    (f'{PREFIX}raw/back\\slash.json', 'backslash'),
    (f'{PREFIX}raw/bell\x07.json', 'control'),
    (f'{PREFIX}raw/c1\x85.json', 'control'),
    (f'{PREFIX}raw/invoice{chr(0x202E)}gpj.exe', 'bidi'),  # U+202E RIGHT-TO-LEFT OVERRIDE
    (f'{PREFIX}raw/zero{chr(0x200B)}width.json', 'zero-width'),  # U+200B ZERO WIDTH SPACE
    (f'{PREFIX}raw/line{chr(0x2028)}sep.json', 'separator'),  # U+2028 LINE SEPARATOR
    (f'{PREFIX}raw/\udc80broken.json', 'UTF-8'),
])
def test_a_key_the_zip_cannot_name_is_skipped_and_listed_never_failing_the_export(world, key, why):
    seed(world)
    _seed_objects(world, {key: (b'hostile', 'application/json')})
    [result] = _run(world)
    assert result['status'] == 'completed'
    archive = _archive(world)
    assert not [name for name in archive.namelist() if 'hostile' in name or '..' in name]
    [skipped] = _manifest(archive)['objects']['not_included']
    assert skipped['reason'] == 'bad_name'
    assert why in skipped['detail']
    assert skipped['key'] == key.removeprefix(PREFIX).encode('utf-8', 'backslashreplace').decode()
    assert ('get_object', key) not in world.s3.calls  # never read
    assert _manifest(archive)['objects']['count'] == len(OBJECTS)


def test_an_object_too_large_for_one_invocation_is_listed_with_its_size_and_never_read(world):
    seed(world)
    big = f'{PREFIX}raw/video/meeting.mp4'
    _seed_objects(world, {big: (b'x' * 2048, 'video/mp4')})
    with patch.object(handler, 'MAX_OBJECT_BYTES', 2047):
        [result] = _run(world)
    assert result['status'] == 'completed'
    archive = _archive(world)
    section = _manifest(archive)['objects']
    assert section['not_included'] == [{'key': 'raw/video/meeting.mp4', 'size': 2048, 'reason': 'too_large',
                                        'detail': objects._REASONS['too_large']}]
    assert section['not_included_count'] == 1
    assert ('get_object', big) not in world.s3.calls
    assert _name(big) not in archive.namelist()


def _when_read(world: World, key: str, change: Any) -> None:
    """Run ``change()`` just before the export's GetObject of ``key`` (after its listing saw it)."""
    real_get = world.s3.get_object

    def get_object(**request: Any) -> dict[str, Any]:
        if request['Key'] == key:
            change()
        return real_get(**request)

    world.s3.get_object = get_object  # type: ignore[method-assign]


def _export_with_one_gone(world: World, gone: str) -> zipfile.ZipFile:
    """Run the export with ``gone`` deleted right before its read; it completes and lists that one key ``gone``."""
    _when_read(world, gone, lambda: world.s3.objects.pop(gone))
    [result] = _run(world)
    assert result['status'] == 'completed'
    archive = _archive(world)
    [skipped] = _manifest(archive)['objects']['not_included']
    assert (skipped['key'], skipped['reason']) == (gone.removeprefix(PREFIX), 'gone')
    return archive


def test_an_object_deleted_after_its_listing_is_listed_gone_though_s3_answers_403(world):
    """Under the job's IAM a GetObject of a missing key answers 403 (the double does so): the layer lists exactly
    that key (allowed by the prefix condition), finds nothing, and the export lists it gone and goes on."""
    seed(world)
    _seed_objects(world)
    gone = f'{PREFIX}raw/email/chart.svg'
    archive = _export_with_one_gone(world, gone)
    assert {'Prefix': gone, 'StartAfter': '', 'MaxKeys': 1} in world.s3.listings
    assert _name(gone) not in archive.namelist()


def test_a_403_for_a_key_that_is_still_listed_is_raised_and_fails_the_export(world):
    seed(world)
    _seed_objects(world)
    denied = f'{PREFIX}raw/email/chart.svg'
    real_get = world.s3.get_object

    def refuse(**request: Any) -> dict[str, Any]:
        if request['Key'] == denied:
            return real_get(Bucket=request['Bucket'], Key=f'{PREFIX}raw/not-there')
        return real_get(**request)

    world.s3.get_object = refuse  # type: ignore[method-assign]
    [result] = _run(world)
    assert result['status'] == 'failed'


class _Dropping(io.BytesIO):
    """A read stream that drops (as botocore raises a reset connection) after ``at`` bytes."""

    def __init__(self, body: bytes, at: int) -> None:
        super().__init__(body)
        self._at = at

    def read(self, size: int | None = -1) -> bytes:
        if self.tell() >= self._at:
            raise ResponseStreamingError(error='connection reset')
        limit = self._at - self.tell()
        return super().read(limit if size is None or size < 0 else min(size, limit))


def _drop_streams(world: World, key: str, drops: int, at: int, replace: bytes | None = None) -> list[dict[str, Any]]:
    """``key``'s first ``drops`` reads drop after ``at`` bytes (``replace``, if given, becomes its bytes at the first
    drop); returns every GetObject request for it."""
    real_get, requests = world.s3.get_object, []

    def get_object(**request: Any) -> dict[str, Any]:
        if request['Key'] == key:
            requests.append({name: value for name, value in request.items() if name in ('Range', 'IfMatch')})
        response = real_get(**request)
        if request['Key'] != key:
            return response
        if len(requests) <= drops:
            response['Body'] = _Dropping(response['Body'].read(), at)
            if replace is not None and len(requests) == 1:
                world.s3.seed(key, replace, 'application/json')
        return response

    world.s3.get_object = get_object  # type: ignore[method-assign]
    return requests


def test_a_dropped_read_stream_resumes_from_the_byte_reached_on_the_same_version(world):
    seed(world)
    _seed_objects(world)
    key = f'{PREFIX}raw/web/2026/11/13/item/a1.json'
    etag = world.s3.etag(key)
    requests = _drop_streams(world, key, drops=2, at=100)
    [result] = _run(world)
    assert result['status'] == 'completed'
    assert _archive(world).read(_name(key)) == OBJECTS[key][0]  # whole, byte for byte, nothing twice
    assert requests == [{}, {'Range': 'bytes=100-', 'IfMatch': etag}, {'Range': 'bytes=200-', 'IfMatch': etag}]


def test_a_stream_that_keeps_dropping_fails_the_export_after_two_resumes(world):
    seed(world)
    _seed_objects(world)
    key = f'{PREFIX}raw/web/2026/11/13/item/a1.json'
    requests = _drop_streams(world, key, drops=3, at=100)
    [result] = _run(world)
    assert result['status'] == 'failed'
    assert len(requests) == 1 + handler.STREAM_RESUMES


def test_an_object_replaced_while_its_stream_dropped_fails_the_export_never_splicing_versions(world):
    seed(world)
    _seed_objects(world)
    key = f'{PREFIX}raw/web/2026/11/13/item/a1.json'
    requests = _drop_streams(world, key, drops=1, at=100, replace=b'{"text": "a new version"}' * 40)
    [result] = _run(world)
    assert result['status'] == 'failed'
    assert requests[1]['IfMatch'] != world.s3.etag(key)  # refused by S3 (412), not read
    assert ZIP_KEY not in world.s3.objects


def test_the_layer_resumes_only_with_a_version_and_an_offset():
    s3 = ExportS3('raw-bucket')
    s3.seed(f'{PREFIX}raw/a.json', b'0123456789')
    layer = WorkspaceObjects(WorkspaceScope(WS), s3, 'raw-bucket')
    assert layer.resume(f'{PREFIX}raw/a.json', 4, s3.etag(f'{PREFIX}raw/a.json')).read() == b'456789'
    for etag, start in (('', 4), (s3.etag(f'{PREFIX}raw/a.json'), -1)):
        with pytest.raises(ValueError, match='names the version read and a byte offset'):
            layer.resume(f'{PREFIX}raw/a.json', start, etag)
    with pytest.raises(OutOfScopeError):
        layer.resume(f'ws/{OTHER}/raw/z.json', 0, '"x"')


def test_an_object_replaced_by_a_larger_version_after_its_listing_is_listed_too_large(world):
    seed(world)
    _seed_objects(world)
    grown = f'{PREFIX}raw/email/logo.png'
    _when_read(world, grown, lambda: world.s3.seed(grown, b'x' * 4096, 'image/png'))
    opened = _bodies(world)
    with patch.object(handler, 'MAX_OBJECT_BYTES', 2048):
        [result] = _run(world)
    assert result['status'] == 'completed'
    archive = _archive(world)
    [skipped] = _manifest(archive)['objects']['not_included']
    assert (skipped['key'], skipped['size'], skipped['reason']) == ('raw/email/logo.png', 4096, 'too_large')
    assert _name(grown) not in archive.namelist()
    [body] = opened[grown]
    assert body.closed


def _bodies(world: World) -> dict[str, list[Any]]:
    """Every body the export's GetObjects returned, by key (to check each of the workspace's objects was closed; the
    export's own work objects are read whole by ``ExportObjects.read_object``)."""
    opened: dict[str, list[Any]] = {}
    real_get = world.s3.get_object

    def get_object(**request: Any) -> dict[str, Any]:
        response = real_get(**request)
        opened.setdefault(request['Key'], []).append(response['Body'])
        return response

    world.s3.get_object = get_object  # type: ignore[method-assign]
    return opened


def test_an_object_too_slow_even_for_a_fresh_invocation_is_listed_never_started(world):
    """At one byte a second, twice the estimate (the margin) of an object of 360 bytes or more exceeds a fresh
    invocation's budget (``FRESH_BUDGET_MS``, 720 s), however much time this one has: listed too_slow, its body
    closed unread; the smaller ones are copied."""
    seed(world)
    _seed_objects(world)
    opened = _bodies(world)
    with patch.object(objects, 'CONSERVATIVE_RATE', 1):
        [result] = _run(world)
    assert result['status'] == 'completed'
    slow = {key for key, (body, _type) in OBJECTS.items() if 2 * len(body) * 1000 >= handler.FRESH_BUDGET_MS}
    assert slow
    archive = _archive(world)
    assert sorted(_object_names(archive)) == sorted(_name(key) for key in set(OBJECTS) - slow)
    section = _manifest(archive)['objects']
    assert sorted(item['key'] for item in section['not_included']) == sorted(key.removeprefix(PREFIX) for key in slow)
    assert {item['reason'] for item in section['not_included']} == {'too_slow'}
    assert all(body.closed for key in OBJECTS for body in opened.get(key, []))


def test_a_large_object_is_never_estimated_faster_than_the_conservative_rate_and_freshness_is_judged_by_time(
        world):
    """A fast measured rate (small JSON objects copy in no time here) does not carry over to a large object: it is
    estimated at the conservative rate, with the margin. With 180 seconds left it does not fit: the invocation hands
    over, the next one too though it has written nothing yet (freshness is time, not what it wrote), and a fresh one
    copies it. One that would not fit even a fresh one is listed too_slow, never started. Every body is closed."""
    seed(world)
    big, huge = f'{PREFIX}raw/big.bin', f'{PREFIX}raw/huge.bin'
    _seed_objects(world, {big: (bytes(range(256)) * 8, 'binary/octet-stream'),  # 2,048 bytes: 410 s allowed
                          huge: (bytes(range(256)) * 16, 'binary/octet-stream')})  # 4,096 bytes: 820 s allowed
    opened = _bodies(world)
    results, reads, event = [], [], queue(world)
    with patch.object(objects, 'CONSERVATIVE_RATE', 10), patch.object(objects, 'LARGE_OBJECT_BYTES', 1024), \
            patch.object(objects, 'MEASURED_AFTER_BYTES', 1), patch.object(objects, 'MIN_MEASURED_COPY', 1):
        for remaining in (300_000, 300_000, *[900_000] * 10):
            world.invoke.reset_mock()
            budget = _Budget(world.s3, None, remaining)
            results.append(handler.handle_event(event, budget))
            reads.append(budget.read())
            if results[-1]['status'] != 'continued':
                break
            [(_fn, event)] = [call.args for call in world.invoke.call_args_list]
    assert results[-1]['status'] == 'completed'
    assert reads[1] == 1  # the second invocation opened big.bin, and handed over without starting it
    archive = _archive(world)
    assert archive.read(_name(big)) == bytes(range(256)) * 8
    assert _name(huge) not in archive.namelist()
    [slow] = _manifest(archive)['objects']['not_included']
    assert (slow['key'], slow['reason']) == ('raw/huge.bin', 'too_slow')
    assert len(opened[big]) >= 3  # opened by both short invocations, then copied
    assert all(body.closed for key, bodies in opened.items() if '/exports/' not in key for body in bodies)


def test_a_folder_marker_is_skipped_quietly(world):
    seed(world)
    marker = f'{PREFIX}raw/folder/'
    _seed_objects(world, {marker: (b'', 'application/x-directory')})
    [result] = _run(world)
    assert result['status'] == 'completed'
    archive = _archive(world)
    assert _manifest(archive)['objects']['not_included'] == []
    assert ('get_object', marker) not in world.s3.calls
    assert not [name for name in archive.namelist() if name.endswith('/')]


def test_a_gone_key_that_is_a_prefix_of_a_live_one_is_listed_gone(world):
    """raw/a is deleted after its listing while raw/a.json stays: the one-key listing of raw/a finds raw/a.json
    first, which is not raw/a, so raw/a is gone."""
    seed(world)
    gone, live = f'{PREFIX}raw/a', f'{PREFIX}raw/a.json'
    _seed_objects(world, {gone: (b'a', 'text/plain'), live: (b'{"a": 1}', 'application/json')})
    archive = _export_with_one_gone(world, gone)
    assert archive.read(_name(live)) == b'{"a": 1}'


@pytest.mark.parametrize('store', [True, False], ids=['store', 'deflate'])
def test_the_largest_object_fits_a_fresh_invocation_at_the_conservative_rate(store):
    """The pin: ``seconds_for`` (the margin included) of a ``MAX_OBJECT_BYTES`` object, at the conservative rate,
    stays inside a fresh invocation's budget, so the size cap and the time rule agree."""
    allowed_ms = ObjectsState().seconds_for(objects.MAX_OBJECT_BYTES, store=store) * 1000
    assert allowed_ms < handler.FRESH_BUDGET_MS


def test_the_run_limit_matches_the_buckets_lifecycle_and_keeps_the_download_window_whole():
    """The pin: the handler's copies of the bucket's export expiry and multipart abort are the stack's own, and a run
    ends while the whole download window fits before the zip expires and the upload is still open."""
    stack = (Path(__file__).resolve().parents[4] / 'lib/stacks/core-buckets.ts').read_text(encoding='utf-8')
    for name in ('EXPORT_EXPIRATION_DAYS', 'ABORT_MULTIPART_DAYS'):
        match = re.search(rf'export const {name} = (\d+);', stack)
        assert match, name
        assert int(match.group(1)) == getattr(handler, name), name
    window = timedelta(days=export_jobs.DOWNLOAD_DAYS)
    expiry, abort = timedelta(days=handler.EXPORT_EXPIRATION_DAYS), timedelta(days=handler.ABORT_MULTIPART_DAYS)
    longest = handler.MAX_RUN
    assert longest + window < expiry
    assert longest < abort


def test_an_export_still_running_past_the_run_limit_fails_saying_why_and_aborts_its_upload(world):
    seed(world)
    _seed_objects(world)
    first = handler.handle_event(queue(world), _Budget(world.s3, 2))
    assert first['status'] == 'continued'  # within the limit: as before, an upload open
    [(_fn, event)] = [call.args for call in world.invoke.call_args_list]
    with patch.object(handler, 'MAX_RUN', timedelta(0)):
        result = handler.handle_event(event, _Budget(world.s3, None))
    assert result['status'] == 'failed'
    row = world.aggregates.get_item(Key={'pk': f'WS#{WS}#JOB#export', 'sk': EXPORT_ID})['Item']
    assert (row['status'], row['error']) == ('failed', handler.RAN_TOO_LONG)
    assert world.s3.aborted  # the open upload aborted
    assert not world.s3.uploads
    assert ZIP_KEY not in world.s3.objects  # no zip (work objects expire with the export tag, as on every failure)


def test_thousands_of_small_copies_do_not_slow_the_rate_a_large_object_is_judged_at():
    """Small copies are mostly their request's fixed cost: they never count toward the rate, so a 3 GiB object after
    three thousand of them is still allowed the conservative rate's time and starts in a fresh invocation."""
    state = ObjectsState()
    for _ in range(3000):
        state.measured(False, 4 * 1024, 0.05)  # 80 KiB/s, if it counted
    assert state.rates == {}
    allowed_ms = state.seconds_for(objects.MAX_OBJECT_BYTES, store=False) * 1000
    assert allowed_ms < handler.FRESH_BUDGET_MS
    state.measured(False, objects.MIN_MEASURED_COPY, 1.0)  # a copy large enough counts
    assert state.rates == {'deflate': [float(objects.MIN_MEASURED_COPY), 1.0]}


def test_the_rate_is_measured_per_kind_with_the_margin_and_carried_across_invocations():
    mib = 1024 * 1024
    state = ObjectsState()
    assert state.seconds_for(10 * mib, store=True) == pytest.approx(2.0)  # the conservative 10 MiB/s, twice
    state.measured(True, 64 * mib, 1.0)  # STORE: 64 MiB/s
    state.measured(False, 8 * mib, 1.0)  # DEFLATE: too little measured yet (under 16 MiB)
    carried = ObjectsState.from_json(json.loads(json.dumps(state.to_json())))
    assert carried.seconds_for(128 * mib, store=True) == pytest.approx(4.0)
    assert carried.seconds_for(10 * mib, store=False) == pytest.approx(2.0)
    # Over 256 MiB: never faster than the conservative rate, however fast the kind measured.
    assert carried.seconds_for(512 * mib, store=True) == pytest.approx(2 * 51.2)
    assert carried == state


def test_a_hand_over_with_fifty_long_control_character_keys_stays_small(world):
    """Fifty keys of about 1,024 bytes, each full of control characters (each escaped to six bytes in JSON): every
    hand-over's event stays far under Lambda's 256 KB, each listed key is cut and marked, and the list stays under
    its byte cap; every one is counted."""
    seed(world)
    hostile = {f'{PREFIX}raw/{n:02d}' + '\x07' * (1024 - len(PREFIX) - 7): (b'x', 'text/plain') for n in range(50)}
    _seed_objects(world, hostile)
    events: list[dict[str, Any]] = []
    _run(world, per_invocation=1, events=events)
    assert events
    assert max(len(json.dumps(event)) for event in events) < 64 * 1024
    section = _manifest(_archive(world))['objects']
    assert section['not_included_count'] == 50
    assert section['not_included']
    assert all(item['truncated'] and len(item['key']) == objects.MAX_LISTED_KEY for item in section['not_included'])
    assert len(json.dumps(section['not_included'])) <= objects.MAX_LISTED_BYTES


def test_compressed_bytes_are_stored_and_the_rest_deflated(world):
    seed(world)
    _seed_objects(world)
    _run(world)
    methods = {info.filename.removeprefix('objects/'): info.compress_type for info in _archive(world).infolist()
               if info.filename.startswith('objects/')}
    assert methods['raw/csv_upload/run1/reviews.csv.gz'] == zipfile.ZIP_STORED  # by its extension
    assert methods['raw/email/logo.png'] == zipfile.ZIP_STORED  # by its content type
    assert methods['raw/email/chart.svg'] == zipfile.ZIP_DEFLATED  # an image that is text
    assert methods['raw/web/2026/11/13/item/a1.json'] == zipfile.ZIP_DEFLATED
    assert methods['memory-imports/notes.txt'] == zipfile.ZIP_DEFLATED


@pytest.mark.parametrize(('content_type', 'key', 'store'), [
    ('image/jpeg', 'a/b', True), ('image/png; charset=binary', 'a/b', True), ('image/bmp', 'a/b', True),
    ('application/zip', 'a/b', True), ('application/gzip', 'a/b', True), ('application/epub+zip', 'a/b', True),
    ('application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'a/b', True),
    ('application/vnd.oasis.opendocument.spreadsheet', 'a/b', True), ('application/java-archive', 'a/b', True),
    ('binary/octet-stream', 'a/b.tar.gz', True), ('binary/octet-stream', 'a/photo.JPG', True),
    ('binary/octet-stream', 'a/report.xlsx', True), ('binary/octet-stream', 'a/book.epub', True),
    ('image/svg+xml', 'a/b.svg', False), ('video/mp4', 'a/b', False), ('audio/mpeg', 'a/b', False),
    ('application/x-bzip2', 'a/b', False), ('application/json', 'a/b.json', False), ('', 'a/.gz', False),
    ('text/csv', 'a/b.csv', False), ('', 'a/b', False),
])
def test_the_store_rule(content_type, key, store):
    assert stored(content_type, key) is store


def test_another_workspaces_objects_and_the_exports_are_never_listed_or_read(world):
    seed(world)
    _seed_objects(world)
    _run(world, per_invocation=3)
    reads = [key for method, key in world.s3.calls if method == 'get_object']
    assert not [key for key in reads if key.startswith(f'ws/{OTHER}/')]
    assert not [key for key in reads if key.startswith(f'{PREFIX}exports/') and f'/{EXPORT_ID}/' not in key]
    assert {listing['Prefix'] for listing in world.s3.listings} == {PREFIX}
    names = _archive(world).namelist()
    assert not [name for name in names if name.startswith('objects/exports/') or OTHER in name]


def test_the_layer_reads_only_the_workspaces_own_objects():
    s3 = ExportS3('raw-bucket')
    reader = WorkspaceObjects(WorkspaceScope(WS), s3, 'raw-bucket')
    s3.seed(f'{PREFIX}raw/a.json', b'a')
    s3.seed(f'{PREFIX}exports/ex_1/workspace-export.zip', b'PK')
    s3.seed(f'ws/{OTHER}/raw/b.json', b'b')
    page = reader.list_page(None)
    assert ([listed.key for listed in page.objects], page.following) == ([f'{PREFIX}raw/a.json'], None)
    for key in (f'{PREFIX}exports/ex_1/workspace-export.zip', f'ws/{OTHER}/raw/b.json', f'{PREFIX}raw/../x',
                f'{PREFIX}raw//x', 'raw/a.json'):
        with pytest.raises(OutOfScopeError):
            reader.open(key)
    with pytest.raises(OutOfScopeError):
        reader.list_page(f'ws/{OTHER}/raw/b.json')
    opened = reader.open(f'{PREFIX}raw/gone.json')
    assert opened is None
    # The gone one: its read (403) and its one-key listing; the rest were refused before any call.
    assert [method for method, _key in s3.calls].count('get_object') == 1
    assert s3.listings[-1] == {'Prefix': f'{PREFIX}raw/gone.json', 'StartAfter': '', 'MaxKeys': 1}


def test_a_listing_that_returns_another_workspaces_key_is_refused():
    class Leaky(ExportS3):
        def list_objects_v2(self, *, Bucket: str, Prefix: str, MaxKeys: int, StartAfter: str = '') -> dict[str, Any]:
            super().list_objects_v2(Bucket=Bucket, Prefix=Prefix, MaxKeys=MaxKeys, StartAfter=StartAfter)
            return {'Contents': [{'Key': f'ws/{OTHER}/raw/b.json', 'Size': 1}], 'IsTruncated': False}

    with pytest.raises(OutOfScopeError):
        WorkspaceObjects(WorkspaceScope(WS), Leaky('raw-bucket'), 'raw-bucket').list_page(None)


def test_the_entry_name_and_the_skip_list_caps():
    scope = WorkspaceScope(WS)
    assert entry_for(scope, f'{PREFIX}raw/a b/é.json') == ('objects/raw/a b/é.json', None)
    assert entry_for(scope, f'{PREFIX}raw/../x')[0] is None
    assert entry_for(scope, f'{PREFIX}raw/a.b./x')[0] == 'objects/raw/a.b./x'  # a dot that is not the whole segment
    state = ObjectsState()
    for n in range(objects.MAX_LISTED_SKIPS + 5):
        state.skip(f'raw/{n}', 1, 'gone')
    assert (len(state.skipped), state.skipped_count) == (objects.MAX_LISTED_SKIPS, objects.MAX_LISTED_SKIPS + 5)
    assert ObjectsState.from_json(state.to_json()) == state
