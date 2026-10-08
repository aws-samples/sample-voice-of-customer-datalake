#!/usr/bin/env python3
"""Rebuild the METRIC# aggregate rows from the feedback table, as absolute values.

The supported repair from docs/processing-pipeline.md ("Rebuilding aggregates for a
window"). Use it when the aggregate counters no longer match the feedback they
summarise — on a deployment migrated from the old 90-day TTL, the METRIC# rows of
every date older than ~90 days are simply gone, and `/metrics/*` reports an empty
workspace while `/feedback` still lists every item.

For each date D with dated feedback (optionally limited to `--from`/`--to`):

1. RECOMPUTE FROM SOURCE. Every feedback item is bucketed by the aggregator's own
   `counter_dimensions` (imported from `lambda/aggregator/handler.py`, not
   re-derived), so the rows land on exactly the pks the read paths query: the daily
   total, per source / category / sentiment / persona archetype, `METRIC#urgent`,
   category+sentiment, and per subcategory. The running average
   (`METRIC#daily_sentiment_avg`) gets `sum` and `count` from the items of D that
   carry a non-zero score — the same `if sentiment_score:` rule the aggregator uses.
2. ABSOLUTE `put_item`, NEVER A DELTA: `{pk, sk: D, count, updated_at}` plus
   `metric_type` on the source and persona partitions (the `gsi1-by-metric-type`
   index `/metrics/sources` and `/metrics/personas` read). No `ttl`: metric rows are
   kept indefinitely.
3. ZERO, NEVER DELETE: a METRIC# row already stored for a rebuilt date that the
   recompute did not produce is written with `count: 0` (and `sum: 0` for the
   average), so a bucket that legitimately emptied stops reporting its old count.
4. The earliest-data watermark (`METRIC#meta / earliest_date`) is lowered to the
   oldest rebuilt date, so `days=0` (all time) reaches it.

SAFE NEXT TO THE LIVE AGGREGATOR, and why:

* The aggregator's dedupe claim is per STREAM RECORD (`aggregator#stream#{eventID}`
  in the idempotency table), not per feedback item, and it only guards a redelivered
  INSERT record. The rebuild consumes no stream records, so it has no claim to write;
  later events stay correct on top of absolute values — a new INSERT increments, a
  MODIFY reverses the item's old buckets (which the rebuild counted, being the
  item's current state) and applies the new ones, a REMOVE decrements a row that now
  exists. Rebuilt days also re-enable edits the aggregator was declining on aged-out
  days (`_day_has_aggregates` reads `METRIC#daily_total`).
* An item whose INSERT record is still IN FLIGHT when the rebuild scans it would be
  counted twice (once here, once when the aggregator catches up). Stream records
  live at most 24 hours, so `--apply` refuses to run while any feedback item was
  processed within the last `--settle-hours` (default 24); `--allow-recent`
  overrides after checking the aggregator's IteratorAge is zero.
* An aggregator write landing on a row between this scan and its put would be
  overwritten. Every put is therefore CONDITIONAL on the row being unchanged since
  the rebuild started (`updated_at` older than the start, or absent); a refused put is
  reported as `changed during rebuild` and a re-run recomputes it.

DRY RUN BY DEFAULT: scans and prints a per-dimension summary. `--apply` writes.
Idempotent and resumable: a row already holding its target value is skipped, so a
re-run after an interruption writes only what is still missing. Never deletes.

Usage:
    python scripts/retention/rebuild_aggregates.py [--stack VocCoreStack] [--region us-west-2]
    python scripts/retention/rebuild_aggregates.py --apply --feedback-table T1 --aggregates-table T2
    python scripts/retention/rebuild_aggregates.py --from 2026-02-01 --to 2026-02-28   (one window)
"""
import argparse
import os
import sys
from collections import Counter, defaultdict
from collections.abc import Callable, Iterable
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from pathlib import Path
from types import ModuleType
from typing import Any

# `retention_common` puts `lambda/` on the path for shared.* and aggregator.*.
sys.path.insert(0, str(Path(__file__).resolve().parent))

from retention_common import is_conditional_failure, resolve_tables, scan_all, table_parser

