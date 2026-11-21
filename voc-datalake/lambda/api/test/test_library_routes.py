"""The Documents Library's routes and extraction, end to end on moto (shared/library_routes.py, docs/documents-library.md).

Deployment-wide here (no ``X-Workspace-Id``) except where a test names a workspace; the two-workspace isolation of
every route is test_cross_workspace_routes.py's (cross_workspace_worlds.py ``library_world``).
"""
from __future__ import annotations

import hashlib
from collections.abc import Callable, Generator
from contextlib import ExitStack
from datetime import UTC, datetime, timedelta
from typing import Any
from unittest.mock import MagicMock, patch

import boto3
import pytest
from moto import mock_aws
from moto_helpers import invoke, pk_sk_table, rest_event

from shared import library_index, library_objects, library_routes, library_store, library_worker
from shared.library_keys import chunks_pk, item_key, slug_key
from shared.test.library_fixtures import docx, pdf
from shared.test.memory_fixtures import fake_vector

BUCKET = 'test-raw-data-bucket'
ADA = {'sub': 'sub-ada', 'cognito:username': 'ada', 'name': 'Ada Example', 'cognito:groups': 'users'}
BEN = {'sub': 'sub-ben', 'cognito:username': 'ben', 'cognito:groups': 'users'}
ADMIN = {'sub': 'sub-root', 'cognito:username': 'root', 'cognito:groups': '[admins, users]'}
WORD = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'


class Library:
    """The projects API over moto, with the worker run in-line when the route invokes it."""

    def __init__(self, table: Any, s3: Any, invoke_async: MagicMock, lambda_context: Any) -> None:
        self.table, self.s3, self.invoke_async, self.context = table, s3, invoke_async, lambda_context

    def call(self, method: str, path: str, *, caller: dict = ADA, body: Any = None,
             query: dict[str, str] | None = None) -> tuple[int, Any]:
        import projects_handler

        event = rest_event(method, path, claims=caller, body=body)
        event['queryStringParameters'] = query
        return invoke(projects_handler, event, self.context, projects=self.table)

    def upload(self, data: bytes, *, content_type: str = WORD, filename: str = 'Q3 Market Report.docx',
               caller: dict = ADA, extract: bool = True, **fields: Any) -> dict:
        """Create an item, PUT its bytes where the URL points, announce it and run the worker: the item."""
        status, body = self.call('POST', '/projects/library', caller=caller, body={
            'filename': filename, 'content_type': content_type, 'bytes': len(data), **fields})
        assert status == 201, body
        item_id = body['item']['item_id']
        self.s3.put_object(Bucket=BUCKET, Key=f'library/{item_id}/original', Body=data, ContentType=content_type)
        status, body = self.call('POST', f'/projects/library/{item_id}/uploaded', caller=caller)
        assert status == 202, body
        if extract:
            self.run_worker()
        return self.item(item_id)

    def run_worker(self) -> list[dict]:
        events = [call.args[1] for call in self.invoke_async.call_args_list]
        self.invoke_async.reset_mock()
        return [library_worker.run(event, self.table) for event in events]

    def item(self, item_id: str) -> dict:
        return self.table.get_item(Key=item_key(item_id))['Item']


@pytest.fixture
def library(lambda_context) -> Generator[Library]:
    with ExitStack() as stack:
        stack.enter_context(mock_aws())
        table = pk_sk_table('test-projects')
        s3 = boto3.client('s3', region_name='us-east-1')
        s3.create_bucket(Bucket=BUCKET)
        invoke_async = MagicMock(name='invoke_lambda_async')
        library_objects._client.clear()
        stack.callback(library_objects._client.clear)
        stack.enter_context(patch.object(library_routes, 'get_projects_table', return_value=table))
        stack.enter_context(patch.object(library_routes, 'invoke_lambda_async', invoke_async))
        stack.enter_context(patch.object(library_index, 'embed_text', side_effect=fake_vector))
        stack.enter_context(patch.dict('os.environ', {'ASSIST_WORKER_FUNCTION': 'voc-projects-assist',
                                                      'AWS_REGION': 'us-east-1'}))
        yield Library(table, s3, invoke_async, lambda_context)


