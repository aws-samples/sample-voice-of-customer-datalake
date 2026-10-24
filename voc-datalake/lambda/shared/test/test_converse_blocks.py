"""``shared.converse.converse_blocks``: the one path for Converse calls whose turn is not plain text.

Persona import (image), design references (image), email intake (attachments) and
the product interview (tool use) once built their own requests. Each former request
is written out below as the literal it was, and the new call must hand boto exactly
those kwargs (the callers' own suites pin the same requests from their side).
"""
from __future__ import annotations

from typing import Any
from unittest.mock import MagicMock, patch

import pytest

from email_intake import model_calls
from email_intake.mime import Attachment
from shared import model_config
from shared.converse import DEFAULT_MAX_RETRIES, build_blocks_request, converse_blocks

MODEL = 'global.anthropic.test-model'
NO_TEMPERATURE_MODEL = sorted(model_config._OMIT_TEMPERATURE_IDS)[0]
IMAGE = [{'image': {'format': 'png', 'source': {'bytes': b'img'}}}, {'text': 'Describe it.'}]


@pytest.fixture
def retry():
    """The shared retry policy, recorded and run once."""
    recorder = MagicMock(side_effect=lambda call, **_kwargs: call())
    with patch('shared.converse.bedrock_call_with_retry', recorder):
        yield recorder


def _client(answer: dict | None = None) -> Any:
    client = MagicMock()
    client.converse.return_value = answer if answer is not None else {'output': {'message': {'content': []}}}
    return client


class TestTheRequest:
    def test_an_image_turn_carries_the_system_prompt_and_the_budget_only(self):
        assert build_blocks_request(MODEL, messages=[{'role': 'user', 'content': IMAGE}],
                                    system_prompt='S', max_tokens=100) == {
            'modelId': MODEL, 'system': [{'text': 'S'}],
            'messages': [{'role': 'user', 'content': IMAGE}], 'inferenceConfig': {'maxTokens': 100},
        }

    def test_a_temperature_is_sent_only_to_a_model_that_accepts_it(self):
        def config(model: str) -> dict:
            return build_blocks_request(model, messages=[], system_prompt='S', max_tokens=10,
                                        temperature=0.3)['inferenceConfig']
        assert config(MODEL) == {'maxTokens': 10, 'temperature': 0.3}
        assert config(NO_TEMPERATURE_MODEL) == {'maxTokens': 10}

    def test_no_system_block_without_a_system_prompt_and_a_tool_config_when_given(self):
        kwargs = build_blocks_request(MODEL, messages=[], system_prompt='', max_tokens=10,
                                      tool_config={'tools': []})
        assert 'system' not in kwargs
        assert kwargs['toolConfig'] == {'tools': []}

    def test_an_eu_deployment_sends_the_eu_profile(self, monkeypatch: pytest.MonkeyPatch):
        monkeypatch.setenv(model_config.INFERENCE_SCOPE_ENV, 'eu')
        assert build_blocks_request(MODEL, messages=[], system_prompt='', max_tokens=1)['modelId'] == \
            'eu.anthropic.test-model'


class TestTheCall:
    def test_the_surfaces_model_is_resolved_and_the_raw_response_returned(self, retry):
        answer = {'output': {'message': {'content': [{'toolUse': {'name': 't', 'input': {}}}]}}}
        client = _client(answer)
        with patch('shared.converse.get_active_model_id', return_value=MODEL) as model:
            assert converse_blocks(client, IMAGE, surface='documents', system_prompt='S', max_tokens=5,
                                   step_name='step') is answer
        model.assert_called_once_with('documents')
        client.converse.assert_called_once_with(
            modelId=MODEL, system=[{'text': 'S'}], messages=[{'role': 'user', 'content': IMAGE}],
            inferenceConfig={'maxTokens': 5},
        )
        assert retry.call_args.kwargs == {'max_retries': DEFAULT_MAX_RETRIES, 'step_name': 'step',
                                          'call_label': 'the Bedrock call'}

    @pytest.mark.usefixtures('retry')
    def test_a_resolved_model_id_is_used_as_given(self):
        client = _client()
        with patch('shared.converse.get_active_model_id') as model:
            converse_blocks(client, IMAGE, surface='documents', model_id=MODEL, system_prompt='S',
                            max_tokens=5, step_name='step')
        model.assert_not_called()
        assert client.converse.call_args.kwargs['modelId'] == MODEL

    @pytest.mark.usefixtures('retry')
    def test_prior_turns_go_before_the_user_turn(self):
        client = _client()
        prior = [{'role': 'user', 'content': [{'text': 'a'}]}, {'role': 'assistant', 'content': [{'text': 'b'}]}]
        with patch('shared.converse.get_active_model_id', return_value=MODEL):
            converse_blocks(client, [{'text': 'c'}], surface='chat', system_prompt='S', max_tokens=5,
                            prior_turns=prior, step_name='step')
        assert client.converse.call_args.kwargs['messages'] == [
            *prior, {'role': 'user', 'content': [{'text': 'c'}]},
        ]

    def test_the_retry_policy_settings_pass_through(self, retry):
        with patch('shared.converse.get_active_model_id', return_value=MODEL):
            converse_blocks(_client(), IMAGE, surface='utility', system_prompt='S', max_tokens=5,
                            max_retries=2, step_name='s', call_label='client.converse(image)')
        assert retry.call_args.kwargs == {'max_retries': 2, 'step_name': 's', 'call_label': 'client.converse(image)'}


class TestTheEmailAttachmentRequestIsUnchanged:
    """Formerly build_single_turn_request(temperature=None) with the blocks put before the text."""

    def test_every_attachment_then_the_fenced_subject_with_no_temperature(self, retry):
        client = _client({'output': {'message': {'content': [{'text': '[]'}]}}})
        attachments = [Attachment('invoice.pdf', 'application/pdf', 'document', 3, b'pdf'),
                       Attachment('shot.png', 'image/png', 'image', 3, b'png')]
        with patch('shared.converse.get_active_model_id', return_value=MODEL) as model:
            model_calls.summarise_attachments(client, 'Hello', attachments)
        model.assert_called_once_with(model_calls.SURFACE)
        prompt = (f'{model_calls.data_block("email", "Subject: Hello")}\n\n'
                  'The attachments, in order:\n1. Attachment 1\n2. Attachment 2\n\nAnswer the JSON array.')
        client.converse.assert_called_once_with(
            modelId=MODEL,
            messages=[{'role': 'user', 'content': [
                {'document': {'format': 'pdf', 'name': 'Attachment 1', 'source': {'bytes': b'pdf'}}},
                {'image': {'format': 'png', 'source': {'bytes': b'png'}}},
                {'text': prompt},
            ]}],
            inferenceConfig={'maxTokens': model_calls._SUMMARY_MAX_TOKENS},
            system=[{'text': model_calls._SUMMARY_SYSTEM}],
        )
        assert retry.call_args.kwargs == {'max_retries': DEFAULT_MAX_RETRIES, 'step_name': 'email_attachments',
                                          'call_label': 'Converse (email attachments)'}
