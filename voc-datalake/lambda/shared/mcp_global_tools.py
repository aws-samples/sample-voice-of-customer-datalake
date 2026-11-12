"""The tool catalogue of the GLOBAL MCP server (``api/mcp_global_handler.py``).

Every tool is a thin translation from MCP arguments to ONE route of the domain
Lambda that owns the data (``shared.mcp_delegate``): metrics, settings, memory,
projects, agents, engagement (the feedback boards), radar, feedback edits or integrations (source status). The tool never reads a table itself, so the route's own
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

from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any, Final

from shared.dimension_config import DIMENSION_KEY_RE, MAX_DIMENSIONS, parse_dims_param
from shared.engineering_agents import engineering_agents_on
from shared.mcp_global_kit import (
    BOOL_SCHEMA,
    DOMAIN_AGENTS,
    DOMAIN_ENGAGEMENT,
    DOMAIN_FEEDBACK_EDIT,
    DOMAIN_INTEGRATIONS,
    DOMAIN_MEMORY,
    DOMAIN_METRICS,
    DOMAIN_PROJECTS,
    DOMAIN_RADAR,
    DOMAIN_SETTINGS,
    ID_SCHEMA,
    PROJECT_ID_SCHEMA,
    FollowUp,
    GlobalTool,
    InvalidToolArgument,
    RouteRequest,
    bool_arg,
    id_arg,
    int_arg,
    public,
    require_project,
    rows_at,
    schema,
    stripped,
    text_arg,
)
from shared.mcp_global_tools_steps import STEP_TOOLS
from shared.mcp_global_tools_work import WORK_TOOLS

DOMAIN_FUNCTION_ENV: Final[dict[str, str]] = {
    DOMAIN_METRICS: 'METRICS_FUNCTION',
    DOMAIN_SETTINGS: 'SETTINGS_FUNCTION',
    DOMAIN_MEMORY: 'MEMORY_FUNCTION',
    DOMAIN_PROJECTS: 'PROJECTS_FUNCTION',
    DOMAIN_AGENTS: 'AGENTS_FUNCTION',
    DOMAIN_ENGAGEMENT: 'ENGAGEMENT_FUNCTION',
    DOMAIN_RADAR: 'RADAR_FUNCTION',
    DOMAIN_FEEDBACK_EDIT: 'FEEDBACK_EDIT_FUNCTION',
    DOMAIN_INTEGRATIONS: 'INTEGRATIONS_FUNCTION',
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
#: An engineering run's views (agents_handler's /agents/engineering/<run_id>/... routes); the board is the default.
ENGINEERING_VIEWS: Final[tuple[str, ...]] = ('board', 'conversation', 'reports', 'report')
REPORT_LEVELS: Final[tuple[str, ...]] = ('commit', 'pr', 'goal')
MAX_CONVERSATION_LIMIT: Final = 200  # agents_handler.MAX_EVENTS_PAGE
MAX_CONVERSATION_SEQ: Final = 99_999_998  # the conversation's seq is 8 digits (engineering/conversation/store.py)
DEFAULT_CONVERSATION_LIMIT: Final = 50
MAX_REPORT_VERSION: Final = 9999
METRIC_VIEWS: Final[tuple[str, ...]] = ('summary', 'sentiment', 'categories', 'sources', 'personas', 'dimensions',
                                         'github', 'entities')
# The views a route other than `/metrics/{view}` serves: the filter values with their counts.
_VIEW_PATHS: Final[dict[str, str]] = {'entities': '/feedback/entities'}
# `get_feedback include_similar`: at most this many neighbours, each with a bounded text.
MAX_SIMILAR: Final = 5
MAX_SIMILAR_TEXT_CHARS: Final = 500
_SIMILAR_FIELDS: Final[tuple[str, ...]] = ('feedback_id', 'source_platform', 'source_created_at', 'category',
                                           'sentiment_label', 'urgency', 'rating', 'title', 'problem_summary')
# Post-query filters every feedback/metrics route takes (docs/dimensions.md); `dims` is serialised.
ITEM_FILTERS: Final[tuple[str, ...]] = ('channel', 'tag')
# `search_feature_requests` (GET /feature-requests/search): the slim item, a page of at most 50, a window of
# at most 3650 days (0 = all time), board / category / status as comma lists.
FEATURE_REQUEST_FIELDS: Final[tuple[str, ...]] = ('request_id', 'board_id', 'title', 'description', 'status',
                                                  'supporters', 'category', 'sentiment', 'problem_summary',
                                                  'created_at')
FEATURE_REQUEST_FILTERS: Final[tuple[str, ...]] = ('board', 'category', 'status')
MAX_FEATURE_REQUEST_LIMIT: Final = 50
DEFAULT_FEATURE_REQUEST_LIMIT: Final = 25
MAX_FEATURE_REQUEST_DAYS: Final = 3650
MAX_FEATURE_REQUEST_FILTER_LENGTH: Final = 500
MAX_FEATURE_REQUEST_TEXT_CHARS: Final = 1000

# ── Argument readers ────────────────────────────────────────────────────────
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
    filters: dict[str, Any] = {name: text_arg(args, name, max_length=MAX_FILTER_LENGTH) for name in ITEM_FILTERS}
    filters['dims'] = _dims_arg(args)
    return filters


_DAYS = {'type': 'integer', 'minimum': 0, 'maximum': MAX_DAYS, 'default': DEFAULT_DAYS,
         'description': 'Days back; 0 = all time.'}
_LIMIT = {'type': 'integer', 'minimum': 1, 'maximum': MAX_LIST_LIMIT, 'default': DEFAULT_LIST_LIMIT}
_FILTER = {'type': 'string', 'maxLength': MAX_FILTER_LENGTH}
_ITEM_FILTERS = {
    'channel': _FILTER, 'tag': _FILTER,
    'dims': {'type': 'object', 'maxProperties': MAX_DIMENSIONS,
             'propertyNames': {'pattern': DIMENSION_KEY_RE.pattern.replace('\\Z', '$')},
             'additionalProperties': {'type': 'string', 'maxLength': MAX_FILTER_LENGTH},
             'description': 'All must match.'},
}
# ── Projections ─────────────────────────────────────────────────────────────
def _document_summary(document: Mapping[str, Any]) -> dict:
    return {key: document.get(key) for key in
            ('document_id', 'document_type', 'title', 'base_title', 'version', 'created_at', 'updated_at')
            if document.get(key) is not None}


def _project_overview(payload: object, _args: Mapping[str, Any]) -> dict:
    project = payload.get('project') if isinstance(payload, Mapping) else None
    return {
        'project': public(project),
        'personas': [{'persona_id': p.get('persona_id'), 'name': p.get('name'), 'tagline': p.get('tagline')}
                     for p in rows_at(payload, 'personas') if isinstance(p, Mapping)],
        'documents': [_document_summary(d) for d in rows_at(payload, 'documents') if isinstance(d, Mapping)],
    }


def _one_document(payload: object, args: Mapping[str, Any]) -> dict:
    wanted = args.get('document_id')
    for document in rows_at(payload, 'documents'):
        if isinstance(document, Mapping) and document.get('document_id') == wanted:
            return {'document': public(document)}
    raise InvalidToolArgument(f'document {wanted} is not in this project')


def _project_list(payload: object, _args: Mapping[str, Any]) -> dict:
    projects = [public(p) for p in rows_at(payload, 'projects') if isinstance(p, Mapping)]
    return {'count': len(projects), 'projects': projects}


def _feature_requests(payload: object, args: Mapping[str, Any]) -> object:
    """The search answer as slim items only: no field added upstream reaches the client unreviewed.

    ``boards: true`` answered the board list instead: its rows without storage keys.
    """
    if args.get('boards') is True:
        return stripped(payload, args)
    items = []
    for row in rows_at(payload, 'items'):
        if not isinstance(row, Mapping):
            continue
        item = {key: row[key] for key in FEATURE_REQUEST_FIELDS if row.get(key) is not None}
        for key in ('title', 'description', 'problem_summary'):
            if isinstance(item.get(key), str):
                item[key] = item[key][:MAX_FEATURE_REQUEST_TEXT_CHARS]
        items.append(item)
    total = payload.get('total') if isinstance(payload, Mapping) else None
    truncated = payload.get('truncated') if isinstance(payload, Mapping) else None
    return {'count': len(items), 'total': total if isinstance(total, int) and not isinstance(total, bool) else len(items),
            'truncated': truncated is True, 'items': items}


# ── Board-route claims ──────────────────────────────────────────────────────
# The board routes (shared/engagement_identity.board_viewer) read the caller's pool from the verified
# `iss` claim and need a verified email. A global token's minter is always an APP-pool user: tokens are
# minted at /connect/tokens behind the app-pool authorizer, and the minter is re-checked in that pool
# (USER_POOL_ID) on every call. So the issuer is THIS function's own app pool, from its environment —
# never the request, and never the board pool, which therefore cannot be claimed through MCP. The email
# and name are the MINTER's, read from Cognito on this call (a verified email only): a request or +1 made
# over MCP is the person's, exactly as if they posted it in the app, so one person supports a request once
# however many tokens they hold. The subject stays the credential (`mcp:<token_id>`), so the token is still
# traceable. An app-pool caller's board scope never depends on its email (every non-archived board), and
# `cognito:groups` stays empty: never admin.


@dataclass(frozen=True)
class MinterIdentity:
    """The token minter's verified email and display name, as Cognito holds them now."""

    email: str
    name: str


