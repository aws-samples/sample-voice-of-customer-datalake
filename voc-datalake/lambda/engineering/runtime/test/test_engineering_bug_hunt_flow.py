"""A run of the Bug hunt and fix template, end to end on the local fake runtime: the coordinator follows the flow, the
board launches each step's agent through the runtime's launch (its argv from the role's skill), and each agent runs
the harness's own entry with that argv, on a scripted Converse model, against the board API in process. The writers
reach the host through the harness's own broker client, signed as their own sessions, to the broker's own handler
behind a SigV4-checking function URL (``broker_stub``), with the broker's own readers of the run's record, the GO
ledger, the submitted patch and the dial (the starter's way of working AI-driven) over the run's real rows and
objects, and a host on the fixture repository that rebuilds each push with git. The run goes as far as the models
let it: to the draft pull request, or to a person when an agent stops without finishing."""
from __future__ import annotations

import functools
import json
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import Any

import boto3
import pytest

from engineering.board.api import BoardApi
from engineering.board.inbox import Inbox
from engineering.board.store import COORDINATE_TASK, BoardStore
from engineering.bus.publish import EventBridgePublisher
from engineering.connectors.broker import Broker
from engineering.connectors.dial import WaysOfWorking
from engineering.connectors.hosts import (
    BundleContents,
    CiProtection,
    CommentTarget,
    Conflict,
    Connector,
    PullRequestRef,
    ReadKind,
    ReadPage,
    RunRecord,
)
from engineering.connectors.identity import Caller
from engineering.connectors.patches import WorkspacePatches
from engineering.connectors.records import RunRecords, WriteClaims
from engineering.flow.ledger import read_gate_record
from engineering.flow.test.fixtures import TEMPLATES
from engineering.runtime import handler
from engineering.runtime.harness import main as harness_main
from engineering.runtime.harness.board_client import BoardHttp, BoardKnowledge, BoardPlanner, InboxHttp
from engineering.runtime.harness.broker_client import BrokerHttp, SignedBroker
from engineering.runtime.harness.converse_loop import ConverseAdapter
from engineering.runtime.harness.interface import AgentSession
from engineering.runtime.harness.ports import BrokerRefused
from engineering.runtime.harness.runner_client import RunnerClient
from engineering.runtime.harness.skills import COORDINATOR, SKILLS, Skill, harness_argv
from engineering.runtime.harness.tools import as_data
from engineering.runtime.test.broker_stub import AgentSessions, FunctionUrl
from engineering.runtime.test.conftest import BOARD_URL, BROKER_URL, COMMIT, TABLE, WORKSPACE_BUCKET
from engineering.runtime.test.harness_fakes import FakeBedrock, FakeRunner, use
from engineering.runtime.test.test_engineering_board_bus import Events
from engineering.runtime.test.test_engineering_harness_main import _vm_directory, fixture_repository, run_git
from engineering.runtime.test.test_engineering_inbox_end_to_end import ApiTransport
from engineering.workspace.store import WorkspaceStore
from shared.ai_mode import MODE_AI_DRIVEN, ai_mode_key
from shared.workflow_schema import encode_definition

RUN = '01JD3R4NZXQ7Y2W8K4M6P9T0CD'
#: The harness's own session builder (a test points its checkout at a temporary directory).
BUILD_SESSION = harness_main.build_session
BRANCH = f'voc-agent/{RUN}/fix-slug'
SLUGS = 'def slugify(text, max_length):\n    words, slug = text.lower().split(), ""\n'
FIXED = SLUGS.replace('""', '""  # <= max_length')
#: The agents whose session runs on real git (a checkout of the fixture repository): the fixer, whose submitted patch
#: is the change, and the gate's two, which judge it.
ON_GIT = ('fixer', 'gate-runner', 'final-go')
#: The person who started the run (a person's subject), whose way of working the broker's dial reads: AI-driven.
STARTER = 'person-sub-1'
#: The aggregates table's stand-in, where the people's ways of working are.
AGGREGATES = 'voc-aggregates-test'
#: The stored connection's repository: the run's ``repo`` at its start, and the one the host's credential is for.
REPOSITORY = 'example/app'
PULL_REQUEST = PullRequestRef(number=7, url='https://code.example.com/example/app/pull/7')


