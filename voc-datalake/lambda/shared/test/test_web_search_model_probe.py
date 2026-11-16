"""The web search surface's Test (shared/web_search_model_probe.py) and the Responses API call it shares with the
ingestor (shared/mantle_responses.py).

* ONE request to exactly the model, on the app region's mantle endpoint, SigV4 for ``bedrock-mantle``, with no
  tool and at most 16 output tokens, inside the settings Lambda's budget;
* the answer in the Claude test's shape (no quota), its status read from the HTTP answer: available, no access,
  no capacity, throttled, not in this region, unavailable, error;
* ``cannot_serve``: what moves the ingestor's read to the next model (429 / 503, or a refusal naming the model's
  availability), and what does not (the request's own shape, a denied role, no answer).
"""
import json
from typing import Any
from unittest.mock import patch

import pytest
from botocore.credentials import Credentials

from shared import web_search_model_probe as probe
from shared.mantle_responses import ResponsesError, cannot_serve, failure_reason, responses_url

SOL = 'openai.gpt-5.6-sol'
CREDENTIALS = Credentials('AKIDEXAMPLE', 'secret')


class Recorder:
    """A ``post`` that records what was sent and answers (status, body)."""

    def __init__(self, status: int, payload: object):
        self.status, self.payload = status, payload
        self.sent: list[tuple[str, dict[str, Any], dict[str, str], float]] = []

    def __call__(self, url: str, body: bytes, headers: dict[str, str], timeout: float) -> tuple[int, bytes]:
        self.sent.append((url, json.loads(body), headers, timeout))
        raw = self.payload if isinstance(self.payload, bytes) else json.dumps(self.payload).encode()
        return self.status, raw


def run(status: int, payload: object) -> tuple[dict[str, Any], Recorder]:
    post = Recorder(status, payload)
    with patch.object(probe, 'app_region', return_value='us-west-2'), \
            patch.object(probe.boto3, 'Session') as session:
        session.return_value.get_credentials.return_value = CREDENTIALS
        return dict(probe.probe_web_search_model(SOL, post=post)), post


class TestTheRequest:
    def test_one_tiny_request_to_exactly_the_model_with_no_tool(self):
        result, post = run(200, {'output': [{'type': 'message'}]})
        [(url, body, headers, timeout)] = post.sent
        assert url == responses_url('us-west-2') == 'https://bedrock-mantle.us-west-2.api.aws/openai/v1/responses'
        assert body == {'model': SOL, 'input': 'Reply with OK', 'max_output_tokens': 16}
        assert '/us-west-2/bedrock-mantle/aws4_request' in headers['Authorization']
        assert timeout == 20
        assert (result['model_id'], result['invoked_id'], result['status'], result['ok']) == (SOL, SOL, 'available', True)
        assert result['quota'] is None
        assert result['latency_ms'] is not None
        assert result['message'] == 'The model answered.'


class TestTheStatus:
    @pytest.mark.parametrize(('status', 'payload', 'expected'), [
        (403, {'message': 'not authorized to perform: bedrock-mantle:CreateInference'}, 'no_access'),
        (401, {'message': 'denied'}, 'no_access'),
        (400, {'error': {'message': 'You do not have a subscription to this model'}}, 'no_access'),
        (429, {'error': {'message': 'Insufficient capacity for this model'}}, 'no_capacity'),
        (429, {'error': {'message': 'Token quota exceeded'}}, 'no_capacity'),
        (429, {'error': {'message': 'Too many requests'}}, 'throttled'),
        (503, {'error': {'message': 'No capacity available'}}, 'no_capacity'),
        (503, b'Service Unavailable', 'unavailable'),
        (500, b'oops', 'unavailable'),
        (404, {'error': {'message': 'Not found'}}, 'not_in_region'),
        (400, {'error': {'message': 'The model openai.gpt-5.6-sol does not exist'}}, 'not_in_region'),
        (400, {'error': {'message': "Unsupported parameter: 'max_output_tokens'"}}, 'error'),
    ])
    def test_is_read_from_the_http_answer(self, status, payload, expected):
        result, _post = run(status, payload)
        assert (result['status'], result['ok'], result['latency_ms']) == (expected, False, None)
        assert result['message'].endswith(f'(HTTP {status})')

    def test_no_answer_is_unavailable(self):
        def silent(*_args: object) -> tuple[int, bytes]:
            raise TimeoutError('timed out')

        with patch.object(probe, 'app_region', return_value='us-west-2'), \
                patch.object(probe.boto3, 'Session') as session:
            session.return_value.get_credentials.return_value = CREDENTIALS
            result = probe.probe_web_search_model(SOL, post=silent)
        assert (result['status'], result['message']) == (
            'unavailable', 'The model is temporarily unavailable; retry later. (no answer)')

    def test_no_credentials_is_an_error_and_nothing_is_sent(self):
        post = Recorder(200, {})
        with patch.object(probe, 'app_region', return_value='us-west-2'), \
                patch.object(probe.boto3, 'Session') as session:
            session.return_value.get_credentials.return_value = None
            result = probe.probe_web_search_model(SOL, post=post)
        assert (result['status'], result['message']) == ('error', 'The test request failed. (NoCredentialsError)')
        assert post.sent == []


class TestWhatMovesTheReadToTheNextModel:
    @pytest.mark.parametrize(('error', 'expected'), [
        (ResponsesError('HTTP 429: Too many requests', 429), True),
        (ResponsesError('HTTP 503: Service Unavailable', 503), True),
        (ResponsesError("HTTP 403: You don't have access to the model with the specified model ID.", 403), True),
        (ResponsesError('HTTP 404: The model is not available in this region', 404), True),
        (ResponsesError('HTTP 403: not authorized to perform: bedrock-mantle:CreateInference', 403), False),
        (ResponsesError("HTTP 400: Unsupported parameter: 'text.format'", 400), False),
        (ResponsesError('HTTP 500: oops', 500), False),
        (ResponsesError('no answer (TimeoutError)'), False),
        (RuntimeError('HTTP 429'), False),
    ])
    def test_throttling_and_capacity_only(self, error, expected):
        assert cannot_serve(error) is expected

    def test_the_reason_is_the_status_or_no_answer(self):
        assert failure_reason(ResponsesError('HTTP 429: x', 429)) == 'HTTP 429'
        assert failure_reason(ResponsesError('no answer (TimeoutError)')) == 'no answer'
        assert failure_reason(ValueError('x')) == 'ValueError'
