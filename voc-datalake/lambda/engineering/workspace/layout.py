"""The workspace's key layout (plan v3, 4.7, with the agent right after the run so one IAM prefix scopes its writes).

::

    ws/<ws>/runs/<run>/<agent>/commits/<sha>/<package>/attempt-<n>/<shard>.jsonl   findings (voc-finding/1 lines)
    ws/<ws>/runs/<run>/<agent>/commits/<sha>/_<kind>/attempt-<n>/<name>             gate outputs, logs, patches, checkpoints
    ws/<ws>/reports/<run>/<level>/<subject>/v<nnnn>.json (+ .md)                    commit, PR and goal reports

Objects are immutable: one per shard, agent and attempt, so a new attempt is a new object and map steps never
collide; a reduce reads the keys the board recorded on its tasks, never a listing. The writer (the runtime) encodes a
package path into one segment: every UTF-8 byte outside ``[A-Za-z0-9_-]`` as ``=XX`` (upper-case hex), and a
leading ``_`` too, which only the artifact kinds begin with (``crates/core`` -> ``crates=2Fcore``, the root package
``.`` -> ``=2E``), so every key stays in the plain character set the board and the bus carry.
"""
from __future__ import annotations

import re
from dataclasses import dataclass

# A run or agent id, and a workspace: the bus's shapes (callers check a run id with this module's ID too).
from engineering.bus.schema import ID
from engineering.bus.schema import WS as _WS

#: The kinds of non-finding artifact an agent writes under a commit.
ARTIFACTS = frozenset({'gate', 'logs', 'patches', 'checkpoints'})
REPORT_LEVELS = frozenset({'commit', 'pr', 'goal'})
#: A commit, by its full hash (SHA-1 or SHA-256): the workspace is content-addressed by commit, never abbreviated.
SHA = re.compile(r'(?:[0-9a-f]{40}|[0-9a-f]{64})\Z')
_NAME = re.compile(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,127}\Z')
#: A package segment: plain characters and ``=XX`` escapes, not beginning with ``_`` (escaped as ``=5F``).
_ENCODED = re.compile(r'(?:[A-Za-z0-9-]|=[0-9A-F]{2})(?:[A-Za-z0-9_-]|=[0-9A-F]{2}){0,599}\Z')
_ATTEMPT = re.compile(r'attempt-([1-9][0-9]{0,3})\Z')


class LayoutError(ValueError):
    """A workspace key part that is not a valid id, sha, package or name."""


def _check(pattern: re.Pattern[str], value: str, what: str) -> str:
    if not pattern.fullmatch(value):
        raise LayoutError(f'not a valid {what}: {value[:80]!r}')
    return value


def _decode_package(segment: str) -> str | None:
    try:
        return re.sub(rb'=([0-9A-F]{2})', lambda m: bytes([int(m.group(1), 16)]), segment.encode()).decode()
    except UnicodeDecodeError:
        return None


def report_key(ws: str, run_id: str, level: str, subject: str, version: int, suffix: str = 'json') -> str:
    if level not in REPORT_LEVELS:
        raise LayoutError(f'a report is one of {sorted(REPORT_LEVELS)}')
    return (f'ws/{_check(_WS, ws, "workspace")}/reports/{_check(ID, run_id, "run id")}/{level}/'
            f'{_check(ID, subject, "report subject")}/v{version:04d}.{suffix}')


@dataclass(frozen=True)
class AgentKey:
    """An agent's own object, parsed: ``package`` is set for a finding shard, ``kind`` for another artifact."""

    ws: str
    run_id: str
    agent: str
    sha: str
    attempt: int
    name: str
    package: str = ''
    kind: str = ''


def parse_agent_key(key: str) -> AgentKey | None:
    """The parts of an agent's object key, or None for anything off the layout.

    ``ws / <ws> / runs / <run> / <agent> / commits / <sha> / <package or kind> / attempt-<n> / <name>``
    """
    parts = key.split('/')
    if len(parts) != 10 or (parts[0], parts[2], parts[5]) != ('ws', 'runs', 'commits'):
        return None
    ws, run_id, agent, sha, middle, attempt, name = parts[1], parts[3], parts[4], parts[6], parts[7], parts[8], parts[9]
    numbered = _ATTEMPT.fullmatch(attempt)
    plain = (_WS.fullmatch(ws), ID.fullmatch(run_id), ID.fullmatch(agent), SHA.fullmatch(sha), _NAME.fullmatch(name))
    if numbered is None or not all(plain):
        return None
    kind = middle[1:] if middle[1:] in ARTIFACTS and middle.startswith('_') else ''
    package = ''
    if not kind:
        decoded = _decode_package(middle) if name.endswith('.jsonl') and _ENCODED.fullmatch(middle) else None
        if not decoded:
            return None
        package = decoded
    return AgentKey(ws, run_id, agent, sha, int(numbered.group(1)), name, package=package, kind=kind)
