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

import json
import secrets
from dataclasses import dataclass, field
from typing import Any, Final, Literal, Protocol

from engineering.runtime.checkpoints import assert_storable, is_valid
from engineering.runtime.harness.ports import PAUSE, SAVE, Inbox, InboxMessage, Store
from engineering.runtime.harness.tools import AgentContext, ToolBox, snapshot
from engineering.runtime.harness.workspace import OutsideCheckout

DONE_EXIT_CODE: Final = 0
#: The same code the supervisor reads as "paused after a checkpoint" (liveness.PAUSED_EXIT_CODE; a test pins it).
PAUSED_EXIT_CODE: Final = 75
#: How far the notes are cut, in turn, when a checkpoint would be too big for the supervisor.
_NOTE_CUTS: Final = (4000, 500, 0)

Ending = Literal['done', 'paused']

#: The brief's instructions a checkpoint keeps at most (a task's spec is at most 8 KB on the board).
MAX_BRIEF: Final = 16 * 1024

@dataclass
class AgentSession:
    """One agent's session on one task, in one MicroVM."""

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
    #: The messages last handed out and not yet known to have reached the model (``shown``).
    handed: list[InboxMessage] = field(default_factory=list)
    #: The ids of messages the model has had since it last saved its notes: done once it saves them (a
    #: continuation starts from those notes, so until then they are read again).
    seen_since_save: list[str] = field(default_factory=list)

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
        self.handed = others
        saves = [message.event_id for message in taken if message.kind == SAVE]
        pauses = [message.event_id for message in taken if message.kind == PAUSE]
        self.inbox.done(pauses)  # acted on: the caller pauses; a continuation is not to pause again
        if saves:
            self.inbox.done(saves)
            self.checkpoint(turn=-1)
        return others, bool(pauses)

    def checkpoint(self, *, turn: int) -> str:
        """Save a new checkpoint object under the agent's own keys (its working tree too); its key."""
        context = self.context
        seq = self.restored_seq + self.saves + 1
        position: dict[str, Any] = {'task_id': context.task_id, 'turn': turn, 'step': context.status.step[:500],
                                    'inbox': self.inbox.cursor(),
                                    # The brief, so a continuation needs no claim of a task it holds already.
                                    'brief': {'title': context.brief.title[:500],
                                              'instructions': context.brief.instructions[:MAX_BRIEF]}}
        if context.runs_code:
            try:
                # None: the working tree is clean (every change undone), and so is the continuation's.
                self.patch = snapshot(context, f'checkpoint-{seq:06d}')
            except (OutsideCheckout, OSError) as refused:
                # The notes and plan are saved with the last working tree saved; the continuation is told so.
                position['patch_refused'] = str(refused)[:300]
                context.status.at(f'checkpoint with an older working tree: {str(refused)[:150]}')
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
