"""The Kiro harness (7.53.00): kiro-cli over ACP, driven against a scripted fake ``kiro-cli acp`` (``fake_kiro.py``, a
real child process speaking ACP on stdio as kiro-cli 3.4.0 did in the probe): prompt, steer, cancel, load, permission
refusal, and what never reaches kiro-cli (its own tools, the checkout as its directory, the key outside its env)."""
from __future__ import annotations

import io
import json
import os
import stat
import sys
import tarfile
from pathlib import Path
from typing import Any, ClassVar

import pytest

from engineering.runtime.checkpoints import artifact_prefix
from engineering.runtime.harness.acp import AcpClient, AcpError
from engineering.runtime.harness.interface import AgentSession
from engineering.runtime.harness.kiro import (
    CONTINUE_LOADED,
    KIRO_CLI_VERSION,
    KiroAcp,
    KiroNotOffered,
    StateRefused,
    compiled_config,
    kiro_env,
    pack_sessions,
    permission_answer,
    session_agent,
    ssm_key,
    unpack_sessions,
)
from engineering.runtime.harness.ports import PAUSE, InboxMessage
from engineering.runtime.harness.tools import STEER
from engineering.runtime.harness.transcript import Transcript
from engineering.runtime.test.harness_fakes import HARNESS_COMMIT, RUN_ID, World, world

CONFIGS = Path(__file__).resolve().parents[4] / 'templates' / 'orchestration' / 'kiro-agents'
FAKE = Path(__file__).with_name('fake_kiro.py')
KEY = 'kiro-test-key-0123456789'
TOOL_ENV = {'VOC_RUN_ID': RUN_ID, 'VOC_AGENT_ID': 'fixer-1', 'AWS_REGION': 'us-east-1',
            'AWS_CONFIG_FILE': '/run/voc/aws-config'}
HARNESS_ENV = {'HTTPS_PROXY': 'http://127.0.0.1:3128', 'NO_PROXY': '127.0.0.1,localhost',
               'AWS_CONFIG_FILE': '/run/voc/aws-config', 'VOC_RUN_ID': RUN_ID}


def _transcribed(w: World) -> Transcript:
    transcript = Transcript(w.store, artifact_prefix(RUN_ID, 'fixer-1', HARNESS_COMMIT, 1, 'transcripts'))
    w.session.context.transcript = transcript
    return transcript


def _events(w: World) -> list[dict[str, Any]]:
    """Every transcript event held or written, in order."""
    transcript = w.session.context.transcript
    assert transcript is not None
    transcript.flush_quietly()
    lines = [line for key, body in sorted(w.store.objects.items()) if '/_transcripts/' in key
             for line in body.decode().splitlines()]
    return [json.loads(line) for line in lines]


def _fake(tmp_path: Path, scenario: dict[str, Any], name: str = 'kiro-cli') -> tuple[str, Path]:
    """The fake as an executable at an absolute path (as the image's /usr/local/bin/kiro-cli), and its log."""
    log = tmp_path / f'{name}.log'
    with open(tmp_path / f'{name}.json', 'w') as stream:
        json.dump({**scenario, 'log': str(log)}, stream)
    binary = tmp_path / name
    binary.write_text(f'#!/bin/sh\nexec "{sys.executable}" -I "{FAKE}" "{tmp_path / f"{name}.json"}" "$@"\n')
    binary.chmod(binary.stat().st_mode | stat.S_IEXEC)
    return str(binary), log


