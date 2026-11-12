"""The run coordinator's own tools: read the board, post a task, launch its agent, read the knowledge pack.

The coordinator plans; it changes no code. What it posts and launches goes through the board (``ports.Planner``),
which checks the caller's identity and role as for every agent, and runs on the caller's run's connection and
commit, which the board takes from that run: neither the model nor anything in the MicroVM names them. Everything the board or the knowledge pack returns is fenced
as data (``tools.as_data``): a task's title or a pack's text is never an instruction.
"""
from __future__ import annotations

import json
from collections.abc import Callable, Mapping
from typing import Any, Final

from engineering.connectors.identity import AGENT_ROLES
from engineering.runtime.checkout import MAX_SPARSE_PATHS, check_sparse_path
from engineering.runtime.harness.board_client import BoardRefused
from engineering.runtime.interface import check_id

#: What tools.py hands in (its ToolSpec and ToolResult classes, its AgentContext): taken as arguments, never
#: imported, so this module and tools.py, which imports it, do not import each other.
Built = Any

#: The roles a task may be for: every agent role but the planners themselves.
TASK_ROLES: Final = frozenset(AGENT_ROLES - {'coordinator', 'coach'})
MAX_TITLE: Final = 200
MAX_INSTRUCTIONS: Final = 8_000
#: The image languages (lambda/engineering/runtime/egress.py REGISTRY_HOSTS; the launch checks it again).
LANGUAGES: Final = frozenset({'java', 'node', 'python', 'rust'})


def specs(tool_spec: Callable[..., Built]) -> tuple[Built, ...]:
    text = {'type': 'string'}
    paths = {'type': 'array', 'items': {'type': 'string'},
             'description': f'Repository paths (relative, no ".."), at most {MAX_SPARSE_PATHS}.'}
    role = {'type': 'string', 'enum': sorted(TASK_ROLES)}
    return (
        tool_spec('read_board', 'The run\'s tasks on the board: each one\'s id, role, title, state and attempt.', {}),
        tool_spec('post_task', 'Post one task for one role, with instructions a person could follow.',
                  {'role': role, 'title': text, 'instructions': text, 'paths': paths}, ('role', 'title', 'instructions')),
        tool_spec('launch_agent', 'Launch one agent for a task you posted, in the run\'s repository at its commit.',
                  {'task_id': text, 'role': role, 'language': {'type': 'string', 'enum': sorted(LANGUAGES)},
                   'paths': paths}, ('task_id', 'role', 'language')),
        tool_spec('read_knowledge', 'The repository\'s knowledge pack (its root\'s): conventions, build and test '
                  'commands, the parts that matter.', {}),
    )


def _bounded(arguments: Mapping[str, Any], name: str, limit: int) -> str:
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


def _paths(arguments: Mapping[str, Any]) -> tuple[str, ...]:
    """Repository paths as the checkout takes them (``checkout.check_sparse_path``: relative, no ``..``, no glob)."""
    raw = arguments.get('paths', [])
    if not isinstance(raw, list) or len(raw) > MAX_SPARSE_PATHS or not all(isinstance(path, str) for path in raw):
        raise ValueError(f'paths are at most {MAX_SPARSE_PATHS} repository paths')
    return tuple(check_sparse_path(path) for path in raw)


def handlers(context: Built, result: Callable[..., Built],
             as_data: Callable[[str, str], str]) -> dict[str, Callable[[Mapping[str, Any]], Built]]:
    """The coordinator's tools, on ``context``'s planner and knowledge reader."""

    def read_board(_arguments: Mapping[str, Any]) -> Built:
        tasks = [{'task_id': task.task_id, 'role': task.role, 'title': task.title, 'state': task.state,
                  'attempt': task.attempt} for task in context.planner.tasks(run_id=context.run_id)]
        return result(as_data('board', json.dumps(tasks)))

    def post_task(arguments: Mapping[str, Any]) -> Built:
        task_id = context.planner.post(run_id=context.run_id, role=_role(arguments),
                                       title=_bounded(arguments, 'title', MAX_TITLE),
                                       instructions=_bounded(arguments, 'instructions', MAX_INSTRUCTIONS),
                                       paths=_paths(arguments))
        context.progress(f'posted task {task_id}')
        return result(json.dumps({'task_id': task_id}))

    def launch_agent(arguments: Mapping[str, Any]) -> Built:
        language = arguments.get('language')
        if language not in LANGUAGES:
            raise ValueError(f'language is one of {sorted(LANGUAGES)}')
        task_id = check_id('task_id', str(arguments.get('task_id', '')))
        agent = context.planner.launch(run_id=context.run_id, task_id=task_id, role=_role(arguments),
                                       language=str(language), paths=_paths(arguments))
        context.progress(f'launched {agent} for task {task_id}')
        return result(json.dumps({'agent_id': agent, 'task_id': task_id}))

    def read_knowledge(_arguments: Mapping[str, Any]) -> Built:
        # The root's pack: the coordinator's task (the run's coordinate task) has no paths of its own.
        parts = context.knowledge.read(run_id=context.run_id, package='')
        if not parts:
            return result('no approved knowledge pack for the repository yet')
        return result('\n'.join(as_data(f'knowledge:{n}', part) for n, part in enumerate(parts, 1)))

    def answered(tool: Callable[[Mapping[str, Any]], Built]) -> Callable[[Mapping[str, Any]], Built]:
        """The board's refusal (a 4xx: no skill for the role yet, a cap, a path not the task's) is a result the
        model reads; a 5xx is raised (a crash the supervisor continues)."""
        def call(arguments: Mapping[str, Any]) -> Built:
            try:
                return tool(arguments)
            except BoardRefused as refused:
                if refused.status >= 500:
                    raise
                return result(f'the board refused: {refused}', error=True)
        return call

    return {name: answered(tool) for name, tool in (('read_board', read_board), ('post_task', post_task),
                                                     ('launch_agent', launch_agent), ('read_knowledge', read_knowledge))}
