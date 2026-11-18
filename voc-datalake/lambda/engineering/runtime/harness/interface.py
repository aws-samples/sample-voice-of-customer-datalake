"""The harness interface: one agent session, run by an adapter to its end (done, or paused after a checkpoint).

``AgentSession`` is what every adapter gets: the tools (``tools.ToolBox``), the agent's inbox, and the
checkpoint it writes and restores from. An ``Adapter`` runs the session and says how it ended; ``main``
turns that into the runtime's exit code (``DONE_EXIT_CODE`` or ``PAUSED_EXIT_CODE``, the supervisor's
``liveness.ended``); anything raised is a crash, and the supervisor continues it from the last checkpoint.

A checkpoint is what a continuation needs: the position, the agent's notes and plan, and, for an agent that
runs code, its working tree as a patch under its own keys (``patch``), which the continuation applies to its
fresh checkout before it starts (``main``). When a snapshot is refused (a file with two links, a patch over
the limit), the checkpoint keeps the last working tree saved and says why (``position.patch_refused``), which
the continuation is told. It is written only when the supervisor would accept it (``checkpoints.is_valid``):
too big, the notes and plan are cut until it fits.
"""
from __future__ import annotations

import contextlib
import json
import secrets
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any, Final, Literal, Protocol

from engineering.runtime.checkpoints import assert_storable, is_valid
from engineering.runtime.harness.board_client import BoardRefused
from engineering.runtime.harness.ports import PAUSE, SAVE, HarnessPortNotWired, Inbox, InboxMessage, Store
from engineering.runtime.harness.tools import DIRECTION, AgentContext, ToolBox, snapshot
from engineering.runtime.harness.waiting import PAUSED_WITH_NEWS, TOOL, News
from engineering.runtime.harness.workspace import OutsideCheckout

DONE_EXIT_CODE: Final = 0
#: The same code the supervisor reads as "paused after a checkpoint" (liveness.PAUSED_EXIT_CODE; a test pins it).
PAUSED_EXIT_CODE: Final = 75
#: How far the notes are cut, in turn, when a checkpoint would be too big for the supervisor.
_NOTE_CUTS: Final = (4000, 500, 0)

Ending = Literal['done', 'paused']

#: The brief's instructions a checkpoint keeps at most (a task's spec is at most 8 KB on the board).
MAX_BRIEF: Final = 16 * 1024
#: The submitted patch's key a checkpoint keeps at most (a longer one is no submitted patch's).
MAX_PATCH_KEY: Final = 512

