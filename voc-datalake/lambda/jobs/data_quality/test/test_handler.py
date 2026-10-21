"""Tests for the data quality worker (lambda/jobs/data_quality/handler.py)."""
import json
from unittest.mock import MagicMock, patch

import pytest
from botocore.exceptions import ClientError
from shared import data_quality as dq

JOB_ID = 'dq_20261016000000_abcdef12'


def _conditional_failure() -> ClientError:
    return ClientError({'Error': {'Code': 'ConditionalCheckFailedException'}}, 'UpdateItem')


def _job(**overrides) -> dict:
    job = {
        'pk': dq.JOBS_PK, 'sk': JOB_ID, 'job_id': JOB_ID, 'status': dq.STATUS_RUNNING,
        'kind': dq.KIND_ENRICH, 'source': 'webscraper', 'field': 'usefulness', 'mode': dq.MODE_MISSING,
        'total': 0, 'processed': 0, 'planned': False,
    }
    job.update(overrides)
    return job


def _record(message: dict, receive_count: int = 1, message_id: str = 'm1') -> dict:
    return {
        'messageId': message_id,
        'body': json.dumps(message),
        'attributes': {'ApproximateReceiveCount': str(receive_count)},
    }


def _item_message(**overrides) -> dict:
    msg = {
        'type': dq.MSG_ENRICH_ITEM, 'job_id': JOB_ID, 'field': 'usefulness',
        'mode': dq.MODE_MISSING, 'pk': 'SOURCE#webscraper', 'sk': 'FEEDBACK#1',
    }
    msg.update(overrides)
    return msg


class _Context:
    def __init__(self, remaining_ms: int = 300_000):
        self.remaining_ms = remaining_ms
        self.function_name = 'voc-data-quality-worker'
        self.memory_limit_in_mb = 512
        self.invoked_function_arn = 'arn:aws:lambda:us-east-1:123456789012:function:x'
        self.aws_request_id = 'req'

    def get_remaining_time_in_millis(self) -> int:
        return self.remaining_ms


@pytest.fixture
def worker():
    """The handler module with both tables and SQS replaced by mocks."""
    from jobs.data_quality import handler

    feedback = MagicMock(name='feedback_table')
    aggregates = MagicMock(name='aggregates_table')
    sqs = MagicMock(name='sqs')
    sqs.send_message_batch.return_value = {'Failed': []}
    state = {'job': _job()}

    aggregates.get_item.side_effect = lambda Key: {'Item': dict(state['job'])}

    def update_item(**kwargs):
        expression = kwargs['UpdateExpression']
        values = kwargs.get('ExpressionAttributeValues', {})
        names = kwargs.get('ExpressionAttributeNames', {})
        job = state['job']
        if 'completed_at' in expression:  # finish_job
            if job['status'] != dq.STATUS_RUNNING:
                raise _conditional_failure()
            job['status'] = values[':status']
            return {}
        if expression.startswith('ADD'):
            for alias, attr in names.items():
                job[attr] = job.get(attr, 0) + values[f':{alias[1:]}']
        else:
            for alias, attr in names.items():
                job[attr] = values[f':{alias[1:]}']
        return {'Attributes': dict(job)}

    aggregates.update_item.side_effect = update_item
    with patch.object(handler, 'feedback_table', feedback), \
            patch.object(handler, 'aggregates_table', aggregates), \
            patch.object(handler, 'get_sqs_client', return_value=sqs), \
            patch.object(handler, 'QUEUE_URL', 'https://sqs.example/q'):
        yield handler, feedback, aggregates, sqs, state


def _run(handler, *records, remaining_ms: int = 300_000) -> dict:
    return handler.lambda_handler({'Records': list(records)}, _Context(remaining_ms))


