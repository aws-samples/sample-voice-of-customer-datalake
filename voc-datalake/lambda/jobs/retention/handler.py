"""voc-retention: the opt-in per-source retention and erasure worker.

The only Lambda that deletes customer feedback (``shared/retention.py`` says
what and how), and only for a legal obligation (TENETS.md D5). Two modes:

- ``{"mode": "retention"}`` — the daily schedule (an event without ``mode``
  reads the same). Deletes items of every source whose profile sets
  ``retention_days`` and whose ``date`` is older than the cutoff, under the
  profile's ``retention_legal_basis`` (``shared/legal_basis.py``). Nothing is
  deleted when no profile sets one, or when the profiles cannot be read.
- ``{"mode": "erase", "job_id": "er_<12 hex>", "value": ...}`` — started by
  ``POST /settings/erasure`` (async invoke). The job row (``pk JOB#erasure``)
  holds the field, the optional source, the legal basis and the value's
  SHA-256; the value itself travels only in the invoke payload, is checked
  against that hash, and is never stored or logged. A workspace's job row is
  ``WS#{ws}#JOB#erasure`` (shared/erasure_jobs.py), the event naming that
  workspace (``workspace_id``, written only by the server from the request's
  resolved membership, shared/erasure_scope.py) and the row naming the same
  one: the run then reaches that workspace's feedback items and their copies
  only (``_named_workspace``), by author, source id, CSV row or email (by email also
  the addresses in its projects), and frees the workspace's one-erasure lock when it ends.

A run walks its PHASES in order, each paged and time-budgeted:

1. ``items`` — voc-feedback. An erasure by email and a retention window reach every workspace's items too
   (``WS#{ws}#SOURCE#…``, with their objects under ``ws/{ws}/``; counted in ``deleted_workspace_items`` as
   well); an erasure by author (a display name), source id or CSV row (ids unique only within one account or
   upload) and a whole-source erasure leave them (``shared/retention.reaches_workspaces``); a job that names a
   workspace reaches that workspace's items only, and walks no other phase but its projects and its participants (by
   email), its exports and its projects' lineage marks. Since 7.96.00 such a job reads no Scan except in two
   fallbacks: its items are found on the workspace's own index partitions, filtered there by the Scan's own filter,
   keys only, each hit read again from the table (strongly consistent) and erased only if that row still matches
   (``item_walk.py``: by source id one Query of gsi4-by-feedback-id, else the gsi1-by-date day walk from the
   workspace's creation); it Scans only when handed over with a Scan cursor or when its workspace names no creation
   time (counted, ``workspace_item_scans``). Its ``scanned`` count is then the index hits (the rows the index's filter
   matched), not rows of the table. Every other run Scans as before;
   then ``form_tests`` — a feedback form's test responses (voc-aggregates, their own test partitions: the deployment's
   ``FEEDBACK_FORM_TEST`` and, as for items, the workspaces' ``WS#{ws}#FEEDBACK_FORM_TEST``), when the run reaches the
   ``feedback_form`` source: its retention window, an erasure by email or name, or its whole-source erasure
   (``form_tests.py``, since 7.55.00's AI review); a job that names a workspace walks that workspace's only;
   then (after the boards and memberships below, before the raw sweep's successor, lineage) ``exports`` — an erasure
   only, once it deleted any workspace's item or de-identified one of its memberships: that workspace's exports, a
   derived copy (``exports.py``): its export jobs marked ``erased``, its open export upload aborted, every version
   under ``ws/{ws}/exports/`` deleted and swept once more (``deleted_export_objects``);
2. ``radar`` — voc-radar (other brands' reviews), when ``RADAR_TABLE`` is set;
   then ``boards`` — an erasure by email only, when ``FEATURE_REQUESTS_TABLE`` is set:
   the person's board requests and +1s are de-identified and their raw copies deleted
   (``boards.py``); then ``members`` — an erasure by email without a source, when
   ``WORKSPACES_TABLE`` is set: the email and name on the person's workspace membership
   rows are removed (``members.py``); then ``workspace_projects`` — an erasure by email without a source, when
   ``PROJECTS_TABLE`` is set (the deployment's job walks the deployment's own projects first, since 7.48.00, then,
   with ``WORKSPACES_TABLE``, every listed workspace's; a job that names a workspace walks its own): the address is
   removed from each walked scope's reviewer comment threads, review link audiences and project ``META`` rows, and
   the product documents that hold it are listed for review (``project_people.py``, since 7.43.00); then
   ``participants`` — the same erasures, when ``PARTICIPANTS_TABLE`` is set (since 7.72.00): the address is looked up
   in the deployment's participant guard and each listed workspace's (a workspace's own job: its own guard), and each
   person found is erased in voc-participants, their ids saved first (``participants.py``); then ``agent_memory`` —
   the deployment's erasure by email without a source, with ``ENGINEERING_TABLE`` and ``USER_POOL_ID`` set (-c
   engineeringAgents=true, since 7.84.00): the address's verified account in the user pool, its ``sub`` saved first,
   erased from the engineering agents' memory (``agent_memory.py``);
3. ``raw`` — whole-source erasure only: every object version left under
   ``raw/{source}/`` and ``silver/{source}/`` (``shared/retention.delete_raw_prefix_page``);
4. ``lineage`` — when the run deleted anything of the deployment's and ``PROJECTS_TABLE`` is set:
   the deployment's artifacts that cited a deleted item are marked, its projects found through its project registry
   (``PROJECT_IDS``, since 7.48.00; ``lineage.py``), which the review registries' backfill must have completed (its
   marker) and which must list every live project (the gap check), since 7.93.00; then ``engineering_lineage`` — with ``ENGINEERING_TABLE`` and ``AGENTS_TABLE`` set
   (since 7.84.00), in every erasure of the deployment and a retention window that deleted an item of the deployment's
   feedback: the erased review ids leave the engineering runs' ``META`` and the issues' run claims
   (``engineering_lineage.py``); then ``workspace_lineage`` —
   when the run deleted a workspace's item: that workspace's artifacts that cite it, found through its project
   registry, never a Scan (``lineage.py``, since 7.43.00).

Each deleted item first gets a tombstone (``copies.py``); its kept Silver versions
(``silver/{source}/{feedback_id}/``) are deleted with it (``shared/retention.delete_item``). Before the Lambda's
budget runs out, or once a phase has read ``MAX_PAGES`` pages, the worker re-invokes itself with its phase, the
phase's scan cursor and its running state (``runs.py``). A scan that answers with the cursor it was read from
fails the run (``CursorStuck``) rather than reading the same page again. Deletes are idempotent, so a
duplicate delivery or an overlapping daily run only repeats no-ops. Every
finished run (and every failure) writes one audit row (``pk AUDIT#retention``).

The deployment's review registries (since 7.93.00, projects 3g-d2): every run that names no workspace and can delete or replay, with
``PROJECTS_TABLE`` set, starts with the ``registries`` phase (``registries.py``: the backfill's marker, then the gap
check, bounded and handed over like the other phases), whose result is the run's (``review_registries`` on its rows).
The deployment's erasure by email without a source fails there, by name, before it deletes anything (its people walk
cannot be owed: the address is not stored). Every other run deletes as usual, and without complete registries it OWES
its deployment ``lineage`` pass (one durable row, ``JOB#retention`` / ``LINEAGE_OWED``), which the next run with
complete registries replays, whether it deleted anything or not, then clears. The marker is read again at each
invocation's start, so an ``--unmark`` during a run is seen. A failure an admin fixes outside the job
(``registries.NeedsAnAdmin``) puts what to do on the job's and audit rows beside its name, fixed text that quotes
nothing of the erasure; a failed run and a run that owes print the alarm's EMF line (``RetentionRunFailed``,
``RetentionLineageOwed``; shared/ops_alerts.py).

A deployment-wide run (an erasure that names no workspace, the retention window) runs as the deployment; each step it
takes inside one workspace is attributed to that workspace for its log lines (``workspaces.inside``, since 7.84.00).

Env: ``FEEDBACK_TABLE``, ``AGGREGATES_TABLE``, ``RAW_DATA_BUCKET``, ``RADAR_TABLE``, ``PROJECTS_TABLE``,
``FEATURE_REQUESTS_TABLE``, ``WORKSPACES_TABLE``, ``PARTICIPANTS_TABLE``; with -c engineeringAgents=true also
``ENGINEERING_TABLE``, ``AGENTS_TABLE`` and ``USER_POOL_ID``.
"""

