"""A run's models (7.58.00): its start records the model chosen for every role and the roles' own choices on META
(refusing a choice off its shape, or a Bedrock model the deployment does not grant and price), a child run keeps its
parent's, and each launch applies them to its argv and its session row, on moto and the local fake."""
from __future__ import annotations

import json
from datetime import UTC, datetime
from typing import Any

import boto3
import pytest

from engineering.runtime import handler
from engineering.runtime.harness.skills import SKILLS, harness_argv
from engineering.runtime.interface import RuntimeRefused
from engineering.runtime.runs import RunStore, run_pk
from engineering.runtime.test.conftest import COMMIT, TABLE
from engineering.settings import read_role_models, save_role_model

RUN_ID = '01JD3R4NZXQ7Y2W8K4M6P9T0GH'
LAUNCH = {'action': 'launch', 'run_id': RUN_ID, 'agent_id': 'fixer-1', 'role': 'fixer', 'task_id': 'task-1',
          'language': 'python', 'connection': 'conn-1', 'commit': COMMIT, 'paths': ['src']}
OPUS = 'global.anthropic.claude-opus-5-5'
UNPRICED = 'global.anthropic.claude-opus-5'   # (one of the agents' Claude models, not in DEFAULT_TOKEN_PRICES)
KIRO = {'ENGINEERING_HARNESS': 'kiro', 'ENGINEERING_KIRO_KEY_PARAMETER': '/voc/engineering/_kiro/api-key'}


def _table() -> Any:
    return boto3.resource('dynamodb', region_name='us-east-1').Table(TABLE)


def _start(**fields: Any) -> dict[str, Any]:
    return handler.lambda_handler({'action': 'start_run', 'run_id': RUN_ID, 'max_tasks': 5, 'flow': 'bug-hunt',
                                   **fields}, None)


def _choose(role: str, choice: str) -> None:
    """An administrator's Registry change (the Agents API's PUT writes it so; voc-agents is TABLE here)."""
    save_role_model(_table(), role=role, choice=choice, by='admin-1', at=datetime.now(UTC))


def _row(agent: str = 'fixer-1') -> dict[str, Any]:
    return _table().get_item(Key={'pk': run_pk(RUN_ID), 'sk': f'AGENT#{agent}'}).get('Item') or {}


def _harness(agent: str = 'fixer-1') -> tuple[str, ...]:
    session = handler._supervisor().sessions.get(RUN_ID, agent)
    assert session is not None
    return session.harness


# -- the start ---------------------------------------------------------------------------------------------------


@pytest.mark.usefixtures('wired')
def test_a_start_records_the_runs_model_and_the_roles_own_on_meta():
    _choose('builder', 'haiku')
    _choose('fixer', 'claude-sonnet-5.5')
    _start(model_choice='opus')
    run = RunStore(_table()).get(RUN_ID)
    assert run is not None
    assert (run.model_choice, dict(run.role_models)) == ('opus', {'builder': 'haiku', 'fixer': 'claude-sonnet-5.5'})


@pytest.mark.usefixtures('wired')
def test_a_start_without_a_model_records_none_and_runs_as_before():
    _start()
    run = RunStore(_table()).get(RUN_ID)
    assert run is not None
    assert (run.model_choice, dict(run.role_models)) == ('', {})
    meta = _table().get_item(Key={'pk': run_pk(RUN_ID), 'sk': 'META'})['Item']
    assert not {'model_choice', 'role_models'} & set(meta)


@pytest.mark.usefixtures('wired')
@pytest.mark.parametrize('choice', ['claude sonnet', 'https://example.com/m', 'a' * 200])
def test_a_start_with_a_model_off_its_shape_is_refused_before_anything_is_written(choice: str):
    with pytest.raises(RuntimeRefused, match='a model is auto, opus, sonnet or haiku'):
        _start(model_choice=choice)
    assert RunStore(_table()).get(RUN_ID) is None


@pytest.mark.usefixtures('wired')
def test_a_native_start_on_a_model_the_deployment_does_not_price_is_refused_and_one_it_prices_starts(monkeypatch):
    with pytest.raises(RuntimeRefused, match=rf"{UNPRICED} isn't enabled in this deployment\. An admin adds it with "
                                             r'-c engineeringModelPrices'):
        _start(model_choice=UNPRICED)
    assert RunStore(_table()).get(RUN_ID) is None
    monkeypatch.setenv('ENGINEERING_MODEL_PRICES', json.dumps({UNPRICED: {'input': '5', 'output': '25'}}))
    _start(model_choice=UNPRICED)
    run = RunStore(_table()).get(RUN_ID)
    assert run is not None
    assert run.model_choice == UNPRICED


