"""GET /settings/model/capacity answers from the stored quotas, not a 15-second listing.

5.35.01 live: the first load of Administration -> AI models took 14.5-15.9 s (budget
4.5 s): every cold container paged through all ~1,050 Bedrock quotas. The aggregates
table (moto) keeps the readings; a fake Service Quotas client that is SLOW per call
proves which path ran and how long it took.
"""
import threading
import time
from collections.abc import Iterator
from decimal import Decimal
from typing import Any
from unittest.mock import MagicMock

import boto3
import pytest
from botocore.exceptions import ClientError
from moto import mock_aws

from shared import model_capacity, model_quota_store
from shared.aws import is_action_event
from shared.model_config import ALLOWED_MODELS
from shared.test.model_capacity_fixtures import GLOBAL

CALL_SECONDS = 0.25


def _expected() -> list[str]:
    return [GLOBAL + m['label'] for m in ALLOWED_MODELS]


class SlowQuotas:
    """A Service Quotas client whose every call takes CALL_SECONDS (thread-safe call log)."""

    def __init__(self, *, pages: int = 6, fail_get: bool = False) -> None:
        self.pages = pages
        self.fail_get = fail_get
        self.calls: list[tuple[str, dict]] = []
        self._lock = threading.Lock()

    def _log(self, name: str, kwargs: dict) -> None:
        with self._lock:
            self.calls.append((name, kwargs))
        time.sleep(CALL_SECONDS)

    def calls_to(self, name: str) -> list[dict]:
        return [kwargs for called, kwargs in self.calls if called == name]

    def get_paginator(self, _operation: str) -> 'SlowQuotas':
        return self

    def paginate(self, **kwargs: Any) -> Iterator[dict]:
        quotas = [{'QuotaName': name, 'QuotaCode': f'L-{i:04d}', 'Value': 1000.0 + i} for i, name in enumerate(_expected())]
        quotas.append({'QuotaName': 'Some other Bedrock quota', 'QuotaCode': 'L-9999', 'Value': 5.0})
        per_page = max(1, len(quotas) // self.pages + 1)
        for start in range(0, len(quotas), per_page):
            self._log('list_service_quotas', kwargs)
            yield {'Quotas': quotas[start:start + per_page]}

    def get_service_quota(self, **kwargs: Any) -> dict:
        self._log('get_service_quota', kwargs)
        if self.fail_get:
            raise ClientError({'Error': {'Code': 'AccessDeniedException', 'Message': 'no'}}, 'GetServiceQuota')
        return {'Quota': {'QuotaCode': kwargs['QuotaCode'], 'Value': 2000.0}}


@pytest.fixture
def table(monkeypatch: pytest.MonkeyPatch) -> Iterator[Any]:
    monkeypatch.delenv('BEDROCK_INFERENCE_SCOPE', raising=False)
    # No assist worker unless a test asks for one (the `invoke` fixture sets it after this): a refresh then runs
    # inline, whatever another test left in the env.
    monkeypatch.delenv('ASSIST_WORKER_FUNCTION', raising=False)
    with mock_aws():
        resource = boto3.resource('dynamodb', region_name='us-east-1')
        created = resource.create_table(
            TableName='aggregates', BillingMode='PAY_PER_REQUEST',
            KeySchema=[{'AttributeName': 'pk', 'KeyType': 'HASH'}, {'AttributeName': 'sk', 'KeyType': 'RANGE'}],
            AttributeDefinitions=[{'AttributeName': 'pk', 'AttributeType': 'S'}, {'AttributeName': 'sk', 'AttributeType': 'S'}],
        )
        monkeypatch.setattr(model_quota_store, '_table', lambda: created)
        model_capacity.clear_quota_cache()
        yield created
        model_capacity.clear_quota_cache()


def _install(monkeypatch: pytest.MonkeyPatch, client: SlowQuotas) -> None:
    monkeypatch.setattr(model_capacity, '_clients', {'service-quotas': client})


def _store(table: Any, *, age_seconds: float, names: list[str] | None = None) -> None:
    expected = _expected()
    table.put_item(Item={
        **model_quota_store.ROW_KEY,
        'values': {name: Decimal(str(10 + i)) for i, name in enumerate(expected)},
        'codes': {name: f'L-{i:04d}' for i, name in enumerate(expected)},
        'fetched_at': Decimal(str(round(time.time() - age_seconds, 3))),
        'names': names if names is not None else expected,
    })


def _timed_overview() -> tuple[list[model_capacity.ModelCapacity], float]:
    started = time.perf_counter()
    overview = model_capacity.capacity_overview()
    return overview, time.perf_counter() - started


class TestTheStoredRow:
    def test_a_fresh_row_answers_with_no_service_call(self, table, monkeypatch):
        client = SlowQuotas()
        _install(monkeypatch, client)
        _store(table, age_seconds=60)

        overview, seconds = _timed_overview()

        assert client.calls == []
        assert seconds < CALL_SECONDS
        assert [m['quota']['tokens_per_minute'] for m in overview if m['quota']] == [10 + i for i in range(len(ALLOWED_MODELS))]

    def test_a_stale_row_is_refreshed_by_code_in_parallel_well_inside_the_budget(self, table, monkeypatch):
        client = SlowQuotas()
        _install(monkeypatch, client)
        _store(table, age_seconds=model_quota_store.FRESH_SECONDS + 1)

        overview, seconds = _timed_overview()

        assert client.calls_to('list_service_quotas') == []
        assert sorted(c['QuotaCode'] for c in client.calls_to('get_service_quota')) == [f'L-{i:04d}' for i in range(len(ALLOWED_MODELS))]
        # Sequential would be len(models) x CALL_SECONDS (2 s for 8); REFRESH_WORKERS at a time is a few rounds.
        rounds = -(-len(ALLOWED_MODELS) // model_quota_store.REFRESH_WORKERS)
        assert seconds < (rounds + 1) * CALL_SECONDS < len(ALLOWED_MODELS) * CALL_SECONDS
        assert all(m['quota'] == {'name': GLOBAL + m['label'], 'tokens_per_minute': 2000} for m in overview)
        stored = model_quota_store.load()
        assert stored is not None
        assert stored.is_fresh(time.time())

    def test_a_failing_refresh_falls_back_to_the_listing(self, table, monkeypatch):
        client = SlowQuotas(fail_get=True)
        _install(monkeypatch, client)
        _store(table, age_seconds=model_quota_store.FRESH_SECONDS + 1)

        overview, _seconds = _timed_overview()

        assert client.calls_to('list_service_quotas')
        assert overview[0]['quota'] == {'name': GLOBAL + ALLOWED_MODELS[0]['label'], 'tokens_per_minute': 1000}

    def test_a_model_added_to_the_allowlist_since_the_reading_re_lists(self, table, monkeypatch):
        client = SlowQuotas()
        _install(monkeypatch, client)
        _store(table, age_seconds=60, names=_expected()[:-1])

        model_capacity.capacity_overview()

        assert client.calls_to('list_service_quotas')


@pytest.mark.usefixtures('table')
class TestTheFirstListingWithTheTable:
    def test_lists_100_per_page_once_then_a_cold_container_reads_the_row(self, monkeypatch):
        client = SlowQuotas()
        _install(monkeypatch, client)

        first = model_capacity.capacity_overview()
        listed = len(client.calls_to('list_service_quotas'))
        model_capacity.clear_quota_cache()  # a cold container
        second, seconds = _timed_overview()

        assert listed > 0
        assert all(c == {'ServiceCode': 'bedrock', 'PaginationConfig': {'PageSize': 100}} for c in client.calls_to('list_service_quotas'))
        assert len(client.calls) == listed, 'the cold container called Service Quotas again'
        assert seconds < CALL_SECONDS
        assert first == second
        stored = model_quota_store.load()
        assert stored is not None
        assert 'Some other Bedrock quota' not in stored.values
        assert stored.codes[GLOBAL + ALLOWED_MODELS[0]['label']] == 'L-0000'


class TestTheFirstListingWithoutTheTable:
    def test_without_a_table_the_listing_still_answers(self, table, monkeypatch):
        monkeypatch.setattr(model_quota_store, '_table', lambda: None)
        client = SlowQuotas()
        _install(monkeypatch, client)

        overview = model_capacity.capacity_overview()

        assert overview[0]['quota'] is not None
        assert table.scan()['Items'] == []


THROTTLED = ClientError({'Error': {'Code': 'TooManyRequestsException', 'Message': 'Rate exceeded'}}, 'GetServiceQuota')


class ThrottlingQuotas(SlowQuotas):
    """Service Quotas under parallel load: every call is throttled; tracks the most reads in flight."""

    def __init__(self, *, throttle_get: bool = True, throttle_list: bool = True) -> None:
        super().__init__()
        self.throttle_get, self.throttle_list = throttle_get, throttle_list
        self.in_flight = 0
        self.most_in_flight = 0

    def paginate(self, **kwargs: Any) -> Iterator[dict]:
        if self.throttle_list:
            self._log('list_service_quotas', kwargs)
            raise THROTTLED
        yield from super().paginate(**kwargs)

    def get_service_quota(self, **kwargs: Any) -> dict:
        with self._lock:
            self.in_flight += 1
            self.most_in_flight = max(self.most_in_flight, self.in_flight)
        try:
            if self.throttle_get:
                self._log('get_service_quota', kwargs)
                raise THROTTLED
            return super().get_service_quota(**kwargs)
        finally:
            with self._lock:
                self.in_flight -= 1


class TestThrottling:
    def test_a_throttled_refresh_serves_the_stored_values_marked_stale_without_listing(self, table, monkeypatch):
        client = ThrottlingQuotas()
        _install(monkeypatch, client)
        _store(table, age_seconds=model_quota_store.FRESH_SECONDS + 1)

        overview = model_capacity.capacity_overview()

        assert client.calls_to('list_service_quotas') == [], 'a throttled refresh must not list ~1,050 quotas'
        assert [m['quota'] for m in overview] == [
            {'name': GLOBAL + m['label'], 'tokens_per_minute': 10 + i, 'stale': True} for i, m in enumerate(ALLOWED_MODELS)
        ]

    def test_a_throttled_listing_serves_a_stored_row_marked_stale(self, table, monkeypatch):
        client = ThrottlingQuotas()
        _install(monkeypatch, client)
        _store(table, age_seconds=60, names=_expected()[:-1])  # a model added since: the listing runs

        overview = model_capacity.capacity_overview()

        assert client.calls_to('list_service_quotas')
        assert overview[0]['quota'] == {'name': GLOBAL + ALLOWED_MODELS[0]['label'], 'tokens_per_minute': 10, 'stale': True}

    @pytest.mark.usefixtures('table')
    def test_a_throttled_listing_with_nothing_stored_is_unknown(self, monkeypatch):
        _install(monkeypatch, ThrottlingQuotas())

        assert all(m['quota'] is None for m in model_capacity.capacity_overview())

    def test_a_stale_answer_is_retried_after_the_short_error_ttl(self, table, monkeypatch):
        client = ThrottlingQuotas()
        _install(monkeypatch, client)
        _store(table, age_seconds=model_quota_store.FRESH_SECONDS + 1)
        before = time.time()

        model_capacity.capacity_overview()

        assert model_capacity._quota_cache.expires <= before + model_capacity.QUOTA_ERROR_CACHE_TTL_SECONDS + 5

    def test_the_refresh_never_has_more_reads_in_flight_than_the_cap(self, table, monkeypatch):
        client = ThrottlingQuotas(throttle_get=False)
        _install(monkeypatch, client)
        _store(table, age_seconds=model_quota_store.FRESH_SECONDS + 1)

        overview = model_capacity.capacity_overview()

        assert len(client.calls_to('get_service_quota')) == len(ALLOWED_MODELS)
        assert 1 < client.most_in_flight <= model_quota_store.REFRESH_WORKERS <= 4
        assert all(m['quota'] == {'name': GLOBAL + m['label'], 'tokens_per_minute': 2000} for m in overview)


def test_the_service_quotas_client_retries_adaptively(monkeypatch):
    monkeypatch.setenv('AWS_DEFAULT_REGION', 'us-east-1')
    monkeypatch.setattr(model_capacity, '_clients', {})

    retries = model_capacity._service_quotas_client().meta.config.retries

    # botocore stores max_attempts=3 (retries) as total_max_attempts=4 (the first call + 3).
    assert retries == {'mode': 'adaptive', 'total_max_attempts': 4}


# ── 5.35.02 e2e: a cold read took 5.2 s (budget 4.5 s) because a row older than an hour was
# re-read from Service Quotas before the response. It now answers with the stored values marked
# stale and async-invokes the settings worker twin, which re-reads them.

WORKER = 'voc-settings-assist'


@pytest.fixture
def invoke(monkeypatch: pytest.MonkeyPatch) -> MagicMock:
    monkeypatch.setenv('ASSIST_WORKER_FUNCTION', WORKER)
    sent = MagicMock(name='invoke_lambda_async')
    monkeypatch.setattr(model_capacity, 'invoke_lambda_async', sent)
    return sent


def _stale_overview() -> list[dict[str, Any]]:
    return [{'name': GLOBAL + m['label'], 'tokens_per_minute': 10 + i, 'stale': True} for i, m in enumerate(ALLOWED_MODELS)]


# A time budget measures the code, not the coverage tracer: no_cover runs it untraced (docs/coverage-gate.md).
@pytest.mark.no_cover
def test_an_old_row_answers_at_once_marked_stale_and_a_worker_refreshes_it(table, monkeypatch, invoke):
    client = SlowQuotas()
    _install(monkeypatch, client)
    _store(table, age_seconds=model_quota_store.FRESH_SECONDS + 1)

    started = time.perf_counter()
    overview = model_capacity.capacity_overview()
    seconds = time.perf_counter() - started

    assert client.calls == [], 'the request must not wait on Service Quotas'
    assert seconds < CALL_SECONDS
    assert [m['quota'] for m in overview] == _stale_overview()
    invoke.assert_called_once_with(WORKER, {'action': model_capacity.REFRESH_ACTION})


def test_a_burst_of_cold_containers_starts_one_refresh(table, monkeypatch, invoke):
    _install(monkeypatch, SlowQuotas())
    _store(table, age_seconds=model_quota_store.FRESH_SECONDS + 1)

    for _container in range(3):
        model_capacity.clear_quota_cache()
        model_capacity.capacity_overview()

    assert invoke.call_count == 1


def test_a_model_added_since_the_reading_is_listed_by_the_worker_not_the_request(table, monkeypatch, invoke):
    client = SlowQuotas()
    _install(monkeypatch, client)
    _store(table, age_seconds=60, names=[GLOBAL + m['label'] for m in ALLOWED_MODELS][:-1])

    overview = model_capacity.capacity_overview()

    assert client.calls == []
    assert overview[0]['quota'] == {'name': GLOBAL + ALLOWED_MODELS[0]['label'], 'tokens_per_minute': 10, 'stale': True}
    invoke.assert_called_once()


def test_a_failed_invoke_still_answers_with_the_stored_row(table, monkeypatch, invoke):
    client = SlowQuotas()
    _install(monkeypatch, client)
    _store(table, age_seconds=model_quota_store.FRESH_SECONDS + 1)
    invoke.side_effect = ClientError({'Error': {'Code': 'AccessDeniedException', 'Message': 'no'}}, 'Invoke')

    overview = model_capacity.capacity_overview()

    assert client.calls == []
    assert [m['quota'] for m in overview] == _stale_overview()


def test_the_worker_event_rewrites_the_row_so_the_next_cold_read_is_fresh(table, monkeypatch, invoke):
    client = SlowQuotas()
    _install(monkeypatch, client)
    _store(table, age_seconds=model_quota_store.FRESH_SECONDS + 1)
    model_capacity.capacity_overview()

    assert is_action_event({'action': model_capacity.REFRESH_ACTION}, model_capacity.REFRESH_ACTION)
    assert model_capacity.run_refresh_event() == {'refreshed': True}
    model_capacity.clear_quota_cache()
    overview = model_capacity.capacity_overview()

    assert all(m['quota'] == {'name': GLOBAL + m['label'], 'tokens_per_minute': 2000} for m in overview)
    assert invoke.call_count == 1


def test_an_api_gateway_request_is_never_the_refresh_event():
    assert not is_action_event({'action': model_capacity.REFRESH_ACTION, 'httpMethod': 'GET'}, model_capacity.REFRESH_ACTION)


def test_a_claim_older_than_the_window_is_taken_again(table):
    _store(table, age_seconds=model_quota_store.FRESH_SECONDS + 1)
    now = time.time()

    assert model_quota_store.claim_refresh(now)
    assert not model_quota_store.claim_refresh(now + 1)
    assert model_quota_store.claim_refresh(now + model_quota_store.REFRESH_CLAIM_SECONDS + 1)


def test_nothing_stored_is_never_claimed(table):
    assert not model_quota_store.claim_refresh(time.time())
    assert table.scan()['Items'] == [], 'a claim must not create a row without readings'
