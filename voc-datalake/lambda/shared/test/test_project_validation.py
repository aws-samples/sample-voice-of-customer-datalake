"""The Validate step's shared rules (shared/project_validation.py, 7.68.00): criteria and tasks, the META's block
(conditional on its revision, refused on a deleted project, who / when / why), and the verdicts: real testers only,
never a synthetic run."""
from __future__ import annotations

from decimal import Decimal

import pytest
from moto import mock_aws

from shared import project_validation as pv
from shared.exceptions import ConflictError, NotFoundError, ValidationError
from shared.test.moto_tables import create_pk_sk_table

ACTOR = {'sub': 'user-1', 'kind': 'user'}


class TestCriteria:
    def test_ids_are_minted_kept_and_texts_stripped(self):
        criteria = pv.validated_criteria([{'text': '  Fast to find an invoice '}, {'id': 'c00aa11', 'text': 'Clear',
                                                                                   'target': 3.46}])
        assert pv.CRITERION_ID.fullmatch(criteria[0]['id'])
        assert criteria[0] == {'id': criteria[0]['id'], 'text': 'Fast to find an invoice'}
        assert criteria[1] == {'id': 'c00aa11', 'text': 'Clear', 'target': Decimal('3.5')}

    @pytest.mark.parametrize(('value', 'message'), [
        ([], 'criteria must be a list of 1 to 10 entries'),
        ([{'text': 'x'}] * 11, 'criteria must be a list of 1 to 10 entries'),
        ([{'text': ''}], 'criteria[0].text is required'),
        ([{'text': 'x' * 301}], 'criteria[0].text must be at most 300 characters'),
        ([{'text': 'x', 'target': 6}], 'criteria[0].target must be a number from 1 to 5'),
        ([{'text': 'x', 'target': True}], 'criteria[0].target must be a number from 1 to 5'),
        ([{'text': 'x', 'weight': 1}], 'criteria[0].weight is not a field of criteria'),
        ([{'id': 't00aa11', 'text': 'x'}], 'criteria[0].id is not one of its ids'),
        ([{'id': 'c00aa11', 'text': 'x'}, {'id': 'c00aa11', 'text': 'y'}], 'is used twice'),
        (['x'], 'criteria[0] must be an object'),
    ])
    def test_a_bad_list_is_a_400_naming_the_field(self, value, message):
        with pytest.raises(ValidationError, match=message.replace('[', r'\[').replace(']', r'\]')):
            pv.validated_criteria(value)

    def test_a_minted_id_never_repeats_one_given_in_the_same_list(self, monkeypatch):
        draws = iter(['00aa11', '00aa11', '00bb22'])
        monkeypatch.setattr(pv.secrets, 'token_hex', lambda _n: next(draws))
        criteria = pv.validated_criteria([{'id': 'c00aa11', 'text': 'a'}, {'text': 'b'}])
        assert [c['id'] for c in criteria] == ['c00aa11', 'c00bb22']

    def test_tasks_take_text_only(self):
        tasks = pv.validated_tasks([{'text': 'Find last month\'s invoice'}])
        assert pv.TASK_ID.fullmatch(tasks[0]['id'])
        with pytest.raises(ValidationError, match='tasks must be a list of 1 to 8 entries'):
            pv.validated_tasks([{'text': 'x'}] * 9)
        with pytest.raises(ValidationError, match='is not a field of tasks'):
            pv.validated_tasks([{'text': 'x', 'target': 4}])


CRITERION = {'id': 'c00aa11', 'text': 'Fast', 'target': Decimal('4.5')}


