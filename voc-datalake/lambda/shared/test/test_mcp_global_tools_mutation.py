"""Mutation hardening for `shared/mcp_global_tools.py`.

`test_global_mcp_protocol.py` and `test_global_mcp_e2e.py` reach the catalogue
through the handler, so they pin what a call ANSWERS — a path-unsafe id is a tool
error, a write tool needs a write token, a projection drops ``pk``/``sk`` — and a
mutation run found what they cannot tell apart:

* the published catalogue as a WHOLE: every tool's title, description and input
  schema (the bounds, defaults and the id pattern a client validates against),
  its annotations and its write / admin_only / project_scoped flags. A model
  reads these strings to pick a tool, so a drifted word or bound is a contract
  change no handler test sees.
* the exact route each builder makes: domain, verb, path, query and body,
  including the defaults (30 days, 20 items, k = 8) and the ``None`` filters a
  search forwards.
* the ACCEPTED and REFUSED side of every argument bound (``days`` 0 and 9999,
  ``limit`` 1 and 100, a 2-character search query, a 200-character title, a
  200,000-character body) and the exact message each refusal names.
* the projections key by key: every hidden storage key, any key containing
  ``url`` in any case, the document summary fields, the persona fields, and the
  non-mapping rows each projection skips rather than forwards.
* that ``RouteRequest`` and ``GlobalTool`` stay frozen dataclasses whose
  annotations resolve (``typing.get_type_hints``), which no call path exercises.
"""
from __future__ import annotations

import dataclasses
import typing
from typing import Any, ClassVar

import pytest

from shared import mcp_global_tools as tools

DAYS = {'type': 'integer', 'minimum': 0, 'maximum': 9999, 'default': 30,
        'description': 'Look-back window in days; 0 = all time.'}
LIMIT = {'type': 'integer', 'minimum': 1, 'maximum': 100, 'default': 20}
FILTER = {'type': 'string', 'maxLength': 64}
ID = {'type': 'string', 'pattern': '^[A-Za-z0-9_-]{1,128}$'}
PROJECT_ID = {**ID, 'description': 'Project id (from list_projects). Optional for a project-scoped token.'}
TITLE = {'type': 'string', 'maxLength': 200}
CONTENT = {'type': 'string', 'maxLength': 200000}
NO_ARGS = {'type': 'object', 'properties': {}, 'additionalProperties': False}
DIMS = {'type': 'object', 'maxProperties': 10, 'propertyNames': {'pattern': '^[a-z][a-z0-9_]{0,31}$'},
        'additionalProperties': {'type': 'string', 'maxLength': 64},
        'description': 'Dimension filters {key: value} (keys from list_dimensions), all must match.'}
ITEM_FILTERS = {'channel': FILTER, 'tag': FILTER, 'dims': DIMS}
NO_ITEM_FILTERS = {'channel': None, 'tag': None, 'dims': None}


def _object(properties: dict, *required: str) -> dict:
    """The expected object schema; ``required`` appears only when a property is required."""
    return {**NO_ARGS, 'properties': properties, **({'required': list(required)} if required else {})}


