"""The harness's entry point in the image: ``/usr/bin/python3 -I /opt/voc/harness.py <command> ...``.

- ``run --adapter converse|cli --model <model id> [--cli claude --cli-binary <path> --cli-version <v>]``: run the
  agent's session (its skill picks the adapter and model; the launch request carries this argv) and exit
  with the runtime's code: 0 done, 75 paused after its checkpoint, 1 (Python's, on anything raised) a crash.
- ``tool-server``: the platform's tools for a CLI (``tool_server``), started by that CLI.

Everything else comes from the agent's own environment (``unit_runner.AGENT_ENV``: its ids, its region, the
bucket its session was handed with) and its role session (``AWS_CONFIG_FILE``). Until the board, the inbox
and the broker land, their ports refuse (``ports.PendingHarnessPorts``), so a session as deployed today stops
at its first call to them rather than guess.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import threading
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from typing import Any, Final

from engineering.runtime.checkout import repo_git, share_working_tree
from engineering.runtime.checkpoints import MAX_CHECKPOINT_BYTES, agent_prefix, checkpoint_prefix, is_valid
from engineering.runtime.harness.cli import CLAUDE, ClaudeCli, choose_cli
from engineering.runtime.harness.converse_loop import ConverseAdapter
from engineering.runtime.harness.interface import DONE_EXIT_CODE, PAUSED_EXIT_CODE, Adapter, AgentSession
from engineering.runtime.harness.ports import Board, Broker, Inbox, PendingHarnessPorts
from engineering.runtime.harness.runner_client import RunnerClient
from engineering.runtime.harness.status import StatusReport
from engineering.runtime.harness.tool_server import SessionFiles, serve
from engineering.runtime.harness.tools import MAX_PATCH_BYTES, AgentContext, Runs, ToolBox
from engineering.runtime.harness.workspace import Workspace
from engineering.runtime.interface import check_id

CHECKOUT_ROOT: Final = '/work/repo'
HEARTBEAT_SECONDS: Final = 60.0


class S3Store:
    """Puts under the agent's own keys only (its role allows nothing else; this refuses before trying)."""

    def __init__(self, s3: Any, bucket: str, own_prefix: str) -> None:
        self._s3 = s3
        self._bucket = bucket
        self._own = own_prefix

    def put(self, key: str, body: bytes) -> None:
        if not key.startswith(self._own) or '..' in key.split('/'):
            raise ValueError(f'{key} is not under the agent\'s own keys')
        self._s3.put_object(Bucket=self._bucket, Key=key, Body=body)

    def get(self, key: str, limit: int) -> bytes:
        return bytes(self._s3.get_object(Bucket=self._bucket, Key=key)['Body'].read(limit + 1))


@dataclass(frozen=True)
class Ports:
    board: Board
    inbox: Inbox
    broker: Broker


def build_session(env: Mapping[str, str], *, s3: Any, ports: Ports, runner: Runs,
                  checkout: str = CHECKOUT_ROOT, restore: bool = True) -> AgentSession:
    """The agent's session from its environment: its ids, its brief, its tools and (``restore``: the harness
    itself, never its tool server) its restored checkpoint, working tree included."""
    run_id, agent_id, task_id = env['VOC_RUN_ID'], env['VOC_AGENT_ID'], env['VOC_TASK_ID']
    prefix = agent_prefix(run_id, agent_id)
    store = S3Store(s3, env['VOC_BUCKET'], prefix)
    home = env['HOME']
    context = AgentContext(
        run_id=run_id, agent_id=agent_id, task_id=check_id('task_id', task_id), role=env['VOC_ROLE'],
        brief=ports.board.brief(run_id=run_id, task_id=task_id), workspace=Workspace(checkout), runner=runner,
        board=ports.board, broker=ports.broker, store=store, status=StatusReport(home),
        patch_dir=os.path.join(home, '.voc', 'patches'), own_prefix=prefix)
    session = AgentSession(context=context, tools=ToolBox(context), inbox=ports.inbox, store=store)
    key = env.get('VOC_RESTORE_KEY')
    if restore and key:
        _restore(session, store, key)
    return session


def _restore(session: AgentSession, store: S3Store, key: str) -> None:
    """Restore from ``key`` when it is one of the agent's own valid checkpoints (else start afresh), and put its
    working tree back on the fresh checkout; a working tree that does not apply is a crash, never a silent loss."""
    context = session.context
    checkpoints = checkpoint_prefix(context.run_id, context.agent_id)
    name = key.removeprefix(checkpoints)
    if not key.startswith(checkpoints) or '/' in name:
        return
    body = store.get(key, MAX_CHECKPOINT_BYTES)
    if not is_valid(body):
        return
    state = json.loads(body)
    session.restored = state
    session.restored_seq = int(name.split('-', 1)[0]) if name.split('-', 1)[0].isdigit() else 0
    session.remember(state)
    position = state.get('position')
    refused = position.get('patch_refused') if isinstance(position, dict) else None
    session.patch_refused = str(refused) if refused else None
    tree = state.get('patch')
    if isinstance(tree, str) and tree.startswith(f'{context.own_prefix}patches/') and context.runs_code:
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


def adapter_for(args: argparse.Namespace, env: Mapping[str, str], bedrock: Callable[[], Any]) -> Adapter:
    if args.adapter == 'converse':
        return ConverseAdapter(bedrock(), args.model)
    choose_cli(args.cli)
    tool_env = {name: env[name] for name in ('VOC_RUN_ID', 'VOC_AGENT_ID', 'VOC_TASK_ID', 'VOC_ROLE', 'VOC_BUCKET',
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
    pending = PendingHarnessPorts()
    ports = ports or Ports(board=pending, inbox=pending, broker=pending)
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

    # The lease is renewed first (the boot took minutes), then every minute through the brief, the restore (a
    # working tree to put back may take minutes) and the session.
    _renew(ports.board, env)
    stop = threading.Event()
    threading.Thread(target=_heartbeat, args=(ports.board, env, stop), daemon=True).start()
    try:
        session = build_session(env, s3=s3, ports=ports, runner=runner or RunnerClient())
        ending = adapter_for(args, env, bedrock or _bedrock).run(session)
    finally:
        stop.set()
    return DONE_EXIT_CODE if ending == 'done' else PAUSED_EXIT_CODE


def entry() -> None:  # pragma: no cover - the image's entry script
    """Run the harness; anything raised ends it with Python's exit code 1 (a crash) and its traceback on stderr,
    whose tail the runner scrubs before anyone sees it."""
    sys.exit(main(sys.argv[1:]))
