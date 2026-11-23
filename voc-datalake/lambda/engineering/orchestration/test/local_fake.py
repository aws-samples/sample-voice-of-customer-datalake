"""The local fake runtime of ``npm run orchestration:run -- --models fake``: the Bug hunt test's, driven by a template.

A run of the compiled Bug hunt and fix flow on one eval case's fixture, end to end, in process: moto for the tables
and buckets, voc-engineering-runtime's own handler on the local fake agent runtime, the board's API, the broker's own
handler behind the SigV4-checking function URL and a git host on the fixture (``runtime/test/
test_engineering_bug_hunt_flow.py``'s, reused as they are). Each agent runs the harness's own entry on a real git
checkout of the fixture, on a scripted Converse model that acts out the case's known fix (``known-fix.diff``) on
the skill its launch resolved (its role's bundled template, as the runtime and the board read it): the hunter runs
the case's check and writes what it shows, the fixer writes the fixed files and runs the tests, the gate runner's
``run_gate`` runs the gate plan's checks for real on the judged tree, and the committer and the PR author go through
the broker. Repository commands run for real in the checkout; the dependency step installs nothing (it would need the
registries): the test interpreter, with pytest, is the sandbox's here.

The scripted coordinator waits for its agents as a model must (7.54.00): it posts a step's task, launches its agent and
calls ``wait_for_agents``; the agent's whole session runs while it waits (at the wait's first sleep), and the board's
events go through the inbox router and the delivery function as the bus takes them, so the agent's ``task.done`` lands
in the conductor's inbox and the wait returns with it. Its ``finish`` meets the harness's finish rule: it finishes once
the flow has.

After each step of the flow it evaluates the step's assertions (``params.assert``) on what the step recorded, as the
board will, and prints them. The run is test support (moto, the runtime's test doubles), loaded only by the runner.
"""
from __future__ import annotations

import functools
import itertools
import json
import re
import shutil
import sys
import tempfile
import time
from collections.abc import Callable, Generator, Mapping, Sequence
from contextlib import contextmanager
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Final

import boto3
import pytest
from moto import mock_aws

from engineering.board.api import BoardApi
from engineering.board.inbox import Inbox
from engineering.board.store import BoardStore
from engineering.bus.publish import EventBridgePublisher
from engineering.bus.router import Router
from engineering.bus.schema import Message
from engineering.connectors.broker import Broker
from engineering.connectors.dial import WaysOfWorking
from engineering.connectors.hosts import Connector, PullRequestRef
from engineering.connectors.patches import WorkspacePatches
from engineering.connectors.records import RunRecords, WriteClaims
from engineering.conversation.store import ConversationStore
from engineering.flow.ledger import read_gate_record
from engineering.learning import reactions_broker
from engineering.orchestration import assertions
from engineering.orchestration.assertions import Recorded, Result
from engineering.quality_gate import packs
from engineering.runtime import delivery, handler
from engineering.runtime.harness import gate_tools
from engineering.runtime.harness import main as harness_main
from engineering.runtime.harness.converse_loop import ConverseAdapter
from engineering.runtime.interface import CODE_ROLES
from engineering.runtime.test import conftest as runtime_world
from engineering.runtime.test import test_engineering_bug_hunt_flow as bug_hunt
from engineering.runtime.test.broker_stub import AgentSessions, FunctionUrl
from engineering.runtime.test.harness_fakes import use
from engineering.runtime.test.local_runtime import LocalAgentRuntime
from engineering.runtime.test.test_engineering_board_bus import Events
from engineering.runtime.test.test_engineering_harness_main import _vm_directory, fixture_repository, run_git
from engineering.skills.templates import bundled
from engineering.workspace.store import WorkspaceStore
from shared import aws as shared_aws
from shared.ai_mode import MODE_AI_DRIVEN, ai_mode_key
from shared.workflow_engineering import flow_settings, step_assertions
from shared.workflow_schema import encode_definition

Out = Callable[[str], None]
#: An agent's whole session, run while the coordinator waits: the errors it was handed.
Agent = Callable[[], list[str]]
RUN = bug_hunt.RUN
#: The flow's steps whose work this script plays, in order (the flow's own ids).
STEPS = ('hunt', 'board', 'gate', 'commit', 'pr_author')
INSTALLED_NOTHING = ('(the local run installs nothing: the dependency step needs the registries; the test interpreter '
                     'and its pytest are the sandbox\'s here)')


