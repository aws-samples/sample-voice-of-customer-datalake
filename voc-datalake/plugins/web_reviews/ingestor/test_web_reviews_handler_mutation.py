"""What the mutation run of the web_reviews ``handler`` found that the end-to-end suite could not see.

``test_web_reviews_handler.py`` drives whole runs with one or two small targets, so every bound
(the 5,000-review run cap, 20 kept errors of 200 characters, the 120 s page budget, the 30 s
reserve, the 900 s default timeout, the one-day watermark slack) could move by one unseen; the
deadline arithmetic in ``run_for_event`` (milliseconds → seconds), the arguments of the model call
and of the browser session, the watermark bookkeeping (no write when the newest review is not newer,
none at all for undated reviews, the ``_last_run`` key), every log line and metric, the
non-``completed`` run status and the Lambda's instrumentation stack were all unobserved.

The run also showed the ``newest`` loop's ``None`` seed to be equivalent to ``''`` (both falsy);
the newest date is now a ``max`` over the read reviews.
"""
from collections.abc import Generator
from contextlib import contextmanager
from datetime import UTC, datetime
from types import SimpleNamespace
from typing import Any
from unittest.mock import MagicMock, call, patch

import pytest
from cdp_client import CdpError
from extract import ExtractedReview
from page_reader import PageLoadError
from target_reader import ReadLimits, ReadReview, TargetResult
from test_web_reviews_handler import URL, WatermarkTable, ingestor, target_config

from _shared.base_ingestor import BaseIngestor, metrics
from shared.test.clock import frozen_clock
from shared.test.emf_fixtures import cold_start_metric_names
from shared.test.instrumentation_fixtures import HAND_WRITTEN_HANDLER_LAYERS, TRACER_SOURCE, handler_layers
from web_reviews.ingestor import handler

NOW = 1000.0
PREFIX = 'target_t1'


def review(text: str = 'Lost my bag.', day: str | None = '2026-10-01') -> ExtractedReview:
    return ExtractedReview(text=text, rating=None, date=day, title=None, author=None)


def result_of(*reviews: ExtractedReview, **fields: Any) -> TargetResult:
    reads = [ReadReview(review=r, page=1, page_url=URL) for r in reviews]
    return TargetResult(reviews=reads, pages_read=1, **fields)


@contextmanager
def clock(now: float = NOW) -> Generator[None, None, None]:
    with patch.object(handler.time, 'monotonic', return_value=now):
        yield


@contextmanager
def reading(result: TargetResult | Exception, configs: list[dict] | None = None,
            **kwargs: Any) -> Generator[tuple[Any, MagicMock], None, None]:
    """An ingestor whose every target read returns *result* (or raises it), and that read's mock."""
    read = MagicMock(side_effect=result) if isinstance(result, Exception) else MagicMock(return_value=result)
    with ingestor(configs or [target_config()], **kwargs) as run, patch.object(handler, 'read_target', read):
        yield run, read


def limits_of(run: Any) -> ReadLimits:
    with patch.object(handler, 'read_target', return_value=result_of()) as read:
        list(run.fetch_new_items())
    return read.call_args.args[3]


class TestTheErrorList:
    def test_at_most_twenty_errors_are_kept(self):
        with ingestor([]) as run:
            for n in range(25):
                run._report(f'e{n}')
        assert run.run_errors == [f'e{n}' for n in range(20)]

    def test_each_error_is_cut_at_200_characters(self):
        with ingestor([]) as run:
            run._report('x' * 250)
        assert run.run_errors == ['x' * 200]

    def test_a_config_without_a_name_is_reported_as_a_target(self):
        config = {k: v for k, v in target_config().items() if k != 'app_name'}
        with ingestor([config]) as run:
            assert list(run.fetch_new_items()) == []
        assert run.run_errors == ['A target: app_name is required']


class TestTheRunStatus:
    @pytest.mark.parametrize('updates', [{'status': 'running'}, {'status': 'completed'}])
    def test_errors_ride_only_on_a_completed_run_that_has_some(self, updates):
        with ingestor([]) as run, patch.object(BaseIngestor, '_update_source_run_status') as base:
            if updates['status'] == 'running':
                run.run_errors.append('boom')
            run._update_source_run_status(updates)
        base.assert_called_once_with(updates)


