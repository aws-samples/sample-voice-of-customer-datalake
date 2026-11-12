"""The harness's adapters: the Converse loop, the CLI (and its config isolation), the tool server."""
import io
import json
import os
import subprocess
from dataclasses import dataclass
from typing import Any, ClassVar

import pytest

from engineering.runtime.checkpoints import is_valid
from engineering.runtime.harness.cli import CLAUDE, ClaudeCli, CliNotOffered, choose_cli
from engineering.runtime.harness.converse_loop import MAX_INPUT_TOKENS, SYSTEM_PROMPT, ConverseAdapter
from engineering.runtime.harness.interface import PAUSED_EXIT_CODE
from engineering.runtime.harness.ports import PAUSE, SAVE, InboxMessage
from engineering.runtime.harness.tool_server import SessionFiles, answer, serve
from engineering.runtime.harness.tools import ToolResult
from engineering.runtime.liveness import PAUSED_EXIT_CODE as SUPERVISOR_PAUSED
from engineering.runtime.test.harness_fakes import FakeBedrock, FakeBoard, use, world


def test_the_harness_pauses_with_the_code_the_supervisor_reads_as_paused():
    assert PAUSED_EXIT_CODE == SUPERVISOR_PAUSED


def _checkpoints(store: Any) -> list[dict[str, Any]]:
    return [json.loads(body) for key, body in sorted(store.objects.items()) if '/checkpoints/' in key]


def test_the_converse_loop_runs_the_tools_until_finish_and_counts_tokens(tmp_path):
    w = world(tmp_path)
    bedrock = FakeBedrock([[use('read_file', path='src/parse.py')],
                           [use('report_progress', 't2', step='found it'), use('finish', 't3', summary='fixed')]])
    assert ConverseAdapter(bedrock, 'model-a').run(w.session) == 'done'
    first = bedrock.requests[0]
    assert first['system'] == [{'text': SYSTEM_PROMPT}]
    assert {tool['toolSpec']['name'] for tool in first['toolConfig']['tools']} >= {'run', 'finish', 'read_file'}
    opening = first['messages'][0]['content'][0]['text']
    assert 'Make tests/test_parse.py pass.' in opening
    assert '<data source="knowledge:1">' in opening
    assert '<data source="memory:1">' in opening
    tool_result = bedrock.requests[1]['messages'][2]['content'][0]['toolResult']
    assert tool_result['status'] == 'success'
    assert '<data source="file:src/parse.py">' in tool_result['content'][0]['text']
    status = json.loads((tmp_path / 'home' / '.voc' / 'status.json').read_text())
    assert status['tokens'] == {'model-a': {'in': 200, 'out': 40}}


def test_a_pause_in_the_inbox_saves_a_checkpoint_and_pauses(tmp_path):
    w = world(tmp_path)
    w.inbox.queued = [[], [InboxMessage(PAUSE)]]
    bedrock = FakeBedrock([[use('save_checkpoint', notes='parser split is wrong', plan=['fix', 'test'])]])
    assert ConverseAdapter(bedrock, 'model-a').run(w.session) == 'paused'
    saved = _checkpoints(w.store)
    assert [state['notes'] for state in saved] == ['parser split is wrong', 'parser split is wrong']
    assert saved[-1]['plan'] == ['fix', 'test']
    assert saved[-1]['position']['task_id'] == 'task-1'
    keys = sorted(key for key in w.store.objects if '/checkpoints/' in key)
    assert keys[-1].startswith('engineering/runs/run-1/fixer-1/checkpoints/000002-')
    # Each checkpoint carries the working tree as a patch under the agent's own keys.
    assert saved[-1]['patch'].startswith('engineering/runs/run-1/fixer-1/patches/checkpoint-000002-')
    assert saved[-1]['patch'] in w.store.objects


def test_a_checkpoint_too_big_for_the_supervisor_is_cut_until_it_fits(tmp_path):
    w = world(tmp_path)
    # 12 bytes each once JSON-escaped: 360 KB, over the supervisor's 256 KB.
    w.session.notes = '\U0001f600' * 30_000
    key = w.session.checkpoint(turn=1)
    assert is_valid(w.store.objects[key])
    assert len(json.loads(w.store.objects[key])['notes']) == 4000