from __future__ import annotations

import os
import re
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any, Final, NoReturn

from boto3.dynamodb.conditions import ConditionBase
from botocore.exceptions import BotoCoreError, ClientError

from jobs.retention import (
    agent_memory,
    boards,
    engineering_lineage,
    exports,
    form_tests,
    item_walk,
    lineage,
    members,
    participants,
    project_people,
    registries,
    workspaces,
)
from jobs.retention.copies import ItemDeleter, write_tombstones
from jobs.retention.runs import (
    AGENT_MEMORY_DUE,
    MODE_ERASE,
    MODE_RETENTION,
    carried_state,
    claim_erasure_job,
    finish_erasure_job,
    job_scope,
    new_run,
    optional_counts,
    record_progress,
    write_audit,
)
from shared import retention
from shared.aws import (
    get_cognito_idp_client,
    get_dynamodb_client,
    get_dynamodb_resource,
    get_s3_client,
    invoke_lambda_async,
)
from shared.data_version import bump_data_version, bump_radar_version
from shared.digests import sha256_hex
from shared.erasure_jobs import refresh_workspace_lock, release_workspace_lock
from shared.invocation_cost import instrumented_handler
from shared.jobs import has_time_left
from shared.legal_basis import legal_basis_or_legacy
from shared.logging import logger, metrics
from shared.retention import (
    BOARD_COUNTER,
    SOURCE_FIELD,
    STORE_FEEDBACK,
    STORE_RADAR,
    UNSCOPED_ROW_COUNTER,
    WORKSPACE_ERASE_FIELDS,
    WORKSPACE_ITEM_COUNTER,
)
from shared.source_erasure import refresh_source_lock, release_source_lock
from shared.source_profiles import SOURCE_ID_RE, load_source_profiles
from shared.warm_init import warm_at_init
from shared.ws_repo import WORKSPACE_FIELD, WorkspaceScope, message_scope, scope_from_message

# Bundled beside `shared/` (no sys.path shim); tests import `jobs.retention.handler`.
(FEEDBACK_TABLE, AGGREGATES_TABLE, RAW_DATA_BUCKET, RADAR_TABLE, PROJECTS_TABLE, FEATURE_REQUESTS_TABLE,
 WORKSPACES_TABLE, PARTICIPANTS_TABLE, ENGINEERING_TABLE, AGENTS_TABLE, USER_POOL_ID) = (
    os.environ.get(name, '')
    for name in ('FEEDBACK_TABLE', 'AGGREGATES_TABLE', 'RAW_DATA_BUCKET', 'RADAR_TABLE', 'PROJECTS_TABLE',
                 'FEATURE_REQUESTS_TABLE', 'WORKSPACES_TABLE', 'PARTICIPANTS_TABLE', 'ENGINEERING_TABLE',
                 'AGENTS_TABLE', 'USER_POOL_ID'))

JOB_ID_RE: Final = re.compile(r'^er_[0-9a-f]{12}\Z')
STATUS_COMPLETED: Final = 'completed'
STATUS_FAILED: Final = 'failed'
PHASE_REGISTRIES: Final = registries.PHASE
PHASE_ITEMS: Final = 'items'
PHASE_FORM_TESTS: Final = 'form_tests'
PHASE_EXPORTS: Final = 'exports'
PHASE_RADAR: Final = 'radar'
PHASE_BOARDS: Final = 'boards'
PHASE_MEMBERS: Final = 'members'
PHASE_RAW: Final = 'raw'
PHASE_LINEAGE: Final = 'lineage'
PHASE_WORKSPACE_PROJECTS: Final = project_people.STORE_PROJECTS
PHASE_WORKSPACE_LINEAGE: Final = 'workspace_lineage'
PHASE_PARTICIPANTS: Final = participants.STORE_PARTICIPANTS
PHASE_AGENT_MEMORY: Final = 'agent_memory'
PHASE_ENGINEERING_LINEAGE: Final = 'engineering_lineage'
_PHASE_STORES: Final = {PHASE_ITEMS: STORE_FEEDBACK, PHASE_RADAR: STORE_RADAR}

PAGE_SIZE: Final = 100
# Hand over to a fresh invocation when less than this remains of the budget.
TIME_RESERVE_MS: Final = 60 * 1000
# A runaway guard: a chain this long means something is wrong (the table would
# have to hold millions of matching items); it stops and fails loudly instead.
MAX_GENERATIONS: Final = 500
# The most pages one phase reads in one invocation (a million rows scanned at PAGE_SIZE): past it the phase hands
# over exactly as when the time runs low, so every loop of the walk is finite whatever the clock says. A store whose
# pages come back in under 84 ms reaches it before the clock (14 minutes of budget): one more hand-over per million
# rows, the same reads. With MAX_GENERATIONS a run stops (fails) past 500 million rows scanned.
MAX_PAGES: Final = 10_000

_AWS_ERRORS: Final = (ClientError, BotoCoreError)

# The scan filter of one store (shared.retention.STORE_*), built once per invocation by the mode's setup.
Filters = Callable[[str], ConditionBase]
# The invocation's clock: whether there is still room for one more slice before handing over.
TimeLeft = Callable[[], bool]


@dataclass
class Walk:
    """One invocation's tables, clients, state and clock, handed to every phase.

    ``time_left`` is the one budget clock every phase reads (``_lambda_clock`` in the Lambda); ``clock`` the wall
    clock a walk of the workspace listing stamps its start and its re-walk passes with (workspaces.py); ``context``
    names the function a hand-over re-invokes.
    """

    tables: dict[str, Any]
    context: Any
    event: dict[str, Any]
    run: dict[str, Any]
    #: The store scans' filters; None for a run that scans no store (``owed_only``).
    filters: Filters | None
    s3: Any
    time_left: TimeLeft
    clock: Callable[[], datetime] = workspaces.utc_now
    #: A retention window that retains nothing but replays owed lineage (7.93.00): its registries and lineage phases.
    owed_only: bool = False
    #: Whether this invocation read the review registries' marker already (``_recheck_marker``, 7.93.00).
    marker_read: bool = False

    @property
    def aggregates(self) -> Any:
        return self.tables['aggregates']


