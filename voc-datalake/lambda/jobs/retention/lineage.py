"""voc-retention: workspace artifacts that cited an erased item say so (TENETS.md D5).

Personas, research reports and documents in voc-projects record the reviews they
read (``input_feedback_ids``) and, for a persona, the ones it cites
(``evidence_feedback_ids``); the board requests they read sit in ``input_feature_request_ids``
(an erasure de-identifies a request, ``boards.py``, and tombstones it like a deleted review). After a
run deletes or de-identifies anything, these passes read
the projects' partitions for rows carrying any list (paged, time-budgeted by the caller)
and look each listed id up among the tombstones of the sources the run deleted
from (``AUDIT#tombstone#{source}``). An artifact with an erased id:

- loses that id from its lists, so lineage never points at a deleted item;
- gains ``erased_evidence: {count, job_id, mode, at}`` (``count`` adds up over
  runs), so its owner sees that evidence was erased.

The artifact's text is never rewritten: it belongs to its owner and holds no
review, only what the model wrote from them. The update is conditional on the
lists read, so an artifact regenerated meanwhile is left alone (its new lists
are checked by the next run that deletes anything).

Two passes (since 7.43.00, projects 3g-b; the deployment's by Query since 7.48.00, 3g-d):

- ``lineage``, the deployment's, run when the run deleted a deployment item or Radar review or de-identified a board
  request, each listed id looked up as ``{feedback_id}``: its projects through its project registry (``PROJECT_IDS``,
  shared/project_walk.py ``registry_page``: put at a project's create, kept by its delete, so a deleted or
  half-deleted project, which the delete's fence takes off ``gsi1-by-type``, is listed too), or, until the backfill's
  marker is there (workspaces.py ``deployment_found``), the backfill's Scan of the projects' ``META`` rows
  (shared/review_registries.py ``PROJECTS``, one Scan page a step); then its company persona library
  (``PROJECT#company_personas``, on no list); in each, the project's own partition by the same filtered Query pages as
  a workspace's (``deployment_step``). Until 7.48.00 a Scan of the whole of voc-projects, every row read (until 7.43.00
  any row of the table marked); every writer of these lists writes in a project's own partition (personas, research, documents and
  the persona library's copies), so the Queries reach the same rows. A workspace's rows are never read: a workspace's
  artifact cites that workspace's items, whose tombstones are ``{ws}#{feedback_id}``.
- ``workspace_lineage``: the workspaces whose item the run deleted (``LINEAGE_WORKSPACES``, noted by copies.py as it
  deletes one, in a retention window, the deployment's erasure by email or a workspace's own erasure), or, once the
  run de-identified a board request, every workspace of the platform's listing (workspaces.py: any workspace's
  artifact may cite a board request); in each, its projects through its registry (``WS#{ws}#PROJECT_IDS``,
  shared/project_walk.py ``registry_page``; a project its registry marks deleted too, since its rows stay until its
  delete sweeps them), then its company persona library (``COMPANY_PERSONAS_CONTAINER``, which no registry lists); in
  each, the project's own partition (shared/project_keys.py ``project_partitions``, kind ``project``: its personas,
  research and documents; its document versions hold none of these lists), one filtered Query page at a time
  (``workspace_step``). A review id and a cited id are looked up as that workspace's tombstones,
  ``{ws}#{feedback_id}``; a board request id as the deployment's (``feature_requests`` / ``{id}``: the boards are the
  deployment's, not per workspace). Every mark is written through the workspace layer (shared/ws_repo.py
  ``ws_table``). No Scan: what it reads is the walked workspaces' own projects. A registry row (or a scanned ``META``)
  not shaped like a project id is skipped and counted (``project_ids_malformed``).

A persona's evidence refreshes (``evidence_updates``, 7.64.00: ``{at, by, reason, feedback_ids}`` entries) are read and
marked the same way: an erased review leaves an entry's ``feedback_ids`` (the entry, its actor and time, stays), and
counts in the mark like a listed id.

What neither pass reads (follow-ups): an id cited inside a document's ``derivation`` (its
``input_feature_request_ids`` there, beside the top-level list this pass filters on), and a persona job's ``result``
in voc-jobs, which holds the persona's lineage ids until the job row's 7-day ``ttl`` deletes it.
"""

from __future__ import annotations

from collections.abc import Callable, Iterable, Mapping, Sequence
from datetime import datetime
from typing import Any, Final