# name -> (title, description, inputSchema, write, admin_only, project_scoped)
CATALOGUE: dict[str, tuple[str, str, dict, bool, bool, bool]] = {
    'search_feedback': (
        'Search feedback',
        'Search or list customer feedback (reviews, form submissions, imports) you can see. Give `query` '
        '(2+ characters) for a text search, or only filters to list the newest items. Returns verbatims with '
        'sentiment, category and urgency. Use it to ground any claim about what customers say.',
        _object({'query': {'type': 'string', 'maxLength': 500}, 'days': DAYS, 'limit': LIMIT,
                 'category': FILTER, 'sentiment': FILTER, 'source': FILTER, **ITEM_FILTERS}),
        False, False, False),
    'get_feedback': (
        'Get one feedback item',
        'One feedback item in full, by `feedback_id` (from search_feedback).',
        _object({'feedback_id': ID}, 'feedback_id'), False, False, False),
    'get_metrics': (
        'Get feedback metrics',
        'Aggregated metrics over a window: `view` = summary (totals, average sentiment, urgent count, daily '
        'series) or a breakdown by sentiment, categories, sources, personas or one dimension (`dimensions` + '
        '`key`); every view takes the source / channel / tag / dims filters. Use it for trends and volumes '
        'instead of counting search results.',
        _object({'view': {'type': 'string', 'enum': ['summary', 'sentiment', 'categories', 'sources', 'personas',
                                                     'dimensions'],
                          'default': 'summary'}, 'days': DAYS, 'key': FILTER, 'source': FILTER, **ITEM_FILTERS}),
        False, False, False),
    'list_categories': (
        'List categories',
        'The feedback category taxonomy you have access to (name, description, product, subcategories).',
        NO_ARGS, False, False, False),
    'list_dimensions': (
        'List dimensions',
        'The feedback dimensions (product, module, user type, ...): key, label and allowed values, for the `dims` '
        'filter and the dimensions metric view.',
        NO_ARGS, False, False, False),
    'search_memory': (
        'Search memory',
        'Semantic search over company memory and your personal memory (decisions, facts, preferences the team '
        'has recorded), filtered to the categories you can see. Use it before proposing something the team may '
        'already have decided.',
        _object({'query': {'type': 'string', 'maxLength': 500},
                 'k': {'type': 'integer', 'minimum': 1, 'maximum': 20, 'default': 8}}, 'query'),
        False, False, False),
    'get_company_context': (
        'Get company context',
        'The company vision and objectives every product decision should align with.',
        NO_ARGS, False, False, False),
    'list_projects': (
        'List projects',
        'Research projects you can see (a project-scoped token sees only its project).',
        NO_ARGS, False, False, False),
    'get_project': (
        'Get a project',
        'A project with its personas and the list of its documents (PRDs, PR/FAQs, research, custom documents) '
        '— titles and ids only; read a body with get_document.',
        _object({'project_id': PROJECT_ID}), False, False, True),
    'get_document': (
        'Get a document',
        'One project document in full, by `document_id` (from get_project).',
        _object({'project_id': PROJECT_ID, 'document_id': ID}, 'document_id'), False, False, True),
    'list_agents': (
        'List autonomous agents',
        'Autonomous agents (review → PR/FAQ → prototype crews) you can see, with their status.',
        NO_ARGS, False, False, False),
    'get_agent_run': (
        'Get agent runs',
        "An agent's run by `run_id` (status, current step, project, error), or without `run_id` its newest "
        'runs. Use it to follow a run started with run_agent; read its output with get_project.',
        _object({'agent_id': ID, 'run_id': ID,
                 'limit': {'type': 'integer', 'minimum': 1, 'maximum': 50, 'default': 5}}, 'agent_id'),
        False, False, False),
    'create_document': (
        'Create a project document',
        'Create a custom markdown document in a project you can edit. Requires a write token. Write only what '
        'the user asked for; cite feedback ids for claims about customers.',
        _object({'project_id': PROJECT_ID, 'title': TITLE, 'content': CONTENT}, 'title', 'content'),
        True, False, True),
    'update_document': (
        'Update a project document',
        "Replace a document's title and/or content in a project you can edit. Requires a write token. Managed "
        'PRD / PR/FAQ titles cannot change series, and prototype bodies cannot be edited here.',
        _object({'project_id': PROJECT_ID, 'document_id': ID, 'title': TITLE, 'content': CONTENT}, 'document_id'),
        True, False, True),
    'run_agent': (
        'Run an autonomous agent',
        'Start a run of an autonomous agent now (from list_agents). Only for write tokens minted by an '
        'administrator who is still an administrator; returns the queued run. Confirm with the user first — a '
        'run spends model budget and creates or updates projects.',
        _object({'agent_id': ID}, 'agent_id'), True, True, False),
}


def _build(name: str, args: dict | None = None, project: str | None = None) -> tools.RouteRequest:
    return tools.TOOLS_BY_NAME[name].build(args or {}, project)


def _refusal(name: str, args: dict, project: str | None = None) -> str:
    with pytest.raises(tools.InvalidToolArgument) as caught:
        _build(name, args, project)
    return str(caught.value)


def _shape(name: str, payload: object, args: dict | None = None) -> Any:
    return tools.TOOLS_BY_NAME[name].shape(payload, args or {})


