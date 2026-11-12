"""Run the gate in a checkout: ``python -m engineering.quality_gate <command>``.

    plan  --repo DIR [--changed FILE]   the detected packs and the checks they would run (JSON)
    check --repo DIR [--changed FILE]   run the deterministic gate (exit 0 when it passes)
    gate  --repo DIR --input FILE [--markdown FILE] [--fresh-checkout]
          the whole gate on one committed change, review only (no reviser: blocking findings stop it for a
          person); FILE holds {"task", "diff", "review_guide", "authors", "changed_paths", "params"}; exit 0 on GO

``--changed`` is a file with one changed path per line: the rounds check only the roots it touches, the final
go's checks cover every root. ``--python`` names the interpreter the repository's Python steps run with (the
sandbox's, ``python3`` by default; never this gate's own, so a repository's dependencies never land in it). The
record (JSON) goes to stdout. Here the checks run as this process's user: on a repository you do not trust, run
it only where the runtime's sandbox runs the checks.
"""
from __future__ import annotations

import argparse
import json
import sys
from collections.abc import Sequence
from pathlib import Path
from typing import Any

from engineering.quality_gate.checks import run_plan
from engineering.quality_gate.gate import GateConfig, GateConfigError, GateInput, QualityGate
from engineering.quality_gate.models import BedrockModel, ModelClient
from engineering.quality_gate.packs import GatePlan, RepoView, default_packs_dir, detect, load_packs, plan
from engineering.quality_gate.review import changed_paths
from engineering.quality_gate.runner import LocalRunner


def _plans(args: argparse.Namespace, changed: Sequence[str] | None) -> tuple[GatePlan, GatePlan]:
    repo = RepoView.from_dir(args.repo)
    detections = detect(load_packs(args.packs or default_packs_dir()), repo)
    return (plan(detections, repo, changed_paths=changed, python=args.python),
            plan(detections, repo, python=args.python))


def _plan_json(gate_plan: GatePlan) -> dict[str, Any]:
    return {'packs': list(gate_plan.packs), 'own_gate': gate_plan.own_gate,
            'network': list(gate_plan.needs.network), 'image': dict(gate_plan.needs.image),
            'checks': [{'key': c.key, 'pack': c.pack_id, 'step': c.step_id, 'language': c.language, 'kind': c.kind,
                        'name': c.name, 'root': c.root, 'argv': list(c.argv), 'timeout_s': c.timeout_s}
                       for c in gate_plan.checks],
            'skipped': [{'key': key, 'reason': reason} for key, reason in gate_plan.skipped]}


def _changed(path: str | None) -> list[str] | None:
    if path is None:
        return None
    return [line.strip() for line in Path(path).read_text(encoding='utf-8').splitlines() if line.strip()]


def _gate(args: argparse.Namespace, model: ModelClient | None) -> int:
    data = json.loads(Path(args.input).read_text(encoding='utf-8'))
    changed = sorted({*map(str, data.get('changed_paths', [])), *changed_paths(str(data.get('diff', '')))})
    round_plan, final_plan = _plans(args, changed)
    gate_input = GateInput(task=str(data.get('task', '')), diff=str(data.get('diff', '')),
                           review_guide=str(data.get('review_guide', '')),
                           authors=frozenset(map(str, data.get('authors', []))), changed_paths=tuple(changed))
    gate = QualityGate(gate_input, config=GateConfig.from_params(data.get('params', {})), round_plan=round_plan,
                       final_plan=final_plan, runner=LocalRunner(args.repo), model=model or BedrockModel(),
                       fresh_checkout=args.fresh_checkout,
                       replan=lambda diff: _plans(args, sorted({*changed, *changed_paths(diff)})))
    outcome = gate.run()
    if args.markdown:
        Path(args.markdown).write_text(outcome.record.render_markdown(), encoding='utf-8')
    print(json.dumps({'record': outcome.record.to_dict(), 'needs_human': outcome.needs_human,  # noqa: T201 — the CLI's output
                      'actions': list(outcome.actions), 'message': outcome.message}, indent=2))
    return 0 if outcome.go else 1


def main(argv: Sequence[str] | None = None, *, model: ModelClient | None = None) -> int:
    parser = argparse.ArgumentParser(prog='python -m engineering.quality_gate')
    parser.add_argument('command', choices=['plan', 'check', 'gate'])
    parser.add_argument('--repo', required=True, type=Path)
    parser.add_argument('--packs', type=Path, default=None)
    parser.add_argument('--python', default='python3')
    parser.add_argument('--changed')
    parser.add_argument('--input')
    parser.add_argument('--markdown')
    parser.add_argument('--fresh-checkout', action='store_true',
                        help='reset the checkout to HEAD before each round (deletes untracked and ignored files)')
    args = parser.parse_args(argv)
    if args.command == 'gate':
        if not args.input:
            parser.error('gate needs --input')
        try:
            return _gate(args, model)
        except GateConfigError as exc:
            parser.error(f'the input: {exc}')
    round_plan, _ = _plans(args, _changed(args.changed))
    if args.command == 'plan':
        print(json.dumps(_plan_json(round_plan), indent=2))  # noqa: T201 — the CLI's output
        return 0
    run = run_plan(round_plan, LocalRunner(args.repo))
    # No check at all, or only a dependency install, is not a pass: nothing looked at the code.
    passed = run.passed and any(r.kind != 'setup' for r in run.results)
    print(json.dumps({'passed': passed, 'tool_versions': dict(run.tool_versions),  # noqa: T201 — the CLI's output
                      'results': [r.summary() for r in run.results]}, indent=2))
    return 0 if passed else 1


if __name__ == '__main__':
    sys.exit(main())
