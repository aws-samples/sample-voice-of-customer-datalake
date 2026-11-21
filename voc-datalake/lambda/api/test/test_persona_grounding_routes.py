"""The personas' evidence routes and the focus group document, through the projects API's handler (7.64.00).

The pack and the freshness count are reads (view), the refresh a write (edit), each gated by the project middleware
before the route; the caller's category scope is the request's own. A focus group saved through
``POST /projects/{id}/documents`` is always synthetic, its derivation validated and its citations kept to it.
"""
from __future__ import annotations

import json
from typing import Any
from unittest.mock import patch

import pytest
from test_project_permissions import EDITOR, OWNER, STRANGER, VIEWER, _member

PACK_PATH = '/projects/p1/personas/evidence-pack'
FRESHNESS_PATH = '/projects/p1/personas/persona_1/evidence-freshness'
REFRESH_PATH = '/projects/p1/personas/persona_1/evidence/refresh'


class FakeTable:
    """The projects table's META read for the gate (a private project with an editor and a viewer)."""

    def __init__(self) -> None:
        self.meta = {
            'pk': 'PROJECT#p1', 'sk': 'META', 'project_id': 'p1', 'name': 'P', 'visibility': 'private',
            'owner_sub': OWNER['sub'], 'owner_username': 'olivia', 'owner_email': OWNER['email'],
            'members': {EDITOR['sub']: _member(EDITOR, 'editor'), VIEWER['sub']: _member(VIEWER, 'viewer')},
        }

    def get_item(self, **kwargs: Any) -> dict:
        key = kwargs['Key']
        return {'Item': self.meta} if key == {'pk': 'PROJECT#p1', 'sk': 'META'} else {}


@pytest.fixture
def call(api_gateway_event, lambda_context):
    import projects_handler

    table = FakeTable()

    def _call(claims: dict, method: str, path: str, body: dict | None = None) -> tuple[int, dict, dict]:
        event = api_gateway_event(method=method, path=path, body=body, claims=claims)
        with patch.object(projects_handler, 'get_projects_table', return_value=table), \
                patch('shared.persona_grounding_routes.get_projects_table', return_value=table), \
                patch('shared.persona_grounding_routes.get_feedback_table', return_value=object()), \
                patch('shared.persona_grounding_routes.get_aggregates_table', return_value=None), \
                patch('shared.persona_grounding_routes.category_gate.scope_for_event') as scope, \
                patch('shared.persona_grounding.evidence_pack', return_value={'personas': []}) as pack, \
                patch('shared.persona_grounding.evidence_freshness', return_value={'count': 2}) as fresh, \
                patch('shared.persona_grounding.refresh_evidence', return_value={'added': 1}) as refresh:
            response = projects_handler.lambda_handler(event, lambda_context)
        return response['statusCode'], json.loads(response['body']), {
            'pack': pack, 'fresh': fresh, 'refresh': refresh, 'scope': scope}

    return _call


class TestLevels:
    def test_a_viewer_reads_the_pack_with_their_own_scope(self, call):
        status, body, mocks = call(VIEWER, 'POST', PACK_PATH, {'persona_ids': ['persona_1'], 'question': 'Why?'})
        assert status == 200, body
        reader, project_id, persona_ids, question, limit = mocks['pack'].call_args.args
        assert (project_id, persona_ids, question, limit) == ('p1', ['persona_1'], 'Why?', 8)
        assert reader.scope is mocks['scope'].return_value
        assert mocks['scope'].call_args.args[0]['requestContext']['authorizer']['claims']['sub'] == VIEWER['sub']

    def test_a_viewer_reads_the_freshness_count(self, call):
        status, body, _ = call(VIEWER, 'GET', FRESHNESS_PATH)
        assert (status, body) == (200, {'count': 2})

    def test_a_viewer_may_not_refresh(self, call):
        status, body, mocks = call(VIEWER, 'POST', REFRESH_PATH)
        assert status == 403
        assert body['error'] == 'You do not have permission to edit this project'
        mocks['refresh'].assert_not_called()

    def test_an_editor_refreshes_as_themselves(self, call):
        status, body, mocks = call(EDITOR, 'POST', REFRESH_PATH)
        assert (status, body) == (200, {'success': True, 'added': 1})
        _reader, project_id, persona_id, actor = mocks['refresh'].call_args.args
        assert (project_id, persona_id, actor) == ('p1', 'persona_1', {'sub': EDITOR['sub'], 'kind': 'user'})

    @pytest.mark.parametrize(('method', 'path'), [('POST', PACK_PATH), ('GET', FRESHNESS_PATH), ('POST', REFRESH_PATH)])
    def test_a_stranger_gets_the_one_404(self, call, method, path):
        status, body, mocks = call(STRANGER, method, path, {'persona_ids': ['persona_1']})
        assert (status, body) == (404, {'success': False, 'error': 'Project not found'})
        assert not any(mock.called for name, mock in mocks.items() if name != 'scope')

    def test_a_malformed_pack_request_is_400_before_any_read(self, call):
        status, _body, mocks = call(OWNER, 'POST', PACK_PATH, {'persona_ids': []})
        assert status == 400
        mocks['pack'].assert_not_called()


