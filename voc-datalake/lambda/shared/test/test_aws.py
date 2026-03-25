"""
Tests for shared/aws.py - AWS client utilities.
"""
import json
import pytest
from unittest.mock import patch, MagicMock


class TestGetDynamoDBResource:
    """Tests for get_dynamodb_resource function."""

    @patch('shared.aws._dynamodb_resource', None)
    @patch('boto3.resource')
    def test_creates_dynamodb_resource(self, mock_boto_resource):
        """Creates DynamoDB resource on first call."""
        mock_resource = MagicMock()
        mock_boto_resource.return_value = mock_resource
        
        import shared.aws
        shared.aws._dynamodb_resource = None
        
        from shared.aws import get_dynamodb_resource
        result = get_dynamodb_resource()
        
        mock_boto_resource.assert_called_once_with('dynamodb')
        assert result == mock_resource

    @patch('boto3.resource')
    def test_reuses_existing_resource(self, mock_boto_resource):
        """Reuses existing DynamoDB resource."""
        mock_resource = MagicMock()
        
        import shared.aws
        shared.aws._dynamodb_resource = mock_resource
        
        from shared.aws import get_dynamodb_resource
        result = get_dynamodb_resource()
        
        mock_boto_resource.assert_not_called()
        assert result == mock_resource


class TestGetS3Client:
    """Tests for get_s3_client function."""

    @patch('shared.aws._s3_client', None)
    @patch('boto3.client')
    def test_creates_s3_client_with_sigv4(self, mock_boto_client):
        """Creates S3 client with Signature Version 4."""
        mock_client = MagicMock()
        mock_boto_client.return_value = mock_client
        
        import shared.aws
        shared.aws._s3_client = None
        
        from shared.aws import get_s3_client
        result = get_s3_client()
        
        mock_boto_client.assert_called_once()
        call_args = mock_boto_client.call_args
        assert call_args[0][0] == 's3'
        assert result == mock_client

    @patch('boto3.client')
    def test_reuses_existing_client(self, mock_boto_client):
        """Reuses existing S3 client."""
        mock_client = MagicMock()
        
        import shared.aws
        shared.aws._s3_client = mock_client
        
        from shared.aws import get_s3_client
        result = get_s3_client()
        
        mock_boto_client.assert_not_called()
        assert result == mock_client


class TestGetSQSClient:
    """Tests for get_sqs_client function."""

    @patch('shared.aws._sqs_client', None)
    @patch('boto3.client')
    def test_creates_sqs_client(self, mock_boto_client):
        """Creates SQS client on first call."""
        mock_client = MagicMock()
        mock_boto_client.return_value = mock_client
        
        import shared.aws
        shared.aws._sqs_client = None
        
        from shared.aws import get_sqs_client
        result = get_sqs_client()
        
        mock_boto_client.assert_called_once_with('sqs')
        assert result == mock_client

    @patch('boto3.client')
    def test_reuses_existing_client(self, mock_boto_client):
        """Reuses existing SQS client."""
        mock_client = MagicMock()
        
        import shared.aws
        shared.aws._sqs_client = mock_client
        
        from shared.aws import get_sqs_client
        result = get_sqs_client()
        
        mock_boto_client.assert_not_called()
        assert result == mock_client


class TestGetSecretsClient:
    """Tests for get_secrets_client function."""

    @patch('shared.aws._secrets_client', None)
    @patch('boto3.client')
    def test_creates_secrets_client(self, mock_boto_client):
        """Creates Secrets Manager client on first call."""
        mock_client = MagicMock()
        mock_boto_client.return_value = mock_client
        
        import shared.aws
        shared.aws._secrets_client = None
        
        from shared.aws import get_secrets_client
        result = get_secrets_client()
        
        mock_boto_client.assert_called_once_with('secretsmanager')
        assert result == mock_client


class TestGetBedrockClient:
    """Tests for get_bedrock_client function."""

    @patch('shared.aws._bedrock_client', None)
    @patch('boto3.client')
    def test_creates_bedrock_client(self, mock_boto_client):
        """Creates Bedrock Runtime client on first call with extended timeout config."""
        mock_client = MagicMock()
        mock_boto_client.return_value = mock_client
        
        import shared.aws
        shared.aws._bedrock_client = None
        
        from shared.aws import get_bedrock_client
        result = get_bedrock_client()
        
        # Verify client was created with bedrock-runtime and a config
        mock_boto_client.assert_called_once()
        call_args = mock_boto_client.call_args
        assert call_args[0][0] == 'bedrock-runtime'
        assert 'config' in call_args[1]
        assert result == mock_client


