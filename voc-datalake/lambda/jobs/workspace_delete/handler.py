"""voc-workspace-delete: a workspace's hard delete (docs/multi-workspace.md, "Export and delete", steps 3 and 4;
decision 17).

Started by ``POST /me/workspaces/current/delete`` (shared/workspace_deletes.py ``request_delete``: the workspace
``deleting``, its job row ``WSDELETE`` / ``{ws}`` ``waiting``) with ``{workspace_id}``, the workspace named from the
request's resolved membership only; resumed by ``POST /platform/workspaces/{ws}/delete/resume``. Each invocation:

1. reads the workspace from its event (``message_scope``) and claims its generation on the job row (shared/
   workspace_deletes.py ``claim_generation``: a duplicate, stale or late delivery claims nothing and stops); the row
   must name the same workspace, and it, not the event, says where the run is (``_take_phase_from_the_row``: a row
   ``waiting`` or in the fence runs the fence; a resume with no checkpoint starts at the row's phase);
2. **the fence** (phase ``fence``, generation 0 and the waiting ones after it): nothing is deleted before the row's
   ``fence_at`` (``deleting_at`` + 21 minutes: every writer's cached ``active`` has expired and the invocation each
   was running has ended, shared/ws_repo.py ``workspace_is_active``). It sleeps toward it ``FENCE_STEP_SECONDS`` at
   a time, handing over after each step (so a waiting delete holds a reserved slot only briefly); at the fence it
   moves the row ``waiting`` → ``running`` (``begin_sweeps``), which a cancel races for on the same row: one of the
   two wins, and a lost race stops here, having deleted nothing;
3. runs ``SWEEPS`` (sweeps.py) in order, each a named phase, a page at a time from its checkpointed cursor; with
   less than ``TIME_RESERVE_MS`` left it records its checkpoint on the row and re-invokes itself, the event carrying
   the next generation only (the next invocation reads the checkpoint from the row). Every invocation past the fence
   first reads the workspace's ``META``: one that reads ``active`` stops the job (``failed``), whatever the phase;
4. **verifies** (``verify``): every partition the inventory lists, each fixed partition, the workspace's versions and
   open uploads, its credentials path and its control partition must hold nothing (a re-check of what the job can
   list, not a proof that nothing of the workspace is left anywhere: TENETS.md D5's gaps); anything found sends the
   job back to the first sweep once (every sweep is idempotent), then fails it naming the families left (never a
   key), checkpointed at the first sweep with its rounds reset, so a resume sweeps and verifies again;
5. deletes its inventory and the export LOCK it held to the end, writes the platform's ``completed`` audit row
   (counts, never a row's content) and ends the job
   ``completed``. Kept: ``AUDIT#WS#{ws}``, the tombstones, ``AUDIT#workspace-deletes``, the job row, ``SLUG#{slug}``
   (marked ``deleted_at``, reserved for good) and, until their TTL, the idempotency claims; backups and logs until
   they expire (TENETS.md D5's gaps).

Any failure (an AWS error, a refusal of the layer, too many hand-overs) ends the job ``failed`` with the error's type
only and its checkpoint on the row: a platform admin resumes it from there (a hand-over whose invoke fails fails the
row the same way, then raises). An invocation the timeout kills writes
nothing; the job reads ``failed`` an hour later and resumes the same way. No retry of its own (``retryAttempts`` 0),
events older than 40 minutes dropped, at most ``MAX_GENERATIONS``, two invocations at once in the deployment.

Env: ``FEEDBACK_TABLE``, ``AGGREGATES_TABLE``, ``MEMORY_TABLE``, ``WATERMARKS_TABLE``, ``WORKSPACES_TABLE``,
``RAW_DATA_BUCKET``, ``WORKSPACE_PARAMETER_PREFIX``, ``PLUGIN_IDS`` (the deployment's plugin ids, a JSON list),
``WORKSPACE_HARD_DELETE`` (``true``: the job is built only with ``-c workspaceHardDelete=true``, and refuses every
event without it).
"""
from __future__ import annotations