@dataclass
class GitHost:
    """The repository host on the fixture repository (``cache``, at ``commit``, which the run's ``COMMIT`` stands
    for): a base file read at the run's commit; a push rebuilt with git from the bundle's changes on that commit, and
    the branch moved only when the rebuilt tree is the checked one, as the host's client does (connectors/github.py);
    a draft opened only on a branch whose tree is the checked one."""

    cache: Path
    commit: str
    work: Path
    branches: dict[str, str] = field(default_factory=dict)
    writes: list[tuple[str, str, str]] = field(default_factory=list)

    def __post_init__(self) -> None:
        # The run's commit as the host has it: a clone of the cache at that commit, read file by file.
        run_git('clone', '--quiet', str(self.cache), str(self.work / 'base'))
        assert run_git('-C', str(self.work / 'base'), 'rev-parse', 'HEAD') == self.commit

    def read(self, connection_id: str, kind: ReadKind, target: str, cursor: str | None, branch: str = '') -> ReadPage:
        del connection_id, cursor, branch
        return ReadPage(content=f'{kind}:{target}', next_cursor=None)

    def ci_protection(self, connection_id: str, default_branch: str, branch: str) -> CiProtection:
        """The branch rules the setup guide asks for: the default branch protected with a required check, the agent's
        branch not protected."""
        assert (connection_id, default_branch, branch.startswith(f'voc-agent/{RUN}/')) == ('conn-1', 'main', True)
        return CiProtection(default_branch_protected=True, required_checks=('ci / test',), agent_branch_protected=False)

    def file_at(self, connection_id: str, commit: str, path: str) -> bytes | None:
        base = self.work / 'base' / path   # (a path the broker's patch reader took: no '..', no .git)
        return base.read_bytes() if (connection_id, commit) == ('conn-1', COMMIT) and base.is_file() else None

    def default_branch(self, connection_id: str, stored: str = '') -> str:
        assert connection_id == 'conn-1'
        return stored or 'main'

    def repository(self, connection_id: str) -> str:
        assert connection_id == 'conn-1'
        return REPOSITORY

    def post_comment(self, connection_id: str, on: CommentTarget, number: int, body: str) -> str:
        raise AssertionError(f'no comment in this flow ({connection_id}, {on} {number}, {len(body)} characters)')

    def branch_tree_hash(self, connection_id: str, branch: str) -> str | None:
        assert connection_id == 'conn-1'
        return self.branches.get(branch)

    def push_bundle(self, connection_id: str, branch: str, contents: BundleContents, tree_hash: str,
                    default_branch: str) -> None:
        assert (connection_id, default_branch, contents.base) == ('conn-1', 'main', COMMIT)
        clone = self.work / f'push-{len(self.writes)}'
        run_git('clone', '--quiet', str(self.cache), str(clone))
        for commit in contents.commits:
            for change in commit.changes:
                target = clone / change.path
                if change.content is None:
                    target.unlink()
                else:
                    target.parent.mkdir(parents=True, exist_ok=True)
                    target.write_bytes(change.content)
        run_git('-C', str(clone), 'add', '--all')
        rebuilt = run_git('-C', str(clone), 'write-tree')
        if rebuilt != tree_hash:
            raise Conflict('The tree rebuilt from the patch is not the checked one; nothing was pushed.')
        self.branches[branch] = rebuilt
        self.writes.append(('push_bundle', branch, rebuilt))

    def open_or_update_draft_pr(self, connection_id: str, branch: str, base: str, title: str, body: str,
                                tree_hash: str) -> PullRequestRef:
        assert (connection_id, base, bool(title and body)) == ('conn-1', 'main', True)
        if self.branches.get(branch) != tree_hash:
            raise Conflict("The branch's head is not the checked tree.")
        self.writes.append(('open_or_update_draft_pr', branch, tree_hash))
        return PULL_REQUEST


