"""voc-workspace-export: a workspace's export, one zip of JSONL files and a manifest (docs/multi-workspace.md,
"Export and delete", step 2).

Started by ``POST /me/workspaces/current/export`` (the workspaces API, a workspace admin): the route writes the job
row and the workspace's export lock (shared/export_jobs.py) and invokes this function asynchronously with
``{export_id, workspace_id}``, the workspace named from the request's resolved membership only (shared/
workspace_routing.py ``workspace_payload``). Each invocation:

1. reads the workspace from its event (``message_scope``: a ``workspace_id`` that names no workspace is ignored) and
   claims its generation on the job row (shared/export_jobs.py ``claim_generation``: a duplicate or stale delivery
   claims nothing and stops); the row must name the same workspace;
2. stops with ``cancelled`` / ``workspace_deleting`` (the upload aborted, the lock released) when the workspace's
   ``META`` is gone or no longer ``active``: read at every start, before every hand-over and before completing;
3. writes the entities of jobs/workspace_export/entities.py, in order, each as JSONL files of at most 256 MB
   (``feedback/feedback-0001.jsonl``, …), then every current object of the workspace outside its exports, each as
   ``objects/{key without ws/{ws}/}`` (jobs/workspace_export/objects.py: read through shared/ws_repo.py's read-only
   ``WorkspaceObjects``, whole, DEFLATE or STORE; one too large or badly named is listed in the manifest instead),
   into one streaming ZIP64 (zip_stream.py) cut into 64 MB parts of one S3 multipart upload,
   ``ws/{ws}/exports/{export id}/workspace-export.zip`` (shared/ws_repo.py ``ExportObjects``);
4. with less than ``TIME_RESERVE_MS`` left, or before an object it could not copy in the time left, closes the open
   file (no entry crosses an invocation), keeps the zip's
   unsent tail (under 5 MB; a larger one goes up as a part) in ``work/tail-{gen}`` and this invocation's
   central-directory records in ``work/cd-{gen}`` (both tagged ``voc-export=true``), renews the lock, records its
   progress and re-invokes itself with its state (``run``);
5. when every entity is written: ``manifest.json``, the central directory (every generation's records), the ZIP64
   end records, the last part, then CompleteMultipartUpload with the ETags ListParts returns; the job is
   ``completed`` with its size, counts and ``expires_at`` (completion + 7 days); the starter gets a job notice
   (``job_type`` ``workspace_export``, shared/job_notices.py) and the lock is released.

Any failure (an AWS error, too many hand-overs, a row naming another workspace) aborts the upload, ends the job
``failed`` with the error's type only (or, for ``ExportRefused``, a message that says what to do) and releases the
lock. The starter gets a notice only when that outcome is written on the row (it was still queued or running): an
invocation the timeout or an out-of-memory kills writes nothing, nor does a hand-over Lambda drops (throttled past
``maxEventAge``), so its row stays ``running`` until the export page shows it ``failed`` ("The export stopped before
it finished") an hour later, when its lock is free again. Before completing,
an invocation with too little time left hands over once more, every entity written, and the next one completes. A
workspace's credentials are never read (no SSM or Secrets Manager grant).

Env: ``FEEDBACK_TABLE``, ``AGGREGATES_TABLE``, ``WORKSPACES_TABLE``, ``RAW_DATA_BUCKET``.
"""
from __future__ import annotations

import itertools
import os
import time
from collections.abc import Mapping
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any, Final

from botocore.exceptions import BotoCoreError, ClientError

from jobs.workspace_export.entities import ENTITIES, FILE_CAP, ExportRefused, Source, encode_row, manifest
from jobs.workspace_export.objects import (
    BAD_NAME,
    CHUNK,
    GONE,
    MAX_OBJECT_BYTES,
    TOO_LARGE,
    TOO_SLOW,
    ObjectsState,
    entry_for,
    manifest_section,
    stored,
)
from jobs.workspace_export.objects import ENTITY as OBJECTS
from jobs.workspace_export.zip_stream import PartSink, ZipEntry, ZipState, ZipWriter
from shared import export_jobs
from shared.aws import get_dynamodb_resource, get_s3_client, invoke_lambda_async
from shared.erasure_jobs import refresh_lock, release_lock, release_quietly
from shared.export_jobs import EXPORT_JOB_TYPE, WORKSPACE_DELETING
from shared.ingest_tables import ingest_table
from shared.invocation_cost import instrumented_handler
from shared.job_notices import notify
from shared.jobs import has_time_left
from shared.logging import logger
from shared.tables import get_workspaces_table
from shared.timestamps import now_iso, parse_iso
from shared.warm_init import warm_at_init
from shared.workspace import ACTIVE
from shared.ws_repo import (
    WORKSPACE_FIELD,
    ExportObjects,
    ListedObject,
    WorkspaceObjects,
    WorkspaceScope,
    WorkspaceTable,
    control_query,
    export_job_pk,
    message_scope,
    s3_prefix,
)

