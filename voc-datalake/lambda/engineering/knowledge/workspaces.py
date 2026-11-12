"""A repository's packages, from its file listing and a few manifests: the unit of the knowledge pack.

The caller lists the repository's paths (the broker's reads), asks ``manifest_paths`` which files to read, reads
them, and hands both to ``detect``. Detection is deterministic and bounded, and reads nothing itself:

- **A package** is a directory with a manifest that names one: a Cargo crate (``[package]``), an npm package
  (``package.json`` with a ``name``), a Go module (``go.mod``), a Python package (``pyproject.toml``'s
  ``[project]`` or ``[tool.poetry]`` name, ``setup.cfg``'s ``[metadata]`` name, or a ``setup.py``), a Gradle or
  Maven module (``build.gradle[.kts]``, ``pom.xml``).
- **Workspaces add their members** (never remove one): Cargo's ``[workspace] members``, npm and yarn's
  ``workspaces``, ``pnpm-workspace.yaml``'s ``packages``, uv's ``[tool.uv.workspace] members``, Gradle's
  ``include`` in ``settings.gradle[.kts]``, Maven's ``<modules>``, ``go.work``'s ``use``. A member records the
  directory of the workspace that declared it.
- **Bazel is the fallback**: only when nothing above found a package, each top-most ``BUILD`` / ``BUILD.bazel``
  directory of a repository with a ``MODULE.bazel`` or ``WORKSPACE`` is one.
- **The root package** ``.`` always exists: it holds every file no package holds.
- **Owners** come from ``CODEOWNERS`` (``.github/``, the root, ``docs/``, ``.gitlab/``: the first found): the last
  rule whose pattern matches the package's directory gives its owners (GitHub's rule: the last match wins), handles
  only (``@user``, ``@org/team``); an e-mail address is personal data and is never kept.

A listing with a path that is absolute, has an empty, ``.`` or ``..`` part, a backslash or a control character is
refused whole (``ListingError``): a path the host would never list is a sign the listing is not the host's.
"""
from __future__ import annotations

import bisect
import configparser
import itertools
import json
import re
import tomllib
from collections.abc import Iterable, Iterator, Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any

ROOT = '.'
MAX_PATHS = 200_000
MAX_MANIFESTS = 2_000
MAX_MANIFEST_BYTES = 256 * 1024
MAX_PACKAGES = 2_000
MAX_OWNERS = 10
MAX_MEMBER_PATTERNS = 200
#: The order a package's kinds are listed in, and the first one names it.
KINDS = ('cargo', 'npm', 'go', 'python', 'gradle', 'maven', 'bazel')
#: Directories whose manifests are never a package of the repository's own (vendored or built).
IGNORED_DIRS = frozenset({'node_modules', '.git', 'vendor', 'target', 'dist', 'build', '.venv', '__pycache__'})
CODEOWNERS_PATHS = ('.github/CODEOWNERS', 'CODEOWNERS', 'docs/CODEOWNERS', '.gitlab/CODEOWNERS')
_STANDALONE = {
    'Cargo.toml': 'cargo', 'package.json': 'npm', 'go.mod': 'go', 'pyproject.toml': 'python', 'setup.cfg': 'python',
    'setup.py': 'python', 'build.gradle': 'gradle', 'build.gradle.kts': 'gradle', 'pom.xml': 'maven',
}
_DECLARING = frozenset({'pnpm-workspace.yaml', 'settings.gradle', 'settings.gradle.kts', 'go.work'})
_BAZEL_ROOTS = frozenset({'MODULE.bazel', 'WORKSPACE', 'WORKSPACE.bazel'})
_BAZEL_BUILD = frozenset({'BUILD', 'BUILD.bazel'})
MANIFEST_NAMES = frozenset(_STANDALONE) | _DECLARING | _BAZEL_ROOTS | _BAZEL_BUILD
_NAME = re.compile(r'[A-Za-z0-9@][A-Za-z0-9@/._:+-]{0,213}\Z')
_HANDLE = re.compile(r'@[A-Za-z0-9][A-Za-z0-9-]{0,38}(?:/[A-Za-z0-9][A-Za-z0-9._-]{0,99})?\Z')
_CONTROL = re.compile(r'[\x00-\x1f\x7f-\x9f\\]')   # C0 and C1 controls, a backslash
_GRADLE_INCLUDE = re.compile(r'^\s*include\b(.*)$', re.MULTILINE)
_QUOTED = re.compile(r'["\']:?([A-Za-z0-9_.:-]{1,200})["\']')
_MAVEN_MODULE = re.compile(r'<module>\s*([^<\s]{1,300})\s*</module>')
_GO_MODULE = re.compile(r'^module\s+(\S{1,300})', re.MULTILINE)


