#!/usr/bin/env python3
"""Migrate an existing deployment to "nothing is ever deleted".

Before this change the processor stamped every voc-feedback item with
`ttl = now + 365 days` and the aggregator stamped every METRIC# aggregate row with
`ttl = now + 90 days`. New code stamps neither, and the CDK disables TTL on the
feedback table — but rows written BEFORE the deploy still carry the attribute,
and the aggregates table keeps TTL ENABLED (its operational rows still expire),
so those METRIC# rows would keep being deleted on schedule.

This script, for one deployment:

1. REMOVEs `ttl` from every voc-feedback item that has one;
2. REMOVEs `ttl` from every `METRIC#…` row in voc-aggregates that has one
   (other rows — processor logs, voting sessions — keep theirs);
3. lowers the earliest-data watermark (`METRIC#meta / earliest_date`) to the oldest
   `date` found in step 1, so `days=0` (all time) covers the whole history.

DRY RUN BY DEFAULT: it scans and reports what it would change. Pass `--apply` to
write. Every write is conditional and idempotent, so it is safe to re-run or to
interrupt. It never deletes anything.

Run it promptly after deploying: until it has run, METRIC# rows older than the
deploy keep ageing out of voc-aggregates.

Usage:
    python scripts/retention/remove_ttl.py [--stack VocCoreStack] [--region us-east-1]
    python scripts/retention/remove_ttl.py --feedback-table T1 --aggregates-table T2 --apply
"""
from __future__ import annotations

import sys
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

# `shared.earliest_date` owns the watermark's key and its conditional update; the
# aggregator uses the same module, so the two cannot disagree about either.
# `retention_common` puts `lambda/` on the path for it.
sys.path.insert(0, str(Path(__file__).resolve().parent))

from retention_common import is_conditional_failure as _is_conditional_failure
from retention_common import resolve_tables, table_parser
from retention_common import scan_all as _scan

from shared.earliest_date import EARLIEST_DATE_PK, lower_watermark_request, parse_iso_date

TTL_ATTRIBUTE = 'ttl'
METRIC_PREFIX = 'METRIC#'


@dataclass
class Report:
    feedback_scanned: int = 0
    feedback_with_ttl: int = 0
    feedback_updated: int = 0
    aggregate_rows_with_ttl: int = 0
    aggregate_rows_updated: int = 0
    earliest_date: str | None = None
    watermark_written: bool = False


def _remove_ttl(table, key: dict) -> bool:
    """REMOVE `ttl` from one existing row. False if the row vanished meanwhile
    (TTL may have deleted it between the scan and this write)."""
    try:
        table.update_item(
            Key=key,
            UpdateExpression='REMOVE #ttl',
            ConditionExpression='attribute_exists(pk)',
            ExpressionAttributeNames={'#ttl': TTL_ATTRIBUTE},
        )
    except Exception as error:  # botocore ClientError; imported lazily with boto3
        if _is_conditional_failure(error):
            return False
        raise
    return True


def migrate_feedback(feedback_table, report: Report, apply: bool) -> None:
    """Strip `ttl` from feedback items and find the oldest `date`."""
    items = _scan(
        feedback_table,
        ProjectionExpression='pk, sk, #ttl, #date',
        ExpressionAttributeNames={'#ttl': TTL_ATTRIBUTE, '#date': 'date'},
    )
    for item in items:
        report.feedback_scanned += 1
        day = item.get('date')
        if (isinstance(day, str) and parse_iso_date(day) is not None
                and (report.earliest_date is None or day < report.earliest_date)):
            report.earliest_date = day
        if TTL_ATTRIBUTE not in item:
            continue
        report.feedback_with_ttl += 1
        if apply and _remove_ttl(feedback_table, {'pk': item['pk'], 'sk': item['sk']}):
            report.feedback_updated += 1


def migrate_aggregates(aggregates_table, report: Report, apply: bool) -> None:
    """Strip `ttl` from METRIC# aggregate rows only."""
    rows = _scan(
        aggregates_table,
        ProjectionExpression='pk, sk',
        FilterExpression='begins_with(pk, :metric) AND attribute_exists(#ttl) AND pk <> :meta',
        ExpressionAttributeNames={'#ttl': TTL_ATTRIBUTE},
        ExpressionAttributeValues={':metric': METRIC_PREFIX, ':meta': EARLIEST_DATE_PK},
    )
    for row in rows:
        report.aggregate_rows_with_ttl += 1
        if apply and _remove_ttl(aggregates_table, {'pk': row['pk'], 'sk': row['sk']}):
            report.aggregate_rows_updated += 1


def write_watermark(aggregates_table, report: Report, apply: bool,
                    now: Callable[[], datetime] = lambda: datetime.now(UTC)) -> None:
    """Lower the earliest-date watermark to the oldest feedback date (conditional)."""
    if not apply or report.earliest_date is None:
        return
    try:
        aggregates_table.update_item(**lower_watermark_request(report.earliest_date, now().isoformat()))
    except Exception as error:
        if _is_conditional_failure(error):
            return  # the stored watermark is already as old or older
        raise
    report.watermark_written = True


def run(feedback_table, aggregates_table, apply: bool) -> Report:
    report = Report()
    migrate_feedback(feedback_table, report, apply)
    migrate_aggregates(aggregates_table, report, apply)
    write_watermark(aggregates_table, report, apply)
    return report


def main(argv: list[str] | None = None) -> int:
    args = table_parser((__doc__ or '').split('\n\n')[0]).parse_args(argv)
    session = resolve_tables(args)

    dynamodb = session.resource('dynamodb')
    report = run(dynamodb.Table(args.feedback_table), dynamodb.Table(args.aggregates_table), args.apply)

    mode = 'APPLIED' if args.apply else 'DRY RUN (pass --apply to write)'
    print(mode)
    print(f'  feedback items scanned:      {report.feedback_scanned}')
    print(f'  feedback items with ttl:     {report.feedback_with_ttl} (updated {report.feedback_updated})')
    print(f'  METRIC# rows with ttl:       {report.aggregate_rows_with_ttl} (updated {report.aggregate_rows_updated})')
    print(f'  earliest feedback date:      {report.earliest_date or "none found"}'
          f'{" (watermark lowered)" if report.watermark_written else ""}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
