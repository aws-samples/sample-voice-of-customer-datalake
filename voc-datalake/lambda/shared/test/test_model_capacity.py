"""Tests for shared/model_capacity.py: the Settings model test and quota lookup.

moto covers neither bedrock-runtime nor service-quotas, so both clients are real
boto3 clients wrapped in botocore Stubbers and injected through the module's
client cache. A Stubber also proves the exact request on the wire.
"""
import boto3
import pytest
from botocore.exceptions import ReadTimeoutError
from botocore.stub import ANY, Stubber

from shared import model_capacity
from shared.model_config import ALLOWED_MODELS, scope_bedrock_client

OPUS55 = 'global.anthropic.claude-opus-5-5'
SONNET55 = 'global.anthropic.claude-sonnet-5-5'
HAIKU55 = 'global.anthropic.claude-haiku-5-5'
HAIKU45 = 'global.anthropic.claude-haiku-4-5-20251001-v1:0'
GLOBAL = 'Global cross-region model inference tokens per minute for Anthropic '
GEO = 'Cross-region model inference tokens per minute for Anthropic '
OK_RESPONSE = {
    'output': {'message': {'role': 'assistant', 'content': [{'text': 'OK'}]}},
    'stopReason': 'end_turn',
    'usage': {'inputTokens': 5, 'outputTokens': 1, 'totalTokens': 6},
    'metrics': {'latencyMs': 120},
}


def _quota(name: str, value: float) -> dict:
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
            expected = {'ServiceCode': 'bedrock'} if index == 0 else {'ServiceCode': 'bedrock', 'NextToken': f'page-{index}'}
            self.quotas_stub.add_response('list_service_quotas', response, expected)

    def converse_ok(self, expected: dict | None = None) -> None:
        self.bedrock_stub.add_response('converse', OK_RESPONSE, expected)

    def converse_error(self, code: str, message: str = 'boom', status: int = 400) -> None:
        self.bedrock_stub.add_client_error('converse', service_error_code=code, service_message=message,
                                           http_status_code=status)


@pytest.fixture
def world(monkeypatch):
    monkeypatch.delenv('BEDROCK_INFERENCE_SCOPE', raising=False)
    model_capacity.clear_quota_cache()
    created = World()
    monkeypatch.setattr(model_capacity, '_clients', {'bedrock-runtime': created.bedrock,
                                                     'service-quotas': created.quotas})
    with created.bedrock_stub, created.quotas_stub:
        yield created
        created.bedrock_stub.assert_no_pending_responses()
        created.quotas_stub.assert_no_pending_responses()
    model_capacity.clear_quota_cache()


def _probe_with_error(world: World, code: str, message: str = 'boom', quota: float | None = None) -> model_capacity.ProbeResult:
    """Probe Opus 5.5 against a ``code`` error, with its global quota at ``quota`` (None = not listed)."""
    world.converse_error(code, message)
    world.list_quotas([_quota(GLOBAL + 'Claude Opus 5.5', quota)] if quota is not None else [])
    return model_capacity.probe_model(OPUS55)


class TestRequestShaping:
    """The probe is converse()'s first request: same per-model shaping, one model, one call."""

    @pytest.mark.parametrize('model_id', [HAIKU55, OPUS55, SONNET55])
    def test_claude_55_models_get_no_temperature_no_thinking_no_tier(self, world, model_id):
        world.converse_ok({
            'modelId': model_id,
            'messages': [{'role': 'user', 'content': [{'text': 'Reply with OK'}]}],
            'inferenceConfig': {'maxTokens': 16},
        })
        world.list_quotas([])

        result = model_capacity.probe_model(model_id)

        assert (result['status'], result['ok'], result['invoked_id']) == ('available', True, model_id)

    def test_haiku_45_control_keeps_the_temperature(self, world):
        world.converse_ok({
            'modelId': HAIKU45,
            'messages': [{'role': 'user', 'content': [{'text': 'Reply with OK'}]}],
            'inferenceConfig': {'maxTokens': 16, 'temperature': 0.1},
        })
        world.list_quotas([])

        assert model_capacity.probe_model(HAIKU45)['status'] == 'available'

    def test_eu_scope_sends_the_eu_profile(self, world, monkeypatch):
        monkeypatch.setenv('BEDROCK_INFERENCE_SCOPE', 'eu')
        world.converse_ok({'modelId': 'eu.anthropic.claude-opus-5-5', 'messages': ANY, 'inferenceConfig': ANY})
        world.list_quotas([_quota(GEO + 'Claude Opus 5.5', 2_000_000)])

        result = model_capacity.probe_model(OPUS55)

        assert result['model_id'] == OPUS55
        assert result['invoked_id'] == 'eu.anthropic.claude-opus-5-5'
        assert result['quota'] == {'name': GEO + 'Claude Opus 5.5', 'tokens_per_minute': 2_000_000}

    def test_a_failure_never_falls_back_to_another_model(self, world):
        """Exactly one converse call: a second queued response would be left pending."""
        world.converse_error('ServiceUnavailableException', status=503)
        world.list_quotas([])

        result = model_capacity.probe_model(OPUS55)

        assert (result['status'], result['invoked_id']) == ('unavailable', OPUS55)