class FakeRunError(ValueError):
    """A repository the scripted models cannot act on (no eval case with a known fix around it)."""


@dataclass(frozen=True)
class Case:
    """The eval case the repository is the fixture of, and its known fix, as the scripts need it."""

    directory: Path
    record: Mapping[str, Any]
    files: Mapping[str, str]
    fixed: Mapping[str, str]
    source: str
    line: int

    @property
    def check(self) -> list[str]:
        argv = list(self.record['check']['argv'])
        return [sys.executable if argv[0] == 'python3' else argv[0], *argv[1:]]


def _first_removed_line(diff: str, path: str) -> int:
    """The line (in the original file) of the first line ``diff`` removes from ``path``."""
    current, line = '', 0
    for text in diff.splitlines():
        if text.startswith('+++ '):
            current = text[6:] if text.startswith('+++ b/') else text[4:]
        elif text.startswith('@@ ') and current == path:
            line = int(text.split()[1].lstrip('-').split(',')[0])
        elif current == path and line and text.startswith('-'):
            return line
        elif current == path and line and not text.startswith('+'):
            line += 1
    return 1


def load_case(repo: Path) -> Case:
    """The eval case around ``repo`` (``<case>/repo``), its files and the files its known fix leaves."""
    directory = repo.parent
    record_file, diff_file = directory / 'case.json', directory / 'known-fix.diff'
    if repo.name != 'repo' or not record_file.is_file() or not diff_file.is_file():
        raise FakeRunError(f'{repo} is not an eval case\'s fixture with a known fix (<case>/repo, beside case.json and '
                           'known-fix.diff): the scripted models act out that fix')
    files = {path.relative_to(repo).as_posix(): path.read_text(encoding='utf-8')
             for path in sorted(repo.rglob('*')) if path.is_file() and '__pycache__' not in path.parts}
    diff = diff_file.read_text(encoding='utf-8')
    with tempfile.TemporaryDirectory() as scratch:
        shutil.copytree(repo, scratch, dirs_exist_ok=True)
        run_git('-C', scratch, 'apply', str(diff_file))
        changed = assertions.patch_paths(diff)
        fixed = {path: (Path(scratch) / path).read_text(encoding='utf-8') for path in changed}
    source = next((path for path in changed if not assertions.is_test_path(path)), None)
    if source is None:
        raise FakeRunError(f'{diff_file} changes tests only: the scripts need the file the bug is in')
    return Case(directory, json.loads(record_file.read_text(encoding='utf-8')), files, fixed, source,
                _first_removed_line(diff, source))


@dataclass
class Code:
    """A session's runner on its real checkout: the harness's own git and repository commands run for real there; a
    command with network (the dependency step) is answered without running."""

    checkout: Any
    real: bool

    def run(self, argv: Sequence[str], *, timeout_seconds: int, repository_code: bool = True, network: bool = False,
            in_checkout: bool = True, on_wait: Callable[[], None] | None = None) -> dict[str, Any]:
        if repository_code and (network or not self.real):
            return {'exit_code': 0, 'stdout_tail': INSTALLED_NOTHING if network else '', 'stderr_tail': '',
                    'timed_out': False}
        return self.checkout.run(argv, timeout_seconds=timeout_seconds, repository_code=repository_code,
                                 network=network, in_checkout=in_checkout, on_wait=on_wait)


@dataclass
class Host(bug_hunt.GitHost):
    """The test's git host, keeping each pull request's text too (ready for review or a draft, as the broker asks)."""

    pull_requests: list[dict[str, Any]] = field(default_factory=list)

    def head_commit(self, connection_id: str, branch: str) -> str | None:
        """The run's commit is the default branch's head (the run is started on it)."""
        return runtime_world.COMMIT if (connection_id, branch) == ('conn-1', 'main') else None

    def issue_state(self, connection_id: str, number: int) -> str | None:
        return 'open' if connection_id == 'conn-1' and number > 0 else None

    def open_or_update_draft_pr(self, connection_id: str, branch: str, base: str, title: str, body: str,
                                tree_hash: str, *, draft: bool = True) -> PullRequestRef:
        opened = super().open_or_update_draft_pr(connection_id, branch, base, title, body, tree_hash, draft=draft)
        self.pull_requests.append({'branch': branch, 'tree': tree_hash, 'draft': draft, 'title': title, 'body': body})
        return opened


