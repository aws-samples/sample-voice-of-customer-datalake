#!/usr/bin/env python3
"""Import a project bundle into a deployment (docs/project-export.md).

    python scripts/project-import.py --prefix <prefix> --region <region> --bundle <dir> \\
        [--owner-email <email>] [--new-ids] [--dry-run]

Writes with the operator's own AWS credentials into the tables, bucket and user pool named by
`<prefix>-VocCoreStack`'s outputs. Every project is planned first; any refusal (an existing
project id without `--new-ids`, an owner the target pool does not know without a usable
`--owner-email`) stops the import before anything is written. Ported from PR #429 by
@aws-bryan (import_projects.py).
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from project_bundle import bundle
from project_bundle.deployment import add_deployment_arguments, resolve, session_for
from project_bundle.importer import Importer, ImportOptions


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=(__doc__ or '').split('\n\n')[0])
    add_deployment_arguments(parser)
    parser.add_argument('--bundle', required=True, type=Path, help='bundle directory from project-export.py')
    parser.add_argument('--owner-email', help='owner on the target when the bundle owner email is not in its pool')
    parser.add_argument('--new-ids', action='store_true',
                        help='give every project, persona and document a new id (needed when the id exists)')
    parser.add_argument('--dry-run', action='store_true', help='print what would be written; write nothing')
    return parser


def main(argv: list[str] | None = None, session: object = None) -> int:
    args = _parser().parse_args(argv)
    root = args.bundle.expanduser()
    try:
        manifest, projects = bundle.read(root)
    except (bundle.BundleError, ValueError) as error:
        print(f'REFUSED: {error}', file=sys.stderr)
        return 2
    session = session or session_for(args.region)
    importer = Importer(session, resolve(session, args.prefix), root, manifest.get('source') or {})
    options = ImportOptions(owner_email=args.owner_email, new_ids=args.new_ids)
    plans = [importer.plan(project, options) for project in projects]
    for plan in plans:
        print('\n'.join(plan.lines()))
    if any(plan.refusals for plan in plans):
        print('REFUSED: nothing was written', file=sys.stderr)
        return 2
    if args.dry_run:
        print(f'dry run: {len(plans)} project(s) planned, nothing written')
        return 0
    for plan in plans:
        importer.write(plan)
    print(f'{len(plans)} project(s) imported')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
