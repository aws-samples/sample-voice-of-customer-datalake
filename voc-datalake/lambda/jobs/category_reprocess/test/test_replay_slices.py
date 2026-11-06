"""Replay slices, resume, lineage and the raw-mode fixes of the reprocess worker (TENETS.md D1-D4).

Against moto, so the Scan filters and the conditional updates really run.
"""
import json
from datetime import UTC, datetime
from typing import ClassVar
from unittest.mock import MagicMock, patch

import pytest

from jobs.category_reprocess import handler
from jobs.category_reprocess.test.test_handler import feedback_item
from shared import reprocess_jobs as jobs
from shared.converse import BedrockThrottlingError
from shared.reprocess_slices import ReprocessSlice


def _items(table) -> dict:
    return {item['feedback_id']: item for item in table.scan()['Items']}


def _start(tables, job_slice: ReprocessSlice | None = None, mode: str = 'processed', **kwargs) -> dict:
    job = jobs.start_job(
        tables['aggregates'], mode=mode, days=0, include_manual=False, started_by='alice',
        now=datetime.now(UTC), job_slice=job_slice, started_by_sub='sub-alice', **kwargs,
    )
    assert job is not None
    return job


def _view(tables, job_id: str) -> dict:
    return jobs.job_view(jobs.get_job(tables['aggregates'], job_id) or {})


@pytest.mark.usefixtures('converse_mock', 'invoke_mock')
class TestSlices:
    def test_a_sourced_job_reprocesses_only_its_sources(self, tables, worker_context):
        tables['feedback'].put_item(Item=feedback_item('a'))
        tables['feedback'].put_item(Item=feedback_item('b', pk='SOURCE#app', source_platform='app'))
        tables['feedback'].put_item(Item=feedback_item('c', pk='SOURCE#forms', source_platform='forms'))
        job = _start(tables, ReprocessSlice(sources=('web', 'forms')))
        assert handler.run_job({'job_id': job['sk']}, worker_context)['status'] == 'completed'
        after = _items(tables['feedback'])
        assert after['a']['category'] == 'shipping'
        assert after['c']['category'] == 'shipping'
        assert after['b']['category'] == 'billing'
        assert _view(tables, job['sk'])['scanned'] == 2

    def test_a_branded_review_of_a_sliced_source_is_reprocessed(self, tables, worker_context):
        """The processor stores a review with a brand name under SOURCE#{brand_name}: the slice still finds it."""
        tables['feedback'].put_item(Item=feedback_item('d', pk='SOURCE#Example Air', source_platform='web'))
        tables['feedback'].put_item(Item=feedback_item('e', pk='SOURCE#Example Air', source_platform='app'))
        job = _start(tables, ReprocessSlice(sources=('web',)))
        assert handler.run_job({'job_id': job['sk']}, worker_context)['status'] == 'completed'
        after = _items(tables['feedback'])
        assert after['d']['category'] == 'shipping'
        assert after['e']['category'] == 'billing'
        assert _view(tables, job['sk'])['scanned'] == 1

    def test_a_category_slice_leaves_other_categories_uncounted(self, tables, worker_context):
        tables['feedback'].put_item(Item=feedback_item('a'))
        tables['feedback'].put_item(Item=feedback_item('b', category='delivery'))
        job = _start(tables, ReprocessSlice(categories=('billing',)))
        handler.run_job({'job_id': job['sk']}, worker_context)
        after = _items(tables['feedback'])
        assert after['a']['category'] == 'shipping'
        assert after['b']['category'] == 'delivery'
        assert _view(tables, job['sk'])['scanned'] == 1

    def test_a_processed_date_range_is_inclusive(self, tables, worker_context):
        for feedback_id, day in (('early', '2026-01-31'), ('first', '2026-02-01'), ('last', '2026-02-28'),
                                 ('late', '2026-03-01')):
            tables['feedback'].put_item(Item=feedback_item(feedback_id, date=day))
        job = _start(tables, ReprocessSlice(days=None, date_from='2026-02-01', date_to='2026-02-28'))
        handler.run_job({'job_id': job['sk']}, worker_context)
        moved = {fid for fid, item in _items(tables['feedback']).items() if item['category'] == 'shipping'}
        assert moved == {'first', 'last'}

    def test_a_days_window_counts_back_from_when_the_job_started(self, tables, worker_context):
        """A hand-over runs later than the first invocation; the window must not move with it."""
        for feedback_id, day in (('in', '2026-02-02'), ('out', '2026-01-31')):
            tables['feedback'].put_item(Item=feedback_item(feedback_id, date=day))
        job = jobs.start_job(tables['aggregates'], mode='processed', days=3, include_manual=False, started_by='alice',
                             now=datetime(2026, 2, 3, 9, tzinfo=UTC), job_slice=ReprocessSlice(days=3),
                             started_by_sub='sub-alice')
        assert job is not None
        handler.run_job({'job_id': job['sk']}, worker_context)  # run "now", long after 2026-02-03
        moved = {fid for fid, item in _items(tables['feedback']).items() if item['category'] == 'shipping'}
        assert moved == {'in'}

    def test_a_review_date_range_reads_when_the_customer_wrote_it(self, tables, worker_context):
        tables['feedback'].put_item(Item=feedback_item('feb', date='2026-04-02', source_created_at='2026-02-10T08:00:00Z'))
        tables['feedback'].put_item(Item=feedback_item('apr', date='2026-02-10', source_created_at='2026-04-01T08:00:00Z'))
        tables['feedback'].put_item(Item=feedback_item('undated', date='2026-02-11'))
        job = _start(tables, ReprocessSlice(days=None, date_from='2026-02-01', date_to='2026-02-28',
                                            date_basis='review'))
        handler.run_job({'job_id': job['sk']}, worker_context)
        moved = {fid for fid, item in _items(tables['feedback']).items() if item['category'] == 'shipping'}
        # 'undated' has no source date and falls back to its processing date, like every review-basis read.
        assert moved == {'feb', 'undated'}


