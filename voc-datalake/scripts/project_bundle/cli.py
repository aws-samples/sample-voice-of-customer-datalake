"""The two commands behind `scripts/project-export.py` and `scripts/project-import.py`.

Both take the deployment (`--prefix`, `--region`) and run with the operator's own AWS
credentials; `session` is injectable for the tests. Exit codes: 0 done, 2 refused.
"""
from __future__ import annotations

import argparse
import sys
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from project_bundle import bundle
from project_bundle.deployment import add_deployment_arguments, resolve, session_for
from project_bundle.exporter import Exporter, ExportError, live_project_ids
from project_bundle.importer import Importer, ImportOptions

REFUSED = 2


def _export_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description='Export projects from a deployment to a bundle directory.')
    add_deployment_arguments(parser)
    parser.add_argument('--out', required=True, type=Path, help='bundle directory to create (must hold no bundle)')
    which = parser.add_mutually_exclusive_group(required=True)
    which.add_argument('--project', action='append', dest='projects', help='project id (repeatable)')
    which.add_argument('--all', action='store_true', help='every live project (no tombstones, no fixtures)')
    return parser


def _import_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description='Import a project bundle into a deployment.')
    add_deployment_arguments(parser)
    parser.add_argument('--bundle', required=True, type=Path, help='bundle directory from project-export.py')
    parser.add_argument('--owner-email', help='owner on the target when the bundle owner email is not in its pool')
    parser.add_argument('--new-ids', action='store_true',
                        help='give every project, persona and document a new id (needed when the id exists)')
    parser.add_argument('--dry-run', action='store_true', help='print what would be written; write nothing')
    return parser


def export_main(argv: list[str] | None = None, session: Any = None) -> int:
    args = _export_parser().parse_args(argv)
    session = session or session_for(args.region)
    deployment = resolve(session, args.prefix)
    exporter = Exporter(session, deployment)
    project_ids = live_project_ids(exporter.projects) if args.all else list(dict.fromkeys(args.projects))
    try:
        writer = bundle.BundleWriter(args.out.expanduser())
        summaries = exporter.run(project_ids, writer)
    except (bundle.BundleError, ExportError) as error:
        print(f'REFUSED: {error}', file=sys.stderr)
        return REFUSED
    writer.close({
        'exported_at': datetime.now(UTC).isoformat(),
        'source': {'prefix': args.prefix, 'region': args.region, 'bucket': deployment.bucket,
                   'api_base': deployment.api_base},
        'projects': summaries,
    })
    for summary in summaries:
        print(f'{summary["project_id"]}  "{summary["name"]}"  rows: {summary["rows"]}  '
              f'S3 objects: {summary["objects"]}  credential rows skipped: {summary["skipped_credentials"]}')
    print(f'{len(summaries)} project(s) exported to {args.out}')
    return 0


def import_main(argv: list[str] | None = None, session: Any = None) -> int:
    args = _import_parser().parse_args(argv)
    root = args.bundle.expanduser()
    try:
        manifest, projects = bundle.read(root)
    except (bundle.BundleError, ValueError) as error:
        print(f'REFUSED: {error}', file=sys.stderr)
        return REFUSED
    session = session or session_for(args.region)
    importer = Importer(session, resolve(session, args.prefix), root, manifest.get('source') or {})
    options = ImportOptions(owner_email=args.owner_email, new_ids=args.new_ids)
    plans = [importer.plan(project, options) for project in projects]
    for plan in plans:
        print('\n'.join(plan.lines()))
    if any(plan.refusals for plan in plans):
        print('REFUSED: nothing was written', file=sys.stderr)
        return REFUSED
    if args.dry_run:
        print(f'dry run: {len(plans)} project(s) planned, nothing written')
        return 0
    for plan in plans:
        importer.write(plan)
    print(f'{len(plans)} project(s) imported')
    return 0
