"""Property and example tests for what the moto suites of shared/prototype_versions.py leave open.

Meant to sit beside test_prototype_versions_properties.py (lambda/shared/test/). The moto suites
(api/test/test_prototype_restore_moto.py, test_prototype_walkthrough_moto.py, test_prototype_drafts_moto.py) pin
what a restore, a walkthrough save and an applied draft WRITE end to end; these pin, against fakes:

- the object a version is written as: HTML in UTF-8 at the version's key, served as ``text/html; charset=utf-8``,
  created only if absent, with the metadata ``prototype_object_metadata`` gives; its identity is the ETag, and the
  version id only when S3 gives one; a conflict reads the winner, any other S3 error is the caller's;
- the row a new version gets: the source's sources and lineage, never what described the source's own version,
  plus the object's identity, empty ``content``, ``html`` format, the project's document index keys and times,
  and the caller's provenance (the property below, over generated source rows);
- the reads: a non-text or empty ``content`` reads the object, any S3 error but a missing object is the caller's;
- Back to vN answers ``success: true``; a walkthrough save's key does not depend on the order of a step's fields,
  and a save that lost a race to its own allocation answers that version.

``_is_inline_html``'s 200-character window is wider than every opener it checks: see the mutation report
(the window's 201 mutant is equivalent; the window only has to hold the longest opener, 14 characters).
"""
from __future__ import annotations

import json
from typing import Any
from unittest.mock import patch

import pytest
from botocore.exceptions import ClientError
from hypothesis import given
from hypothesis import strategies as st

from shared import prototype_versions as pv
from shared.document_history import validated_edit_id
from shared.exceptions import ConfigurationError, ConflictError
from shared.prototype_pins import pin_form_id, prototype_object_metadata
from shared.prototypes import prototype_s3_key
from shared.test.property_settings import PROPERTY

PROJECT = 'proj-1'
BUCKET = 'raw-data'
API_BASE = 'https://abcdefghij.execute-api.us-east-1.amazonaws.com/v1'
NOW = '2026-06-01T00:00:00+00:00'
HTML = '<!DOCTYPE html><html><body><h1>Café ✓</h1></body></html>'


def _client_error(code: str) -> ClientError:
    return ClientError({'Error': {'Code': code, 'Message': code}}, 'PutObject')


class FakeS3:
    """put_object / head_object / get_object, each answering what the test sets and recording its call."""

    def __init__(self, *, put: dict | Exception | None = None, head: dict | None = None,
                 body: bytes | Exception | None = None) -> None:
        self.put, self.head, self.body = put, head, body
        self.calls: list[tuple[str, dict]] = []

    def put_object(self, **kwargs: Any) -> dict:
        self.calls.append(('put', kwargs))
        if isinstance(self.put, Exception):
            raise self.put
        return self.put or {}

    def head_object(self, **kwargs: Any) -> dict:
        self.calls.append(('head', kwargs))
        return self.head or {}

    def get_object(self, **kwargs: Any) -> dict:
        self.calls.append(('get', kwargs))
        if isinstance(self.body, Exception):
            raise self.body
        body = self.body

        class Body:
            @staticmethod
            def read() -> bytes:
                return body or b''

        return {'Body': Body()}


