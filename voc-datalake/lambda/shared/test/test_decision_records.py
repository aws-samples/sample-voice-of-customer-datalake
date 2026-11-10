"""Decision records (shared.decision_records): validation, storage, Pursue → PR/FAQ."""
from decimal import Decimal
from unittest.mock import MagicMock

import pytest
from botocore.exceptions import ClientError

from shared import decision_records as dr
from shared.exceptions import ConflictError, NotFoundError, ValidationError
from shared.project_access import Caller

ANA = Caller(subject='sub-user', username='Ana')
BEN = Caller(subject='sub-other', username='Ben')
VALID = {'title': 'Offline mode', 'verdict': 'pursue', 'rationale': 'Top complaint for 3 months',
         'success_metric': 'Offline complaints -50 %', 'kill_criterion': 'No change after 2 releases',
         'evidence': {'feedback_ids': ['fb_1', 'fb_2', 'fb_1'], 'document_ids': ['prd_1']},
         'review_by': '2026-12-01'}


def _table(*, document_ids=('prd_1',), stored=None):
    table = MagicMock()
    table.name = 'voc-projects'
    table.query.return_value = {'Items': [{'document_id': d} for d in document_ids]}
    table.get_item.return_value = {'Item': stored} if stored else {}
    return table


def _stored(**decision):
    base = {'verdict': 'park', 'rationale': 'Later', 'success_metric': '', 'kill_criterion': '',
            'evidence': {'feedback_ids': [], 'document_ids': []}, 'review_by': None, 'launched_at': None,
            'decided_by': 'sub-other', 'decided_by_name': 'Ben', 'decided_at': '2026-10-01T00:00:00+00:00',
            'history': []}
    return {'pk': 'PROJECT#p1', 'sk': 'DOC#doc_1', 'document_id': 'doc_1', 'document_type': 'decision',
            'title': 'Offline mode', 'revision': Decimal(2), 'decision': {**base, **decision}}


def _transact_update(table) -> dict:
    items = table.meta.client.transact_write_items.call_args.kwargs['TransactItems']
    return next(i['Update'] for i in items if 'Update' in i)


class TestValidation:
    def test_a_full_body_validates_and_dedupes_evidence(self):
        fields = dr.validated_fields(VALID, partial=False)
        assert fields['evidence'] == {'feedback_ids': ['fb_1', 'fb_2'], 'document_ids': ['prd_1']}
        assert (fields['review_by'], fields['launched_at'], fields['verdict']) == ('2026-12-01', None, 'pursue')

    @pytest.mark.parametrize(('patch', 'message'), [
        ({'verdict': 'maybe'}, 'verdict must be one of'),
        ({'rationale': '  '}, 'rationale is required'),
        ({'title': 'x' * 201}, 'title must be at most 200'),
        ({'kill_criterion': 7}, 'kill_criterion must be a string'),
        ({'review_by': '2026-02-30'}, 'review_by must be a YYYY-MM-DD'),
        ({'evidence': {'feedback_ids': ['bad id!']}}, 'only ids'),
        ({'evidence': {'feedback_ids': ['f'] * 51}}, 'at most 50'),
        ({'evidence': []}, 'evidence must be an object'),
    ])
    def test_bad_fields_are_400s(self, patch, message):
        with pytest.raises(ValidationError, match=message):
            dr.validated_fields({**VALID, **patch}, partial=False)

    def test_an_empty_edit_is_refused(self):
        with pytest.raises(ValidationError, match='at least one'):
            dr.validated_fields({'unknown': 1}, partial=True)

    @pytest.mark.parametrize('value', [0, True, '2', -1])
    def test_expected_revision_must_be_a_positive_int(self, value):
        with pytest.raises(ValidationError):
            dr.validated_expected_revision(value)


