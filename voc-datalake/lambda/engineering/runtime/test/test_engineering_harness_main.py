"""The harness's entry point: the session from the agent's environment, its restore, its heartbeat, its exit codes."""
import json
import shutil
import stat
import subprocess
import sys
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import pytest
from botocore.exceptions import ClientError

from engineering.runtime.checkout import checkout_commands
from engineering.runtime.harness import main as harness_main
from engineering.runtime.harness.board_client import InboxHttp
from engineering.runtime.harness.cli import CliNotOffered
from engineering.runtime.harness.main import Ports, S3Store, build_session, main
from engineering.runtime.harness.ports import HarnessPortNotWired, PendingHarnessPorts
from engineering.runtime.harness.runner_client import RunnerClient
from engineering.runtime.test.conftest import BUCKET
from engineering.runtime.test.harness_fakes import FakeBedrock, FakeBoard, FakeBroker, FakeInbox, FakeRunner, use
from engineering.runtime.test.test_engineering_images import IMAGES, RUNTIME, SHIPPED
from engineering.runtime.unit_runner import Runner, serve
from engineering.workspace.layout import parse_agent_key

PREFIX = 'ws/default/runs/01JD3R4NZXQ7Y2W8K4M6P9T0AB/fixer-1/'
CHECKPOINTS = 'ws/default/runs/01JD3R4NZXQ7Y2W8K4M6P9T0AB/fixer-1/commits/cccccccccccccccccccccccccccccccccccccccc/_checkpoints/attempt-1/'
PATCHES = 'ws/default/runs/01JD3R4NZXQ7Y2W8K4M6P9T0AB/fixer-1/commits/cccccccccccccccccccccccccccccccccccccccc/_patches/attempt-1/'
#: The test's own git, by absolute path (the fixture repository it builds is the test's, not a MicroVM's).
GIT_BIN = shutil.which('git') or '/usr/bin/git'


@dataclass
class BeatingBoard(FakeBoard):
    """Says when ``wanted`` heartbeats have come."""

    wanted: int = 1
    beat: threading.Event = field(default_factory=threading.Event)

    def heartbeat(self, *, run_id: str, task_id: str, agent_id: str) -> None:
        super().heartbeat(run_id=run_id, task_id=task_id, agent_id=agent_id)
        if len(self.heartbeats) >= self.wanted:
            self.beat.set()


def _env(tmp_path: Any, **extra: str) -> dict[str, str]:
    (tmp_path / 'home').mkdir(exist_ok=True)
    return {'VOC_RUN_ID': '01JD3R4NZXQ7Y2W8K4M6P9T0AB', 'VOC_AGENT_ID': 'fixer-1', 'VOC_TASK_ID': 'task-1', 'VOC_ROLE': 'fixer',
            'VOC_WORKSPACE_BUCKET': BUCKET, 'VOC_COMMIT': 'c' * 40, 'AWS_REGION': 'us-east-1', 'AWS_CONFIG_FILE': '/run/voc/aws-config',
            'HOME': str(tmp_path / 'home'), **extra}


def _ports(board: FakeBoard | None = None) -> Ports:
    return Ports(board=board or FakeBoard(), inbox=FakeInbox(), broker=FakeBroker())


def _session(s3: Any, tmp_path: Any, runner: FakeRunner | None = None, **extra: str) -> Any:
    return build_session(_env(tmp_path, **extra), s3=s3, ports=_ports(), runner=runner or FakeRunner(),
                         checkout=str(tmp_path))


def test_the_session_comes_from_the_agents_environment_and_restores_its_own_checkpoint(aws, tmp_path):
    s3, _ = aws
    key = f'{CHECKPOINTS}000007-abcd.json'
    s3.put_object(Bucket=BUCKET, Key=key, Body=json.dumps({'position': {'turn': 3}, 'notes': 'n', 'plan': ['p']}))
    session = _session(s3, tmp_path, VOC_RESTORE_KEY=key)
    assert (session.context.task_id, session.context.own_prefix) == ('task-1', PREFIX)
    assert (session.restored_seq, session.notes, session.plan) == (7, 'n', ['p'])
    assert session.checkpoint(turn=1).startswith(f'{CHECKPOINTS}000008-')