from botocore.exceptions import ClientError

from jobs.retention import workspaces
from jobs.retention.copies import tombstone_key
from jobs.retention.runs import LINEAGE_ALL, LINEAGE_WORKSPACES
from shared.aws import is_conditional_check_failure
from shared.batch_get import batch_get_all
from shared.feature_requests_raw import FEATURE_REQUESTS_SOURCE
from shared.feedback_sampling import INPUT_FEATURE_REQUEST_IDS_FIELD, INPUT_FEEDBACK_IDS_FIELD
from shared.ingest_tables import table_view
from shared.logging import logger
from shared.persona_evidence import EVIDENCE_FEEDBACK_IDS_FIELD
from shared.persona_grounding import EVIDENCE_UPDATES_FIELD, evidence_update_entries, listed_ids
from shared.project_keys import project_partitions
from shared.project_walk import checked_ids, checked_key, is_project_id, query_page
from shared.retention import BOARD_COUNTER
from shared.timestamps import now_iso
from shared.ws_repo import WORKSPACE_FIELD, WorkspaceScope, scope_from_message, ws_table

# The board requests a document / persona / research result read (written by the generators, C5 of 6.01.00);
# a request whose reporter an erasure de-identified has a tombstone under ``feature_requests`` (boards.py).
ID_FIELDS: Final = (INPUT_FEEDBACK_IDS_FIELD, EVIDENCE_FEEDBACK_IDS_FIELD, INPUT_FEATURE_REQUEST_IDS_FIELD)
MARK_FIELD: Final = 'erased_evidence'
PAGE_SIZE: Final = 100
#: The attributes a mark's UpdateItem names, with the key: lib/stacks/retention-worker.ts grants them on the
#: deployment's and one workspace id's ``PROJECT#*`` partitions only (since 7.48.00: no pass Scans any more), in a
#: statement of their own (a test holds the two to each other).
LINEAGE_UPDATE_ATTRIBUTES: Final = ('pk', 'sk', *ID_FIELDS, EVIDENCE_UPDATES_FIELD, MARK_FIELD)
#: What both passes read of a row, and the names they read it by.
_PROJECTION: Final = '#pk, #sk, #ids, #cited, #requests, #updates, #mark'
_NAMES: Final = {'#pk': 'pk', '#sk': 'sk', '#ids': ID_FIELDS[0], '#cited': ID_FIELDS[1], '#requests': ID_FIELDS[2],
                 '#updates': EVIDENCE_UPDATES_FIELD, '#mark': MARK_FIELD}
#: Both passes' filter: the rows that carry a list.
_CARRIES_A_LIST: Final = ('attribute_exists(#ids) OR attribute_exists(#cited) OR attribute_exists(#requests) '
                          'OR attribute_exists(#updates)')


class TombstonesUnreadable(RuntimeError):
    """The tombstone lookup left keys unprocessed (the run fails and says so; nothing is half-marked)."""


def _listed_ids(row: Mapping[str, Any], fields: Sequence[str] = ID_FIELDS, *, refreshed: bool = True) -> list[str]:
    """The ids the row's ``fields`` list, then (``refreshed``) those its evidence refreshes added."""
    ids = [value for field in fields for value in listed_ids(row.get(field))]
    if refreshed:
        ids.extend(value for entry in evidence_update_entries(row) for value in listed_ids(entry.get('feedback_ids')))
    return list(dict.fromkeys(ids))


def _kept_updates(row: Mapping[str, Any], erased: set[str]) -> tuple[list[Any], int]:
    """``evidence_updates`` without ``erased`` in any entry's ``feedback_ids`` (every entry kept), and how many went."""
    kept: list[Any] = []
    removed = 0
    for entry in row[EVIDENCE_UPDATES_FIELD]:
        ids = entry.get('feedback_ids') if isinstance(entry, Mapping) else None
        if not isinstance(ids, list):
            kept.append(entry)
            continue
        left = [value for value in ids if value not in erased]
        removed += len(ids) - len(left)
        kept.append({**entry, 'feedback_ids': left})
    return kept, removed