FEEDBACK_TABLE, AGGREGATES_TABLE, RAW_DATA_BUCKET = (
    os.environ.get(name, '') for name in ('FEEDBACK_TABLE', 'AGGREGATES_TABLE', 'RAW_DATA_BUCKET'))

#: Hand over to a fresh invocation when less than this remains (the 15-minute timeout's reserve: a part of up to
#: 64 MB, the work objects, the progress write and the invoke all fit in it).
TIME_RESERVE_MS: Final = 2 * 60 * 1000
#: The function's timeout (lib/stacks/workspace-export-worker.ts: 15 minutes).
TIMEOUT_MS: Final = 15 * 60 * 1000
#: What a fresh invocation can give one object: its timeout less the reserve, and a minute for its start (the claim,
#: the deleting check, the tail and the listing). An object allowed more is never started (objects.py, ``too_slow``);
#: one allowed less fits the next invocation, so a hand-over before it always makes progress.
FRESH_BUDGET_MS: Final = TIMEOUT_MS - TIME_RESERVE_MS - 60 * 1000
#: A runaway guard: an export this long means something is wrong; it fails loudly instead.
MAX_GENERATIONS: Final = 300
ZIP_CONTENT_TYPE: Final = 'application/zip'
MANIFEST_NAME: Final = 'manifest.json'
#: The job row's phase once every entity is written: the manifest, the central directory, the upload's completion.
COMPLETING: Final = 'manifest'
_AWS_ERRORS: Final = (ClientError, BotoCoreError)
#: The run's phase after the JSONL entities: the workspace's objects; past it, the completion.
OBJECTS_PHASE: Final = len(ENTITIES)


def _phase_name(phase: int) -> str:
    """The job row's ``phase``: the entity being written, ``objects``, or ``COMPLETING``."""
    if phase < len(ENTITIES):
        return ENTITIES[phase]
    return OBJECTS if phase == OBJECTS_PHASE else COMPLETING


@dataclass
class RunState:
    """What one invocation hands the next (the event's ``run``)."""

    generation: int = 0
    upload_id: str = ''
    part: int = 1
    zip_state: ZipState = field(default_factory=ZipState)
    phase: int = 0
    cursor: dict[str, Any] | None = None
    counts: dict[str, int] = field(default_factory=dict)
    files: dict[str, list[str]] = field(default_factory=dict)
    cd_generations: list[int] = field(default_factory=list)
    tail_generation: int | None = None
    objects: ObjectsState = field(default_factory=ObjectsState)

    @classmethod
    def from_event(cls, event: Mapping[str, Any]) -> RunState:
        carried = event.get('run')
        if not isinstance(carried, Mapping):
            return cls()
        cursor = carried.get('cursor')
        tail = carried.get('tail_generation')
        return cls(
            generation=int(carried.get('generation', 0)), upload_id=str(carried.get('upload_id') or ''),
            part=int(carried.get('part', 1)), zip_state=ZipState.from_json(carried.get('zip')),
            phase=int(carried.get('phase', 0)), cursor=dict(cursor) if isinstance(cursor, Mapping) else None,
            counts={str(name): int(count) for name, count in (carried.get('counts') or {}).items()},
            files={str(name): [str(file) for file in names] for name, names in (carried.get('files') or {}).items()},
            cd_generations=[int(generation) for generation in carried.get('cd_generations') or []],
            tail_generation=int(tail) if isinstance(tail, int) else None,
            objects=ObjectsState.from_json(carried.get('objects')))

    def to_json(self) -> dict[str, Any]:
        return {'generation': self.generation, 'upload_id': self.upload_id, 'part': self.part,
                'zip': self.zip_state.to_json(), 'phase': self.phase, 'cursor': self.cursor, 'counts': dict(self.counts),
                'files': {name: list(names) for name, names in self.files.items()},
                'cd_generations': list(self.cd_generations), 'tail_generation': self.tail_generation,
                'objects': self.objects.to_json()}


