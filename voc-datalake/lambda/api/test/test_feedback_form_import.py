"""An imported form and its rows (7.67.00, the import wizard, docs/import-wizard.md): ``imported`` on
``POST /feedback-forms`` and ``POST /feedback-forms/{form_id}/import``.

An imported form is a real Feedback Form v2 (the server's own validation), Off for good with no public link: the public
routes answer it as an unknown id, a save cannot turn it on and it takes no test link. Its rows are imported by an admin
acting as themselves (a workspace's admin in one; an editor 403, a delegated caller 403), each checked for its types
and ranges but never the form's logic, queued as a response dated with its own date under the form's brand partition
(revision 1, NPS in ``form_answers`` and never the rating, which is never 0), the original file kept write-once in the
bronze layer (``ws/{ws}/raw/…`` in a workspace) and the run recorded. A dry run writes nothing. Made-up data only.
"""
from __future__ import annotations

import base64
import json
import threading
import time
from collections.abc import Iterator
from contextlib import ExitStack
from typing import Any
from unittest.mock import MagicMock, patch

import boto3
import pytest
from botocore.exceptions import ClientError
from moto import mock_aws
from moto_helpers import pk_sk_table, rest_event, workspace_route_call
from test_feedback_form_workspace import wire_form_handler

import feedback_form_handler as h
from shared import forms_v2_import as fimp
from shared.import_runs import _put_rows as write_run_rows
from shared.ingest_schemas import IngestMessage
from shared.test.source_profile_fixtures import seeded_source_profiles

WS = 'ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D8'
ADMIN = {'sub': 'sub-ad', 'cognito:groups': 'admins', 'cognito:username': 'ad'}
WS_ADMIN = {'sub': 'sub-wa', 'cognito:groups': 'users', 'cognito:username': 'wa'}
EDITOR = {'sub': 'sub-ed', 'cognito:groups': 'users', 'cognito:username': 'ed'}
DELEGATED = {'sub': 'mcp:token-1', 'voc:acting_subject': 'sub-ad', 'cognito:groups': 'admins'}
BUCKET = 'raw-bucket'
QUEUE = 'https://sqs.example.com/queue'
IMPORTED = {'from': 'Survey tool', 'at': '2026-11-21T09:00:00Z', 'filename': 'workshop-results.csv'}
FORM = {
    'name': 'Workshop (imported)', 'language': 'en', 'imported': IMPORTED, 'hidden_fields': [{'id': 'channel'}],
    'questions': [
        {'id': 'q_nps', 'type': 'nps', 'headline': {'en': 'How likely are you to recommend us?'}},
        {'id': 'q_plan', 'type': 'single_select', 'headline': {'en': 'Which plan?'},
         'options': [{'code': 'pro', 'label': {'en': 'Pro'}}, {'code': 'free', 'label': {'en': 'Free'}}]},
        {'id': 'q_csat', 'type': 'csat', 'headline': {'en': 'Satisfied?'}},
        {'id': 'q_why', 'type': 'open_text', 'long': True, 'headline': {'en': 'Why?'}},
    ],
    'endings': [{'id': 'end_thanks', 'title': {'en': 'Thank you!'}}],
}
MAPPING = {'Response ID': 'id', 'Submitted': 'date', 'NPS': 'q_nps', 'Plan': 'q_plan', 'CSAT': 'q_csat',
           'Why': 'q_why', 'Channel': 'hidden:channel', 'Email': 'ignore'}
ROWS = [
    {'Response ID': 'r1', 'Submitted': '14/03/2026 09:30', 'NPS': '0', 'Plan': 'Pro', 'CSAT': '', 'Why': 'Too slow',
     'Channel': 'email', 'Email': 'ana@example.com'},
    {'Response ID': 'r2', 'Submitted': '15/03/2026', 'NPS': '9', 'Plan': 'free', 'CSAT': '4', 'Why': '',
     'Channel': '', 'Email': ''},
    {'Response ID': 'r3', 'Submitted': 'soon', 'NPS': '7', 'Plan': 'Pro'},
    {'Response ID': 'r4', 'NPS': '12'},
]
FILE = {'name': 'workshop-results.csv', 'format': 'csv', 'content': 'Response ID,NPS\nr1,0\n'}


