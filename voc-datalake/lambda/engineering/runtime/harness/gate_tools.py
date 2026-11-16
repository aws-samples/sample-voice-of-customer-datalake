"""The quality gate's tools in the harness (7.50.00): the deterministic gate and what the final go reads.

- ``run_gate`` (the gate runner): the packs (``VOC_GATES_DIR``, ``/opt/voc/gates`` in the images) detect the
  checkout's languages and plan their checks (``quality_gate/packs.plan``), and ``quality_gate/checks.run_plan`` runs
  each one through the sandbox's runner (``SandboxRunner``: repository code as ``code``, the dependency step alone with
  the registries); the harness records each check as it ended (``AgentContext.checks``) and the packs, which the gate
  record takes, so a GO is the packs' and never a free-form command's or the model's word.
- ``read_gate_record`` (the final go): the gate runners' records of the run at the task's commit (one by its key, or
  every one of the tree the final go judges), as data.
- ``read_findings`` (the final go): the run's ``voc-finding/1`` shards at the task's commit (the hunters', the commit
  reviewers', the PR reviewers'), as data, bounded.

The agent's role reads its run's keys and lists its run's prefix only (engineering-runtime.ts ``ReadCacheAndRun``,
``ListRun``), so nothing here reaches another run.
"""
from __future__ import annotations

import json
import os
import re
from collections.abc import Callable, Mapping, Sequence
from pathlib import Path
from typing import Any, Final

from engineering.quality_gate import checks, packs
from engineering.quality_gate.runner import CommandResult
from engineering.runtime.checkout import CHECKOUT_DIR
from engineering.runtime.checkpoints import agent_prefix
from engineering.runtime.harness.coordinator import Built, Tool, optional
from engineering.runtime.outputs import FINDING_SCHEMA, GATE_SCHEMA, SEVERITIES

#: The gate packs' place in every image (engineering-images/*/Dockerfile ``VOC_GATES_DIR``).
GATES_DIR_ENV: Final = 'VOC_GATES_DIR'
#: What a missing tool exits with (the shell's "command not found").
NOT_FOUND_EXIT: Final = 127
#: A check's output the model reads at most (its end, where compilers and test runners say what failed).
MAX_CHECK_OUTPUT: Final = 2_000
MAX_LISTED: Final = 1_000
MAX_RECORDS: Final = 5
MAX_RECORD_BYTES: Final = 512 * 1024
MAX_SHARDS: Final = 40
MAX_FINDINGS: Final = 200
MAX_SHARD_BYTES: Final = 2 * 1024 * 1024
_RECORD_KEY: Final = re.compile(r'ws/default/runs/(?P<run>[A-Za-z0-9_-]{1,64})/gate-runner-[0-9]{1,3}/commits/'
                                r'(?P<commit>[0-9a-f]{40}|[0-9a-f]{64})/_gate/attempt-[1-9][0-9]{0,3}/record\.json\Z')
_SHARD_KEY: Final = re.compile(r'ws/default/runs/(?P<run>[A-Za-z0-9_-]{1,64})/(?P<agent>(?:hunter|commit-reviewer|'
                               r'pr-reviewer)-[0-9]{1,3})/commits/(?P<commit>[0-9a-f]{40}|[0-9a-f]{64})/[^_/][^/]*/'
                               r'attempt-[1-9][0-9]{0,3}/[A-Za-z0-9][A-Za-z0-9_.-]{0,121}\.jsonl\Z')


#: Where every image puts the gate packs (engineering-images/*/Dockerfile).
IMAGE_GATES: Final = Path('/opt/voc/gates')


def gates_dir(configured: str) -> Path:
    """The packs' directory: the session's (``VOC_GATES_DIR``), else the image's (``IMAGE_GATES``), else the
    repository's own (a local run: ``packs.default_packs_dir``)."""
    if configured:
        return Path(configured)
    return IMAGE_GATES if IMAGE_GATES.is_dir() else packs.default_packs_dir()