class TestThePublishedCatalogue:
    def test_tools_are_listed_in_this_order(self):
        assert [tool.name for tool in tools.TOOLS] == list(CATALOGUE)
        assert list(tools.TOOLS_BY_NAME) == list(CATALOGUE)

    @pytest.mark.parametrize('name', list(CATALOGUE))
    def test_declaration_is_exact(self, name):
        title, description, schema, write, _admin, _scoped = CATALOGUE[name]
        assert tools.TOOLS_BY_NAME[name].declaration() == {
            'name': name, 'title': title, 'description': description, 'inputSchema': schema,
            'annotations': {'title': title, 'readOnlyHint': not write, 'destructiveHint': False,
                            'idempotentHint': not write, 'openWorldHint': False},
        }

    @pytest.mark.parametrize('name', list(CATALOGUE))
    def test_gating_flags_are_exact(self, name):
        tool = tools.TOOLS_BY_NAME[name]
        assert (tool.write, tool.admin_only, tool.project_scoped) == CATALOGUE[name][3:]

    def test_a_tool_declared_without_flags_is_a_read_tool_with_an_identity_shape(self):
        tool = tools.GlobalTool('t', 'T', 'd', NO_ARGS, lambda _a, _p: tools.RouteRequest('x', 'GET', '/'))
        assert (tool.write, tool.admin_only, tool.project_scoped) == (False, False, False)
        payload = {'pk': 'kept'}
        assert tool.shape(payload, {}) is payload

    def test_domains_and_their_function_env_names(self):
        assert tools.DOMAIN_FUNCTION_ENV == {
            'metrics': 'METRICS_FUNCTION', 'settings': 'SETTINGS_FUNCTION', 'memory': 'MEMORY_FUNCTION',
            'projects': 'PROJECTS_FUNCTION', 'agents': 'AGENTS_FUNCTION'}


class TestTheModelTypes:
    @pytest.mark.parametrize(('target', 'attribute'), [
        (_build('list_agents'), 'path'), (tools.TOOLS_BY_NAME['run_agent'], 'write')])
    def test_a_route_and_a_tool_are_immutable(self, target, attribute):
        with pytest.raises(dataclasses.FrozenInstanceError):
            setattr(target, attribute, None)

    @pytest.mark.parametrize('target', [tools.RouteRequest, tools.GlobalTool])
    def test_the_dataclass_annotations_resolve(self, target):
        assert typing.get_type_hints(target)


class TestEachToolBuildsItsRoute:
    ROUTES: ClassVar[list[tuple[str, dict, str | None, tuple]]] = [
        ('get_feedback', {'feedback_id': 'f_1'}, None, ('metrics', 'GET', '/feedback/f_1', {}, None)),
        ('get_metrics', {}, None, ('metrics', 'GET', '/metrics/summary', {'days': 30, 'source': None, **NO_ITEM_FILTERS}, None)),
        ('list_dimensions', {}, None, ('settings', 'GET', '/settings/dimensions', {}, None)),
        ('list_categories', {}, None, ('settings', 'GET', '/settings/categories', {}, None)),
        ('get_company_context', {}, None, ('settings', 'GET', '/settings/company-context', {}, None)),
        ('search_memory', {'query': ' pricing '}, None,
         ('memory', 'POST', '/memory/retrieve', {}, {'query': 'pricing', 'k': 8})),
        ('list_projects', {}, None, ('projects', 'GET', '/projects', {}, None)),
        ('get_project', {}, 'proj_1', ('projects', 'GET', '/projects/proj_1', {}, None)),
        ('get_document', {'document_id': 'doc_1'}, 'proj_1', ('projects', 'GET', '/projects/proj_1', {}, None)),
        ('create_document', {'title': ' T ', 'content': ' body '}, 'proj_1',
         ('projects', 'POST', '/projects/proj_1/documents', {},
          {'document_type': 'custom', 'title': 'T', 'content': 'body'})),
        ('update_document', {'document_id': 'doc_1', 'title': 'T', 'content': 'C'}, 'proj_1',
         ('projects', 'PUT', '/projects/proj_1/documents/doc_1', {}, {'title': 'T', 'content': 'C'})),
        ('list_agents', {}, None, ('agents', 'GET', '/agents', {}, None)),
        ('get_agent_run', {'agent_id': 'agent_1'}, None,
         ('agents', 'GET', '/agents/agent_1/runs', {'limit': 5}, None)),
        ('get_agent_run', {'agent_id': 'agent_1', 'run_id': '', 'limit': 50}, None,
         ('agents', 'GET', '/agents/agent_1/runs', {'limit': 50}, None)),
        ('get_agent_run', {'agent_id': 'agent_1', 'run_id': 'run_9', 'limit': 3}, None,
         ('agents', 'GET', '/agents/agent_1/runs/run_9', {}, None)),
        ('run_agent', {'agent_id': 'agent_1'}, None, ('agents', 'POST', '/agents/agent_1/run', {}, None)),
    ]

    @pytest.mark.parametrize(('name', 'args', 'project', 'expected'), ROUTES)
    def test_route(self, name, args, project, expected):
        request = _build(name, args, project)
        assert (request.domain, request.method, request.path, request.query, request.body) == expected

    @pytest.mark.parametrize('view', ['summary', 'sentiment', 'categories', 'sources', 'personas'])
    def test_every_metrics_view_is_its_own_path(self, view):
        assert _build('get_metrics', {'view': view, 'days': 0}).path == f'/metrics/{view}'
        assert _build('get_metrics', {'view': view, 'days': 0}).query == {'days': 0, 'source': None, **NO_ITEM_FILTERS}

    @pytest.mark.parametrize('view', ['summary', 'sources', 'personas'])
    def test_every_metrics_view_forwards_source_and_the_item_filters(self, view):
        query = _build('get_metrics', {'view': view, 'source': ' web ', 'tag': 'VIP'}).query
        assert (query['source'], query['tag']) == ('web', 'VIP')

    def test_the_dimensions_view_needs_a_key_and_forwards_the_item_filters(self):
        request = _build('get_metrics', {'view': 'dimensions', 'key': ' product ', 'channel': ' email ',
                                         'tag': 'VIP', 'dims': {'module': ' billing ', 'user_type': 'partner'}})
        assert (request.path, request.query) == ('/metrics/dimensions', {
            'days': 30, 'source': None, 'channel': 'email', 'tag': 'VIP', 'dims': 'module:billing,user_type:partner',
            'key': 'product'})

    @pytest.mark.parametrize(('args', 'body'), [
        ({'document_id': 'd', 'title': 'Only title'}, {'title': 'Only title'}),
        ({'document_id': 'd', 'content': 'Only body', 'title': '  '}, {'content': 'Only body'}),
    ])
    def test_an_update_sends_only_what_changes(self, args, body):
        assert _build('update_document', args, 'p').body == body


