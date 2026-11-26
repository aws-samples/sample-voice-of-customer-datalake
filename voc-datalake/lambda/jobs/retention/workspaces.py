"""voc-retention: which workspaces a workspace phase walks, and its counts (7.43.00, projects 3g-b).

Both workspace phases (lineage.py ``workspace_lineage``, project_people.py ``workspace_projects``) walk a list of
workspaces, one at a time, its cursor carrying the page of workspace ids still to do (``ws``, the first being walked)
and, when the list is the platform's, where its listing is:

* the platform's listing (voc-workspaces' ``WORKSPACES`` partition, shared/platform_workspaces.py
  ``listing_ids_page``, ``ID_PAGE`` a page): the deployment's erasure by email (every workspace may hold the address)
  and a run that de-identified board requests (any workspace's artifact may cite one) or deleted items of more
  workspaces than lineage's list keeps. The listing is sorted by name, then id (its sort key, the one key that lists
  every workspace), and a rename moves a workspace's row to its new name's key, which can put it behind the page
  already read; a workspace created meanwhile can land there too. So the walk tolerates a moved row: its cursor
  carries when it began, less ``SKEW`` for the clocks' drift (``since``), and when the listing ends it reads the
  listing again, one strongly consistent Query filtered to the rows stamped since then (``renamed_at``, which the
  rename stamps on the row it puts, shared/workspace_rename.py, or ``created_at``), and walks those workspaces again
  (every step is idempotent). That re-walk pass is repeated, from the previous pass's start (less ``SKEW``), while a
  pass finds a row stamped since its own start that the previous pass did not walk with that same stamp; past
  ``MAX_REWALKS`` passes, or ``MAX_MOVED`` such rows in one pass, the job fails (``ListingKeptMoving``) and an admin
  runs it again. A rename that lands between two pages of the last pass (a listing over 1 MB is read in more than one
  page) and moves its row behind them is the one case still not walked;
* one named workspace (a workspace's own erasure, ``workspace_id`` on the run): its cursor may only ever carry that
  workspace (``checked_page``: a hand-over naming another, or the listing, fails the job);
* lineage's own list of the workspaces whose items the run deleted (``LINEAGE_WORKSPACES``, runs.py).
"""
from __future__ import annotations

from collections.abc import Callable, Mapping
from datetime import UTC, datetime, timedelta
from typing import Any, Final

from shared import review_registries
from shared.company_personas import COMPANY_PERSONAS_CONTAINER
from shared.ingest_tables import table_view
from shared.platform_workspaces import LISTING_PK, RENAMED_AT, listing_ids_page
from shared.project_keys import DEPLOYMENT_LINK_REGISTRY_PK, REVIEW_REGISTRIES_MARKER_SK
from shared.project_walk import (
    ID_PAGE,
    RegistryPage,
    StuckQuery,
    checked_ids,
    checked_key,
    merged,
    query_page,
    registry_page,
    sort_key,
)
from shared.retention import MALFORMED_ID_COUNTER
from shared.scoped_query import SK_EQUALS
from shared.workspace_ids import is_workspace_id
from shared.ws_repo import WORKSPACE_FIELD, WorkspaceScope, ws_table

#: How far the worker's clock may run ahead of the API's that stamps the listing rows.
SKEW: Final = timedelta(minutes=5)
#: The re-walk passes after the listing ends; a last one that still finds a newer stamp fails the job.
MAX_REWALKS: Final = 3
#: The rows one re-walk pass may walk, and carry for the next to skip.
MAX_MOVED: Final = 100
_CREATED_AT: Final = 'created_at'
#: How a walk of the deployment finds its links, series and projects (``found``, ``deployment_found``): its
#: registries by Query once the backfill's marker is there, else the backfill's own Scans (shared/review_registries.py).
FOUND_REGISTRY: Final = 'registry'
FOUND_SCAN: Final = 'scan'
_BAD_REWALK_STATE: Final = 'a carried listing pass is not one'


class ListingKeptMoving(RuntimeError):
    """The listing kept moving under the walk (``MAX_REWALKS``, ``MAX_MOVED``): the job fails, an admin reruns it."""