import json
import os
import time
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any, Final

from botocore.exceptions import BotoCoreError, ClientError

from jobs.workspace_delete.sweeps import (
    OWNER_LISTS,
    PARTITION_FAMILIES,
    SWEEPS,
    WORK_PARTITION,
    Context,
    OutOfTime,
    OwnerList,
    Sweep,
    listed_left,
    memory_pages,
    partition_has_rows,
    unthrottled,
)
from jobs.workspace_export.pages import items
from shared import workspace_deletes
from shared.aws import get_dynamodb_resource, get_s3_client, get_ssm_run_client, invoke_lambda_async
from shared.export_jobs import export_lock_key
from shared.ingest_tables import ingest_table
from shared.invocation_cost import instrumented_handler
from shared.jobs import has_time_left
from shared.logging import logger
from shared.tables import get_workspaces_table
from shared.timestamps import now_iso, parse_iso
from shared.warm_init import warm_at_init
from shared.workspace import ACTIVE
from shared.workspace_credentials import list_parameter_names
from shared.ws_repo import (
    LOOKUP_SORT_KEY,
    WATERMARK_DIRECTORY,
    WORKSPACE_FIELD,
    ExportObjects,
    WorkspaceObjectVersions,
    WorkspaceScope,
    WorkspaceTable,
    control_query,
    delete_work_pk,
    message_scope,
)

FEEDBACK_TABLE, AGGREGATES_TABLE, MEMORY_TABLE, WATERMARKS_TABLE, RAW_DATA_BUCKET, PARAMETER_PREFIX = (
    os.environ.get(name, '') for name in ('FEEDBACK_TABLE', 'AGGREGATES_TABLE', 'MEMORY_TABLE', 'WATERMARKS_TABLE',
                                          'RAW_DATA_BUCKET', 'WORKSPACE_PARAMETER_PREFIX'))

#: Hand over to a fresh invocation when less than this remains (a page's tombstones, its deletes, the checkpoint and
#: the invoke all fit in it).
TIME_RESERVE_MS: Final = 2 * 60 * 1000
#: A runaway guard: a delete this long means something is wrong; it fails loudly instead (600 times 15 minutes). A
#: resume grants another 600 (at most ``workspace_deletes.MAX_RESUMES`` resumes).
MAX_GENERATIONS: Final = 600
TOO_MANY_HAND_OVERS: Final = (f'Stopped after {MAX_GENERATIONS} hand-overs. A platform admin can resume it, with '
                              f'{MAX_GENERATIONS} more, at most {workspace_deletes.MAX_RESUMES} times in all')
#: The fence is waited for in steps: an invocation sleeps at most this long, then hands over, so a waiting delete
#: holds one of the job's two reserved slots only briefly and a third delete requested meanwhile is not throttled
#: past its event age (about 11 short invocations over the 21 minutes).
FENCE_STEP_SECONDS: Final = 120
#: How many verify passes find rows left before the job fails (each but the last sends it back to the first sweep).
VERIFY_ROUNDS: Final = 2
PHASE_FENCE: Final = workspace_deletes.PHASE_FENCE
VERIFY: Final = 'verify'
COMPLETE: Final = 'complete'
SWEEP_NAMES: Final = tuple(sweep.name for sweep in SWEEPS)
#: Every phase of a run, in order, each named (a checkpoint names the one it is in).
PHASES: Final = (PHASE_FENCE, *SWEEP_NAMES, VERIFY, WORK_PARTITION, COMPLETE)
#: What the completed audit row says is kept, or left to expire (never content).
KEPT: Final = {
    'audit': "AUDIT#WS#{ws} (the workspace's audit trail) and AUDIT#workspace-deletes, for good",
    'tombstones': 'AUDIT#tombstone#<source> and AUDIT#tombstone#memory, one per deleted item and memory, for good',
    'job_row': 'WSDELETE/{ws}, for good',
    'slug': 'SLUG#{slug}, marked deleted_at and kept: the slug is never reused',
    'idempotency': 'the processing claims in voc-idempotency (no content) until their TTL, at most two days',
    'backups_and_logs': 'point-in-time backups and logs keep what they hold until they expire (TENETS.md D5 gaps)',
}
_AWS_ERRORS: Final = (ClientError, BotoCoreError)


