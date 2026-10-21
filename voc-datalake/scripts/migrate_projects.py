#!/usr/bin/env python3
"""Copy all live Projects from one VoC deployment to another.

Moves the DynamoDB `voc-projects` partitions (whole-partition, every item type)
plus the backing S3 objects — persona avatars, prototype HTML, uploaded product
docs — from a source deployment prefix to a target prefix in the same account.

Feedback is NOT moved. Jobs, tombstoned (deleted) projects, and verification
fixtures are skipped. See scripts/MIGRATE_PROJECTS_D_TO_F.md for the full
rationale and the storage model this relies on.

Safety
------
- Dry-run by default. Pass --apply to write.
- Idempotent: DynamoDB puts are keyed on pk/sk; S3 copies overwrite the same
  key. Re-running after an interruption is safe.
- Target-scoped: only writes to the target projects table and target raw-data
  bucket, only under keys derived from the copied projects. Never touches
  feedback.
- --rollback removes exactly what a copy would have written (same project ids,
  same S3 keys), nothing else.

Usage
-----
    python scripts/migrate_projects.py \
        --source-prefix d --target-prefix f \
        --account 459119164048 --region us-east-1 [--apply] [--rollback]
"""
from __future__ import annotations

import argparse
import sys
from typing import Iterator

import boto3
from boto3.dynamodb.conditions import Key

# Terminal project statuses whose META rows are tombstones (see
# lambda/shared/project_writes.py PROJECT_TERMINAL_STATUSES).
TOMBSTONE_STATUSES = {"deleting", "deleted"}
TOMBSTONE_ATTRIBUTE = "deletion_started_at"
FIXTURE_ATTRIBUTE = "verification_fixture_id"


def table_name(prefix: str, account: str, region: str) -> str:
    return f"{prefix}-voc-projects-{account}-{region}"


def bucket_name(prefix: str, account: str, region: str) -> str:
    return f"{prefix}-voc-raw-data-{account}-{region}"


def is_tombstone(meta: dict) -> bool:
    return TOMBSTONE_ATTRIBUTE in meta or meta.get("status") in TOMBSTONE_STATUSES


def is_fixture(meta: dict) -> bool:
    return FIXTURE_ATTRIBUTE in meta


def scan_all(table) -> Iterator[dict]:
    """Yield every item in a table, following pagination."""
    kwargs: dict = {}
    while True:
        resp = table.scan(**kwargs)
        yield from resp.get("Items", [])
        key = resp.get("LastEvaluatedKey")
        if not key:
            return
        kwargs["ExclusiveStartKey"] = key


def live_project_ids(table) -> set[str]:
    """project_ids whose META row is neither a tombstone nor a fixture."""
    ids: set[str] = set()
    for item in scan_all(table):
        if item.get("sk") != "META":
            continue
        if is_tombstone(item) or is_fixture(item):
            continue
        pid = item.get("project_id") or item.get("pk", "").removeprefix("PROJECT#")
        if pid:
            ids.add(pid)
    return ids


def partition_items(table, project_id: str) -> list[dict]:
    """Every item in one project's partition, following pagination."""
    items: list[dict] = []
    kwargs = {"KeyConditionExpression": Key("pk").eq(f"PROJECT#{project_id}")}
    while True:
        resp = table.query(**kwargs)
        items.extend(resp.get("Items", []))
        key = resp.get("LastEvaluatedKey")
        if not key:
            return items
        kwargs["ExclusiveStartKey"] = key


def s3_keys_for_project(items: list[dict], project_id: str, s3, src_bucket: str) -> list[str]:
    """The S3 object keys backing one project's items.

    - avatars/{persona_id}.* for each persona (any extension — list the prefix).
    - prototypes/{project_id}/* for S3-backed prototypes (listed, so legacy
      inline ones with no object are simply absent).
    - projects/{project_id}/product_docs/** for uploaded product docs.
    """
    keys: list[str] = []
    persona_ids = [
        it["sk"].removeprefix("PERSONA#")
        for it in items
        if it.get("sk", "").startswith("PERSONA#")
    ]
    for pid in persona_ids:
        keys.extend(_list_prefix(s3, src_bucket, f"avatars/{pid}."))
    keys.extend(_list_prefix(s3, src_bucket, f"prototypes/{project_id}/"))
    keys.extend(_list_prefix(s3, src_bucket, f"projects/{project_id}/product_docs/"))
    return keys