def utc_now() -> datetime:
    """The walks' wall clock (each phase takes it injected)."""
    return datetime.now(UTC)


def count(run: dict[str, Any], counter: str, n: int = 1) -> None:
    """Add ``n`` to an optional counter of the run (shared/retention.py ``ERASURE_OPTIONAL_COUNTERS``)."""
    if n:
        run[counter] = int(run.get(counter) or 0) + n


def named(run: Mapping[str, Any]) -> str | None:
    """The one workspace a job names, or None for the deployment's: None only when the run names none (no
    ``workspace_id``, or a null one); any other value that is not a workspace id fails the job (ValueError), never
    reads as the deployment's job, which walks the deployment's projects and every listed workspace."""
    value = run.get(WORKSPACE_FIELD)
    if value is not None and not is_workspace_id(value):
        raise ValueError('the job names a workspace id that is not one')
    return None if value is None else str(value)


def listing_start(now: datetime) -> dict[str, Any]:
    """The cursor of a walk over the platform's listing, before its first page, begun at ``now``: ``pass`` 0 is the
    listing's own pages; each re-walk pass reads the rows stamped from ``since``, sets ``pass_at`` (its own start,
    less ``SKEW``) at its first page, skips what the previous pass walked (``seen``), notes what the next must skip
    (``seen_next``) and whether it found a newer stamp (``newer``)."""
    return {'ws': [], 'listing': None, 'listing_done': False, 'at': {}, 'pass': 0, 'since': _iso(now - SKEW),
            'pass_at': None, 'seen': [], 'seen_next': [], 'newer': False}


def one_start(ws: str) -> dict[str, Any]:
    """The cursor of a walk over one workspace."""
    return {'ws': [ws], 'listing_done': True, 'at': {}}


#: The flag a walk's cursor carries once the deployment's own part is done (the projects walk, project_people.py, and
#: the participants', participants.py; a one-workspace job's cursor has none).
DEPLOYMENT_DONE: Final = 'deployment_done'


def start(run: Mapping[str, Any], clock: Callable[[], datetime]) -> dict[str, Any]:
    """The first cursor of a walk of the run's workspaces: the one a job names (``one_start``), else the platform's
    listing, begun now (``listing_start``)."""
    only = named(run)
    return one_start(only) if only is not None else listing_start(clock())


def checked_page(run: Mapping[str, Any], here: Mapping[str, Any]) -> list[str]:
    """The carried page of workspace ids; for a job that names a workspace, only that one and never the listing
    (ValueError otherwise: a hand-over of a one-workspace job must not reach another workspace)."""
    page = checked_ids(here.get('ws'), is_workspace_id, 'ws')
    only = named(run)
    if only is not None and (any(ws != only for ws in page) or here.get('listing_done') is not True):
        raise ValueError('a one-workspace job carried another workspace')
    return page


def projects_keys(scope: WorkspaceScope | None) -> tuple[str, str]:
    """The cursor's names for where the scope's list of projects is, and whether it is done: a workspace's registry
    (``registry``, ``registry_done``), the deployment's (``projects_from``, ``projects_done``)."""
    return ('registry', 'registry_done') if scope is not None else ('projects_from', 'projects_done')


def deployment_found(projects_table: Any) -> str:
    """How a walk of the deployment finds its links, series and projects (since 7.48.00, 3g-d; a deployment cursor's
    ``found``): ``FOUND_REGISTRY`` once the backfill's marker is there and complete (one strongly consistent Query,
    projected to what ``review_registries.marker_complete`` judges), else ``FOUND_SCAN``, the backfill's own Scans."""
    rows, _ = query_page(table_view(None, projects_table), DEPLOYMENT_LINK_REGISTRY_PK, None, ConsistentRead=True,
                         **merged(sort_key(SK_EQUALS, {':sk': REVIEW_REGISTRIES_MARKER_SK}),
                                  review_registries.MARKER_PROJECTION))
    return FOUND_REGISTRY if rows and review_registries.marker_complete(rows[0]) else FOUND_SCAN


def checked_found(at: Mapping[str, Any]) -> str:
    """A deployment cursor's ``found`` (ValueError when it is not one: a malformed run state)."""
    found = at.get('found')
    if found not in (FOUND_REGISTRY, FOUND_SCAN):
        raise ValueError('a carried way of finding the links is not one')
    return str(found)


