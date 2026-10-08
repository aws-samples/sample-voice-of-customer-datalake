"""The processor enriches the records of one SQS batch concurrently.

QA (prod 2.13.00, s1): about 40 s of the ~50 s from a Manual Import to the item
being visible was the event source's 30 s batching window plus ~2.5 s of SERIAL
enrichment per record. These tests pin the second half:

* a local benchmark with fake AWS/Bedrock latency, the shipped handler against a
  serial BatchProcessor running the very same record handler;
* the concurrency is bounded (never more than ENRICHMENT_CONCURRENCY at once);
* partial-batch semantics are unchanged: each failing record, and only it, is a
  batchItemFailure, reported in the batch's order;
* idempotency still holds across threads (real Powertools idempotency over a
  moto table): a key repeated within a batch, or a redelivered batch, is not
  enriched again.
"""
import sys
import threading
import time
from collections.abc import Iterator
from contextlib import contextmanager
from unittest.mock import MagicMock, patch

import boto3
import pytest
from aws_lambda_powertools.utilities.batch import BatchProcessor, EventType
from moto import mock_aws

from processor import handler
from processor.test.sqs_fixtures import sqs_record
from shared.batch import batch_lambda_handler
from shared.converse import BedrockThrottlingError
from shared.idempotency import ThreadSafeDynamoDBPersistenceLayer, get_idempotency_config

# Fake latencies, scaled down ~10x from production (Comprehend detect ≈ sentiment
# ≈ 0.1 s, Translate skipped for English, the model ≈ 2.2 s).
FAKE_COMPREHEND_S = 0.01
FAKE_BEDROCK_S = 0.2
BATCH = 10
# A serial handler can never gather the parties; one short wait proves it (the broken barrier
# then fails every later wait at once). A concurrent one only needs time to start its threads.
SERIAL_RENDEZVOUS_TIMEOUT_S = 0.5
CONCURRENT_RENDEZVOUS_TIMEOUT_S = 30.0


def _body(n: int, **extra: object) -> dict:
    return {
        'id': f'src-{n}', 'source_platform': 'manual_import', 'source_channel': 'e2e',
        'text': f'review number {n}', 'created_at': '2026-10-05T00:00:00Z', **extra,
    }


def _event(bodies: list[dict]) -> dict:
    return {'Records': [sqs_record(f'm{i}', body) for i, body in enumerate(bodies)]}


def _context() -> MagicMock:
    return MagicMock(
        function_name='voc-processor', memory_limit_in_mb=1024, aws_request_id='req-1',
        invoked_function_arn='arn:aws:lambda:us-east-1:123456789012:function:voc-processor',
    )


