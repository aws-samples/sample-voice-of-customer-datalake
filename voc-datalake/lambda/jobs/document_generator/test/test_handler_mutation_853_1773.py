"""
Mutation hardening for `jobs/document_generator/handler.py` lines 853-1773:
the prototype-build source readers and prompt sections, `_generate_prototype`,
`handle_job` and the Step Functions step handlers.

What the mutation run found that the earlier tests could not see. The earlier
suites drive whole builds through the mocked projects table and assert that a
phrase reached the prompt, so they let through:

- every cap on the research section (per report, in total, per title, the
  heading overhead and the `max(0, …)` clamp) — no test counted characters;
- the exact wording of each refusal (`<field>: no <TYPE> document "<id>" …`) and
  of each injected prompt section, beyond one key phrase;
- the default of every optional knob (`'Untitled'`, `''`, `4096`, `'documents'`,
  `'prd'`), the progress percentages, and the scratch keys of the claim-check;
- the log lines the step handlers write, and the 500-character cap on a failed
  step's error.

These tests call the helpers directly with their collaborators patched on the
handler module, so each assertion names one literal.
"""
import inspect
import json
from contextlib import ExitStack
from unittest.mock import MagicMock, call, patch

import pytest

from jobs.document_generator import handler as H
from shared.exceptions import ServiceError
from shared.test.instrumentation_fixtures import INSTRUMENTED_HANDLER_LAYERS, handler_layers

PROJECT = 'proj_1'
JOB = 'job_1'


def _patched(**mocks: object) -> ExitStack:
    """Patch each named handler-module attribute (any number, including none)."""
    stack = ExitStack()
    for name, value in mocks.items():
        stack.enter_context(patch.object(H, name, value))
    return stack


class TestNewestOfATypeAndAimedSources:
    def test_no_newest_id_returns_none_without_a_keyed_read(self):
        table = MagicMock()
        with patch.object(H, '_newest_document_id', return_value=None) as newest, \
                patch.object(H, '_document_by_id') as by_id:
            assert H._latest_doc_by_prefix(table, PROJECT, 'PRD#') is None
        newest.assert_called_once_with(table, PROJECT, 'PRD#')
        by_id.assert_not_called()

    def test_the_newest_id_is_fetched_in_full(self):
        table = MagicMock()
        with patch.object(H, '_newest_document_id', return_value='d9'), \
                patch.object(H, '_document_by_id', return_value={'document_id': 'd9'}) as by_id:
            assert H._latest_doc_by_prefix(table, PROJECT, 'PRD#') == {'document_id': 'd9'}
        by_id.assert_called_once_with(table, PROJECT, 'PRD#', 'd9')

    def test_no_requested_id_reads_the_newest(self):
        table = MagicMock()
        with patch.object(H, '_latest_doc_by_prefix', return_value={'document_id': 'n'}) as latest, \
                patch.object(H, '_document_by_id') as by_id:
            assert H._source_document(table, PROJECT, 'PRFAQ#', '', 'source_prfaq_id') == {'document_id': 'n'}
        latest.assert_called_once_with(table, PROJECT, 'PRFAQ#')
        by_id.assert_not_called()

    def test_a_requested_id_is_read_by_key(self):
        table = MagicMock()
        with patch.object(H, '_latest_doc_by_prefix') as latest, \
                patch.object(H, '_document_by_id', return_value={'document_id': 'r'}) as by_id:
            assert H._source_document(table, PROJECT, 'PRD#', 'r', 'source_prd_id') == {'document_id': 'r'}
        by_id.assert_called_once_with(table, PROJECT, 'PRD#', 'r')
        latest.assert_not_called()

    @pytest.mark.parametrize(('prefix', 'field', 'message'), [
        ('PRD#', 'source_prd_id', 'source_prd_id: no PRD document "gone" in this project.'),
        ('PRFAQ#', 'source_prfaq_id', 'source_prfaq_id: no PRFAQ document "gone" in this project.'),
        # Only the trailing '#' is stripped, whatever letters the type ends in.
        ('INBOX#', 'source_inbox_id', 'source_inbox_id: no INBOX document "gone" in this project.'),
    ])
    def test_an_unresolved_requested_id_names_field_type_and_id(self, prefix, field, message):
        with patch.object(H, '_document_by_id', return_value=None), \
                pytest.raises(RuntimeError) as raised:
            H._source_document(MagicMock(), PROJECT, prefix, 'gone', field)
        assert str(raised.value) == message


def _report(title, content):
    return {'title': title, 'content': content}


class TestResearchSectionBounds:
    PREFIX = '\n\nRESEARCH FINDINGS:\n'

    def test_no_documents_is_no_section(self):
        assert H._research_section([]) == ''

    def test_one_report_is_cut_at_three_thousand(self):
        section = H._research_section([_report('T', 'a' * 3001)])
        assert section == self.PREFIX + '### T\n' + 'a' * 3000

    def test_four_reports_each_get_2873(self):
        section = H._research_section([_report(str(i), 'b' * 5000) for i in range(4)])
        body = '\n\n'.join(f'### {i}\n' + 'b' * 2873 for i in range(4))
        assert section == self.PREFIX + body

    def test_ten_reports_each_get_1073(self):
        section = H._research_section([_report('x', 'c' * 2000) for _ in range(10)])
        assert section == self.PREFIX + '\n\n'.join(['### x\n' + 'c' * 1073] * 10)

    def test_a_long_title_is_cut_at_120(self):
        section = H._research_section([_report('t' * 121, 'body')])
        assert section == self.PREFIX + '### ' + 't' * 120 + '\nbody'

    def test_missing_title_and_content_default(self):
        assert H._research_section([{}]) == self.PREFIX + '### Untitled\n'

    def test_a_blank_title_is_untitled(self):
        assert H._research_section([_report('', 'z')]) == self.PREFIX + '### Untitled\nz'

    def test_headings_past_the_budget_clamp_content_to_nothing_and_the_body_to_12000(self):
        docs = [_report('h' * 120, 'QQQ') for _ in range(100)]
        section = H._research_section(docs)
        assert 'Q' not in section
        assert len(section) == len(self.PREFIX) + 12000

    def test_the_budget_at_94_reports_still_leaves_one_character(self):
        # 12000 // 94 = 127 = the per-block overhead: a share of exactly 0.
        assert 'Q' not in H._research_section([_report('', 'Q')] * 94)
        # 12000 // 93 = 129: a share of 2.
        assert H._research_section([_report('', 'QQQ')] * 93).count('QQ\n') == 92


