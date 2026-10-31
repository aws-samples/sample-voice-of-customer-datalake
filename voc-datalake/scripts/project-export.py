#!/usr/bin/env python3
"""Export projects from a deployment to a portable bundle directory (docs/project-export.md).

    python scripts/project-export.py --prefix <prefix> --region <region> --out <dir> \\
        (--project <id> [--project <id> ...] | --all)

Reads with the operator's own AWS credentials (boto3's chain: AWS_PROFILE, env, SSO). Table
and bucket names come from `<prefix>-VocCoreStack`'s outputs. Writes nothing to AWS. Ported
from PR #429 by @aws-bryan (export_projects.py / migrate_projects.py).
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from project_bundle.cli import export_main

if __name__ == '__main__':
    raise SystemExit(export_main())