class ListingError(ValueError):
    """A listing the host would not have produced (a path outside the repository's own shape)."""


@dataclass(frozen=True)
class Package:
    #: The package's directory (``.`` for the root), the unit of the pack, the review and the gate.
    path: str
    name: str
    kinds: tuple[str, ...]
    #: The directory of the workspace that declared it a member, ``''`` when none did.
    workspace: str = ''
    owners: tuple[str, ...] = ()


@dataclass(frozen=True)
class Layout:
    packages: tuple[Package, ...]
    #: Every listed path, by the package that holds it (the deepest package directory above it).
    files: Mapping[str, tuple[str, ...]]
    #: What was cut or could not be read, counted: manifests past ``MAX_MANIFESTS``, manifests that could not be
    #: read as their kind (malformed, over ``MAX_MANIFEST_BYTES``, not given), workspaces with member patterns past
    #: ``MAX_MEMBER_PATTERNS`` (one each), and packages past ``MAX_PACKAGES``.
    skipped: int = 0


@dataclass
class _Found:
    kinds: set[str] = field(default_factory=set)
    names: dict[str, str] = field(default_factory=dict)
    workspace: str = ''


def check_paths(paths: Iterable[str]) -> list[str]:
    """The listing's paths, sorted and unique; ``ListingError`` for any path off the repository's shape."""
    seen: set[str] = set()
    for path in paths:
        parts = path.split('/')
        if (not path or path.startswith('/') or _CONTROL.search(path) or len(path) > 4096
                or any(part in {'', '.', '..'} for part in parts)):
            raise ListingError(f'not a repository path: {path[:80]!r}')
        seen.add(path)
        if len(seen) > MAX_PATHS:
            raise ListingError(f'more than {MAX_PATHS} paths: map the repository by its top-level directories')
    return sorted(seen)


def _parent(path: str) -> str:
    return path.rsplit('/', 1)[0] if '/' in path else ROOT


def _base(path: str) -> str:
    return path.rsplit('/', 1)[-1]


def _ignored(path: str) -> bool:
    return any(part in IGNORED_DIRS for part in path.split('/')[:-1])


def manifest_paths(paths: Iterable[str]) -> list[str]:
    """The files ``detect`` reads (manifests and CODEOWNERS), sorted, at most ``MAX_MANIFESTS``: shallow ones first,
    so a cut drops the deepest."""
    return sorted(_wanted(check_paths(paths))[:MAX_MANIFESTS])


def _wanted(listed: Sequence[str]) -> list[str]:
    """Every manifest and CODEOWNERS of the listing, shallow ones first."""
    wanted = [p for p in listed if (_base(p) in MANIFEST_NAMES and not _ignored(p)) or p in CODEOWNERS_PATHS]
    return sorted(wanted, key=lambda p: (p.count('/'), p))


def _join(directory: str, relative: str) -> str | None:
    """``relative`` (a member as a workspace spells it) under ``directory``; None when it leaves it."""
    parts = [part for part in relative.strip().strip('/').split('/') if part not in {'', '.'}]
    if not parts or '..' in parts:
        return None
    return '/'.join(parts) if directory == ROOT else '/'.join([directory, *parts])


def _glob(pattern: str) -> re.Pattern[str]:
    wildcards = {'**': '.*', '*': '[^/]*', '?': '[^/]'}
    body = ''.join(wildcards.get(part) or re.escape(part) for part in re.findall(r'\*\*|\*|\?|[^*?]+', pattern))
    return re.compile(body + r'\Z')


def _starting(dirs: Sequence[str], prefix: str) -> Iterator[str]:
    """The sorted ``dirs`` that start with ``prefix``: a pattern's literal head narrows its scan."""
    for index in range(bisect.bisect_left(dirs, prefix), len(dirs)):
        if not dirs[index].startswith(prefix):
            return
        yield dirs[index]


def _members(directory: str, patterns: Iterable[Any], dirs: Sequence[str]) -> list[str]:
    """The listed directories ``patterns`` (globs relative to ``directory``; ``!`` excludes; the first
    ``MAX_MEMBER_PATTERNS``) name."""
    included: set[str] = set()
    excluded: set[str] = set()
    for pattern in itertools.islice(patterns, MAX_MEMBER_PATTERNS):
        if not isinstance(pattern, str):
            continue
        joined = _join(directory, pattern.removeprefix('!'))
        if joined is None:
            continue
        regex = _glob(joined)
        matched = {d for d in _starting(dirs, re.split(r'[*?]', joined, maxsplit=1)[0]) if regex.match(d)}
        (excluded if pattern.startswith('!') else included).update(matched)
    return sorted(included - excluded)


