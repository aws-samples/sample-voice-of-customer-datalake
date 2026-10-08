"""Mutation hardening for `agents/nodes/generate_personas.py`.

The only earlier test drove `start` with persona generation switched off and
checked `status == 'done'` — so the skip summary, the whole POST body the node
sends to `/projects/{id}/personas/generate`, both defaults (`count` 3, `days`
30), the `[:2000]` envelope cap, the literal-`True` avatar opt-in and
everything `finish` answers (the persona-id filter, the refusal, the summary,
the artifacts claim and the de-duplicated `persona_ids` update) could change
without a failing test. Pinned here, as literals:

* `start` skips with its exact summary only when `personas.allow_generate` is
  literally `False` (absent, `None`, `0` or a non-dict `personas` = allowed);
* otherwise it POSTs once, as the caller, the agent's category scope, `days`
  and `persona_count` from the node params only when they are ints (else 30
  and 3), the first 2000 characters of the envelope, and `generate_avatars`
  true only for a literal `True`; it answers the pending result whose summary
  is `Persona generation started`; without a project it refuses before any POST;
* `finish` keeps only the string `persona_id`s of dict entries, refuses a job
  that yields none, and files the new ids after the ones already on the run,
  each once.
"""
from __future__ import annotations

from typing import Any
from unittest.mock import MagicMock

import pytest

from agents.graph import Node
from agents.nodes import generate_personas
from agents.nodes.base import NodeContext, NodeFailure

AGENT_SCOPE = {'all': False, 'categories': ['checkout', 'shipping']}
ROUTE = '/projects/p1/personas/generate'
ENVELOPE = 'Focus on mobile shoppers.'
NO_PROJECT = r'^no project has been chosen for this run yet$'


def node_ctx(*, params: dict[str, Any] | None = None, personas: Any = None, project_id: str | None = 'p1',
             envelope: str = ENVELOPE, persona_ids: Any = None) -> tuple[NodeContext, MagicMock]:
    """The context of a `generate_personas` node (id `n_personas`) and the `projects` fake it calls,
    which answers a started job `job_9`."""
    agent: dict[str, Any] = {'agent_id': 'ag_1', 'scope': AGENT_SCOPE}
    if personas is not None:
        agent['personas'] = personas
    context: dict[str, Any] = {}
    if project_id:
        context['project_id'] = project_id
    if persona_ids is not None:
        context['persona_ids'] = persona_ids
    node = Node(id='n_personas', type='generate_personas', title='Generate personas', instructions='',
                role='worker', params=params or {})
    ctx = NodeContext(agent=agent, run={'run_id': 'ar_1', 'context': context}, node=node,
                      envelope=envelope, claims={'sub': 'owner-sub'})
    fake = MagicMock(return_value={'job_id': 'job_9'})
    ctx.projects = fake
    return ctx, fake


def body(**overrides: Any) -> dict:
    return {'categories': ['checkout', 'shipping'], 'days': 30, 'persona_count': 3,
            'custom_instructions': ENVELOPE, 'generate_avatars': False, **overrides}


def posted_body(fake: MagicMock) -> dict:
    """The one POST's body, after asserting the method, route and path parameters."""
    assert fake.call_count == 1
    args, kwargs = fake.call_args
    assert args == ('POST', ROUTE)
    assert set(kwargs) == {'body', 'path_parameters'}
    assert kwargs['path_parameters'] == {'project_id': 'p1'}
    return kwargs['body']


PENDING = {'node_id': 'n_personas', 'status': 'pending', 'summary': 'Persona generation started',
           'pending': {'project_id': 'p1', 'job_id': 'job_9'}}


class TestGenerationSwitch:
    def test_a_literal_false_skips_without_calling_the_route(self):
        ctx, fake = node_ctx(personas={'allow_generate': False})
        assert generate_personas.start(ctx) == {
            'node_id': 'n_personas', 'status': 'done',
            'summary': 'Persona generation is off for this agent; skipped.'}
        assert fake.call_count == 0

    @pytest.mark.parametrize('personas', [{}, {'allow_generate': None}, {'allow_generate': 0},
                                          {'allow_generate': True}, 'off', {'allow': False}])
    def test_anything_but_a_literal_false_generates(self, personas: Any):
        ctx, fake = node_ctx(personas=personas)
        assert generate_personas.start(ctx) == PENDING
        assert posted_body(fake) == body()

    def test_the_switch_is_read_from_the_personas_field(self):
        ctx, fake = node_ctx()
        ctx.agent['allow_generate'] = False
        assert generate_personas.start(ctx) == PENDING
        assert fake.call_count == 1


