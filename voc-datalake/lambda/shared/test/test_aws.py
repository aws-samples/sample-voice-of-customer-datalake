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


class TestBedrockClientBudget:
    """The read timeout and the retry count MULTIPLY, and that product is the bug.

    At `read_timeout=300` with `max_attempts=3` the budget was 900 s — EXACTLY the
    ceiling of the 15-minute job Lambdas that generate documents, prototypes,
    personas and research. A generation needing more than five minutes therefore
    could not succeed at all: two abandoned attempts, each re-paying for a full
    generation, then killed mid-third with nothing returned. Measured live on a
    prototype build.

    Nothing covered this before (see the module docstring's note about dropped
    client-factory tests) and that is precisely how it survived: each value reads
    as reasonable on its own line, and the number it collides with lives in a CDK
    stack. So both halves are pinned — the values that reach botocore, and the
    arithmetic that made them unsatisfiable.
    """

    # An AWS service maximum, not a repo choice: no Lambda can be configured
    # above 15 minutes, so a client budget at or above this can never fit inside
    # ANY caller. lib/stacks/api-stack.test.ts pins the same constant against the
    # timeouts actually configured, which is the half this file cannot see.
    MAX_LAMBDA_TIMEOUT_SECONDS = 900

    @staticmethod
    def _build_and_capture():
        """Build the client through a patched boto3 and return the call args.

        The client is cached in a module global that outlives a single test, so it
        is cleared on both sides: without the reset before, an earlier test's
        client is returned and nothing is captured; without the reset after, every
        later test in the session is handed this MagicMock.
        """
        import shared.aws as shared_aws

        with patch('shared.aws.boto3') as mock_boto3:
            shared_aws._bedrock_client = None
            try:
                shared_aws.get_bedrock_client()
            finally:
                shared_aws._bedrock_client = None
        return mock_boto3.client.call_args

    def test_the_client_carries_the_declared_timeouts_and_one_attempt(self):
        """What actually reaches botocore, not what the constants say."""
        call = self._build_and_capture()
        config = call.kwargs['config']

        from shared.aws import (
            BEDROCK_CONNECT_TIMEOUT_SECONDS,
            BEDROCK_MAX_ATTEMPTS,
            BEDROCK_READ_TIMEOUT_SECONDS,
        )

        assert call.args[0] == 'bedrock-runtime'
        assert config.read_timeout == BEDROCK_READ_TIMEOUT_SECONDS
        assert config.connect_timeout == BEDROCK_CONNECT_TIMEOUT_SECONDS
        assert config.retries['max_attempts'] == BEDROCK_MAX_ATTEMPTS

    def test_standard_retry_mode_is_explicit(self):
        """`max_attempts` counts TOTAL attempts in standard mode.

        Legacy mode's reading of the same key is ambiguous, so the mode is stated
        rather than inherited: `max_attempts: 1` has to mean one attempt, or the
        budget below is a lower bound instead of the budget.
        """
        config = self._build_and_capture().kwargs['config']

        assert config.retries['mode'] == 'standard'

    def test_a_single_attempt_so_no_caller_gets_a_multiple_of_the_read_timeout(self):
        """One cached client serves 30 s API handlers and 15 min job Lambdas alike.

        A per-caller budget would need a keyed cache; one attempt is what makes a
        single shared budget safe for all of them, because the worst case is one
        read timeout rather than N of them.
        """
        from shared.aws import BEDROCK_MAX_ATTEMPTS

        assert BEDROCK_MAX_ATTEMPTS == 1, (
            'more than one attempt makes the budget a MULTIPLE of the read '
            'timeout, which is how 300 x 3 came to equal the 900s job ceiling. '
            'shared/converse.py already retries what is genuinely transient, and '
            'logs each attempt; botocore retries below it, invisibly.'
        )

    def test_the_budget_fits_inside_a_lambda_with_room_to_record_the_failure(self):
        """The regression test: 300 x 3 = 900 fails here, and so does 840 x 2.

        Fitting is not enough — the invocation also has to survive the timeout
        long enough for shared/jobs.py to write the job `failed`. A budget that
        merely equals the ceiling turns a slow generation into a silent kill and
        an eternal `running` row, which is what was observed live.
        """
        from shared.aws import BEDROCK_MAX_ATTEMPTS, BEDROCK_READ_TIMEOUT_SECONDS

        budget = BEDROCK_READ_TIMEOUT_SECONDS * BEDROCK_MAX_ATTEMPTS

        assert budget < self.MAX_LAMBDA_TIMEOUT_SECONDS, (
            f'the Bedrock read budget ({budget}s) is not smaller than the longest '
            f'possible Lambda timeout ({self.MAX_LAMBDA_TIMEOUT_SECONDS}s), so the '
            f'last attempt is always killed in flight'
        )
        # Enough for a DynamoDB status write plus unwinding, generously: the point
        # is that the reserve is DELIBERATE, not whatever rounding left behind.
        assert self.MAX_LAMBDA_TIMEOUT_SECONDS - budget >= 30, (
            'too little of the invocation is left after the read timeout fires '
            'for the handler to record the failure'
        )


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
