"""What the conductor writes when a run needs a human, and how it picks the run up again.

A ``needs_human`` finish carries a payload (``shared.agent_run_decisions``) naming
the step that stopped the run and why. After an admin decides ``accept`` or
``another_round`` (``shared.agent_run_resume``) the run is queued with
``resume = {decision, note}`` and a new execution starts; the conductor's ``init``
then continues FROM THE GATE named in the payload instead of from ``start``:

- ``accept``         the gate's passing outcome, no round counted;
- ``another_round``  the loop's counter is set to ``max_rounds - 1`` and the run
  takes the failing outcome without counting it, so exactly one more round runs
  and the next failure stops it again.

A human's note waits in ``context.human_note`` for the next revision step's brief.
"""
from __future__ import annotations

from typing import Any, Final

from agents.fields import list_field
from agents.graph import Loop, Node
from shared import agent_run_decisions as decisions

HUMAN_NOTE_KEY: Final = 'human_note'
_PASSING: Final = {'persona_review': 'agreed'}
_FAILING: Final = {'persona_review': 'not_agreed'}


def passing_outcome(node: Node) -> str:
    return _PASSING.get(node.type, 'pass')


def failing_outcome(node: Node) -> str:
    return _FAILING.get(node.type, 'fail')


def payload(reason: str, node: Node, *, loop: Loop | None = None, context: dict | None = None) -> dict[str, Any]:
    """The ``needs_human`` payload for a stop at ``node`` (verdicts only for the gate reasons)."""
    return decisions.needs_human_payload(
        reason, node.id, node.title,
        loop_index=loop.index if loop is not None else None,
        max_rounds=loop.max_rounds if loop is not None else None,
        verdicts=list_field(context or {}, 'last_verdicts'),
    )


def bare_payload(reason: str, node_id: str) -> dict[str, Any]:
    """A payload when only the node id is known (a budget stop outside any node)."""
    return decisions.needs_human_payload(reason, node_id, node_id)


def with_human_note(brief: str, context: dict) -> str:
    """The revision brief with the waiting human note appended (if any)."""
    note = context.get(HUMAN_NOTE_KEY)
    if not isinstance(note, str) or not note.strip():
        return brief
    line = f'Note from a human: {note.strip()}'
    return f'{brief}\n\n{line}' if brief else line
