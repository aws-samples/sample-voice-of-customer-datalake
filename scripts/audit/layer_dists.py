"""Installed-distribution metadata for py_layers (a library: no detector marker).

Resolution is OFFLINE and deterministic: a layer's ``requirements.txt`` is read against the ``*.dist-info``
directories of one site-packages (``voc-datalake/.venv``, which CI installs from the same files), never pip or
the network. ``Requires-Dist`` markers are evaluated for the Lambda runtime (:data:`LAMBDA_MARKERS`), not the
machine running the audit, so a macOS venv resolves the layer the arm64 Linux build installs.

:data:`RUNTIME_PROVIDED` is what ``public.ecr.aws/lambda/python:3.14`` ships in
``/var/lang/lib/python3.14/site-packages`` (measured 2026-10-24: ``importlib.metadata.distributions()`` in
the image, ``pip`` left out). ``test_py_layers.py`` re-checks the names and import names against the image
when Docker and the image are present (skipped otherwise). A layer that ships one of these shadows the
runtime's copy, because ``/opt/python`` precedes the runtime's site-packages on ``sys.path``.
"""
from __future__ import annotations

import re
from collections.abc import Iterable, Iterator
from dataclasses import dataclass
from importlib.metadata import Distribution, distributions
from pathlib import Path

from audit_common import AuditError
from packaging.markers import Marker
from packaging.requirements import InvalidRequirement
from packaging.requirements import Requirement as _PackagingRequirement
from packaging.specifiers import SpecifierSet
from packaging.utils import canonicalize_name
from packaging.version import InvalidVersion, Version

#: The marker environment of the Lambda Python 3.14 arm64 runtime the layers are built for.
LAMBDA_MARKERS: dict[str, str] = {
    'python_version': '3.14', 'python_full_version': '3.14.8', 'implementation_version': '3.14.8',
    'implementation_name': 'cpython', 'platform_python_implementation': 'CPython', 'os_name': 'posix',
    'sys_platform': 'linux', 'platform_system': 'Linux', 'platform_machine': 'aarch64',
    'platform_release': '', 'platform_version': '',
}


@dataclass(frozen=True)
class RuntimeDist:
    version: str
    imports: tuple[str, ...]


#: Distributions the Lambda Python 3.14 runtime provides (see the module docstring).
RUNTIME_PROVIDED: dict[str, RuntimeDist] = {
    'awslambdaric': RuntimeDist('4.2.2', ('awslambdaric',)),
    'boto3': RuntimeDist('1.42.97', ('boto3',)),
    'botocore': RuntimeDist('1.42.97', ('botocore',)),
    'jmespath': RuntimeDist('1.1.0', ('jmespath',)),
    'python-dateutil': RuntimeDist('2.9.0.post0', ('dateutil',)),
    's3transfer': RuntimeDist('0.16.0', ('s3transfer',)),
    'simplejson': RuntimeDist('4.2.0', ('simplejson',)),
    'six': RuntimeDist('1.17.0', ('six',)),
    'snapshot-restore-py': RuntimeDist('1.0.0', ('snapshot_restore_py',)),
    'urllib3': RuntimeDist('2.8.0', ('urllib3',)),
}


def runtime_imports() -> Iterator[str]:
    for dist in RUNTIME_PROVIDED.values():
        yield from dist.imports


@dataclass(frozen=True)
class Requirement:
    """One requirement line or ``Requires-Dist`` entry, its name canonical."""

    name: str
    specifier: SpecifierSet
    extras: frozenset[str]
    marker: Marker | None

    @property
    def spec(self) -> str:
        return str(self.specifier)

    @classmethod
    def parse(cls, text: str) -> Requirement:
        try:
            req = _PackagingRequirement(text)
        except InvalidRequirement as error:
            raise AuditError(f'unparseable requirement {text!r}: {error}') from error
        return cls(canonicalize_name(req.name), req.specifier, frozenset(req.extras), req.marker)

    def applies(self, extras: Iterable[str] = ()) -> bool:
        """True on the Lambda runtime with ``extras`` requested (an ``extra == 'x'`` marker needs ``x``)."""
        if self.marker is None:
            return True
        return any(self.marker.evaluate({**LAMBDA_MARKERS, 'extra': extra}) for extra in ('', *extras))

    def allows(self, version: str) -> bool:
        try:
            return self.specifier.contains(Version(version), prereleases=True)
        except InvalidVersion:
            return False