def _one_workspace() -> Any:
    """voc-workspaces with workspace ``WS``: its admin and its editor."""
    table = pk_sk_table('workspaces')
    table.put_item(Item={'pk': f'WS#{WS}', 'sk': 'META', 'status': 'active', 'name': 'A', 'slug': 'a'})
    for member, role in ((WS_ADMIN, 'admin'), (EDITOR, 'editor')):
        table.put_item(Item={'pk': f'WS#{WS}', 'sk': f"MEMBER#{member['sub']}", 'role': role})
    return table


@pytest.fixture
def world() -> Iterator[dict[str, Any]]:
    with mock_aws(), ExitStack() as stack:
        tables = wire_form_handler(stack, {'aggregates': pk_sk_table('aggregates'), 'feedback': pk_sk_table('feedback'),
                                           'workspaces': _one_workspace()}, QUEUE)
        tables['sqs'].send_message_batch.side_effect = lambda Entries, **_k: {
            'Successful': [{'Id': e['Id']} for e in Entries], 'Failed': []}
        s3 = boto3.client('s3', region_name='us-east-1')
        s3.create_bucket(Bucket=BUCKET)
        stack.enter_context(patch.object(h, 's3', s3))
        stack.enter_context(patch.object(h, 'RAW_DATA_BUCKET', BUCKET))
        stack.enter_context(patch('shared.import_runs._put_rows', side_effect=write_run_rows))
        # The workspace saved a feedback_form profile that keeps raw copies; the deployment's default does too.
        stack.enter_context(seeded_source_profiles(workspaces={WS: [{'id': 'feedback_form', 'pii': 'allow'}]}))
        yield {**tables, 's3': s3}


def _call(lambda_context: Any, method: str, path: str, *, claims: dict = ADMIN, ws: str | None = None,
          body: Any = None) -> tuple[int, Any]:
    parts = path.strip('/').split('/')
    return workspace_route_call(h, lambda_context, method, path, claims=claims, ws=ws, body=body,
                                path_params={'form_id': parts[1]} if len(parts) > 1 else None)


def _imported_form(lambda_context: Any, **kwargs: Any) -> str:
    status, answer = _call(lambda_context, 'POST', '/feedback-forms', body=FORM, **kwargs)
    assert status == 200, answer
    return answer['form']['form_id']


def _import(lambda_context: Any, form_id: str, **body: Any) -> tuple[int, Any]:
    claims = body.pop('claims', ADMIN)
    ws = body.pop('ws', None)
    return _call(lambda_context, 'POST', f'/feedback-forms/{form_id}/import', claims=claims, ws=ws,
                 body={'rows': ROWS, 'mapping': MAPPING, 'date_order': 'dmy', **body})


def _messages(world: dict) -> dict[str, dict]:
    return {m['csv_row_id']: m for call in world['sqs'].send_message_batch.call_args_list
            for m in (json.loads(e['MessageBody']) for e in call.kwargs['Entries'])}


def _keys(world: dict) -> list[str]:
    return [o['Key'] for o in world['s3'].list_objects_v2(Bucket=BUCKET).get('Contents', [])]


