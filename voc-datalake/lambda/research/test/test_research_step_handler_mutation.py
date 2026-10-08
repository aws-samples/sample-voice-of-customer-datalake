"""Mutation hardening for `research/research_step_handler.py`.

The earlier suites drive each step and check the headline result (a feedback
count, a key being present, a substring of the prompt), but a mutation run found
what they cannot see:

* the JOB PROGRESS TRAIL. Every step reports `(status, progress, current_step)`
  to the jobs table, which is what the project page's progress bar renders;
  no test pinned a single number or step label, so `10` becoming `11` or
  `'initializing'` becoming `'XXinitializingXX'` passed.
* the exact BOUNDARIES: the 50,000-character feedback cut, the 350,000-character
  report cut (exactly at the limit must be kept whole), the 3-document and
  5,000-character reference caps.
* the DEFAULTS read from an unvalidated Step Functions input (`days` 30, the
  default question, `'Untitled'`/`'DOC'` for a bare document, `'Unknown error'`).
* the saved RESEARCH ITEM and the completion record, field by field.
* the log lines an operator greps for when a job fails.
"""
import importlib.util
from collections.abc import Iterator
from datetime import UTC, datetime
from typing import Any
from unittest.mock import MagicMock, call, patch

import pytest
import research_step_handler as rsh
from boto3.dynamodb.conditions import Key

from shared.agentic_search import AgenticSearchOutcome
from shared.derivation import build_derivation
from shared.persona_context import personas_prompt_context
from shared.prompts import get_response_language_instruction
from shared.test.instrumentation_fixtures import assert_handler_wrapped, assert_tracer_wrapped

P, J = 'p1', 'j1'
INFERENCE_CONFIG = {
    'system_prompt': 'SYS', 'max_tokens': 1234, 'thinking_budget': 56, 'step_name': 'cfg_step',
}


class FrozenDatetime(datetime):
    """`datetime` whose `now` is 2026-03-04 05:06:07 (in the zone asked for)."""

    @classmethod
    def now(cls, tz: Any = None) -> 'FrozenDatetime':
        return cls(2026, 3, 4, 5, 6, 7, tzinfo=tz)


NOW_ISO = '2026-03-04T05:06:07+00:00'
RESEARCH_ID = 'research_20260304050607_a1b2c3d4'


@pytest.fixture
def job_status() -> Iterator[MagicMock]:
    with patch('research_step_handler.update_job_status') as mock:
        yield mock


@pytest.fixture
def log() -> Iterator[MagicMock]:
    with patch('research_step_handler.logger') as mock:
        yield mock


@pytest.fixture
def converse() -> Iterator[MagicMock]:
    with patch('research_step_handler.converse', return_value='MODEL TEXT') as mock:
        yield mock


@pytest.fixture
def step_config() -> Iterator[MagicMock]:
    with patch('research_step_handler.get_research_step_config', return_value=dict(INFERENCE_CONFIG)) as mock:
        yield mock


@pytest.fixture
def frozen_clock() -> Iterator[None]:
    with patch('research_step_handler.datetime', FrozenDatetime):
        yield


def _running(progress: int, step: str) -> Any:
    return call(P, J, 'running', progress, step)


class TestLazyTableAccessors:
    @pytest.mark.parametrize(('getter', 'factory', 'attr'), [
        ('_get_feedback_table', 'get_feedback_table', 'feedback_table'),
        ('_get_projects_table', 'get_projects_table', 'projects_table'),
    ])
    def test_builds_once_and_then_reuses(self, monkeypatch: pytest.MonkeyPatch,
                                         getter: str, factory: str, attr: str) -> None:
        monkeypatch.setattr(rsh, attr, None)
        table = object()
        fake = MagicMock(return_value=table)
        monkeypatch.setattr(rsh, factory, fake)

        assert getattr(rsh, getter)() is table
        assert getattr(rsh, getter)() is table
        fake.assert_called_once_with()

    @pytest.mark.parametrize(('getter', 'factory', 'attr'), [
        ('_get_feedback_table', 'get_feedback_table', 'feedback_table'),
        ('_get_projects_table', 'get_projects_table', 'projects_table'),
    ])
    def test_an_existing_table_is_returned_unbuilt(self, monkeypatch: pytest.MonkeyPatch,
                                                   getter: str, factory: str, attr: str) -> None:
        existing = object()
        monkeypatch.setattr(rsh, attr, existing)
        fake = MagicMock()
        monkeypatch.setattr(rsh, factory, fake)

        assert getattr(rsh, getter)() is existing
        fake.assert_not_called()


