"""Agent sessions: one row per agent of a run, the supervisor's view of its MicroVM.

``WS#<ws>#RUN#<run>`` / ``AGENT#<agent>`` in voc-engineering: the row the board's table keeps for each agent
of a run, which the reports read (role, skill version, model, MicroVM seconds, tokens in and out) and the
brokers add their own metering to (the cost they priced). So this store never writes the whole item: it
creates the row once and from then on updates only its own attributes. The supervisor finds the live sessions
through the runs the supervisor watches (``runs.RunStore.listed``: the table has no index). Every write is
conditional on the row's ``seq``, so overlapping ticks never write over each other: the second gets
``StaleSession`` and leaves the session to the next tick.

A row holds ids, times, the MicroVM's id and endpoint, the run monitor's inspection data and the live cost
counters (MicroVM seconds, tokens per model and their totals), never a token, a credential or a command's output.
"""
from __future__ import annotations

import secrets
import time
import uuid
from collections.abc import Callable, Iterator
from dataclasses import asdict, dataclass, field, replace
from datetime import UTC, datetime
from decimal import Decimal
from typing import Any, Final, Literal

from botocore.exceptions import ClientError

from engineering.rows import LAUNCH_HOLD
from engineering.runtime.interface import AgentSpec, MicroVm
from engineering.runtime.runs import RunNotActive, RunStore, meta_key, run_pk, transaction_conflict
from engineering.spend import (
    MAX_SESSION_MODELS,
    MICROVM,
    OTHER_MODELS,
    REPORTED_MICROVM,
    Usage,
    Where,
    ledger_updates,
    token_deltas,
)
from shared.aws import consistent_item, is_conditional_check_failure
from shared.dynamo_paging import iter_query
from shared.dynamo_values import plain
from shared.ids import is_key_collision

Status = Literal['booting', 'working', 'pause_requested', 'waiting', 'paused', 'done', 'failed', 'stopped',
                 'reposted']
#: The sessions the supervisor checks each tick. All but ``waiting`` have a MicroVM; a ``waiting`` session
#: paused for a long open wait and is continued in a new MicroVM once the wait closes.
LIVE_STATUSES: Final = frozenset({'booting', 'working', 'pause_requested', 'waiting'})
WITH_MICROVM: Final = frozenset({'booting', 'working', 'pause_requested'})
#: What a ``pause_requested`` session does once its harness has paused: a continuation (the 8-hour limit),
#: held for a person to resume (``hold``: a person's pause, a spent budget), held until its open wait closes
#: (``wait``), or stopped (``shutdown``).
After = Literal['continue', 'hold', 'wait', 'shutdown']


#: How long a launch holds it: the runtime function's own limit (engineering-runtime.ts, 5 minutes), so a launch
#: killed at its limit lets go by then.
LAUNCH_HOLD_SECONDS: Final = 5 * 60


class StaleSession(RuntimeError):
    """Someone else moved the session since it was read."""


class LaunchUnderWay(RuntimeError):
    """The agent has its session, or another launch of it holds its row (``SessionStore.hold_launch``)."""


