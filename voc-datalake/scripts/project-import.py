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
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from project_bundle.cli import import_main

if __name__ == '__main__':
    raise SystemExit(import_main())
