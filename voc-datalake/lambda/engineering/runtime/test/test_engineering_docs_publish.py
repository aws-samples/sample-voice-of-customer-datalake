"""voc-engineering-start's ``publish_docs`` (7.52.00, runtime/docs_publish.py and handler.start_handler): the request
handed to the broker's ``push_approved_docs`` as the start's own role, its answer opened, repeated or refused."""
from __future__ import annotations

import json
from typing import Any

import pytest

from engineering.learning.reactions_broker import BrokerAnswered, BrokerUnavailable
from engineering.runtime import handler
from engineering.runtime.docs_publish import DocsRefused, DocsUnavailable, publish, request_args
from engineering.runtime.interface import RuntimeRefused

DIGEST = 'd' * 64
EVENT = {'action': 'publish_docs', 'connection': 'conn-1', 'repository': 'example-org/harbor',
         'default_branch': 'main', 'kind': 'knowledge', 'digest': DIGEST, 'draft': False, 'actor': 'admin-sub-1'}
PR = {'number': 12, 'url': 'https://github.com/example-org/harbor/pull/12', 'branch': 'voc-agent/docs/knowledge-v3'}


class Broker:
    def __init__(self, answer: Any) -> None:
        self.answer, self.asked = answer, []

    def __call__(self, args: Any) -> bytes:
        self.asked.append(dict(args))
        if isinstance(self.answer, Exception):
            raise self.answer
        return json.dumps(self.answer).encode()


def test_the_request_is_the_brokers_args_from_the_event() -> None:
    assert request_args(EVENT) == {'connection': 'conn-1', 'repository': 'example-org/harbor',
                                   'default_branch': 'main', 'kind': 'knowledge', 'digest': DIGEST,
                                   'requested_by': 'admin-sub-1', 'draft': False}


@pytest.mark.parametrize('change', [{'kind': 'code'}, {'digest': 'abc'}, {'actor': ''}, {'draft': 'no'},
                                    {'connection': ''}])
def test_an_event_off_its_shape_is_refused_before_the_broker(change: dict[str, Any]) -> None:
    broker = Broker({})
    with pytest.raises(DocsRefused):
        publish({**EVENT, **change}, broker)
    assert broker.asked == []


def test_an_opened_and_a_repeated_pull_request() -> None:
    result = {'pr': PR, 'kind': 'knowledge', 'version': 3, 'digest': DIGEST, 'draft': False, 'repeated': False}
    assert publish(EVENT, Broker({'result': result})) == {
        'status': 'opened', 'pr': PR, 'kind': 'knowledge', 'version': 3, 'digest': DIGEST, 'draft': False}
    again = publish(EVENT, Broker({'result': {**result, 'repeated': True}}))
    assert again['status'] == 'repeated'


def test_a_refusal_is_answered_with_its_status_reason_and_code() -> None:
    refused = publish(EVENT, Broker(BrokerAnswered(409, 'You work Human-driven.', 'human_driven')))
    assert refused == {'status': 'refused', 'http_status': 409, 'reason': 'You work Human-driven.',
                       'code': 'human_driven'}
    other = publish(EVENT, Broker(BrokerAnswered(422, 'Not docs.', 'made_up')))
    assert other['code'] == ''


@pytest.mark.parametrize('answer', [BrokerUnavailable('lost'), {'result': {'pr': {'number': 0, 'url': 'x'}}},
                                    {'error': 'x'}])
def test_a_broker_out_of_reach_or_off_its_shape_is_not_known(answer: Any) -> None:
    with pytest.raises(DocsUnavailable):
        publish(EVENT, Broker(answer))


def test_the_start_takes_the_action_as_its_own_role(monkeypatch: pytest.MonkeyPatch) -> None:
    sent: list[dict[str, Any]] = []

    def call(url: str, _region: str, _credentials: Any, operation: str, args: dict[str, object], **_: Any) -> bytes:
        sent.append({'url': url, 'operation': operation, **args})
        return json.dumps({'result': {'pr': PR, 'kind': 'knowledge', 'version': 3, 'digest': DIGEST,
                                      'draft': False, 'repeated': False}}).encode()

    monkeypatch.setenv('ENGINEERING_BROKER_URL', 'https://abc.lambda-url.us-east-1.on.aws/')
    monkeypatch.setattr('engineering.runtime.docs_publish.signed_call', call)
    monkeypatch.setattr(handler, '_own_credentials', object)
    assert handler.start_handler(EVENT, None)['status'] == 'opened'
    assert sent[0]['operation'] == 'push_approved_docs'
    with pytest.raises(RuntimeRefused):
        handler.start_handler({**EVENT, 'kind': 'code'}, None)
