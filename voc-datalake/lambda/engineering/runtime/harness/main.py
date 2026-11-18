"""The harness's entry point in the image: ``/usr/bin/python3 -I /opt/voc/harness.py <command> ...``.

- ``run --adapter converse|cli|kiro --model <model id> [--cli claude --cli-binary <path> --cli-version <v>]
  [--kiro-version <v> --kiro-key-parameter <name>]``: run the agent's session (its skill picks the model and the
  converse or cli adapter; a deployment that runs the role on Kiro, ``-c engineeringHarness``, has its launch name
  ``kiro``: runtime/harness_switch.py; the launch request carries this argv) and exit with the runtime's code: 0 done,
  75 paused after its checkpoint, 1 (Python's, on anything raised) a crash.
- ``tool-server``: the platform's tools for a CLI (``tool_server``), started by that CLI.

Everything else comes from the agent's own environment (``unit_runner.AGENT_ENV``: its ids, its region, the
bucket its session was handed with, the board's and the broker's function URLs) and its role session
(``AWS_CONFIG_FILE``). Its skill (7.50.00) is the board's answer for the label its launch recorded
(``Board.skill``), fetched before anything else and never chosen here: a fetch that fails crashes the session, never
falls back to another skill; its task's brief takes its approved lessons from the board's ``memory``. The board, the
inbox, the run coordinator's planner and the knowledge reader are reached through the board API
(``board_client.py``), the repository host's reads and writes through the broker (``broker_client.py``), each
signed with that session; a port whose URL the session was not handed refuses (``ports.PendingHarnessPorts``), so a
session stops at its first call to it rather than guess.

7.51.00: a fresh start whose task names a child run's seed (its spec's ``seed_key``, ``harness/seed.py``) takes its
notes, plan and working tree (``git apply`` on the parent's own commit, ``git apply --3way`` on a moved base; what does
not apply reaches the model as data, never a crash); every session reads the run's direction at its start
(``AgentSession.read_direction``); and the transcript's clock flushes its events every ``transcript.FLUSH_SECONDS``
beside the heartbeat.

7.54.00: the tool server's ``wait_for_agents`` takes the batches its harness leaves (``tool_server.waiter``), and a
coordinator's continuation first closes the wait its last session may have left open (``CONTINUING``).
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import threading
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field, replace
from typing import Any, Final

from engineering.quality_gate.text import nonce
from engineering.runtime.checkout import repo_git, share_working_tree
from engineering.runtime.checkpoints import MAX_CHECKPOINT_BYTES, SHA, agent_prefix, artifact_prefix, is_valid
from engineering.runtime.harness.board_client import (
    BoardHttp,
    BoardKnowledge,
    BoardPlanner,
    BoardRefused,
    InboxHttp,
    SignedTransport,
    board_url,
)
from engineering.runtime.harness.broker_client import BrokerHttp, SignedBroker
from engineering.runtime.harness.cli import CLAUDE, ClaudeCli, choose_cli
from engineering.runtime.harness.converse_loop import ConverseAdapter
from engineering.runtime.harness.gate_tools import configured_gates_dir
from engineering.runtime.harness.interface import DONE_EXIT_CODE, PAUSED_EXIT_CODE, Adapter, AgentSession
from engineering.runtime.harness.kiro import KEY_ENV, KIRO_BINARY, KiroAcp, ssm_key
from engineering.runtime.harness.ports import (
    Board,
    Broker,
    Inbox,
    KnowledgeReader,
    PendingHarnessPorts,
    Planner,
    TaskBrief,
)
from engineering.runtime.harness.role_tools import GATE_ROLES, MAX_RESULT_KEYS, judge_submitted_patch
from engineering.runtime.harness.runner_client import RunnerClient
from engineering.runtime.harness.seed import MAX_SEED_BYTES, SeedError, check_seed_key
from engineering.runtime.harness.seed import parse as parse_seed
from engineering.runtime.harness.skills import Skill
from engineering.runtime.harness.status import StatusReport
from engineering.runtime.harness.tool_server import SessionFiles, serve, waiter
from engineering.runtime.harness.tools import MAX_CHECKS, MAX_PATCH_BYTES, AgentContext, Runs, ToolBox
from engineering.runtime.harness.transcript import FLUSH_SECONDS, Transcript
from engineering.runtime.harness.workspace import Workspace
from engineering.runtime.interface import check_id

CHECKOUT_ROOT: Final = '/work/repo'
#: The tree a gate's harness hashed, handed to the CLI's tool server (which shares its checkout) in its environment.
GATE_TREE_ENV: Final = 'VOC_GATE_TREE'
#: The session's fence, handed to the CLI's tool server the same way, so one session fences with one nonce.
FENCE_ENV: Final = 'VOC_FENCE'
_FENCE: Final = re.compile(r'[0-9a-f]{16}\Z')
HEARTBEAT_SECONDS: Final = 60.0
#: The run coordinator's role (its stop without ``finish`` is a crash: ``_finished``).
COORDINATOR_ROLE: Final = 'coordinator'
#: The last progress report of a session that stopped without its ``finish`` (its task goes to a person).
STOPPED_UNFINISHED: Final = 'Stopped without saying the task is done: a person decides what happens next.'
#: The run coordinator's (its stop is a crash, which the supervisor continues: no person is asked yet).
COORDINATOR_STOPPED: Final = 'Stopped without finishing the run: continued as a crash.'
#: A coordinator continuation's first progress report, which closes a wait its last session left open (7.54.00).
CONTINUING: Final = 'continuing from the checkpoint'


class S3Store:
    """Create-only puts under the agent's own keys only (its role allows nothing else, and the workspace bucket
    refuses a put without ``If-None-Match``; this refuses before trying)."""

    def __init__(self, s3: Any, bucket: str, own_prefix: str) -> None:
        self._s3 = s3
        self._bucket = bucket
        self._own = own_prefix

    def put(self, key: str, body: bytes) -> None:
        if not key.startswith(self._own) or '..' in key.split('/'):
            raise ValueError(f'{key} is not under the agent\'s own keys')
        self._s3.put_object(Bucket=self._bucket, Key=key, Body=body, IfNoneMatch='*')

    def get(self, key: str, limit: int) -> bytes:
        return bytes(self._s3.get_object(Bucket=self._bucket, Key=key)['Body'].read(limit + 1))

    def list(self, prefix: str, token: str | None = None) -> dict[str, Any]:
        """One page of the run's keys under ``prefix`` (its role lists its run's prefix only)."""
        return dict(self._s3.list_objects_v2(Bucket=self._bucket, Prefix=prefix,
                                             **({'ContinuationToken': token} if token else {})))


@dataclass(frozen=True)
class Ports:
    board: Board
    inbox: Inbox
    broker: Broker
    #: The run coordinator's: the board's tasks, posting, launching; the knowledge pack's agent reader.
    planner: Planner = field(default_factory=PendingHarnessPorts)
    knowledge: KnowledgeReader = field(default_factory=PendingHarnessPorts)


def build_session(env: Mapping[str, str], *, s3: Any, ports: Ports, runner: Runs,
                  checkout: str = CHECKOUT_ROOT, restore: bool = True) -> AgentSession:
    """The agent's session from its environment: its ids, its brief, its tools and (``restore``: the harness
    itself, never its tool server) its restored checkpoint, working tree included. The brief is the checkpoint's when
    it has one (a continuation: the board's claim is a fresh start's only), else the holder's claim; the tool server
    reads no brief (only the model's loop does) and so never claims."""
    run_id, agent_id, task_id = env['VOC_RUN_ID'], env['VOC_AGENT_ID'], env['VOC_TASK_ID']
    prefix = agent_prefix(run_id, agent_id)
    commit, attempt = env['VOC_COMMIT'], int(env.get('VOC_ATTEMPT', '1'))
    store = S3Store(s3, env['VOC_WORKSPACE_BUCKET'], prefix)
    home = env['HOME']
    checkpoints = artifact_prefix(run_id, agent_id, commit, attempt, 'checkpoints')
    restored = _read(store, checkpoints, env.get('VOC_RESTORE_KEY')) if restore else None
    saved = _saved_brief(restored, task_id)
    context = AgentContext(
        run_id=run_id, agent_id=agent_id, task_id=check_id('task_id', task_id), role=env['VOC_ROLE'],
        brief=saved or (ports.board.brief(run_id=run_id, task_id=task_id) if restore else TaskBrief(task_id, '', '')),
        workspace=Workspace(checkout), runner=runner,
        board=ports.board, broker=ports.broker, store=store, status=StatusReport(home),
        patch_dir=os.path.join(home, '.voc', 'patches'), own_prefix=prefix,
        checkpoints_prefix=checkpoints,
        patches_prefix=artifact_prefix(run_id, agent_id, commit, attempt, 'patches'),
        transcript=Transcript(store, artifact_prefix(run_id, agent_id, commit, attempt, 'transcripts')),
        flush_each_call=not restore,
        planner=ports.planner, knowledge=ports.knowledge, commit=commit, attempt=attempt,
        model=env.get('VOC_MODEL', ''), gates_dir=configured_gates_dir(env),
        # (the tool server takes the harness's own fence; the harness makes its own)
        fence=fence if not restore and _FENCE.fullmatch(fence := env.get(FENCE_ENV, '')) else nonce())
    skill = session_skill(ports.board, context)
    if restore and not saved:
        # (a continuation's brief is its checkpoint's, which kept what it recalled in its notes)
        context.brief = replace(context.brief, memory=_recalled(ports.board, context))
    session = AgentSession(context=context, tools=ToolBox(context, skill), inbox=ports.inbox, store=store)
    if context.role in GATE_ROLES:
        # A gate judges the submitted patch its task names: applied and hashed by the harness before anything runs
        # (a continuation's working tree is a patch on that tree, so it goes back on after). The CLI's tool server
        # shares the checkout the harness set up and takes the tree the harness hashed (``VOC_GATE_TREE``).
        tree = env.get(GATE_TREE_ENV, '')
        context.gate_tree = judge_submitted_patch(context, store) if restore else tree if SHA.fullmatch(tree) else ''
    if restored is not None:
        _restore(session, store, *restored)
    elif restore and context.brief.seed_key:
        # (a child run's task, 7.51.00: its seed's notes, plan and working tree; a continuation has its own checkpoint)
        _seeded(session, store, context.brief.seed_key)
    if restore:
        # The run's direction, read at each session's start (a continuation's too), then only when an inbox page
        # names a newer version (``AgentSession.read_direction``).
        session.read_direction()
    return session


#: The tail of git's words a seed's conflict hands the model at most.
MAX_SEED_CONFLICT: Final = 4_000


def _seeded(session: AgentSession, store: S3Store, key: str) -> None:
    """Start from the child run's seed (``harness/seed.py``): its key only under the session's own run's ``_seed/``,
    its record checked, its checkpoint's notes and plan taken, and, for an agent that runs code, its working tree put on
    the checkout: ``git apply`` on the parent's own commit, ``git apply --3way`` on another (the child's base moved to
    the default branch's head). A tree that does not apply cleanly reaches the model as data (``seed_conflict``), never
    a crash; a seed that cannot be read or is off its shape is said on the status and the task starts afresh."""
    context = session.context
    try:
        record = parse_seed(store.get(check_seed_key(key, context.run_id), MAX_SEED_BYTES), context.run_id)
    except SeedError as refused:
        session.seed_refused = str(refused)[:200]
    except Exception as error:  # noqa: BLE001 - a seed that cannot be read starts the task afresh, said
        session.seed_refused = f'the seed could not be read ({type(error).__name__})'
    else:
        if record is None:
            session.seed_refused = 'the seed is not a voc-resume-seed/1 record of this run'
        else:
            session.seed = record
    if session.seed is None:
        context.status.at(f'started afresh: {session.seed_refused}')
        return
    checkpoint = session.seed.get('checkpoint')
    if checkpoint is not None:
        session.notes, session.plan = checkpoint['notes'], list(checkpoint['plan'])
    patch_key = session.seed.get('patch_key')
    if patch_key and context.runs_code:
        same = session.seed['parent']['commit'] == context.commit
        session.seed_conflict = _apply_seed(context, store, patch_key, three_way=not same)
    context.status.at('started from the earlier run\'s seed' + (' (its working tree with conflicts)'
                                                                  if session.seed_conflict else ''))


def _apply_seed(context: AgentContext, store: S3Store, patch_key: str, *, three_way: bool) -> str:
    """Put the seed's working tree on the checkout; '' when it applied cleanly, else what git said (and the files the
    patch touches)."""
    patch = store.get(patch_key, MAX_PATCH_BYTES)
    if len(patch) > MAX_PATCH_BYTES:
        return f'the earlier run\'s working tree {patch_key} is over the patch limit: it was not applied'
    os.makedirs(context.patch_dir, mode=0o700, exist_ok=True)
    local = os.path.join(context.patch_dir, 'seed.diff')
    with open(local, 'wb') as stream:
        stream.write(patch)
    apply = ('apply', '--binary', *(('--3way',) if three_way else ()), local)
    result = context.runner.run(repo_git(*apply), timeout_seconds=600, repository_code=False, in_checkout=False)
    said = ''
    if result.get('exit_code') != 0:
        touched = context.runner.run(repo_git('apply', '--numstat', local), timeout_seconds=300,
                                     repository_code=False, in_checkout=False)
        files = [line.split('\t')[-1] for line in str(touched.get('stdout_tail', '')).splitlines() if '\t' in line]
        said = (f'git apply {"--3way " if three_way else ""}exited {result.get("exit_code")}: '
                f'{str(result.get("stderr_tail", ""))[-MAX_SEED_CONFLICT:]}\nthe patch touches: '
                f'{", ".join(files[:50]) or "(unknown)"}')
    opened = context.runner.run(share_working_tree(), timeout_seconds=300, repository_code=False, in_checkout=False)
    if opened.get('exit_code') != 0:
        raise RuntimeError('the seeded working tree could not be opened to repository code')
    return said


def _recalled(board: Board, context: AgentContext) -> tuple[str, ...]:
    """The task's approved lessons (the board's ``memory``); none when the board refuses them (advisory: a session
    never stops for its recall), said on its status."""
    try:
        return board.memory(run_id=context.run_id, task_id=context.task_id)
    except BoardRefused as refused:
        context.status.at(f'no memory recalled ({refused.status})')
        return ()


def session_skill(board: Board, context: AgentContext) -> Skill:
    """The skill the session runs: the board's answer for the label the launch recorded (its record, and the
    platform's rules to put around it). Anything else is raised: a crash, never a fallback to another skill."""
    answer = board.skill(run_id=context.run_id, role=context.role)
    skill = Skill.from_record(answer.record)
    if skill.name != context.role:
        raise RuntimeError(f'the board answered the skill of {skill.name}, not of {context.role}')
    context.platform_rules, context.skill_label = answer.platform_rules, answer.label
    context.status.at(f'skill {answer.label}')
    return skill


def _read(store: S3Store, checkpoints: str, key: str | None) -> tuple[str, dict[str, Any]] | None:
    """The checkpoint at ``key`` when it is one of the agent's own valid ones (its name and state), else None (the
    session starts afresh)."""
    if not key:
        return None
    name = key.removeprefix(checkpoints)
    if not key.startswith(checkpoints) or '/' in name:
        return None
    body = store.get(key, MAX_CHECKPOINT_BYTES)
    return (name, json.loads(body)) if is_valid(body) else None


def _saved_brief(restored: tuple[str, dict[str, Any]] | None, task_id: str) -> TaskBrief | None:
    """The brief a checkpoint saved for this task, if any."""
    position = restored[1].get('position') if restored is not None else None
    if not isinstance(position, dict) or position.get('task_id', task_id) != task_id:
        return None
    brief = position.get('brief')
    if not (isinstance(brief, dict) and isinstance(brief.get('title'), str)
            and isinstance(brief.get('instructions'), str)):
        return None
    patch = brief.get('patch')
    return TaskBrief(task_id=task_id, title=brief['title'], instructions=brief['instructions'],
                     patch=patch if isinstance(patch, str) else '')


def _restore(session: AgentSession, store: S3Store, name: str, state: dict[str, Any]) -> None:
    """Restore from one of the agent's own valid checkpoints (``_read``), and put its working tree back on the fresh
    checkout; a working tree that does not apply is a crash, never a silent loss."""
    context = session.context
    session.restored = state
    session.restored_seq = int(name.split('-', 1)[0]) if name.split('-', 1)[0].isdigit() else 0
    session.remember(state)
    position = state.get('position')
    # The inbox from where the checkpoint left it: what never reached the model is read again from the board;
    # nothing the first session acted on (a pause) is taken again.
    session.inbox.resume(position.get('inbox') if isinstance(position, dict) else None)
    refused = position.get('patch_refused') if isinstance(position, dict) else None
    session.patch_refused = str(refused) if refused else None
    # The outputs written before (role_tools): still recorded on the task when it finishes, never written again.
    results = position.get('results') if isinstance(position, dict) else None
    context.result_keys = [key for key in results if isinstance(key, str) and key.startswith(context.own_prefix)
                           ][:MAX_RESULT_KEYS] if isinstance(results, list) else []
    # The checks it ran before (a gate record's), as the harness recorded them, never as anything else said them.
    checks = position.get('checks') if isinstance(position, dict) else None
    context.checks = [{'name': str(check['name'])[:200], 'status': check['status']} for check in checks
                      if isinstance(check, dict) and 'name' in check and check.get('status') in ('pass', 'fail')
                      ][:MAX_CHECKS] if isinstance(checks, list) else []
    gate = position.get('gate') if isinstance(position, dict) else None
    if isinstance(gate, dict) and gate.get('ran') is True and context.checks:
        # (run_gate's run before the crash: its checks above, its packs' plain names)
        packs, versions = gate.get('packs'), gate.get('tool_versions')
        context.gate_ran = True
        context.gate_packs = tuple(str(pack)[:64] for pack in packs if isinstance(pack, str))[:20] \
            if isinstance(packs, list) else ()
        context.gate_tool_versions = {str(tool)[:64]: version[:200] for tool, version in list(versions.items())[:20]
                                      if isinstance(version, str)} if isinstance(versions, dict) else {}
    tree = state.get('patch')
    if isinstance(tree, str) and tree.startswith(context.patches_prefix) and context.runs_code:
        session.patch = tree
        os.makedirs(context.patch_dir, mode=0o700, exist_ok=True)
        local = os.path.join(context.patch_dir, 'restored.diff')
        patch = store.get(tree, MAX_PATCH_BYTES)
        if len(patch) > MAX_PATCH_BYTES:
            raise RuntimeError(f'the checkpoint\'s working tree {tree} is over the patch limit')
        with open(local, 'wb') as stream:
            stream.write(patch)
        result = context.runner.run(repo_git('apply', '--binary', local), timeout_seconds=600,
                                    repository_code=False, in_checkout=False)
        if result.get('exit_code') != 0:
            raise RuntimeError(f'the checkpoint\'s working tree {tree} does not apply to the checkout')
        # The files git wrote back are the agent's (umask 0022): open the working tree to the group again, as the
        # checkout does, so repository steps (a formatter, a generator) can rewrite them.
        opened = context.runner.run(share_working_tree(), timeout_seconds=300, repository_code=False,
                                    in_checkout=False)
        if opened.get('exit_code') != 0:
            raise RuntimeError('the restored working tree could not be opened to repository code')


def _renew(board: Board, ids: Mapping[str, str]) -> None:
    """Renew the task's lease (the supervisor's crash clock); a failed renewal is said on stderr and the next one
    tries again (the lease outlives three missed minutes)."""
    try:
        board.heartbeat(run_id=ids['VOC_RUN_ID'], task_id=ids['VOC_TASK_ID'], agent_id=ids['VOC_AGENT_ID'])
    except Exception as error:  # noqa: BLE001 - one failed renewal must not end the renewals
        sys.stderr.write(f'harness: the lease was not renewed ({type(error).__name__}); trying again\n')


def _heartbeat(board: Board, ids: Mapping[str, str], stop: threading.Event) -> None:
    """Renew the lease once a minute until ``stop``."""
    while not stop.wait(HEARTBEAT_SECONDS):
        _renew(board, ids)


#: How often the transcript's clock looks for events held ``FLUSH_SECONDS`` (so a live thread lags by at most both).
FLUSH_POLL_SECONDS: Final = FLUSH_SECONDS / 3


def _start_flusher(session: AgentSession, stop: threading.Event) -> None:
    """The transcript's clock, beside the heartbeat, for the session's life (none without a transcript)."""
    if session.context.transcript is not None:
        threading.Thread(target=_flusher, args=(session.context.transcript, stop), daemon=True).start()


def _flusher(transcript: Transcript, stop: threading.Event) -> None:
    """Flush the transcript's events once the oldest is ``FLUSH_SECONDS`` old (7.51.00), until ``stop``."""
    while not stop.wait(FLUSH_POLL_SECONDS):
        transcript.flush_due()


def default_ports(env: Mapping[str, str], credentials: Any = None) -> Ports:
    """The board, the inbox, the planner and the knowledge reader on the board's function URL (``VOC_BOARD_URL``), the
    broker on the broker's (``VOC_BROKER_URL``), each signed with the agent's own session (the board refuses the
    planner's ops to anyone but the run's coordinator, the broker every operation the caller's role may not make). A
    port whose URL the session was not handed refuses (``PendingHarnessPorts``)."""
    pending = PendingHarnessPorts()
    board, broker = env.get('VOC_BOARD_URL'), env.get('VOC_BROKER_URL')
    if not (board or broker):
        return Ports(board=pending, inbox=pending, broker=pending)
    if credentials is None:
        import boto3
        credentials = boto3.Session(region_name=env['AWS_REGION']).get_credentials()
    run_id, task_id, agent_id = env['VOC_RUN_ID'], env['VOC_TASK_ID'], env['VOC_AGENT_ID']
    writes: Broker = pending
    if broker:
        writes = BrokerHttp(SignedBroker(board_url(broker), env['AWS_REGION'], credentials), run_id, agent_id,
                            env.get('VOC_COMMIT', ''), attempt=int(env.get('VOC_ATTEMPT', '1')))
    if not board:
        return Ports(board=pending, inbox=pending, broker=writes)
    transport = SignedTransport(board_url(board), env['AWS_REGION'], credentials)
    # The lease's epoch is the task's attempt (the board's claim sets it so): the harness, a continuation and the CLI's
    # tool server renew, report and move on it without claiming.
    return Ports(board=BoardHttp(transport, run_id, task_id, epoch=int(env.get('VOC_ATTEMPT', '1'))),
                 inbox=InboxHttp(transport, run_id, agent_id), broker=writes,
                 planner=BoardPlanner(transport, run_id), knowledge=BoardKnowledge(transport, run_id, task_id))


#: What the tool server a CLI or kiro-cli starts gets of the harness's environment (its ids, its session, its fence).
TOOL_ENV: Final = ('VOC_RUN_ID', 'VOC_AGENT_ID', 'VOC_TASK_ID', 'VOC_ROLE', 'VOC_WORKSPACE_BUCKET', 'VOC_COMMIT',
                   'VOC_ATTEMPT', 'VOC_BOARD_URL', 'VOC_BROKER_URL', 'VOC_MODEL', GATE_TREE_ENV, FENCE_ENV,
                   'VOC_GATES_DIR', 'AWS_REGION', 'AWS_CONFIG_FILE', 'HOME')
#: Beside them, for kiro-cli's tool server: the agent's proxy (its boto3 reaches S3, the board and the broker through
#: it, as the harness's own does).
KIRO_TOOL_ENV: Final = ('HTTPS_PROXY', 'https_proxy', 'NO_PROXY', 'no_proxy', 'AWS_SDK_LOAD_CONFIG')


def adapter_for(args: argparse.Namespace, env: Mapping[str, str], bedrock: Callable[[], Any]) -> Adapter:
    if args.adapter == 'converse':
        return ConverseAdapter(bedrock(), args.model)
    if args.adapter == 'kiro':
        return KiroAcp(binary=args.kiro_binary, version=args.kiro_version, agent_home=env['HOME'], environment=env,
                       tool_env={name: env[name] for name in (*TOOL_ENV, *KIRO_TOOL_ENV) if name in env},
                       key=ssm_key(args.kiro_key_parameter, env['AWS_REGION']))
    choose_cli(args.cli)
    tool_env = {name: env[name] for name in TOOL_ENV if name in env}
    return ClaudeCli(binary=args.cli_binary, version=args.cli_version, model_id=args.model,
                     home_root=os.path.join(env['HOME'], '.voc', 'cli'), region=env['AWS_REGION'],
                     aws_config=env['AWS_CONFIG_FILE'], tool_env=tool_env)


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog='harness')
    commands = parser.add_subparsers(dest='command', required=True)
    run = commands.add_parser('run')
    run.add_argument('--adapter', choices=('converse', 'cli', 'kiro'), required=True)
    run.add_argument('--model', required=True)
    run.add_argument('--cli', default=CLAUDE)
    run.add_argument('--cli-binary', default='/usr/local/bin/claude')
    run.add_argument('--cli-version', default='')
    run.add_argument('--kiro-binary', default=KIRO_BINARY)
    run.add_argument('--kiro-version', default='')
    run.add_argument('--kiro-key-parameter', default='')
    commands.add_parser('tool-server')
    return parser


