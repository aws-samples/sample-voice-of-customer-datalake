"""Mutation hardening for `agents/nodes/custom_llm.py`.

No earlier test imported the node: the state-machine drives in
`test_conductor_run.py` never schedule a `custom_llm` step, so a mutation run
found the whole module unobserved. What is pinned here, as literals:

* the PROMPT the node builds — which context blocks go in, in which order,
  and the clip each one gets (800 characters of aggregate as the memory
  query when the node has no instructions, 4000 for `<reviews>`, 8000 for
  `<conductor_message>`), plus the exact system prompt and `max_tokens`;
* the two REFUSALS and their wording (`the model returned nothing` for an
  empty or whitespace-only answer, `the document could not be saved` for
  every malformed save response);
* the two RESULT shapes: without a project the answer is kept on the run as
  `custom_outputs` (summary clipped to 400, stored text to 4000); with a
  project it is POSTed as a `custom` document with the title clipped to 120
  and the saved `document_id` is claimed as an artifact.
"""
from __future__ import annotations

from unittest.mock import Mock, call, patch

import pytest

from agents import context_blocks
from agents.graph import Node
from agents.nodes import custom_llm
from agents.nodes.base import NodeContext, NodeFailure

AGGREGATE = {
    'title': 'Checkout is slow',
    'problem_summary': 'x' * 1500,  # long enough that an 800-character clip is observable
    'top_problems': [{'title': 'Slow payment', 'category': 'checkout', 'evidence_count': 3}],
}
SAVED = {'success': True, 'document': {'document_id': 'doc_7'}}


def _ctx(*, project_id: str | None = 'p1', instructions: str = '', title: str = 'Summarise',
         answer: str | None = 'Markdown answer', payload=SAVED, envelope: str = 'Do the task') -> NodeContext:
    node = Node(id='n_custom', type='custom_llm', title=title, instructions=instructions, role='worker')
    context: dict = {'aggregate': AGGREGATE}
    if project_id:
        context['project_id'] = project_id
    ctx = NodeContext(agent={'agent_id': 'ag_1'}, run={'run_id': 'r1', 'context': context}, node=node,
                      envelope=envelope, claims={'sub': 'owner-sub'})
    ctx.ask = Mock(return_value=answer)
    ctx.projects = Mock(return_value=payload)
    return ctx


def _stub(method: object) -> Mock:
    """The Mock `_ctx` put in place of a NodeContext method (type-narrowed for the checker)."""
    assert isinstance(method, Mock)
    return method


@pytest.fixture(autouse=True)
def blocks():
    """Every context block stubbed (for every test) so the prompt's composition is observable."""
    with (
        patch.object(context_blocks, 'company_context', return_value='<company_context>C</company_context>') as company,
        patch.object(context_blocks, 'memories', return_value='<memory>M</memory>') as memories,
        patch.object(context_blocks, 'wrap', side_effect=lambda tag, _text, limit: f'<{tag}>{limit}</{tag}>') as wrap,
    ):
        yield company, memories, wrap


class TestThePromptIsBuiltFromEveryBlockInOrder:
    def test_system_prompt_is_the_crew_brief_plus_the_data_notice(self):
        assert custom_llm.SYSTEM == (
            'You are a member of an autonomous product crew. Do exactly the task in the conductor '
            'message, using the context provided. Answer in Markdown. ' + context_blocks.DATA_NOTICE)

    def test_the_model_sees_company_memory_reviews_and_message_with_their_clips(self, blocks):
        company, memories, wrap = blocks
        ctx = _ctx(instructions='Write a haiku')
        custom_llm.start(ctx)
        company.assert_called_once_with()
        memories.assert_called_once_with({'sub': 'owner-sub'}, 'Write a haiku', 'p1')
        assert wrap.call_args_list == [
            call('reviews', ctx.aggregate_text(), 4000),
            call('conductor_message', 'Do the task', 8000),
        ]
        _stub(ctx.ask).assert_called_once_with(
            '<company_context>C</company_context>\n\n<memory>M</memory>\n\n'
            '<reviews>4000</reviews>\n\n<conductor_message>8000</conductor_message>',
            system_prompt=custom_llm.SYSTEM, max_tokens=4000)

    def test_without_instructions_the_memory_query_is_the_first_800_aggregate_characters(self, blocks):
        _company, memories, _wrap = blocks
        ctx = _ctx(instructions='')
        custom_llm.start(ctx)
        query = memories.call_args.args[1]
        assert len(query) == 800
        assert query == ctx.aggregate_text()[:800]
        assert len(ctx.aggregate_text()) > 800

    def test_without_a_project_the_memory_lookup_gets_none(self, blocks):
        _company, memories, _wrap = blocks
        custom_llm.start(_ctx(project_id=None, instructions='Write'))
        memories.assert_called_once_with({'sub': 'owner-sub'}, 'Write', None)


class TestAnEmptyAnswerIsRefused:
    @pytest.mark.parametrize('answer', [None, '', '   \n\t '])
    def test_nothing_or_whitespace_fails_the_node(self, answer):
        ctx = _ctx(answer=answer)
        with pytest.raises(NodeFailure) as exc:
            custom_llm.start(ctx)
        assert str(exc.value) == 'the model returned nothing'
        _stub(ctx.projects).assert_not_called()

    def test_the_answer_is_stripped_before_it_is_saved(self):
        ctx = _ctx(answer='  \n# Haiku\n  ')
        custom_llm.start(ctx)
        assert _stub(ctx.projects).call_args.kwargs['body']['content'] == '# Haiku'


class TestWithoutAProjectTheAnswerStaysOnTheRun:
    def test_summary_is_clipped_to_400_and_the_stored_text_to_4000(self):
        answer = ''.join(str(i % 10) for i in range(5000))
        ctx = _ctx(project_id=None, answer=answer)
        result = custom_llm.start(ctx)
        assert result == {
            'node_id': 'n_custom', 'status': 'done', 'summary': answer[:400],
            'updates': {'custom_outputs': {'n_custom': answer[:4000]}},
        }
        assert len(result['summary']) == 400
        assert len(result['updates']['custom_outputs']['n_custom']) == 4000
        _stub(ctx.projects).assert_not_called()


class TestWithAProjectTheAnswerBecomesACustomDocument:
    def test_the_document_is_posted_with_a_120_character_title(self):
        title = 'T' * 130
        ctx = _ctx(title=title, answer='# Body')
        result = custom_llm.start(ctx)
        _stub(ctx.projects).assert_called_once_with(
            'POST', '/projects/p1/documents',
            body={'title': 'T' * 120, 'content': '# Body', 'document_type': 'custom'},
            path_parameters={'project_id': 'p1'})
        assert result == {
            'node_id': 'n_custom', 'status': 'done', 'summary': f'{title} saved as a document',
            'artifacts': {'project_id': 'p1', 'document_id': 'doc_7', 'document_type': 'custom'},
        }

    @pytest.mark.parametrize('payload', [
        None,
        'saved',
        {'success': True},
        {'document': 'doc_7'},
        {'document': {}},
        {'document': {'document_id': 7}},
        {'document': {'document_id': None}},
        {'documents': {'document_id': 'doc_7'}},
    ])
    def test_every_malformed_save_response_is_refused(self, payload):
        with pytest.raises(NodeFailure) as exc:
            custom_llm.start(_ctx(payload=payload))
        assert str(exc.value) == 'the document could not be saved'
