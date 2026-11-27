"""The read-only Feedback Forms tools on ``/mcp/global`` (7.104.00, tenet 4; shared/mcp_global_tools_forms.py,
docs/mcp.md) end to end: each tool's route request, delegated as ``mcp_delegate`` sends it (the minter's synthetic
claims, the token's workspace as its header), run through the real forms Lambda (api/feedback_form_handler.py) on
moto, then shaped as the tool answers.

What it pins: each tool's answer, field by field; the refusals the routes make for the minter (a workspace viewer on
the Results reads, another workspace's form, the category and source access, test responses only when asked); the
responses' paging; that no tool builds the CSV export, the test responses' delete or any other write; and the
report's AI summary, kept only on the view it was made for. (``forms_get_results`` has its own module,
test_mcp_forms_results.py.)"""
from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest
from test_feedback_form_v2 import EDITOR, OTHER, USER, V2_FORM, VIEWER, WS, _call, _create, _item, _submit
from test_feedback_form_v2 import world as v2_world

import feedback_form_handler as h
from shared import forms_v2
from shared import mcp_global_tools_forms as forms
from shared.mcp_delegate import DomainCall, build_proxy_event, synthetic_claims
from shared.mcp_global_kit import InvalidToolArgument
from shared.mcp_global_tools import TOOLS, TOOLS_BY_NAME
from shared.project_access import MCP_DELEGATED_OPS
from shared.test.source_profile_fixtures import no_source_profiles

_no_profiles = pytest.fixture(autouse=True)(no_source_profiles)
world = v2_world

FORMS_TOOLS = ('forms_list', 'forms_get', 'forms_get_results', 'forms_get_responses', 'forms_get_report')


def over_mcp(lambda_context: Any, name: str, minter: dict, args: dict, *, ws: str | None = None) -> tuple[int, Any]:
    """Tool ``name``'s call as the global MCP server makes it, for a token ``minter`` made (``ws``: minted there):
    the route's status and the tool's answer (the route's body when it refused). Also test_mcp_forms_results.py's."""
    tool = TOOLS_BY_NAME[name]
    request = tool.build(args, None)
    call = DomainCall(function_name='forms-fn', method=request.method, path=request.path, query=request.query)
    claims = synthetic_claims({'token_id': 'tok_forms', 'created_by': minter['sub']})
    response = h.lambda_handler(build_proxy_event(call, claims, ws), lambda_context)
    body = json.loads(response['body'])
    return response['statusCode'], tool.shape(body, args) if response['statusCode'] == 200 else body


def _seed(world: dict, form_id: str) -> None:
    """Three real responses (f0 to f2, 1 to 3 November), the second and third with an ``app_version``."""
    for n, hidden in enumerate(({}, {'app_version': '5.0'}, {'app_version': '5.1'})):
        world['feedback'].put_item(Item=_item(form_id, f'f{n}', f'2026-11-0{n + 1}T10:00:00',
                                              {'q_reason': {'code': 'slow'}, 'q_rate': 4, 'q_which': f'answer {n}'},
                                              ['q_reason', 'q_which', 'q_rate', 'q_contact'], form_hidden=hidden))


@pytest.fixture
def form(world, lambda_context) -> str:
    """A live deployment form with three real responses and one tagged test response (through its test link)."""
    form_id = _create(lambda_context)['form_id']
    _seed(world, form_id)
    token = _call(lambda_context, 'POST', f'/feedback-forms/{form_id}/test-link', body={})[1]['test']['token']
    assert _submit(lambda_context, form_id, {'answers': {'q_reason': {'code': 'slow'}}, 'test': token})[0] == 200
    return form_id


@pytest.fixture
def ws_form(world, lambda_context) -> str:
    """A form of the workspace ``WS``, made by its editor, with three real responses in the workspace's feedback."""
    form_id = _create(lambda_context, claims=EDITOR, ws=WS)['form_id']
    for n in range(3):
        item = _item(form_id, f'w{n}', f'2026-11-0{n + 1}T10:00:00', {'q_reason': {'code': 'slow'}},
                     ['q_reason', 'q_rate', 'q_contact'])
        world['feedback'].put_item(Item={**item, 'pk': f'WS#{WS}#SOURCE#Acme'})
    return form_id