class TestResearchDocumentsAreKeyedAndLoud:
    def test_none_reads_nothing(self):
        with patch.object(H, '_document_by_id') as by_id:
            assert H._research_documents(MagicMock(), PROJECT, None) == []
        by_id.assert_not_called()

    def test_blank_ids_are_skipped_and_the_rest_read_in_order(self):
        table = MagicMock()
        with patch.object(H, '_document_by_id', side_effect=lambda _t, _p, _s, i: {'id': i}) as by_id:
            docs = H._research_documents(table, PROJECT, ['', None, '  r2 ', 'r1'])
        assert docs == [{'id': 'r2'}, {'id': 'r1'}]
        assert by_id.call_args_list == [
            call(table, PROJECT, 'RESEARCH#', 'r2'), call(table, PROJECT, 'RESEARCH#', 'r1'),
        ]

    def test_an_unresolved_id_raises_naming_it(self):
        with patch.object(H, '_document_by_id', return_value=None), \
                pytest.raises(RuntimeError) as raised:
            H._research_documents(MagicMock(), PROJECT, ['missing'])
        assert str(raised.value) == 'selected_research_ids: no RESEARCH document "missing" in this project.'


class TestBasePrototype:
    def test_no_id_reads_nothing(self):
        table = MagicMock()
        assert H._base_prototype(table, PROJECT, '') is None
        table.get_item.assert_not_called()

    def test_the_named_prototype_is_read_by_key(self):
        table = MagicMock()
        table.get_item.return_value = {'Item': {'content': 'x'}}
        assert H._base_prototype(table, PROJECT, 'b1') == {'content': 'x'}
        table.get_item.assert_called_once_with(Key={'pk': 'PROJECT#proj_1', 'sk': 'PROTOTYPE#b1'})

    def test_an_absent_prototype_raises_naming_it(self):
        table = MagicMock()
        table.get_item.return_value = {}
        with pytest.raises(RuntimeError) as raised:
            H._base_prototype(table, PROJECT, 'b1')
        assert str(raised.value) == 'base_prototype_id: no PROTOTYPE document "b1" in this project.'


VISUAL_TEXT = (
    '\n\nVISUAL BRIEF — uploaded mockups/screenshots of the look and feel to build:\n'
    'BRIEF\n\nACT ON THE VISUAL BRIEF ABOVE. Take the theme from these visuals in preference to '
    'the neutral defaults: set every :root custom property from the palette they describe (their '
    'dominant accent is --primary, and the lighter/soft/tint/background/text tones follow from '
    'what they show), take the LAYOUT MODE from them (a phone shell or a full-width top-nav web '
    'layout, whichever they depict), and match their corner radii, spacing and type weight. '
    'Where two visuals disagree, the EARLIER one wins. They describe the look, not the feature: '
    'what the screens contain and do still comes from the sections below.'
)


class TestVisualBriefSection:
    def test_no_selection_never_calls_the_producer(self):
        with patch.object(H, '_visual_brief') as brief:
            assert H._visual_brief_section(PROJECT, {'selected_product_doc_ids': []}) == ('', [])
        brief.assert_not_called()

    def test_an_empty_brief_adds_no_section_but_keeps_the_ids(self):
        with patch.object(H, '_visual_brief', return_value=('', ['v1'])) as brief:
            assert H._visual_brief_section(PROJECT, {'selected_product_doc_ids': ['v1', 'v2']}) == ('', ['v1'])
        brief.assert_called_once_with(PROJECT, ['v1', 'v2'])

    def test_a_brief_is_wrapped_in_the_exact_instruction(self):
        with patch.object(H, '_visual_brief', return_value=('BRIEF', ['v2'])):
            assert H._visual_brief_section(PROJECT, {'selected_product_doc_ids': ['v2']}) == (VISUAL_TEXT, ['v2'])


class TestProductContextSection:
    def test_not_asked_never_reads(self):
        with patch.object(H, '_product_context') as read:
            assert H._product_context_section(PROJECT, {}) == ('', False)
        read.assert_not_called()

    def test_a_placeholder_adds_nothing(self):
        with patch.object(H, '_product_context', return_value=('(none)', False)) as read:
            assert H._product_context_section(PROJECT, {'use_product_context': True}) == ('', False)
        read.assert_called_once_with(PROJECT)

    def test_a_block_is_capped_at_12000(self):
        with patch.object(H, '_product_context', return_value=('p' * 12001, True)):
            section = H._product_context_section(PROJECT, {'use_product_context': True})
        assert section == ('\n\nPRODUCT CONTEXT (what this product is, who it is for):\n' + 'p' * 12000, True)


class TestPriorPrototypeHtml:
    def test_no_base_is_empty(self):
        assert H._prior_prototype_html(PROJECT, None) == ''

    def test_a_legacy_inline_prototype_uses_its_content(self):
        with patch.object(H, '_get_prototype_html') as get:
            assert H._prior_prototype_html(PROJECT, {'content': '<p>legacy</p>'}) == '<p>legacy</p>'
            assert H._prior_prototype_html(PROJECT, {'prototype_format': 'json'}) == ''
        get.assert_not_called()

    @pytest.mark.parametrize('base', [
        {'document_id': 'd1', 'prototype_format': 'html'},
        {'document_id': 'd1', 'prototype_url': 'https://x'},
    ])
    def test_an_s3_prototype_is_read_from_s3(self, base):
        with patch.object(H, '_get_prototype_html', return_value='<html>s3</html>') as get:
            assert H._prior_prototype_html(PROJECT, base) == '<html>s3</html>'
        get.assert_called_once_with(PROJECT, 'd1')

    def test_an_s3_failure_falls_back_to_legacy_content_with_a_warning(self):
        base = {'document_id': 'd1', 'prototype_format': 'html', 'content': 'old'}
        with patch.object(H, '_get_prototype_html', side_effect=OSError('boom')), \
                patch.object(H, 'logger') as log:
            assert H._prior_prototype_html(PROJECT, base) == 'old'
        log.warning.assert_called_once_with(
            'Failed to read prior prototype HTML from S3; using legacy content: boom'
        )

    def test_an_s3_failure_without_legacy_content_raises(self):
        error = OSError('boom')
        with patch.object(H, '_get_prototype_html', side_effect=error), \
                pytest.raises(RuntimeError) as raised:
            H._prior_prototype_html(PROJECT, {'document_id': 'd1', 'prototype_format': 'html'})
        assert str(raised.value) == 'Failed to read the base prototype HTML from S3.'
        assert raised.value.__cause__ is error