@pytest.mark.usefixtures('converse_mock', 'invoke_mock')
class TestPartialAndResume:
    def test_the_ceiling_ends_partial_and_a_resume_continues_after_the_last_review(self, tables, worker_context):
        for index in range(5):
            tables['feedback'].put_item(Item=feedback_item(f'i{index}'))
        first = _start(tables, ReprocessSlice(categories=('billing',)))
        with patch.object(jobs, 'MAX_REPROCESS_ITEMS', 2):
            assert handler.run_job({'job_id': first['sk']}, worker_context)['status'] == jobs.STATUS_PARTIAL
        assert _view(tables, first['sk'])['resumable'] is True
        resume = jobs.resume_point(jobs.get_job(tables['aggregates'], first['sk']))
        assert resume is not None
        stored = jobs.get_job(tables['aggregates'], first['sk']) or {}
        second = _start(tables, handler.slice_from_job(stored), resume=resume)
        assert second['categories'] == ['billing']
        assert handler.run_job({'job_id': second['sk']}, worker_context)['status'] == 'completed'
        assert all(item['category'] == 'shipping' for item in _items(tables['feedback']).values())
        assert _view(tables, second['sk'])['scanned'] == 3  # never restarted from the top
        assert _view(tables, second['sk'])['resumed_from'] == first['sk']
        assert _view(tables, first['sk'])['resumable'] is False

    def _partial(self, tables, worker_context):
        tables['feedback'].put_item(Item=feedback_item('a'))
        tables['feedback'].put_item(Item=feedback_item('b'))
        first = _start(tables)
        with patch.object(jobs, 'MAX_REPROCESS_ITEMS', 1):
            handler.run_job({'job_id': first['sk']}, worker_context)
        resume = jobs.resume_point(jobs.get_job(tables['aggregates'], first['sk']))
        assert resume is not None
        return first, resume

    def test_a_partial_job_is_resumed_once_at_a_time(self, tables, worker_context):
        first, resume = self._partial(tables, worker_context)
        second = _start(tables, resume=resume)
        jobs.release_lock(tables['aggregates'], second['sk'])  # a live resumer would hold it; the lock is not under test
        with pytest.raises(jobs.ResumeRefused):
            _start(tables, resume=resume)
        assert jobs.resume_point(jobs.get_job(tables['aggregates'], first['sk'])) is None

    def test_a_resume_whose_job_row_failed_hands_the_partial_job_back(self, tables, worker_context):
        """The partial job is marked before the new row is written; a failed put must not strand it."""
        first, resume = self._partial(tables, worker_context)
        real_put = tables['aggregates'].put_item

        def failing_job_row(**kwargs):
            if str(kwargs.get('Item', {}).get('sk', '')).startswith('rp_'):
                raise RuntimeError('put failed')
            return real_put(**kwargs)

        with patch.object(tables['aggregates'], 'put_item', side_effect=failing_job_row), \
             pytest.raises(RuntimeError, match='put failed'):
            _start(tables, resume=resume)
        assert jobs.resume_point(jobs.get_job(tables['aggregates'], first['sk'])) == resume

    @pytest.mark.parametrize('ending', ['cancel', 'fail'])
    def test_a_resumer_that_did_not_finish_hands_the_partial_job_back(self, tables, worker_context, ending):
        """A failed or cancelled resume (an invoke that never started included) never loses the cursor."""
        first, resume = self._partial(tables, worker_context)
        second = _start(tables, resume=resume)
        if ending == 'cancel':
            jobs.cancel_job(tables['aggregates'], second['sk'])
        else:
            jobs.finish_job(tables['aggregates'], second['sk'], jobs.STATUS_FAILED, error='invoke failed')
        again = jobs.resume_point(jobs.get_job(tables['aggregates'], first['sk']))
        assert again == resume
        third = _start(tables, resume=again)
        assert (jobs.get_job(tables['aggregates'], first['sk']) or {}).get('resumed_by') == third['sk']

    def test_a_completed_resumer_keeps_the_partial_job_closed(self, tables, worker_context):
        first, resume = self._partial(tables, worker_context)
        second = _start(tables, resume=resume)
        assert handler.run_job({'job_id': second['sk']}, worker_context)['status'] == 'completed'
        assert jobs.resume_point(jobs.get_job(tables['aggregates'], first['sk'])) is None

    @pytest.mark.parametrize('job', [
        None, {'status': 'completed', 'resume_from': {'pk': 'a'}}, {'status': 'partial'},
        {'status': 'partial', 'resume_from': {'pk': 'a'}, 'resumed_by': 'rp_x'},
    ])
    def test_only_an_unresumed_partial_job_with_a_cursor_offers_a_resume(self, job):
        assert jobs.resume_point(job) is None