def _lambda_clock(context: Any) -> TimeLeft:
    """The Lambda's own clock: more than ``TIME_RESERVE_MS`` of the invocation's budget remain."""
    return lambda: has_time_left(context, TIME_RESERVE_MS)


def _tables() -> dict[str, Any]:
    dynamodb = get_dynamodb_resource()
    tables = {STORE_FEEDBACK: dynamodb.Table(FEEDBACK_TABLE), 'aggregates': dynamodb.Table(AGGREGATES_TABLE)}
    for name, table_name in ((STORE_RADAR, RADAR_TABLE), ('projects', PROJECTS_TABLE),
                             (boards.STORE_BOARDS, FEATURE_REQUESTS_TABLE),
                             (members.STORE_MEMBERS, WORKSPACES_TABLE),
                             (participants.STORE_PARTICIPANTS, PARTICIPANTS_TABLE),
                             # Only with -c engineeringAgents=true (7.84.00): voc-engineering and voc-agents.
                             (engineering_lineage.STORE_ENGINEERING, ENGINEERING_TABLE),
                             (engineering_lineage.STORE_AGENTS, AGENTS_TABLE)):
        if table_name:
            tables[name] = dynamodb.Table(table_name)
    return tables


# ============================================
# Run setup (one per mode)
# ============================================

def _retention_setup(aggregates_table: Any, run: dict[str, Any]) -> Filters | None:
    """The scan filters for today's retention run, or None when nothing is retained."""
    profiles = load_source_profiles(aggregates_table)
    cutoffs = retention.retention_cutoffs(profiles, datetime.now(UTC).date())
    if not cutoffs:
        return None
    run['cutoffs'] = cutoffs
    # Each retained source's basis; a profile saved before 6.00.00 reads "not recorded".
    run['legal_bases'] = {str(profile['id']): legal_basis_or_legacy(profile.get('retention_legal_basis'))
                          for profile in profiles if str(profile['id']) in cutoffs}
    return lambda store: retention.retention_filter(cutoffs, store)


def _erase_setup(aggregates_table: Any, event: dict[str, Any], run: dict[str, Any]) -> Filters | None:
    """The scan filters for an erasure job, or None when the job cannot (or need not) run."""
    job_id, value = event.get('job_id'), event.get('value')
    if not isinstance(job_id, str) or not JOB_ID_RE.match(job_id) or not isinstance(value, str) or not value:
        logger.error('Erasure event without a valid job_id and value')
        return None
    refused, partition = message_scope(event)
    if refused:
        logger.error('Erasure event whose workspace_id names no workspace', extra={'job_id': job_id})
        return None
    # A workspace job's id and partition are already on the run (``_workspace_job``, before any read); the
    # deployment's job_id only after a successful claim, as before (a claim fault then fails no row).
    job = claim_erasure_job(aggregates_table, job_id, partition)
    if job is None:
        logger.info('Erasure job is missing or already finished', extra={'job_id': job_id})
        return None
    run.update(job_id=job_id, field=job.get('field'), source=job.get('source') or None,
               value_hash=job.get('value_hash'), legal_basis=legal_basis_or_legacy(job.get('legal_basis')),
               started_by_sub=job.get('started_by_sub'))
    if job.get('value_hash') != sha256_hex(value):
        raise ValueError('The erasure value does not match the job')
    scope = _named_workspace(job)
    if (scope.ws if scope else None) != (partition.ws if partition else None):
        raise ValueError('The job row names another workspace than its partition')
    if scope is not None and run['generation'] == 0:
        # A job of one workspace closes its exports at its start (the lock, every export marked erased), before
        # anything is read or deleted; the `exports` phase sweeps them and frees the lock (exports.py).
        exports.note_workspace(run, scope, aggregates_table)
    if run['field'] == SOURCE_FIELD:
        _check_whole_source(run['source'], value)
    field, source = str(job.get('field')), run['source']
    return lambda store: retention.erase_filter(field, value, source, store, scope)


def _workspace_job(event: dict[str, Any], run: dict[str, Any]) -> None:
    """A workspace erasure's job id and partition on the run from the start of the invocation (before the
    generation guard and the claim), so every failure path, ``MAX_GENERATIONS`` included, marks the workspace's own
    row failed and frees its lock. Only for a well-formed job id and a valid workspace (``message_scope``); the
    deployment's job keeps its order (``_erase_setup``)."""
    job_id = event.get('job_id')
    refused, partition = message_scope(event)
    if refused or partition is None or not isinstance(job_id, str) or not JOB_ID_RE.match(job_id):
        return
    run['job_id'] = job_id
    run[WORKSPACE_FIELD] = partition.ws


def _named_workspace(job: dict[str, Any]) -> WorkspaceScope | None:
    """The one workspace the job ROW names (``workspace_id``), or None for a job of the deployment.

    The settings API writes it from the request's resolved membership (shared/erasure_scope.py ``scoped_job_row``),
    never from a body, in that workspace's own job partition, and names the same workspace on the invoke event
    (``workspace_payload``) so the worker finds the row; the event alone never makes a job (the row must exist in
    that partition) and the row must name the same workspace (``_erase_setup``). A field that is there but not a
    workspace id, or a whole-source job that names one, fails the job (ValueError) before anything is read: never
    run deployment-wide instead.
    """
    if WORKSPACE_FIELD not in job:
        return None
    scope = scope_from_message(job)
    if job.get('field') not in WORKSPACE_ERASE_FIELDS:
        raise ValueError('This erasure cannot name a workspace')
    return scope


def _check_whole_source(source: object, value: str) -> None:
    """A whole-source job names the invoked source, and it is a source id (defence in depth).

    The settings route already insists on both; a job row written any other way
    must not turn into an erasure of something else.
    """
    if source != value or not SOURCE_ID_RE.match(value):
        raise ValueError('The whole-source erasure does not name one valid source')


# ============================================
# Hand-over and the source lock
# ============================================

def _hand_over(walk: Walk, phase: str, cursor: dict | None) -> dict:
    run = walk.run
    _whole_source_lock_call(walk.aggregates, run, refresh_source_lock, 'renew')
    _workspace_lock_call(walk.aggregates, run, refresh_workspace_lock, 'renew')
    _renew_export_locks(walk.aggregates, run)
    payload = {**walk.event, 'mode': run['mode'], 'phase': phase, 'cursor': cursor, 'run': carried_state(run)}
    invoke_lambda_async(walk.context.function_name, payload)
    return {'status': 'continued', 'run_id': run['run_id']}