def _plugin_ids() -> tuple[str, ...]:
    try:
        parsed = json.loads(os.environ.get('PLUGIN_IDS') or '[]')
    except ValueError:
        return ()
    return tuple(plugin for plugin in parsed if isinstance(plugin, str)) if isinstance(parsed, list) else ()


def _counts(value: object) -> dict[str, int]:
    """A carried ``{name: count}`` (none: ``{}``)."""
    return {str(name): int(count) for name, count in value.items()} if isinstance(value, Mapping) else {}


def phase_of(value: object) -> str:
    """A checkpoint's phase; ValueError for anything else."""
    if isinstance(value, str) and value in PHASES:
        return value
    raise ValueError('not a delete phase')


def event_generation(event: Mapping[str, Any]) -> int:
    """The generation an event asks to claim (``run.generation``; 0 for a start). Nothing else of the event is read:
    where the run is comes from the job row's checkpoint (``RunState.from_row``)."""
    carried = event.get('run')
    generation = carried.get('generation', 0) if isinstance(carried, Mapping) else 0
    if isinstance(generation, bool) or not isinstance(generation, int) or generation < 0:
        raise ValueError('not a delete generation')
    return generation


@dataclass
class RunState:
    """Where a run is: the job row's ``checkpoint`` (each hand-over records it there first), at a generation."""

    generation: int = 0
    phase: str = PHASE_FENCE
    verify_rounds: int = 0
    cursor: dict[str, Any] | None = None
    #: Per sweep, the rows or objects it deleted; the tombstones written and kept.
    counts: dict[str, int] = field(default_factory=dict)
    #: What the verify pass under way found left, per family (a count, never a key).
    leftovers: dict[str, int] = field(default_factory=dict)

    @classmethod
    def from_row(cls, row: Mapping[str, Any], generation: int) -> RunState:
        """The row's ``checkpoint`` (a fresh state when it has none), its phase checked (``phase_of``)."""
        carried = row.get('checkpoint')
        if not isinstance(carried, Mapping):
            return cls(generation=generation)
        cursor = carried.get('cursor')
        return cls(phase=phase_of(carried.get('phase', PHASE_FENCE)), generation=generation,
                   verify_rounds=int(carried.get('verify_rounds') or 0),
                   cursor=dict(cursor) if isinstance(cursor, Mapping) else None,
                   counts=_counts(carried.get('counts')), leftovers=_counts(carried.get('leftovers')))

    def checkpoint(self) -> dict[str, Any]:
        """What the row records for the next invocation (everything but the generation, which the event carries)."""
        return {'phase': self.phase, 'cursor': self.cursor, 'counts': dict(self.counts),
                'verify_rounds': self.verify_rounds, 'leftovers': dict(self.leftovers)}


class _HandOver(OutOfTime):
    """The time ran low between two pages (or inside one: sweeps.py ``OutOfTime``): the run's cursor is where to
    resume."""


class _VerifyFailed(RuntimeError):
    """The verify pass still found rows after its last round; its message names the families, never a key."""