FEEDBACK_INSTRUCTION = (
    'Revise the prototype to center on this feedback (e.g. change perspective, add/replace screens, '
    'adjust flows) while STILL staying consistent with the PRD/PR-FAQ above. Keep the offline-first '
    'single-HTML rules. Output the full revised HTML document.'
)


class TestRevisionFeedbackSection:
    def test_without_prior_html_there_is_no_existing_block(self):
        with patch.object(H, '_prior_prototype_html', return_value=''):
            section = H._revision_feedback_section(PROJECT, None, 'make it blue')
        assert section == (
            '\n\nUSER FEEDBACK — make this the PRIMARY focus of the revision:\nmake it blue\n'
            + FEEDBACK_INSTRUCTION
        )

    def test_prior_html_is_stripped_of_the_pin_widget_and_capped_at_24000(self):
        base = {'content': 'x'}
        with patch.object(H, '_prior_prototype_html', return_value='RAW') as prior, \
                patch.object(H, 'strip_pin_widget', return_value='h' * 24001) as strip:
            section = H._revision_feedback_section(PROJECT, base, 'fb')
        prior.assert_called_once_with(PROJECT, base)
        strip.assert_called_once_with('RAW')
        assert section == (
            '\n\nUSER FEEDBACK — make this the PRIMARY focus of the revision:\nfb\n'
            + FEEDBACK_INSTRUCTION
            + '\n\nEXISTING PROTOTYPE (revise this):\n' + 'h' * 24000
        )


TEMPLATE = ('{project_name}|{brand_section}|{design_system_section}|{company_context_section}|'
            '{visual_brief_section}|{product_context_section}|{prd_section}|{prfaq_section}|'
            '{research_section}|{lang_hint}')
NOW = '2026-07-01T00:00:00+00:00'


class _PrototypeBuild:
    """`_generate_prototype` with every collaborator patched on the handler module."""

    def __init__(self, *, prd=None, prfaq=None, project=None, research=(), html='<html>ok</html>'):
        self.table = MagicMock()
        self.table.get_item.return_value = {'Item': project} if project is not None else {}
        self.ctx = MagicMock()
        self.converse = MagicMock(return_value='RAW')
        self.mocks: dict[str, MagicMock] = {}
        sources = {'source_prd_id': prd, 'source_prfaq_id': prfaq}
        self._patches = {
            'get_versioned_document_by_allocation': MagicMock(return_value=None),
            'versioned_document_id': MagicMock(return_value='doc_new'),
            '_source_document': MagicMock(side_effect=lambda *a: sources[a[4]]),
            '_research_documents': MagicMock(return_value=list(research)),
            '_visual_brief_section': MagicMock(return_value=('<VIS>', ['v1'])),
            '_product_context_section': MagicMock(return_value=('<PC>', True)),
            '_base_prototype': MagicMock(return_value={'base': 1}),
            '_revision_feedback_section': MagicMock(return_value='<FB>'),
            '_prototype_org_sections': MagicMock(return_value=('<DS>', '<CC>')),
            '_extract_html': MagicMock(return_value=html),
            '_with_pin_widget': MagicMock(return_value='<html>pinned</html>'),
            '_put_prototype_html': MagicMock(return_value={'s3_key': 'k'}),
            'build_derivation': MagicMock(return_value={'deriv': 1}),
            'derivation_source': MagicMock(side_effect=lambda doc_id, role: (doc_id, role)),
            'persist_versioned_document': MagicMock(return_value={'document_id': 'doc_new', 'title': 'T'}),
            'datetime': MagicMock(),
        }
        self._patches['datetime'].now.return_value.isoformat.return_value = NOW

    def run(self, **config):
        with patch.multiple(H, PROTOTYPE_HTML_USER_TEMPLATE=TEMPLATE, **self._patches), \
                patch('shared.converse.converse', self.converse):
            return H._generate_prototype(self.ctx, self.table, PROJECT, JOB, config)

    def __getitem__(self, name: str) -> MagicMock:
        return self._patches[name]

    @property
    def prompt(self) -> str:
        return self.converse.call_args.kwargs['prompt']

    @property
    def item_fields(self) -> dict:
        return self['persist_versioned_document'].call_args.args[5]


PRD = {'document_id': 'p1', 'content': 'P' * 12001}
PRFAQ = {'document_id': 'f1', 'content': 'F'}