class TestClassification:
    def test_available_reports_latency_and_quota(self, world):
        world.converse_ok()
        world.list_quotas([_quota(GLOBAL + 'Claude Opus 5.5', 30_000_000)])

        result = model_capacity.probe_model(OPUS55)

        assert result['status'] == 'available'
        assert isinstance(result['latency_ms'], int)
        assert result['latency_ms'] >= 0
        assert result['quota'] == {'name': GLOBAL + 'Claude Opus 5.5', 'tokens_per_minute': 30_000_000}
        assert result['message'] == 'The model answered.'
        assert result['checked_at'].endswith('+00:00')

    @pytest.mark.parametrize(('code', 'message', 'quota', 'status'), [
        ('AccessDeniedException', 'You do not have access', None, 'no_access'),
        ('ValidationException', 'Model use case details have not been submitted', None, 'no_access'),
        ('ValidationException', 'You don\'t have access to the model with the specified model ID.', None, 'no_access'),
        ('ValidationException', 'The provided model identifier is invalid.', None, 'not_in_region'),
        ('ResourceNotFoundException', 'Model not found', None, 'not_in_region'),
        ('ThrottlingException', 'Too many tokens', 0, 'no_capacity'),
        ('ServiceQuotaExceededException', 'quota', 0, 'no_capacity'),
        ('ThrottlingException', 'Too many tokens', 30_000_000, 'throttled'),
        ('ThrottlingException', 'Too many tokens', None, 'throttled'),
        ('ModelNotReadyException', 'warming', None, 'not_ready'),
        ('ServiceUnavailableException', 'down', None, 'unavailable'),
        ('ModelTimeoutException', 'slow', None, 'unavailable'),
        ('ValidationException', 'maxTokens must be positive', None, 'error'),
        ('InternalServerException', 'oops', None, 'error'),
    ])
    def test_status_mapping(self, world, code, message, quota, status):
        result = _probe_with_error(world, code, message, quota)

        assert (result['status'], result['ok'], result['latency_ms']) == (status, False, None)

    def test_message_names_the_code_but_never_the_raw_aws_text(self, world):
        result = _probe_with_error(world, 'AccessDeniedException', 'User arn:aws:iam::123456789012:role/x is not authorized')

        assert result['message'].endswith('(AccessDeniedException)')
        assert '123456789012' not in result['message']
        assert 'arn:aws' not in str(result)

    def test_no_capacity_says_to_wait(self, world):
        result = _probe_with_error(world, 'ThrottlingException', quota=0)

        assert 'nothing to do but wait' in result['message']
        assert result['quota'] == {'name': GLOBAL + 'Claude Opus 5.5', 'tokens_per_minute': 0}

    def test_a_read_timeout_is_unavailable(self, world, monkeypatch):
        def timeout(**_kwargs):
            raise ReadTimeoutError(endpoint_url='https://bedrock-runtime')
        monkeypatch.setattr(world.bedrock, 'converse', timeout)
        world.list_quotas([])

        result = model_capacity.probe_model(OPUS55)

        assert (result['status'], result['message']) == (
            'unavailable', 'The model is temporarily unavailable; retry later. (ReadTimeoutError)')