REPORT = docx('Regional sales grew in the north after the new pricing.',
              'Customers in the south asked for faster delivery and fewer delays.')


def test_an_upload_is_presigned_bound_to_its_length_type_and_a_single_write(library):
    status, body = library.call('POST', '/projects/library', body={
        'filename': 'Q3 Market Report.docx', 'content_type': WORD, 'bytes': 1234, 'tags': ['Market', 'market', 'q3']})
    assert status == 201
    item, upload = body['item'], body['upload']
    assert item['status'] == 'pending'
    assert (item['title'], item['slug'], item['tags']) == ('Q3 Market Report', 'q3-market-report', ['market', 'q3'])
    assert item['created_by'] == {'sub': 'sub-ada', 'name': 'Ada Example'}
    assert upload['headers'] == {'Content-Type': WORD, 'If-None-Match': '*'}
    assert upload['expires_in'] == 900
    signed = upload['url'].split('X-Amz-SignedHeaders=')[1].split('&')[0]
    assert signed == 'content-length%3Bcontent-type%3Bhost%3Bif-none-match'
    assert f"library/{item['item_id']}/original" in upload['url']


def test_an_invited_member_without_a_name_is_stored_by_username_never_by_address(library):
    """An invited member's token has an email but no ``name`` claim: the stored created_by / updated_by name is the
    username (as document_review_routes._member_author), never the address an erasure would have to find."""
    invited = {**BEN, 'email': 'ben@example.com'}
    item = library.upload(REPORT, caller=invited, extract=False)
    assert item['created_by'] == item['updated_by'] == {'sub': 'sub-ben', 'name': 'ben'}
    status, body = library.call('PUT', f"/projects/library/{item['item_id']}", caller=invited,
                                body={'expected_version': 1, 'title': 'Renamed', 'slug': 'renamed', 'tags': []})
    assert status == 200, body
    assert library.item(item['item_id'])['updated_by'] == {'sub': 'sub-ben', 'name': 'ben'}
    assert 'ben@example.com' not in str(library.item(item['item_id']))


@pytest.mark.parametrize(('body', 'code'), [
    ({'filename': 'a.zip', 'content_type': 'application/zip', 'bytes': 10}, 'unsupported_type'),
    ({'filename': 'a.pdf', 'content_type': 'application/pdf', 'bytes': 25 * 1024 * 1024 + 1}, 'too_large'),
    ({'filename': 'a.png', 'content_type': 'image/png', 'bytes': 3_750_001}, 'too_large'),
])
def test_unsupported_and_oversize_files_are_refused_before_anything_is_written(library, body, code):
    status, answer = library.call('POST', '/projects/library', body=body)
    assert (status, answer.get('code')) == (400, code)
    assert library.table.scan()['Items'] == []


def test_a_chosen_slug_is_unique_and_a_generated_one_takes_the_next_free(library):
    first = library.call('POST', '/projects/library', body={'filename': 'Q3.pdf', 'content_type': 'application/pdf',
                                                            'bytes': 10, 'slug': 'q3-market'})[1]['item']
    status, taken = library.call('POST', '/projects/library', body={
        'filename': 'Other.pdf', 'content_type': 'application/pdf', 'bytes': 10, 'slug': 'q3-market'})
    assert (status, taken['code']) == (409, 'slug_taken')
    again = library.call('POST', '/projects/library', body={'filename': 'q3 market.pdf', 'title': 'Q3 market',
                                                            'content_type': 'application/pdf', 'bytes': 10})[1]
    assert again['item']['slug'] == 'q3-market-2'
    assert library.table.get_item(Key=slug_key('q3-market'))['Item']['item_id'] == first['item_id']


