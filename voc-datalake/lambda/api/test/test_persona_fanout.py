"""Persona generation writes ONE persona per model call (#235: "personas are key").

The analysis is followed by a small plan call naming the N distinct personas,
then N calls in parallel, each writing one full persona from the shared
analysis, the feedback sample, its own plan entry and the other planned names.
A persona whose call fails or does not parse is retried once, then dropped and
counted; the run fails only when no persona survives.
"""
import json
import threading
from unittest.mock import MagicMock, patch

import pytest
from persona_fakes import (
    ANALYSIS_STEP,
    PERSONA_STEP,
    PLAN_STEP,
    FakePersonaModel,
    assigned_name,
    persona,
    plan_output,
)

import projects
from shared.exceptions import ServiceError
from shared.prompts import get_persona_generation_steps

NAMES = ['Ada Moreno', 'Grace Okafor', 'Mary Lindqvist']


def _steps(persona_count: int = 3) -> list[dict]:
    return get_persona_generation_steps(persona_count, 'stats', 'feedback context')


def _run(model: FakePersonaModel, *, persona_count: int = 3, progress=None, avoid=None):
    with patch.object(projects, 'converse_detailed', model):
        return projects._run_persona_calls(
            _steps(persona_count), {}, persona_count, avoid or [], progress or MagicMock(),
        )


@pytest.fixture
def metrics():
    with patch.object(projects, 'metrics') as mock:
        yield mock


def _metric_counts(mock) -> dict[str, int]:
    counts: dict[str, int] = {}
    for c in mock.add_metric.call_args_list:
        counts[c.kwargs['name']] = counts.get(c.kwargs['name'], 0) + c.kwargs['value']
    return counts


class TestThePlan:
    def test_entries_without_a_name_and_repeated_names_are_skipped(self):
        text = json.dumps([
            {'name': 'Ada Moreno', 'archetype': 'The Planner'},
            {'archetype': 'no name'},
            {'name': '  ada   moreno '},
            {'name': 'Grace Okafor', 'segment': 7},
        ])

        planned = projects._plan_entries(text, 5)

        assert [(p.name, p.archetype, p.segment) for p in planned] == [
            ('Ada Moreno', 'The Planner', ''), ('Grace Okafor', '', ''),
        ]

    def test_the_plan_is_cut_to_the_requested_count(self):
        assert [p.name for p in projects._plan_entries(plan_output(NAMES), 2)] == NAMES[:2]

    def test_a_long_plan_field_is_bounded(self):
        text = json.dumps([{'name': 'Ada', 'evidence': 'x ' * 1000}])

        assert len(projects._plan_entries(text, 1)[0].evidence) == projects.MAX_PLAN_FIELD_CHARS

    def test_the_plan_prompt_carries_the_analysis_and_the_names_to_avoid(self):
        model = FakePersonaModel(NAMES, analysis='SEGMENT ANALYSIS TEXT')

        _run(model, avoid=['Old Name'])

        (plan_prompt,) = model.prompts(PLAN_STEP)
        assert 'SEGMENT ANALYSIS TEXT' in plan_prompt
        assert '["Old Name"]' in plan_prompt

    def test_a_plan_that_does_not_parse_is_retried_once(self):
        model = FakePersonaModel(NAMES, plan=['not json', plan_output(NAMES)])

        run = _run(model)

        assert len(model.prompts(PLAN_STEP)) == 2
        assert [p['name'] for p in run.batch.personas] == NAMES

    def test_a_plan_that_never_parses_is_a_named_refusal(self):
        model = FakePersonaModel(NAMES, plan='I cannot plan these.')

        with pytest.raises(ServiceError, match='Failed to plan personas'):
            _run(model)

        assert len(model.prompts(PLAN_STEP)) == projects.PERSONA_CALL_ATTEMPTS
        assert model.prompts(PERSONA_STEP) == []