def _renew_export_locks(aggregates_table: Any, run: dict[str, Any]) -> None:
    """Re-close the exports of every workspace the run still has to clear (``exports.renew``: each export lock
    renewed, any export that slipped in marked erased); best effort, as the other locks: a failure is logged, and
    the ``exports`` phase closes them again before it sweeps."""
    try:
        exports.renew(run, aggregates_table)
    except _AWS_ERRORS as e:
        logger.warning('Could not renew the workspace export locks', extra={'error_type': type(e).__name__})


def _workspace_lock_call(aggregates_table: Any, run: dict[str, Any],
                         operation: Callable[[Any, WorkspaceScope, str, datetime], None], action: str) -> None:
    """Renew or release a workspace job's lock (one live erasure per workspace, shared/erasure_jobs.py); best
    effort, as the source lock (``_whole_source_lock_call``): a stale lock frees itself after ``STALE_AFTER``."""
    scope = job_scope(run)
    if not run.get('job_id') or scope is None:
        return
    try:
        operation(aggregates_table, scope, str(run['job_id']), datetime.now(UTC))
    except _AWS_ERRORS as e:
        logger.warning('Could not update the workspace erasure lock',
                       extra={'action': action, 'error_type': type(e).__name__})


def _whole_source_lock_call(aggregates_table: Any, run: dict[str, Any],
                            operation: Callable[[Any, str, str, datetime], None], action: str) -> None:
    """Renew or release a whole-source erasure run's source lock (shared/source_erasure.py); best effort.

    At a hand-over (``refresh_source_lock``) a missed renewal only lets the
    lock read as stale sooner, and the live-job check still sees this job's
    ``progress_at``. At the finish (``release_source_lock``) a failed release
    must not fail the invocation: the job already reads completed, the audit
    row would be lost, and the lock goes stale after ``STALE_AFTER`` anyway.
    """
    if not (run.get('job_id') and run.get('field') == SOURCE_FIELD and run.get('source')):
        return
    try:
        operation(aggregates_table, str(run['source']), str(run['job_id']), datetime.now(UTC))
    except _AWS_ERRORS as e:
        logger.warning('Could not update the source erasure lock',
                       extra={'action': action, 'error_type': type(e).__name__})


# ============================================
# Phases
# ============================================

def _scan_page(table: Any, condition: ConditionBase, cursor: dict | None) -> dict:
    kwargs: dict[str, Any] = {'Limit': PAGE_SIZE, 'FilterExpression': condition}
    if cursor:
        kwargs['ExclusiveStartKey'] = cursor
    return table.scan(**kwargs)


@dataclass(frozen=True)
class _Resume:
    """A page left unfinished when the time ran out: resume the scan from ``cursor`` (None = the start)."""

    cursor: dict | None


def _walk(walk: Walk, phase: str, cursor: dict | None, scan: Callable[[dict | None], dict],
          handle: Callable[[dict, dict | None], _Resume | None]) -> dict | None:
    """The paged, time-budgeted loop every scanning phase shares; a hand-over result, or None when done.

    ``scan(cursor)`` reads one page; ``handle(page, cursor)`` works through it and
    returns ``_Resume`` when the time ran out mid-page. The cursor is checkpointed
    across self re-invocations. At most ``MAX_PAGES`` pages, then a hand-over at the next one. A page whose
    ``LastEvaluatedKey`` is the cursor it was read from stops the run (``CursorStuck``) before it is handled, so it
    is never worked through twice; a longer cycle (A, B, A) is bounded by the page cap.
    """
    for _page in range(MAX_PAGES):
        page = scan(cursor)
        following = page.get('LastEvaluatedKey') or None
        if following is not None and following == cursor:
            _cursor_stuck(phase)
        resume = handle(page, cursor)
        if resume is not None:
            return _hand_over(walk, phase, resume.cursor)
        record_progress(walk.aggregates, walk.run, phase)
        if following is None:
            return None
        cursor = following
        if not walk.time_left():
            return _hand_over(walk, phase, cursor)
    return _page_cap(walk, phase, cursor)


class CursorStuck(RuntimeError):
    """A scan answered with the cursor it was read from: the walk would read that page forever."""


def _cursor_stuck(phase: str) -> NoReturn:
    """Stop the run: it fails and is audited like any other failure (``_run``). The cursor is a row key (it may
    name a person), so only the phase is logged."""
    logger.error('Retention scan returned the cursor it started from; stopping the run', extra={'phase': phase})
    raise CursorStuck(phase)


def _page_cap(walk: Walk, phase: str, cursor: dict | None) -> dict:
    """The phase read ``MAX_PAGES`` pages in this invocation: hand over from ``cursor``, as when the time runs low."""
    logger.warning('Retention phase read its page cap in one invocation; handing over',
                   extra={'phase': phase, 'pages': MAX_PAGES})
    return _hand_over(walk, phase, cursor)


def _table_position(_page: dict, item: dict) -> dict:
    """A Scan's cursor right after ``item``: its table key."""
    return {'pk': item['pk'], 'sk': item['sk']}


def _erase_pages(walk: Walk, phase: str, cursor: dict | None, scan: Callable[[dict | None], dict],
                 tombstones: Callable[[list[dict]], None], erase: Callable[[dict], None],
                 position: Callable[[dict, dict], dict] = _table_position) -> dict | None:
    """Per page: every match's tombstone first, then each match erased, until the time runs low. ``position(page,
    item)``: the cursor right after an erased item (a Scan's table key; a workspace job's index walk names its own,
    item_walk.py)."""

    def handle(page: dict, start: dict | None) -> _Resume | None:
        walk.run['scanned'] += int(page.get('ScannedCount', 0))
        items = page.get('Items', [])
        tombstones(items)
        done = start
        for item in items:
            if not walk.time_left():
                # After the last erased item (this page's start when none was).
                return _Resume(done)
            erase(item)
            done = position(page, item)
        return None

    return _walk(walk, phase, cursor, scan, handle)


def _without_unscoped_rows(run: dict[str, Any], page: dict) -> dict:
    """A retention run's page without the rows whose partition starts ``WS#`` but names no workspace.

    Such a row is never deleted as the deployment's (``shared/retention.item_scope``). An erasure fails closed on
    it (the job stops and says so); the daily retention run skips and counts it instead (``UNSCOPED_ROW_COUNTER``,
    metric ``RetentionUnscopedRowsSkipped``, logged by count only), so one bad row never stalls every window.
    """
    items = page.get('Items', [])
    kept = [item for item in items if not _unscoped(item)]
    skipped = len(items) - len(kept)
    if not skipped:
        return page
    run[UNSCOPED_ROW_COUNTER] = int(run.get(UNSCOPED_ROW_COUNTER) or 0) + skipped
    metrics.add_metric(name='RetentionUnscopedRowsSkipped', unit='Count', value=skipped)
    logger.warning('Retention skipped rows whose WS# partition names no workspace', extra={'rows': skipped})
    return {**page, 'Items': kept}


def _only_in_workspace(ws: str, page: dict) -> None:
    """Defence in depth for a job that names workspace ``ws``: every matched row of the page is that workspace's (its
    ``pk``), checked before any tombstone is written; any other row fails the job (ValueError), nothing deleted."""
    for item in page.get('Items', []):
        scope = retention.item_scope(item)
        if scope is None or scope.ws != ws:
            raise ValueError('A matched row is outside the named workspace')