class TestTheObjectAVersionIsWrittenAs:
    def test_html_in_utf8_at_its_key_created_only_if_absent_with_its_metadata(self):
        s3 = FakeS3(put={'ETag': '"e1"'})
        identity = pv.put_prototype_html(s3, BUCKET, PROJECT, 'doc_1', HTML, API_BASE)
        assert s3.calls == [('put', {
            'Bucket': BUCKET, 'Key': prototype_s3_key(PROJECT, 'doc_1'), 'Body': HTML.encode('utf-8'),
            'ContentType': 'text/html; charset=utf-8', 'IfNoneMatch': '*',
            'Metadata': prototype_object_metadata('doc_1', HTML, API_BASE)})]
        assert identity == {'prototype_etag': '"e1"'}

    @pytest.mark.parametrize(('answer', 'identity'), [
        ({'ETag': '"e1"', 'VersionId': 'v7'}, {'prototype_etag': '"e1"', 'prototype_version_id': 'v7'}),
        ({'ETag': '"e1"', 'VersionId': ''}, {'prototype_etag': '"e1"'}),
        ({'ETag': '"e1"', 'VersionId': None}, {'prototype_etag': '"e1"'}),
    ])
    def test_the_version_id_is_kept_only_when_s3_gives_one(self, answer, identity):
        assert pv.put_prototype_html(FakeS3(put=answer), BUCKET, PROJECT, 'doc_1', HTML, None) == identity

    @pytest.mark.parametrize('code', ['PreconditionFailed', 'ConditionalRequestConflict'])
    def test_a_conflict_answers_the_object_already_there(self, code):
        s3 = FakeS3(put=_client_error(code), head={'ETag': '"winner"', 'VersionId': 'v1'})
        identity = pv.put_prototype_html(s3, BUCKET, PROJECT, 'doc_1', HTML, None)
        assert identity == {'prototype_etag': '"winner"', 'prototype_version_id': 'v1'}
        assert s3.calls[1] == ('head', {'Bucket': BUCKET, 'Key': prototype_s3_key(PROJECT, 'doc_1')})

    @pytest.mark.parametrize('code', ['AccessDenied', 'InternalError', ''])
    def test_any_other_s3_error_is_the_callers_and_nothing_is_read(self, code):
        s3 = FakeS3(put=_client_error(code))
        with pytest.raises(ClientError):
            pv.put_prototype_html(s3, BUCKET, PROJECT, 'doc_1', HTML, None)
        assert [call for call, _ in s3.calls] == ['put']

    @pytest.mark.parametrize('s3', [FakeS3(put={'ETag': ''}), FakeS3(put={}),
                                    FakeS3(put=_client_error('PreconditionFailed'), head={})])
    def test_without_an_etag_it_is_an_error(self, s3):
        with pytest.raises(RuntimeError, match='did not identify the winning prototype object'):
            pv.put_prototype_html(s3, BUCKET, PROJECT, 'doc_1', HTML, None)


class TestReadingAVersionsHtml:
    @pytest.mark.parametrize('content', [None, '', 0, ['<html>'], {'html': 1}])
    def test_a_row_without_inline_text_reads_its_object_in_utf8(self, content):
        s3 = FakeS3(body=HTML.encode('utf-8'))
        row = {'document_id': 'doc_1', 'content': content, 'prototype_format': 'html'}
        assert pv.version_html(s3, BUCKET, PROJECT, row) == HTML
        assert s3.calls == [('get', {'Bucket': BUCKET, 'Key': prototype_s3_key(PROJECT, 'doc_1')})]

    def test_inline_html_is_answered_as_it_is_without_a_read(self):
        s3 = FakeS3()
        assert pv.version_html(s3, BUCKET, PROJECT, {'document_id': 'doc_1', 'content': '\n<html>x'}) == '\n<html>x'
        assert s3.calls == []

    def test_any_s3_error_but_a_missing_object_is_the_callers(self):
        s3 = FakeS3(body=_client_error('AccessDenied'))
        with pytest.raises(ClientError):
            pv.version_html(s3, BUCKET, PROJECT, {'document_id': 'doc_1', 'content': ''})


class _Captured:
    """The module's storage calls, replaced: what the row write was given, and what it answers."""

    def __init__(self) -> None:
        self.persisted: list[tuple[tuple, dict]] = []
        self.forms: list[tuple] = []

    def persist(self, *args: Any, **kwargs: Any) -> dict:
        self.persisted.append((args, kwargs))
        return {'document_id': 'new', **args[5]}

    def form(self, *args: Any) -> str:
        self.forms.append(args)
        return pin_form_id(args[2])


def _store(s3: FakeS3) -> pv.PrototypeStore:
    return pv.PrototypeStore(table='projects', pins_table='pins', s3=s3, bucket=BUCKET, api_base=API_BASE)