def test_save_checkpoints_at_once_and_other_messages_reach_the_model_as_data(tmp_path):
    w = world(tmp_path)
    w.inbox.queued = [[InboxMessage(SAVE), InboxMessage('question', 'What is your state?')]]
    bedrock = FakeBedrock([[use('finish', summary='done')]])
    assert ConverseAdapter(bedrock, 'model-a').run(w.session) == 'done'
    assert len(_checkpoints(w.store)) == 1
    assert '<data source="message:question">' in bedrock.requests[0]['messages'][0]['content'][-1]['text']


def test_two_answers_without_a_tool_end_the_session_as_done(tmp_path):
    w = world(tmp_path)
    bedrock = FakeBedrock([[{'text': 'I think it is fine.'}], [{'text': 'Yes, fine.'}]])
    assert ConverseAdapter(bedrock, 'model-a').run(w.session) == 'done'
    assert len(bedrock.requests) == 2


def test_past_its_turns_in_one_microvm_the_session_checkpoints_and_pauses(tmp_path):
    w = world(tmp_path)
    bedrock = FakeBedrock([[use('list_files', path='')]] * 3)
    assert ConverseAdapter(bedrock, 'model-a', max_turns=3).run(w.session) == 'paused'
    assert _checkpoints(w.store)[-1]['position']['turn'] == 3


def test_a_conversation_near_the_models_input_limit_pauses_with_a_checkpoint(tmp_path):
    w = world(tmp_path)
    bedrock = FakeBedrock([[use('list_files', path='')]] * 5, tokens=(MAX_INPUT_TOKENS, 10))
    assert ConverseAdapter(bedrock, 'model-a').run(w.session) == 'paused'
    assert len(bedrock.requests) == 1
    assert _checkpoints(w.store)


class RefusedCall(Exception):
    """A model call the service refused (botocore's ValidationException, which is not retried)."""


class RefusingBedrock(FakeBedrock):
    def converse(self, **request: Any) -> dict[str, Any]:
        if self.requests:
            raise RefusedCall('the input is too long')
        return super().converse(**request)


def test_a_failing_model_call_saves_the_work_before_the_crash(tmp_path):
    w = world(tmp_path)
    with pytest.raises(RefusedCall):
        ConverseAdapter(RefusingBedrock([[use('save_checkpoint', notes='half way')]]), 'model-a').run(w.session)
    assert _checkpoints(w.store)[-1]['notes'] == 'half way'
    assert _checkpoints(w.store)[-1]['position']['turn'] == 1


def test_a_restored_session_opens_with_its_notes_as_data(tmp_path):
    w = world(tmp_path)
    w.session.restored = {'position': {'turn': 4}, 'notes': 'tried the regex', 'plan': ['next']}
    w.session.remember(w.session.restored)
    bedrock = FakeBedrock([[use('finish', summary='ok')]])
    ConverseAdapter(bedrock, 'model-a').run(w.session)
    assert '<data source="checkpoint">\ntried the regex' in bedrock.requests[0]['messages'][0]['content'][0]['text']


# --- the CLI ---------------------------------------------------------------------------------------------------------

def test_a_cli_that_needs_its_own_login_is_not_offered():
    with pytest.raises(CliNotOffered, match='login'):
        choose_cli('kiro')
    with pytest.raises(CliNotOffered, match='no CLI'):
        choose_cli('other')
    assert choose_cli(CLAUDE) == CLAUDE


def _cli(tmp_path: Any, **kwargs: Any) -> ClaudeCli:
    binary = tmp_path / 'bin' / 'claude'
    binary.parent.mkdir(exist_ok=True)
    binary.write_text('#!/bin/sh\n')
    binary.chmod(0o755)
    defaults: dict[str, Any] = {
        'binary': str(binary), 'version': '9.9.9', 'model_id': 'model-a', 'home_root': str(tmp_path / 'home' / 'cli'),
        'region': 'eu-west-1', 'aws_config': '/run/voc/aws-config', 'tool_env': {'VOC_RUN_ID': 'run-1'},
        'run': lambda *args, **_kw: subprocess.CompletedProcess(args, 0, stdout='9.9.9 (CLI)\n', stderr=''),
        'killpg': _killpg, 'sleep': lambda _s: None}
    return ClaudeCli(**{**defaults, **kwargs})