def app_pool_issuer(pool_id: str) -> str | None:
    """The Cognito issuer of ``pool_id`` (``<region>_<id>``), or None when it is not a pool id."""
    region, sep, rest = pool_id.partition('_')
    if not sep or not region or not rest:
        return None
    return f'https://cognito-idp.{region}.amazonaws.com/{pool_id}'


def board_route_claims(claims: Mapping[str, str], minter: MinterIdentity | None, pool_id: str) -> dict[str, str]:
    """``claims`` plus the app-pool issuer and the minter's verified email and name; unchanged when either the
    issuer or the minter is unknown.

    Fail closed: without them the board route refuses the call (403), it never widens it.
    """
    issuer = app_pool_issuer(pool_id)
    if issuer is None or minter is None:
        return dict(claims)
    return {**claims, 'iss': issuer, 'email': minter.email, 'name': minter.name, 'email_verified': 'true'}


# ── Builders ────────────────────────────────────────────────────────────────
def _search_feedback(args: Mapping[str, Any], _project: str | None) -> RouteRequest:
    query = text_arg(args, 'query', max_length=MAX_QUERY_LENGTH)
    filters: dict[str, Any] = {
        'days': int_arg(args, 'days', default=DEFAULT_DAYS, low=0, high=MAX_DAYS),
        'limit': int_arg(args, 'limit', default=DEFAULT_LIST_LIMIT, low=1, high=MAX_LIST_LIMIT),
    }
    for name in ('category', 'sentiment', 'source'):
        filters[name] = text_arg(args, name, max_length=MAX_FILTER_LENGTH)
    filters.update(_item_filters(args))
    # shared/item_filters.py: `urgent=1` keeps only high-urgency items, on both routes, with every other filter.
    filters['urgent'] = '1' if bool_arg(args, 'urgent') else None
    if query and len(query) >= MIN_SEARCH_QUERY_LENGTH:
        return RouteRequest(DOMAIN_METRICS, 'GET', '/feedback/search', query={'q': query, **filters})
    return RouteRequest(DOMAIN_METRICS, 'GET', '/feedback', query=filters)


