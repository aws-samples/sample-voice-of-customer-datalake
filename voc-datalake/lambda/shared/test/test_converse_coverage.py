"""
Additional coverage tests for shared.converse module.
Targets uncovered lines: 72-74, 212-213, 218, 300-303, 361.
"""

import pytest
from unittest.mock import patch, MagicMock
from botocore.exceptions import ClientError


class TestConverseClientCreationFailure:
    """Tests for converse() when get_bedrock_client fails (lines 72-74)."""

    @patch('shared.converse.get_bedrock_client')
    def test_raises_when_client_creation_fails(self, mock_get_client):
        """Raises exception when get_bedrock_client fails."""
        mock_get_client.side_effect = RuntimeError("Cannot create client")

        from shared.converse import converse

        with pytest.raises(RuntimeError, match="Cannot create client"):
            converse("Hello", step_name="test_step")


class TestInvokeWithRetryExhaustedNoRaise:
    """Tests for _invoke_with_retry exhausting retries with raise_on_throttle=False (lines 212-213, 218)."""

    @patch('shared.converse.time.sleep')
    def test_returns_empty_on_exhausted_retries_no_raise(self, mock_sleep):
        """Returns empty string when retries exhausted and raise_on_throttle=False."""
        from shared.converse import _invoke_with_retry

        mock_client = MagicMock()
        throttle_error = ClientError(
            {'Error': {'Code': 'ThrottlingException', 'Message': 'Rate exceeded'}},
            'Converse'
        )
        mock_client.converse.side_effect = throttle_error

        result = _invoke_with_retry(
            client=mock_client,
            kwargs={'modelId': 'test', 'messages': []},
            max_retries=2,
            raise_on_throttle=False,
            step_name="test",
        )

        assert result == ""
        assert mock_client.converse.call_count == 2


class TestConverseChainExceptionPropagation:
    """Tests for converse_chain exception propagation (lines 300-303)."""

    @patch('shared.converse.converse')
    def test_propagates_exception_from_step(self, mock_converse):
        """Propagates exception from a failing step."""
        mock_converse.side_effect = [
            "Step 1 result",
            RuntimeError("Step 2 failed"),
        ]

        from shared.converse import converse_chain

        steps = [
            {'system': 'S1', 'user': 'U1', 'step_name': 'step_1'},
            {'system': 'S2', 'user': 'U2 {previous}', 'step_name': 'step_2'},
        ]

        with pytest.raises(RuntimeError, match="Step 2 failed"):
            converse_chain(steps)

    @patch('shared.converse.converse')
    def test_propagates_bedrock_throttling_from_chain(self, mock_converse):
        """Propagates BedrockThrottlingError from chain step."""
        from shared.converse import converse_chain, BedrockThrottlingError

        mock_converse.side_effect = BedrockThrottlingError("Throttled")

        steps = [{'system': 'S', 'user': 'U', 'step_name': 'throttled_step'}]

        with pytest.raises(BedrockThrottlingError):
            converse_chain(steps)


class TestInvokeWithRetryGenericExceptionExhausted:
    """Tests for _invoke_with_retry when generic exceptions exhaust all retries."""

    @patch('shared.converse.time.sleep')
    def test_raises_generic_exception_after_max_retries(self, mock_sleep):
        """Raises the generic exception after exhausting all retries."""
        from shared.converse import _invoke_with_retry

        mock_client = MagicMock()
        mock_client.converse.side_effect = ConnectionError("Persistent network error")

        with pytest.raises(ConnectionError, match="Persistent network error"):
            _invoke_with_retry(
                client=mock_client,
                kwargs={'modelId': 'test', 'messages': []},
                max_retries=3,
                raise_on_throttle=True,
                step_name="test",
            )

        assert mock_client.converse.call_count == 3


class TestInvokeWithRetryZeroRetries:
    """Tests for _invoke_with_retry with max_retries=0 (fallback path)."""

    def test_returns_empty_on_zero_retries_raise_true(self):
        """Returns empty string when max_retries=0 even with raise_on_throttle=True (no last_exception)."""
        from shared.converse import _invoke_with_retry

        mock_client = MagicMock()

        result = _invoke_with_retry(
            client=mock_client,
            kwargs={'modelId': 'test', 'messages': []},
            max_retries=0,
            raise_on_throttle=True,
            step_name="zero_retry",
        )

        assert result == ""
        assert mock_client.converse.call_count == 0

    def test_returns_empty_on_zero_retries_no_raise(self):
        """Returns empty string when max_retries=0 and raise_on_throttle=False."""
        from shared.converse import _invoke_with_retry

        mock_client = MagicMock()

        result = _invoke_with_retry(
            client=mock_client,
            kwargs={'modelId': 'test', 'messages': []},
            max_retries=0,
            raise_on_throttle=False,
            step_name="zero_retry",
        )

        assert result == ""
        assert mock_client.converse.call_count == 0