# ── Each tool's answer ──────────────────────────────────────────────────────────────────────────────────────────

def test_the_list_names_each_form_its_status_and_the_responses_the_minter_may_see(form, lambda_context):
    off = _create(lambda_context, {**V2_FORM, 'name': 'Paused one', 'enabled': False})['form_id']
    status, answer = over_mcp(lambda_context, 'forms_list', USER, {})
    assert status == 200, answer
    by_id = {row['form_id']: row for row in answer['forms']}
    assert answer['count'] == len(answer['forms']) == 3            # (the two above and the world's version 1 form)
    listed = by_id[form]
    assert {key: listed[key] for key in ('name', 'status', 'language', 'languages', 'responses', 'last_response_at')} \
        == {'name': 'Old UI', 'status': 'live', 'language': 'pl', 'languages': ['pl', 'en'], 'responses': 3,
            'last_response_at': '2026-11-03T10:00:00'}
    assert listed['headline']['question_id'] == 'q_rate'
    assert (by_id[off]['status'], by_id[off]['responses']) == ('off', 0)
    # Never the definition, the theme, the test link's settings or who saved it: forms_get reads one form.
    assert not {'questions', 'theme', 'settings', 'updated_by', 'enabled', 'write_count'} & set(listed)


def test_a_form_reads_as_its_definition_and_routing_never_its_theme_or_test_settings(form, lambda_context):
    status, answer = over_mcp(lambda_context, 'forms_get', USER, {'form_id': form})
    assert status == 200, answer
    defined = answer['form']
    assert (defined['form_id'], defined['status'], defined['revision'], defined['response_count']) == (form, 'live', 1, 3)
    assert [question['id'] for question in defined['questions']] == ['q_reason', 'q_which', 'q_rate', 'q_contact']
    assert defined['questions'][0]['options'][0]['category'] == {'category': 'features', 'subcategory': 'missing'}
    assert [field['id'] for field in defined['hidden_fields']] == ['app_version', 'screen']
    assert [ending['id'] for ending in defined['endings']] == ['end_thanks']
    assert not {'theme', 'settings', 'updated_by', 'can_delete_test_responses', 'write_count', 'retired_ids',
                'enabled'} & set(defined)


def test_responses_are_json_newest_first_with_their_answers(form, lambda_context):
    status, page = over_mcp(lambda_context, 'forms_get_responses', USER, {'form_id': form})
    assert status == 200, page
    assert (page['form_id'], page['total'], page['next_cursor']) == (form, 3, None)
    assert [row['response_id'] for row in page['responses']] == ['f2', 'f1', 'f0']
    newest = page['responses'][0]
    assert (newest['feedback_id'], newest['is_test'], newest['hidden'], newest['answers']['q_which']) == \
        ('f2', False, {'app_version': '5.1'}, 'answer 2')
    assert set(newest) <= set(forms._RESPONSE_FIELDS)
    narrowed = over_mcp(lambda_context, 'forms_get_responses', USER,
                         {'form_id': form, 'hidden': {'app_version': '5.0'}, 'from': '2026-11-02', 'to': '2026-11-02'})
    assert [row['response_id'] for row in narrowed[1]['responses']] == ['f1']


def test_the_report_has_its_sections_and_segments_and_no_summary_when_none_was_made(form, lambda_context):
    status, report = over_mcp(lambda_context, 'forms_get_report', USER,
                               {'form_id': form, 'group_by': 'hidden.app_version'})
    assert status == 200, report
    assert (report['form_id'], report['name'], report['responses'], report['test_responses']) == (form, 'Old UI', 3, 1)
    assert [kpi['id'] for kpi in report['kpis']] == ['q_rate']
    assert report['themes'][0]['question_id'] == 'q_which'
    assert (report['segments']['by'], report['min_segment'], report['ai']) == ('hidden.app_version', 5, None)
    assert set(report) == {*forms._REPORT_FIELDS, 'ai'}