class TestGeneratePrototype:
    def test_a_committed_allocation_returns_before_any_read(self):
        build = _PrototypeBuild()
        build['get_versioned_document_by_allocation'].return_value = {'document_id': 'old', 'title': 'Old'}
        assert build.run() == {'document_id': 'old', 'title': 'Old'}
        build['get_versioned_document_by_allocation'].assert_called_once_with(
            build.table, PROJECT, 'prototype', JOB,
        )
        build.ctx.update_progress.assert_called_once_with(100, 'saved')
        build['_source_document'].assert_not_called()

    def test_no_source_documents_refuses(self):
        with pytest.raises(RuntimeError) as raised:
            _PrototypeBuild().run()
        assert str(raised.value) == 'No PRD or PR/FAQ found for this project. Generate at least one first.'

    def test_a_model_answer_without_html_refuses(self):
        build = _PrototypeBuild(prd=PRD, html='')
        with pytest.raises(RuntimeError) as raised:
            build.run()
        assert str(raised.value) == 'Prototype model did not return an HTML document.'
        build['_put_prototype_html'].assert_not_called()

    def test_a_full_revision_build_assembles_every_input(self):
        research = [{'document_id': 'r1'}, {'document_id': 'r2'}]
        build = _PrototypeBuild(prd=PRD, prfaq=PRFAQ, project={'name': 'Acme App'}, research=research)
        result = build.run(
            source_prd_id=' p1 ', source_prfaq_id=' f1 ', brand=' Acme ', response_language='ko-KR',
            use_research=True, selected_research_ids=['r1', 'r2'], feedback=' fix it ' + 'z' * 2000,
            base_prototype_id=' b1 ',
        )
        assert result == {'document_id': 'doc_new', 'title': 'T'}
        assert build['_source_document'].call_args_list == [
            call(build.table, PROJECT, 'PRD#', 'p1', 'source_prd_id'),
            call(build.table, PROJECT, 'PRFAQ#', 'f1', 'source_prfaq_id'),
        ]
        build.table.get_item.assert_called_once_with(Key={'pk': 'PROJECT#proj_1', 'sk': 'META'})
        build['_research_documents'].assert_called_once_with(build.table, PROJECT, ['r1', 'r2'])
        build['_base_prototype'].assert_called_once_with(build.table, PROJECT, 'b1')
        build['_revision_feedback_section'].assert_called_once_with(
            PROJECT, {'base': 1}, 'fix it ' + 'z' * 2000,
        )
        build['versioned_document_id'].assert_called_once_with(PROJECT, 'prototype', JOB)
        assert build.prompt == (
            'Acme App|BRAND: Acme\n|<DS>|<CC>|<VIS>|<PC>|\n\nPRD:\n' + 'P' * 12000
            + '|\n\nPR/FAQ:\nF|' + H._research_section(research) + '|Write the UI text in Korean.<FB>'
        )
        assert build.converse.call_args.kwargs == {
            'prompt': build.prompt, 'system_prompt': H.PROTOTYPE_HTML_SYSTEM_PROMPT,
            'surface': 'prototype', 'max_tokens': 32000, 'step_name': 'build_prototype',
        }
        build['_extract_html'].assert_called_once_with('RAW')
        build['_with_pin_widget'].assert_called_once_with(
            PROJECT, 'doc_new', 'Prototype: Acme App', '<html>ok</html>',
        )
        build['_put_prototype_html'].assert_called_once_with(PROJECT, 'doc_new', '<html>pinned</html>')
        assert build.ctx.update_progress.call_args_list == [
            call(40, 'invoking_bedrock'), call(80, 'saving_prototype'),
            call(90, 'saving_document'), call(100, 'saved'),
        ]
        assert build['derivation_source'].call_args_list == [
            call('p1', H.ROLE_PROTOTYPE_PRD), call('f1', H.ROLE_PROTOTYPE_PRFAQ),
            call('r1', H.ROLE_REFERENCE), call('r2', H.ROLE_REFERENCE),
        ]
        build['build_derivation'].assert_called_once_with(
            sources=[('p1', H.ROLE_PROTOTYPE_PRD), ('f1', H.ROLE_PROTOTYPE_PRFAQ),
                     ('r1', H.ROLE_REFERENCE), ('r2', H.ROLE_REFERENCE)],
            selected_document_count=4, product_context_included=True, visual_document_ids=['v1'],
        )
        build['persist_versioned_document'].assert_called_once_with(
            build.table, PROJECT, 'prototype', 'Prototype: Acme App', JOB, build.item_fields,
        )
        assert build.item_fields == {
            's3_key': 'k', 'gsi1pk': 'PROJECT#proj_1#DOCUMENTS', 'gsi1sk': NOW,
            'prototype_format': 'html', 'job_id': JOB, 'source_prd_id': 'p1', 'source_prfaq_id': 'f1',
            H.DERIVATION_FIELD: {'deriv': 1}, 'created_at': NOW,
            'revised_from_id': 'b1', 'revision_feedback': ('fix it ' + 'z' * 2000)[:2000],
        }

    def test_a_plain_build_from_one_empty_prfaq_asks_for_nothing_optional(self):
        build = _PrototypeBuild(prfaq={'document_id': 'f1'}, project={})
        build['_visual_brief_section'].return_value = ('', [])
        build['_product_context_section'].return_value = ('', False)
        build['_prototype_org_sections'].return_value = ('', '')
        build['_base_prototype'].return_value = None
        build.run(title='Given', response_language=None)
        assert build['_source_document'].call_args_list == [
            call(build.table, PROJECT, 'PRD#', '', 'source_prd_id'),
            call(build.table, PROJECT, 'PRFAQ#', '', 'source_prfaq_id'),
        ]
        build['_research_documents'].assert_not_called()
        build['_revision_feedback_section'].assert_not_called()
        build['_base_prototype'].assert_called_once_with(build.table, PROJECT, '')
        assert build.prompt == 'Project|||||||||Match the language of the brief.'
        build['build_derivation'].assert_called_once_with(
            sources=[('', H.ROLE_PROTOTYPE_PRD), ('f1', H.ROLE_PROTOTYPE_PRFAQ)],
            selected_document_count=1, product_context_included=False, visual_document_ids=[],
        )
        assert build.item_fields['source_prd_id'] is None
        assert 'revised_from_id' not in build.item_fields
        assert build['persist_versioned_document'].call_args.args[3] == 'Given'

    def test_feedback_without_a_base_records_no_base(self):
        build = _PrototypeBuild(prd={'document_id': 'p1', 'content': 'x'}, project={'name': 'N'})
        build.run(feedback='only feedback')
        assert build.item_fields['revised_from_id'] is None
        assert build.item_fields['revision_feedback'] == 'only feedback'

    def test_a_non_korean_language_matches_the_brief(self):
        build = _PrototypeBuild(prd={'document_id': 'p1'}, project={'name': 'N'})
        build.run(response_language='en-ko')
        assert build.prompt.endswith('|Match the language of the brief.')


class _Tables:
    """`get_dynamodb_resource()` handing out a projects and a feedback table by name."""

    def __init__(self):
        self.projects = MagicMock(name='projects')
        self.feedback = MagicMock(name='feedback')
        self.resource = MagicMock()
        self.resource.Table.side_effect = {
            H.PROJECTS_TABLE: self.projects, H.FEEDBACK_TABLE: self.feedback,
        }.__getitem__


