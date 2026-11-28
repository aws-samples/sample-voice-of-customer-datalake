"""The Product tab's source routes through the projects handler, on moto (shared/product_source_routes.py, 7.104.00):
an upload announced, a link added and read again, typed answers saved; their refusals (not https, not public, too
long, a second copy, the 21st source, the 11th link, the 31st link read of a day, a viewer, a stranger), and the
twin run in-line where a route hands it the source. The listing's view of every kind closes the file."""
from __future__ import annotations

import hashlib
from collections.abc import Iterator
from datetime import UTC, datetime, timedelta
from typing import Any
from unittest.mock import patch

import pytest
from moto_helpers import invoke, rest_event

from shared.product_source_routes import NOT_STARTED
from shared.product_sources import (
    MAX_DOCS_PER_PROJECT,
    MAX_LINK_READS_PER_DAY,
    MAX_LINKS_PER_PROJECT,
    MAX_PERSON_FILE_READS_PER_DAY,
    MAX_PERSON_LINK_READS_PER_DAY,
    file_read_counters,
    link_read_counters,
    link_reads_key,
)
from shared.test.library_fixtures import pdf
from shared.test.product_source_fixtures import PAGE_TEXT, PROJECT, SourcesWorld, sources_world

ADA = {'sub': 'sub-ada', 'cognito:username': 'ada', 'cognito:groups': 'users'}
VIC = {'sub': 'sub-vic', 'cognito:username': 'vic', 'cognito:groups': 'users'}
EVE = {'sub': 'sub-eve', 'cognito:username': 'eve', 'cognito:groups': 'users'}
BASE = f'/projects/{PROJECT}/product-docs'
LINK = 'https://www.example.com/product'
PDF = 'application/pdf'
DOC = pdf('Acme Notes turns each meeting into a summary with its decisions.')
#: The SHA-256 POST …/upload-url records on a PDF's row (the twin reads no file whose row declares none).
DOC_SHA256 = hashlib.sha256(DOC).hexdigest()
SOURCE_FIELDS = {'source_kind', 'injection_flag', 'method', 'pages', 'truncated', 'url', 'final_url', 'title',
                 'interview_mode'}


@pytest.fixture
def world() -> Iterator[SourcesWorld]:
    with sources_world() as built:
        yield built


@pytest.fixture
def call(world, lambda_context):
    def _call(method: str, path: str, *, caller: dict = ADA, body: Any = None) -> tuple[int, Any]:
        import product_context
        import projects_handler

        with patch.object(product_context, 'projects_table', world.projects):
            return invoke(projects_handler, rest_event(method, path, claims=caller, body=body), lambda_context,
                          projects=world.projects)

    return _call


def _invoked(world: SourcesWorld) -> list[dict]:
    return [entry.args[1] for entry in world.invoke.call_args_list]


def _private(world: SourcesWorld) -> None:
    """The project made private: Ada its owner, Vic a viewer, Eve nobody."""
    world.projects.put_item(Item={'pk': f'PROJECT#{PROJECT}', 'sk': 'META', 'project_id': PROJECT, 'status': 'active',
                                  'visibility': 'private', 'owner_sub': ADA['sub'],
                                  'members': {VIC['sub']: {'role': 'viewer', 'username': 'vic'}}})


# ── An upload announced ─────────────────────────────────────────────────────────────────────────────────────────


