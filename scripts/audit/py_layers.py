#!/usr/bin/env python3
# audit-detector: run by scripts/audit/run-all.sh
"""py_layers: what each Python dependency layer ships that the functions attached to it never use.

PATTERN. A ``LayerVersion`` built from ``lambda/layers/<name>/requirements.txt`` is attached to every Lambda of
its stack, so a library one handler needs is unzipped into all of them: before 5.31 the CloudFront-signing
crypto (cryptography + cffi + pycparser, ~16 MB of a 42 MB layer) shipped to 42 functions, five of which can
sign; and the layers carried their own urllib3 / jmespath / dateutil / six, which SHADOW the copies the Lambda
runtime ships (``/opt/python`` precedes the runtime's site-packages), so the runtime's botocore ran on them.

HOW. ``py_assembly`` synthesizes the app (no Docker) and records each layer's source dir and bundling command.
Per layer, the requirements are resolved OFFLINE against the installed metadata of the interpreter running
the detector (the gate's ``voc-datalake/.venv``, which CI installs from the same requirement files;
``--site-packages`` overrides): each distribution's version,
``Requires-Dist`` (markers evaluated for the Lambda runtime, the requested extras followed), its top-level
import names and size (both from ``RECORD``). The ``rm -rf /asset-output/python/<name>`` steps of the bundling
command say what the layer strips. Per attached function, ``py_reachability``'s per-bundle reach gives the
loaded modules and live defs; the imports those execute (module level, class bodies and LIVE functions;
``if TYPE_CHECKING`` blocks skipped) that are neither stdlib nor bundle modules are the third-party names it
needs, plus any live string literal equal to a layer import name (``BeautifulSoup(html, 'lxml')`` loads lxml
by name). A distribution is reached when it provides one of those names, or is a requirement of a reached one.

KINDS (key ``<stack>/<layer>::<distribution>`` unless noted):
- ``unused-distribution``: no attached function reaches it.
- ``runtime-provided``: the Lambda runtime ships it (:data:`RUNTIME_PROVIDED`) and the layer does not strip it.
- ``runtime-conflict`` (``<layer>::<dist>-><runtime dist>``): a layer distribution requires a stripped runtime
  distribution at a version the runtime does not have, so stripping it would break that distribution.
- ``narrow-distribution``: reached by fewer than a third of the layer's functions and at least
  :data:`NARROW_MB` MB (its own installed files): a candidate for a layer of its own.
- ``version-mismatch``: the venv's version does not satisfy the requirement (or the venv lacks it, so its
  imports and dependencies are unknown and it is not judged).
- ``missing-distribution`` (``<function>::<import name>``): live code imports a third-party name that no attached
  layer and not the runtime provides (an ``ImportError`` waiting for its first call).
- ``unused-layer`` (``<function>::<layer>``): the function reaches nothing the layer ships.

WHY THE REFERENCE TOOLS MISS IT. ``pip``/``pipdeptree`` know what was installed, not who imports it; the
reachability detectors stop at the first third-party import; nothing joins the template's ``Layers`` with code.

FALSE POSITIVES. A library loaded by a name the code builds at run time; a plugin a library discovers by entry
point. Silence with ``{"key": ..., "kind"?: ..., "reason": ...}`` in ``scripts/audit/allowlists/py_layers.json``.

Run: ``voc-datalake/.venv/bin/python scripts/audit/py_layers.py [--json [PATH]] [--refresh] [--site-packages DIR]``.
Exit 0 clean, 1 findings, 2 scan error.
"""
from __future__ import annotations

import argparse
import fnmatch
import re
import shlex
import sysconfig
from collections.abc import Iterable
from dataclasses import dataclass, field
from pathlib import Path

from audit_common import AuditError, Finding, finish, guard, parse_cli, run_main
from layer_dists import RUNTIME_PROVIDED, DistIndex, Requirement, read_requirements, runtime_imports
from layer_imports import library_closure, live_imports
from py_assembly import Assembly, LayerAsset, load_assembly, refs
from py_reachability import FunctionReach, analyse

TOOL = 'py_layers'
NARROW_MB = 2.0          # a distribution smaller than this is not worth a layer of its own
NARROW_SHARE = 1 / 3     # "narrow": reached by fewer than this share of the layer's functions
_STRIP = re.compile(r'^/asset-output/python/(?P<entry>[^/]+)$')