class TestSearchFeedback:
    NO_FILTERS: ClassVar[dict] = {'days': 30, 'limit': 20, 'category': None, 'sentiment': None, 'source': None,
                                  **NO_ITEM_FILTERS}

    def test_no_query_lists_with_the_default_filters(self):
        request = _build('search_feedback')
        assert (request.domain, request.method, request.path, request.query, request.body) == (
            'metrics', 'GET', '/feedback', self.NO_FILTERS, None)

    def test_a_two_character_query_searches_and_one_character_lists(self):
        assert _build('search_feedback', {'query': ' ab '}).query == {'q': 'ab', **self.NO_FILTERS}
        search = _build('search_feedback', {'query': ' ab '})
        assert (search.domain, search.method, search.path, search.body) == ('metrics', 'GET', '/feedback/search', None)
        one = _build('search_feedback', {'query': 'a'})
        assert (one.path, one.query) == ('/feedback', self.NO_FILTERS)

    def test_filters_are_trimmed_and_forwarded(self):
        request = _build('search_feedback', {'days': 0, 'limit': 100, 'category': ' billing ',
                                             'sentiment': 'negative', 'source': 'webscraper'})
        assert request.query == {'days': 0, 'limit': 100, 'category': 'billing', 'sentiment': 'negative',
                                 'source': 'webscraper', **NO_ITEM_FILTERS}

    def test_item_filters_are_forwarded_and_an_empty_dims_is_no_filter(self):
        request = _build('search_feedback', {'query': 'late', 'channel': 'chat', 'tag': ' refund ',
                                             'dims': {'product': 'app'}})
        assert request.query == {**self.NO_FILTERS, 'q': 'late', 'channel': 'chat', 'tag': 'refund',
                                 'dims': 'product:app'}
        assert _build('search_feedback', {'dims': {}}).query['dims'] is None

    def test_bounds_accept_the_edges(self):
        assert _build('search_feedback', {'days': 9999, 'limit': 1}).query['days'] == 9999
        assert _build('search_feedback', {'days': 9999, 'limit': 1}).query['limit'] == 1
        assert _build('search_feedback', {'query': 'q' * 500}).query['q'] == 'q' * 500
        assert _build('search_feedback', {'category': 'c' * 64}).query['category'] == 'c' * 64


