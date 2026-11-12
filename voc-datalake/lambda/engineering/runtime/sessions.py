"""Agent sessions: one row per agent of a run, the supervisor's view of its MicroVM.

``ENGRUN#<run>`` / ``AGENT#<agent>`` in voc-agents. While the session is live the row is also on the
existing ``gsi1-by-agents-listing`` index under ``gsi1pk = ENG_SESSIONS_ACTIVE`` (no new index), which is
how the supervisor finds what to check; a session that ends or is paused by a person leaves it in the same
write. Every write is conditional on the row's ``seq``, so overlapping ticks never write over each other:
the second gets ``StaleSession`` and leaves the session to the next tick.

A row holds ids, times, the MicroVM's id and endpoint, the run monitor's inspection data and the live cost
counters (MicroVM seconds, tokens per model), never a token, a credential or a command's output.
"""
from __future__ import annotations

from collections.abc import Iterator
from dataclasses import asdict, dataclass, field, replace
from typing import Any, Final, Literal

from botocore.exceptions import ClientError

from engineering.runtime.interface import AgentSpec, MicroVm
from shared.aws import consistent_item, is_conditional_check_failure
from shared.dynamo_paging import iter_query
from shared.dynamo_values import plain
from shared.indexes import AGENTS_LISTING_INDEX

ACTIVE_KEY: Final = 'ENG_SESSIONS_ACTIVE'
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


class StaleSession(RuntimeError):
    """Someone else moved the session since it was read."""


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
    suspended_at: int | None = None
    #: Calls to this MicroVM that failed in a row (the third is a crash: it is gone or never came up).
    failures: int = 0
    #: A tick or a signal is moving this session until then (epoch seconds): nobody else may (``SessionStore.claim``).
    claimed_until: int | None = None
    #: The checkpoint this MicroVM restored from (None: the task's start).
    restore_key: str | None = None
    #: When the launcher's role session handed to this MicroVM lapses (None: none handed yet).
    session_expires_at: int | None = None
    #: Live cost and inspection data for the run monitor.
    microvm_seconds: int = 0
    last_tick_at: int | None = None
    tokens: dict[str, dict[str, int]] = field(default_factory=dict)
    inspect: dict[str, Any] = field(default_factory=dict)
    seq: int = 0

    def spec(self, restore_key: str | None = None) -> AgentSpec:
        return AgentSpec(run_id=self.run_id, agent_id=self.agent_id, role=self.role, task_id=self.task_id,
                         language=self.language, egress=self.egress, connection=self.connection,
                         restore_key=restore_key)

    @property
    def vm(self) -> MicroVm:
        return MicroVm(vm_id=self.vm_id, agent_id=self.agent_id, endpoint=self.endpoint)

    def on(self, vm: MicroVm, now: int, restore_key: str | None) -> AgentSession:
        """This session continued in ``vm``: booting again, the next continuation, nothing in flight."""
        return replace(self, vm_id=vm.vm_id, endpoint=vm.endpoint, started_at=now, status='booting',
                       continuation=self.continuation + 1, boot_index=0, exec_id=None, asked_at=None,
                       pause_requested_at=None, after_pause='continue', suspended=False, suspended_at=None,
                       failures=0, restore_key=restore_key,
                       session_expires_at=None, last_tick_at=now)


_OPTIONAL_INTS: Final = ('asked_at', 'pause_requested_at', 'session_expires_at', 'last_tick_at', 'suspended_at',
                         'claimed_until')
_OPTIONAL_STRS: Final = ('exec_id', 'restore_key')


def _to_item(session: AgentSession) -> dict[str, Any]:
    item = {key: value for key, value in asdict(session).items() if value is not None}
    item.update(pk=f'ENGRUN#{session.run_id}', sk=f'AGENT#{session.agent_id}',
                egress=list(session.egress), paths=list(session.paths), harness=list(session.harness))
    if session.status in LIVE_STATUSES:
        item.update(gsi1pk=ACTIVE_KEY, gsi1sk=f'{session.run_id}#{session.agent_id}')
    return item


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
        failures=int(item.get('failures', 0)),
        microvm_seconds=int(item.get('microvm_seconds', 0)),
        tokens=plain(item.get('tokens') or {}), inspect=plain(item.get('inspect') or {}), seq=int(item['seq']),
        **optional,
    )


class SessionStore:
    def __init__(self, table: Any) -> None:
        self._table = table

    def create(self, session: AgentSession) -> AgentSession:
        """Write a new session's row (refused when the agent already has one in this run)."""
        first = replace(session, seq=1)
        self._write(first, 'attribute_not_exists(pk)', {})
        return first

    def save(self, session: AgentSession) -> AgentSession:
        """Write ``session`` over the row it was read from; ``StaleSession`` when the row moved meanwhile."""
        moved = replace(session, seq=session.seq + 1)
        self._write(moved, 'seq = :seen', {':seen': session.seq})
        return moved

    def claim(self, session: AgentSession, now: int, ttl: int) -> AgentSession:
        """Take ``session`` for one move until ``now + ttl``; ``StaleSession`` when it moved or someone holds it.

        Only the holder's next writes match the row's ``seq``, so nobody else moves the session meanwhile; a
        holder that died lets go when its claim lapses.
        """
        claimed = replace(session, seq=session.seq + 1, claimed_until=now + ttl)
        self._write(claimed, 'seq = :seen AND (attribute_not_exists(claimed_until) OR claimed_until < :now)',
                    {':seen': session.seq, ':now': now})
        return claimed

    def _write(self, session: AgentSession, condition: str, values: dict[str, Any]) -> None:
        try:
            self._table.put_item(Item=_to_item(session), ConditionExpression=condition,
                                 **({'ExpressionAttributeValues': values} if values else {}))
        except ClientError as error:
            if is_conditional_check_failure(error):
                raise StaleSession(f'session {session.run_id}/{session.agent_id} moved') from error
            raise

    def get(self, run_id: str, agent_id: str) -> AgentSession | None:
        item = consistent_item(self._table, {'pk': f'ENGRUN#{run_id}', 'sk': f'AGENT#{agent_id}'})
        return None if item is None else _from_item(item)

    def of_run(self, run_id: str) -> list[AgentSession]:
        """Every session of one run, live or not (the run monitor's signals reach paused agents too)."""
        query = {'KeyConditionExpression': 'pk = :run AND begins_with(sk, :agent)',
                 'ExpressionAttributeValues': {':run': f'ENGRUN#{run_id}', ':agent': 'AGENT#'}, 'ConsistentRead': True}
        return [_from_item(item) for item in iter_query(self._table, query)]

    def active(self) -> Iterator[AgentSession]:
        """Every live session, page by page (the index is eventually consistent: each is re-read before a write)."""
        query = {'IndexName': AGENTS_LISTING_INDEX, 'KeyConditionExpression': 'gsi1pk = :active',
                 'ExpressionAttributeValues': {':active': ACTIVE_KEY}}
        for item in iter_query(self._table, query):
            run_id, _, agent_id = str(item['gsi1sk']).partition('#')
            session = self.get(run_id, agent_id)
            if session is not None and session.status in LIVE_STATUSES:
                yield session