def _toml(text: str) -> dict[str, Any] | None:
    try:
        return tomllib.loads(text)
    except tomllib.TOMLDecodeError:
        return None


def _table(data: Mapping[str, Any], *keys: str) -> dict[str, Any]:
    value: Any = data
    for key in keys:
        value = value.get(key) if isinstance(value, dict) else None
    return value if isinstance(value, dict) else {}


def _list(value: Any) -> list[Any]:
    return value if isinstance(value, list) else []


def _cargo(text: str) -> tuple[str | None, list[Any]]:
    data = _toml(text)
    if data is None:
        raise ValueError('not TOML')
    name = _table(data, 'package').get('name')
    return (name if isinstance(name, str) else None), _list(_table(data, 'workspace').get('members'))


def _npm(text: str) -> tuple[str | None, list[Any]]:
    data = json.loads(text)
    if not isinstance(data, dict):
        raise ValueError('not an object')
    workspaces = data.get('workspaces')
    members = _list(workspaces.get('packages') if isinstance(workspaces, dict) else workspaces)
    name = data.get('name')
    return (name if isinstance(name, str) else None), members


def _pyproject(text: str) -> tuple[str | None, list[Any]]:
    data = _toml(text)
    if data is None:
        raise ValueError('not TOML')
    name = _table(data, 'project').get('name') or _table(data, 'tool', 'poetry').get('name')
    return (name if isinstance(name, str) else None), _list(_table(data, 'tool', 'uv', 'workspace').get('members'))


def _setup_cfg(text: str) -> tuple[str | None, list[Any]]:
    parser = configparser.ConfigParser(interpolation=None)
    parser.read_string(text)
    name = parser.get('metadata', 'name', fallback=None)
    return name, []


def _pnpm(text: str) -> list[str]:
    """``packages:``'s list items: the one YAML shape pnpm documents (no YAML library needed)."""
    members: list[str] = []
    inside = False
    for line in text.splitlines():
        if not line.strip() or line.lstrip().startswith('#'):
            continue
        if not line[0].isspace() and not line.startswith('-'):
            inside = line.split(':', 1)[0].strip() == 'packages'
        elif inside and line.strip().startswith('-'):
            members.append(line.strip()[1:].split('#', 1)[0].strip().strip('\'"'))
    return members


def _go_work(text: str) -> list[str]:
    block = re.search(r'^use\s*\((.*?)\)', text, re.MULTILINE | re.DOTALL)
    lines = block.group(1).splitlines() if block else re.findall(r'^use\s+(\S+)', text, re.MULTILINE)
    return [line.split('//', 1)[0].strip() for line in lines if line.split('//', 1)[0].strip()]


def _gradle(text: str) -> list[str]:
    return [match.replace(':', '/') for line in _GRADLE_INCLUDE.findall(text) for match in _QUOTED.findall(line)]


_READERS = {'Cargo.toml': _cargo, 'package.json': _npm, 'pyproject.toml': _pyproject, 'setup.cfg': _setup_cfg}


def _read(path: str, manifests: Mapping[str, str]) -> str | None:
    text = manifests.get(path)
    return text if text is not None and len(text.encode()) <= MAX_MANIFEST_BYTES else None


