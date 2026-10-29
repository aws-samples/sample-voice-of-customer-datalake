"""How the shared PR/FAQ / PRD writer (`agents/nodes/documents.py`) takes a way-of-working
refusal from `POST /projects/{id}/document` (docs/ways-of-working.md → Enforcement).

A 403 whose message starts with `AUTONOMOUS_REFUSAL_PREFIX` becomes a plain node failure
carrying the route's own sentence (the run log shows why); every other route error is
left as it was, for the runtime's ordinary error handling.
"""
from __future__ import annotations

import pytest

from agents import principal
from agents.nodes import documents
from agents.nodes.base import NodeContext, NodeFailure
from agents.test.document_node_fixtures import node_ctx, projects_fake, stubbed_context_blocks
from shared.ai_writing import AUTONOMOUS_REFUSAL_PREFIX

REFUSAL = (f'{AUTONOMOUS_REFUSAL_PREFIX} PRD only for people working AI-driven. '
           'Write it in the editor, or ask an administrator to change your way of working.')


def _refused_with(doc_type: str, error: Exception) -> NodeContext:
    ctx = node_ctx(doc_type)
    projects_fake(ctx).side_effect = error
    return ctx


def _start(ctx: NodeContext, doc_type: str, **kwargs: str) -> dict:
    with stubbed_context_blocks():
        return documents.start_document(ctx, doc_type, **kwargs)


@pytest.mark.parametrize('doc_type', ['prd', 'prfaq'])
def test_a_way_of_working_refusal_fails_the_step_with_the_routes_own_sentence(doc_type: str):
    ctx = _refused_with(doc_type, principal.RouteError(403, REFUSAL))

    with pytest.raises(NodeFailure) as caught:
        _start(ctx, doc_type)

    assert str(caught.value) == REFUSAL
    assert isinstance(caught.value.__cause__, principal.RouteError)


def test_a_refused_revision_fails_the_same_way():
    ctx = _refused_with('prd', principal.RouteError(403, REFUSAL))

    with pytest.raises(NodeFailure, match=f'^{AUTONOMOUS_REFUSAL_PREFIX}'):
        _start(ctx, 'prd', revision_of='doc_1')


def test_the_refused_post_is_the_one_generation_request():
    ctx = _refused_with('prd', principal.RouteError(403, REFUSAL))

    with pytest.raises(NodeFailure):
        _start(ctx, 'prd')

    projects = projects_fake(ctx)
    projects.assert_called_once()
    assert projects.call_args.args == ('POST', '/projects/p1/document')
    assert projects.call_args.kwargs['path_parameters'] == {'project_id': 'p1'}


@pytest.mark.parametrize('error', [
    principal.RouteError(403, 'Access denied'),
    principal.RouteError(403, 'You work Human-driven on PRDs: you write, the AI coaches.'),
    principal.RouteError(500, REFUSAL),
    principal.RouteError(404, 'Project not found'),
], ids=['other-403', 'interactive-refusal', 'prefix-on-a-500', '404'])
def test_any_other_route_error_is_not_turned_into_a_node_failure(error: principal.RouteError):
    ctx = _refused_with('prd', error)

    with pytest.raises(principal.RouteError) as caught:
        _start(ctx, 'prd')

    assert caught.value is error


def test_an_allowed_request_starts_the_job():
    ctx = node_ctx('prd')

    result = _start(ctx, 'prd')

    assert 'job_9' in str(result)
    projects_fake(ctx).assert_called_once()