@dataclass(frozen=True)
class AgentSession:
    run_id: str
    agent_id: str
    role: str
    task_id: str
    language: str
    egress: tuple[str, ...]
    connection: str
    commit: str
    paths: tuple[str, ...]
    #: The agent's own command, started once the checkout is done (``harness/``).
    harness: tuple[str, ...]
    vm_id: str
    endpoint: str
    started_at: int
    status: Status = 'booting'
    continuation: int = 0
    crashes: int = 0
    boot_index: int = 0
    exec_id: str | None = None
    asked_at: int | None = None
    pause_requested_at: int | None = None
    after_pause: After = 'continue'
    #: The supervisor suspended this MicroVM for an open wait (resumed when the wait ends), since when.
    suspended: bool = False
    #: Calls to this MicroVM that failed in a row (the third is a crash: it is gone or never came up).
    failures: int = 0
    #: A tick or a signal is moving this session until then (epoch seconds): nobody else may (``SessionStore.claim``).
    claimed_until: int | None = None
    #: The checkpoint this MicroVM restored from (None: the task's start).
    restore_key: str | None = None
    #: When the launcher's role session handed to this MicroVM lapses (None: none handed yet).
    session_expires_at: int | None = None
    #: When a message last woke it (``Supervisor.wake``): an open wait does not suspend it again for a while.
    woken_at: int | None = None
    #: When this MicroVM's harness started (its boot's last command): a fresh agent's claim is due within the
    #: crash clock from then.
    harness_at: int | None = None
    #: The task's attempt it works on (the board's; its workspace keys go under it).
    task_attempt: int = 1
    #: When its current open wait began (None: no open wait): the 45-minute hold counts from here, awake or not.
    wait_since: int | None = None
    #: The wait (its ``wait_since``) a message already continued it in a new MicroVM for: once per wait, whatever
    #: continuations (a crashed boot) follow.
    woken_wait: int | None = None
    #: The continuation that message made: it alone gets the grace to read it (none that follows it does).
    woken_continuation: int | None = None
    #: Live cost and inspection data for the run monitor.
    microvm_seconds: int = 0
    #: How many of its MicroVM seconds are already priced into the row's ``cost_usd`` (``SessionStore``).
    priced_seconds: int = 0
    last_tick_at: int | None = None
    #: Tokens per model (``{"in", "out"}``) of every MicroVM of this session so far: ``tokens_before`` (the
    #: earlier ones', fixed when it continues) plus what the current one's harness reported, which starts at zero.
    tokens: dict[str, dict[str, int]] = field(default_factory=dict)
    tokens_before: dict[str, dict[str, int]] = field(default_factory=dict)
    #: The tokens per model already in the spend ledger (``engineering/spend.py``): the row's ``tokens`` as it was
    #: read (never stored: every metered write ledgers the difference in the same write), so each write adds the rest.
    ledgered_tokens: dict[str, dict[str, int]] = field(default_factory=dict)
    inspect: dict[str, Any] = field(default_factory=dict)
    seq: int = 0

    @property
    def input_tokens(self) -> int:
        return sum(counts.get('in', 0) for counts in self.tokens.values())

    @property
    def output_tokens(self) -> int:
        return sum(counts.get('out', 0) for counts in self.tokens.values())

    def reported(self, current: dict[str, dict[str, int]]) -> dict[str, dict[str, int]]:
        """The session's tokens, given what the current MicroVM's harness reported.

        The report comes from inside the MicroVM, so it can only add: a negative count is none, and no total ever
        drops below what was saved (the run's token cap must not be talked down).
        """
        totals = {model: dict(counts) for model, counts in self.tokens_before.items()}
        for model, counts in current.items():
            total = totals.setdefault(model, {'in': 0, 'out': 0})
            for kind in ('in', 'out'):
                total[kind] = total.get(kind, 0) + max(int(counts.get(kind, 0)), 0)
        for model, counts in self.tokens.items():
            total = totals.setdefault(model, {'in': 0, 'out': 0})
            for kind in ('in', 'out'):
                total[kind] = max(total.get(kind, 0), int(counts.get(kind, 0)))
        return totals

    def spec(self, restore_key: str | None = None, workspace_bucket: str = '', board_url: str = '') -> AgentSpec:
        return AgentSpec(run_id=self.run_id, agent_id=self.agent_id, role=self.role, task_id=self.task_id,
                         language=self.language, egress=self.egress, connection=self.connection,
                         restore_key=restore_key, commit=self.commit, attempt=self.task_attempt,
                         workspace_bucket=workspace_bucket, board_url=board_url)

    @property
    def vm(self) -> MicroVm:
        return MicroVm(vm_id=self.vm_id, agent_id=self.agent_id, endpoint=self.endpoint)

    def on(self, vm: MicroVm, now: int, restore_key: str | None) -> AgentSession:
        """This session continued in ``vm``: booting again, the next continuation, nothing in flight."""
        return replace(self, vm_id=vm.vm_id, endpoint=vm.endpoint, started_at=now, status='booting',
                       continuation=self.continuation + 1, boot_index=0, exec_id=None, asked_at=None,
                       pause_requested_at=None, after_pause='continue', suspended=False,
                       failures=0, restore_key=restore_key, tokens_before=self.tokens, woken_at=None, harness_at=None,
                       session_expires_at=None, last_tick_at=now)


_OPTIONAL_INTS: Final = ('asked_at', 'pause_requested_at', 'session_expires_at', 'last_tick_at',
                         'claimed_until', 'woken_at', 'wait_since', 'woken_wait', 'woken_continuation',
                         'harness_at')
_OPTIONAL_STRS: Final = ('exec_id', 'restore_key')


