#!/usr/bin/env python3
"""Backfill the creator index of global MCP tokens (``/connect/tokens``).

Since this release every global token is minted together with a keys-only pointer
row, ``pk=MCPGTOKEN, sk=CREATOR#{sub}#TOKEN#{token_id}``, so "my tokens" is a
key-condition Query on the caller's prefix instead of a filtered read of the whole
``MCPGTOKEN`` partition (lambda/shared/mcp_global_tokens.py). Tokens minted BEFORE
the deploy have no pointer; until this script has run, the list route also reads
the old layout and merges, so nothing disappears in between.

This script, for one deployment:

1. reads every ``TOKEN#`` row of the ``MCPGTOKEN`` partition (a Query, not a Scan);
2. for each row with a usable ``token_id``/``created_by`` READS its pointer, and
   writes it only when absent — conditionally (``attribute_not_exists(sk)``), so a
   pointer minted concurrently is never overwritten;
3. when every row was indexed (none skipped as malformed, none failed), writes the
   ``MIGRATION#creator-index`` marker, which switches the list route to the index
   alone.

DRY RUN BY DEFAULT: it reads and reports. Pass ``--apply`` to write. Idempotent:
re-running writes nothing new. It never updates or deletes a token row.

Run it AFTER the release is fully deployed (an old Lambda still minting would
create rows without pointers after the marker).

Usage:
    python scripts/mcp_tokens/backfill_creator_index.py [--stack VocCoreStack] [--region eu-west-1]
    python scripts/mcp_tokens/backfill_creator_index.py --projects-table NAME --apply
"""
from __future__ import annotations

import argparse
import sys
from collections.abc import Iterator
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from botocore.exceptions import ClientError

# `lambda/`, so the key builders below are the ones the handler uses.
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'lambda'))

from shared import mcp_global_tokens as gt

FRESH_SORT_KEY = 'attribute_not_exists(sk)'


@dataclass
class Report:
    token_rows: int = 0
    already_indexed: int = 0
    pointers_missing: int = 0
    pointers_written: int = 0
    # Written by a concurrent mint between the read and the conditional put.
    pointers_raced: int = 0
    skipped_malformed: int = 0
    marker_present: bool = False
    marker_written: bool = False


def _token_rows(table: Any) -> Iterator[dict]:
    """Every ``TOKEN#`` row of the global partition, following pagination."""
    from boto3.dynamodb.conditions import Key  # deferred: importable without boto3 config

    kwargs: dict[str, Any] = {
        'KeyConditionExpression': Key('pk').eq(gt.GLOBAL_TOKEN_PK) & Key('sk').begins_with(gt.token_sk('')),
        'ConsistentRead': True,
    }
    while True:
        response = table.query(**kwargs)
        yield from (item for item in response.get('Items', []) if isinstance(item, dict))
        last_key = response.get('LastEvaluatedKey')
        if not last_key:
            return
        kwargs['ExclusiveStartKey'] = last_key


def _put_if_absent(table: Any, item: dict) -> bool:
    """Conditional put; False when the row appeared meanwhile (nothing overwritten)."""
    try:
        table.put_item(Item=item, ConditionExpression=FRESH_SORT_KEY)
    except ClientError as error:
        if error.response.get('Error', {}).get('Code') == 'ConditionalCheckFailedException':
            return False
        raise
    return True


def _pointer_for(row: dict) -> dict | None:
    token_id, subject = row.get('token_id'), row.get('created_by')
    if not gt.is_path_id(token_id) or not isinstance(subject, str):
        return None
    try:
        return gt.creator_index_item(subject, str(token_id), str(row.get('created_at') or ''))
    except ValueError:
        return None


def run(table: Any, apply: bool, now: datetime | None = None) -> Report:
    report = Report()
    for row in _token_rows(table):
        report.token_rows += 1
        pointer = _pointer_for(row)
        if pointer is None:
            report.skipped_malformed += 1
            continue
        existing = table.get_item(Key={'pk': pointer['pk'], 'sk': pointer['sk']}, ConsistentRead=True).get('Item')
        if existing:
            report.already_indexed += 1
            continue
        report.pointers_missing += 1
        if not apply:
            continue
        if _put_if_absent(table, pointer):
            report.pointers_written += 1
        else:
            report.pointers_raced += 1

    marker_key = {'pk': gt.GLOBAL_TOKEN_PK, 'sk': gt.CREATOR_INDEX_MARKER_SK}
    report.marker_present = bool(table.get_item(Key=marker_key, ConsistentRead=True).get('Item'))
    # Only a complete pass may switch the list route off the old layout.
    complete = (report.skipped_malformed == 0
                and report.pointers_written + report.pointers_raced == report.pointers_missing)
    if apply and complete and not report.marker_present:
        stamp = (now or datetime.now(UTC)).isoformat()
        report.marker_written = _put_if_absent(table, {**marker_key, 'completed_at': stamp,
                                                       'token_rows': report.token_rows})
    return report


def _projects_table_name(session: Any, stack: str) -> str:
    outputs = session.client('cloudformation').describe_stacks(StackName=stack)['Stacks'][0].get('Outputs', [])
    for output in outputs:
        if output.get('OutputKey') == 'ProjectsTableName':
            return output['OutputValue']
    raise SystemExit(f'{stack} has no ProjectsTableName output; pass --projects-table')


def parse_args(argv: list[str] | None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=(__doc__ or '').split('\n\n')[0])
    parser.add_argument('--stack', default='VocCoreStack', help='core stack to read the table name from')
    parser.add_argument('--projects-table', help='voc-projects table name (overrides --stack)')
    parser.add_argument('--region', help='AWS region (default: the configured one)')
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument('--dry-run', dest='apply', action='store_false', help='read and report only (the default)')
    mode.add_argument('--apply', dest='apply', action='store_true', help='write the pointers and the marker')
    parser.set_defaults(apply=False)
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    import boto3  # deferred so the module imports (and its tests run) without AWS config

    session = boto3.session.Session(region_name=args.region)
    table_name = args.projects_table or _projects_table_name(session, args.stack)
    report = run(session.resource('dynamodb').Table(table_name), args.apply)

    print('APPLIED' if args.apply else 'DRY RUN (pass --apply to write)')
    print(f'  token rows read:        {report.token_rows}')
    print(f'  already indexed:        {report.already_indexed}')
    print(f'  pointers missing:       {report.pointers_missing} (written {report.pointers_written},'
          f' raced {report.pointers_raced})')
    print(f'  skipped (malformed):    {report.skipped_malformed}')
    marker = 'present' if report.marker_present else ('written' if report.marker_written else 'not written')
    print(f'  completion marker:      {marker}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