@pytest.mark.usefixtures('wired')
def test_a_roles_own_choice_that_is_not_enabled_refuses_the_start_too():
    _choose('coordinator', 'vendor.model-x')
    with pytest.raises(RuntimeRefused, match=r"the coordinator runs on the native harness: vendor\.model-x isn't"):
        _start()


@pytest.mark.usefixtures('wired')
def test_on_kiro_any_id_starts_kiro_checks_it_at_the_sessions_start(monkeypatch):
    for name, value in KIRO.items():
        monkeypatch.setenv(name, value)
    _start(model_choice='claude-sonnet-4.5')
    run = RunStore(_table()).get(RUN_ID)
    assert run is not None
    assert run.model_choice == 'claude-sonnet-4.5'


@pytest.mark.usefixtures('wired')
def test_the_roles_choices_are_read_at_the_start_from_the_settings_row():
    _choose('fixer', 'opus')
    _choose('fixer', '')   # (back to its default: the attribute removed, the history kept)
    _choose('hunter', 'auto')
    assert {role: model.choice for role, model in read_role_models(_table()).items()} == {'hunter': 'auto'}
    logs = _table().query(KeyConditionExpression='pk = :pk AND begins_with(sk, :log)',
                          ExpressionAttributeValues={':pk': 'SETTINGS#engineering', ':log': 'LOG#'})['Items']
    assert sorted(log['role_model']['model'] for log in logs) == ['', 'auto', 'opus']


@pytest.mark.usefixtures('wired')
def test_a_child_run_keeps_its_parents_models(monkeypatch):
    from engineering.runtime.test.test_engineering_child_run import CHILD, PARENT, _parent, _resumed
    _parent(monkeypatch)
    _table().update_item(Key={'pk': run_pk(PARENT), 'sk': 'META'},
                         UpdateExpression='SET model_choice = :m, role_models = :r',
                         ExpressionAttributeValues={':m': 'haiku', ':r': {'fixer': 'opus'}})
    _resumed(monkeypatch)
    child = RunStore(_table()).get(CHILD)
    assert child is not None
    assert (child.model_choice, dict(child.role_models)) == ('haiku', {'fixer': 'opus'})


# -- the launch --------------------------------------------------------------------------------------------------


@pytest.mark.usefixtures('wired')
def test_a_launch_runs_the_runs_model_on_the_native_harness_and_its_row_says_so():
    _start(model_choice='opus')
    handler.lambda_handler(LAUNCH, None)
    argv = _harness()
    assert argv[argv.index('--model') + 1] == OPUS
    assert argv[:argv.index('--model')] == harness_argv(SKILLS['fixer'])[:argv.index('--model')]
    row = _row()
    assert (row['model'], row['model_choice']) == (OPUS, 'opus')


@pytest.mark.usefixtures('wired')
def test_a_launch_without_the_runs_model_takes_the_roles_own():
    _choose('fixer', 'haiku')
    _start()
    handler.lambda_handler(LAUNCH, None)
    argv = _harness()
    assert argv[argv.index('--model') + 1] == 'global.anthropic.claude-haiku-5-5'


@pytest.mark.usefixtures('wired')
def test_a_launch_with_no_choice_runs_its_skills_argv_as_before():
    _start()
    handler.lambda_handler(LAUNCH, None)
    assert _harness() == harness_argv(SKILLS['fixer'])
    assert 'model_choice' not in _row()
    assert _row()['model'] == SKILLS['fixer'].model


@pytest.mark.usefixtures('wired')
def test_a_launch_on_kiro_names_the_choices_kiro_model(monkeypatch):
    for name, value in KIRO.items():
        monkeypatch.setenv(name, value)
    _start(model_choice='sonnet')
    handler.lambda_handler(LAUNCH, None)
    argv = _harness()
    assert argv[-2:] == ('--kiro-model', 'claude-sonnet-5.5')
    assert (_row()['model'], _row()['model_choice']) == ('claude-sonnet-5.5', 'sonnet')


@pytest.mark.usefixtures('wired')
def test_a_launch_on_kiro_without_a_choice_says_kiros_name_for_its_skills_model(monkeypatch):
    for name, value in KIRO.items():
        monkeypatch.setenv(name, value)
    _start()
    handler.lambda_handler(LAUNCH, None)
    assert '--kiro-model' not in _harness()
    assert (_row()['model'], 'model_choice' in _row()) == ('claude-sonnet-5.5', False)
