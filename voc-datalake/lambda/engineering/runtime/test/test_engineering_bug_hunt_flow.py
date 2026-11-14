"""A run of the Bug hunt and fix template, end to end on the local fake runtime: the coordinator follows the flow, the
board launches each step's agent through the runtime's launch (its argv from the role's skill), and each agent runs
the harness's own entry with that argv, on a scripted Converse model, against the board API in process. The run goes
as far as the models let it: to the draft pull request, or to a person when an agent stops without finishing."""
from __future__ import annotations

import functools
import json
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import boto3
import pytest

from engineering.board.api import BoardApi
from engineering.board.inbox import Inbox
from engineering.board.store import COORDINATE_TASK, BoardStore
from engineering.bus.publish import EventBridgePublisher
from engineering.connectors.identity import Caller
from engineering.flow.ledger import read_gate_record
from engineering.flow.test.fixtures import TEMPLATES
from engineering.runtime import handler
from engineering.runtime.harness import main as harness_main
from engineering.runtime.harness.board_client import BoardHttp, BoardKnowledge, BoardPlanner, InboxHttp
from engineering.runtime.harness.converse_loop import ConverseAdapter
from engineering.runtime.harness.interface import AgentSession
from engineering.runtime.harness.runner_client import RunnerClient
from engineering.runtime.harness.skills import COORDINATOR, SKILLS, Skill, harness_argv
from engineering.runtime.harness.tools import as_data
from engineering.runtime.test.conftest import BOARD_URL, COMMIT, TABLE, WORKSPACE_BUCKET
from engineering.runtime.test.harness_fakes import FakeBedrock, FakeBroker, FakeRunner, use
from engineering.runtime.test.test_engineering_board_bus import Events
from engineering.runtime.test.test_engineering_harness_main import _vm_directory, fixture_repository, run_git
from engineering.runtime.test.test_engineering_inbox_end_to_end import ApiTransport
from engineering.workspace.store import WorkspaceStore
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
    broker: FakeBroker = field(default_factory=FakeBroker)
    models: dict[str, ScriptedModel] = field(default_factory=dict)

    def transport(self, agent_id: str) -> ApiTransport:
        role, index = agent_id.rsplit('-', 1)
        return ApiTransport(self.api, Caller(role, RUN, int(index)))

    def ports(self, agent_id: str, task_id: str, attempt: int) -> harness_main.Ports:
        """``main.default_ports`` on the board API in process: the agent's own caller, never another's."""
        transport = self.transport(agent_id)
        return harness_main.Ports(board=BoardHttp(transport, RUN, task_id, epoch=attempt),
                                  inbox=InboxHttp(transport, RUN, agent_id), broker=self.broker,
                                  planner=BoardPlanner(transport, RUN), knowledge=BoardKnowledge(transport, RUN, task_id))

    def environment(self, agent_id: str) -> tuple[tuple[str, ...], dict[str, str]]:
        """The agent's argv and environment, as its session row has them (what the runtime starts it with)."""
        session = handler._supervisor().sessions.get(RUN, agent_id)
        assert session is not None
        home = self.tmp / agent_id / 'home'
        home.mkdir(parents=True)
        (self.tmp / agent_id / 'repo').mkdir()
        (self.tmp / agent_id / 'repo' / 'slugs.py').write_text(SLUGS)
        env = {**session.spec(None, WORKSPACE_BUCKET, BOARD_URL).environment(), 'AWS_REGION': 'us-east-1',
               'HOME': str(home)}
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

    def read(self, agent_id: str, path: str) -> list[str]:
        """What ``agent_id``'s session was handed for each ``read_file`` of ``path``: its checkout's file, fenced."""
        texts = [block['toolResult']['content'][0]['text'] for message in self.models[agent_id].requests[-1]['messages']
                 for block in message['content'] if 'toolResult' in block]
        return [text for text in texts if text.startswith(f'<data source="file:{path}">')]


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
                            'connection': 'conn-1', 'commit': COMMIT, 'language': 'python', 'flow': 'wf_bugs',
                            'flow_definition': encode_definition(TEMPLATES['bug-hunt-and-fix']), 'flow_revision': 1},
                           None)
    client = boto3.client('dynamodb', region_name='us-east-1')
    counter = iter(range(1, 100))
    workspace = WorkspaceStore(s3, WORKSPACE_BUCKET, denied_is_missing=True)
    launcher = RuntimeLauncher()
    # The board's own wiring (board/api.py _from_environment), its skill lookup the shipped one.
    api = BoardApi(BoardStore(client, TABLE, new_id=lambda: f'task-{next(counter)}'),
                   EventBridgePublisher(Events(), 'voc-engineering', 'voc.engineering/board'), Inbox(client, TABLE),
                   launcher=launcher, gate_records=lambda key: read_gate_record(workspace, key))
    return BugHunt(api, launcher, s3, tmp_path, *fixture_repository(tmp_path, {'slugs.py': SLUGS}))


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
    patch = flow.broker.submitted[0][3]
    # The board lists it among the fixer's task's outputs, where the coordinator reads it for the gate's tasks.
    listed = {task['task_id']: task for task in flow.transport('coordinator-1').post({'op': 'tasks'})['tasks']}
    assert listed['task-2']['result_keys'] == [patch]
    coordinate(coordinator, _post_and_launch('commit-reviewer', 'board', 'task-3', 'Review the slug fix'))
    flow.run_agent('commit-reviewer-4', [
        [use('read_file', path='slugs.py')],
        [use('write_findings', package='.', shard='review', findings=[{**FINDING, 'severity': 'nit'}])],
        _done('no blocking finding')], monkeypatch)
    # Nothing is committed before the gate: the template's commit step comes after its GO.
    assert (statuses(flow.plan())['commit'], flow.broker.writes) == ('waiting', [])

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
    tree = _fixed_tree(flow)
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
    # one the committer pushed); the host writes went to the broker, the push only after the GO.
    tasks = {task.task_id: task for task in flow.api.store.tasks('default', RUN)}
    assert all(task.state == 'done' for task in tasks.values())
    assert [len(tasks[t].result_keys) for t in ('task-1', 'task-2', 'task-3', 'task-4', 'task-5')] == [1] * 5
    assert tasks['task-2'].result_keys == (patch,)
    assert [(write[0], write[3].get('patch'), write[3].get('tree_hash')) for write in flow.broker.writes] == [
        ('push_bundle', patch, tree), ('open_or_update_draft_pr', None, None)]
    assert [submitted[1] for submitted in flow.broker.submitted] == ['fixer-3']


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
