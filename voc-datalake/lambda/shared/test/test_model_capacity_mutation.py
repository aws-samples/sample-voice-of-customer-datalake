"""Mutation hardening for `shared/model_capacity.py`.

`test_model_capacity.py` pins the request shape, the status mapping and the
quota match, but a mutation run (199 mutants, 57 survivors) found what it
could not see:

* the WORDING of every status message. `POST /settings/model/test` returns it to
  API callers, so each one is pinned here as a literal, with its `(code)` suffix.
* the exact cache lifetimes: a listing is fresh for 599 s and stale at 600 s, a
  failed one at 59 s / 60 s, and a cleared or fresh-container cache re-lists
  even on a clock below one second.
* the client cache of a fresh container: each client is built once, with the
  probe's 5 s / 20 s / single-attempt botocore config.
* the latency arithmetic (milliseconds of the probe call alone), the
  `Model test finished` and listing-failure log records and their fields, and
  the outcomes no stub produced: a ClientError without a code, a non-timeout
  BotoCoreError, a connect timeout, `TooManyRequestsException`, malformed
  quota entries (no Value) and an unexpected exception in the listing.
"""
import importlib.util
import logging
from collections.abc import Callable, Iterator
from pathlib import Path
from types import ModuleType, SimpleNamespace
from typing import Any

import boto3
import pytest
from botocore.exceptions import ClientError, ConnectTimeoutError, EndpointConnectionError
from botocore.stub import Stubber

from shared import model_capacity
from shared.test.model_capacity_fixtures import (
    GLOBAL,
    OK_RESPONSE,
    OPUS55,
    World,
    probe_with_error,
    quota_entry,
    stubbed_world,
)

OPUS_QUOTA = GLOBAL + 'Claude Opus 5.5'


@pytest.fixture
def world(monkeypatch: pytest.MonkeyPatch) -> Iterator[World]:
    with stubbed_world(monkeypatch) as created:
        yield created


def _clock(monkeypatch: pytest.MonkeyPatch, module: ModuleType, wall: list[float],
           monotonic: list[float] | None = None) -> None:
    """Give ``module`` its own clock: ``wall[0]`` for time(), ``monotonic`` read in order."""
    ticks = iter(monotonic or [])
    monkeypatch.setattr(module, 'time', SimpleNamespace(time=lambda: wall[0], monotonic=lambda: next(ticks)))


def _raise(error: Exception) -> Callable[..., Any]:
    def raiser(*_args: Any, **_kwargs: Any) -> Any:
        raise error
    return raiser


def _records(caplog: pytest.LogCaptureFixture, message: str) -> list[logging.LogRecord]:
    return [record for record in caplog.records if record.getMessage() == message]


def _fields(record: logging.LogRecord, *names: str) -> list[Any]:
    """The ``extra`` fields a record carries (attributes the stdlib type does not declare)."""
    return [vars(record)[name] for name in names]


class TestEveryStatusMessageIsPinned:
    @pytest.mark.parametrize(('code', 'quota', 'status', 'message'), [
        ('AccessDeniedException', None, 'no_access',
         'This account has no access to the model (model access, use case or agreement). (AccessDeniedException)'),
        ('ResourceNotFoundException', None, 'not_in_region',
         'The model or its inference profile is not offered in this region. (ResourceNotFoundException)'),
        ('ThrottlingException', 0, 'no_capacity',
         'The token quota for this model is 0 in this account; nothing to do but wait. (ThrottlingException)'),
        ('TooManyRequestsException', None, 'throttled',
         'The model is throttling requests right now; retry later. (TooManyRequestsException)'),
        ('ModelNotReadyException', None, 'not_ready',
         'The model is not ready yet; retry in a few minutes. (ModelNotReadyException)'),
        ('ServiceUnavailableException', None, 'unavailable',
         'The model is temporarily unavailable; retry later. (ServiceUnavailableException)'),
        ('InternalServerException', None, 'error', 'The test request failed. (InternalServerException)'),
    ])
    def test_a_client_error_reports_its_status_text_and_code(self, world, code, quota, status, message):
        result = probe_with_error(world, code, quota=quota)

        assert (result['status'], result['message']) == (status, message)

    def test_a_client_error_without_a_code_is_named_client_error(self, world, monkeypatch):
        monkeypatch.setattr(world.bedrock, 'converse', _raise(ClientError({'Error': {}}, 'Converse')))
        world.list_quotas([])

        result = model_capacity.probe_model(OPUS55)

        assert (result['status'], result['message']) == ('error', 'The test request failed. (ClientError)')

    @pytest.mark.parametrize(('error', 'status', 'message'), [
        (ConnectTimeoutError(endpoint_url='https://bedrock-runtime'), 'unavailable',
         'The model is temporarily unavailable; retry later. (ConnectTimeoutError)'),
        (EndpointConnectionError(endpoint_url='https://bedrock-runtime'), 'error',
         'The test request failed. (EndpointConnectionError)'),
    ])
    def test_a_transport_failure_is_named_by_its_class(self, world, monkeypatch, error, status, message):
        monkeypatch.setattr(world.bedrock, 'converse', _raise(error))
        world.list_quotas([])

        result = model_capacity.probe_model(OPUS55)

        assert (result['status'], result['ok'], result['message']) == (status, False, message)