class TestEveryRefusalNamesItsCause:
    @pytest.mark.parametrize(('name', 'args', 'message'), [
        ('search_feedback', {'days': -1}, 'days must be an integer between 0 and 9999'),
        ('search_feedback', {'days': 10000}, 'days must be an integer between 0 and 9999'),
        ('search_feedback', {'days': True}, 'days must be an integer between 0 and 9999'),
        ('search_feedback', {'days': '7'}, 'days must be an integer between 0 and 9999'),
        ('search_feedback', {'limit': 0}, 'limit must be an integer between 1 and 100'),
        ('search_feedback', {'limit': 101}, 'limit must be an integer between 1 and 100'),
        ('search_feedback', {'query': 'q' * 501}, 'query must be at most 500 characters'),
        ('search_feedback', {'query': 7}, 'query must be a string'),
        ('search_feedback', {'category': 'c' * 65}, 'category must be at most 64 characters'),
        ('search_feedback', {'sentiment': ['x']}, 'sentiment must be a string'),
        ('search_feedback', {'source': 's' * 65}, 'source must be at most 64 characters'),
        ('get_metrics', {'days': 10000}, 'days must be an integer between 0 and 9999'),
        ('get_metrics', {'view': 'daily'},
         'view must be one of: summary, sentiment, categories, sources, personas, dimensions'),
        ('get_metrics', {'view': 'dimensions'}, 'key is required'),
        ('get_metrics', {'view': 'dimensions', 'key': 'Product'},
         'key must be a dimension key (from list_dimensions)'),
        ('get_metrics', {'tag': 't' * 65}, 'tag must be at most 64 characters'),
        ('search_feedback', {'dims': 'product:app'}, 'dims must be an object of dimension key to value strings'),
        ('search_feedback', {'dims': {'product': 1}}, 'dims must be an object of dimension key to value strings'),
        ('search_feedback', {'dims': {'product': 'a b'}}, 'dims must be key:value pairs separated by commas'),
        ('search_feedback', {'dims': {f'k{n}': 'v' for n in range(11)}},
         'dims accepts at most 10 key:value pairs'),
        ('search_feedback', {'channel': 7}, 'channel must be a string'),
        ('search_memory', {}, 'query is required'),
        ('search_memory', {'query': '   '}, 'query is required'),
        ('search_memory', {'query': 'q', 'k': 0}, 'k must be an integer between 1 and 20'),
        ('search_memory', {'query': 'q', 'k': 21}, 'k must be an integer between 1 and 20'),
        ('get_feedback', {'feedback_id': 'a/b'},
         'feedback_id is required and must be an id (letters, digits, _ and -)'),
        ('run_agent', {}, 'agent_id is required and must be an id (letters, digits, _ and -)'),
        ('get_agent_run', {}, 'agent_id is required and must be an id (letters, digits, _ and -)'),
        ('get_agent_run', {'agent_id': 'a', 'run_id': '../x'},
         'run_id is required and must be an id (letters, digits, _ and -)'),
        ('get_agent_run', {'agent_id': 'a', 'limit': 0}, 'limit must be an integer between 1 and 50'),
        ('get_agent_run', {'agent_id': 'a', 'limit': 51}, 'limit must be an integer between 1 and 50'),
        ('update_document', {'document_id': 'd'}, 'give a new title, new content, or both'),
        ('update_document', {'document_id': 'd', 'title': 't' * 201}, 'title must be at most 200 characters'),
        ('create_document', {'title': 'T'}, 'content is required'),
        ('create_document', {'content': 'C'}, 'title is required'),
        ('create_document', {'title': 'T', 'content': 'c' * 200_001}, 'content must be at most 200000 characters'),
    ])
    def test_message(self, name, args, message):
        assert _refusal(name, args, 'proj_1') == message

    @pytest.mark.parametrize(('name', 'args'), [
        ('get_project', {}), ('create_document', {'title': 'T', 'content': 'C'}),
        ('update_document', {'document_id': 'd', 'title': 'T'}),
    ])
    def test_a_project_tool_without_a_project_says_so(self, name, args):
        assert _refusal(name, args, None) == 'project_id is required'
        assert _refusal(name, args, '') == 'project_id is required'

    def test_get_document_checks_the_document_id_before_the_project(self):
        assert _refusal('get_document', {'document_id': '../x'}, None) == (
            'document_id is required and must be an id (letters, digits, _ and -)')

    def test_the_accepted_edges(self):
        assert _build('search_memory', {'query': 'q', 'k': 1}).body == {'query': 'q', 'k': 1}
        assert _build('search_memory', {'query': 'q', 'k': 20}).body == {'query': 'q', 'k': 20}
        assert _build('search_memory', {'query': 'q' * 500}).body == {'query': 'q' * 500, 'k': 8}
        body = _build('create_document', {'title': 't' * 200, 'content': 'c' * 200_000}, 'p').body
        assert body == {'document_type': 'custom', 'title': 't' * 200, 'content': 'c' * 200_000}
        assert _build('get_feedback', {'feedback_id': 'x' * 128}).path == '/feedback/' + 'x' * 128