class TestHandleJob:
    def _run(self, config, **patches):
        tables = _Tables()
        ctx = MagicMock()
        with patch.object(H, 'get_dynamodb_resource', return_value=tables.resource), \
                _patched(**patches):
            result = inspect.unwrap(H.handle_job)(ctx, PROJECT, JOB, config)
        return result, ctx, tables

    def test_a_failed_job_is_reported_as_a_document_generation_failure(self):
        event = {'project_id': PROJECT, 'job_id': JOB, 'doc_config': {'doc_type': 'prd'}}
        with patch.object(H, 'get_dynamodb_resource'), \
                patch.object(H, '_chain_doc_type', side_effect=RuntimeError('boom')), \
                patch('shared.jobs.update_job_status') as status, \
                pytest.raises(ServiceError) as raised:
            H.handle_job(event)
        assert raised.value.message == 'Document generation failed'
        assert status.call_args == call(
            PROJECT, JOB, 'failed', 0, 'error', error='Document generation failed: boom',
        )

    def test_a_product_report_delegates_to_generate_report(self):
        report = MagicMock(return_value={'document': {'document_id': 'rep', 'title': 'Report'}})
        with patch('api.product_context.generate_report', report):
            result, ctx, _ = self._run({'doc_type': 'product_report', 'title': 'R', 'response_language': 'ja'})
        assert result == {'document_id': 'rep', 'title': 'Report'}
        report.assert_called_once_with(PROJECT, {'response_language': 'ja', 'title': 'R'})
        assert ctx.update_progress.call_args_list == [
            call(10, 'gathering_context'), call(50, 'generating_report'), call(100, 'saved'),
        ]

    def test_a_product_report_without_a_document_returns_nones(self):
        report = MagicMock(return_value={})
        with patch('api.product_context.generate_report', report):
            result, _, _ = self._run({'doc_type': 'product_report'})
        assert result == {'document_id': None, 'title': None}
        report.assert_called_once_with(PROJECT, {'response_language': None, 'title': 'Untitled'})

    def test_a_missing_product_context_module_is_reported(self):
        with patch.dict('sys.modules', {'api.product_context': None}), \
                pytest.raises(RuntimeError) as raised:
            self._run({'doc_type': 'product_report'})
        assert str(raised.value).startswith('product_context module not available: ')
        assert isinstance(raised.value.__cause__, ImportError)

    def test_a_prototype_build_is_routed_with_the_projects_table(self):
        generate = MagicMock(return_value={'document_id': 'pt'})
        config = {'doc_type': 'build_prototype'}
        result, ctx, tables = self._run(config, _generate_prototype=generate)
        assert result == {'document_id': 'pt'}
        generate.assert_called_once_with(ctx, tables.projects, PROJECT, JOB, config)
        assert ctx.update_progress.call_args_list == [
            call(10, 'gathering_context'), call(20, 'loading_source_documents'),
        ]

    def test_a_replayed_chain_document_returns_the_committed_one(self):
        spec = MagicMock()
        existing = MagicMock(return_value={'document_id': 'e', 'title': 'E'})
        gather = MagicMock()
        result, _, tables = self._run(
            {}, _chain_doc_type=MagicMock(return_value=spec),
            get_versioned_document_by_allocation=existing, _gather_context=gather,
        )
        assert result == {'document_id': 'e', 'title': 'E'}
        existing.assert_called_once_with(tables.projects, PROJECT, 'prd', JOB)
        gather.assert_not_called()

    def test_a_chain_document_is_generated_and_saved(self):
        spec = MagicMock()
        chain_type = MagicMock(return_value=spec)
        gathered = MagicMock(feedback_context='FB', personas_context='PE', feedback='SAMPLE',
                             derivation_inputs={'sources': ['s']})
        mocks = {
            '_chain_doc_type': chain_type,
            'get_versioned_document_by_allocation': MagicMock(return_value=None),
            '_gather_context': MagicMock(return_value=gathered),
            '_product_context': MagicMock(return_value=('PCTX', True)),
            '_with_org_context': MagicMock(return_value='PCTX+ORG'),
            '_generate_chain_document': MagicMock(return_value=('CONTENT', {'a': 1})),
            '_feedback_usage_fields': MagicMock(return_value={'feedback_items_used': 3}),
            'build_derivation': MagicMock(return_value={'d': 1}),
            '_date_basis_fields': MagicMock(return_value={'date_basis': 'b'}),
            '_document_item_fields': MagicMock(return_value={'fields': 1}),
            'persist_versioned_document': MagicMock(return_value={'document_id': 'n', 'title': 'Saved'}),
        }
        config = {'doc_type': 'prfaq', 'title': 'Mine', 'feature_idea': 'idea'}
        result, ctx, tables = self._run(config, **mocks)
        assert result == {'document_id': 'n', 'title': 'Saved', 'feedback_items_used': 3}
        chain_type.assert_called_once_with('prfaq')
        mocks['_gather_context'].assert_called_once_with(ctx, tables.projects, tables.feedback, PROJECT, config)
        mocks['_product_context'].assert_called_once_with(PROJECT)
        mocks['_with_org_context'].assert_called_once_with('PCTX')
        mocks['_generate_chain_document'].assert_called_once_with(
            ctx, spec, 'idea', 'FB', 'PE', config, 'PCTX+ORG',
        )
        mocks['_feedback_usage_fields'].assert_called_once_with('SAMPLE')
        mocks['build_derivation'].assert_called_once_with(sources=['s'], product_context_included=True)
        mocks['_date_basis_fields'].assert_called_once_with(config)
        mocks['_document_item_fields'].assert_called_once_with(
            PROJECT, JOB, 'idea', 'CONTENT', {'d': 1}, {'a': 1}, {'feedback_items_used': 3},
            {'date_basis': 'b'},
        )
        mocks['persist_versioned_document'].assert_called_once_with(
            tables.projects, PROJECT, 'prfaq', 'Mine', JOB, {'fields': 1},
        )
        assert ctx.update_progress.call_args_list == [
            call(10, 'gathering_context'), call(50, 'generating_document'), call(90, 'saving_document'),
        ]

    def test_chain_defaults_are_untitled_and_no_idea(self):
        mocks = {
            '_chain_doc_type': MagicMock(),
            'get_versioned_document_by_allocation': MagicMock(return_value=None),
            '_gather_context': MagicMock(),
            '_product_context': MagicMock(return_value=('', False)),
            '_with_org_context': MagicMock(return_value=''),
            '_generate_chain_document': MagicMock(return_value=('C', {})),
            '_feedback_usage_fields': MagicMock(return_value={}),
            'build_derivation': MagicMock(),
            '_document_item_fields': MagicMock(),
            'persist_versioned_document': MagicMock(return_value={'document_id': 'n', 'title': 'Untitled'}),
        }
        self._run({}, **mocks)
        assert mocks['_generate_chain_document'].call_args.args[2] == ''
        assert mocks['persist_versioned_document'].call_args.args[3] == 'Untitled'
        assert mocks['_document_item_fields'].call_args.args[2] == ''


