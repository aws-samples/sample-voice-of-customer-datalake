"""The global MCP server's Product tab tools (7.104.00, tenet 4; docs/mcp.md → Tools).

Each call is ONE route of the projects API, made as the token's minter (never admin, capped at editor), and the route
decides every rule (shared/product_source_routes.py, shared/product_proposal_routes.py):

* ``product_get``: ``GET /projects/{id}/product-proposals/latest``: the product form, who wrote each field, the
  sources with their status, and the latest extract's proposal (each field's value, citations, confidence, the value
  it was proposed against) with its questions.
* ``product_write``, by ``action``: ``add_url`` → ``POST …/product-docs/urls`` (a public https page as a source);
  ``answer`` → ``POST …/product-docs/answers`` (typed answers as one interview source); ``extract`` →
  ``POST …/product-extract`` (a billed job: follow it with ``projects_get_job``); ``accept`` →
  ``POST …/product-proposals/{proposal_id}/accept``, each field with the value it was seen at. An MCP token is an
  autonomous caller, so the route never lets it replace a value a person typed (``person_value``).

Every limit is the route's (a link's https, its length, the answers' count and lengths, the fields): the tool keeps
none of its own and passes the arguments through, so a refusal is the route's 400, in its words. The tool shapes only
``accept``'s ``fields`` ({field: value seen} into the route's {field: {seen}}). An autonomous write is the dial's
(shared/ai_writing.py ``require_autonomous_writing``): an ``accept`` is refused 403 unless the minter (and the project's
owner) work AI-driven.

No file upload: a file is added in the app (docs/mcp.md). Voice is the app's alone (a person's browser session).
"""
from __future__ import annotations

from collections.abc import Mapping
from typing import Any, Final

from shared.mcp_global_kit import (
    DOMAIN_PROJECTS,
    ID_SCHEMA,
    PROJECT_ID_SCHEMA,
    GlobalTool,
    InvalidToolArgument,
    RouteRequest,
    id_arg,
    require_project,
    schema,
    stripped,
)

__all__ = ['PRODUCT_TOOLS']

ACTIONS: Final = ('add_url', 'answer', 'extract', 'accept')


def _get(_args: Mapping[str, Any], project: str | None) -> RouteRequest:
    return RouteRequest(DOMAIN_PROJECTS, 'GET', f'/projects/{require_project(project)}/product-proposals/latest')


def _seen(value: object) -> dict[str, Any]:
    """``accept``'s ``fields`` as the route takes them: each ``{field: value seen}`` as ``{field: {seen}}`` (the
    route judges the fields and the values)."""
    if not isinstance(value, Mapping):
        raise InvalidToolArgument('fields must map product fields to the value each was seen at (product_get)')
    return {str(name): {'seen': seen} for name, seen in value.items()}


def _write(args: Mapping[str, Any], project: str | None) -> RouteRequest:
    action, project_id = args.get('action'), require_project(project)
    if action == 'add_url':
        return RouteRequest(DOMAIN_PROJECTS, 'POST', f'/projects/{project_id}/product-docs/urls',
                            body={'url': args.get('url')})
    if action == 'answer':
        return RouteRequest(DOMAIN_PROJECTS, 'POST', f'/projects/{project_id}/product-docs/answers',
                            body={'mode': 'typed', 'answers': args.get('answers')})
    if action == 'extract':
        return RouteRequest(DOMAIN_PROJECTS, 'POST', f'/projects/{project_id}/product-extract', body={})
    if action == 'accept':
        proposal_id = id_arg(args, 'proposal_id')
        return RouteRequest(DOMAIN_PROJECTS, 'POST', f'/projects/{project_id}/product-proposals/{proposal_id}/accept',
                            body={'fields': _seen(args.get('fields'))})
    raise InvalidToolArgument(f"action must be one of: {', '.join(ACTIONS)}")


PRODUCT_TOOLS: Final[tuple[GlobalTool, ...]] = (
    GlobalTool(
        'product_get', 'Get product description',
        "A project's product form, sources and latest extract proposal (values, citations, questions).",
        schema({'project_id': PROJECT_ID_SCHEMA}), _get, stripped, project_scoped=True),
    GlobalTool(
        'product_write', 'Edit product description',
        '`action`: add_url `url`; answer `answers` [{field, question, answer}]; extract, then projects_get_job; '
        'accept `proposal_id`, `fields` {field: value seen}. Confirm with the user first.',
        schema({'project_id': PROJECT_ID_SCHEMA, 'action': {'enum': list(ACTIONS)}, 'url': {'type': 'string'},
                'answers': {'type': 'array'}, 'proposal_id': ID_SCHEMA, 'fields': {'type': 'object'}},
               ('action',)),
        _write, stripped, write=True, project_scoped=True),
)