@dataclass
class Attested:
    """The broker's run directory (records.py ``RunRecords``) with the CI attestation given: the test stands in for an
    administrator's attestation of the repository's CI settings (its record, in voc-agents, is the Agents API's:
    lambda/api/test/test_agents_engineering_connections.py runs the broker on it end to end), and for nothing else."""

    records: RunRecords

    def run(self, run_id: str) -> RunRecord | None:
        return self.records.run(run_id)

    def attested(self, run: RunRecord) -> RunRecord:
        return replace(run, ci_attested=True, ci_attestation=1)


@dataclass
class GitRunner:
    """A session's runner: the harness's own git on its real checkout (``unit_runner.Runner``), repository code
    answered by the fake (exit 0: the scripted checks pass)."""

    git: RunnerClient
    code: FakeRunner = field(default_factory=FakeRunner)

    def run(self, argv: Sequence[str], *, timeout_seconds: int, repository_code: bool = True, network: bool = False,
            in_checkout: bool = True, on_wait: Callable[[], None] | None = None) -> dict[str, Any]:
        runner: Any = self.code if repository_code else self.git
        return runner.run(argv, timeout_seconds=timeout_seconds, repository_code=repository_code, network=network,
                          in_checkout=in_checkout, on_wait=on_wait)
FINDING = {'file': 'slugs.py', 'line': 2, 'severity': 'blocking', 'rule': 'off-by-one',
           'title': 'A slug exactly max_length long loses its last word', 'evidence': 'the length check uses <'}


class ScriptedModel(FakeBedrock):
    """One agent's Converse model, scripted: its turns in order (each the tool calls it answers with), then text
    only. Each call must be for the skill's own model, with the skill as its system prompt and exactly its tools."""

    def __init__(self, skill: Skill, turns: list[list[dict[str, Any]]]) -> None:
        super().__init__(turns)
        self.skill = skill

    def converse(self, **request: Any) -> dict[str, Any]:
        assert request['modelId'] == self.skill.model
        assert request['system'] == [{'text': self.skill.system_prompt()}]
        assert tuple(tool['toolSpec']['name'] for tool in request['toolConfig']['tools']) == self.skill.tool_policy
        return super().converse(**request)

    def refused(self) -> list[str]:
        """The tool results the session handed back as errors, in turn."""
        last = self.requests[-1]['messages'] if self.requests else []
        return [block['toolResult']['content'][0]['text'] for message in last for block in message['content']
                if 'toolResult' in block and block['toolResult']['status'] == 'error']


@dataclass
class RuntimeLauncher:
    """The board's launch, handed to voc-engineering-runtime's own ``launch`` in process (as LambdaLauncher invokes
    it): the runtime takes the agent's argv from its role's skill."""

    launched: list[str] = field(default_factory=list)

    def launch(self, request: Mapping[str, Any]) -> Mapping[str, Any]:
        self.launched.append(str(request['agent_id']))
        return handler.lambda_handler({**request, 'action': 'launch'}, None)