def _unscoped(item: dict) -> bool:
    try:
        retention.item_scope(item)
    except ValueError:
        return True
    return False


def _walk_store(walk: Walk, phase: str, cursor: dict | None) -> dict | None:
    """Tombstone, then delete, every match of the phase's store from ``cursor`` on; a hand-over or None."""
    store = _PHASE_STORES[phase]
    if walk.filters is None:
        # An owed-only run's phases are ``registries`` and ``lineage`` (``_phases``): never a store's.
        raise RuntimeError(f'a run that replays owed lineage only scanned {store}')
    table, condition, run = walk.tables[store], walk.filters(store), walk.run
    deleter = ItemDeleter(run, walk.s3, RAW_DATA_BUCKET, walk.tables)
    retention_run = run['mode'] == MODE_RETENTION
    named = run.get('workspace_id')
    def tombstones(items: list[dict]) -> None:
        write_tombstones(walk.aggregates, run, items, store)

    def erase(item: dict) -> None:
        # Inside the item's workspace (a deployment-wide run's workspace item): its lines are that workspace's.
        with workspaces.inside(None if store == STORE_RADAR else retention.item_scope(item)):
            deleter.delete(item, store)

    # 7.96.00: a job that names a workspace reads that workspace's index partitions, filtered there, keys only, each
    # hit re-read (item_walk.py); it Scans only when handed over with a Scan cursor or its workspace names no creation time.
    indexed = _workspace_index_walk(walk, cursor) if named and store == STORE_FEEDBACK else None
    if indexed is not None:
        def walk_page(at: dict | None) -> dict:
            page = indexed.page(at)
            _only_in_workspace(str(named), page)
            return page

        return _erase_pages(walk, phase, cursor, walk_page, tombstones, erase, indexed.position)

    def scan(at: dict | None) -> dict:
        page = _scan_page(table, condition, at)
        if named:
            _only_in_workspace(str(named), page)
        return _without_unscoped_rows(run, page) if retention_run else page

    return _erase_pages(walk, phase, cursor, scan, tombstones, erase)


def _workspace_index_walk(walk: Walk, cursor: dict | None) -> item_walk.IndexWalk | None:
    """A workspace job's index read of its items from ``cursor`` (item_walk.py ``index_walk``), or None to Scan."""
    scope = job_scope(walk.run)
    if scope is None:
        raise RuntimeError('a job that names a workspace has no workspace scope')
    return item_walk.index_walk(walk.run, str(walk.event.get('value') or ''), walk.tables[STORE_FEEDBACK],
                                walk.tables.get(members.STORE_MEMBERS), scope, cursor,
                                walk.clock().astimezone(UTC).date(), PAGE_SIZE)


def _sweep_raw(walk: Walk, _cursor: dict | None) -> dict | None:
    """A whole-source erasure's raw phase: every object left under ``raw/{source}/`` and ``silver/{source}/``.

    The per-item archives and kept Silver versions went with their items; this
    removes what no item points at any more (an archive whose item failed
    processing, an older copy). Each page lists from the start of the prefix
    (what was listed is gone), so a hand-over carries no cursor. At most ``MAX_PAGES`` pages a prefix, then a
    hand-over.
    """
    source = str(walk.run.get('source') or '')
    raw_prefix, silver_prefix = retention.raw_source_prefix(source), retention.silver_source_prefix(source)
    if raw_prefix is None or silver_prefix is None or not RAW_DATA_BUCKET:
        return None
    for prefix in (raw_prefix, silver_prefix):
        handed_over = _sweep_prefix(walk, prefix)
        if handed_over is not None:
            return handed_over
    return None


def _sweep_prefix(walk: Walk, prefix: str) -> dict | None:
    """Delete every object version under ``prefix``, page by page; a hand-over result, or None once it is empty."""
    for _page in range(MAX_PAGES):
        if not walk.time_left():
            return _hand_over(walk, PHASE_RAW, None)
        objects, more = retention.delete_raw_prefix_page(walk.s3, RAW_DATA_BUCKET, prefix)
        walk.run['deleted_objects'] += objects
        record_progress(walk.aggregates, walk.run, PHASE_RAW)
        if not more:
            return None
    return _page_cap(walk, PHASE_RAW, None)


def _erase_from_boards(walk: Walk, cursor: dict | None) -> dict | None:
    """Tombstone, then de-identify, every board request and +1 of the erased email (``boards.py``)."""
    table, value = walk.tables[boards.STORE_BOARDS], str(walk.event.get('value') or '')
    eraser = boards.BoardEraser(walk.run, walk.tables, walk.s3, RAW_DATA_BUCKET, value)
    return _erase_pages(walk, PHASE_BOARDS, cursor, lambda at: boards.scan_page(table, value, at),
                        eraser.tombstones, eraser.erase)


def _erase_from_members(walk: Walk, cursor: dict | None) -> dict | None:
    """Tombstone, then de-identify, every workspace membership row of the erased email (``members.py``)."""
    table, value = walk.tables[members.STORE_MEMBERS], str(walk.event.get('value') or '')
    eraser = members.MemberEraser(walk.run, walk.tables)
    return _erase_pages(walk, PHASE_MEMBERS, cursor, lambda at: members.scan_page(table, value, at),
                        eraser.tombstones, eraser.erase)


def _erase_form_tests(walk: Walk, cursor: dict | None) -> dict | None:
    """Tombstone, then delete, every test response of a feedback form the run matches, partition by partition
    (``form_tests.py``); nothing, not even a read, for a run that reaches none."""
    matches = form_tests.row_matcher(walk.run, str(walk.event.get('value') or ''))
    if matches is None:
        return None
    eraser = form_tests.FormTestEraser(walk.run, walk.tables, matches, walk.clock, members.STORE_MEMBERS)
    return _step_walk(walk, PHASE_FORM_TESTS, cursor, eraser.step)


def _erase_exports(walk: Walk, _cursor: dict | None) -> dict | None:
    """The exports of every workspace the erasure reached: marked erased, open uploads aborted, every version of
    their objects deleted (exports.py, TENETS.md D5). Each step is idempotent, so a hand-over resumes with none."""
    if not RAW_DATA_BUCKET:
        return None
    done = exports.clear(walk.run, walk.s3, RAW_DATA_BUCKET, walk.aggregates, walk.time_left)
    record_progress(walk.aggregates, walk.run, PHASE_EXPORTS)
    return None if done else _hand_over(walk, PHASE_EXPORTS, None)


def _mark_lineage(walk: Walk, cursor: dict | None) -> dict | None:
    """Mark the deployment's artifacts that cited a deleted item (``lineage.deployment_step``: its projects by Query,
    since 7.48.00), step by step; a workspace's rows are the ``workspace_lineage`` phase's. Once the pass ended, what an
    earlier run owed and this one replayed is cleared (registries.py ``clear_owed``, 7.93.00)."""
    projects = walk.tables['projects']
    handed_over = _step_walk(walk, PHASE_LINEAGE, cursor,
                             lambda at: lineage.deployment_step(projects, walk.aggregates, walk.run, at))
    if handed_over is None:
        registries.clear_owed(walk.aggregates, walk.run)
        walk.run[registries.LINEAGE_DONE] = True
    return handed_over