from shared.earliest_date import EARLIEST_DATE_PK, lower_watermark_request, parse_iso_date

METRIC_PREFIX = 'METRIC#'
TTL_ATTRIBUTE = 'ttl'
DEFAULT_SETTLE_HOURS = 24

RowKey = tuple[str, str]  # (pk, sk)


def _aggregator() -> ModuleType:
    """`lambda/aggregator/handler.py`, imported for its bucketing — never re-derived.

    Deferred because the module reads `AGGREGATES_TABLE` at import; `main` sets it
    to the table being rebuilt before the first call.
    """
    from aggregator import handler

    return handler


@dataclass
class Plan:
    """What the recompute found, and what the writes did."""
    feedback_scanned: int = 0
    undated_items: int = 0
    outside_window: int = 0
    recent_items: int = 0
    newest_processed_at: str | None = None
    dates: set[str] = field(default_factory=set)
    targets: dict[RowKey, dict[str, Any]] = field(default_factory=dict)
    existing: dict[RowKey, dict[str, Any]] = field(default_factory=dict)
    untouched_existing_dates: set[str] = field(default_factory=set)
    written: Counter = field(default_factory=Counter)
    unchanged: Counter = field(default_factory=Counter)
    zeroed: Counter = field(default_factory=Counter)
    conflicted: list[RowKey] = field(default_factory=list)
    watermark_written: bool = False


def family(pk: str) -> str:
    """The dimension a pk belongs to, for the summary: `METRIC#daily_source#web` -> `METRIC#daily_source#*`."""
    head, sep, _ = pk[len(METRIC_PREFIX):].partition('#')
    return f'{METRIC_PREFIX}{head}{"#*" if sep else ""}'


def recompute(items: Iterable[dict], plan: Plan, window: tuple[str | None, str | None],
              recent_cutoff: str) -> None:
    """Bucket every dated item exactly as the aggregator's INSERT path would."""
    agg = _aggregator()
    counts: dict[RowKey, Counter] = defaultdict(Counter)
    averages: dict[str, list[Decimal]] = {}
    first, last = window
    for item in items:
        plan.feedback_scanned += 1
        processed_at = item.get('processed_at')
        if isinstance(processed_at, str):
            if processed_at >= recent_cutoff:
                plan.recent_items += 1
            if plan.newest_processed_at is None or processed_at > plan.newest_processed_at:
                plan.newest_processed_at = processed_at
        day = item.get('date')
        if not isinstance(day, str) or parse_iso_date(day) is None:
            plan.undated_items += 1
            continue
        if (first and day < first) or (last and day > last):
            plan.outside_window += 1
            continue
        plan.dates.add(day)
        for pk, attribute in agg.counter_dimensions(item):
            counts[(pk, day)][attribute] += 1
        score = agg._image_score(item)
        if score:
            running = averages.setdefault(day, [Decimal('0'), Decimal('0')])
            running[0] += Decimal(str(score))
            running[1] += 1
    for (pk, day), attributes in counts.items():
        plan.targets[(pk, day)] = dict(attributes)
    for day, (total, scored) in averages.items():
        plan.targets[(agg.SENTIMENT_AVG_PK, day)] = {'sum': total, 'count': scored}


def load_existing(aggregates_table, plan: Plan) -> None:
    """Every stored METRIC# counter row (the watermark excluded)."""
    rows = scan_all(
        aggregates_table,
        FilterExpression='begins_with(pk, :metric) AND pk <> :meta',
        ExpressionAttributeValues={':metric': METRIC_PREFIX, ':meta': EARLIEST_DATE_PK},
    )
    for row in rows:
        key = (row['pk'], row['sk'])
        plan.existing[key] = row
        if row['sk'] not in plan.dates:
            plan.untouched_existing_dates.add(row['sk'])


def zero_targets(plan: Plan) -> None:
    """A stored row on a rebuilt date that the recompute did not produce: count 0."""
    avg_pk = _aggregator().SENTIMENT_AVG_PK
    for pk, day in plan.existing:
        if day in plan.dates and (pk, day) not in plan.targets:
            plan.targets[(pk, day)] = (
                {'sum': Decimal('0'), 'count': 0} if pk == avg_pk else {'count': 0})
            plan.zeroed[family(pk)] += 1


