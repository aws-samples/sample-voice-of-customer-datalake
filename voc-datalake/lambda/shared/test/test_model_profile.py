"""The e2e model profile (shared/model_profile.py): who gets it, how it travels, what it resolves to."""
import json
from typing import Any
from unittest.mock import MagicMock, patch

import pytest

from shared import model_profile
from shared.api import api_handler
from shared.invocation_cost import instrumented_handler
from shared.model_config import (
    ALLOWED_MODEL_IDS,
    PICKER_SURFACES,
    PROFILE_MODELS,
    apply_model_profile,
    fallback_chain,
    get_active_model_id,
)
from shared.model_profile import (
    E2E_PROFILE,
    PAYLOAD_KEY,
    active_profile,
    model_profile_scope,
    payload_fields,
    profile_for_groups,
    profile_from_job_event,
    stamp_config,
)

HAIKU55 = 'global.anthropic.claude-haiku-5-5'
SONNET55 = 'global.anthropic.claude-sonnet-5-5'
OPUS55 = 'global.anthropic.claude-opus-5-5'


@pytest.fixture
def pinned_settings():
    """An admin pinned Opus on every picker surface (the profile must win over it)."""
    settings = {'surfaces': dict.fromkeys(PICKER_SURFACES, OPUS55), 'model_id': OPUS55}
    with patch('shared.model_config._load_settings', return_value=settings):
        yield settings


def _rest_event(groups: object = None, **extra: Any) -> dict:
    claims: dict[str, object] = {'sub': 'user-1'}
    if groups is not None:
        claims['cognito:groups'] = groups
    return {'httpMethod': 'GET', 'path': '/x', 'requestContext': {'authorizer': {'claims': claims}}, **extra}


def _lambda_context() -> MagicMock:
    context = MagicMock()
    context.function_name = 'voc-test'
    context.memory_limit_in_mb = 512
    context.invoked_function_arn = 'arn:aws:lambda:us-east-1:123456789012:function:voc-test'
    context.aws_request_id = 'req-1'
    return context


def _seen_profile(decorator, event: dict) -> str | None:
    seen: list[str | None] = []

    @decorator
    def lambda_handler(_event: dict, _context: object) -> dict:
        seen.append(active_profile())
        return {'statusCode': 200}

    lambda_handler(event, _lambda_context())
    return seen[0]


class TestResolution:
    def test_the_profile_model_is_allowlisted_haiku_55(self):
        assert PROFILE_MODELS == {E2E_PROFILE: HAIKU55}
        assert HAIKU55 in ALLOWED_MODEL_IDS

    @pytest.mark.usefixtures('pinned_settings')
    def test_without_a_profile_the_admin_choice_applies(self):
        assert {get_active_model_id(s) for s in PICKER_SURFACES} == {OPUS55}

    @pytest.mark.usefixtures('pinned_settings')
    def test_under_the_e2e_profile_every_surface_resolves_to_haiku(self):
        with model_profile_scope(E2E_PROFILE):
            assert {get_active_model_id(s) for s in (*PICKER_SURFACES, 'default', 'unknown_surface')} == {HAIKU55}
        assert get_active_model_id('chat') == OPUS55

    def test_an_explicit_model_id_follows_the_profile_too(self):
        assert apply_model_profile(OPUS55) == OPUS55
        with model_profile_scope(E2E_PROFILE):
            assert apply_model_profile(OPUS55) == HAIKU55

    def test_the_capacity_fallback_stays_on_haiku(self):
        assert SONNET55 in fallback_chain(OPUS55, 'prototype')
        with model_profile_scope(E2E_PROFILE):
            assert fallback_chain(OPUS55, 'prototype') == (HAIKU55, 'global.anthropic.claude-haiku-4-5-20251001-v1:0')

    def test_haiku_55_is_shaped_without_temperature_or_thinking_budget(self):
        from shared.converse import build_single_turn_request
        with model_profile_scope(E2E_PROFILE):
            request = build_single_turn_request(apply_model_profile(OPUS55), prompt='p', max_tokens=10)
        assert request['modelId'] == HAIKU55
        assert 'temperature' not in request.get('inferenceConfig', {})
        assert 'thinking' not in json.dumps(request.get('additionalModelRequestFields', {}))