class TestTheImportedForm:
    @pytest.mark.usefixtures('world')
    def test_it_is_a_valid_v2_form_that_stays_off(self, lambda_context):
        form_id = _imported_form(lambda_context)
        status, answer = _call(lambda_context, 'GET', f'/feedback-forms/{form_id}')
        assert status == 200
        form = answer['form']
        assert (form['enabled'], form['imported'], form['revision'], form['schema_version']) == (False, IMPORTED, 1, 2)
        assert [q['type'] for q in form['questions']] == ['nps', 'single_select', 'csat', 'open_text']

    def test_it_cannot_be_created_on(self, lambda_context):
        status, answer = _call(lambda_context, 'POST', '/feedback-forms', body={**FORM, 'enabled': True})
        assert (status, answer['code']) == (400, 'imported_form')

    @pytest.mark.parametrize('imported', [{'at': 'yesterday', 'filename': 'x.csv'}, {'at': '2026-11-21'},
                                          {'at': '2026-11-21', 'filename': 'x.csv', 'url': 'x'}, 'x'])
    def test_its_provenance_is_checked(self, lambda_context, imported):
        assert _call(lambda_context, 'POST', '/feedback-forms', body={**FORM, 'imported': imported})[0] == 400

    @pytest.mark.usefixtures('world')
    def test_a_save_cannot_turn_it_on_and_it_takes_no_test_link(self, lambda_context):
        form_id = _imported_form(lambda_context)
        status, answer = _call(lambda_context, 'PUT', f'/feedback-forms/{form_id}', body={'enabled': True})
        assert (status, answer['code']) == (409, 'imported_form')
        assert _call(lambda_context, 'PUT', f'/feedback-forms/{form_id}', body={'name': 'Renamed'})[0] == 200
        assert _call(lambda_context, 'POST', f'/feedback-forms/{form_id}/test-link', body={})[0] == 409

    @pytest.mark.parametrize(('method', 'route'), [('GET', 'config'), ('GET', 'iframe'), ('POST', 'submit'),
                                                   ('POST', 'events')])
    def test_it_has_no_public_link(self, world, lambda_context, method, route):
        form_id = _imported_form(lambda_context)
        body = {'answers': {'q_nps': 9}} if route == 'submit' else {'event': {'kind': 'opened', 'session': 's' * 10}}
        event = rest_event(method, f'/feedback-forms/{form_id}/{route}', claims={},
                           body=body if method == 'POST' else None, path_params={'form_id': form_id})
        assert h.lambda_handler(event, lambda_context)['statusCode'] == 404
        assert world['sqs'].send_message.call_args_list == []


