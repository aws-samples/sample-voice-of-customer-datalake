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


DRAFT = 'documents_draft_prototype_revision'
GET_DRAFT = 'documents_get_prototype_draft'
APPLY_DRAFT = 'documents_apply_prototype_draft'
DISCARD_DRAFT = 'documents_discard_prototype_draft'
DRAFT_ID = 'job_0123456789abcdef'
SIGNED = 'https://cdn.example/prototypes/proj_1/drafts/job_0123456789abcdef.html?Signature=s'


class TestPrototypeDrafts:
    """The four draft tools (docs/prototype-builder.md, part 2): each is ONE route, and no signed URL leaves."""

    @pytest.mark.parametrize(('name', 'args', 'method', 'path', 'body'), [
        (DRAFT, {'document_id': 'd1', 'instruction': '  Make the summary a sticky footer  '}, 'POST',
         '/projects/proj_1/prototypes/d1/drafts', {'instruction': 'Make the summary a sticky footer'}),
        (GET_DRAFT, {'document_id': 'd1', 'draft_id': DRAFT_ID}, 'GET',
         f'/projects/proj_1/prototypes/d1/drafts/{DRAFT_ID}', None),
        (APPLY_DRAFT, {'document_id': 'd1', 'draft_id': DRAFT_ID}, 'POST',
         f'/projects/proj_1/prototypes/d1/drafts/{DRAFT_ID}/apply', {}),
        # Discard is the draft route's DELETE, never the bare job DELETE (which takes any job).
        (DISCARD_DRAFT, {'document_id': 'd1', 'draft_id': DRAFT_ID}, 'DELETE',
         f'/projects/proj_1/prototypes/d1/drafts/{DRAFT_ID}', None),
    ])
    def test_each_tool_is_its_route(self, name, args, method, path, body):
        request = _build(name, args)
        assert (request.domain, request.method, request.path, request.body, request.query) == (
            'projects', method, path, body, {})

    @pytest.mark.parametrize(('args', 'message'), [
        ({'document_id': 'd1'}, 'instruction is required'),
        ({'document_id': 'd1', 'instruction': '   '}, 'instruction is required'),
        ({'document_id': 'd1', 'instruction': 7}, 'instruction must be a string'),
        ({'document_id': 'd1', 'instruction': 'x' * 2001}, 'instruction must be at most 2000 characters'),
        ({'instruction': 'Blue'}, 'document_id is required'),
    ])
    def test_a_draft_needs_a_document_and_an_instruction_of_at_most_2000_characters(self, args, message):
        with pytest.raises(InvalidToolArgument, match=message):
            _build(DRAFT, args)

    def test_an_instruction_of_2000_characters_is_sent(self):
        assert _build(DRAFT, {'document_id': 'd1', 'instruction': 'x' * 2000}).body == {'instruction': 'x' * 2000}

    @pytest.mark.parametrize('name', [GET_DRAFT, APPLY_DRAFT, DISCARD_DRAFT])
    @pytest.mark.parametrize('draft_id', [None, '', 'job/1', '../x'])
    def test_a_draft_id_must_be_an_id(self, name, draft_id):
        with pytest.raises(InvalidToolArgument, match='draft_id is required'):
            _build(name, {'document_id': 'd1', 'draft_id': draft_id})

    @pytest.mark.parametrize('name', [DRAFT, GET_DRAFT, APPLY_DRAFT, DISCARD_DRAFT])
    def test_a_project_is_required(self, name):
        with pytest.raises(InvalidToolArgument, match='project_id is required'):
            _build(name, {'document_id': 'd1', 'draft_id': DRAFT_ID, 'instruction': 'Blue'}, project=None)

    @pytest.mark.parametrize(('name', 'write'), [(DRAFT, True), (GET_DRAFT, False), (APPLY_DRAFT, True),
                                                 (DISCARD_DRAFT, True)])
    def test_the_get_is_a_read_and_the_rest_are_writes_all_project_scoped(self, name, write):
        tool = TOOLS_BY_NAME[name]
        assert (tool.write, tool.admin_only, tool.project_scoped, tool.workspace_wide) == (write, False, True, False)

    def test_the_start_answers_the_job(self):
        payload = {'success': True, 'job_id': DRAFT_ID, 'status': 'pending', 'message': 'Prototype draft started.',
                   'pk': 'x'}
        assert TOOLS_BY_NAME[DRAFT].shape(payload, {}) == {
            'job_id': DRAFT_ID, 'status': 'pending', 'message': 'Prototype draft started.'}

    def test_the_draft_is_read_without_its_signed_preview_url(self):
        payload = {'draft_id': DRAFT_ID, 'base_document_id': 'd1', 'base_version': 3, 'instruction': 'Blue',
                   'summary': 'Home: the button is blue', 'preview_url': SIGNED, 'completed_at': 't'}
        assert TOOLS_BY_NAME[GET_DRAFT].shape(payload, {}) == {
            'draft_id': DRAFT_ID, 'base_document_id': 'd1', 'base_version': 3, 'instruction': 'Blue',
            'summary': 'Home: the button is blue', 'completed_at': 't'}

    def test_the_applied_version_is_answered_without_its_signed_url_or_storage_keys(self):
        payload = {'success': True, 'document': {
            'document_id': 'd4', 'version': 4, 'title': 'Checkout (v4)', 'prototype_url': SIGNED,
            'pk': 'PROJECT#proj_1', 'sk': 'PROTOTYPE#d4', 'edit_kind': 'revise'}}
        assert TOOLS_BY_NAME[APPLY_DRAFT].shape(payload, {}) == {'success': True, 'document': {
            'document_id': 'd4', 'version': 4, 'title': 'Checkout (v4)', 'edit_kind': 'revise'}}
        assert SIGNED not in str(TOOLS_BY_NAME[APPLY_DRAFT].shape(payload, {}))

    @pytest.mark.parametrize('payload', [None, [], 'x', {'success': True}])
    def test_an_unreadable_apply_answer_is_empty(self, payload):
        shaped = TOOLS_BY_NAME[APPLY_DRAFT].shape(payload, {})
        assert shaped['document'] == {}

    @pytest.mark.parametrize('document_id', [None, '', 'd/1'])
    def test_a_discard_needs_the_prototype_it_belongs_to(self, document_id):
        with pytest.raises(InvalidToolArgument, match='document_id is required'):
            _build(DISCARD_DRAFT, {'document_id': document_id, 'draft_id': DRAFT_ID})

    def test_the_discard_answer_is_the_route_body(self):
        assert TOOLS_BY_NAME[DISCARD_DRAFT].shape({'success': True}, {}) == {'success': True}


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