@contextmanager
def _wired(work: Path) -> Generator[pytest.MonkeyPatch]:
    """voc-engineering-runtime's handler on moto and the local fake, wired from its environment."""
    environment = sorted({
        'ENGINEERING_TABLE': runtime_world.TABLE, 'ENGINEERING_SETTINGS_TABLE': runtime_world.TABLE,
        'ENGINEERING_WORKSPACE_BUCKET': runtime_world.WORKSPACE_BUCKET, 'RAW_DATA_BUCKET': runtime_world.BUCKET,
        'ENGINEERING_BOARD_URL': runtime_world.BOARD_URL, 'ENGINEERING_BROKER_URL': runtime_world.BROKER_URL,
        'ENGINEERING_BUS_NAME': runtime_world.BUS, 'SUPERVISOR_RULE_NAME': runtime_world.SCHEDULE,
        'ENGINEERING_AGENT_ROLE_ARNS': json.dumps(runtime_world.ROLE_ARNS),
        'ENGINEERING_AGENT_RUNTIMES': json.dumps(runtime_world.IMAGE_ARNS), 'ENGINEERING_BENCHMARK_CASES': '[]',
        'AWS_REGION': 'us-east-1', 'AWS_DEFAULT_REGION': 'us-east-1', 'HOME': str(work / 'home'),
    }.items())
    with mock_aws(), pytest.MonkeyPatch.context() as patched:
        for name, value in environment:
            patched.setenv(name, value)
        # (the handler's supervisor waits for no boot command within a tick: runtime/test/conftest.py QuickSupervisor)
        for name, value in (('_runtime', LocalAgentRuntime), ('_checkout_cache', runtime_world.ReadyCache),
                            ('_own_credentials', runtime_world.FakeCredentials), ('_supervisor_cache', None),
                            ('_learning_cache', None), ('Supervisor', runtime_world.QuickSupervisor)):
            patched.setattr(handler, name, value)
        patched.setattr(reactions_broker, '_OPENER', runtime_world.NoPullRequest())
        for client in ('_dynamodb_resource', '_dynamodb_client', '_s3_client', '_lambda_client', '_eventbridge_client'):
            patched.setattr(shared_aws, client, None)
        handler._sts_client.cache_clear()
        s3 = boto3.client('s3', region_name='us-east-1')
        for bucket in (runtime_world.BUCKET, runtime_world.WORKSPACE_BUCKET):
            s3.create_bucket(Bucket=bucket)
        dynamodb = boto3.resource('dynamodb', region_name='us-east-1')
        for table in (runtime_world.TABLE, bug_hunt.AGGREGATES):
            dynamodb.create_table(TableName=table, BillingMode='PAY_PER_REQUEST', KeySchema=[
                {'AttributeName': 'pk', 'KeyType': 'HASH'}, {'AttributeName': 'sk', 'KeyType': 'RANGE'}],
                AttributeDefinitions=[{'AttributeName': key, 'AttributeType': 'S'} for key in ('pk', 'sk')])
        events = boto3.client('events', region_name='us-east-1')
        events.put_rule(Name=runtime_world.SCHEDULE, ScheduleExpression='rate(1 minute)', State='DISABLED')
        events.create_event_bus(Name=runtime_world.BUS)
        yield patched


