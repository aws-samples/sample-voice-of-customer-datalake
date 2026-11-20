"""The model an agent runs on (7.58.00): the Kiro adapter sets the launch's model and checks Kiro took it (else the step
ends for a person, never on another model), and the launch's argv carries the choice on either harness (a Bedrock
model the deployment grants and prices, or Kiro's id), against the scripted fake ``kiro-cli acp``."""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from engineering.board.store import MAX_LINE, BoardError
from engineering.run_objects import RunObjects
from engineering.runtime import harness_switch
from engineering.runtime.harness import main as harness_main
from engineering.runtime.harness import model_choice
from engineering.runtime.harness.converse_loop import ConverseAdapter
from engineering.runtime.harness.kiro import _offered
from engineering.runtime.harness.kiro_pin import kiro_model
from engineering.runtime.harness.skills import HARNESS_ENTRY
from engineering.runtime.harness.tools import PROGRESS_MAX
from engineering.runtime.interface import RuntimeRefused
from engineering.runtime.test.harness_fakes import HARNESS_COMMIT, RUN_ID, FakeBedrock, FakeBoard, World, use, world
from engineering.runtime.test.test_engineering_kiro_harness import (
    _adapter,
    _events,
    _fake,
    _finish,
    _received,
    _transcribed,
)
from engineering.thread_items import is_thread_item
from engineering.views_thread import Event, Subject, _Transcript

PARAMETER = '/voc/engineering-kiro/api-key'
SONNET = 'global.anthropic.claude-sonnet-5-5'
ARGV = (*HARNESS_ENTRY, '--adapter', 'converse', '--model', SONNET)


def _model_sets(log: Path) -> list[str]:
    return [frame['params']['value'] for frame in _received(log, 'session/set_config_option')
            if frame['params']['configId'] == 'model']


TAIL = ' Restart the run with another model (Restart run, Model), or start a new run with one.'


def _run(tmp_path: Path, scenario: dict[str, Any], model: str, *, skill_model: str = '') -> tuple[World, Path, str]:
    """A fixer's session on the fake: ``model`` the launch's ``--kiro-model``, ``skill_model`` its ``--model``."""
    w = world(tmp_path)
    w.session.context.model = skill_model
    _transcribed(w)
    binary, log = _fake(tmp_path, {'turns': [[_finish(), {'stop': 'end_turn'}]], **scenario})
    return w, log, _adapter(binary, w, model=model).run(w.session)


def _config(w: World) -> dict[str, Any]:
    return json.loads((Path(w.home) / '.voc' / 'kiro' / 'home' / '.kiro' / 'agents' / 'fixer.json').read_text())


def _not_taken(w: World) -> list[dict[str, Any]]:
    return [{'wanted': event['wanted'], 'current': event['current']} for event in _events(w)
            if event['kind'] == 'kiro_model']


# -- Kiro: the model set, and checked --------------------------------------------------------------------------------


def test_kiro_takes_the_launchs_model_before_its_first_prompt_and_the_session_says_it(tmp_path):
    w, log, ending = _run(tmp_path, {}, 'claude-opus-5.5')
    assert ending == 'done'
    assert w.session.stopped_for == ''
    assert _model_sets(log) == ['claude-opus-5.5']
    # The mode first, then the model, then the prompt.
    methods = [entry['in']['method'] for entry in json.loads(f'[{",".join(log.read_text().splitlines())}]')
               if 'in' in entry and entry['in'].get('method')]
    assert methods.index('session/set_config_option') < methods.index('session/prompt')
    assert w.session.context.status.step == 'kiro session started on claude-opus-5.5 at medium effort'
    # The session's agent config pins it too.
    assert _config(w)['model'] == 'claude-opus-5.5'
    asked = next(event for event in _events(w) if event['kind'] == 'acp_model')
    assert (asked['wanted'], asked['current']) == ('claude-opus-5.5', 'claude-opus-5.5')
    assert 'claude-haiku-5.5' in asked['offered']
    assert _not_taken(w) == []


