"""The orchestration templates' command line (run from voc-datalake/lambda; the npm scripts at the root call it).

    python -m engineering.orchestration validate                      npm run orchestration:validate
    python -m engineering.orchestration compile [--check]             npm run orchestration:compile
    python -m engineering.orchestration promote-pending               npm run orchestration:promote-pending
    python -m engineering.orchestration run --flow ID --repo DIR [--dry-run] [--models fake|bedrock]
                                                                      npm run orchestration:run -- ...
    python -m engineering.orchestration calibrate --run ID --manifest FILE [--manifest FILE ...]
                                                                      npm run orchestration:calibrate -- ...

Exit 0 when the command did what it says, 1 when the templates (or a run) have problems, 2 when it cannot run.
"""
from __future__ import annotations

import argparse
import sys
from collections.abc import Callable, Sequence
from pathlib import Path

from engineering.orchestration import calibrate, promote, runner, validate
from engineering.orchestration.compile import compile_bundle, kiro_files, load, render, write, write_kiro_agents
from engineering.orchestration.schema import ROOT

Out = Callable[[str], None]


def _validate(_args: argparse.Namespace, out: Out) -> int:
    found = validate.problems(ROOT)
    notice = ''
    if not found:
        found, notice = validate.kiro_cli_problems(ROOT)   # (optional: kiro-cli's own check, when it is there)
    for problem in found:
        out(problem)
    out(f'orchestration: {len(found)} problem(s)' if found
        else 'orchestration: the templates, both bundles and the Kiro agent configs are valid')
    if notice:
        out(notice)
    return 1 if found else 0


def _compile(args: argparse.Namespace, out: Out) -> int:
    found = validate.problems(ROOT, drift=False)
    if found:
        for problem in found:
            out(problem)
        return 1
    sources = load(ROOT)
    text, configs = render(compile_bundle(sources)), kiro_files(sources)
    if args.check:
        drift = validate.drift_problems(text, ROOT) + validate.kiro_drift_problems(configs, ROOT)
        for problem in drift:
            out(problem)
        return 1 if drift else 0
    written = write(text, ROOT) + write_kiro_agents(configs, ROOT)
    out(f'wrote {", ".join(str(path) for path in written)}' if written
        else 'both bundles and the Kiro agent configs are up to date')
    return 0


def _promote(_args: argparse.Namespace, out: Out) -> int:
    moved = promote.promote(ROOT)
    for item in moved:
        out(str(item))
    out(f'promoted {len(moved)} card(s); the bundles are compiled again' if moved
        else 'nothing to promote: every pending tool and broker operation is still not offered')
    return 0


def _run(args: argparse.Namespace, out: Out) -> int:
    return runner.run(args.flow, Path(args.repo), dry=args.dry_run, models=args.models, issue=args.issue, out=out)


def _calibrate(args: argparse.Namespace, out: Out) -> int:
    if not args.manifest:
        out('calibrate reads run manifests (voc-run-manifest/1, which the runtime writes under '
            'ws/default/runs/<run>/_manifest/): pass each with --manifest <file>')
        return 2
    for proposal in calibrate.calibrate(args.run, [Path(path) for path in args.manifest]):
        out(str(proposal))
    return 0


def parser() -> argparse.ArgumentParser:
    parse = argparse.ArgumentParser(prog='python -m engineering.orchestration', description=__doc__,
                                    formatter_class=argparse.RawDescriptionHelpFormatter)
    commands = parse.add_subparsers(dest='command', required=True)
    commands.add_parser('validate', help='every check of the templates, both bundles and the Kiro agent '
                        'configs').set_defaults(act=_validate)
    compiling = commands.add_parser('compile', help='write bundle.json, its Lambda copy and the Kiro agent configs')
    compiling.add_argument('--check', action='store_true', help='only say whether they are up to date')
    compiling.set_defaults(act=_compile)
    commands.add_parser('promote-pending', help='move the tools and broker operations the platform now offers out '
                        'of pending').set_defaults(act=_promote)
    running = commands.add_parser('run', help='a flow on a local repository')
    running.add_argument('--flow', required=True)
    running.add_argument('--repo', required=True)
    running.add_argument('--dry-run', action='store_true')
    running.add_argument('--models', choices=runner.MODELS, default='fake')
    running.add_argument('--issue', type=int, default=None, help="the run's issue number (Fixes #N)")
    running.set_defaults(act=_run)
    calibrating = commands.add_parser('calibrate', help='caps and budgets from run manifests')
    calibrating.add_argument('--run', required=True)
    calibrating.add_argument('--manifest', action='append', default=[])
    calibrating.set_defaults(act=_calibrate)
    return parse


def main(argv: Sequence[str] | None = None, out: Out = print) -> int:
    args = parser().parse_args(argv)
    try:
        return int(args.act(args, out))
    except (runner.RunError, calibrate.CalibrationError) as error:
        out(str(error))
        return 2


if __name__ == '__main__':
    sys.exit(main())