def desired_item(pk: str, day: str, values: dict[str, Any], now_iso: str) -> dict[str, Any]:
    """The full row a put writes: values, `updated_at`, `metric_type` where the GSI needs it, no ttl."""
    item: dict[str, Any] = {'pk': pk, 'sk': day, **values, 'updated_at': now_iso}
    metric_type = _aggregator().get_metric_type(pk)
    if metric_type:
        item['metric_type'] = metric_type
    return item


def _already_holds(existing: dict[str, Any] | None, desired: dict[str, Any]) -> bool:
    """True when the stored row already carries every target value, and no ttl."""
    if existing is None or TTL_ATTRIBUTE in existing:
        return False
    return all(existing.get(name) == value for name, value in desired.items() if name != 'updated_at')


def write_rows(aggregates_table, plan: Plan, started_iso: str, apply: bool) -> None:
    """Put every target row whose stored value differs, unless an aggregator write beat us to it."""
    for (pk, day), values in sorted(plan.targets.items()):
        desired = desired_item(pk, day, values, started_iso)
        if _already_holds(plan.existing.get((pk, day)), desired):
            plan.unchanged[family(pk)] += 1
            continue
        plan.written[family(pk)] += 1
        if not apply:
            continue
        try:
            aggregates_table.put_item(
                Item=desired,
                ConditionExpression=(
                    'attribute_not_exists(pk) OR attribute_not_exists(updated_at) '
                    'OR updated_at < :started'),
                ExpressionAttributeValues={':started': started_iso},
            )
        except Exception as error:  # botocore ClientError; imported lazily with boto3
            if not is_conditional_failure(error):
                raise
            plan.written[family(pk)] -= 1
            plan.conflicted.append((pk, day))


def write_watermark(aggregates_table, plan: Plan, now_iso: str, apply: bool) -> None:
    """Lower the earliest-date watermark to the oldest rebuilt date (conditional)."""
    if not apply or not plan.dates:
        return
    try:
        aggregates_table.update_item(**lower_watermark_request(min(plan.dates), now_iso))
    except Exception as error:
        if is_conditional_failure(error):
            return  # already as old or older
        raise
    plan.watermark_written = True


class RecentFeedbackError(RuntimeError):
    """`--apply` refused: items processed inside the settle window may still be in the stream."""


def run(feedback_table, aggregates_table, apply: bool, *,
        window: tuple[str | None, str | None] = (None, None),
        settle_hours: int = DEFAULT_SETTLE_HOURS, allow_recent: bool = False,
        now: Callable[[], datetime] = lambda: datetime.now(UTC)) -> Plan:
    """Recompute, then (with `apply`) write. The start instant is taken BEFORE the scan."""
    started = now()
    started_iso = started.isoformat()
    recent_cutoff = (started - timedelta(hours=settle_hours)).isoformat()
    plan = Plan()
    recompute(scan_all(feedback_table), plan, window, recent_cutoff)
    if apply and plan.recent_items and not allow_recent:
        raise RecentFeedbackError(
            f'{plan.recent_items} feedback items were processed in the last {settle_hours}h; '
            'their stream records may not be aggregated yet (double count). Wait, or check '
            'the aggregator IteratorAge is 0 and pass --allow-recent.')
    load_existing(aggregates_table, plan)
    zero_targets(plan)
    write_rows(aggregates_table, plan, started_iso, apply)
    write_watermark(aggregates_table, plan, started_iso, apply)
    return plan


def daily_total_sum(plan: Plan) -> int:
    """Sum of the recomputed `METRIC#daily_total` counts — must equal the dated items in the window."""
    total_pk = _aggregator().DAILY_TOTAL_PK
    return sum(int(values.get('count', 0)) for (pk, _), values in plan.targets.items() if pk == total_pk)