def _get_feedback(args: Mapping[str, Any], _project: str | None) -> RouteRequest:
    bool_arg(args, 'include_similar')
    return RouteRequest(DOMAIN_METRICS, 'GET', f"/feedback/{id_arg(args, 'feedback_id')}")


def _slim_similar(payload: object) -> list[dict]:
    """``/feedback/{id}/similar`` as at most ``MAX_SIMILAR`` slim rows with a bounded ``text``."""
    rows = []
    for item in [i for i in rows_at(payload, 'items') if isinstance(i, Mapping)][:MAX_SIMILAR]:
        row = {key: item[key] for key in _SIMILAR_FIELDS if item.get(key) is not None}
        text = item.get('original_text')
        if isinstance(text, str):
            row['text'] = text[:MAX_SIMILAR_TEXT_CHARS]
        rows.append(row)
    return rows


def _similar_follow_up(args: Mapping[str, Any]) -> tuple[FollowUp, ...]:
    if args.get('include_similar') is not True:
        return ()
    request = RouteRequest(DOMAIN_METRICS, 'GET', f"/feedback/{id_arg(args, 'feedback_id')}/similar",
                           query={'limit': MAX_SIMILAR})
    return (FollowUp('similar', request, _slim_similar),)


def _get_metrics(args: Mapping[str, Any], _project: str | None) -> RouteRequest:
    view = args.get('view', 'summary')
    if view not in METRIC_VIEWS:
        raise InvalidToolArgument(f'view must be one of: {", ".join(METRIC_VIEWS)}')
    query: dict[str, Any] = {'days': int_arg(args, 'days', default=DEFAULT_DAYS, low=0, high=MAX_DAYS),
                             'source': text_arg(args, 'source', max_length=MAX_FILTER_LENGTH),
                             **_item_filters(args)}
    if view == 'dimensions':
        key = text_arg(args, 'key', max_length=MAX_FILTER_LENGTH, required=True)
        if not DIMENSION_KEY_RE.match(key or ''):
            raise InvalidToolArgument('key must be a dimension key (from list_dimensions)')
        query['key'] = key
    return RouteRequest(DOMAIN_METRICS, 'GET', _VIEW_PATHS.get(view, f'/metrics/{view}'), query=query)