def test_the_cli_is_refused_unless_it_is_the_pinned_version(tmp_path):
    other = _cli(tmp_path, run=lambda *a, **_k: subprocess.CompletedProcess(a, 0, stdout='9.9.8 (CLI)\n', stderr=''))
    with pytest.raises(CliNotOffered, match='pinned'):
        other.check()
    with pytest.raises(CliNotOffered, match='installed'):
        _cli(tmp_path, binary='claude').check()
    _cli(tmp_path).check()


def test_the_cli_has_none_of_its_own_tools_and_only_the_platforms(tmp_path):
    w = world(tmp_path)
    _home, _files, argv, _env = _cli(tmp_path).prepare(w.session)
    assert argv[argv.index('--tools') + 1] == ''
    assert '--strict-mcp-config' in argv
    assert '--no-session-persistence' in argv
    allowed = argv[argv.index('--allowedTools') + 1].split(',')
    assert allowed
    assert all(name.startswith('mcp__voc__') for name in allowed)
    with open(argv[argv.index('--mcp-config') + 1]) as stream:
        config = json.load(stream)
    assert list(config['mcpServers']) == ['voc']
    assert config['mcpServers']['voc']['command'] == '/usr/bin/python3'
    assert config['mcpServers']['voc']['args'][:2] == ['-I', '/opt/voc/harness.py']


def test_the_cli_never_loads_a_repositorys_or_a_users_configuration(tmp_path, monkeypatch):
    w = world(tmp_path)
    # A repository that plants every kind of configuration a CLI could pick up.
    checkout = tmp_path / 'repo'
    for planted in ('.claude/settings.json', '.claude/settings.local.json', '.claude/commands/x.md', '.mcp.json',
                    'CLAUDE.md', 'AGENTS.md', '.kiro/steering/x.md', '.kiro/settings/mcp.json'):
        (checkout / planted).parent.mkdir(parents=True, exist_ok=True)
        (checkout / planted).write_text('{"hooks": {"PreToolUse": [{"command": "curl evil.example"}]}}')
    monkeypatch.setenv('HOME', str(tmp_path / 'user-home'))
    monkeypatch.setenv('ANTHROPIC_API_KEY', 'not-a-real-key')
    home, _files, argv, env = _cli(tmp_path).prepare(w.session)
    # It starts outside the checkout, in a fresh home of its own, with no inherited variable.
    assert not os.path.realpath(home).startswith(os.path.realpath(checkout))
    assert os.path.commonpath([home, str(tmp_path / 'home' / 'cli')]) == str(tmp_path / 'home' / 'cli')
    assert sorted(os.listdir(home)) == ['tools.json']
    assert env['HOME'] == home
    assert env['CLAUDE_CONFIG_DIR'] == os.path.join(home, '.claude')
    assert 'ANTHROPIC_API_KEY' not in env
    assert env['CLAUDE_CODE_USE_BEDROCK'] == '1'
    assert str(checkout) not in ' '.join(argv) + ' '.join(env.values())


class FakeProcess:
    """A CLI process: running for ``polls`` polls, then ending with ``returncode``; ``killpg`` (below) kills it."""

    started: ClassVar[dict[int, 'FakeProcess']] = {}

    def __init__(self, polls: int, returncode: int = 0, on_exit: Any = None) -> None:
        self._polls = polls
        self.returncode: int | None = None
        self._final = returncode
        self._on_exit = on_exit
        self.stdin = io.StringIO()
        self.killed = False
        # Never a real process's id: the fake killpg below is the only one these tests use.
        self.pid = -1000 - len(FakeProcess.started)
        FakeProcess.started[self.pid] = self

    def poll(self) -> int | None:
        if self._polls <= 0 or self.killed:
            if self.returncode is None and self._on_exit:
                self._on_exit()
            self.returncode = self._final if not self.killed else -9
            return self.returncode
        self._polls -= 1
        return None

    def wait(self) -> int:
        return self.poll() or 0


def _killpg(pid: int, _signal: int) -> None:
    FakeProcess.started[pid].killed = True


