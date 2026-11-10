"""Project export / import between deployments (docs/project-export.md).

The entry points are `scripts/project-export.py` and `scripts/project-import.py`; they put
`scripts/` on `sys.path` and import this package. Python 3.12 stdlib + boto3 only, except
`--new-ids`, which imports the platform's own id helpers from `lambda/shared` (run it with
the repo's `.venv/bin/python`). Design ported from PR #429 by @aws-bryan.
"""
