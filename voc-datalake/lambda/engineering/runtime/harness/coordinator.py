"""The run coordinator's own tools: read the board, post a task, launch its agent, read the knowledge pack.

The coordinator plans; it changes no code. What it posts and launches goes through the board (``ports.Planner``),
which checks the caller's identity and role as for every agent, and runs on the caller's run's connection and
commit, which the board takes from that run: neither the model nor anything in the session names them. Everything the board or the knowledge pack returns is fenced
as data (``tools.as_data``): a task's title or a pack's text is never an instruction.
"""
from __future__ import annotations

import json
from collections.abc import Callable, Mapping
from typing import Any, Final

from engineering.connectors.identity import AGENT_ROLES
from engineering.runtime.checkout import check_sparse_path
from engineering.runtime.harness.board_client import BoardRefused
from engineering.runtime.interface import MAX_TASK_PATHS, check_id
from engineering.runtime.outputs import is_submitted_patch

#: What tools.py hands in (its ToolSpec and ToolResult classes, its AgentContext): taken as arguments, never
#: imported, so this module and tools.py, which imports it, do not import each other.
Built = Any

#: The roles a task may be for: every agent role but the planners themselves.
TASK_ROLES: Final = frozenset(AGENT_ROLES - {'coordinator', 'coach'})
#: The roles whose task names a submitted patch: the gate's (which judge it) and the committer (which pushes it).
PATCH_ROLES: Final = frozenset({'gate-runner', 'final-go', 'committer'})
MAX_TITLE: Final = 200
MAX_INSTRUCTIONS: Final = 8_000
#: The image languages (lambda/engineering/runtime/egress.py REGISTRY_HOSTS; the launch checks it again).
LANGUAGES: Final = frozenset({'java', 'node', 'python', 'rust'})


#: A step id of the run's flow (shared/workflow_schema.py: at most 64 characters); a map's shard is a repository path.
MAX_STEP: Final = 64
#: The most shards a map lists (shared/workflow_engineering.py MAX_SHARD_CAP; the board holds the map's own cap).
MAX_SHARDS: Final = 200


def specs(tool_spec: Callable[..., Built]) -> tuple[Built, ...]:
    text = {'type': 'string'}
    paths = {'type': 'array', 'items': {'type': 'string'},
             'description': f'Repository paths (relative, no ".."), at most {MAX_TASK_PATHS}.'}
    role = {'type': 'string', 'enum': sorted(TASK_ROLES)}
    step = {'type': 'string', 'description': 'The id of a ready step of the run\'s flow (read_flow).'}
    return (
        tool_spec('read_board', 'The run\'s tasks on the board: each one\'s id, role, title, state, attempt, step and '
                  'outputs (a fixer\'s or builder\'s submitted patch among them).', {}),
        tool_spec('read_flow', 'The run\'s flow: every step\'s status, and the ready ones with their roles, settings '
                  'and what to do at them. The only steps you may work on.', {}),
        tool_spec('post_task', 'Post one task for one role of a ready step, with instructions a person could follow.',
                  {'role': role, 'title': text, 'instructions': text, 'paths': paths, 'step': step,
                   'shard': {'type': 'string', 'description': 'For a step after a map: the shard the task works on.'},
                   'patch': {'type': 'string', 'description': 'For a gate runner\'s, a final go\'s or the '
                             'committer\'s task: the key of the patch a fixer or builder submitted (read_board '
                             'lists it among that task\'s outputs), the one the gate judges.'}},
                  ('role', 'title', 'instructions')),
        tool_spec('launch_agent', 'Launch one agent for a task you posted, in the run\'s repository at its commit.',
                  {'task_id': text, 'role': role, 'language': {'type': 'string', 'enum': sorted(LANGUAGES)},
                   'paths': paths}, ('task_id', 'role', 'language')),
        tool_spec('complete_step', 'Record a step you did yourself (an agent step of your own role) or close a board '
                  'once everything on it is done.', {'step': step}, ('step',)),
        tool_spec('fan_out', 'Record a map step\'s shards: the repository\'s packages, as paths, at most its '
                  'shard_cap.', {'step': step, 'shards': {**paths, 'description': 'Repository paths, each once.'}},
                  ('step', 'shards')),
        tool_spec('read_knowledge', 'The repository\'s knowledge pack (its root\'s): conventions, build and test '
                  'commands, the parts that matter.', {}),
    )


def bounded(arguments: Mapping[str, Any], name: str, limit: int) -> str:
    """``arguments[name]`` as stripped text of 1-``limit`` characters (the model's JSON may send a number)."""
    value = str(arguments.get(name) or '').strip()
    if not 0 < len(value) <= limit:
        raise ValueError(f'{name} is text of 1-{limit} characters')
    return value


def _role(arguments: Mapping[str, Any]) -> str:
    role = arguments.get('role')
    if role not in TASK_ROLES:
        raise ValueError(f'role is one of {sorted(TASK_ROLES)}')
    return str(role)


def task_paths(arguments: Mapping[str, Any]) -> tuple[str, ...]:
    """Repository paths as the checkout takes them (``checkout.check_sparse_path``: relative, no ``..``, no glob)."""
    raw = arguments.get('paths', [])
    if not isinstance(raw, list) or len(raw) > MAX_TASK_PATHS or not all(isinstance(path, str) for path in raw):
        raise ValueError(f'paths are at most {MAX_TASK_PATHS} repository paths')
    return tuple(check_sparse_path(path) for path in raw)


def optional(arguments: Mapping[str, Any], name: str, limit: int) -> str:
    """``arguments[name]`` as stripped text of at most ``limit`` characters, '' when left out."""
    value = arguments.get(name)
    return '' if value in (None, '') else bounded(arguments, name, limit)