@dataclass
class LayerPlan:
    """One repo layer: what pip installs into it (resolved), what the bundling strips, who attaches it."""

    lid: str
    requirements: list[Requirement]
    installed: dict[str, set[str]] = field(default_factory=dict)   # dist -> its requirements in the layer
    stripped: set[str] = field(default_factory=set)                # dists the bundling removes
    unresolved: set[str] = field(default_factory=set)              # required, not in the venv
    functions: list[str] = field(default_factory=list)

    @property
    def shipped(self) -> set[str]:
        return set(self.installed) - self.stripped


def strip_entries(command: list[str] | None) -> list[str]:
    """The ``/asset-output/python/<entry>`` globs the bundling command's ``rm -rf`` steps remove."""
    script = command[-1] if command else ''
    entries: list[str] = []
    for step in re.split(r'\s+&&\s+', script):
        words = shlex.split(step) if step.strip().startswith('rm ') else []
        entries += [m.group('entry') for word in words[2:] if (m := _STRIP.match(word))]
    return entries


def plan_layer(cdk_dir: Path, layer: LayerAsset, index: DistIndex) -> LayerPlan:
    if layer.asset_source is None:
        raise AuditError(f'{layer.lid}: no bundling record for its asset')
    req_file = cdk_dir / layer.asset_source / 'requirements.txt'
    if not req_file.is_file():
        raise AuditError(f'{layer.lid}: {req_file.relative_to(cdk_dir)} not found')
    plan = LayerPlan(layer.lid, read_requirements(req_file))
    todo = [(req.name, req.extras) for req in plan.requirements if req.applies()]
    seen: set[tuple[str, frozenset[str]]] = set()
    while todo:
        name, extras = todo.pop()
        if (name, extras) in seen:
            continue
        seen.add((name, extras))
        dist = index.get(name)
        if dist is None:
            plan.unresolved.add(name)
            continue
        deps = plan.installed.setdefault(name, set())
        for dep in dist.requires_for(extras):
            deps.add(dep.name)
            todo.append((dep.name, dep.extras))
    entries = strip_entries(layer.asset_command)
    plan.stripped = {name for name in plan.installed
                     if (tops := index.require(name).top_entries)
                     and all(any(fnmatch.fnmatch(top, e) for e in entries) for top in tops)}
    return plan


def attachments(assembly: Assembly) -> dict[str, list[str]]:
    """Function id -> the layer ids its template ``Layers`` property names."""
    exports = assembly.exports()
    found: dict[str, list[str]] = {}
    for fid, fn in assembly.functions.items():
        value = assembly.resource(fid).get('Properties', {}).get('Layers')
        if value:
            found[fid] = list(refs(value, fn.stack, exports))
    return found


@dataclass
class Scan:
    plans: dict[str, LayerPlan]
    reached: dict[str, dict[str, set[str]]] = field(default_factory=dict)   # layer -> dist -> functions
    findings: list[Finding] = field(default_factory=list)


def _reach(plan: LayerPlan, index: DistIndex, names: set[str]) -> set[str]:
    """The layer distributions a function needing ``names`` reaches (direct, then their requirements)."""
    hit = {d for d in plan.installed if index.require(d).imports & names}
    todo = list(hit)
    while todo:
        for dep in plan.installed.get(todo.pop(), ()):
            if dep in plan.installed and dep not in hit:
                hit.add(dep)
                todo.append(dep)
    return hit


def judge_function(scan: Scan, index: DistIndex, fr: FunctionReach, layer_ids: list[str], root: Path) -> None:
    live = live_imports(fr, root)
    layer_names = {i for lid in layer_ids for d in scan.plans[lid].shipped for i in index.require(d).imports}
    by_name = {s for s in fr.reach.strings if s in layer_names}   # BeautifulSoup(html, 'lxml')
    loaded = library_closure(live.modules | by_name, index.modules)
    names = live.names | by_name | {m.split('.')[0] for m in loaded}
    optional = live.optional
    provided = set(runtime_imports())
    fid = fr.fn.fid
    for lid in layer_ids:
        plan = scan.plans[lid]
        hit = _reach(plan, index, names) & plan.shipped
        for dist in hit:
            scan.reached[lid].setdefault(dist, set()).add(fid)
        provided |= {i for d in plan.shipped for i in index.require(d).imports}
        if not hit:
            scan.findings.append(Finding('unused-layer', f'{fid}::{lid}', 'the function reaches nothing this layer ships'))
    unknown = {i for lid in layer_ids for d in scan.plans[lid].unresolved for i in index.guess_imports(d)}
    # Only the function's OWN imports: a library's unguarded import of something the layer lacks is the
    # venv's business (the venv holds dev tools the layers never ship).
    for name in sorted(live.names - provided - optional - unknown):
        scan.findings.append(Finding('missing-distribution', f'{fid}::{name}',
                                     'imported by live code; no attached layer and not the runtime provides it'))


