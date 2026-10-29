"""Persona generation gets company knowledge as context: product/customer memories only,
on the analysis step only, recorded per persona — and the job hands it over."""
from unittest.mock import patch

import pytest

from shared import persona_knowledge
from shared.grounding import GROUNDING_GUIDANCE, Grounding
from shared.job_knowledge import PERSONA_MEMORY_KINDS

KNOWLEDGE = Grounding(text='<memory>\n- (company) Most buyers are clinics\n</memory>', memory_ids=['mem_7'],
                      company_context_included=False)
STEPS = [
    {'step_name': 'research_analysis', 'system': 'S1', 'user': 'U1'},
    {'step_name': 'persona_plan', 'system': 'S2', 'user': 'U2'},
    {'step_name': 'persona_synthesis', 'system': 'S3', 'user': 'U3'},
]


def test_the_knowledge_step_is_the_persona_analysis_step():
    assert persona_knowledge.PERSONA_KNOWLEDGE_STEP == STEPS[0]['step_name'] == 'research_analysis'


def test_only_the_analysis_step_carries_the_knowledge_and_the_guidance():
    analysis, plan, synthesis = persona_knowledge.with_persona_knowledge(STEPS, KNOWLEDGE)
    assert (KNOWLEDGE.text in analysis['user'], analysis['system']) == (True, f'S1\n\n{GROUNDING_GUIDANCE}')
    assert (plan, synthesis) == (STEPS[1], STEPS[2])


def test_no_knowledge_leaves_the_chain_as_built():
    assert persona_knowledge.with_persona_knowledge(STEPS, None) is STEPS
    assert persona_knowledge.with_persona_knowledge(STEPS, Grounding()) is STEPS


def test_grounding_uses_product_and_customer_kinds_under_the_starter_scope():
    scope = {'all': True}
    with patch.object(persona_knowledge, 'shared_grounding', return_value=KNOWLEDGE) as grounding:
        persona_knowledge.persona_grounding({'custom_instructions': 'clinic staff', 'categories': ['billing'],
                                             'category_scope': scope})
        persona_knowledge.persona_grounding({})
    first, second = grounding.call_args_list
    assert first.args == ('clinic staff billing', scope)
    assert (first.kwargs, second.args[0]) == ({'kinds': PERSONA_MEMORY_KINDS}, persona_knowledge.PERSONA_QUERY_FALLBACK)


def test_a_persona_records_the_company_memories_it_was_built_with():
    fields = persona_knowledge.persona_knowledge_fields(KNOWLEDGE, 12)
    assert fields['derivation']['memory_ids'] == ['mem_7']
    assert fields['derivation']['feedback_count'] == 12
    assert persona_knowledge.persona_knowledge_fields(Grounding(), 12) == {}


@pytest.mark.usefixtures('mock_jobs_table')
def test_the_job_hands_its_grounding_to_the_generator(
    mock_generate_personas, persona_generation_event, lambda_context, no_company_knowledge,
):
    from jobs.persona_generator.handler import lambda_handler
    no_company_knowledge.return_value = KNOWLEDGE
    lambda_handler(persona_generation_event, lambda_context)
    no_company_knowledge.assert_called_once_with(persona_generation_event['filters'])
    assert mock_generate_personas.call_args.kwargs['knowledge'] is KNOWLEDGE