def _list_categories(_args: Mapping[str, Any], _project: str | None) -> RouteRequest:
    return RouteRequest(DOMAIN_SETTINGS, 'GET', '/settings/categories')


def _list_dimensions(_args: Mapping[str, Any], _project: str | None) -> RouteRequest:
    return RouteRequest(DOMAIN_SETTINGS, 'GET', '/settings/dimensions')


def _company_context(_args: Mapping[str, Any], _project: str | None) -> RouteRequest:
    return RouteRequest(DOMAIN_SETTINGS, 'GET', '/settings/company-context')


def _search_memory(args: Mapping[str, Any], _project: str | None) -> RouteRequest:
    query = text_arg(args, 'query', max_length=MAX_QUERY_LENGTH, required=True)
    k = int_arg(args, 'k', default=DEFAULT_MEMORY_K, low=1, high=MAX_MEMORY_K)
    return RouteRequest(DOMAIN_MEMORY, 'POST', '/memory/retrieve', body={'query': query, 'k': k})


def _list_projects(_args: Mapping[str, Any], _project: str | None) -> RouteRequest:
    return RouteRequest(DOMAIN_PROJECTS, 'GET', '/projects')


def _get_project(_args: Mapping[str, Any], project: str | None) -> RouteRequest:
    return RouteRequest(DOMAIN_PROJECTS, 'GET', f'/projects/{require_project(project)}')


def _get_document(args: Mapping[str, Any], project: str | None) -> RouteRequest:
    id_arg(args, 'document_id')
    return _get_project(args, project)


def _create_document(args: Mapping[str, Any], project: str | None) -> RouteRequest:
    body = {
        'document_type': 'custom',
        'title': text_arg(args, 'title', max_length=MAX_TITLE_LENGTH, required=True),
        'content': text_arg(args, 'content', max_length=MAX_DOCUMENT_CHARS, required=True),
    }
    return RouteRequest(DOMAIN_PROJECTS, 'POST', f'/projects/{require_project(project)}/documents', body=body)


def _update_document(args: Mapping[str, Any], project: str | None) -> RouteRequest:
    document_id = id_arg(args, 'document_id')
    body = {name: value for name, value in (
        ('title', text_arg(args, 'title', max_length=MAX_TITLE_LENGTH)),
        ('content', text_arg(args, 'content', max_length=MAX_DOCUMENT_CHARS)),
    ) if value is not None}
    if not body:
        raise InvalidToolArgument('give a new title, new content, or both')
    return RouteRequest(DOMAIN_PROJECTS, 'PUT', f'/projects/{require_project(project)}/documents/{document_id}',
                        body=body)


