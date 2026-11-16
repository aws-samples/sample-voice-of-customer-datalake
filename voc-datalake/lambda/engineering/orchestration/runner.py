"""``npm run orchestration:run -- --flow <id> --repo <path> [--dry-run] [--models fake|bedrock]``: a flow, locally.

- ``--dry-run`` prints what a run of the flow on that repository would be, and runs nothing: the compiled
  ``voc-workflow/2`` definition, each step's resolved skill (the bundled template's label, model, harness and tools),
  and the quality gate's plan on the repository (the packs its markers select and every check with its command).
- ``--models fake`` runs the flow end to end on the local fake runtime the Bug hunt test drives (the conductor, the
  board, the broker's own handler behind a SigV4-checking function URL, a git host on a fixture repository, moto for
  the tables and buckets), each agent on a scripted model that acts out the eval case's known fix. It prints each
  step's output, the gate's checks (run for real on the fixed tree) and each step's assertions. It needs a repository
  that is an eval case's fixture (``templates/orchestration/evals/<flow>/cases/<case>/repo``, with its known fix) and
  the test tools (moto: requirements-dev.txt); the fake runtime is test support
  (``orchestration/test/local_fake.py``), so it is loaded only here.
- ``--models bedrock`` is not run locally yet: a run on Converse needs the harness to take each skill from the bundle
  and the gate runner's ``run_gate`` tool (7.50.00's runtime work). It says so and exits 2.
"""
from __future__ import annotations

import importlib
import json
import sys
from collections.abc import Callable, Mapping
from pathlib import Path
from typing import Any, Final

from engineering.orchestration import bundle as bundled
from engineering.orchestration.compile import compile_bundle, load, render, skill_ref
from engineering.orchestration.schema import ROOT
from engineering.quality_gate.packs import GatePlan, RepoView, detect, load_packs, plan
from shared.workflow_engineering import flow_settings, step_assertions

MODELS: Final = ('fake', 'bedrock')
#: The flows ``--models fake`` scripts (the local fake runtime the Bug hunt test drives).
FAKE_FLOWS: Final = frozenset({'bug-hunt-and-fix'})
FAKE_RUNTIME: Final = 'engineering.orchestration.test.local_fake'
BEDROCK_STUB: Final = ('--models bedrock does not run locally yet: a run on Converse needs the harness to take each '
                       "skill from the bundle and the gate runner's run_gate tool, which 7.50.00's runtime work adds. "
                       'Use --dry-run to see the flow, or --models fake to run it on scripted models.')

Out = Callable[[str], None]


class RunError(ValueError):
    """A run this command cannot make (an unknown flow, a repository that is not there, ...)."""


def gate_plan(repo: Path, root: Path = ROOT) -> GatePlan:
    """The quality gate's plan on ``repo``: the packs its markers select and their checks, every root."""
    view = RepoView.from_dir(repo)
    return plan(detect(load_packs(root / 'gates'), view), view, python=sys.executable)


def _flow(flow_id: str, root: Path) -> Mapping[str, Any]:
    flows = {flow['template_id']: flow for flow in compile_bundle(load(root))['flows']}
    if flow_id not in flows:
        raise RunError(f'no flow {flow_id} (the flows: {", ".join(flows)})')
    return flows[flow_id]


def _skill_line(step: str, reference: str, root: Path) -> str:
    role, version = skill_ref(reference)
    agent = bundled.agent(role, None if root == ROOT else root / 'bundle.json')
    if agent is None or agent['skill'] is None:
        return f'  {step}: {reference} -> no bundled skill'
    skill = agent['skill']
    pending = f'; pending {", ".join(agent["pending_tools"])}' if agent['pending_tools'] else ''
    return (f'  {step}: {reference} -> {agent["label"]} ({"the template" if version == "latest" else version}), '
            f'{skill["model"]}, {skill["harness"]}; tools {", ".join(skill["tool_policy"])}{pending}')


def dry_run(flow_id: str, repo: Path, out: Out = print, root: Path = ROOT) -> int:
    """Print the compiled flow, the resolved skills and the gate plan; 0."""
    if not repo.is_dir():
        raise RunError(f'{repo} is not a directory')
    flow = _flow(flow_id, root)
    stale = (root / 'bundle.json').is_file() and (root / 'bundle.json').read_text(encoding='utf-8') != render(
        compile_bundle(load(root)))
    out(f'flow {flow_id} v{flow["version"]}: {flow["name"]}' + (
        ' (bundle.json is older than the templates: npm run orchestration:compile)' if stale else ''))
    out(json.dumps(flow['definition'], indent=1))
    settings = flow_settings(flow['definition'])
    out(f'settings: memory {json.dumps(settings["memory"])}; learn {json.dumps(settings["learn"])}; '
        f'pull request {settings["pr"]}')
    for node in flow['definition']['nodes']:
        checks = [f'{item["check"]} ({item.get("on_fail", "block")})' for item in step_assertions(node)]
        if checks:
            out(f'  {node["id"]} asserts: {", ".join(checks)}')
    out('skills (the bundled templates; a deployment runs its skills store\'s current version where it has one):')
    for step, reference in flow['skills'].items():
        out(_skill_line(step, reference, root))
    gate = gate_plan(repo, root)
    out(f'gate plan on {repo}: packs {", ".join(gate.packs) or "none"}' + (' (its own scripts/validate.sh)'
                                                                          if gate.own_gate else ''))
    for check in gate.checks:
        out(f'  [{check.kind}] {check.key}: {" ".join(check.argv)}')
    for key, why in gate.skipped:
        out(f'  (skipped) {key}: {why}')
    if gate.needs.image or gate.needs.network:
        out(f'  image {json.dumps(dict(gate.needs.image))}; setup network {", ".join(gate.needs.network) or "none"}')
    return 0


def run(flow_id: str, repo: Path, *, dry: bool, models: str, issue: int | None = None, out: Out = print,
        root: Path = ROOT) -> int:
    """The ``run`` command: 0 when the flow ran (or was shown) and every blocking assertion passed. ``issue``: the
    run's issue number (its pull request then says Fixes #<issue>)."""
    if dry:
        return dry_run(flow_id, repo, out, root)
    if models == 'bedrock':
        out(BEDROCK_STUB)
        return 2
    if flow_id not in FAKE_FLOWS:
        raise RunError(f'--models fake scripts {", ".join(sorted(FAKE_FLOWS))}; for {flow_id}, use --dry-run')
    fake: Any = importlib.import_module(FAKE_RUNTIME)
    try:
        return int(fake.run_flow(_flow(flow_id, root), repo.resolve(), out=out, issue=issue))
    except fake.FakeRunError as error:
        raise RunError(str(error)) from error
