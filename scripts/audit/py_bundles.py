"""Which deployed Python bundles ship each source file: the "could these copies share one home?" question.

A library of the ``py_*`` detectors (no marker, never run on its own). Built from the synthesized app
(:func:`py_assembly.load_assembly`) and each function's replayed bundling command, so "shareable" means the files
really ship together, not that they sit side by side in the repo. ``lambda/shared`` ships in every Python bundle
today (plugins included); ``product_doc_extractor`` (stdlib + boto3 by design) and inline custom resources do not,
so their copies never get a home.
"""
from __future__ import annotations

from collections import defaultdict
from collections.abc import Iterable
from dataclasses import dataclass
from pathlib import Path

from audit_common import CDK_DIR
from py_assembly import Assembly, emulate_bundle, load_assembly, python_modules

#: The shared package; a file whose every bundle ships it can import a constant or helper from there.
SHARED_MARKER = 'lambda/shared/__init__.py'


@dataclass(frozen=True)
class Bundles:
    """``voc-datalake``-relative source path -> the function ids whose bundle ships it, and its module names."""

    file_fns: dict[str, frozenset[str]]
    file_modules: dict[str, frozenset[str]]

    def can_import(self, importer: str, owner: str) -> bool:
        """Every bundle that ships ``importer`` also ships ``owner``."""
        mine, theirs = self.file_fns.get(importer, frozenset()), self.file_fns.get(owner, frozenset())
        return bool(mine) and mine <= theirs

    def ships_shared(self, rel: str) -> bool:
        """Every bundle of ``rel`` ships ``lambda/shared`` (and ``rel`` ships at all)."""
        return self.can_import(rel, SHARED_MARKER)

    def home(self, files: Iterable[str]) -> str | None:
        """Where ONE copy could live: an existing site every other site can import, else ``lambda/shared``."""
        sites = sorted(set(files))
        for owner in sites:
            if all(self.can_import(other, owner) for other in sites if other != owner):
                return owner
        if sites and all(self.ships_shared(site) for site in sites):
            return 'lambda/shared'
        return None


def bundles_of(cdk_dir: Path, assembly: Assembly) -> Bundles:
    """Membership of every analysable Python function's bundle (inline and CDK-provided handlers skipped)."""
    fns: dict[str, set[str]] = defaultdict(set)
    modules: dict[str, set[str]] = defaultdict(set)
    root = cdk_dir.resolve()
    for fn in assembly.functions.values():
        if not fn.is_python or fn.external or fn.inline is not None or fn.asset_source is None:
            continue
        for name, src in python_modules(emulate_bundle(cdk_dir, fn)).items():
            rel = src.resolve().relative_to(root).as_posix()
            fns[rel].add(fn.fid)
            modules[rel].add(name)
    return Bundles({k: frozenset(v) for k, v in fns.items()}, {k: frozenset(v) for k, v in modules.items()})


def load_bundles(cdk_dir: Path = CDK_DIR, *, refresh: bool = False) -> Bundles:
    return bundles_of(cdk_dir, load_assembly(cdk_dir, refresh=refresh))