def test_auto_takes_whichever_model_kiro_picks(tmp_path):
    w, log, ending = _run(tmp_path, {'model_answer': 'claude-sonnet-5.5'}, kiro_model('auto', chosen=True) or '')
    assert (ending, _model_sets(log), w.session.stopped_for) == ('done', ['auto'], '')
    # (and Kiro's effort: auto pins none, Kiro choosing per task)
    assert w.session.context.status.step == 'kiro session started on claude-sonnet-5.5 at medium effort'
    assert [frame['params']['configId'] for frame in _received(log, 'session/set_config_option')] == ['mode', 'model']


def test_without_a_choice_kiro_runs_its_name_for_the_skills_model_never_its_default(tmp_path):
    w, log, ending = _run(tmp_path, {}, '', skill_model=SONNET)
    assert (ending, _model_sets(log), w.session.stopped_for) == ('done', ['claude-sonnet-5.5'], '')
    assert _config(w)['model'] == 'claude-sonnet-5.5'
    assert w.session.context.status.step == 'kiro session started on claude-sonnet-5.5 at high effort'


def test_a_session_given_no_model_sets_none(tmp_path):
    w, log, ending = _run(tmp_path, {}, '')
    assert (ending, _model_sets(log), w.session.stopped_for) == ('done', [], '')
    assert 'model' not in _config(w)


def test_a_model_kiro_refuses_ends_the_step_for_a_person_and_sends_no_prompt(tmp_path):
    w, log, ending = _run(tmp_path, {'model_refuse': 'model not available'}, 'claude-opus-5.5')
    assert ending == 'done'
    assert w.session.stopped_for == ('Kiro could not use claude-opus-5.5 for the fixer (it answered none: model not '
                                     f'available).{TAIL}')
    assert _received(log, 'session/prompt') == []
    assert w.session.finished_elsewhere is False
    assert _not_taken(w) == [{'wanted': 'claude-opus-5.5', 'current': 'none'}]
    assert any(event['kind'] == 'model_refused' for event in _events(w))
    assert w.session.context.status.step == w.session.stopped_for


def test_an_id_the_account_does_not_offer_says_so(tmp_path):
    w, log, _ = _run(tmp_path, {'model_groups': True}, 'claude-nope-1')
    assert w.session.stopped_for == ('Kiro could not use claude-nope-1 for the fixer (it answered claude-sonnet-4.5; '
                                     f'Kiro does not offer claude-nope-1 on this account).{TAIL}')
    assert _received(log, 'session/prompt') == []


def test_another_model_answered_is_never_run(tmp_path):
    w, log, _ = _run(tmp_path, {'model_answer': 'claude-sonnet-4.5', 'models': []}, 'claude-opus-5.5')
    assert w.session.stopped_for == f'Kiro could not use claude-opus-5.5 for the fixer (it answered claude-sonnet-4.5).{TAIL}'
    assert _received(log, 'session/prompt') == []
    assert _not_taken(w) == [{'wanted': 'claude-opus-5.5', 'current': 'claude-sonnet-4.5'}]


def test_the_skills_model_kiro_does_not_offer_stops_too(tmp_path):
    w, log, _ = _run(tmp_path, {}, '', skill_model='global.anthropic.claude-opus-4-8')
    assert w.session.stopped_for == ('Kiro could not use claude-opus-4.8 for the fixer (it answered claude-sonnet-4.5; '
                                     f'Kiro does not offer claude-opus-4.8 on this account).{TAIL}')
    assert _received(log, 'session/prompt') == []


def test_a_model_with_no_kiro_name_stops_before_kiro_starts(tmp_path):
    w, log, ending = _run(tmp_path, {}, '', skill_model='openai.gpt-5.6-luna')
    assert ending == 'done'
    assert w.session.stopped_for == 'openai.gpt-5.6-luna has no Kiro name; choose a Kiro model for this role.'
    assert not [entry for entry in json.loads(f'[{",".join(log.read_text().splitlines())}]' if log.exists() else '[]')
                if entry.get('started')]