class _Gauge:
    """Counts the model calls in flight and remembers the peak."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self.current = 0
        self.peak = 0
        self.calls: list[str] = []

    def __enter__(self) -> None:
        with self._lock:
            self.current += 1
            self.peak = max(self.peak, self.current)

    def __exit__(self, *_exc: object) -> None:
        with self._lock:
            self.current -= 1


class _Rendezvous:
    """Makes every model call wait until ENRICHMENT_CONCURRENCY calls are in flight together.

    No wall-clock comparison: a handler that enriches records one at a time can never gather
    the parties, so each of its calls is recorded as `alone` (after one short timeout the
    barrier is broken and every later wait fails at once). A concurrent handler gathers them
    in waves of ENRICHMENT_CONCURRENCY, so `alone` stays empty however loaded the machine is:
    the generous timeout only has to cover starting the pool's threads.
    """

    def __init__(self, parties: int, timeout_s: float) -> None:
        self._barrier = threading.Barrier(parties, timeout=timeout_s)
        self._lock = threading.Lock()
        self.alone: list[str] = []

    def meet(self, record_id: str) -> None:
        try:
            self._barrier.wait()
        except threading.BrokenBarrierError:
            with self._lock:
                self.alone.append(record_id)


@contextmanager
def _fake_enrichment(gauge: _Gauge, throttle_ids: frozenset[str] = frozenset(),
                     rendezvous: _Rendezvous | None = None) -> Iterator[MagicMock]:
    """Every AWS stage stubbed with a sleep; the model call is gauged. Yields the write mock."""
    def sentiment(_text: str, _lang: str) -> dict:
        time.sleep(FAKE_COMPREHEND_S)
        return {'label': 'neutral', 'score': 0.0}

    def detect(_text: str) -> str:
        time.sleep(FAKE_COMPREHEND_S)
        return 'en'

    def llm(raw_record: dict, raise_on_throttle: bool = True) -> dict:
        del raise_on_throttle
        with gauge:
            gauge.calls.append(raw_record['id'])
            if rendezvous is not None:
                rendezvous.meet(raw_record['id'])
            time.sleep(FAKE_BEDROCK_S)
            if raw_record['id'] in throttle_ids:
                raise BedrockThrottlingError('throttled')
        return {'insights': {'category': 'other', 'urgency': 'low'}, 'metadata': {}}

    with patch('processor.handler.check_duplicate', return_value=False), \
         patch('processor.handler.detect_language', side_effect=detect), \
         patch('processor.handler.translate_text', side_effect=lambda text, *_: text), \
         patch('processor.handler.get_comprehend_sentiment', side_effect=sentiment), \
         patch('processor.handler.invoke_bedrock_llm', side_effect=llm), \
         patch('processor.handler.log_processing_error'), \
         patch('processor.handler.write_to_dynamodb') as write:
        yield write


def _timed(fn, event: dict) -> tuple[float, dict]:
    started = time.perf_counter()
    response = fn(event, _context())
    return time.perf_counter() - started, response


@pytest.fixture
def no_idempotency():
    with patch('processor.handler.persistence_layer', None), \
         patch('processor.handler.idempotency_config', None):
        yield


@pytest.mark.usefixtures('no_idempotency')
class TestBatchEnrichmentBenchmark:
    def test_the_shipped_handler_enriches_records_together_and_serial_does_not(self, capsys):
        """Before (serial BatchProcessor) vs after (the shipped handler), same records and fakes.

        Deterministic: the verdict comes from a rendezvous of ENRICHMENT_CONCURRENCY model
        calls, not from comparing wall-clock times (which failed under a loaded run). The
        timings are still printed for the reader."""
        event = _event([_body(n) for n in range(BATCH)])
        serial_handler = batch_lambda_handler(handler.record_handler, BatchProcessor(event_type=EventType.SQS))
        parties = handler.ENRICHMENT_CONCURRENCY

        serial_meeting = _Rendezvous(parties, timeout_s=SERIAL_RENDEZVOUS_TIMEOUT_S)
        with _fake_enrichment(_Gauge(), rendezvous=serial_meeting):
            before, before_response = _timed(serial_handler, event)
        concurrent_meeting = _Rendezvous(parties, timeout_s=CONCURRENT_RENDEZVOUS_TIMEOUT_S)
        with _fake_enrichment(_Gauge(), rendezvous=concurrent_meeting) as write:
            after, after_response = _timed(handler.lambda_handler, event)

        with capsys.disabled():
            sys.stdout.write(f'\n[processor benchmark] {BATCH} records, fake model {FAKE_BEDROCK_S}s: '
                             f'serial {before:.2f}s → concurrent {after:.2f}s (informational)\n')
        assert before_response == after_response == {'batchItemFailures': []}
        assert write.call_count == BATCH
        # Serial: no model call ever had company. Concurrent: every call met a full wave.
        assert sorted(serial_meeting.alone) == sorted(f'src-{n}' for n in range(BATCH))
        assert concurrent_meeting.alone == []

    def test_no_more_than_the_configured_number_of_records_run_at_once(self):
        gauge = _Gauge()
        # The rendezvous holds each wave until all its calls are in flight, so the peak
        # reaches the pool size on any machine instead of depending on thread start-up speed.
        meeting = _Rendezvous(handler.ENRICHMENT_CONCURRENCY, timeout_s=CONCURRENT_RENDEZVOUS_TIMEOUT_S)
        with _fake_enrichment(gauge, rendezvous=meeting):
            handler.lambda_handler(_event([_body(n) for n in range(BATCH)]), _context())

        assert handler.ENRICHMENT_CONCURRENCY == 5
        assert meeting.alone == []
        assert gauge.peak == handler.ENRICHMENT_CONCURRENCY
        assert sorted(gauge.calls) == sorted(f'src-{n}' for n in range(BATCH))


@pytest.mark.usefixtures('no_idempotency')
class TestPartialBatchSemanticsUnderConcurrency:
    def test_only_the_throttled_records_fail_and_in_batch_order(self):
        # Workers finish in any order; the report must still read in batch order.
        with _fake_enrichment(_Gauge(), throttle_ids=frozenset({'src-7', 'src-2'})) as write:
            response = handler.lambda_handler(_event([_body(n) for n in range(BATCH)]), _context())

        assert response == {'batchItemFailures': [{'itemIdentifier': 'm2'}, {'itemIdentifier': 'm7'}]}
        written = sorted(call.args[0]['source_id'] for call in write.call_args_list)
        assert written == sorted(f'src-{n}' for n in range(BATCH) if n not in (2, 7))

    def test_every_processed_record_is_counted_once(self):
        """Powertools' add_metric is a read-modify-write of one dict entry; two threads
        adding at once lose a count. The fake widens that window so the race is certain."""
        counts: dict[str, int] = {}

        def racy_add_metric(name: str, unit: str, value: float) -> None:
            del unit
            seen = counts.get(name, 0)
            time.sleep(0.02)
            counts[name] = seen + int(value)

        with _fake_enrichment(_Gauge()), patch('processor.handler.metrics') as metrics:
            metrics.add_metric.side_effect = racy_add_metric
            handler.lambda_handler(_event([_body(n) for n in range(BATCH)]), _context())

        assert counts['FeedbackProcessed'] == BATCH


@pytest.fixture
def idempotency_store():
    """The processor's real idempotency path over a moto table."""
    with mock_aws():
        boto3.client('dynamodb').create_table(
            TableName='idem', BillingMode='PAY_PER_REQUEST',
            KeySchema=[{'AttributeName': 'id', 'KeyType': 'HASH'}],
            AttributeDefinitions=[{'AttributeName': 'id', 'AttributeType': 'S'}],
        )
        layer = ThreadSafeDynamoDBPersistenceLayer(table_name='idem')
        config = get_idempotency_config(expires_after_seconds=3600, use_local_cache=True, local_cache_max_items=256)
        with patch('processor.handler.persistence_layer', layer), \
             patch('processor.handler.idempotency_config', config):
            yield


