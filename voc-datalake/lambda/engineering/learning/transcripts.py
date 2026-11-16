"""What Learn reads of a failed attempt's transcript (7.50.00): its last events, as short excerpts.

The agent's session wrote them under its own keys (runtime/harness/transcript.py: ``.../commits/<sha>/_transcripts/
attempt-<n>/<chunk:04d>.jsonl``, redacted when written). The runtime's role lists and reads only those
(engineering-runtime.ts ``LearnReadsTranscripts``): the last ``MAX_CHUNKS`` chunks of the attempt, each read up to
``MAX_CHUNK_BYTES``, every event rendered on a few lines (a tool's call and its result, the model's words, a crash,
the end), bounded, redacted again, never with a NUL. The coach's prompt fences each excerpt as data
(coach/prompt.py): a transcript holds repository, issue and model text, never an instruction.
"""
from __future__ import annotations

import json
from collections.abc import Callable, Mapping, Sequence
from typing import Any, Final

from engineering.quality_gate.text import redact
from engineering.runtime.checkpoints import artifact_prefix

MAX_CHUNKS: Final = 3
MAX_CHUNK_BYTES: Final = 512 * 1024
MAX_LINE: Final = 1_500
MAX_EXCERPTS: Final = 40
_INPUT: Final = 300


def _clip(text: str, limit: int) -> str:
    flat = redact(text).replace('\x00', '')
    return flat if len(flat) <= limit else f'{flat[:limit - 1]}…'


def _content(blocks: object) -> str:
    """A message's text: its text blocks, and the tools it asked for by name."""
    parts: list[str] = []
    for block in blocks if isinstance(blocks, list) else ():
        if isinstance(block, Mapping) and isinstance(block.get('text'), str):
            parts.append(block['text'])
        elif isinstance(block, Mapping) and isinstance(block.get('toolUse'), Mapping):
            parts.append(f'[asks for {block["toolUse"].get("name", "?")}]')
    return ' '.join(parts)


def render(event: Mapping[str, Any]) -> str:
    """One event as a short line ('' for one the coach does not need: a checkpoint, a model call's numbers)."""
    kind = event.get('kind')
    if kind == 'tool_call':
        return _clip(f'call {event.get("tool")}: {json.dumps(event.get("input"), sort_keys=True)[:_INPUT]}', MAX_LINE)
    if kind == 'tool_result':
        how = 'refused' if event.get('error') else 'answered'
        return _clip(f'{event.get("tool")} {how}: {event.get("text", "")}', MAX_LINE)
    if kind == 'message' and event.get('role') == 'assistant':
        return _clip(f'the agent said: {_content(event.get("content"))}', MAX_LINE)
    if kind in ('crash', 'end'):
        fields = {name: value for name, value in event.items() if name not in ('schema', 'at')}
        return _clip(f'{kind}: {json.dumps(fields, sort_keys=True)}', MAX_LINE)
    return ''


def excerpts(list_keys: Callable[[str], Sequence[str]], read: Callable[[str, int], bytes | None], run_id: str,
             agent: str, commit: str, attempt: int) -> tuple[str, ...]:
    """The attempt's last events as lines, oldest first, at most ``MAX_EXCERPTS``; none when it wrote no transcript
    (or its commit is unknown)."""
    try:
        prefix = artifact_prefix(run_id, agent, commit, attempt, 'transcripts')
    except Exception:  # noqa: BLE001 - an attempt off the layout has no transcript to read
        return ()
    keys = sorted(key for key in list_keys(prefix) if key.endswith('.jsonl'))[-MAX_CHUNKS:]
    lines: list[str] = []
    for key in keys:
        body = read(key, MAX_CHUNK_BYTES) or b''
        for raw in body.decode('utf-8', 'replace').splitlines():
            try:
                event = json.loads(raw)
            except ValueError:
                continue
            line = render(event) if isinstance(event, dict) else ''
            if line.strip():
                lines.append(line)
    return tuple(lines[-MAX_EXCERPTS:])
