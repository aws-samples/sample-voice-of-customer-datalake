"""The spend ledger: what the engineering runs cost, by day, workflow, run, agent and model (plan v3 §13 Q4).

One partition per workspace and month, ``WS#<ws>#SPEND#<yyyy-mm>``; one row per day, workflow, run, agent and model,
``DAY#<dd>#WF#<flow>#RUN#<run>#AGENT#<agent>#MODEL#<model>``, whose numbers only grow by ADD: ``usd`` (what was
priced: today the MicroVM's seconds, under the model ``microvm``), ``tokens_in``/``tokens_out`` per model and
``microvm_seconds``. Its ``repo`` names the run's repository, for grouping by it.

Every row is written in the SAME transaction as the metering it mirrors (``ledger_updates``: the session store's priced
writes add their rows to the session's own conditional write), so the ledger and the sessions never drift: a write the
session's condition refuses adds nothing here either, and a retried one adds once.

The rows are cost records (D5): never deleted, no TTL; anything that ever removes one goes through the AUDIT# guard.

Rows are booked to the day (UTC) of the write that measured them, which is when the supervisor counted the MicroVM time
or the harness's report reached it: the ledger starts when this is deployed (a session's earlier tokens are not booked).

The administrators' reads (``month_spend``, ``GET /agents/engineering/spend``) are one Query of one month partition's
``DAY#`` rows, grouped here by what was asked (never a whole-table read), bounded by ``MAX_ROWS``: a month with more
rows than that answers what it read, marked ``truncated``.

Each workflow also has its month's total, ``FLOW#<flow>`` in the same partition, ADDed in the same transaction as its
runs' rows: what a flow has spent this month is one GetItem (``flow_month_usd``), for its budget's alerts (and the
planned hard cap), never a Query of the month. The alerts (``alert_levels``) are as the month passes 80% and 100% of the
flow's budget, then every further 50%; each has its row, ``ALERT#<flow>#<budget>#<percent>`` in the month's
``WS#<ws>#BUDGET#<yyyy-mm>`` partition (only the supervisor writes it): a run's tick claims it (``claim_alert``),
says it, then closes it (``alert_sent``). It is said at least once per flow, budget, level and month while a run of
the flow is live: a send that fails gives the claim back (``release_alert``) for any live run's next tick (an unsaid
claim is also taken over past its time), and one whose close failed may be said again. With no run of the flow left
live (its last run's last tick failed to say it), it waits for one: a later run of the flow that month.
"""
from __future__ import annotations

import re
from collections.abc import Mapping
from dataclasses import dataclass, field
from datetime import UTC, datetime
from decimal import Decimal
from typing import Any, Final, Literal

from botocore.exceptions import ClientError

from engineering.connectors.identity import WORKSPACE
from shared.aws import is_conditional_check_failure
from shared.dynamo_paging import iter_query

#: The pseudo model MicroVM time is priced under (a run's tokens are under their own models).
MICROVM: Final = 'microvm'
#: The most ledger rows one write adds (its transaction also holds the session's row and its flow's month total;
#: DynamoDB takes 100 items).
MAX_MODEL_ROWS: Final = 32
#: What a harness's model named like the MicroVM row is ledgered as, so its tokens never read as MicroVM time.
REPORTED_MICROVM: Final = 'microvm-reported'
#: The most rows one month's read takes (each a day, workflow, run, agent and model): far above a month of normal use.
MAX_ROWS: Final = 20_000
#: What a read groups by, and the row's attribute each one reads.
_ATTRIBUTE: Final = {'workflow': 'flow', 'repo': 'repo', 'run': 'run_id', 'agent': 'agent_id', 'model': 'model',
                     'day': 'day'}
MONTH: Final = re.compile(r'(20[0-9]{2})-(0[1-9]|1[0-2])\Z')
#: A key part: ASCII, never a ``#`` (the key's separator), never empty, at most 128 bytes, so a sort key of five parts
#: stays under DynamoDB's 1,024 bytes whatever its inputs.
_PART: Final = re.compile(r'[A-Za-z0-9._:/@+=-]{1,128}\Z')
#: The most models one session ledgers under their own names (the first by name): any others go on the '-' row,
#: so no session can open rows without end (the report's names come from inside the MicroVM). A model that sorts
#: earlier and is first reported later moves a later one onto '-' from then on (the totals stay right).
MAX_SESSION_MODELS: Final = 8
#: The row of a session's models past the cap (and of a key part that cleans to nothing).
OTHER_MODELS: Final = '-'
_NONE: Final = OTHER_MODELS


def month_of(at: datetime) -> str:
    return at.astimezone(UTC).strftime('%Y-%m')


def ledger_pk(month: str) -> str:
    if not MONTH.fullmatch(month):
        raise ValueError('a month is YYYY-MM')
    return f'WS#{WORKSPACE}#SPEND#{month}'