class TestQuotaLookup:
    def test_global_profile_matches_the_global_quota_across_pages(self, world):
        world.list_quotas(
            [_quota(GEO + 'Claude Haiku 5.5', 1_000_000)],
            [_quota(GLOBAL + 'Claude Haiku 5.5', 10_000_000), _quota(GLOBAL + 'Claude Haiku 4.5', 5)],
        )

        assert model_capacity.lookup_quota(HAIKU55) == {
            'name': GLOBAL + 'Claude Haiku 5.5', 'tokens_per_minute': 10_000_000}

    def test_eu_profile_matches_the_cross_region_quota(self, world, monkeypatch):
        monkeypatch.setenv('BEDROCK_INFERENCE_SCOPE', 'eu')
        world.list_quotas([_quota(GLOBAL + 'Claude Sonnet 5.5', 6_000_000), _quota(GEO + 'Claude Sonnet 5.5', 400_000)])

        assert model_capacity.lookup_quota(SONNET55) == {
            'name': GEO + 'Claude Sonnet 5.5', 'tokens_per_minute': 400_000}

    def test_a_version_suffix_matches_but_a_longer_name_does_not(self, world):
        """'Claude Opus 5' must not pick up 'Claude Opus 5.5'; an AWS ' V1' suffix is accepted."""
        world.list_quotas([_quota(GLOBAL + 'Claude Opus 5.5', 30_000_000), _quota(GLOBAL + 'Claude Opus 5 V1', 7)])

        assert model_capacity.lookup_quota('global.anthropic.claude-opus-5') == {
            'name': GLOBAL + 'Claude Opus 5 V1', 'tokens_per_minute': 7}

    def test_listing_is_cached_for_ten_minutes(self, world, monkeypatch):
        clock = [1_000.0]
        monkeypatch.setattr(model_capacity.time, 'time', lambda: clock[0])
        world.list_quotas([_quota(GLOBAL + 'Claude Opus 5.5', 1)])
        world.list_quotas([_quota(GLOBAL + 'Claude Opus 5.5', 2)])

        first = model_capacity.lookup_quota(OPUS55)
        clock[0] += 599
        cached = model_capacity.lookup_quota(OPUS55)
        clock[0] += 2
        refreshed = model_capacity.lookup_quota(OPUS55)

        assert [q['tokens_per_minute'] if q else None for q in (first, cached, refreshed)] == [1, 1, 2]

    def test_access_denied_gives_a_null_quota_and_never_fails(self, world):
        world.quotas_stub.add_client_error('list_service_quotas', service_error_code='AccessDeniedException')
        world.converse_ok()

        result = model_capacity.probe_model(OPUS55)

        assert (result['status'], result['quota']) == ('available', None)

    def test_a_model_outside_the_allowlist_has_no_quota(self, world):
        assert model_capacity.quota_name('anthropic.unknown') is None
        assert model_capacity.lookup_quota('anthropic.unknown') is None
        world.quotas_stub.assert_no_pending_responses()

    def test_capacity_overview_lists_every_allowlisted_model(self, world):
        world.list_quotas([_quota(GLOBAL + 'Claude Haiku 5.5', 10_000_000)])

        overview = model_capacity.capacity_overview()

        assert [row['model_id'] for row in overview] == [m['id'] for m in ALLOWED_MODELS]
        by_id = {row['model_id']: row for row in overview}
        assert by_id[HAIKU55]['quota'] == {'name': GLOBAL + 'Claude Haiku 5.5', 'tokens_per_minute': 10_000_000}
        assert by_id[HAIKU55]['label'] == 'Claude Haiku 5.5'
        assert by_id[OPUS55]['quota'] is None


def test_the_probe_never_logs_the_prompt_or_credentials(world, caplog):
    world.converse_ok()
    world.list_quotas([])

    with caplog.at_level('DEBUG'):
        model_capacity.probe_model(OPUS55)

    logged = ' '.join(str(vars(record)) for record in caplog.records)
    assert 'Model test finished' in logged
    assert model_capacity.PROBE_PROMPT not in logged
    assert "'testing'" not in logged  # the conftest's fake access key / secret
