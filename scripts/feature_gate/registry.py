"""The registry: docs/feature-tests/<slice>.json, one file per slice of the roadmap, and the schema of an item.

An item: {id, aliases[], title, source{changelog, doc}, kind, status, unit[], e2e[], exemption}, plus optional
``uncertain`` (why its kind is a guess). Test entries are checked by cli.py; this module checks the item's own shape.
docs/feature-tests/README.md is the schema's prose.
"""
from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

REGISTRY_DIR = 'docs/feature-tests'
KINDS = ('feature', 'plumbing', 'fix', 'no-behaviour')
KIND_RANK = {'feature': 3, 'fix': 2, 'plumbing': 1, 'no-behaviour': 0}
STATUSES = ('done', 'planned')
LAYERS = ('unit', 'e2e', 'regression', 'all')
EXEMPTION_KINDS = ('no-user-flow', 'no-behaviour', 'platform-only', 'live-only')
CLOSING_EXEMPTIONS = ('no-user-flow', 'no-behaviour')    # a reviewed one closes its layer
ELSEWHERE = ('platform-only', 'live-only')                   # checked elsewhere: listed, closes nothing
EXEMPTION_KEYS = ('layer', 'kind', 'reason', 'proposed_by', 'reviewed_by', 'reviewed_at')
ITEM_KEYS = ('id', 'aliases', 'title', 'source', 'kind', 'status', 'unit', 'e2e', 'exemption')
OPTIONAL_KEYS = ('uncertain',)
VERSION_RE = re.compile(r'(\d+)\.(\d{2,})\.(\d{2,})')
ID_RE = re.compile(r'(\d+\.\d{2,}\.\d{2,}|[a-z][a-z0-9.-]*)(/[a-z0-9][a-z0-9-]*)?')
SHA_RE = re.compile(r'[0-9a-f]{7,40}')
TREE_RE = re.compile(r'[0-9a-f]{40}')
SESSION_RE = re.compile(r'[A-Za-z0-9._:-]+(/[A-Za-z0-9._:-]+)*')


def is_session(value: object) -> bool:
    return isinstance(value, str) and SESSION_RE.fullmatch(value) is not None


def is_sha(value: object) -> bool:
    return isinstance(value, str) and SHA_RE.fullmatch(value) is not None


@dataclass(frozen=True)
class Slice:
    name: str
    lo: str               # the first version it holds
    until: str | None     # the first version it does not hold (None: every later one)

    @property
    def file(self) -> str:
        return f'{REGISTRY_DIR}/{self.name}.json'


SLICES = (
    Slice('phase1-2', '6.05.00', '7.15.00'),
    Slice('phase3a-4', '7.15.00', '7.50.00'),
    Slice('product-7.5x-7.7x', '7.50.00', '7.76.00'),
    Slice('phase3-switch', '7.76.00', None),
)
FLOOR = SLICES[0].lo
GATE = '7.105.00'   # the release that brings the gate: every later one lands proven (feature floor, no allowed gap)


def parse_version(version: str) -> tuple[int, int, int]:
    m = VERSION_RE.fullmatch(version)
    if not m:
        raise ValueError(f'{version!r} is not a release number (MAJOR.MM.PP)')
    return int(m.group(1)), int(m.group(2)), int(m.group(3))


def semver(version: str) -> str:
    return '.'.join(str(n) for n in parse_version(version))


def canonical(version: str) -> str:
    """A release number in the CHANGELOG's two-digit form (``07.105.000`` -> ``7.105.00``)."""
    major, minor, patch = parse_version(version)
    return f'{major}.{minor:02d}.{patch:02d}'


def is_release(version: str | None) -> bool:
    """A release number, in its one canonical two-digit form (``7.105.000`` and ``07.105.00`` are not)."""
    return version is not None and VERSION_RE.fullmatch(version) is not None and canonical(version) == version


def after_gate(version: str | None) -> bool:
    return is_release(version) and parse_version(str(version)) > parse_version(GATE)