def test_the_uploaded_route_checks_the_object_and_the_worker_indexes_it(library):
    item = library.upload(REPORT, sha256=hashlib.sha256(REPORT).hexdigest())
    assert item['status'] == 'ready'
    assert int(item['chunks']) == 1
    assert item['native'] is True
    text = library.s3.get_object(Bucket=BUCKET, Key=f"library/{item['item_id']}/extracted")['Body'].read().decode()
    assert 'Regional sales grew' in text
    chunk = library.table.get_item(Key={'pk': chunks_pk(item['item_id']), 'sk': 'C#00001'})['Item']
    assert 'faster delivery' in chunk['text']
    assert 'extract_token' in item


def test_an_announced_upload_that_never_arrived_or_differs_is_refused(library):
    item = library.call('POST', '/projects/library', body={'filename': 'a.pdf', 'content_type': 'application/pdf',
                                                           'bytes': 10})[1]['item']
    path = f"/projects/library/{item['item_id']}/uploaded"
    assert library.call('POST', path)[1]['code'] == 'not_uploaded'
    library.s3.put_object(Bucket=BUCKET, Key=f"library/{item['item_id']}/original", Body=b'12345',
                          ContentType='application/pdf')
    assert library.call('POST', path) == (409, {'success': False, 'error': 'The uploaded file is not the one '
                                                'announced. Upload it again.', 'code': 'upload_mismatch'})
    library.invoke_async.assert_not_called()


def test_a_file_that_cannot_be_read_fails_with_its_reason_and_can_be_retried(library):
    item = library.upload(b'not a zip at all')
    assert item['status'] == 'failed'
    assert 'could not be opened' in item['error']
    status, body = library.call('POST', f"/projects/library/{item['item_id']}/retry")
    assert (status, body['item']['status']) == (202, 'extracting')
    assert library.run_worker() == [{'status': 'done'}]
    assert library.item(item['item_id'])['status'] == 'failed'
    assert library.call('POST', f"/projects/library/{item['item_id']}/retry")[0] == 202
    library.invoke_async.reset_mock()
    ready = library.upload(REPORT)
    assert library.call('POST', f"/projects/library/{ready['item_id']}/retry")[1]['code'] == 'not_failed'


def _started(library: Library, item_id: str, minutes_ago: int) -> None:
    """The item's extraction as if it had started ``minutes_ago`` (its worker never finished)."""
    started = (datetime.now(UTC) - timedelta(minutes=minutes_ago)).isoformat()
    library.table.update_item(Key=item_key(item_id), UpdateExpression='SET extract_started_at = :at',
                              ExpressionAttributeValues={':at': started})


def test_a_pending_item_whose_upload_link_expired_reads_stale(library):
    """Review round 2 (7.66.00): a pending item older than its PUT's lifetime gets no file, so it reads ``stale`` (no
    longer in flight: the SPA stops polling it) and is not retried (409 ``not_failed``: delete it, upload again)."""
    from shared.library_objects import UPLOAD_SECONDS
    from shared.library_store import STALE_UPLOAD_SECONDS
    assert STALE_UPLOAD_SECONDS > UPLOAD_SECONDS
    status, body = library.call('POST', '/projects/library', body={'filename': 'Q3.pdf', 'content_type': 'application/pdf',
                                                               'bytes': 10})
    assert status == 201
    item_id = body['item']['item_id']
    path = f'/projects/library/{item_id}'
    assert 'stale' not in library.call('GET', path)[1]['item']
    old = (datetime.now(UTC) - timedelta(seconds=STALE_UPLOAD_SECONDS + 5)).isoformat()
    library.table.update_item(Key=item_key(item_id), UpdateExpression='SET created_at = :at',
                              ExpressionAttributeValues={':at': old})
    item = library.call('GET', path)[1]['item']
    assert (item['status'], item['stale']) == ('pending', True)
    assert library.call('POST', f'{path}/retry')[1]['code'] == 'not_failed'


