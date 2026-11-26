"""An erasure by email racing the boards' own edit routes, raw copies on (jobs/retention/boards.py, 7.72.03).

The boards phase deletes a matched row's raw folder, then reads the row again and changes it (a +1's re-key, a
contact's REMOVE, a request's de-identify). The routes write first and archive after (``put_support_route``:
``put_support`` then ``archive_support``; ``put_request``: ``update_request`` then ``archive_request``). An edit
landing between the folder delete and the change would leave a copy naming the address that nothing swept again: the
phase sweeps the folder once more after the change, whether it held or not. Each test runs the real route at that moment (from inside
the eraser's own read or write), then asserts no raw copy names the address. A later edit of a re-keyed +1's old id is
refused (``put_support(replacing=True)`` holds only while the row is there), so it archives nothing.
"""
from __future__ import annotations

import json
from collections.abc import Iterator
from typing import Any
from unittest.mock import patch

import pytest
from engagement_fixtures import BOARD, BOARD_2, call, ok, raw_boards_world

from jobs.retention import boards, boards_rekey, runs
from shared.feature_requests_store import request_key
from shared.test.raw_lake_fixtures import RAW_BUCKET

REPORTER = 'sam@acme.example'  # BOARD's address, as the store keeps it
SUPPORTER = 'kim@acme.example'  # BOARD_2's
CONTACT = 'partner.contact@example.com'
_PLUS_ONE = {'customer': 'Example Air', 'impact': 'committed', 'amount_usd': 50_000, 'name': 'A supporter'}


@pytest.fixture
def world() -> Iterator[tuple[Any, Any]]:
    with raw_boards_world() as pair:
        yield pair


def _file(ctx: Any) -> str:
    body = {'title': 'SSO with SAML', 'description': 'Needed for the enterprise tier', 'customer': 'Acme',
            'impact': 'at_risk', 'amount_usd': 120_000, 'name': 'A reporter'}
    return str(ok(ctx, 'POST', '/feature-requests', 201, claims=BOARD, body=body)['request']['request_id'])


def _plus_one(ctx: Any, request_id: str, **extra: Any) -> str:
    support = ok(ctx, 'POST', f'/feature-requests/{request_id}/supports', 201, claims=BOARD_2,
                 body={**_PLUS_ONE, **extra})['support']
    return str(support['support_id'])


def _edit_plus_one(ctx: Any, request_id: str, support_id: str, **extra: Any) -> tuple[int, Any]:
    return call(ctx, 'PUT', f'/feature-requests/{request_id}/supports/{support_id}', claims=BOARD_2,
                body={**_PLUS_ONE, 'amount_usd': 60_000, **extra})


def _eraser(w: Any, s3: Any, address: str) -> boards.BoardEraser:
    run = {**runs.new_run({}, 'erase'), 'field': 'email', 'job_id': 'er_00000000race', 'legal_basis': 'Art. 17'}
    return boards.BoardEraser(run, {'feature_requests': w.requests, 'aggregates': w.aggregates}, s3, RAW_BUCKET,
                              address)


def _row(w: Any, request_id: str, sk: str) -> dict[str, Any]:
    return w.requests.get_item(Key={'pk': f'FR#{request_id}', 'sk': sk})['Item']


def _copies_naming(s3: Any, address: str, item_id: str = '') -> list[str]:
    """The keys of every raw copy, every version, whose content names ``address`` (``item_id``: in that row's folder
    only)."""
    versions = s3.list_object_versions(Bucket=RAW_BUCKET, Prefix='raw/feature_requests/').get('Versions', [])
    found = []
    for version in versions:
        if item_id and version['Key'].split('/')[5] != item_id:
            continue
        body = s3.get_object(Bucket=RAW_BUCKET, Key=version['Key'], VersionId=version['VersionId'])['Body'].read()
        if address in json.dumps(json.loads(body)).lower():
            found.append(version['Key'])
    return found


def _once(action: Any) -> Any:
    """``action`` the first time the returned callable runs, never again."""
    done: list[bool] = []

    def run() -> None:
        if not done:
            done.append(True)
            action()
    return run


def _read_then(edit: Any) -> Any:
    """``boards_rekey.current_support`` as the eraser calls it, then ``edit`` (once): the edit lands after the
    eraser's read and before its write."""
    real = boards_rekey.current_support

    def read_then_edit(table: Any, rid: str, sid: str) -> dict[str, Any] | None:
        row = real(table, rid, sid)
        edit()
        return row
    return read_then_edit


def test_a_plus_one_edited_between_the_folder_delete_and_its_rekey_leaves_no_copy(world, lambda_context):
    """The edit lands after the eraser's read (its updated_at moves: the re-key is cancelled, read again, done) and
    archives its version into the old id's folder after the first sweep: the second sweep takes it."""
    w, s3 = world
    request_id = _file(lambda_context)
    support_id = _plus_one(lambda_context, request_id)
    scanned = _row(w, request_id, f'SUP#{support_id}')
    edit = _once(lambda: _edit_plus_one(lambda_context, request_id, support_id))

    with patch.object(boards_rekey, 'current_support', _read_then(edit)):
        _eraser(w, s3, SUPPORTER).erase(scanned)

    assert 'Item' not in w.requests.get_item(Key={'pk': f'FR#{request_id}', 'sk': f'SUP#{support_id}'})
    assert _copies_naming(s3, SUPPORTER) == []


def test_a_rekeyed_plus_ones_old_id_refuses_a_later_edit_and_archives_nothing(world, lambda_context):
    w, s3 = world
    request_id = _file(lambda_context)
    support_id = _plus_one(lambda_context, request_id)
    _eraser(w, s3, SUPPORTER).erase(_row(w, request_id, f'SUP#{support_id}'))

    status, _body = _edit_plus_one(lambda_context, request_id, support_id)

    assert status == 404
    assert _copies_naming(s3, SUPPORTER) == []