@dataclass
class BugHunt:
    api: BoardApi
    launcher: RuntimeLauncher
    s3: Any
    tmp: Path
    #: The fixture repository's cache (what a real checkout clones) and its commit.
    cache: Path
    commit: str
    #: The repository host and the broker's function URL in front of the broker's own handler.
    host: GitHost
    url: FunctionUrl
    models: dict[str, ScriptedModel] = field(default_factory=dict)

    def transport(self, agent_id: str) -> ApiTransport:
        role, index = agent_id.rsplit('-', 1)
        return ApiTransport(self.api, Caller(role, RUN, int(index)))

    def broker(self, agent_id: str) -> BrokerHttp:
        """The harness's own broker client, signed with the agent's own role session (the launcher's)."""
        return BrokerHttp(SignedBroker(BROKER_URL, 'us-east-1', self.url.sessions.credentials(agent_id),
                                       opener=self.url), RUN, agent_id, COMMIT)

    def ports(self, agent_id: str, task_id: str, attempt: int) -> harness_main.Ports:
        """``main.default_ports`` on the board API in process and the broker's function URL: the agent's own caller,
        never another's."""
        transport = self.transport(agent_id)
        return harness_main.Ports(board=BoardHttp(transport, RUN, task_id, epoch=attempt),
                                  inbox=InboxHttp(transport, RUN, agent_id), broker=self.broker(agent_id),
                                  planner=BoardPlanner(transport, RUN), knowledge=BoardKnowledge(transport, RUN, task_id))

    def broker_calls(self) -> list[tuple[str, str, int]]:
        """Each call the broker's function URL took: the caller's session name, the operation, the status."""
        return [(str(caller).rsplit('/', 1)[-1], operation, status) for caller, operation, status, _ in self.url.calls]

    def environment(self, agent_id: str) -> tuple[tuple[str, ...], dict[str, str]]:
        """The agent's argv and environment, as its session row has them (what the runtime starts it with)."""
        session = handler._supervisor().sessions.get(RUN, agent_id)
        assert session is not None
        home = self.tmp / agent_id / 'home'
        home.mkdir(parents=True)
        (self.tmp / agent_id / 'repo').mkdir()
        (self.tmp / agent_id / 'repo' / 'slugs.py').write_text(SLUGS)
        env = {**session.spec(None, WORKSPACE_BUCKET, BOARD_URL, BROKER_URL).environment(), 'AWS_REGION': 'us-east-1',
               'HOME': str(home)}
        assert (env['VOC_BROKER_URL'], BROKER_URL.removeprefix('https://').rstrip('/') in session.egress) == (
            BROKER_URL, True)
        return session.harness, env

    def run_agent(self, agent_id: str, turns: list[list[dict[str, Any]]], monkeypatch: pytest.MonkeyPatch) -> int:
        """The agent's whole session through the harness's entry, with the argv its session row records."""
        argv, env = self.environment(agent_id)
        skill = SKILLS[env['VOC_ROLE']]
        assert argv == harness_argv(skill)
        model = self.models[agent_id] = ScriptedModel(skill, turns)
        # (its own checkout: the image's /work/repo; the fixer's and the gate's a real one of the fixture repository)
        checkout, runner = str(self.tmp / agent_id / 'repo'), FakeRunner()
        if env['VOC_ROLE'] in ON_GIT:
            vm = self.tmp / agent_id / 'vm'
            checkout, runner = str(vm / 'work' / 'repo'), GitRunner(_vm_directory(vm, self.cache, self.commit))
        monkeypatch.setattr(harness_main, 'build_session', functools.partial(BUILD_SESSION, checkout=checkout))
        # argv[3:]: past the image's entry script (/usr/bin/python3 -I /opt/voc/harness.py), as the image runs it.
        code = harness_main.main(list(argv[3:]), env, s3=self.s3,
                                 ports=self.ports(agent_id, env['VOC_TASK_ID'], int(env['VOC_ATTEMPT'])),
                                 bedrock=lambda: model, runner=runner)
        assert model.refused() == []
        return code

    def coordinator(self) -> AgentSession:
        argv, env = self.environment('coordinator-1')
        assert argv == harness_argv(COORDINATOR)
        return BUILD_SESSION(env, s3=self.s3, ports=self.ports('coordinator-1', COORDINATE_TASK, 1),
                             runner=FakeRunner(), checkout=str(self.tmp / 'coordinator-1' / 'repo'))

    def plan(self) -> dict[str, Any]:
        flow = self.transport('coordinator-1').post({'op': 'flow'})['flow']
        assert isinstance(flow, dict)
        return flow

    def results(self, agent_id: str, start: str) -> list[str]:
        """The tool results ``agent_id``'s session was handed that start with ``start``."""
        texts = [block['toolResult']['content'][0]['text'] for message in self.models[agent_id].requests[-1]['messages']
                 for block in message['content'] if 'toolResult' in block]
        return [text for text in texts if text.startswith(start)]

    def read(self, agent_id: str, path: str) -> list[str]:
        """What ``agent_id``'s session was handed for each ``read_file`` of ``path``: its checkout's file, fenced."""
        return self.results(agent_id, f'<data source="file:{path}">')


