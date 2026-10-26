"""The tool catalogue of the GLOBAL MCP server (``api/mcp_global_handler.py``).

Every tool is a thin translation from MCP arguments to ONE route of the domain
Lambda that owns the data (``shared.mcp_delegate``): metrics, settings, memory,
projects or agents. The tool never reads a table itself, so the route's own
validation, category filtering and per-project access rules apply to the call,
evaluated for the token's minter (never admin, capped at editor).

What this module adds on top of the route is only what a bearer credential needs:

* strict argument validation, so caller text never becomes a path segment
  (``is_path_id``) or an unbounded body;
* ``write`` / ``admin_only`` / ``project_scoped`` flags the handler gates on
  (token scope, the admin-minted check for ``run_agent``, the project pin);
* output projections that drop storage keys and signed URLs — a credential
  pasted into a third-party client must not carry pre-signed CDN links out.

``DOMAIN_FUNCTION_ENV`` names the environment variable each domain's function
name arrives in; ``lib/stacks/api-stack-mcp-global.test.ts`` keeps it, every
route below and the role's invoke grant in step with the stack.
"""

from __future__ import annotations

from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from typing import Any, Final

from shared import mcp_global_tokens as gt
from shared.dimension_config import DIMENSION_KEY_RE, MAX_DIMENSIONS, parse_dims_param

DOMAIN_METRICS: Final = 'metrics'
DOMAIN_SETTINGS: Final = 'settings'
DOMAIN_MEMORY: Final = 'memory'
DOMAIN_PROJECTS: Final = 'projects'
DOMAIN_AGENTS: Final = 'agents'

DOMAIN_FUNCTION_ENV: Final[dict[str, str]] = {
    DOMAIN_METRICS: 'METRICS_FUNCTION',
    DOMAIN_SETTINGS: 'SETTINGS_FUNCTION',
    DOMAIN_MEMORY: 'MEMORY_FUNCTION',
    DOMAIN_PROJECTS: 'PROJECTS_FUNCTION',
    DOMAIN_AGENTS: 'AGENTS_FUNCTION',
}

MAX_DAYS: Final = 9999           # shared.api.MAX_FEEDBACK_WINDOW_DAYS; 0 = all time
DEFAULT_DAYS: Final = 30
MAX_LIST_LIMIT: Final = 100
DEFAULT_LIST_LIMIT: Final = 20
MAX_FILTER_LENGTH: Final = 64
MAX_QUERY_LENGTH: Final = 500
MAX_MEMORY_K: Final = 20
DEFAULT_MEMORY_K: Final = 8
MAX_TITLE_LENGTH: Final = 200
MAX_DOCUMENT_CHARS: Final = 200_000
MIN_SEARCH_QUERY_LENGTH: Final = 2  # /feedback/search refuses shorter queries
MAX_RUNS_LIMIT: Final = 50          # agents_handler.MAX_RUNS_PAGE
DEFAULT_RUNS_LIMIT: Final = 5
METRIC_VIEWS: Final[tuple[str, ...]] = ('summary', 'sentiment', 'categories', 'sources', 'personas', 'dimensions')
# Post-query filters every feedback/metrics route takes (docs/dimensions.md); `dims` is serialised.
ITEM_FILTERS: Final[tuple[str, ...]] = ('channel', 'tag')

# Keys never forwarded to an MCP client: storage keys, index keys, and anything
# carrying a signed URL.
_HIDDEN_KEYS: Final = frozenset({'pk', 'sk', 'gsi1pk', 'gsi1sk', 'gsi2pk', 'gsi2sk', 'secret_hash',
                                 'kiro_default_export_prompt', 'kiro_export_prompt'})


class InvalidToolArgument(ValueError):
    """The arguments do not satisfy the tool's contract; a tool error the model can fix."""


@dataclass(frozen=True)
class RouteRequest:
    """The route a tool call becomes, before a function name and claims are attached."""

    domain: str
    method: str
    path: str
    query: dict[str, Any] = field(default_factory=dict)
    body: dict | None = None


def _unchanged(payload: Any, _args: Mapping[str, Any]) -> Any:
    return payload


@dataclass(frozen=True)
class GlobalTool:
    name: str
    title: str
    description: str
    input_schema: dict
    build: Callable[[Mapping[str, Any], str | None], RouteRequest]
    shape: Callable[[Any, Mapping[str, Any]], Any] = _unchanged
    write: bool = False
    admin_only: bool = False
    # Takes a `project_id` argument; a pinned token's pin applies (and defaults it).
    project_scoped: bool = False

    def declaration(self) -> dict:
        """The tool as `tools/list` publishes it."""
        return {
            'name': self.name,
            'title': self.title,
            'description': self.description,
            'inputSchema': self.input_schema,
            'annotations': {
                'title': self.title,
                'readOnlyHint': not self.write,
                'destructiveHint': False,
                'idempotentHint': not self.write,
                'openWorldHint': False,
            },
        }