class TestImportingItsRows:
    def test_each_row_is_a_response_with_its_own_date(self, world, lambda_context):
        form_id = _imported_form(lambda_context)
        status, answer = _import(lambda_context, form_id, file=FILE)
        assert status == 200
        assert (answer['accepted'], answer['refused_count']) == (2, 2)
        assert answer['refused'] == [{'row': 3, 'code': 'date_invalid'},
                                     {'row': 4, 'code': 'answer_invalid', 'question_id': 'q_nps'}]
        messages = _messages(world)
        first, second = messages['r1'], messages['r2']
        assert (first['created_at'], second['created_at']) == ('2026-03-14T09:30:00+00:00', '2026-03-15T00:00:00+00:00')
        assert (first['source_platform'], first['source_channel'], first['brand_name']) == (
            'feedback_form', f'form_{form_id}', 'Acme')
        meta = first['metadata']
        assert (meta['form_revision'], meta['form_answers'], meta['form_hidden'], meta['form_import_run']) == (
            1, {'q_nps': 0, 'q_plan': {'code': 'pro'}, 'q_why': 'Too slow'}, {'channel': 'email'}, answer['run_id'])
        assert first['rating'] is None  # an NPS stays an answer: the queue refuses a 0 rating
        assert second['rating'] == 4  # the CSAT is the item's rating
        assert first['text'] == 'Why?\nToo slow'
        assert second['text'] == 'How likely are you to recommend us?: 9/10\nWhich plan?: Free\nSatisfied?: 4/5'
        assert 'ana@example.com' not in json.dumps(messages)
        for message in messages.values():  # what the processor's queue takes: a 0 rating or an empty text never is
            IngestMessage(**message)

    def test_the_original_file_is_kept_write_once_and_the_run_recorded(self, world, lambda_context):
        form_id = _imported_form(lambda_context)
        _status, answer = _import(lambda_context, form_id, file=FILE)
        key = f"raw/feedback_form/import/{form_id}/{answer['run_id']}.csv"
        assert _keys(world) == [key]
        assert world['s3'].get_object(Bucket=BUCKET, Key=key)['Body'].read() == FILE['content'].encode()
        assert answer['raw_s3_key'] == f's3://{BUCKET}/{key}'
        assert {m['s3_raw_uri'] for m in _messages(world).values()} == {answer['raw_s3_key']}
        run = world['aggregates'].get_item(Key={'pk': f"IMPORT_RUN#{answer['run_id']}", 'sk': 'RUN'})['Item']
        assert (run['method'], run['imported'], run['skipped'], run['source']) == ('form', 2, 2, 'Workshop (imported)')
        stored = world['aggregates'].get_item(Key={'pk': 'FEEDBACK_FORM', 'sk': f'FORM#{form_id}'})['Item']
        assert stored['has_responses'] is True

    def test_a_later_call_names_the_first_calls_file(self, world, lambda_context):
        form_id = _imported_form(lambda_context)
        _status, first = _import(lambda_context, form_id, file=FILE)
        key = first['raw_s3_key'].removeprefix(f's3://{BUCKET}/')
        status, later = _import(lambda_context, form_id, rows=[{'NPS': '5', 'Response ID': 'r9'}], file_key=key,
                                offset=4)
        assert (status, later['raw_s3_key'], _keys(world)) == (200, first['raw_s3_key'], [key])
        status, _refused = _import(lambda_context, form_id, file_key=f'raw/feedback_form/import/ff_other/{key[-40:]}')
        assert status == 400

    def test_a_dry_run_writes_nothing(self, world, lambda_context):
        form_id = _imported_form(lambda_context)
        status, answer = _import(lambda_context, form_id, file=FILE, dry_run=True)
        assert (status, answer['accepted'], answer['dry_run']) == (200, 2, True)
        assert world['sqs'].send_message_batch.call_args_list == []
        assert _keys(world) == []

    def test_the_same_file_again_is_the_same_items(self, world, lambda_context):
        form_id = _imported_form(lambda_context)
        _import(lambda_context, form_id)
        once = {m['id'] for m in _messages(world).values()}
        world['sqs'].send_message_batch.reset_mock()
        _import(lambda_context, form_id)
        assert {m['id'] for m in _messages(world).values()} == once

    @pytest.mark.usefixtures('world')
    def test_only_an_imported_form_takes_rows(self, lambda_context):
        status, answer = _call(lambda_context, 'POST', '/feedback-forms', body={k: v for k, v in FORM.items()
                                                                                if k != 'imported'})
        assert status == 200
        status, refused = _import(lambda_context, answer['form']['form_id'])
        assert (status, refused['code']) == (409, 'not_imported')

    @pytest.mark.parametrize(('mapping', 'status'), [({'NPS': 'q_unknown'}, 400), ({'Email': 'ignore'}, 400)])
    @pytest.mark.usefixtures('world')
    def test_the_mapping_names_this_forms_questions(self, lambda_context, mapping, status):
        form_id = _imported_form(lambda_context)
        assert _import(lambda_context, form_id, mapping=mapping)[0] == status

    def test_a_delegated_caller_is_refused(self, world, lambda_context):
        form_id = _imported_form(lambda_context)
        assert _import(lambda_context, form_id, claims=DELEGATED)[0] == 403
        assert world['sqs'].send_message_batch.call_args_list == []


class TestInAWorkspace:
    def test_its_admin_imports_into_it(self, world, lambda_context):
        form_id = _imported_form(lambda_context, claims=WS_ADMIN, ws=WS)
        status, answer = _import(lambda_context, form_id, claims=WS_ADMIN, ws=WS, file=FILE, workspace_id='ws_x')
        assert status == 200
        assert {m['workspace_id'] for m in _messages(world).values()} == {WS}
        assert _keys(world) == [f"ws/{WS}/raw/feedback_form/import/{form_id}/{answer['run_id']}.csv"]
        assert world['aggregates'].get_item(Key={'pk': f"WS#{WS}#IMPORT_RUN#{answer['run_id']}", 'sk': 'RUN'}).get('Item')

    @pytest.mark.usefixtures('world')
    def test_an_editor_cannot_import(self, lambda_context):
        form_id = _imported_form(lambda_context, claims=WS_ADMIN, ws=WS)
        assert _import(lambda_context, form_id, claims=EDITOR, ws=WS)[0] == 403

    def test_its_form_is_unknown_elsewhere(self, world, lambda_context):
        form_id = _imported_form(lambda_context, claims=WS_ADMIN, ws=WS)
        assert _import(lambda_context, form_id)[0] == 404
        assert world['sqs'].send_message_batch.call_args_list == []

    def test_a_workbook_is_kept_as_a_workbook(self, world, lambda_context):
        form_id = _imported_form(lambda_context, claims=WS_ADMIN, ws=WS)
        workbook = {'name': 'r.xlsx', 'format': 'xlsx', 'content': base64.b64encode(b'PK\x03\x04 fake').decode()}
        _status, answer = _import(lambda_context, form_id, claims=WS_ADMIN, ws=WS, file=workbook)
        [key] = _keys(world)
        assert key.endswith('.xlsx')
        head = world['s3'].head_object(Bucket=BUCKET, Key=key)
        assert head['ContentType'].startswith('application/vnd.openxmlformats')
        assert answer['raw_s3_key'].endswith(key)