def _log(path: Path) -> list[dict[str, Any]]:
    return [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []


def _received(path: Path, method: str) -> list[dict[str, Any]]:
    return [entry['in'] for entry in _log(path) if entry.get('in', {}).get('method') == method]


def _adapter(binary: str, w: World, **kwargs: Any) -> KiroAcp:
    return KiroAcp(binary=binary, version=KIRO_CLI_VERSION, agent_home=w.home, environment=HARNESS_ENV,
                   tool_env=TOOL_ENV, key=lambda: KEY, configs_dir=str(CONFIGS), poll_seconds=0.05,
                   timeouts={'exit': 5, 'cancel': 10, 'finish': 2}, **kwargs)


def _finish(**extra: Any) -> dict[str, Any]:
    return {'tool': '@voc/finish', 'finish': True, **extra}


# -- prompt, the config, the environment ----------------------------------------------------------------------------


def test_a_prompt_runs_to_its_finish_in_an_isolated_home_with_only_the_platforms_tools(tmp_path):
    w = world(tmp_path)
    _transcribed(w)
    binary, log = _fake(tmp_path, {'turns': [[{'think': 'look at parse'}, {'say': 'I will fix the parser.'},
                                              _finish(), {'stop': 'end_turn'}]]})
    assert _adapter(binary, w).run(w.session) == 'done'
    assert w.session.finished_elsewhere is True
    started = next(entry for entry in _log(log) if entry.get('started'))
    home = Path(w.home) / '.voc' / 'kiro' / 'home'
    # kiro-cli: its own home, an empty working directory there (never the checkout), the key in its environment only,
    # and none of the harness's AWS variables.
    assert started['cwd'] == str(home / 'work')
    assert started['key_set'] is True
    assert started['agents'] == ['fixer']
    assert 'AWS_CONFIG_FILE' not in started['env']
    assert 'VOC_RUN_ID' not in started['env']
    assert {'HOME', 'HTTPS_PROXY', 'KIRO_API_KEY', 'PATH', 'TMPDIR'} <= set(started['env'])
    config = json.loads((home / '.kiro' / 'agents' / 'fixer.json').read_text())
    names = sorted(spec.name for spec in w.session.tools.specs)
    assert config['tools'] == ['@voc']
    assert config['allowedTools'] == [f'@voc/{name}' for name in names]
    assert config['permissions'] == {'rules': [{'capability': 'mcp', 'match': [f'voc/{name}' for name in names],
                                                'effect': 'allow'}]}
    assert f'<<<DATA <name> {w.session.context.fence}>>>' in config['prompt']
    server = config['mcpServers']['voc']
    assert server['command'] == '/usr/bin/python3'
    assert server['args'] == ['-I', '/opt/voc/harness.py', 'tool-server']
    assert server['env']['KIRO_API_KEY'] == ''
    assert server['env']['VOC_RUN_ID'] == RUN_ID
    assert server['env']['VOC_SESSION_FILES'] == str(Path(w.home) / '.voc' / 'kiro' / 'session')
    # ACP: no fs or terminal capability; mcpServers forced to []; the role's agent selected; the brief as the prompt.
    initialize = _received(log, 'initialize')[0]['params']
    assert initialize['clientCapabilities'] == {'fs': {'readTextFile': False, 'writeTextFile': False}, 'terminal': False}
    assert _received(log, 'session/new')[0]['params'] == {'cwd': str(home / 'work'), 'mcpServers': []}
    assert _received(log, 'session/set_config_option')[0]['params']['value'] == 'fixer'
    prompt = _received(log, 'session/prompt')[0]['params']['prompt'][0]['text']
    assert 'Make tests/test_parse.py pass.' in prompt
    events = _events(w)
    kinds = [event['kind'] for event in events]
    # The chunks coalesced (one event each), the prompt's stop reason recorded.
    assert [event['text'] for event in events if event['kind'] == 'agent_thought_chunk'] == ['look at parse']
    assert [event['text'] for event in events if event['kind'] == 'agent_message_chunk'] == ['I will fix the parser.']
    assert {'kind': 'prompt_end', 'prompt': 'open', 'stop_reason': 'end_turn'}.items() <= next(
        event for event in events if event['kind'] == 'prompt_end').items()
    assert 'acp_session' in kinds
    # The platform's own calls are the tool server's to record (with their results): none here.
    assert not [event for event in events if event['kind'] == 'tool_call']
    assert KEY not in json.dumps(events)
    assert KEY not in json.dumps(config)


def test_a_turn_without_finish_is_nudged_once_then_ends_unfinished(tmp_path):
    w = world(tmp_path)
    binary, log = _fake(tmp_path, {'turns': [[{'say': 'hm'}], [{'say': 'still hm'}]]})
    assert _adapter(binary, w).run(w.session) == 'done'
    assert w.session.finished_elsewhere is False
    prompts = [frame['params']['prompt'][0]['text'] for frame in _received(log, 'session/prompt')]
    assert len(prompts) == 2
    assert 'call finish' in prompts[1]


# -- steering -------------------------------------------------------------------------------------------------------


def test_steering_is_a_prompt_mid_turn_in_the_steering_fence_and_kiro_goes_on_with_it(tmp_path):
    w = world(tmp_path)
    _transcribed(w)
    steer = InboxMessage(kind=STEER, summary='try the fix in ops.py first', event_id='ev-steer-1',
                         sender='coordinator-1')
    w.inbox.queued = [[], [], [steer]]
    binary, log = _fake(tmp_path, {'turns': [[{'say': 'working'}, {'hold': True}], [_finish()]]})
    assert _adapter(binary, w).run(w.session) == 'done'
    prompts = _received(log, 'session/prompt')
    assert len(prompts) == 2
    assert not _received(log, 'session/cancel')
    steering = prompts[1]['params']['prompt'][0]['text']
    fence = w.session.context.fence
    assert f'<<<STEERING steer:coordinator-1 {fence}>>>' in steering
    assert 'try the fix in ops.py first' in steering
    assert 'below the platform rules' in steering
    ends = [(event['prompt'], event['stop_reason']) for event in _events(w) if event['kind'] == 'prompt_end']
    assert ends == [('open', 'cancelled'), ('steer', 'end_turn')]
    assert any(event['kind'] == 'steer' and event['by'] == 'coordinator-1' for event in _events(w))
    # It reached the model with the prompt: done once the model saves notes after it (the CLI's rule).
    assert 'ev-steer-1' in w.session.seen_since_save


# -- stop (cancel) and resume (load) --------------------------------------------------------------------------------


def _paused(tmp_path: Path) -> tuple[World, Path, dict[str, Any]]:
    w = world(tmp_path)
    _transcribed(w)
    w.inbox.queued = [[], [], [InboxMessage(kind=PAUSE, event_id='ev-pause')]]
    binary, log = _fake(tmp_path, {'turns': [[{'say': 'first half'}, {'tool': '@voc/save_checkpoint',
                                                                      'notes': 'parser half done'},
                                              {'hold': True}]]})
    assert _adapter(binary, w).run(w.session) == 'paused'
    states = [json.loads(body) for key, body in sorted(w.store.objects.items()) if '/_checkpoints/' in key]
    return w, log, states[-1]



def _continuing(tmp_path: Path) -> World:
    """A new process's session continuing the paused one (``_paused``, in ``first``) from its checkpoint, its store
    holding what the first one saved."""
    first, _, state = _paused(tmp_path / 'first')
    w = world(tmp_path / 'second')
    _transcribed(w)
    w.store.objects.update(first.store.objects)
    w.session.restored = state
    return w

def test_a_pause_cancels_the_turn_ends_kiro_and_saves_its_session_with_the_checkpoint(tmp_path):
    w, log, last = _paused(tmp_path)
    assert _received(log, 'session/cancel') == [{'jsonrpc': '2.0', 'method': 'session/cancel',
                                                 'params': {'sessionId': 'sess_fake-1'}}]
    assert w.inbox.finished == ['ev-pause']
    kiro = last['position']['kiro']
    assert kiro['session_id'] == 'sess_fake-1'
    assert kiro['state'].startswith(artifact_prefix(RUN_ID, 'fixer-1', HARNESS_COMMIT, 1, 'kiro'))
    with tarfile.open(fileobj=io.BytesIO(w.store.objects[kiro['state']]), mode='r:gz') as archive:
        assert archive.getnames() == ['ws/sess_fake-1/messages.jsonl']
    assert last['notes'] == 'parser half done'
    assert [event['stop_reason'] for event in _events(w) if event['kind'] == 'prompt_end'] == ['cancelled']


def test_a_continuation_loads_the_saved_session_by_its_id_in_a_new_process(tmp_path):
    w = _continuing(tmp_path)
    binary, log = _fake(tmp_path / 'second', {'turns': [[_finish()]]})
    assert _adapter(binary, w).run(w.session) == 'done'
    assert _received(log, 'session/load')[0]['params']['sessionId'] == 'sess_fake-1'
    assert not _received(log, 'session/new')
    assert _received(log, 'session/prompt')[0]['params']['prompt'][0]['text'] == CONTINUE_LOADED
    events = _events(w)
    loaded = next(event for event in events if event['kind'] == 'acp_session')
    assert loaded['loaded'] is True
    assert loaded['replayed'] >= 2
    # The replayed history is not recorded again (the first session's transcript has it).
    assert 'first half' not in [event.get('text') for event in events]


def test_a_session_kiro_cannot_load_opens_a_new_one_from_the_checkpoints_notes(tmp_path):
    w = _continuing(tmp_path)
    w.session.notes = 'parser half done'
    binary, log = _fake(tmp_path / 'second', {'turns': [[_finish()]], 'load_session': False})
    assert _adapter(binary, w).run(w.session) == 'done'
    assert not _received(log, 'session/load')
    assert _received(log, 'session/new')
    assert 'parser half done' in _received(log, 'session/prompt')[0]['params']['prompt'][0]['text']
    why = next(event for event in _events(w) if event['kind'] == 'acp_session')
    assert why['loaded'] is False
    assert 'does not load' in why['why_not']


def test_a_child_runs_agent_loads_its_parents_session_from_the_seed(tmp_path):
    from engineering.runtime.harness import seed
    w = world(tmp_path)
    _transcribed(w)
    parent = tmp_path / 'parent-sessions' / 'ws' / 'sess_parent'
    parent.mkdir(parents=True)
    (parent / 'messages.jsonl').write_text(json.dumps({'kind': 'user', 'text': 'the parent brief'}) + '\n')
    key = seed.kiro_key(RUN_ID, 'task-0')
    w.store.objects[key] = pack_sessions(str(tmp_path / 'parent-sessions'))
    w.session.seed = {'parent': {'run_id': '01JD3R4NZXQ7Y2W8K4M6P9T0CD', 'agent_id': 'fixer-2', 'task_id': 'task-0',
                                 'attempt': 1, 'commit': HARNESS_COMMIT},
                      'kiro': {'session_id': 'sess_parent', 'state': key}}
    binary, log = _fake(tmp_path, {'turns': [[_finish()]]})
    assert _adapter(binary, w).run(w.session) == 'done'
    assert _received(log, 'session/load')[0]['params']['sessionId'] == 'sess_parent'
    first = _received(log, 'session/prompt')[0]['params']['prompt'][0]['text']
    assert first.startswith(CONTINUE_LOADED)
    assert 'A person resumed that earlier run (01JD3R4NZXQ7Y2W8K4M6P9T0CD)' in first


def test_a_saved_state_outside_the_agents_own_keys_is_never_restored(tmp_path):
    w = world(tmp_path)
    _transcribed(w)
    w.session.restored = {'position': {'kiro': {'session_id': 'sess_x', 'state': f'ws/default/runs/{RUN_ID}/other/x.tgz'}}}
    binary, log = _fake(tmp_path, {'turns': [[_finish()]]})
    assert _adapter(binary, w).run(w.session) == 'done'
    assert not _received(log, 'session/load')
    assert 'not under this agent' in next(event for event in _events(w) if event['kind'] == 'acp_session')['why_not']


# -- the permission policy ------------------------------------------------------------------------------------------


def test_permission_requests_are_answered_by_the_harness_policy_fail_closed(tmp_path):
    w = world(tmp_path)
    _transcribed(w)
    binary, log = _fake(tmp_path, {'turns': [[{'ask': '@voc/secret_tool'}, {'ask': 'ls -la'},
                                              {'ask': '@voc/report_progress'}, {'fs': '/etc/hostname'},
                                              _finish()]]})
    assert _adapter(binary, w).run(w.session) == 'done'
    answers = {entry['answered']: entry for entry in _log(log) if 'answered' in entry}
    permissions = [entry['with']['result']['outcome'] for entry in _log(log)
                   if entry.get('answered') == 'session/request_permission']
    assert [outcome.get('optionId', '').rsplit('-', 1)[0] for outcome in permissions] == [
        'reject_once', 'reject_once', 'allow_once']
    # A method the client offers none of is method-not-found, never an allow.
    assert answers['fs/read_text_file']['with']['error']['code'] == -32601
    decisions = [(event.get('title'), event['decision']) for event in _events(w) if event['kind'] == 'permission']
    assert decisions == [('@voc/secret_tool', 'refused'), ('ls -la', 'refused'), ('@voc/report_progress', 'allowed'),
                         (None, 'refused')]
    # The refused calls are in the transcript with their results (the tool server never saw them).
    results = [(event['tool'], event['status']) for event in _events(w) if event['kind'] == 'tool_result']
    assert results == [('secret_tool', 'failed'), ('kiro:ls_la', 'failed')]


def test_the_policy_never_allows_always_and_cancels_when_it_cannot_answer():
    allowed = frozenset({'finish'})
    options = [{'optionId': 'a', 'kind': 'allow_always'}, {'optionId': 'b', 'kind': 'reject_always'}]
    for title in ('@voc/finish', '@voc/run'):
        assert permission_answer({'toolCall': {'title': title}, 'options': options}, allowed).answer == {
            'outcome': {'outcome': 'cancelled'}}
    assert permission_answer({}, allowed).decision == 'cancelled'
    assert permission_answer({'toolCall': {'title': '@voc/../finish'}, 'options': [
        {'optionId': 'r', 'kind': 'reject_once'}]}, allowed).decision == 'refused'


# -- failing closed -------------------------------------------------------------------------------------------------


def test_kiro_selecting_another_agent_is_a_crash_with_the_work_saved(tmp_path):
    w = world(tmp_path)
    binary, _ = _fake(tmp_path, {'refuse_mode': True})
    with pytest.raises(AcpError, match='did not select the fixer agent'):
        _adapter(binary, w).run(w.session)
    assert [key for key in w.store.objects if '/_checkpoints/' in key]


def test_kiro_ending_mid_turn_is_a_crash(tmp_path):
    w = world(tmp_path)
    binary, _ = _fake(tmp_path, {'turns': [[{'say': 'bye'}, {'exit': True}]]})
    with pytest.raises(AcpError, match='kiro-cli ended'):
        _adapter(binary, w).run(w.session)


def test_a_kiro_cli_that_is_missing_or_not_the_pinned_version_is_refused(tmp_path):
    w = world(tmp_path)
    with pytest.raises(KiroNotOffered, match='not an installed kiro-cli'):
        _adapter('kiro-cli', w).run(w.session)
    binary, _ = _fake(tmp_path, {'version': '3.3.0'})
    with pytest.raises(KiroNotOffered, match=r'not the pinned kiro-cli 3\.4\.0'):
        _adapter(binary, w).run(w.session)


def test_a_role_with_no_compiled_config_or_one_with_kiros_own_tools_is_refused(tmp_path):
    with pytest.raises(KiroNotOffered, match='no compiled Kiro config'):
        compiled_config('nobody', str(CONFIGS))
    bad = tmp_path / 'fixer.json'
    bad.write_text(json.dumps({**json.loads((CONFIGS / 'fixer.json').read_text()), 'tools': ['@voc', 'shell']}))
    with pytest.raises(KiroNotOffered, match='offers Kiro tools'):
        compiled_config('fixer', str(tmp_path))
    bad.write_text(json.dumps({**json.loads((CONFIGS / 'fixer.json').read_text()),
                               'mcpServers': {'voc': {'command': '/bin/sh', 'args': []}}}))
    with pytest.raises(KiroNotOffered, match='tool server other than'):
        compiled_config('fixer', str(tmp_path))


def test_every_compiled_config_passes_the_harness_check():
    for path in sorted(CONFIGS.glob('*.json')):
        assert compiled_config(path.stem, str(CONFIGS))['tools'] == ['@voc']


def test_the_session_agent_serves_exactly_the_toolboxs_tools_from_its_registry(tmp_path):
    w = world(tmp_path, role='fixer')
    session: AgentSession = w.session
    config = session_agent(session, {'description': 'd'}, {'VOC_RUN_ID': RUN_ID, 'KIRO_API_KEY': KEY})
    assert config['allowedTools'] == sorted(f'@voc/{spec.name}' for spec in session.tools.specs)
    assert config['mcpServers']['voc']['env']['KIRO_API_KEY'] == ''
    assert config['mcpServers']['voc']['timeout'] > 3_600_000


def test_kiros_environment_is_built_never_inherited():
    env = kiro_env('/h', {**HARNESS_ENV, 'AWS_SECRET_ACCESS_KEY': 'x', 'VOC_BOARD_URL': 'u'}, KEY)
    assert env['KIRO_API_KEY'] == KEY
    assert env['HOME'] == '/h'
    assert env['HTTPS_PROXY'] == HARNESS_ENV['HTTPS_PROXY']
    assert not {'AWS_SECRET_ACCESS_KEY', 'VOC_BOARD_URL', 'AWS_CONFIG_FILE'} & set(env)


# -- the key --------------------------------------------------------------------------------------------------------


class _Ssm:
    def __init__(self, value: str = KEY, error: Exception | None = None) -> None:
        self.value, self.error, self.asked = value, error, []

    def get_parameter(self, **request: Any) -> dict[str, Any]:
        self.asked.append(request)
        if self.error is not None:
            raise self.error
        return {'Parameter': {'Value': self.value + '\n'}}


def test_the_key_is_read_decrypted_from_exactly_the_deployments_parameter():
    ssm = _Ssm()
    assert ssm_key('/b-voc/engineering/_kiro/api-key', 'us-west-2', ssm)() == KEY
    assert ssm.asked == [{'Name': '/b-voc/engineering/_kiro/api-key', 'WithDecryption': True}]
    with pytest.raises(KiroNotOffered):
        ssm_key('/voc/engineering/conn-1', 'us-west-2', ssm)


def test_a_key_that_cannot_be_read_says_why_never_what_it_held():
    class Refused(Exception):
        response: ClassVar[dict[str, Any]] = {'Error': {'Code': 'ParameterNotFound', 'Message': f'not {KEY}'}}

    with pytest.raises(KiroNotOffered) as raised:
        ssm_key('/voc/engineering/_kiro/api-key', 'us-east-1', _Ssm(error=Refused()))()
    assert 'ParameterNotFound' in str(raised.value)
    assert KEY not in str(raised.value)
    with pytest.raises(KiroNotOffered, match='holds no key'):
        ssm_key('/voc/engineering/_kiro/api-key', 'us-east-1', _Ssm(value=' '))()


# -- the saved state ------------------------------------------------------------------------------------------------


def test_the_session_state_packs_plain_files_and_cuts_a_line_being_written(tmp_path):
    root = tmp_path / 'sessions'
    (root / 'ws' / 'sess_a').mkdir(parents=True)
    (root / 'ws' / 'sess_a' / 'messages.jsonl').write_bytes(b'{"a":1}\n{"b":')
    (root / 'ws' / 'sess_a' / 'session.json').write_text('{}')
    os.symlink('/etc/hostname', root / 'ws' / 'sess_a' / 'link')
    body = pack_sessions(str(root))
    target = tmp_path / 'restored'
    assert unpack_sessions(body, str(target)) == 2
    assert (target / 'ws' / 'sess_a' / 'messages.jsonl').read_bytes() == b'{"a":1}\n'
    assert not (target / 'ws' / 'sess_a' / 'link').exists()


@pytest.mark.parametrize('name', ['../escape', '/abs/path', 'a/../../b'])
def test_a_state_with_an_entry_off_its_shape_is_refused(tmp_path, name):
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode='w:gz') as archive:
        info = tarfile.TarInfo(name)
        info.size = 1
        archive.addfile(info, io.BytesIO(b'x'))
    with pytest.raises(StateRefused):
        unpack_sessions(buffer.getvalue(), str(tmp_path / 'out'))
    assert not (tmp_path / 'escape').exists()


