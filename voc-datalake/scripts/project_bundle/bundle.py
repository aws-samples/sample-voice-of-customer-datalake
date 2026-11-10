"""The bundle on disk: one directory, versioned.

    <bundle>/
      manifest.json    format, version, source deployment, one summary per project
      items.jsonl      one line per DynamoDB row: {"project_id", "table", "item"}
      objects.jsonl    one line per S3 object: {"project_id", "key", "content_type", "cache_control", "metadata"}
      objects/<key>    each object's bytes at its source key path

`table` is `projects` or `aggregates` (the prototype pin forms and pins). Items are encoded by
`codec.encode`. A reader refuses another `format` or a newer `version`, and an object path
that would leave the bundle directory (a hand-edited `..` key).
"""
from __future__ import annotations

import json
from collections.abc import Iterator
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

from project_bundle.codec import decode, encode

FORMAT = 'voc-project-bundle'
VERSION = 1
TABLES = ('projects', 'aggregates')


class BundleError(Exception):
    """The directory is not a bundle this script can read."""


@dataclass
class ObjectRecord:
    project_id: str
    key: str
    content_type: str | None = None
    cache_control: str | None = None
    metadata: dict[str, str] = field(default_factory=dict)


@dataclass
class ProjectBundle:
    """Everything one project carries, as read back from a bundle."""

    summary: dict[str, Any]
    rows: list[tuple[str, dict[str, Any]]] = field(default_factory=list)  # (table, item)
    objects: list[ObjectRecord] = field(default_factory=list)

    @property
    def project_id(self) -> str:
        return str(self.summary['project_id'])


def object_path(root: Path, key: str) -> Path:
    path = (root / 'objects' / key).resolve()
    if not path.is_relative_to((root / 'objects').resolve()):
        raise BundleError(f'object key {key!r} leaves the bundle directory')
    return path


class BundleWriter:
    def __init__(self, root: Path) -> None:
        self.root = root
        root.mkdir(parents=True, exist_ok=True)
        if (root / 'manifest.json').exists():
            raise BundleError(f'{root} already holds a bundle; choose an empty --out directory')
        self._items = (root / 'items.jsonl').open('w', encoding='utf-8')
        self._objects = (root / 'objects.jsonl').open('w', encoding='utf-8')

    def add_row(self, project_id: str, table: str, item: dict[str, Any]) -> None:
        line = {'project_id': project_id, 'table': table, 'item': encode(item)}
        self._items.write(json.dumps(line, ensure_ascii=False, sort_keys=True) + '\n')

    def add_object(self, record: ObjectRecord, body: bytes) -> None:
        path = object_path(self.root, record.key)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(body)
        self._objects.write(json.dumps(asdict(record), ensure_ascii=False, sort_keys=True) + '\n')

    def close(self, manifest: dict[str, Any]) -> None:
        self._items.close()
        self._objects.close()
        document = {'format': FORMAT, 'version': VERSION, **manifest}
        (self.root / 'manifest.json').write_text(json.dumps(document, indent=2, ensure_ascii=False) + '\n',
                                                 encoding='utf-8')


def _lines(path: Path) -> Iterator[dict[str, Any]]:
    with path.open(encoding='utf-8') as handle:
        for number, line in enumerate(handle, start=1):
            if not line.strip():
                continue
            value = json.loads(line)
            if not isinstance(value, dict):
                raise BundleError(f'{path.name} line {number} is not an object')
            yield value


def _manifest(root: Path) -> dict[str, Any]:
    path = root / 'manifest.json'
    if not path.is_file():
        raise BundleError(f'no manifest.json in {root}; is this a project bundle?')
    manifest = json.loads(path.read_text(encoding='utf-8'))
    if not isinstance(manifest, dict) or manifest.get('format') != FORMAT:
        raise BundleError(f'{path} is not a {FORMAT}')
    version = manifest.get('version')
    if not isinstance(version, int) or version > VERSION:
        raise BundleError(f'bundle version {version!r} is newer than this script reads ({VERSION})')
    return manifest


def _add_row(by_id: dict[str, ProjectBundle], line: dict[str, Any]) -> None:
    project = by_id.get(str(line.get('project_id')))
    table, item = line.get('table'), line.get('item')
    if project is None or table not in TABLES or not isinstance(item, dict):
        raise BundleError(f'items.jsonl holds a row this bundle does not describe: {line.get("project_id")!r}')
    project.rows.append((str(table), decode(item)))


def _add_object(root: Path, by_id: dict[str, ProjectBundle], line: dict[str, Any]) -> None:
    project = by_id.get(str(line.get('project_id')))
    key, metadata = line.get('key'), line.get('metadata') or {}
    if project is None or not isinstance(key, str) or not isinstance(metadata, dict):
        raise BundleError(f'objects.jsonl holds an object this bundle does not describe: {key!r}')
    object_path(root, key)  # refuses a key outside the bundle before anything is read
    project.objects.append(ObjectRecord(
        project_id=project.project_id, key=key, content_type=line.get('content_type'),
        cache_control=line.get('cache_control'), metadata={str(k): str(v) for k, v in metadata.items()},
    ))


def read(root: Path) -> tuple[dict[str, Any], list[ProjectBundle]]:
    """The manifest and every project of the bundle at `root`, validated."""
    manifest = _manifest(root)
    summaries = manifest.get('projects')
    if not isinstance(summaries, list) or not all(isinstance(s, dict) and s.get('project_id') for s in summaries):
        raise BundleError('manifest.json lists no projects')
    by_id = {str(s['project_id']): ProjectBundle(summary=s) for s in summaries}
    for line in _lines(root / 'items.jsonl'):
        _add_row(by_id, line)
    for line in _lines(root / 'objects.jsonl'):
        _add_object(root, by_id, line)
    return manifest, list(by_id.values())