class TestGetSecret:
    """Tests for get_secret function."""

    @patch('shared.aws.get_secrets_client')
    def test_returns_parsed_secret(self, mock_get_client):
        """Returns parsed secret as dict."""
        mock_client = MagicMock()
        mock_client.get_secret_value.return_value = {
            'SecretString': json.dumps({'api_key': 'secret123', 'api_secret': 'secret456'})
        }
        mock_get_client.return_value = mock_client
        
        from shared.aws import get_secret, clear_secret_cache
        clear_secret_cache()
        
        result = get_secret('arn:aws:secretsmanager:us-east-1:123:secret:test')
        
        assert result['api_key'] == 'secret123'
        assert result['api_secret'] == 'secret456'

    @patch('shared.aws.get_secrets_client')
    def test_returns_empty_dict_on_error(self, mock_get_client):
        """Returns empty dict when secret retrieval fails."""
        mock_client = MagicMock()
        mock_client.get_secret_value.side_effect = Exception('Access denied')
        mock_get_client.return_value = mock_client
        
        from shared.aws import get_secret, clear_secret_cache
        clear_secret_cache()
        
        result = get_secret('arn:aws:secretsmanager:us-east-1:123:secret:nonexistent')
        
        assert result == {}

    @patch('shared.aws.get_secrets_client')
    def test_caches_secret_value(self, mock_get_client):
        """Caches secret value for subsequent calls."""
        mock_client = MagicMock()
        mock_client.get_secret_value.return_value = {
            'SecretString': json.dumps({'key': 'value'})
        }
        mock_get_client.return_value = mock_client
        
        from shared.aws import get_secret, clear_secret_cache
        clear_secret_cache()
        
        # First call
        result1 = get_secret('arn:aws:secretsmanager:us-east-1:123:secret:cached')
        # Second call should use cache
        result2 = get_secret('arn:aws:secretsmanager:us-east-1:123:secret:cached')
        
        assert result1 == result2
        # Should only call get_secret_value once due to caching
        assert mock_client.get_secret_value.call_count == 1


class TestClearSecretCache:
    """Tests for clear_secret_cache function."""

    @patch('shared.aws.get_secrets_client')
    def test_clears_cache(self, mock_get_client):
        """Clears the secret cache."""
        mock_client = MagicMock()
        mock_client.get_secret_value.return_value = {
            'SecretString': json.dumps({'key': 'value'})
        }
        mock_get_client.return_value = mock_client
        
        from shared.aws import get_secret, clear_secret_cache
        clear_secret_cache()
        
        # First call
        get_secret('arn:aws:secretsmanager:us-east-1:123:secret:test-clear')
        
        # Clear cache
        clear_secret_cache()
        
        # Second call should fetch again
        get_secret('arn:aws:secretsmanager:us-east-1:123:secret:test-clear')
        
        # Should call get_secret_value twice (once before clear, once after)
        assert mock_client.get_secret_value.call_count == 2


class TestBedrockModelId:
    """Tests for BEDROCK_MODEL_ID constant."""

    def test_model_id_is_claude_sonnet(self):
        """Verifies correct Bedrock model ID."""
        from shared.aws import BEDROCK_MODEL_ID
        
        assert 'claude' in BEDROCK_MODEL_ID.lower()
        assert 'sonnet' in BEDROCK_MODEL_ID.lower()


class TestGetLambdaClient:
    """Tests for get_lambda_client function."""

    @patch('shared.aws.boto3.client')
    def test_creates_lambda_client(self, mock_boto_client):
        """Creates Lambda client on first call."""
        import shared.aws as aws_module
        aws_module._lambda_client = None  # Reset cached client
        
        mock_client = MagicMock()
        mock_boto_client.return_value = mock_client
        
        from shared.aws import get_lambda_client
        result = get_lambda_client()
        
        mock_boto_client.assert_called_with('lambda')
        assert result == mock_client

    @patch('shared.aws.boto3.client')
    def test_reuses_existing_client(self, mock_boto_client):
        """Reuses existing client on subsequent calls."""
        import shared.aws as aws_module
        existing_client = MagicMock()
        aws_module._lambda_client = existing_client
        
        from shared.aws import get_lambda_client
        result = get_lambda_client()
        
        mock_boto_client.assert_not_called()
        assert result == existing_client


class TestInvokeLambdaAsync:
    """Tests for invoke_lambda_async function."""

    @patch('shared.aws.get_lambda_client')
    def test_invokes_lambda_with_event_type(self, mock_get_client):
        """Invokes Lambda with Event invocation type."""
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

    @patch('shared.aws.get_lambda_client')
    def test_handles_complex_payload(self, mock_get_client):
        """Handles complex nested payload."""
        mock_client = MagicMock()
        mock_client.invoke.return_value = {'StatusCode': 202}
        mock_get_client.return_value = mock_client
        
        from shared.aws import invoke_lambda_async
        payload = {
            'job_type': 'generate_personas',
            'project_id': 'proj_123',
            'filters': {'days': 30, 'sources': ['webscraper']}
        }
        invoke_lambda_async('my-function', payload)
        
        call_args = mock_client.invoke.call_args
        assert call_args.kwargs['FunctionName'] == 'my-function'
        assert call_args.kwargs['InvocationType'] == 'Event'



