"""The walls each language's sessions run behind, as their runner reports them, and the deployment's last record of
them (7.50.03; docs/autonomous-engineering.md → Runtime).

A session's runner says which walls hold in its ``start`` answer and on every ``status`` (``unit_runner.Runner.walls``:
the agent's egress wall and repository code's, ``iptables``, ``namespaces`` or ``none``, the hard-link guards, and
since 7.53.00 the image's kiro-cli version, which readiness's ``kiro`` check reads).
The runtime keeps the last start's word per language in voc-engineering, ``WS#<ws>#SANDBOX`` / ``LANG#<language>``
(``record``: overwritten by each later start, so it is what the runtime last saw, with when), and readiness reads it
(``read_record``; engineering/readiness.py ``sandbox``): with none recorded yet, the walls are unknown until the first
session of the language's image, never a pass. A session whose runner holds no egress wall refuses its ``start``
(fail closed), so no record names one without it: a launch refused that way is the launch's error, not a record.
"""
from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any, Final

from engineering.connectors.identity import WORKSPACE
from engineering.runtime.unit_runner import DECLARED_GUARD, EGRESS_WALLS, HARDLINK_GUARDS, KIRO_VERSION_RE

#: The partition of the deployment's sandbox records (one row per language).
RECORD_PK: Final = f'WS#{WORKSPACE}#SANDBOX'
NO_WALL: Final = 'none'
MAX_LANGUAGE: Final = 40


@dataclass(frozen=True)
class Walls:
    """A session's walls, as its runner said them."""

    egress: str
    code: str
    hardlink_guard: tuple[str, ...]
    #: The image's kiro-cli version (7.53.00, ``unit_runner.kiro_cli_version``), '' for an image without one.
    kiro_cli: str = ''

    @classmethod
    def parse(cls, raw: object) -> Walls | None:
        """A runner's ``sandbox`` answer, None when it is not one (an image from before 7.50.03 says nothing)."""
        if not isinstance(raw, Mapping):
            return None
        egress, code, guards = raw.get('egress'), raw.get('code'), raw.get('hardlink_guard')
        known = (*EGRESS_WALLS, NO_WALL)
        if egress not in known or code not in known or not isinstance(guards, list):
            return None
        if not all(guard in (*HARDLINK_GUARDS, DECLARED_GUARD) for guard in guards):
            return None
        kiro = raw.get('kiro_cli', '')
        return cls(str(egress), str(code), tuple(str(guard) for guard in guards),
                   kiro if isinstance(kiro, str) and KIRO_VERSION_RE.fullmatch(kiro) else '')

    @property
    def holds(self) -> bool:
        """Every wall a run needs holds: the agent's egress, repository code's, and a hard-link guard."""
        return self.egress in EGRESS_WALLS and self.code in EGRESS_WALLS and bool(self.hardlink_guard)

    def item(self) -> dict[str, Any]:
        return {'egress': {'S': self.egress}, 'code': {'S': self.code},
                'hardlink_guard': {'L': [{'S': guard} for guard in self.hardlink_guard]}, 'kiro_cli': {'S': self.kiro_cli}}


@dataclass(frozen=True)
class Recorded:
    """The last walls the runtime saw for a language: what they were, when (ISO 8601), on which runtime."""

    walls: Walls
    at: str
    runtime: str = ''


def record_key(language: str) -> dict[str, dict[str, str]]:
    if not language or len(language) > MAX_LANGUAGE or not language.isalnum():
        raise ValueError('a language is a short plain name')
    return {'pk': {'S': RECORD_PK}, 'sk': {'S': f'LANG#{language}'}}


def record(client: Any, table: str, language: str, walls: Walls, *, at: str, runtime: str = '') -> None:
    """Keep ``walls`` as the language's last (a plain put: the newest start's word stands)."""
    client.put_item(TableName=table, Item={**record_key(language), 'language': {'S': language}, **walls.item(),
                                           'at': {'S': at}, 'runtime': {'S': runtime[:2048]}})


def read_record(client: Any, table: str, language: str) -> Recorded | None:
    """The language's last record (a consistent GetItem), None when none was kept or it is off its shape."""
    item = client.get_item(TableName=table, Key=record_key(language), ConsistentRead=True).get('Item')
    if not isinstance(item, Mapping):
        return None
    guards = [entry.get('S') for entry in item.get('hardlink_guard', {}).get('L', []) if isinstance(entry, Mapping)]
    walls = Walls.parse({'egress': item.get('egress', {}).get('S'), 'code': item.get('code', {}).get('S'),
                         'hardlink_guard': guards, 'kiro_cli': item.get('kiro_cli', {}).get('S', '')})
    at = item.get('at', {}).get('S')
    if walls is None or not isinstance(at, str):
        return None
    return Recorded(walls, at, str(item.get('runtime', {}).get('S', '')))