class TestFocusGroupDocument:
    #: The reviews the saver may see (shared/persona_grounding.py visible_ids, here as a set).
    VISIBLE = frozenset({'fb1', 'fb2'})

    def _create(self, body: dict, scope: dict | None = None) -> dict:
        import projects
        captured: dict = {}
        seen: list = []

        def put(_table, _project_id, _prefix, build, **_kwargs):
            captured.update(build('doc_1'))
            return captured

        def visible(reader, ids):
            seen.append(reader.scope)
            return [one for one in dict.fromkeys(ids) if one in self.VISIBLE]
        with patch.object(projects, 'projects_table', object()), \
                patch.object(projects, 'create_counted_project_child', side_effect=put), \
                patch.object(projects.persona_grounding, 'visible_ids', side_effect=visible):
            document = projects.create_document('p1', body, creator_sub='owner-sub', category_scope=scope)['document']
        self.scopes = seen
        return document

    def _body(self, **extra: Any) -> dict:
        return {
            'document_type': 'focus_group', 'title': 'Focus group: delivery', 'synthetic': False,
            'content': 'Ada: late again [fb:fb1]. Bea: invented [fb:nope]. Cy: hidden [fb:fb9].',
            'derivation': {'persona_ids': ['p_a', 'p_b'], 'feedback_ids': ['fb1', 'fb1', 'fb9'], 'rounds': 2,
                           'document_ids': ['d1'], 'library_item_ids': []},
            **extra,
        }

    def test_is_always_synthetic_with_its_derivation_and_lineage(self):
        document = self._create(self._body())
        assert document['document_type'] == 'focus_group'
        assert document['synthetic'] is True
        assert document['derivation'] == {'kind': 'focus_group', 'persona_ids': ['p_a', 'p_b'], 'document_ids': ['d1'],
                                          'library_item_ids': [], 'rounds': 2, 'feedback_count': 1}
        # Only the cited reviews the saver may see: fb9 is not theirs to cite.
        assert document['input_feedback_ids'] == ['fb1']
        assert document['created_by_sub'] == 'owner-sub'
        assert document['sk'] == 'DOC#doc_1'

    def test_a_citation_it_does_not_keep_is_removed(self):
        assert self._create(self._body())['content'] == 'Ada: late again [fb:fb1]. Bea: invented . Cy: hidden .'

    def test_removing_one_citation_never_leaves_another(self):
        content = self._create(self._body(content='Nested [fb:[fb:nope]fb2] and [fb:[fb:[fb:x]y]z].'))['content']
        assert '[fb:' not in content

    def test_the_saver_s_scope_decides_what_is_kept(self):
        scope = {'all': False, 'categories': ['billing']}
        self._create(self._body(), scope=scope)
        from shared import category_access
        assert self.scopes == [category_access.scope_from_config(scope)]

    @pytest.mark.parametrize('derivation', [
        None, {}, {'persona_ids': [], 'rounds': 1}, {'persona_ids': ['p'], 'rounds': 4},
        {'persona_ids': ['p'], 'rounds': True}, {'persona_ids': ['p'] * 7, 'rounds': 1},
        {'persona_ids': ['p'], 'rounds': 1, 'feedback_ids': 'fb1'},
        {'persona_ids': ['p'], 'rounds': 1, 'document_ids': ['a', 'b', 'c', 'd']},
        {'persona_ids': [' p'], 'rounds': 1},
    ])
    def test_a_malformed_derivation_is_400(self, derivation):
        from shared.exceptions import ValidationError
        with pytest.raises(ValidationError):
            self._create(self._body(derivation=derivation))

    @pytest.mark.parametrize('content', ['', '   ', 5, 'x' * 200_001])
    def test_needs_its_transcript(self, content):
        from shared.exceptions import ValidationError
        with pytest.raises(ValidationError):
            self._create(self._body(content=content))


def test_the_route_passes_the_saver_s_scope_for_a_focus_group_only(api_gateway_event, lambda_context):
    import projects_handler
    with patch.object(projects_handler, 'create_document', return_value={'success': True}) as create, \
            patch.object(projects_handler, '_caller_category_scope', return_value={'all': True}) as scope:
        for document_type in ('focus_group', 'custom'):
            event = api_gateway_event(method='POST', path='/projects/p1/documents', body={'document_type': document_type})
            assert projects_handler.lambda_handler(event, lambda_context)['statusCode'] == 200
    assert [call.kwargs['category_scope'] for call in create.call_args_list] == [{'all': True}, None]
    assert scope.call_count == 1
