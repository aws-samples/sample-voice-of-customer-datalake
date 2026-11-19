"""A role's model in the Registry (7.58.00, ``PUT /agents/engineering/registry/<role>/model``): every card says its
role's choice and the harness it runs on, an administrator sets or clears it with its history, a choice off its shape
is refused, and on the native harness so is a Bedrock model the deployment does not grant and price; on Kiro any id
is taken (Kiro checks it when the session starts)."""
from __future__ import annotations

import json
from collections.abc import Iterator
from typing import Any

import pytest
from agents_handler_fixtures import USER
from agents_handler_fixtures import call as _call
from engineering_skills_fixtures import DELEGATED_ADMIN, engineering_skills

from engineering.settings import read_role_models
from shared import agents_store as store

REGISTRY = '/agents/engineering/registry'
OPUS, SONNET, HAIKU = ('global.anthropic.claude-opus-5-5', 'global.anthropic.claude-sonnet-5-5',
                       'global.anthropic.claude-haiku-5-5')
UNPRICED = 'global.anthropic.claude-opus-5'


@pytest.fixture(autouse=True)
def tables(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    with engineering_skills(monkeypatch):
        yield


def _put(lambda_context: Any, role: str, model: Any, **kwargs: Any) -> tuple[int, dict]:
    return _call(lambda_context, 'PUT', f'{REGISTRY}/{role}/model', body={'model': model}, **kwargs)


def _card(lambda_context: Any, role: str) -> dict[str, Any]:
    status, body = _call(lambda_context, 'GET', f'{REGISTRY}/{role}')
    assert status == 200, body
    return body['card']


def test_every_card_says_its_roles_model_choice_and_harness(lambda_context: Any) -> None:
    status, body = _call(lambda_context, 'GET', REGISTRY)
    assert status == 200, body
    assert {OPUS, SONNET, HAIKU} <= set(body['bedrock_enabled'])
    assert UNPRICED not in body['bedrock_enabled']
    fixer = next(card for card in body['cards'] if card['id'] == 'fixer')
    assert {name: fixer[name] for name in ('model_choice', 'template_model_choice', 'model_choice_updated_at',
                                           'model_choice_updated_by', 'runs_on')} == {
        'model_choice': None, 'template_model_choice': None, 'model_choice_updated_at': None,
        'model_choice_updated_by': None, 'runs_on': 'native'}


def test_an_administrator_sets_a_roles_model_and_clears_it_with_its_history(lambda_context: Any) -> None:
    status, body = _put(lambda_context, 'fixer', 'opus')
    assert status == 200, body
    assert (body['role'], body['model_choice'], body['updated_by']) == ('fixer', 'opus', 'alice')
    card = _card(lambda_context, 'fixer')
    assert (card['model_choice'], card['model_choice_updated_by']) == ('opus', 'alice')
    status, body = _put(lambda_context, 'fixer', None)
    assert (status, body['model_choice']) == (200, None)
    assert _card(lambda_context, 'fixer')['model_choice'] is None
    logs = store.get_agents_table().query(
        KeyConditionExpression='pk = :pk AND begins_with(sk, :log)',
        ExpressionAttributeValues={':pk': 'SETTINGS#engineering', ':log': 'LOG#'})['Items']
    assert sorted(log['role_model']['model'] for log in logs) == ['', 'opus']


@pytest.mark.parametrize('model', ['auto', 'haiku', 'sonnet', OPUS, HAIKU])
def test_a_named_choice_or_an_enabled_bedrock_id_is_taken_on_the_native_harness(lambda_context: Any,
                                                                                  model: str) -> None:
    assert _put(lambda_context, 'hunter', model)[0] == 200


@pytest.mark.parametrize('model', ['claude sonnet', 'https://example.com/model', '', 7, ['opus']])
def test_a_choice_off_its_shape_is_a_400(lambda_context: Any, model: Any) -> None:
    status, body = _put(lambda_context, 'fixer', model)
    if model == '':
        assert status == 200   # ('' is no choice: the role's default, as null)
        return
    assert status == 400
    assert 'a model is auto, opus, sonnet or haiku' in body['error']


def test_a_bedrock_id_the_deployment_does_not_price_is_refused_until_it_is_priced(
        lambda_context: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    status, body = _put(lambda_context, 'fixer', UNPRICED)
    assert status == 400
    assert body['error'] == (f"{UNPRICED} isn't enabled in this deployment. An admin adds it with "
                             '-c engineeringModelPrices (docs/deployment.md).')
    monkeypatch.setenv('ENGINEERING_MODEL_PRICES', json.dumps({UNPRICED: {'input': '5', 'output': '25'}}))
    assert _put(lambda_context, 'fixer', UNPRICED)[0] == 200
    status, body = _call(lambda_context, 'GET', REGISTRY)
    assert UNPRICED in body['bedrock_enabled']


def test_on_kiro_any_id_is_taken_and_the_card_says_kiro(lambda_context: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv('ENGINEERING_HARNESS', 'kiro:fixer')
    assert _put(lambda_context, 'fixer', 'claude-sonnet-4.5')[0] == 200
    card = _card(lambda_context, 'fixer')
    assert (card['runs_on'], card['model_choice']) == ('kiro', 'claude-sonnet-4.5')
    assert _card(lambda_context, 'hunter')['runs_on'] == 'native'
    assert {role: model.choice for role, model in read_role_models(store.get_agents_table()).items()} == {
        'fixer': 'claude-sonnet-4.5'}


def test_only_a_launchable_role_with_a_model_body_from_an_administrator(lambda_context: Any) -> None:
    assert _put(lambda_context, 'coach', 'opus')[0] == 404
    assert _put(lambda_context, 'nobody', 'opus')[0] == 404
    status, body = _call(lambda_context, 'PUT', f'{REGISTRY}/fixer/model', body={'model': 'opus', 'role': 'x'})
    assert status == 400
    assert body['error'] == 'the body is {model: auto | opus | sonnet | haiku | <a model id> | null}'
    for claims in (USER, DELEGATED_ADMIN):
        assert _put(lambda_context, 'fixer', 'opus', claims=claims)[0] == 403


def test_the_route_is_404_while_the_module_is_off(lambda_context: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv('ENGINEERING_AGENTS')
    assert _put(lambda_context, 'fixer', 'opus')[0] == 404