@pytest.mark.parametrize(('model', 'chosen', 'kiro'), [
    (SONNET, False, 'claude-sonnet-5.5'), ('global.anthropic.claude-haiku-4-5-20251001-v1:0', False, 'claude-haiku-4.5'),
    ('global.anthropic.claude-opus-5', False, 'claude-opus-5'), ('openai.gpt-5.6-luna', False, None), ('', False, None),
    ('opus', False, None), ('opus', True, 'claude-opus-5.5'), ('auto', True, 'auto'), (SONNET, True, 'claude-sonnet-5.5'),
    ('claude-x-1', True, 'claude-x-1'), ('', True, None)])
def test_kiros_name_for_a_model(model: str, chosen: bool, kiro: str | None):
    assert kiro_model(model, chosen=chosen) == kiro


def test_the_offered_models_are_read_flat_or_in_groups_and_bounded():
    flat = {'configOptions': [{'id': 'model', 'options': [{'value': 'a'}, {'value': 'b'}, {'value': 'a'}, 'x']}]}
    grouped = {'configOptions': [{'id': 'model', 'options': [{'group': 'g', 'options': [{'value': 'c'}]}]}]}
    many = {'configOptions': [{'id': 'model', 'options': [{'value': f'm{n}'} for n in range(80)]}]}
    assert (_offered(flat, 'model'), _offered(grouped, 'model'), _offered({}, 'model')) == (['a', 'b'], ['c'], [])
    assert len(_offered(many, 'model')) == 50


# -- the step for a person ---------------------------------------------------------------------------------------------


def test_a_session_stopped_for_its_model_sends_its_task_to_a_person_in_those_words(tmp_path):
    w = world(tmp_path)
    w.session.stopped_for = 'Kiro could not use claude-opus-5.5 for the fixer: no. Choose another model.'
    harness_main._finished(w.session)
    assert w.board.progress_seen[-1][3] == w.session.stopped_for
    assert w.board.moves[-1][2] == 'needs_human'


def test_a_coordinator_stopped_for_its_model_is_a_crash_saying_why(tmp_path):
    w = world(tmp_path, role='coordinator')
    w.session.stopped_for = 'Kiro could not use claude-opus-5.5 for the coordinator: no. Choose another model.'
    with pytest.raises(harness_main.CoordinatorStopped, match='Choose another model'):
        harness_main._finished(w.session)
    assert (w.board.moves, w.board.progress_seen[-1][3]) == ([], w.session.stopped_for)


def test_a_long_refusal_reaches_a_person_as_one_board_line_and_stays_whole_on_the_session(tmp_path):
    # (Q25) Kiro's answer can make the reason longer than the board's MAX_LINE (200): sent whole, the board refused
    # the progress step, the session crashed and was continued into the same refusal, never reaching a person.
    w = world(tmp_path)
    w.session.stopped_for = 'Kiro could not use claude-opus-5.5 for the fixer (it answered ' + 'x' * 250 + ').'
    w.session.context.status.at(w.session.stopped_for)
    harness_main._finished(w.session)
    step = w.board.progress_seen[-1][3]
    assert (len(step) <= PROGRESS_MAX < MAX_LINE, step.endswith('…'), w.board.moves[-1][2]) == (True, True, 'needs_human')
    assert w.session.context.status.step == w.session.stopped_for


def test_a_long_coordinator_refusal_is_a_crash_whose_reason_is_one_line(tmp_path):
    w = world(tmp_path, role='coordinator')
    w.session.stopped_for = 'Kiro could not use claude-opus-5.5 for the coordinator\n(it answered ' + 'y' * 250 + ').'
    with pytest.raises(harness_main.CoordinatorStopped) as stopped:
        harness_main._finished(w.session)
    assert (str(stopped.value), w.board.moves) == (w.board.progress_seen[-1][3], [])
    assert len(str(stopped.value)) <= PROGRESS_MAX
    assert '\n' not in str(stopped.value)