class TestOneCallPerPersona:
    def test_there_is_one_persona_call_per_planned_persona(self):
        model = FakePersonaModel(NAMES)

        run = _run(model)

        assert [c['step_name'] for c in model.calls[:2]] == [ANALYSIS_STEP, PLAN_STEP]
        assert sorted(assigned_name(p) for p in model.prompts(PERSONA_STEP)) == sorted(NAMES)
        assert [p['name'] for p in run.batch.personas] == NAMES
        assert (run.batch.dropped, run.batch.tiers) == (0, ['strict'] * 3)

    def test_each_call_gets_the_analysis_the_sample_and_the_other_planned_names(self):
        model = FakePersonaModel(NAMES, analysis='SHARED ANALYSIS')

        _run(model)

        for prompt in model.prompts(PERSONA_STEP):
            own = assigned_name(prompt)
            others = json.dumps([name for name in NAMES if name != own])
            assert 'SHARED ANALYSIS' in prompt
            assert 'feedback context' in prompt
            assert others in prompt.split('## THE OTHER PLANNED PERSONAS')[1]

    def test_the_stored_name_is_the_planned_name_even_when_the_model_drifts(self):
        model = FakePersonaModel(
            NAMES[:1], persona_answer=lambda _name, _attempt: json.dumps(persona('Somebody Else')),
        )

        run = _run(model, persona_count=1)

        assert [p['name'] for p in run.batch.personas] == ['Ada Moreno']

    def test_a_persona_wrapped_in_a_fence_or_prose_still_parses(self):
        answers = {
            'Ada Moreno': f"```json\n{json.dumps(persona('Ada Moreno'))}\n```",
            'Grace Okafor': f"Here it is: {json.dumps(persona('Grace Okafor'))} Thanks!",
            'Mary Lindqvist': json.dumps([persona('Mary Lindqvist')]),
        }
        model = FakePersonaModel(NAMES, persona_answer=lambda name, _attempt: answers[name])

        assert _run(model).batch.tiers == ['fenced', 'object', 'strict']

    def test_no_more_than_the_concurrency_cap_run_at_once(self):
        names = [f'Person {i}' for i in range(8)]
        active, peak, lock = [0], [0], threading.Lock()
        gate = threading.Event()

        def answer(name: str, _attempt: int) -> str:
            with lock:
                active[0] += 1
                peak[0] = max(peak[0], active[0])
                if active[0] == projects.PERSONA_WRITE_MAX_CONCURRENCY:
                    gate.set()
            gate.wait(timeout=2)
            with lock:
                active[0] -= 1
            return json.dumps(persona(name))

        run = _run(FakePersonaModel(names, persona_answer=answer), persona_count=8)

        assert len(run.batch.personas) == 8
        assert peak[0] == projects.PERSONA_WRITE_MAX_CONCURRENCY


class TestAFailedPersonaIsRetriedThenDropped:
    def test_a_persona_that_fails_once_is_retried_and_kept(self, metrics):
        def answer(name: str, attempt: int) -> str:
            return 'oops' if name == 'Grace Okafor' and attempt == 1 else json.dumps(persona(name))

        model = FakePersonaModel(NAMES, persona_answer=answer)

        run = _run(model)

        assert model.attempts('Grace Okafor') == 2
        assert model.attempts('Ada Moreno') == 1
        assert [p['name'] for p in run.batch.personas] == NAMES
        assert _metric_counts(metrics) == {}

    def test_a_persona_that_never_parses_is_dropped_and_counted(self, metrics):
        def answer(name: str, _attempt: int) -> str:
            return '{"name": "broken",}' if name == 'Grace Okafor' else json.dumps(persona(name))

        model = FakePersonaModel(NAMES, persona_answer=answer)

        run = _run(model)

        assert model.attempts('Grace Okafor') == projects.PERSONA_CALL_ATTEMPTS
        assert [p['name'] for p in run.batch.personas] == ['Ada Moreno', 'Mary Lindqvist']
        assert run.batch.dropped == 1
        assert _metric_counts(metrics) == {'PersonasDroppedAtParse': 1}

    def test_a_persona_whose_call_keeps_raising_is_dropped_and_counted(self, metrics):
        def answer(name: str, _attempt: int) -> str:
            if name == 'Mary Lindqvist':
                raise RuntimeError('ThrottlingException')
            return json.dumps(persona(name))

        model = FakePersonaModel(NAMES, persona_answer=answer)

        run = _run(model)

        assert model.attempts('Mary Lindqvist') == projects.PERSONA_CALL_ATTEMPTS
        assert run.batch.dropped == 1
        assert _metric_counts(metrics) == {'PersonaCallFailed': 1}

    def test_an_object_without_any_persona_section_is_a_failed_parse(self, metrics):
        def answer(name: str, _attempt: int) -> str:
            return '{"error": "refused"}' if name == 'Ada Moreno' else json.dumps(persona(name))

        run = _run(FakePersonaModel(NAMES, persona_answer=answer))

        assert [p['name'] for p in run.batch.personas] == ['Grace Okafor', 'Mary Lindqvist']
        assert _metric_counts(metrics) == {'PersonasDroppedAtParse': 1}

    def test_every_persona_failing_to_parse_is_a_service_error(self, metrics):
        model = FakePersonaModel(NAMES, persona_answer=lambda _name, _attempt: 'no json')

        with pytest.raises(ServiceError, match='Failed to parse persona data'):
            _run(model)

        assert _metric_counts(metrics) == {'PersonasDroppedAtParse': 3}

    def test_every_call_raising_re_raises_the_call_error(self, metrics):
        error = RuntimeError('Input is too long for requested model.')

        def answer(_name: str, _attempt: int) -> str:
            raise error

        with pytest.raises(RuntimeError) as exc:
            _run(FakePersonaModel(NAMES, persona_answer=answer))

        assert exc.value is error
        assert _metric_counts(metrics) == {'PersonaCallFailed': 3}


class TestProgress:
    def test_progress_only_moves_forward_and_ends_below_saving(self):
        progress = MagicMock()

        _run(FakePersonaModel(NAMES), progress=progress)

        values = [c.args[0] for c in progress.call_args_list]
        steps = [c.args[1] for c in progress.call_args_list]
        assert values == sorted(values)
        assert steps[:3] == ['analysing_feedback', 'planning_personas', 'writing_personas']
        assert values[-1] == projects.PERSONA_WRITE_PROGRESS_END < 80
        assert len(values) == 3 + len(NAMES)