@dataclass
class LocalRun:
    """One run: the Bug hunt test's world on the case's fixture, and what the run printed and evaluated."""

    world: bug_hunt.BugHunt
    host: Host
    case: Case
    flow: Mapping[str, Any]
    patched: pytest.MonkeyPatch
    out: Out
    issue: int | None
    #: The board's events (its publisher's), and the inbox router they go through as the bus takes them.
    events: Events
    router: Router
    results: dict[str, tuple[Result, ...]] = field(default_factory=dict)
    coordinator: Any = None
    #: The board's events routed so far.
    routed: int = 0

    def tasks(self) -> list[Any]:
        return list(self.world.api.store.tasks('default', RUN))

    def objects(self, *roles: str) -> list[tuple[str, str, bytes]]:
        """Each output the tasks of ``roles`` recorded: (role, key, body)."""
        s3 = self.world.s3
        return [(task.role, key, s3.get_object(Bucket=runtime_world.WORKSPACE_BUCKET, Key=key)['Body'].read())
                for task in self.tasks() if task.role in roles for key in task.result_keys]

    def recorded(self) -> Recorded:
        """What the run has recorded so far, as the assertions read it."""
        findings, patches, gates, reviews = [], [], [], []
        for role, key, body in self.objects('hunter', 'commit-reviewer', 'fixer', 'gate-runner', 'final-go'):
            if '/_patches/' in key:
                patches.append(body.decode())
            elif key.endswith('/record.json'):
                gates.append({**json.loads(body), 'by': role})
            elif '/_review/' in key:
                reviews.append({**json.loads(body), 'by': role})
            elif key.endswith('.jsonl'):
                findings += [{**json.loads(line), 'by': role} for line in body.decode().splitlines() if line]
        posted = tuple((task.role, task.posted_by.rsplit('-', 1)[0]) for task in self.tasks() if task.posted_by)
        pushes = tuple({'branch': branch, 'tree': tree} for op, branch, tree in self.host.writes if op == 'push_bundle')
        return Recorded(findings=tuple(findings), posted=posted, patches=tuple(patches), gate_records=tuple(gates),
                        pushes=pushes, pull_requests=tuple(self.host.pull_requests), reviews=tuple(reviews),
                        issue=self.issue, pr_setting=str(flow_settings(self.flow['definition'])['pr']))

    def agent(self, agent_id: str, turns: Sequence[bug_hunt.Turn]) -> list[str]:
        """``agent_id``'s whole session through the harness's entry on its real checkout; the errors it was handed."""
        argv, env = self.world.environment(agent_id)
        role = env['VOC_ROLE']
        # (read before the model takes its turns: it answers them one by one, off the list; a turn that answers from
        # the opening is not known yet)
        summary = next((block['toolUse']['input'].get('summary', '') for turn in turns if not callable(turn)
                        for block in turn if block.get('toolUse', {}).get('name') == 'finish'), '')
        # (the role's bundled template: the skill the runtime's launch resolved and the board's skill op serves)
        template = bundled().skill(role)
        if template is None:
            raise FakeRunError(f'the bundle has no template for {role}')
        model = self.world.models[agent_id] = bug_hunt.ScriptedModel(template.skill, turns)
        vm = self.world.tmp / agent_id / 'vm'
        runner = Code(_vm_directory(vm, self.world.cache, self.world.commit), real=role in CODE_ROLES)
        self.patched.setattr(harness_main, 'build_session',
                             functools.partial(bug_hunt.BUILD_SESSION, checkout=str(vm / 'work' / 'repo')))
        ports = self.world.ports(agent_id, env['VOC_TASK_ID'], int(env['VOC_ATTEMPT']))
        harness_main.main(list(argv[3:]), env, s3=self.world.s3, ports=ports, bedrock=lambda: model, runner=runner)
        self.out(f'  {agent_id} ({role}, {template.label}): {summary}')
        return model.refused()

    def deliver(self) -> None:
        """The board's events since the last call through the inbox router, which hands the delivery function the
        ones for an inbox (a posted task's, and the conductor's notices: a task done, failed or needing a person)."""
        for entry in self.events.entries[self.routed:]:
            self.router.route_event(str(entry['Source']), json.loads(entry['Detail']),
                                    detail_type=str(entry['DetailType']))
        self.routed = len(self.events.entries)

    def coordinate(self, turns: list[list[dict[str, Any]]], agent: tuple[str, Agent] | None = None) -> list[str]:
        """One stretch of the run coordinator's one session (started at its first), on the model of the skill its
        launch resolved, none of its calls refused. ``agent``: the agent (its id and its session) that runs while the
        coordinator waits for it, at the wait's first sleep; what each wait brought is printed. The agent's errors."""
        if self.coordinator is None:
            self.coordinator = self.world.coordinator()
        session, pending, errors, now = self.coordinator, [agent] if agent else [], [], [0.0]

        def sleep(seconds: float) -> None:
            now[0] += seconds
            while pending:
                errors.extend(pending.pop()[1]())
                self.deliver()

        session.context.sleep, session.context.clock = sleep, lambda: now[0]
        skill = session.tools.skill
        model = bug_hunt.ScriptedModel(skill, turns)
        ConverseAdapter(model, skill.model).run(session)
        if model.refused():
            raise FakeRunError(f'the coordinator was refused: {model.refused()}')
        if agent is not None and pending:
            raise FakeRunError(f'the coordinator never waited for {agent[0]}')
        for news in waits(model):
            self.out(f'  coordinator-1 waited for {agent[0] if agent else "its agents"}: {news}')
        return errors

    def step_done(self, step: str) -> None:
        """The step's state as the conductor says, then its assertions on what it recorded."""
        node = next(node for node in self.flow['definition']['nodes'] if node['id'] == step)
        status = bug_hunt.statuses(self.world.plan()).get(step)
        found = self.results[step] = assertions.evaluate_all(step_assertions(node), self.recorded())
        self.out(f'step {step}: {status}')
        for result in found:
            self.out(f'    assert {result.check}: {"pass" if result.passed else "FAIL"} ({result.detail})'
                     + ('' if result.passed or result.on_fail == 'block' else f' [{result.on_fail}]'))


