"""Mutation hardening for `jobs/document_generator/handler.py`, lines 1-852.

The earlier suites drive the generator end to end and assert that the right
CONTENT reaches the step builders (a persona name, a reference title), but a
mutation run over the first half of the module found what they cannot see:

* the module's environment wiring — which variable each table / bucket name is
  read from, its default, and that the lambda directory is put FIRST on
  ``sys.path``;
* the job's progress reports (``fetching_feedback`` at 20, ``_personas`` at 30,
  ``_documents`` at 40) and the 15-75 → 50-85 remap of the chain's progress;
* the exact arguments of the feedback fetch (the 30-day default, empty filters
  sent as ``None``), of the projects query and of the chain call's surface;
* the exact text of the reference-documents block (heading, separators, the
  3,000-character per-document cut, the ``Untitled`` fallback) and of the
  feedback + documents join;
* every log line and metric a degraded path emits, and the wording of the two
  prototype-prompt instructions and of the prototype system prompt (pinned
  against golden files: `test_org_context_injection` compares the system prompt
  with the module's own constant, so blanking it passed);
* the chain assemblers' handling of a short chain (each missing PR/FAQ step
  leaves exactly an empty section; a PRD falls back to the last result), the
  versioned item's fields, the fence stripping and HTML cut, and the newest-
  document read's query, pagination, skip and tie rules.
"""
import dataclasses
import importlib.util
import os
import sys
from pathlib import Path
from types import ModuleType
from unittest.mock import ANY, MagicMock, call, patch

import pytest
from boto3.dynamodb.conditions import Key

from jobs.document_generator import handler
from shared import category_access
from shared.api import validate_date_basis
from shared.feedback import feedback_char_budget, feedback_item_limit

from .conftest import TEST_CONTEXT_WINDOW_TOKENS

GOLDEN_INSTRUCTIONS = Path(__file__).parent / 'golden' / 'prototype_org_instructions.txt'
GOLDEN_SYSTEM_PROMPT = Path(__file__).parent / 'golden' / 'prototype_system_prompt.txt'
LAMBDA_DIR = str(Path(os.path.abspath(handler.__file__)).parents[2])
FETCH_LIMIT = feedback_item_limit(feedback_char_budget(window_tokens=TEST_CONTEXT_WINDOW_TOKENS))
ENV_NAMES = ('PROJECTS_TABLE', 'FEEDBACK_TABLE', 'RAW_DATA_BUCKET')


def _fresh_module(env: dict[str, str]) -> tuple[ModuleType, list[str], list[str]]:
    """Execute the handler file anew under ``env`` (the three names unset otherwise).

    Returns the module, ``sys.path`` before and ``sys.path`` after the load.
    """
    spec = importlib.util.spec_from_file_location('document_generator_fresh', handler.__file__)
    assert spec
    assert spec.loader
    module = importlib.util.module_from_spec(spec)
    # A sentinel first entry, so "inserted first" and "inserted second" differ even
    # when the lambda directory already heads the path (as it does under pytest).
    with patch.dict(os.environ), patch.object(sys, 'path', ['/sentinel', *sys.path]):
        for name in ENV_NAMES:
            os.environ.pop(name, None)
        os.environ.update(env)
        before = list(sys.path)
        spec.loader.exec_module(module)
        after = list(sys.path)
    return module, before, after


class TestModuleWiring:
    def test_names_come_from_their_own_variables(self):
        module, _, _ = _fresh_module({
            'PROJECTS_TABLE': 'projects-t', 'FEEDBACK_TABLE': 'feedback-t', 'RAW_DATA_BUCKET': 'raw-b',
        })
        assert (module.PROJECTS_TABLE, module.FEEDBACK_TABLE, module.SCRATCH_BUCKET) == (
            'projects-t', 'feedback-t', 'raw-b')

    def test_every_name_defaults_to_empty(self):
        module, _, _ = _fresh_module({})
        assert (module.PROJECTS_TABLE, module.FEEDBACK_TABLE, module.SCRATCH_BUCKET) == ('', '', '')

    def test_the_lambda_directory_goes_first_on_the_import_path(self):
        _, before, after = _fresh_module({})
        assert after == [LAMBDA_DIR, *before]

    def test_no_aggregates_table_without_its_variable(self, monkeypatch):
        monkeypatch.delenv('AGGREGATES_TABLE', raising=False)
        assert handler._aggregates_table() is None