class CountingComprehend:
    """A Comprehend stand-in that counts its calls, keeps what each was sent and how many ran at once; a text holding
    ``throttled`` fails as a throttle that outlasted the client's retries."""

    def __init__(self) -> None:
        self.texts: list[str] = []
        self.in_flight = self.most_at_once = 0
        self._lock = threading.Lock()

    def detect_pii_entities(self, **request: str) -> dict:
        text = request['Text']
        with self._lock:
            self.texts.append(text)
            self.in_flight += 1
            self.most_at_once = max(self.most_at_once, self.in_flight)
        time.sleep(0.005)  # long enough for the next row's call to start beside it when rows run at once
        with self._lock:
            self.in_flight -= 1
        if 'throttled' in text:
            raise ClientError({'Error': {'Code': 'ThrottlingException', 'Message': 'Rate exceeded'}}, 'DetectPiiEntities')
        start = text.find('Ana Kowalska')
        return {'Entities': [{'Type': 'NAME', 'Score': 0.99, 'BeginOffset': start, 'EndOffset': start + 12}]
                if start >= 0 else []}


def _german(value: Any) -> Any:
    """``FORM``'s texts as a German form's (its language ``de``, every ``{'en': …}`` text under ``de``)."""
    if isinstance(value, dict):
        return {('de' if key == 'en' else key): _german(item) for key, item in value.items()}
    if isinstance(value, list):
        return [_german(item) for item in value]
    return 'de' if value == 'en' else value