def _version_from_html(source: dict, captured: _Captured, **kwargs: Any) -> dict:
    with patch.object(pv, 'get_versioned_document_by_allocation', return_value=None), \
            patch.object(pv, 'persist_versioned_document', captured.persist), \
            patch.object(pv, 'ensure_pin_form', captured.form), \
            patch.object(pv, 'series_head_version', return_value=4):
        return pv.version_from_html(_store(FakeS3(put={'ETag': '"e"', 'VersionId': 'v1'})), PROJECT, source, HTML,
                                    allocation_id='restore:a:b', now=NOW, provenance={'edit_kind': 'restore'},
                                    **kwargs)


ROW_FIELDS = sorted(pv._PROTOTYPE_ROW_FIELDS)
CARRIED = ['source_prd_id', 'derivation', 'methodology', 'prototype_format', 'persona_ids', 'project_id']
SOURCES = st.dictionaries(st.sampled_from(ROW_FIELDS + CARRIED),
                          st.one_of(st.text(max_size=8), st.integers(0, 9)), max_size=12).map(
    lambda row: {**row, 'title': 'Checkout (v2)', 'base_title': 'Checkout'})


class TestTheRowANewVersionGets:
    """Invariant: the new row keeps every field of the source that is not about the source's own version, drops
    every one that is, and gets the object's identity, empty content, html format, the project's document index
    keys, its times and the caller's provenance; it is written once, for the series' base title."""

    @PROPERTY
    @given(source=SOURCES)
    def test_the_row_is_the_sources_lineage_and_the_new_versions_own_fields(self, source: dict) -> None:
        captured = _Captured()
        _version_from_html(source, captured)
        (args, kwargs), = captured.persisted
        kept = {key: value for key, value in source.items() if key not in pv._PROTOTYPE_ROW_FIELDS}
        assert args[:5] == ('projects', PROJECT, 'prototype', 'Checkout', 'restore:a:b')
        assert args[5] == {**kept, 'prototype_etag': '"e"', 'prototype_version_id': 'v1', 'content': '',
                           'prototype_format': 'html', 'gsi1pk': f'PROJECT#{PROJECT}#DOCUMENTS', 'gsi1sk': NOW,
                           'created_at': NOW, 'updated_at': NOW, 'edit_kind': 'restore'}
        assert kwargs == {'expected_last_version': None}

    def test_an_allocation_that_landed_is_answered_and_nothing_is_written(self):
        captured = _Captured()
        with patch.object(pv, 'get_versioned_document_by_allocation', return_value={'document_id': 'done'}), \
                patch.object(pv, 'persist_versioned_document', captured.persist), \
                patch.object(pv, 'ensure_pin_form', captured.form):
            s3 = FakeS3(put={'ETag': '"e"'})
            answer = pv.version_from_html(_store(s3), PROJECT, {'title': 'T'}, HTML, allocation_id='a', now=NOW,
                                          provenance={})
        assert (answer, captured.persisted, captured.forms, s3.calls) == ({'document_id': 'done'}, [], [], [])

    def test_a_series_that_moved_is_refused_before_the_form_and_the_object(self):
        captured = _Captured()
        with pytest.raises(ConflictError):
            _version_from_html({'title': 'Checkout (v2)'}, captured, expected_last_version=3)
        assert (captured.forms, captured.persisted) == ([], [])

    def test_a_series_still_at_the_expected_version_is_written_with_that_expectation(self):
        captured = _Captured()
        _version_from_html({'title': 'Checkout (v4)'}, captured, expected_last_version=4)
        assert captured.persisted[0][1] == {'expected_last_version': 4}


