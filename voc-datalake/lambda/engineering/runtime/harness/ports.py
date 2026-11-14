"""What the harness needs from the parts of the system it does not own, as small interfaces.

The board (the task brief, the lease's heartbeat and progress; for the run coordinator, the run's tasks, posting
one and launching its agent), the agent's inbox (the run monitor's and the supervisor's messages: ``save``,
``pause``, a question), the knowledge pack (its agent reader: the latest approved version, read as data) and the
broker (every write to the repository host) are built apart from the runtime (engineering/board, its inbox op
included, engineering/knowledge, engineering/connectors;
docs/autonomous-engineering.md → How the agents work together, Repository connectors). Until the harness is
wired to them, it reaches them only through these interfaces, the
tests use fakes of them, and ``main.py`` wires adapters that refuse (``PendingHarnessPorts``), like the
supervisor's own ports.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Final, Protocol

#: The inbox messages the harness acts on itself; any other kind is shown to the model as data.
SAVE: Final = 'save'
PAUSE: Final = 'pause'


@dataclass(frozen=True)
class TaskBrief:
    """What the agent is asked to do, and the only context it gets: its task and its slices."""

    task_id: str
    title: str
    instructions: str
    #: Knowledge-pack slices for this task (the connector's pack: conventions, build and test commands).
    knowledge: tuple[str, ...] = ()
    #: Memory slices (what earlier runs learnt that this task needs).
    memory: tuple[str, ...] = ()
    #: The submitted patch the task is about (its spec's ``patch``: a fixer's or builder's ``_patches/`` key), which
    #: the harness applies before a gate's session starts (``role_tools.judge_submitted_patch``); '' for none.
    patch: str = ''


@dataclass(frozen=True)
class InboxMessage:
    kind: str
    summary: str = ''
    #: The notice's event id: what ``Inbox.done`` names.
    event_id: str = ''


class Board(Protocol):
    """``brief``: the task's brief (refused when the agent does not hold the task's lease). ``heartbeat``: renew the
    lease (once a minute, the supervisor's crash clock). ``progress``: record progress on the task (the lease's last
    progress, the supervisor's activity clock). ``move``: move the agent's own task on (``done`` when it finishes, with
    the keys of the outputs it wrote under its own keys, which the board records on the task for the steps after it)."""

    def brief(self, *, run_id: str, task_id: str) -> TaskBrief: ...

    def heartbeat(self, *, run_id: str, task_id: str, agent_id: str) -> None: ...

    def progress(self, run_id: str, task_id: str, agent_id: str, step: str) -> None: ...

    def move(self, run_id: str, task_id: str, *, to_state: str, result_keys: tuple[str, ...] = ()) -> None: ...


@dataclass(frozen=True)
class TaskSummary:
    """One task of the run, as the coordinator reads the board."""

    task_id: str
    role: str
    title: str
    state: str
    attempt: int = 1
    #: The step of the run's flow it was posted for ('' for none).
    step: str = ''
    #: The outputs recorded on it when it finished (a fixer's or builder's: its submitted patch).
    result_keys: tuple[str, ...] = ()


class Planner(Protocol):
    """The run coordinator's view of its run: ``tasks`` on the board, ``post`` a task (its id; for a step of the
    run's flow, and a map's shard; for a gate's or the committer's, the submitted patch it is about), ``launch`` one agent for a task (its id), ``flow`` (the conductor's plan of the
    run's flow, None for a run without one) and ``record_step`` (a step it did itself, or a map's shards). The run's
    connection and commit are the board's to take from the verified caller's run, never anything the session sends."""

    def tasks(self, *, run_id: str) -> list[TaskSummary]: ...

    def post(self, *, run_id: str, role: str, title: str, instructions: str, paths: tuple[str, ...],
             step: str = '', shard: str = '', patch: str = '') -> str: ...

    def launch(self, *, run_id: str, task_id: str, role: str, language: str, paths: tuple[str, ...]) -> str: ...

    def flow(self, *, run_id: str) -> dict[str, Any] | None: ...

    def record_step(self, *, run_id: str, step: str, action: str, shards: tuple[str, ...] = ()) -> dict[str, Any]: ...


class KnowledgeReader(Protocol):
    """The knowledge pack's agent reader: the caller's run's connection's latest approved pack of ``package`` (one of
    its own task's paths, or '' for the repository's root; the board takes the connection from the verified caller and
    checks it holds ``task_id``'s live lease), as text fenced as data (none when no version is approved)."""

    def read(self, *, run_id: str, task_id: str, package: str) -> list[str]: ...


class Inbox(Protocol):
    """``take``: the messages waiting for the agent, each taken once in a session. ``done``: these reached the model,
    or were acted on. ``cursor``: what a checkpoint saves, up to the oldest message taken and not yet done;
    ``resume``: start there (a continuation takes again only what never reached the model)."""

    def take(self, *, run_id: str, agent_id: str) -> list[InboxMessage]: ...

    def done(self, event_ids: list[str]) -> None: ...

    def cursor(self) -> dict[str, Any]: ...

    def resume(self, cursor: object) -> None: ...


class Broker(Protocol):
    """The connector's broker, which alone writes to the repository host (connectors/broker.py: it checks the caller's
    role, the run, the dial, the CI attestation, the board's GO and the write rules before the host). Each write is the
    one its role may make: ``push`` the committer's, ``open_draft_pr`` the PR author's, ``comment`` the PR
    reviewer's; the answer is the broker's ``result``."""

    def submit(self, run_id: str, agent_id: str, task_id: str, patch_key: str, summary: str) -> str:
        """Hand the agent's work (a patch under its own keys) to the broker, which alone writes to the host."""
        ...

    def push(self, run_id: str, agent_id: str, *, branch: str, patch_key: str, tree_hash: str,
             message: str) -> dict[str, Any]:
        """The broker's ``push_bundle``: the agent's own patch as one commit on one of the run's branches."""
        ...

    def open_draft_pr(self, run_id: str, agent_id: str, *, branch: str, title: str, body: str) -> dict[str, Any]:
        """The broker's ``open_or_update_draft_pr``: the run's draft pull request from ``branch``."""
        ...

    def comment(self, run_id: str, agent_id: str, *, number: int, body: str) -> dict[str, Any]:
        """The broker's ``post_comment`` on the run's own pull request ``number``."""
        ...


class Store(Protocol):
    def put(self, key: str, body: bytes) -> None:
        """Put one object under the agent's own keys (its role may write nowhere else)."""
        ...


class HarnessPortNotWired(RuntimeError):
    """A port the harness is not wired to yet: it refuses rather than guess."""


class PendingHarnessPorts:
    """The ports a harness has no wiring for: the board and the inbox without a board URL, and the broker, the
    planner and the knowledge reader until they are wired. Every call refuses."""

    @staticmethod
    def _refuse(name: str) -> HarnessPortNotWired:
        return HarnessPortNotWired(f'{name} is not wired yet (no board URL for the board and the inbox; the broker, '
                                   'the planner and the knowledge reader are not wired yet)')

    def brief(self, *, run_id: str, task_id: str) -> TaskBrief:
        raise self._refuse(f'board.brief({run_id}, {task_id})')

    def heartbeat(self, *, run_id: str, task_id: str, agent_id: str) -> None:
        raise self._refuse(f'board.heartbeat({run_id}, {task_id}, {agent_id})')

    def move(self, run_id: str, task_id: str, *, to_state: str, result_keys: tuple[str, ...] = ()) -> None:
        raise self._refuse(f'board.move({run_id}, {task_id}, {to_state}, {len(result_keys)} results)')

    def done(self, event_ids: list[str]) -> None:
        if event_ids:
            raise self._refuse(f'inbox.done({len(event_ids)})')

    def cursor(self) -> dict[str, Any]:
        return {}

    def resume(self, cursor: object) -> None:
        raise self._refuse(f'inbox.resume({str(cursor)[:40]})')

    def progress(self, run_id: str, task_id: str, agent_id: str, step: str) -> None:
        raise self._refuse(f'board.progress({run_id}, {task_id}, {agent_id}): {step[:40]}')

    def tasks(self, *, run_id: str) -> list[TaskSummary]:
        raise self._refuse(f'board.tasks({run_id})')

    def post(self, *, run_id: str, role: str, title: str, instructions: str, paths: tuple[str, ...],
             step: str = '', shard: str = '', patch: str = '') -> str:
        raise self._refuse(f'board.post({run_id}, {role}, {len(paths)} paths, {len(instructions)} characters, step '
                           f'{step[:40]} {shard[:40]}, {"a" if patch else "no"} patch): {title[:40]}')

    def flow(self, *, run_id: str) -> dict[str, Any] | None:
        raise self._refuse(f'board.flow({run_id})')

    def record_step(self, *, run_id: str, step: str, action: str, shards: tuple[str, ...] = ()) -> dict[str, Any]:
        raise self._refuse(f'board.step({run_id}, {step[:40]}, {action[:20]}, {len(shards)} shards)')

    def launch(self, *, run_id: str, task_id: str, role: str, language: str, paths: tuple[str, ...]) -> str:
        raise self._refuse(f'launch({run_id}, {task_id}, {role}, {language}, {len(paths)} paths)')

    def read(self, *, run_id: str, task_id: str, package: str) -> list[str]:
        raise self._refuse(f'knowledge.read({run_id}, {task_id}): {package[:40]}')

    def take(self, *, run_id: str, agent_id: str) -> list[InboxMessage]:
        raise self._refuse(f'inbox.take({run_id}, {agent_id})')

    def submit(self, run_id: str, agent_id: str, task_id: str, patch_key: str, summary: str) -> str:
        raise self._refuse(f'broker.submit({run_id}, {agent_id}, {task_id}, {patch_key}): {summary[:40]}')

    def push(self, run_id: str, agent_id: str, *, branch: str, patch_key: str, tree_hash: str,
             message: str) -> dict[str, Any]:
        raise self._refuse(f'broker.push({run_id}, {agent_id}, {branch[:80]}, {patch_key}, {tree_hash}): '
                           f'{message[:40]}')

    def open_draft_pr(self, run_id: str, agent_id: str, *, branch: str, title: str, body: str) -> dict[str, Any]:
        raise self._refuse(f'broker.open_draft_pr({run_id}, {agent_id}, {branch[:80]}, {len(body)} characters): '
                           f'{title[:40]}')

    def comment(self, run_id: str, agent_id: str, *, number: int, body: str) -> dict[str, Any]:
        raise self._refuse(f'broker.comment({run_id}, {agent_id}, #{number}): {body[:40]}')
