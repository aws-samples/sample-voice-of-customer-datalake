"""Shared arrange blocks for the shared/model_capacity.py suites.

moto covers neither bedrock-runtime nor service-quotas, so both clients are real
boto3 clients wrapped in botocore Stubbers and injected through the module's
client cache. A Stubber also proves the exact request on the wire.
"""
from collections.abc import Iterator
from contextlib import contextmanager

import boto3
import pytest
from botocore.stub import Stubber

from shared import model_capacity, model_quota_store
from shared.model_config import scope_bedrock_client

OPUS55 = 'global.anthropic.claude-opus-5-5'
GLOBAL = 'Global cross-region model inference tokens per minute for Anthropic '
GEO = 'Cross-region model inference tokens per minute for Anthropic '
OK_RESPONSE = {
    'output': {'message': {'role': 'assistant', 'content': [{'text': 'OK'}]}},
    'stopReason': 'end_turn',
    'usage': {'inputTokens': 5, 'outputTokens': 1, 'totalTokens': 6},
    'metrics': {'latencyMs': 120},
}


def quota_entry(name: str, value: float) -> dict:
    return {'ServiceCode': 'bedrock', 'QuotaCode': 'L-TEST0001', 'QuotaName': name, 'Value': value}


class World:
    """Stubbed bedrock-runtime + service-quotas clients behind the module's client cache."""

    def __init__(self, region: str = 'us-east-1') -> None:
        self.bedrock = scope_bedrock_client(boto3.client('bedrock-runtime', region_name=region))
        self.quotas = boto3.client('service-quotas', region_name=region)
        self.bedrock_stub = Stubber(self.bedrock)
        self.quotas_stub = Stubber(self.quotas)

    def list_quotas(self, *pages: list[dict]) -> None:
        """Queue one ListServiceQuotas listing made of ``pages``."""
        for index, page in enumerate(pages):
            response: dict = {'Quotas': page}
            if index + 1 < len(pages):
                response['NextToken'] = f'page-{index + 1}'
            expected: dict = {'ServiceCode': 'bedrock', 'MaxResults': 100}
            if index > 0:
                expected['NextToken'] = f'page-{index}'
            self.quotas_stub.add_response('list_service_quotas', response, expected)

    def converse_ok(self, expected: dict | None = None) -> None:
        self.bedrock_stub.add_response('converse', OK_RESPONSE, expected)

    def converse_error(self, code: str, message: str = 'boom', status: int = 400) -> None:
        self.bedrock_stub.add_client_error('converse', service_error_code=code, service_message=message,
                                           http_status_code=status)


@contextmanager
def stubbed_world(monkeypatch: pytest.MonkeyPatch) -> Iterator[World]:
    """A World installed in the module (no inference scope, empty quota cache); every stub consumed."""
    monkeypatch.delenv('BEDROCK_INFERENCE_SCOPE', raising=False)
    model_capacity.clear_quota_cache()
    # No stored copy unless a test installs one (model_quota_store's own suite does).
    monkeypatch.setattr(model_quota_store, '_table', lambda: None)
    created = World()
    monkeypatch.setattr(model_capacity, '_clients', {'bedrock-runtime': created.bedrock,
                                                     'service-quotas': created.quotas})
    with created.bedrock_stub, created.quotas_stub:
        yield created
        created.bedrock_stub.assert_no_pending_responses()
        created.quotas_stub.assert_no_pending_responses()
    model_capacity.clear_quota_cache()


def probe_with_error(world: World, code: str, message: str = 'boom', quota: float | None = None) -> model_capacity.ProbeResult:
    """Probe Opus 5.5 against a ``code`` error, with its global quota at ``quota`` (None = not listed)."""
    world.converse_error(code, message)
    world.list_quotas([quota_entry(GLOBAL + 'Claude Opus 5.5', quota)] if quota is not None else [])
    return model_capacity.probe_model(OPUS55)