class TestBackToAVersion:
    def test_the_answer_is_a_success_with_the_new_version(self):
        source = {'document_id': 'v1', 'version': 1, 'content': HTML, 'title': 'Checkout (v1)'}
        latest = {'document_id': 'v2', 'version': 2}
        made: list[dict] = []

        def version(*args: Any, **kwargs: Any) -> dict:
            made.append({'args': args, **kwargs})
            return {'document_id': 'v3'}

        with patch.object(pv, 'restore_rows', return_value=(source, latest)), \
                patch.object(pv, 'version_from_html', version):
            answer = pv.restore_prototype_version(_store(FakeS3()), PROJECT, {'document_id': 'v2'}, 'v1',
                                                  {'edit_id': 'back-1'}, now=NOW, actor={'sub': 'u1'})
        assert answer == {'success': True, 'document': {'document_id': 'v3'}}
        assert made[0]['allocation_id'] == 'restore:v1:back-1'
        assert made[0]['args'][3] == HTML


STEP = {'title': 'Pay', 'body': 'Press pay', 'selector': '#pay'}


class TestAWalkthroughSave:
    def _save(self, steps: list[dict], *, existing: list, version_from_html: Any) -> tuple[dict, bool]:
        document = {'document_id': 'd2', 'version': 2, 'content': HTML, 'title': 'Checkout (v2)'}
        with patch.object(pv, 'get_versioned_document_by_allocation', side_effect=existing), \
                patch.object(pv, 'version_from_html', version_from_html):
            return pv.save_walkthrough(_store(FakeS3()), PROJECT, document, steps, None, now=NOW, actor={'sub': 'u'})

    def test_the_key_does_not_depend_on_the_order_of_a_steps_fields(self):
        seen: list[str] = []

        def version(*_args: Any, allocation_id: str, **_kwargs: Any) -> dict:
            seen.append(allocation_id)
            return {'document_id': 'd3'}

        reordered = dict(reversed(list(STEP.items())))
        assert self._save([STEP], existing=[None], version_from_html=version) == ({'document_id': 'd3'}, True)
        self._save([reordered], existing=[None], version_from_html=version)
        key = validated_edit_id(None, json.dumps([STEP], sort_keys=True))
        assert seen == [f'walkthrough:d2:{key}'] * 2

    def test_a_save_that_lost_the_race_to_its_own_allocation_answers_that_version(self):
        def stale(*_args: Any, **_kwargs: Any) -> dict:
            raise ConflictError('moved')

        landed = {'document_id': 'd3'}
        assert self._save([STEP], existing=[None, landed], version_from_html=stale) == (landed, False)
        with pytest.raises(ConflictError):
            self._save([STEP], existing=[None, None], version_from_html=stale)


class TestTheRefusalsAreExact:
    """What an operator or a caller reads when storage is missing or S3 answers oddly, word for word, and the
    error S3 raised stays S3's when it carries no error code at all."""

    def test_a_store_without_a_bucket_is_not_configured(self):
        with pytest.raises(ConfigurationError, match=r'^Prototype storage not configured$'):
            pv.PrototypeStore(table='projects', pins_table='pins', s3=FakeS3(), bucket='', api_base=None)

    def test_an_answer_without_an_etag_names_the_object(self):
        with pytest.raises(RuntimeError, match=r'^S3 did not identify the winning prototype object\.$'):
            pv.put_prototype_html(FakeS3(put={}), BUCKET, PROJECT, 'doc_1', HTML, None)

    def test_an_s3_error_without_an_error_block_is_raised_as_it_came(self):
        bare = ClientError({}, 'PutObject')
        s3 = FakeS3(put=bare)
        with pytest.raises(ClientError) as raised:
            pv.put_prototype_html(s3, BUCKET, PROJECT, 'doc_1', HTML, None)
        assert raised.value is bare
        assert [call for call, _ in s3.calls] == ['put']


class TestTheNewVersionsPinFormIsNamedForItsSeries:
    """The tester-pin form a new version gets is titled with the series' base title, not left untitled."""

    def test_the_form_gets_the_base_title(self):
        captured = _Captured()
        _version_from_html({'title': 'Checkout (v2)', 'base_title': 'Checkout'}, captured)
        assert [form[3] for form in captured.forms] == ['Checkout']