class TestBedrockCall:
    def test_the_throttling_alias_is_the_shared_error(self) -> None:
        from shared.converse import BedrockThrottlingError
        assert rsh.BedrockThrottlingException is BedrockThrottlingError

    def test_defaults_reach_converse(self, converse: MagicMock) -> None:
        assert rsh.invoke_bedrock_with_retry('S', 'U') == 'MODEL TEXT'
        converse.assert_called_once_with(
            prompt='U', system_prompt='S', max_tokens=4096, thinking_budget=0,
            surface='documents', max_retries=3, raise_on_throttle=True, step_name='unknown',
        )

    def test_explicit_values_reach_converse(self, converse: MagicMock) -> None:
        rsh.invoke_bedrock_with_retry('S', 'U', max_tokens=7, max_retries=2, thinking_budget=9, step_name='x')
        converse.assert_called_once_with(
            prompt='U', system_prompt='S', max_tokens=7, thinking_budget=9,
            surface='documents', max_retries=2, raise_on_throttle=True, step_name='x',
        )


@pytest.mark.usefixtures('step_config')
class TestStepInference:
    def test_without_language_the_config_is_passed_through(self, step_config: MagicMock) -> None:
        assert rsh._step_inference('synthesis', {}) == INFERENCE_CONFIG
        step_config.assert_called_once_with('synthesis')

    @pytest.mark.parametrize('language', [None, 'en'])
    def test_english_or_none_adds_nothing(self, language: str | None) -> None:
        assert rsh._step_inference('s', {'response_language': language})['system_prompt'] == 'SYS'

    def test_a_language_instruction_is_appended_after_a_blank_line(self) -> None:
        result = rsh._step_inference('s', {'response_language': 'es'})
        assert result['system_prompt'] == f"SYS\n\n{get_response_language_instruction('es')}"


class TestFeedbackContextWrapper:
    def test_default_limit_is_100_and_uses_the_feedback_table(self) -> None:
        table = object()
        with patch('research_step_handler._get_feedback_table', return_value=table), \
                patch('research_step_handler._get_feedback_context', return_value=['x']) as shared:
            assert rsh.get_feedback_context({'f': 1}) == ['x']
        shared.assert_called_once_with(table, {'f': 1}, 100)


class TestProjectItems:
    def test_queries_the_project_partition(self) -> None:
        table = MagicMock()
        table.query.return_value = {'Items': [{'sk': 'A'}]}
        assert rsh._project_items(table, 'p9') == [{'sk': 'A'}]
        table.query.assert_called_once_with(KeyConditionExpression=Key('pk').eq('PROJECT#p9'))

    def test_a_response_without_items_is_empty(self) -> None:
        table = MagicMock()
        table.query.return_value = {}
        assert rsh._project_items(table, 'p9') == []

    @pytest.mark.parametrize(('item', 'expected'), [
        ({'sk': 'DOC#1'}, 'DOC#1'), ({'sk': 5}, ''), ({}, ''),
    ])
    def test_sort_key_is_a_string_or_empty(self, item: dict, expected: str) -> None:
        assert rsh._sort_key(item) == expected


def _table(items: list[dict]) -> MagicMock:
    table = MagicMock()
    table.query.return_value = {'Items': items}
    return table


PERSONA = {'sk': 'PERSONA#a', 'persona_id': 'a', 'name': 'Ana', 'tagline': 'Busy'}


class TestSelectedPersonas:
    @pytest.mark.parametrize(('ids', 'table'), [([], _table([PERSONA])), (['a'], None)])
    def test_nothing_selected_or_no_table_reads_nothing(self, job_status: MagicMock,
                                                        ids: list, table: Any) -> None:
        assert rsh._selected_personas_context(table, P, J, ids) == ('', [])
        job_status.assert_not_called()
        if table is not None:
            table.query.assert_not_called()

    def test_selected_personas_become_the_section(self, job_status: MagicMock) -> None:
        other = {'sk': 'PERSONA#b', 'persona_id': 'b', 'name': 'Bo'}
        not_a_persona = {'sk': 'DOC#a', 'persona_id': 'a', 'name': 'Doc'}
        no_sk = {'persona_id': 'a', 'name': 'Nosk'}
        table = _table([PERSONA, other, not_a_persona, no_sk])

        context, used = rsh._selected_personas_context(table, P, J, ['a'])

        assert context == personas_prompt_context([PERSONA], header='## Selected Personas')
        assert context.startswith('## Selected Personas\n\n')
        assert used == ['a']
        job_status.assert_called_once_with(P, J, 'running', 17, 'fetching_personas')

    def test_a_blank_persona_id_is_not_recorded(self, job_status: MagicMock) -> None:
        blank = {'sk': 'PERSONA#x', 'persona_id': '', 'name': 'Blank'}
        context, used = rsh._selected_personas_context(_table([blank, PERSONA]), P, J, ['', 'a'])
        assert 'Blank' in context
        assert used == ['a']
        assert job_status.call_count == 1

    def test_no_match_is_empty_after_the_status(self, job_status: MagicMock) -> None:
        assert rsh._selected_personas_context(_table([PERSONA]), P, J, ['zzz']) == ('', [])
        job_status.assert_called_once_with(P, J, 'running', 17, 'fetching_personas')