@dataclass
class PausedInbox:
    """The board's inbox op holding one old pause: every read answers it, as the window behind the tail does."""

    reads: list[int] = field(default_factory=list)

    def post(self, body: dict[str, Any]) -> dict[str, Any]:
        self.reads.append(body['after'])
        return {'messages': [{'seq': 1, 'event_id': 'E-PAUSE', 'type': 'signal.pause', 'summary': 'pause'}],
                'next': 0}


def test_a_continuation_does_not_take_again_the_pause_its_first_session_acted_on(aws, tmp_path):
    s3, _ = aws
    board = PausedInbox()
    first = _inbox_session(s3, tmp_path, board)
    assert first.take_messages() == ([], True)
    key = first.checkpoint(turn=4)  # the pause's checkpoint
    saved = json.loads(s3.get_object(Bucket=BUCKET, Key=key)['Body'].read())
    assert saved['position']['inbox'] == {'after': 0, 'done': [{'id': 'E-PAUSE', 'seq': 1}]}
    # The continuation reads the inbox again (the old pause still answers) and takes nothing: no second pause.
    assert _inbox_session(s3, tmp_path, board, VOC_RESTORE_KEY=key).take_messages() == ([], False)
    assert board.reads == [0, 0]


def test_a_checkpoints_cursor_is_handed_to_the_inbox_whatever_it_holds(aws, tmp_path):
    s3, _ = aws
    key = f'{CHECKPOINTS}000002-abcd.json'
    s3.put_object(Bucket=BUCKET, Key=key, Body=json.dumps({'position': {'turn': 1, 'inbox': 'nonsense'}, 'notes': ''}))
    ports = _ports()
    build_session(_env(tmp_path, VOC_RESTORE_KEY=key), s3=s3, ports=ports, runner=FakeRunner(), checkout=str(tmp_path))
    assert isinstance(ports.inbox, FakeInbox)
    assert ports.inbox.resumed == 'nonsense'  # handed on; InboxHttp.resume ignores what is not a cursor

def _checkpoint_with_a_tree(s3: Any) -> str:
    """A checkpoint of the agent's whose working tree is a patch under its own keys; the checkpoint's key."""
    tree = f'{PATCHES}checkpoint-000003-ab.diff'
    s3.put_object(Bucket=BUCKET, Key=tree, Body=b'diff --git a/x b/x\n')
    key = f'{CHECKPOINTS}000003-ab.json'
    s3.put_object(Bucket=BUCKET, Key=key, Body=json.dumps({'position': {'turn': 1}, 'notes': '', 'patch': tree}))
    return key


def test_a_continuation_puts_its_working_tree_back_on_the_fresh_checkout(aws, tmp_path):
    s3, _ = aws
    runner = FakeRunner()
    _session(s3, tmp_path, runner, VOC_RESTORE_KEY=_checkpoint_with_a_tree(s3))
    applied = [call for call in runner.calls if 'apply' in call['argv']]
    assert len(applied) == 1
    assert '--git-dir=../repo.git' in applied[0]['argv']
    assert not applied[0]['repository_code']
    patch = Path(applied[0]['argv'][-1])
    assert patch.read_bytes() == b'diff --git a/x b/x\n'


def _vm_directory(root: Path, cache: Path, commit: str) -> RunnerClient:
    """A MicroVM's /work at ``root`` with the commit checked out from ``cache``, and a client of its own runner."""
    for part in ('work', 'home', 'secrets'):
        (root / part).mkdir(parents=True)
    runner = Runner(str(root / 'work'), sandbox=False, secrets_dir=str(root / 'secrets'), agent_home=str(root / 'home'))
    server = serve('127.0.0.1', 0, runner)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    client = RunnerClient(f'http://127.0.0.1:{server.server_address[1]}', sleep=lambda _s: time.sleep(0.02))
    for command in checkout_commands(commit, [], source=f'file://{cache}'):
        assert client.run(command.argv, timeout_seconds=60, repository_code=False, in_checkout=False)['exit_code'] == 0
    return client


