"""shared/assist_jobs.py: start → worker run → poll, against a moto jobs table."""
from __future__ import annotations

import json
from decimal import Decimal
from unittest.mock import patch

import pytest
from moto import mock_aws

from shared import assist_jobs as aj
from shared.exceptions import NotFoundError, ServiceError, ValidationError
from shared.test.moto_tables import create_pk_sk_table


@pytest.fixture
def table():
    with mock_aws():
        created = create_pk_sk_table('test-jobs')
        with patch.object(aj, 'get_jobs_table', return_value=created):
            yield created


@pytest.fixture
def invoked():
    with patch.object(aj, 'invoke_lambda_async') as invoke:
        yield invoke


PK = aj.owner_pk('user-sub')


def _start(invoked, job_type='assist_categories', **kwargs) -> dict:
    del invoked  # the fixture only has to be active
    return aj.start(PK, job_type, {'company_description': 'airline'}, worker_function='worker-fn',
                    initiated_by='user-sub', **kwargs)


def _event(started: dict) -> dict:
    return {'action': aj.ASSIST_ACTION, 'pk': PK, 'job_id': started['job_id']}


@pytest.mark.usefixtures('table')
class TestStart:
    def test_answers_the_pending_job_and_invokes_the_worker_with_its_key(self, invoked):
        started = _start(invoked)
        assert started == {'success': True, 'job_id': started['job_id'], 'status': 'pending'}
        assert started['job_id'].startswith('job_')
        invoked.assert_called_once_with('worker-fn', _event(started))

    def test_the_row_carries_type_owner_config_and_a_one_day_ttl(self, invoked, table):
        started = _start(invoked, project_id='p1')
        row = table.get_item(Key={'pk': PK, 'sk': f"JOB#{started['job_id']}"})['Item']
        assert (row['job_type'], row['status'], row['initiated_by'], row['project_id'], row['config']) == (
            'assist_categories', 'pending', 'user-sub', 'p1', {'company_description': 'airline'})
        assert int(row['ttl']) - int(aj._now().timestamp()) == pytest.approx(86400, abs=5)

    def test_a_non_assist_type_is_a_programming_error(self, invoked):
        with pytest.raises(ValueError, match='assist_'):
            _start(invoked, job_type='generate_personas')

    def test_a_failed_invoke_marks_the_row_failed_and_answers_500(self, invoked, table):
        invoked.side_effect = RuntimeError('throttled')
        with pytest.raises(ServiceError, match='could not be started'):
            _start(invoked)
        [row] = table.scan()['Items']
        assert (row['status'], row['error']) == ('failed', 'The assistant could not be started; try again.')


@pytest.mark.usefixtures('table')
class TestStartOwned:
    def test_starts_in_the_callers_partition_on_the_configured_twin(self, invoked, table, monkeypatch):
        monkeypatch.setenv('ASSIST_WORKER_FUNCTION', 'twin-fn')
        started = aj.start_owned('user-sub', 'assist_analyze_url', {'url': 'https://example.com/'})
        invoked.assert_called_once_with('twin-fn', _event(started))
        row = table.get_item(Key={'pk': PK, 'sk': f"JOB#{started['job_id']}"})['Item']
        assert (row['initiated_by'], row['config']) == ('user-sub', {'url': 'https://example.com/'})

    def test_refuses_with_500_when_no_twin_is_configured(self, invoked, monkeypatch):
        monkeypatch.delenv('ASSIST_WORKER_FUNCTION', raising=False)
        with pytest.raises(ServiceError, match='not configured'):
            aj.start_owned('user-sub', 'assist_analyze_url', {'url': 'https://example.com/'})
        invoked.assert_not_called()


class TestAccepted:
    def test_answers_202_json_with_the_started_body(self):
        resp = aj.accepted({'success': True, 'job_id': 'job_1', 'status': 'pending'})
        assert (resp.status_code, resp.content_type) == (202, 'application/json')
        assert json.loads(str(resp.body)) == {'success': True, 'job_id': 'job_1', 'status': 'pending'}


class TestOwnerPk:
    def test_needs_a_subject(self):
        with pytest.raises(ServiceError):
            aj.owner_pk('')
        assert aj.owner_pk('s') == 'ASSIST#s'


@pytest.mark.usefixtures('table')
class TestRunAndPoll:
    def test_a_completed_job_returns_the_work_result_verbatim(self, invoked):
        started = _start(invoked)
        registry = {'assist_categories': aj.Work(lambda cfg: {'categories': [cfg['company_description']], 'score': 0.5},
                                                 'Category generation failed')}
        assert aj.run(_event(started), registry) == {'status': 'completed'}
        polled = aj.get(PK, started['job_id'])
        assert (polled['status'], polled['result'], polled['error']) == (
            'completed', {'categories': ['airline'], 'score': Decimal('0.5')}, None)
        assert set(polled) == {'success', *aj.VIEW_FIELDS}

    def test_a_4xx_refusal_records_its_own_message(self, invoked):
        started = _start(invoked)

        def refuse(_cfg):
            raise ValidationError('Company description is required')

        aj.run(_event(started), {'assist_categories': aj.Work(refuse, 'generic')})
        assert aj.get(PK, started['job_id'])['error'] == 'Company description is required'

    def test_an_unexpected_failure_records_the_generic_message_and_does_not_raise(self, invoked):
        started = _start(invoked)

        def boom(_cfg):
            raise RuntimeError('secret internals')

        assert aj.run(_event(started), {'assist_categories': aj.Work(boom, 'Category generation failed')}) == {
            'status': 'failed'}
        assert aj.get(PK, started['job_id'])['error'] == 'Category generation failed'

    def test_a_second_delivery_does_not_run_the_work_again(self, invoked):
        started = _start(invoked)
        calls = []
        registry = {'assist_categories': aj.Work(lambda cfg: calls.append(cfg) or {}, 'x')}
        aj.run(_event(started), registry)
        assert aj.run(_event(started), registry) == {'status': 'skipped'}
        assert len(calls) == 1

    def test_an_unregistered_type_fails_the_job(self, invoked):
        started = _start(invoked)
        assert aj.run(_event(started), {}) == {'status': 'failed'}
        assert aj.get(PK, started['job_id'])['error'] == 'This assistant is not available.'

    def test_a_malformed_event_is_ignored(self):
        assert aj.run({'action': aj.ASSIST_ACTION}, {}) == {'status': 'ignored'}

    def test_poll_404s_a_missing_job_a_bad_id_and_a_non_assist_row(self, invoked, table):
        _start(invoked)
        table.put_item(Item={'pk': PK, 'sk': 'JOB#job_other', 'job_id': 'job_other', 'job_type': 'generate_personas'})
        for job_id in ('job_missing', 'not-a-job', 'job_other'):
            with pytest.raises(NotFoundError):
                aj.get(PK, job_id)

    def test_another_owner_cannot_read_the_job(self, invoked):
        started = _start(invoked)
        with pytest.raises(NotFoundError):
            aj.get(aj.owner_pk('someone-else'), started['job_id'])


class TestEventAndTypes:
    @pytest.mark.parametrize(('event', 'expected'), [
        ({'action': 'assist_job'}, True), ({'action': 'other'}, False), ({}, False), ('assist_job', False)])
    def test_is_assist_event(self, event, expected):
        assert aj.is_assist_event(event) is expected

    @pytest.mark.parametrize(('job_type', 'expected'), [
        ('assist_x', True), ('generate_personas', False), (None, False)])
    def test_is_assist_job_type(self, job_type, expected):
        assert aj.is_assist_job_type(job_type) is expected
