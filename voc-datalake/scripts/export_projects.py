#!/usr/bin/env python3
"""Export all live Projects to a portable, offline bundle.

Writes the DynamoDB `voc-projects` partitions (every item type) and the backing
S3 objects (persona avatars, prototype HTML, uploaded product docs) for every
live project to a self-contained directory, so the data can be handed to someone
who has NO access to this AWS account and loaded into their own deployment with
`import_projects.py` (which travels in the bundle).

Feedback is NOT exported. Jobs, tombstoned (deleted) projects, and verification
fixtures are skipped — same selection rules as migrate_projects.py.

Bundle layout
-------------
    <out-dir>/
      manifest.json            # counts + provenance
      projects.ndjson          # one DynamoDB item per line (Decimal-safe)
      s3/<key>                 # each S3 object at its original key path
      import_projects.py       # the loader (copied in so the bundle is self-contained)
      IMPORT_README.md         # how the recipient loads it

Usage
-----
    python scripts/export_projects.py \
        --source-prefix d --account 459119164048 --region us-east-1 \
        --out ~/Documents/voc-deployment-handoff/projects-export
"""
from __future__ import annotations

import argparse
import json
import pathlib
import shutil
import sys
from datetime import datetime, timezone
from decimal import Decimal

import boto3
from boto3.dynamodb.conditions import Key

TOMBSTONE_STATUSES = {"deleting", "deleted"}
TOMBSTONE_ATTRIBUTE = "deletion_started_at"
FIXTURE_ATTRIBUTE = "verification_fixture_id"


class DecimalEncoder(json.JSONEncoder):
    """Serialize DynamoDB Decimals losslessly.

    Integral values become JSON ints; non-integral values are emitted as JSON
    STRINGS carrying the exact Decimal text (e.g. "-0.55"), so no value is ever
    routed through a binary float and precision cannot drift. The importer
    reconstructs Decimals: ints via parse_int, and these strings are converted
    back where a numeric attribute is expected. Counts and 3-dp sentiment scores
    are the realistic payload; this keeps even pathological values exact.
    """

    def default(self, o):
        if isinstance(o, Decimal):
            return int(o) if o % 1 == 0 else {"__decimal__": str(o)}
        return super().default(o)


def table_name(prefix: str, account: str, region: str) -> str:
    return f"{prefix}-voc-projects-{account}-{region}"


def bucket_name(prefix: str, account: str, region: str) -> str:
    return f"{prefix}-voc-raw-data-{account}-{region}"


def is_tombstone(meta: dict) -> bool:
    return TOMBSTONE_ATTRIBUTE in meta or meta.get("status") in TOMBSTONE_STATUSES


def is_fixture(meta: dict) -> bool:
    return FIXTURE_ATTRIBUTE in meta


def scan_all(table):
    kwargs: dict = {}
    while True:
        resp = table.scan(**kwargs)
        yield from resp.get("Items", [])
        key = resp.get("LastEvaluatedKey")
        if not key:
            return
        kwargs["ExclusiveStartKey"] = key


def live_project_ids(table) -> list[str]:
    ids: list[str] = []
    for item in scan_all(table):
        if item.get("sk") != "META" or is_tombstone(item) or is_fixture(item):
            continue
        pid = item.get("project_id") or item.get("pk", "").removeprefix("PROJECT#")
        if pid:
            ids.append(pid)
    return sorted(ids)


def partition_items(table, project_id: str) -> list[dict]:
    items: list[dict] = []
    kwargs = {"KeyConditionExpression": Key("pk").eq(f"PROJECT#{project_id}")}
    while True:
        resp = table.query(**kwargs)
        items.extend(resp.get("Items", []))
        key = resp.get("LastEvaluatedKey")
        if not key:
            return items
        kwargs["ExclusiveStartKey"] = key


def list_prefix(s3, bucket: str, prefix: str) -> list[str]:
    keys: list[str] = []
    token = None
    while True:
        kwargs = {"Bucket": bucket, "Prefix": prefix}
        if token:
            kwargs["ContinuationToken"] = token
        resp = s3.list_objects_v2(**kwargs)
        keys.extend(obj["Key"] for obj in resp.get("Contents", []))
        if not resp.get("IsTruncated"):
            return keys
        token = resp.get("NextContinuationToken")


def s3_keys_for_project(items: list[dict], project_id: str, s3, bucket: str) -> list[str]:
    keys: list[str] = []
    for it in items:
        if it.get("sk", "").startswith("PERSONA#"):
            persona_id = it["sk"].removeprefix("PERSONA#")
            keys.extend(list_prefix(s3, bucket, f"avatars/{persona_id}."))
    keys.extend(list_prefix(s3, bucket, f"prototypes/{project_id}/"))
    keys.extend(list_prefix(s3, bucket, f"projects/{project_id}/product_docs/"))
    return keys


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-prefix", required=True)
    parser.add_argument("--account", required=True)
    parser.add_argument("--region", default="us-east-1")
    parser.add_argument("--profile", default=None)
    parser.add_argument("--out", required=True, help="Output bundle directory (created/overwritten).")
    args = parser.parse_args()

    out = pathlib.Path(args.out).expanduser()
    s3_dir = out / "s3"
    s3_dir.mkdir(parents=True, exist_ok=True)

    session = boto3.Session(profile_name=args.profile, region_name=args.region)
    table = session.resource("dynamodb").Table(table_name(args.source_prefix, args.account, args.region))
    s3 = session.client("s3")
    bucket = bucket_name(args.source_prefix, args.account, args.region)

    ids = live_project_ids(table)
    print(f"Exporting {len(ids)} live projects from {args.source_prefix}...")

    total_items = 0
    total_objects = 0
    projects_meta: list[dict] = []

    with (out / "projects.ndjson").open("w", encoding="utf-8") as fh:
        for pid in ids:
            items = partition_items(table, pid)
            for item in items:
                fh.write(json.dumps(item, cls=DecimalEncoder, ensure_ascii=False) + "\n")
            keys = s3_keys_for_project(items, pid, s3, bucket)
            for key in keys:
                dest = s3_dir / key
                dest.parent.mkdir(parents=True, exist_ok=True)
                s3.download_file(bucket, key, str(dest))
            total_items += len(items)
            total_objects += len(keys)
            name = next((it.get("name") for it in items if it.get("sk") == "META"), "?")
            projects_meta.append({"project_id": pid, "name": name, "items": len(items), "s3_objects": len(keys)})
            print(f"  {pid}  \"{name}\"  — {len(items)} items, {len(keys)} S3 objects")

    manifest = {
        "exported_at": datetime.now(timezone.utc).isoformat(),
        "source_prefix": args.source_prefix,
        "source_account": args.account,
        "source_region": args.region,
        "project_count": len(ids),
        "total_items": total_items,
        "total_s3_objects": total_objects,
        "projects": projects_meta,
    }
    (out / "manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")

    # Make the bundle self-contained: ship the importer and its readme alongside.
    here = pathlib.Path(__file__).parent
    for extra in ("import_projects.py", "IMPORT_README.md"):
        src = here / extra
        if src.exists():
            shutil.copy2(src, out / extra)

    print("\n=== Export complete ===")
    print(f"  projects       : {len(ids)}")
    print(f"  DynamoDB items : {total_items}")
    print(f"  S3 objects     : {total_objects}")
    print(f"  bundle         : {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