def judge_layer(scan: Scan, index: DistIndex, plan: LayerPlan) -> None:
    lid, total = plan.lid, len(plan.functions)
    reached = scan.reached[lid]
    for req in plan.requirements:
        dist = index.get(req.name)
        if dist is None:
            scan.findings.append(Finding('version-mismatch', f'{lid}::{req.name}',
                                         f'requires {req.spec or "any"}; not installed in the venv (not judged)'))
        elif not req.allows(dist.version):
            scan.findings.append(Finding('version-mismatch', f'{lid}::{req.name}',
                                         f'requires {req.spec}; the venv has {dist.version}'))
    for name in sorted(plan.installed):
        if name in RUNTIME_PROVIDED and name not in plan.stripped:
            scan.findings.append(Finding('runtime-provided', f'{lid}::{name}',
                                         f'the Lambda runtime ships {name} {RUNTIME_PROVIDED[name].version}; '
                                         'the layer copy shadows it'))
        for dep in index.require(name).requires_for(()):
            runtime = RUNTIME_PROVIDED.get(dep.name)
            if name not in plan.stripped and dep.name in plan.stripped and runtime and not dep.allows(runtime.version):
                scan.findings.append(Finding('runtime-conflict', f'{lid}::{name}->{dep.name}',
                                             f'{name} requires {dep.name}{dep.spec}; the runtime has {runtime.version}'))
    for name in sorted(plan.shipped):
        users = reached.get(name, set())
        size_mb = index.require(name).size / 1e6
        if not users:
            scan.findings.append(Finding('unused-distribution', f'{lid}::{name}',
                                         f'{size_mb:.1f} MB; none of the {total} attached functions reaches it'))
        elif len(users) < total * NARROW_SHARE and size_mb >= NARROW_MB:
            scan.findings.append(Finding('narrow-distribution', f'{lid}::{name}',
                                         f'{size_mb:.1f} MB, reached by {len(users)} of {total}: '
                                         + ', '.join(sorted(users)), {'functions': sorted(users)}))


def run_scan(assembly: Assembly, program: dict[str, FunctionReach], index: DistIndex, cdk_dir: Path) -> Scan:
    repo_layers = {lid: layer for lid, layer in assembly.layers.items() if not layer.external}
    scan = Scan({lid: plan_layer(cdk_dir, layer, index) for lid, layer in sorted(repo_layers.items())})
    for lid in scan.plans:
        scan.reached[lid] = {}
    for fid, layer_ids in sorted(attachments(assembly).items()):
        mine = [lid for lid in layer_ids if lid in scan.plans]
        if not mine:
            continue
        for lid in mine:
            scan.plans[lid].functions.append(fid)
        if fid not in program:
            raise AuditError(f'{fid}: attached to {mine} but not analysed by py_reachability')
        judge_function(scan, index, program[fid], mine, cdk_dir)
    for plan in scan.plans.values():
        judge_layer(scan, index, plan)
    return scan


def default_site_packages() -> list[Path]:
    """The running interpreter's site-packages (the gate runs every detector with ``voc-datalake/.venv``)."""
    paths = sysconfig.get_paths()
    return sorted({Path(paths['purelib']), Path(paths['platlib'])})


def _extra(parser: argparse.ArgumentParser) -> None:
    parser.add_argument('--site-packages', type=Path, action='append', metavar='DIR',
                        help='resolve layer requirements against this site-packages (default: the running interpreter\'s)')


def main(argv: list[str] | None = None) -> int:
    args = parse_cli(__doc__, argv, extra=_extra)
    assembly = load_assembly(args.cdk_dir, refresh=args.refresh)
    index = DistIndex.from_paths(args.site_packages or default_site_packages())
    program = analyse(args.cdk_dir, assembly).functions
    scan = run_scan(assembly, program, index, args.cdk_dir)
    attached = sum(len(p.functions) for p in scan.plans.values())
    guard(len(scan.plans) >= 2, f'only {len(scan.plans)} repo layers found')
    guard(attached >= 30, f'only {attached} function-layer attachments')
    guard(len(index) >= 20, f'only {len(index)} distributions in the site-packages')
    sizes = ', '.join(f'{lid} {len(p.shipped)} dists/{len(p.functions)} fns' for lid, p in scan.plans.items())
    return finish(TOOL, args, _sorted(scan.findings), f'{len(scan.plans)} layers ({sizes})')


def _sorted(found: Iterable[Finding]) -> list[Finding]:
    return sorted(set(found), key=lambda f: (f.kind, f.key))


if __name__ == '__main__':
    run_main(main)
