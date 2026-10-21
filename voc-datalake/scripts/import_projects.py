#!/usr/bin/env python3
"""Load a projects export bundle into a VoC deployment you own.

Reads the bundle produced by `export_projects.py` and writes the DynamoDB
project items into your deployment's `voc-projects` table and re-uploads the
backing S3 objects (avatars, prototype HTML, product docs) into your raw-data
bucket under their original keys.

You need: AWS credentials for YOUR account, and your deployment's prefix. You do
NOT need any access to the source account.

Usage
-----
    python import_projects.py \
        --bundle . \
        --target-prefix <your-prefix> --account <your-account> --region <your-region> \
        [--apply]

Dry-run by default. Idempotent: DynamoDB puts are keyed on pk/sk, S3 copies
overwrite the same key — safe to re-run.
"""
from __future__ import annotations

import argparse
import json
import pathlib
import sys
from decimal import Decimal


def table_name(prefix: str, account: str, region: str) -> str:
    return f"{prefix}-voc-projects-{account}-{region}"


def bucket_name(prefix: str, account: str, region: str) -> str:
    return f"{prefix}-voc-raw-data-{account}-{region}"


def _reconstruct_decimals(value):
    """Turn exported JSON back into DynamoDB-ready Python.

    - ints stay ints (DynamoDB resource accepts them).
    - the ``{"__decimal__": "<text>"}`` sentinel emitted for non-integral values
      becomes an exact Decimal.
    - everything else recurses.
    """
    if isinstance(value, dict):
        if set(value.keys()) == {"__decimal__"}:
            return Decimal(value["__decimal__"])
        return {k: _reconstruct_decimals(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_reconstruct_decimals(v) for v in value]
    if isinstance(value, float):
        # No bare floats are emitted by the exporter, but guard anyway: DynamoDB
        # rejects floats, and a stray one would otherwise fail the whole put.
        return Decimal(str(value))
    return value


def load_items(bundle: pathlib.Path) -> list[dict]:
    items: list[dict] = []
    with (bundle / "projects.ndjson").open(encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if line:
                items.append(_reconstruct_decimals(json.loads(line)))
    return items


def s3_objects(bundle: pathlib.Path) -> list[tuple[str, pathlib.Path]]:
    """(s3_key, local_path) for every file under the bundle's s3/ mirror."""
    root = bundle / "s3"
    if not root.is_dir():
        return []
    out: list[tuple[str, pathlib.Path]] = []
    for path in root.rglob("*"):
        if path.is_file():
            out.append((path.relative_to(root).as_posix(), path))
    return out


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bundle", default=".", help="Path to the export bundle directory.")
    parser.add_argument("--target-prefix", required=True)
    parser.add_argument("--account", required=True)
    parser.add_argument("--region", default="us-east-1")
    parser.add_argument("--profile", default=None)
    parser.add_argument("--apply", action="store_true", help="Write (default is dry-run).")
    args = parser.parse_args()

    import boto3

    bundle = pathlib.Path(args.bundle).expanduser()
    if not (bundle / "projects.ndjson").exists():
        print(f"No projects.ndjson in {bundle} — is this an export bundle?")
        return 1

    manifest_path = bundle / "manifest.json"
    if manifest_path.exists():
        m = json.loads(manifest_path.read_text())
        print(f"Bundle: {m.get('project_count')} projects from "
              f"'{m.get('source_prefix')}' exported {m.get('exported_at')}")

    items = load_items(bundle)
    objects = s3_objects(bundle)
    mode = "APPLY" if args.apply else "DRY-RUN"
    print(f"[{mode}] Importing into {args.target_prefix}: "
          f"{len(items)} items, {len(objects)} S3 objects")

    session = boto3.Session(profile_name=args.profile, region_name=args.region)
    table = session.resource("dynamodb").Table(table_name(args.target_prefix, args.account, args.region))
    s3 = session.client("s3")
    tgt_bucket = bucket_name(args.target_prefix, args.account, args.region)

    if args.apply:
        with table.batch_writer() as batch:
            for item in items:
                batch.put_item(Item=item)
        for key, path in objects:
            s3.upload_file(str(path), tgt_bucket, key)

    print(f"\n=== Import {'complete' if args.apply else 'preview (nothing written)'} ===")
    print(f"  DynamoDB items : {len(items)}")
    print(f"  S3 objects     : {len(objects)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