class TestTheGenerateRequest:
    def test_defaults(self):
        ctx, fake = node_ctx()
        assert generate_personas.start(ctx) == PENDING
        assert posted_body(fake) == body()

    def test_int_params_are_forwarded(self):
        ctx, fake = node_ctx(params={'count': 5, 'days': 7, 'generate_avatars': True})
        generate_personas.start(ctx)
        assert posted_body(fake) == body(days=7, persona_count=5, generate_avatars=True)

    @pytest.mark.parametrize('value', ['5', 7.5, None, [5]])
    def test_non_int_params_fall_back_to_the_defaults(self, value: Any):
        ctx, fake = node_ctx(params={'count': value, 'days': value})
        generate_personas.start(ctx)
        assert posted_body(fake) == body()

    @pytest.mark.parametrize('value', [1, 'yes', False, None])
    def test_avatars_need_a_literal_true(self, value: Any):
        ctx, fake = node_ctx(params={'generate_avatars': value})
        generate_personas.start(ctx)
        assert posted_body(fake)['generate_avatars'] is False

    def test_the_envelope_is_cut_at_2000_characters(self):
        ctx, fake = node_ctx(envelope='a' * 1999 + 'bc')
        generate_personas.start(ctx)
        assert posted_body(fake)['custom_instructions'] == 'a' * 1999 + 'b'

    def test_no_project_refuses_before_the_post(self):
        ctx, fake = node_ctx(project_id=None)
        with pytest.raises(NodeFailure, match=NO_PROJECT):
            generate_personas.start(ctx)
        assert fake.call_count == 0

    def test_a_route_that_starts_no_job_is_refused(self):
        ctx, fake = node_ctx()
        fake.return_value = {}
        with pytest.raises(NodeFailure, match=r'^the route did not start a job$'):
            generate_personas.start(ctx)


NO_PERSONAS = 'persona generation finished without personas'


class TestFinish:
    def test_new_ids_follow_the_known_ones_once_each(self):
        ctx, _ = node_ctx(persona_ids=['per_1', 'per_2'])
        job = {'result': {'personas': [{'persona_id': 'per_2'}, {'persona_id': 'per_3'},
                                       {'persona_id': 7}, 'per_4', {'name': 'x'}]}}
        assert generate_personas.finish(ctx, job) == {
            'node_id': 'n_personas', 'status': 'done', 'summary': '2 persona(s) generated',
            'artifacts': {'project_id': 'p1', 'persona_ids': ['per_2', 'per_3']},
            'updates': {'persona_ids': ['per_1', 'per_2', 'per_3']},
        }

    def test_without_known_ids_every_new_id_is_filed(self):
        ctx, _ = node_ctx(persona_ids='per_1')
        job = {'result': {'personas': [{'persona_id': 'per_5'}]}}
        assert generate_personas.finish(ctx, job) == {
            'node_id': 'n_personas', 'status': 'done', 'summary': '1 persona(s) generated',
            'artifacts': {'project_id': 'p1', 'persona_ids': ['per_5']},
            'updates': {'persona_ids': ['per_5']},
        }

    @pytest.mark.parametrize('job', [{}, {'result': 'x'}, {'result': {}}, {'result': {'personas': None}},
                                     {'result': {'personas': []}},
                                     {'result': {'personas': [{'persona_id': None}, 'per_1']}}])
    def test_a_job_without_persona_ids_is_refused(self, job: dict):
        ctx, _ = node_ctx()
        with pytest.raises(NodeFailure, match=rf'^{NO_PERSONAS}$'):
            generate_personas.finish(ctx, job)

    def test_finish_without_a_project_is_refused(self):
        ctx, _ = node_ctx(project_id=None)
        with pytest.raises(NodeFailure, match=NO_PROJECT):
            generate_personas.finish(ctx, {'result': {'personas': [{'persona_id': 'per_1'}]}})
