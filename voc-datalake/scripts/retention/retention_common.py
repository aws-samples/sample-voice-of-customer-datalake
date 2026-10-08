"""What the retention scripts share: the table CLI, a paged Scan, and the conditional-failure test.

`remove_ttl.py` and `rebuild_aggregates.py` take the same table arguments and resolve
them the same way (explicit names, else the core stack's outputs), so an operator who
has run one can run the other. Both scripts put this directory on `sys.path` before
importing it, because `scripts/` is not a package.
"""
from __future__ import annotations

import argparse
import sys
from collections.abc import Iterator
from pathlib import Path
from typing import Any

# `lambda/`, so the scripts can import `shared.*` (and `aggregator.*`) after this module.
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'lambda'))


def scan_all(table, **kwargs: Any) -> Iterator[dict]:
    """Every item a Scan returns, following LastEvaluatedKey."""
    while True:
        response = table.scan(**kwargs)
        yield from response.get('Items', [])
        last_key = response.get('LastEvaluatedKey')
        if not last_key:
            return
        kwargs['ExclusiveStartKey'] = last_key


def is_conditional_failure(error: Exception) -> bool:
    """True for DynamoDB's ConditionalCheckFailedException (botocore is imported lazily)."""
    response = getattr(error, 'response', None)
    code = response.get('Error', {}).get('Code') if isinstance(response, dict) else None
    return code == 'ConditionalCheckFailedException'


def table_parser(description: str) -> argparse.ArgumentParser:
    """The shared CLI: --stack / --feedback-table / --aggregates-table / --region / --apply."""
    parser = argparse.ArgumentParser(description=description)
    parser.add_argument('--stack', default='VocCoreStack', help='core stack to read table names from')
    parser.add_argument('--feedback-table', help='voc-feedback table name (overrides --stack)')
    parser.add_argument('--aggregates-table', help='voc-aggregates table name (overrides --stack)')
    parser.add_argument('--region', help='AWS region (default: the configured one)')
    parser.add_argument('--apply', action='store_true', help='write the changes (default: dry run)')
    return parser


def _stack_output(cloudformation, stack: str, key: str) -> str:
    outputs = cloudformation.describe_stacks(StackName=stack)['Stacks'][0].get('Outputs', [])
    for output in outputs:
        if output.get('OutputKey') == key:
            return output['OutputValue']
    raise SystemExit(f'{stack} has no {key} output; pass the table names explicitly')


def resolve_tables(args: argparse.Namespace):
    """A boto3 session for `--region`, with the two table names filled in on `args`."""
    import boto3  # deferred so the scripts import (and their tests run) without AWS config

    session = boto3.session.Session(region_name=args.region)
    if not (args.feedback_table and args.aggregates_table):
        cloudformation = session.client('cloudformation')
        args.feedback_table = args.feedback_table or _stack_output(cloudformation, args.stack, 'FeedbackTableName')
        args.aggregates_table = args.aggregates_table or _stack_output(cloudformation, args.stack, 'AggregatesTableName')
    return session
