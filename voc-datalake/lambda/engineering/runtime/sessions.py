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

from collections.abc import Iterator
from dataclasses import asdict, dataclass, field, replace
from decimal import Decimal
from typing import Any, Final, Literal

from botocore.exceptions import ClientError

from engineering.rows import LAUNCH_HOLD
from engineering.runtime.interface import AgentSpec, MicroVm
from engineering.runtime.runs import RunNotActive, RunStore, meta_key, run_pk
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
    return dict(asdict(session), egress=list(session.egress), paths=list(session.paths),
                harness=list(session.harness), input_tokens=session.input_tokens,
                output_tokens=session.output_tokens)


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
        inspect=plain(item.get('inspect') or {}),
        seq=int(item['seq']),
        **optional,
    )


class SessionStore:
    """``usd_per_second``: the deployment's price of a MicroVM second (0: not priced). Each write that moves the
    session adds the seconds it has not priced yet to the row's ``cost_usd`` (an ADD, as the brokers add theirs, so
    neither writes over the other), in the same conditional write, so a move counted once is priced once. Pricing
    goes forward only: time used while the price is 0 is never priced later."""

    def __init__(self, table: Any, runs: RunStore, usd_per_second: Decimal = Decimal(0)) -> None:
        self._table = table
        self._runs = runs
        self._usd_per_second = usd_per_second

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
        moved, cost = self._priced(replace(session, seq=session.seq + 1))
        self._write(moved, 'seq = :seen', {':seen': session.seq}, cost)
        return moved

    def claim(self, session: AgentSession, now: int, ttl: int) -> AgentSession:
        """Take ``session`` for one move until ``now + ttl``; ``StaleSession`` when it moved or someone holds it.

        Only the holder's next writes match the row's ``seq``, so nobody else moves the session meanwhile; a
        holder that died lets go when its claim lapses.
        """
        claimed, cost = self._priced(replace(session, seq=session.seq + 1, claimed_until=now + ttl))
        self._write(claimed, 'seq = :seen AND (attribute_not_exists(claimed_until) OR claimed_until < :now)',
                    {':seen': session.seq, ':now': now}, cost)
        return claimed

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
               cost: Decimal | None = None) -> None:
        try:
            self._table.update_item(**self._update(session, condition, values, cost=cost))
        except ClientError as error:
            if is_conditional_check_failure(error):
                raise StaleSession(f'session {session.run_id}/{session.agent_id} moved') from error
            raise

    def get(self, run_id: str, agent_id: str) -> AgentSession | None:
        item = consistent_item(self._table, _key(run_id, agent_id))
        return None if item is None or 'seq' not in item else _from_item(item)

    def of_run(self, run_id: str) -> list[AgentSession]:
        """Every session of one run, live or not (the run monitor's signals reach paused agents too)."""
        query = {'KeyConditionExpression': 'pk = :run AND begins_with(sk, :agent)',
                 'ExpressionAttributeValues': {':run': run_pk(run_id), ':agent': 'AGENT#'}, 'ConsistentRead': True}
        # A row the brokers metered before the session was written holds no session yet.
        return [_from_item(item) for item in iter_query(self._table, query) if 'seq' in item]

    def any_live_or_moving(self, run_id: str, now: int) -> bool:
        """An agent of the run is live, or one is being moved (a Resume may be starting a MicroVM for it)."""
        return any(session.status in LIVE_STATUSES or (session.claimed_until or 0) >= now
                   for session in self.of_run(run_id))

    def active(self) -> Iterator[AgentSession]:
        """Every live session of the runs the supervisor watches, run by run."""
        for run_id in self._runs.listed():
            yield from (session for session in self.of_run(run_id) if session.status in LIVE_STATUSES)