def main(argv: Sequence[str], env: Mapping[str, str] | None = None, *, s3: Any = None, ports: Ports | None = None,
         bedrock: Callable[[], Any] | None = None, runner: Runs | None = None) -> int:
    args = _parser().parse_args(list(argv))
    env = dict(os.environ) if env is None else env
    if args.command == 'run':
        # The model the session runs on, as its argv names it (a final go's record names it; the CLI's tool server
        # reads it from its environment).
        env = {**env, 'VOC_MODEL': args.model}
    ports = ports or default_ports(env)
    if s3 is None:
        import boto3
        s3 = boto3.client('s3', region_name=env.get('AWS_REGION'))
    if args.command == 'tool-server':
        # (kiro-cli's key is its own: its config blanks it for this server, and nothing here would hold it anyway)
        os.environ.pop(KEY_ENV, None)
        env = {name: value for name, value in env.items() if name != KEY_ENV}
        session = build_session(env, s3=s3, ports=ports, runner=runner or RunnerClient(), restore=False)
        files = SessionFiles(env['VOC_SESSION_FILES'])
        # (its wait takes what the harness, the inbox's one reader here, leaves for it: never the inbox itself)
        session.context.waiter = waiter(files)
        serve(session.tools, files, sys.stdin, sys.stdout)
        return DONE_EXIT_CODE

    def _bedrock() -> Any:
        import boto3
        from botocore.config import Config
        # Throttling and transient errors are retried by botocore itself, backing off.
        return boto3.client('bedrock-runtime', region_name=env.get('AWS_REGION'),
                            config=Config(retries={'mode': 'adaptive', 'max_attempts': 8}, read_timeout=300))

    # A session restored from a checkpoint renews its lease first (the supervisor refreshed it when the harness
    # started), then every minute through the restore (a working tree to put back may take minutes) and the session.
    # A fresh start claims first (its task is not claimed yet), and renews after; so does a continuation of a crash
    # in the moment before the fresh start's first checkpoint, whose claim the board answers for its live holder.
    if env.get('VOC_RESTORE_KEY'):
        _renew(ports.board, env)
    stop = threading.Event()
    threading.Thread(target=_heartbeat, args=(ports.board, env, stop), daemon=True).start()
    session: AgentSession | None = None
    ending: str = 'crashed'
    try:
        session = build_session(env, s3=s3, ports=ports, runner=runner or RunnerClient())
        _start_flusher(session, stop)
        _started(session, args)
        _begun(session)
        # The tool server's tree is the one this harness hashed, never one the session's start named.
        tool_env = {name: value for name, value in env.items() if name not in (GATE_TREE_ENV, FENCE_ENV)}
        if session.context.gate_tree:
            tool_env[GATE_TREE_ENV] = session.context.gate_tree
        tool_env[FENCE_ENV] = session.context.fence
        ending = adapter_for(args, tool_env, bedrock or _bedrock).run(session)
        if ending == 'done':
            _finished(session)
    except BaseException as error:
        if session is not None and session.context.transcript is not None:
            session.context.transcript.record('crash', error=f'{type(error).__name__}: {error}'[:500])
        raise
    finally:
        stop.set()
        if session is not None:
            _ended(session, ending)
    return DONE_EXIT_CODE if ending == 'done' else PAUSED_EXIT_CODE