def test_a_group_by_the_form_has_not_is_the_routes_refusal(form, lambda_context):
    status, body = over_mcp(lambda_context, 'forms_get_report', USER, {'form_id': form, 'group_by': 'hidden.nope'})
    assert (status, body.get('code')) == (400, 'group_by_invalid')


# ── Paging ──────────────────────────────────────────────────────────────────────────────────────────────────────

def test_the_responses_page_through_the_routes_cursor(form, lambda_context):
    first = over_mcp(lambda_context, 'forms_get_responses', USER, {'form_id': form, 'limit': 2})[1]
    assert ([row['response_id'] for row in first['responses']], first['total'], first['next_cursor']) == \
        (['f2', 'f1'], 3, '2')
    second = over_mcp(lambda_context, 'forms_get_responses', USER,
                       {'form_id': form, 'limit': 2, 'cursor': first['next_cursor']})[1]
    assert ([row['response_id'] for row in second['responses']], second['next_cursor']) == (['f0'], None)


def test_a_page_is_capped_and_the_default_is_smaller_than_the_routes():
    build = TOOLS_BY_NAME['forms_get_responses'].build
    assert build({'form_id': 'ff_1'}, None).query['limit'] == forms.DEFAULT_RESPONSES_PAGE == 20
    assert build({'form_id': 'ff_1', 'limit': 50}, None).query['limit'] == forms.MAX_RESPONSES_PAGE == 50
    for limit in (0, 51, 100, True, '20'):
        with pytest.raises(InvalidToolArgument, match='limit must be an integer between 1 and 50'):
            build({'form_id': 'ff_1', 'limit': limit}, None)


LONG_ANSWER = ('It drops the tax "again".\n' * 200)[:forms_v2.MAX_OPEN_TEXT_CHARS]


def test_a_page_of_long_answers_fits_one_tool_result_and_names_the_cursor_for_the_rest(world, form, lambda_context):
    """(Q1, 7.104.00) 50 responses with a 5,000-character answer each (JSON escapes its quotes and line ends, so each is
    over 5,400 characters of text) pass the handler's 200,000-character cut together, which would drop the page's
    structured content and, with ``next_cursor`` last, the cursor too. The page keeps what fits, its ``total`` and
    ``next_cursor`` first, and the cursor names the first response left out: every response is read once."""
    for n in range(50):
        world['feedback'].put_item(Item=_item(form, f'long{n:02d}', f'2026-11-10T10:{n:02d}:00',
                                              {'q_reason': {'code': 'slow'}, 'q_which': LONG_ANSWER},
                                              ['q_reason', 'q_which']))
    read: list[str] = []
    totals: set[int] = set()
    cursor: str | None = None
    pages = 0
    while pages < 5:
        pages += 1
        status, page = over_mcp(lambda_context, 'forms_get_responses', USER,
                                {'form_id': form, 'limit': 50, **({'cursor': cursor} if cursor else {})})
        assert status == 200, page
        text = json.dumps(page, default=str, ensure_ascii=False)
        assert len(text) <= forms.MAX_RESULT_TEXT_CHARS
        assert list(page)[:4] == ['form_id', 'revision', 'total', 'next_cursor']
        read += [row['response_id'] for row in page['responses']]
        totals.add(page['total'])
        cursor = page['next_cursor']
        if cursor is None:
            break
    assert read == [f'long{n:02d}' for n in reversed(range(50))] + ['f2', 'f1', 'f0']
    assert (len(read), len(set(read)), totals, pages) == (53, 53, {53}, 2)   # (the first page shorter than 50)


