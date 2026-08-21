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


class TestIsConditionalCheckFailure:
    """Both signals, because the exception arrives two different ways.

    Every conditional write in this app depends on this predicate to tell an
    EXPECTED refusal (a decrement with nothing to decrement, a status write against
    a record already terminal) from a real failure, and it gets the two wrong in
    opposite directions: too narrow and a benign refusal is re-raised into the batch
    processor, too wide and a throttle is swallowed as if nothing happened. So both
    branches are covered, and so is what must NOT match.
    """

    @staticmethod
    def _client_error(code: str) -> Exception:
        from botocore.exceptions import ClientError
        return ClientError(
            {'Error': {'Code': code, 'Message': 'the conditional request failed'}},
            'UpdateItem',
        )

    def test_the_response_code_is_recognized(self):
        """The dependable signal: boto3's resource layer raises a ClientError whose
        dynamically-built subclass name is a botocore implementation detail."""
        from shared.aws import is_conditional_check_failure

        assert is_conditional_check_failure(
            self._client_error('ConditionalCheckFailedException')
        ) is True

    def test_the_exception_type_name_is_recognized_too(self):
        """A test double raises the named exception with no response payload."""
        from shared.aws import is_conditional_check_failure

        ConditionalCheckFailedException = type('ConditionalCheckFailedException',
                                               (Exception,), {})

        assert is_conditional_check_failure(ConditionalCheckFailedException()) is True

    def test_another_dynamodb_error_is_not_a_refusal(self):
        """A throttle must reach the caller; swallowing it loses the write silently."""
        from shared.aws import is_conditional_check_failure

        assert is_conditional_check_failure(
            self._client_error('ProvisionedThroughputExceededException')
        ) is False

    def test_an_error_with_no_response_at_all_is_not_a_refusal(self):
        """`getattr(error, 'response', None)` must not raise on a bare exception."""
        from shared.aws import is_conditional_check_failure

        assert is_conditional_check_failure(RuntimeError('boom')) is False

    def test_a_malformed_response_is_not_a_refusal(self):
        """`response['Error']` can be absent or None; neither may raise here."""
        from shared.aws import is_conditional_check_failure

        for response in ({}, {'Error': None}, {'Error': {}}, 'not a dict'):
            error = RuntimeError('boom')
            error.response = response
            assert is_conditional_check_failure(error) is False, response


class TestTheExtractorsCopyStaysInStep:
    """`product_doc_extractor/handler.py` keeps its OWN copy of the predicate.

    Not by preference: that Lambda is stdlib+boto3 only so CoreStack never needs
    container bundling, so it cannot import `shared/`. The duplication is therefore
    load-bearing and permanent, which makes it exactly the kind of thing that drifts
    — whoever finds a third arrival path for this exception fixes one copy. This pins
    the two bodies against each other rather than trusting the comment that says to
    change both.
    """

    @staticmethod
    def _function_body(source: str, name: str) -> str:
        import ast
        tree = ast.parse(source)
        functions = [node for node in ast.walk(tree)
                     if isinstance(node, ast.FunctionDef) and node.name == name]
        assert len(functions) == 1, f'expected one {name}; found {len(functions)}'
        # Docstrings differ deliberately (each points at the other), so only the
        # executable statements are compared.
        body = [node for node in functions[0].body
                if not (isinstance(node, ast.Expr) and isinstance(node.value, ast.Constant))]
        return '\n'.join(ast.unparse(node) for node in body)

    def test_the_two_copies_have_identical_logic(self):
        from pathlib import Path

        # lambda/shared/test/ -> voc-datalake/lambda/
        lambda_root = Path(__file__).resolve().parents[2]
        shared = self._function_body(
            (lambda_root / 'shared' / 'aws.py').read_text(encoding='utf-8'),
            'is_conditional_check_failure',
        )
        extractor = self._function_body(
            (lambda_root / 'product_doc_extractor' / 'handler.py').read_text(encoding='utf-8'),
            '_is_conditional_check_failure',
        )

        assert shared == extractor, (
            'shared/aws.py::is_conditional_check_failure and '
            'product_doc_extractor/handler.py::_is_conditional_check_failure have '
            'drifted. The extractor cannot import shared/ (see its module '
            'docstring), so the copy is permanent — change both, or neither.'
        )