def erased_ids(aggregates_table: Any, sources: Sequence[str], ids: Iterable[str],
               scope: WorkspaceScope | None = None) -> set[str]:
    """The ``ids`` that have a tombstone under one of ``sources``: the deployment's (``{id}``), or, given a workspace,
    that workspace's (``{ws}#{id}``, copies.py ``tombstone_key``)."""
    wanted = list(dict.fromkeys(ids))
    keys = [tombstone_key(source, feedback_id, scope) for source in sources for feedback_id in wanted]
    if not keys:
        return set()
    rows = batch_get_all(aggregates_table, keys, failure=TombstonesUnreadable('Tombstones could not be read'),
                         read_options={'ProjectionExpression': 'sk'})
    prefix = '' if scope is None else f'{scope.ws}#'
    return {str(row['sk']).removeprefix(prefix) for row in rows}


def _mark(row: Mapping[str, Any], removed: int, run: Mapping[str, Any]) -> dict[str, Any]:
    previous = row.get(MARK_FIELD)
    before = previous.get('count') if isinstance(previous, Mapping) else 0
    return {
        'count': int(before or 0) + removed, 'job_id': run.get('job_id') or run['run_id'],
        'mode': run['mode'], 'at': now_iso(),
    }


def _list_update(row: Mapping[str, Any], erased: set[str]) -> tuple[list[str], list[str], dict[str, str],
                                                                 dict[str, Any], int]:
    """``(sets, conditions, names, values, removed)`` that drop ``erased`` from the row's id lists."""
    sets: list[str] = []
    conditions: list[str] = []
    names: dict[str, str] = {}
    values: dict[str, Any] = {}
    removed = 0
    for n, field in enumerate(field for field in ID_FIELDS if isinstance(row.get(field), list)):
        listed = row[field]
        kept = [value for value in listed if value not in erased]
        removed += len(listed) - len(kept)
        names[f'#f{n}'] = field
        values.update({f':old{n}': listed, f':new{n}': kept})
        sets.append(f'#f{n} = :new{n}')
        conditions.append(f'#f{n} = :old{n}')
    if isinstance(row.get(EVIDENCE_UPDATES_FIELD), list):
        kept, gone = _kept_updates(row, erased)
        removed += gone
        names['#fu'] = EVIDENCE_UPDATES_FIELD
        values.update({':oldu': row[EVIDENCE_UPDATES_FIELD], ':newu': kept})
        sets.append('#fu = :newu')
        conditions.append('#fu = :oldu')
    return sets, conditions, names, values, removed


def mark_artifact(projects_table: Any, row: Mapping[str, Any], erased: set[str], run: Mapping[str, Any],
                  scope: WorkspaceScope | None = None) -> bool:
    """Drop ``erased`` from the row's lists and mark it; False when it changed since it was read. A workspace's row
    (``scope``) is written through the workspace layer (its key checked to be that workspace's first)."""
    sets, conditions, names, values, removed = _list_update(row, erased)
    update = {
        'UpdateExpression': f"SET {', '.join(sets)}, #mark = :mark",
        'ConditionExpression': ' AND '.join(conditions),
        'ExpressionAttributeNames': {**names, '#mark': MARK_FIELD},
        'ExpressionAttributeValues': {**values, ':mark': _mark(row, removed, run)},
    }
    if not set(update['ExpressionAttributeNames'].values()) <= set(LINEAGE_UPDATE_ATTRIBUTES):
        # IAM refuses any other (dynamodb:Attributes): fail here, saying so, rather than as AccessDenied.
        raise RuntimeError('A lineage mark names an attribute the worker may not update')
    key = {'pk': row['pk'], 'sk': row['sk']}
    try:
        if scope is None:
            projects_table.update_item(Key=key, **update)
        else:
            ws_table(scope, projects_table).update_item(key, **update)
    except ClientError as e:
        if is_conditional_check_failure(e):
            logger.info('An artifact changed while its erased evidence was being marked; left for the next run')
            return False
        raise
    return True


def mark_rows(projects_table: Any, aggregates_table: Any, run: dict[str, Any],
              rows: Sequence[Mapping[str, Any]], scope: WorkspaceScope | None = None) -> None:
    """Mark every row of one page whose lists name an erased item (counted in ``run['artifacts_marked']``); a
    workspace's rows (``scope``) against that workspace's tombstones.

    One tombstone lookup for the whole page (BatchGetItem, 100 keys a request).
    """
    if scope is None:
        listed = [_listed_ids(row) for row in rows]
        erased = erased_ids(aggregates_table, list(run['erased_sources']),
                            (feedback_id for ids in listed for feedback_id in ids))
        hits_of = [erased.intersection(ids) for ids in listed]
    else:
        hits_of = _workspace_hits(aggregates_table, run, rows, scope)
    for row, hits in zip(rows, hits_of, strict=True):
        if hits and mark_artifact(projects_table, row, hits, run, scope):
            run['artifacts_marked'] += 1