class TestEnrichItem:
    def test_writes_a_derived_value_with_the_missing_mode_guard_and_counts_it(self, worker):
        handler, feedback, _, _, state = worker
        state['job'].update(total=1, planned=True)
        feedback.get_item.return_value = {'Item': {'original_text': 'App crashes when I upload a photo'}}
        with patch.object(handler, 'converse', return_value='{"usefulness": "High"}') as converse:
            result = _run(handler, _record(_item_message()))

        assert result == {'batchItemFailures': []}
        assert converse.call_args.kwargs['surface'] == 'enrichment'
        update = feedback.update_item.call_args.kwargs
        assert update['ExpressionAttributeValues'] == {':v': 'high'}
        assert 'attribute_exists(pk)' in update['ConditionExpression']
        assert 'attribute_not_exists(#f)' in update['ConditionExpression']
        assert state['job']['updated'] == 1 and state['job']['processed'] == 1
        assert state['job']['status'] == dq.STATUS_COMPLETED

    def test_all_mode_does_not_require_the_field_to_be_missing(self, worker):
        handler, feedback, _, _, _ = worker
        feedback.get_item.return_value = {'Item': {'original_text': 'ok'}}
        with patch.object(handler, 'converse', return_value='{"usefulness":"low"}'):
            _run(handler, _record(_item_message(mode=dq.MODE_ALL)))
        assert 'attribute_not_exists' not in feedback.update_item.call_args.kwargs['ConditionExpression']

    def test_a_refused_guard_counts_as_skipped(self, worker):
        handler, feedback, _, _, state = worker
        feedback.get_item.return_value = {'Item': {'original_text': 'ok'}}
        feedback.update_item.side_effect = _conditional_failure()
        with patch.object(handler, 'converse', return_value='{"usefulness":"low"}'):
            result = _run(handler, _record(_item_message()))
        assert result == {'batchItemFailures': []}
        assert state['job']['skipped'] == 1

    def test_an_answer_outside_the_enum_is_failed_not_retried(self, worker):
        handler, feedback, _, _, state = worker
        feedback.get_item.return_value = {'Item': {'original_text': 'ok'}}
        with patch.object(handler, 'converse', return_value='{"usefulness":"stellar"}'):
            result = _run(handler, _record(_item_message()))
        assert result == {'batchItemFailures': []}
        assert state['job']['failed'] == 1
        feedback.update_item.assert_not_called()

    def test_a_row_without_text_is_skipped_without_a_model_call(self, worker):
        handler, feedback, _, _, state = worker
        feedback.get_item.return_value = {}
        with patch.object(handler, 'converse') as converse:
            _run(handler, _record(_item_message()))
        converse.assert_not_called()
        assert state['job']['skipped'] == 1

    def test_a_model_error_is_retried_until_the_final_delivery(self, worker):
        handler, feedback, _, _, state = worker
        feedback.get_item.return_value = {'Item': {'original_text': 'ok'}}
        with patch.object(handler, 'converse', side_effect=RuntimeError('throttled')):
            early = _run(handler, _record(_item_message(), receive_count=1))
            assert early == {'batchItemFailures': [{'itemIdentifier': 'm1'}]}
            assert state['job'].get('processed', 0) == 0
            final = _run(handler, _record(_item_message(), receive_count=handler.MAX_RECEIVE_COUNT))
        assert final == {'batchItemFailures': []}
        assert state['job']['failed'] == 1

    def test_messages_for_a_cancelled_job_are_dropped(self, worker):
        handler, feedback, _, _, state = worker
        state['job']['status'] = dq.STATUS_CANCELLED
        with patch.object(handler, 'converse') as converse:
            result = _run(handler, _record(_item_message()))
        assert result == {'batchItemFailures': []}
        converse.assert_not_called()
        feedback.get_item.assert_not_called()

    def test_poison_messages_are_dropped(self, worker):
        handler, _, _, _, _ = worker
        result = _run(handler, {'messageId': 'x', 'body': 'not json', 'attributes': {}})
        assert result == {'batchItemFailures': []}