def _key(run_id: str, agent_id: str) -> dict[str, str]:
    return {'pk': run_pk(run_id), 'sk': f'AGENT#{agent_id}'}


def _own(session: AgentSession) -> dict[str, Any]:
    """The attributes this store writes: the session's own (and the totals the reports read), never anyone else's."""
    own = dict(asdict(session), egress=list(session.egress), paths=list(session.paths),
               harness=list(session.harness), input_tokens=session.input_tokens,
               output_tokens=session.output_tokens)
    own.pop('ledgered_tokens')   # (the row's own tokens as read: never a stored copy)
    return own


def _from_item(item: dict[str, Any]) -> AgentSession:
    optional: dict[str, Any] = {key: int(item[key]) for key in _OPTIONAL_INTS if item.get(key) is not None}
    optional.update({key: str(item[key]) for key in _OPTIONAL_STRS if item.get(key) is not None})
    return AgentSession(
        run_id=str(item['run_id']), agent_id=str(item['agent_id']), role=str(item['role']),
        task_id=str(item['task_id']), language=str(item['language']), egress=tuple(item['egress']),
        connection=str(item['connection']), commit=str(item['commit']), paths=tuple(item.get('paths') or ()),
        harness=tuple(item['harness']), vm_id=str(item['vm_id']), endpoint=str(item['endpoint']),
        started_at=int(item['started_at']), status=item['status'], continuation=int(item.get('continuation', 0)),
        crashes=int(item.get('crashes', 0)), boot_index=int(item.get('boot_index', 0)),
        after_pause=item.get('after_pause', 'continue'), suspended=bool(item.get('suspended', False)),
        failures=int(item.get('failures', 0)), task_attempt=int(item.get('task_attempt', 1)),
        microvm_seconds=int(item.get('microvm_seconds', 0)), priced_seconds=int(item.get('priced_seconds', 0)),
        tokens=plain(item.get('tokens') or {}), tokens_before=plain(item.get('tokens_before') or {}),
        ledgered_tokens=plain(item.get('tokens') or {}),
        inspect=plain(item.get('inspect') or {}),
        seq=int(item['seq']),
        **optional,
    )


#: A priced write's transaction is tried this many times when another write holds one of its rows (``_transact``),
#: pausing 20-40, 40-80 and 60-120 ms (jittered) between tries.
CONFLICT_TRIES: Final = 4
CONFLICT_PAUSE_SECONDS: Final = 0.02


def _condition_failed(error: ClientError) -> bool:
    """A cancelled transaction one of whose items' conditions failed (the session moved meanwhile)."""
    reasons = error.response.get('CancellationReasons') or []
    return any(reason.get('Code') == 'ConditionalCheckFailed' for reason in reasons)


def _in_progress(error: ClientError) -> bool:
    """An earlier try of the same ClientRequestToken is still under way."""
    return error.response.get('Error', {}).get('Code') == 'TransactionInProgressException'