# ── Argument readers ────────────────────────────────────────────────────────
def _int_arg(args: Mapping[str, Any], name: str, *, default: int, low: int, high: int) -> int:
    value = args.get(name, default)
    if isinstance(value, bool) or not isinstance(value, int) or not low <= value <= high:
        raise InvalidToolArgument(f'{name} must be an integer between {low} and {high}')
    return value


def _text_arg(args: Mapping[str, Any], name: str, *, max_length: int, required: bool = False) -> str | None:
    """A trimmed string argument; absent or blank is None unless ``required``."""
    value = args.get(name)
    if value is not None and not isinstance(value, str):
        raise InvalidToolArgument(f'{name} must be a string')
    text = (value or '').strip()
    if not text:
        if required:
            raise InvalidToolArgument(f'{name} is required')
        return None
    if len(text) > max_length:
        raise InvalidToolArgument(f'{name} must be at most {max_length} characters')
    return text


def _id_arg(args: Mapping[str, Any], name: str) -> str:
    value = args.get(name)
    if not gt.is_path_id(value):
        raise InvalidToolArgument(f'{name} is required and must be an id (letters, digits, _ and -)')
    return str(value)


def _dims_arg(args: Mapping[str, Any]) -> str | None:
    """``dims`` ({key: value}) as the routes' ``key:value,…`` query parameter; empty is None."""
    value = args.get('dims')
    if value is None:
        return None
    if not isinstance(value, Mapping) or not all(isinstance(v, str) for v in value.values()):
        raise InvalidToolArgument('dims must be an object of dimension key to value strings')
    serialised = ','.join(f'{key}:{text.strip()}' for key, text in value.items())
    try:
        parse_dims_param(serialised)
    except ValueError as error:
        raise InvalidToolArgument(str(error)) from error
    return serialised or None


def _item_filters(args: Mapping[str, Any]) -> dict[str, Any]:
    """channel, tag and dims, validated; None values are dropped by the delegate."""
    filters: dict[str, Any] = {name: _text_arg(args, name, max_length=MAX_FILTER_LENGTH) for name in ITEM_FILTERS}
    filters['dims'] = _dims_arg(args)
    return filters


def _require_project(project_id: str | None) -> str:
    if not project_id:
        raise InvalidToolArgument('project_id is required')
    return project_id


def _schema(properties: dict, required: tuple[str, ...] = ()) -> dict:
    schema: dict[str, Any] = {'type': 'object', 'properties': properties, 'additionalProperties': False}
    if required:
        schema['required'] = list(required)
    return schema


_DAYS = {'type': 'integer', 'minimum': 0, 'maximum': MAX_DAYS, 'default': DEFAULT_DAYS,
         'description': 'Look-back window in days; 0 = all time.'}
_LIMIT = {'type': 'integer', 'minimum': 1, 'maximum': MAX_LIST_LIMIT, 'default': DEFAULT_LIST_LIMIT}
_FILTER = {'type': 'string', 'maxLength': MAX_FILTER_LENGTH}
_ITEM_FILTERS = {
    'channel': _FILTER, 'tag': _FILTER,
    'dims': {'type': 'object', 'maxProperties': MAX_DIMENSIONS,
             'propertyNames': {'pattern': DIMENSION_KEY_RE.pattern.replace('\\Z', '$')},
             'additionalProperties': {'type': 'string', 'maxLength': MAX_FILTER_LENGTH},
             'description': 'Dimension filters {key: value} (keys from list_dimensions), all must match.'},
}
_ID = {'type': 'string', 'pattern': '^[A-Za-z0-9_-]{1,128}$'}
_PROJECT_ID = {**_ID, 'description': 'Project id (from list_projects). Optional for a project-scoped token.'}


# ── Projections ─────────────────────────────────────────────────────────────
def _public(row: object) -> dict:
    """A row without storage keys and without any signed URL."""
    if not isinstance(row, Mapping):
        return {}
    return {key: value for key, value in row.items()
            if key not in _HIDDEN_KEYS and 'url' not in key.lower()}


def _items(payload: object, key: str) -> list:
    value = payload.get(key) if isinstance(payload, Mapping) else None
    return value if isinstance(value, list) else []