def test_an_extraction_that_outlived_its_worker_reads_stale_and_can_be_retried(library):
    """Round 1 Q16: 16 minutes or more since an extraction started, the item reads ``stale`` and a retry claims it
    again (202, a new token); a minute in, the retry is refused (409 ``not_failed``) and the item is not stale."""
    item = library.upload(REPORT, extract=False)
    item_id, path = item['item_id'], f"/projects/library/{item['item_id']}"
    first_token = library.item(item_id)['extract_token']
    _started(library, item_id, 1)
    assert 'stale' not in library.call('GET', path)[1]['item']
    assert library.call('POST', f'{path}/retry') == (409, {'success': False, 'code': 'not_failed',
                                                           'error': 'Only a failed item can be extracted again.'})
    _started(library, item_id, 17)
    assert library.call('GET', path)[1]['item']['stale'] is True
    library.invoke_async.reset_mock()
    status, body = library.call('POST', f'{path}/retry')
    assert (status, body['item']['status']) == (202, 'extracting')
    assert 'stale' not in body['item']
    new_token = library.item(item_id)['extract_token']
    assert new_token != first_token
    assert library.invoke_async.call_args.args[1]['token'] == new_token
    assert library.run_worker() == [{'status': 'done'}]
    assert library.item(item_id)['status'] == 'ready'


def test_a_sha256_that_does_not_match_fails_the_item(library):
    item = library.upload(REPORT, sha256='0' * 64)
    assert item['status'] == 'failed'
    assert 'does not match' in item['error']


def test_a_scanned_pdf_is_transcribed_by_bedrock_once(library):
    reply = {'output': {'message': {'content': [{'citationsContent': {'content': [{'text': 'Scanned invoice'}]}},
                                                 {'text': ' total 40'}]}}}
    with patch.object(library_worker, 'converse_blocks', return_value=reply) as converse:
        item = library.upload(pdf('', ''), content_type='application/pdf', filename='scan.pdf')
    assert item['status'] == 'ready'
    assert item['method'] == 'model'
    block = converse.call_args.args[1][0]['document']
    assert block['format'] == 'pdf'
    assert block['citations'] == {'enabled': True}
    assert converse.call_args.kwargs['surface'] == 'documents'
    assert 'form feed' in converse.call_args.args[1][1]['text']
    # Round 1 Q12: the two-page scan's transcription has no page break, so the item has no pages (never p.1 for all).
    assert 'pages' not in item
    assert library.call('GET', f"/projects/library/{item['item_id']}/text")[1]['paged'] is False


def test_a_transcription_cut_at_the_models_cap_is_marked_truncated(library):
    """Round 1 Q13: Bedrock's ``stopReason`` reaches the item: ``max_tokens`` marks it truncated."""
    reply = {'output': {'message': {'content': [{'text': 'The first page of a long scan'}]}},
             'stopReason': 'max_tokens'}
    with patch.object(library_worker, 'converse_blocks', return_value=reply):
        item = library.upload(pdf(''), content_type='application/pdf', filename='scan.pdf')
    assert (item['status'], item['truncated']) == ('ready', True)


def test_the_list_filters_sorts_and_pages(library):
    library.upload(REPORT, title='North report', tags=['market'], extract=False)
    library.upload(REPORT, title='South notes', tags=['support'], extract=False)
    status, body = library.call('GET', '/projects/library', query={'tag': 'market'})
    assert status == 200
    assert [item['title'] for item in body['items']] == ['North report']
    assert body['tags'] == ['market', 'support']
    titles = library.call('GET', '/projects/library', query={'sort': 'title', 'limit': '1'})[1]
    assert ([item['title'] for item in titles['items']], titles['next_cursor'], titles['total']) == (['North report'], '1', 2)
    assert library.call('GET', '/projects/library', query={'q': 'south'})[1]['total'] == 1
    assert library.call('GET', '/projects/library', query={'sort': 'size'})[0] == 400