def item_version(item_id: str) -> str | None:
    """The release an item id names (``7.50.00`` or ``7.50.00/<slice>``), None for a plan-only id."""
    head = item_id.split('/', 1)[0]
    return head if is_release(head) else None


def slice_for(version: str) -> Slice:
    v = parse_version(version)
    for sl in SLICES:
        if parse_version(sl.lo) <= v and (sl.until is None or v < parse_version(sl.until)):
            return sl
    raise ValueError(f'{version} is older than the gate floor {FLOOR}')


def slice_by_file(path: str) -> Slice:
    for sl in SLICES:
        if sl.file == path.removeprefix('./'):
            return sl
    raise ValueError(f'{path} is not a registry slice file ({", ".join(sl.file for sl in SLICES)})')


@dataclass
class Registry:
    items: list[dict[str, Any]] = field(default_factory=list)
    slice_of: dict[str, Slice] = field(default_factory=dict)
    by_id: dict[str, dict[str, Any]] = field(default_factory=dict)
    problems: list[str] = field(default_factory=list)

    def in_slice(self, sl: Slice) -> list[dict[str, Any]]:
        return [it for it in self.items if self.slice_of.get(str(it.get('id'))) == sl]

    def add(self, sl: Slice, text: str) -> None:
        """Reads one slice file's text (a malformed one is a problem, never a traceback)."""
        try:
            data = json.loads(text)
        except (ValueError, RecursionError) as err:
            self.problems.append(f'{sl.file}: not JSON ({err})')
            return
        items = data.get('items', []) if isinstance(data, dict) else None
        if not isinstance(items, list) or not all(isinstance(it, dict) for it in items):
            self.problems.append(f'{sl.file}: "items" must be a list of objects')
            return
        if data.get('slice') != sl.name:
            self.problems.append(f'{sl.file}: "slice" must be {sl.name!r}')
        for it in items:
            item_id = str(it.get('id'))
            if item_id in self.by_id:
                self.problems.append(f'{item_id}: registered twice')
                continue
            self.items.append(it)
            self.by_id[item_id] = it
            self.slice_of[item_id] = sl


def load(root: Path) -> Registry:
    reg = Registry()
    for sl in SLICES:
        path = root / sl.file
        if not path.exists():
            reg.problems.append(f'{sl.file}: missing')
            continue
        reg.add(sl, path.read_text(encoding='utf-8'))
    return reg


def from_texts(texts: dict[str, str | None]) -> Registry:
    """A registry from the slice files' texts (another branch's, through git); an absent file holds no item."""
    reg = Registry()
    for sl in SLICES:
        text = texts.get(sl.file)
        if text is not None:
            reg.add(sl, text)
    return reg


def _sort_key(it: dict[str, Any]) -> tuple[int, tuple[int, int, int], str]:
    version = item_version(str(it.get('id')))
    return (0, parse_version(version), str(it['id'])) if version else (1, (0, 0, 0), str(it.get('id')))


def link_on_path(path: Path, root: Path) -> Path | None:
    """The file, or a folder between the root and it, that is a link (lstat), else None."""
    return next((part for part in [path, *[p for p in path.parents if p != root and p.is_relative_to(root)]]
                 if part.is_symlink()), None)


def write_file(path: Path, text: str, root: Path) -> None:
    """Writes a file of the gate's own, never through a link: neither the file nor any folder between the root and it
    may be one (a planted one would redirect the write)."""
    if (link := link_on_path(path, root)) is not None:
        raise ValueError(f'{link} is a link: the gate never writes through one')
    path.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW | os.O_CLOEXEC, 0o644)
    with os.fdopen(fd, 'w', encoding='utf-8') as fh:
        fh.write(text)


def save_slice(root: Path, sl: Slice, items: list[dict[str, Any]]) -> None:
    data = {'slice': sl.name, 'from': sl.lo, 'until': sl.until, 'items': sorted(items, key=_sort_key)}
    write_file(root / sl.file, json.dumps(data, indent=2, ensure_ascii=False) + '\n', root)