def _list_agents(_args: Mapping[str, Any], _project: str | None) -> RouteRequest:
    return RouteRequest(DOMAIN_AGENTS, 'GET', '/agents')


def _get_agent_run(args: Mapping[str, Any], _project: str | None) -> RouteRequest:
    """One run by ``run_id``; without it, the agent's newest runs (so a caller can find the latest)."""
    agent_id = id_arg(args, 'agent_id')
    if args.get('run_id') in (None, ''):
        limit = int_arg(args, 'limit', default=DEFAULT_RUNS_LIMIT, low=1, high=MAX_RUNS_LIMIT)
        return RouteRequest(DOMAIN_AGENTS, 'GET', f'/agents/{agent_id}/runs', query={'limit': limit})
    return RouteRequest(DOMAIN_AGENTS, 'GET', f"/agents/{agent_id}/runs/{id_arg(args, 'run_id')}")


def _get_engineering_run(args: Mapping[str, Any], _project: str | None) -> RouteRequest:
    """An engineering run's board (the default), a page of its conversation, its reports, or one report."""
    run_id = id_arg(args, 'run_id')
    view = args.get('view', 'board')
    if view == 'conversation':
        query = {'after': int_arg(args, 'after', default=0, low=0, high=MAX_CONVERSATION_SEQ),
                 'limit': int_arg(args, 'limit', default=DEFAULT_CONVERSATION_LIMIT, low=1,
                                  high=MAX_CONVERSATION_LIMIT)}
        return RouteRequest(DOMAIN_AGENTS, 'GET', f'/agents/engineering/{run_id}/conversation', query=query)
    if view == 'reports':
        return RouteRequest(DOMAIN_AGENTS, 'GET', f'/agents/engineering/{run_id}/reports')
    if view == 'report':
        level = args.get('level')
        if level not in REPORT_LEVELS:
            raise InvalidToolArgument(f'level is one of {", ".join(REPORT_LEVELS)} for view report')
        subject = id_arg(args, 'subject')
        version = {} if args.get('version') is None else {
            'version': int_arg(args, 'version', default=1, low=1, high=MAX_REPORT_VERSION)}
        return RouteRequest(DOMAIN_AGENTS, 'GET', f'/agents/engineering/{run_id}/reports/{level}/{subject}',
                            query=version)
    if view != 'board':
        raise InvalidToolArgument(f'view is one of {", ".join(ENGINEERING_VIEWS)}')
    return RouteRequest(DOMAIN_AGENTS, 'GET', f'/agents/engineering/{run_id}/board')


def _search_feature_requests(args: Mapping[str, Any], _project: str | None) -> RouteRequest:
    if bool_arg(args, 'boards'):
        # The boards the minter can see (GET /feature-requests/boards), folded in to keep tools/list small.
        return RouteRequest(DOMAIN_ENGAGEMENT, 'GET', '/feature-requests/boards')
    query: dict[str, Any] = {
        'q': text_arg(args, 'query', max_length=MAX_QUERY_LENGTH),
        'limit': int_arg(args, 'limit', default=DEFAULT_FEATURE_REQUEST_LIMIT, low=1, high=MAX_FEATURE_REQUEST_LIMIT),
    }
    for name in FEATURE_REQUEST_FILTERS:
        query[name] = text_arg(args, name, max_length=MAX_FEATURE_REQUEST_FILTER_LENGTH)
    days = int_arg(args, 'days', default=0, low=0, high=MAX_FEATURE_REQUEST_DAYS)
    query['days'] = days or None  # 0 = all time: no window sent
    return RouteRequest(DOMAIN_ENGAGEMENT, 'GET', '/feature-requests/search', query=query)


def _run_agent(args: Mapping[str, Any], _project: str | None) -> RouteRequest:
    return RouteRequest(DOMAIN_AGENTS, 'POST', f"/agents/{id_arg(args, 'agent_id')}/run")