def test_suggestions_offer_ready_items_only(library):
    ready = library.upload(REPORT, slug='q3-market')
    library.upload(REPORT, slug='q3-draft', extract=False)
    body = library.call('GET', '/projects/library/suggest', query={'q': 'q3'})[1]
    assert [item['item_id'] for item in body['items']] == [ready['item_id']]


def test_one_item_reads_with_its_excerpt_a_signed_original_and_its_text_by_part(library):
    item = library.upload(REPORT)
    status, body = library.call('GET', f"/projects/library/{item['item_id']}")
    assert status == 200
    assert body['preview']['text_excerpt'].startswith('Regional sales grew')
    assert 'response-content-disposition=attachment' in body['preview']['original_url']
    text = library.call('GET', f"/projects/library/{item['item_id']}/text", query={'page': '1'})[1]
    assert (text['page'], text['parts'], text['paged']) == (1, 1, False)
    assert library.call('GET', f"/projects/library/{item['item_id']}/text", query={'page': '2'})[0] == 400


def test_a_pdf_text_reads_by_page(library):
    pages = ('The first page of the annual review for Example Ltd', 'The second page lists the regional figures')
    item = library.upload(pdf(*pages), content_type='application/pdf', filename='review.pdf')
    body = library.call('GET', f"/projects/library/{item['item_id']}/text", query={'page': '2'})[1]
    assert (body['text'], body['parts'], body['paged']) == (pages[1], 2, True)


def test_an_unknown_or_malformed_id_is_the_one_404(library):
    for item_id in ('lib_20990101000000_00000000', 'nope', 'lib_x'):
        assert library.call('GET', f'/projects/library/{item_id}') == (
            404, {'success': False, 'error': 'Library item not found'})


def test_an_edit_needs_the_version_it_read(library):
    item = library.upload(REPORT, extract=False)
    path = f"/projects/library/{item['item_id']}"
    status, body = library.call('PUT', path, body={'expected_version': 1, 'title': 'Renamed', 'slug': 'renamed',
                                                   'tags': ['A']})
    assert status == 200
    assert (body['item']['title'], body['item']['slug'], body['item']['version'], body['item']['tags']) == (
        'Renamed', 'renamed', 2, ['a'])
    assert 'Item' not in library.table.get_item(Key=slug_key(item['slug']))
    assert library.table.get_item(Key=slug_key('renamed'))['Item']['item_id'] == item['item_id']
    stale = library.call('PUT', path, body={'expected_version': 1, 'title': 'Again'})
    assert (stale[0], stale[1]['code']) == (409, 'stale')
    assert library.call('PUT', path, body={'title': 'No version'})[0] == 400
    assert library.call('PUT', path, body={'expected_version': 2, 'colour': 'red'})[0] == 400


def test_a_project_link_must_name_a_project_the_caller_sees(library):
    status, body = library.call('POST', '/projects/library', body={
        'filename': 'a.pdf', 'content_type': 'application/pdf', 'bytes': 10, 'project_id': 'proj_hidden'})
    assert status == 404
    library.table.put_item(Item={'pk': 'PROJECT#proj_open', 'sk': 'META', 'project_id': 'proj_open',
                                 'visibility': 'public', 'owner_sub': 'sub-ben'})
    status, body = library.call('POST', '/projects/library', body={
        'filename': 'a.pdf', 'content_type': 'application/pdf', 'bytes': 10, 'project_id': 'proj_open'})
    assert (status, body['item']['project_id']) == (201, 'proj_open')


