"""shared/mcp_global_tools_steps.py: each new MCP tool is ONE existing route, with its arguments checked."""
import pytest

from shared.mcp_global_tools import TOOLS_BY_NAME, InvalidToolArgument, RouteRequest


def _build(name, args, project: str | None = 'proj_1') -> RouteRequest:
    return TOOLS_BY_NAME[name].build(args, project)


class TestGenerate:
    @pytest.mark.parametrize(('args', 'path', 'body'), [
        ({'step': 'personas', 'count': 4}, '/projects/proj_1/personas/generate',
         {'persona_count': 4, 'keep_existing_personas': True}),
        ({'step': 'research', 'brief': 'Why do Example Air customers churn?'}, '/projects/proj_1/research',
         {'question': 'Why do Example Air customers churn?'}),
        ({'step': 'prfaq', 'title': 'Seat map', 'brief': 'A live seat map'}, '/projects/proj_1/document',
         {'doc_type': 'prfaq', 'title': 'Seat map', 'feature_idea': 'A live seat map'}),
        ({'step': 'prd'}, '/projects/proj_1/document', {'doc_type': 'prd'}),
        ({'step': 'prototype', 'title': 'Proto'}, '/projects/proj_1/build-prototype', {'title': 'Proto'}),
    ])
    def test_each_step_is_its_route(self, args, path, body):
        request = _build('generate', args)
        assert (request.domain, request.method, request.path, request.body) == ('projects', 'POST', path, body)

    def test_an_unknown_step_is_refused(self):
        with pytest.raises(InvalidToolArgument, match='step must be one of'):
            _build('generate', {'step': 'review'})

    def test_a_project_is_required(self):
        with pytest.raises(InvalidToolArgument, match='project_id is required'):
            _build('generate', {'step': 'prd'}, project=None)

    def test_it_is_a_project_scoped_write(self):
        tool = TOOLS_BY_NAME['generate']
        assert (tool.write, tool.admin_only, tool.project_scoped) == (True, False, True)

    def test_the_answer_keeps_the_job_and_the_methodology(self):
        payload = {'success': True, 'job_id': 'j1', 'status': 'pending', 'message': 'm',
                   'methodology': {'skipped': []}, 'extra': 1}
        assert TOOLS_BY_NAME['generate'].shape(payload, {'step': 'prd'}) == {
            'step': 'prd', 'job_id': 'j1', 'status': 'pending', 'message': 'm', 'methodology': {'skipped': []}}


class TestGetJob:
    def test_the_route(self):
        assert _build('get_job', {'job_id': 'j1'}).path == '/projects/proj_1/jobs/j1'

    def test_who_started_it_is_not_answered(self):
        shaped = TOOLS_BY_NAME['get_job'].shape({'job_id': 'j1', 'status': 'completed', 'initiated_by': 'sub'}, {})
        assert shaped == {'job_id': 'j1', 'status': 'completed'}


class TestRadar:
    def test_no_brand_is_the_overview_without_settings(self):
        assert _build('read_radar', {}).path == '/radar'
        shaped = TOOLS_BY_NAME['read_radar'].shape({'brands': [{'key': 'b', 'pk': 'x'}], 'settings': {'s': 1}}, {})
        assert shaped == {'brands': [{'key': 'b'}]}

    def test_a_brand_is_its_reviews(self):
        request = _build('read_radar', {'brand': 'example-air', 'days': 30})
        assert (request.domain, request.path, request.query) == (
            'radar', '/radar/brands/example-air/reviews', {'days': 30, 'limit': 20})


class TestEditFeedback:
    def test_a_category(self):
        request = _build('edit_feedback', {'feedback_id': 'fb1', 'category': 'delivery', 'subcategory': 'late'})
        assert (request.domain, request.method, request.path, request.body) == (
            'feedback_edit', 'PUT', '/feedback/fb1/category', {'category': 'delivery', 'subcategory': 'late'})

    def test_dimensions_and_tags(self):
        request = _build('edit_feedback', {'feedback_id': 'fb1', 'dimensions': {'product': None}, 'tags': ['web']})
        assert (request.path, request.body) == ('/feedback/fb1/dimensions', {'dimensions': {'product': None},
                                                                             'tags': ['web']})

    @pytest.mark.parametrize('args', [
        {'feedback_id': 'fb1'},
        {'feedback_id': 'fb1', 'category': 'a', 'tags': ['x']},
        {'feedback_id': 'fb1', 'dimensions': {'product': 7}},
        {'feedback_id': 'fb1', 'tags': 'web'},
    ])
    def test_one_kind_of_change_with_valid_values(self, args):
        with pytest.raises(InvalidToolArgument):
            _build('edit_feedback', args)


class TestBoards:
    def test_boards_true_lists_the_boards(self):
        assert _build('search_feature_requests', {'boards': True}).path == '/feature-requests/boards'
        shaped = TOOLS_BY_NAME['search_feature_requests'].shape({'boards': [{'board_id': 'b', 'pk': 'x'}]},
                                                                {'boards': True})
        assert shaped == {'boards': [{'board_id': 'b'}]}