def scan(run: dict[str, Any], projects_table: Any, kind: str, start: object,
         after: object = None) -> review_registries.Found:
    """One Scan page of the backfill's ``kind`` pass (shared/review_registries.py), its malformed rows counted; a page
    answering with its own start key fails the job (``StuckQuery``)."""
    begun = checked_key(start)
    page = review_registries.scan_page(projects_table, kind, begun, after if isinstance(after, str) else None)
    if page.following is not None and begun and page.following == begun:
        raise StuckQuery('a Scan answered with the key it started from')
    count(run, MALFORMED_ID_COUNTER, page.malformed)
    return page


def registry_step(projects_table: Any, run: dict[str, Any], scope: WorkspaceScope | None, at: Mapping[str, Any],
                  **starting: Any) -> dict[str, Any]:
    """The scope's next page of projects, as every walk reads it: a workspace's registry, or (``scope`` None, since
    7.48.00) the deployment's, ``PROJECT_IDS`` (shared/project_walk.py ``registry_page``), or until the backfill ran
    (the cursor's ``found``) a page of its ``PROJECTS`` Scan; every project shaped like one, a deleted or half-deleted
    one too (its rows, or its kept ``META``, stay; its delete leaves its registry row), a malformed row counted
    (``project_ids_malformed``); ``starting``: the per-project part of the cursor as the page's first project starts."""
    following_key, done_key = projects_keys(scope)
    if scope is None and checked_found(at) == FOUND_SCAN:
        scanned = scan(run, projects_table, review_registries.PROJECTS, at.get(following_key))
        ids, following = scanned.ids, scanned.following
    else:
        page: RegistryPage = registry_page(table_view(scope, projects_table) if scope is None
                                           else ws_table(scope, projects_table), scope, at.get(following_key))
        ids, following = page.ids, page.following
        count(run, MALFORMED_ID_COUNTER, page.malformed)
    return {**at, following_key: following, done_key: following is None, 'ids': ids, **starting}


def library_step(at: Mapping[str, Any], **starting: Any) -> dict[str, Any]:
    """The scope's company persona library, which no registry or index lists, walked as a project last."""
    return {**at, 'ids': [COMPANY_PERSONAS_CONTAINER], 'library': True, **starting}


def listing_page(run: dict[str, Any], table: Any, here: Mapping[str, Any], now: datetime) -> dict[str, Any]:
    """The platform's next page of workspaces (one Query of ``WORKSPACES``): the listing's own, or once it ended a
    re-walk pass's (the module docstring); their ids to walk; a row naming no workspace id counted
    (``project_ids_malformed``); a page answering with the key it started from fails the job (``StuckQuery``)."""
    start = checked_key(here.get('listing'))
    state = _pass_state(here)
    if state['pass'] == 0:
        ids, malformed, following = listing_ids_page(table, limit=ID_PAGE, start=start)
        _not_stuck(start, following)
        count(run, MALFORMED_ID_COUNTER, malformed)
        if following is not None:
            return {**here, 'ws': ids, 'listing': following, 'at': {}}
        return {**here, 'ws': ids, 'listing': None, 'at': {}, **_next_pass(1, str(state['since']), [])}
    return _rewalk_page(run, table, {**here, **state}, start, now)


