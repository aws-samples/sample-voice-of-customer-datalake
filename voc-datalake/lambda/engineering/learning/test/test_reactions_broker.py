"""The runtime's call of the broker's ``reactions`` (learning/reactions_broker.py, 7.10.00): one signed POST to the
function URL, sent once, its answer's ``reactions``; any refusal or unreadable answer is ``BrokerUnavailable``."""
from __future__ import annotations

import http.client
import io
import json
import urllib.error
import urllib.request
from email.message import Message
from typing import Any

import pytest

from engineering.learning.reactions_broker import (
    MAX_ANSWER_BYTES,
    BrokerReactions,
    BrokerUnavailable,
    function_url,
)
from engineering.runtime.test.broker_stub import Answer
from engineering.runtime.test.conftest import FakeCredentials

URL = 'https://brk456ghi.lambda-url.us-east-1.on.aws/'
RUN = '01JD3R4NZXQ7Y2W8K4M6P9T0AB'


class Opener:
    def __init__(self, reply: object) -> None:
        self.reply, self.sent = reply, []

    def open(self, request: urllib.request.Request, timeout: float) -> Any:
        self.sent.append((request, timeout))
        if isinstance(self.reply, Exception):
            raise self.reply
        return Answer(self.reply if isinstance(self.reply, bytes) else json.dumps(self.reply).encode())


def call(reply: object) -> tuple[object, Opener]:
    opener = Opener(reply)
    return BrokerReactions(URL, 'us-east-1', FakeCredentials(), opener=opener)(RUN), opener


def test_one_signed_post_of_the_reactions_operation_answers_its_reactions() -> None:
    found, opener = call({'result': {'reactions': {'schema': 'voc-reactions/1'}}})
    assert found == {'schema': 'voc-reactions/1'}
    [(request, timeout)] = opener.sent
    assert (request.full_url, request.get_method(), timeout) == (URL, 'POST', 125)
    assert json.loads(request.data or b'') == {'operation': 'reactions', 'args': {'run_id': RUN}}
    assert request.headers['Authorization'].startswith('AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/')


def test_no_recorded_pull_request_is_none() -> None:
    assert call({'result': {'reactions': None}})[0] is None


@pytest.mark.parametrize('reply', [
    urllib.error.HTTPError(URL, 403, 'Forbidden', Message(), io.BytesIO(b'{"Message": "Forbidden"}')),
    urllib.error.URLError('reset'), TimeoutError(), b'not json', b'x' * (MAX_ANSWER_BYTES + 1), {'result': 'page'},
    {'error': 'The run has not ended.'}, [1, 2],
], ids=['refused', 'lost', 'timeout', 'not-json', 'too-large', 'no-result', 'error', 'not-object'])
def test_anything_but_an_answer_with_reactions_is_unavailable_and_sent_once(reply: object) -> None:
    opener = Opener(reply)
    with pytest.raises(BrokerUnavailable):
        BrokerReactions(URL, 'us-east-1', FakeCredentials(), opener=opener)(RUN)
    assert len(opener.sent) == 1


@pytest.mark.parametrize('url', ['http://brk456ghi.lambda-url.us-east-1.on.aws/', 'https://example.org/',
                                 'https://brk456ghi.lambda-url.us-east-1.on.aws:8443/',
                                 'https://brk456ghi.lambda-url.us-east-1.on.aws/x?y=1'])
def test_only_a_function_urls_own_address_is_called(url: str) -> None:
    with pytest.raises(BrokerUnavailable, match='not a function URL'):
        function_url(url)
    assert function_url(URL.rstrip('/')) == URL


def test_a_redirect_is_never_followed() -> None:
    from engineering.learning.reactions_broker import _NoFollow

    request = urllib.request.Request(URL, data=b'{}', method='POST')
    assert _NoFollow().redirect_request(request, io.BytesIO(), 302, 'Found', http.client.HTTPMessage(),
                                        'https://elsewhere.example') is None