class DeleteRun:
    """One invocation of one workspace's delete (see the module docstring)."""

    def __init__(self, scope: WorkspaceScope, row: Mapping[str, Any], run: RunState, context: Any) -> None:
        self.scope = scope
        self.row = row
        self.run = run
        self.context = context
        self.workspaces = get_workspaces_table()
        resource = get_dynamodb_resource()
        s3 = get_s3_client()
        self.ctx = Context(
            scope=scope, feedback=ingest_table(scope, resource, FEEDBACK_TABLE),
            aggregates=ingest_table(scope, resource, AGGREGATES_TABLE),
            memory=ingest_table(scope, resource, MEMORY_TABLE),
            watermarks=ingest_table(scope, resource, WATERMARKS_TABLE, key='source'),
            workspaces=self.workspaces, objects=WorkspaceObjectVersions(scope, s3, RAW_DATA_BUCKET),
            exports=ExportObjects(scope, s3, RAW_DATA_BUCKET), ssm=get_ssm_run_client(),
            parameter_prefix=PARAMETER_PREFIX, plugin_ids=_plugin_ids(), job=row,
            settings=ingest_table(None, resource, AGGREGATES_TABLE).table, counts=run.counts,
            time_left=lambda: has_time_left(context, TIME_RESERVE_MS))
        self._take_phase_from_the_row()

    def _take_phase_from_the_row(self) -> None:
        """The job row decides where the run is (its checkpoint already is the run, ``RunState.from_row``): a row
        ``waiting`` or in the fence runs the fence, so nothing is deleted while a cancel can still win; a row past the
        fence whose checkpoint is still the fence's or missing (a job that stopped before its first hand-over past
        it) starts at the row's phase."""
        row_phase = self.row.get('phase')
        if self.row.get('status') == workspace_deletes.WAITING or row_phase == PHASE_FENCE:
            self.run.phase, self.run.cursor = PHASE_FENCE, None
        elif self.run.phase == PHASE_FENCE:
            self.run.phase = row_phase if row_phase in PHASES and row_phase != COMPLETE else SWEEP_NAMES[0]
            self.run.cursor = None

    # ── The run ─────────────────────────────────────────────────────────────────────────────────────────────

    def execute(self) -> dict[str, Any]:
        """The invocation's outcome; any AWS error or refusal fails the job (resumable from its checkpoint). A
        hand-over that cannot be written or sent fails the job too, then raises (``_hand_over``)."""
        # Each resume grants another MAX_GENERATIONS (shared/workspace_deletes.py bounds the resumes).
        if self.run.generation >= MAX_GENERATIONS * (1 + int(self.row.get('resumes') or 0)):
            return self.fail(TOO_MANY_HAND_OVERS)
        try:
            return self._execute()
        except OutOfTime:  # _HandOver too
            return self._hand_over()
        except _VerifyFailed as error:
            return self._failed('VerifyFailed', str(error))
        except (*_AWS_ERRORS, ValueError, RuntimeError) as error:
            return self._failed(type(error).__name__, f'The delete failed in {self.run.phase} ({type(error).__name__})')

    def _failed(self, failure: str, message: str) -> dict[str, Any]:
        # The error TYPE only in the log: a message (or a traceback) could quote a key back into the logs.
        logger.error('Workspace delete failed', extra={'workspace_id': self.scope.ws, 'phase': self.run.phase,
                                                       'error_type': failure})
        return self.fail(message)

    def _execute(self) -> dict[str, Any]:
        if self.run.phase == PHASE_FENCE and not self._past_fence():
            return {'status': 'stopped', 'workspace_id': self.scope.ws}
        if self._active_again():
            return self.fail('The workspace is active again: the delete stopped')
        while self.run.phase in SWEEP_NAMES or self.run.phase == VERIFY:
            self._sweeps()
            if self.run.phase == VERIFY:
                self._verify()
        if self.run.phase == WORK_PARTITION:
            self._delete_inventory()
            self._advance()
        return self._complete()

    def _check_time(self) -> None:
        """``_HandOver`` once less than ``TIME_RESERVE_MS`` of the invocation is left."""
        if not has_time_left(self.context, TIME_RESERVE_MS):
            raise _HandOver

    def _past_fence(self) -> bool:
        """Wait for the fence (sleeping toward it at most ``FENCE_STEP_SECONDS``, then ``_HandOver``), then end it:
        the row ``running`` in the first sweep; False when a cancel won the row first."""
        fence_at = parse_iso(self.row.get('fence_at'))
        if fence_at is None:
            raise ValueError('a delete job row without its fence')
        remaining = (fence_at - datetime.now(UTC)).total_seconds()
        if remaining > 0:
            budget = (self.context.get_remaining_time_in_millis() - TIME_RESERVE_MS) / 1000
            time.sleep(max(0.0, min(remaining, budget, FENCE_STEP_SECONDS)))
            if datetime.now(UTC) < fence_at:
                raise _HandOver
        if not workspace_deletes.begin_sweeps(self.workspaces, self.scope.ws, self.run.generation, SWEEP_NAMES[0],
                                              datetime.now(UTC)):
            logger.info('Workspace delete not begun (cancelled, or another invocation holds it)',
                        extra={'workspace_id': self.scope.ws})
            return False
        self.run.phase, self.run.cursor = SWEEP_NAMES[0], None
        return True

    def _active_again(self) -> bool:
        """Whether the workspace's ``META`` reads ``active`` (a delete never runs on an active workspace; one gone is
        the control rows' sweep done)."""
        page = control_query(self.scope, self.workspaces, 'meta', sort_condition='#sk = :meta',
                             ExpressionAttributeNames={'#sk': 'sk'},
                             ExpressionAttributeValues={':meta': LOOKUP_SORT_KEY}, ConsistentRead=True)
        found = items(page)
        return bool(found) and found[0].get('status') == ACTIVE

    def _sweeps(self) -> None:
        """Every sweep from the run's on, a page at a time; ``_HandOver`` when the time runs low."""
        while self.run.phase in SWEEP_NAMES:
            self._sweep(SWEEPS[SWEEP_NAMES.index(self.run.phase)])
            self._advance()

    def _sweep(self, sweep: Sweep) -> None:
        """One sweep from the run's cursor: each page noted, tombstoned, then deleted, in that order."""
        while True:
            self._check_time()
            batch = sweep.pages(self.ctx, self.run.cursor)
            for step in (sweep.note, sweep.tombstone):
                if step is not None and batch.rows:
                    step(self.ctx, batch)
            self.ctx.count(sweep.name, sweep.delete(self.ctx, batch))
            self.run.cursor = batch.following
            if batch.following is None:
                return

    def _advance(self) -> None:
        self.run.phase = PHASES[PHASES.index(self.run.phase) + 1]
        self.run.cursor = None

    # ── Verify ──────────────────────────────────────────────────────────────────────────────────────────────

    def _verify(self) -> None:
        """Every check in turn (``VERIFY_CHECKS``), one step at a time from the run's cursor (a long inventory hands
        over like a sweep); then on to the inventory's delete, or back to the first sweep, or a failure."""
        while True:
            cursor = self.run.cursor or {'check': 0, 'start': None}
            index = int(cursor['check'])
            if index >= len(VERIFY_CHECKS):
                break
            self._check_time()
            name, check = VERIFY_CHECKS[index]
            found, following = check(self, cursor.get('start'))
            if found:
                self.run.leftovers[name] = self.run.leftovers.get(name, 0) + found
            self.run.cursor = {'check': index, 'start': following} if following else {'check': index + 1,
                                                                                         'start': None}
        leftovers, self.run.leftovers = dict(self.run.leftovers), {}
        if not leftovers:
            self._advance()
            return
        self.run.verify_rounds += 1
        logger.warning('Workspace delete verify found rows left', extra={'workspace_id': self.scope.ws,
                                                                         'families': sorted(leftovers)})
        exhausted = self.run.verify_rounds >= VERIFY_ROUNDS
        # Every sweep is idempotent: once more, from the first. A job that fails here is checkpointed there too, its
        # rounds reset, so its resume sweeps again and verifies again, never completes past what was left.
        self.run.phase, self.run.cursor = SWEEP_NAMES[0], None
        if exhausted:
            self.run.verify_rounds = 0
            raise _VerifyFailed(f'The verify pass found rows left in {", ".join(sorted(leftovers))}')

    # ── Hand-over and the end ───────────────────────────────────────────────────────────────────────────────

    def _checkpoint(self) -> dict[str, Any]:
        return self.run.checkpoint()

    def _hand_over(self) -> dict[str, Any]:
        """Record the checkpoint, then invoke the next generation with it. If either call fails, the row is failed
        first (resumable from its checkpoint, said now rather than an hour later), and then the error is raised."""
        generation = self.run.generation
        # The generation only: the next invocation reads where to resume from the checkpoint recorded here.
        following = {WORKSPACE_FIELD: self.scope.ws, 'run': {'generation': generation + 1}}
        try:
            if not workspace_deletes.record_progress(self.workspaces, self.scope.ws, generation, {
                    'progress_at': now_iso(), 'phase': self.run.phase,
                    'checkpoint': self._checkpoint(), 'counts': dict(self.run.counts)}):
                logger.warning('Workspace delete row moved on (cancelled, or another invocation holds it); this '
                               'invocation stops', extra={'workspace_id': self.scope.ws})
                return {'status': 'stopped', 'workspace_id': self.scope.ws}
            invoke_lambda_async(self.context.function_name, following)
        except _AWS_ERRORS as error:
            self.fail(f'The hand-over failed in {self.run.phase} ({type(error).__name__})')
            raise
        self.run.generation = generation + 1
        return {'status': 'continued', 'workspace_id': self.scope.ws, 'generation': self.run.generation}

    def _delete_inventory(self) -> None:
        """The inventory, then the export LOCK the delete held to the end (sweeps.py ``_export_pages``)."""
        partition = delete_work_pk(self.scope)
        while True:
            self._check_time()
            rows = items(self.ctx.aggregates.query('pk', partition, Limit=1000, ConsistentRead=True,
                                                   ProjectionExpression='pk, sk'))
            if not rows:
                break
            self.ctx.count(WORK_PARTITION, _remove_rows(self.ctx.aggregates, rows))
        _remove_rows(self.ctx.aggregates, [export_lock_key(self.scope)])

    def _complete(self) -> dict[str, Any]:
        now = datetime.now(UTC)
        kept = {name: text.format(ws=self.scope.ws, slug=self.row.get('slug') or '') for name, text in KEPT.items()}
        workspace_deletes.audit_completed(self.workspaces, self.row, self.run.counts, kept, now.isoformat())
        written = workspace_deletes.finish_job(self.workspaces, self.scope.ws, self.run.generation,
                                               workspace_deletes.COMPLETED,
                                               {'completed_at': now.isoformat(), 'phase': COMPLETE,
                                                'counts': dict(self.run.counts), 'checkpoint': self._checkpoint()})
        logger.info('Workspace deleted', extra={'workspace_id': self.scope.ws, 'counts': dict(self.run.counts)})
        return {'status': workspace_deletes.COMPLETED if written else 'stopped', 'workspace_id': self.scope.ws}

    def fail(self, error: str) -> dict[str, Any]:
        """End the job ``failed`` with ``error`` (no row content), its checkpoint kept for a resume."""
        written = workspace_deletes.finish_job(self.workspaces, self.scope.ws, self.run.generation,
                                               workspace_deletes.FAILED,
                                               {'error': error, 'progress_at': now_iso(),
                                                'phase': self.run.phase, 'checkpoint': self._checkpoint(),
                                                'counts': dict(self.run.counts)})
        return {'status': workspace_deletes.FAILED if written else 'stopped', 'workspace_id': self.scope.ws}