def _doc(sk: str, doc_id: str, **extra: Any) -> dict:
    return {'sk': sk, 'document_id': doc_id, **extra}


class TestSelectedDocuments:
    @pytest.mark.parametrize(('ids', 'table'), [([], _table([_doc('DOC#1', '1')])), (['1'], None)])
    def test_nothing_selected_or_no_table_reads_nothing(self, job_status: MagicMock,
                                                        ids: list, table: Any) -> None:
        assert rsh._selected_documents_context(table, P, J, ids) == ('', [])
        job_status.assert_not_called()

    @pytest.mark.parametrize('prefix', ['DOC#', 'RESEARCH#', 'PRD#', 'PRFAQ#'])
    def test_every_document_kind_is_read(self, job_status: MagicMock, prefix: str) -> None:
        table = _table([_doc(f'{prefix}1', '1', title='T', document_type='prd', content='body')])
        context, sources = rsh._selected_documents_context(table, P, J, ['1'])
        assert context == '## Reference Documents\n\n### T (PRD)\n\nbody\n\n---\n\n'
        assert sources == [{'document_id': '1', 'role': 'reference'}]
        job_status.assert_called_once_with(P, J, 'running', 18, 'fetching_documents')

    def test_a_bare_document_reads_untitled_doc_with_no_body(self, job_status: MagicMock) -> None:
        context, _ = rsh._selected_documents_context(_table([_doc('DOC#1', '1')]), P, J, ['1'])
        assert context == '## Reference Documents\n\n### Untitled (DOC)\n\n\n\n---\n\n'
        assert job_status.call_count == 1

    def test_unselected_or_foreign_items_are_skipped(self, job_status: MagicMock) -> None:
        table = _table([_doc('PERSONA#1', '1'), _doc('DOC#2', '2'), {'document_id': '1'}])
        assert rsh._selected_documents_context(table, P, J, ['1']) == ('', [])
        assert job_status.call_count == 1

    def test_three_documents_and_5000_characters_each(self, job_status: MagicMock) -> None:
        docs = [_doc(f'DOC#{i}', str(i), title=f'T{i}', content=str(i) * 5001) for i in range(4)]
        context, sources = rsh._selected_documents_context(_table(docs), P, J, ['0', '1', '2', '3'])
        expected = '## Reference Documents\n\n' + ''.join(
            f'### T{i} (DOC)\n\n{str(i) * 5000}\n\n---\n\n' for i in range(3)
        )
        assert context == expected
        assert sources == [{'document_id': str(i), 'role': 'reference'} for i in range(3)]
        assert job_status.call_count == 1

    def test_a_blank_document_id_is_used_but_not_recorded(self, job_status: MagicMock) -> None:
        context, sources = rsh._selected_documents_context(
            _table([_doc('DOC#x', '', title='Blank')]), P, J, [''],
        )
        assert '### Blank (DOC)' in context
        assert sources == []
        assert job_status.call_count == 1


