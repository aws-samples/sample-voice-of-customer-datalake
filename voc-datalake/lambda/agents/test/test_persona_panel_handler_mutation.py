"""Mutation hardening for `agents/persona_panel/handler.py`.

`test_runtime_units.py` pins the verdict parser's rejections and the agreement
rule, and `test_conductor_run.py` drives the panel inside a whole run, but a
mutation run found what neither can see:

* the LITERALS of the review: the three refusal messages, the ``Agreed`` /
  ``Not agreed`` summary wording, the ``agreed`` / ``not_agreed`` outcome, the
  ``artifacts`` claim and the ``updates`` the conductor commits — all read
  back on the run row, so a drifted key or word is a wrong run record;
* the bounds: six personas on the panel (the seventh is dropped), five
  objections kept, a 120-character name, 1200 tokens per persona, three
  workers, a 3000-character conductor envelope, and ``score`` accepted at
  exactly 1 and exactly 5 but refused at 0 and 6;
* the panel's composition: fixed personas first, one ``personas_of`` call per
  source project, deduplication across sources, a fixed reference that names a
  persona picks only that persona, and a source that cannot be read drops its
  personas without sinking the panel;
* the plumbing: ``reserve`` once per persona on the main thread, ``invoke``
  with the persona's own description as system prompt and the artifact as a
  DATA block, one failing consultation logged and skipped, and the Lambda
  entry point's finished message.
"""
from __future__ import annotations

import json
from collections.abc import Iterator
from typing import Any
from unittest.mock import MagicMock, patch

import pytest

from agents import artifacts, context_blocks
from agents.graph import Node
from agents.nodes.base import NodeContext, NodeFailure
from agents.persona_panel import handler as panel
from shared.persona_context import persona_prompt_block

AGENT: dict[str, Any] = {'agent_id': 'ag_1', 'owner_sub': 'o'}
CLAIMS = {'sub': 'agent:ag_1'}
PERSONA = {'persona_id': 'p1', 'name': 'Ana'}


def _persona(n: int, project: str = 'proj') -> dict:
    return {'persona_id': f'{project}-p{n}', 'name': f'Persona {n}'}


def _ctx(*, params: dict | None = None, context: dict | None = None, envelope: str = 'Review this') -> NodeContext:
    run = {'run_id': 'ar_1', 'context': {'project_id': 'proj', 'documents': {'prfaq': 'doc_1'},
                                         **(context or {})}}
    node = Node(id='review_1', type='persona_review', title='Review', instructions='', role='persona',
                params=params or {})
    return NodeContext(agent=AGENT, run=run, node=node, envelope=envelope, claims=CLAIMS)


def _verdict(score: float, objections: list | None = None, blocking: bool = False) -> str:
    return json.dumps({'score': score, 'objections': objections or [], 'blocking': blocking, 'would_use': True})


@pytest.fixture
def seams() -> Iterator[dict[str, MagicMock]]:
    """Every external edge of ``review`` as a mock, with a one-persona project by default."""
    with (
        patch.object(artifacts, 'load_text', return_value=('prfaq', '# prfaq content')) as load_text,
        patch.object(artifacts, 'personas_of', return_value=('Checkout', [_persona(1)])) as personas_of,
        patch.object(panel.llm, 'reserve') as reserve,
        patch.object(panel.llm, 'invoke', return_value=_verdict(5)) as invoke,
    ):
        yield {'load_text': load_text, 'personas_of': personas_of, 'reserve': reserve, 'invoke': invoke}


class TestConstants:
    def test_the_bounds_are_the_documented_ones(self):
        assert panel.MAX_PANEL_PERSONAS == 6
        assert panel.PERSONA_CONCURRENCY == 3
        assert panel.PERSONA_MAX_TOKENS == 1200
        assert panel.AGREEMENT_MEAN == 4.0
        assert panel.MAX_OBJECTIONS == 5
        assert panel.TARGETS == ('prfaq', 'prd', 'prototype')


