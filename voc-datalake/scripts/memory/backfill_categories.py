#!/usr/bin/env python3
"""Backfill the category tags of memories written before every write was tagged (docs/memory.md "Category tags").

A memory's ``categories`` tags decide who may read it (``memory_store.visible_to``): a reader
restricted to some categories never sees a memory tagged with another. Memories written
before 5.19 were tagged only when the extractor's model answered or the statement NAMED a
category, so a memory about one in other words ("Broken components are the most reported
problem") reached restricted readers. This script, for one deployment:

1. scans ``voc-memory`` for every memory row (company and personal, every status) whose
   ``categories`` are missing or empty;
2. classifies each statement with the SAME function the API uses on a write
   (``shared.memory_categories.classify_statement``: one model call on the ``memory``
   surface, closed list of the configured categories, plus the name match; a model failure
   falls back to the name match);
3. with ``--apply``, writes ONLY the ``categories`` attribute, with a condition that the item
   still exists and still has no tags — an existing tag is never overwritten, nothing else
   (statement, status, timestamps) is touched.

DRY RUN BY DEFAULT: it reads, classifies (Bedrock calls) and prints, per memory, its id, scope,
the first 80 characters and the proposed tags, then a summary. Idempotent and resumable: a
re-run only revisits what is still untagged (a memory the model leaves untagged — about the
company in general — is classified again on the next run; nothing is written for it).

Usage (from voc-datalake/):
    .venv/bin/python scripts/memory/backfill_categories.py [--stack VocCoreStack] [--region us-west-2]
    .venv/bin/python scripts/memory/backfill_categories.py --memory-table NAME --aggregates-table NAME --apply
Table names: the flags, else the MEMORY_TABLE / AGGREGATES_TABLE environment, else the core
stack's MemoryTableName / AggregatesTableName outputs.
"""
from __future__ import annotations

import argparse
import os
import sys
from collections.abc import Callable, Iterator, Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from botocore.exceptions import ClientError

# `lambda/`, so the classifier and the key layout are the ones the API uses.
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'lambda'))

from shared import memory_store as store
from shared.category_gate import CATEGORIES_PK, CATEGORIES_SK
from shared.logging import logger
from shared.memory_categories import CategoryTags, classify_statement

PREVIEW_CHARS = 80
PROJECTION = ('pk', 'sk', 'memory_id', 'scope', 'status', 'statement', 'categories')
STILL_UNTAGGED = 'attribute_exists(pk) AND (attribute_not_exists(categories) OR size(categories) = :zero)'

Classifier = Callable[[str, list[dict]], CategoryTags]


@dataclass
class Report:
    scanned: int = 0
    tagged: int = 0
    untagged: int = 0
    # The model could not answer; the name match alone was used (the memory may still be tagged).
    model_failures: int = 0
    # Tagged meanwhile by another writer: the condition kept that tag.
    raced: int = 0
    write_failures: int = 0


def is_untagged(row: Mapping[str, Any]) -> bool:
    categories = row.get('categories')
    return not (isinstance(categories, list) and categories)


def untagged_memories(table: Any) -> Iterator[dict]:
    """Every memory row (``MEM#company`` / ``MEM#user#…`` partitions, ``MEM#`` sort keys) without tags."""
    from boto3.dynamodb.conditions import Attr  # deferred: importable without AWS config

    names = {f'#p{i}': name for i, name in enumerate(PROJECTION)}
    kwargs: dict[str, Any] = {
        'FilterExpression': Attr('pk').begins_with('MEM#') & Attr('sk').begins_with(store.MEMORY_SK_PREFIX)
        & (Attr('categories').not_exists() | Attr('categories').size().eq(0)),
        'ProjectionExpression': ', '.join(names), 'ExpressionAttributeNames': names,
    }
    while True:
        response = table.scan(**kwargs)
        yield from (row for row in response.get('Items', []) if isinstance(row, dict) and is_untagged(row))
        last_key = response.get('LastEvaluatedKey')
        if not last_key:
            return
        kwargs['ExclusiveStartKey'] = last_key


def read_categories(aggregates: Any) -> list[dict]:
    """The configured categories (strong read); exits when unset — there is nothing to tag with."""
    item = aggregates.get_item(Key={'pk': CATEGORIES_PK, 'sk': CATEGORIES_SK}, ConsistentRead=True).get('Item') or {}
    raw = item.get('categories')
    config = [c for c in raw if isinstance(c, dict) and c.get('name')] if isinstance(raw, list) else []
    if not config:
        raise SystemExit('No categories are configured (SETTINGS#categories): nothing to tag with.')
    return config