def _document_summary(document: Mapping[str, Any]) -> dict:
    return {key: document.get(key) for key in
            ('document_id', 'document_type', 'title', 'base_title', 'version', 'created_at', 'updated_at')
            if document.get(key) is not None}


def _project_overview(payload: object, _args: Mapping[str, Any]) -> dict:
    project = payload.get('project') if isinstance(payload, Mapping) else None
    return {
        'project': _public(project),
        'personas': [{'persona_id': p.get('persona_id'), 'name': p.get('name'), 'tagline': p.get('tagline')}
                     for p in _items(payload, 'personas') if isinstance(p, Mapping)],
        'documents': [_document_summary(d) for d in _items(payload, 'documents') if isinstance(d, Mapping)],
    }


def _one_document(payload: object, args: Mapping[str, Any]) -> dict:
    wanted = args.get('document_id')
    for document in _items(payload, 'documents'):
        if isinstance(document, Mapping) and document.get('document_id') == wanted:
            return {'document': _public(document)}
    raise InvalidToolArgument(f'document {wanted} is not in this project')


def _project_list(payload: object, _args: Mapping[str, Any]) -> dict:
    projects = [_public(p) for p in _items(payload, 'projects') if isinstance(p, Mapping)]
    return {'count': len(projects), 'projects': projects}


def _public_value(value: object) -> object:
    """A list of rows loses its rows' hidden keys; anything else passes through."""
    if isinstance(value, list) and all(isinstance(v, Mapping) for v in value):
        return [_public(v) for v in value]
    return value


def _stripped(payload: object, _args: Mapping[str, Any]) -> object:
    """The route body without hidden keys, one level of row lists deep."""
    if not isinstance(payload, Mapping):
        return payload
    return {key: _public_value(value) for key, value in _public(payload).items()}


# ── Builders ────────────────────────────────────────────────────────────────
def _search_feedback(args: Mapping[str, Any], _project: str | None) -> RouteRequest:
    query = _text_arg(args, 'query', max_length=MAX_QUERY_LENGTH)
    filters: dict[str, Any] = {
        'days': _int_arg(args, 'days', default=DEFAULT_DAYS, low=0, high=MAX_DAYS),
        'limit': _int_arg(args, 'limit', default=DEFAULT_LIST_LIMIT, low=1, high=MAX_LIST_LIMIT),
    }
    for name in ('category', 'sentiment', 'source'):
        filters[name] = _text_arg(args, name, max_length=MAX_FILTER_LENGTH)
    filters.update(_item_filters(args))
    if query and len(query) >= MIN_SEARCH_QUERY_LENGTH:
        return RouteRequest(DOMAIN_METRICS, 'GET', '/feedback/search', query={'q': query, **filters})
    return RouteRequest(DOMAIN_METRICS, 'GET', '/feedback', query=filters)


def _get_feedback(args: Mapping[str, Any], _project: str | None) -> RouteRequest:
    return RouteRequest(DOMAIN_METRICS, 'GET', f"/feedback/{_id_arg(args, 'feedback_id')}")


def _get_metrics(args: Mapping[str, Any], _project: str | None) -> RouteRequest:
    view = args.get('view', 'summary')
    if view not in METRIC_VIEWS:
        raise InvalidToolArgument(f'view must be one of: {", ".join(METRIC_VIEWS)}')
    query: dict[str, Any] = {'days': _int_arg(args, 'days', default=DEFAULT_DAYS, low=0, high=MAX_DAYS),
                             'source': _text_arg(args, 'source', max_length=MAX_FILTER_LENGTH),
                             **_item_filters(args)}
    if view == 'dimensions':
        key = _text_arg(args, 'key', max_length=MAX_FILTER_LENGTH, required=True)
        if not DIMENSION_KEY_RE.match(key or ''):
            raise InvalidToolArgument('key must be a dimension key (from list_dimensions)')
        query['key'] = key
    return RouteRequest(DOMAIN_METRICS, 'GET', f'/metrics/{view}', query=query)


def _list_categories(_args: Mapping[str, Any], _project: str | None) -> RouteRequest:
    return RouteRequest(DOMAIN_SETTINGS, 'GET', '/settings/categories')


def _list_dimensions(_args: Mapping[str, Any], _project: str | None) -> RouteRequest:
    return RouteRequest(DOMAIN_SETTINGS, 'GET', '/settings/dimensions')


def _company_context(_args: Mapping[str, Any], _project: str | None) -> RouteRequest:
    return RouteRequest(DOMAIN_SETTINGS, 'GET', '/settings/company-context')