#: A message a wait brought, as its DATA block opens (``tools.as_data``: ``message:<kind>``).
_MESSAGE: Final = re.compile(r'^<<<DATA message:(\S+) ', re.MULTILINE)


def waits(model: bug_hunt.ScriptedModel) -> list[str]:
    """What each ``wait_for_agents`` of the stretch returned: the kinds of the messages it brought, or its first line."""
    messages = model.requests[-1]['messages'] if model.requests else []
    found = []
    for asked, answered in itertools.pairwise(messages):
        if any(block.get('toolUse', {}).get('name') == 'wait_for_agents' for block in asked['content']):
            text = next(block['toolResult']['content'][0]['text'] for block in answered['content']
                        if 'toolResult' in block)
            kinds = _MESSAGE.findall(text)
            found.append(f'news ({", ".join(kinds)})' if kinds else text.splitlines()[0])
    return found


def _post(role: str, step: str, task: str, title: str, **extra: str) -> list[list[dict[str, Any]]]:
    """The coordinator's post of one task for a live step, its launch, and its wait for the agent."""
    return [[use('post_task', role=role, step=step, title=title, instructions=f'{title}: see the board.', **extra)],
            [use('launch_agent', task_id=task, role=role, language='python')], [use('wait_for_agents')]]


def _finish(summary: str) -> list[dict[str, Any]]:
    return [use('finish', summary=summary)]


def _hunt(run: LocalRun) -> None:
    case = run.case
    finding = {'file': case.source, 'line': case.line, 'severity': 'blocking', 'rule': 'wrong-result',
               'title': str(case.record['title'])[:200], 'evidence': f'{" ".join(case.check[:3])} ... exits 1 on the '
               f'fixture: the case\'s check fails at {case.source}:{case.line}'}
    errors = run.coordinate([[use('read_flow')], *_post('hunter', 'hunt', 'task-1', f'Hunt in {case.source}')],
                            ('hunter-2', lambda: run.agent('hunter-2', [
                                [use('list_files', path='')], [use('read_file', path=case.source)],
                                [use('run', argv=case.check)],
                                [use('write_findings', package='.', shard='hunt', findings=[finding])],
                                [use('post_subtask', title='Fix: ' + str(case.record['title'])[:180],
                                     instructions=str(case.record['task']), paths=[case.source], step='board')],
                                _finish('one bug confirmed by the case\'s check, one fix task posted')])))
    run.out(f'    the hunter\'s check of the bug exited non-zero, as it should: {len(errors)} error result(s)')
    run.step_done('hunt')