def _part(value: str) -> str:
    return value if _PART.fullmatch(value) else _NONE


@dataclass(frozen=True)
class Usage:
    """What one write adds for one model: dollars priced, tokens in and out, MicroVM seconds."""
    usd: Decimal = Decimal(0)
    tokens_in: int = 0
    tokens_out: int = 0
    microvm_seconds: int = 0

    def __bool__(self) -> bool:
        return bool(self.usd or self.tokens_in or self.tokens_out or self.microvm_seconds)

    def __add__(self, other: Usage) -> Usage:
        return Usage(usd=self.usd + other.usd, tokens_in=self.tokens_in + other.tokens_in,
                     tokens_out=self.tokens_out + other.tokens_out,
                     microvm_seconds=self.microvm_seconds + other.microvm_seconds)

    @property
    def tokens(self) -> int:
        return self.tokens_in + self.tokens_out

    @classmethod
    def of_row(cls, item: Mapping[str, Any]) -> Usage:
        """A ledger row's numbers."""
        return cls(usd=Decimal(str(item.get('usd', 0))), tokens_in=int(item.get('tokens_in', 0)),
                   tokens_out=int(item.get('tokens_out', 0)), microvm_seconds=int(item.get('microvm_seconds', 0)))

    def view(self) -> dict[str, Any]:
        return {'usd': float(self.usd), 'tokens_in': self.tokens_in, 'tokens_out': self.tokens_out,
                'microvm_seconds': self.microvm_seconds}


@dataclass(frozen=True)
class Where:
    """Whose spend: the run, its workflow and repository, the agent; and the write that measured it (D4): the
    session row's version (``seq``) whose write adds it, so a row traces back to the session it mirrors."""
    run_id: str
    agent_id: str
    flow: str = ''
    repo: str = ''
    seq: int = 0

#: Who writes the ledger: the runtime's session store, in each priced session write (D4: who, when, which version).
WRITER: Final = 'runtime/sessions'


def ledger_updates(table: str, at: datetime, where: Where, usage: Mapping[str, Usage]) -> list[dict[str, Any]]:
    """The ledger's ADDs for ``usage`` (per model), as TransactWriteItems ``Update`` entries to go in the metering's
    own transaction (no row for a model that adds nothing). Plain values, as the boto3 resource's client takes.

    The model names come from inside the MicroVM (its harness's report): names that clean to the same key part are
    summed into ONE entry, so no report can put two operations on one row and fail the session's write with it."""
    day = at.astimezone(UTC).strftime('%d')
    by_model: dict[str, Usage] = {}
    for model, used in usage.items():
        if min(used.usd, used.tokens_in, used.tokens_out, used.microvm_seconds) < 0:
            raise ValueError('a ledger write only adds: nothing in it is below zero')
        part = _part(model)
        by_model[part] = by_model.get(part, Usage()) + used
    if len(by_model) > MAX_MODEL_ROWS:
        # A transaction holds at most 100 items: past the cap, the smallest go on one '-' row (MicroVM time stays its
        # own, then the models with the most tokens in this write: per-model rows past the cap are best effort).
        keep = sorted(by_model, key=lambda part: (part != MICROVM, -by_model[part].tokens, part))[:MAX_MODEL_ROWS - 1]
        rest = sum((used for part, used in by_model.items() if part not in keep), Usage())
        by_model = {part: by_model[part] for part in keep}
        by_model[_NONE] = by_model.get(_NONE, Usage()) + rest
    updates: list[dict[str, Any]] = []
    for model, used in sorted(by_model.items()):
        if not used:
            continue
        sk = (f'DAY#{day}#WF#{_part(where.flow)}#RUN#{_part(where.run_id)}#AGENT#{_part(where.agent_id)}'
              f'#MODEL#{model}')
        updates.append({'Update': {
            'TableName': table, 'Key': {'pk': ledger_pk(month_of(at)), 'sk': sk},
            'UpdateExpression': ('ADD usd :usd, tokens_in :in, tokens_out :out, microvm_seconds :secs '
                                 'SET #day = :day, flow = :flow, repo = :repo, run_id = :run, agent_id = :agent, '
                                 'model = :model, updated_at = :at, updated_by = :by, session_seq = :seq'),
            'ExpressionAttributeNames': {'#day': 'day'},
            'ExpressionAttributeValues': {
                ':usd': used.usd, ':in': used.tokens_in, ':out': used.tokens_out, ':secs': used.microvm_seconds,
                ':day': day, ':flow': where.flow, ':repo': where.repo, ':run': where.run_id, ':agent': where.agent_id,
                ':model': model, ':at': at.astimezone(UTC).isoformat(), ':by': WRITER, ':seq': where.seq},
        }})
    dollars = sum((used.usd for used in by_model.values()), Decimal(0))
    # (only a write that adds dollars: a tokens-only one, or unpriced MicroVM time, leaves the hot item alone)
    if updates and dollars > 0 and keyable(where.flow):
        # (dollars only: what the alerts read, as the planned hard cap will; the month's tokens and time are the DAY#
        # rows')
        updates.append({'Update': {
            'TableName': table, 'Key': flow_total_key(month_of(at), where.flow),
            'UpdateExpression': 'ADD usd :usd SET updated_at = :at, updated_by = :by',
            'ExpressionAttributeValues': {
                ':usd': dollars,
                ':at': at.astimezone(UTC).isoformat(), ':by': WRITER},
        }})
    return updates