def read_requirements(path: Path) -> list[Requirement]:
    """A layer's requirements file: one requirement per line, ``#`` comments; no pip options."""
    found: list[Requirement] = []
    for raw in path.read_text(encoding='utf-8').splitlines():
        line = raw.split('#', 1)[0].strip()
        if not line:
            continue
        if line.startswith('-'):
            raise AuditError(f'{path}: pip option {line!r} is not supported by py_layers')
        found.append(Requirement.parse(line))
    return found


_SUFFIX = re.compile(r'\..*$')


@dataclass(frozen=True)
class InstalledDist:
    name: str
    version: str
    requires: tuple[Requirement, ...]
    top_entries: frozenset[str]     # the top-level files / directories it installs (``six.py``, ``dateutil``)
    imports: frozenset[str]          # the importable top-level names among them
    size: int                        # bytes, from RECORD
    sources: tuple[tuple[str, Path], ...] = ()   # (dotted module, file) of every installed .py file

    def requires_for(self, extras: Iterable[str]) -> list[Requirement]:
        chosen = tuple(extras)
        return [req for req in self.requires if req.applies(chosen)]


def _from_distribution(dist: Distribution) -> InstalledDist:
    tops: set[str] = set()
    sources: list[tuple[str, Path]] = []
    size = 0
    for file in dist.files or []:
        parts = file.parts
        size += file.size or 0
        if file.suffix == '.py' and parts[0] != '..' and all(p.isidentifier() for p in parts[:-1]):
            dotted = '.'.join([*parts[:-1], file.stem]).removesuffix('.__init__')
            sources.append((dotted, Path(str(dist.locate_file(file)))))
        if parts and parts[0] not in ('..', '__pycache__') and not parts[0].endswith(('.dist-info', '.data')):
            tops.add(parts[0])
    imports = {_SUFFIX.sub('', top) for top in tops if not top.endswith('.pth') and top != 'bin'}
    imports = {name for name in imports if name.isidentifier()}
    requires = tuple(Requirement.parse(r) for r in dist.requires or [])
    return InstalledDist(canonicalize_name(dist.metadata['Name']), dist.version, requires,
                         frozenset(tops - {'bin'}), frozenset(imports), size, tuple(sorted(sources)))


class DistIndex:
    """Canonical name -> installed distribution, for one or more site-packages directories."""

    def __init__(self, dists: Iterable[InstalledDist]) -> None:
        self._by_name = {d.name: d for d in dists}
        #: dotted module -> file, over every installed distribution (the library import graph)
        self.modules = {dotted: path for d in self._by_name.values() for dotted, path in d.sources}

    @classmethod
    def from_paths(cls, paths: Iterable[Path]) -> DistIndex:
        return cls(_from_distribution(d) for d in distributions(path=[str(p) for p in paths]))

    def __len__(self) -> int:
        return len(self._by_name)

    def get(self, name: str) -> InstalledDist | None:
        return self._by_name.get(canonicalize_name(name))

    def require(self, name: str) -> InstalledDist:
        dist = self.get(name)
        if dist is None:
            raise AuditError(f'distribution {name} is not installed')
        return dist

    @staticmethod
    def guess_imports(name: str) -> set[str]:
        """Import names an UNRESOLVED distribution may provide (its name, with and without a ``-client`` tail)."""
        base = name.replace('-', '_')
        return {base, base.removesuffix('_client'), base.removeprefix('python_')}