class TestWebSearchContext:
    @pytest.mark.parametrize('flag', [False, 'true', 1, None])
    def test_only_a_real_true_searches(self, job_status: MagicMock, flag: Any) -> None:
        with patch('research_step_handler.is_web_search_configured') as configured:
            assert rsh._web_search_context(P, J, {'use_web_search': flag}, 's') == ('', [])
        configured.assert_not_called()
        job_status.assert_not_called()

    def test_unconfigured_warns_and_skips(self, job_status: MagicMock, log: MagicMock) -> None:
        with patch('research_step_handler.is_web_search_configured', return_value=False), \
                patch('research_step_handler.run_agentic_web_search') as search:
            assert rsh._web_search_context(P, J, {'use_web_search': True}, 's') == ('', [])
        log.warning.assert_called_once_with(
            'use_web_search requested but web search is not configured; skipping')
        search.assert_not_called()
        job_status.assert_not_called()

    def test_a_search_returns_its_context_and_queries(self, job_status: MagicMock, log: MagicMock) -> None:
        outcome = AgenticSearchOutcome(context='CTX', queries=['q1', 'q2'], result_count=3)
        with patch('research_step_handler.is_web_search_configured', return_value=True), \
                patch('research_step_handler.run_agentic_web_search', return_value=outcome) as search:
            assert rsh._web_search_context(P, J, {'use_web_search': True}, 'hint') == ('CTX', ['q1', 'q2'])
        search.assert_called_once_with('', context_hint='hint')
        job_status.assert_called_once_with(P, J, 'running', 19, 'searching_web')
        log.info.assert_called_once_with('Web search grounding: 2 queries, 3 results')

    def test_a_failure_is_logged_and_degrades(self, job_status: MagicMock, log: MagicMock) -> None:
        with patch('research_step_handler.is_web_search_configured', return_value=True), \
                patch('research_step_handler.run_agentic_web_search', side_effect=RuntimeError('x')):
            assert rsh._web_search_context(P, J, {'use_web_search': True, 'question': 'Q'}, 's') == ('', [])
        log.exception.assert_called_once_with('Web search failed, continuing without web context')
        log.info.assert_not_called()
        assert job_status.call_count == 1


@pytest.fixture
def initialize_stubs() -> Iterator[dict[str, MagicMock]]:
    """step_initialize with the feedback read and formatting stubbed, no project table."""
    items = [{'original_text': 'a'}, {'original_text': 'b'}]
    with patch('research_step_handler.get_feedback_context', return_value=items) as fetch, \
            patch('research_step_handler.format_feedback_for_llm', return_value='FB') as fmt, \
            patch('research_step_handler.get_feedback_statistics', return_value='STATS') as stats, \
            patch('research_step_handler._get_projects_table', return_value=None):
        yield {'fetch': fetch, 'format': fmt, 'stats': stats}


def _initialize(config: dict) -> dict:
    return rsh.step_initialize({'project_id': P, 'job_id': J, 'research_config': config})


class TestStepInitialize:
    def test_defaults_progress_trail_and_result(self, initialize_stubs: dict[str, MagicMock],
                                                job_status: MagicMock, log: MagicMock) -> None:
        result = _initialize({})

        initialize_stubs['fetch'].assert_called_once_with({
            'sources': [], 'categories': [], 'sentiments': [], 'days': 30,
            'date_basis': 'imported', 'category_scope': None,
        }, limit=50)
        assert job_status.call_args_list == [
            _running(10, 'initializing'), _running(12, 'fetching_feedback'),
            _running(15, 'formatting_data'), _running(20, 'data_ready'),
        ]
        assert log.info.call_args_list == [
            call('Initializing research for project p1, job j1'), call('Fetched 2 feedback items'),
        ]
        assert result == {
            'feedback_context': 'FB', 'feedback_stats': 'STATS', 'feedback_count': 2,
            'personas_context': '', 'documents_context': '', 'web_context': '',
            'web_search_queries': [],
            'derivation': build_derivation(feedback_count=2),
        }

    def test_the_configured_filters_are_forwarded(self, initialize_stubs: dict[str, MagicMock]) -> None:
        with patch('research_step_handler.update_job_status'):
            _initialize({'sources': ['s'], 'categories': ['c'], 'sentiments': ['n'], 'days': 7,
                         'date_basis': 'review', 'category_scope': {'all': True}})
        initialize_stubs['fetch'].assert_called_once_with({
            'sources': ['s'], 'categories': ['c'], 'sentiments': ['n'], 'days': 7,
            'date_basis': 'review', 'category_scope': {'all': True},
        }, limit=50)

    def test_no_feedback_stops_after_the_fetch(self, initialize_stubs: dict[str, MagicMock],
                                               job_status: MagicMock) -> None:
        initialize_stubs['fetch'].return_value = []
        with pytest.raises(ValueError, match=r'^No feedback data found matching the filters$'):
            _initialize({})
        assert job_status.call_args_list == [_running(10, 'initializing'), _running(12, 'fetching_feedback')]

    @pytest.mark.parametrize(('length', 'expected'), [
        (50000, 'x' * 50000),
        (50001, 'x' * 50000 + '\n\n[... truncated ...]'),
    ])
    @pytest.mark.usefixtures('job_status')
    def test_feedback_is_cut_after_50000_characters(self, initialize_stubs: dict[str, MagicMock],
                                                    length: int, expected: str) -> None:
        initialize_stubs['format'].return_value = 'x' * length
        assert _initialize({})['feedback_context'] == expected

    @pytest.mark.usefixtures('job_status', 'initialize_stubs')
    def test_the_selection_and_web_search_are_threaded_through(self) -> None:
        table = object()
        with patch('research_step_handler._get_projects_table', return_value=table), \
                patch('research_step_handler._selected_personas_context',
                      return_value=('PERS', ['a'])) as personas, \
                patch('research_step_handler._selected_documents_context',
                      return_value=('DOCS', [{'document_id': 'd', 'role': 'reference'}])) as documents, \
                patch('research_step_handler._web_search_context', return_value=('WEB', ['q'])) as web:
            config = {'selected_persona_ids': ['a'], 'selected_document_ids': ['d', 'e']}
            result = _initialize(config)

        personas.assert_called_once_with(table, P, J, ['a'])
        documents.assert_called_once_with(table, P, J, ['d', 'e'])
        web.assert_called_once_with(P, J, config, 'STATS')
        assert (result['personas_context'], result['documents_context']) == ('PERS', 'DOCS')
        assert (result['web_context'], result['web_search_queries']) == ('WEB', ['q'])
        assert result['derivation'] == build_derivation(
            sources=[{'document_id': 'd', 'role': 'reference'}], selected_document_count=2,
            feedback_count=2, persona_ids=['a'],
        )