class TestJudging:

    @pytest.mark.parametrize(('real', 'status'), [
        (None, pv.NOT_ENOUGH_DATA),
        ({'n': 4, 'average': 5.0}, pv.NOT_ENOUGH_DATA),
        ({'n': 5, 'average': 4.5}, pv.MET),
        ({'n': 9, 'average': 4.4}, pv.NOT_MET),
        ({'n': 9, 'average': None}, pv.NOT_ENOUGH_DATA),
    ])
    def test_a_criterion_is_judged_on_real_testers_against_its_target(self, real, status):
        assert pv.judged(CRITERION, real) == status

    def test_without_a_target_the_default_applies(self):
        assert pv.judged({'id': 'c1', 'text': 'x'}, {'n': 5, 'average': 4.0}) == pv.MET
        assert pv.judged({'id': 'c1', 'text': 'x'}, {'n': 5, 'average': 3.9}) == pv.NOT_MET

    def test_a_synthetic_run_never_counts_towards_met(self):
        """Every persona rated it 5 and no tester answered: not enough data, the run shown beside it, labelled."""
        [result] = pv.criteria_results([CRITERION], None, {'criteria': {'c00aa11': {'n': 6, 'average': 5.0}}})
        assert result['outcome'] == pv.NOT_ENOUGH_DATA
        assert result['synthetic'] == {'n': 6, 'average': 5.0, 'reading': pv.LIKELY_MET, 'synthetic': True}
        assert pv.suggested_verdict([result]) == 'park'

    def test_task_results_put_the_personas_beside_the_testers(self):
        [task] = pv.task_results([{'id': 't1', 'text': 'Pay'}], {'tasks': {'t1': {'n': 2, 'yes': 1, 'no': 1,
                                                                                  'rate': 0.5}}},
                                 {'tasks': {'t1': {'completed': 3, 'struggled': 0, 'failed': 0, 'n': 3}}})
        assert task['real']['rate'] == 0.5
        assert task['synthetic'] == {'completed': 3, 'struggled': 0, 'failed': 0, 'n': 3, 'synthetic': True}
        assert pv.task_results([{'id': 't2', 'text': 'x'}], None, None)[0]['synthetic'] is None

    def test_pursue_only_when_every_criterion_is_met(self):
        met = {'outcome': pv.MET}
        assert pv.suggested_verdict([met, met]) == 'pursue'
        assert pv.suggested_verdict([met, {'outcome': pv.NOT_MET}]) == 'park'
        assert pv.suggested_verdict([]) == 'park'

    def test_the_decision_prefill_names_the_report_and_the_real_responses(self):
        results = pv.criteria_results([CRITERION], {'criteria': {'c00aa11': {'n': 6, 'average': 4.6}}}, None)
        prefill = pv.decision_prefill('Billing', results, report_document_id='doc_1',
                                      feedback_ids=['f1', 'f1', *[f'f{i}' for i in range(2, 60)]], responses=6)
        assert prefill['verdict'] == 'pursue'
        assert prefill['success_metric'] == 'Fast (target 4.5 of 5)'
        assert prefill['evidence']['document_ids'] == ['doc_1']
        assert len(prefill['evidence']['feedback_ids']) == 50
        assert prefill['evidence']['feedback_ids'][0] == 'f1'
        assert 'Synthetic persona runs are not counted' in prefill['rationale']


@pytest.fixture
def table():
    with mock_aws():
        projects = create_pk_sk_table('test-projects')
        projects.put_item(Item={'pk': 'PROJECT#p1', 'sk': 'META', 'project_id': 'p1', 'name': 'P'})
        yield projects


class TestTheBlock:
    def test_the_first_write_records_who_when_why_and_the_revision(self, table):
        criteria = pv.validated_criteria([{'text': 'Fast', 'target': 4.5}])
        block = pv.update_block(table, 'p1', lambda _s: {'criteria': criteria}, actor=ACTOR,
                                reason=pv.REASON_CRITERIA_EDITED)
        stored = pv.block_of(pv.read_meta(table, 'p1'))
        assert stored == {**block, 'criteria': [{'id': criteria[0]['id'], 'text': 'Fast', 'target': 4.5}]}
        # (no stored status: review round 1, F3)
        assert (stored['revision'], stored['updated_by'], stored['reason'], 'status' in stored) == (
            1, ACTOR, 'criteria_edited', False)

    def test_a_stale_editor_is_a_409_and_writes_nothing(self, table):
        pv.update_block(table, 'p1', lambda _s: {'criteria': []}, actor=ACTOR, reason='x')
        with pytest.raises(ConflictError) as raised:
            pv.update_block(table, 'p1', lambda _s: {'tasks': []}, actor=ACTOR, reason='y', expected_revision=0)
        assert raised.value.code == pv.CHANGED_CODE
        assert 'tasks' not in pv.block_of(pv.read_meta(table, 'p1'))

    def test_a_job_reads_a_write_in_between_again_and_keeps_it(self, table):
        pv.update_block(table, 'p1', lambda _s: {'criteria': [{'id': 'c1', 'text': 'a'}]}, actor=ACTOR, reason='x')
        calls = []

        def changes(stored):
            calls.append(stored.get('revision'))
            if len(calls) == 1:  # someone saves between the job's read and its write
                pv.update_block(table, 'p1', lambda _s: {'tasks': [{'id': 't1', 'text': 'b'}]}, actor=ACTOR,
                                reason='edit')
            return {'plan_document_id': 'doc_1'}

        block = pv.update_block(table, 'p1', changes, actor=ACTOR, reason=pv.REASON_PLAN_WRITTEN)
        assert calls == [1, 2]
        assert (block['revision'], block['tasks'], block['plan_document_id']) == (3, [{'id': 't1', 'text': 'b'}],
                                                                                  'doc_1')

    def test_a_project_being_deleted_takes_no_write(self, table):
        table.update_item(Key={'pk': 'PROJECT#p1', 'sk': 'META'}, UpdateExpression='SET deletion_started_at = :at',
                          ExpressionAttributeValues={':at': '2026-11-21T00:00:00Z'})
        with pytest.raises(NotFoundError):
            pv.update_block(table, 'p1', lambda _s: {'criteria': []}, actor=ACTOR, reason='x')

    def test_a_missing_project_is_a_404(self, table):
        with pytest.raises(NotFoundError):
            pv.read_meta(table, 'nope')
