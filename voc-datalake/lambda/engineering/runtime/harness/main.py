"""The harness's entry point in the image: ``/usr/bin/python3 -I /opt/voc/harness.py <command> ...``.

- ``run --adapter converse|cli --model <model id> [--cli claude --cli-binary <path> --cli-version <v>]``: run the
  agent's session (its skill picks the adapter and model; the launch request carries this argv) and exit
  with the runtime's code: 0 done, 75 paused after its checkpoint, 1 (Python's, on anything raised) a crash.
- ``tool-server``: the platform's tools for a CLI (``tool_server``), started by that CLI.

Everything else comes from the agent's own environment (``unit_runner.AGENT_ENV``: its ids, its region, the
bucket its session was handed with, the board's function URL) and its role session (``AWS_CONFIG_FILE``). The
board, the inbox, the run coordinator's planner and the knowledge reader are reached through the board API, signed
with that session (``board_client.py``); the broker still refuses (``ports.PendingHarnessPorts``), so a session
stops at its first call to it rather than guess.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import threading
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any, Final

from engineering.runtime.checkout import repo_git, share_working_tree
from engineering.runtime.checkpoints import MAX_CHECKPOINT_BYTES, agent_prefix, artifact_prefix, is_valid
from engineering.runtime.harness.board_client import (
    BoardHttp,
    BoardKnowledge,
    BoardPlanner,
    InboxHttp,
    SignedTransport,
    board_url,
)
from engineering.runtime.harness.cli import CLAUDE, ClaudeCli, choose_cli
from engineering.runtime.harness.converse_loop import ConverseAdapter
from engineering.runtime.harness.interface import DONE_EXIT_CODE, PAUSED_EXIT_CODE, Adapter, AgentSession
from engineering.runtime.harness.ports import (
    Board,
    Broker,
    Inbox,
    KnowledgeReader,
    PendingHarnessPorts,
    Planner,
    TaskBrief,
)
from engineering.runtime.harness.runner_client import RunnerClient
from engineering.runtime.harness.status import StatusReport
from engineering.runtime.harness.tool_server import SessionFiles, serve
from engineering.runtime.harness.tools import MAX_PATCH_BYTES, AgentContext, Runs, ToolBox
from engineering.runtime.harness.workspace import Workspace
from engineering.runtime.interface import check_id

CHECKOUT_ROOT: Final = '/work/repo'
HEARTBEAT_SECONDS: Final = 60.0


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
        planner=ports.planner, knowledge=ports.knowledge)
    session = AgentSession(context=context, tools=ToolBox(context), inbox=ports.inbox, store=store)
    if restored is not None:
        _restore(session, store, *restored)
    return session


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
    return TaskBrief(task_id=task_id, title=brief['title'], instructions=brief['instructions'])


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


def default_ports(env: Mapping[str, str], credentials: Any = None) -> Ports:
    """The board, the inbox, the planner and the knowledge reader on the board's function URL (``VOC_BOARD_URL``,
    signed with the agent's own session; the board refuses the planner's ops to anyone but the run's coordinator);
    the broker still refuses (``PendingHarnessPorts``)."""
    pending = PendingHarnessPorts()
    url = env.get('VOC_BOARD_URL')
    if not url:
        return Ports(board=pending, inbox=pending, broker=pending)
    if credentials is None:
        import boto3
        credentials = boto3.Session(region_name=env['AWS_REGION']).get_credentials()
    transport = SignedTransport(board_url(url), env['AWS_REGION'], credentials)
    # The lease's epoch is the task's attempt (the board's claim sets it so): the harness, a continuation and the CLI's
    # tool server renew, report and move on it without claiming.
    run_id = env['VOC_RUN_ID']
    return Ports(board=BoardHttp(transport, run_id, env['VOC_TASK_ID'], epoch=int(env.get('VOC_ATTEMPT', '1'))),
                 inbox=InboxHttp(transport, run_id, env['VOC_AGENT_ID']), broker=pending,
                 planner=BoardPlanner(transport, run_id), knowledge=BoardKnowledge(transport, run_id))


def adapter_for(args: argparse.Namespace, env: Mapping[str, str], bedrock: Callable[[], Any]) -> Adapter:
    if args.adapter == 'converse':
        return ConverseAdapter(bedrock(), args.model)
    choose_cli(args.cli)
    tool_env = {name: env[name] for name in ('VOC_RUN_ID', 'VOC_AGENT_ID', 'VOC_TASK_ID', 'VOC_ROLE',
                                              'VOC_WORKSPACE_BUCKET', 'VOC_COMMIT', 'VOC_ATTEMPT', 'VOC_BOARD_URL',
                                              'AWS_REGION', 'AWS_CONFIG_FILE', 'HOME') if name in env}
    return ClaudeCli(binary=args.cli_binary, version=args.cli_version, model_id=args.model,
                     home_root=os.path.join(env['HOME'], '.voc', 'cli'), region=env['AWS_REGION'],
                     aws_config=env['AWS_CONFIG_FILE'], tool_env=tool_env)


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog='harness')
    commands = parser.add_subparsers(dest='command', required=True)
    run = commands.add_parser('run')
    run.add_argument('--adapter', choices=('converse', 'cli'), required=True)
    run.add_argument('--model', required=True)
    run.add_argument('--cli', default=CLAUDE)
    run.add_argument('--cli-binary', default='/usr/local/bin/claude')
    run.add_argument('--cli-version', default='')
    commands.add_parser('tool-server')
    return parser


def main(argv: Sequence[str], env: Mapping[str, str] | None = None, *, s3: Any = None, ports: Ports | None = None,
         bedrock: Callable[[], Any] | None = None, runner: Runs | None = None) -> int:
    args = _parser().parse_args(list(argv))
    env = dict(os.environ) if env is None else env
    ports = ports or default_ports(env)
    if s3 is None:
        import boto3
        s3 = boto3.client('s3', region_name=env.get('AWS_REGION'))
    if args.command == 'tool-server':
        session = build_session(env, s3=s3, ports=ports, runner=runner or RunnerClient(), restore=False)
        serve(session.tools, SessionFiles(env['VOC_SESSION_FILES']), sys.stdin, sys.stdout)
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
    try:
        session = build_session(env, s3=s3, ports=ports, runner=runner or RunnerClient())
        if session.restored is None:
            # A fresh start's first checkpoint, right after its claim (one write: its checkout is fresh, nothing to
            # snapshot): its brief, so a continuation reads it there and never claims the task it already holds.
            session.checkpoint(turn=0, clean=True)
        ending = adapter_for(args, env, bedrock or _bedrock).run(session)
        if ending == 'done':
            _finished(session)
    finally:
        stop.set()
    return DONE_EXIT_CODE if ending == 'done' else PAUSED_EXIT_CODE


def _finished(session: AgentSession) -> None:
    """A session that ended without its ``finish`` (two answers without a tool; a CLI ending cleanly) never leaves
    its task in progress, nor calls it done: the task goes to a person (``needs_human``), since an agent that stops
    without saying it is done may have given up. The CLI's ``finish`` runs in its tool server: its ``finished``
    file says it ran, so its task is done already. Any refusal (the lease not this agent's, run out, the task
    unable to move) is raised: a crash, which the supervisor continues or ends."""
    context = session.context
    if not (context.finished or session.finished_elsewhere):
        context.board.move(context.run_id, context.task_id, to_state='needs_human')


def entry() -> None:  # pragma: no cover - the image's entry script
    """Run the harness; anything raised ends it with Python's exit code 1 (a crash) and its traceback on stderr,
    whose tail the runner scrubs before anyone sees it."""
    sys.exit(main(sys.argv[1:]))