def _fix(run: LocalRun) -> None:
    case = run.case
    tests = [sys.executable, '-m', 'pytest', '-q', '-p', 'no:cacheprovider']
    errors = run.coordinate(
        [[use('read_board')], [use('launch_agent', task_id='task-2', role='fixer', language='python')],
         [use('wait_for_agents')]],
        ('fixer-3', lambda: run.agent('fixer-3', [
            [use('read_file', path=case.source)],
            *[[use('write_file', path=path, text=text)] for path, text in case.fixed.items()],
            [use('run', argv=case.check)], [use('run', argv=tests)],
            [use('submit_work', summary='the fix and its test')],
            _finish(f'fixed {case.source} with a test; the case\'s check and the tests pass')])))
    if errors:
        raise FakeRunError(f'the fixer was refused: {errors}')


#: The first line of a ``read_patch`` answer (7.54.00): the patch's name and its pages.
_PATCH_READ: Final = re.compile(r'^The submitted patch (\S+): page 1 of (\d+)\.$', re.MULTILINE)


def _said(run: LocalRun, agent_id: str) -> str:
    """Every tool result ``agent_id``'s session handed its model, in turn."""
    messages = run.world.models[agent_id].requests[-1]['messages']
    return '\n'.join(block['toolResult']['content'][0]['text'] for message in messages
                     for block in message['content'] if 'toolResult' in block)


def _board(run: LocalRun) -> None:
    """The fix, then its review (7.54.00): the commit reviewer's task names the fixer's submitted patch, which it
    reads with ``read_patch`` and finds applied to its checkout (``read_file`` answers the fixed file), and its review
    approves it."""
    case = run.case
    _fix(run)
    errors = run.coordinate(_post('commit-reviewer', 'board', 'task-3', 'Review the fix', patch=_patch(run)),
                            ('commit-reviewer-4', lambda: run.agent('commit-reviewer-4', [
                                [use('read_patch', page=1)], [use('read_file', path=case.source)],
                                [use('write_findings', package='.', shard='review', findings=[{
                                    'file': case.source, 'line': case.line, 'severity': 'nit', 'rule': 'scope',
                                    'title': 'The fix is the one line the bug needs',
                                    'evidence': 'only the operator changed'}])],
                                [use('write_review', verdict='approve',
                                     reasons=['the fix is the one line the bug needs, and its test fails without it'])],
                                _finish('approved: no blocking finding')])))
    if errors:
        raise FakeRunError(f'the commit reviewer was refused: {errors}')
    said = _said(run, 'commit-reviewer-4')
    found = _PATCH_READ.search(said)
    fixed = case.fixed[case.source].splitlines()[case.line - 1].strip()
    run.out(f'    the commit reviewer read the submitted patch {found[1] if found else "(none)"} '
            f'({found[2] if found else 0} page(s)); its checkout has the fixed {case.source}: '
            f'{"yes" if fixed and fixed in said else "no"}')
    run.coordinate([[use('complete_step', step='board')]])
    run.step_done('board')


def _unreadable_review(run: LocalRun) -> None:
    """The fix, then a review whose patch cannot be read (7.54.00: its task names a submitted patch's key with no
    object): the reviewer says it could not review, its task goes to a person, the board does not close, and the
    board's ``review.no_blocking`` fails, never passing on zero findings."""
    _fix(run)
    missing = f'{_patch(run).rsplit("/", 1)[0]}/task-9-00000000.diff'
    run.coordinate(_post('commit-reviewer', 'board', 'task-3', 'Review the fix', patch=missing),
                   ('commit-reviewer-4', lambda: run.agent('commit-reviewer-4', [
                       [use('read_patch')],
                       [use('write_review', verdict='could_not_review',
                            reasons=['the submitted patch could not be read'])],
                       _finish('could not review: the patch could not be read')])))
    refused = [line for line in _said(run, 'commit-reviewer-4').splitlines() if line.startswith('read_patch refused')]
    run.out(f'    the commit reviewer\'s read_patch: {refused[0] if refused else "answered"}')
    board = next(step for step in run.world.plan()['steps'] if step['step'] == 'board')
    run.out(f'    the board is {board["status"]}: {board.get("reason", "")}')
    run.step_done('board')


def _patch(run: LocalRun) -> str:
    [patch] = [key for task in run.tasks() if task.role == 'fixer' for key in task.result_keys]
    return patch