ANALYZE_EVENT = {
    'project_id': P, 'job_id': J, 'research_config': {},
    'feedback_context': 'FBCTX', 'feedback_stats': 'FBSTATS',
}


@pytest.mark.usefixtures('step_config')
class TestStepAnalyze:
    def test_progress_trail_inference_and_default_question(self, job_status: MagicMock, converse: MagicMock,
                                                           log: MagicMock, step_config: MagicMock) -> None:
        assert rsh.step_analyze(dict(ANALYZE_EVENT)) == {'analysis': 'MODEL TEXT'}

        step_config.assert_called_once_with('data_analysis')
        assert job_status.call_args_list == [
            _running(25, 'preparing_analysis'), _running(30, 'calling_ai'), _running(45, 'analysis_complete'),
        ]
        log.info.assert_called_once_with('Starting analysis for job j1')
        kwargs = converse.call_args.kwargs
        assert (kwargs['system_prompt'], kwargs['max_tokens'], kwargs['thinking_budget'], kwargs['step_name']) \
            == ('SYS', 1234, 56, 'cfg_step')
        prompt = kwargs['prompt']
        assert 'RESEARCH QUESTION: What are the main customer pain points?\n' in prompt
        assert '## FEEDBACK STATISTICS:\nFBSTATS\n\n## ACTUAL CUSTOMER FEEDBACK DATA:\nFBCTX\n\n---' in prompt
        assert 'Based on the ACTUAL FEEDBACK DATA above, analyze:' in prompt
        assert prompt.startswith('Conduct a thorough analysis to answer this research question')
        assert prompt.endswith('Do not make assumptions beyond what the data shows.')

    @pytest.mark.usefixtures('job_status')
    def test_each_context_is_wrapped_in_newlines(self, converse: MagicMock) -> None:
        rsh.step_analyze({**ANALYZE_EVENT, 'research_config': {'question': 'Why?'},
                          'personas_context': 'PERS', 'documents_context': 'DOCS', 'web_context': 'WEB'})
        prompt = converse.call_args.kwargs['prompt']
        assert 'RESEARCH QUESTION: Why?\n' in prompt
        assert 'FBCTX\n\nPERS\n\nDOCS\n\n## PUBLIC WEB SEARCH RESULTS\n' in prompt
        assert 'to customers.\n\nWEB\n\n---' in prompt
        assert 'Based on the ACTUAL FEEDBACK DATA above and the provided context, analyze:' in prompt

    @pytest.mark.parametrize('key', ['personas_context', 'documents_context', 'web_context'])
    @pytest.mark.usefixtures('job_status')
    def test_any_one_context_names_the_provided_context(self, converse: MagicMock, key: str) -> None:
        rsh.step_analyze({**ANALYZE_EVENT, key: 'ONLY'})
        prompt = converse.call_args.kwargs['prompt']
        assert 'above and the provided context, analyze:' in prompt
        assert '\nONLY\n' in prompt
        assert ('PUBLIC WEB SEARCH RESULTS' in prompt) is (key == 'web_context')