def summary_lines(plan: Plan, apply: bool) -> list[str]:
    """The human report: totals, then one line per dimension."""
    families = sorted(set(plan.written) | set(plan.unchanged) | set(plan.zeroed))
    item_totals: Counter = Counter()
    for (pk, _), values in plan.targets.items():
        item_totals[family(pk)] += int(values.get('count', 0))
    dated = plan.feedback_scanned - plan.undated_items - plan.outside_window
    totals_sum = daily_total_sum(plan)
    lines = [
        'APPLIED' if apply else 'DRY RUN (pass --apply to write)',
        f'  feedback items scanned:        {plan.feedback_scanned}',
        f'  dated items rebuilt:           {dated}',
        f'  undated items (not bucketed):  {plan.undated_items}',
        f'  items outside --from/--to:     {plan.outside_window}',
        f'  items processed in settle win: {plan.recent_items} (newest processed_at {plan.newest_processed_at})',
        f'  dates rebuilt:                 {len(plan.dates)}'
        + (f' ({min(plan.dates)} .. {max(plan.dates)})' if plan.dates else ''),
        f'  sum of daily totals:           {totals_sum}'
        f' ({"MATCHES" if totals_sum == dated else "DIFFERS FROM"} dated items)',
        f'  existing METRIC# rows:         {len(plan.existing)}'
        f' ({len(plan.untouched_existing_dates)} dates with no dated feedback, left untouched)',
        f'  rows written (dry run: would): {sum(plan.written.values())}',
        f'  rows already correct:          {sum(plan.unchanged.values())}',
        f'  rows zeroed (not deleted):     {sum(plan.zeroed.values())}',
        f'  changed during rebuild:        {len(plan.conflicted)}'
        + (' (re-run to recompute them)' if plan.conflicted else ''),
        f'  earliest-date watermark:       {min(plan.dates) if plan.dates else "none"}'
        + (' (lowered)' if plan.watermark_written else ''),
        '  per dimension (rows write/same/zeroed, sum of counts):',
    ]
    lines.extend(
        f'    {name:<40} {plan.written[name]:>6} /{plan.unchanged[name]:>6} /{plan.zeroed[name]:>5}'
        f'   count={item_totals[name]}'
        for name in families)
    return lines


def _iso_day(value: str) -> str:
    if parse_iso_date(value) is None:
        raise argparse.ArgumentTypeError(f'{value!r} is not YYYY-MM-DD')
    return value


def main(argv: list[str] | None = None) -> int:
    parser = table_parser((__doc__ or '').split('\n\n')[0])
    parser.add_argument('--from', dest='first', type=_iso_day, help='first date to rebuild (default: oldest)')
    parser.add_argument('--to', dest='last', type=_iso_day, help='last date to rebuild (default: newest)')
    parser.add_argument('--settle-hours', type=int, default=DEFAULT_SETTLE_HOURS,
                        help='refuse --apply if feedback was processed this recently (default 24)')
    parser.add_argument('--allow-recent', action='store_true',
                        help='apply even with recent feedback (check the aggregator IteratorAge first)')
    args = parser.parse_args(argv)
    session = resolve_tables(args)

    # The aggregator module reads these at import; only its pure bucketing is used.
    os.environ['AGGREGATES_TABLE'] = args.aggregates_table
    if session.region_name:
        os.environ['AWS_DEFAULT_REGION'] = session.region_name
    os.environ.setdefault('POWERTOOLS_LOG_LEVEL', 'ERROR')
    os.environ.setdefault('POWERTOOLS_METRICS_NAMESPACE', 'VoC-RebuildAggregates')

    dynamodb = session.resource('dynamodb')
    print(f'feedback table:   {args.feedback_table}\naggregates table: {args.aggregates_table}')
    try:
        plan = run(dynamodb.Table(args.feedback_table), dynamodb.Table(args.aggregates_table), args.apply,
                   window=(args.first, args.last), settle_hours=args.settle_hours,
                   allow_recent=args.allow_recent)
    except RecentFeedbackError as error:
        print(f'REFUSED: {error}', file=sys.stderr)
        return 2
    print('\n'.join(summary_lines(plan, args.apply)))
    return 1 if plan.conflicted else 0


if __name__ == '__main__':
    raise SystemExit(main())
