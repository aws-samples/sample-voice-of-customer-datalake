"""List the owners of the workspace conversations kept before 7.19.00 (docs/multi-workspace.md, "Upgrading").

Since 7.19.00 every save of a conversation inside a workspace first lists its owner in the workspace's list of
conversation owners, ``WS#{ws}#CONVERSANTS`` / ``{sub}`` with ``first_at`` in voc-conversations
(``shared/conversations.py``), so the workspace's export and delete find every ``WS#{ws}#USER#{sub}`` partition with
one Query. Conversations kept inside a workspace from 7.15.00 to 7.18.00 have no such row. This script, once, for one
deployment:

1. scans voc-conversations for the conversation rows (``sk CONV#…``) of ``WS#{ws}#USER#{sub}`` partitions (one paged
   Scan, the only read of the whole table; the other partitions are not returned);
2. takes each owner's earliest ``created_at`` there as their ``first_at`` (the run's time when none is stored);
3. with ``--apply``, puts each owner's row if absent, through the same writer the chat routes use
   (``record_conversant``: a conditional PutItem, so a row a save wrote meanwhile, or an earlier run, is kept as it
   is and nothing is duplicated). It never changes or deletes a conversation.

DRY RUN BY DEFAULT: it reads, then prints each owner it would list and a summary. Idempotent: a second run lists
nobody. Needed only for a deployment that ran 7.15.00 to 7.18.00 with workspaces; a fresh deployment (decision 21)
has nothing to list.

Usage (from voc-datalake/):
    .venv/bin/python scripts/conversations/backfill_conversants.py [--stack VocCoreStack] [--region us-west-2]
    .venv/bin/python scripts/conversations/backfill_conversants.py --conversations-table NAME --apply
Table name: the flag, else the CONVERSATIONS_TABLE environment, else the core stack's ConversationsTableName output.
"""
from __future__ import annotations

import argparse
import os
import sys
from collections.abc import Callable, Iterator
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

# `lambda/`, so the keys and the writer are the ones the chat routes use.
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'lambda'))

from shared.conversations import CONVERSATION_SK_PREFIX, conversant_key, conversation_partition, record_conversant
from shared.dynamo_paging import iter_query
from shared.ws_repo import WORKSPACE_KEY_PREFIX, WorkspaceScope, partition_scope, ws_table


@dataclass
class Report:
    #: Conversation rows of workspace partitions the scan returned.
    conversations: int = 0
    #: Distinct (workspace, person) pairs among them.
    owners: int = 0
    listed: int = 0
    already_listed: int = 0
    #: Rows under ``WS#`` that are not a member's conversation partition (or name no workspace): left alone.
    skipped: int = 0


@dataclass(frozen=True)
class Owner:
    scope: WorkspaceScope
    sub: str


def owner_of(partition: object) -> Owner | None:
    """The owner a ``WS#{ws}#USER#{sub}`` partition belongs to, else None (another row, or a malformed key)."""
    try:
        scope = partition_scope(partition)
    except ValueError:
        return None
    if scope is None or not isinstance(partition, str):
        return None
    prefix = f'{scope.prefix}USER#'
    sub = partition[len(prefix):] if partition.startswith(prefix) else ''
    if not sub or conversation_partition(sub, scope) != partition:
        return None
    return Owner(scope, sub)


def workspace_conversations(table: Any) -> Iterator[dict]:
    """Every conversation row (``CONV#…``) of a ``WS#…`` partition, every page of one Scan (paged by the layer's
    ``iter_query``, which follows ``LastEvaluatedKey`` the same way for a Scan)."""
    from boto3.dynamodb.conditions import Attr  # deferred: importable without AWS config

    return iter_query(_ScanPages(table), {
        'FilterExpression': Attr('pk').begins_with(WORKSPACE_KEY_PREFIX) & Attr('sk').begins_with(CONVERSATION_SK_PREFIX),
        'ProjectionExpression': '#pk, #sk, #created',
        'ExpressionAttributeNames': {'#pk': 'pk', '#sk': 'sk', '#created': 'created_at'},
    })