def test_a_working_tree_survives_a_continuation_on_real_git_and_lands_only_in_the_checkout(aws, tmp_path):
    s3, _ = aws
    origin, cache = tmp_path / 'origin', tmp_path / 'cache.git'
    git = [GIT_BIN, '-c', 'user.name=Example', '-c', 'user.email=dev@example.org', '-c', 'init.defaultBranch=main']
    (origin / 'src').mkdir(parents=True)
    (origin / 'src' / 'parse.py').write_text('old\n')
    for argv in (['init', '--quiet', str(origin)], ['-C', str(origin), 'add', '.'],
                 ['-C', str(origin), 'commit', '--quiet', '-m', 'first'], ['clone', '--quiet', '--bare', str(origin),
                                                                        str(cache)]):
        subprocess.run([*git, *argv], check=True, capture_output=True)
    commit = subprocess.run([GIT_BIN, '-C', str(origin), 'rev-parse', 'HEAD'], check=True, capture_output=True,
                            text=True).stdout.strip()
    first = _vm_directory(tmp_path / 'vm-1', cache, commit)
    env = _env(tmp_path, VOC_ROLE='fixer')
    session = build_session(env, s3=s3, ports=_ports(), runner=first, checkout=str(tmp_path / 'vm-1/work/repo'))
    (tmp_path / 'vm-1/work/repo/src/parse.py').write_text('new\n')
    (tmp_path / 'vm-1/work/repo/src/added.py').write_text('added\n')
    # A file named like the agent's git directory's own: inside the checkout it is only a file of the checkout.
    (tmp_path / 'vm-1/work/repo/repo.git').mkdir()
    (tmp_path / 'vm-1/work/repo/repo.git/commondir').write_text('../repo/evil\n')
    key = session.checkpoint(turn=1)

    second = _vm_directory(tmp_path / 'vm-2', cache, commit)
    build_session({**env, 'VOC_RESTORE_KEY': key}, s3=s3, ports=_ports(), runner=second,
                  checkout=str(tmp_path / 'vm-2/work/repo'))
    work = tmp_path / 'vm-2/work'
    # Open to repository code again (a formatter may rewrite them), as the checkout leaves its own files.
    for written in ('repo/src/parse.py', 'repo/src/added.py', 'repo/src'):
        assert (work / written).stat().st_mode & stat.S_IWGRP
    assert (work / 'repo/src/parse.py').read_text() == 'new\n'
    assert (work / 'repo/src/added.py').read_text() == 'added\n'
    assert (work / 'repo/repo.git/commondir').read_text() == '../repo/evil\n'
    assert not (work / 'repo.git' / 'commondir').exists()
    assert sorted(path.name for path in work.iterdir()) == ['repo', 'repo.git']


def test_a_working_tree_that_does_not_apply_is_a_crash_never_a_silent_loss(aws, tmp_path):
    s3, _ = aws
    with pytest.raises(RuntimeError, match='does not apply'):
        _session(s3, tmp_path, FakeRunner(apply_exit=1), VOC_RESTORE_KEY=_checkpoint_with_a_tree(s3))


@pytest.mark.parametrize('key', [CHECKPOINTS.replace('fixer-1', 'other-1') + '000001-a.json',
                                 f'{CHECKPOINTS}sub/000001-a.json', f'{PREFIX}notes.json',
                                 CHECKPOINTS.replace('attempt-1', 'attempt-2') + '000001-a.json'],
                         ids=['another-agent', 'nested', 'not-a-checkpoint', 'another-attempt'])
def test_a_restore_key_that_is_not_one_of_the_agents_own_checkpoints_starts_afresh(aws, tmp_path, key):
    s3, _ = aws
    s3.put_object(Bucket=BUCKET, Key=key, Body=json.dumps({'position': 1, 'notes': 'planted'}))
    session = _session(s3, tmp_path, VOC_RESTORE_KEY=key)
    assert (session.restored, session.notes) == (None, '')