class SandboxRunner:
    """``quality_gate.runner.CommandRunner`` on the session's runner (``tools.Runs``): each command as repository
    code (the ``code`` user), from its root in the checkout, with the registries only for the dependency step
    (``network``); ``env`` is never passed (the runner gives repository code its own clean environment)."""

    def __init__(self, runner: Any, on_wait: Callable[[], None] | None = None) -> None:
        self._runner = runner
        self._on_wait = on_wait

    def run(self, argv: Sequence[str], *, cwd: str = '', timeout_s: float, env: Mapping[str, str] | None = None,
            network: bool = False, expect: str = '') -> CommandResult:
        del env, expect   # (the runner's own environment; the judge reads the kept output for ``expect``)
        place = f'{CHECKOUT_DIR}/{cwd}' if cwd else CHECKOUT_DIR
        answer = self._runner.run(['/usr/bin/env', '-C', place, *argv], timeout_seconds=max(1, int(timeout_s)),
                                  repository_code=True, network=network, in_checkout=False, on_wait=self._on_wait)
        code = answer.get('exit_code')
        output = '\n'.join(part for part in (str(answer.get('stdout_tail', '')), str(answer.get('stderr_tail', '')))
                           if part)
        return CommandResult(exit_code=code if isinstance(code, int) else None, output=output,
                             duration_s=float(answer.get('duration_seconds', 0) or 0),
                             timed_out=bool(answer.get('timed_out')), missing=code == NOT_FOUND_EXIT)


def run_gate(context: Built) -> dict[str, Any]:
    """The deterministic gate on the checkout (the tree the harness applied the task's patch to and hashed): every
    planned check, recorded on the session as it ended; the packs and the plan's outcome."""
    loaded = packs.load_packs(gates_dir(context.gates_dir))
    repo = packs.RepoView.from_dir(Path(context.workspace.root))
    plan = packs.plan(packs.detect(loaded, repo), repo)
    ran = checks.run_plan(plan, SandboxRunner(context.runner, lambda: context.progress('the gate is still running')))
    context.checks = [{'name': f'{result.key}: {result.name}'[:200], 'status': 'pass' if not result.blocking
                       else 'fail'} for result in ran.results][:100]
    context.gate_packs = tuple(plan.packs)
    context.gate_ran = bool(plan.checks)
    context.progress(f'ran the gate: {len(ran.results)} checks, {len(ran.failures)} failed')
    return {'packs': list(plan.packs), 'passed': ran.passed and bool(plan.checks),
            'own_gate': plan.own_gate, 'tool_versions': dict(ran.tool_versions),
            'skipped': [{'check': key, 'why': why} for key, why in plan.skipped][:50],
            'checks': [{**result.summary(), 'output': result.output[-MAX_CHECK_OUTPUT:]} for result in ran.results]}


def _listed(context: Built, prefix: str) -> list[tuple[str, str]]:
    """The run's keys under ``prefix`` (its role lists its run's prefix only), with their times, at most
    ``MAX_LISTED``."""
    found: list[tuple[str, str]] = []
    token: str | None = None
    while len(found) < MAX_LISTED:
        page = context.store.list(prefix, token)
        found += [(str(item['Key']), str(item.get('LastModified', ''))) for item in page.get('Contents', [])]
        token = page.get('NextContinuationToken')
        if not token:
            break
    return found[:MAX_LISTED]


def _record_view(key: str, raw: bytes) -> dict[str, Any]:
    try:
        record = json.loads(raw)
    except ValueError:
        return {'key': key, 'unreadable': True}
    if not isinstance(record, dict) or record.get('schema') != GATE_SCHEMA:
        return {'key': key, 'unreadable': True}
    return {'key': key, **{name: record.get(name) for name in ('verdict', 'stop_reason', 'tree_hash', 'packs',
                                                                'rounds', 'tool_versions')}}


