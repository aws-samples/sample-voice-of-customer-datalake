"""Mutation hardening for `shared/model_fallback.py`.

`test_model_fallback.py` drives the fallback through `converse_detailed` and
checks which models were tried and what the metric counted, but a mutation run
found what that end-to-end view cannot see:

* the fallback LOG line (`record_fallback`): its text, its `extra` keys and the
  `reason` — the Bedrock error code, or ``'cooldown'`` for a skipped model —
  which is what an operator searches CloudWatch for. Nothing asserted it.
* `error_code` on its own: a ClientError with no code, a wrapped cause, a plain
  exception all name a different thing.
* the metric's namespace fallback (`metrics.namespace or 'VoC'`) and the warning
  logged when the metric itself fails.
* the cooldown boundary: at exactly the expiry second a model is ready again.
* that a three-model walk records BOTH fallbacks, not only the first, and the
  exact refusal for an empty chain.
"""
from collections.abc import Iterator
from unittest.mock import MagicMock, call, patch

import pytest
from botocore.exceptions import ClientError

from shared import model_fallback
from shared.converse import BedrockThrottlingError
from shared.test.converse_fixtures import metric_recorder

LOG_LINE = '[BEDROCK] Model cannot serve now; falling back'


def _error(code: str | None, message: str = 'x') -> ClientError:
    if code is None:
        return ClientError({'Error': {'Message': message}}, 'Converse')
    return ClientError({'Error': {'Code': code, 'Message': message}}, 'Converse')


def _fallback_log(surface: str, from_model: str, to_model: str, reason: str):
    return call(LOG_LINE, extra={'surface': surface, 'from_model': from_model,
                                 'to_model': to_model, 'reason': reason})


@pytest.fixture
def logger() -> Iterator[MagicMock]:
    with patch.object(model_fallback, 'logger') as mocked:
        yield mocked


@pytest.fixture
def emitted() -> Iterator[list[dict]]:
    calls: list[dict] = []
    with patch.object(model_fallback, 'single_metric', metric_recorder(calls)):
        yield calls


class TestErrorCodeNamesTheCause:
    def test_client_error_gives_its_code(self):
        assert model_fallback.error_code(_error('ThrottlingException')) == 'ThrottlingException'

    def test_client_error_without_a_code_gives_the_class_name(self):
        assert model_fallback.error_code(_error(None)) == 'ClientError'

    def test_wrapped_cause_gives_the_cause_code(self):
        wrapped = BedrockThrottlingError('throttled after 5 retries')
        wrapped.__cause__ = _error('ServiceUnavailableException')
        assert model_fallback.error_code(wrapped) == 'ServiceUnavailableException'

    def test_plain_exception_gives_its_class_name(self):
        assert model_fallback.error_code(RuntimeError('boom')) == 'RuntimeError'


class TestCooldownWindow:
    def test_cooling_until_the_expiry_second_and_ready_at_it(self):
        model_fallback.mark_unavailable('m', now=1_000.0)
        assert model_fallback.cooldown_until == {'m': 1_300.0}
        assert model_fallback.is_cooling_down('m', now=1_299.0) is True
        assert model_fallback.is_cooling_down('m', now=1_300.0) is False


class TestRecordFallbackLogsAndCounts:
    def test_log_line_and_metric(self, logger: MagicMock, emitted: list[dict]):
        model_fallback.record_fallback('chat', 'a', 'b', 'ThrottlingException')
        assert logger.warning.call_args_list == [_fallback_log('chat', 'a', 'b', 'ThrottlingException')]
        assert [e['namespace'] for e in emitted] == ['VoC']

    @pytest.mark.parametrize(('configured', 'expected'), [(None, 'VoC'), ('', 'VoC'), ('Custom', 'Custom')])
    def test_namespace_falls_back_to_voc(self, emitted: list[dict], configured: str | None, expected: str):
        with patch.object(model_fallback, 'metrics', MagicMock(namespace=configured)):
            model_fallback.record_fallback('chat', 'a', 'b', 'r')
        assert [e['namespace'] for e in emitted] == [expected]

    def test_metric_failure_is_logged_not_raised(self, logger: MagicMock):
        with patch.object(model_fallback, 'single_metric', side_effect=RuntimeError('emf down')):
            model_fallback.record_fallback('chat', 'a', 'b', 'r')
        assert logger.warning.call_args_list == [
            _fallback_log('chat', 'a', 'b', 'r'),
            call('[BEDROCK] Could not emit ModelFallback: emf down'),
        ]


class TestRunWithFallbackRecordsEveryHop:
    def test_three_failing_models_record_both_hops_and_raise_the_first(
            self, logger: MagicMock, emitted: list[dict]):
        errors = {'a': _error('ThrottlingException'), 'b': _error('ModelNotReadyException'),
                  'c': _error('ServiceQuotaExceededException')}

        def attempt(model: str) -> str:
            raise errors[model]

        with pytest.raises(ClientError) as raised:
            model_fallback.run_with_fallback(['a', 'b', 'c'], 'chat', attempt)
        assert raised.value is errors['a']
        assert logger.warning.call_args_list == [
            _fallback_log('chat', 'a', 'b', 'ThrottlingException'),
            _fallback_log('chat', 'b', 'c', 'ModelNotReadyException'),
        ]
        assert [e['dimensions'] for e in emitted] == [
            {'Surface': 'chat', 'From': 'a', 'To': 'b'},
            {'Surface': 'chat', 'From': 'b', 'To': 'c'},
        ]

    def test_skipped_cooling_primary_is_logged_with_reason_cooldown(self, logger: MagicMock, emitted: list[dict]):
        model_fallback.mark_unavailable('a')
        assert model_fallback.run_with_fallback(['a', 'b'], 'docs', lambda m: f'from {m}') == ('b', 'from b')
        assert logger.warning.call_args_list == [_fallback_log('docs', 'a', 'b', 'cooldown')]
        assert [e['dimensions'] for e in emitted] == [{'Surface': 'docs', 'From': 'a', 'To': 'b'}]

    def test_empty_chain_is_refused(self):
        with pytest.raises(ValueError, match=r'^run_with_fallback needs at least one model$'):
            model_fallback.run_with_fallback([], 'chat', lambda m: m)