def save(root: Path, reg: Registry) -> None:
    for sl in SLICES:
        save_slice(root, sl, reg.in_slice(sl))


def _str_list(value: Any) -> bool:
    return isinstance(value, list) and all(isinstance(v, str) for v in value)


def _field_problems(item: dict[str, Any]) -> list[str]:
    out = []
    if not isinstance(item['id'], str) or not ID_RE.fullmatch(item['id']):
        out.append('id must be a release (7.50.00), a plan id (lowercase), or either with /<slice>')
    elif (head := item['id'].split('/', 1)[0]) and VERSION_RE.fullmatch(head) and not is_release(head):
        out.append(f'id {head} is not a release number in canonical form ({canonical(head)})')
    if not _str_list(item['aliases']):
        out.append('aliases must be a list of strings')
    if not isinstance(item['title'], str) or not item['title'].strip():
        out.append('title must be a non-empty string')
    source = item['source']
    if not isinstance(source, dict) or set(source) != {'changelog', 'doc'}:
        out.append('source must be {changelog, doc}')
    if item['kind'] not in KINDS:
        out.append(f'kind must be one of {", ".join(KINDS)}')
    if item['status'] not in STATUSES:
        out.append(f'status must be one of {", ".join(STATUSES)}')
    out += [f'{layer} must be a list of test entries' for layer in ('unit', 'e2e')
            if not isinstance(item[layer], list) or not all(isinstance(e, dict) for e in item[layer])]
    return out


def _shape_problems(item: dict[str, Any]) -> list[str]:
    out = [f'missing key {key!r}' for key in ITEM_KEYS if key not in item]
    out += [f'unknown key {key!r}' for key in item if key not in ITEM_KEYS + OPTIONAL_KEYS]
    return out or _field_problems(item)


def _review_problems(ex: dict[str, Any]) -> list[str]:
    by, at = ex['reviewed_by'], ex['reviewed_at']
    if by is None and at is None:
        return []   # proposed, not reviewed yet
    out = []
    if not is_session(by):
        out.append('exemption reviewed_by must be a session id (or null with reviewed_at, before its review)')
    if not is_sha(at):
        out.append('exemption reviewed_at must be a commit sha (or null with reviewed_by, before its review)')
    return out


def exemption_problems(ex: Any, item_kind: Any) -> list[str]:
    if ex is None:
        return []
    if not isinstance(ex, dict):
        return ['exemption must be an object or null']
    if set(ex) != set(EXEMPTION_KEYS):
        return [f'exemption must have exactly {", ".join(EXEMPTION_KEYS)}']
    out = []
    if ex['layer'] not in LAYERS:
        out.append(f'exemption layer must be one of {", ".join(LAYERS)}')
    if ex['kind'] not in EXEMPTION_KINDS:
        out.append(f'exemption kind must be one of {", ".join(EXEMPTION_KINDS)}')
    if ex['kind'] == 'no-user-flow' and ex['layer'] != 'e2e':
        out.append('exemption no-user-flow speaks of the e2e layer only')
    if ex['kind'] == 'no-behaviour' and item_kind not in ('no-behaviour', 'plumbing'):
        out.append('exemption no-behaviour fits only a no-behaviour or plumbing item')
    if not isinstance(ex['reason'], str) or not ex['reason'].strip():
        out.append('exemption needs a reason')
    if not is_session(ex['proposed_by']):
        out.append('exemption proposed_by must be a session id')
    return out + _review_problems(ex)


def item_problems(item: dict[str, Any]) -> list[str]:
    """The item's own shape (its tests are checked by the CLI's check)."""
    out = _shape_problems(item)
    if not out:
        out = exemption_problems(item['exemption'], item['kind'])
    return out


def session_root(session: str) -> str:
    """The session a sub-agent belongs to: ``h2/sub-3`` and ``h2`` share the root ``h2``."""
    return session.split('/', 1)[0]
