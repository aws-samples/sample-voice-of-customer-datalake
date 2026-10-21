#!/usr/bin/env python3
"""One-time backfill of `custom_fields` onto already-stored feedback records.

Why this exists
---------------
Bulk imports through the s3_import plugin used to drop each record's `metadata`
map before it reached the processor, so historical records were written with no
`custom_fields` attribute (and the admin-pickable import filters had nothing to
offer). The ingest path is now fixed, but the processor's content-addressed
idempotency (source_platform:id) means a plain re-import SKIPS existing records
as duplicates — so new ingests get custom_fields, but the already-stored corpus
cannot be backfilled by re-importing.

This script backfills them in place, cheaply: it joins the ORIGINAL source file
(which still carries each record's `metadata`) to the stored records by
`source_id`, rebuilds `custom_fields` with the SAME sanitizer the processor uses,
and writes just that one attribute with `update_item`. No reprocessing, no
Comprehend/Bedrock spend, no delete, no dedup fight.

Safety
------
- Dry-run by default. Pass --apply to actually write.
- Only touches records that MATCH the source file by source_id AND currently
  lack custom_fields (idempotent: re-running skips already-backfilled rows).
- Scoped to one feedback table (pass the exact deployment-prefixed name).

Usage
-----
    python scripts/backfill_custom_fields.py \
        --table d-voc-feedback-459119164048-us-east-1 \
        --source-file /path/to/august_feedback.json \
        [--region us-east-1] [--profile KiroAccess] [--apply]

The sanitizer (`build_custom_fields`) and its caps are a FAITHFUL copy of
`_build_custom_fields` / MAX_CUSTOM_FIELD_* in lambda/processor/handler.py —
restated here because this standalone script does not import the processor
bundle. Keep the two in step.
"""
from __future__ import annotations

import argparse
import json
import sys
from decimal import Decimal
from typing import Any

import boto3

# Mirror lambda/processor/handler.py (source of truth). See module docstring.
MAX_CUSTOM_FIELD_KEYS = 20
MAX_CUSTOM_FIELD_VALUE_LENGTH = 1000
MAX_CUSTOM_FIELD_KEY_LENGTH = 64


def build_custom_fields(metadata: Any) -> dict | None:
    """Sanitize import metadata into a DynamoDB-safe map.

    Faithful copy of `_build_custom_fields` in the processor: keep only primitive
    values (floats -> Decimal), skip over-long keys and non-primitive values, cap
    the number of keys, and return None when nothing survives so the caller can
    skip the record entirely.
    """
    if not isinstance(metadata, dict) or not metadata:
        return None

    cleaned: dict = {}
    for key, value in metadata.items():
        if len(cleaned) >= MAX_CUSTOM_FIELD_KEYS:
            break
        if not isinstance(key, str) or not key or len(key) > MAX_CUSTOM_FIELD_KEY_LENGTH:
            continue
        if value is None or isinstance(value, bool):
            cleaned[key] = value
        elif isinstance(value, int):
            cleaned[key] = value
        elif isinstance(value, float):
            cleaned[key] = Decimal(str(round(value, 6)))
        elif isinstance(value, str):
            cleaned[key] = value[:MAX_CUSTOM_FIELD_VALUE_LENGTH]
        # Anything else (nested dict/list) is skipped — matches the processor.

    return cleaned or None


def load_metadata_by_id(source_file: str) -> dict[str, dict]:
    """Build an id -> metadata map from the original source file.

    Accepts a `{"items": [...]}` envelope or a bare list, matching the import
    parser. Only records with a dict `metadata` are kept.
    """
    with open(source_file, encoding="utf-8") as fh:
        data = json.load(fh)
    if isinstance(data, dict) and isinstance(data.get("items"), list):
        records = data["items"]
    elif isinstance(data, list):
        records = data
    else:
        records = [data]

    by_id: dict[str, dict] = {}
    for rec in records:
        if not isinstance(rec, dict):
            continue
        rid = rec.get("id")
        meta = rec.get("metadata")
        if rid and isinstance(meta, dict) and meta:
            by_id[str(rid)] = meta
    return by_id


def iter_records_missing_custom_fields(table):
    """Yield (pk, sk, source_id) for stored items that have no custom_fields."""
    scan_kwargs = {
        "FilterExpression": "attribute_not_exists(custom_fields) AND attribute_exists(source_id)",
        "ProjectionExpression": "pk, sk, source_id",
    }
    start_key = None
    while True:
        if start_key:
            scan_kwargs["ExclusiveStartKey"] = start_key
        resp = table.scan(**scan_kwargs)
        for item in resp.get("Items", []):
            yield item["pk"], item["sk"], item.get("source_id")
        start_key = resp.get("LastEvaluatedKey")
        if not start_key:
            break


def backfill(table, metadata_by_id: dict[str, dict], apply: bool) -> dict[str, int]:
    stats = {"scanned": 0, "matched": 0, "updated": 0, "no_metadata": 0, "no_match": 0}
    for pk, sk, source_id in iter_records_missing_custom_fields(table):
        stats["scanned"] += 1
        meta = metadata_by_id.get(str(source_id)) if source_id else None
        if not meta:
            stats["no_match"] += 1
            continue
        custom_fields = build_custom_fields(meta)
        if custom_fields is None:
            stats["no_metadata"] += 1
            continue
        stats["matched"] += 1
        if apply:
            # Guard the write with the same precondition we scanned on, so a
            # concurrent reprocess that already added custom_fields is not
            # clobbered (and re-running the script stays idempotent).
            table.update_item(
                Key={"pk": pk, "sk": sk},
                UpdateExpression="SET custom_fields = :cf",
                ConditionExpression="attribute_not_exists(custom_fields)",
                ExpressionAttributeValues={":cf": custom_fields},
            )
            stats["updated"] += 1
        if stats["scanned"] % 2000 == 0:
            print(f"  ...scanned {stats['scanned']}, matched {stats['matched']}, "
                  f"updated {stats['updated']}", flush=True)
    return stats


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--table", required=True, help="Exact feedback table name (prefixed).")
    parser.add_argument("--source-file", required=True, help="Original import JSON with per-record metadata.")
    parser.add_argument("--region", default="us-east-1")
    parser.add_argument("--profile", default=None)
    parser.add_argument("--apply", action="store_true", help="Write changes (default is dry-run).")
    args = parser.parse_args()

    session = boto3.Session(profile_name=args.profile, region_name=args.region)
    table = session.resource("dynamodb").Table(args.table)

    print(f"Loading metadata from {args.source_file} ...", flush=True)
    metadata_by_id = load_metadata_by_id(args.source_file)
    print(f"  {len(metadata_by_id)} records with metadata in source file.", flush=True)

    mode = "APPLY" if args.apply else "DRY-RUN"
    print(f"[{mode}] Backfilling custom_fields on {args.table} ...", flush=True)
    stats = backfill(table, metadata_by_id, args.apply)

    print("\n=== Summary ===")
    print(f"  records missing custom_fields scanned : {stats['scanned']}")
    print(f"  matched source metadata               : {stats['matched']}")
    print(f"  no matching id in source file         : {stats['no_match']}")
    print(f"  matched but metadata sanitized to none: {stats['no_metadata']}")
    print(f"  updated                               : {stats['updated']}"
          + ("" if args.apply else "  (dry-run: nothing written)"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
