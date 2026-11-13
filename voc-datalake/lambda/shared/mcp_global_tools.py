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
  (token scope, the admin-minted check for ``agents_run``, the project pin);
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
from shared.document_sections import SECTION_ORDER, newest_edit_first, row_section
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
from shared.mcp_global_tools_steps import LEGACY_REVISE_STEP, STEP_TOOLS, legacy_revise
from shared.mcp_global_tools_work import WORK_TOOLS
from shared.prototype_pins import STATUSES as PIN_STATUSES

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
METRIC_VIEWS: Final[tuple[str, ...]] = ('summary', 'sentiment', 'categories', 'sources', 'personas', 'dimensions',
                                         'github', 'entities')
# The views a route other than `/metrics/{view}` serves: the filter values with their counts.
_VIEW_PATHS: Final[dict[str, str]] = {'entities': '/feedback/entities'}
# `feedback_get include_similar`: at most this many neighbours, each with a bounded text.
MAX_SIMILAR: Final = 5
MAX_SIMILAR_TEXT_CHARS: Final = 500
_SIMILAR_FIELDS: Final[tuple[str, ...]] = ('feedback_id', 'source_platform', 'source_created_at', 'category',
                                           'sentiment_label', 'urgency', 'rating', 'title', 'problem_summary')
# Post-query filters every feedback/metrics route takes (docs/dimensions.md); `dims` is serialised.
ITEM_FILTERS: Final[tuple[str, ...]] = ('channel', 'tag')
# `feature_requests_search` (GET /feature-requests/search): the slim item, a page of at most 50, a window of
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
# `documents_list_prototype_feedback` (GET /projects/{id}/prototypes/{doc}/feedback, shared/prototype_feedback.py):
# the answer field by field; the last fields of a pin and of an item (its text, its replies) are never sent for a
# flagged one, so instruction-shaped tester text does not reach a model through the tool; nor does an anchor field
# the route names in an item's `unsafe_fields`, or a group's route unless its `route_unsafe` is exactly False.
_FEEDBACK_FIELDS: Final[tuple[str, ...]] = ('document_id', 'versions_read', 'partial', 'cut',
                                            'older_versions_unread', 'pin_count')
_FEEDBACK_ITEM_FIELDS: Final[tuple[str, ...]] = ('item_id', 'pin_ids', 'count', 'first_at', 'text')
_FEEDBACK_PIN_FIELDS: Final[tuple[str, ...]] = ('pin_id', 'document_id', 'version', 'status', 'created_at',
                                                'addressed_by', 'text', 'replies')
# A pin's replies as the assistant's tool gives them: the newest five, each capped; the comment capped too.
_FEEDBACK_REPLIES: Final = 5
_FEEDBACK_TEXT_CHARS: Final = 600
_FEEDBACK_REPLY_CHARS: Final = 300
_FEEDBACK_PLACE_CHARS: Final = 200

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


def _document_sections(payload: object) -> list[dict]:
    """The read's documents in the four sections, in SECTION_ORDER (an empty one kept), last edit first inside each.

    A legacy row with no ``document_type`` is in its sort key's section (``row_section``).
    """
    grouped: dict[str, list[Mapping[str, Any]]] = {section: [] for section in SECTION_ORDER}
    for document in rows_at(payload, 'documents'):
        if isinstance(document, Mapping):
            grouped[row_section(document)].append(document)
    return [{'section': section, 'documents': [_document_summary(row) for row in newest_edit_first(rows)]}
            for section, rows in grouped.items()]


def _project_overview(payload: object, _args: Mapping[str, Any]) -> dict:
    project = payload.get('project') if isinstance(payload, Mapping) else None
    return {
        'project': public(project),
        'personas': [{'persona_id': p.get('persona_id'), 'name': p.get('name'), 'tagline': p.get('tagline')}
                     for p in rows_at(payload, 'personas') if isinstance(p, Mapping)],
        'document_sections': _document_sections(payload),
    }