def listed(arguments: Mapping[str, Any], name: str, limit: int, kind: type, what: str) -> list[Any]:
    """``arguments[name]`` as a list of 1-``limit`` items of ``kind`` (``what``: how a refusal names them)."""
    raw = arguments.get(name)
    if not isinstance(raw, list) or not 0 < len(raw) <= limit or not all(isinstance(item, kind) for item in raw):
        raise ValueError(f'{name} are 1-{limit} {what}')
    return raw


def _shards(arguments: Mapping[str, Any]) -> tuple[str, ...]:
    return tuple(check_sparse_path(path) for path in listed(arguments, 'shards', MAX_SHARDS, str, 'repository paths'))


Tool = Callable[[Mapping[str, Any]], Built]


def post_for(context: Built, result: Callable[..., Built], arguments: Mapping[str, Any], role: str,
             shard: str = '', patch: str = '') -> Built:
    """Post one task for ``role`` on the board (its title, instructions, paths and step from ``arguments``)."""
    task_id = context.planner.post(run_id=context.run_id, role=role, title=bounded(arguments, 'title', MAX_TITLE),
                                   instructions=bounded(arguments, 'instructions', MAX_INSTRUCTIONS),
                                   paths=task_paths(arguments), step=optional(arguments, 'step', MAX_STEP),
                                   shard=shard, patch=patch)
    context.progress(f'posted task {task_id}')
    return result(json.dumps({'task_id': task_id}))


def _flow_tools(context: Built, result: Callable[..., Built], as_data: Callable[[str, str], str]) -> dict[str, Tool]:
    """The tools that follow the run's flow: its plan read, and the steps the coordinator does itself recorded."""

    def read_flow(_arguments: Mapping[str, Any]) -> Built:
        plan = context.planner.flow(run_id=context.run_id)
        if plan is None:
            return result('this run follows no flow: plan the work from the run\'s goal')
        # (the flow's titles and instructions are a person's text: data, like the board's)
        return result(as_data('flow', json.dumps(plan)))

    def complete_step(arguments: Mapping[str, Any]) -> Built:
        step = bounded(arguments, 'step', MAX_STEP)
        answer = context.planner.record_step(run_id=context.run_id, step=step, action='complete')
        context.progress(f'completed step {step}')
        return result(as_data('flow', json.dumps(answer.get('flow'))))

    def fan_out(arguments: Mapping[str, Any]) -> Built:
        step, shards = bounded(arguments, 'step', MAX_STEP), _shards(arguments)
        answer = context.planner.record_step(run_id=context.run_id, step=step, action='fan_out', shards=shards)
        context.progress(f'listed {len(shards)} shards for step {step}')
        return result(as_data('flow', json.dumps(answer.get('flow'))))

    return {'read_flow': read_flow, 'complete_step': complete_step, 'fan_out': fan_out}


def handlers(context: Built, result: Callable[..., Built],
             as_data: Callable[[str, str], str]) -> dict[str, Callable[[Mapping[str, Any]], Built]]:
    """The coordinator's tools, on ``context``'s planner and knowledge reader."""

    def read_board(_arguments: Mapping[str, Any]) -> Built:
        tasks = [{'task_id': task.task_id, 'role': task.role, 'title': task.title, 'state': task.state,
                  'attempt': task.attempt, 'step': task.step or None, 'outputs': list(task.result_keys)}
                 for task in context.planner.tasks(run_id=context.run_id)]
        return result(as_data('board', json.dumps(tasks)))

    def post_task(arguments: Mapping[str, Any]) -> Built:
        role, shard, patch = _role(arguments), optional(arguments, 'shard', 512), optional(arguments, 'patch', 512)
        if patch and (role not in PATCH_ROLES or not is_submitted_patch(patch, context.run_id, context.commit)):
            raise ValueError(f'patch is for a task of {", ".join(sorted(PATCH_ROLES))} only: the key of a patch a '
                             'fixer or builder of this run submitted (read_board lists it among its outputs)')
        return post_for(context, result, arguments, role, check_sparse_path(shard) if shard else '', patch)

    def launch_agent(arguments: Mapping[str, Any]) -> Built:
        language = arguments.get('language')
        if language not in LANGUAGES:
            raise ValueError(f'language is one of {sorted(LANGUAGES)}')
        task_id = check_id('task_id', str(arguments.get('task_id', '')))
        agent = context.planner.launch(run_id=context.run_id, task_id=task_id, role=_role(arguments),
                                       language=str(language), paths=task_paths(arguments))
        context.progress(f'launched {agent} for task {task_id}')
        return result(json.dumps({'agent_id': agent, 'task_id': task_id}))

    def read_knowledge(_arguments: Mapping[str, Any]) -> Built:
        # The root's pack: the coordinator's task (the run's coordinate task) has no paths of its own.
        parts = context.knowledge.read(run_id=context.run_id, task_id=context.task_id, package='')
        if not parts:
            return result('no approved knowledge pack for the repository yet')
        return result('\n'.join(as_data(f'knowledge:{n}', part) for n, part in enumerate(parts, 1)))

    tools = {'read_board': read_board, 'post_task': post_task, 'launch_agent': launch_agent,
             'read_knowledge': read_knowledge, **_flow_tools(context, result, as_data)}
    return {name: answered(tool, result) for name, tool in tools.items()}


def answered(tool: Tool, result: Callable[..., Built]) -> Tool:
    """The board's refusal (a 4xx: no skill for the role yet, a cap, a path not the task's) is a result the model
    reads; a 5xx is raised (a crash the supervisor continues)."""
    def call(arguments: Mapping[str, Any]) -> Built:
        try:
            return tool(arguments)
        except BoardRefused as refused:
            if refused.status >= 500:
                raise
            return result(f'the board refused: {refused}', error=True)
    return call
