"""7.104.00's contract for the Product tab's sources, extract and proposals, fixed before their bodies: the twin's
event and its dispatch (shared/product_source_worker.py), the two routers and the extract's job start bound in the
projects handler (shared/product_source_routes.py, shared/product_proposal_routes.py), ``save_interview_source``'s
signature (shared/product_sources.py), which the typed answers route and the voice finalize both call, and the keys
and store names (shared/project_keys.py). A change to any of them is a change to that contract."""
from __future__ import annotations

import dataclasses
import inspect
from unittest.mock import MagicMock, patch

import pytest

from shared import product_proposal_routes, product_source_worker, product_sources
from shared.project_keys import (
    PRODUCT_DOC_SK_PREFIX,
    PRODUCT_EXTRACT_STORE,
    PRODUCT_PROPOSAL_SK_PREFIX,
    NotPerWorkspaceError,
    require_deployment,
)
from shared.ws_repo import WorkspaceScope

EVENT = {'action': 'product_source_extract', 'project_id': 'proj-123', 'doc_id': 'doc_1', 'token': 'tok'}


class TestTheTwinsEvent:
    def test_its_action_is_its_own(self):
        assert product_source_worker.EXTRACT_ACTION == 'product_source_extract'
        assert product_source_worker.is_extract_event(EVENT)

    @pytest.mark.parametrize('event', [{'action': 'library_extract'}, {'action': 'assist_job'}, {}, None, 'x'])
    def test_another_event_is_not_one(self, event):
        assert not product_source_worker.is_extract_event(event)

    def test_the_projects_handler_hands_it_to_the_worker(self, lambda_context):
        """The worker reads the claimed source (here: none, so the event is skipped)."""
        import projects_handler

        table = MagicMock()
        table.get_item.return_value = {}
        with patch.object(product_sources, 'get_projects_table', return_value=table):
            assert projects_handler.lambda_handler(dict(EVENT), lambda_context) == {'status': 'skipped'}
        table.get_item.assert_called_once_with(Key={'pk': 'PROJECT#proj-123', 'sk': 'PRODUCT_DOC#doc_1'},
                                               ConsistentRead=True)


def test_the_extract_starts_through_the_handlers_job_start():
    import projects_handler

    assert product_proposal_routes._bound == [projects_handler._started_generator_job]


def test_save_interview_source_takes_the_answers_as_the_contract_says():
    signature = inspect.signature(product_sources.save_interview_source)
    assert [(name, param.kind.name, param.default) for name, param in signature.parameters.items()] == [
        ('project_id', 'POSITIONAL_OR_KEYWORD', inspect.Parameter.empty),
        ('answers', 'POSITIONAL_OR_KEYWORD', inspect.Parameter.empty),
        ('workspace', 'KEYWORD_ONLY', inspect.Parameter.empty),
    ]
    assert signature.return_annotation == 'dict[str, Any]'
    answers = product_sources.InterviewAnswers(text='**Q** A', mode='voice', created_by={'sub': 's', 'kind': 'user'},
                                               session_id='vs_1')
    assert [(field.name, field.default) for field in dataclasses.fields(answers)] == [
        ('text', dataclasses.MISSING), ('mode', dataclasses.MISSING), ('created_by', dataclasses.MISSING),
        ('proposal_id', None), ('session_id', None), ('past_the_cap', False),
    ]
    with pytest.raises(dataclasses.FrozenInstanceError):
        answers.text = 'changed'  # pyright: ignore[reportAttributeAccessIssue]


class TestTheKeys:
    def test_a_proposal_sorts_apart_from_a_source(self):
        assert PRODUCT_PROPOSAL_SK_PREFIX == 'PRODUCT_PROPOSAL#'
        assert not PRODUCT_PROPOSAL_SK_PREFIX.startswith(PRODUCT_DOC_SK_PREFIX)

    def test_the_extract_refuses_a_workspace_until_its_job_moves(self):
        """Since 7.106.00 (3h-S3b) the sources take the workspace; the extract's own stores refuse one (3h-S8)."""
        require_deployment(None, PRODUCT_EXTRACT_STORE)
        with pytest.raises(NotPerWorkspaceError, match=r'^The product extract is not per workspace yet$'):
            require_deployment(WorkspaceScope('ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D8'), PRODUCT_EXTRACT_STORE)
