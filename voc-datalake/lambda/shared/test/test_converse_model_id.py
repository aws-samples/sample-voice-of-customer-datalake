"""A converse result names the model it ran on, so provenance never re-resolves it.

Re-resolving the picker after a call is wrong for long jobs: the picker caches
per container, so an admin switching the model mid-run makes a later lookup name
a model that answered nothing. These pin the reporting end of that contract.
"""
from unittest.mock import MagicMock, patch

import pytest

from shared.converse import converse_chain, converse_chain_detailed, converse_detailed

SURFACE_MODELS = {
    'documents': 'global.anthropic.claude-sonnet-5',
    'prototype': 'global.anthropic.claude-opus-5',
}
EXPLICIT = 'global.anthropic.claude-haiku-4-5-20251001-v1:0'


def _reply(text: str) -> dict:
    return {'output': {'message': {'content': [{'text': text}]}}, 'stopReason': 'end_turn'}


@pytest.fixture
def bedrock():
    """A Bedrock client answering 'first' then 'second', and a picker resolving
    each surface to its own model."""
    client = MagicMock()
    client.converse.side_effect = [_reply('first'), _reply('second')]
    with patch('shared.converse.get_bedrock_client', return_value=client), \
            patch('shared.converse.get_active_model_id', side_effect=SURFACE_MODELS.__getitem__):
        yield client


TWO_STEPS = [
    {'step_name': 'one', 'system': '', 'user': 'a'},
    {'step_name': 'two', 'system': '', 'user': 'b {previous}', 'surface': 'prototype'},
]


@pytest.mark.usefixtures('bedrock')
class TestModelIdIsReported:
    def test_an_explicit_model_is_the_reported_model(self):
        assert converse_detailed('hi', surface='documents', model_id=EXPLICIT).model_id == EXPLICIT

    def test_a_surface_resolved_model_is_the_reported_model(self):
        assert converse_detailed('hi', surface='prototype').model_id == SURFACE_MODELS['prototype']

    def test_the_detailed_chain_reports_each_steps_own_model(self):
        results = converse_chain_detailed(TWO_STEPS, surface='documents')

        assert [r.text for r in results] == ['first', 'second']
        assert [r.model_id for r in results] == [SURFACE_MODELS['documents'], SURFACE_MODELS['prototype']]

    def test_the_plain_chain_still_returns_texts(self):
        assert converse_chain(TWO_STEPS, surface='documents') == ['first', 'second']