class TestUploaded:
    def test_a_landed_pdf_is_claimed_handed_to_the_twin_and_read(self, world, call):
        world.seed('d1', size_bytes=len(DOC), sha256=DOC_SHA256)
        world.upload('d1', 'pdf', DOC, PDF)
        status, body = call('POST', f'{BASE}/d1/uploaded')
        assert (status, body['doc']['status']) == (202, 'extracting')
        token = world.row('d1')['extract_token']
        assert _invoked(world) == [{'action': 'product_source_extract', 'project_id': PROJECT, 'doc_id': 'd1',
                                    'token': token}]
        assert world.run_worker() == [{'status': 'done'}]
        assert world.row('d1')['status'] == 'ready'

    def test_each_announced_upload_counts_as_one_of_the_persons_file_reads(self, world, call):
        world.seed('d1', size_bytes=len(DOC))
        world.upload('d1', 'pdf', DOC, PDF)
        call('POST', f'{BASE}/d1/uploaded')
        call('POST', f'{BASE}/d1/uploaded')  # idempotent: claimed already, not counted again
        [files] = file_read_counters(ADA['sub'], datetime.now(UTC), workspace=None)
        assert world.aggregates.get_item(Key=files.key)['Item']['count'] == 1

    def test_a_persons_sixty_first_file_read_is_a_429_and_the_upload_stays_pending(self, world, call):
        world.seed('d1', size_bytes=len(DOC))
        world.upload('d1', 'pdf', DOC, PDF)
        [files] = file_read_counters(ADA['sub'], datetime.now(UTC), workspace=None)
        world.aggregates.put_item(Item={**files.key, 'count': MAX_PERSON_FILE_READS_PER_DAY})
        status, body = call('POST', f'{BASE}/d1/uploaded')
        assert (status, body['code'], world.row('d1')['status']) == (429, 'rate_limited', 'pending')

    def test_announcing_it_again_is_idempotent(self, world, call):
        world.seed('d1', size_bytes=len(DOC))
        world.upload('d1', 'pdf', DOC, PDF)
        call('POST', f'{BASE}/d1/uploaded')
        status, body = call('POST', f'{BASE}/d1/uploaded')
        assert (status, body['doc']['status'], world.invoke.call_count) == (202, 'extracting', 1)

    def test_a_file_not_arrived_is_a_409_and_stays_pending(self, world, call):
        world.seed('d1')
        status, body = call('POST', f'{BASE}/d1/uploaded')
        assert (status, body['code'], world.row('d1')['status']) == (409, 'not_uploaded', 'pending')
        world.invoke.assert_not_called()

    def test_a_file_of_another_length_is_a_409(self, world, call):
        world.seed('d1', size_bytes=len(DOC) + 1)
        world.upload('d1', 'pdf', DOC, PDF)
        status, body = call('POST', f'{BASE}/d1/uploaded')
        assert (status, body['code']) == (409, 'upload_mismatch')
        world.invoke.assert_not_called()

    def test_an_upload_the_s3_extractor_reads_is_answered_as_it_is(self, world, call):
        world.seed('d1', content_type='text/markdown', filename='notes.md')
        status, body = call('POST', f'{BASE}/d1/uploaded')
        assert (status, body['doc']['status']) == (202, 'pending')
        world.invoke.assert_not_called()

    def test_an_unknown_source_is_a_404(self, call):
        assert call('POST', f'{BASE}/nope/uploaded') == (404, {'success': False, 'error': 'Product source not found'})

    def test_a_twin_that_cannot_be_invoked_fails_the_source_and_answers_500(self, world, call):
        world.seed('d1', size_bytes=len(DOC))
        world.upload('d1', 'pdf', DOC, PDF)
        world.invoke.side_effect = RuntimeError('throttled')
        status, body = call('POST', f'{BASE}/d1/uploaded')
        assert (status, body['error']) == (500, NOT_STARTED)
        assert (world.row('d1')['status'], world.row('d1')['error']) == ('failed', NOT_STARTED)


# ── A link ──────────────────────────────────────────────────────────────────────────────────────────────────────