class TestScratchClaimCheck:
    def test_keys_live_under_the_job_prefix(self):
        assert H._scratch_key('j9', 'steps') == 'scratch/document_jobs/j9/steps.txt'

    def test_put_and_get_round_trip_utf8_in_the_scratch_bucket(self):
        client = MagicMock()
        client.get_object.return_value = {'Body': MagicMock(read=MagicMock(return_value='한'.encode()))}
        with patch.object(H, '_s3', return_value=client):
            assert H._put_text('k1', '한') == 'k1'
            assert H._get_text('k2') == '한'
        client.put_object.assert_called_once_with(Bucket=H.SCRATCH_BUCKET, Key='k1', Body='한'.encode())
        client.get_object.assert_called_once_with(Bucket=H.SCRATCH_BUCKET, Key='k2')

    def test_the_client_is_an_s3_client(self):
        with patch('boto3.client', return_value='CLIENT') as factory:
            assert H._s3() == 'CLIENT'
        factory.assert_called_once_with('s3')

    def test_a_stashed_object_is_read_back(self):
        with patch.object(H, '_get_text', return_value='{"a": 1}') as get:
            assert H._read_scratch_json(JOB, 'thing', {'d': 0}, 'thing') == {'a': 1}
        get.assert_called_once_with('scratch/document_jobs/job_1/thing.txt')

    def test_a_non_object_is_the_default(self):
        with patch.object(H, '_get_text', return_value='[1]'):
            assert H._read_scratch_json(JOB, 'thing', {'d': 0}, 'thing') == {'d': 0}

    def test_an_unreadable_stash_is_the_default_and_logged(self):
        with patch.object(H, '_get_text', side_effect=OSError('gone')), \
                patch.object(H, 'logger') as log:
            assert H._read_scratch_json(JOB, 'thing', {'d': 0}, 'my thing') == {'d': 0}
        log.exception.assert_called_once_with(
            'Could not read my thing for job job_1 (non-fatal; saving without it)'
        )

    @pytest.mark.parametrize(('reader', 'name', 'what', 'default'), [
        (H._read_derivation, 'derivation', 'derivation', H.build_derivation()),
        (H._read_feedback_usage, 'feedback_usage', 'feedback usage', {}),
        (H._read_date_basis, 'date_basis', 'date basis', {}),
    ])
    def test_each_reader_names_its_stash(self, reader, name, what, default):
        with patch.object(H, '_read_scratch_json', return_value={'stashed': name}) as read:
            value = reader(JOB)
        read.assert_called_once_with(JOB, name, default, what)
        # The date basis is re-validated and only kept when the stash carries one.
        assert value == ({} if name == 'date_basis' else {'stashed': name})

    def test_the_date_basis_is_revalidated(self):
        with patch.object(H, '_read_scratch_json', return_value={'date_basis': 'bogus'}), \
                patch.object(H, '_date_basis_fields', return_value={'date_basis': 'ok'}) as fields:
            assert H._read_date_basis(JOB) == {'date_basis': 'ok'}
        fields.assert_called_once_with({'date_basis': 'bogus'})


class TestBuildSteps:
    def _run(self, config, **patches):
        tables = _Tables()
        job_context = MagicMock()
        puts = MagicMock(side_effect=lambda key, _text: key)
        with patch.object(H, 'get_dynamodb_resource', return_value=tables.resource), \
                patch.object(H, 'JobContext', job_context), patch.object(H, '_put_text', puts), \
                _patched(**patches):
            result = H._build_steps(PROJECT, JOB, config)
        return result, job_context, tables, puts

    def test_a_replay_completes_with_the_committed_document(self):
        complete = MagicMock()
        existing = {'document_id': 'e', 'title': 'Committed'}
        result, job_context, _tables, puts = self._run(
            {'feature_idea': 'i'}, _chain_doc_type=MagicMock(),
            get_versioned_document_by_allocation=MagicMock(return_value=existing),
            _complete_with_existing=complete,
        )
        assert result == {'doc_type': 'prd', 'title': 'Committed', 'feature_idea': 'i',
                          'num_steps': 0, 'replayed': True}
        complete.assert_called_once_with(PROJECT, JOB, existing)
        job_context.assert_called_once_with(PROJECT, JOB)
        job_context.return_value.update_progress.assert_called_once_with(10, 'gathering_context')
        puts.assert_not_called()

    def test_gather_stashes_steps_derivation_usage_and_basis(self):
        spec = MagicMock()
        spec.build_steps.return_value = [{'s': 1}, {'s': 2}]
        gathered = MagicMock(feedback_context='FB', personas_context='PE', feedback='SAMPLE',
                             derivation_inputs={'sources': []})
        allocation = MagicMock(return_value=None)
        gather = MagicMock(return_value=gathered)
        config = {'doc_type': 'prfaq', 'title': 'T', 'feature_idea': 'idea', 'response_language': 'ko'}
        result, job_context, tables, puts = self._run(
            config, _chain_doc_type=MagicMock(return_value=spec),
            get_versioned_document_by_allocation=allocation,
            _gather_context=gather,
            _product_context=MagicMock(return_value=('PC', False)),
            _with_org_context=MagicMock(return_value='PC+ORG'),
            build_derivation=MagicMock(return_value={'d': 2}),
            _feedback_usage_fields=MagicMock(return_value={'u': 3}),
            _date_basis_fields=MagicMock(return_value={'date_basis': 'b'}),
        )
        assert result == {'doc_type': 'prfaq', 'title': 'T', 'feature_idea': 'idea',
                          'num_steps': 2, 'replayed': False}
        allocation.assert_called_once_with(tables.projects, PROJECT, 'prfaq', JOB)
        gather.assert_called_once_with(job_context.return_value, tables.projects, tables.feedback, PROJECT, config)
        spec.build_steps.assert_called_once_with(
            feature_idea='idea', personas_context='PE', feedback_context='FB',
            product_context='PC+ORG', response_language='ko',
        )
        assert puts.call_args_list == [
            call('scratch/document_jobs/job_1/steps.txt', '[{"s": 1}, {"s": 2}]'),
            call('scratch/document_jobs/job_1/derivation.txt', '{"d": 2}'),
            call('scratch/document_jobs/job_1/feedback_usage.txt', '{"u": 3}'),
            call('scratch/document_jobs/job_1/date_basis.txt', '{"date_basis": "b"}'),
        ]
        assert job_context.return_value.update_progress.call_args_list == [
            call(10, 'gathering_context'), call(15, 'context_ready'),
        ]

    def test_defaults_are_prd_untitled_and_no_idea(self):
        spec = MagicMock()
        spec.build_steps.return_value = []
        result, *_ = self._run(
            {}, _chain_doc_type=MagicMock(return_value=spec),
            get_versioned_document_by_allocation=MagicMock(return_value=None),
            _gather_context=MagicMock(), _product_context=MagicMock(return_value=('', False)),
            _with_org_context=MagicMock(return_value=''),
            build_derivation=MagicMock(return_value={}), _feedback_usage_fields=MagicMock(return_value={}),
            _date_basis_fields=MagicMock(return_value={}),
        )
        assert result == {'doc_type': 'prd', 'title': 'Untitled', 'feature_idea': '',
                          'num_steps': 0, 'replayed': False}