class TestARedactedWorkspaceImport:
    """A workspace that saved no feedback_form profile redacts (its default) and, with ``PII_COMPREHEND=1``, each free
    text is one Comprehend call: only free text is sent (a hidden value too: it may hold a name), several rows at once,
    and a call in a language Comprehend reads holds at most the budget; a row Comprehend could not read is refused."""

    @staticmethod
    def _rows(count: int, channel: str = 'email') -> list[dict[str, str]]:
        return [{'Response ID': f'r{n}', 'NPS': str(n % 11), 'Plan': 'Pro', 'Channel': channel,
                 'Why': f'Ana Kowalska says page {n} is slow'} for n in range(count)]

    def _run(self, lambda_context: Any, monkeypatch: Any, rows: list[dict[str, str]] | int,
             form: dict[str, Any] = FORM) -> tuple[int, Any, CountingComprehend]:
        monkeypatch.setenv('PII_COMPREHEND', '1')
        comprehend = CountingComprehend()
        status, created = _call(lambda_context, 'POST', '/feedback-forms', body=form, claims=WS_ADMIN, ws=WS)
        assert status == 200, created
        with seeded_source_profiles(workspaces={WS: []}), \
                patch('shared.pii_redaction._comprehend', return_value=comprehend):
            status, answer = _import(lambda_context, created['form']['form_id'], claims=WS_ADMIN, ws=WS,
                                     rows=self._rows(rows) if isinstance(rows, int) else rows,
                                     mapping={k: v for k, v in MAPPING.items() if k != 'Submitted'})
        return status, answer, comprehend

    def test_only_free_text_reaches_comprehend_several_rows_at_once(self, world, lambda_context, monkeypatch):
        rows = fimp.MAX_REDACTED_TEXTS // 3  # each row: its text, its one open answer and its hidden channel
        status, answer, comprehend = self._run(lambda_context, monkeypatch, rows)
        assert (status, answer['accepted']) == (200, rows), answer
        assert len(comprehend.texts) == 3 * rows
        assert {text for text in comprehend.texts if 'is slow' not in text} == {'email'}, \
            'never an id, an option code, an NPS or the form name: the words, the open answers and the hidden values'
        assert comprehend.most_at_once > 1
        messages = _messages(world)
        assert {m['pii_policy_applied'] for m in messages.values()} == {'redact'}
        assert messages['r1']['metadata']['form_answers']['q_why'] == '[NAME] says page 1 is slow'
        assert messages['r1']['text'] == 'Why?\n[NAME] says page 1 is slow'
        assert (messages['r1']['metadata']['form_hidden'], messages['r1']['s3_raw_uri']) == ({'channel': 'email'}, None)

    def test_a_name_mapped_to_a_hidden_field_is_read_by_comprehend(self, world, lambda_context, monkeypatch):
        """S6 (7.71.01): a hidden field's value is free text: a name there gets Comprehend under a redacting
        policy, never the patterns alone."""
        status, answer, _comprehend = self._run(lambda_context, monkeypatch, self._rows(2, channel='Ana Kowalska'))
        assert (status, answer['accepted']) == (200, 2), answer
        assert {m['metadata']['form_hidden']['channel'] for m in _messages(world).values()} == {'[NAME]'}

    def test_a_call_over_the_budget_is_refused_before_any_call(self, world, lambda_context, monkeypatch):
        status, answer, comprehend = self._run(lambda_context, monkeypatch, fimp.MAX_REDACTED_TEXTS // 3 + 1)
        assert (status, answer['code']) == (400, fimp.TOO_MANY_TEXTS)
        assert (comprehend.texts, world['sqs'].send_message_batch.call_args_list) == ([], [])

    def test_a_form_in_a_language_comprehend_does_not_read_takes_large_calls(self, world, lambda_context, monkeypatch):
        """Q34 (7.71.01): a German survey's texts never reach Comprehend (it reads en and es only), so no 250-text
        bound: 300 rows, 900 texts, go in one call, redacted by the patterns."""
        status, answer, comprehend = self._run(lambda_context, monkeypatch, 300, form=_german(FORM))
        assert (status, answer['accepted']) == (200, 300), answer
        assert comprehend.texts == []
        assert {m['pii_policy_applied'] for m in _messages(world).values()} == {'redact'}

    def test_a_row_comprehend_could_not_read_is_refused_and_the_others_are_queued(self, world, lambda_context,
                                                                                 monkeypatch):
        """S7 (7.71.01): a throttle that outlasted the client's retries refuses that row (``redaction_unavailable``,
        which the wizard shows): its text is never kept with the patterns' redaction alone."""
        rows = self._rows(4)
        rows[2]['Why'] = 'throttled: Ana Kowalska, call 555-123-4567'
        status, answer, _comprehend = self._run(lambda_context, monkeypatch, rows)
        assert (status, answer['accepted'], answer['refused_count']) == (200, 3, 1), answer
        assert answer['refused'] == [{'row': 3, 'code': fimp.REDACTION_UNAVAILABLE}]
        assert sorted(_messages(world)) == ['r0', 'r1', 'r3']


def test_a_send_failure_is_reported_by_row(world, lambda_context):
    form_id = _imported_form(lambda_context)
    world['sqs'].send_message_batch.side_effect = lambda Entries, **_k: {
        'Successful': [{'Id': Entries[0]['Id']}],
        'Failed': [{'Id': e['Id'], 'Code': 'Throttled', 'Message': 'Throttled'} for e in Entries[1:]]}
    status, answer = _import(lambda_context, form_id)
    assert (status, answer['accepted'], answer['errors']) == (200, 1, ['row 2: Throttled'])
    assert isinstance(world['sqs'], MagicMock)