class _ScanPages:
    """A table whose ``query`` is its ``scan``, for ``iter_query``'s paging."""

    def __init__(self, table: Any) -> None:
        self.query = table.scan


def find_owners(table: Any, report: Report) -> dict[Owner, str | None]:
    """Each owner with the earliest ``created_at`` of their conversations there (None when none stores one)."""
    owners: dict[Owner, str | None] = {}
    for row in workspace_conversations(table):
        owner = owner_of(row.get('pk'))
        if owner is None:
            report.skipped += 1
            continue
        report.conversations += 1
        earliest = owners.setdefault(owner, None)
        created = row.get('created_at')
        if isinstance(created, str) and created and (earliest is None or created < earliest):
            owners[owner] = created
    report.owners = len(owners)
    return owners


def is_listed(table: Any, owner: Owner) -> bool:
    """Whether the owner's row is already there (the dry run's report; ``--apply`` relies on the put's condition)."""
    view = ws_table(owner.scope, table)
    return 'Item' in view.get_item(conversant_key(owner.scope, owner.sub), ConsistentRead=True,
                                   ProjectionExpression='#pk', ExpressionAttributeNames={'#pk': 'pk'})


def run(table: Any, *, apply: bool, now: Callable[[], str] = lambda: datetime.now(UTC).isoformat(),
        out: Callable[[str], None] = print) -> Report:
    report = Report()
    owners = find_owners(table, report)
    for owner, first_at in sorted(owners.items(), key=lambda entry: (entry[0].scope.ws, entry[0].sub)):
        stamp = first_at or now()
        if apply:
            written = record_conversant(ws_table(owner.scope, table), owner.sub, stamp)
        else:
            written = not is_listed(table, owner)
        if written:
            report.listed += 1
            out(f'{owner.scope.ws}  {owner.sub}  first_at {stamp}')
        else:
            report.already_listed += 1
    return report


#: The core stack's output naming voc-conversations (core-stack.ts).
TABLE_OUTPUT = 'ConversationsTableName'


def parse_args(argv: list[str] | None) -> argparse.Namespace:
    """The command line: a dry run unless ``--apply``."""
    parser = argparse.ArgumentParser(description='List the owners of workspace conversations kept before 7.19.00.')
    parser.add_argument('--apply', action='store_true', help='write the missing owner rows (default: dry run)')
    parser.add_argument('--conversations-table', default=os.environ.get('CONVERSATIONS_TABLE'),
                        help=f'table name (default: CONVERSATIONS_TABLE, else the stack output {TABLE_OUTPUT})')
    parser.add_argument('--stack', default='VocCoreStack', help='core stack holding that output')
    parser.add_argument('--region', help='AWS region (default: the configured one)')
    return parser.parse_args(argv)


def table_name(args: argparse.Namespace, cloudformation: Any) -> str:
    """The flag or the environment, else the core stack's output; exits when none names the table."""
    if args.conversations_table:
        return str(args.conversations_table)
    stack = cloudformation.describe_stacks(StackName=args.stack)['Stacks'][0]
    name = next((o.get('OutputValue') for o in stack.get('Outputs', []) if o.get('OutputKey') == TABLE_OUTPUT), None)
    if not name:
        raise SystemExit(f'{args.stack} has no {TABLE_OUTPUT} output; pass --conversations-table')
    return str(name)


def summary(report: Report, apply: bool) -> str:
    """One line for the end of the run."""
    verb = 'listed' if apply else 'would list (dry run; --apply writes)'
    return (f'{report.conversations} workspace conversations, {report.owners} owners: {verb} {report.listed}, '
            f'{report.already_listed} already listed, {report.skipped} other WS# rows left alone')


def main(argv: list[str] | None = None) -> int:
    """Resolve the table, run once, print the summary."""
    options = parse_args(argv)
    import boto3  # deferred: the module imports, and its tests run, with no AWS configuration

    aws = boto3.session.Session(region_name=options.region)
    conversations = aws.resource('dynamodb').Table(table_name(options, aws.client('cloudformation')))
    print(summary(run(conversations, apply=options.apply), options.apply))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