class TestRunOneStep:
    def _run(self, index, steps, texts=None):
        store = {'scratch/document_jobs/job_1/steps.txt': json.dumps(steps), **(texts or {})}
        converse = MagicMock(return_value='OUT')
        job_context = MagicMock()
        with patch.object(H, '_get_text', side_effect=store.__getitem__), \
                patch.object(H, '_put_text') as put, patch.object(H, 'converse', converse), \
                patch.object(H, 'JobContext', job_context), patch.object(H, 'logger') as log:
            H._run_one_step(PROJECT, JOB, index)
        return converse, job_context, put, log

    def test_the_first_step_uses_every_default(self):
        converse, job_context, put, log = self._run(0, [{}, {}])
        converse.assert_called_once_with(
            prompt='', system_prompt='', max_tokens=4096, thinking_budget=0,
            surface='documents', step_name='llm_step_1',
        )
        job_context.assert_called_once_with(PROJECT, JOB)
        job_context.return_value.update_progress.assert_called_once_with(15, 'llm_step_1')
        put.assert_called_once_with('scratch/document_jobs/job_1/result_0.txt', 'OUT')
        assert log.info.call_args_list == [
            call("[DOCSTEP] step 1/2 'llm_step_1': max_tokens=4096"),
            call("[DOCSTEP] step 'llm_step_1' produced 3 chars"),
        ]

    def test_a_later_step_substitutes_the_previous_result(self):
        steps = [{}, {}, {'step_name': 'final', 'user': 'use {previous} now', 'system': 'SYS',
                          'max_tokens': 99, 'thinking_budget': 5, 'surface': 'prototype'}]
        converse, job_context, put, log = self._run(
            2, steps, {'scratch/document_jobs/job_1/result_1.txt': 'PREV'},
        )
        converse.assert_called_once_with(
            prompt='use PREV now', system_prompt='SYS', max_tokens=99, thinking_budget=5,
            surface='prototype', step_name='final',
        )
        # 15 + int(2 / 3 * 70) = 15 + 46
        job_context.return_value.update_progress.assert_called_once_with(61, 'final')
        put.assert_called_once_with('scratch/document_jobs/job_1/result_2.txt', 'OUT')
        assert log.info.call_args_list[0] == call("[DOCSTEP] step 3/3 'final': max_tokens=99")

    def test_the_first_step_has_no_previous_result(self):
        converse, *_ = self._run(0, [{'user': '[{previous}]'}])
        assert converse.call_args.kwargs['prompt'] == '[]'

    def test_the_second_step_reads_result_zero(self):
        converse, job_context, *_ = self._run(
            1, [{}, {'user': '{previous}'}], {'scratch/document_jobs/job_1/result_0.txt': 'ZERO'},
        )
        assert converse.call_args.kwargs['prompt'] == 'ZERO'
        assert converse.call_args.kwargs['step_name'] == 'llm_step_2'
        job_context.return_value.update_progress.assert_called_once_with(50, 'llm_step_2')