def test_a_contact_only_plus_one_edited_between_the_folder_delete_and_its_remove_leaves_no_copy(world,
                                                                                                 lambda_context):
    """The edit (its contact still the address) archives a version after the first sweep and before the REMOVE,
    which then holds: the second sweep takes the version."""
    w, s3 = world
    request_id = _file(lambda_context)
    support_id = _plus_one(lambda_context, request_id, contact_email=CONTACT)
    scanned = _row(w, request_id, f'SUP#{support_id}')
    assert scanned['contact_email'] == CONTACT
    edit = _once(lambda: _edit_plus_one(lambda_context, request_id, support_id, contact_email=CONTACT))

    with patch.object(boards_rekey, 'current_support', _read_then(edit)):
        _eraser(w, s3, CONTACT).erase(scanned)

    assert 'contact_email' not in _row(w, request_id, f'SUP#{support_id}')
    assert _copies_naming(s3, CONTACT) == []


def test_a_request_edited_between_the_folder_delete_and_its_deidentify_leaves_no_copy(world, lambda_context):
    """``put_request`` writes, then archives the row as written (its reporter still there) after the first sweep;
    the de-identify then holds and the second sweep takes the version."""
    w, s3 = world
    request_id = _file(lambda_context)
    scanned = _row(w, request_id, 'META')
    real = boards.deidentify
    edit = _once(lambda: ok(lambda_context, 'PUT', f'/feature-requests/{request_id}', claims=BOARD,
                            body={'title': 'SAML SSO'}))

    def edit_then_deidentify(table: Any, row: Any) -> bool:
        edit()
        return real(table, row)

    with patch.object(boards, 'deidentify', edit_then_deidentify):
        _eraser(w, s3, REPORTER).erase(scanned)

    meta = w.requests.get_item(Key=request_key(request_id))['Item']
    assert (meta['title'], 'reporter_email' in meta) == ('SAML SSO', False)
    # The request's own folder (the reporter's +1 is a row of its own, erased by its own match).
    assert _copies_naming(s3, REPORTER, request_id) == []
    assert _copies_naming(s3, REPORTER)  # the +1's copies are there: the check reads real objects


def test_a_change_that_does_not_hold_is_swept_again_and_not_counted(world, lambda_context):
    """Every matched row's folder is swept twice, whatever its change did: a +1 whose contact changed since the scan
    (no change made) has its folder listed twice, and is not counted."""
    w, s3 = world
    request_id = _file(lambda_context)
    support_id = _plus_one(lambda_context, request_id, contact_email=CONTACT)
    scanned = _row(w, request_id, f'SUP#{support_id}')
    _edit_plus_one(lambda_context, request_id, support_id, contact_email='someone.else@example.com')
    real = boards._delete_folder
    sweeps: list[str] = []

    def counted(client: Any, bucket: str, folder: str) -> int:
        sweeps.append(folder)
        return real(client, bucket, folder)

    eraser = _eraser(w, s3, CONTACT)
    with patch.object(boards, '_delete_folder', counted):
        eraser.erase(scanned)

    assert len(sweeps) == 2
    assert len(set(sweeps)) == 1
    assert boards.BOARD_COUNTER not in eraser._run
    assert _copies_naming(s3, CONTACT) == []


def test_an_edit_keeping_the_contact_then_one_changing_it_leave_no_copy(world, lambda_context):
    """After the first sweep, one edit keeps the contact (its version names the address), a second changes it: the
    REMOVE does not hold, and the second sweep still takes the first edit's version."""
    w, s3 = world
    request_id = _file(lambda_context)
    support_id = _plus_one(lambda_context, request_id, contact_email=CONTACT)
    scanned = _row(w, request_id, f'SUP#{support_id}')

    def keep_then_change() -> None:
        _edit_plus_one(lambda_context, request_id, support_id, contact_email=CONTACT)
        _edit_plus_one(lambda_context, request_id, support_id, contact_email='someone.else@example.com')

    eraser = _eraser(w, s3, CONTACT)
    with patch.object(boards_rekey, 'current_support', _read_then(_once(keep_then_change))):
        eraser.erase(scanned)

    assert _row(w, request_id, f'SUP#{support_id}')['contact_email'] == 'someone.else@example.com'
    assert boards.BOARD_COUNTER not in eraser._run
    assert _copies_naming(s3, CONTACT) == []


def test_an_edit_then_a_delete_of_the_row_leave_no_copy(world, lambda_context):
    """After the first sweep, an edit keeps the contact (its version names the address) and the supporter then
    removes the +1: the REMOVE finds no row, and the second sweep still takes the edit's version."""
    w, s3 = world
    request_id = _file(lambda_context)
    support_id = _plus_one(lambda_context, request_id, contact_email=CONTACT)
    scanned = _row(w, request_id, f'SUP#{support_id}')

    def edit_then_delete() -> None:
        _edit_plus_one(lambda_context, request_id, support_id, contact_email=CONTACT)
        ok(lambda_context, 'DELETE', f'/feature-requests/{request_id}/supports/{support_id}', claims=BOARD_2)

    eraser = _eraser(w, s3, CONTACT)
    with patch.object(boards_rekey, 'current_support', _read_then(_once(edit_then_delete))):
        eraser.erase(scanned)

    assert 'Item' not in w.requests.get_item(Key={'pk': f'FR#{request_id}', 'sk': f'SUP#{support_id}'})
    assert boards.BOARD_COUNTER not in eraser._run
    assert _copies_naming(s3, CONTACT) == []