class TestPersonaSystemPrompt:
    def test_the_prompt_is_project_persona_then_verdict_instructions(self):
        persona = {'persona_id': 'p1', 'name': 'Ana', 'goals_motivations': {'primary_goal': 'speed'}}

        prompt = panel.persona_system_prompt('Checkout', persona)

        assert prompt == (
            'You are a synthetic customer persona from the "Checkout" research project. Stay in character.\n\n'
            + persona_prompt_block(persona) + '\n\n'
            + 'Review the artifact as yourself — your goals, frustrations and context — and say honestly '
            'whether you would use it. Answer with ONE JSON object only: {"score": 1-5, "objections": '
            '[short strings], "blocking": true|false, "would_use": true|false}. "blocking" means you would '
            'not adopt it unless that objection is fixed. ' + context_blocks.DATA_NOTICE
        )


class TestParseVerdict:
    @pytest.mark.parametrize('text', ['', 'no json here', '{}', '[]', '{"score": null}', '{"score": "4"}',
                                      '{"score": true}', '{"score": false}', '{"score": 0}', '{"score": 6}',
                                      '{"score": 0.99}', '{"score": 5.01}'])
    def test_an_unusable_answer_is_none(self, text):
        assert panel.parse_verdict(text, PERSONA) is None

    @pytest.mark.parametrize(('score', 'expected'), [(1, 1.0), (5, 5.0), (1.0, 1.0), (3.456, 3.5), (4.25, 4.2)])
    def test_the_score_bounds_are_inclusive_and_rounded_to_one_decimal(self, score, expected):
        verdict = panel.parse_verdict(json.dumps({'score': score}), PERSONA)
        assert verdict is not None
        assert verdict['score'] == expected

    def test_a_minimal_answer_yields_the_full_verdict_shape(self):
        assert panel.parse_verdict('{"score": 4}', PERSONA) == {
            'persona_id': 'p1', 'name': 'Ana', 'score': 4.0, 'objections': [], 'blocking': False, 'would_use': False,
        }

    def test_flags_are_true_only_for_json_true(self):
        true = panel.parse_verdict('{"score": 4, "blocking": true, "would_use": true}', PERSONA)
        truthy = panel.parse_verdict('{"score": 4, "blocking": "yes", "would_use": 1}', PERSONA)
        assert true is not None
        assert truthy is not None
        assert (true['blocking'], true['would_use']) == (True, True)
        assert (truthy['blocking'], truthy['would_use']) == (False, False)

    def test_objections_are_stripped_strings_only_and_capped_at_five(self):
        answer = {'score': 2, 'objections': [' one ', 7, '   ', None, 'two', 'three', 'four', 'five', 'six']}
        verdict = panel.parse_verdict(json.dumps(answer), PERSONA)
        assert verdict is not None
        assert verdict['objections'] == ['one', 'two', 'three', 'four', 'five']

    def test_an_objection_is_clipped_to_400_characters_after_stripping(self):
        verdict = panel.parse_verdict(json.dumps({'score': 2, 'objections': ['  ' + 'x' * 401]}), PERSONA)
        assert verdict is not None
        assert verdict['objections'] == ['x' * 400]

    @pytest.mark.parametrize('objections', [None, 0, False])
    def test_a_non_list_objections_field_means_no_objections(self, objections):
        verdict = panel.parse_verdict(json.dumps({'score': 2, 'objections': objections}), PERSONA)
        assert verdict is not None
        assert verdict['objections'] == []

    def test_the_name_falls_back_to_persona_and_is_clipped_to_120(self):
        unnamed = panel.parse_verdict('{"score": 3}', {'persona_id': 'p9', 'name': ''})
        long = panel.parse_verdict('{"score": 3}', {'persona_id': 'p9', 'name': 'n' * 121})
        assert unnamed is not None
        assert long is not None
        assert (unnamed['persona_id'], unnamed['name']) == ('p9', 'Persona')
        assert long['name'] == 'n' * 120


class TestAgreement:
    @pytest.mark.parametrize(('scores', 'agreed'), [
        ([4.0], True), ([3.9], False), ([5, 3], True), ([5, 2.9], False), ([], False),
    ])
    def test_the_mean_must_reach_four(self, scores, agreed):
        assert panel.agreement([{'score': s, 'blocking': False} for s in scores]) is agreed

    def test_one_blocking_verdict_vetoes_a_perfect_mean(self):
        assert panel.agreement([{'score': 5, 'blocking': False}, {'score': 5, 'blocking': True}]) is False


