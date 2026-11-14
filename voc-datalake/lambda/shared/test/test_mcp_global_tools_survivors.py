"""Property and example tests for what the other tests of shared/mcp_global_tools.py leave open.

Meant to sit beside test_mcp_global_tools_mutation.py (lambda/shared/test/). The rules, in words a person would use:

- A text the feedback tool sends a model is never longer than its cap: a short one goes whole, a long one is cut to
  exactly the cap with an ellipsis at the end; anything that is not text goes as it is.
- The feature-request answer is slim whatever the route sends: one item per row (a non-row anywhere in the list is
  skipped, never the end of the list), only the reviewed fields, no empty ones, every free text at most 1000
  characters; ``total`` is the route's only when it is a whole number, and ``truncated`` is true only when the route
  says exactly true.
- A tool name belongs to the area it starts with (the area and an underscore), and tools/list puts a tool with no
  area after every area.
- A feedback item whose anchor is not an object has no place.

The fixed catalogue, routes and the other projections are pinned by test_mcp_global_tools_mutation.py; the
renamed-name routing by test_mcp_global_tools_properties.py.
"""
from __future__ import annotations

from typing import Any

from hypothesis import given
from hypothesis import strategies as st

from shared import mcp_global_tools as tools
from shared.test.property_settings import PROPERTY

FEATURE_SEARCH = tools.TOOLS_BY_NAME['feature_requests_search']
TEXT_FIELDS = ('title', 'description', 'problem_summary')
TEXT_CAP = tools.MAX_FEATURE_REQUEST_TEXT_CHARS

# Feature-request rows as the search route answers them: the slim fields (some empty), plus storage keys and
# personal fields that must never reach a client.
_FIELD_VALUES = {
    'request_id': st.sampled_from(['fr_1', 'fr_2', 'fr_seat']),
    'board_id': st.sampled_from(['brd_sales', 'ideas']),
    'title': st.text(min_size=0, max_size=1100),
    'description': st.text(min_size=0, max_size=1300),
    'status': st.sampled_from(['open', 'planned', 'done']),
    'supporters': st.integers(min_value=0, max_value=500),
    'category': st.sampled_from(['booking', 'billing']),
    'sentiment': st.sampled_from(['negative', 'positive']),
    'problem_summary': st.text(min_size=0, max_size=1100),
    'created_at': st.sampled_from(['2026-05-01T10:00:00Z', '2026-06-12T08:30:00Z']),
}
SLIM_ROW = st.fixed_dictionaries({}, optional={key: st.one_of(st.none(), value)
                                               for key, value in _FIELD_VALUES.items()})
EXTRAS = st.fixed_dictionaries({}, optional={'pk': st.just('FR#fr_1'), 'email': st.just('someone@example.com'),
                                             'author_name': st.just('Someone'), 'source_url': st.just('https://x')})
ROW = st.builds(lambda slim, extra: {**slim, **extra}, SLIM_ROW, EXTRAS)
NOT_A_ROW = st.sampled_from(['odd', 7, None, ['fr_1']])
ROWS = st.lists(st.one_of(ROW, NOT_A_ROW), max_size=6)
TOTALS = st.one_of(st.none(), st.integers(min_value=0, max_value=10_000), st.booleans(), st.just('80'), st.just(4.0))
TRUNCATED = st.one_of(st.none(), st.booleans(), st.just(1), st.just('true'), st.just(0))


class TestAClippedTextNeverPassesItsCap:
    """Invariant: a text within the cap is sent whole; a longer one is exactly the cap long, its first cap - 1
    characters and an ellipsis; a value that is not text is sent as it is."""

    @PROPERTY
    @given(text=st.text(max_size=80), limit=st.integers(min_value=1, max_value=60))
    def test_a_text_is_whole_or_cut_to_exactly_the_cap(self, text: str, limit: int) -> None:
        clipped = tools._clipped(text, limit)
        if len(text) <= limit:
            assert clipped == text
        else:
            assert clipped == text[:limit - 1] + '…'
            assert isinstance(clipped, str)
            assert len(clipped) == limit

    @PROPERTY
    @given(value=st.one_of(st.none(), st.integers(), st.lists(st.text(max_size=3), max_size=3)),
           limit=st.integers(min_value=1, max_value=5))
    def test_a_value_that_is_not_text_is_sent_as_it_is(self, value: object, limit: int) -> None:
        assert tools._clipped(value, limit) is value


class TestTheFeatureRequestAnswerIsSlimWhateverTheRouteSends:
    """Invariant: one item per row, in order, with only the reviewed non-empty fields and every free text within
    1000 characters; the count is the items'; total is the route's only when it is an integer (not a boolean);
    truncated only when the route says exactly true."""

    @PROPERTY
    @given(rows=ROWS, total=TOTALS, truncated=TRUNCATED)
    def test_the_answer_is_the_slim_rows(self, rows: list, total: object, truncated: object) -> None:
        payload: dict[str, Any] = {'success': True, 'items': rows, 'total': total, 'truncated': truncated}
        answer = FEATURE_SEARCH.shape(payload, {})
        mapped = [row for row in rows if isinstance(row, dict)]
        expected = []
        for row in mapped:
            item = {key: row[key] for key in tools.FEATURE_REQUEST_FIELDS if row.get(key) is not None}
            expected.append({key: value[:TEXT_CAP] if key in TEXT_FIELDS else value for key, value in item.items()})
        whole = isinstance(total, int) and not isinstance(total, bool)
        assert answer == {'count': len(mapped), 'total': total if whole else len(mapped),
                          'truncated': truncated is True, 'items': expected}

    @PROPERTY
    @given(field=st.sampled_from(TEXT_FIELDS), extra=st.integers(min_value=1, max_value=400))
    def test_every_free_text_is_cut_at_the_cap(self, field: str, extra: int) -> None:
        answer = FEATURE_SEARCH.shape({'items': [{'request_id': 'fr_1', field: 'x' * (TEXT_CAP + extra)}]}, {})
        assert answer['items'] == [{'request_id': 'fr_1', field: 'x' * TEXT_CAP}]

    @PROPERTY
    @given(payload=st.one_of(st.none(), st.just('nope'), st.lists(st.integers(), max_size=2)))
    def test_an_unreadable_answer_is_empty(self, payload: object) -> None:
        assert FEATURE_SEARCH.shape(payload, {}) == {'count': 0, 'total': 0, 'truncated': False, 'items': []}