def _started(session: AgentSession, args: argparse.Namespace) -> None:
    """The transcript's first event: who runs what, on which model and harness."""
    context = session.context
    if context.transcript is not None:
        context.transcript.record('session', run=context.run_id, agent=context.agent_id, role=context.role,
                                  task=context.task_id, attempt=context.attempt, commit=context.commit,
                                  model=args.model, adapter=args.adapter, skill=context.skill_label,
                                  continuation=session.restored is not None,
                                  tools=[spec.name for spec in session.tools.specs])


def _begun(session: AgentSession) -> None:
    """A fresh start's first checkpoint, right after its claim (one write: its checkout is fresh, nothing to
    snapshot): its brief, so a continuation reads it there and never claims the task it already holds. A
    coordinator's continuation (7.54.00) first closes a wait its last session left open (``wait_for_agents``, paused
    without news): it reads its inbox and the board itself now, and the supervisor's clocks apply again."""
    if session.restored is None:
        session.checkpoint(turn=0, clean=True)
    elif session.context.role == COORDINATOR_ROLE:
        session.context.progress(CONTINUING, waiting=False)


def _ended(session: AgentSession, ending: str) -> None:
    """The transcript's last event (how the session ended, its tokens per model), then its last chunk; never
    raising: the session's outcome is what the supervisor reads."""
    transcript = session.context.transcript
    if transcript is None:
        return
    transcript.record('end', ending=ending, tokens=dict(session.context.status.tokens),
                      results=list(session.context.result_keys))
    transcript.flush_quietly()