def _check_registries(walk: Walk, cursor: dict | None) -> dict | None:
    """The ``registries`` phase (registries.py ``step``: the marker, then the gap check, one page a step), first in
    every run that names no workspace and can delete or replay; then the deployment's erasure by email requires its
    result. Resumed with a cursor, it reads the marker again first (round 2, R2-4): an ``--unmark`` between two
    invocations ends the phase with ``not_backfilled`` before anything is deleted."""
    projects = walk.tables['projects']
    if cursor is not None and not walk.marker_read:
        walk.marker_read = True
        if not registries.marker_present(projects):
            walk.run[registries.RESULT] = registries.REGISTRIES_NOT_BACKFILLED
            _require_for_people(walk)
            return None
    handed_over = _step_walk(walk, PHASE_REGISTRIES, cursor, lambda at: registries.step(projects, walk.run, at))
    if handed_over is None:
        walk.marker_read = True
        _require_for_people(walk)
    return handed_over


def _walks_deployment_people(walk: Walk) -> bool:
    """The deployment's erasure by email without a source: its walk of the deployment's projects is the erasure."""
    return project_people.applies(walk.run, walk.tables) and not walk.run.get('workspace_id')


def _require_for_people(walk: Walk) -> None:
    """The deployment's erasure by email cannot be owed (the address is not stored): without complete registries it
    fails by name; what it already deleted (an ``--unmark`` between two invocations) owes its lineage marks first."""
    run = walk.run
    if not _walks_deployment_people(walk) or run.get(registries.RESULT) == registries.REGISTRIES_COMPLETE:
        return
    if _deleted_anything(run):
        registries.owe(walk.aggregates, run)
    raise registries.refusal(run.get(registries.RESULT))


def _recheck_marker(walk: Walk) -> None:
    """The backfill's marker read again at an invocation's start (7.93.00, review round 2: an ``--unmark`` during a run
    is seen), once an invocation; a run handed over from before 7.93.00 (no result yet) takes the marker alone."""
    if walk.marker_read:
        return
    walk.marker_read = True
    run = walk.run
    present = registries.marker_present(walk.tables['projects'])
    if run.get(registries.RESULT) is None:
        run[registries.RESULT] = registries.REGISTRIES_COMPLETE if present else registries.REGISTRIES_NOT_BACKFILLED
    elif not present:
        run[registries.RESULT] = registries.REGISTRIES_NOT_BACKFILLED


def _people_walk_ahead(phases: list[str], resumed: str, cursor: dict | None) -> bool:
    """Whether the deployment's people walk is still ahead of this invocation (a phase before ``workspace_projects``,
    or that phase before its ``deployment_done``)."""
    if PHASE_WORKSPACE_PROJECTS not in phases or resumed not in phases:
        return False
    if resumed == PHASE_WORKSPACE_PROJECTS:
        return (cursor or {}).get(project_people.DEPLOYMENT_DONE) is not True
    return phases.index(resumed) < phases.index(PHASE_WORKSPACE_PROJECTS)


def _lineage_due(walk: Walk, cursor: dict | None) -> bool:
    """Whether the deployment's lineage pass runs now (7.93.00): only with complete registries, and then when the run
    deleted anything or an earlier run owes it a pass (registries.py ``load_owed``); without them, a run that deleted
    anything owes the pass instead (``owe``), and walks on."""
    run = walk.run
    _recheck_marker(walk)
    if run.get(registries.RESULT) != registries.REGISTRIES_COMPLETE:
        if run.get(registries.LINEAGE_OWED) is not True:
            if _deleted_anything(run) or run.get(registries.OWED_SOURCES):
                registries.owe(walk.aggregates, run)
            elif registries.owes(walk.aggregates):
                # Nothing of its own owed, but it cannot replay what is (round 2, R2-3): it says so all the same.
                registries.note_owed(run)
        return False
    if cursor is not None:
        return True
    registries.load_owed(walk.aggregates, run)
    return _deleted_anything(run) or bool(run.get(registries.OWED_SOURCES))


def _step_walk(walk: Walk, phase: str, cursor: dict | None, step: Callable[[dict | None], dict | None]) -> dict | None:
    """The time-budgeted loop of a phase made of steps (shared/project_walk.py: one Query page each, with its writes):
    ``step(cursor)`` gives the next step's cursor, None when the phase is done. A hand-over between two steps carries
    the cursor; at most ``MAX_PAGES`` steps an invocation, then a hand-over, as ``_walk``."""
    for _page in range(MAX_PAGES):
        cursor = step(cursor)
        record_progress(walk.aggregates, walk.run, phase)
        if cursor is None:
            return None
        if not walk.time_left():
            return _hand_over(walk, phase, cursor)
    return _page_cap(walk, phase, cursor)


def _mark_workspace_lineage(walk: Walk, cursor: dict | None) -> dict | None:
    """Mark the workspaces' artifacts that cite an erased item or board request (``lineage.workspace_step``)."""
    projects = walk.tables['projects']
    listing = walk.tables.get(members.STORE_MEMBERS)
    return _step_walk(walk, PHASE_WORKSPACE_LINEAGE, cursor,
                      lambda at: lineage.workspace_step(projects, walk.aggregates, walk.run, at, listing, walk.clock))


def _erase_from_projects(walk: Walk, cursor: dict | None) -> dict | None:
    """De-identify the erased email in the workspaces' projects (``project_people.py``), step by step."""
    eraser = project_people.ProjectPeopleEraser(walk.run, walk.tables, str(walk.event.get('value') or ''), walk.s3,
                                                RAW_DATA_BUCKET, walk.time_left, walk.clock)
    return _step_walk(walk, PHASE_WORKSPACE_PROJECTS, cursor, eraser.step)


def _erase_participants(walk: Walk, cursor: dict | None) -> dict | None:
    """Erase, in voc-participants, each person the address's guards name (``participants.py``), step by step."""
    eraser = participants.ParticipantEraser(walk.run, walk.tables, str(walk.event.get('value') or ''), walk.clock)
    return _step_walk(walk, PHASE_PARTICIPANTS, cursor, eraser.step)


def _erase_agent_memory(walk: Walk, cursor: dict | None) -> dict | None:
    """Erase, from the engineering agents' memory, the person the address's account names (``agent_memory.py``)."""
    directory = agent_memory.cognito_directory(get_cognito_idp_client(), USER_POOL_ID)
    eraser = agent_memory.AgentMemoryEraser(walk.run, walk.tables, str(walk.event.get('value') or ''), directory,
                                            client=get_dynamodb_client(), clock=walk.clock)
    return _step_walk(walk, PHASE_AGENT_MEMORY, cursor, eraser.step)


def _mark_engineering_lineage(walk: Walk, cursor: dict | None) -> dict | None:
    """Remove the erased review ids the engineering runs and the issues' run claims keep
    (``engineering_lineage.py``)."""
    walker = engineering_lineage.EngineeringLineage(walk.run, walk.tables, walk.clock)
    return _step_walk(walk, PHASE_ENGINEERING_LINEAGE, cursor, walker.step)


