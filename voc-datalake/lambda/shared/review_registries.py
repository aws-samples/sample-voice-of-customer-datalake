"""The deployment's registries of its review links and of its commented series (since 7.48.00, projects 3g-d;
docs/multi-workspace.md, the project plan's 3g-d and 3g-d2).

Every real reviewer address sits in the deployment's own rows today: a link's audience (``DOCSHARE#{id}`` /
``META``) and the threads of a series (``DCOMMENTS#{project}#{series}``). A workspace lists both (its
``WS#{ws}#DOCSHARE_IDS`` and each project's ``COMMENT_SERIES#`` rows, 7.37.00); the deployment listed neither, and a
revoke deletes the series' ``SHARE`` pointer, so nothing named a revoked link. Since 7.48.00:

- the link create puts the link in ``DOCSHARE_IDS`` / ``{share id}`` and its series in ``COMMENT_SERIES_IDS`` /
  ``{project}#{series}`` in its own transaction (shared/document_share.py), a series' first thread puts its series
  there if absent (shared/document_comments.py ``put_thread``), and so does the project bundle's import;
- a project's create lists the project in the deployment's project registry (``PROJECT_IDS`` / ``{id}``,
  shared/project_writes.py ``register_deployment_project``), which its delete never touches (the delete's fence takes
  the tombstoned ``META`` off ``gsi1-by-type``, so the index no longer names a deleted or half-deleted project);
- what was made before is listed once by the backfill (scripts/projects/backfill_review_registries.py: three Scans,
  put if absent, then the marker, ``REVIEW_REGISTRIES_MARKER_SK``, a row of the link registry saying it is done, with
  when, what it found and the release it was taken under: ``marker_complete`` wants every count and a release of
  7.48.0 or later).

An erasure by email (jobs/retention/project_people.py) and the deployment's lineage pass (jobs/retention/lineage.py)
walk the registries by Query. Since 7.93.00 (3g-d2) no Scan finds the rows instead (the Scans are the backfill's
alone, and the worker holds no Scan of voc-projects): every run of the retention worker that names no workspace and can delete or replay
starts with its ``registries`` phase (jobs/retention/registries.py: this module's marker, then the live projects on
``gsi1-by-type`` looked up in ``PROJECT_IDS``); without both, an erasure by email fails by name before it deletes, and
every other run owes its lineage marks. The rows the stores had written when the walk read that part are found,
provided every writer since the backfill ran 7.48.00 or later (a VocApiStack-only rollback below it, or a bundle
imported from an older checkout, breaks this until the backfill's ``--unmark``; the check catches a live project such
a writer left unlisted, never an unlisted review link, an unlisted series or an unlisted deleted project); one written
after (a thread on a series already walked) is the next erasure's, as in a workspace.

The series registry is deployment-wide, not in each project's partition as a workspace's list is: the deployment's
project delete (api/projects.py ``delete_project``) empties the project's partition and leaves its comment partitions,
so a list kept there would lose the threads of a deleted project, which still hold their reviewers' addresses.
"""
from __future__ import annotations

from collections.abc import Mapping
from decimal import Decimal
from typing import Any, Final

__all__ = ['FIRST_RELEASE', 'MARKER_PROJECTION', 'marker_complete', 'release_of']

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


def release_of(value: object) -> tuple[int, ...] | None:
    """A release as ``APP_VERSION`` and the marker name it (``7.48.0``), as numbers; None when it is not one."""
    parts = str(value).split('.') if isinstance(value, str) and value else []
    if len(parts) < 3 or not all(part.isdigit() for part in parts[:3]):
        return None
    return tuple(int(part) for part in parts[:3])


def marker_complete(row: Mapping[str, Any] | None) -> bool:
    """Whether a marker row says the backfill finished: its ``completed_at``, every count, and a ``release`` of
    ``FIRST_RELEASE`` or later there (an incomplete one, written by hand or half-copied, or one an older release
    wrote, reads as absent: since 7.93.00 an erasure by email then fails by name, and every other run owes)."""
    if not isinstance(row, Mapping):
        return False
    at = row.get(MARKER_TIME)
    release = release_of(row.get(MARKER_RELEASE))
    return isinstance(at, str) and bool(at) and release is not None and release >= FIRST_RELEASE and all(
        isinstance(row.get(name), int | Decimal) and not isinstance(row.get(name), bool) for name in MARKER_COUNTS)