@pytest.mark.usefixtures('step_config')
class TestStepSynthesizeAndValidate:
    def test_synthesize(self, job_status: MagicMock, converse: MagicMock,
                        log: MagicMock, step_config: MagicMock) -> None:
        assert rsh.step_synthesize({'project_id': P, 'job_id': J, 'analysis': 'ANA'}) == {'synthesis': 'MODEL TEXT'}
        step_config.assert_called_once_with('synthesis')
        assert job_status.call_args_list == [
            _running(50, 'preparing_synthesis'), _running(55, 'calling_ai'), _running(70, 'synthesis_complete'),
        ]
        log.info.assert_called_once_with('Synthesizing findings for job j1')
        prompt = converse.call_args.kwargs['prompt']
        assert prompt.startswith('Synthesize the analysis into clear findings.\n\nPrevious analysis:\nANA\n')
        assert prompt.endswith('5. **Areas for Further Research**')
        assert converse.call_args.kwargs['step_name'] == 'cfg_step'

    def test_validate(self, job_status: MagicMock, converse: MagicMock,
                      log: MagicMock, step_config: MagicMock) -> None:
        event = {'project_id': P, 'job_id': J, 'analysis': 'ANA', 'synthesis': 'SYN'}
        assert rsh.step_validate(event) == {'validation': 'MODEL TEXT'}
        step_config.assert_called_once_with('validation')
        assert job_status.call_args_list == [
            _running(75, 'preparing_validation'), _running(80, 'calling_ai'), _running(90, 'validation_complete'),
        ]
        log.info.assert_called_once_with('Validating research for job j1')
        prompt = converse.call_args.kwargs['prompt']
        assert prompt.startswith('Review and validate the research findings.\n\nAnalysis:\nANA\n\nSynthesis:\nSYN\n')
        assert prompt.endswith('Provide a final validated research report.')


def _save_event(config: dict, **extra: Any) -> dict:
    return {
        'project_id': P, 'job_id': J, 'research_config': config, 'feedback_count': 4,
        'analysis': 'ANA', 'synthesis': 'SYN', 'validation': 'VAL', **extra,
    }


@pytest.fixture
def saved() -> Iterator[MagicMock]:
    """The projects table put_project_item_and_increment receives.

    create_counted_project_child mints the id (pinned to RESEARCH_ID's shape, keeping
    the prefix the handler asked for) and makes this one write.
    """
    table = MagicMock()
    with patch('research_step_handler._get_projects_table', return_value=table), \
            patch('shared.ids.timestamped_id',
                  side_effect=lambda prefix, _now=None: f'{prefix}_20260304050607_a1b2c3d4'), \
            patch('shared.project_writes.put_project_item_and_increment') as put:
        put.projects_table = table
        yield put


def _saved_item(put: MagicMock) -> dict:
    return put.call_args.args[2]


