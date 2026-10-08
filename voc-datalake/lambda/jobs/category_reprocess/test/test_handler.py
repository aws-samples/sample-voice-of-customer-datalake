"""Tests for the category reprocess worker (jobs/category_reprocess/handler.py)."""
import json
from datetime import UTC, datetime, timedelta
from unittest.mock import MagicMock, patch

import pytest

from jobs.category_reprocess.handler import (
    CATEGORY_SOURCE_REPROCESS,
    run_job,
    window_cutoff,
)
from shared import reprocess_jobs as jobs
from shared.converse import BedrockThrottlingError


def feedback_item(feedback_id: str, **overrides) -> dict:
    item = {
        'pk': 'SOURCE#web', 'sk': f'FEEDBACK#{feedback_id}', 'feedback_id': feedback_id,
        'gsi1pk': 'DATE#2026-01-10', 'gsi1sk': f'2026-01-10T00:00:00+00:00#{feedback_id}',
        'gsi2pk': 'CATEGORY#billing', 'gsi2sk': '0.1#2026-01-10T00:00:00+00:00',
        'gsi3pk': 'URGENCY#low', 'gsi3sk': '2026-01-10T00:00:00+00:00',
        'date': datetime.now(UTC).strftime('%Y-%m-%d'),
        'source_platform': 'web', 'source_channel': 'reviews',
        'original_text': 'My parcel arrived two weeks late', 'category': 'billing',
    }
    item.update(overrides)
    return item


def _all_items(table) -> dict:
    return {item['feedback_id']: item for item in table.scan()['Items']}


def _stored_job(tables, job_id) -> dict:
    stored = jobs.get_job(tables['aggregates'], job_id)
    assert stored is not None, f'job {job_id} is not stored'
    return stored


def _job(tables, job_id):
    return jobs.job_view(_stored_job(tables, job_id))


def _assert_untouched_and_counted_failed(tables, job_id):
    """Review `a` keeps its stored category and the job counts it as failed."""
    assert _all_items(tables['feedback'])['a']['category'] == 'billing'
    assert _job(tables, job_id)['failed'] == 1


def test_window_cutoff():
    today = datetime(2026, 3, 10, tzinfo=UTC)
    assert window_cutoff(0, today) is None
    assert window_cutoff(1, today) == '2026-03-10'
    assert window_cutoff(30, today) == '2026-02-09'


@pytest.mark.usefixtures('converse_mock', 'invoke_mock')
class TestProcessedMode:
    def test_recategorises_in_place_keeping_keys(self, tables, start_job, worker_context):
        before = feedback_item('a', subcategory='invoice')
        tables['feedback'].put_item(Item=before)
        job = start_job()

        assert run_job({'job_id': job['sk']}, worker_context)['status'] == 'completed'

        items = _all_items(tables['feedback'])
        assert len(items) == 1
        after = items['a']
        assert after['category'] == 'shipping'
        assert after['subcategory'] == 'late'
        assert after['gsi2pk'] == 'CATEGORY#shipping'
        assert after['category_source'] == CATEGORY_SOURCE_REPROCESS
        assert after['category_reprocessed_at']
        for key in ('pk', 'sk', 'gsi1pk', 'gsi1sk', 'gsi2sk', 'gsi3pk', 'gsi3sk', 'original_text'):
            assert after[key] == before[key]
        view = _job(tables, job['sk'])
        assert view['status'] == 'completed'
        assert view['scanned'] == 1
        assert view['updated'] == 1
        # Lock released: a new job can start.
        assert start_job() is not None

    def test_unchanged_review_is_not_written(self, tables, start_job, worker_context):
        tables['feedback'].put_item(Item=feedback_item('a', category='shipping', subcategory='late'))
        job = start_job()
        run_job({'job_id': job['sk']}, worker_context)
        assert 'category_source' not in _all_items(tables['feedback'])['a']
        assert _job(tables, job['sk'])['unchanged'] == 1

    def test_manual_corrections_are_respected(self, tables, start_job, worker_context):
        tables['feedback'].put_item(Item=feedback_item('m', category_source='manual'))
        job = start_job()
        run_job({'job_id': job['sk']}, worker_context)
        assert _all_items(tables['feedback'])['m']['category'] == 'billing'
        assert _job(tables, job['sk'])['skipped_manual'] == 1

    def test_include_manual_overrides(self, tables, start_job, worker_context):
        tables['feedback'].put_item(Item=feedback_item('m', category_source='manual'))
        job = start_job(include_manual=True)
        run_job({'job_id': job['sk']}, worker_context)
        item = _all_items(tables['feedback'])['m']
        assert item['category'] == 'shipping'
        assert item['category_source'] == 'reprocess'

    def test_window_excludes_older_reviews(self, tables, start_job, worker_context):
        old = (datetime.now(UTC) - timedelta(days=40)).strftime('%Y-%m-%d')
        tables['feedback'].put_item(Item=feedback_item('old', date=old))
        tables['feedback'].put_item(Item=feedback_item('new'))
        job = start_job(days=7)
        run_job({'job_id': job['sk']}, worker_context)
        items = _all_items(tables['feedback'])
        assert items['old']['category'] == 'billing'
        assert items['new']['category'] == 'shipping'
        assert _job(tables, job['sk'])['scanned'] == 1

    def test_unknown_category_answer_counts_failed(self, tables, start_job, worker_context, converse_mock):
        converse_mock.return_value = '{"category": "invented"}'
        tables['feedback'].put_item(Item=feedback_item('a'))
        job = start_job()
        run_job({'job_id': job['sk']}, worker_context)
        _assert_untouched_and_counted_failed(tables, job['sk'])