class TestProjections:
    @pytest.mark.parametrize('key', ['pk', 'sk', 'gsi1pk', 'gsi1sk', 'gsi2pk', 'gsi2sk', 'secret_hash',
                                     'kiro_default_export_prompt', 'url', 'prototype_url', 'Avatar_URL', 'urls'])
    def test_a_hidden_key_never_leaves(self, key):
        assert _shape('list_agents', {key: 'x', 'name': 'n'}, {}) == {'name': 'n'}

    def test_stripped_cleans_one_level_of_row_lists_only(self):
        payload = {'agents': [{'agent_id': 'a', 'pk': 'P', 'nested': {'sk': 'kept'}}],
                   'mixed': [{'pk': 'P'}, 'x'], 'tags': ['a', 'b'], 'row': {'pk': 'kept'}, 'empty': [], 'n': 3}
        assert _shape('list_agents', payload) == {
            'agents': [{'agent_id': 'a', 'nested': {'sk': 'kept'}}], 'mixed': [{'pk': 'P'}, 'x'],
            'tags': ['a', 'b'], 'row': {'pk': 'kept'}, 'empty': [], 'n': 3}

    def test_a_non_mapping_body_passes_through(self):
        assert _shape('run_agent', ['x']) == ['x']
        assert _shape('run_agent', None) is None

    def test_project_list_counts_the_public_rows(self):
        payload = {'projects': [{'project_id': 'p1', 'pk': 'P', 'cover_url': 'u'}, 'junk', {'project_id': 'p2'}]}
        assert _shape('list_projects', payload) == {
            'count': 2, 'projects': [{'project_id': 'p1'}, {'project_id': 'p2'}]}

    @pytest.mark.parametrize('payload', [None, [], {'projects': 'x'}, {}])
    def test_project_list_of_an_unreadable_body_is_empty(self, payload):
        assert _shape('list_projects', payload) == {'count': 0, 'projects': []}

    def test_project_overview_keeps_only_the_summary_fields(self):
        document = {'document_id': 'd1', 'document_type': 'prd', 'title': 'T', 'base_title': 'B', 'version': 2,
                    'created_at': 'c', 'updated_at': 'u', 'content': 'long body', 'sk': 'S'}
        payload = {
            'project': {'project_id': 'p1', 'name': 'N', 'pk': 'P', 'share_url': 'u'},
            'personas': [{'persona_id': 'pe1', 'name': 'Pat', 'tagline': 'Busy', 'avatar_url': 'u', 'quote': 'q'},
                         'junk'],
            'documents': [document, {'document_id': 'd2', 'title': None, 'version': 0}, 'junk'],
        }
        assert _shape('get_project', payload) == {
            'project': {'project_id': 'p1', 'name': 'N'},
            'personas': [{'persona_id': 'pe1', 'name': 'Pat', 'tagline': 'Busy'}],
            'documents': [{'document_id': 'd1', 'document_type': 'prd', 'title': 'T', 'base_title': 'B',
                           'version': 2, 'created_at': 'c', 'updated_at': 'u'},
                          {'document_id': 'd2', 'version': 0}],
        }

    def test_project_overview_of_an_unreadable_body_is_empty(self):
        assert _shape('get_project', ['x']) == {'project': {}, 'personas': [], 'documents': []}

    def test_one_document_is_found_by_id_and_stripped(self):
        payload = {'documents': ['junk', {'document_id': 'd1', 'title': 'one'},
                                 {'document_id': 'd2', 'content': 'two', 'prototype_url': 'u', 'pk': 'P'}]}
        assert _shape('get_document', payload, {'document_id': 'd2'}) == {
            'document': {'document_id': 'd2', 'content': 'two'}}

    def test_a_missing_document_is_named(self):
        with pytest.raises(tools.InvalidToolArgument) as caught:
            _shape('get_document', {'documents': [{'document_id': 'd1'}]}, {'document_id': 'd9'})
        assert str(caught.value) == 'document d9 is not in this project'

    @pytest.mark.parametrize('name', ['get_metrics', 'list_categories', 'search_memory', 'get_company_context'])
    def test_tools_without_a_projection_return_the_body_itself(self, name):
        payload = {'pk': 'route already public', 'url': 'u'}
        assert _shape(name, payload) is payload
