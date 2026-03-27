"""
Tests for shared/aws.py - AWS client utilities.

Focuses on behavioral tests: caching, secret parsing, error handling.
Removed: client factory tests that only verify boto3 is called with the right service name.
"""
import json
from unittest.mock import patch, MagicMock


class TestGetSecret:
    """Tests for get_secret function — real parsing and caching behavior."""

    @patch('shared.aws.get_secrets_client')
    def test_parses_json_secret_into_dict(self, mock_get_client):
        """Parses SecretString JSON into a Python dict with correct values."""
        mock_client = MagicMock()
        mock_client.get_secret_value.return_value = {
            'SecretString': json.dumps({'api_key': 'secret123', 'api_secret': 'secret456'})
        }
        mock_get_client.return_value = mock_client

        from shared.aws import get_secret, clear_secret_cache
        clear_secret_cache()

        result = get_secret('arn:aws:secretsmanager:us-east-1:123:secret:test')
        assert result == {'api_key': 'secret123', 'api_secret': 'secret456'}

    @patch('shared.aws.get_secrets_client')
    def test_returns_empty_dict_when_retrieval_fails(self, mock_get_client):
        """Returns empty dict on access denied or missing secret."""
        mock_client = MagicMock()
        mock_client.get_secret_value.side_effect = Exception('Access denied')
        mock_get_client.return_value = mock_client

        from shared.aws import get_secret, clear_secret_cache
        clear_secret_cache()

        result = get_secret('arn:aws:secretsmanager:us-east-1:123:secret:x')
        assert result == {}

    @patch('shared.aws.get_secrets_client')
    def test_caches_secret_and_avoids_repeated_api_calls(self, mock_get_client):
        """Second call returns cached value without hitting Secrets Manager."""
        mock_client = MagicMock()
        mock_client.get_secret_value.return_value = {
            'SecretString': json.dumps({'key': 'value'})
        }
        mock_get_client.return_value = mock_client

        from shared.aws import get_secret, clear_secret_cache
        clear_secret_cache()

        result1 = get_secret('arn:aws:secretsmanager:us-east-1:123:secret:cached')
        result2 = get_secret('arn:aws:secretsmanager:us-east-1:123:secret:cached')

        assert result1 == result2 == {'key': 'value'}
        assert mock_client.get_secret_value.call_count == 1


class TestClearSecretCache:

    @patch('shared.aws.get_secrets_client')
    def test_forces_fresh_fetch_after_cache_clear(self, mock_get_client):
        """After clearing cache, next get_secret hits Secrets Manager again."""
        mock_client = MagicMock()
        mock_client.get_secret_value.return_value = {
            'SecretString': json.dumps({'key': 'value'})
        }
        mock_get_client.return_value = mock_client

        from shared.aws import get_secret, clear_secret_cache
        clear_secret_cache()

        get_secret('arn:aws:secretsmanager:us-east-1:123:secret:test-clear')
        clear_secret_cache()
        get_secret('arn:aws:secretsmanager:us-east-1:123:secret:test-clear')

        assert mock_client.get_secret_value.call_count == 2


class TestBedrockModelId:

    def test_model_id_points_to_claude_sonnet(self):
        """Verifies the model ID references Claude Sonnet."""
        from shared.aws import BEDROCK_MODEL_ID
        assert 'claude' in BEDROCK_MODEL_ID.lower()
        assert 'sonnet' in BEDROCK_MODEL_ID.lower()


class TestInvokeLambdaAsync:

    @patch('shared.aws.get_lambda_client')
    def test_invokes_with_event_type_and_serialized_payload(self, mock_get_client):
        """Uses async Event invocation and JSON-serializes the payload."""
        mock_client = MagicMock()
        mock_client.invoke.return_value = {'StatusCode': 202}
        mock_get_client.return_value = mock_client

        from shared.aws import invoke_lambda_async
        result = invoke_lambda_async('my-function', {'key': 'value'})

        mock_client.invoke.assert_called_once_with(
            FunctionName='my-function',
            InvocationType='Event',
            Payload='{"key": "value"}'
        )
        assert result == {'StatusCode': 202}