AREA_NAMES = st.builds(lambda area, rest: f'{area}_{rest}', st.sampled_from(tools.AREAS),
                       st.text(alphabet='abcdefghij_', max_size=10))
OTHER_NAMES = st.one_of(st.sampled_from([*tools.AREAS, 'feature_x', 'prioritise_get', 'xfeedback_search', '']),
                        st.text(alphabet='abcdefghij_', max_size=12))


def _area_by_hand(name: str) -> str | None:
    """The first area (in AREAS' order) ``name`` starts with, followed by an underscore."""
    for area in tools.AREAS:
        if name.startswith(area + '_'):
            return area
    return None


class TestAToolNameBelongsToTheAreaItStartsWith:
    """Invariant: a name's area is the one it starts with, followed by an underscore, and nothing else; a tool
    with no area ranks after every area, so tools/list shows it last."""

    @PROPERTY
    @given(name=st.one_of(AREA_NAMES, OTHER_NAMES))
    def test_the_area_is_the_prefix_and_its_underscore(self, name: str) -> None:
        assert tools.area_of(name) == _area_by_hand(name)

    @PROPERTY
    @given(name=st.one_of(AREA_NAMES, OTHER_NAMES))
    def test_the_rank_is_the_areas_place_or_after_them_all(self, name: str) -> None:
        tool = tools.GlobalTool(name, 'T', 'd', {}, lambda _a, _p: tools.RouteRequest('x', 'GET', '/'))
        area = _area_by_hand(name)
        assert tools._area_rank(tool) == (tools.AREAS.index(area) if area is not None else len(tools.AREAS))


class TestExamples:
    def test_a_bare_area_or_an_unknown_name_has_no_area(self):
        assert [tools.area_of(name) for name in ('feedback', 'zzz_search', 'radar')] == [None, None, None]
        assert tools.area_of('feature_requests_search') == 'feature_requests'

    def test_every_listed_tool_ranks_at_its_areas_place(self):
        assert [tools._area_rank(tool) for tool in tools.TOOLS] == [
            tools.AREAS.index(tools.area_of(tool.name) or '') for tool in tools.TOOLS]

    def test_a_tool_with_no_area_ranks_after_the_last_area(self):
        tool = tools.GlobalTool('misc', 'T', 'd', {}, lambda _a, _p: tools.RouteRequest('x', 'GET', '/'))
        assert tools._area_rank(tool) == len(tools.AREAS) == 9

    def test_a_non_row_before_the_rows_is_skipped_not_the_end(self):
        answer = FEATURE_SEARCH.shape({'items': ['odd', {'request_id': 'fr_1'}, {'request_id': 'fr_2'}]}, {})
        assert answer['items'] == [{'request_id': 'fr_1'}, {'request_id': 'fr_2'}]

    def test_a_text_total_and_a_truthy_truncated_are_not_taken(self):
        answer = FEATURE_SEARCH.shape({'items': [{'request_id': 'fr_1'}], 'total': '80', 'truncated': 1}, {})
        assert (answer['total'], answer['truncated']) == (1, False)

    def test_a_feedback_item_whose_anchor_is_not_an_object_has_no_place(self):
        for anchor in (None, '/checkout', ['route']):
            payload = {'groups': [{'route': '/r', 'route_unsafe': False, 'items': [
                {'item_id': 'p1', 'flagged': False, 'text': 't', 'unsafe_fields': [], 'anchor': anchor}]}]}
            shaped = tools.TOOLS_BY_NAME['documents_list_prototype_feedback'].shape(payload, {})
            assert shaped['groups'][0]['items'][0]['anchor'] == {}


class TestTheBoardSearchAndThePoolIssuerAreExact:
    """The board list is one GET of the engagement API's boards route; a search takes a limit from 1 up; the
    issuer's region is the part of the pool id before its first underscore."""

    def test_the_board_list_is_a_get_of_the_boards_route(self):
        assert tools._search_feature_requests({'boards': True}, None) == tools.RouteRequest(
            tools.DOMAIN_ENGAGEMENT, 'GET', '/feature-requests/boards')

    def test_a_search_of_one_request_is_allowed(self):
        assert tools._search_feature_requests({'limit': 1}, None).query['limit'] == 1

    def test_the_region_ends_at_the_first_underscore(self):
        assert tools.app_pool_issuer('eu-west-1_Ab_Cd') == 'https://cognito-idp.eu-west-1.amazonaws.com/eu-west-1_Ab_Cd'
