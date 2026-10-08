"""A finished agent run as a memory source (``agent_run``, docs/memory.md).

When a run completes or escalates to a human, the conductor hands its event
journal to the memory extractor (``voc-memory-extract`` queue). The extractor
treats the text as DATA, keeps only durable COMPANY knowledge (an agent never
writes anyone's personal memory) and applies the usual write rules, so what is
learned from a run is screened exactly like a chat session.

Best effort by design: memory is a by-product, so a failure here is logged and
the run's own outcome is never affected. Journal summaries are bounded and
already free of document content (agents/store caps every summary).
"""
from __future__ import annotations

import json
import os
from typing import Final

from agents import store
from shared.aws import get_sqs_client
from shared.logging import logger

QUEUE_ENV: Final = 'MEMORY_EXTRACT_QUEUE_URL'
KIND_AGENT_RUN: Final = 'agent_run'
# Statuses worth learning from: a cancelled or failed run says little that is durable.
MEMORABLE_STATUSES: Final = frozenset({store.RUN_COMPLETED, store.RUN_NEEDS_HUMAN})
# The extractor reads at most its last 40k characters; stay well inside that.
MAX_JOURNAL_CHARS: Final = 30_000
MAX_EVENTS: Final = 400


def journal_text(run_id: str, agent_name: str, status: str) -> str:
    """The run's journal as plain lines, oldest first, bounded."""
    lines = [f'Autonomous agent "{agent_name}" run {run_id} finished: {status}.']
    for event in store.list_events(run_id, MAX_EVENTS):
        summary = event.get('summary')
        if isinstance(summary, str) and summary.strip():
            lines.append(f"[{event.get('kind')}] {summary.strip()}")
    return '\n'.join(lines)[-MAX_JOURNAL_CHARS:]


def enqueue_finished_run(agent_id: str, run_id: str, status: str) -> bool:
    """Queue the run for memory extraction; True when a message was sent."""
    queue_url = os.environ.get(QUEUE_ENV, '')
    if status not in MEMORABLE_STATUSES or not queue_url or not agent_id:
        return False
    try:
        agent = store.get_agent(agent_id) or {}
        text = journal_text(run_id, str(agent.get('name') or agent_id), status)
        get_sqs_client().send_message(QueueUrl=queue_url, MessageBody=json.dumps({
            'kind': KIND_AGENT_RUN, 'ref': run_id, 'text': text, 'agent_id': agent_id,
        }))
    except Exception:  # noqa: BLE001 - memory must never fail the run
        logger.warning('Agent run not queued for memory', extra={'agent_id': agent_id, 'run_id': run_id})
        return False
    return True