# ── Catalogue ───────────────────────────────────────────────────────────────
TOOLS: Final[tuple[GlobalTool, ...]] = (
    GlobalTool(
        'search_feedback', 'Search feedback',
        'Search (`query`, 2+ characters) or list the newest customer feedback you can see; `urgent: true` keeps '
        'high urgency only. Ground claims about customers here.',
        schema({'query': {'type': 'string', 'maxLength': MAX_QUERY_LENGTH}, 'days': _DAYS, 'limit': _LIMIT,
                 'category': _FILTER, 'sentiment': _FILTER, 'source': _FILTER, 'urgent': BOOL_SCHEMA, **_ITEM_FILTERS}),
        _search_feedback, stripped),
    GlobalTool(
        'get_feedback', 'Get one feedback item',
        f'One feedback item by `feedback_id`; `include_similar: true` adds up to {MAX_SIMILAR} similar items.',
        schema({'feedback_id': ID_SCHEMA, 'include_similar': BOOL_SCHEMA}, ('feedback_id',)), _get_feedback, stripped,
        follow_ups=_similar_follow_up),
    GlobalTool(
        'get_metrics', 'Get feedback metrics',
        'Metrics over a window. `view`: summary, sentiment, categories, sources, personas, dimensions (+ `key`), '
        'github (issues per release and label) or entities (filter values with counts).',
        schema({'view': {'type': 'string', 'enum': list(METRIC_VIEWS), 'default': 'summary'}, 'days': _DAYS,
                 'key': _FILTER, 'source': _FILTER, **_ITEM_FILTERS}),
        _get_metrics),
    GlobalTool(
        'list_categories', 'List categories',
        'Categories you can see, with subcategories.',
        schema({}), _list_categories),
    GlobalTool(
        'list_dimensions', 'List dimensions',
        'Dimensions (key, label, values) for `dims`.',
        schema({}), _list_dimensions),
    GlobalTool(
        'search_memory', 'Search memory',
        'Semantic search over company and personal memory (decisions, facts, preferences) you can see.',
        schema({'query': {'type': 'string', 'maxLength': MAX_QUERY_LENGTH},
                 'k': {'type': 'integer', 'minimum': 1, 'maximum': MAX_MEMORY_K, 'default': DEFAULT_MEMORY_K}}, ('query',)),
        _search_memory),
    GlobalTool(
        'get_company_context', 'Get company context',
        'The company vision and objectives.',
        schema({}), _company_context),
    GlobalTool(
        'list_projects', 'List projects',
        'Projects you can see.',
        schema({}), _list_projects, _project_list),
    GlobalTool(
        'get_project', 'Get a project',
        'A project: its personas and documents (bodies via get_document).',
        schema({'project_id': PROJECT_ID_SCHEMA}), _get_project, _project_overview, project_scoped=True),
    GlobalTool(
        'get_document', 'Get a document',
        'One project document in full, by `document_id`.',
        schema({'project_id': PROJECT_ID_SCHEMA, 'document_id': ID_SCHEMA}, ('document_id',)),
        _get_document, _one_document, project_scoped=True),
    GlobalTool(
        'list_agents', 'List agents',
        'Agents you can see, with their status.',
        schema({}), _list_agents, stripped),
    GlobalTool(
        'get_agent_run', 'Get agent runs',
        "An agent's run by `run_id`, or its newest runs.",
        schema({'agent_id': ID_SCHEMA, 'run_id': ID_SCHEMA,
                 'limit': {'type': 'integer', 'minimum': 1, 'maximum': MAX_RUNS_LIMIT,
                           'default': DEFAULT_RUNS_LIMIT}}, ('agent_id',)),
        _get_agent_run, stripped),
    GlobalTool(
        'search_feature_requests', 'Search board requests',
        'Search feedback-board requests you can see (NOT reviews: never in feedback metrics); cite as '
        '[FR:<request_id>]. `board`, `category`, `status`: comma lists. `boards: true` lists the boards.',
        schema({'query': {'type': 'string', 'maxLength': MAX_QUERY_LENGTH},
                 'board': {'type': 'string', 'maxLength': MAX_FEATURE_REQUEST_FILTER_LENGTH,
                           'description': 'Board id or slug.'},
                 'category': {'type': 'string', 'maxLength': MAX_FEATURE_REQUEST_FILTER_LENGTH},
                 'status': {'type': 'string', 'maxLength': MAX_FEATURE_REQUEST_FILTER_LENGTH},
                 'days': {'type': 'integer', 'minimum': 0, 'maximum': MAX_FEATURE_REQUEST_DAYS, 'default': 0,
                          'description': 'Created in the last N days; 0 = all time.'},
                 'limit': {'type': 'integer', 'minimum': 1, 'maximum': MAX_FEATURE_REQUEST_LIMIT,
                           'default': DEFAULT_FEATURE_REQUEST_LIMIT},
                 'boards': BOOL_SCHEMA}),
        _search_feature_requests, _feature_requests, board_route=True),
    GlobalTool(
        'create_document', 'Create a document',
        'Create a custom markdown document in a project you can edit (write token). Cite feedback ids for claims.',
        schema({'project_id': PROJECT_ID_SCHEMA, 'title': {'type': 'string', 'maxLength': MAX_TITLE_LENGTH},
                 'content': {'type': 'string', 'maxLength': MAX_DOCUMENT_CHARS}}, ('title', 'content')),
        _create_document, stripped, write=True, project_scoped=True),
    GlobalTool(
        'update_document', 'Update a document',
        "Replace a document's title and/or content (write token). PRD / PR/FAQ titles keep their series; "
        'not prototypes.',
        schema({'project_id': PROJECT_ID_SCHEMA, 'document_id': ID_SCHEMA,
                 'title': {'type': 'string', 'maxLength': MAX_TITLE_LENGTH},
                 'content': {'type': 'string', 'maxLength': MAX_DOCUMENT_CHARS}}, ('document_id',)),
        _update_document, stripped, write=True, project_scoped=True),
    GlobalTool(
        'run_agent', 'Run an agent',
        'Run an agent now (write token minted by a current admin). Confirm first: it spends model budget.',
        schema({'agent_id': ID_SCHEMA}, ('agent_id',)), _run_agent, stripped, write=True, admin_only=True),
    # Methodology steps, their jobs, Radar and feedback edits (shared/mcp_global_tools_steps.py).
    *STEP_TOOLS,
    # The feedback catalogue and sources, Prioritization and board writes (shared/mcp_global_tools_work.py).
    *WORK_TOOLS,
)