def _finished(session: AgentSession) -> None:
    """A session that ended without its ``finish`` (two answers without a tool; a CLI ending cleanly) never leaves
    its task in progress, nor calls it done: the task goes to a person (``needs_human``), since an agent that stops
    without saying it is done may have given up. The CLI's ``finish`` runs in its tool server: its ``finished``
    file says it ran, so its task is done already. Its last progress report says why first, so the person sees it
    on the task. Any refusal (the lease not this agent's, run out, the task unable to move) is raised: a crash,
    which the supervisor continues or ends.

    The run coordinator is the exception: its task is the run's plan, and a coordinate task sent to a person would
    leave the run active with nobody planning it. It stops as a crash (``CoordinatorStopped``), so the supervisor
    continues it from its checkpoint, and after the crashes it allows sends the run to a person, whose Resume
    replaces it (the task still held, so it can be re-posted)."""
    context = session.context
    if context.finished or session.finished_elsewhere:
        return
    if context.role == COORDINATOR_ROLE:
        context.board.progress(context.run_id, context.task_id, context.agent_id, COORDINATOR_STOPPED)
        raise CoordinatorStopped('the run coordinator stopped without finishing the run')
    context.board.progress(context.run_id, context.task_id, context.agent_id, STOPPED_UNFINISHED)
    context.board.move(context.run_id, context.task_id, to_state='needs_human')


class CoordinatorStopped(RuntimeError):
    """The run coordinator ended its session without ``finish``: a crash, never its task sent to a person."""


def entry() -> None:  # pragma: no cover - the image's entry script
    """Run the harness; anything raised ends it with Python's exit code 1 (a crash) and its traceback on stderr,
    whose tail the runner scrubs before anyone sees it."""
    sys.exit(main(sys.argv[1:]))