class SessionStore:
    """``usd_per_second``: the deployment's price of a MicroVM second (0: not priced). Each write that moves the
    session adds the seconds it has not priced yet to the row's ``cost_usd`` (an ADD, as the brokers add theirs, so
    neither writes over the other), in the same conditional write, so a move counted once is priced once. Pricing
    goes forward only: time used while the price is 0 is never priced later."""

    def __init__(self, table: Any, runs: RunStore, usd_per_second: Decimal = Decimal(0),
                 clock: Callable[[], datetime] = lambda: datetime.now(UTC)) -> None:
        self._table = table
        self._pause: Callable[[float], None] = time.sleep   # (a test sets its own)
        self._runs = runs
        self._usd_per_second = usd_per_second
        self._clock = clock
        self._runs_seen: dict[str, tuple[str, str]] = {}

    def create(self, session: AgentSession, labels: dict[str, str] | None = None) -> AgentSession:
        """Write a new session's row, only while its run is active (``RunNotActive``: checked in the same write, so
        a run that ends meanwhile gets no agent nothing supervises), and never over the agent's session in it.

        ``labels``: what the reports name the agent by (its model, its skill version), written once here; later
        writes set only the session's own attributes, so they stay.
        """
        first = replace(session, seq=1)
        name = self._table.name
        # The launch's hold (``hold_launch``) goes with the row's creation: the session is the record from then on.
        extra: dict[str, str | None] = {**(labels or {}), LAUNCH_HOLD: None}
        try:
            self._table.meta.client.transact_write_items(TransactItems=[
                {'ConditionCheck': {'TableName': name, 'Key': meta_key(session.run_id),
                                    'ConditionExpression': '#status = :active',
                                    'ExpressionAttributeNames': {'#status': 'status'},
                                    'ExpressionAttributeValues': {':active': 'active'}}},
                {'Update': {'TableName': name, **self._update(first, 'attribute_not_exists(seq)', {}, extra)}},
            ])
        except ClientError as error:
            if is_key_collision(error, put_index=0):
                raise RunNotActive(f'run {session.run_id} is not active: no agent is launched') from error
            if is_key_collision(error, put_index=1):
                raise StaleSession(f'session {session.run_id}/{session.agent_id} exists') from error
            raise
        return first

    def hold_launch(self, run_id: str, agent_id: str, now: int) -> None:
        """Take the agent's launch before its MicroVM starts, for ``LAUNCH_HOLD_SECONDS``: one conditional write on the
        agent's row while it holds no session yet. ``LaunchUnderWay`` when the agent has its session already, or
        another launch of it holds it (a retry while the first still boots never starts a second MicroVM)."""
        try:
            self._table.update_item(
                Key=_key(run_id, agent_id), UpdateExpression='SET #hold = :until',
                ConditionExpression='attribute_not_exists(seq) AND (attribute_not_exists(#hold) OR #hold < :now)',
                ExpressionAttributeNames={'#hold': LAUNCH_HOLD},
                ExpressionAttributeValues={':until': now + LAUNCH_HOLD_SECONDS, ':now': now})
        except ClientError as error:
            if is_conditional_check_failure(error):
                raise LaunchUnderWay(f'{run_id}/{agent_id} has a session or a launch under way') from error
            raise

    def launch_under_way(self, run_id: str, agent_id: str, now: int) -> bool:
        """Another launch of the agent holds its row (its MicroVM still starting) and has written no session yet."""
        item = consistent_item(self._table, _key(run_id, agent_id))
        return item is not None and 'seq' not in item and int(item.get(LAUNCH_HOLD, 0)) >= now

    def release_launch(self, run_id: str, agent_id: str) -> None:
        """Let go of a launch that started no session (its MicroVM failed to start): a retry may launch at once. The
        hold is run out (0), never removed: the row stays a launch hold, which no reader takes for an agent (the
        report builder's facts skip it), rather than a key-only row read as an agent with no role."""
        try:
            self._table.update_item(Key=_key(run_id, agent_id), UpdateExpression='SET #hold = :ended',
                                    ConditionExpression='attribute_not_exists(seq)',
                                    ExpressionAttributeNames={'#hold': LAUNCH_HOLD},
                                    ExpressionAttributeValues={':ended': 0})
        except ClientError as error:
            if not is_conditional_check_failure(error):   # (a session exists: its creation removed the hold)
                raise

    def save(self, session: AgentSession) -> AgentSession:
        """Write ``session`` over the row it was read from; ``StaleSession`` when the row moved meanwhile."""
        moved, cost, usage = self._metered(replace(session, seq=session.seq + 1))
        self._write(moved, 'seq = :seen', {':seen': session.seq}, cost, usage)
        return moved

    def claim(self, session: AgentSession, now: int, ttl: int) -> AgentSession:
        """Take ``session`` for one move until ``now + ttl``; ``StaleSession`` when it moved or someone holds it.

        Only the holder's next writes match the row's ``seq``, so nobody else moves the session meanwhile; a
        holder that died lets go when its claim lapses.
        """
        claimed, cost, usage = self._metered(replace(session, seq=session.seq + 1, claimed_until=now + ttl))
        self._write(claimed, 'seq = :seen AND (attribute_not_exists(claimed_until) OR claimed_until < :now)',
                    {':seen': session.seq, ':now': now}, cost, usage)
        return claimed

    def _metered(self, session: AgentSession) -> tuple[AgentSession, Decimal | None, dict[str, Usage]]:
        """``_priced``, and what the write adds to the spend ledger: the MicroVM seconds not counted before (with
        their price, if any) and, per model, the tokens not ledgered before. The session then records both as
        counted, in the same write. Past the session's first ``MAX_SESSION_MODELS`` models by name, its others' tokens are
        ledgered under ``-``: the names come from inside the MicroVM, and no session may open rows without end."""
        priced, cost = self._priced(session)
        unpriced = priced.priced_seconds - session.priced_seconds   # (the seconds _priced just counted, once)
        # (token_deltas names a reported 'microvm' as REPORTED_MICROVM: its own names say the same)
        # The first models by name (a map read back from DynamoDB keeps no order): deterministic on every write.
        own = {REPORTED_MICROVM if model == MICROVM else model for model in sorted(priced.tokens)[:MAX_SESSION_MODELS]}
        usage: dict[str, Usage] = {}
        for model, used in token_deltas(priced.tokens, priced.ledgered_tokens).items():
            name = model if model in own else OTHER_MODELS
            usage[name] = usage.get(name, Usage()) + used
        if unpriced > 0:
            # (a harness's model of that name is ledgered as spend.REPORTED_MICROVM: this row is the runtime's own)
            usage[MICROVM] = Usage(usd=cost or Decimal(0), microvm_seconds=unpriced)
        if usage:
            priced = replace(priced, ledgered_tokens={model: dict(counts) for model, counts in priced.tokens.items()})
        return priced, cost, usage

    def _where(self, run_id: str) -> Where:
        """The run's workflow and repository for its ledger rows (read once per run and store)."""
        known = self._runs_seen.get(run_id)
        if known is None:
            run = self._runs.get(run_id)
            if run is None:   # (not cached: a META written later is read next time)
                return Where(run_id=run_id, agent_id='')
            known = self._runs_seen[run_id] = (run.flow, run.repo)
        return Where(run_id=run_id, agent_id='', flow=known[0], repo=known[1])

    def _priced(self, session: AgentSession) -> tuple[AgentSession, Decimal | None]:
        """The session with its MicroVM seconds counted as priced, and the cost of the ones not priced before (None:
        none, or no price: those seconds stay unpriced, so a price set later applies from then on only)."""
        unpriced = session.microvm_seconds - session.priced_seconds
        if unpriced <= 0:
            return session, None
        priced = replace(session, priced_seconds=session.microvm_seconds)
        return priced, (self._usd_per_second * unpriced if self._usd_per_second > 0 else None)

    @staticmethod
    def _update(session: AgentSession, condition: str, values: dict[str, Any],
                extra: dict[str, str | None] | None = None, cost: Decimal | None = None) -> dict[str, Any]:
        """The update that SETs the session's own attributes (REMOVEs the ones it no longer has), under ``condition``."""
        names: dict[str, str] = {}
        sets, removes, own = [], [], {**_own(session), **(extra or {})}
        for number, (attribute, value) in enumerate(sorted(own.items())):
            names[f'#a{number}'] = attribute
            if value is None:
                removes.append(f'#a{number}')
            else:
                sets.append(f'#a{number} = :a{number}')
                values = {**values, f':a{number}': value}
        expression = 'SET ' + ', '.join(sets) + (' REMOVE ' + ', '.join(removes) if removes else '')
        if cost is not None:
            names['#cost'] = 'cost_usd'
            values = {**values, ':cost': cost}
            expression += ' ADD #cost :cost'
        return {'Key': _key(session.run_id, session.agent_id), 'UpdateExpression': expression,
                'ConditionExpression': condition, 'ExpressionAttributeNames': names,
                'ExpressionAttributeValues': values}

    def _write(self, session: AgentSession, condition: str, values: dict[str, Any],
               cost: Decimal | None = None, usage: dict[str, Usage] | None = None) -> None:
        """The session's write; with ``usage``, in one transaction with its spend ledger rows (``spend.py``), so a
        write the session's condition refuses adds nothing to the ledger, and the two never drift."""
        update = self._update(session, condition, values, cost=cost)
        try:
            if usage:
                where = replace(self._where(session.run_id), agent_id=session.agent_id, seq=session.seq)
                items = [{'Update': {'TableName': self._table.name, **update}},
                         *ledger_updates(self._table.name, self._clock(), where, usage)]
                self._transact(items)
            else:
                self._table.update_item(**update)
        except ClientError as error:
            # The session's condition failed, or another write held one of the transaction's rows (a conflict, which
            # botocore does not retry): either way the move did not happen, and the next tick reads the row again. (An
            # earlier try still under way after the last: it may land; the next tick's read says which.)
            if (is_conditional_check_failure(error) or is_key_collision(error, put_index=0)
                    or transaction_conflict(error) or _in_progress(error)):
                raise StaleSession(f'session {session.run_id}/{session.agent_id} moved') from error
            raise

    def _transact(self, items: list[dict[str, Any]]) -> None:
        """The priced write's transaction. Another write may hold one of its rows at that moment: a broker's ADD to the
        same session row, or another agent's priced write of the flow's month total (FLOW#, every agent of the flow
        adds to it), which a plain update would not have been refused by. Each such conflict is tried again after a
        short, jittered pause, ``CONFLICT_TRIES`` in all: the moment passes in milliseconds, and a move that loses it
        for good (a StaleSession) may cost a new MicroVM its start.

        The request token: botocore gives each call one of its own and resends it on its own retries; a retry here is
        a new call, so the write names its token itself. After ``TransactionInProgressException`` (an earlier try of
        the token still under way, whose answer botocore lost) the next try keeps it, and is answered as that try
        ended: as landed when it landed, never refused by the session's condition it moved itself (a StaleSession for
        a move that happened; still under way after the last try, the next tick's read says which). After a conflict
        (the try did not land) the next try takes a new one, never relying on how a cancelled token is replayed. Each
        token is this call's own, never derived from the write: two writers of the same move are never told they
        both made it."""
        token = str(uuid.uuid4())
        for tries in range(1, CONFLICT_TRIES + 1):
            try:
                self._table.meta.client.transact_write_items(TransactItems=items, ClientRequestToken=token)
            except ClientError as error:
                # (a conflict only: a cancellation that also names a failed condition can never land; or the same
                # token's earlier try still under way, which the next try answers as it ended)
                conflict = transaction_conflict(error) and not _condition_failed(error)
                if not (conflict or _in_progress(error)) or tries == CONFLICT_TRIES:
                    raise
                if conflict:
                    token = str(uuid.uuid4())
                self._pause(CONFLICT_PAUSE_SECONDS * tries * (1 + secrets.randbelow(100) / 100))
            else:
                return

    def get(self, run_id: str, agent_id: str) -> AgentSession | None:
        item = consistent_item(self._table, _key(run_id, agent_id))
        return None if item is None or 'seq' not in item else _from_item(item)

    def of_run(self, run_id: str) -> list[AgentSession]:
        """Every session of one run, live or not (the run monitor's signals reach paused agents too)."""
        return self._agents_of(run_id)[0]

    def _agents_of(self, run_id: str) -> tuple[list[AgentSession], dict[str, int]]:
        """One query of the run's agent rows: its sessions, and the launch holds of agents with no session yet (each
        agent's hold's end, epoch seconds; a run-out hold is 0)."""
        query = {'KeyConditionExpression': 'pk = :run AND begins_with(sk, :agent)',
                 'ExpressionAttributeValues': {':run': run_pk(run_id), ':agent': 'AGENT#'}, 'ConsistentRead': True}
        sessions: list[AgentSession] = []
        holds: dict[str, int] = {}
        for item in iter_query(self._table, query):
            if 'seq' in item:
                sessions.append(_from_item(item))
            elif LAUNCH_HOLD in item:   # (a row the brokers metered before the session was written holds neither)
                holds[str(item['sk']).removeprefix('AGENT#')] = int(item[LAUNCH_HOLD])
        return sessions, holds

    def any_live_or_moving(self, run_id: str, now: int) -> bool:
        """An agent of the run is live, or one is being moved (a Resume may be starting a MicroVM for it)."""
        return any(session.status in LIVE_STATUSES or (session.claimed_until or 0) >= now
                   for session in self.of_run(run_id))

    def watched(self) -> Iterator[tuple[str, list[AgentSession]]]:
        """Every session, live or not, of each run the supervisor watches, run by run (one query per run)."""
        for run_id, sessions, _holds in self.watched_with_holds():
            yield run_id, sessions

    def watched_with_holds(self) -> Iterator[tuple[str, list[AgentSession], dict[str, int]]]:
        """``watched``, with each run's launch holds of agents that have no session yet (the same one query per
        run): the tick's check for a coordinator whose launch never came reads them."""
        for run_id in self._runs.listed():
            yield run_id, *self._agents_of(run_id)

    def active(self) -> Iterator[AgentSession]:
        """Every live session of the runs the supervisor watches, run by run."""
        for _run_id, sessions in self.watched():
            yield from (session for session in sessions if session.status in LIVE_STATUSES)