def test_a_trimmed_page_names_its_cursor_from_the_offset_asked_and_keeps_one_response_past_the_cap():
    row = {'response_id': 'r', 'answers': {'q_which': 'x' * 60_000}}
    payload = {'form_id': 'ff_1', 'total': 90, 'responses': [dict(row, response_id=f'r{n}') for n in range(5)],
               'next_cursor': '45'}
    page = forms._responses(payload, {'cursor': '40'})
    assert ([row['response_id'] for row in page['responses']], page['next_cursor']) == (['r0', 'r1', 'r2'], '43')
    assert forms._responses({**payload, 'responses': payload['responses'][:3]}, {'cursor': '40'})['next_cursor'] == '45'
    alone = forms._responses({'responses': [{'response_id': 'big', 'answers': {'q': 'x' * 250_000}}, row],
                              'next_cursor': None}, {})
    assert ([row['response_id'] for row in alone['responses']], alone['next_cursor']) == (['big'], '1')


@pytest.mark.parametrize('cursor', ['-1', '2x', '12345678', '²', 7, '../2'])
def test_a_cursor_that_no_page_named_is_refused_before_the_route(cursor):
    with pytest.raises(InvalidToolArgument, match='cursor must be the next_cursor'):
        TOOLS_BY_NAME['forms_get_responses'].build({'form_id': 'ff_1', 'cursor': cursor}, None)


# ── Access: as the minter, never more ───────────────────────────────────────────────────────────────────────────

def test_test_responses_are_read_only_when_asked(form, lambda_context):
    page = over_mcp(lambda_context, 'forms_get_responses', USER, {'form_id': form, 'include_test': True})[1]
    assert page['total'] == 4
    # (one test response, which is no feedback item: it has no feedback_id)
    assert ['feedback_id' in row for row in page['responses'] if row['is_test']] == [False]
    report = over_mcp(lambda_context, 'forms_get_report', USER, {'form_id': form, 'include_test': True})[1]
    assert report['responses'] == 4


def test_the_minters_source_and_category_access_apply_to_every_read(world, form, lambda_context):
    """A restricted ``feedback_form`` source: no response, real or test, and the list counts none; then granted the
    source but not the responses' category (``features``): still none, the test one judged under the form's own."""
    world['aggregates'].put_item(Item={'pk': 'SETTINGS#sources', 'sk': 'config',
                                       'sources': [{'id': 'feedback_form', 'restricted': True}]})
    for granted in (None, {'sources': ['feedback_form'], 'categories': ['billing']}):
        if granted:
            world['aggregates'].put_item(Item={'pk': 'CATEGORY_ACCESS', 'sk': f"USER#{USER['sub']}", **granted})
        page = over_mcp(lambda_context, 'forms_get_responses', USER, {'form_id': form, 'include_test': True})[1]
        report = over_mcp(lambda_context, 'forms_get_report', USER, {'form_id': form, 'include_test': True})[1]
        listed = next(row for row in over_mcp(lambda_context, 'forms_list', USER, {})[1]['forms']
                      if row['form_id'] == form)
        assert (page['total'], report['responses'], report['test_responses'], listed['responses']) == (0, 0, 0, 0)


def test_a_workspace_viewer_lists_and_reads_a_form_but_not_its_responses_or_report(ws_form, lambda_context):
    """The routes' own rule: any member reads the forms; the Results reads are its editors' and admins'."""
    listed = over_mcp(lambda_context, 'forms_list', VIEWER, {}, ws=WS)[1]
    assert [row['form_id'] for row in listed['forms']] == [ws_form]
    assert over_mcp(lambda_context, 'forms_get', VIEWER, {'form_id': ws_form}, ws=WS)[0] == 200
    for name in ('forms_get_responses', 'forms_get_report', 'forms_get_results'):
        assert over_mcp(lambda_context, name, VIEWER, {'form_id': ws_form}, ws=WS)[0] == 403, name
    editors = over_mcp(lambda_context, 'forms_get_responses', EDITOR, {'form_id': ws_form}, ws=WS)[1]
    assert editors['total'] == 3