def _list_prefix(s3, bucket: str, prefix: str) -> list[str]:
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


def copy_project(table_tgt, src_items: list[dict], apply: bool) -> int:
    if not apply:
        return len(src_items)
    with table_tgt.batch_writer() as batch:
        for item in src_items:
            batch.put_item(Item=item)
    return len(src_items)


def copy_s3_objects(s3, src_bucket: str, tgt_bucket: str, keys: list[str], apply: bool) -> int:
    if not apply:
        return len(keys)
    copied = 0
    for key in keys:
        # Server-side copy; target bucket's default KMS key re-encrypts.
        s3.copy_object(
            Bucket=tgt_bucket,
            Key=key,
            CopySource={"Bucket": src_bucket, "Key": key},
        )
        copied += 1
    return copied


def rollback(table_tgt, s3, tgt_bucket, project_ids: set[str], apply: bool) -> dict[str, int]:
    stats = {"items_deleted": 0, "objects_deleted": 0}
    for pid in project_ids:
        items = partition_items(table_tgt, pid)
        if apply:
            with table_tgt.batch_writer() as batch:
                for it in items:
                    batch.delete_item(Key={"pk": it["pk"], "sk": it["sk"]})
        stats["items_deleted"] += len(items)
        keys = s3_keys_for_project(items, pid, s3, tgt_bucket)
        for key in keys:
            if apply:
                s3.delete_object(Bucket=tgt_bucket, Key=key)
            stats["objects_deleted"] += 1
    return stats


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-prefix", required=True)
    parser.add_argument("--target-prefix", required=True)
    parser.add_argument("--account", required=True)
    parser.add_argument("--region", default="us-east-1")
    parser.add_argument("--profile", default=None)
    parser.add_argument("--apply", action="store_true", help="Write (default is dry-run).")
    parser.add_argument("--rollback", action="store_true", help="Delete the copied data from the target.")
    args = parser.parse_args()

    if args.source_prefix == args.target_prefix:
        print("Refusing to run: source and target prefixes are identical.")
        return 1

    session = boto3.Session(profile_name=args.profile, region_name=args.region)
    ddb = session.resource("dynamodb")
    s3 = session.client("s3")

    src_table = ddb.Table(table_name(args.source_prefix, args.account, args.region))
    tgt_table = ddb.Table(table_name(args.target_prefix, args.account, args.region))
    src_bucket = bucket_name(args.source_prefix, args.account, args.region)
    tgt_bucket = bucket_name(args.target_prefix, args.account, args.region)
    mode = "APPLY" if args.apply else "DRY-RUN"

    print(f"[{mode}] Projects: {args.source_prefix} -> {args.target_prefix}")

    if args.rollback:
        ids = live_project_ids(src_table)
        print(f"Rolling back {len(ids)} project partitions from the target...")
        stats = rollback(tgt_table, s3, tgt_bucket, ids, args.apply)
        print(f"\n=== Rollback summary ({mode}) ===")
        print(f"  items deleted  : {stats['items_deleted']}")
        print(f"  objects deleted: {stats['objects_deleted']}")
        return 0

    ids = sorted(live_project_ids(src_table))
    print(f"Found {len(ids)} live projects on {args.source_prefix}.\n")

    total_items = 0
    total_objects = 0
    for pid in ids:
        items = partition_items(src_table, pid)
        keys = s3_keys_for_project(items, pid, s3, src_bucket)
        name = next((it.get("name") for it in items if it.get("sk") == "META"), "?")
        n_items = copy_project(tgt_table, items, args.apply)
        n_objs = copy_s3_objects(s3, src_bucket, tgt_bucket, keys, args.apply)
        total_items += n_items
        total_objects += n_objs
        print(f"  {pid}  \"{name}\"  — {n_items} items, {n_objs} S3 objects")

    print(f"\n=== Summary ({mode}) ===")
    print(f"  projects      : {len(ids)}")
    print(f"  DynamoDB items: {total_items}")
    print(f"  S3 objects    : {total_objects}"
          + ("" if args.apply else "  (dry-run: nothing written)"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
