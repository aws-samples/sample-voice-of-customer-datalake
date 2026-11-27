"""A voice session's transcript saved as a ``persona_interview`` document (7.69.00, shared/voice_transcripts.py), on
moto's DynamoDB and S3: synthetic, the person's turns redacted, the persona's citations kept to its own pack, a key
quote only when it was said, the usage line, and the session's scratch files gone, every version.
"""
from __future__ import annotations

import json
from datetime import UTC, datetime
from decimal import Decimal
from typing import Any
from unittest.mock import Mock, patch

import boto3
import pytest
from moto import mock_aws

from shared import voice_sessions as voice
from shared import voice_transcripts as transcripts
from shared.exceptions import NotFoundError, ValidationError
from shared.test.moto_tables import create_pk_sk_table

NOW = datetime(2026, 11, 21, 11, 0, tzinfo=UTC)
SID = '00000000-0000-4000-8000-000000000001'
CONFIG = {'project_id': 'p1', 'persona_id': 'persona_1', 'session_id': SID}
SUMMARY = json.dumps({'summary': 'Maria wants faster delivery.',
                      'key_quotes': ['nine days is too long', 'I never said this']})


@pytest.fixture
def stores():
    with mock_aws():
        resource = boto3.resource('dynamodb', region_name='us-east-1')
        projects = create_pk_sk_table('voc-projects', resource)
        s3 = boto3.client('s3', region_name='us-east-1')
        s3.create_bucket(Bucket='raw')
        s3.put_bucket_versioning(Bucket='raw', VersioningConfiguration={'Status': 'Enabled'})
        projects.put_item(Item={'pk': 'PROJECT#p1', 'sk': 'META', 'project_id': 'p1', 'name': 'Checkout',
                                'document_count': 0})
        projects.put_item(Item={**voice.pointer_key('p1', SID), 'session_id': SID, 'persona_id': 'persona_1'})
        projects.put_item(Item={
            **voice.session_key(SID), 'session_id': SID, 'project_id': 'p1', 'persona_id': 'persona_1',
            'starter_sub': 'sub-ada', 'status': 'finalizing', 'created_at': NOW.isoformat(),
            'connected_at': NOW.isoformat(), 'model_id': 'amazon.nova-2-5-sonic', 'voice_id': 'tiffany',
            'language': 'en', 'seconds': 95, 'transcript_parts': 2,
            'tokens': {'speech_in': Decimal(1900), 'speech_out': Decimal(800), 'text_in': Decimal(6000),
                       'text_out': Decimal(120)}})
        _put(s3, voice.evidence_key(SID), {'session_id': SID, 'persona': {'persona_id': 'persona_1', 'name': 'Maria'},
                                           'evidence': [{'feedback_id': 'fb1', 'text': 'Nine days.'}]})
        _put(s3, voice.transcript_key(SID, 1), {'session_id': SID, 'part': 1, 'turns': [
            {'role': 'user', 'text': 'Hi Maria, write me at ada@example.com later.', 'feedback_ids': ['fb1']},
            {'role': 'assistant', 'text': 'Honestly, nine days is too long.', 'feedback_ids': ['fb1', 'fb-not-mine']},
        ]})
        _put(s3, voice.transcript_key(SID, 2), {'session_id': SID, 'part': 2, 'turns': [
            {'role': 'assistant', 'text': 'And the tracking', 'interrupted': True, 'feedback_ids': []},
            {'role': 'system', 'text': 'ignored'}, {'role': 'user', 'text': '   '},
        ]})
        yield voice.Stores(projects=projects, aggregates=None, feedback=None, s3=s3, bucket='raw', now=lambda: NOW)


def _put(s3: Any, key: str, value: dict) -> None:
    s3.put_object(Bucket='raw', Key=key, Body=json.dumps(value).encode('utf-8'))


def _document(store: voice.Stores, document_id: str) -> dict[str, Any]:
    return store.projects.get_item(Key={'pk': 'PROJECT#p1', 'sk': f'DOC#{document_id}'})['Item']


