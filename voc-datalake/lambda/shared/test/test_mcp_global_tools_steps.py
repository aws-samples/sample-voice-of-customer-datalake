"""shared/mcp_global_tools_steps.py: each new MCP tool is ONE existing route, with its arguments checked."""
import pytest

from shared.mcp_global_tools import TOOLS_BY_NAME, InvalidToolArgument, RouteRequest, resolve_tool


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
        request = _build('projects_generate', args)
        assert (request.domain, request.method, request.path, request.body) == ('projects', 'POST', path, body)

    @pytest.mark.parametrize('step', ['review', 'revise'])
    def test_an_unknown_step_is_refused(self, step):
        """``revise`` is no step of its own any more: it is documents_revise_from_comments (6.10.00)."""
        with pytest.raises(InvalidToolArgument) as caught:
            _build('projects_generate', {'step': step, 'document_id': 'd1'})
        assert str(caught.value) == 'step must be one of: personas, research, prfaq, prd, prototype'

    def test_its_schema_offers_only_the_methodology_steps(self):
        properties = TOOLS_BY_NAME['projects_generate'].input_schema['properties']
        assert properties['step']['enum'] == ['personas', 'research', 'prfaq', 'prd', 'prototype']
        assert not {'document_id', 'thread_ids', 'mark_addressed'} & set(properties)

    def test_a_project_is_required(self):
        with pytest.raises(InvalidToolArgument, match='project_id is required'):
            _build('projects_generate', {'step': 'prd'}, project=None)

    def test_it_is_a_project_scoped_write(self):
        tool = TOOLS_BY_NAME['projects_generate']
        assert (tool.write, tool.admin_only, tool.project_scoped) == (True, False, True)

    def test_the_answer_keeps_the_job_and_the_methodology(self):
        payload = {'success': True, 'job_id': 'j1', 'status': 'pending', 'message': 'm',
                   'methodology': {'skipped': []}, 'extra': 1}
        assert TOOLS_BY_NAME['projects_generate'].shape(payload, {'step': 'prd'}) == {
            'step': 'prd', 'job_id': 'j1', 'status': 'pending', 'message': 'm', 'methodology': {'skipped': []}}


THREAD = 'dc_00000000000000000001abcdef'


REVISE = 'documents_revise_from_comments'
MARK = 'documents_mark_comments_addressed'


class TestReviseFromComments:
    """``documents_revise_from_comments``: start a "Revise from comments" pass (docs/document-review.md)."""

    @pytest.mark.parametrize(('args', 'body'), [
        ({'document_id': 'd1'}, {}),
        ({'document_id': 'd1', 'thread_ids': [THREAD]}, {'thread_ids': [THREAD]}),
    ])
    def test_a_pass_is_the_revise_route(self, args, body):
        request = _build(REVISE, args)
        assert (request.domain, request.method, request.path, request.body) == (
            'projects', 'POST', '/projects/proj_1/documents/d1/revise-from-comments', body)

    @pytest.mark.parametrize(('args', 'body'), [
        ({'thread_ids': []}, {'thread_ids': []}),
        ({'thread_ids': ['a/b'] * 51}, {'thread_ids': ['a/b'] * 51}),
    ])
    def test_thread_ids_go_to_the_route_unchanged(self, args, body):
        """The route checks them (its 400 is the tool's error: test_global_mcp_e2e)."""
        assert _build(REVISE, {'document_id': 'd1', **args}).body == body

    def test_the_answer_is_the_job(self):
        payload = {'success': True, 'job_id': 'j1', 'status': 'pending', 'message': 'm', 'pk': 'x', 'extra': 1}
        assert TOOLS_BY_NAME[REVISE].shape(payload, {}) == {'job_id': 'j1', 'status': 'pending', 'message': 'm'}


class TestMarkCommentsAddressed:
    """``documents_mark_comments_addressed``: mark or clear threads by a version (docs/document-review.md)."""

    @pytest.mark.parametrize(('args', 'addressed'), [({}, True), ({'addressed': True}, True),
                                                      ({'addressed': False}, False)])
    def test_it_marks_by_default_or_clears_the_threads_by_the_named_version(self, args, addressed):
        request = _build(MARK, {'document_id': 'd1', 'thread_ids': [THREAD], **args})
        assert (request.domain, request.method, request.path, request.body) == (
            'projects', 'POST', '/projects/proj_1/documents/d1/comments/addressed',
            {'thread_ids': [THREAD], 'addressed': addressed})

    def test_addressed_goes_to_the_route_unchanged(self):
        assert _build(MARK, {'document_id': 'd1', 'addressed': 'yes'}).body == {'addressed': 'yes'}

    def test_the_answer_is_the_threads_without_storage_keys(self):
        marked = {'threads': [{'comment_id': THREAD, 'pk': 'x', 'addressed': {'version': 4}}]}
        assert TOOLS_BY_NAME[MARK].shape(marked, {}) == {'threads': [{'comment_id': THREAD,
                                                                       'addressed': {'version': 4}}]}