def _remove_rows(table_view: WorkspaceTable, rows: list[dict[str, Any]]) -> int:
    keys = [{'pk': row['pk'], 'sk': row['sk']} for row in rows]
    return unthrottled(lambda: table_view.batch_delete(keys))


# ── The verify pass: (family, one step from a cursor's start → (rows or partitions found, the next start)) ──────

Check = Callable[[DeleteRun, Any], tuple[int, Any]]


def _listed(kind: str, table: str) -> Check:
    """Each partition listed under ``kind``, one inventory page a step."""
    return lambda run, start: listed_left(run.ctx, getattr(run.ctx, table), kind, start)


def _partition(partition: Callable[[WorkspaceScope], str]) -> Check:
    return lambda run, _start: (int(partition_has_rows(run.ctx.aggregates, partition(run.scope))), None)


def _owner_list_left(owners: OwnerList) -> Check:
    """An owner-list entry's list is deleted last, so a list still there means its sweep did not finish."""
    return lambda run, _start: (int(partition_has_rows(owners.view_of(run.ctx), owners.list_partition(run.scope))),
                                None)


def _memory_left(run: DeleteRun, _start: object) -> tuple[int, Any]:
    """Every memory row the memory sweep reads (its company partition, the personal status partitions of its
    index, its cursors and imports)."""
    left, cursor = 0, None
    while True:
        batch = memory_pages(run.ctx, cursor)
        left += len(batch.rows)
        if batch.following is None:
            return left, None
        cursor = batch.following