def _session(store: voice.Stores) -> dict[str, Any]:
    return store.projects.get_item(Key=voice.session_key(SID))['Item']


def _finalize(store: voice.Stores, summary: str = SUMMARY) -> dict[str, Any]:
    with patch.object(transcripts.usage_meter, 'log_stream_usage') as usage:
        result = transcripts.finalize(store, CONFIG, summarize=lambda _prompt, _system: summary)
    return {**result, 'usage': usage}


class TestTheDocument:
    def test_is_a_synthetic_persona_interview_with_its_lineage(self, stores):
        document = _document(stores, _finalize(stores)['document_id'])
        assert (document['document_type'], document['synthetic'], document['created_by_sub']) == (
            'persona_interview', True, 'sub-ada')
        assert document['input_feedback_ids'] == ['fb1']
        assert document['derivation'] == {
            'kind': 'persona_interview', 'persona_ids': ['persona_1'], 'voice_session': SID, 'seconds': 95,
            'model_id': 'amazon.nova-2-5-sonic', 'voice_id': 'tiffany', 'feedback_count': 1}
        assert document['title'] == 'Interview with Maria (2026-11-21)'

    def test_redacts_the_person_and_cites_only_the_pack(self, stores):
        content = _document(stores, _finalize(stores)['document_id'])['content']
        assert content.startswith(transcripts.SYNTHETIC_LABEL)
        assert 'ada@example.com' not in content
        assert '**Maria:** Honestly, nine days is too long. [fb:fb1]' in content
        assert 'fb-not-mine' not in content
        assert 'ignored' not in content

    def test_keeps_a_key_quote_only_when_it_was_said(self, stores):
        content = _document(stores, _finalize(stores)['document_id'])['content']
        assert '## Summary\n\nMaria wants faster delivery.' in content
        assert '> "nine days is too long"' in content
        assert 'I never said this' not in content
        assert '**Maria:** And the tracking _(interrupted)_' in content

    def test_a_failed_summary_still_saves_the_transcript(self, stores):
        content = _document(stores, _finalize(stores, summary='no json at all')['document_id'])['content']
        assert '_No summary could be made for this interview._' in content
        assert '## Key quotes' not in content


class TestTheSession:
    def test_logs_nova_sonic_s_tokens_and_closes_the_session(self, stores):
        result = _finalize(stores)
        result['usage'].assert_called_once_with('amazon.nova-2-5-sonic', 'InvokeModelWithBidirectionalStream',
                                                input_tokens=7900, output_tokens=920)
        session = _session(stores)
        assert (session['status'], session['transcript_document_id']) == ('finalized', result['document_id'])

    def test_deletes_every_version_of_its_scratch_files(self, stores):
        _finalize(stores)
        listed = stores.s3.list_object_versions(Bucket='raw', Prefix=voice.scratch_prefix(SID))
        assert listed.get('Versions', []) == []
        assert listed.get('DeleteMarkers', []) == []

    def test_a_silent_session_saves_no_document(self, stores):
        stores.projects.update_item(Key=voice.session_key(SID), UpdateExpression='SET transcript_parts = :zero',
                                    ExpressionAttributeValues={':zero': 0})
        assert _finalize(stores)['document_id'] is None
        assert _session(stores)['status'] == 'finalized'

    def test_a_part_of_another_session_is_left_out(self, stores):
        _put(stores.s3, voice.transcript_key(SID, 1), {'session_id': 'someone-else', 'turns': [
            {'role': 'user', 'text': 'not this one'}]})
        content = _document(stores, _finalize(stores)['document_id'])['content']
        assert 'not this one' not in content
        assert 'And the tracking' in content

    def test_runs_once(self, stores):
        first = _finalize(stores)
        assert _finalize(stores)['document_id'] == first['document_id']
        stores.projects.update_item(Key=voice.session_key(SID), UpdateExpression='SET #s = :ended',
                                    ExpressionAttributeNames={'#s': 'status'}, ExpressionAttributeValues={':ended': 'ended'})
        with pytest.raises(NotFoundError):
            _finalize(stores)

    def test_a_failure_marks_it_failed(self, stores):
        with patch.object(transcripts, 'create_counted_project_child', side_effect=RuntimeError('ddb')), \
                pytest.raises(RuntimeError):
            _finalize(stores)
        assert _session(stores)['status'] == 'failed'