def flow_total_key(month: str, flow: str) -> dict[str, str]:
    """The key of a workflow's month total (its runs' whole month, ADDed with each of their ledger writes)."""
    return {'pk': ledger_pk(month), 'sk': f'FLOW#{_part(flow)}'}


def flow_month_usd(table: Any, month: str, flow: str) -> Decimal:
    """What ``flow``'s runs spent in ``month`` (priced: MicroVM time until tokens are), from its month total: one
    GetItem."""
    # (consistent: read right after this tick's own writes, so a level they passed is seen in this tick)
    item = table.get_item(Key=flow_total_key(month, flow), ConsistentRead=True).get('Item') or {}
    return Decimal(str(item.get('usd', 0)))


#: The alert levels as a flow's month passes its budget, in percent: 80, 100, then every further 50 up to 1,000 (a
#: month ten times over has said so enough, and a tick never writes more than these 20 rows).
_LEVELS: Final = (80, 100, *range(150, 1001, 50))
#: Who records an alert: the supervisor's tick.
ALERT_WRITER: Final = 'runtime/supervisor'
#: A claimed alert not sent in this long (its run's tick failed between the claim and the send) may be taken over by
#: another run of the flow.
ALERT_CLAIM_SECONDS: Final = 300


def alert_levels(spent: Decimal, budget: Decimal) -> list[int]:
    """The alert levels (percent of ``budget``) that ``spent`` has passed, lowest first."""
    if budget <= 0:
        return []
    percent = spent * 100 / budget
    return [level for level in _LEVELS if percent >= level]


def keyable(flow: str) -> bool:
    """``flow`` is a ledger key part of its own (never the '-' row of what cannot be one): the totals and the alerts
    key by it."""
    return _part(flow) != _NONE


def alerts_pk(month: str) -> str:
    """The month's budget alerts: a partition of their own, which only the supervisor's role may write (the ledger's
    other writers can never make, and so mute, an alert)."""
    ledger_pk(month)   # (the same month rule)
    return f'WS#{WORKSPACE}#BUDGET#{month}'


def _alert_key(month: str, flow: str, budget: Decimal, level: int) -> dict[str, str]:
    # The budget is in the key: a flow's new budget has alerts of its own, never silenced by the old one's.
    return {'pk': alerts_pk(month), 'sk': f'ALERT#{_part(flow)}#{int(budget * 100):012d}#{level:04d}'}


#: What a claim found: this run is to say it (``claimed``), it was said (``said``), or another run holds it unsaid
#: (``held``: try again on a later tick, which may take it over).
Claim = Literal['claimed', 'said', 'held']


def claim_alert(table: Any, month: str, flow: str, level: int, *, run_id: str, spent: Decimal, budget: Decimal,
                at: datetime) -> Claim:
    """Claim the saying of ``flow``'s ``level`` (at ``budget``) in ``month``: its ``ALERT#`` row, made once and never
    deleted (D1). It names the latest claim (D4: which run's tick, when, at what spend) until it is closed: a claim
    renewed or taken over before the alert is said replaces those three fields, and once ``sent_at`` closes the row
    nothing changes it. ``claimed`` when this run says it: it made the row, or its own claim was not said yet, or
    another run's claim went unsaid past ``ALERT_CLAIM_SECONDS``."""
    stale = datetime.fromtimestamp(at.timestamp() - ALERT_CLAIM_SECONDS, UTC).isoformat()
    try:
        table.update_item(
            Key=_alert_key(month, flow, budget, level),
            UpdateExpression='SET run_id = :run, spent_usd = :spent, alerted_at = :at, updated_by = :by',
            ConditionExpression=('attribute_not_exists(sk) OR (attribute_not_exists(sent_at) '
                                 'AND (run_id = :run OR alerted_at < :stale))'),
            ExpressionAttributeValues={':run': run_id, ':spent': spent, ':stale': stale,
                                       ':at': at.astimezone(UTC).isoformat(), ':by': ALERT_WRITER},
            ReturnValuesOnConditionCheckFailure='ALL_OLD')
    except ClientError as error:
        if is_conditional_check_failure(error):
            return 'said' if 'sent_at' in (error.response.get('Item') or {}) else 'held'
        raise
    return 'claimed'