def test_a_state_holding_a_link_is_refused(tmp_path):
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode='w:gz') as archive:
        info = tarfile.TarInfo('ws/link')
        info.type, info.linkname = tarfile.SYMTYPE, '/etc/passwd'
        archive.addfile(info)
    with pytest.raises(StateRefused):
        unpack_sessions(buffer.getvalue(), str(tmp_path / 'out'))


# -- the ACP client's own bounds ------------------------------------------------------------------------------------


class _Pipe(io.StringIO):
    def flush(self) -> None:  # (nothing to flush)
        return None


def test_the_client_sends_only_its_methods_and_drops_frames_over_the_cap_or_to_no_request(monkeypatch):
    from engineering.runtime.harness import acp
    monkeypatch.setattr(acp, 'MAX_FRAME_BYTES', 200)
    frames = '\n'.join([json.dumps({'jsonrpc': '2.0', 'method': 'session/update', 'params': {'x': 'y' * 300}}),
                        json.dumps({'jsonrpc': '2.0', 'id': 99, 'result': {}}), '[1]', 'not json',
                        json.dumps({'jsonrpc': '2.0', 'id': 1, 'result': {'ok': True}})]) + '\n'
    seen: list[Any] = []
    stdin = _Pipe()
    client = AcpClient(stdin, io.StringIO(frames), on_request=lambda _method, _params: None,
                       on_notification=seen.append)
    for method in ('fs/read_text_file', 'terminal/create', 'session/delete'):
        with pytest.raises(ValueError, match='not a method this client sends'):
            client.request(method, {})
    with pytest.raises(ValueError, match='not a notification this client sends'):
        client.notify('session/prompt', {})
    ident = client.request('initialize', {})
    assert client.wait(ident, 5) == {'ok': True}
    assert seen == []
    assert client.dropped == 4