def _workspace_hits(aggregates_table: Any, run: Mapping[str, Any], rows: Sequence[Mapping[str, Any]],
                    scope: WorkspaceScope) -> list[set[str]]:
    """Each workspace row's erased ids: its reviews and cited reviews by that workspace's tombstones
    (``{ws}#{id}``), its board requests by the deployment's (``feature_requests`` / ``{id}``)."""
    sources = list(run['erased_sources'])
    reviews = [_listed_ids(row, ID_FIELDS[:2]) for row in rows]
    requests = [_listed_ids(row, ID_FIELDS[2:], refreshed=False) for row in rows]
    erased_reviews = erased_ids(aggregates_table, [source for source in sources if source != FEATURE_REQUESTS_SOURCE],
                                (one for ids in reviews for one in ids), scope)
    erased_requests = erased_ids(aggregates_table, [FEATURE_REQUESTS_SOURCE] if FEATURE_REQUESTS_SOURCE in sources
                                 else [], (one for ids in requests for one in ids))
    return [erased_reviews.intersection(review_ids) | erased_requests.intersection(request_ids)
            for review_ids, request_ids in zip(reviews, requests, strict=True)]


# ── The workspaces' pass ───────────────────────────────────────────────────────────────────────────────────────

def pending_workspaces(run: Mapping[str, Any]) -> list[str]:
    """The workspaces whose items the run deleted, whose projects the ``workspace_lineage`` phase still has to mark."""
    return list(run.get(LINEAGE_WORKSPACES) or [])


class ListingUnavailable(RuntimeError):
    """The run deleted items of more workspaces than it could list (``LINEAGE_ALL``) and voc-workspaces, which lists
    them, is not configured: the phase cannot reach them, so the job fails and says so, never skips them."""


def _walks_listing(run: Mapping[str, Any], workspaces_table: Any) -> bool:
    """Whether the phase walks every listed workspace (the job names no workspace): the run deleted items of more
    workspaces than ``LINEAGE_WORKSPACES`` keeps (``LINEAGE_ALL``, runs.py: then voc-workspaces must be there, else
    ``ListingUnavailable``), or it de-identified a board request (any workspace's artifact may cite one; without
    voc-workspaces there is no workspace to walk)."""
    if workspaces.named(run) is not None:
        return False
    if run.get(LINEAGE_ALL) is True:
        return True
    return int(run.get(BOARD_COUNTER) or 0) > 0 and workspaces_table is not None


def has_work(run: Mapping[str, Any], workspaces_table: Any) -> bool:
    """Whether the ``workspace_lineage`` phase has anything to look at."""
    return bool(pending_workspaces(run)) or _walks_listing(run, workspaces_table)


def _own_partition(project_id: str, scope: WorkspaceScope | None) -> str:
    """The project's own partition in voc-projects (``project_partitions``' kind ``project``)."""
    [own] = [part.partition for part in project_partitions(project_id, workspace=scope) if part.kind == 'project']
    return own


def deployment_step(projects_table: Any, aggregates_table: Any, run: dict[str, Any],
                    cursor: Mapping[str, Any] | None) -> dict[str, Any] | None:
    """One step of the deployment's pass (``lineage``, since 7.48.00 by Query: the module docstring): first how its
    projects are found (``found``, workspaces.py ``deployment_found``: its registry once the backfill's marker is
    there, else the backfill's ``PROJECTS`` Scan); then a filtered page of the first project's own partition and its
    marks; or the next page of the deployment's projects; or its persona library; None once all are done. A cursor of
    the Scan before 7.48.00 (a row's key, carried by a hand-over across the upgrade) names none of these steps: the
    pass starts again from the top, every mark being idempotent."""
    known = ('found', 'ids', 'start', 'library', *workspaces.projects_keys(None))
    at = {name: value for name, value in (cursor or {}).items() if name in known}
    if 'found' not in at:
        return {'found': workspaces.deployment_found(projects_table)}
    workspaces.checked_found(at)
    return _projects_step(projects_table, aggregates_table, run, None, at)


