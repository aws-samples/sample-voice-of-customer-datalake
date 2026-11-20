"""Readiness of the roles' model choices (7.58.00): on the native harness the chosen Bedrock models are the ones
checked for access, and one the deployment does not grant and price fails (Enable waits on it); on Kiro the check
names each role's model and says it is checked when the step's session starts (readiness cannot see what an account
offers); and the Agents API's settings read the price setting and the choices."""
from __future__ import annotations

import json
from dataclasses import replace

import pytest

from engineering.readiness import REQUIRED, evaluate, flow_models
from engineering.readiness_aws import enabled_native_models, settings_from_environment
from engineering.test.test_readiness import BUG_FLOW, CARDS, HAIKU, OPUS, SETTINGS, SONNET, SUBJECT, Ports, checks

ENABLED = frozenset({SONNET, HAIKU, OPUS})


def test_a_native_roles_choice_is_the_model_checked_for_access():
    settings = replace(SETTINGS, model_choices={'hunter': 'opus', 'fixer': 'auto'}, native_models=ENABLED)
    models = flow_models(BUG_FLOW, settings.run_models())
    assert 'hunter' in models[OPUS]
    assert 'fixer' in models[SONNET]   # (auto on the native harness: the role's default)
    check = checks(settings=settings)['bedrock_models']
    assert check.status == 'pass'
    assert f'Chosen: fixer {SONNET} (enabled), hunter {OPUS} (enabled).' in check.detail


def test_a_native_roles_model_the_deployment_does_not_grant_and_price_fails_and_blocks_enable():
    settings = replace(SETTINGS, model_choices={'hunter': 'global.anthropic.claude-opus-5'}, native_models=ENABLED)
    check = checks(settings=settings)['bedrock_models']
    assert check.status == 'fail'
    assert check.detail == ("The hunter: global.anthropic.claude-opus-5 isn't enabled in this deployment. An admin "
                            'adds it with -c engineeringModelPrices (docs/deployment.md).')
    assert 'bedrock_models' in REQUIRED
    assert not evaluate(SUBJECT, Ports(), settings, REQUIRED).ready


def test_a_choice_of_a_role_the_flow_does_not_run_or_on_kiro_is_not_a_bedrock_model():
    settings = replace(SETTINGS, model_choices={'builder': 'vendor.x', 'fixer': 'claude-sonnet-4.5'},
                       native_models=ENABLED, kiro_roles=frozenset({'fixer'}))
    assert checks(settings=settings)['bedrock_models'].status == 'pass'
    assert settings.run_models()['fixer'] == CARDS['fixer']


@pytest.mark.parametrize(('choices', 'cards', 'said'), [
    ({'fixer': 'opus'}, CARDS, 'Models on Kiro: fixer claude-opus-5.5.'),
    ({}, CARDS, 'Models on Kiro: fixer claude-sonnet-5.5.'),   # (Kiro's name for its card's model)
    ({'fixer': 'claude-x-1'}, CARDS, 'Models on Kiro: fixer claude-x-1.'),
    ({}, {**CARDS, 'fixer': 'openai.gpt-5.6-luna'},
     'Models on Kiro: fixer none (openai.gpt-5.6-luna has no Kiro name: choose a Kiro model).'),
])
def test_the_kiro_check_names_each_roles_model_and_says_it_is_checked_at_the_sessions_start(choices, cards, said):
    settings = replace(SETTINGS, kiro_roles=frozenset({'fixer'}), kiro_key_parameter='/voc/engineering-kiro/api-key',
                       kiro_version='3.4.0', model_choices=choices, card_models=cards)
    detail = checks(settings=settings)['kiro'].detail
    assert said in detail
    assert ("Kiro checks each when the step's session starts: a model it cannot use on this account stops that "
            'step for a person.') in detail


def test_the_agents_apis_settings_read_the_choices_and_the_price_setting(monkeypatch):
    monkeypatch.setenv('ENGINEERING_MODEL_PRICES', json.dumps({'global.anthropic.claude-opus-5': {'input': '5',
                                                                                                 'output': '25'}}))
    settings = settings_from_environment(CARDS, 'us-east-1', {'fixer': 'haiku'})
    assert settings.model_choices == {'fixer': 'haiku'}
    assert {'global.anthropic.claude-opus-5', SONNET, HAIKU, OPUS} <= settings.native_models
    monkeypatch.setenv('ENGINEERING_MODEL_PRICES', 'not json')
    assert enabled_native_models() == frozenset()