def coordinate(session: AgentSession, turns: list[list[dict[str, Any]]]) -> str:
    """One stretch of the coordinator's session: its scripted turns, on its skill's model, none of them refused."""
    model = ScriptedModel(COORDINATOR, turns)
    ending = ConverseAdapter(model, COORDINATOR.model).run(session)
    assert model.refused() == []
    return ending


def statuses(flow: dict[str, Any]) -> dict[str, str]:
    return {step['step']: step['status'] for step in flow['steps']}


@pytest.fixture
def bug_hunt(wired: Any, aws: tuple[Any, Any], tmp_path: Path) -> BugHunt:
    assert wired is not None
    s3, _ = aws
    handler.lambda_handler({'action': 'start_run', 'run_id': RUN, 'max_tasks': 20, 'goal': 'hunt the slug bugs',
                            'connection': 'conn-1', 'repo': REPOSITORY, 'commit': COMMIT, 'language': 'python',
                            'flow': 'wf_bugs',
                            'flow_definition': encode_definition(TEMPLATES['bug-hunt-and-fix']), 'flow_revision': 1,
                            'actor': STARTER}, None)
    client = boto3.client('dynamodb', region_name='us-east-1')
    counter = iter(range(1, 100))
    workspace = WorkspaceStore(s3, WORKSPACE_BUCKET, denied_is_missing=True)
    launcher = RuntimeLauncher()
    # The board's own wiring (board/api.py _from_environment), its skill lookup the shipped one.
    api = BoardApi(BoardStore(client, TABLE, new_id=lambda: f'task-{next(counter)}'),
                   EventBridgePublisher(Events(), 'voc-engineering', 'voc.engineering/board'), Inbox(client, TABLE),
                   launcher=launcher, gate_records=lambda key: read_gate_record(workspace, key))
    cache, commit = fixture_repository(tmp_path, {'slugs.py': SLUGS})
    # The broker's own wiring (connectors/handler.py broker_for) over the run's rows and objects, the starter's way
    # of working AI-driven in the aggregates table, and the host on the fixture repository.
    people = boto3.resource('dynamodb', region_name='us-east-1').create_table(
        TableName=AGGREGATES, BillingMode='PAY_PER_REQUEST',
        KeySchema=[{'AttributeName': 'pk', 'KeyType': 'HASH'}, {'AttributeName': 'sk', 'KeyType': 'RANGE'}],
        AttributeDefinitions=[{'AttributeName': name, 'AttributeType': 'S'} for name in ('pk', 'sk')])
    people.put_item(Item={**ai_mode_key(STARTER), 'mode': MODE_AI_DRIVEN})
    host = GitHost(cache, commit, tmp_path / 'host')
    records = RunRecords(client, TABLE, workspace)
    broker = Broker(Connector(host=host, bundles=WorkspacePatches(workspace, host.file_at), runs=Attested(records),
                              ledger=records, dial=WaysOfWorking(people), writes=WriteClaims(client, TABLE)))
    return BugHunt(api, launcher, s3, tmp_path, cache, commit, host, FunctionUrl(BROKER_URL, broker, AgentSessions(RUN)))


def _fixed_tree(flow: BugHunt) -> str:
    """The tree of the run's commit with the fix, as the test's own git hashes it in a clone of its own."""
    clone = flow.tmp / 'expected'
    run_git('clone', '--quiet', str(flow.cache), str(clone))
    (clone / 'slugs.py').write_text(FIXED)
    run_git('-C', str(clone), 'add', 'slugs.py')
    return run_git('-C', str(clone), 'write-tree')