class TestAddALink:
    def test_a_public_link_is_a_source_read_by_the_twin(self, world, call):
        world.pages.serve(LINK)
        status, body = call('POST', f'{BASE}/urls', body={'url': LINK})
        doc = body['doc']
        assert (status, doc['source_kind'], doc['url'], doc['status'], doc['filename']) == (
            201, 'url', LINK, 'extracting', LINK)
        assert world.row(doc['doc_id'])['created_by'] == {'sub': 'sub-ada', 'kind': 'user'}
        assert world.run_worker() == [{'status': 'done'}]
        assert world.text(doc['doc_id']) == PAGE_TEXT

    @pytest.mark.parametrize(('url', 'message'), [
        ('http://www.example.com/', 'This address is not allowed (only public https pages can be read)'),
        ('https://169.254.169.254/latest/meta-data/',
         'This address is not allowed (Access to internal/private IP addresses is not allowed)'),
        ('https://localhost/', 'This address is not allowed (Access to localhost is not allowed)'),
    ])
    def test_a_link_that_is_not_public_https_is_refused_and_nothing_written(self, world, call, url, message):
        status, body = call('POST', f'{BASE}/urls', body={'url': url})
        assert (status, body['code'], body['error']) == (400, 'url_not_allowed', message)
        assert (world.sources(), world.invoke.called) == ([], False)

    @pytest.mark.parametrize(('body', 'error'), [
        ({'url': 'https://www.example.com/' + 'a' * 2048}, 'url must be at most 2048 characters'),
        ({}, 'url is required'),
        ({'url': LINK, 'depth': 2}, 'Unknown field(s): depth'),
        ({'url': ['https://www.example.com/']}, 'url must be a string'),
    ])
    def test_a_malformed_link_is_a_400(self, world, call, body, error):
        status, answer = call('POST', f'{BASE}/urls', body=body)
        assert (status, answer['error'], world.sources()) == (400, error, [])

    def test_the_same_address_twice_is_a_409_naming_the_first(self, world, call):
        world.seed('d1', source_kind='url', url=LINK, status='ready')
        status, body = call('POST', f'{BASE}/urls', body={'url': 'https://WWW.example.com/product/'})
        assert (status, body['code'], body['doc_id']) == (409, 'duplicate', 'd1')

    def test_the_twenty_first_source_is_refused(self, world, call):
        for index in range(MAX_DOCS_PER_PROJECT):
            world.seed(f'd{index:02d}', status='ready')
        status, body = call('POST', f'{BASE}/urls', body={'url': LINK})
        assert (status, body['code'], len(world.sources())) == (400, 'too_many_sources', MAX_DOCS_PER_PROJECT)

    def test_the_eleventh_link_is_refused(self, world, call):
        for index in range(MAX_LINKS_PER_PROJECT):
            world.seed(f'l{index:02d}', source_kind='url', url=f'https://www.example.com/{index}', status='ready')
        status, body = call('POST', f'{BASE}/urls', body={'url': LINK})
        assert (status, body['code']) == (400, 'too_many_links')

    def test_the_thirty_first_link_read_of_a_day_is_a_429(self, world, call):
        key = link_reads_key(PROJECT, datetime.now(UTC), workspace=None)
        world.aggregates.put_item(Item={**key, 'count': MAX_LINK_READS_PER_DAY})
        status, body = call('POST', f'{BASE}/urls', body={'url': LINK})
        assert (status, body['code'], world.sources()) == (429, 'rate_limited', [])

    def test_the_sixty_first_link_read_of_a_persons_day_is_a_429_and_counts_no_project(self, world, call):
        # Review S8 (7.104.00 round 1): a person's link reads across every project, counted with the project's,
        # both or neither (shared/aws.py count_once).
        now = datetime.now(UTC)
        _project, person = link_read_counters(PROJECT, ADA['sub'], now, workspace=None)
        world.aggregates.put_item(Item={**person.key, 'count': MAX_PERSON_LINK_READS_PER_DAY})
        status, body = call('POST', f'{BASE}/urls', body={'url': LINK})
        assert (status, body['code'], world.sources()) == (429, 'rate_limited', [])
        assert world.aggregates.get_item(Key=link_reads_key(PROJECT, now, workspace=None)).get('Item') is None

    def test_a_link_read_is_counted_for_two_days(self, world, call):
        world.pages.serve(LINK)
        call('POST', f'{BASE}/urls', body={'url': LINK})
        counter = world.aggregates.get_item(Key=link_reads_key(PROJECT, datetime.now(UTC), workspace=None))['Item']
        assert counter['count'] == 1
        assert 0 < int(counter['ttl']) - datetime.now(UTC).timestamp() <= 2 * 24 * 3600