def _gate(run: LocalRun) -> str:
    patch = _patch(run)
    # ``run_gate`` plans the packs' checks on the sandbox's interpreter ({python}): for a local run, the test
    # interpreter, which has pytest (the dependency step installs nothing here).
    run.patched.setattr(gate_tools.packs, 'plan', functools.partial(packs.plan, python=sys.executable))
    errors = run.coordinate(
        [[use('read_board')], *_post('gate-runner', 'gate', 'task-4', 'Run the gate packs', patch=patch)],
        ('gate-runner-5', lambda: run.agent('gate-runner-5', [
            [use('run_gate')], [use('write_gate_record', verdict='GO', packs=['python'])],
            _finish('every check passed')])))
    if errors:
        raise FakeRunError(f'the gate runner was refused: {errors}')
    [record] = [json.loads(body) for _, key, body in run.objects('gate-runner') if key.endswith('/record.json')]
    for check in record['rounds'][0]['checks']:
        run.out(f'    gate check {check["name"]}: {check["status"]}')
    run.coordinate(_post('final-go', 'gate', 'task-5', 'The final go', patch=patch), ('final-go-6', lambda: run.agent(
        'final-go-6', [[use('read_file', path=run.case.source)],
                       [use('write_gate_record', verdict='GO', reasons=['every check passed',
                                                                        'no blocking finding is open'])],
                       _finish('GO')])))
    run.step_done('gate')
    return str(record['tree_hash'])


def _deliver(run: LocalRun, tree: str) -> None:
    """The commit and the pull request. The committer and the PR author know their write's patch, tree and branch only
    from their opening (7.71.02: the harness fills them in), and write the message, the title and the body alone."""
    patch, title = _patch(run), str(run.case.record['title'])[:200]
    told: dict[str, str] = {}

    def committing(opening: str) -> list[dict[str, Any]]:
        told.update(bug_hunt.told(opening, patch=bug_hunt.PATCH_NAMED, tree=bug_hunt.TREE_NAMED,
                                  branch=bug_hunt.BRANCH_NAMED))
        return [use('push_commit', message=title)]

    run.coordinate(_post('committer', 'commit', 'task-6', 'Commit the fix', patch=patch), ('committer-7', lambda: run.agent(
        'committer-7', [committing, _finish('pushed')])))
    named = ("the fixer's patch and the gate's tree" if (told.get('patch'), told.get('tree')) == (patch, tree)
             else 'another patch or tree')
    run.out(f'    the committer was told {named}, on the branch {told.get("branch", "(none)")}')
    run.step_done('commit')
    body = f'{run.case.record["task"]}\n\nTested by the new test; the quality gate said GO.'
    if run.issue is not None:
        body += f'\n\nFixes #{run.issue}'

    def authoring(opening: str) -> list[dict[str, Any]]:
        told.update(bug_hunt.told(opening, opens=bug_hunt.OPENS_NAMED))
        return [use('open_draft_pr', title=title, body=body)]

    run.coordinate(_post('pr-author', 'pr_author', 'task-7', 'Open the pull request'), ('pr-author-8', lambda: run.agent(
        'pr-author-8', [authoring, _finish('the pull request is open')])))
    run.out(f'    the PR author was told its pull request opens {told.get("opens", "(unsaid)")}')
    run.step_done('pr_author')