def test_another_workspaces_form_is_not_found_either_way(form, ws_form, lambda_context):
    """A token minted in the workspace never reaches the deployment's form, a deployment token never the
    workspace's, and a minter who is no member of the workspace reaches nothing in it (the route's one 404)."""
    for name in ('forms_get', 'forms_get_responses', 'forms_get_report'):
        assert over_mcp(lambda_context, name, EDITOR, {'form_id': form}, ws=WS)[0] == 404, name
        assert over_mcp(lambda_context, name, USER, {'form_id': ws_form})[0] == 404, name
        assert over_mcp(lambda_context, name, OTHER, {'form_id': ws_form}, ws=WS)[0] == 404, name
    assert ws_form not in {row['form_id'] for row in over_mcp(lambda_context, 'forms_list', USER, {})[1]['forms']}
    assert over_mcp(lambda_context, 'forms_list', OTHER, {}, ws=WS)[0] == 404


def test_no_forms_tool_needs_an_admin_or_carries_a_delegated_operation():
    """They are reads any minter's unpinned token gets (the route decides), so the handler adds no ``voc:mcp_op``
    claim."""
    for name in FORMS_TOOLS:
        tool = TOOLS_BY_NAME[name]
        assert (tool.write, tool.admin_only, tool.engineering_op, tool.needs_write_token) == (False, False, '', False)
        assert name not in MCP_DELEGATED_OPS


@pytest.mark.parametrize('name', FORMS_TOOLS)
def test_a_project_pinned_token_is_neither_offered_a_forms_tool_nor_let_call_it(name):
    # (S1, 7.104.00 review) The forms are the scope's, never one project's: a pinned token, even a read-only one, paged
    # through every form's responses (contact answers included) and read validation forms of other projects.
    import mcp_global_handler as mcp
    tool, row = TOOLS_BY_NAME[name], {'token_id': 'tok_forms', 'scope': 'read', 'created_by': USER['sub']}
    pinned = {**row, 'project_id': 'proj_a'}
    assert (tool.workspace_wide, mcp._may_offer(tool, row), mcp._may_offer(tool, pinned)) == (True, True, False)
    mcp._check_allowed(mcp.ToolCall(tool, ARGS[name], None), row)
    with pytest.raises(mcp.ToolDenied, match='scoped to one project'):
        mcp._check_allowed(mcp.ToolCall(tool, ARGS[name], None), pinned)


# ── Never the CSV, never a write ────────────────────────────────────────────────────────────────────────────────

ARGS: dict[str, dict] = {
    'forms_list': {}, 'forms_get': {'form_id': 'ff_1'},
    'forms_get_results': {'form_id': 'ff_1', 'include_test': True, 'hidden': {'customer': 'B'}},
    'forms_get_responses': {'form_id': 'ff_1', 'include_test': True, 'cursor': '50', 'limit': 10},
    'forms_get_report': {'form_id': 'ff_1', 'group_by': 'q_reason', 'include_test': True},
}
ROUTES = {'forms_list': '/feedback-forms', 'forms_get': '/feedback-forms/ff_1',
          'forms_get_results': '/feedback-forms/ff_1/results', 'forms_get_responses': '/feedback-forms/ff_1/responses',
          'forms_get_report': '/feedback-forms/ff_1/report'}


@pytest.mark.parametrize('name', FORMS_TOOLS)
def test_every_forms_tool_is_one_get_and_never_asks_for_a_file(name):
    extra = {'format': 'csv', 'layout': 'detailed', 'ids': 'true', 'test': 'true', 'include_test': 'only'}
    request = TOOLS_BY_NAME[name].build(ARGS[name], None)
    assert (request.domain, request.method, request.path, request.body) == ('forms', 'GET', ROUTES[name], None)
    assert not {'format', 'layout', 'ids', 'test'} & set(request.query)
    # (an argument the schema does not name is never sent: a client cannot turn a read into the CSV or a delete)
    widened = {**ARGS[name], **{key: value for key, value in extra.items() if key != 'include_test'}}
    assert TOOLS_BY_NAME[name].build(widened, None) == request
    assert TOOLS_BY_NAME[name].input_schema['additionalProperties'] is False


