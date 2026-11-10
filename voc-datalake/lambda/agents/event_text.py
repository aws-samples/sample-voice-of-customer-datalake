"""The names a run's events and summaries use: project names and labels, never ids.

A run's journal is read by product people, so a step that names a project says its
name ('Created the project "Faster checkout" for Billing'), not ``proj_…``. The name is
read ONCE per run: the first lookup stores it in the run context under
``PROJECT_NAMES_KEY`` (the node returns it in ``updates``) and every later step reads it
from there. A name that cannot be read reads as "the project" — never the id, and the
step never fails for it.
"""
from __future__ import annotations

from typing import TYPE_CHECKING, Final

from agents import principal
from agents.fields import dict_field
from shared.mcp_delegate import DelegationUnavailable

if TYPE_CHECKING:
    from agents.nodes.base import NodeContext

__all__ = ['project_name', 'project_ref', 'remember_project_name']

PROJECT_NAMES_KEY: Final = 'project_names'
UNNAMED_PROJECT: Final = 'the project'
MAX_NAME_CHARS: Final = 120
#: Names kept in the run context (a run touches one or two projects; the cap bounds the context).
MAX_CACHED_NAMES: Final = 10


def _clean(name: object) -> str:
    return ' '.join(name.split())[:MAX_NAME_CHARS] if isinstance(name, str) else ''


def remember_project_name(context: dict, project_id: str, name: object) -> dict:
    """The run-context update caching ``name`` for ``project_id`` ({} when there is nothing to cache)."""
    clean = _clean(name)
    names = dict_field(context, PROJECT_NAMES_KEY)
    if not clean or names.get(project_id) == clean:
        return {}
    others = [(key, value) for key, value in names.items() if key != project_id]
    newest = others[len(others) - (MAX_CACHED_NAMES - 1):] if len(others) >= MAX_CACHED_NAMES else others
    return {PROJECT_NAMES_KEY: {**dict(newest), project_id: clean}}


def project_ref(name: object) -> str:
    """``the project "<name>"``, or "the project" when it has no name — never its id."""
    clean = _clean(name)
    return f'{UNNAMED_PROJECT} "{clean}"' if clean else UNNAMED_PROJECT


def project_name(ctx: NodeContext, project_id: str) -> tuple[str, dict]:
    """``('the project "<name>"', run-context updates)`` for ``project_id`` — cached per run, read once otherwise."""
    cached = _clean(dict_field(ctx.context, PROJECT_NAMES_KEY).get(project_id))
    if cached:
        return project_ref(cached), {}
    try:
        payload = ctx.projects('GET', f'/projects/{project_id}', path_parameters={'project_id': project_id})
    except (principal.RouteError, DelegationUnavailable):
        return UNNAMED_PROJECT, {}
    meta = payload.get('project') if isinstance(payload, dict) else None
    name = _clean(meta.get('name')) if isinstance(meta, dict) else ''
    return project_ref(name), remember_project_name(ctx.context, project_id, name)