def test_the_tasks_attempt_names_every_key_the_harness_writes(aws, tmp_path):
    s3, _ = aws
    session = _session(s3, tmp_path, VOC_ATTEMPT='2')
    parsed = parse_agent_key(session.checkpoint(turn=1))
    assert parsed is not None
    assert (parsed.kind, parsed.attempt, parsed.sha, parsed.agent) == ('checkpoints', 2, 'c' * 40, 'fixer-1')
    assert session.context.patches_prefix == PATCHES.replace('attempt-1', 'attempt-2')


def test_an_invalid_checkpoint_is_not_restored(aws, tmp_path):
    s3, _ = aws
    key = f'{CHECKPOINTS}000002-a.json'
    s3.put_object(Bucket=BUCKET, Key=key, Body=json.dumps({'position': 1, 'notes': {'api_token': 'x'}}))
    assert _session(s3, tmp_path, VOC_RESTORE_KEY=key).restored is None


def test_the_store_puts_only_under_the_agents_own_keys(aws):
    s3, _ = aws
    store = S3Store(s3, BUCKET, PREFIX)
    for key in ('ws/default/runs/01JD3R4NZXQ7Y2W8K4M6P9T0AB/other-1/x', f'{PREFIX}../other-1/x'):
        with pytest.raises(ValueError, match='own keys'):
            store.put(key, b'x')
    store.put(f'{PATCHES}p.diff', b'x')
    # Create-only (If-None-Match, which the workspace bucket requires): an object is never written over.
    with pytest.raises(ClientError, match='PreconditionFailed'):
        store.put(f'{PATCHES}p.diff', b'y')
    assert s3.get_object(Bucket=BUCKET, Key=f'{PATCHES}p.diff')['Body'].read() == b'x'


def test_run_exits_0_when_done_and_75_when_paused(aws, tmp_path):
    s3, _ = aws
    args = ['run', '--adapter', 'converse', '--model', 'model-a']
    done = FakeBedrock([[use('finish', summary='ok')]])
    assert main(args, _env(tmp_path), s3=s3, ports=_ports(), bedrock=lambda: done, runner=FakeRunner()) == 0
    paused = FakeBedrock([[use('list_files', path='')]] * 200)
    assert main(args, _env(tmp_path), s3=s3, ports=_ports(), bedrock=lambda: paused, runner=FakeRunner()) == 75


def test_the_lease_is_renewed_while_the_session_runs(aws, tmp_path, monkeypatch):
    s3, _ = aws
    monkeypatch.setattr(harness_main, 'HEARTBEAT_SECONDS', 0.01)
    board = BeatingBoard(wanted=2)

    class SlowBedrock(FakeBedrock):
        def converse(self, **request: Any) -> dict[str, Any]:
            board.beat.wait(5)
            return super().converse(**request)

    args = ['run', '--adapter', 'converse', '--model', 'model-a']
    assert main(args, _env(tmp_path), s3=s3, ports=_ports(board), runner=FakeRunner(),
                bedrock=lambda: SlowBedrock([[use('finish', summary='ok')]])) == 0
    # The first renewal is main's own; the second can only come from the thread renewing while the session runs.
    assert len(board.heartbeats) >= 2
    assert board.heartbeats[1] == ('01JD3R4NZXQ7Y2W8K4M6P9T0AB', 'task-1', 'fixer-1')


@dataclass
class FlakyBoard(BeatingBoard):
    """Its first heartbeat fails; the next ones are recorded."""

    failed: int = 0

    def heartbeat(self, *, run_id: str, task_id: str, agent_id: str) -> None:
        if not self.failed:
            self.failed += 1
            raise OSError('the board is not answering')
        super().heartbeat(run_id=run_id, task_id=task_id, agent_id=agent_id)


