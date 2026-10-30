"""More of the app through the existing global MCP tools (shared/mcp_global_tools.py, docs/mcp.md → Tools).

* ``search_feedback urgent=true`` forwards ``urgent=1`` (shared/item_filters.py) to whichever route the
  query picks, with every other filter kept;
* ``get_metrics view=github`` reads ``/metrics/github`` and ``view=entities`` reads ``/feedback/entities``
  (the filter values in use), both with the usual filters;
* ``get_feedback include_similar=true`` asks for ONE follow-up read of ``/feedback/{id}/similar``, bounded
  to ``MAX_SIMILAR`` slim rows whose text is cut at ``MAX_SIMILAR_TEXT_CHARS``.
"""
from __future__ import annotations

import pytest

from shared import mcp_global_tools as tools

FEEDBACK = tools.TOOLS_BY_NAME['search_feedback']
GET_FEEDBACK = tools.TOOLS_BY_NAME['get_feedback']
METRICS = tools.TOOLS_BY_NAME['get_metrics']


class TestUrgentFeedback:
    @pytest.mark.parametrize(('args', 'path'), [
        ({'urgent': True}, '/feedback'),
        ({'urgent': True, 'query': 'late bags'}, '/feedback/search'),
    ])
    def test_urgent_is_forwarded_on_both_routes_with_the_other_filters(self, args, path):
        request = FEEDBACK.build({**args, 'category': 'baggage', 'tag': 'vip'}, None)
        assert request.path == path
        assert (request.query['urgent'], request.query['category'], request.query['tag']) == ('1', 'baggage', 'vip')

    @pytest.mark.parametrize('args', [{}, {'urgent': False}])
    def test_not_urgent_sends_no_filter(self, args):
        assert FEEDBACK.build(args, None).query['urgent'] is None

    @pytest.mark.parametrize('value', ['true', 1, None])
    def test_urgent_must_be_a_boolean(self, value):
        with pytest.raises(tools.InvalidToolArgument, match=r'^urgent must be true or false$'):
            FEEDBACK.build({'urgent': value}, None)


class TestNewMetricViews:
    def test_github_reads_the_github_breakdown(self):
        request = METRICS.build({'view': 'github', 'days': 90, 'tag': 'crash'}, None)
        assert (request.domain, request.method, request.path) == ('metrics', 'GET', '/metrics/github')
        assert request.query == {'days': 90, 'source': None, 'channel': None, 'tag': 'crash', 'dims': None}

    def test_entities_reads_the_filter_values(self):
        request = METRICS.build({'view': 'entities', 'source': 'webscraper'}, None)
        assert (request.domain, request.method, request.path) == ('metrics', 'GET', '/feedback/entities')
        assert request.query['source'] == 'webscraper'

    def test_the_old_views_keep_their_paths(self):
        assert METRICS.build({'view': 'personas'}, None).path == '/metrics/personas'


class TestSimilarFeedback:
    def test_no_follow_up_unless_asked(self):
        assert GET_FEEDBACK.follow_ups({'feedback_id': 'f_1'}) == ()
        assert GET_FEEDBACK.follow_ups({'feedback_id': 'f_1', 'include_similar': False}) == ()

    def test_one_bounded_follow_up_when_asked(self):
        (follow,) = GET_FEEDBACK.follow_ups({'feedback_id': 'f_1', 'include_similar': True})
        assert follow.key == 'similar'
        assert (follow.request.domain, follow.request.method, follow.request.path, follow.request.query) == (
            'metrics', 'GET', '/feedback/f_1/similar', {'limit': tools.MAX_SIMILAR})

    def test_include_similar_is_validated_by_the_main_build(self):
        with pytest.raises(tools.InvalidToolArgument, match=r'^include_similar must be true or false$'):
            GET_FEEDBACK.build({'feedback_id': 'f_1', 'include_similar': 'yes'}, None)
        assert GET_FEEDBACK.build({'feedback_id': 'f_1', 'include_similar': True}, None).path == '/feedback/f_1'

    def test_similar_rows_are_slim_bounded_and_cut(self):
        (follow,) = GET_FEEDBACK.follow_ups({'feedback_id': 'f_1', 'include_similar': True})
        row = {'feedback_id': 'f_2', 'pk': 'SOURCE#web', 'sk': 'FEEDBACK#f_2', 'source_url': 'https://x',
               'category': 'baggage', 'sentiment_label': 'negative', 'rating': 2, 'title': None,
               'original_text': 'x' * (tools.MAX_SIMILAR_TEXT_CHARS + 10)}
        shaped = follow.shape({'items': [row, 'not a row'] + [dict(row, feedback_id=f'f_{n}') for n in range(10)]})
        assert len(shaped) == tools.MAX_SIMILAR  # the non-row is skipped and does not take a slot
        assert shaped[0] == {'feedback_id': 'f_2', 'category': 'baggage', 'sentiment_label': 'negative',
                             'rating': 2, 'text': 'x' * tools.MAX_SIMILAR_TEXT_CHARS}

    def test_an_unreadable_similar_body_is_empty(self):
        (follow,) = GET_FEEDBACK.follow_ups({'feedback_id': 'f_1', 'include_similar': True})
        assert follow.shape('nope') == []
        assert follow.shape({'items': [{'feedback_id': 'f_3', 'original_text': 42}]}) == [{'feedback_id': 'f_3'}]

    def test_other_tools_have_no_follow_ups(self):
        assert all(tool.follow_ups({'include_similar': True}) == () for tool in tools.TOOLS if tool is not GET_FEEDBACK)
