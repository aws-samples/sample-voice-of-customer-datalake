"""Mutation hardening for `shared/embeddings.py`.

No test targeted this module directly: the memory-store suites patch
`embed_text` out and only import `EMBED_DIMENSIONS`. A mutation run found that
nothing observed:

* the exact Bedrock request — model id (env override, stripped, else the
  Titan V2 default), the JSON body (`inputText`, `dimensions`, `normalize`),
  the content types, and the retry budget/labels handed to
  `bedrock_call_with_retry`;
* the input bound: text is stripped and cut at exactly 20,000 characters;
* every refusal and its wording: blank or `None` text, a missing body, a
  non-JSON body, and each malformed vector shape (not a dict, no list, wrong
  length, a non-number, a `bool` posing as a number);
* that the returned vector is converted to `float` element by element.
"""
import io
import json
import re
from collections.abc import Callable, Iterator
from typing import Any
from unittest.mock import MagicMock, patch

import pytest

from shared import embeddings
from shared.embeddings import embed_model_id, embed_text
from shared.exceptions import ServiceError

DIMENSIONS = 1024


def _body(payload: object) -> dict[str, io.BytesIO]:
    return {'body': io.BytesIO(json.dumps(payload).encode())}


def _vector(value: float = 0.5) -> list[float]:
    return [value] * DIMENSIONS


@pytest.fixture(autouse=True)
def _no_env_override(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv('MEMORY_EMBED_MODEL_ID', raising=False)


class _Bedrock:
    """The fake client and the patched retry wrapper (which runs the call once and records how it was asked)."""

    def __init__(self, client: MagicMock, retry: MagicMock) -> None:
        self.client = client
        self.retry = retry


@pytest.fixture
def bedrock() -> Iterator[Callable[[object], _Bedrock]]:
    client = MagicMock()
    with patch.object(embeddings, 'get_bedrock_client', return_value=client), \
            patch.object(embeddings, 'bedrock_call_with_retry',
                         side_effect=lambda call, **_kwargs: call()) as retry:
        def install(response: object) -> _Bedrock:
            client.invoke_model.return_value = response
            return _Bedrock(client, retry)
        yield install


def _sent_body(fake: _Bedrock) -> dict[str, Any]:
    return json.loads(fake.client.invoke_model.call_args.kwargs['body'])


class TestTheModelId:
    def test_defaults_to_titan_v2(self) -> None:
        assert embed_model_id() == 'amazon.titan-embed-text-v2:0'

    def test_env_override_is_stripped(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv('MEMORY_EMBED_MODEL_ID', '  custom.embed-v9:1  ')
        assert embed_model_id() == 'custom.embed-v9:1'

    def test_blank_env_falls_back_to_default(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv('MEMORY_EMBED_MODEL_ID', '   ')
        assert embed_model_id() == 'amazon.titan-embed-text-v2:0'


class TestTheExactBedrockRequest:
    def test_invoke_model_arguments(self, bedrock: Callable[[object], _Bedrock]) -> None:
        fake = bedrock(_body({'embedding': _vector()}))
        embed_text('  hello world  ')
        fake.client.invoke_model.assert_called_once_with(
            modelId='amazon.titan-embed-text-v2:0',
            body='{"inputText": "hello world", "dimensions": 1024, "normalize": true}',
            contentType='application/json',
            accept='application/json',
        )

    def test_env_model_id_reaches_the_request(
        self, bedrock: Callable[[object], _Bedrock], monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        monkeypatch.setenv('MEMORY_EMBED_MODEL_ID', 'custom.embed-v9:1')
        fake = bedrock(_body({'embedding': _vector()}))
        embed_text('x')
        assert fake.client.invoke_model.call_args.kwargs['modelId'] == 'custom.embed-v9:1'

    def test_retry_budget_and_labels(self, bedrock: Callable[[object], _Bedrock]) -> None:
        fake = bedrock(_body({'embedding': _vector()}))
        embed_text('x')
        fake.retry.assert_called_once()
        assert fake.retry.call_args.kwargs == {
            'max_retries': 3, 'step_name': 'memory_embed', 'call_label': 'the embedding call',
        }

    @pytest.mark.parametrize(('length', 'sent'), [(20_000, 20_000), (20_001, 20_000), (19_999, 19_999)])
    def test_input_is_cut_at_20000_chars(
        self, bedrock: Callable[[object], _Bedrock], length: int, sent: int,
    ) -> None:
        fake = bedrock(_body({'embedding': _vector()}))
        embed_text('a' * length)
        assert _sent_body(fake)['inputText'] == 'a' * sent


class TestTheReturnedVector:
    def test_ints_become_floats(self, bedrock: Callable[[object], _Bedrock]) -> None:
        bedrock(_body({'embedding': [1] * DIMENSIONS}))
        result = embed_text('x')
        assert result == [1.0] * DIMENSIONS
        assert all(type(v) is float for v in result)

    def test_accepts_a_str_body(self, bedrock: Callable[[object], _Bedrock]) -> None:
        stream = MagicMock()
        stream.read.return_value = json.dumps({'embedding': _vector(0.25)})
        bedrock({'body': stream})
        assert embed_text('x') == _vector(0.25)


def _exact(message: str) -> str:
    return f'^{re.escape(message)}$'


class TestEveryRefusalNamesItsCause:
    @pytest.mark.parametrize('text', ['', '   \n\t', None])
    def test_blank_text(self, bedrock: Callable[[object], _Bedrock], text: str) -> None:
        fake = bedrock(_body({'embedding': _vector()}))
        with pytest.raises(ValueError, match=_exact('cannot embed blank text')):
            embed_text(text)
        fake.client.invoke_model.assert_not_called()

    def test_missing_body(self, bedrock: Callable[[object], _Bedrock]) -> None:
        bedrock({'ResponseMetadata': {}})
        with pytest.raises(ServiceError, match=_exact('Embedding call returned no body')):
            embed_text('x')

    def test_body_not_json(self, bedrock: Callable[[object], _Bedrock]) -> None:
        bedrock({'body': io.BytesIO(b'not json')})
        with pytest.raises(ServiceError, match=_exact('Embedding response was not JSON')):
            embed_text('x')

    @pytest.mark.parametrize('payload', [
        [0.5] * DIMENSIONS,
        {},
        {'embedding': 'vector'},
        {'embedding': [0.5] * (DIMENSIONS - 1)},
        {'embedding': [0.5] * (DIMENSIONS + 1)},
        {'embedding': [*([0.5] * (DIMENSIONS - 1)), '0.5']},
        {'embedding': [*([0.5] * (DIMENSIONS - 1)), True]},
        {'embedding': [*([0.5] * (DIMENSIONS - 1)), None]},
    ])
    def test_unexpected_shape(self, bedrock: Callable[[object], _Bedrock], payload: object) -> None:
        bedrock(_body(payload))
        with pytest.raises(ServiceError, match=_exact('Embedding response had an unexpected shape')):
            embed_text('x')