class TestRefresh:
    def test_a_read_link_is_read_again_under_a_new_claim(self, world, call):
        world.seed('l1', source_kind='url', url=LINK, status='ready', content_type='text/html')
        world.pages.serve(LINK)
        status, body = call('POST', f'{BASE}/l1/refresh')
        assert (status, body['doc']['status']) == (202, 'extracting')
        assert _invoked(world)[0]['token'] == world.row('l1')['extract_token']
        assert world.run_worker() == [{'status': 'done'}]

    def test_a_link_being_read_is_a_409(self, world, call):
        world.claimed('l1', source_kind='url', url=LINK, claimed_at=datetime.now(UTC).isoformat())
        status, body = call('POST', f'{BASE}/l1/refresh')
        assert (status, body['code']) == (409, 'extracting')

    def test_a_read_that_outlived_the_twin_is_read_again(self, world, call):
        stale = (datetime.now(UTC) - timedelta(seconds=961)).isoformat()
        world.claimed('l1', source_kind='url', url=LINK, claimed_at=stale)
        status, _ = call('POST', f'{BASE}/l1/refresh')
        assert (status, world.row('l1')['extract_token'] != 'tok-1') == (202, True)

    @pytest.mark.parametrize('fields', [{'content_type': 'text/markdown', 'status': 'failed'},
                                        {'source_kind': 'interview', 'content_type': 'text/markdown',
                                         'status': 'ready'}])
    def test_an_upload_the_extractor_reads_and_answers_are_not_read_again(self, world, call, fields):
        world.seed('d1', **fields)
        status, body = call('POST', f'{BASE}/d1/refresh')
        assert (status, body['code']) == (409, 'not_refreshable')

    def test_a_file_read_fine_is_a_409(self, world, call):
        world.seed('d1', status='ready')
        assert call('POST', f'{BASE}/d1/refresh')[1]['code'] == 'not_failed'

    def test_a_failed_file_whose_upload_never_arrived_is_a_409(self, world, call):
        world.seed('d1', status='failed', error='x')
        assert call('POST', f'{BASE}/d1/refresh')[1]['code'] == 'not_uploaded'

    def test_a_persons_sixty_first_file_read_of_a_day_is_a_429_and_the_file_stays_failed(self, world, call):
        # Review S8 (7.104.00 round 1): a person's reads of a PDF, DOCX or PPTX on the twin, a day.
        world.seed('d1', status='failed', error='earlier', size_bytes=len(DOC))
        world.upload('d1', 'pdf', DOC, PDF)
        [files] = file_read_counters(ADA['sub'], datetime.now(UTC), workspace=None)
        world.aggregates.put_item(Item={**files.key, 'count': MAX_PERSON_FILE_READS_PER_DAY})
        status, body = call('POST', f'{BASE}/d1/refresh')
        assert (status, body['code'], world.row('d1')['status']) == (429, 'rate_limited', 'failed')
        world.invoke.assert_not_called()

    def test_a_failed_file_is_read_again(self, world, call):
        world.seed('d1', status='failed', error='earlier', size_bytes=len(DOC), sha256=DOC_SHA256)
        world.upload('d1', 'pdf', DOC, PDF)
        status, body = call('POST', f'{BASE}/d1/refresh')
        assert (status, body['doc']['status'], body['doc']['error']) == (202, 'extracting', None)
        assert world.run_worker() == [{'status': 'done'}]


# ── Typed answers ───────────────────────────────────────────────────────────────────────────────────────────────

ANSWER = {'field': 'target_users', 'question': 'Who uses it?', 'answer': 'Team leads; write to lead@example.com'}