def _one_document(payload: object, args: Mapping[str, Any]) -> dict:
    wanted = args.get('document_id')
    for document in rows_at(payload, 'documents'):
        if isinstance(document, Mapping) and document.get('document_id') == wanted:
            return {'document': public(document)}
    raise InvalidToolArgument(f'document {wanted} is not in this project')


def _feedback_pin(pin: Mapping[str, Any]) -> dict:
    """One pin of the feedback answer; a flagged one (or one not marked unflagged) without text and replies."""
    flagged = pin.get('flagged') is not False
    view = {key: pin.get(key) for key in _FEEDBACK_PIN_FIELDS[:-2]}
    if not flagged:
        replies = [r for r in rows_at(pin, 'replies') if isinstance(r, Mapping)][-_FEEDBACK_REPLIES:]
        view |= {'text': _clipped(pin.get('text'), _FEEDBACK_TEXT_CHARS),
                 'replies': [{'name': r.get('name'), 'text': _clipped(r.get('text'), _FEEDBACK_REPLY_CHARS), 'at': r.get('at')}
                             for r in replies]}
    return {**view, 'flagged': flagged}


def _clipped(value: object, limit: int) -> object:
    """A text field within ``limit`` characters (as the assistant's tool caps it); anything else as it is."""
    return value if not isinstance(value, str) or len(value) <= limit else value[:limit - 1] + '…'


def _feedback_item(item: Mapping[str, Any]) -> dict:
    """One item; a flagged one (instruction-shaped text) keeps only its ids, place and pins' status."""
    flagged = item.get('flagged') is not False
    keys = _FEEDBACK_ITEM_FIELDS[:-1] if flagged else _FEEDBACK_ITEM_FIELDS
    anchor = item.get('anchor')
    # Never a field the route judged unsafe for a model (an unmarked item: none of its text), nor a flagged item's
    # element text: as the assistant's tool gives it.
    raw_unsafe = item.get('unsafe_fields')
    unsafe = set(raw_unsafe) if isinstance(raw_unsafe, list) else {'route', 'selector', 'text_snippet'}
    anchor_keys = [key for key in ('route', 'selector', 'text_snippet')
                   if key not in unsafe and not (flagged and key == 'text_snippet')]
    view = {key: item.get(key) for key in keys}
    if 'text' in view:
        view['text'] = _clipped(view['text'], _FEEDBACK_TEXT_CHARS)
    return {
        **view, 'flagged': flagged,
        'anchor': {key: _clipped(anchor.get(key), _FEEDBACK_PLACE_CHARS) for key in anchor_keys}
        if isinstance(anchor, Mapping) else {},
        'pins': [_feedback_pin(p) for p in rows_at(item, 'pins') if isinstance(p, Mapping)],
    }


def _prototype_feedback(payload: object, _args: Mapping[str, Any]) -> dict:
    """The route's answer, field by field, with no text or reply of a flagged item or pin."""
    answer = payload if isinstance(payload, Mapping) else {}
    return {
        **{key: answer.get(key) for key in _FEEDBACK_FIELDS},
        'groups': [{'route': '' if group.get('route_unsafe') is not False else group.get('route'),
                    'items': [_feedback_item(i) for i in rows_at(group, 'items') if isinstance(i, Mapping)]}
                   for group in rows_at(answer, 'groups') if isinstance(group, Mapping)],
    }


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
            raise InvalidToolArgument('key must be a dimension key (from feedback_list_dimensions)')
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


def _list_prototype_feedback(args: Mapping[str, Any], project: str | None) -> RouteRequest:
    document_id = id_arg(args, 'document_id')
    status = args.get('status')
    if status is not None and status not in PIN_STATUSES:
        raise InvalidToolArgument(f'status must be one of: {", ".join(PIN_STATUSES)}')
    return RouteRequest(DOMAIN_PROJECTS, 'GET',
                        f'/projects/{require_project(project)}/prototypes/{document_id}/feedback',
                        query={'status': status})


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
# Every name starts with its area (AREAS), so a client that lists or searches tools finds an area's tools
# together; each description says what the tool does, its nouns and verbs, when to use it and its key
# arguments (the whole list's budget: test_mcp_global_tools_budget.py).
AREAS: Final[tuple[str, ...]] = ('feedback', 'memory', 'company', 'projects', 'documents', 'agents',
                                 'feature_requests', 'radar', 'prioritization')

