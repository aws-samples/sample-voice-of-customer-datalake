"""The deployment's registries of its review links and of its commented series (since 7.48.00, projects 3g-d;
docs/multi-workspace.md, the project plan's 3g-d).

Every real reviewer address sits in the deployment's own rows today: a link's audience (``DOCSHARE#{id}`` /
``META``) and the threads of a series (``DCOMMENTS#{project}#{series}``). A workspace lists both (its
``WS#{ws}#DOCSHARE_IDS`` and each project's ``COMMENT_SERIES#`` rows, 7.37.00); the deployment listed neither, and a
revoke deletes the series' ``SHARE`` pointer, so nothing named a revoked link. Since this release:

- the link create puts the link in ``DOCSHARE_IDS`` / ``{share id}`` and its series in ``COMMENT_SERIES_IDS`` /
  ``{project}#{series}`` in its own transaction (shared/document_share.py), a series' first thread puts its series
  there if absent (shared/document_comments.py ``put_thread``), and so does the project bundle's import;
- a project's create lists the project in the deployment's project registry (``PROJECT_IDS`` / ``{id}``,
  shared/project_writes.py ``register_deployment_project``), which its delete never touches (the delete's fence takes
  the tombstoned ``META`` off ``gsi1-by-type``, so the index no longer names a deleted or half-deleted project);
- what was made before is listed once by the backfill (scripts/projects/backfill_review_registries.py: these three
  Scans, ``LINKS``, ``SERIES`` and ``PROJECTS``, put if absent, then the marker, ``REVIEW_REGISTRIES_MARKER_SK``, a
  row of the link registry saying it is done, with when, what it found and the release it was taken under:
  ``marker_complete`` wants every count and a release of 7.48.0 or later);
- an erasure by email (jobs/retention/project_people.py) and the deployment's lineage pass (jobs/retention/lineage.py)
  read the marker first: a complete one, they walk the registries by Query; none, or an incomplete one, they find the
  same links, series and projects by these same Scans (one read of the table per pass: three per erasure by email,
  one per lineage pass, until it runs). Either way the rows the stores had written when the walk read that part are
  found, provided every writer since the backfill ran 7.48.00 or later (a VocApiStack-only rollback below
  it, or a bundle imported from an older checkout, breaks this until the backfill's ``--unmark``); one written after (a thread on a series already walked) is the next erasure's, as in a workspace.

The series registry is deployment-wide, not in each project's partition as a workspace's list is: the deployment's
project delete (api/projects.py ``delete_project``) empties the project's partition and leaves its comment partitions,
so a list kept there would lose the threads of a deleted project, which still hold their reviewers' addresses.

A Scan page (``scan_page``) reads ``SCAN_PAGE`` rows of the table (DynamoDB applies the limit before the filter),
strongly consistent, projected to ``SCAN_ATTRIBUTES`` only (lib/stacks/retention-worker.ts holds the worker's Scan to
exactly these: ``dynamodb:Select`` and ``dynamodb:Attributes``), and answers the ids of what it found: for the links,
each deployment link (``DOCSHARE#{id}`` / ``META`` naming no workspace; a workspace link's routing row is that
workspace's, walked there, and skipped uncounted); for the series, each comment partition
(``DCOMMENTS#{project}#{series}``) once, judged by the walker's own rule (shared/project_walk.py ``is_series_ref``);
for the projects, each ``PROJECT#{id}`` / ``META`` (a tombstoned one too), its id shaped like one (``is_project_id``),
the persona library's container left out, uncounted (the walks read the library on their own).
Any other row under those prefixes is counted as malformed, a comment partition once whatever rows it holds, and
never fails anything. A Scan returns one partition's rows together, so a partition that runs over a page's end is met
again by the next page's first rows only: ``after`` (the last partition a page met, ``Found.last_pk``) drops that
repeat.
"""
from __future__ import annotations

from collections.abc import Mapping
from decimal import Decimal
from typing import Any, Final, NamedTuple

from shared.company_personas import COMPANY_PERSONAS_CONTAINER
from shared.project_keys import COMMENT_PARTITION_PREFIX, PROJECT_PREFIX, comment_partition_ids, project_id_of
from shared.project_walk import ID_PAGE, is_project_id, is_series_ref
from shared.review_share_audience import ROUTE_WORKSPACE_FIELD, SHARE_PK_PREFIX, SHARE_SK, is_share_id
from shared.workspace_ids import is_workspace_id

__all__ = ['FIRST_RELEASE', 'LINKS', 'MARKER_PROJECTION', 'PROJECTS', 'SERIES', 'Found', 'marker_complete',
           'release_of', 'scan_page']

#: The three passes, in this order: the links first, so an audience is scrubbed before the threads are read, then the
#: series, then the projects (``PROJECT#{id}`` / ``META``: since the delete's fence takes a deleted project off
#: ``gsi1-by-type``, only its registry row, ``PROJECT_IDS``, or this Scan finds it).
LINKS: Final = 'links'
SERIES: Final = 'series'
PROJECTS: Final = 'projects'
#: The rows one Scan page evaluates, so it answers at most a page of ids (a cursor carries at most ``ID_PAGE``).
SCAN_PAGE: Final = ID_PAGE
_PREFIX: Final = {LINKS: SHARE_PK_PREFIX, SERIES: COMMENT_PARTITION_PREFIX, PROJECTS: PROJECT_PREFIX}
#: What a page reads of a row: its key, a routing row's workspace, and what a link's or a project's registry row copies.
SCAN_ATTRIBUTES: Final = ('pk', 'sk', ROUTE_WORKSPACE_FIELD, 'project_id', 'series_id', 'created_at')
_NAMES: Final = {f'#a{n}': name for n, name in enumerate(SCAN_ATTRIBUTES)}
#: The marker's fields an erasure requires before it trusts the registries, and the release it must name at least:
#: 7.48.0 lists the projects too (a marker an older build wrote, or one left by a rollback, reads as absent).
MARKER_COUNTS: Final = ('links_found', 'series_found', 'projects_found')
MARKER_TIME: Final = 'completed_at'
MARKER_RELEASE: Final = 'release'
FIRST_RELEASE: Final = (7, 48, 0)
#: What a walk reads of the marker (a Query's projection; ``marker_complete`` judges it).
MARKER_PROJECTION: Final = {
    'ProjectionExpression': ', '.join(['#sk', *(f'#m{n}' for n in range(len(MARKER_COUNTS) + 2))]),
    'ExpressionAttributeNames': {f'#m{n}': name for n, name in enumerate((MARKER_TIME, MARKER_RELEASE,
                                                                          *MARKER_COUNTS))},
}