def _projects_table(items: list[dict]) -> MagicMock:
    table = MagicMock()
    table.query.return_value = {'Items': items}
    return table


class TestGatherContext:
    def test_nothing_requested_reads_nothing_and_records_zeroes(self):
        ctx, projects, feedback = MagicMock(), _projects_table([]), MagicMock()
        gathered = handler._gather_context(ctx, projects, feedback, 'p1', {'data_sources': {}})
        assert gathered == handler.GatheredContext(
            '', '', {'sources': [], 'selected_document_count': 0, 'feedback_count': 0, 'persona_ids': []},
            handler.FeedbackSample('', 0, False),
        )
        assert projects.query.call_count == 0
        assert ctx.update_progress.call_count == 0

    def test_each_source_reports_its_progress_in_order(self):
        ctx = MagicMock()
        sources = {'feedback': True, 'personas': True, 'documents': True}
        with patch.object(handler, '_feedback_context', return_value=handler.FeedbackSample('FB', 1, False)):
            handler._gather_context(ctx, _projects_table([]), MagicMock(), 'p1', {'data_sources': sources})
        assert ctx.update_progress.call_args_list == [
            call(20, 'fetching_feedback'), call(30, 'fetching_personas'), call(40, 'fetching_documents'),
        ]

    def test_project_items_are_queried_once_by_the_project_key(self):
        projects = _projects_table([])
        handler._gather_context(MagicMock(), projects, MagicMock(), 'p1',
                                {'data_sources': {'personas': True, 'research': True}})
        projects.query.assert_called_once_with(KeyConditionExpression=Key('pk').eq('PROJECT#p1'))

    def test_documents_follow_the_feedback_after_one_blank_line(self):
        items = [{'sk': 'DOC#d1', 'document_id': 'd1', 'title': 'Spec', 'content': 'body'}]
        with patch.object(handler, '_feedback_context', return_value=handler.FeedbackSample('FB', 1, False)):
            gathered = handler._gather_context(
                MagicMock(), _projects_table(items), MagicMock(), 'p1',
                {'data_sources': {'feedback': True, 'documents': True}},
            )
        assert gathered.feedback_context == 'FB\n\n## Reference Documents\n\n### Spec\nbody'


class TestFeedbackFetch:
    def _fetch(self, doc_config: dict) -> tuple[MagicMock, MagicMock]:
        table = MagicMock()
        with patch.object(handler, 'query_feedback_by_date', return_value=[]) as fetch, \
                patch.object(handler, 'surface_context_window_tokens',
                             return_value=TEST_CONTEXT_WINDOW_TOKENS) as window:
            handler._feedback_context(table, doc_config)
        fetch.assert_called_once()
        assert fetch.call_args.args == (table,)
        return fetch, window

    def test_the_budget_comes_from_the_documents_surface(self):
        _, window = self._fetch({})
        window.assert_called_once_with('documents')

    def test_defaults_are_thirty_days_and_no_filters(self):
        fetch, _ = self._fetch({'feedback_sources': [], 'feedback_categories': []})
        assert fetch.call_args.kwargs == {
            'days': 30, 'sources': None, 'categories': None, 'limit': FETCH_LIMIT,
            'date_basis': validate_date_basis(None), 'category_scope': None,
        }

    def test_the_request_filters_are_passed_through(self):
        scope = {'all': True}
        fetch, _ = self._fetch({
            'days': 7, 'feedback_sources': ['webscraper'], 'feedback_categories': ['billing'],
            category_access.SCOPE_CONFIG_KEY: scope,
        })
        assert fetch.call_args.kwargs == {
            'days': 7, 'sources': ['webscraper'], 'categories': ['billing'], 'limit': FETCH_LIMIT,
            'date_basis': validate_date_basis(None),
            'category_scope': category_access.scope_from_config(scope),
        }

    def test_a_short_read_logs_what_was_left_out(self):
        reviews = [{'original_text': f'r{i}', 'source_platform': 'ws'} for i in range(2)]
        with patch.object(handler, 'query_feedback_by_date', return_value=reviews), \
                patch.object(handler, 'feedback_char_budget', return_value=100_000), \
                patch.object(handler, 'feedback_item_limit', return_value=2), \
                patch.object(handler, 'logger') as log:
            sample = handler._feedback_context(MagicMock(), {})
        assert (sample.items_used, sample.truncated) == (2, True)
        log.warning.assert_called_once_with(
            '[DOCUMENT] Feedback context does not cover every matching item',
            extra={'items_fetched': 2, 'items_used': 2, 'fetch_limit': 2,
                   'budget_chars': 100_000, 'char_cap_applied': False},
        )