@dataclass
class AgentSession:
    """One agent's session on one task, in one session."""

    context: AgentContext
    tools: ToolBox
    inbox: Inbox
    store: Store
    #: The checkpoint this session restores from (``VOC_RESTORE_KEY``), already read, if any.
    restored: dict[str, Any] | None = None
    #: The sequence number of the restored checkpoint (the next one is greater, so the newest sorts last).
    restored_seq: int = 0
    notes: str = ''
    plan: list[str] = field(default_factory=list)
    #: Checkpoints this session saved (the next one's sequence number follows them).
    saves: int = 0
    #: The last working tree saved (or restored): a checkpoint whose own snapshot is refused keeps this one.
    patch: str | None = None
    #: Why the restored checkpoint's working tree is not the newest (told to the model when it starts).
    patch_refused: str | None = None
    #: The task's finish ran in another process (the CLI's tool server): the session ended done by it.
    finished_elsewhere: bool = False
    #: The messages last handed out and not yet known to have reached the model (``shown``).
    handed: list[InboxMessage] = field(default_factory=list)
    #: The ids of messages the model has had since it last saved its notes: done once it saves them (a
    #: continuation starts from those notes, so until then they are read again).
    seen_since_save: list[str] = field(default_factory=list)
    #: The child run's seed this session started from (7.51.00, ``harness/seed.py``: checked), if any; why its working
    #: tree did not apply cleanly (git's words: told to the model as data, never a crash); why it was not taken.
    seed: dict[str, Any] | None = None
    seed_conflict: str = ''
    seed_refused: str = ''
    #: What an adapter adds to each checkpoint's position (7.53.00: the Kiro adapter's ``kiro`` entry, its ACP session id
    #: and the key of that session's saved state), given the checkpoint's sequence number; None for nothing.
    checkpoint_extra: Callable[[int], dict[str, Any]] | None = None

    def seed_parts(self) -> list[str]:
        """What the opening says of the seed: the earlier run's notes, plan and history as data, its steering in the
        steering block, and how its working tree went on (empty without one)."""
        context, seeded = self.context, self.seed
        if seeded is None:
            refused = (f'This task was to start from an earlier run\'s work, which could not be read '
                       f'({self.seed_refused}): start it afresh.')
            return [refused] if self.seed_refused else []
        parent = seeded['parent']
        parts = ['', (f'A person resumed an earlier run ({parent["run_id"]}): you take this task over from its '
                      f'{parent["agent_id"] or "agent"} (attempt {parent["attempt"]}). What it left:')]
        checkpoint = seeded.get('checkpoint')
        if checkpoint is not None:
            parts.append(context.data('seed:notes', f'{checkpoint["notes"]}\nplan: {checkpoint["plan"]}'))
        history = seeded['history']
        parts.append(context.data(f'seed:history:{history["kind"]}', '\n'.join(history['lines'])
                                  if history['kind'] == 'excerpts' else history['text']))
        if seeded.get('patch_key') and context.runs_code:
            parts.append('Its working tree is in your checkout: check it before you go on.' if not self.seed_conflict
                         else ('Its working tree did not apply cleanly on this run\'s commit: the files git could '
                               'merge are in your checkout, those with conflicts carry conflict markers, and what git '
                               'said is below. Resolve them before you go on.'))
            if self.seed_conflict:
                parts.append(context.data('seed:conflict', self.seed_conflict))
        parts.extend(context.steering(f'earlier:{given["by"]}', given['text'], given['by'])
                     for given in seeded.get('steering', []))
        return parts

    def shown(self) -> None:
        """The messages last handed out reached the model."""
        self.saw([message.event_id for message in self.handed])
        self.handed = []

    def saw(self, event_ids: list[str]) -> None:
        """These messages reached the model (the CLI: its tool server took them)."""
        self.seen_since_save.extend(event_ids)

    def take_messages(self, *, shows: bool = True) -> tuple[list[InboxMessage], bool]:
        """The inbox's other messages, and whether a pause was asked. A save or a pause is done once acted on; the
        others once the model saved its notes after having them (``remember``): they reach it at the next take
        (``shows``), or when the adapter says (``saw``)."""
        if shows:
            self.shown()
        taken = self.inbox.take(run_id=self.context.run_id, agent_id=self.context.agent_id)
        others = [message for message in taken if message.kind not in (SAVE, PAUSE)]
        moved = self.read_direction(self.inbox.direction())
        if moved is not None:
            others.append(moved)
        self.handed = others
        saves = [message.event_id for message in taken if message.kind == SAVE]
        pauses = [message.event_id for message in taken if message.kind == PAUSE]
        self.inbox.done(pauses)  # acted on: the caller pauses; a continuation is not to pause again
        if saves:
            self.inbox.done(saves)
            self.checkpoint(turn=-1)
        return others, bool(pauses)

    def news(self) -> News:
        """One look at the inbox for ``wait_for_agents`` (7.54.00: the Converse loop's waiter): ``take_messages``, so
        the messages it hands out reach the model with the wait's result, and a save or a pause is acted on as at a
        turn's start."""
        messages, pause = self.take_messages()
        return News(messages=tuple(messages), pause=pause)

    def paused_with(self, others: list[InboxMessage]) -> None:
        """A pause the CLI's or the Kiro adapter's harness acts on (7.54.00), which may end its tool server's
        ``wait_for_agents`` (the harness is the inbox's one reader there): with news beside it, the wait is closed, as
        the Converse loop's own wait closes it, so a long wait's hold continues the coordinator at once to read the news
        (it stays unread for the continuation). Never raising: the pause is the outcome."""
        if others and any(spec.name == TOOL for spec in self.tools.specs):
            with contextlib.suppress(Exception):
                self.context.progress(PAUSED_WITH_NEWS, waiting=False)

    def read_direction(self, named: int | None = None) -> InboxMessage | None:
        """The run's direction read again (7.51.00) when ``named`` (an inbox page's version) is newer than the one the
        session holds, or always when ``named`` is None (a session's start): the new one as a note for the model
        (``DIRECTION``), None when it did not move (or is the coordinator's own). Advisory: a board that refuses or
        cannot be reached is said on the status, and the next page tries again."""
        context = self.context
        if named is not None and named <= context.direction_version:
            return None
        try:
            found = context.board.direction(run_id=context.run_id)
        except (BoardRefused, HarnessPortNotWired) as refused:
            context.status.at(f'the run\'s direction was not read ({str(refused)[:120]})')
            return None
        if found.version <= context.direction_version:
            return None
        context.direction_version, context.direction = found.version, found.text
        if context.role == 'coordinator' or not found.text:
            return None
        return InboxMessage(kind=DIRECTION, summary=found.text, sender=f'v{found.version}')

    def checkpoint(self, *, turn: int, clean: bool = False) -> str:
        """Save a new checkpoint object under the agent's own keys (its working tree too, unless ``clean``: a fresh
        checkout, nothing changed yet); its key."""
        context = self.context
        seq = self.restored_seq + self.saves + 1
        position: dict[str, Any] = {'task_id': context.task_id, 'turn': turn, 'step': context.status.step[:500],
                                    'inbox': self.inbox.cursor(),
                                    # The outputs written so far, recorded on the task when a continuation finishes.
                                    'results': list(context.result_keys),
                                    # The checks it ran, as the harness recorded them (a gate record's checks),
                                    # and whether the gate's own run made them (run_gate: its packs).
                                    'checks': list(context.checks),
                                    'gate': {'ran': context.gate_ran, 'packs': list(context.gate_packs),
                                             'tool_versions': dict(context.gate_tool_versions),
                                             'stop': context.gate_stop},
                                    # The brief, so a continuation needs no claim of a task it holds already.
                                    'brief': {'title': context.brief.title[:500],
                                              'instructions': context.brief.instructions[:MAX_BRIEF],
                                              'patch': context.brief.patch[:MAX_PATCH_KEY]}}
        if context.runs_code and not clean:
            try:
                # None: the working tree is clean (every change undone), and so is the continuation's.
                # (a gate's working tree is a patch on the tree it judges, which its continuation rebuilds first)
                self.patch = snapshot(context, f'checkpoint-{seq:06d}', context.gate_tree)
            except (OutsideCheckout, OSError) as refused:
                # The notes and plan are saved with the last working tree saved; the continuation is told so.
                position['patch_refused'] = str(refused)[:300]
                context.status.at(f'checkpoint with an older working tree: {str(refused)[:150]}')
        if self.checkpoint_extra is not None:
            # (never the position's own fields: an adapter only adds its entry beside them)
            position.update({name: value for name, value in self.checkpoint_extra(seq).items() if name not in position})
        for cut in (None, *_NOTE_CUTS):
            notes = self.notes if cut is None else self.notes[:cut]
            plan = self.plan if cut is None else self.plan[:5]
            state = {'position': position, 'notes': notes, 'plan': plan, 'patch': self.patch}
            assert_storable(state)
            body = json.dumps(state).encode()
            if is_valid(body):
                break
        else:  # pragma: no cover - a position alone always fits
            raise ValueError('the checkpoint does not fit even without notes')
        key = f'{context.checkpoints_prefix}{seq:06d}-{secrets.token_hex(4)}.json'
        self.store.put(key, body)
        self.saves += 1
        if context.transcript is not None:
            # (flushed at each checkpoint: what a continuation starts from is in the transcript too)
            context.transcript.record('checkpoint', key=key, turn=turn)
            context.transcript.flush()
        return key

    def remember(self, checkpoint: dict[str, Any]) -> None:
        """What the agent asked a continuation to know (``save_checkpoint``): the messages it had before are in its
        notes now, so they are done."""
        self.inbox.done(self.seen_since_save)
        self.seen_since_save = []
        self.notes = str(checkpoint.get('notes', ''))
        plan = checkpoint.get('plan', [])
        self.plan = [str(item) for item in plan] if isinstance(plan, list) else []


class Adapter(Protocol):
    def run(self, session: AgentSession) -> Ending:
        """Run the session until the task is done or it pauses (after saving its checkpoint)."""
        ...