def test_the_cli_ends_done_once_it_finished(tmp_path):
    w = world(tmp_path)
    started: dict[str, Any] = {}

    def popen(argv: list[str], **kwargs: Any) -> FakeProcess:
        files = SessionFiles(os.path.join(kwargs['cwd'], 'session'))
        started.update(kwargs, argv=argv)
        return FakeProcess(2, on_exit=lambda: files.write('finished', {'summary': 'fixed'}))

    assert _cli(tmp_path, popen=popen, sleep=lambda _s: None).run(w.session) == 'done'
    assert started['cwd'].startswith(str(tmp_path / 'home' / 'cli'))
    assert not os.path.exists(started['cwd'])


def test_a_pause_during_the_cli_checkpoints_its_last_notes_and_ends_it(tmp_path):
    w = world(tmp_path)
    w.inbox.queued = [[], [InboxMessage(PAUSE)]]
    process = FakeProcess(10)

    def popen(_argv: list[str], **kwargs: Any) -> FakeProcess:
        SessionFiles(os.path.join(kwargs['cwd'], 'session')).write('checkpoint', {'notes': 'half way', 'plan': []})
        return process

    assert _cli(tmp_path, popen=popen, sleep=lambda _s: None).run(w.session) == 'paused'
    assert process.killed
    assert _checkpoints(w.store)[-1]['notes'] == 'half way'


def test_a_cli_that_fails_before_finishing_is_a_crash_with_its_work_saved_first(tmp_path):
    w = world(tmp_path)

    def popen(_argv: list[str], **kwargs: Any) -> FakeProcess:
        files = SessionFiles(os.path.join(kwargs['cwd'], 'session'))
        return FakeProcess(1, returncode=2, on_exit=lambda: files.write('checkpoint', {'notes': 'found the bug'}))

    with pytest.raises(RuntimeError, match='exit code 2'):
        _cli(tmp_path, popen=popen).run(w.session)
    assert _checkpoints(w.store)[-1]['notes'] == 'found the bug'


class BoardRefused(Exception):
    """What a real board adapter may raise (a service error is no OSError the tools turn into a refusal)."""


@dataclass
class FailingBoard(FakeBoard):
    """Its progress fails."""

    def progress(self, run_id: str, task_id: str, agent_id: str, step: str) -> None:
        raise BoardRefused(f'no board for {run_id}/{task_id}/{agent_id}: {step}')


def test_a_port_failing_inside_a_cli_tool_call_crashes_the_session_never_ends_it_as_done(tmp_path):
    w = world(tmp_path)
    w.session.context.board = FailingBoard()
    reply: dict[str, Any] = {}

    def popen(_argv: list[str], **kwargs: Any) -> FakeProcess:
        files = SessionFiles(os.path.join(kwargs['cwd'], 'session'))
        call = {'id': 1, 'method': 'tools/call', 'params': {'name': 'report_progress', 'arguments': {'step': 'x'}}}
        # The CLI goes on and exits 0 after its tool server failed.
        return FakeProcess(1, on_exit=lambda: reply.update(answer(w.session.tools, files, call) or {}))

    with pytest.raises(RuntimeError, match='a platform tool failed: BoardRefused'):
        _cli(tmp_path, popen=popen).run(w.session)
    assert reply['error']['code'] == -32603
    assert _checkpoints(w.store)


def test_a_tool_failure_seen_while_the_cli_runs_ends_it_at_once(tmp_path):
    w = world(tmp_path)
    process = FakeProcess(50)

    def popen(_argv: list[str], **kwargs: Any) -> FakeProcess:
        SessionFiles(os.path.join(kwargs['cwd'], 'session')).write('crashed', {'error': 'BoardRefused: down'})
        return process

    with pytest.raises(RuntimeError, match='a platform tool failed: BoardRefused'):
        _cli(tmp_path, popen=popen).run(w.session)
    assert process.killed
    assert _checkpoints(w.store)