TOOLS_BY_NAME: Final[dict[str, GlobalTool]] = {tool.name: tool for tool in TOOLS}

#: The engineering agents' read tool. The engineering agents are an opt-in module (tenet 7: off, it adds nothing),
#: so its tool is offered only where the deployment turned them on (shared.engineering_agents, the one switch the
#: Agents API's engineering routes read too): the default catalogue keeps its budget.
ENGINEERING_TOOLS: Final[tuple[GlobalTool, ...]] = (
    GlobalTool(
        'get_engineering_run', 'Get an engineering run',
        "An engineering run's task board, or (`view`) its conversation from `after`, its reports, or one report "
        '(`level`, `subject`, `version`: latest if omitted).',
        schema({'run_id': ID_SCHEMA, 'view': {'type': 'string', 'enum': list(ENGINEERING_VIEWS)},
                 'after': {'type': 'integer', 'minimum': 0, 'maximum': MAX_CONVERSATION_SEQ},
                 'limit': {'type': 'integer', 'minimum': 1, 'maximum': MAX_CONVERSATION_LIMIT},
                 'level': {'type': 'string', 'enum': list(REPORT_LEVELS)}, 'subject': ID_SCHEMA,
                 'version': {'type': 'integer', 'minimum': 1, 'maximum': MAX_REPORT_VERSION}}, ('run_id',)),
        _get_engineering_run, stripped),
)


def deployment_tools() -> tuple[GlobalTool, ...]:
    """The catalogue this deployment offers (``tools/list``): with the engineering agents' tool only where they are on."""
    return TOOLS + ENGINEERING_TOOLS if engineering_agents_on() else TOOLS


def deployment_tool(name: str) -> GlobalTool | None:
    """The tool of that name this deployment offers (``tools/call``), or None."""
    if name in TOOLS_BY_NAME:
        return TOOLS_BY_NAME[name]
    return next((tool for tool in ENGINEERING_TOOLS if tool.name == name), None) if engineering_agents_on() else None