class Found(NamedTuple):
    """One Scan page: the ids found (a share id, or ``{project}#{series}``), each link's row as read (its project,
    series and creation time, for the backfill's registry row), how many partitions were malformed, the rows
    evaluated, the key the next page starts from (None at the end) and the last partition the page met."""

    ids: list[str]
    rows: dict[str, dict[str, Any]]
    malformed: int
    scanned: int
    following: dict[str, Any] | None
    last_pk: str | None


def series_ref(project_id: str, series_id: str) -> str:
    """How a series is carried and registered: ``{project}#{series}`` (the series registry's sort key)."""
    return f'{project_id}#{series_id}'


def release_of(value: object) -> tuple[int, ...] | None:
    """A release as ``APP_VERSION`` and the marker name it (``7.48.0``), as numbers; None when it is not one."""
    parts = str(value).split('.') if isinstance(value, str) and value else []
    if len(parts) < 3 or not all(part.isdigit() for part in parts[:3]):
        return None
    return tuple(int(part) for part in parts[:3])


def marker_complete(row: Mapping[str, Any] | None) -> bool:
    """Whether a marker row says the backfill finished: its ``completed_at``, every count, and a ``release`` of
    ``FIRST_RELEASE`` or later there (an incomplete one, written by hand or half-copied, or one an older release
    wrote, reads as absent, so the erasure keeps its own Scans)."""
    if not isinstance(row, Mapping):
        return False
    at = row.get(MARKER_TIME)
    release = release_of(row.get(MARKER_RELEASE))
    return isinstance(at, str) and bool(at) and release is not None and release >= FIRST_RELEASE and all(
        isinstance(row.get(name), int | Decimal) and not isinstance(row.get(name), bool) for name in MARKER_COUNTS)


def _request(kind: str, start: Mapping[str, Any] | None) -> dict[str, Any]:
    meta = ' AND #a1 = :meta' if kind == PROJECTS else ''
    request: dict[str, Any] = {
        'Limit': SCAN_PAGE, 'ConsistentRead': True, 'Select': 'SPECIFIC_ATTRIBUTES',
        'FilterExpression': f'begins_with(#a0, :prefix){meta}',
        'ExpressionAttributeValues': {':prefix': _PREFIX[kind], **({':meta': 'META'} if meta else {})},
        'ProjectionExpression': ', '.join(_NAMES), 'ExpressionAttributeNames': dict(_NAMES),
    }
    if start:
        request['ExclusiveStartKey'] = dict(start)
    return request


def scan_page(table: Any, kind: str, start: Mapping[str, Any] | None, after: str | None = None) -> Found:
    """One Scan page of the ``kind`` pass (``LINKS``, ``SERIES`` or ``PROJECTS``) from ``start``; ``after``: the last partition the
    previous page met, not met again (the module docstring)."""
    response = table.scan(**_request(kind, start))
    items = [dict(item) for item in response.get('Items') or [] if isinstance(item, Mapping)]
    last = response.get('LastEvaluatedKey')
    following = dict(last) if isinstance(last, Mapping) and last else None
    ids: list[str] = []
    rows: dict[str, dict[str, Any]] = {}
    seen: set[str] = set() if after is None else {after}
    malformed, last_pk = 0, None
    for item in items:
        pk = str(item.get('pk') or '')
        if kind == LINKS:
            found = _link_of(item)
            # A routing row naming a workspace id is that workspace's, uncounted; one naming anything else is malformed.
            if found is None and not is_workspace_id(item.get(ROUTE_WORKSPACE_FIELD)):
                malformed += 1
        elif kind == PROJECTS:
            project_id = project_id_of(pk)
            if project_id == COMPANY_PERSONAS_CONTAINER:
                continue  # the persona library's container: the walks read it on their own
            found = project_id if is_project_id(project_id) else None
            malformed += found is None
        else:
            last_pk = pk
            if pk in seen:
                continue
            seen.add(pk)
            found = _series_of(item)
            malformed += found is None
        if found is not None and found not in rows:
            ids.append(found)
            rows[found] = item
    return Found(ids, rows, malformed, int(response.get('ScannedCount') or 0), following, last_pk)


def _link_of(item: Mapping[str, Any]) -> str | None:
    """The deployment link a ``DOCSHARE#`` row is, or None (a routing row, which names a workspace, or a bad key)."""
    if ROUTE_WORKSPACE_FIELD in item or item.get('sk') != SHARE_SK:
        return None
    share_id = str(item.get('pk') or '').removeprefix(SHARE_PK_PREFIX)
    return share_id if is_share_id(share_id) else None


def _series_of(item: Mapping[str, Any]) -> str | None:
    ids = comment_partition_ids(item.get('pk'))
    ref = None if ids is None else series_ref(*ids)
    return ref if is_series_ref(ref) else None