@pytest.mark.usefixtures('converse_mock', 'invoke_mock')
class TestLineage:
    def test_the_previous_version_is_kept_and_the_update_says_who_how_and_why(
        self, tables, worker_context, kept_versions,
    ):
        tables['feedback'].put_item(Item=feedback_item('a'))
        job = _start(tables)
        handler.run_job({'job_id': job['sk']}, worker_context)
        [kept] = kept_versions.call_args_list
        assert kept.args[0]['category'] == 'billing'  # the review AS IT WAS
        assert kept.kwargs['actor'] == {'sub': 'sub-alice', 'kind': 'admin'}
        assert kept.kwargs['reason'] == 'reprocess'
        assert 'category' in kept.kwargs['changed_fields']
        after = _items(tables['feedback'])['a']
        assert after['enrichment_mode'] == 'reprocess_processed'
        assert 'pipeline_version' in after
        assert after['llm_metadata']['model_name'] == 'test-model'  # S6: the re-classification's model
        assert after['updated_by'] == {'sub': 'sub-alice', 'kind': 'admin'}
        assert after['change_reason'] == 'reprocess'

    def test_an_unchanged_review_keeps_no_version(self, tables, worker_context, kept_versions):
        tables['feedback'].put_item(Item=feedback_item('a', category='shipping', subcategory='late', usefulness='low'))
        handler.run_job({'job_id': _start(tables)['sk']}, worker_context)
        kept_versions.assert_not_called()

    def test_a_review_a_manual_edit_won_meanwhile_keeps_no_version(self, tables, worker_context, kept_versions):
        """The conditional update loses to a hand correction made during the job: no version of a change that
        never happened (TENETS.md D4)."""
        feedback = tables['feedback']
        feedback.put_item(Item=feedback_item('a'))
        real_update = feedback.update_item

        def corrected_by_hand_first(**kwargs):
            real_update(Key={'pk': 'SOURCE#web', 'sk': 'FEEDBACK#a'},
                        UpdateExpression='SET category_source = :m', ExpressionAttributeValues={':m': 'manual'})
            return real_update(**kwargs)

        job = _start(tables)
        with patch.object(feedback, 'update_item', side_effect=corrected_by_hand_first), \
             patch.object(handler, '_tables', return_value=(feedback, tables['aggregates'])):
            handler.run_job({'job_id': job['sk']}, worker_context)
        assert _items(feedback)['a']['category'] == 'billing'
        assert _view(tables, job['sk'])['skipped_manual'] == 1
        kept_versions.assert_not_called()

    def test_the_job_records_the_configuration_it_derived_with(self, tables, worker_context):
        tables['feedback'].put_item(Item=feedback_item('a'))
        tables['aggregates'].put_item(Item={'pk': 'METRIC#meta', 'sk': 'config_version', 'v': 7})
        job = _start(tables)
        handler.run_job({'job_id': job['sk']}, worker_context)
        config = _view(tables, job['sk'])['config']
        assert config['config_version'] == 7
        assert config['model_id'] == 'test-model'
        assert len(config['categories_sha16']) == 16

    def test_a_hand_over_that_sees_another_configuration_says_so(self, tables):
        job = _start(tables)
        jobs.claim_job(tables['aggregates'], job['sk'], 'tok')
        stored = jobs.get_job(tables['aggregates'], job['sk']) or {}
        assert jobs.record_config(tables['aggregates'], stored, {'model_id': 'a'}, 'tok') is not None
        stored = jobs.get_job(tables['aggregates'], job['sk']) or {}
        assert jobs.record_config(tables['aggregates'], stored, {'model_id': 'a'}, 'tok') == stored
        jobs.record_config(tables['aggregates'], stored, {'model_id': 'b'}, 'tok')
        view = _view(tables, job['sk'])
        assert view['config']['model_id'] == 'a'
        assert view['config_changed'] is True