def _phases(walk: Walk) -> list[str]:
    """The phases this run walks, in order (the lineage ones are decided when they are reached).

    A retention window that retains nothing and replays owed lineage (``owed_only``) walks the registries and the
    lineage pass only. A job that names a workspace walks the item scan, (an erasure by email) that workspace's projects and its
    participants, its exports and its projects' lineage marks only: Radar, the feedback boards and the workspace
    memberships are the deployment's (not keyed by workspace), and there is no whole-source sweep. A form's test
    responses follow the items in every run (their phase ends at once for a run that reaches none of them; a
    workspace's job walks its own test partition only)."""
    if walk.owed_only:
        return [PHASE_REGISTRIES, PHASE_LINEAGE]
    phases = [PHASE_ITEMS, PHASE_FORM_TESTS]
    # 7.93.00 (3g-d2): every run that names no workspace and can delete or replay first checks the deployment's review registries.
    first = [PHASE_REGISTRIES] if 'projects' in walk.tables and not walk.run.get('workspace_id') else []
    # The exports of every workspace the item scan, the memberships, the projects or the participants reached, after
    # them (decided when it is reached: exports.py), so an export started between them is swept too; before the
    # lineage passes. Each such workspace's exports were already closed (locked, marked erased) when the run first met
    # it: no link meanwhile.
    exports_phase = [PHASE_EXPORTS] if walk.run['mode'] == MODE_ERASE else []
    projects_phase = [PHASE_WORKSPACE_PROJECTS] if project_people.applies(walk.run, walk.tables) else []
    # Then the participants (7.72.00), after the boards' +1s are de-identified, so no later promote finds the address
    # to make a participant of again (participants.py); a job handed over in an earlier phase across the upgrade
    # still reaches them.
    if participants.applies(walk.run, walk.tables):
        projects_phase.append(PHASE_PARTICIPANTS)
    # The workspaces' lineage marks (decided when reached: only once the run deleted a workspace's item).
    workspace_lineage = [PHASE_WORKSPACE_LINEAGE] if 'projects' in walk.tables else []
    if walk.run.get('workspace_id'):
        return [*phases, *projects_phase, *exports_phase, *workspace_lineage]
    if STORE_RADAR in walk.tables:
        phases.append(PHASE_RADAR)
    if boards.STORE_BOARDS in walk.tables and boards.applies(walk.run):
        phases.append(PHASE_BOARDS)
    if members.STORE_MEMBERS in walk.tables and members.applies(walk.run):
        phases.append(PHASE_MEMBERS)
    phases.extend(projects_phase)
    # With -c engineeringAgents=true (7.84.00): the agents' memory of the address's person, the deployment's job only.
    if agent_memory.applies(walk.run, walk.tables, bool(USER_POOL_ID)):
        phases.append(PHASE_AGENT_MEMORY)
    if walk.run.get('field') == SOURCE_FIELD:
        phases.append(PHASE_RAW)
    phases.extend(exports_phase)
    if 'projects' in walk.tables:
        phases.append(PHASE_LINEAGE)
    # The engineering runs' and issue claims' review ids (decided when reached: once a deployment item was deleted).
    if engineering_lineage.applies(walk.tables):
        phases.append(PHASE_ENGINEERING_LINEAGE)
    phases.extend(workspace_lineage)
    return [*first, *phases]


def _deleted_anything(run: dict[str, Any]) -> bool:
    """Whether the run deleted or de-identified anything the deployment's artifacts may cite (a workspace's item
    is cited by its own workspace's artifacts only: the ``workspace_lineage`` phase's; a form's test responses are
    never cited, so they never count here)."""
    deployment_items = run['deleted_items'] - int(run.get(WORKSPACE_ITEM_COUNTER) or 0)
    return deployment_items + run['deleted_radar_items'] + int(run.get(BOARD_COUNTER) or 0) > 0


def _walk_phases(walk: Walk) -> dict | None:
    """Every phase from the event's on; a hand-over result or None.

    A hand-over names its phase; one without (from before 6.00.00) was in the item
    scan. The event's cursor belongs to that first phase only.
    """
    phases = _phases(walk)
    if PHASE_AGENT_MEMORY in phases:
        # Its job and audit rows say whether the memory was walked (runs.py ``agent_memory_fields``), failed or not.
        walk.run[AGENT_MEMORY_DUE] = True
    # A hand-over without a phase but with a cursor (from before 6.00.00) was in the item scan.
    resumed = walk.event.get('phase') or (PHASE_ITEMS if walk.event.get('cursor') else phases[0])
    remaining = phases[phases.index(resumed):] if resumed in phases else phases
    cursor = (walk.event.get('cursor') or None) if resumed in phases else None
    if PHASE_REGISTRIES in phases and remaining[:1] != [PHASE_REGISTRIES]:
        # An invocation past the registries phase reads the marker again first (7.93.00), and an erasure by email whose
        # people walk is still ahead stops before it deletes anything more.
        _recheck_marker(walk)
        if _people_walk_ahead(phases, resumed, cursor):
            _require_for_people(walk)
    for phase in remaining:
        if (phase == PHASE_LINEAGE and not _lineage_due(walk, cursor)) or (
                phase == PHASE_EXPORTS and not exports.pending(walk.run)) or (
                phase == PHASE_ENGINEERING_LINEAGE and not engineering_lineage.has_work(walk.run)) or (
                phase == PHASE_WORKSPACE_LINEAGE
                and not lineage.has_work(walk.run, walk.tables.get(members.STORE_MEMBERS))):
            continue
        handed_over = _PHASE_RUNNERS[phase](walk, cursor)
        if handed_over is not None:
            return handed_over
        cursor = None
    return None


_PHASE_RUNNERS: Final[dict[str, Callable[[Walk, dict | None], dict | None]]] = {
    PHASE_ITEMS: lambda walk, cursor: _walk_store(walk, PHASE_ITEMS, cursor),
    PHASE_FORM_TESTS: _erase_form_tests,
    PHASE_EXPORTS: _erase_exports,
    PHASE_RADAR: lambda walk, cursor: _walk_store(walk, PHASE_RADAR, cursor),
    PHASE_BOARDS: _erase_from_boards,
    PHASE_MEMBERS: _erase_from_members,
    PHASE_RAW: _sweep_raw,
    PHASE_LINEAGE: _mark_lineage,
    PHASE_REGISTRIES: _check_registries,
    PHASE_WORKSPACE_PROJECTS: _erase_from_projects,
    PHASE_WORKSPACE_LINEAGE: _mark_workspace_lineage,
    PHASE_PARTICIPANTS: _erase_participants,
    PHASE_AGENT_MEMORY: _erase_agent_memory,
    PHASE_ENGINEERING_LINEAGE: _mark_engineering_lineage,
}


# ============================================
# Entry
# ============================================