def _exports_left(run: DeleteRun, _start: object) -> tuple[int, Any]:
    """The export jobs' partition holds nothing but its LOCK (the delete's, deleted with the inventory, last)."""
    lock = export_lock_key(run.scope)
    rows = items(run.ctx.aggregates.query('pk', lock['pk'], Limit=2, ConsistentRead=True,
                                          ProjectionExpression='pk, sk'))
    return len([row for row in rows if row.get('sk') != lock['sk']]), None


def _objects_left(run: DeleteRun, _start: object) -> tuple[int, Any]:
    return len(run.ctx.objects.list_page(None).versions) + len(run.ctx.objects.open_uploads()), None


def _credentials_left(run: DeleteRun, _start: object) -> tuple[int, Any]:
    return len(list_parameter_names(run.ctx.ssm, run.ctx.parameter_prefix, run.scope.ws)), None


def _control_left(run: DeleteRun, _start: object) -> tuple[int, Any]:
    return len(items(control_query(run.scope, run.workspaces, 'meta', Limit=1, ConsistentRead=True))), None


#: The verify pass's checks, in order.
VERIFY_CHECKS: Final[tuple[tuple[str, Check], ...]] = (
    ('credentials', _credentials_left),
    ('feedback', _listed('feedback', 'feedback')),
    ('counters', _listed('counter', 'aggregates')),
    *((name, _listed(name, 'aggregates')) for name in PARTITION_FAMILIES),
    *((name, _owner_list_left(owners)) for name, owners in OWNER_LISTS.items()),
    ('watermarks', _partition(lambda scope: scope.key(WATERMARK_DIRECTORY))),
    ('memory', _memory_left),
    ('exports', _exports_left),
    ('objects', _objects_left),
    ('control_rows', _control_left),
)