def _post_and_launch(role: str, step: str, task: str, title: str, **extra: str) -> list[list[dict[str, Any]]]:
    """The coordinator's two turns for one task of a live step: post it (``extra``: a gate's patch), then launch its
    agent."""
    return [[use('post_task', role=role, step=step, title=title, instructions=f'{title}: see the board.', **extra)],
            [use('launch_agent', task_id=task, role=role, language='python')]]


def _done(summary: str) -> list[dict[str, Any]]:
    return [use('finish', summary=summary)]


def test_a_bug_hunt_runs_every_step_with_its_roles_skill_to_the_draft_pull_request(
        bug_hunt: BugHunt, monkeypatch: pytest.MonkeyPatch):
    flow = bug_hunt
    coordinator = flow.coordinator()
    coordinate(coordinator, [[use('read_flow')], *_post_and_launch('hunter', 'hunt', 'task-1', 'Hunt in slugs.py')])
    assert flow.run_agent('hunter-2', [
        [use('list_files', path='')], [use('run', argv=['python3', '-m', 'unittest'])],
        [use('write_findings', package='.', shard='slugs', findings=[FINDING])],
        [use('post_subtask', title='Fix the slug cut', instructions='slugs.py:2 uses < where <= is meant.',
             paths=['slugs.py'], step='board')],
        _done('one bug, one fix posted')], monkeypatch) == 0
    assert statuses(flow.plan())['hunt'] == 'done'

    coordinate(coordinator, [[use('read_board')], [use('launch_agent', task_id='task-2', role='fixer',
                                                       language='python')]])
    flow.run_agent('fixer-3', [
        [use('read_file', path='slugs.py')],
        [use('write_file', path='slugs.py', text=FIXED)],
        [use('run', argv=['python3', '-m', 'unittest'])], [use('submit_work', summary='the <= fix and its test')],
        _done('fixed with a test')], monkeypatch)
    # The board lists the submitted patch among the fixer's task's outputs, where the coordinator reads it for the
    # gate's tasks. The submission went through the harness's broker client, which makes no call for it: the broker
    # reads the patch at the committer's push.
    listed = {task['task_id']: task for task in flow.transport('coordinator-1').post({'op': 'tasks'})['tasks']}
    [patch] = listed['task-2']['result_keys']
    assert patch.startswith(f'ws/default/runs/{RUN}/fixer-3/commits/{COMMIT}/_patches/attempt-1/task-2-')
    assert [json.loads(text)['broker'][:10] for text in flow.results('fixer-3', '{"patch"')] == ['submitted:']
    assert flow.broker_calls() == []
    coordinate(coordinator, _post_and_launch('commit-reviewer', 'board', 'task-3', 'Review the slug fix'))
    flow.run_agent('commit-reviewer-4', [
        [use('read_file', path='slugs.py')],
        [use('write_findings', package='.', shard='review', findings=[{**FINDING, 'severity': 'nit'}])],
        _done('no blocking finding')], monkeypatch)
    # Nothing is committed before the gate: the template's commit step comes after its GO, and the broker's own
    # checks refuse a push asked for early (no GO in the ledger for the fixed tree) or by a fixer (its role).
    tree = _fixed_tree(flow)
    assert (statuses(flow.plan())['commit'], flow.host.writes) == ('waiting', [])
    with pytest.raises(BrokerRefused, match='no final-go GO for this tree') as early:
        flow.broker('committer-9').push(RUN, 'committer-9', branch=BRANCH, patch_key=patch, tree_hash=tree,
                                        message='Keep a slug exactly max_length long')
    with pytest.raises(BrokerRefused, match='The fixer role may not push bundle') as fixer:
        flow.broker('fixer-3').push(RUN, 'fixer-3', branch=BRANCH, patch_key=patch, tree_hash=tree, message='m')
    assert (early.value.status, fixer.value.status, flow.host.writes) == (409, 403, [])

    # The gate's two tasks name the fixer's patch: the harness applies it to each one's checkout and hashes the tree
    # before anything runs, so the checks run on the fix and the record's tree is that tree, never a model's word.
    coordinate(coordinator, [[use('complete_step', step='board')], [use('read_board')],
                             *_post_and_launch('gate-runner', 'gate', 'task-4', 'Run the gate packs', patch=patch)])
    flow.run_agent('gate-runner-5', [
        [use('install_dependencies', argv=['python3', '-m', 'pip', 'install', '-r', 'requirements.txt'])],
        [use('read_file', path='slugs.py')], [use('run', argv=['python3', '-m', 'unittest'])],
        [use('write_gate_record', verdict='GO', tree_hash='d' * 40, packs=['python-ts'])],
        _done('every check passed')], monkeypatch)
    assert flow.read('gate-runner-5', 'slugs.py') == [as_data('file:slugs.py', FIXED)]
    # The board ties the final go to the patch the gate runner's checks ran on: never another submitted patch.
    other = patch.rsplit('/', 1)[0] + '/task-9-0a1b2c3d.diff'
    with pytest.raises(Exception, match="a final go judges the patch the gate runner's checks passed on"):
        flow.transport('coordinator-1').post({'op': 'post', 'role': 'final-go', 'flow_step': 'gate', 'title': 'Go',
                                              'spec': {'instructions': 'The final go.', 'patch': other}})
    coordinate(coordinator, _post_and_launch('final-go', 'gate', 'task-5', 'The final go', patch=patch))
    flow.run_agent('final-go-6', [[use('read_file', path='slugs.py')],
                                  [use('write_gate_record', verdict='GO', reasons=['checked'])], _done('GO')],
                   monkeypatch)
    assert flow.read('final-go-6', 'slugs.py') == [as_data('file:slugs.py', FIXED)]
    plan = flow.plan()
    assert (statuses(plan)['gate'], statuses(plan)['commit']) == ('done', 'ready')
    tasks = {task.task_id: task for task in flow.api.store.tasks('default', RUN)}
    records = [json.loads(flow.s3.get_object(Bucket=WORKSPACE_BUCKET, Key=tasks[task].result_keys[0])['Body'].read())
               for task in ('task-4', 'task-5')]
    assert [(record['verdict'], record['tree_hash']) for record in records] == [('GO', tree), ('GO', tree)]

    # After the GO: the committer pushes the fixer's submitted patch, for the tree the gate judged.
    coordinate(coordinator, _post_and_launch('committer', 'commit', 'task-6', 'Commit the slug fix', patch=patch))
    flow.run_agent('committer-7', [
        [use('push_commit', branch=BRANCH, patch=patch, tree_hash=tree, message='Keep a slug exactly max_length long')],
        _done('pushed')], monkeypatch)
    assert statuses(flow.plan())['pr_author'] == 'ready'
    coordinate(coordinator, _post_and_launch('pr-author', 'pr_author', 'task-7', 'Open the draft pull request'))
    flow.run_agent('pr-author-8', [
        [use('open_draft_pr', branch=BRANCH, title='Keep a slug exactly max_length long',
             body='Fixes the slug cut (slugs.py:2), tested; the gate said GO.')], _done('draft #7 opened')],
        monkeypatch)
    assert coordinate(coordinator, [[use('read_flow')], _done('the flow reached its draft pull request')]) == 'done'

    # Every step's agent was launched by the board through the runtime, with its role's skill's argv and label.
    assert flow.launcher.launched == ['hunter-2', 'fixer-3', 'commit-reviewer-4', 'gate-runner-5', 'final-go-6',
                                      'committer-7', 'pr-author-8']
    table = boto3.resource('dynamodb', region_name='us-east-1').Table(TABLE)
    for agent_id in ['coordinator-1', *flow.launcher.launched]:
        row = table.get_item(Key={'pk': f'WS#default#RUN#{RUN}', 'sk': f'AGENT#{agent_id}'}).get('Item')
        assert row is not None
        skill, argv = SKILLS[str(row['role'])], row['harness']
        assert isinstance(argv, list)
        assert (tuple(argv), row['model'], row['skill_version']) == (
            harness_argv(skill), skill.model, f'{skill.name}@{skill.version}')
    plan = flow.plan()
    assert statuses(plan) == {'start': 'done', 'hunt': 'done', 'board': 'done', 'gate': 'done', 'commit': 'done',
                              'pr_author': 'done', 'pr': 'done', 'human': 'skipped'}
    # The outputs went where their readers read them, recorded on the tasks (the fixer's: its submitted patch, the
    # one the committer pushed). The host writes went through the broker, each writer as its own session: the push
    # only after the GO, rebuilt by the host from the patch to exactly the tree the gate judged, and the draft on
    # that branch's tree.
    tasks = {task.task_id: task for task in flow.api.store.tasks('default', RUN)}
    assert all(task.state == 'done' for task in tasks.values())
    assert [len(tasks[t].result_keys) for t in ('task-1', 'task-2', 'task-3', 'task-4', 'task-5')] == [1] * 5
    assert tasks['task-2'].result_keys == (patch,)
    assert flow.host.writes == [('push_bundle', BRANCH, tree), ('open_or_update_draft_pr', BRANCH, tree)]
    assert flow.broker_calls() == [(f'{RUN}.9', 'push_bundle', 409), (f'{RUN}.3', 'push_bundle', 403),
                                   (f'{RUN}.7', 'push_bundle', 200), (f'{RUN}.8', 'open_or_update_draft_pr', 200)]
    assert [json.loads(text)['broker'] for text in flow.results('pr-author-8', '{"broker"')] == [
        {'number': PULL_REQUEST.number, 'url': PULL_REQUEST.url}]


