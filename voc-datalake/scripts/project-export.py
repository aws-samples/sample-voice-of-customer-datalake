#!/usr/bin/env python3
"""Export projects from a deployment to a portable bundle directory (docs/project-export.md).

    python scripts/project-export.py --prefix <prefix> --region <region> --out <dir> \\
        (--project <id> [--project <id> ...] | --all)

Reads with the operator's own AWS credentials (boto3's chain: AWS_PROFILE, env, SSO). Table
and bucket names come from `<prefix>-VocCoreStack`'s outputs. Writes nothing to AWS. Ported
from PR #429 by @aws-bryan (export_projects.py / migrate_projects.py).
"""
from __future__ import annotations

import argparse
import sys
from datetime import UTC, datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from project_bundle.bundle import BundleError, BundleWriter
from project_bundle.deployment import add_deployment_arguments, resolve, session_for
from project_bundle.exporter import Exporter, ExportError, live_project_ids


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=(__doc__ or '').split('\n\n')[0])
    add_deployment_arguments(parser)
    parser.add_argument('--out', required=True, type=Path, help='bundle directory to create (must hold no bundle)')
    which = parser.add_mutually_exclusive_group(required=True)
    which.add_argument('--project', action='append', dest='projects', help='project id (repeatable)')
    which.add_argument('--all', action='store_true', help='every live project (no tombstones, no fixtures)')
    return parser


def main(argv: list[str] | None = None, session: object = None) -> int:
    args = _parser().parse_args(argv)
    session = session or session_for(args.region)
    deployment = resolve(session, args.prefix)
    exporter = Exporter(session, deployment)
    project_ids = live_project_ids(exporter.projects) if args.all else list(dict.fromkeys(args.projects))
    try:
        writer = BundleWriter(args.out.expanduser())
        summaries = exporter.run(project_ids, writer)
    except (BundleError, ExportError) as error:
        print(f'REFUSED: {error}', file=sys.stderr)
        return 2
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


if __name__ == '__main__':
    raise SystemExit(main())