def _start(world_dir: Path, case: Case, flow: Mapping[str, Any], patched: pytest.MonkeyPatch, out: Out,
           issue: int | None) -> LocalRun:
    handler.lambda_handler({'action': 'start_run', 'run_id': RUN, 'max_tasks': 20, 'goal': str(case.record['title']),
                            'connection': 'conn-1', 'repo': bug_hunt.REPOSITORY, 'commit': runtime_world.COMMIT,
                            'language': 'python', 'flow': f'tpl_{flow["template_id"]}'[:64],
                            'flow_definition': encode_definition(flow['definition']), 'flow_revision': 1,
                            'actor': bug_hunt.STARTER,
                            **({'issue': issue, 'host': 'github'} if issue is not None else {})}, None)
    client = boto3.client('dynamodb', region_name='us-east-1')
    workspace = WorkspaceStore(boto3.client('s3', region_name='us-east-1'), runtime_world.WORKSPACE_BUCKET,
                               denied_is_missing=True)
    counter = iter(range(1, 100))
    launcher = bug_hunt.RuntimeLauncher()
    events = Events()
    api = BoardApi(BoardStore(client, runtime_world.TABLE, new_id=lambda: f'task-{next(counter)}'),
                   EventBridgePublisher(events, 'voc-engineering', 'voc.engineering/board'),
                   Inbox(client, runtime_world.TABLE), launcher=launcher,
                   gate_records=lambda key: read_gate_record(workspace, key))
    table = boto3.resource('dynamodb', region_name='us-east-1').Table(runtime_world.TABLE)

    def deliver(message: Message, seq: int) -> None:
        """The delivery function, handed what the router's Lambda invokes it with."""
        delivery.deliver({'message': message.to_dict(), 'seq': seq}, table=table, supervisor=handler._supervisor(),
                         now=int(time.time()))

    # The inbox router on the run's conversation.
    router = Router(ConversationStore(client, runtime_world.TABLE), deliver=deliver)
    cache, commit = fixture_repository(world_dir, dict(case.files))
    boto3.resource('dynamodb', region_name='us-east-1').Table(bug_hunt.AGGREGATES).put_item(
        Item={**ai_mode_key(bug_hunt.STARTER), 'mode': MODE_AI_DRIVEN})
    host = Host(cache, commit, world_dir / 'host')
    records = RunRecords(client, runtime_world.TABLE, workspace)
    people = boto3.resource('dynamodb', region_name='us-east-1').Table(bug_hunt.AGGREGATES)
    broker = Broker(Connector(host=host, bundles=WorkspacePatches(workspace, host.file_at),
                              runs=bug_hunt.Attested(records), ledger=records, dial=WaysOfWorking(people),
                              writes=WriteClaims(client, runtime_world.TABLE)))
    world = bug_hunt.BugHunt(api, launcher, boto3.client('s3', region_name='us-east-1'), world_dir, cache, commit,
                             host, FunctionUrl(runtime_world.BROKER_URL, broker, AgentSessions(RUN)))
    return LocalRun(world, host, case, flow, patched, out, issue, events, router)


def run_flow(flow: Mapping[str, Any], repo: Path, *, out: Out = print, issue: int | None = None,
             unreadable_review: bool = False) -> int:
    """The compiled Bug hunt and fix ``flow`` on ``repo`` (an eval case's fixture), end to end on scripted models:
    0 when it reached its pull request with every blocking assertion passed, 1 otherwise. ``unreadable_review``
    (7.54.00, a test's): the commit reviewer's patch cannot be read, so the run stops at the board, at a person."""
    case = load_case(repo)
    out(f'local run of {flow["template_id"]} v{flow["version"]} on {case.directory.name} (scripted models acting out '
        'its known fix; each agent runs its role\'s bundled template, as the runtime resolves it)')
    with tempfile.TemporaryDirectory() as scratch, _wired(Path(scratch)) as patched:
        (Path(scratch) / 'home').mkdir()
        run = _start(Path(scratch) / 'world', case, flow, patched, out, issue)
        _hunt(run)
        if unreadable_review:
            _unreadable_review(run)
        else:
            _board(run)
            _deliver(run, _gate(run))
        run.coordinate([[use('read_flow')], _finish('the flow stopped at a person' if unreadable_review
                                                    else 'the flow reached its pull request')])
        statuses = bug_hunt.statuses(run.world.plan())
        run.out(f'flow: {", ".join(f"{step} {state}" for step, state in statuses.items())}')
        learn = flow_settings(flow['definition'])['learn']
        out(f'learn: {"on" if learn.get("enabled") else "off"} (the built-in Learn step runs at a run\'s end in the '
            'runtime; the local run does not run it)')
        blocked = [f'{step}: {result.check}' for step, results in run.results.items() for result in results
                   if result.blocks]
        reached = statuses.get('pr') == 'done'
    out(f'result: {"reached its pull request" if reached else "did not reach its pull request"}; '
        + (f'{len(blocked)} blocking assertion(s) failed: {", ".join(blocked)}' if blocked else
           'every blocking assertion passed'))
    return 0 if reached and not blocked else 1