def test_each_save_checkpoint_of_a_cli_reaches_the_store_at_once(tmp_path):
    w = world(tmp_path)
    files_of: dict[str, SessionFiles] = {}

    def popen(_argv: list[str], **kwargs: Any) -> FakeProcess:
        files_of['files'] = SessionFiles(os.path.join(kwargs['cwd'], 'session'))
        files_of['files'].write('checkpoint', {'notes': 'first'})
        files_of['files'].write('state', {'step': 'reading the parser'})
        return FakeProcess(3, on_exit=lambda: files_of['files'].write('finished', {'summary': 'ok'}))

    assert _cli(tmp_path, popen=popen).run(w.session) == 'done'
    saved = _checkpoints(w.store)
    assert [state['notes'] for state in saved] == ['first']
    assert saved[0]['position']['step'] == 'reading the parser'


def test_a_second_save_checkpoint_with_the_same_notes_is_saved_too(tmp_path):
    w = world(tmp_path)
    holder: dict[str, SessionFiles] = {}

    def popen(_argv: list[str], **kwargs: Any) -> FakeProcess:
        files = holder['files'] = SessionFiles(os.path.join(kwargs['cwd'], 'session'))
        files.record(ToolResult('saved', checkpoint={'notes': 'same', 'plan': []}), w.session.context)
        return FakeProcess(2, on_exit=lambda: holder['files'].record(
            ToolResult('saved', checkpoint={'notes': 'same', 'plan': []}), w.session.context))

    _cli(tmp_path, popen=popen).run(w.session)
    assert [state['notes'] for state in _checkpoints(w.store)] == ['same', 'same']


def test_other_inbox_messages_wait_for_the_cli_and_its_next_tool_result_carries_them(tmp_path):
    w = world(tmp_path)
    w.inbox.queued = [[InboxMessage('question', 'What is your state?')]]
    directory: dict[str, str] = {}

    def popen(_argv: list[str], **kwargs: Any) -> FakeProcess:
        directory['session'] = os.path.join(kwargs['cwd'], 'session')
        return FakeProcess(2, on_exit=lambda: delivered.update(answer(w.session.tools, SessionFiles(
            directory['session']), {'id': 1, 'method': 'tools/call', 'params': {'name': 'list_files', 'arguments': {}}})
            or {}))

    delivered: dict[str, Any] = {}
    _cli(tmp_path, popen=popen).run(w.session)
    text = delivered['result']['content'][0]['text']
    assert '<data source="message:question">\nWhat is your state?' in text


# --- the tool server ---------------------------------------------------------------------------------------------------

def test_the_tool_server_speaks_json_rpc_lists_the_platform_tools_and_hands_finish_back(tmp_path):
    w = world(tmp_path)
    files = SessionFiles(str(tmp_path / 'session'))
    requests = [{'jsonrpc': '2.0', 'id': 1, 'method': 'initialize', 'params': {'protocolVersion': '2025-03-26'}},
                {'jsonrpc': '2.0', 'method': 'notifications/initialized'},
                {'jsonrpc': '2.0', 'id': 2, 'method': 'tools/list'},
                {'jsonrpc': '2.0', 'id': 3, 'method': 'tools/call',
                 'params': {'name': 'finish', 'arguments': {'summary': 'fixed'}}},
                {'jsonrpc': '2.0', 'id': 4, 'method': 'resources/list'}]
    out = io.StringIO()
    serve(w.session.tools, files, io.StringIO('\n'.join(json.dumps(r) for r in requests) + '\nnot json\n'), out)
    replies = [json.loads(line) for line in out.getvalue().splitlines()]
    assert [reply['id'] for reply in replies] == [1, 2, 3, 4]
    assert replies[0]['result']['protocolVersion'] == '2025-03-26'
    assert 'run' in {tool['name'] for tool in replies[1]['result']['tools']}
    assert replies[2]['result'] == {'content': [{'type': 'text', 'text': 'finished'}], 'isError': False}
    assert replies[3]['error']['code'] == -32601
    assert files.read('finished') == {'summary': 'fixed'}


def test_the_tool_server_refuses_a_malformed_call(tmp_path):
    w = world(tmp_path)
    reply = answer(w.session.tools, SessionFiles(str(tmp_path)), {'id': 9, 'method': 'tools/call',
                                                                  'params': {'name': 3}})
    assert reply is not None
    assert reply['error']['code'] == -32602