def _projects_step(projects_table: Any, aggregates_table: Any, run: dict[str, Any], scope: WorkspaceScope | None,
                   at: dict[str, Any]) -> dict[str, Any] | None:
    """One step of a scope's projects, as both passes walk them: a filtered page of the first project's own partition
    and its marks; or the scope's next page of projects (workspaces.py ``registry_step``: a workspace's registry, the
    deployment's, or its Scan); or its persona library (``library_step``); None once all are done."""
    ids = checked_ids(at.get('ids'), is_project_id, 'ids')
    if ids:
        return _partition_step(projects_table, aggregates_table, run, scope, ids, at)
    if not at.get(workspaces.projects_keys(scope)[1]):
        return workspaces.registry_step(projects_table, run, scope, at, start=None)
    if not at.get('library'):
        return workspaces.library_step(at, start=None)
    return None


def _start(run: Mapping[str, Any], workspaces_table: Any, now: datetime) -> dict[str, Any]:
    """The phase's first cursor: the listing (``mode`` ``listing``, begun ``now``), or the run's own list (``mode``
    ``pending``)."""
    if _walks_listing(run, workspaces_table):
        if workspaces_table is None:
            raise ListingUnavailable('The workspaces to mark cannot be listed: voc-workspaces is not configured')
        return {**workspaces.listing_start(now), 'mode': 'listing'}
    return {'mode': 'pending', 'at': {}}


def _page_of(run: Mapping[str, Any], here: Mapping[str, Any]) -> list[str]:
    """The workspaces still to walk, the first being walked: the listing's page, or the run's list. For a job that
    names a workspace, only that one (ValueError otherwise)."""
    if here.get('mode') == 'listing':
        return workspaces.checked_page(run, here)
    if here.get('mode') != 'pending':
        raise ValueError('a carried lineage mode is not one')
    pending = pending_workspaces(run)
    only = workspaces.named(run)
    if only is not None and any(ws != only for ws in pending):
        raise ValueError('a one-workspace job carried another workspace')
    return pending


def _workspace_done(run: dict[str, Any], here: dict[str, Any], page: list[str]) -> dict[str, Any]:
    """The cursor once the first workspace of the page is done: the next one starts from the top."""
    if here['mode'] == 'pending':
        run[LINEAGE_WORKSPACES] = page[1:]
        return {**here, 'at': {}}
    return {**here, 'ws': page[1:], 'at': {}}


def workspace_step(projects_table: Any, aggregates_table: Any, run: dict[str, Any], cursor: Mapping[str, Any] | None,
                   workspaces_table: Any = None,
                   clock: Callable[[], datetime] = workspaces.utc_now) -> dict[str, Any] | None:
    """One step of the phase (the module docstring): the listing's next page (or a re-walk pass's: workspaces.py,
    ``clock`` its wall clock); or, in the first workspace still to walk, a page of a project's partition and its marks,
    the registry's next page of ids, or the persona library; or that workspace is done. None once every workspace is
    (the run's list then cleared)."""
    here = dict(cursor) if cursor else _start(run, workspaces_table, clock())
    page = _page_of(run, here)
    if not page:
        if here['mode'] == 'listing' and not here.get('listing_done'):
            return workspaces.listing_page(run, workspaces_table, here, clock())
        run.pop(LINEAGE_WORKSPACES, None)
        return None
    scope = scope_from_message({WORKSPACE_FIELD: page[0]})
    moved = _projects_step(projects_table, aggregates_table, run, scope, dict(here.get('at') or {}))
    return _workspace_done(run, here, page) if moved is None else {**here, 'at': moved}


def _partition_step(projects_table: Any, aggregates_table: Any, run: dict[str, Any], scope: WorkspaceScope | None,
                    ids: list[str], at: dict[str, Any]) -> dict[str, Any]:
    """One filtered page of the first project's own partition (a workspace's through the layer, the deployment's,
    ``scope`` None, on the table), and its marks."""
    rows, following = query_page(table_view(scope, projects_table), _own_partition(ids[0], scope),
                                 checked_key(at.get('start')), Limit=PAGE_SIZE, FilterExpression=_CARRIES_A_LIST,
                                 ProjectionExpression=_PROJECTION, ExpressionAttributeNames=dict(_NAMES))
    mark_rows(projects_table, aggregates_table, run, rows, scope)
    return {**at, 'start': following} if following else {**at, 'ids': ids[1:], 'start': None}