@pytest.mark.usefixtures('frozen_clock')
class TestStepSave:
    def test_defaults_item_completion_and_result(self, saved: MagicMock, job_status: MagicMock,
                                                 log: MagicMock) -> None:
        result = rsh.step_save(_save_event({}))

        assert result == {'success': True, 'document_id': RESEARCH_ID, 'feedback_count': 4}
        log.info.assert_called_once_with('Saving research results for job j1')
        title = 'Research: Research'
        assert job_status.call_args_list == [
            _running(95, 'saving'),
            call(P, J, 'completed', 100, 'complete', result={'document_id': RESEARCH_ID, 'title': title}),
        ]
        table, project_id, item, counter = saved.call_args.args
        assert (project_id, counter) == (P, 'document_count')
        assert item.pop('content').startswith(
            '# Research Report: Research\n\n**Generated:** 2026-03-04\n**Feedback Analyzed:** 4 items\n'
            '**Filters:** Sources: All | Categories: All | Sentiments: All | Days: 30 | Date basis: imported\n')
        assert item == {
            'pk': 'PROJECT#p1', 'sk': f'RESEARCH#{RESEARCH_ID}', 'gsi1pk': 'PROJECT#p1#DOCUMENTS',
            'gsi1sk': NOW_ISO, 'document_id': RESEARCH_ID, 'document_type': 'research', 'title': title,
            'question': 'Research', 'feedback_count': 4, 'date_basis': 'imported', 'job_id': J,
            'derivation': build_derivation(), 'created_at': NOW_ISO,
        }
        assert table is saved.projects_table

    def test_the_report_body_in_order(self, saved: MagicMock, job_status: MagicMock) -> None:
        rsh.step_save(_save_event({'question': 'Q', 'filters': {
            'sources': ['a', 'b'], 'categories': ['c', 'd'], 'sentiments': ['n', 'm'], 'days': 9}}))
        assert _saved_item(saved)['content'] == (
            '# Research Report: Q\n\n**Generated:** 2026-03-04\n**Feedback Analyzed:** 4 items\n'
            '**Filters:** Sources: a, b | Categories: c, d | Sentiments: n, m | Days: 9 | Date basis: imported\n\n'
            '---\n\n## Executive Summary & Key Findings\n\nSYN\n\n---\n\n## Detailed Analysis\n\nANA\n\n'
            '---\n\n## Validation & Confidence Assessment\n\nVAL\n'
        )
        assert job_status.call_count == 2

    def test_title_question_and_derivation_come_from_the_event(self, saved: MagicMock,
                                                               job_status: MagicMock) -> None:
        derivation = {'sources': [], 'feedback_count': 4}
        rsh.step_save(_save_event({'question': 'Q' * 60, 'title': 'Named'}, derivation=derivation))
        item = _saved_item(saved)
        assert (item['title'], item['question'], item['derivation']) == ('Named', 'Q' * 60, derivation)
        assert job_status.call_args.kwargs == {'result': {'document_id': RESEARCH_ID, 'title': 'Named'}}

    def test_a_long_question_titles_on_its_first_50_characters(self, saved: MagicMock,
                                                               job_status: MagicMock) -> None:
        result = rsh.step_save(_save_event({'question': 'abcde' * 12}))
        title = 'Research: ' + 'abcde' * 10
        assert _saved_item(saved)['title'] == title
        assert job_status.call_args.kwargs == {'result': {'document_id': result['document_id'], 'title': title}}

    @pytest.mark.usefixtures('job_status')
    def test_report_kept_whole_at_350000_and_cut_after(self, saved: MagicMock) -> None:
        rsh.step_save(_save_event({}, validation=''))
        base = len(_saved_item(saved)['content'])
        rsh.step_save(_save_event({}, validation='a' * (350000 - base)))
        whole = _saved_item(saved)['content']
        assert len(whole) == 350000
        assert whole.endswith('a\n')
        rsh.step_save(_save_event({}, validation='a' * (350001 - base)))
        # The report ends "<validation>\n"; one more character pushes that newline past the cut.
        assert _saved_item(saved)['content'] == \
            whole[:-1] + 'a' + '\n\n---\n\n*[Report truncated due to size limits]*'

    def test_no_table_still_completes(self, job_status: MagicMock) -> None:
        with patch('research_step_handler._get_projects_table', return_value=None), \
                patch('shared.project_writes.put_project_item_and_increment') as put:
            assert rsh.step_save(_save_event({}))['success'] is True
        put.assert_not_called()
        assert job_status.call_args.args[2] == 'completed'

    @pytest.mark.parametrize(('queries', 'note', 'section'), [
        (None, ' | Web search: enabled', ''),
        ([' ', 7], ' | Web search: enabled', ''),
        (['one'], ' | Web search: enabled (1 query)',
         '\n---\n\n## Web Searches\n\nPublic-web grounding for this report came from the following searches:'
         '\n\n1. "one"\n'),
        (['a  b', 'c'], ' | Web search: enabled (2 queries)',
         '\n---\n\n## Web Searches\n\nPublic-web grounding for this report came from the following searches:'
         '\n\n1. "a b"\n2. "c"\n'),
    ])
    @pytest.mark.usefixtures('job_status')
    def test_web_search_disclosure(self, saved: MagicMock, queries: Any, note: str, section: str) -> None:
        extra = {} if queries is None else {'web_search_queries': queries}
        rsh.step_save(_save_event({'use_web_search': True}, **extra))
        content = _saved_item(saved)['content']
        assert f'Date basis: imported{note}\n\n---' in content
        assert content.endswith(f'## Validation & Confidence Assessment\n\nVAL\n{section}')

    @pytest.mark.usefixtures('job_status')
    def test_queries_without_web_search_are_not_disclosed(self, saved: MagicMock) -> None:
        rsh.step_save(_save_event({'use_web_search': 'yes'}, web_search_queries=['q']))
        assert _saved_item(saved)['content'].endswith('Assessment\n\nVAL\n')