def test_include_test_is_true_or_false_never_only():
    with pytest.raises(InvalidToolArgument, match='include_test must be true or false'):
        TOOLS_BY_NAME['forms_get_responses'].build({'form_id': 'ff_1', 'include_test': 'only'}, None)


def test_the_forms_routes_a_tool_reaches_are_exactly_the_five_reads():
    reached = {(request.method, request.path) for request in
               (tool.build(ARGS[tool.name], None) for tool in TOOLS if tool.name.startswith('forms_'))}
    assert reached == {('GET', path) for path in ROUTES.values()}
    assert not any(tool.write for tool in TOOLS if tool.name.startswith('forms_'))


def test_the_csv_the_route_serves_is_never_what_the_tool_gets(form, lambda_context):
    """The tool's request is the JSON page even where a person's same route answers a CSV file."""
    status, response = _call(lambda_context, 'GET', f'/feedback-forms/{form}/responses', claims=USER,
                             query={'format': 'csv'}, raw=True)
    assert (status, response['multiValueHeaders']['Content-Type']) == (200, ['text/csv; charset=utf-8'])
    status, page = over_mcp(lambda_context, 'forms_get_responses', USER, {'form_id': form, 'format': 'csv'})
    assert (status, page['total']) == (200, 3)


# ── The report's AI summary: only on its own view ───────────────────────────────────────────────────────────────

def _store_summary(world: dict, form_id: str, filters: dict[str, str], read: tuple[str, ...] = ('f0', 'f1')) -> None:
    """A stored AI summary (shared/forms_v2_report_ai.py's row) made on ``filters``, having read ``read``."""
    world['aggregates'].put_item(Item={
        'pk': 'FEEDBACK_FORM', 'sk': f'FORMREPORT#{form_id}#rpt_1', 'form_id': form_id, 'report_id': 'rpt_1',
        'created_at': '2026-11-04T09:00:00+00:00', 'created_by': {'sub': ADMIN_SUB, 'kind': 'person'},
        'reason': 'ai_summary', 'responses_counted': len(read), 'last_response_at': '2026-11-03T10:00:00',
        'filters': filters, 'response_ids': list(read),
        'themes': [{'label': 'Slow pages', 'count': 2, 'sentiment': 'negative', 'quote_ids': list(read)}],
        'ai': {'model': 'utility', 'prompt_version': 1, 'summary': 'People find it slow.'}})


ADMIN_SUB = 'sub-ad'
SINCE_2000 = '2000-01-01T00:00:00.000Z'


@pytest.mark.parametrize(('stored', 'args'), [
    ({'days': 'all'}, {}),
    ({'days': '30', 'from': SINCE_2000}, {'days': 30}),
    ({'days': 'all', 'hidden.app_version': '5.0'}, {'hidden': {'app_version': '5.0'}}),
], ids=['all-time', 'last-30-days', 'a-hidden-value'])
def test_a_summary_made_for_this_view_is_answered_under_its_model_text_label(world, form, lambda_context, stored, args):
    _store_summary(world, form, stored)
    ai = over_mcp(lambda_context, 'forms_get_report', USER, {'form_id': form, **args})[1]['ai']
    assert (ai['label'], ai['report_id'], ai['summary'], ai['filters']) == \
        (forms.SUMMARY_LABEL, 'rpt_1', 'People find it slow.', stored)
    assert ai['themes'][0]['label'] == 'Slow pages'
    assert 'created_by' not in ai


@pytest.mark.parametrize(('stored', 'args'), [
    ({'days': '30', 'from': SINCE_2000}, {}),
    ({'days': 'all'}, {'days': 7}),
    ({'days': 'all', 'hidden.app_version': '5.0'}, {}),
    ({'days': 'all'}, {'hidden': {'app_version': '5.0'}}),
    ({'days': 'all', 'language': 'pl'}, {}),
    ({'days': 'all', 'ending': 'end_thanks'}, {}),
    ({'days': 'all', 'hidden.Call Ana on 555 0100': 'x', 'Call Bo': 'y'}, {}),
], ids=['range', 'all-time-asked-7', 'hidden-missing', 'hidden-extra', 'a-language', 'an-ending',
        'names-an-editor-typed'])