def test_a_failed_heartbeat_does_not_end_the_renewals(monkeypatch):
    monkeypatch.setattr(harness_main, 'HEARTBEAT_SECONDS', 0.01)
    board, stop = FlakyBoard(), threading.Event()
    ids = {'VOC_RUN_ID': '01JD3R4NZXQ7Y2W8K4M6P9T0AB', 'VOC_TASK_ID': 'task-1', 'VOC_AGENT_ID': 'fixer-1'}
    harness_main._renew(board, ids)  # fails, and is said
    beating = threading.Thread(target=harness_main._heartbeat, args=(board, ids, stop), daemon=True)
    beating.start()
    assert board.beat.wait(5)
    stop.set()
    beating.join(5)
    assert board.failed == 1
    assert board.heartbeats[0] == ('01JD3R4NZXQ7Y2W8K4M6P9T0AB', 'task-1', 'fixer-1')


@dataclass
class OrderedBoard(FakeBoard):
    """Records what came first: a heartbeat or the brief."""

    order: list[str] = field(default_factory=list)

    def heartbeat(self, *, run_id: str, task_id: str, agent_id: str) -> None:
        self.order.append('heartbeat')
        super().heartbeat(run_id=run_id, task_id=task_id, agent_id=agent_id)

    def brief(self, *, run_id: str, task_id: str) -> Any:
        self.order.append('brief')
        return super().brief(run_id=run_id, task_id=task_id)


def test_a_fresh_start_claims_its_brief_before_any_renewal(aws, tmp_path):
    s3, _ = aws
    board = OrderedBoard()
    main(['run', '--adapter', 'converse', '--model', 'model-a'], _env(tmp_path), s3=s3, ports=_ports(board),
         runner=FakeRunner(), bedrock=lambda: FakeBedrock([[use('finish', summary='ok')]]))
    # Its task is not claimed yet: a renewal first would be refused.
    assert board.order[0] == 'brief'


def test_a_continuation_renews_its_lease_at_once_before_the_restore(aws, tmp_path):
    s3, _ = aws
    key = f'{CHECKPOINTS}000002-abcd.json'
    s3.put_object(Bucket=BUCKET, Key=key, Body=json.dumps({'position': {'turn': 1}, 'notes': ''}))
    board = OrderedBoard()
    main(['run', '--adapter', 'converse', '--model', 'model-a'], _env(tmp_path, VOC_RESTORE_KEY=key), s3=s3,
         ports=_ports(board), runner=FakeRunner(), bedrock=lambda: FakeBedrock([[use('finish', summary='ok')]]))
    assert board.order[0] == 'heartbeat'
    # Restored: no first checkpoint of a fresh start written beside it.
    keys = [item['Key'] for item in s3.list_objects_v2(Bucket=BUCKET, Prefix=CHECKPOINTS)['Contents']]
    assert keys == [key]


def test_until_the_board_lands_the_harness_refuses_rather_than_guess(aws, tmp_path):
    s3, _ = aws
    with pytest.raises(HarnessPortNotWired, match='not wired yet'):
        main(['run', '--adapter', 'converse', '--model', 'model-a'], _env(tmp_path), s3=s3, runner=FakeRunner())


@pytest.mark.parametrize(('method', 'args', 'kwargs'), [
    ('brief', (), {'run_id': 'r', 'task_id': 't'}), ('heartbeat', (), {'run_id': 'r', 'task_id': 't', 'agent_id': 'a'}),
    ('progress', ('r', 't', 'a', 's'), {}), ('take', (), {'run_id': 'r', 'agent_id': 'a'}),
    ('submit', ('r', 'a', 't', 'k', 's'), {})], ids=['brief', 'heartbeat', 'progress', 'take', 'submit'])
def test_every_pending_harness_port_refuses(method, args, kwargs):
    with pytest.raises(HarnessPortNotWired):
        getattr(PendingHarnessPorts(), method)(*args, **kwargs)