class TestEnrichPlan:
    def _plan(self, **overrides) -> dict:
        msg = {'type': dq.MSG_ENRICH_PLAN, 'job_id': JOB_ID, 'source': 'webscraper',
               'field': 'usefulness', 'mode': dq.MODE_MISSING}
        msg.update(overrides)
        return msg

    def test_fans_out_one_item_message_per_row_and_records_the_total(self, worker):
        handler, feedback, _, sqs, state = worker
        rows = [{'pk': 'SOURCE#webscraper', 'sk': f'FEEDBACK#{i}'} for i in range(12)]
        feedback.query.return_value = {'Items': rows}
        _run(handler, _record(self._plan()))

        sent = [json.loads(e['MessageBody']) for c in sqs.send_message_batch.call_args_list for e in c.kwargs['Entries']]
        assert len(sent) == 12 and sqs.send_message_batch.call_count == 2
        assert all(m['type'] == dq.MSG_ENRICH_ITEM and m['field'] == 'usefulness' for m in sent)
        assert state['job']['total'] == 12 and state['job']['planned'] is True
        assert state['job']['status'] == dq.STATUS_RUNNING
        query = feedback.query.call_args.kwargs
        assert 'FilterExpression' in query  # missing mode reads only unscored rows

    def test_an_empty_plan_completes_the_job_immediately(self, worker):
        handler, feedback, _, _, state = worker
        feedback.query.return_value = {'Items': []}
        _run(handler, _record(self._plan(mode=dq.MODE_ALL)))
        assert 'FilterExpression' not in feedback.query.call_args.kwargs
        assert state['job']['status'] == dq.STATUS_COMPLETED

    def test_continues_itself_with_the_cursor_when_time_is_short(self, worker):
        handler, feedback, _, sqs, state = worker
        feedback.query.return_value = {
            'Items': [{'pk': 'SOURCE#webscraper', 'sk': 'FEEDBACK#1'}],
            'LastEvaluatedKey': {'pk': 'SOURCE#webscraper', 'sk': 'FEEDBACK#1'},
        }
        _run(handler, _record(self._plan()), remaining_ms=1_000)
        continuation = json.loads(sqs.send_message.call_args.kwargs['MessageBody'])
        assert continuation['type'] == dq.MSG_ENRICH_PLAN
        assert continuation['start_key'] == {'pk': 'SOURCE#webscraper', 'sk': 'FEEDBACK#1'}
        assert state['job']['planned'] is False

    def test_a_partial_send_records_what_was_sent_and_retries(self, worker):
        handler, feedback, _, sqs, state = worker
        feedback.query.return_value = {'Items': [{'pk': 'SOURCE#w', 'sk': f'FEEDBACK#{i}'} for i in range(3)]}
        sqs.send_message_batch.return_value = {'Failed': [{'Id': '0'}]}
        result = _run(handler, _record(self._plan()))
        assert result == {'batchItemFailures': [{'itemIdentifier': 'm1'}]}
        assert state['job']['total'] == 2

    def test_a_plan_failing_on_its_final_delivery_fails_the_job(self, worker):
        handler, feedback, _, _, state = worker
        feedback.query.side_effect = RuntimeError('boom')
        result = _run(handler, _record(self._plan(), receive_count=handler.MAX_RECEIVE_COUNT))
        assert result == {'batchItemFailures': []}
        assert state['job']['status'] == dq.STATUS_FAILED


class TestProfileScan:
    def test_scans_every_page_then_writes_the_snapshot_and_completes(self, worker):
        handler, feedback, aggregates, _, state = worker
        state['job'].update(kind=dq.KIND_PROFILE, source='', field='')
        feedback.scan.side_effect = [
            {'Items': [{'pk': 'SOURCE#a', 'sk': 'FEEDBACK#1', 'rating': 5, 'usefulness': 'high',
                        'sentiment_label': 'positive', 'original_text': 'x' * 50}],
             'LastEvaluatedKey': {'pk': 'SOURCE#a', 'sk': 'FEEDBACK#1'}},
            {'Items': [{'pk': 'SOURCE#b', 'sk': 'FEEDBACK#2', 'original_text': 'y' * 700}]},
        ]
        _run(handler, _record({'type': dq.MSG_PROFILE_SCAN, 'job_id': JOB_ID}))

        snapshot = aggregates.put_item.call_args.kwargs['Item']
        assert snapshot['pk'] == dq.STATS_PK and snapshot['scanned'] == 2
        by_source = {s['source']: s for s in snapshot['sources']}
        assert by_source['a']['ratings'] == {'5': 1}
        assert by_source['b']['enrichment']['usefulness'] == {'unscored': 1}
        assert by_source['b']['lengths'] == {'501-1000': 1}
        assert state['job']['status'] == dq.STATUS_COMPLETED

    def test_carries_the_partial_profile_across_a_continuation(self, worker):
        handler, feedback, aggregates, sqs, state = worker
        state['job'].update(kind=dq.KIND_PROFILE)
        feedback.scan.return_value = {
            'Items': [{'pk': 'SOURCE#a', 'sk': 'FEEDBACK#1', 'original_text': 'x'}],
            'LastEvaluatedKey': {'pk': 'SOURCE#a', 'sk': 'FEEDBACK#1'},
        }
        _run(handler, _record({'type': dq.MSG_PROFILE_SCAN, 'job_id': JOB_ID}), remaining_ms=1_000)
        continuation = json.loads(sqs.send_message.call_args.kwargs['MessageBody'])
        assert continuation['scanned'] == 1
        assert continuation['partial']['a']['count'] == 1
        aggregates.put_item.assert_not_called()
        assert state['job']['status'] == dq.STATUS_RUNNING