def test_only_an_admin_or_the_uploader_deletes_and_every_trace_goes(library):
    item = library.upload(REPORT)
    item_id = item['item_id']
    library.s3.put_object(Bucket=BUCKET, Key=f'library/{item_id}/original', Body=b'second version')
    assert library.call('DELETE', f'/projects/library/{item_id}', caller=BEN)[0] == 403
    status, body = library.call('DELETE', f'/projects/library/{item_id}', caller=ADMIN)
    assert (status, body) == (200, {'success': True, 'deleted': item_id})
    assert 'Item' not in library.table.get_item(Key=item_key(item_id))
    assert 'Item' not in library.table.get_item(Key=slug_key(item['slug']))
    assert library.table.query(KeyConditionExpression='pk = :p',
                               ExpressionAttributeValues={':p': chunks_pk(item_id)})['Items'] == []
    versions = library.s3.list_object_versions(Bucket=BUCKET, Prefix=f'library/{item_id}/')
    assert versions.get('Versions', []) == []
    assert versions.get('DeleteMarkers', []) == []
    audit = library.table.query(KeyConditionExpression='pk = :p', ExpressionAttributeValues={':p': 'AUDIT#delete'})
    row = audit['Items'][0]
    assert (row['kind'], row['actor']['sub']) == ('library_item', 'sub-root')
    assert library.table.get_item(Key={'pk': 'LIBRARY', 'sk': 'META'})['Item']['items'] == 0


def test_the_uploader_deletes_their_own(library):
    item = library.upload(REPORT, extract=False)
    assert library.call('DELETE', f"/projects/library/{item['item_id']}")[0] == 200


def _extract_and_meanwhile(library: Any, meanwhile: Callable[[str], object]) -> str:
    """Upload the report unextracted and run its extraction, ``meanwhile(item_id)`` right after the passages are
    written (a delete, a retry's claim, a revoked claim): the item's id."""
    item_id = library.upload(REPORT, extract=False)['item_id']
    events = [call.args[1] for call in library.invoke_async.call_args_list]
    real_write = library_index.write_chunks

    def write_then(*args: Any, **kwargs: Any) -> int:
        written = real_write(*args, **kwargs)
        meanwhile(item_id)
        return written

    with patch.object(library_worker, 'write_chunks', side_effect=write_then):
        assert library_worker.run(events[0], library.table) == {'status': 'done'}
    return item_id


def test_a_delete_during_extraction_leaves_nothing_behind(library):
    def delete(item_id: str) -> None:
        assert library.call('DELETE', f'/projects/library/{item_id}')[0] == 200

    item_id = _extract_and_meanwhile(library, delete)
    assert library.table.query(KeyConditionExpression='pk = :p',
                               ExpressionAttributeValues={':p': chunks_pk(item_id)})['Items'] == []
    listed = library.s3.list_object_versions(Bucket=BUCKET, Prefix=f'library/{item_id}/')
    assert listed.get('Versions', []) == []


def test_a_run_whose_item_was_claimed_again_stops_without_deleting(library):
    """Round 1 Q18: a retry that claimed the item meanwhile owns the passages and the text (they share their
    keys): the earlier run stops and deletes nothing."""
    def claim_again(item_id: str) -> None:
        library.table.update_item(Key=item_key(item_id), UpdateExpression='SET extract_token = :t',
                                  ExpressionAttributeValues={':t': 'f' * 16})

    item_id = _extract_and_meanwhile(library, claim_again)
    row = library.item(item_id)
    assert (row['status'], row['extract_token']) == ('extracting', 'f' * 16)
    _assert_output_kept(library, item_id)


def _assert_output_kept(library: Any, item_id: str) -> None:
    """The item's passages and its extracted text are still there."""
    assert library.table.query(KeyConditionExpression='pk = :p',
                               ExpressionAttributeValues={':p': chunks_pk(item_id)})['Items'] != []
    assert library.s3.get_object(Bucket=BUCKET, Key=f'library/{item_id}/extracted')['Body'].read()