def test_the_board_fake_refuses_a_step_over_the_boards_line():
    with pytest.raises(BoardError, match='a line of 1 to 200'):
        FakeBoard().progress('r', 't', 'a', 'z' * (MAX_LINE + 1))


def test_the_harness_takes_the_kiro_model_from_its_argv_and_names_it_as_the_sessions():
    args = harness_main._parser().parse_args(['run', '--adapter', 'kiro', '--model', SONNET, '--kiro-model',
                                              'claude-haiku-5.5'])
    assert (args.kiro_model, harness_main.session_model(args)) == ('claude-haiku-5.5', 'claude-haiku-5.5')
    native = harness_main._parser().parse_args(['run', '--adapter', 'converse', '--model', SONNET])
    assert (native.kiro_model, harness_main.session_model(native)) == ('', SONNET)


# -- the launch's argv -------------------------------------------------------------------------------------------------


def _env(**extra: str) -> dict[str, str]:
    return {'ENGINEERING_KIRO_KEY_PARAMETER': PARAMETER, **extra}


@pytest.mark.parametrize(('choice', 'model'), [('opus', 'global.anthropic.claude-opus-5-5'),
                                               ('haiku', 'global.anthropic.claude-haiku-5-5'),
                                               ('sonnet', SONNET), ('auto', SONNET), ('', SONNET)])
def test_the_native_harness_gets_the_choices_bedrock_model(choice, model):
    argv, asked = harness_switch.with_model(ARGV, 'fixer', _env(), choice)
    assert (argv[-1], asked) == (model, model)
    assert argv[:-1] == ARGV[:-1]


def test_another_bedrock_id_runs_only_where_the_deployment_grants_and_prices_it():
    granted_unpriced = 'global.anthropic.claude-opus-5'   # (allowlisted, not in DEFAULT_TOKEN_PRICES)
    with pytest.raises(RuntimeRefused, match=r"global\.anthropic\.claude-opus-5 isn't enabled in this deployment\. An "
                                             r'admin adds it with -c engineeringModelPrices \(docs/deployment\.md\)'):
        harness_switch.with_model(ARGV, 'fixer', _env(), granted_unpriced)
    priced = _env(ENGINEERING_MODEL_PRICES=json.dumps({granted_unpriced: {'input': '5', 'output': '25'}}))
    assert harness_switch.with_model(ARGV, 'fixer', priced, granted_unpriced)[1] == granted_unpriced
    # Priced but never granted (not one of the agents' Claude models): refused, never a wider grant.
    ungranted = _env(ENGINEERING_MODEL_PRICES=json.dumps({'vendor.model-x': {'input': '1', 'output': '1'}}))
    with pytest.raises(RuntimeRefused, match="isn't enabled"):
        harness_switch.with_model(ARGV, 'fixer', ungranted, 'vendor.model-x')
    assert 'vendor.model-x' not in harness_switch.native_models(ungranted)