def test_a_cli_session_refuses_kiro_and_a_missing_cli(aws, tmp_path):
    s3, _ = aws
    with pytest.raises(CliNotOffered, match='login'):
        main(['run', '--adapter', 'cli', '--cli', 'kiro', '--model', 'm'], _env(tmp_path), s3=s3, ports=_ports(),
             runner=FakeRunner())
    with pytest.raises(CliNotOffered, match='installed'):
        main(['run', '--adapter', 'cli', '--model', 'm', '--cli-binary', str(tmp_path / 'none'), '--cli-version',
              '1'], _env(tmp_path), s3=s3, ports=_ports(), runner=FakeRunner())


def test_the_images_entry_script_imports_the_harness_from_its_own_directory_under_isolated_mode(tmp_path):
    # The image's layout: /opt/voc/harness.py beside /opt/voc/engineering/..., run with -I (no path but its own).
    opt = tmp_path / 'opt-voc'
    for module in SHIPPED:
        target = opt / 'engineering' / module.relative_to(RUNTIME.parent)
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy(module, target)
    shutil.copy(RUNTIME.parent / '__init__.py', opt / 'engineering' / '__init__.py')
    shutil.copy(IMAGES / 'common' / 'harness.py', opt / 'harness.py')
    shown = subprocess.run([sys.executable, '-I', str(opt / 'harness.py'), '--help'], capture_output=True, text=True,
                           timeout=60, cwd=tmp_path, check=False)
    assert shown.returncode == 0, shown.stderr
    assert 'usage: harness' in shown.stdout


def test_the_tool_servers_session_reads_no_brief(aws, tmp_path):
    s3, _ = aws
    board = FakeBoard()
    session = build_session(_env(tmp_path), s3=s3, ports=_ports(board), runner=FakeRunner(), checkout=str(tmp_path),
                            restore=False)
    assert (board.briefs_asked, session.context.brief.task_id) == ([], 'task-1')


@dataclass
class Batch:
    """The inbox op answering one batch, then nothing new (the window behind the tail answers it again)."""

    notices: list[tuple[str, str]]

    def post(self, body: dict[str, Any]) -> dict[str, Any]:
        del body
        return {'messages': [{'seq': n, 'event_id': f'E{n}', 'type': kind, 'summary': text}
                             for n, (kind, text) in enumerate(self.notices, 1)], 'next': 0}



class Failing:
    """The board's inbox op failing (a 503 past its retries)."""

    def post(self, body: dict[str, Any]) -> dict[str, Any]:
        raise RuntimeError(f'board down ({body["op"]})')

def _inbox_session(s3: Any, tmp_path: Any, board: Batch | Failing | PausedInbox, **extra: str) -> Any:
    ports = Ports(board=FakeBoard(), inbox=InboxHttp(board, '01JD3R4NZXQ7Y2W8K4M6P9T0AB', 'fixer-1'), broker=FakeBroker())
    return build_session(_env(tmp_path, **extra), s3=s3, ports=ports, runner=FakeRunner(), checkout=str(tmp_path))


def test_an_answer_taken_with_a_pause_reaches_the_continuation(aws, tmp_path):
    s3, _ = aws
    board = Batch([('msg.answer', 'Use the second parser.'), ('signal.pause', 'pause')])
    first = _inbox_session(s3, tmp_path, board)
    notes, pause = first.take_messages()
    assert pause
    key = first.checkpoint(turn=2)  # the pause's checkpoint: the answer was never shown to the model
    others, again = _inbox_session(s3, tmp_path, board, VOC_RESTORE_KEY=key).take_messages()
    assert (notes, [(note.kind, note.summary) for note in others], again) == (
        notes, [('msg.answer', 'Use the second parser.')], False)


def test_a_save_in_a_batch_leaves_the_batchs_other_messages_to_be_read_again(aws, tmp_path):
    s3, _ = aws
    board = Batch([('signal.save', 'save'), ('msg.answer', 'Yes, go on.')])
    first = _inbox_session(s3, tmp_path, board)
    first.take_messages()
    [key] = [item['Key'] for item in s3.list_objects_v2(Bucket=BUCKET, Prefix=CHECKPOINTS)['Contents']]
    # The save is done; the answer, not yet shown to the model, is before the cursor's end: read again.
    others, _ = _inbox_session(s3, tmp_path, board, VOC_RESTORE_KEY=key).take_messages()
    assert [(note.kind, note.summary) for note in others] == [('msg.answer', 'Yes, go on.')]


