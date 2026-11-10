"""The methodology block in an agent run's journal (TENETS.md tenet 2; docs/autonomous-agents.md).

A node that starts a methodology step (research, PR/FAQ, PRD, prototype) carries the
block its route answered (``shared/methodology.py``: skipped upstream steps, warnings)
on its pending result; the finished job's final block (with the evidence count) rides
on its done result. The conductor journals both, so a run's detail shows what each
step skipped, exactly like the project's Documents tab does for the document:

* at the start, one ``message`` event with a plain line and the block;
* at the end, the block on the step's ``node_finished`` event.
"""
from __future__ import annotations

from agents import store
from agents.graph import Node
from shared import methodology


def record_start(agent_id: str, run_id: str, node: Node, result: dict) -> None:
    """Journal the block a step's route answered at its start; nothing when there is none.

    Only a start answer carries it (a poll's pending result does not), so a waiting step adds nothing.
    """
    block = methodology.compact(result.get('methodology'))
    if block is not None:
        store.append_event(agent_id, run_id, 'message', methodology.journal_line(block), node_id=node.id,
                           role=node.role, methodology_block=block)


def finished_kwargs(result: dict) -> dict:
    """``methodology_block`` for the step's ``node_finished`` event when its result carries a block, else none."""
    block = methodology.compact(result.get('methodology'))
    return {} if block is None else {'methodology_block': block}