def _finish(aggregates_table: Any, run: dict[str, Any], status: str, error: str | None = None) -> dict:
    if run.get('job_id'):
        finished = finish_erasure_job(aggregates_table, run, status, error)
        # Completed or failed: the next erasure of this source may start (each release frees only its own job's lock).
        _whole_source_lock_call(aggregates_table, run, release_source_lock, 'release')
        _workspace_lock_call(aggregates_table, run, release_workspace_lock, 'release')
        if not finished:
            # A workspace job whose row already reads finished (a duplicate invoke): its outcome, audit row and
            # counts are the first run's; this one adds none (runs.finish_erasure_job logged it).
            return {'status': 'already_finished', 'job_id': run['job_id']}
    write_audit(aggregates_table, run, status, error)
    metrics.add_metric(name='RetentionItemsDeleted', unit='Count',
                       value=run['deleted_items'] + run['deleted_radar_items'])
    return {'status': status, 'run_id': run['run_id'], 'deleted_items': run['deleted_items'],
            'deleted_radar_items': run['deleted_radar_items'], 'deleted_objects': run['deleted_objects'],
            'artifacts_marked': run['artifacts_marked'], **optional_counts(run)}


def handle_event(event: dict[str, Any], context: Any) -> dict:
    """One invocation of either mode (see the module docstring)."""
    mode = event.get('mode') or MODE_RETENTION
    if mode not in (MODE_RETENTION, MODE_ERASE):
        logger.error('Retention event with an unknown mode', extra={'mode': str(mode)[:32]})
        return {'status': 'ignored'}
    tables = _tables()
    state = new_run(event, mode)
    if mode == MODE_ERASE:
        _workspace_job(event, state)
    else:
        # The daily window names no workspace: it runs as the deployment (7.84.00), each workspace's item inside its
        # own (``workspaces.inside``), as an erasure's message scope sets it (``_erase_setup``).
        message_scope({})
    if state['generation'] >= MAX_GENERATIONS:
        # A failure like any other (round 2, R2-1 and R2-2): counted by the alarm, and its lineage owed.
        registries.emit(registries.FAILED_METRIC, 'TooManyHandOvers')
        _owe_after_failure(tables, state)
        return _finish(tables['aggregates'], state, STATUS_FAILED, 'Stopped after too many hand-overs')
    before = (state['deleted_items'], state['deleted_radar_items'], _workspace_items(state))
    try:
        return _run(tables, context, event, state)
    finally:
        # After deletes (a hand-over, completion or failure): cached reads move on. A job that names a workspace
        # deleted that workspace's items only: its own data_version moves (WS#{ws}#METRIC#meta), not the deployment's.
        # (Only ``_workspace_job`` puts a workspace on the run, beside its job id.)
        named = job_scope(state)
        if named is not None:
            if _workspace_items(state) > before[2]:
                bump_data_version(tables['aggregates'], named)
        elif state['deleted_items'] > before[0]:
            bump_data_version(tables['aggregates'])
        if state['deleted_radar_items'] > before[1] and STORE_RADAR in tables:
            bump_radar_version(tables[STORE_RADAR])


def _owe_after_failure(tables: dict[str, Any], run: dict[str, Any]) -> None:
    """A run that fails (any failure path: round 2, R2-1) after it deleted, before its deployment lineage pass ended,
    owes that pass (registries.py ``owe``), so the next run with complete registries marks what it deleted; one that
    deleted nothing but cannot replay what is owed says so (``note_owed``). It never raises (round 2, q-10): a failure
    here is logged, the run's own failure stays the one recorded or raised, and a run that deleted still says its marks
    are owed, that they could not be recorded (``OWE_FAILED_REASON``, the metric's ``OWE_FAILED``: q-1). Never a
    workspace's own job (its lineage is ``workspace_lineage``)."""
    if ('projects' not in tables or run.get('workspace_id') or run.get(registries.LINEAGE_DONE) is True
            or run.get(registries.LINEAGE_OWED) is True):
        return
    try:
        if _deleted_anything(run):
            registries.owe(tables['aggregates'], run)
        elif run.get(registries.RESULT) not in (None, registries.REGISTRIES_COMPLETE) and registries.owes(
                tables['aggregates']):
            registries.note_owed(run)
    except Exception as e:  # noqa: BLE001 - recording what is owed must never replace the run's own failure
        logger.warning('Could not record the owed lineage of a failed run', extra={'error_type': type(e).__name__})
        if _deleted_anything(run):
            registries.note_owed(run, reason=registries.OWE_FAILED_REASON, error_type=registries.OWE_FAILED)


def _workspace_items(run: dict[str, Any]) -> int:
    return int(run.get(WORKSPACE_ITEM_COUNTER) or 0)


def _run(tables: dict[str, Any], context: Any, event: dict[str, Any], state: dict[str, Any]) -> dict:
    """Set the run up for its mode, walk its phases, and record the outcome."""
    mode, aggregates_table = state['mode'], tables['aggregates']
    try:
        filters = (_retention_setup(aggregates_table, state) if mode == MODE_RETENTION
                   else _erase_setup(aggregates_table, event, state))
        owed_only = filters is None and mode == MODE_RETENTION and 'projects' in tables and registries.owes(
            aggregates_table)
        if filters is None and not owed_only:
            # Retention with no retained source still audits its (empty) run;
            # an erase event that cannot run leaves its job as it was.
            return (_finish(aggregates_table, state, STATUS_COMPLETED) if mode == MODE_RETENTION
                    else {'status': 'nothing_to_do'})
        # 7.93.00: a window that retains nothing still replays the lineage an earlier run owed (its registries and
        # lineage phases only; retention is opt-in, so a deployment may never run a window that deletes).
        handed_over = _walk_phases(Walk(tables, context, event, state, filters, get_s3_client(),
                                        _lambda_clock(context), owed_only=owed_only))
    except (*_AWS_ERRORS, ValueError, RuntimeError) as e:
        failure = type(e).__name__
        # An admin's next steps (7.93.00): the class's own fixed text, never the exception's message.
        what_to_do = type(e).what_to_do if isinstance(e, registries.NeedsAnAdmin) else None
    except Exception as e:
        # Unexpected (round 2, R2-2): counted by the alarm too, its lineage owed, then raised as before.
        registries.emit(registries.FAILED_METRIC, type(e).__name__)
        _owe_after_failure(tables, state)
        raise
    else:
        return handed_over or _finish(aggregates_table, state, STATUS_COMPLETED)
    # The error TYPE only: a message (or a traceback) could quote the erased value back.
    logger.error('Retention run failed', extra={'mode': mode, 'error_type': failure})
    # The alarm's metric (7.93.00; shared/ops_alerts.py): by service, and by service and the failure's name.
    registries.emit(registries.FAILED_METRIC, failure)
    _owe_after_failure(tables, state)
    return _finish(aggregates_table, state, STATUS_FAILED,
                   f'Run failed ({failure})' + (f': {what_to_do}' if what_to_do else ''))


# Build the AWS clients during INIT, not on the first request (shared/warm_init.py).
warm_at_init(get_dynamodb_resource, get_s3_client)


@instrumented_handler
def lambda_handler(event: dict, context: Any) -> dict:
    return handle_event(event, context)