def release_alert(table: Any, month: str, flow: str, level: int, *, run_id: str, budget: Decimal) -> None:
    """Give back a claim whose saying failed (only the run holding it, only while unsaid): its claim time goes to the
    epoch, so any run of the flow takes it over on its next tick (its own run may have none: its last tick)."""
    try:
        table.update_item(
            Key=_alert_key(month, flow, budget, level), UpdateExpression='SET alerted_at = :released',
            ConditionExpression='attribute_exists(sk) AND run_id = :run AND attribute_not_exists(sent_at)',
            ExpressionAttributeValues={':run': run_id, ':released': datetime.fromtimestamp(0, UTC).isoformat()})
    except ClientError as error:
        if not is_conditional_check_failure(error):
            raise


def alert_sent(table: Any, month: str, flow: str, level: int, *, run_id: str, budget: Decimal, at: datetime) -> None:
    """The claimed alert was said: its row is closed (once; only by the run holding it)."""
    try:
        table.update_item(
            Key=_alert_key(month, flow, budget, level), UpdateExpression='SET sent_at = :at',
            ConditionExpression='attribute_exists(sk) AND run_id = :run AND attribute_not_exists(sent_at)',
            ExpressionAttributeValues={':run': run_id, ':at': at.astimezone(UTC).isoformat()})
    except ClientError as error:
        if not is_conditional_check_failure(error):
            raise


def token_deltas(now: Mapping[str, Mapping[str, int]], ledgered: Mapping[str, Mapping[str, int]]) -> dict[str, Usage]:
    """Per model, the tokens in ``now`` not yet in the ledger (``ledgered``): never negative (a total never drops)."""
    deltas: dict[str, Usage] = {}
    for model, counts in now.items():
        before = ledgered.get(model, {})
        delta = Usage(tokens_in=max(int(counts.get('in', 0)) - int(before.get('in', 0)), 0),
                      tokens_out=max(int(counts.get('out', 0)) - int(before.get('out', 0)), 0))
        if delta:
            name = REPORTED_MICROVM if model == MICROVM else model   # (the MicroVM row is the runtime's own)
            deltas[name] = deltas.get(name, Usage()) + delta
    return deltas


@dataclass
class MonthSpend:
    month: str
    by: str
    total: Usage = field(default_factory=Usage)
    groups: dict[str, Usage] = field(default_factory=dict)
    truncated: bool = False

    def view(self) -> dict[str, Any]:
        # Biggest first: dollars, then tokens, then MicroVM time (tokens are not priced yet), then the key.
        ordered = sorted(self.groups.items(), key=lambda pair: (
            -pair[1].usd, -pair[1].tokens, -pair[1].microvm_seconds, pair[0]))
        return {'month': self.month, 'by': self.by, 'total': self.total.view(), 'truncated': self.truncated,
                'groups': [{'key': key, **total.view()} for key, total in ordered]}


def check_query(month: str, by: str) -> None:
    """``ValueError`` (the caller's mistake) for a month that is not YYYY-MM or a grouping that is not one of the
    groupings; checked before any read, so a refusal never stands for something the read met."""
    ledger_pk(month)
    if by not in _ATTRIBUTE:
        raise ValueError(f'by is one of {", ".join(_ATTRIBUTE)}')


def _group_key(item: Mapping[str, Any], by: str) -> str:
    """The row's group: an agent is its run's (every run has its own ``fixer-1``), as ``<run>/<agent>``."""
    value = str(item.get(_ATTRIBUTE[by]) or _NONE)
    return f'{item.get("run_id") or _NONE}/{value}' if by == 'agent' else value


def month_spend(table: Any, month: str, by: str, *, flow: str = '') -> MonthSpend:
    """The ledger's read: ``month``'s spend grouped ``by`` one of the groupings (only ``flow``'s, when given), from
    one Query of its partition (``check_query`` first)."""
    check_query(month, by)
    # (its DAY# rows: the flows' month totals share the partition)
    query: dict[str, Any] = {'KeyConditionExpression': 'pk = :pk AND begins_with(sk, :day)',
                             'ExpressionAttributeValues': {':pk': ledger_pk(month), ':day': 'DAY#'}}
    spend = MonthSpend(month=month, by=by)
    rows = 0
    for item in iter_query(table, query, max_items=MAX_ROWS + 1):
        rows += 1
        if rows > MAX_ROWS:
            spend.truncated = True
            break
        if flow and item.get('flow') != flow:
            continue
        used = Usage.of_row(item)
        spend.total += used
        key = _group_key(item, by)
        spend.groups[key] = spend.groups.get(key, Usage()) + used
    return spend