def test_a_continuation_whose_first_read_fails_keeps_the_cursor_it_restored(aws, tmp_path):
    s3, _ = aws
    board = Batch([('msg.answer', 'Use the second parser.'), ('signal.pause', 'pause')])
    first = _inbox_session(s3, tmp_path, board)
    first.take_messages()
    key = first.checkpoint(turn=2)
    second = _inbox_session(s3, tmp_path, Failing(), VOC_RESTORE_KEY=key)
    with pytest.raises(RuntimeError, match='board down'):
        second.take_messages()
    crash = second.checkpoint(turn=0)  # the crash's checkpoint: the answer is still to be read
    others, _ = _inbox_session(s3, tmp_path, board, VOC_RESTORE_KEY=crash).take_messages()
    assert [note.summary for note in others] == ['Use the second parser.']


def test_messages_the_model_saved_after_are_not_handed_out_again(aws, tmp_path):
    s3, _ = aws
    board = Batch([('msg.answer', 'Yes.')])
    first = _inbox_session(s3, tmp_path, board)
    first.take_messages()  # shown to the model
    first.take_messages()  # the loop came back: the batch reached it
    first.remember({'notes': 'The person said yes.', 'plan': []})  # the model saved its notes after
    key = first.checkpoint(turn=3)
    assert _inbox_session(s3, tmp_path, board, VOC_RESTORE_KEY=key).take_messages() == ([], False)


def test_a_message_the_model_had_but_never_saved_after_is_read_again(aws, tmp_path):
    s3, _ = aws
    board = Batch([('msg.answer', 'Use the second parser.')])
    first = _inbox_session(s3, tmp_path, board)
    first.take_messages()
    first.take_messages()  # it reached the model; then a pause before the model saved its notes
    key = first.checkpoint(turn=3)
    others, _ = _inbox_session(s3, tmp_path, board, VOC_RESTORE_KEY=key).take_messages()
    assert [note.summary for note in others] == ['Use the second parser.']


def test_a_continuation_reads_its_brief_in_its_checkpoint_and_claims_nothing(aws, tmp_path):
    s3, _ = aws
    key = f'{CHECKPOINTS}000004-abcd.json'
    s3.put_object(Bucket=BUCKET, Key=key, Body=json.dumps({
        'position': {'turn': 2, 'brief': {'title': 'Fix the parser', 'instructions': 'Read src/parse.py.'}},
        'notes': ''}))
    board = FakeBoard()
    session = build_session(_env(tmp_path, VOC_RESTORE_KEY=key), s3=s3, ports=_ports(board), runner=FakeRunner(),
                            checkout=str(tmp_path))
    assert (board.briefs_asked, session.context.brief.title, session.context.brief.instructions) == (
        [], 'Fix the parser', 'Read src/parse.py.')


def test_a_checkpoint_saves_the_brief_for_its_continuation(aws, tmp_path):
    s3, _ = aws
    key = _session(s3, tmp_path).checkpoint(turn=1)
    saved = json.loads(s3.get_object(Bucket=BUCKET, Key=key)['Body'].read())
    assert set(saved['position']['brief']) == {'title', 'instructions'}


def test_a_fresh_start_saves_its_brief_in_a_first_checkpoint_at_once(aws, tmp_path):
    s3, _ = aws
    board = FakeBoard()
    main(['run', '--adapter', 'converse', '--model', 'model-a'], _env(tmp_path), s3=s3, ports=_ports(board),
         runner=FakeRunner(), bedrock=lambda: FakeBedrock([[use('finish', summary='ok')]]))
    [first, *_] = sorted(item['Key'] for item in s3.list_objects_v2(Bucket=BUCKET, Prefix=CHECKPOINTS)['Contents'])
    saved = json.loads(s3.get_object(Bucket=BUCKET, Key=first)['Body'].read())
    # A continuation after a crash before any save of the agent's restores it: no claim of a task it holds.
    assert (first.removeprefix(CHECKPOINTS)[:6], saved['position']['turn'], set(saved['position']['brief'])) == (
        '000001', 0, {'title', 'instructions'})