def _search_memory(args: Mapping[str, Any], _project: str | None) -> RouteRequest:
    query = _text_arg(args, 'query', max_length=MAX_QUERY_LENGTH, required=True)
    k = _int_arg(args, 'k', default=DEFAULT_MEMORY_K, low=1, high=MAX_MEMORY_K)
    return RouteRequest(DOMAIN_MEMORY, 'POST', '/memory/retrieve', body={'query': query, 'k': k})


def _list_projects(_args: Mapping[str, Any], _project: str | None) -> RouteRequest:
    return RouteRequest(DOMAIN_PROJECTS, 'GET', '/projects')


def _get_project(_args: Mapping[str, Any], project: str | None) -> RouteRequest:
    return RouteRequest(DOMAIN_PROJECTS, 'GET', f'/projects/{_require_project(project)}')


def _get_document(args: Mapping[str, Any], project: str | None) -> RouteRequest:
    _id_arg(args, 'document_id')
    return _get_project(args, project)


def _create_document(args: Mapping[str, Any], project: str | None) -> RouteRequest:
    body = {
        'document_type': 'custom',
        'title': _text_arg(args, 'title', max_length=MAX_TITLE_LENGTH, required=True),
        'content': _text_arg(args, 'content', max_length=MAX_DOCUMENT_CHARS, required=True),
    }
    return RouteRequest(DOMAIN_PROJECTS, 'POST', f'/projects/{_require_project(project)}/documents', body=body)


def _update_document(args: Mapping[str, Any], project: str | None) -> RouteRequest:
    document_id = _id_arg(args, 'document_id')
    body = {name: value for name, value in (
        ('title', _text_arg(args, 'title', max_length=MAX_TITLE_LENGTH)),
        ('content', _text_arg(args, 'content', max_length=MAX_DOCUMENT_CHARS)),
    ) if value is not None}
    if not body:
        raise InvalidToolArgument('give a new title, new content, or both')
    return RouteRequest(DOMAIN_PROJECTS, 'PUT', f'/projects/{_require_project(project)}/documents/{document_id}',
                        body=body)


def _list_agents(_args: Mapping[str, Any], _project: str | None) -> RouteRequest:
    return RouteRequest(DOMAIN_AGENTS, 'GET', '/agents')


def _get_agent_run(args: Mapping[str, Any], _project: str | None) -> RouteRequest:
    """One run by ``run_id``; without it, the agent's newest runs (so a caller can find the latest)."""
    agent_id = _id_arg(args, 'agent_id')
    if args.get('run_id') in (None, ''):
        limit = _int_arg(args, 'limit', default=DEFAULT_RUNS_LIMIT, low=1, high=MAX_RUNS_LIMIT)
        return RouteRequest(DOMAIN_AGENTS, 'GET', f'/agents/{agent_id}/runs', query={'limit': limit})
    return RouteRequest(DOMAIN_AGENTS, 'GET', f"/agents/{agent_id}/runs/{_id_arg(args, 'run_id')}")


def _run_agent(args: Mapping[str, Any], _project: str | None) -> RouteRequest:
    return RouteRequest(DOMAIN_AGENTS, 'POST', f"/agents/{_id_arg(args, 'agent_id')}/run")


