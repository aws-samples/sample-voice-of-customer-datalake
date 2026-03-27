"""
Coverage tests for shared.converse module — error propagation and retry exhaustion.
Removed: zero-retries tests (trivial edge case that tests a no-op code path).
"""

import pytest
from unittest.mock import patch, MagicMock
from botocore.exceptions import ClientError


class TestConverseClientCreationFailure:

    @patch('shared.converse.get_bedrock_client')
    def test_raises_when_client_creation_fails(self, mock_get_client):
        """Propagates exception when Bedrock client cannot be created."""
        mock_get_client.side_effect = RuntimeError("Cannot create client")

        from shared.converse import converse

        with pytest.raises(RuntimeError, match="Cannot create client"):
            converse("Hello", step_name="test_step")


class TestRetryExhaustion:

    @patch('shared.converse.time.sleep')
    def test_returns_empty_string_when_throttle_retries_exhausted_and_raise_disabled(self, mock_sleep):
        """Returns empty string instead of raising when raise_on_throttle=False and all retries fail."""
        from shared.converse import _invoke_with_retry

        mock_client = MagicMock()
        mock_client.converse.side_effect = ClientError(
            {'Error': {'Code': 'ThrottlingException', 'Message': 'Rate exceeded'}},
            'Converse'
        )

        result = _invoke_with_retry(
            client=mock_client,
            kwargs={'modelId': 'test', 'messages': []},
            max_retries=2,
            raise_on_throttle=False,
            step_name="test",
        )

        assert result == ""
        assert mock_client.converse.call_count == 2

    @patch('shared.converse.time.sleep')
    def test_raises_after_exhausting_retries_on_network_error(self, mock_sleep):
        """Raises the original exception after all retries are exhausted for non-throttle errors."""
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


class TestConverseChainExceptionPropagation:

    @patch('shared.converse.converse')
    def test_propagates_exception_from_mid_chain_step(self, mock_converse):
        """Exception in step 2 of a chain propagates without swallowing step 1's result."""
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
    def test_propagates_throttling_error_from_chain(self, mock_converse):
        """BedrockThrottlingError in a chain step propagates for retry at a higher level."""
        from shared.converse import converse_chain, BedrockThrottlingError

        mock_converse.side_effect = BedrockThrottlingError("Throttled")

        with pytest.raises(BedrockThrottlingError):
            converse_chain([{'system': 'S', 'user': 'U', 'step_name': 'throttled_step'}])