def test_a_session_ending_without_finish_sends_its_task_to_a_person_never_done(aws, tmp_path):
    calls: list[str] = []

    class Ordered(FakeBoard):
        def progress(self, run_id: str, task_id: str, agent_id: str, step: str) -> None:
            super().progress(run_id, task_id, agent_id, step)
            calls.append(step)

        def move(self, run_id: str, task_id: str, *, to_state: str) -> None:
            super().move(run_id, task_id, to_state=to_state)
            calls.append(to_state)

    s3, _ = aws
    board = Ordered()
    # Two answers without a tool: the loop ends the session, the model never said it was done (it may have given up).
    assert main(['run', '--adapter', 'converse', '--model', 'model-a'], _env(tmp_path), s3=s3, ports=_ports(board),
                runner=FakeRunner(), bedrock=lambda: FakeBedrock([[], []])) == 0
    assert board.moves == [('01JD3R4NZXQ7Y2W8K4M6P9T0AB', 'task-1', 'needs_human')]
    # Its last progress report says why, before the move (the board takes none once the task left its holder).
    assert board.progress_seen[-1][1:] == ('task-1', 'fixer-1', harness_main.STOPPED_UNFINISHED)
    assert calls[-2:] == [harness_main.STOPPED_UNFINISHED, 'needs_human']


def test_a_finish_moves_the_task_once(aws, tmp_path):
    s3, _ = aws
    board = FakeBoard()
    main(['run', '--adapter', 'converse', '--model', 'model-a'], _env(tmp_path), s3=s3, ports=_ports(board),
         runner=FakeRunner(), bedrock=lambda: FakeBedrock([[use('finish', summary='ok')]]))
    assert [move[2] for move in board.moves] == ['done']


def test_a_refused_move_at_the_end_is_a_crash_never_a_success(aws, tmp_path):
    from engineering.runtime.harness.board_client import BoardRefused

    class Refused(FakeBoard):
        def move(self, run_id: str, task_id: str, *, to_state: str) -> None:
            raise BoardRefused(409, f'the lease of {run_id}/{task_id} is not yours or has run out: no {to_state}')

    s3, _ = aws
    with pytest.raises(BoardRefused):
        main(['run', '--adapter', 'converse', '--model', 'model-a'], _env(tmp_path), s3=s3, ports=_ports(Refused()),
             runner=FakeRunner(), bedrock=lambda: FakeBedrock([[], []]))


def test_a_run_coordinator_that_stops_without_finish_is_a_crash_never_its_task_sent_to_a_person(aws, tmp_path):
    s3, _ = aws
    board = FakeBoard()
    session = build_session(_env(tmp_path, VOC_ROLE='coordinator', VOC_AGENT_ID='coordinator-1',
                                 VOC_TASK_ID='coordinate'), s3=s3, ports=_ports(board), runner=FakeRunner(),
                            checkout=str(tmp_path))
    # Its task is the run's plan: the supervisor continues it, then sends the run to a person, whose Resume
    # replaces it (the task still held, so it can be re-posted).
    with pytest.raises(harness_main.CoordinatorStopped):
        harness_main._finished(session)
    assert (board.moves, board.progress_seen[-1][3]) == ([], harness_main.STOPPED_UNFINISHED)


def test_a_session_its_cli_tool_server_finished_moves_nothing_more(aws, tmp_path):
    s3, _ = aws
    board = FakeBoard()
    session = build_session(_env(tmp_path), s3=s3, ports=_ports(board), runner=FakeRunner(), checkout=str(tmp_path))
    session.finished_elsewhere = True  # the CLI's tool server's finish moved the task to done
    harness_main._finished(session)
    assert board.moves == []
