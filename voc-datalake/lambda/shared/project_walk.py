"""Reading a workspace's projects one Query page at a time, with a checkpointed cursor (7.43.00; docs/multi-workspace.md,
the project plan's 3g).

The workspace export (jobs/workspace_export/projects.py) and the retention worker's workspace phases
(jobs/retention/lineage.py ``workspace_lineage``, jobs/retention/project_people.py ``workspace_projects``) page by hand:
each step reads one page through the workspace layer (shared/ws_repo.py ``WorkspaceTable.query``: a partition or a
cursor outside the workspace is refused before DynamoDB) and a hand-over carries where the next page starts. They share
what is here:

* ``query_page``: one page and the key the next starts from; a page that answers with the key it started from fails
  the job (``StuckQuery``), so no walk reads one page forever;
* ``registry_page``: one strongly consistent page of the workspace's registry of project ids
  (``WS#{ws}#PROJECT_IDS``, read with ``REGISTRY_PROJECTION``: shared/project_tables.py ``registered_project``), its
  ids shaped like a project id, which of them are live, and how many rows were malformed (the persona library's
  reserved id is left out, uncounted: the walks read the library on their own);
* ``checked_ids`` / ``checked_key`` / ``is_project_id``: a carried cursor's ids and keys checked before they name a
  partition (ValueError: a malformed run state);
* ``sort_key``: a Query's key condition on ``sk`` for the layer's ``sort_condition``.
"""
from __future__ import annotations

from collections.abc import Callable, Mapping
from typing import Any, Final, NamedTuple

from shared.company_personas import COMPANY_PERSONAS_CONTAINER
from shared.project_keys import project_registry_pk
from shared.project_tables import REGISTRY_PROJECTION, registered_project
from shared.row_ids import LONG_OPAQUE_ID_RE
from shared.ws_repo import WorkspaceScope, WorkspaceTable

__all__ = ['ID_PAGE', 'RegistryPage', 'StuckQuery', 'checked_ids', 'checked_key', 'is_project_id', 'merged',
           'query_page', 'registry_page', 'sort_key']

#: The rows one registry or id-list page reads at most (a cursor carries a page of ids: 100 ids of at most 128
#: characters, about 13 KB, well inside the 256 KB hand-over payload limit the code assumes).
ID_PAGE: Final = 100


class StuckQuery(RuntimeError):
    """A Query answered with the key it was started from: the walk would read that page forever (the job fails)."""


def sort_key(condition: str | None, values: Mapping[str, Any]) -> dict[str, Any]:
    """A Query's key condition on ``sk`` (written ``#sk``, its values named in ``values``), for the workspace layer's
    ``sort_condition``; nothing for a whole partition (``condition`` None)."""
    if condition is None:
        return {}
    return {'sort_condition': condition, 'ExpressionAttributeNames': {'#sk': 'sk'},
            'ExpressionAttributeValues': dict(values)}


def merged(*parts: Mapping[str, Any]) -> dict[str, Any]:
    """Query options merged, their ``ExpressionAttributeNames`` and ``ExpressionAttributeValues`` joined."""
    out: dict[str, Any] = {}
    for part in parts:
        for name, value in part.items():
            if name in ('ExpressionAttributeNames', 'ExpressionAttributeValues'):
                out[name] = {**out.get(name, {}), **value}
            else:
                out[name] = value
    return out


def query_page(view: WorkspaceTable, partition: str, start: Mapping[str, Any] | None,
               **kwargs: Any) -> tuple[list[dict[str, Any]], dict[str, Any] | None]:
    """One Query page of ``partition`` in the workspace from ``start``: its items and the key the next page starts
    from (None at the end). ``StuckQuery`` when DynamoDB answers with ``start`` itself."""
    options = dict(kwargs)
    if start:
        options['ExclusiveStartKey'] = dict(start)
    page = view.query('pk', partition, **options)
    found = page.get('Items')
    rows = [dict(item) for item in found if isinstance(item, Mapping)] if isinstance(found, list) else []
    last = page.get('LastEvaluatedKey')
    following = dict(last) if isinstance(last, Mapping) and last else None
    if following is not None and start and following == dict(start):
        raise StuckQuery('a Query answered with the key it started from')
    return rows, following


def is_project_id(value: object) -> bool:
    """A project id as a registry row or a cursor carries it (the claim's rule; the persona library's reserved id is
    one too)."""
    return isinstance(value, str) and LONG_OPAQUE_ID_RE.fullmatch(value) is not None


class RegistryPage(NamedTuple):
    """One page of a workspace's project registry: the ids shaped like a project id, those of them that are live, how
    many rows were not shaped like one, and the key of the next page (None at the end)."""

    ids: list[str]
    live: list[str]
    malformed: int
    following: dict[str, Any] | None


def registry_page(view: WorkspaceTable, scope: WorkspaceScope, start: Mapping[str, Any] | None) -> RegistryPage:
    """One strongly consistent page of the registry, each row read with ``REGISTRY_PROJECTION`` (any
    ``deleted_at`` but null reads deleted); the library's reserved id is left out, not counted."""
    rows, following = query_page(view, project_registry_pk(scope), checked_key(start), Limit=ID_PAGE,
                                 ConsistentRead=True, ProjectionExpression=REGISTRY_PROJECTION)
    registered = [registered_project(row) for row in rows if row.get('sk') != COMPANY_PERSONAS_CONTAINER]
    shaped = [project for project in registered if is_project_id(project.project_id)]
    return RegistryPage([project.project_id for project in shaped],
                        [project.project_id for project in shaped if not project.deleted],
                        len(registered) - len(shaped), following)


def checked_ids(carried: object, valid: Callable[[str], object], what: str) -> list[str]:
    """A carried page of ids, each one ``valid`` accepts (ValueError otherwise: a malformed run state)."""
    if carried is None:
        return []
    if not isinstance(carried, list) or len(carried) > ID_PAGE or not all(
            isinstance(each, str) and valid(each) for each in carried):
        raise ValueError(f'{what} is not a page of ids')
    return list(carried)


def checked_key(carried: object) -> dict[str, Any] | None:
    """A carried Query key (a map), or None."""
    if carried is None:
        return None
    if not isinstance(carried, Mapping):
        raise ValueError('a carried key is not a map')
    return dict(carried) or None