class TestAnswers:
    def test_typed_answers_are_one_ready_interview_source_redacted(self, world, call):
        status, body = call('POST', f'{BASE}/answers', body={
            'mode': 'typed', 'proposal_id': 'p-1',
            'answers': [ANSWER, {'field': 'product_name', 'question': 'Its name?', 'answer': '  '}]})
        doc = body['doc']
        assert (status, doc['source_kind'], doc['interview_mode'], doc['status']) == (
            201, 'interview', 'typed', 'ready')
        assert world.text(doc['doc_id']) == (
            '### Target users (`target_users`)\n**Question:** Who uses it?\n\n**Answer:** Team leads; write to [EMAIL]')
        row = world.row(doc['doc_id'])
        assert (row['created_by'], row['proposal_id']) == ({'sub': 'sub-ada', 'kind': 'user'}, 'p-1')
        world.invoke.assert_not_called()

    @pytest.mark.parametrize(('body', 'error'), [
        ({'mode': 'voice', 'answers': [ANSWER]}, "mode must be 'typed' (a voice interview is saved when it ends)"),
        ({'mode': 'typed', 'answers': [ANSWER] * 13}, 'answers must be a list of 1 to 12 answers'),
        ({'mode': 'typed', 'answers': []}, 'answers must be a list of 1 to 12 answers'),
        ({'mode': 'typed', 'answers': [{**ANSWER, 'answer': 'a' * 2001}]}, 'answer must be at most 2000 characters'),
        # One question cap, the extract's and the voice interview's (shared/product_fields.py, review F3).
        ({'mode': 'typed', 'answers': [{**ANSWER, 'question': 'q' * 201}]},
         'question must be at most 200 characters'),
        ({'mode': 'typed', 'answers': [{**ANSWER, 'field': 'pricing'}]},
         'an answer names a field the product description does not have'),
        ({'mode': 'typed', 'answers': [{**ANSWER, 'field': ['x']}]},
         'an answer names a field the product description does not have'),
        ({'mode': 'typed', 'answers': ['x']}, 'each answer must be an object: {field, question, answer}'),
        ({'mode': 'typed', 'answers': [{**ANSWER, 'answer': ' '}]}, 'Write at least one answer.'),
        ({'mode': 'typed', 'answers': [ANSWER], 'extra': 1}, 'Unknown field(s): extra'),
    ])
    def test_answers_outside_their_bounds_are_a_400_and_nothing_saved(self, world, call, body, error):
        status, answer = call('POST', f'{BASE}/answers', body=body)
        assert (status, answer['error'], world.sources()) == (400, error, [])

    def test_the_twenty_first_source_is_refused(self, world, call):
        for index in range(MAX_DOCS_PER_PROJECT):
            world.seed(f'd{index:02d}', status='ready')
        status, body = call('POST', f'{BASE}/answers', body={'mode': 'typed', 'answers': [ANSWER]})
        assert (status, body['code']) == (400, 'too_many_sources')


# ── Who may ─────────────────────────────────────────────────────────────────────────────────────────────────────

WRITES = [('POST', f'{BASE}/d1/uploaded', None), ('POST', f'{BASE}/d1/refresh', None),
          ('POST', f'{BASE}/urls', {'url': LINK}), ('POST', f'{BASE}/answers', {'mode': 'typed', 'answers': [ANSWER]})]


@pytest.mark.parametrize(('method', 'path', 'body'), WRITES)
def test_a_viewer_is_refused_every_write_and_nothing_changes(world, call, method, path, body):
    _private(world)
    world.seed('d1', source_kind='url', url=LINK, status='ready')
    before = world.sources()
    assert call(method, path, caller=VIC, body=body) == (
        403, {'success': False, 'error': 'You do not have permission to edit this project'})
    assert (world.sources(), world.invoke.called) == (before, False)


@pytest.mark.parametrize(('method', 'path', 'body'), WRITES)
def test_a_stranger_to_a_private_project_gets_its_404(world, call, method, path, body):
    _private(world)
    assert call(method, path, caller=EVE, body=body) == (404, {'success': False, 'error': 'Project not found'})


def test_a_viewer_lists_every_kind_with_the_nine_source_fields(world, call):
    _private(world)
    world.seed('f1', status='ready', content_type='text/markdown', filename='notes.md')
    world.seed('l1', source_kind='url', url=LINK, final_url=LINK, title='Acme', status='ready', method='text')
    world.seed('i1', source_kind='interview', interview_mode='typed', status='ready', content_type='text/markdown')
    status, body = call('GET', BASE, caller=VIC)
    by_id = {doc['doc_id']: doc for doc in body['docs']}
    assert status == 200
    assert (by_id['f1']['source_kind'], by_id['l1']['title'], by_id['i1']['interview_mode']) == (
        'file', 'Acme', 'typed')
    assert all(set(doc) == set(by_id['f1']) >= SOURCE_FIELDS for doc in body['docs'])
