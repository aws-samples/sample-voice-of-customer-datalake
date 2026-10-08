"""Which CSV column feeds which feedback field (``POST /scrapers/manual/csv-upload``).

An upload may send ``column_map: {<csv header>: <target>}``; every header it
does not map is auto-detected by its name (``text``/``review``/``comment``/...,
the legacy ``source``/``source_channel`` header reads as the channel), and any
header still unclaimed goes to the item's ``metadata`` — nothing is silently
dropped. Targets::

    text | id | rating | date | author | title | url | channel | tags
    | metadata | ignore | dimension:<key>

A target that is explicitly mapped switches its auto-detection off, so a header
that merely looks like it (a second ``comment`` column when ``Body`` is mapped
to text) lands in metadata instead of competing for the field.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Final

from shared.dimension_config import DIMENSION_KEY_RE

__all__ = [
    'AUTO_COLUMNS',
    'MAX_METADATA_KEYS',
    'MAX_METADATA_KEY_CHARS',
    'MAX_METADATA_VALUE_CHARS',
    'SINGLE_TARGETS',
    'ColumnPlan',
    'bounded_metadata',
    'plan_columns',
]

# Targets one row has at most one value for, with the header names that
# auto-map to each (lower-cased, in lookup priority order).
AUTO_COLUMNS: Final[dict[str, tuple[str, ...]]] = {
    'text': ('text', 'review', 'comment', 'feedback'),
    'id': ('id', 'review_id'),
    'rating': ('rating', 'stars', 'score'),
    'date': ('date', 'timestamp', 'created_at'),
    'author': ('author', 'user', 'user_id', 'name'),
    'title': ('title', 'subject'),
    'url': ('url', 'link'),
    'channel': ('channel', 'source', 'source_channel'),
    'tags': ('tags', 'tag', 'labels'),
}
SINGLE_TARGETS: Final = frozenset(AUTO_COLUMNS)
_MULTI_TARGETS: Final = frozenset({'metadata', 'ignore'})
_DIMENSION_PREFIX: Final = 'dimension:'
_MAX_COLUMN_MAP_ENTRIES: Final = 200
_MAX_HEADER_CHARS: Final = 256

MAX_METADATA_KEYS: Final = 30
MAX_METADATA_KEY_CHARS: Final = 64
MAX_METADATA_VALUE_CHARS: Final = 1000


@dataclass(frozen=True)
class ColumnPlan:
    """Actual CSV headers per target; ``single`` lists headers in priority order."""

    single: dict[str, list[str]] = field(default_factory=dict)
    dimensions: dict[str, str] = field(default_factory=dict)
    metadata: list[str] = field(default_factory=list)


def _target(raw: object, header: str) -> str:
    if not isinstance(raw, str):
        raise ValueError(f'column_map target for "{header}" must be a string')
    target = raw.strip()
    if target in SINGLE_TARGETS or target in _MULTI_TARGETS:
        return target
    if target.startswith(_DIMENSION_PREFIX) and DIMENSION_KEY_RE.match(target[len(_DIMENSION_PREFIX):]):
        return target
    raise ValueError(
        f'column_map target "{target[:40]}" for "{header}" is not one of '
        f'{", ".join(sorted(SINGLE_TARGETS | _MULTI_TARGETS))} or dimension:<key>')


def _explicit(column_map: object, headers: list[str]) -> tuple[dict[str, str], list[str]]:
    """``{actual header: target}`` for the mapped headers present, and warnings for absent ones."""
    if column_map is None:
        return {}, []
    if not isinstance(column_map, Mapping):
        raise ValueError('column_map must be an object of {header: target}')
    if len(column_map) > _MAX_COLUMN_MAP_ENTRIES:
        raise ValueError(f'column_map accepts at most {_MAX_COLUMN_MAP_ENTRIES} entries')
    by_folded = {header.strip().casefold(): header for header in headers}
    mapped: dict[str, str] = {}
    warnings: list[str] = []
    for raw_header, raw_target in column_map.items():
        if not isinstance(raw_header, str) or len(raw_header) > _MAX_HEADER_CHARS:
            raise ValueError('column_map keys must be CSV header names')
        target = _target(raw_target, raw_header)
        actual = by_folded.get(raw_header.strip().casefold())
        if actual is None:
            warnings.append(f'column_map: no "{raw_header[:64]}" column in the CSV — ignored')
            continue
        mapped[actual] = target
    _refuse_repeats(mapped)
    return mapped, warnings


def _refuse_repeats(mapped: Mapping[str, str]) -> None:
    targets = [target for target in mapped.values() if target not in _MULTI_TARGETS and target != 'tags']
    repeated = sorted({target for target in targets if targets.count(target) > 1})
    if repeated:
        raise ValueError(f'column_map maps more than one column to {", ".join(repeated)}')


def plan_columns(headers: list[str], column_map: object = None) -> tuple[ColumnPlan, list[str]]:
    """The column plan for a CSV with ``headers``, plus warnings. ValueError on a bad map."""
    present = [header for header in headers if header]
    mapped, warnings = _explicit(column_map, present)
    plan = ColumnPlan()
    for header, target in mapped.items():
        if target.startswith(_DIMENSION_PREFIX):
            plan.dimensions[target[len(_DIMENSION_PREFIX):]] = header
        elif target == 'metadata':
            plan.metadata.append(header)
        elif target != 'ignore':
            plan.single.setdefault(target, []).append(header)
    unclaimed = {header.strip().lower(): header for header in present if header not in mapped}
    for target, aliases in AUTO_COLUMNS.items():
        if target in plan.single:
            continue
        found = [unclaimed.pop(alias) for alias in aliases if alias in unclaimed]
        if found:
            plan.single[target] = found
    plan.metadata.extend(unclaimed.values())
    return plan, warnings


def bounded_metadata(values: Mapping[str, object]) -> tuple[dict[str, str], list[str]]:
    """Non-blank ``values`` within the metadata bounds, and one warning per dropped entry."""
    out: dict[str, str] = {}
    dropped: list[str] = []
    for key, value in values.items():
        text = value.strip() if isinstance(value, str) else ''
        if not text:
            continue
        name = key.strip()[:MAX_METADATA_KEY_CHARS]
        if not name or len(text) > MAX_METADATA_VALUE_CHARS or len(out) >= MAX_METADATA_KEYS:
            dropped.append(key)
            continue
        out[name] = text
    return out, dropped