class TestAssembleAndSave:
    def _patches(self, existing=None):
        spec = MagicMock()
        spec.assemble.return_value = ('DOC', {'an': 1})
        return {
            '_chain_doc_type': MagicMock(return_value=spec),
            'get_versioned_document_by_allocation': MagicMock(return_value=existing),
            '_complete_with_existing': MagicMock(return_value={'done': 1}),
            'JobContext': MagicMock(),
            '_get_text': MagicMock(side_effect=lambda key: f'<{key}>'),
            '_read_feedback_usage': MagicMock(return_value={'u': 1}),
            '_read_derivation': MagicMock(return_value={'d': 1}),
            '_read_date_basis': MagicMock(return_value={'b': 1}),
            '_document_item_fields': MagicMock(return_value={'f': 1}),
            'persist_versioned_document': MagicMock(return_value={'document_id': 'n', 'title': 'T'}),
            '_s3': MagicMock(),
            'update_job_status': MagicMock(),
        }

    def _run(self, mocks, num_steps=2):
        tables = _Tables()
        with patch.object(H, 'get_dynamodb_resource', return_value=tables.resource), \
                patch.multiple(H, **mocks), patch.object(H, 'logger') as log:
            result = H._assemble_and_save(PROJECT, JOB, 'prd', 'Title', 'idea', num_steps)
        return result, tables, log

    def test_a_replay_completes_with_the_committed_document(self):
        mocks = self._patches(existing={'document_id': 'e'})
        result, tables, _ = self._run(mocks)
        assert result == {'done': 1}
        mocks['get_versioned_document_by_allocation'].assert_called_once_with(tables.projects, PROJECT, 'prd', JOB)
        mocks['_complete_with_existing'].assert_called_once_with(PROJECT, JOB, {'document_id': 'e'})
        mocks['_get_text'].assert_not_called()

    def test_results_are_assembled_saved_cleaned_and_completed(self):
        mocks = self._patches()
        result, tables, log = self._run(mocks)
        assert result == {'document_id': 'n', 'title': 'T', 'u': 1}
        mocks['JobContext'].return_value.update_progress.assert_called_once_with(90, 'saving_document')
        mocks['_chain_doc_type'].return_value.assemble.assert_called_once_with(H.ChainOutput(
            'idea', ['<scratch/document_jobs/job_1/result_0.txt>', '<scratch/document_jobs/job_1/result_1.txt>'],
        ))
        mocks['_document_item_fields'].assert_called_once_with(
            PROJECT, JOB, 'idea', 'DOC', {'d': 1}, {'an': 1}, {'u': 1}, {'b': 1},
        )
        mocks['persist_versioned_document'].assert_called_once_with(
            tables.projects, PROJECT, 'prd', 'Title', JOB, {'f': 1},
        )
        prefix = 'scratch/document_jobs/job_1/'
        mocks['_s3'].return_value.delete_objects.assert_called_once_with(Bucket=H.SCRATCH_BUCKET, Delete={'Objects': [
            {'Key': f'{prefix}{name}.txt'}
            for name in ('steps', 'derivation', 'feedback_usage', 'date_basis', 'result_0', 'result_1')
        ]})
        mocks['update_job_status'].assert_called_once_with(
            PROJECT, JOB, 'completed', 100, 'complete', result={'document_id': 'n', 'title': 'T', 'u': 1},
        )
        log.exception.assert_not_called()

    def test_a_failed_cleanup_is_logged_and_still_completes(self):
        mocks = self._patches()
        mocks['_s3'].return_value.delete_objects.side_effect = OSError('denied')
        result, _, log = self._run(mocks, num_steps=0)
        assert result == {'document_id': 'n', 'title': 'T', 'u': 1}
        log.exception.assert_called_once_with('Scratch cleanup failed (non-fatal)')
        mocks['update_job_status'].assert_called_once()


class TestStepErrorNamesTheCause:
    @pytest.mark.parametrize(('error', 'message'), [
        ({'Cause': '{"errorMessage": "model refused"}'}, 'model refused'),
        ({'Cause': '{"other": 1}'}, '{"other": 1}'),
        ({'Cause': 'not json'}, 'not json'),
        ({}, '{}'),
        ('plain string', 'plain string'),
        ('', 'Unknown error'),
        ({'Cause': '{"errorMessage": "' + 'e' * 600 + '"}'}, 'e' * 500),
    ])
    def test_the_job_is_failed_with_the_message(self, error, message):
        with patch.object(H, 'update_job_status') as status, patch.object(H, 'logger') as log:
            result = H._handle_step_error({'project_id': PROJECT, 'job_id': JOB, 'error': error})
        assert result == {'success': False, 'error': message}
        status.assert_called_once_with(PROJECT, JOB, 'failed', 0, 'error', error=message)
        assert log.error.call_args.args[0].startswith('Document job job_1 failed: ')

    def test_the_log_line_carries_the_uncapped_message(self):
        with patch.object(H, 'update_job_status'), patch.object(H, 'logger') as log:
            H._handle_step_error({'project_id': PROJECT, 'job_id': JOB})
        log.error.assert_called_once_with('Document job job_1 failed: {}')


class TestLambdaHandlerDispatch:
    def test_the_handler_wears_the_shared_instrumentation_stack_in_order(self):
        assert handler_layers(H.lambda_handler) == INSTRUMENTED_HANDLER_LAYERS

    def _invoke(self, event, lambda_context, **patches):
        with _patched(**patches), patch.object(H.logger, 'info') as info:
            result = H.lambda_handler(event, lambda_context)
        return result, info

    def test_no_step_is_the_single_shot_job(self, lambda_context):
        job = MagicMock(return_value={'ok': 1})
        event = {'project_id': PROJECT, 'job_id': JOB}
        result, info = self._invoke(event, lambda_context, handle_job=job)
        assert result == {'ok': 1}
        job.assert_called_once_with(event, lambda_context)
        info.assert_any_call("Document generator invoked: step=None, keys=['project_id', 'job_id']")

    def test_gather_builds_steps(self, lambda_context):
        build = MagicMock(return_value={'g': 1})
        event = {'step': 'gather', 'project_id': PROJECT, 'job_id': JOB, 'doc_config': {'c': 1}}
        assert self._invoke(event, lambda_context, _build_steps=build)[0] == {'g': 1}
        build.assert_called_once_with(PROJECT, JOB, {'c': 1})

    def test_run_step_runs_one_and_echoes_its_index(self, lambda_context):
        run = MagicMock()
        event = {'step': 'run_step', 'project_id': PROJECT, 'job_id': JOB, 'index': 3}
        assert self._invoke(event, lambda_context, _run_one_step=run)[0] == {'index': 3}
        run.assert_called_once_with(PROJECT, JOB, 3)

    def test_save_assembles(self, lambda_context):
        save = MagicMock(return_value={'s': 1})
        event = {'step': 'save', 'project_id': PROJECT, 'job_id': JOB, 'doc_type': 'prd',
                 'title': 'T', 'feature_idea': 'i', 'num_steps': 4}
        assert self._invoke(event, lambda_context, _assemble_and_save=save)[0] == {'s': 1}
        save.assert_called_once_with(PROJECT, JOB, 'prd', 'T', 'i', 4)

    def test_error_fails_the_job(self, lambda_context):
        fail = MagicMock(return_value={'success': False})
        event = {'step': 'error', 'project_id': PROJECT, 'job_id': JOB}
        assert self._invoke(event, lambda_context, _handle_step_error=fail)[0] == {'success': False}
        fail.assert_called_once_with(event)

    def test_an_unknown_step_is_refused_by_name(self, lambda_context):
        with pytest.raises(ValueError, match='Unknown step') as raised:
            H.lambda_handler({'step': 'bogus', 'project_id': PROJECT, 'job_id': JOB}, lambda_context)
        assert str(raised.value) == 'Unknown step: bogus'