class TestPanelComposition:
    def test_fixed_personas_come_first_then_the_project_and_each_source_is_read_once(self, seams):
        seams['personas_of'].side_effect = lambda project_id, _claims: {
            'other': ('Other', [_persona(1, 'other'), _persona(2, 'other')]),
            'proj': ('Checkout', [_persona(1), _persona(2)]),
        }[project_id]
        ctx = _ctx(context={'fixed_personas': [
            {'project_id': 'other', 'persona_id': 'other-p2'},
            {'project_id': 'proj', 'persona_id': 'proj-p2'},
            {'project_id': 'other', 'persona_id': 'other-p2'},  # duplicate reference
            'not-a-dict', {'project_id': 7}, {'persona_id': 'proj-p1'},
        ]})

        result = panel.review(ctx)

        assert [c.args for c in seams['personas_of'].call_args_list] == [('other', CLAIMS), ('proj', CLAIMS)]
        assert [v['persona_id'] for v in result['updates']['last_verdicts']] == ['other-p2', 'proj-p2', 'proj-p1']
        systems = [c.kwargs['system_prompt'] for c in seams['invoke'].call_args_list]
        assert systems[0].startswith('You are a synthetic customer persona from the "Other" research project.')
        assert systems[1].startswith('You are a synthetic customer persona from the "Checkout" research project.')

    def test_a_fixed_reference_without_a_persona_id_takes_every_persona_of_its_project(self, seams):
        seams['personas_of'].side_effect = lambda project_id, _claims: {
            'other': ('Other', [_persona(1, 'other'), _persona(2, 'other')]),
            'proj': ('Checkout', [_persona(1)]),
        }[project_id]
        ctx = _ctx(context={'fixed_personas': [{'project_id': 'other'}]})

        result = panel.review(ctx)

        assert [v['persona_id'] for v in result['updates']['last_verdicts']] == ['other-p1', 'other-p2', 'proj-p1']

    def test_the_panel_is_capped_at_six_personas(self, seams):
        seams['personas_of'].return_value = ('Checkout', [_persona(n) for n in range(1, 8)])

        result = panel.review(_ctx())

        assert [v['persona_id'] for v in result['updates']['last_verdicts']] == [f'proj-p{n}' for n in range(1, 7)]
        assert seams['reserve'].call_count == 6
        assert seams['invoke'].call_count == 6
        assert result['summary'] == 'Agreed on the prfaq: mean 5.0 from 6 persona(s), 0 blocking'

    def test_an_unreadable_fixed_source_drops_only_its_personas(self, seams):
        def personas_of(project_id, _claims):
            if project_id == 'broken':
                raise RuntimeError('route refused')
            return ('Checkout', [_persona(1)])
        seams['personas_of'].side_effect = personas_of
        ctx = _ctx(context={'fixed_personas': [{'project_id': 'broken', 'persona_id': 'x'},
                                               {'project_id': 'broken', 'persona_id': 'y'}]})

        result = panel.review(ctx)

        assert [c.args[0] for c in seams['personas_of'].call_args_list] == ['broken', 'proj']
        assert [v['persona_id'] for v in result['updates']['last_verdicts']] == ['proj-p1']

    def test_an_empty_panel_is_a_node_failure(self, seams):
        seams['personas_of'].return_value = ('Checkout', [])
        with pytest.raises(NodeFailure, match=r'^no personas are available for the review$'):
            panel.review(_ctx())
        assert seams['reserve'].call_count == 0
        assert seams['invoke'].call_count == 0


class TestReviewRefusals:
    @pytest.mark.parametrize('target', ['persona', 'PRFAQ', '', None, 7])
    def test_an_unknown_target_is_refused_before_anything_is_read(self, seams, target):
        with pytest.raises(NodeFailure, match=r'^persona_review target must be prfaq, prd or prototype$'):
            panel.review(_ctx(params={'target': target}))
        assert seams['load_text'].call_count == 0
        assert seams['personas_of'].call_count == 0

    @pytest.mark.usefixtures('seams')
    def test_a_missing_project_fails_with_the_context_message(self):
        with pytest.raises(NodeFailure, match=r'^no project has been chosen for this run yet$'):
            panel.review(_ctx(context={'project_id': ''}))

    @pytest.mark.parametrize('target', ['prfaq', 'prd', 'prototype'])
    def test_a_missing_document_names_the_target(self, seams, target):
        with pytest.raises(NodeFailure, match=rf'^there is no {target} to review yet$'):
            panel.review(_ctx(params={'target': target}, context={'documents': {}}))
        assert seams['load_text'].call_count == 0

    def test_an_unavailable_artifact_becomes_a_node_failure_with_its_message(self, seams):
        seams['load_text'].side_effect = artifacts.ArtifactUnavailable('prototype HTML could not be read')
        with pytest.raises(NodeFailure, match=r'^prototype HTML could not be read$') as info:
            panel.review(_ctx())
        assert isinstance(info.value.__cause__, artifacts.ArtifactUnavailable)
        assert seams['personas_of'].call_count == 0

    def test_no_usable_verdict_is_a_node_failure(self, seams):
        seams['invoke'].return_value = 'I refuse to answer in JSON'
        with pytest.raises(NodeFailure, match=r'^no persona returned a usable verdict$'):
            panel.review(_ctx())