class TestTheClock:
    def test_the_default_deadline_is_900_seconds_away(self):
        with clock(), ingestor([]) as run:
            assert run._deadline == 1900.0

    def test_the_remaining_time_keeps_30_seconds_back(self):
        with clock(), ingestor([]) as run:
            run._deadline = 1500.0
            assert run._remaining() == 470.0

    @pytest.mark.parametrize(('deadline', 'has_time'), [(1150.0, True), (1149.0, False)])
    def test_a_page_needs_120_seconds(self, deadline, has_time):
        with clock(), ingestor([]) as run:
            run._deadline = deadline
            assert run._has_time() is has_time

    def test_the_session_lasts_the_remaining_time_plus_the_reserve(self):
        with clock(), ingestor([target_config()]) as run, patch.object(handler, 'session_seconds', return_value=77) as seconds, \
                patch.object(handler, 'browser_session') as session:
            run._deadline = 1500.0
            list(run.fetch_new_items())
        seconds.assert_called_once_with(500.0)
        session.assert_called_once_with(77)

    def test_a_target_without_time_left_is_skipped_and_reported(self):
        with clock(), reading(result_of(review())) as (run, read):
            run._deadline = 1100.0
            assert list(run.fetch_new_items()) == []
        assert run.run_errors == ['Trustpilot: skipped, the run ran out of time']
        read.assert_not_called()


class TestTheReviewCap:
    def test_a_fresh_run_may_read_5000_reviews(self):
        with ingestor([target_config()]) as run:
            assert limits_of(run).max_reviews == 5000

    def test_a_target_may_read_what_the_run_has_left(self):
        with ingestor([target_config()]) as run:
            run._sent = 3
            assert limits_of(run).max_reviews == 4997

    @pytest.mark.parametrize(('sent', 'cap'), [(0, 200), (4801, 199)])
    def test_a_target_reads_its_own_limit_or_what_the_run_has_left(self, sent, cap):
        with ingestor([target_config(max_reviews='200')]) as run:
            run._sent = sent
            assert limits_of(run).max_reviews == cap

    @pytest.mark.parametrize(('pages', 'limit'), [('0', 100), ('7', 7)])
    def test_a_target_reads_its_pages_or_every_page_up_to_the_cap(self, pages, limit):
        with ingestor([target_config(max_pages=pages)]) as run:
            assert limits_of(run).max_pages == limit

    def test_every_target_after_the_cap_is_reported(self):
        second = target_config(id='t2', app_name='TripAdvisor', url='https://www.tripadvisor.com/x')
        with reading(result_of(review()), [target_config(), second]) as (run, _read):
            run._sent = 5000
            assert list(run.fetch_new_items()) == []
        assert run.run_errors == ['Trustpilot: skipped, the run reached 5000 reviews',
                                  'TripAdvisor: skipped, the run reached 5000 reviews']

    def test_one_below_the_cap_still_reads(self):
        with reading(result_of(review())) as (run, _read):
            run._sent = 4999
            assert len(list(run.fetch_new_items())) == 1
        assert (run._sent, run.run_errors) == (5000, [])

    def test_every_sent_review_counts(self):
        with reading(result_of(review('a'), review('b'), review('c'))) as (run, _read):
            run._sent = 2
            list(run.fetch_new_items())
        assert run._sent == 5


class TestTheWatermarkCutoff:
    @pytest.mark.parametrize(('day', 'new'), [('2026-10-01', True), ('2026-09-30', False), (None, True)])
    def test_a_review_one_day_before_the_watermark_is_still_new(self, day, new):
        table = WatermarkTable({f'test_source#{PREFIX}_newest_review': '2026-10-02'})
        with ingestor([target_config()], table=table) as run:
            assert limits_of(run).is_new(review(day=day)) is new

    def test_without_a_watermark_every_review_is_new(self):
        with ingestor([target_config()]) as run:
            assert limits_of(run).is_new(review(day='1999-01-01')) is True


class TestTheWatermarkWrites:
    @contextmanager
    def written(self, result: TargetResult, stored: str | None) -> Generator[MagicMock, None, None]:
        table = WatermarkTable({f'test_source#{PREFIX}_newest_review': stored} if stored else {})
        with reading(result, table=table) as (run, _read), patch.object(run, 'set_watermark') as write, \
                frozen_clock(handler) as clock_now:
            clock_now.now.return_value = datetime(2026, 10, 15, 12, 0, tzinfo=UTC)
            list(run.fetch_new_items())
        yield write

    def last_run(self) -> Any:
        return call(f'{PREFIX}_last_run', '2026-10-15T12:00:00+00:00')

    @pytest.mark.parametrize('stored', ['2026-10-05', '2026-10-03'])
    def test_an_older_or_equal_newest_review_leaves_the_watermark(self, stored):
        with self.written(result_of(review(day='2026-10-03'), review(day='2026-10-01')), stored) as write:
            assert write.call_args_list == [self.last_run()]

    def test_undated_reviews_write_no_watermark(self):
        with self.written(result_of(review(day=None)), None) as write:
            assert write.call_args_list == [self.last_run()]

    def test_the_newest_of_the_reviews_becomes_the_watermark(self):
        result = result_of(review('a', '2026-10-02'), review('b', '2026-10-04'), review('c', None), review('d', '2026-10-03'))
        with self.written(result, '2026-10-01') as write:
            assert write.call_args_list == [call(f'{PREFIX}_newest_review', '2026-10-04'), self.last_run()]