@pytest.mark.usefixtures('converse_mock')
class TestHandOverAndCancel:
    def test_hands_over_with_cursor_when_time_runs_low(self, tables, start_job, worker_context, invoke_mock):
        for index in range(3):
            tables['feedback'].put_item(Item=feedback_item(f'i{index}'))
        job = start_job()
        worker_context.get_remaining_time_in_millis.side_effect = [900_000, 1_000, 1_000]

        assert run_job({'job_id': job['sk']}, worker_context)['status'] == 'continued'

        invoke_mock.assert_called_once()
        name, event = invoke_mock.call_args.args
        assert name == 'voc-job-category-reprocess'
        assert event['job_id'] == job['sk']
        assert event['cursor']['sk'].startswith('FEEDBACK#')
        assert _job(tables, job['sk'])['status'] == 'running'

        worker_context.get_remaining_time_in_millis.side_effect = None
        assert run_job(event, worker_context)['status'] == 'completed'
        view = _job(tables, job['sk'])
        assert view['scanned'] == 3
        assert view['updated'] == 3

    def test_throttling_hands_over_without_counting_the_item(
        self, tables, start_job, worker_context, invoke_mock, converse_mock,
    ):
        tables['feedback'].put_item(Item=feedback_item('a'))
        job = start_job()
        converse_mock.side_effect = BedrockThrottlingError('slow')
        assert run_job({'job_id': job['sk']}, worker_context)['status'] == 'continued'
        assert invoke_mock.call_args.args[1]['throttle_restarts'] == 1
        assert _job(tables, job['sk'])['scanned'] == 0

    def test_an_unexpected_job_failure_is_logged_by_type_only(self, tables, start_job, worker_context):
        # A model or NLP refusal can echo review text in its message; the job log
        # must carry the type, never the message or a traceback.
        job = start_job()
        failure = RuntimeError('refused: "my card number is 4111…"')
        with patch('jobs.category_reprocess.handler._reprocess_pages', side_effect=failure), \
                patch('jobs.category_reprocess.handler.logger') as logger_mock:
            result = run_job({'job_id': job['sk']}, worker_context)

        assert result == {'status': 'failed'}
        assert _job(tables, job['sk'])['error'] == 'Reprocess failed (RuntimeError)'
        logger_mock.exception.assert_not_called()
        logger_mock.error.assert_called_once_with(
            'Category reprocess job failed', extra={'job_id': job['sk'], 'error_type': 'RuntimeError'},
        )
        assert '4111' not in repr(logger_mock.mock_calls)

    @pytest.mark.usefixtures('invoke_mock')
    def test_cancelled_job_does_nothing(self, tables, start_job, worker_context, converse_mock):
        tables['feedback'].put_item(Item=feedback_item('a'))
        job = start_job()
        jobs.cancel_job(tables['aggregates'], job['sk'])
        assert run_job({'job_id': job['sk']}, worker_context)['status'] == 'not_active'
        converse_mock.assert_not_called()
        assert _all_items(tables['feedback'])['a']['category'] == 'billing'

    def test_duplicate_delivery_does_no_work(self, tables, start_job, worker_context, converse_mock):
        tables['feedback'].put_item(Item=feedback_item('a'))
        job = start_job()
        # The first delivery claims the job and stops mid-run (simulated by a claim).
        assert jobs.claim_job(tables['aggregates'], job['sk'], 'owner') is not None
        assert run_job({'job_id': job['sk']}, worker_context)['status'] == 'not_active'
        converse_mock.assert_not_called()
        assert _all_items(tables['feedback'])['a']['category'] == 'billing'

    def test_superseded_worker_exits_at_its_checkpoint(self, tables, start_job, worker_context, invoke_mock):
        for index in range(2):
            tables['feedback'].put_item(Item=feedback_item(f'i{index}'))
        job = start_job()
        real_checkpoint = jobs.checkpoint

        def steal_then_checkpoint(table, job_id, counters, cursor, token, now=None):
            # Another delivery takes the job over between pages.
            jobs.claim_job(table, job_id, 'thief', previous_token=token)
            return real_checkpoint(table, job_id, counters, cursor, token, now)

        with patch('jobs.category_reprocess.handler.PAGE_SIZE', 1), \
                patch.object(jobs, 'checkpoint', side_effect=steal_then_checkpoint):
            result = run_job({'job_id': job['sk']}, worker_context)
        assert result['status'] == 'cancelled'
        invoke_mock.assert_not_called()
        view = _job(tables, job['sk'])
        assert view['status'] == 'running'
        assert view['scanned'] == 0

    def test_hand_over_carries_the_claim_token(self, tables, start_job, worker_context, invoke_mock):
        tables['feedback'].put_item(Item=feedback_item('a'))
        job = start_job()
        worker_context.get_remaining_time_in_millis.return_value = 1_000
        run_job({'job_id': job['sk']}, worker_context)
        event = invoke_mock.call_args.args[1]
        assert event['worker_token'] == _stored_job(tables, job['sk'])['worker_token']
        # Replaying the original event (a duplicate) is refused; the hand-over is not.
        worker_context.get_remaining_time_in_millis.return_value = 900_000
        assert run_job({'job_id': job['sk']}, worker_context)['status'] == 'not_active'
        assert run_job(event, worker_context)['status'] == 'completed'

    def test_stops_at_the_item_ceiling(self, tables, start_job, worker_context):
        for index in range(3):
            tables['feedback'].put_item(Item=feedback_item(f'i{index}'))
        job = start_job()
        with patch.object(jobs, 'MAX_REPROCESS_ITEMS', 2):
            result = run_job({'job_id': job['sk']}, worker_context)
        assert result['status'] == 'completed'
        assert result['stopped_at_ceiling'] is True
        view = _job(tables, job['sk'])
        assert view['status'] == 'completed'
        assert view['stopped_at_ceiling'] is True
        assert view['scanned'] == 2
        assert start_job() is not None  # lock released