class TestReviewPlumbing:
    def test_the_default_target_is_the_prfaq(self, seams):
        result = panel.review(_ctx(context={'documents': {'prfaq': 'doc_prfaq', 'prd': 'doc_prd'}}))

        seams['load_text'].assert_called_once_with('proj', 'doc_prfaq', CLAIMS)
        assert result['artifacts'] == {'project_id': 'proj', 'document_id': 'doc_prfaq', 'document_type': 'prfaq'}
        assert result['updates']['last_review_target'] == 'prfaq'

    @pytest.mark.parametrize('target', ['prd', 'prototype'])
    def test_each_target_reads_its_own_document_and_labels_the_artifact(self, seams, target):
        ctx = _ctx(params={'target': target}, context={'documents': {target: f'doc_{target}'}}, envelope='Env')

        result = panel.review(ctx)

        seams['load_text'].assert_called_once_with('proj', f'doc_{target}', CLAIMS)
        assert result['artifacts'] == {'project_id': 'proj', 'document_id': f'doc_{target}', 'document_type': target}
        assert result['updates']['last_review_target'] == target
        assert seams['invoke'].call_args.args[2] == (
            f'<conductor_message>\nEnv\n</conductor_message>\n\n'
            f'<artifact>\n{target.upper()}:\n# prfaq content\n</artifact>\n\n'
            'Give your verdict as the JSON object now.'
        )

    def test_each_persona_is_reserved_on_the_main_thread_then_invoked_with_its_own_description(self, seams):
        seams['personas_of'].return_value = ('Checkout', [_persona(1), _persona(2)])

        panel.review(_ctx(envelope='Env'))

        assert seams['reserve'].call_args_list == [((AGENT, 'ar_1'),), ((AGENT, 'ar_1'),)]
        prompt = ('<conductor_message>\nEnv\n</conductor_message>\n\n'
                  '<artifact>\nPRFAQ:\n# prfaq content\n</artifact>\n\n'
                  'Give your verdict as the JSON object now.')
        assert sorted(c.kwargs['system_prompt'] for c in seams['invoke'].call_args_list) == sorted(
            panel.persona_system_prompt('Checkout', _persona(n)) for n in (1, 2))
        for call in seams['invoke'].call_args_list:
            assert call.args == (AGENT, 'persona', prompt)
            assert call.kwargs['max_tokens'] == 1200
            assert call.kwargs['step_name'] == 'agent_persona_review'
            assert set(call.kwargs) == {'system_prompt', 'max_tokens', 'step_name'}

    def test_the_envelope_is_clipped_to_3000_characters(self, seams):
        panel.review(_ctx(envelope='e' * 3001))

        prompt = seams['invoke'].call_args.args[2]
        assert prompt.startswith('<conductor_message>\n' + 'e' * 3000 + '\n</conductor_message>')

    def test_the_artifact_is_clipped_to_the_artifact_limit(self, seams):
        seams['load_text'].return_value = ('prfaq', 'a' * artifacts.MAX_ARTIFACT_CHARS)

        panel.review(_ctx())

        prompt = seams['invoke'].call_args.args[2]
        assert ('<artifact>\nPRFAQ:\n' + 'a' * (artifacts.MAX_ARTIFACT_CHARS - len('PRFAQ:\n')) + '\n</artifact>') in prompt

    @pytest.mark.usefixtures('seams')
    def test_three_workers_consult_the_panel(self):
        with patch.object(panel, 'ThreadPoolExecutor', wraps=panel.ThreadPoolExecutor) as executor:
            panel.review(_ctx())
        executor.assert_called_once_with(max_workers=3)

    def test_a_failing_consultation_is_logged_by_type_and_skipped(self, seams):
        seams['personas_of'].return_value = ('Checkout', [_persona(1), _persona(2), _persona(3)])
        seams['invoke'].side_effect = [_verdict(4), RuntimeError('boom'), 'not json']

        with patch.object(panel, 'logger') as log:
            result = panel.review(_ctx())

        log.warning.assert_called_once_with('Persona consultation failed', extra={'error_type': 'RuntimeError'})
        assert result['updates']['last_verdicts'] == [{
            'persona_id': 'proj-p1', 'name': 'Persona 1', 'score': 4.0, 'objections': [],
            'blocking': False, 'would_use': True,
        }]
        assert result['summary'] == 'Agreed on the prfaq: mean 4.0 from 1 persona(s), 0 blocking'

    def test_an_agreed_review_returns_the_full_node_result(self, seams):
        seams['personas_of'].return_value = ('Checkout', [_persona(1), _persona(2)])
        seams['invoke'].side_effect = [_verdict(5), _verdict(4, ['Slow'])]

        result = panel.review(_ctx(params={'target': 'prfaq'}))

        assert result == {
            'node_id': 'review_1', 'status': 'done', 'outcome': 'agreed',
            'summary': 'Agreed on the prfaq: mean 4.5 from 2 persona(s), 0 blocking',
            'artifacts': {'project_id': 'proj', 'document_id': 'doc_1', 'document_type': 'prfaq'},
            'updates': {
                'last_verdicts': [
                    {'persona_id': 'proj-p1', 'name': 'Persona 1', 'score': 5.0, 'objections': [],
                     'blocking': False, 'would_use': True},
                    {'persona_id': 'proj-p2', 'name': 'Persona 2', 'score': 4.0, 'objections': ['Slow'],
                     'blocking': False, 'would_use': True},
                ],
                'last_review_target': 'prfaq',
            },
        }

    def test_a_blocked_review_is_not_agreed_and_counts_the_blockers(self, seams):
        seams['personas_of'].return_value = ('Checkout', [_persona(1), _persona(2), _persona(3)])
        seams['invoke'].side_effect = [_verdict(5, blocking=True), _verdict(5), _verdict(2, blocking=True)]

        result = panel.review(_ctx(params={'target': 'prd'}, context={'documents': {'prd': 'doc_prd'}}))

        assert result['outcome'] == 'not_agreed'
        assert result['summary'] == 'Not agreed on the prd: mean 4.0 from 3 persona(s), 2 blocking'
        assert [v['blocking'] for v in result['updates']['last_verdicts']] == [True, False, True]

    def test_a_low_mean_is_not_agreed_without_blockers(self, seams):
        seams['personas_of'].return_value = ('Checkout', [_persona(1), _persona(2)])
        seams['invoke'].side_effect = [_verdict(4), _verdict(3.8)]

        result = panel.review(_ctx())

        assert result['outcome'] == 'not_agreed'
        assert result['summary'] == 'Not agreed on the prfaq: mean 3.9 from 2 persona(s), 0 blocking'