class TestBothReviewTools:
    @pytest.mark.parametrize('name', [REVISE, MARK])
    @pytest.mark.parametrize(('args', 'message'), [
        ({}, 'document_id is required'),
        ({'document_id': 'd/1'}, 'document_id is required'),
    ])
    def test_their_arguments_are_checked(self, name, args, message):
        with pytest.raises(InvalidToolArgument, match=message):
            _build(name, args)

    @pytest.mark.parametrize('name', [REVISE, MARK])
    def test_a_project_is_required(self, name):
        with pytest.raises(InvalidToolArgument, match='project_id is required'):
            _build(name, {'document_id': 'd1'}, project=None)

    @pytest.mark.parametrize('name', [REVISE, MARK])
    def test_each_is_a_project_scoped_write_like_generate(self, name):
        tool = TOOLS_BY_NAME[name]
        assert (tool.write, tool.admin_only, tool.project_scoped, tool.workspace_wide) == (True, False, True, False)


class TestTheOldGenerateRevise:
    """Before 6.10.00 "Revise from comments" was ``generate`` with ``step: revise``: still accepted this release."""

    @pytest.mark.parametrize(('args', 'name', 'arguments'), [
        ({'step': 'revise', 'document_id': 'd1'}, REVISE, {'document_id': 'd1'}),
        ({'step': 'revise', 'document_id': 'd1', 'thread_ids': [THREAD], 'project_id': 'p'}, REVISE,
         {'document_id': 'd1', 'thread_ids': [THREAD], 'project_id': 'p'}),
        ({'step': 'revise', 'document_id': 'd1', 'thread_ids': [THREAD], 'mark_addressed': True}, MARK,
         {'document_id': 'd1', 'thread_ids': [THREAD], 'addressed': True}),
        ({'step': 'revise', 'document_id': 'd1', 'mark_addressed': False}, MARK,
         {'document_id': 'd1', 'addressed': False}),
        ({'step': 'revise', 'document_id': 'd1', 'mark_addressed': None}, REVISE, {'document_id': 'd1'}),
    ])
    def test_it_maps_to_the_review_tools(self, args, name, arguments):
        assert resolve_tool('generate', args) == (TOOLS_BY_NAME[name], arguments)

    def test_its_other_steps_map_to_projects_generate_unchanged(self):
        args = {'step': 'prd', 'brief': 'b'}
        assert resolve_tool('generate', args) == (TOOLS_BY_NAME['projects_generate'], args)


class TestGetJob:
    def test_the_route(self):
        assert _build('projects_get_job', {'job_id': 'j1'}).path == '/projects/proj_1/jobs/j1'

    def test_who_started_it_is_not_answered(self):
        shaped = TOOLS_BY_NAME['projects_get_job'].shape({'job_id': 'j1', 'status': 'completed', 'initiated_by': 'sub'}, {})
        assert shaped == {'job_id': 'j1', 'status': 'completed'}


class TestRadar:
    def test_no_brand_is_the_overview_without_settings(self):
        assert _build('radar_read', {}).path == '/radar'
        shaped = TOOLS_BY_NAME['radar_read'].shape({'brands': [{'key': 'b', 'pk': 'x'}], 'settings': {'s': 1}}, {})
        assert shaped == {'brands': [{'key': 'b'}]}

    def test_a_brand_is_its_reviews(self):
        request = _build('radar_read', {'brand': 'example-air', 'days': 30})
        assert (request.domain, request.path, request.query) == (
            'radar', '/radar/brands/example-air/reviews', {'days': 30, 'limit': 20})


class TestEditFeedback:
    def test_a_category(self):
        request = _build('feedback_edit', {'feedback_id': 'fb1', 'category': 'delivery', 'subcategory': 'late'})
        assert (request.domain, request.method, request.path, request.body) == (
            'feedback_edit', 'PUT', '/feedback/fb1/category', {'category': 'delivery', 'subcategory': 'late'})

    def test_dimensions_and_tags(self):
        request = _build('feedback_edit', {'feedback_id': 'fb1', 'dimensions': {'product': None}, 'tags': ['web']})
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
            _build('feedback_edit', args)


class TestBoards:
    def test_boards_true_lists_the_boards(self):
        assert _build('feature_requests_search', {'boards': True}).path == '/feature-requests/boards'
        shaped = TOOLS_BY_NAME['feature_requests_search'].shape({'boards': [{'board_id': 'b', 'pk': 'x'}]},
                                                                {'boards': True})
        assert shaped == {'boards': [{'board_id': 'b'}]}