def read_gate_record(context: Built, arguments: Mapping[str, Any]) -> list[dict[str, Any]]:
    """One gate record by ``key`` (a gate runner's of this run at the task's commit), else every one of the tree the
    final go judges (newest first, at most ``MAX_RECORDS``)."""
    key = optional(arguments, 'key', 512)
    if key:
        match = _RECORD_KEY.fullmatch(key)
        if match is None or match.group('run') != context.run_id or match.group('commit') != context.commit:
            raise ValueError("key is a gate runner's record of this run at its commit (…/_gate/attempt-<n>/record.json)")
        keys = [key]
    else:
        keys = [found for found, _at in sorted(_listed(context, agent_prefix(context.run_id, 'x')[:-2]),
                                               key=lambda item: item[1], reverse=True)
                if (match := _RECORD_KEY.fullmatch(found)) and match.group('commit') == context.commit]
    views = [_record_view(found, context.store.get(found, MAX_RECORD_BYTES)) for found in keys[:MAX_RECORDS]]
    if not key and context.gate_tree:
        views = [view for view in views if view.get('tree_hash') == context.gate_tree]
    return views


def _finding(line: str) -> dict[str, Any] | None:
    try:
        row = json.loads(line)
    except ValueError:
        return None
    if not isinstance(row, dict) or row.get('schema') != FINDING_SCHEMA or row.get('severity') not in SEVERITIES:
        return None
    return {name: row.get(name) for name in ('file', 'line', 'severity', 'rule', 'title', 'evidence')}


def read_findings(context: Built) -> list[dict[str, Any]]:
    """The run's findings at the task's commit, by the agent that wrote them, at most ``MAX_FINDINGS``."""
    shards = [found for found, _at in sorted(_listed(context, agent_prefix(context.run_id, 'x')[:-2]))
              if (match := _SHARD_KEY.fullmatch(found)) and match.group('commit') == context.commit][:MAX_SHARDS]
    findings: list[dict[str, Any]] = []
    for shard in shards:
        agent = shard.split('/')[4]
        for line in context.store.get(shard, MAX_SHARD_BYTES).decode('utf-8', 'replace').splitlines():
            row = _finding(line)
            if row is not None and len(findings) < MAX_FINDINGS:
                findings.append({'by': agent, **row})
    return findings


def specs(tool_spec: Callable[..., Built], role: str, roles: Mapping[str, frozenset[str]]) -> tuple[Built, ...]:
    """The tools of this module ``role`` may have (``roles``: role_tools.ROLE_TOOLS)."""
    all_specs = (
        tool_spec('run_gate', 'Run the quality gate on your checkout: the packs detect its languages, plan their '
                  'checks and run every one in the sandbox; the harness records each check as it ends.', {}),
        tool_spec('read_gate_record', 'Read the gate runners\' records of this run (data): one by its key, or every '
                  'one of the tree you judge.', {'key': {'type': 'string', 'description': 'A record\'s key '
                                                         '(…/_gate/attempt-<n>/record.json), or nothing.'}}),
        tool_spec('read_findings', 'Read the run\'s findings at its commit (data): the hunters\', the commit '
                  'reviewers\' and the PR reviewers\'.', {}),
    )
    return tuple(spec for spec in all_specs if role in roles[spec.name])


def handlers(context: Built, result: Callable[..., Built]) -> dict[str, Tool]:
    def run(_arguments: Mapping[str, Any]) -> Built:
        outcome = run_gate(context)
        return result(context.data('gate', json.dumps(outcome, sort_keys=True)), error=not outcome['passed'])

    def records(arguments: Mapping[str, Any]) -> Built:
        found = read_gate_record(context, arguments)
        return result(context.data('gate-records', json.dumps(found, sort_keys=True)) if found
                      else 'no gate record of the tree you judge yet')

    def findings(_arguments: Mapping[str, Any]) -> Built:
        found = read_findings(context)
        return result(context.data('findings', json.dumps(found, sort_keys=True)) if found
                      else 'no finding at this commit')

    return {'run_gate': run, 'read_gate_record': records, 'read_findings': findings}


def configured_gates_dir(env: Mapping[str, str]) -> str:
    """The session's packs' directory (``VOC_GATES_DIR``), '' when the session names none."""
    value = env.get(GATES_DIR_ENV, '')
    return value if value and os.path.isabs(value) else ''