@pytest.mark.usefixtures('idempotency_store')
class TestIdempotencyUnderConcurrency:
    def test_a_key_repeated_in_one_batch_is_enriched_once_and_nothing_fails(self):
        bodies = [_body(n) for n in range(6)] + [_body(0), _body(1)]
        gauge = _Gauge()
        with _fake_enrichment(gauge):
            response = handler.lambda_handler(_event(bodies), _context())

        assert response == {'batchItemFailures': []}
        assert sorted(gauge.calls) == sorted(f'src-{n}' for n in range(6))

    def test_a_redelivered_batch_is_not_enriched_again(self):
        event = _event([_body(n) for n in range(BATCH)])
        first, second = _Gauge(), _Gauge()
        with _fake_enrichment(first):
            handler.lambda_handler(event, _context())
        with _fake_enrichment(second):
            response = handler.lambda_handler(event, _context())

        assert len(first.calls) == BATCH
        assert second.calls == []
        assert response == {'batchItemFailures': []}


class _BlockingConfig:
    """An IdempotencyConfig stand-in whose first attribute read stalls configure() mid-way."""

    def __init__(self, started: threading.Event) -> None:
        self._started = started
        self._real = get_idempotency_config()

    def __getattr__(self, name: str) -> object:
        if name == 'event_key_jmespath':
            self._started.wait(2)
            time.sleep(0.2)
        return getattr(self._real, name)


class TestThreadSafePersistenceLayer:
    def test_a_second_thread_never_sees_a_half_configured_layer(self):
        """Powertools sets `configured = True` before building the cache; without the
        lock a concurrent configure() returns at once and the layer has no `_cache`."""
        with mock_aws():
            layer = ThreadSafeDynamoDBPersistenceLayer(table_name='idem')
            b_started = threading.Event()
            config = _BlockingConfig(b_started)
            first = threading.Thread(target=layer.configure, args=(config, 'fn'))
            first.start()
            time.sleep(0.05)  # thread one is now inside configure(), past `configured = True`
            b_started.set()
            layer.configure(get_idempotency_config(), 'fn')
            has_cache = hasattr(layer, '_cache')
            first.join(5)

        assert has_cache