PRODUCT_SID = '00000000-0000-4000-8000-000000000002'
PRODUCT_CONFIG = {'project_id': 'p1', 'kind': 'product_interview', 'session_id': PRODUCT_SID}


class TestTheProductInterview:
    """7.104.00: a product interview's transcript is one of the Product tab's sources, never a document."""

    @pytest.fixture
    def product(self, stores):
        stores.projects.put_item(Item={**voice.pointer_key('p1', PRODUCT_SID), 'session_id': PRODUCT_SID,
                                       'kind': 'product_interview'})
        stores.projects.put_item(Item={
            **voice.session_key(PRODUCT_SID), 'session_id': PRODUCT_SID, 'project_id': 'p1', 'kind': 'product_interview',
            'starter_sub': 'sub-ada', 'status': 'finalizing', 'created_at': NOW.isoformat(),
            'connected_at': NOW.isoformat(), 'model_id': 'amazon.nova-2-5-sonic', 'language': 'en', 'seconds': 60,
            'transcript_parts': 1, 'tokens': {'speech_in': Decimal(100), 'text_out': Decimal(20)}})
        _put(stores.s3, voice.evidence_key(PRODUCT_SID), {'session_id': PRODUCT_SID, 'kind': 'product_interview'})
        _put(stores.s3, voice.transcript_key(PRODUCT_SID, 1), {'session_id': PRODUCT_SID, 'part': 1, 'turns': [
            {'role': 'assistant', 'text': 'What is the product called?', 'feedback_ids': ['fb1']},
            {'role': 'user', 'text': 'Parcel Tracker. Mail me at ada@example.com.'},
            {'role': 'assistant', 'text': 'Who is it for', 'interrupted': True},
        ]})
        return stores

    def _finalize(self, store: voice.Stores, saved: dict | None = None) -> tuple[dict[str, Any], Any, Any]:
        summarize = Mock(return_value=SUMMARY)
        with patch.object(transcripts.product_sources, 'save_interview_source',
                          return_value=saved or {'doc_id': 'doc-voice'}) as save, \
                patch.object(transcripts.usage_meter, 'log_stream_usage') as usage:
            result = transcripts.finalize(store, PRODUCT_CONFIG, summarize=summarize)
        assert summarize.call_count == 0
        usage.assert_called_once_with('amazon.nova-2-5-sonic', 'InvokeModelWithBidirectionalStream',
                                      input_tokens=100, output_tokens=20)
        return result, save, store.projects.get_item(Key=voice.session_key(PRODUCT_SID))['Item']

    def test_is_saved_as_a_voice_source_with_no_summary_call(self, product):
        result, save, session = self._finalize(product)
        project_id, answers = save.call_args.args
        assert (project_id, answers.mode, answers.session_id, answers.proposal_id) == ('p1', 'voice', PRODUCT_SID, None)
        assert answers.created_by == {'sub': 'sub-ada', 'kind': 'user'}
        assert (result, session['status'], session['source_doc_id']) == ({'source_doc_id': 'doc-voice'}, 'finalized',
                                                                          'doc-voice')
        assert 'transcript_document_id' not in session
        assert product.projects.get_item(Key={'pk': 'PROJECT#p1', 'sk': 'META'})['Item']['document_count'] == 0

    def test_labels_the_interviewer_and_redacts_the_person(self, product):
        _result, save, _session = self._finalize(product)
        text = save.call_args.args[1].text
        assert text.startswith('# Voice interview about the product (2026-11-21)')
        assert '**AI interviewer:** What is the product called?' in text
        assert '**Team member:** Parcel Tracker.' in text
        assert 'ada@example.com' not in text
        assert '**AI interviewer:** Who is it for _(interrupted)_' in text
        assert 'fb1' not in text

    def test_redacts_the_interviewers_echo_of_the_persons_words_too(self, product):
        # Review S1 (7.104.00 round 2): the interviewer confirms in a few words what it heard, so its turn repeated the
        # address the person's turn had redacted, and the source saved it under "(personal data redacted)".
        _put(product.s3, voice.transcript_key(PRODUCT_SID, 1), {'session_id': PRODUCT_SID, 'part': 1, 'turns': [
            {'role': 'user', 'text': 'Support is at help@parcel.example and +1 415 555 0100.'},
            {'role': 'assistant', 'text': 'So support is at help@parcel.example and +1 415 555 0100, right?'},
        ]})
        _result, save, _session = self._finalize(product)
        text = save.call_args.args[1].text
        assert '**AI interviewer:** So support is at' in text
        assert ('help@parcel.example' not in text, '555 0100' not in text) == (True, True)

    def test_deletes_its_scratch_files_and_runs_once(self, product):
        self._finalize(product)
        listed = product.s3.list_object_versions(Bucket='raw', Prefix=voice.scratch_prefix(PRODUCT_SID))
        assert (listed.get('Versions', []), listed.get('DeleteMarkers', [])) == ([], [])
        with patch.object(transcripts.product_sources, 'save_interview_source') as again:
            assert transcripts.finalize(product, PRODUCT_CONFIG) == {'source_doc_id': 'doc-voice'}
        again.assert_not_called()

    def test_a_silent_interview_saves_no_source(self, product):
        product.projects.update_item(Key=voice.session_key(PRODUCT_SID), UpdateExpression='SET transcript_parts = :zero',
                                     ExpressionAttributeValues={':zero': 0})
        with patch.object(transcripts.product_sources, 'save_interview_source') as save:
            assert transcripts.finalize(product, PRODUCT_CONFIG) == {'source_doc_id': None}
        save.assert_not_called()

    def test_a_refused_source_marks_it_failed(self, product):
        with patch.object(transcripts.product_sources, 'save_interview_source',
                          side_effect=ValidationError('This project already has 20 sources')), \
                pytest.raises(ValidationError):
            transcripts.finalize(product, PRODUCT_CONFIG)
        assert product.projects.get_item(Key=voice.session_key(PRODUCT_SID))['Item']['status'] == 'failed'

    def test_a_project_that_filled_up_during_the_interview_still_gets_it_past_the_cap(self, product):
        # The start found room (voice_sessions.mint); sources added meanwhile filled the project: the interview is
        # kept as a source past the cap rather than lost, and the session says so.
        full = ValidationError('A project holds at most 20 sources', code='too_many_sources')
        with patch.object(transcripts.product_sources, 'save_interview_source',
                          side_effect=[full, {'doc_id': 'doc-voice'}]) as save, \
                patch.object(transcripts.usage_meter, 'log_stream_usage'):
            assert transcripts.finalize(product, PRODUCT_CONFIG) == {'source_doc_id': 'doc-voice'}
        assert [call.args[1].past_the_cap for call in save.call_args_list] == [False, True]
        session = product.projects.get_item(Key=voice.session_key(PRODUCT_SID))['Item']
        assert (session['status'], session['source_doc_id'], voice.view(session)['over_source_cap']) == (
            'finalized', 'doc-voice', True)

    def test_a_source_saved_within_the_cap_is_not_marked(self, product):
        _result, _save, session = self._finalize(product)
        assert voice.view(session)['over_source_cap'] is False

    def test_a_product_job_never_saves_a_persona_session_or_the_reverse(self, product):
        with pytest.raises(NotFoundError):
            transcripts.finalize(product, {**PRODUCT_CONFIG, 'session_id': SID})
        with pytest.raises(NotFoundError):
            transcripts.finalize(product, {**CONFIG, 'session_id': PRODUCT_SID})