class _Detector:
    def __init__(self, paths: Sequence[str], manifests: Mapping[str, str]) -> None:
        self.paths = paths
        self.manifests = manifests
        every = {'/'.join(p.split('/')[:depth]) for p in paths for depth in range(1, p.count('/') + 1)}
        self.dirs = sorted(d for d in every if not _ignored(f'{d}/'))
        self.manifest_dirs = {(_base(p), _parent(p)) for p in paths}
        self.found: dict[str, _Found] = {}
        self.skipped = 0

    def add(self, directory: str, kind: str, name: str | None = None, workspace: str = '') -> None:
        entry = self.found.setdefault(directory, _Found())
        entry.kinds.add(kind)
        if name and _NAME.match(name):
            entry.names.setdefault(kind, name)
        if workspace and not entry.workspace and workspace != directory:
            entry.workspace = workspace

    def declare(self, directory: str, kind: str, patterns: Sequence[Any], needs: str | None) -> None:
        if len(patterns) > MAX_MEMBER_PATTERNS:   # the rest are not read: counted, never silent
            self.skipped += 1
        for member in _members(directory, patterns, self.dirs):
            if needs is None or (needs, member) in self.manifest_dirs:
                self.add(member, kind, workspace=directory)

    def standalone(self, path: str) -> None:
        base, directory = _base(path), _parent(path)
        kind = _STANDALONE[base]
        reader = _READERS.get(base)
        text = _read(path, self.manifests)
        if reader is None:
            module = _GO_MODULE.search(text or '') if base == 'go.mod' else None
            self.add(directory, kind, module.group(1) if module else None)
            if base == 'pom.xml' and text is not None:
                self.declare(directory, kind, _MAVEN_MODULE.findall(text), 'pom.xml')
            return
        if text is None:
            self.skipped += 1
            return
        try:
            name, members = reader(text)
        except (ValueError, RecursionError, configparser.Error):   # a JSON or TOML nested past the parser's depth
            self.skipped += 1
            return
        if name is not None or base == 'package.json':
            self.add(directory, kind, name)
        self.declare(directory, kind, members, base)

    def declaring(self, path: str) -> None:
        base, directory = _base(path), _parent(path)
        text = _read(path, self.manifests)
        if text is None:
            self.skipped += 1
            return
        if base == 'pnpm-workspace.yaml':
            self.declare(directory, 'npm', _pnpm(text), 'package.json')
        elif base == 'go.work':
            self.declare(directory, 'go', _go_work(text), 'go.mod')
        else:
            self.declare(directory, 'gradle', _gradle(text), None)

    def bazel(self) -> None:
        if self.found.keys() - {ROOT} or not any((name, ROOT) in self.manifest_dirs for name in _BAZEL_ROOTS):
            return
        builds = sorted({_parent(p) for p in self.paths if _base(p) in _BAZEL_BUILD and not _ignored(p)} - {ROOT})
        for directory in builds:
            if not any(directory.startswith(f'{top}/') for top in builds):
                self.add(directory, 'bazel')


def _owner_rules(text: str) -> list[tuple[re.Pattern[str], tuple[str, ...]]]:
    rules: list[tuple[re.Pattern[str], tuple[str, ...]]] = []
    for line in text.splitlines():
        fields = line.split('#', 1)[0].split()
        if not fields or fields[0].startswith('!') or '[' in fields[0]:
            continue
        pattern = fields[0]
        anchored = pattern.startswith('/') or '/' in pattern.strip('/')
        body = _glob(pattern.strip('/')).pattern.removesuffix(r'\Z')
        regex = re.compile(('' if anchored else '(?:.*/)?') + body + r'(?:/.*)?\Z')
        rules.append((regex, tuple(sorted({o for o in fields[1:] if _HANDLE.match(o)}))[:MAX_OWNERS]))
    return rules


def _owners(rules: Sequence[tuple[re.Pattern[str], tuple[str, ...]]], directory: str) -> tuple[str, ...]:
    target = '' if directory == ROOT else directory
    owners: tuple[str, ...] = ()
    for regex, handles in rules:
        if regex.match(target):
            owners = handles
    return owners


def _holder(path: str, package_dirs: frozenset[str]) -> str:
    directory = _parent(path)
    while directory != ROOT and directory not in package_dirs:
        directory = _parent(directory)
    return directory


def detect(paths: Iterable[str], manifests: Mapping[str, str]) -> Layout:
    """The repository's packages and which of them holds each path; ``manifests``: path -> text, as read."""
    listed = check_paths(paths)
    detector = _Detector(listed, manifests)
    detector.skipped += max(0, len(_wanted(listed)) - MAX_MANIFESTS)   # manifests past the cap, never read
    for path in manifest_paths(listed):
        base = _base(path)
        if base in _STANDALONE:
            detector.standalone(path)
        elif base in _DECLARING:
            detector.declaring(path)
    detector.bazel()
    owners_texts = (_read(path, manifests) for path in CODEOWNERS_PATHS)
    rules = _owner_rules(next((text for text in owners_texts if text is not None), ''))
    found = detector.found
    found.setdefault(ROOT, _Found())
    ordered = [ROOT, *sorted(found.keys() - {ROOT})]
    kept, skipped = ordered[:MAX_PACKAGES], detector.skipped + max(0, len(ordered) - MAX_PACKAGES)
    packages = []
    for directory in kept:
        entry = found[directory]
        kinds = tuple(kind for kind in KINDS if kind in entry.kinds)
        name = next((entry.names[kind] for kind in kinds if kind in entry.names), _base(directory))
        packages.append(Package(directory, name, kinds, entry.workspace, _owners(rules, directory)))
    package_dirs = frozenset(kept)
    files: dict[str, list[str]] = {directory: [] for directory in kept}
    for path in listed:
        files[_holder(path, package_dirs)].append(path)
    return Layout(tuple(packages), {k: tuple(v) for k, v in files.items()}, skipped)