def write_tags(table: Any, row: Mapping[str, Any], ids: list[str]) -> bool:
    """SET only ``categories``, if the memory still exists untagged; False when the condition held it back."""
    try:
        table.update_item(
            Key=store.item_key(row), UpdateExpression='SET categories = :c',
            ConditionExpression=STILL_UNTAGGED, ExpressionAttributeValues={':c': ids, ':zero': 0},
        )
    except ClientError as error:
        if error.response.get('Error', {}).get('Code') == 'ConditionalCheckFailedException':
            return False
        raise
    return True


def _line(row: Mapping[str, Any], ids: list[str]) -> str:
    preview = ' '.join(str(row.get('statement') or '').split())[:PREVIEW_CHARS]
    return f"{row.get('memory_id')}  {row.get('scope')}/{row.get('status')}  {preview!r}  -> {ids or '(none)'}"


def _apply(table: Any, row: Mapping[str, Any], ids: list[str], report: Report, out: Callable[[str], None]) -> None:
    try:
        written = write_tags(table, row, ids)
    except ClientError:
        report.write_failures += 1
        out(f"  write failed for {row.get('memory_id')}")
        return
    if written:
        report.tagged += 1
    else:
        report.raced += 1


def run(table: Any, categories: list[dict], *, apply: bool, classify: Classifier = classify_statement,
        out: Callable[[str], None] = print) -> Report:
    report = Report()
    for row in untagged_memories(table):
        report.scanned += 1
        result = classify(str(row.get('statement') or ''), categories)
        report.model_failures += int(result.model_failed)
        out(_line(row, result.ids))
        if not result.ids:
            report.untagged += 1
        elif apply:
            _apply(table, row, result.ids, report, out)
        else:
            report.tagged += 1
    return report


def _stack_output(session: Any, stack: str, key: str) -> str:
    described = session.client('cloudformation').describe_stacks(StackName=stack)['Stacks'][0]
    values = {o.get('OutputKey'): o.get('OutputValue') for o in described.get('Outputs', [])}
    if not values.get(key):
        raise SystemExit(f'{stack} has no {key} output; pass the table name')
    return str(values[key])


def parse_args(argv: list[str] | None) -> argparse.Namespace:
    """The command line (``--dry-run`` is the default; ``--apply`` writes)."""
    parser = argparse.ArgumentParser(description=(__doc__ or '').split('\n\n', 1)[0])
    tables = parser.add_argument_group('tables (default: environment, else the core stack outputs)')
    tables.add_argument('--memory-table', default=os.environ.get('MEMORY_TABLE'), help='voc-memory table name')
    tables.add_argument('--aggregates-table', default=os.environ.get('AGGREGATES_TABLE'),
                        help='voc-aggregates table name (the categories config, the model picker)')
    tables.add_argument('--stack', default='VocCoreStack', help='core stack to read missing table names from')
    parser.add_argument('--region', help='AWS region (default: the configured one)')
    writes = parser.add_mutually_exclusive_group()
    writes.add_argument('--apply', action='store_true', help='write the proposed tags')
    writes.add_argument('--dry-run', action='store_false', dest='apply', help='classify and print only (the default)')
    return parser.parse_args(argv)


def _print_summary(report: Report, apply: bool) -> None:
    rows = [('untagged memories scanned', report.scanned),
            ('tagged' if apply else 'would be tagged', report.tagged),
            ('left untagged', report.untagged),
            ('model failures (name match used)', report.model_failures)]
    if apply:
        rows += [('already tagged meanwhile', report.raced), ('write failures', report.write_failures)]
    print('APPLIED' if apply else 'DRY RUN (pass --apply to write)')
    for label, value in rows:
        print(f'  {label + ":":<34} {value}')


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    import boto3  # deferred so the module imports (and its tests run) without AWS config

    # Per-call Bedrock INFO logs would bury the per-memory lines; warnings (a failed classification) stay.
    logger.setLevel('WARNING')
    if args.region:
        os.environ['AWS_DEFAULT_REGION'] = args.region
    session = boto3.session.Session(region_name=args.region)
    memory_name = args.memory_table or _stack_output(session, args.stack, 'MemoryTableName')
    aggregates_name = args.aggregates_table or _stack_output(session, args.stack, 'AggregatesTableName')
    # The model picker (shared/model_config.py) reads its per-surface choice from here, as the Lambdas do.
    os.environ['AGGREGATES_TABLE'] = aggregates_name
    dynamodb = session.resource('dynamodb')
    report = run(dynamodb.Table(memory_name), read_categories(dynamodb.Table(aggregates_name)), apply=args.apply)
    _print_summary(report, args.apply)
    return 1 if report.write_failures else 0


if __name__ == '__main__':
    raise SystemExit(main())