class TestPersonaContext:
    def test_no_personas_is_an_empty_block(self):
        assert handler._persona_context([{'sk': 'DOC#x'}], {}) == ('', [])

    def test_an_empty_rendering_becomes_none(self):
        with patch.object(handler, 'personas_prompt_context', return_value=''):
            result = handler._persona_context([{'sk': 'PERSONA#p1', 'persona_id': 'p1'}], {})
        assert result == ('(none)', ['p1'])


class TestReferenceDocuments:
    def test_nothing_matching_is_an_empty_block_with_the_selected_count(self):
        assert handler._reference_documents([], {'selected_document_ids': ['a', 'b']}) == ('', [], 2)

    def test_every_document_type_prefix_is_a_reference(self):
        items = [
            {'sk': f'{prefix}{i}', 'document_id': str(i), 'title': prefix, 'content': 'c'}
            for i, prefix in enumerate(('PRFAQ#', 'DOC#', 'PERSONA#'))
        ]
        text, sources, count = handler._reference_documents(items, {})
        assert text == '## Reference Documents\n\n### PRFAQ#\nc\n\n### DOC#\nc'
        assert [s['document_id'] for s in sources] == ['0', '1']
        assert count == 0

    def test_the_block_text_is_exact(self):
        items = [
            {'sk': 'RESEARCH#r1', 'document_id': 'r1', 'content': 'x' * 3001},
            {'sk': 'PRD#d1', 'document_id': 'd1', 'title': 'Old PRD'},
        ]
        text, _, _ = handler._reference_documents(items, {})
        assert text == f'## Reference Documents\n\n### Untitled\n{"x" * 3000}\n\n### Old PRD\n'


class TestPinWidgetDegrades:
    def test_a_failed_form_write_is_logged_counted_and_skipped(self):
        with patch.object(handler, '_aggregates_table', return_value=MagicMock()), \
                patch.object(handler, 'ensure_pin_form', side_effect=RuntimeError('down')), \
                patch.object(handler, 'logger') as log, \
                patch.object(handler, 'metrics') as metric:
            assert handler._with_pin_widget('p1', 'doc1', 'T', '<html></html>') == '<html></html>'
        log.warning.assert_called_once_with(
            'Prototype pin form unavailable; built without the widget', extra={'error_type': 'RuntimeError'})
        metric.add_metric.assert_called_once_with(name='PrototypePinFormFailed', unit='Count', value=1)


class TestPrototypeOrgSections:
    def test_the_instructions_match_the_golden_wording(self):
        assert GOLDEN_INSTRUCTIONS.read_text(encoding='utf-8').splitlines() == [
            handler.DESIGN_SYSTEM_INSTRUCTION, handler.COMPANY_CONTEXT_INSTRUCTION,
        ]

    def test_each_present_block_is_followed_by_its_instruction(self):
        with patch.object(handler, '_org_context_blocks', return_value=('CO', 'DS')):
            assert handler._prototype_org_sections() == (
                f'\n\nDS\n\n{handler.DESIGN_SYSTEM_INSTRUCTION}',
                f'\n\nCO\n\n{handler.COMPANY_CONTEXT_INSTRUCTION}',
            )

    def test_absent_blocks_are_empty_sections(self):
        with patch.object(handler, '_org_context_blocks', return_value=('', '')):
            assert handler._prototype_org_sections() == ('', '')


def _failing_producer(name: str, error: Exception) -> dict[str, ModuleType]:
    """A stand-in ``api.product_context`` whose ``name`` raises ``error``."""
    module = ModuleType('api.product_context')

    def producer(*_args):
        raise error

    setattr(module, name, producer)
    return {'api.product_context': module}