class TestLatencyAndTheFinishedLog:
    def test_latency_is_the_probe_call_in_milliseconds_and_is_logged(self, world, monkeypatch, caplog):
        _clock(monkeypatch, model_capacity, [1_000.0], [10.0, 12.0])
        world.converse_ok()
        world.list_quotas([])

        with caplog.at_level('INFO'):
            result = model_capacity.probe_model(OPUS55)

        assert result['latency_ms'] == 2_000
        [record] = _records(caplog, 'Model test finished')
        assert _fields(record, 'model_id', 'invoked_id', 'status', 'error_code', 'latency_ms') == [
            OPUS55, OPUS55, 'available', None, 2_000]

    def test_a_failure_logs_its_code_and_returns_no_latency(self, world, monkeypatch, caplog):
        _clock(monkeypatch, model_capacity, [1_000.0], [10.0, 10.5])

        with caplog.at_level('INFO'):
            result = probe_with_error(world, 'ThrottlingException')

        assert result['latency_ms'] is None
        [record] = _records(caplog, 'Model test finished')
        assert _fields(record, 'status', 'error_code', 'latency_ms') == ['throttled', 'ThrottlingException', 500]


class TestQuotaCacheLifetimes:
    def test_a_listing_is_fresh_for_599_seconds_and_stale_at_600(self, world, monkeypatch):
        clock = [1_000.0]
        _clock(monkeypatch, model_capacity, clock)
        world.list_quotas([quota_entry(OPUS_QUOTA, 1)])
        world.list_quotas([quota_entry(OPUS_QUOTA, 2)])

        seen = []
        for at in (1_000.0, 1_599.5, 1_600.0):
            clock[0] = at
            quota = model_capacity.lookup_quota(OPUS55)
            seen.append(quota['tokens_per_minute'] if quota else None)

        assert seen == [1, 1, 2]

    def test_a_failed_listing_is_retried_after_60_seconds(self, world, monkeypatch):
        clock = [1_000.0]
        _clock(monkeypatch, model_capacity, clock)
        world.quotas_stub.add_client_error('list_service_quotas', service_error_code='AccessDeniedException')
        world.list_quotas([quota_entry(OPUS_QUOTA, 3)])

        first = model_capacity.lookup_quota(OPUS55)
        clock[0] = 1_059.5
        still_unknown = model_capacity.lookup_quota(OPUS55)
        clock[0] = 1_060.0
        retried = model_capacity.lookup_quota(OPUS55)

        assert (first, still_unknown, retried) == (None, None, {'name': OPUS_QUOTA, 'tokens_per_minute': 3})

    def test_clearing_forces_a_new_listing_even_before_the_first_second(self, world, monkeypatch):
        _clock(monkeypatch, model_capacity, [0.5])
        world.list_quotas([quota_entry(OPUS_QUOTA, 1)])
        world.list_quotas([quota_entry(OPUS_QUOTA, 2)])

        first = model_capacity.lookup_quota(OPUS55)
        model_capacity.clear_quota_cache()
        second = model_capacity.lookup_quota(OPUS55)

        assert [first, second] == [{'name': OPUS_QUOTA, 'tokens_per_minute': 1},
                                   {'name': OPUS_QUOTA, 'tokens_per_minute': 2}]