@pytest.mark.parametrize('model', ['global.anthropic.claude-sonnet-4-6', 'global.anthropic.claude-haiku-4-5-20251001-v1:0'])
def test_a_granted_claude_that_does_not_think_adaptively_runs_natively_once_priced_and_thinks_unseen(tmp_path, model):
    """F6 (7.58.01): the native choice is what the deployment grants and prices, nothing more. The Converse loop asks
    only a model that thinks adaptively for its summarized thinking (``model_request_fields``, 7.54.00), so this one's
    calls carry no thinking field, and the run's thread shows its words with no thought, and no error."""
    with pytest.raises(RuntimeRefused, match="isn't enabled"):   # (granted, unpriced: as any other model)
        harness_switch.with_model(ARGV, 'fixer', _env(), model)
    priced = _env(ENGINEERING_MODEL_PRICES=json.dumps({model: {'input': '3', 'output': '15'}}))
    assert model in harness_switch.native_models(priced)
    assert harness_switch.with_model(ARGV, 'fixer', priced, model)[1] == model
    w = world(tmp_path)
    _transcribed(w)
    bedrock = FakeBedrock([[{'text': 'The slice end adds one.'}, use('finish', summary='fixed')]])
    assert ConverseAdapter(bedrock, model).run(w.session) == 'done'
    assert [set(request) & {'additionalModelRequestFields'} for request in bedrock.requests] == [set()]
    subject = Subject(run_id=RUN_ID, agent='fixer-1', role='fixer', task_id='task-1', attempt=1, commit=HARNESS_COMMIT,
                      status='working')
    events = [Event(0, index, index + 1, data) for index, data in enumerate(_events(w))]
    items = [built.item for built in _Transcript(subject, RunObjects(None, '')).build(events)[0]]
    assert all(is_thread_item(item) for item in items)
    assert [item['text'] for item in items if item['kind'] == 'said'] == ['The slice end adds one.', 'fixed']
    assert 'thought' not in {item['kind'] for item in items}


@pytest.mark.parametrize(('choice', 'kiro'), [('opus', 'claude-opus-5.5'), ('auto', 'auto'),
                                              ('claude-sonnet-4.5', 'claude-sonnet-4.5')])
def test_a_role_on_kiro_gets_the_choices_kiro_model(choice, kiro):
    argv, asked = harness_switch.with_model(ARGV, 'fixer', _env(ENGINEERING_HARNESS='kiro:fixer'), choice)
    assert argv[-2:] == ('--kiro-model', kiro)
    assert argv[argv.index('--adapter'):argv.index('--adapter') + 2] == ('--adapter', 'kiro')
    assert asked == kiro


def test_a_role_on_kiro_with_no_choice_asks_for_kiros_name_for_its_skills_model():
    argv, asked = harness_switch.with_model(ARGV, 'fixer', _env(ENGINEERING_HARNESS='kiro'), '')
    assert '--kiro-model' not in argv   # (the session asks for it: Kiro's name for its --model)
    assert argv == harness_switch.harness_for(ARGV, 'fixer', _env(ENGINEERING_HARNESS='kiro'))
    assert asked == 'claude-sonnet-5.5'
    # A Bedrock id a person chose for a role on Kiro is Kiro's name for it.
    assert harness_switch.with_model(ARGV, 'fixer', _env(ENGINEERING_HARNESS='kiro'), SONNET)[0][-1] == \
        'claude-sonnet-5.5'


# -- the choice's shape ------------------------------------------------------------------------------------------------


@pytest.mark.parametrize('value', ['opus', 'auto', 'claude-sonnet-5.5', 'global.anthropic.claude-sonnet-5-5',
                                   'arn:aws:bedrock:us-east-1:123456789012:inference-profile/x', ' haiku ', None, ''])
def test_a_choice_of_its_shape_is_taken(value):
    assert model_choice.checked(value) == (value or '').strip()


@pytest.mark.parametrize('value', ['claude sonnet', 'https://example.com/model', '-opus', 'a' * 129, 'x\ny', 7,
                                   ['opus'], 'model;rm'])
def test_a_choice_off_its_shape_is_refused(value):
    with pytest.raises(model_choice.ModelChoiceError, match='a model is auto, opus, sonnet or haiku'):
        model_choice.checked(value)


def test_the_launch_applies_the_runs_choice_then_the_roles_and_else_none():
    # (a card names no choice: none is its model.id, the skill's --model)
    assert model_choice.chosen('haiku', 'opus') == 'haiku'
    assert model_choice.chosen('', 'opus') == 'opus'
    assert model_choice.chosen('', '') == ''