class TestEveryOutcomeIsLoggedAndCounted:
    def test_a_read_target_is_counted_and_logged(self):
        with reading(result_of(review('a'), review('b'))) as (run, _read), patch.object(handler, 'metrics') as metric, \
                patch.object(handler, 'logger') as log:
            list(run.fetch_new_items())
        metric.add_metric.assert_called_once_with(name='WebReviewsRead', unit='Count', value=2)
        log.info.assert_called_once_with('web_reviews www.trustpilot.com: 2 reviews from 1 pages (stop: no_next)')

    def test_a_blocked_target_is_counted_once(self):
        with reading(result_of(blocked='DataDome')) as (run, _read), patch.object(handler, 'metrics') as metric:
            list(run.fetch_new_items())
        assert metric.add_metric.call_args_list == [
            call(name='WebReviewsBlocked', unit='Count', value=1),
            call(name='WebReviewsRead', unit='Count', value=0),
        ]

    def test_no_due_target_is_logged(self):
        with ingestor([]) as run, patch.object(handler, 'logger') as log:
            assert list(run.fetch_new_items()) == []
        log.info.assert_called_once_with('web_reviews: no target is due')

    def test_an_unexpected_failure_is_logged_with_its_host(self):
        with reading(KeyError('x')) as (run, _read), patch.object(handler, 'logger') as log:
            list(run.fetch_new_items())
        log.exception.assert_called_once_with('web_reviews target www.trustpilot.com failed')

    @pytest.mark.parametrize('error', [PageLoadError('page timed out'), CdpError('page timed out')])
    def test_a_page_failure_names_the_target(self, error):
        with reading(error) as (run, _read):
            list(run.fetch_new_items())
        assert run.run_errors == ['Trustpilot: page timed out']

    @pytest.mark.parametrize('error', [PageLoadError('socket closed'), CdpError('socket closed')])
    def test_a_session_failure_is_reported(self, error):
        session = MagicMock()
        session.__enter__.side_effect = error
        with ingestor([target_config()], session=session) as run:
            assert list(run.fetch_new_items()) == []
        assert run.run_errors == ['The browser session failed: socket closed']


class TestTheModel:
    def test_the_completion_is_one_uncontinued_call_on_the_enrichment_surface(self):
        with patch.object(handler, 'converse', return_value='[]') as converse:
            assert handler._model_completion('prompt', 'system') == '[]'
        converse.assert_called_once_with(
            prompt='prompt', system_prompt='system', max_tokens=handler.LLM_MAX_TOKENS, temperature=None,
            surface=handler.LLM_SURFACE, step_name='web_reviews', max_continuations=0,
        )

    def test_extraction_uses_the_ingestors_completion(self):
        snapshot = SimpleNamespace(jsonld=('{}',), text='page text')
        with ingestor([]) as run, patch.object(handler, 'extract_reviews', return_value=[]) as extract:
            assert run._extract(snapshot) == []
        jsonld, text, complete = extract.call_args.args
        assert (jsonld, text, complete('prompt', 'system')) == (('{}',), 'page text', '')


class TestRunForEvent:
    def deadline(self, event: object, context: Any = None) -> Any:
        with clock(), ingestor([target_config()]), \
                patch.object(handler.WebReviewsIngestor, 'run', lambda self: (self._deadline, self.only_target)):
            return handler.WebReviewsIngestor.run_for_event(event, context)

    def test_the_deadline_is_the_lambdas_remaining_time(self):
        context = SimpleNamespace(get_remaining_time_in_millis=lambda: 60_500)
        assert self.deadline({}, context) == (1060.5, None)

    def test_without_a_context_the_default_deadline_applies(self):
        assert self.deadline({}) == (1900.0, None)

    def test_an_event_that_is_not_an_object_is_a_scheduled_run(self):
        assert self.deadline(None) == (1900.0, None)


class TestTheLambdaInstrumentation:
    def test_the_handler_wears_the_shared_instrumentation_stack_in_order(self):
        assert handler_layers(handler.lambda_handler) == HAND_WRITTEN_HANDLER_LAYERS

    def test_the_cold_start_metric_is_flushed(self, capsys):
        context = SimpleNamespace(
            function_name='voc-web-reviews', memory_limit_in_mb=512, aws_request_id='req-1',
            invoked_function_arn='arn:aws:lambda:us-east-1:123456789012:function:voc-web-reviews',
            get_remaining_time_in_millis=lambda: 600_000)
        with patch.object(handler.WebReviewsIngestor, 'run_for_event', return_value={}):
            names = cold_start_metric_names(metrics, lambda: handler.lambda_handler({}, context), capsys)
        assert names == {'ColdStart'}

    def test_fetch_new_items_is_traced(self):
        method = vars(handler.WebReviewsIngestor)['fetch_new_items']
        assert method.__code__.co_filename.endswith(TRACER_SOURCE)
        assert vars(method)['__wrapped__'].__qualname__ == 'WebReviewsIngestor.fetch_new_items'
