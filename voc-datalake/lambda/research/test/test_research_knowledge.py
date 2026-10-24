"""Research reports use company knowledge (SHARED policy) and keep it out of web queries.

step_initialize asks ``shared_grounding`` for the question under the starter's
scope, stashes the text in the scratch claim-check, and threads only a flag
through the state; the model steps read it back and add GROUNDING_GUIDANCE to
their system prompt. The privacy guard: web queries are planned from the
question and feedback statistics only, so a memory never becomes a query.
"""
import json
from unittest.mock import MagicMock, patch

import pytest
import research_step_handler as rsh

from shared import agentic_search
from shared.derivation import build_derivation
from shared.grounding import GROUNDING_GUIDANCE, Grounding

SECRET = 'Codename FALCON ships the 48 h refund target'
GROUNDED = Grounding(text=f'<company_context>\nVision\n</company_context>\n\n<memory>\n- {SECRET}\n</memory>',
                     memory_ids=['mem_1'], company_context_included=True)
GROUNDING_KEY = ('test-raw', 'scratch/research_jobs/j1/grounding.txt')
SCOPE = {'all': False, 'categories': ['billing']}
CONFIG = {'question': 'Why are refunds slow?', 'category_scope': SCOPE}


@pytest.fixture
def initialize():
    items = [{'original_text': 'a'}, {'original_text': 'b'}]
    with patch('research_step_handler.get_feedback_context', return_value=items), \
            patch('research_step_handler.format_feedback_for_llm', return_value='### Review 1\na'), \
            patch('research_step_handler.get_feedback_statistics', return_value='STATS'), \
            patch('research_step_handler._get_projects_table', return_value=None), \
            patch('research_step_handler.update_job_status'):
        yield lambda config: rsh.step_initialize({'project_id': 'p1', 'job_id': 'j1', 'research_config': config})


class TestInitialize:
    def test_grounding_is_asked_for_the_question_under_the_starter_scope(self, initialize, no_company_knowledge):
        initialize(CONFIG)
        no_company_knowledge.assert_called_once_with('Why are refunds slow?', SCOPE)

    def test_grounded_text_is_stashed_and_only_a_flag_rides_the_state(self, initialize, no_company_knowledge,
                                                                       scratch_s3):
        no_company_knowledge.return_value = GROUNDED
        result = initialize(CONFIG)
        assert scratch_s3.objects[GROUNDING_KEY] == GROUNDED.text.encode('utf-8')
        assert result['grounding_included'] is True
        assert SECRET not in json.dumps(result)

    def test_derivation_records_company_memories_context_and_web_searches(self, initialize, no_company_knowledge):
        no_company_knowledge.return_value = GROUNDED
        with patch('research_step_handler._web_search_context', return_value=('WEB', ['q1', 'q2'])):
            result = initialize(CONFIG)
        assert result['derivation'] == build_derivation(
            feedback_count=1, memory_ids=['mem_1'], company_context_included=True, web_search_count=2,
        )

    def test_nothing_grounded_writes_no_stash(self, initialize, scratch_s3):
        result = initialize(CONFIG)
        assert (result['grounding_included'], GROUNDING_KEY in scratch_s3.objects) == (False, False)

    def test_a_failed_stash_drops_the_knowledge_not_the_job(self, initialize, no_company_knowledge, scratch_s3):
        no_company_knowledge.return_value = GROUNDED
        scratch_s3.put_object = MagicMock(side_effect=[RuntimeError('denied'), {}])  # grounding first, then feedback
        result = initialize(CONFIG)
        assert (result['grounding_included'], 'memory_ids' in result['derivation']) == (False, False)


ANALYZE = {'project_id': 'p1', 'job_id': 'j1', 'research_config': {'question': 'Q'},
           'feedback_context': 'FB', 'feedback_stats': 'S'}
#: The two model steps that read the company knowledge, with a minimal event each.
MODEL_STEPS = [('step_analyze', ANALYZE), ('step_synthesize', {**ANALYZE, 'analysis': 'A'})]


@pytest.fixture
def model():
    step = {'system_prompt': 'SYS', 'max_tokens': 100, 'thinking_budget': 0, 'step_name': 's'}
    with patch('research_step_handler.get_research_step_config', return_value=step), \
            patch('research_step_handler.update_job_status'), \
            patch('research_step_handler.converse', return_value='TEXT') as converse:
        yield converse


class TestModelSteps:
    @pytest.mark.parametrize(('step', 'event'), MODEL_STEPS)
    def test_the_stash_reaches_the_prompt_with_the_guidance(self, model, scratch_s3, step, event):
        scratch_s3.objects[GROUNDING_KEY] = GROUNDED.text.encode('utf-8')
        getattr(rsh, step)({**event, 'grounding_included': True})
        kwargs = model.call_args.kwargs
        assert (GROUNDED.text in kwargs['prompt'], kwargs['system_prompt']) == (True, f'SYS\n\n{GROUNDING_GUIDANCE}')

    @pytest.mark.parametrize(('step', 'event'), MODEL_STEPS)
    def test_without_the_flag_nothing_is_read_and_the_prompt_is_unchanged(self, model, scratch_s3, step, event):
        scratch_s3.objects[GROUNDING_KEY] = GROUNDED.text.encode('utf-8')
        getattr(rsh, step)(dict(event))
        kwargs = model.call_args.kwargs
        assert (rsh.GROUNDING_SECTION_HEADING in kwargs['prompt'], kwargs['system_prompt']) == (False, 'SYS')

    def test_a_missing_stash_degrades_to_no_knowledge(self, model):
        rsh.step_analyze({**ANALYZE, 'grounding_included': True})
        assert model.call_args.kwargs['system_prompt'] == 'SYS'


class TestPrivacyGuard:
    def test_memory_and_company_context_never_reach_a_web_query(self, initialize, no_company_knowledge):
        no_company_knowledge.return_value = GROUNDED
        planner = MagicMock(side_effect=[json.dumps({'queries': ['refund speed benchmarks']}),
                                         json.dumps({'done': True, 'queries': []})])
        search = MagicMock(return_value=[{'title': 't', 'url': 'https://example.com', 'snippet': 's'}])
        with patch('research_step_handler.is_web_search_configured', return_value=True), \
                patch.object(agentic_search, 'converse', planner), \
                patch.object(agentic_search, 'search_web', search):
            initialize({**CONFIG, 'use_web_search': True})
        planned_from = ' '.join(c.kwargs['prompt'] for c in planner.call_args_list)
        queried = ' '.join(str(c.args) + str(c.kwargs) for c in search.call_args_list)
        assert ('FALCON' in planned_from, 'FALCON' in queried, 'Vision' in queried) == (False, False, False)
        assert search.call_count == 1


class TestAgentWebQueryCap:
    @pytest.mark.parametrize(('config', 'kwargs'), [
        ({'web_query_cap': 2}, {'max_queries': 2}),
        ({}, {}),
        ({'web_query_cap': True}, {}),
        ({'web_query_cap': '2'}, {}),
    ])
    def test_only_an_int_cap_reaches_the_search(self, config, kwargs):
        outcome = agentic_search.AgenticSearchOutcome()
        with patch('research_step_handler.is_web_search_configured', return_value=True), \
                patch('research_step_handler.update_job_status'), \
                patch('research_step_handler.run_agentic_web_search', return_value=outcome) as search:
            rsh._web_search_context('p1', 'j1', {'use_web_search': True, 'question': 'Q', **config}, 'S')
        assert search.call_args.kwargs == {'context_hint': 'S', **kwargs}