def _rewalk_page(run: dict[str, Any], table: Any, here: dict[str, Any], start: dict[str, Any] | None,
                 now: datetime) -> dict[str, Any]:
    """One page of a re-walk pass: the rows stamped from ``since`` (``renamed_at`` or ``created_at``), strongly
    consistent; at the pass's end the next pass, the walk's end, or past ``MAX_REWALKS`` the job fails."""
    pass_at = here['pass_at'] if start else _iso(now - SKEW)
    if pass_at is None:
        raise ValueError(_BAD_REWALK_STATE)  # a page after a pass's first carries when that pass began
    since = here['since']
    request: dict[str, Any] = {
        'KeyConditionExpression': '#pk = :pk', 'ConsistentRead': True,
        'FilterExpression': '#renamed >= :since OR #created >= :since',
        'ProjectionExpression': '#pk, #sk, #ws, #renamed, #created',
        'ExpressionAttributeNames': {'#pk': 'pk', '#sk': 'sk', '#ws': WORKSPACE_FIELD, '#renamed': RENAMED_AT,
                                     '#created': _CREATED_AT},
        'ExpressionAttributeValues': {':pk': LISTING_PK, ':since': since},
    }
    if start:
        request['ExclusiveStartKey'] = dict(start)
    response = table.query(**request)
    following = response.get('LastEvaluatedKey') or None
    _not_stuck(start, following)
    seen = {(ws, stamp) for ws, stamp in here['seen']}
    seen_next, newer, ids = list(here['seen_next']), bool(here['newer']), []
    for row in response.get('Items', []):
        ws, stamp = row.get(WORKSPACE_FIELD), _stamp(row)
        if not is_workspace_id(ws) or stamp is None:
            count(run, MALFORMED_ID_COUNTER)
            continue
        if (ws, stamp) not in seen:
            ids.append(ws)
            newer = newer or stamp >= pass_at
        if stamp >= pass_at:
            seen_next.append([ws, stamp])
    if len(ids) > MAX_MOVED or len(seen_next) > MAX_MOVED:
        raise ListingKeptMoving(f'More than {MAX_MOVED} workspaces were renamed or created while the erasure ran')
    page = {**here, 'ws': ids, 'at': {}, 'pass_at': pass_at, 'seen_next': seen_next, 'newer': newer}
    if following is not None:
        return {**page, 'listing': dict(following)}
    if not newer:
        return {**page, 'listing': None, 'listing_done': True}
    if here['pass'] >= MAX_REWALKS:
        raise ListingKeptMoving(f'The workspace listing kept moving through {MAX_REWALKS} passes of the erasure')
    return {**page, 'listing': None, **_next_pass(int(here['pass']) + 1, pass_at, seen_next)}


def _next_pass(number: int, since: str, seen: list[list[str]]) -> dict[str, Any]:
    return {'pass': number, 'since': since, 'pass_at': None, 'seen': seen, 'seen_next': [], 'newer': False}


def _not_stuck(start: Mapping[str, Any] | None, following: Mapping[str, Any] | None) -> None:
    if following is not None and start and dict(following) == dict(start):
        raise StuckQuery('the workspace listing answered with the key it started from')


def _stamp(row: Mapping[str, Any]) -> str | None:
    """The row's latest stamp, ``renamed_at`` or ``created_at`` (ISO-8601 in UTC, so they compare as text)."""
    stamps = [value for value in (row.get(RENAMED_AT), row.get(_CREATED_AT)) if isinstance(value, str) and value]
    return max(stamps) if stamps else None


def _iso(at: datetime) -> str:
    return at.isoformat()


def _pass_state(here: Mapping[str, Any]) -> dict[str, Any]:
    """The carried re-walk state, checked (ValueError otherwise: the walk made it, so a bad one is a bug or tampering)."""
    number, since, pass_at, newer = here.get('pass'), here.get('since'), here.get('pass_at'), here.get('newer')
    if (not isinstance(number, int) or isinstance(number, bool) or not 0 <= number <= MAX_REWALKS
            or not isinstance(since, str) or not (pass_at is None or isinstance(pass_at, str))
            or not isinstance(newer, bool)):
        raise ValueError(_BAD_REWALK_STATE)
    return {'pass': number, 'since': since, 'pass_at': pass_at, 'newer': newer,
            'seen': _pairs(here.get('seen')), 'seen_next': _pairs(here.get('seen_next'))}


def _pairs(value: object) -> list[list[str]]:
    """A carried list of ``[workspace id, stamp]``, at most ``MAX_MOVED``."""
    if not isinstance(value, list) or len(value) > MAX_MOVED:
        raise ValueError(_BAD_REWALK_STATE)
    pairs = []
    for pair in value:
        if (not isinstance(pair, list) or len(pair) != 2 or not is_workspace_id(pair[0])
                or not isinstance(pair[1], str)):
            raise ValueError(_BAD_REWALK_STATE)
        pairs.append([pair[0], pair[1]])
    return pairs
