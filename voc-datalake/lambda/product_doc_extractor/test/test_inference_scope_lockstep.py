"""The extractor's EU inference-scope mapping must equal shared/model_config.py's.

The extractor cannot import `shared/` (see the handler docstring), so
`_invocation_model_id` is a second copy of `invocation_model_id`. An EU
deployment is granted ONLY the `eu.` profiles, so a drift here would make every
image description in an EU deployment fail AccessDenied.
"""
import pytest

from product_doc_extractor import handler
from shared.model_config import invocation_model_id
from shared.test.test_inference_scope import assert_wire_model_id

CASES = [
    'global.anthropic.claude-sonnet-5',
    'global.anthropic.claude-haiku-4-5-20251001-v1:0',
    'eu.anthropic.claude-sonnet-5',
    'amazon.titan-embed-text-v2:0',
]


@pytest.mark.parametrize('scope', ['', 'global', 'eu', 'EU ', 'apac'])
@pytest.mark.parametrize('model_id', CASES)
def test_mapping_matches_shared(monkeypatch, scope, model_id):
    monkeypatch.setenv('BEDROCK_INFERENCE_SCOPE', scope)
    assert handler._invocation_model_id(model_id) == invocation_model_id(model_id)


def test_the_bedrock_client_rewrites_the_wire_id(monkeypatch):
    monkeypatch.setenv('BEDROCK_INFERENCE_SCOPE', 'eu')
    monkeypatch.setenv('AWS_DEFAULT_REGION', 'eu-central-1')
    monkeypatch.setattr(handler, '_clients', {})
    assert_wire_model_id(handler._bedrock(), 'eu.anthropic.claude-sonnet-5')


def test_the_client_is_built_once(monkeypatch):
    monkeypatch.setenv('AWS_DEFAULT_REGION', 'eu-central-1')
    monkeypatch.setattr(handler, '_clients', {})
    assert handler._bedrock() is handler._bedrock()