def test_a_duplicate_delivery_of_one_claim_keeps_the_ready_items_output(library):
    """Review round 1 of the second gate (7.66.00): the same event delivered twice, its runs overlapping (one token):
    the second finishes first and the item is ready; the first's ready write is refused, and it keeps the passages and
    the text (the item is still claimed), never dropping a ready item's output."""
    events = [call.args[1] for call in library.invoke_async.call_args_list]
    seen: list[str] = []

    def duplicate(item_id: str) -> None:
        if seen:
            return
        seen.append(item_id)
        latest = [call.args[1] for call in library.invoke_async.call_args_list][len(events):]
        assert library_worker.run(latest[0], library.table) == {'status': 'done'}

    item_id = _extract_and_meanwhile(library, duplicate)
    assert library.item(item_id)['status'] == 'ready'
    _assert_output_kept(library, item_id)


def test_a_run_whose_claim_a_delete_revoked_drops_what_it_wrote(library):
    """A delete revokes the claim before it sweeps the passages and the files: a run that writes meanwhile, while the
    row is still there, finds no claim of its own and drops its passages and its text."""
    item_id = _extract_and_meanwhile(library, lambda item_id: library_store.revoke_claim(library.table, None, item_id))
    assert 'extract_token' not in library.item(item_id)
    assert library.table.query(KeyConditionExpression='pk = :p',
                               ExpressionAttributeValues={':p': chunks_pk(item_id)})['Items'] == []
    listed = library.s3.list_object_versions(Bucket=BUCKET, Prefix=f'library/{item_id}/extracted')
    assert listed.get('Versions', []) == []


def test_a_delete_that_fails_part_way_leaves_the_item_to_delete_again(library):
    """Round 1 Q17: the passages and the objects go first, the rows last, so a failure part way leaves the item
    (and its slug) to delete again, never passages or files that no item names."""
    item = library.upload(REPORT)
    item_id, path = item['item_id'], f"/projects/library/{item['item_id']}"
    with patch.object(library_routes, 'delete_chunks', side_effect=RuntimeError('DynamoDB is unavailable')):
        assert library.call('DELETE', path)[0] == 500
    assert 'Item' in library.table.get_item(Key=item_key(item_id))
    assert 'Item' in library.table.get_item(Key=slug_key(item['slug']))
    assert library.call('DELETE', path) == (200, {'success': True, 'deleted': item_id})
    assert 'Item' not in library.table.get_item(Key=item_key(item_id))
    assert library.table.query(KeyConditionExpression='pk = :p',
                               ExpressionAttributeValues={':p': chunks_pk(item_id)})['Items'] == []


def test_a_delete_whose_object_versions_were_refused_is_503_and_keeps_the_rows(library):
    """Review round 1 of the second gate (7.66.00): refused version deletes answer 503 before the rows go, so the item
    is there to delete again."""
    item = library.upload(REPORT)
    item_id, path = item['item_id'], f"/projects/library/{item['item_id']}"
    with patch.object(library_objects.LibraryObjects, 'delete_item', return_value=2):
        assert library.call('DELETE', path)[0] == 503
    assert 'Item' in library.table.get_item(Key=item_key(item_id))
    assert library.call('DELETE', path) == (200, {'success': True, 'deleted': item_id})


def test_the_context_signs_native_items_and_searches_the_others(library):
    small = library.upload(REPORT, slug='q3-market')
    big = library.upload(docx(*[f'Paragraph {n} about delivery delays in the south region.' for n in range(400)]),
                         slug='delivery-study', filename='study.docx')
    status, body = library.call('POST', '/projects/library/context', body={
        'item_ids': [small['item_id'], big['item_id'], 'lib_20990101000000_00000000'],
        'query': 'delivery delays south', 'native_slots': 1})
    assert status == 200
    assert [entry['item_id'] for entry in body['native']] == [small['item_id']]
    assert body['native'][0]['kind'] == 'document'
    assert body['native'][0]['url'].startswith('https://')
    assert body['missing'] == 1
    assert body['passages']
    assert all(passage['item_id'] == big['item_id'] for passage in body['passages'])
    assert len(body['passages']) <= 8
    assert sum(len(passage['text']) for passage in body['passages']) <= 12_000