class TestListingFailuresAreLoggedAndNeverRaise:
    def test_a_client_error_is_logged_with_its_code(self, world, caplog):
        world.quotas_stub.add_client_error('list_service_quotas', service_error_code='AccessDeniedException')

        with caplog.at_level('WARNING'):
            assert model_capacity.lookup_quota(OPUS55) is None

        [record] = _records(caplog, 'Service Quotas listing failed; quota unknown')
        assert [record.levelname, *_fields(record, 'error_code')] == ['WARNING', 'AccessDeniedException']

    def test_a_botocore_error_is_logged_with_its_class_name(self, world, monkeypatch, caplog):
        error = EndpointConnectionError(endpoint_url='https://servicequotas')
        monkeypatch.setattr(world.quotas, 'get_paginator', _raise(error))

        with caplog.at_level('WARNING'):
            assert model_capacity.lookup_quota(OPUS55) is None

        [record] = _records(caplog, 'Service Quotas listing failed; quota unknown')
        assert _fields(record, 'error_code') == ['EndpointConnectionError']

    def test_an_unexpected_exception_is_logged_and_gives_no_quota(self, world, monkeypatch, caplog):
        monkeypatch.setattr(world.quotas, 'get_paginator', _raise(RuntimeError('surprise')))

        with caplog.at_level('ERROR'):
            assert model_capacity.lookup_quota(OPUS55) is None

        [record] = _records(caplog, 'Unexpected Service Quotas failure; quota unknown')
        assert record.levelname == 'ERROR'

    def test_an_entry_without_a_value_is_skipped_not_fatal(self, world):
        world.list_quotas([{'QuotaName': GLOBAL + 'Claude Haiku 5.5'}, quota_entry(OPUS_QUOTA, 4)])

        assert model_capacity.lookup_quota(OPUS55) == {'name': OPUS_QUOTA, 'tokens_per_minute': 4}


def _fresh_module() -> ModuleType:
    """A second, never-touched copy of the module: what a new Lambda container starts with."""
    spec = importlib.util.spec_from_file_location('model_capacity_fresh_container', Path(model_capacity.__file__))
    assert spec
    assert spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class TestAFreshContainer:
    def test_builds_each_client_once_with_the_probe_config_and_lists_at_first_use(self, monkeypatch):
        monkeypatch.delenv('BEDROCK_INFERENCE_SCOPE', raising=False)
        fresh = _fresh_module()
        _clock(monkeypatch, fresh, [0.5], [1.0, 1.1, 2.0, 2.1])
        clients = {'bedrock-runtime': boto3.client('bedrock-runtime', region_name='us-east-1'),
                   'service-quotas': boto3.client('service-quotas', region_name='us-east-1')}
        built: list[tuple[str, dict]] = []

        def factory(service: str, **kwargs: Any) -> Any:
            built.append((service, kwargs))
            return clients[service]

        monkeypatch.setattr(fresh.boto3, 'client', factory)
        with Stubber(clients['bedrock-runtime']) as bedrock, Stubber(clients['service-quotas']) as quotas:
            bedrock.add_response('converse', OK_RESPONSE)
            bedrock.add_response('converse', OK_RESPONSE)
            for value in (5, 6):
                quotas.add_response('list_service_quotas', {'Quotas': [quota_entry(OPUS_QUOTA, value)]},
                                    {'ServiceCode': 'bedrock'})

            first = fresh.probe_model(OPUS55)
            fresh.clear_quota_cache()  # the second probe lists again, through the cached client
            results = [first, fresh.probe_model(OPUS55)]

            bedrock.assert_no_pending_responses()
            quotas.assert_no_pending_responses()

        assert [r['quota'] for r in results] == [{'name': OPUS_QUOTA, 'tokens_per_minute': 5},
                                                 {'name': OPUS_QUOTA, 'tokens_per_minute': 6}]
        assert built == [('bedrock-runtime', {'config': fresh._PROBE_CLIENT_CONFIG}), ('service-quotas', {})]
        config = fresh._PROBE_CLIENT_CONFIG
        assert (config.connect_timeout, config.read_timeout, config.retries) == (
            5, 20, {'max_attempts': 1, 'mode': 'standard'})