class TestEntryPoints:
    def test_execute_runs_review_as_a_step(self):
        with patch.object(panel.runtime, 'run_step', return_value={'status': 'done'}) as run_step:
            assert panel.execute({'node_id': 'n1'}) == {'status': 'done'}
        run_step.assert_called_once_with({'node_id': 'n1'}, panel.review)

    def test_the_lambda_handler_logs_the_finished_message_with_the_node_status(self):
        lambda_context = MagicMock()
        lambda_context.function_name = 'voc-agent-persona-panel'
        lambda_context.memory_limit_in_mb = 512
        lambda_context.invoked_function_arn = 'arn:aws:lambda:us-east-1:123456789012:function:voc-agent-persona-panel'
        lambda_context.aws_request_id = 'req-1'
        with (
            patch.object(panel.runtime, 'run_step', return_value={'node_id': 'n1', 'status': 'failed'}) as run_step,
            patch.object(panel.runtime, 'logger') as log,
        ):
            result = panel.lambda_handler({'node_id': 'n1'}, lambda_context)

        assert result == {'node_id': 'n1', 'status': 'failed'}
        run_step.assert_called_once_with({'node_id': 'n1'}, panel.review)
        log.info.assert_called_once_with('Persona panel finished', extra={'node_status': 'failed'})