def test_a_summary_made_for_another_view_says_so_and_nothing_of_that_view(world, form, lambda_context, stored, args):
    # (C2, F1 and S2, 7.104.00 review) Only that it was made for another view: neither a filter's value (a
    # hidden value of a view the caller did not ask for) nor its name (the AI report's start stores any name of up to
    # 64 characters an editor sends, free text) is the answer's.
    _store_summary(world, form, stored)
    ai = over_mcp(lambda_context, 'forms_get_report', USER, {'form_id': form, **args})[1]['ai']
    assert ai == {'report_id': 'rpt_1', 'created_at': '2026-11-04T09:00:00+00:00', 'other_view': True}
    assert not {*stored, *stored.values()} & set(json.dumps(ai).split('"'))


def test_a_summary_withheld_from_the_minter_stays_withheld(world, form, lambda_context):
    """It read a response the minter cannot see (here: one of another form), so its labels could describe it."""
    _store_summary(world, form, {'days': 'all'}, read=('f0', 'someone_elses'))
    ai = over_mcp(lambda_context, 'forms_get_report', USER, {'form_id': form})[1]['ai']
    assert ai == {'report_id': 'rpt_1', 'created_at': '2026-11-04T09:00:00+00:00', 'withheld': 'access'}


def test_the_reports_days_are_the_report_pages_ranges_sent_as_its_from():
    build = TOOLS_BY_NAME['forms_get_report'].build
    assert build({'form_id': 'ff_1'}, None).query['from'] is None
    before = datetime.now(UTC) - timedelta(days=30)
    sent = datetime.fromisoformat(build({'form_id': 'ff_1', 'days': 30}, None).query['from'])
    assert before <= sent <= datetime.now(UTC) - timedelta(days=30) + timedelta(seconds=5)
    # (C1, 7.104.00) never a float: 7.0 equals 7, but its view, '7.0', would never match the stored summary's '7'
    for days in (1, 14, 365, -7, True, False, '30', 'all', 7.0, 0.0, None):
        with pytest.raises(InvalidToolArgument, match='days must be one of: 0, 7, 30, 90'):
            build({'form_id': 'ff_1', 'days': days}, None)


def test_a_summary_made_for_the_last_7_days_is_this_views_only_for_the_integer_7(world, form, lambda_context):
    _store_summary(world, form, {'days': '7', 'from': SINCE_2000})
    assert over_mcp(lambda_context, 'forms_get_report', USER, {'form_id': form, 'days': 7})[1]['ai']['summary'] == \
        'People find it slow.'
    with pytest.raises(InvalidToolArgument, match='days must be one of'):
        over_mcp(lambda_context, 'forms_get_report', USER, {'form_id': form, 'days': 7.0})


@pytest.mark.parametrize(('args', 'message'), [
    ({'form_id': 'ff_1', 'group_by': 'x' * 101}, 'group_by must be at most 100 characters'),
    ({'form_id': 'ff_1', 'group_by': 7}, 'group_by must be a string'),
    ({'form_id': 'ff_1', 'hidden': {'Customer': 'B'}}, 'hidden must map'),
    ({'form_id': '../ff_1'}, 'form_id is required'),
])
def test_the_report_refuses_what_it_cannot_send(args, message):
    with pytest.raises(InvalidToolArgument, match=message):
        TOOLS_BY_NAME['forms_get_report'].build(args, None)


@pytest.mark.parametrize('payload', [None, [], 'x', {'forms': 'x', 'stats': []}])
def test_an_unreadable_answer_shapes_to_empty_rows(payload):
    assert forms._form_list(payload, {}) == {'count': 0, 'forms': []}
    assert forms._responses(payload, {}) == {'next_cursor': None, 'responses': []}
    assert forms._report(payload, {}) == {'ai': None}
    assert forms._form_definition(payload, {}) == {'form': {'status': 'off'}}