def handle_event(event: dict[str, Any], context: Any) -> dict[str, Any]:
    """One invocation of a workspace's delete (see the module docstring)."""
    if not workspace_deletes.hard_delete_enabled():
        # The deployment flag is off (lib/utils/workspace-hard-delete.ts): nothing is claimed, read or deleted.
        logger.error('Workspace hard delete is turned off in this deployment; the event is refused')
        return {'status': 'disabled'}
    refused, scope = message_scope(event)
    if refused or scope is None:
        logger.error('Delete event without a valid workspace')
        return {'status': 'ignored'}
    try:
        generation = event_generation(event)
    except ValueError:
        logger.warning('Delete event without a valid generation', extra={'workspace_id': scope.ws})
        return {'status': 'ignored'}
    row = workspace_deletes.claim_generation(get_workspaces_table(), scope.ws, generation, datetime.now(UTC))
    if row is None:
        logger.info('Delete generation not claimed (missing, finished, a duplicate or late)',
                    extra={'workspace_id': scope.ws, 'generation': generation})
        return {'status': 'not_claimed', 'workspace_id': scope.ws}
    try:
        run, unreadable = RunState.from_row(row, generation), False
    except ValueError:
        run, unreadable = RunState(generation=generation), True
    delete = DeleteRun(scope, row, run, context)
    if row.get(WORKSPACE_FIELD) != scope.ws:
        return delete.fail('The job row names another workspace')
    if unreadable:
        return delete.fail('The job row holds a checkpoint this job cannot read')
    return delete.execute()


# Build the AWS clients during INIT, not on the first request (shared/warm_init.py).
warm_at_init(get_dynamodb_resource, get_s3_client)


@instrumented_handler
def lambda_handler(event: dict, context: Any) -> dict:
    return handle_event(event, context)