# ── Catalogue ───────────────────────────────────────────────────────────────
TOOLS: Final[tuple[GlobalTool, ...]] = (
    GlobalTool(
        'search_feedback', 'Search feedback',
        'Search or list customer feedback (reviews, form submissions, imports) you can see. Give `query` '
        '(2+ characters) for a text search, or only filters to list the newest items. Returns verbatims '
        'with sentiment, category and urgency. Use it to ground any claim about what customers say.',
        _schema({'query': {'type': 'string', 'maxLength': MAX_QUERY_LENGTH}, 'days': _DAYS, 'limit': _LIMIT,
                 'category': _FILTER, 'sentiment': _FILTER, 'source': _FILTER, **_ITEM_FILTERS}),
        _search_feedback, _stripped),
    GlobalTool(
        'get_feedback', 'Get one feedback item',
        'One feedback item in full, by `feedback_id` (from search_feedback).',
        _schema({'feedback_id': _ID}, ('feedback_id',)), _get_feedback, _stripped),
    GlobalTool(
        'get_metrics', 'Get feedback metrics',
        'Aggregated metrics over a window: `view` = summary (totals, average sentiment, urgent count, '
        'daily series) or a breakdown by sentiment, categories, sources, personas or one dimension '
        '(`dimensions` + `key`); every view takes the source / channel / tag / dims filters. '
        'Use it for trends and volumes instead of counting search results.',
        _schema({'view': {'type': 'string', 'enum': list(METRIC_VIEWS), 'default': 'summary'}, 'days': _DAYS,
                 'key': _FILTER, 'source': _FILTER, **_ITEM_FILTERS}),
        _get_metrics),
    GlobalTool(
        'list_categories', 'List categories',
        'The feedback category taxonomy you have access to (name, description, product, subcategories).',
        _schema({}), _list_categories),
    GlobalTool(
        'list_dimensions', 'List dimensions',
        'The feedback dimensions (product, module, user type, ...): key, label and allowed values, for '
        'the `dims` filter and the dimensions metric view.',
        _schema({}), _list_dimensions),
    GlobalTool(
        'search_memory', 'Search memory',
        'Semantic search over company memory and your personal memory (decisions, facts, preferences '
        'the team has recorded), filtered to the categories you can see. Use it before proposing '
        'something the team may already have decided.',
        _schema({'query': {'type': 'string', 'maxLength': MAX_QUERY_LENGTH},
                 'k': {'type': 'integer', 'minimum': 1, 'maximum': MAX_MEMORY_K, 'default': DEFAULT_MEMORY_K}}, ('query',)),
        _search_memory),
    GlobalTool(
        'get_company_context', 'Get company context',
        'The company vision and objectives every product decision should align with.',
        _schema({}), _company_context),
    GlobalTool(
        'list_projects', 'List projects',
        'Research projects you can see (a project-scoped token sees only its project).',
        _schema({}), _list_projects, _project_list),
    GlobalTool(
        'get_project', 'Get a project',
        'A project with its personas and the list of its documents (PRDs, PR/FAQs, research, custom '
        'documents) — titles and ids only; read a body with get_document.',
        _schema({'project_id': _PROJECT_ID}), _get_project, _project_overview, project_scoped=True),
    GlobalTool(
        'get_document', 'Get a document',
        'One project document in full, by `document_id` (from get_project).',
        _schema({'project_id': _PROJECT_ID, 'document_id': _ID}, ('document_id',)),
        _get_document, _one_document, project_scoped=True),
    GlobalTool(
        'list_agents', 'List autonomous agents',
        'Autonomous agents (review → PR/FAQ → prototype crews) you can see, with their status.',
        _schema({}), _list_agents, _stripped),
    GlobalTool(
        'get_agent_run', 'Get agent runs',
        "An agent's run by `run_id` (status, current step, project, error), or without `run_id` its newest "
        'runs. Use it to follow a run started with run_agent; read its output with get_project.',
        _schema({'agent_id': _ID, 'run_id': _ID,
                 'limit': {'type': 'integer', 'minimum': 1, 'maximum': MAX_RUNS_LIMIT,
                           'default': DEFAULT_RUNS_LIMIT}}, ('agent_id',)),
        _get_agent_run, _stripped),
    GlobalTool(
        'create_document', 'Create a project document',
        'Create a custom markdown document in a project you can edit. Requires a write token. Write '
        'only what the user asked for; cite feedback ids for claims about customers.',
        _schema({'project_id': _PROJECT_ID, 'title': {'type': 'string', 'maxLength': MAX_TITLE_LENGTH},
                 'content': {'type': 'string', 'maxLength': MAX_DOCUMENT_CHARS}}, ('title', 'content')),
        _create_document, _stripped, write=True, project_scoped=True),
    GlobalTool(
        'update_document', 'Update a project document',
        "Replace a document's title and/or content in a project you can edit. Requires a write token. "
        'Managed PRD / PR/FAQ titles cannot change series, and prototype bodies cannot be edited here.',
        _schema({'project_id': _PROJECT_ID, 'document_id': _ID,
                 'title': {'type': 'string', 'maxLength': MAX_TITLE_LENGTH},
                 'content': {'type': 'string', 'maxLength': MAX_DOCUMENT_CHARS}}, ('document_id',)),
        _update_document, _stripped, write=True, project_scoped=True),
    GlobalTool(
        'run_agent', 'Run an autonomous agent',
        'Start a run of an autonomous agent now (from list_agents). Only for write tokens minted by an '
        'administrator who is still an administrator; returns the queued run. Confirm with the user '
        'first — a run spends model budget and creates or updates projects.',
        _schema({'agent_id': _ID}, ('agent_id',)), _run_agent, _stripped, write=True, admin_only=True),
)

TOOLS_BY_NAME: Final[dict[str, GlobalTool]] = {tool.name: tool for tool in TOOLS}