class _HandOver(Exception):
    """The time ran low between rows: the open file is closed and the run's cursor is where to resume."""


@dataclass
class _Progress:
    """Where one entity's writing stands in this invocation: its next cursor and its open file."""

    resume: dict[str, Any] | None
    entry: ZipEntry | None = None


class ExportRun:
    """One invocation of one export (see the module docstring)."""

    def __init__(self, scope: WorkspaceScope, export_id: str, row: Mapping[str, Any], run: RunState,
                 event: Mapping[str, Any], context: Any) -> None:
        self.scope = scope
        self.export_id = export_id
        self.row = row
        self.run = run
        self.event = event
        self.context = context
        resource = get_dynamodb_resource()
        self.jobs: WorkspaceTable = ingest_table(scope, resource, AGGREGATES_TABLE)
        self.workspaces = get_workspaces_table()
        self.source = Source(scope, ingest_table(scope, resource, FEEDBACK_TABLE), self.jobs, self.workspaces)
        s3 = get_s3_client()
        self.objects = ExportObjects(scope, s3, RAW_DATA_BUCKET)
        self.workspace_objects = WorkspaceObjects(scope, s3, RAW_DATA_BUCKET)
        self.zip_key = self.objects.key(export_id, export_jobs.ZIP_NAME)
        self.created = parse_iso(row.get('created_at')) or datetime.now(UTC)
        self.records = bytearray()
        #: Whether this invocation's outcome was written on the row (``_finish``).
        self.finished = False

    # ── The run ─────────────────────────────────────────────────────────────────────────────────────────────

    def execute(self) -> dict[str, Any]:
        """The invocation's outcome; any AWS error, refusal or too-large export fails the job."""
        try:
            outcome = self._execute()
        except ExportRefused as error:
            # A message of our own, which names no row: it says what to do.
            failure, message = type(error).__name__, str(error)
        except (*_AWS_ERRORS, ValueError, RuntimeError) as error:
            failure = type(error).__name__
            message = f'Export failed ({failure})'
        else:
            return outcome
        # The error TYPE only: a message (or a traceback) could quote a row back into the logs.
        logger.error('Workspace export failed', extra={'export_id': self.export_id, 'error_type': failure})
        return self.fail(message)

    def _execute(self) -> dict[str, Any]:
        if self.run.generation >= MAX_GENERATIONS:
            return self.fail('Stopped after too many hand-overs')
        if self._deleting():
            return self._cancel()
        if self.run.generation == 0:
            self.run.upload_id = self.objects.create_multipart_upload(self.zip_key, ZIP_CONTENT_TYPE)
        sink = PartSink(self._upload_part, next_part=self.run.part, tail=self._tail())
        writer = ZipWriter(sink, self.created, self.run.zip_state)
        try:
            self._write_entities(writer)
        except _HandOver:
            return self._hand_over(sink, writer)
        if not self._time_left():
            # Every entity is written (phase == len(ENTITIES)): the next invocation only completes the zip.
            return self._hand_over(sink, writer)
        return self._complete(sink, writer)

    def _time_left(self) -> bool:
        return has_time_left(self.context, TIME_RESERVE_MS)

    def _write_entities(self, writer: ZipWriter) -> None:
        """Every entity from the run's phase and cursor on, then the workspace's objects; ``_HandOver`` when the time
        runs low."""
        while self.run.phase < len(ENTITIES):
            entity = ENTITIES[self.run.phase]
            cursor = self.run.cursor or self.source.first_cursor(entity, self.created.date())
            if cursor is not None:
                self._write_entity(writer, entity, cursor)
            self.run.phase += 1
            self.run.cursor = None
        if self.run.phase == OBJECTS_PHASE:
            self._write_objects(writer)
            self.run.phase += 1

    # ── The workspace's objects (objects.py) ────────────────────────────────────────────────────────────────

    def _write_objects(self, writer: ZipWriter) -> None:
        """Every current object of the workspace after the run's last key, a listing page at a time; the last key
        handled is the checkpoint, so a hand-over (``_HandOver``) between any two objects resumes right after it."""
        state = self.run.objects
        while True:
            page = self.workspace_objects.list_page(state.after)
            for listed in page.objects:
                if not self._time_left():
                    raise _HandOver
                self._write_object(writer, listed)
                state.after = listed.key
            if page.following is None:
                return
            state.after = page.following

    def _write_object(self, writer: ZipWriter, listed: ListedObject) -> None:
        """One object as its entry, whole; or listed as not included; ``_HandOver`` before one that would not fit in
        the time left at its kind's measured rate. One that would not fit even a fresh invocation's budget
        (``FRESH_BUDGET_MS``) is listed ``too_slow`` instead of started."""
        state = self.run.objects
        if listed.key.endswith('/') and listed.size == 0:
            return  # a folder marker (a console's "create folder"): no object, nothing to list
        name, why = entry_for(self.scope, listed.key)
        relative = listed.key.removeprefix(s3_prefix(self.scope))
        if name is None:
            state.skip(relative, listed.size, BAD_NAME, why)
            return
        if listed.size > MAX_OBJECT_BYTES:
            state.skip(relative, listed.size, TOO_LARGE)
            return
        # Opened first: its kind (STORE or DEFLATE) comes with its content type, before any byte is read.
        opened = self.workspace_objects.open(listed.key)
        if opened is None:
            state.skip(relative, listed.size, GONE)
            return
        store = stored(opened.content_type, listed.key)
        allowed_ms = state.seconds_for(opened.size, store) * 1000
        if opened.size > MAX_OBJECT_BYTES or allowed_ms >= FRESH_BUDGET_MS or not self._fits(allowed_ms):
            opened.body.close()
            if opened.size > MAX_OBJECT_BYTES:
                # Replaced by a larger version since it was listed.
                state.skip(relative, opened.size, TOO_LARGE)
            elif allowed_ms >= FRESH_BUDGET_MS:
                state.skip(relative, opened.size, TOO_SLOW)
            else:
                raise _HandOver
            return
        started = time.monotonic()
        entry = writer.open_entry(name, store=store)
        try:
            while chunk := opened.body.read(CHUNK):
                entry.write(chunk)
        finally:
            opened.body.close()
        self._close(entry)
        state.measured(store, entry.size, time.monotonic() - started)
        state.copied_bytes += entry.size
        self.run.counts[OBJECTS] = self.run.counts.get(OBJECTS, 0) + 1

    def _fits(self, allowed_ms: float) -> bool:
        """Whether a copy allowed ``allowed_ms`` ends before this invocation's reserve."""
        return allowed_ms < self.context.get_remaining_time_in_millis() - TIME_RESERVE_MS

    def _write_entity(self, writer: ZipWriter, entity: str, cursor: dict[str, Any]) -> None:
        """One entity's rows as JSONL files from ``cursor`` on. Its open file always ends in this invocation (at the
        entity's end, at ``FILE_CAP``, or before a hand-over, the run's cursor then right after its last row)."""
        progress = _Progress(cursor)
        out_of_time = self._write_pages(writer, entity, progress)
        if progress.entry is not None:
            self._close(progress.entry)
        if out_of_time:
            self.run.cursor = progress.resume
            raise _HandOver

    def _write_pages(self, writer: ZipWriter, entity: str, progress: _Progress) -> bool:
        """The entity's pages from ``progress.resume`` on; True when the time ran low (``progress.resume`` is then
        right after the last row written)."""
        while progress.resume is not None:
            if not self._time_left():
                return True
            page = self.source.page(entity, progress.resume)
            for row in page.rows:
                if not self._time_left():
                    return True
                line = encode_row(row.item)
                if progress.entry is not None and progress.entry.size + len(line) > FILE_CAP:
                    self._close(progress.entry)
                    progress.entry = None
                progress.entry = progress.entry or self._open(writer, entity)
                progress.entry.write(line)
                self.run.counts[entity] = self.run.counts.get(entity, 0) + 1
                progress.resume = row.after
            progress.resume = page.following
        return False

    def _open(self, writer: ZipWriter, entity: str) -> ZipEntry:
        files = self.run.files.setdefault(entity, [])
        name = f'{entity}/{entity}-{len(files) + 1:04d}.jsonl'
        files.append(name)
        return writer.open_entry(name)

    def _close(self, entry: ZipEntry) -> None:
        self.records += entry.close()

    def _upload_part(self, number: int, body: bytes) -> None:
        self.objects.upload_part(self.zip_key, self.run.upload_id, number, body)

    def _work_key(self, name: str) -> str:
        return self.objects.key(self.export_id, export_jobs.WORK_FOLDER, name)

    def _tail(self) -> bytes:
        if self.run.tail_generation is None:
            return b''
        return self.objects.read_object(self._work_key(f'tail-{self.run.tail_generation}'))

    # ── Hand-over and completion ────────────────────────────────────────────────────────────────────────────

    def _hand_over(self, sink: PartSink, writer: ZipWriter) -> dict[str, Any]:
        if self._deleting():
            return self._cancel()
        generation = self.run.generation
        previous_tail = self.run.tail_generation
        next_part, tail = sink.hand_over()
        self.run.tail_generation = None
        if tail:
            self.objects.put_work_object(self._work_key(f'tail-{generation}'), tail)
            self.run.tail_generation = generation
        if self.records:
            self.objects.put_work_object(self._work_key(f'cd-{generation}'), bytes(self.records))
            self.run.cd_generations.append(generation)
        self.run.part = next_part
        self.run.zip_state = writer.state
        now = datetime.now(UTC)
        refresh_lock(self.jobs, export_job_pk(self.scope), self.export_id, now)
        progressed = export_jobs.record_progress(self.jobs, self.export_id, generation, {
            'progress_at': now.isoformat(),
            'phase': _phase_name(self.run.phase),
            'counts': dict(self.run.counts)})
        if not progressed:
            return self._stop(previous_tail)
        self.run.generation = generation + 1
        invoke_lambda_async(self.context.function_name, {**self.event, 'run': self.run.to_json()})
        return {'status': 'continued', 'export_id': self.export_id, 'generation': self.run.generation}

    def _complete(self, sink: PartSink, writer: ZipWriter) -> dict[str, Any]:
        if self._deleting():
            return self._cancel()
        completed = datetime.now(UTC)
        daily_total = self.source.daily_total()
        entry = writer.open_entry(MANIFEST_NAME)
        entry.write(manifest(
            export_id=self.export_id, scope=self.scope, workspace=self._workspace_names(),
            created_at=self.created.isoformat(), completed_at=completed.isoformat(), files=self.run.files,
            counts=self.run.counts, daily_total=daily_total,
            objects=manifest_section(self.run.counts.get(OBJECTS, 0), self.run.objects)))
        self._close(entry)
        exported = self.run.counts.get('feedback', 0)
        if exported != daily_total:
            # Reported, not fatal: an item without a date, an expired counter or an arrival during the run.
            logger.warning('Workspace export counts differ from daily_total',
                           extra={'export_id': self.export_id, 'feedback': exported, 'daily_total': daily_total})
        # Each generation's records read and streamed into the parts in turn (never joined: memory stays at about
        # one part plus one generation's records), then this invocation's.
        earlier = (self.objects.read_object(self._work_key(f'cd-{generation}'))
                   for generation in self.run.cd_generations)
        writer.finish(itertools.chain(earlier, [bytes(self.records)]))
        uploaded = sink.close()
        parts = self.objects.list_parts(self.zip_key, self.run.upload_id)
        if [part['PartNumber'] for part in parts] != list(range(1, uploaded + 1)):
            raise RuntimeError('the upload does not hold every part')
        # The row re-checked right before the zip exists: an erasure that marked it since this invocation's claim
        # (whose sweep may have run before the upload began) stops it here; one that marks it after this write
        # comes before that erasure's sweep, which aborts the upload or deletes the zip.
        if not export_jobs.record_progress(self.jobs, self.export_id, self.run.generation, {
                'progress_at': now_iso(), 'phase': COMPLETING}):
            return self._stop(None)
        self.objects.complete_multipart_upload(self.zip_key, self.run.upload_id, parts)
        return self._finish(export_jobs.EXPORT_COMPLETED, {
            'completed_at': completed.isoformat(), 'expires_at': export_jobs.expires_at(completed),
            'counts': dict(self.run.counts), 'size_bytes': writer.state.offset, 'phase': COMPLETING})

    def _workspace_names(self) -> dict[str, Any]:
        page = control_query(self.scope, self.workspaces, 'meta', sort_condition='#sk = :meta',
                             ExpressionAttributeNames={'#sk': 'sk'}, ExpressionAttributeValues={':meta': 'META'},
                             ConsistentRead=True)
        items = page.get('Items') or []
        return dict(items[0]) if items else {}

    def _deleting(self) -> bool:
        """The workspace's ``META`` is gone or no longer ``active`` (its delete began)."""
        return self._workspace_names().get('status') != ACTIVE

    # ── The end ─────────────────────────────────────────────────────────────────────────────────────────────

    def _abort(self) -> None:
        if not self.run.upload_id:
            return
        try:
            self.objects.abort_multipart_upload(self.zip_key, self.run.upload_id)
        except _AWS_ERRORS as error:
            # The raw bucket's `abort-incomplete-uploads` lifecycle rule aborts an upload 7 days after it began
            # (lib/stacks/core-buckets.ts ABORT_MULTIPART_DAYS), and an erasure aborts it at once.
            logger.warning('Could not abort the export upload', extra={'error_type': type(error).__name__})

    def _delete_work_objects(self, previous_tail: int | None) -> None:
        """Every work object of this export the run knows of (each generation's central-directory records, this and
        the last tail), best effort: one that stays expires by its tag."""
        names = [f'cd-{generation}' for generation in self.run.cd_generations]
        names += [f'tail-{generation}' for generation in (previous_tail, self.run.tail_generation)
                  if generation is not None]
        for name in dict.fromkeys(names):
            try:
                self.objects.delete_work_object(self._work_key(name))
            except _AWS_ERRORS as error:
                logger.warning('Could not delete an export work object', extra={'error_type': type(error).__name__})

    def _stop(self, previous_tail: int | None) -> dict[str, Any]:
        """The row no longer reads running at this generation (an erasure marked it erased, or another invocation
        holds it): nothing this export wrote may stay. Its upload goes, and every work object it knows of."""
        # The row says why (an erasure's mark carries export_jobs.ERASED_DURING_EXPORT); nothing more is written.
        logger.warning('Workspace export row moved on (erased, or another invocation holds it); this invocation stops',
                       extra={'export_id': self.export_id})
        self._abort()
        self._delete_work_objects(previous_tail)
        return {'status': 'stopped', 'export_id': self.export_id}

    def _cancel(self) -> dict[str, Any]:
        self._abort()
        return self._finish(export_jobs.EXPORT_CANCELLED, {'error': WORKSPACE_DELETING})

    def fail(self, error: str) -> dict[str, Any]:
        """End the job ``failed`` with ``error`` (no row content in it), the upload aborted, the lock released."""
        self._abort()
        outcome = self._finish(export_jobs.EXPORT_FAILED, {'error': error})
        if not self.finished:
            # The row moved on (an erasure marked it erased): nothing this export wrote may stay.
            self._delete_work_objects(None)
        return outcome

    def _finish(self, status: str, fields: Mapping[str, Any]) -> dict[str, Any]:
        written = export_jobs.finish_job(self.jobs, self.export_id, status, fields)
        self.finished = written
        # The job already reads finished; a lock that cannot be released goes stale after an hour anyway.
        release_quietly(lambda: release_lock(self.jobs, export_job_pk(self.scope), self.export_id, datetime.now(UTC)),
                        'workspace export')
        if written:
            notify(self.row.get('started_by_sub'), self.export_id, status, job_type=EXPORT_JOB_TYPE)
        return {'status': status, 'export_id': self.export_id}


def handle_event(event: dict[str, Any], context: Any) -> dict[str, Any]:
    """One invocation of an export (see the module docstring)."""
    refused, scope = message_scope(event)
    export_id = event.get('export_id')
    if refused or scope is None or not export_jobs.is_export_id(export_id):
        logger.error('Export event without a valid workspace and export id')
        return {'status': 'ignored'}
    run = RunState.from_event(event)
    jobs = ingest_table(scope, get_dynamodb_resource(), AGGREGATES_TABLE)
    row = export_jobs.claim_generation(jobs, export_id, run.generation, datetime.now(UTC))
    if row is None:
        logger.info('Export generation not claimed (missing, finished, a duplicate or late)',
                    extra={'export_id': export_id, 'generation': run.generation})
        return {'status': 'not_claimed', 'export_id': export_id}
    export = ExportRun(scope, export_id, row, run, event, context)
    if row.get(WORKSPACE_FIELD) != scope.ws:
        return export.fail('The job row names another workspace')
    return export.execute()


# Build the AWS clients during INIT, not on the first request (shared/warm_init.py).
warm_at_init(get_dynamodb_resource, get_s3_client)


@instrumented_handler
def lambda_handler(event: dict, context: Any) -> dict:
    return handle_event(event, context)