class TestOptionalSectionsDegrade:
    def test_a_failed_product_context_logs_and_falls_back(self):
        with patch.dict(sys.modules, _failing_producer('build_product_context_block', RuntimeError('x'))), \
                patch.object(handler, 'logger') as log:
            assert handler._product_context('p1') == (handler.NO_PRODUCT_CONTEXT, False)
        log.exception.assert_called_once_with(
            'Failed to build product context (non-fatal; using the placeholder)')

    def test_a_failed_visual_brief_logs_the_error(self):
        with patch.dict(sys.modules, _failing_producer('build_visual_brief_block', ValueError('boom'))), \
                patch.object(handler, 'logger') as log:
            assert handler._visual_brief('p1', ['v1']) == ('', [])
        log.warning.assert_called_once_with('Failed to build visual brief: boom')


class TestDocumentChain:
    def test_steps_run_on_the_documents_surface_with_remapped_progress(self):
        ctx, build_steps = MagicMock(), MagicMock(return_value=['step'])
        with patch.object(handler, 'converse_chain', return_value=['out']) as chain:
            results = handler._run_document_chain(
                ctx, build_steps, 'idea', 'FB', 'PER', {'response_language': 'ko'}, 'PROD')
        assert results == ['out']
        build_steps.assert_called_once_with(
            feature_idea='idea', personas_context='PER', feedback_context='FB',
            product_context='PROD', response_language='ko',
        )
        chain.assert_called_once_with(['step'], progress_callback=ANY, surface='documents')
        report = chain.call_args.kwargs['progress_callback']
        for progress, step in ((15, 'first'), (45, 'middle'), (75, 'last')):
            report(progress, step)
        assert ctx.update_progress.call_args_list == [call(50, 'first'), call(67, 'middle'), call(85, 'last')]



class TestPrototypeSystemPrompt:
    def test_matches_the_golden_wording(self):
        assert GOLDEN_SYSTEM_PROMPT.read_text(encoding='utf-8').removesuffix('\n') == (
            handler.PROTOTYPE_HTML_SYSTEM_PROMPT)


class TestPrdAssembly:
    @pytest.mark.parametrize(('results', 'content', 'analysis'), [
        (['a'], 'a', {}),
        (['a', 'b'], 'b', {}),
        (['a', 'b', 'c'], 'c', {'problem': 'a', 'solution': 'b'}),
        (['a', 'b', 'c', 'd'], 'c', {'problem': 'a', 'solution': 'b'}),
    ])
    def test_content_is_the_third_result_or_the_last(self, results, content, analysis):
        assert handler._assemble_prd(handler.ChainOutput('idea', results)) == (content, analysis)


def _prfaq(press: str, customer: str, internal: str) -> str:
    return '\n'.join([
        '# PR/FAQ: Idea', '', '## Press Release', '', press, '', '---', '',
        '## Frequently Asked Questions', '', '### Customer FAQ', '', customer, '',
        '### Internal FAQ', '', internal, '',
    ])


class TestPrfaqAssembly:
    @pytest.mark.parametrize(('results', 'document'), [
        (['t'], _prfaq('', '', '')),
        (['t', 'P'], _prfaq('P', '', '')),
        (['t', 'P', 'C'], _prfaq('P', 'C', '')),
        (['t', 'P', 'C', 'I'], _prfaq('P', 'C', 'I')),
    ])
    def test_missing_steps_leave_their_section_empty(self, results, document):
        content, sections = handler._assemble_prfaq(handler.ChainOutput('Idea', results))
        assert content == document
        assert sections == ({} if len(results) < 4 else {
            'customer_insights': 't', 'press_release': 'P', 'customer_faq': 'C', 'internal_faq': 'I'})


class TestDispatchEntries:
    @pytest.mark.parametrize('field', ['build_steps', 'assemble'])
    def test_an_entry_cannot_be_rebound(self, field):
        with pytest.raises(dataclasses.FrozenInstanceError):
            setattr(handler.CHAIN_DOC_TYPES['prd'], field, handler._assemble_prfaq)

    def test_an_unknown_type_names_the_supported_set(self):
        with pytest.raises(handler.UnsupportedDocTypeError) as raised:
            handler._chain_doc_type('onepager')
        assert str(raised.value) == "doc_type 'onepager' has no document generator; supported: prd, prfaq"