_CATALOGUE: Final[tuple[GlobalTool, ...]] = (
    GlobalTool(
        'feedback_search', 'Search customer feedback',
        'Search customer feedback (reviews, app-store ratings, survey and form answers, support messages) by '
        'text, or list the newest items. Use it for what customers say and for the evidence behind every claim '
        'about customers. `query` (2+ characters) searches the text; without it the filters list the newest '
        'items. Filters: `days` (0 = all time), `category`, `sentiment` (positive, negative, neutral, mixed), '
        '`source`, `channel`, `tag`, `dims` (from feedback_list_dimensions), `urgent: true` (high urgency only), '
        '`limit`. Each item has its feedback_id: cite it.',
        schema({'query': {'type': 'string', 'maxLength': MAX_QUERY_LENGTH}, 'days': _DAYS, 'limit': _LIMIT,
                 'category': _FILTER, 'sentiment': _FILTER, 'source': _FILTER, 'urgent': BOOL_SCHEMA, **_ITEM_FILTERS}),
        _search_feedback, stripped),
    GlobalTool(
        'feedback_get', 'Get one feedback item',
        'Read one customer feedback item (review) in full by `feedback_id`: text, source, date, rating, '
        'sentiment, category, urgency, persona, dimensions and tags. `include_similar: true` adds up to '
        f'{MAX_SIMILAR} similar items (short text), to see whether a problem is isolated or a pattern.',
        schema({'feedback_id': ID_SCHEMA, 'include_similar': BOOL_SCHEMA}, ('feedback_id',)), _get_feedback, stripped,
        follow_ups=_similar_follow_up),
    GlobalTool(
        'feedback_get_metrics', 'Get feedback metrics',
        'Count and trend customer feedback over `days` (0 = all time): `view` summary (volume, sentiment, daily '
        'series), sentiment, categories, sources, personas, dimensions (counts per value of one dimension `key`), '
        'github (issues per release and label) or entities (the filter values in use with counts). Filters: '
        '`source`, `channel`, `tag`, `dims`. Prefer it to counting search results.',
        schema({'view': {'type': 'string', 'enum': list(METRIC_VIEWS), 'default': 'summary'}, 'days': _DAYS,
                 'key': _FILTER, 'source': _FILTER, **_ITEM_FILTERS}),
        _get_metrics),
    GlobalTool(
        'feedback_list_categories', 'List feedback categories',
        'List the feedback category taxonomy you can see: categories with their descriptions and subcategories. '
        'Use the exact names as `category` in feedback_search and feedback_edit.',
        schema({}), _list_categories),
    GlobalTool(
        'feedback_list_dimensions', 'List feedback dimensions',
        'List the feedback dimensions (key, label, allowed values; for example product, module, user type). Use '
        'the exact keys and values in `dims` filters and as the `key` of feedback_get_metrics view=dimensions.',
        schema({}), _list_dimensions),
    GlobalTool(
        'memory_search', 'Search memory',
        'Semantic search over the company and personal memory you can see: decisions, facts, preferences and '
        'lessons the team recorded. Use it before proposing something, to respect what was already decided. '
        '`query` (required), `k` results (default 8).',
        schema({'query': {'type': 'string', 'maxLength': MAX_QUERY_LENGTH},
                 'k': {'type': 'integer', 'minimum': 1, 'maximum': MAX_MEMORY_K, 'default': DEFAULT_MEMORY_K}}, ('query',)),
        _search_memory),
    GlobalTool(
        'company_get_context', 'Get company context',
        'Read the company context: its vision and strategic objectives (goals). Use it to align a proposal, '
        'PR/FAQ, PRD or prioritization with what the company is trying to achieve.',
        schema({}), _company_context),
    GlobalTool(
        'projects_list', 'List projects',
        'List the research projects you can see, with their ids and names. Start here to find the `project_id` '
        'the projects_ and documents_ tools take.',
        schema({}), _list_projects, _project_list),
    GlobalTool(
        'projects_get', 'Get a project',
        'Read one research project: its details, personas (name, tagline) and documents in sections prd, prfaq, '
        'prototypes, documents, last edit first in each (ids, types, titles, versions; no bodies: read one with '
        'documents_get).',
        schema({'project_id': PROJECT_ID_SCHEMA}), _get_project, _project_overview, project_scoped=True),
    GlobalTool(
        'documents_get', 'Get a document',
        'Read one project document in full by `document_id`: a PR/FAQ, PRD, research report or custom markdown '
        'document, with its type, title, version and content.',
        schema({'project_id': PROJECT_ID_SCHEMA, 'document_id': ID_SCHEMA}, ('document_id',)),
        _get_document, _one_document, project_scoped=True),
    GlobalTool(
        'documents_list_prototype_feedback', 'List prototype feedback',
        "Read the testers' pins on every version of a prototype `document_id`, grouped by screen and folded "
        '("3 testers said this"), with their replies, status, version and pin ids; optional `status`. '
        '`partial` names the versions not fully read. A flagged item has no text.',
        schema({'project_id': PROJECT_ID_SCHEMA, 'document_id': ID_SCHEMA,
                'status': {'type': 'string', 'enum': list(PIN_STATUSES)}}, ('document_id',)),
        _list_prototype_feedback, _prototype_feedback, project_scoped=True),
    GlobalTool(
        'agents_list', 'List agents',
        'List the autonomous agents you can see, with their status. Use it to find the `agent_id` the agents_ '
        'tools take.',
        schema({}), _list_agents, stripped),
    GlobalTool(
        'agents_get_run', 'Get agent runs',
        "Follow an autonomous agent's run: `agent_id` with `run_id` (from agents_run) for its status, current "
        'step, project and error; without `run_id`, the agent\'s newest runs (`limit`).',
        schema({'agent_id': ID_SCHEMA, 'run_id': ID_SCHEMA,
                 'limit': {'type': 'integer', 'minimum': 1, 'maximum': MAX_RUNS_LIMIT,
                           'default': DEFAULT_RUNS_LIMIT}}, ('agent_id',)),
        _get_agent_run, stripped),
    GlobalTool(
        'feature_requests_search', 'Search feature requests',
        'Search the feature requests and ideas people posted on feedback boards, with their +1 count '
        '(`supporters`). They are NOT customer reviews: never add them to feedback counts or metrics; cite each '
        'as [FR:<request_id>]. `query`; `board`, `category`, `status` (comma lists); `days` (0 = all time); '
        '`limit`. `boards: true` lists the boards instead.',
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
        'documents_create', 'Create a document',
        'Create a custom markdown document (notes, analysis, report) in a project you can edit (write token): '
        '`title` and `content`. Cite the feedback ids its claims rest on. Confirm with the user first.',
        schema({'project_id': PROJECT_ID_SCHEMA, 'title': {'type': 'string', 'maxLength': MAX_TITLE_LENGTH},
                 'content': {'type': 'string', 'maxLength': MAX_DOCUMENT_CHARS}}, ('title', 'content')),
        _create_document, stripped, write=True, project_scoped=True),
    GlobalTool(
        'documents_update', 'Update a document',
        "Edit a project document: replace its `title` and/or `content` by `document_id` (write token); each "
        'save is a new version, never an overwrite. A PRD or PR/FAQ keeps its series title and is refused unless '
        'the user and the project owner work AI-driven; prototypes cannot be edited. Confirm with the user first.',
        schema({'project_id': PROJECT_ID_SCHEMA, 'document_id': ID_SCHEMA,
                 'title': {'type': 'string', 'maxLength': MAX_TITLE_LENGTH},
                 'content': {'type': 'string', 'maxLength': MAX_DOCUMENT_CHARS}}, ('document_id',)),
        _update_document, stripped, write=True, project_scoped=True),
    GlobalTool(
        'agents_run', 'Run an agent',
        'Start an autonomous agent run now by `agent_id` (write token minted by a current administrator). It '
        'spends model budget: confirm with the user first; follow the run with agents_get_run.',
        schema({'agent_id': ID_SCHEMA}, ('agent_id',)), _run_agent, stripped, write=True, admin_only=True),
    # Methodology steps, their jobs, Revise from comments, Radar and feedback edits (mcp_global_tools_steps.py).
    *STEP_TOOLS,
    # The feedback catalogue and sources, Prioritization and board writes (shared/mcp_global_tools_work.py).
    *WORK_TOOLS,
)