def test_an_agent_that_stops_without_finishing_takes_the_run_to_a_person(bug_hunt: BugHunt,
                                                                         monkeypatch: pytest.MonkeyPatch):
    flow = bug_hunt
    coordinate(flow.coordinator(), _post_and_launch('hunter', 'hunt', 'task-1', 'Hunt in slugs.py'))
    # The model reads one file and answers without a tool twice: the session ends, its task goes to a person.
    assert flow.run_agent('hunter-2', [[use('read_file', path='slugs.py')]], monkeypatch) == 0
    task = flow.api.store.task('default', RUN, 'task-1')
    plan = flow.plan()
    assert (task.state, statuses(plan)['hunt'], statuses(plan)['board'], plan['at']) == (
        'needs_human', 'blocked', 'waiting', 'hunt')
    assert flow.launcher.launched == ['hunter-2']


def test_a_launch_of_a_role_with_no_skill_is_refused_by_the_board_before_an_agent_is_numbered(bug_hunt: BugHunt):
    caller: Callable[[dict[str, Any]], dict[str, Any]] = bug_hunt.transport('coordinator-1').post
    caller({'op': 'post', 'role': 'hunter', 'flow_step': 'hunt', 'title': 'Hunt', 'spec': {'instructions': 'Hunt.'}})
    bug_hunt.api.skill = lambda role: None if role == 'hunter' else SKILLS.get(role)
    with pytest.raises(Exception, match='no hunter agent can be launched yet: the role has no skill'):
        caller({'op': 'launch', 'task_id': 'task-1', 'role': 'hunter', 'language': 'python', 'paths': []})
    bug_hunt.api.skill = SKILLS.get
    assert caller({'op': 'launch', 'task_id': 'task-1', 'role': 'hunter', 'language': 'python',
                   'paths': []})['agent_id'] == 'hunter-2'
    assert bug_hunt.launcher.launched == ['hunter-2']