class TestWhoGetsTheProfile:
    @pytest.mark.parametrize('groups', [['e2e'], 'e2e', '[admins, e2e]', 'users,e2e', 'admins e2e'])
    def test_a_verified_e2e_group_claim_in_any_api_gateway_shape(self, groups):
        assert _seen_profile(api_handler, _rest_event(groups)) == E2E_PROFILE

    @pytest.mark.parametrize('groups', [None, '', 'admins', '[users]', 'e2e-admins', ['E2E']])
    def test_any_other_caller_gets_none(self, groups):
        assert _seen_profile(api_handler, _rest_event(groups)) is None

    def test_a_client_supplied_profile_in_body_query_or_headers_is_ignored(self):
        event = _rest_event('users', body=json.dumps({PAYLOAD_KEY: E2E_PROFILE}),
                            queryStringParameters={PAYLOAD_KEY: E2E_PROFILE},
                            headers={PAYLOAD_KEY: E2E_PROFILE, 'User-Agent': 'node voc-e2e/run-1'})
        assert _seen_profile(api_handler, event) is None

    def test_an_unknown_profile_name_is_ignored(self):
        assert _seen_profile(api_handler, {'action': 'assist_job', PAYLOAD_KEY: 'free-opus'}) is None
        assert profile_for_groups('e2e') == E2E_PROFILE

    def test_the_scope_ends_with_the_invocation(self):
        _seen_profile(api_handler, _rest_event('e2e'))
        assert active_profile() is None


class TestHowItTravels:
    def test_an_assist_event_carries_it_at_the_top_level(self):
        assert _seen_profile(api_handler, {'action': 'assist_job', 'pk': 'p', 'job_id': 'j', PAYLOAD_KEY: 'e2e'}) == 'e2e'

    @pytest.mark.parametrize('key', model_profile.JOB_CONFIG_KEYS)
    def test_a_job_event_carries_it_in_its_stamped_config(self, key):
        assert _seen_profile(instrumented_handler, {'job_id': 'j', key: {PAYLOAD_KEY: 'e2e'}}) == 'e2e'

    def test_other_nested_values_are_never_read(self):
        # research_config.filters is the raw request body.
        event = {'research_config': {'filters': {PAYLOAD_KEY: 'e2e'}}, 'other': {PAYLOAD_KEY: 'e2e'}}
        assert profile_from_job_event(event) is None
        assert profile_from_job_event('not a mapping') is None

    def test_stamping_replaces_a_client_value_with_the_server_one(self):
        forged = {'title': 't', PAYLOAD_KEY: 'e2e'}
        assert stamp_config(forged) == {'title': 't'}
        with model_profile_scope(E2E_PROFILE):
            assert stamp_config({'title': 't'}) == {'title': 't', PAYLOAD_KEY: 'e2e'}
            assert payload_fields() == {PAYLOAD_KEY: 'e2e'}
        assert payload_fields() == {}

    def test_nested_scopes_restore_the_outer_profile(self):
        with model_profile_scope(E2E_PROFILE):
            with model_profile_scope(None):
                assert active_profile() is None
            assert active_profile() == E2E_PROFILE
        assert active_profile() is None

    def test_the_assist_worker_invoke_carries_the_starters_profile(self):
        from shared import assist_jobs
        table = MagicMock()
        with patch.object(assist_jobs, '_table', return_value=table), \
                patch.object(assist_jobs, 'invoke_lambda_async') as invoke:
            with model_profile_scope(E2E_PROFILE):
                assist_jobs.start('ASSIST#u', 'assist_x', {}, worker_function='w', initiated_by='u')
            assist_jobs.start('ASSIST#u', 'assist_x', {}, worker_function='w', initiated_by='u')
        first, second = (c.args[1] for c in invoke.call_args_list)
        assert first[PAYLOAD_KEY] == 'e2e'
        assert PAYLOAD_KEY not in second