class TestStepError:
    def _error(self, error: Any, job_status: MagicMock) -> str:
        event: dict[str, Any] = {'project_id': P, 'job_id': J}
        if error is not None:
            event['error'] = error
        result = rsh.step_error(event)
        message = result['error']
        assert result == {'success': False, 'error': message}
        job_status.assert_called_once_with(P, J, 'failed', 0, 'error', error=message)
        return message

    @pytest.mark.parametrize(('error', 'expected'), [
        (None, 'Unknown error'),
        ({}, 'Unknown error'),
        ({'Error': 'E'}, 'E'),
        ({'Cause': '{}', 'Error': 'E'}, 'E'),
        ({'Cause': '', 'Error': 'E'}, 'E'),
        ({'Cause': 'not json', 'Error': 'E'}, 'not json'),
        ({'Cause': 5, 'Error': 'E'}, 5),
        ({'Cause': '{"errorMessage": "boom"}', 'Error': 'E'}, 'boom'),
        ({'Cause': '{"other": 1}', 'Error': 'E'}, '{"other": 1}'),
    ])
    def test_the_message_comes_from_the_best_field(self, job_status: MagicMock, log: MagicMock,
                                                   error: Any, expected: Any) -> None:
        assert self._error(error, job_status) == expected
        assert log.error.call_args_list == [
            call({} if error is None else error), call(f'Research job j1 failed: {expected}'),
        ]


class TestLambdaHandler:
    @pytest.mark.parametrize('step', ['initialize', 'analyze', 'synthesize', 'validate', 'save', 'error'])
    def test_each_step_routes_to_its_function(self, step: str) -> None:
        fake = MagicMock(return_value={'ok': step})
        with patch(f'research_step_handler.step_{step}', fake):
            assert rsh._step_function(step) is fake

    def test_an_unknown_step_names_itself(self) -> None:
        with pytest.raises(ValueError, match=r'^Unknown step: nope$'):
            rsh._step_function('nope')

    def test_a_step_result_is_returned_and_logged(self, lambda_context: Any, log: MagicMock) -> None:
        event = {'step': 'save'}
        with patch('research_step_handler.step_save', return_value={'done': 1}) as step:
            assert rsh.lambda_handler(event, lambda_context) == {'done': 1}
        step.assert_called_once_with(event)
        log.info.assert_called_once_with('Executing research step: save')

    def test_a_missing_step_is_unknown(self, lambda_context: Any, log: MagicMock) -> None:
        with pytest.raises(ValueError, match=r'^Unknown step: unknown$'):
            rsh.lambda_handler({}, lambda_context)
        log.exception.assert_called_once_with('Step unknown failed: Unknown step: unknown')

    def test_throttling_is_logged_as_throttling_and_reraised(self, lambda_context: Any, log: MagicMock) -> None:
        error = rsh.BedrockThrottlingException('slow down')
        with patch('research_step_handler.step_analyze', side_effect=error), \
                pytest.raises(rsh.BedrockThrottlingException) as raised:
            rsh.lambda_handler({'step': 'analyze'}, lambda_context)
        assert raised.value is error
        log.exception.assert_called_once_with('Bedrock throttling in step analyze: slow down')


class TestModuleWiring:
    @pytest.mark.parametrize('name', [
        'step_initialize', 'step_analyze', 'step_synthesize', 'step_validate', 'step_save', 'step_error',
    ])
    def test_every_step_is_traced(self, name: str) -> None:
        assert_tracer_wrapped(rsh, name)

    def test_the_handler_carries_its_decorator(self) -> None:
        assert_handler_wrapped(rsh)

    def test_a_fresh_import_has_no_table_yet(self) -> None:
        """The lazy getters build on `is None`; any other sentinel would be returned as the table."""
        spec = importlib.util.spec_from_file_location('research_step_handler_fresh', rsh.__file__)
        assert spec is not None
        assert spec.loader is not None
        fresh = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(fresh)
        assert fresh.feedback_table is None
        assert fresh.projects_table is None


def test_frozen_clock_is_utc_aware() -> None:
    """Guards the fixture: the saved timestamps above are only meaningful in UTC."""
    assert FrozenDatetime.now(UTC).isoformat() == NOW_ISO