class TestCreate:
    def test_creates_a_doc_row_with_server_set_decider_and_derivation(self):
        table = _table()
        item = dr.create_decision(table, 'p1', VALID, ANA)['document']
        assert (item['document_type'], item['sk'], item['revision']) == ('decision', f"DOC#{item['document_id']}", 1)
        assert (item['decision']['decided_by'], item['decision']['decided_by_name']) == ('sub-user', 'Ana')
        assert item['derivation']['sources'] == [{'document_id': 'prd_1', 'role': 'reference'}]
        assert item['derivation']['feedback_count'] == 2

    def test_client_supplied_decider_is_ignored(self):
        item = dr.create_decision(_table(), 'p1', {**VALID, 'decided_by': 'sub-x'}, ANA)['document']
        assert item['decision']['decided_by'] == 'sub-user'

    def test_content_renders_the_fields(self):
        content = dr.create_decision(_table(), 'p1', VALID, ANA)['document']['content']
        assert content.startswith('# Offline mode\n')
        assert '**Verdict:** Pursue' in content
        assert '- Feedback: fb_2' in content

    def test_evidence_documents_must_be_in_the_project(self):
        with pytest.raises(ValidationError, match='not in this project'):
            dr.create_decision(_table(document_ids=('prd_9',)), 'p1', VALID, ANA)


class TestUpdate:
    def test_a_new_verdict_restamps_the_decider_and_keeps_history(self):
        table = _table(stored=_stored())
        doc = dr.update_decision(table, 'p1', 'doc_1', {'verdict': 'pursue', 'expected_revision': 2}, BEN)['document']
        assert (doc['revision'], doc['decision']['verdict'], doc['decision']['decided_by']) == (3, 'pursue', 'sub-other')
        assert doc['decision']['history'][0]['verdict'] == 'park'
        update = _transact_update(table)
        assert update['ExpressionAttributeValues'][':observed'] == 2

    def test_other_edits_keep_who_decided(self):
        table = _table(stored=_stored())
        doc = dr.update_decision(table, 'p1', 'doc_1', {'rationale': 'Now'}, ANA)['document']
        assert (doc['decision']['decided_by'], doc['decision']['updated_by']) == ('sub-other', 'sub-user')
        assert doc['decision']['history'] == []

    def test_a_stale_expected_revision_is_a_409(self):
        with pytest.raises(ConflictError):
            dr.update_decision(_table(stored=_stored()), 'p1', 'doc_1', {'rationale': 'x', 'expected_revision': 1}, ANA)

    def test_a_concurrent_save_is_a_409(self):
        table = _table(stored=_stored())
        table.meta.client.transact_write_items.side_effect = ClientError(
            {'Error': {'Code': 'TransactionCanceledException'}}, 'TransactWriteItems')
        with pytest.raises(ConflictError):
            dr.update_decision(table, 'p1', 'doc_1', {'rationale': 'x'}, ANA)

    def test_a_decision_cannot_cite_itself(self):
        table = _table(document_ids=('doc_1',), stored=_stored())
        with pytest.raises(ValidationError, match='itself'):
            dr.update_decision(table, 'p1', 'doc_1', {'evidence': {'document_ids': ['doc_1']}}, ANA)

    @pytest.mark.parametrize('stored', [None, {**_stored(), 'document_type': 'custom'}])
    def test_a_missing_or_non_decision_document_is_a_404(self, stored):
        with pytest.raises(NotFoundError):
            dr.stored_decision(_table(stored=stored), 'p1', 'doc_1')


class TestPursue:
    def test_a_pursue_decision_becomes_a_prfaq_request(self):
        item = _stored(verdict='pursue', rationale='Why', success_metric='KPI',
                       evidence={'feedback_ids': [], 'document_ids': ['a', 'b', 'c']})
        config = dr.pursue_doc_config(item, {'response_language': 'es'})
        assert (config['doc_type'], config['title'], config['response_language']) == ('prfaq', 'Offline mode', 'es')
        assert config['selected_document_ids'] == ['doc_1', 'a', 'b']
        assert config['feature_idea'] == 'Why\n\nSuccess metric: KPI'

    def test_only_pursue_seeds(self):
        with pytest.raises(ValidationError, match='Only a Pursue'):
            dr.pursue_doc_config(_stored(verdict='park'), {})

    def test_the_seeded_job_is_recorded_outside_the_fields(self):
        table = _table()
        dr.record_seeded_prfaq(table, _stored(), 'job-1')
        assert table.update_item.call_args.kwargs['ExpressionAttributeValues'][':job'] == 'job-1'