@pytest.mark.usefixtures('invoke_mock')
class TestRawMode:
    @pytest.fixture
    def aws_nlp(self):
        comprehend = MagicMock()
        comprehend.detect_dominant_language.return_value = {'Languages': [{'LanguageCode': 'de'}]}
        comprehend.detect_sentiment.return_value = {
            'Sentiment': 'NEGATIVE', 'SentimentScore': {'Positive': 0.1, 'Negative': 0.8},
        }
        translate = MagicMock()
        translate.translate_text.return_value = {'TranslatedText': 'Parcel was late'}
        with patch('jobs.category_reprocess.handler._comprehend_client', return_value=comprehend), \
             patch('jobs.category_reprocess.handler._translate_client', return_value=translate):
            yield comprehend, translate

    def test_full_enrichment_updates_in_place(self, tables, start_job, worker_context, aws_nlp):
        _, translate = aws_nlp
        insights = {'category': 'shipping', 'subcategory': 'late', 'urgency': 'high',
                    'sentiment_score': -0.7, 'persona': {'name': 'Waiting buyer'}}
        tables['feedback'].put_item(Item=feedback_item('a', original_text='Paket kam spät',
                                                       problem_summary='old summary'))
        job = start_job(mode='raw')
        with patch('shared.categorization.converse', MagicMock(return_value=json.dumps(insights))):
            run_job({'job_id': job['sk']}, worker_context)

        after = _all_items(tables['feedback'])['a']
        assert after['category'] == 'shipping'
        assert after['urgency'] == 'high'
        assert after['gsi2pk'] == 'CATEGORY#shipping'
        assert after['gsi3pk'] == 'URGENCY#high'
        assert after['gsi3sk'] == '2026-01-10T00:00:00+00:00'
        assert after['normalized_text'] == 'Parcel was late'
        assert after['original_language'] == 'de'
        assert after['persona_name'] == 'Waiting buyer'
        assert 'problem_summary' not in after  # model returned none: stale value removed
        assert after['original_text'] == 'Paket kam spät'
        assert after['llm_metadata']['model_name'] == 'test-model'
        translate.translate_text.assert_called_once()
        assert _job(tables, job['sk'])['updated'] == 1

    @pytest.mark.usefixtures('aws_nlp')
    def test_model_failure_leaves_review_untouched(self, tables, start_job, worker_context):
        tables['feedback'].put_item(Item=feedback_item('a'))
        job = start_job(mode='raw')
        with patch('shared.categorization.converse', MagicMock(return_value='not json')):
            run_job({'job_id': job['sk']}, worker_context)
        _assert_untouched_and_counted_failed(tables, job['sk'])