def test_a_scanned_pdf_is_never_sent_as_a_file_its_passages_are_searched(library):
    """Review round 1 of the second gate (7.66.00): a PDF whose text Amazon Bedrock read (``method: model``) has no
    text layer, and a PDF sent without citations is read by it: such an item is searched, never attached."""
    scanned = library.upload(REPORT, slug='scanned-survey')
    library.table.update_item(Key=item_key(scanned['item_id']), UpdateExpression='SET #f = :pdf, #m = :model',
                              ExpressionAttributeNames={'#f': 'format', '#m': 'method'},
                              ExpressionAttributeValues={':pdf': 'pdf', ':model': 'model'})
    assert library.item(scanned['item_id'])['native'] is True
    body = library.call('POST', '/projects/library/context', body={
        'item_ids': [scanned['item_id']], 'query': 'faster delivery south', 'native_slots': 3})[1]
    assert body['native'] == []
    assert {passage['item_id'] for passage in body['passages']} == {scanned['item_id']}


def test_the_context_without_ids_finds_items_by_their_words(library):
    found = library.upload(REPORT, title='Delivery survey', slug='delivery-survey')
    library.upload(REPORT, title='Pricing', slug='pricing')
    body = library.call('POST', '/projects/library/context', body={'query': 'what does the delivery survey say'})[1]
    assert [item['item_id'] for item in body['items']] == [found['item_id']]
    assert body['passages'][0]['item_id'] == found['item_id']


def test_the_context_finds_items_by_their_slugs(library):
    found = library.upload(REPORT, slug='q3-market')
    body = library.call('POST', '/projects/library/context', body={'slugs': ['q3-market', 'nope', 'Bad Slug'],
                                                                   'query': 'delivery'})[1]
    assert [item['item_id'] for item in body['items']] == [found['item_id']]
    assert body['missing'] == 1


@pytest.mark.parametrize('body', [{}, {'item_ids': 'x', 'query': 'q'}, {'query': 'q', 'native_slots': 9},
                                  {'slugs': 'x', 'query': 'q'},
                                  {'query': 'q', 'budget': 99999}, {'item_ids': ['a'] * 6, 'query': 'q'}])
def test_the_context_refuses_a_malformed_request(library, body):
    assert library.call('POST', '/projects/library/context', body=body)[0] == 400


def test_a_reserved_segment_never_reaches_a_project_route(library):
    assert library.call('GET', '/projects/library/jobs')[0] == 404


def test_a_library_item_never_reaches_feedback(library):
    """Tenet 1: nothing of an item goes to voc-feedback, voc-aggregates or the processing queue."""
    with patch('shared.aws.get_sqs_client') as sqs:
        library.upload(REPORT)
    sqs.assert_not_called()
    names = boto3.client('dynamodb', region_name='us-east-1').list_tables()['TableNames']
    assert names == ['test-projects']
    keys = {row['pk'] for row in library.table.scan()['Items']}
    assert all(key == 'LIBRARY' or key.startswith('LIBRARY_CHUNKS#') for key in keys), keys
    objects = library.s3.list_objects_v2(Bucket=BUCKET).get('Contents', [])
    assert all(obj['Key'].startswith('library/') for obj in objects)


def test_the_worker_refuses_an_event_it_did_not_write(library):
    assert library_worker.run({'action': 'library_extract', 'item_id': 1}, library.table) == {'status': 'ignored'}
    assert library_worker.run({'action': 'library_extract', 'item_id': 'lib_x', 'token': 't',
                               'workspace_id': 'nope'}, library.table) == {'status': 'ignored'}
    assert library_worker.run({'action': 'library_extract', 'item_id': 'lib_20990101000000_00000000',
                               'token': 't'}, library.table) == {'status': 'skipped'}
    assert library_worker.is_extract_event({'action': 'library_extract'})
    assert not library_worker.is_extract_event({'action': 'assist_job'})