@pytest.mark.usefixtures('invoke_mock')
class TestRawMode:
    INSIGHTS: ClassVar[dict] = {'category': 'shipping', 'subcategory': 'late', 'urgency': 'high', 'sentiment_score': -0.5,
                'direct_customer_quote': 'two weeks late', 'problem_summary': 'Late parcel'}

    @pytest.fixture(autouse=True)
    def nlp(self):
        comprehend = MagicMock()
        comprehend.detect_dominant_language.return_value = {'Languages': [{'LanguageCode': 'de'}]}
        comprehend.detect_sentiment.return_value = {'Sentiment': 'NEGATIVE', 'SentimentScore': {}}
        translate = MagicMock()
        translate.translate_text.return_value = {'TranslatedText': 'Parcel was late'}
        with patch.object(handler, '_comprehend_client', return_value=comprehend), \
                patch.object(handler, '_translate_client', return_value=translate), \
                patch('shared.categorization.converse', MagicMock(return_value=json.dumps(self.INSIGHTS))):
            yield

    def test_a_summary_only_review_gets_no_translation_or_quote_back(self, tables, worker_context):
        tables['feedback'].put_item(Item=feedback_item('a', pii_policy='summary_only', original_text='Late parcel'))
        handler.run_job({'job_id': _start(tables, mode='raw')['sk']}, worker_context)
        after = _items(tables['feedback'])['a']
        assert after['category'] == 'shipping'
        assert 'normalized_text' not in after
        assert 'direct_customer_quote' not in after
        assert after['original_text'] == 'Late parcel'
        assert after['enrichment_mode'] == 'reprocess_raw'

    def test_a_full_text_review_keeps_the_processor_fields(self, tables, worker_context):
        tables['feedback'].put_item(Item=feedback_item('a', original_text='Paket kam spät'))
        handler.run_job({'job_id': _start(tables, mode='raw')['sk']}, worker_context)
        after = _items(tables['feedback'])['a']
        assert after['normalized_text'] == 'Parcel was late'
        assert after['direct_customer_quote'] == 'two weeks late'

    def test_reviews_without_an_archived_raw_item_are_counted_with_their_sources(self, tables, worker_context):
        tables['feedback'].put_item(Item=feedback_item('a'))
        tables['feedback'].put_item(Item=feedback_item('b', pk='SOURCE#csv_upload', source_platform='csv_upload'))
        job = _start(tables, mode='raw')
        result = handler.run_job({'job_id': job['sk']}, worker_context)
        assert result['raw_fallback'] == 2
        view = _view(tables, job['sk'])
        assert view['raw_fallback'] == 2
        assert view['raw_fallback_sources'] == ['csv_upload', 'web']

    def test_an_archived_raw_item_is_not_a_fallback(self, tables, worker_context):
        tables['feedback'].put_item(Item=feedback_item('a', s3_raw_uri='s3://bucket/raw/web/a.json'))
        archived = {'text': 'Paket kam spät', 'source_platform': 'web', 'source_channel': 'reviews', 'rating': 1}
        with patch.object(handler, '_raw_record_from_s3', return_value=archived):
            result = handler.run_job({'job_id': _start(tables, mode='raw')['sk']}, worker_context)
        assert result['raw_fallback'] == 0
        assert result['raw_fallback_sources'] == []

    def test_a_throttled_fallback_review_is_counted_once(self, tables):
        """A throttle raises before the count; the review is read again on the retry and counted then, once."""
        tables['feedback'].put_item(Item=feedback_item('a'))
        counters: dict = {}
        job = {'mode': 'raw', 'started_by_sub': 'sub-alice'}
        item = tables['feedback'].get_item(Key={'pk': 'SOURCE#web', 'sk': 'FEEDBACK#a'})['Item']
        with patch.object(handler, 'raw_attributes', side_effect=BedrockThrottlingError('slow down')), \
             pytest.raises(BedrockThrottlingError):
            handler._recategorise(tables['feedback'], item, job, [], counters)
        assert counters.get('raw_fallback', 0) == 0


def test_the_withheld_fields_are_the_processors_summary_only_fields_that_enrichment_writes():
    """Lockstep with ``processor/handler.py``: every field it drops for summary-only that raw-mode
    enrichment could write is withheld here too."""
    from processor import handler as processor
    from shared.categorization import Enrichment, EnrichmentSteps, run_enrichment

    steps = EnrichmentSteps(
        detect_language=lambda _text: 'de', translate_text=lambda text, _src, _dst: text,
        sentiment=lambda _text, _lang: {'label': 'neutral', 'score': 0.0},
        llm=lambda _record: {'insights': {}, 'metadata': {}},
    )
    written: Enrichment = run_enrichment({'text': 't'}, steps, 'en', [])
    enrichment_fields = set(written.attributes)
    assert set(processor.SUMMARY_ONLY_DROPPED_FIELDS) & enrichment_fields == set(handler.SUMMARY_ONLY_WITHHELD)
