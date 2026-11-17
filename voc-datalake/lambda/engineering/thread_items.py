"""A thread item (7.51.00): one line of an agent's (or the orchestrator's) thread in the run workspace.

The run workspace's thread (``engineering/views_thread.py``, ``GET /agents/engineering/<run>/agents/<agent>/thread``)
merges, in time order, the agent's transcript events (runtime/harness/transcript.py) and the run's conversation
messages about it (conversation/store.py). Each becomes one item of this shape::

    {ref, at, kind, from: {kind, id}, text, cut, tool?: {name, ok, input, kind, status}, update}

- ``ref``: where the full event is, ``<attempt>.<chunk>.<line>`` for a transcript event, ``c<seq>`` for a conversation
  message (``GET …/thread/<ref>`` answers it whole).
- ``at``: its time (ISO 8601, UTC).
- ``kind``: one of ``KINDS``.
- ``from``: who: an ``agent`` (its words, its tools), a ``human`` (a person's steering, a signal), the ``conductor``
  (a relay), the ``supervisor``, the ``system`` (the board, the platform).
- ``text``: at most ``MAX_TEXT`` bytes of redacted text, cut on a character boundary (``cut`` true when it was). It is
  data from a repository, a model or a person: the web app renders it as Markdown without raw HTML.
- ``tool``: a tool call's name, whether it succeeded (``ok``: None while it has no result yet), a one-line input (at most
  ``MAX_TOOL_INPUT`` characters), its ACP kind (``transcript.TOOL_KINDS``) and its ACP status.
- ``update``: the ACP ``session/update`` kind the item is (``ACP_UPDATES``), so 7.53.00's ACP channel and the thread
  are one stream (an agent's words ``agent_message_chunk``, its reasoning ``agent_thought_chunk``, a tool call
  ``tool_call`` and its result ``tool_call_update``, a person's or a relayed message ``user_message_chunk``, and
  ``''`` for an item ACP has no update for: a gate result, a finding, a checkpoint, the session's end).
"""
from __future__ import annotations

from collections.abc import Mapping
from typing import Any, Final

from engineering.quality_gate.text import redact
from engineering.runtime.harness.transcript import TOOL_STATUSES, tool_kind

KINDS: Final = ('said', 'thought', 'tool', 'gate', 'finding', 'steer', 'signal', 'checkpoint', 'crash', 'end',
                'message')
FROM_KINDS: Final = frozenset({'agent', 'human', 'conductor', 'supervisor', 'coach', 'system'})
MAX_TEXT: Final = 4 * 1024
MAX_TOOL_INPUT: Final = 300
#: Each kind's ACP ``session/update`` kind ('' for none). A tool item is ``tool_call`` until its result, then
#: ``tool_call_update``.
ACP_UPDATES: Final = {'said': 'agent_message_chunk', 'thought': 'agent_thought_chunk', 'tool': 'tool_call',
                      'steer': 'user_message_chunk', 'message': 'user_message_chunk', 'signal': '', 'gate': '',
                      'finding': '', 'checkpoint': '', 'crash': '', 'end': ''}
ACP_TOOL_RESULT: Final = 'tool_call_update'


def bounded(text: str, limit: int = MAX_TEXT) -> tuple[str, bool]:
    """``text`` redacted and cut to ``limit`` UTF-8 bytes on a character boundary, and whether it was cut."""
    clean = redact(text).replace('\x00', '')
    raw = clean.encode('utf-8')
    if len(raw) <= limit:
        return clean, False
    return raw[:limit].decode('utf-8', 'ignore'), True


def one_line(value: object, limit: int = MAX_TOOL_INPUT) -> str:
    """A tool input as one redacted line of at most ``limit`` characters."""
    flat = ' '.join(redact(value if isinstance(value, str) else str(value)).split())
    return flat if len(flat) <= limit else f'{flat[:limit - 1]}…'


def thread_item(*, ref: str, at: str, kind: str, sender: Mapping[str, str], text: str = '',
                tool: Mapping[str, Any] | None = None) -> dict[str, Any]:
    """One thread item, its text bounded and its tool's input cut to one line (``ValueError`` for a kind or a sender
    off the shape). ``tool``: ``{name, ok?, input?, status?}``; its ACP kind is the tool's, its status ``completed``
    or ``failed`` once ``ok`` is known, else ``in_progress``."""
    if kind not in KINDS:
        raise ValueError(f'a thread item is one of {", ".join(KINDS)}')
    if sender.get('kind') not in FROM_KINDS or not isinstance(sender.get('id'), str):
        raise ValueError('a thread item is from {kind, id}')
    shown, cut = bounded(text)
    item: dict[str, Any] = {'ref': ref, 'at': at, 'kind': kind, 'from': {'kind': sender['kind'], 'id': sender['id']},
                            'text': shown, 'cut': cut, 'update': ACP_UPDATES[kind]}
    if tool is not None:
        ok = tool.get('ok')
        status = tool.get('status') or ('in_progress' if ok is None else 'completed' if ok else 'failed')
        if status not in TOOL_STATUSES:
            raise ValueError(f'a tool status is one of {", ".join(TOOL_STATUSES)}')
        name = str(tool.get('name', ''))[:64]
        item['tool'] = {'name': name, 'ok': ok if isinstance(ok, bool) else None,
                        'input': one_line(tool.get('input', '')), 'kind': tool_kind(name), 'status': status}
        item['update'] = 'tool_call' if ok is None else ACP_TOOL_RESULT
    return item


def is_thread_item(item: object) -> bool:
    """Whether ``item`` has the thread item's shape and bounds (the shared fixture's check)."""
    if not isinstance(item, Mapping) or not {'ref', 'at', 'kind', 'from', 'text', 'cut', 'update'} <= set(item):
        return False
    sender = item.get('from')
    shape = (isinstance(item['ref'], str) and isinstance(item['at'], str) and item['kind'] in KINDS
             and isinstance(sender, Mapping) and sender.get('kind') in FROM_KINDS and isinstance(sender.get('id'), str)
             and isinstance(item['text'], str) and len(item['text'].encode('utf-8')) <= MAX_TEXT
             and isinstance(item['cut'], bool) and item['update'] in (*ACP_UPDATES.values(), ACP_TOOL_RESULT))
    if not shape or 'tool' not in item:
        return shape
    tool = item['tool']
    return (isinstance(tool, Mapping) and isinstance(tool.get('name'), str) and tool.get('ok') in (True, False, None)
            and isinstance(tool.get('input'), str) and len(tool['input']) <= MAX_TOOL_INPUT
            and tool.get('status') in TOOL_STATUSES and isinstance(tool.get('kind'), str))