class TestDocumentItem:
    def test_fields_are_exact(self):
        fields = handler._document_item_fields(
            'p1', 'j1', 'idea', 'body', {'d': 1}, {'problem': 'x'}, {'feedback_items_used': 3},
            {'date_basis': 'review'})
        now = fields['created_at']
        assert fields == {
            'gsi1pk': 'PROJECT#p1#DOCUMENTS', 'gsi1sk': now, 'feature_idea': 'idea', 'content': 'body',
            'job_id': 'j1', 'derivation': {'d': 1}, 'created_at': now, 'feedback_items_used': 3,
            'date_basis': 'review', 'analysis': {'problem': 'x'},
        }

    def test_a_replay_completes_the_job_with_the_existing_document(self):
        with patch.object(handler, 'update_job_status') as status:
            result = handler._complete_with_existing('p1', 'j1', {'document_id': 'd1', 'title': 'T', 'x': 1})
        assert result == {'document_id': 'd1', 'title': 'T'}
        status.assert_called_once_with('p1', 'j1', 'completed', 100, 'complete', result=result)


class TestHtmlExtraction:
    @pytest.mark.parametrize(('raw', 'html'), [
        ('```html\n<a>\n<b>\n```', '<a>\n<b>'),
        ('```\n<a>\n<b>', '<a>\n<b>'),
        ('```', ''),
        ('<a>\n```', '<a>\n```'),
    ])
    def test_fences_are_stripped(self, raw, html):
        assert handler._strip_html_fences(raw) == html

    @pytest.mark.parametrize(('raw', 'html'), [
        (None, ''),
        ('', ''),
        ('say <html><body>x', '<html><body>x'),
        ('```html\n<!DOCTYPE html><html></html>\n```', '<!DOCTYPE html><html></html>'),
    ])
    def test_the_document_is_cut_out_of_the_reply(self, raw, html):
        assert handler._extract_html(raw) == html


class TestPrototypeObject:
    def test_a_put_without_an_etag_is_refused(self):
        s3 = MagicMock()
        s3.put_object.return_value = {}
        with patch.object(handler, '_s3', return_value=s3), \
                pytest.raises(RuntimeError) as raised:
            handler._put_prototype_html('p1', 'd1', '<html></html>')
        assert str(raised.value) == 'S3 did not identify the winning prototype object.'


class TestNewestDocument:
    def _newest(self, pages: list[dict]) -> tuple[str | None, MagicMock]:
        table = MagicMock()
        table.query.side_effect = pages
        return handler._newest_document_id(table, 'p1', 'PRD#'), table

    def test_the_query_reads_only_the_ranking_attributes_of_the_type(self):
        _, table = self._newest([{'Items': []}])
        table.query.assert_called_once_with(
            KeyConditionExpression=Key('pk').eq('PROJECT#p1') & Key('sk').begins_with('PRD#'),
            ProjectionExpression='sk, document_id, created_at',
        )

    def test_an_id_less_item_is_skipped_not_the_end(self):
        newest, _ = self._newest([{'Items': [
            {'sk': ''}, {'sk': 'PRD#a', 'created_at': '2025-01-01'},
        ]}])
        assert newest == 'a'

    def test_a_dated_document_beats_an_undated_one(self):
        newest, _ = self._newest([{'Items': [
            {'document_id': 'a', 'created_at': '2025-01-01'}, {'document_id': 'z'},
        ]}])
        assert newest == 'a'

    def test_every_page_is_read_from_its_start_key(self):
        key = {'pk': 'PROJECT#p1', 'sk': 'PRD#a'}
        newest, table = self._newest([
            {'Items': [{'document_id': 'a', 'created_at': '1'}], 'LastEvaluatedKey': key},
            {'Items': [{'document_id': 'b', 'created_at': '2'}]},
        ])
        assert newest == 'b'
        assert table.query.call_args.kwargs['ExclusiveStartKey'] == key

    def test_an_empty_start_key_ends_the_read(self):
        newest, table = self._newest([{'Items': [], 'LastEvaluatedKey': {}}])
        assert (newest, table.query.call_count) == (None, 1)

    def test_the_id_falls_back_to_the_sort_key(self):
        assert [handler._document_id_of(i) for i in ({'sk': 'PRD#a#b'}, {'sk': 'PRD'}, {})] == ['a#b', '', '']
