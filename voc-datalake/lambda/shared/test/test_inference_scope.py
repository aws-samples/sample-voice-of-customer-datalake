"""EU inference scope at call time (docs/eu-deployment.md).

An EU deployment sets BEDROCK_INFERENCE_SCOPE=eu and is granted only the `eu.`
inference profiles, so the id on the wire must be the `eu.` twin while every
stored / allowlisted / capability-checked id stays canonical (`global.`).
"""
import re
from unittest.mock import MagicMock, patch

import boto3
import pytest
from botocore.stub import Stubber

from shared import avatar
from shared.converse import converse_detailed
from shared.model_config import (
    ALLOWED_MODEL_IDS,
    get_active_model_id,
    inference_scope,
    invocation_model_id,
    scope_bedrock_client,
)
from shared.test.repo_paths import repo_root

SONNET5 = 'global.anthropic.claude-sonnet-5'
SONNET55 = 'global.anthropic.claude-sonnet-5-5'
HAIKU45 = 'global.anthropic.claude-haiku-4-5-20251001-v1:0'
CDK_ALLOWLIST = repo_root() / 'lib' / 'utils' / 'model-allowlist.ts'


@pytest.fixture
def eu(monkeypatch):
    monkeypatch.setenv('BEDROCK_INFERENCE_SCOPE', 'eu')


class TestInvocationModelId:
    def test_global_scope_keeps_the_canonical_id(self, monkeypatch):
        monkeypatch.delenv('BEDROCK_INFERENCE_SCOPE', raising=False)
        assert invocation_model_id(SONNET5) == SONNET5

    @pytest.mark.usefixtures('eu')
    def test_eu_scope_swaps_the_global_prefix(self):
        assert invocation_model_id(HAIKU45) == 'eu.anthropic.claude-haiku-4-5-20251001-v1:0'

    @pytest.mark.usefixtures('eu')
    @pytest.mark.parametrize('model_id', ['eu.anthropic.claude-sonnet-5', 'amazon.titan-embed-text-v2:0'])
    def test_eu_scope_leaves_non_global_ids_alone(self, model_id):
        assert invocation_model_id(model_id) == model_id

    def test_an_unknown_scope_is_global(self, monkeypatch):
        monkeypatch.setenv('BEDROCK_INFERENCE_SCOPE', 'mars')
        assert inference_scope() == 'global'
        assert invocation_model_id(SONNET5) == SONNET5

    @pytest.mark.usefixtures('eu')
    def test_the_picker_still_resolves_and_allowlists_canonical_ids(self, monkeypatch):
        monkeypatch.delenv('AGGREGATES_TABLE', raising=False)
        assert get_active_model_id('documents') == SONNET55
        assert all(model_id.startswith('global.') for model_id in ALLOWED_MODEL_IDS)

    @pytest.mark.usefixtures('eu')
    def test_every_allowlisted_model_maps_to_the_profile_cdk_grants(self):
        # The CDK grant is `eu.` + the foundation id (scopedModelId); the Python
        # mapping must produce exactly those ids or every EU call is AccessDenied.
        source = CDK_ALLOWLIST.read_text(encoding='utf-8')
        assert "`eu.${toFoundationModelId(canonicalId)}`" in source
        assert re.search(r"replace\(/\^global\\\./, ''\)", source)
        assert {invocation_model_id(m) for m in ALLOWED_MODEL_IDS} == {'eu.' + m[len('global.'):] for m in ALLOWED_MODEL_IDS}


@pytest.mark.usefixtures('eu')
class TestConverseSendsTheScopedId:
    def test_the_wire_id_is_eu_and_the_reported_id_is_canonical(self):
        client = MagicMock()
        client.converse.return_value = {'output': {'message': {'content': [{'text': 'ok'}]}}, 'stopReason': 'end_turn'}
        with patch('shared.converse.get_bedrock_client', return_value=client), \
                patch('shared.converse.get_active_model_id', return_value=SONNET5):
            result = converse_detailed('hi', surface='documents', temperature=0.2)

        sent = client.converse.call_args.kwargs
        assert sent['modelId'] == 'eu.anthropic.claude-sonnet-5'
        assert result.model_id == SONNET5
        # Capabilities were checked on the canonical id: Sonnet 5 rejects temperature.
        assert 'temperature' not in sent['inferenceConfig']


class TestAvatarsFlag:
    @pytest.mark.parametrize(('value', 'enabled'), [('false', False), ('FALSE', False), ('true', True), ('', True)])
    def test_only_false_disables(self, monkeypatch, value, enabled):
        monkeypatch.setenv('AVATARS_ENABLED', value)
        assert avatar.avatars_enabled() is enabled

    def test_disabled_avatars_spend_no_model_call(self, monkeypatch):
        monkeypatch.setenv('AVATARS_ENABLED', 'false')
        monkeypatch.setenv('RAW_DATA_BUCKET', 'bucket')
        with patch.object(avatar, 'generate_avatar_prompt_with_llm') as prompt, \
                patch.object(avatar, 'get_image_model_client') as image_client:
            result = avatar.generate_persona_avatar({'persona_id': 'p1', 'name': 'Ada'}, project_id='proj')

        assert result == {'avatar_url': None, 'avatar_prompt': None}
        prompt.assert_not_called()
        image_client.assert_not_called()


def assert_wire_model_id(client, expected_model_id: str) -> None:
    """Send one converse with the canonical SONNET5 id and assert the id that reaches the wire."""
    stub = Stubber(client)
    stub.add_response('converse', {
        'output': {'message': {'role': 'assistant', 'content': [{'text': 'ok'}]}},
        'stopReason': 'end_turn',
        'usage': {'inputTokens': 1, 'outputTokens': 1, 'totalTokens': 2},
        'metrics': {'latencyMs': 1},
    }, {'modelId': expected_model_id, 'messages': [{'role': 'user', 'content': [{'text': 'hi'}]}]})
    with stub:
        client.converse(modelId=SONNET5, messages=[{'role': 'user', 'content': [{'text': 'hi'}]}])
    stub.assert_no_pending_responses()


class TestScopedRawClient:
    """Raw converse / invoke_model call sites bypass converse(); the client hook maps them."""

    @staticmethod
    def _stubbed_converse(expected_model_id: str) -> None:
        assert_wire_model_id(scope_bedrock_client(boto3.client('bedrock-runtime', region_name='eu-central-1')),
                             expected_model_id)

    @pytest.mark.usefixtures('eu')
    def test_eu_scope_rewrites_the_wire_id(self):
        self._stubbed_converse('eu.anthropic.claude-sonnet-5')

    def test_global_scope_sends_the_canonical_id(self, monkeypatch):
        monkeypatch.delenv('BEDROCK_INFERENCE_SCOPE', raising=False)
        self._stubbed_converse(SONNET5)

    def test_an_object_without_events_is_returned_unchanged(self):
        sentinel = object()
        assert scope_bedrock_client(sentinel) is sentinel


class TestSharedClientIsScoped:
    """shared/aws.get_bedrock_client is the ONE client most surfaces use; it must carry the hook."""

    @pytest.mark.usefixtures('eu')
    def test_the_cached_client_rewrites_the_wire_id(self, monkeypatch):
        import shared.aws as shared_aws

        monkeypatch.setenv('AWS_DEFAULT_REGION', 'eu-central-1')
        monkeypatch.setattr(shared_aws, '_bedrock_client', None)
        assert_wire_model_id(shared_aws.get_bedrock_client(), 'eu.anthropic.claude-sonnet-5')