def area_of(name: str) -> str | None:
    """The area a tool name starts with (``feedback_search`` → ``feedback``), or None."""
    return next((area for area in AREAS if name.startswith(f'{area}_')), None)


def _area_rank(tool: GlobalTool) -> int:
    area = area_of(tool.name)
    return AREAS.index(area) if area is not None else len(AREAS)


#: tools/list's order: by area (AREAS), and within an area in catalogue order.
TOOLS: Final[tuple[GlobalTool, ...]] = tuple(sorted(_CATALOGUE, key=_area_rank))
TOOLS_BY_NAME: Final[dict[str, GlobalTool]] = {tool.name: tool for tool in TOOLS}

# ── Renamed in 6.10.00 ──────────────────────────────────────────────────────
#: Each name before 6.10.00 → its tool now. ``tools/call`` still accepts them, never listed; a later
#: release removes them (docs/mcp.md → Renamed in 6.10.00).
RENAMED: Final[dict[str, str]] = {
    'search_feedback': 'feedback_search',
    'get_feedback': 'feedback_get',
    'get_metrics': 'feedback_get_metrics',
    'list_categories': 'feedback_list_categories',
    'list_dimensions': 'feedback_list_dimensions',
    'get_feedback_catalogue': 'feedback_get_catalogue',
    'edit_feedback': 'feedback_edit',
    'search_memory': 'memory_search',
    'get_company_context': 'company_get_context',
    'list_projects': 'projects_list',
    'get_project': 'projects_get',
    'generate': 'projects_generate',
    'get_job': 'projects_get_job',
    'get_document': 'documents_get',
    'create_document': 'documents_create',
    'update_document': 'documents_update',
    'list_agents': 'agents_list',
    'get_agent_run': 'agents_get_run',
    'run_agent': 'agents_run',
    'search_feature_requests': 'feature_requests_search',
    'write_feature_request': 'feature_requests_write',
    'read_radar': 'radar_read',
    'get_prioritization': 'prioritization_get',
    'score_prioritization': 'prioritization_score',
}


def resolve_tool(name: object, arguments: object) -> tuple[GlobalTool, object] | None:
    """The tool a ``tools/call`` of ``name`` runs and the arguments it gets, or None for an unknown name.

    A listed name runs as is; a name of ``RENAMED`` runs its tool with the same arguments, except the old
    ``generate`` with ``step: revise`` ("Revise from comments"), which is now its own two tools
    (``legacy_revise``). Arguments that are not an object pass unchanged (the handler refuses them).
    """
    if not isinstance(name, str):
        return None
    tool = TOOLS_BY_NAME.get(name)
    if tool is not None:
        return tool, arguments
    current = RENAMED.get(name)
    if current is None:
        return None
    if name == 'generate' and isinstance(arguments, Mapping) and arguments.get('step') == LEGACY_REVISE_STEP:
        current, arguments = legacy_revise(arguments)
    return TOOLS_BY_NAME[current], arguments
