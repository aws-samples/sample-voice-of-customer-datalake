"""Mutation hardening for `jobs/document_merger/handler.py`.

`test_handler.py` and `test_handler_coverage.py` prove a merge runs, but they
check the prompt with `in`, the write with `'source_documents' in item` and the
token budget with `>= 12000`. A mutation run left 99 survivors behind those
checks: a renamed key, a swapped literal, an off-by-one slice or a dropped
default changed nothing a test saw.

Pinned here as literals:

* the refusals — the `output_type must be one of: prd, prfaq, custom (got …)`
  and `At least 2 documents are required for merging` causes, prefixed with
  `Document merge failed: ` on the job record;
* the whole user prompt and system prompt per output type, the document block
  (1-based numbering, `Untitled`/`UNKNOWN`/empty-content fallbacks, the 8,000
  character cap), which rows count as source documents, the persona and
  feedback sections (header, 20-review cap, 250-character cap, `unknown`
  fallbacks) and the `\\n\\n` join;
* the feedback query arguments and their defaults, and the `converse` call
  (`max_tokens` 16000 for PR/FAQ else 12000, the `documents` surface);
* the saved row for a custom document (`doc_<yyyymmddhhmmss>`, keys, gsi,
  derivation) and the versioned save for PRD / PR/FAQ, the `document_count`
  counter, the returned id and title;
* the progress ladder, the table names read from the environment and their
  `''` defaults, and the three decorators on `lambda_handler`.

The run also found one equivalent mutant: `used_feedback_count = 0 → None`
(the derivation coerces None to 0). The default is now assigned as the pair
`(None, 0)` the feedback helper itself answers with, which keeps the behaviour
and leaves no equivalent mutant.
"""
import importlib
import inspect
import os
from collections.abc import Iterator
from datetime import UTC, datetime
from functools import partial
from types import SimpleNamespace
from unittest.mock import MagicMock, call, patch

import pytest
from boto3.dynamodb.conditions import Key

from jobs.document_merger import handler
from shared.category_access import CategoryScope
from shared.exceptions import ServiceError
from shared.logging import logger, metrics
from shared.test.emf_fixtures import cold_start_metric_names

PROJECT_ID = 'proj_m1'
JOB_ID = 'job_m1'
FIXED_NOW = datetime(2025, 1, 2, 3, 4, 5, tzinfo=UTC)
FIXED_ISO = '2025-01-02T03:04:05+00:00'
MERGED = 'MERGED BODY'

PRD_SYSTEM = (
    "You are a senior product manager creating a revised PRD. Merge and revise the provided "
    "source documents according to the user's instructions."
)
PRFAQ_SYSTEM = (
    "You are creating a revised Amazon-style PR-FAQ. Merge and revise the provided source "
    "documents. Include PRESS RELEASE, CUSTOMER FAQ (10 questions), and INTERNAL FAQ (10 questions)."
)
CUSTOM_SYSTEM = (
    "You are a skilled document editor. Merge and revise the provided source documents "
    "according to the user's instructions."
)

DOC_A = {'pk': f'PROJECT#{PROJECT_ID}', 'sk': 'PRD#doc_a', 'document_id': 'doc_a',
         'document_type': 'prd', 'title': 'Alpha', 'content': 'A body'}
DOC_B = {'sk': 'RESEARCH#doc_b', 'document_id': 'doc_b', 'document_type': 'research',
         'title': 'Beta', 'content': 'B body'}
TWO_DOCS_BLOCK = (
    '## SOURCE DOCUMENTS TO MERGE\n\n'
    '### Document 1: Alpha (PRD)\n\nA body\n\n---\n\n'
    '### Document 2: Beta (RESEARCH)\n\nB body\n\n---\n\n'
)


class _FrozenDatetime(datetime):
    @classmethod
    def now(cls, tz=None):
        return FIXED_NOW if tz is not None else FIXED_NOW.replace(tzinfo=None)


class _World(SimpleNamespace):
    resource: MagicMock
    projects: MagicMock
    feedback: MagicMock
    converse: MagicMock
    persist: MagicMock
    lookup: MagicMock
    put_and_increment: MagicMock
    query_feedback: MagicMock
    personas: MagicMock
    jobs: MagicMock


@pytest.fixture
def world(mock_jobs_table: MagicMock) -> Iterator[_World]:
    """Every collaborator of the handler replaced by a recorder."""
    projects, feedback = MagicMock(name='projects'), MagicMock(name='feedback')
    projects.query.return_value = {'Items': [DOC_A, DOC_B]}
    resource = MagicMock()
    resource.Table.side_effect = lambda name: feedback if name == os.environ['FEEDBACK_TABLE'] else projects
    with (
        patch.object(handler, 'get_dynamodb_resource', return_value=resource),
        patch.object(handler, 'converse', return_value=MERGED) as converse,
        patch.object(handler, 'persist_versioned_document',
                     return_value={'document_id': 'prd_v', 'title': 'Merged (v2)'}) as persist,
        patch.object(handler, 'get_versioned_document_by_allocation', return_value=None) as lookup,
        # The custom-document write: create_counted_project_child mints the id
        # (pinned below, keeping the prefix the handler asked for) and calls this.
        patch('shared.project_writes.put_project_item_and_increment') as put_and_increment,
        patch('shared.ids.timestamped_id',
              side_effect=lambda prefix, _now=None: f'{prefix}_20250102030405_a1b2c3d4'),
        patch.object(handler, 'query_feedback_by_date', return_value=[]) as query_feedback,
        patch.object(handler, 'personas_prompt_context', return_value='PERSONA BLOCK') as personas,
        patch.object(handler, 'datetime', _FrozenDatetime),
    ):
        yield _World(
            resource=resource, projects=projects, feedback=feedback, converse=converse,
            persist=persist, lookup=lookup, put_and_increment=put_and_increment,
            query_feedback=query_feedback, personas=personas, jobs=mock_jobs_table,
        )


def _event(**config) -> dict:
    merge_config = {'selected_document_ids': ['doc_a', 'doc_b'], **config}
    return {'project_id': PROJECT_ID, 'job_id': JOB_ID, 'merge_config': merge_config}


def _run(**config) -> dict:
    """The job run without a Lambda context (no execution claim), as the wrapper runs it."""
    return handler.handle_job(_event(**config))


def _prompt(world: _World) -> str:
    return world.converse.call_args.kwargs['prompt']


def _job_errors(jobs: MagicMock) -> list[str]:
    return [
        c.kwargs['ExpressionAttributeValues'][':error']
        for c in jobs.update_item.call_args_list
        if ':error' in c.kwargs['ExpressionAttributeValues']
    ]


def _ladder(jobs: MagicMock) -> list[tuple[int, str]]:
    ladder = []
    for c in jobs.update_item.call_args_list:
        values = c.kwargs['ExpressionAttributeValues']
        if ':progress' in values and ':step' in values:
            ladder.append((values[':progress'], values[':step']))
    return ladder


def _derivation(world: _World) -> dict:
    return world.put_and_increment.call_args.args[2]['derivation']


class TestEveryRefusalNamesItsCause:
    @pytest.mark.parametrize(('output_type', 'got'), [('prototype', 'str'), (7, 'int')])
    def test_an_unknown_output_type(self, world, output_type, got):
        with pytest.raises(ServiceError) as raised:
            _run(output_type=output_type)
        assert str(raised.value) == 'Document merge failed'
        assert _job_errors(world.jobs) == [
            f'Document merge failed: output_type must be one of: prd, prfaq, custom (got {got})',
        ]
        world.projects.query.assert_not_called()

    def test_fewer_than_two_source_documents(self, world):
        world.projects.query.return_value = {'Items': [DOC_A]}
        with pytest.raises(ServiceError):
            _run()
        assert _job_errors(world.jobs) == [
            'Document merge failed: At least 2 documents are required for merging',
        ]
        world.converse.assert_not_called()


class TestTheModelRequest:
    def test_defaults_make_a_custom_document_with_no_instructions(self, world):
        result = _run()

        world.converse.assert_called_once_with(
            prompt=(
                '## MERGE INSTRUCTIONS\n\n\n## OUTPUT DOCUMENT TITLE\nMerged Document\n\n'
                f'{TWO_DOCS_BLOCK}\n\nCreate a new document incorporating all relevant feedback.'
            ),
            system_prompt=CUSTOM_SYSTEM,
            max_tokens=12000,
            surface='documents',
        )
        assert result == {'success': True, 'document_id': 'doc_20250102030405_a1b2c3d4', 'title': 'Merged Document'}

    @pytest.mark.parametrize(('output_type', 'system', 'max_tokens'), [
        ('prd', PRD_SYSTEM, 12000), ('prfaq', PRFAQ_SYSTEM, 16000), ('custom', CUSTOM_SYSTEM, 12000),
    ])
    def test_each_output_type_has_its_prompt_and_budget(self, world, output_type, system, max_tokens):
        _run(output_type=output_type, title='T', instructions='Merge them')

        noun = 'document' if output_type == 'custom' else output_type.upper()
        assert world.converse.call_args.kwargs == {
            'prompt': (
                f'## MERGE INSTRUCTIONS\nMerge them\n\n## OUTPUT DOCUMENT TITLE\nT\n\n'
                f'{TWO_DOCS_BLOCK}\n\nCreate a new {noun} incorporating all relevant feedback.'
            ),
            'system_prompt': system,
            'max_tokens': max_tokens,
            'surface': 'documents',
        }

    def test_a_document_block_falls_back_and_caps_its_content(self, world):
        world.projects.query.return_value = {'Items': [
            {'sk': 'PRFAQ#doc_a', 'document_id': 'doc_a', 'document_type': 'prfaq',
             'title': 'Alpha', 'content': 'a' * 8000 + 'b'},
            {'sk': 'DOC#doc_b', 'document_id': 'doc_b'},
        ]}
        _run()

        assert (
            '## SOURCE DOCUMENTS TO MERGE\n\n'
            f'### Document 1: Alpha (PRFAQ)\n\n{"a" * 8000}\n\n---\n\n'
            '### Document 2: Untitled (UNKNOWN)\n\n\n\n---\n\n'
        ) in _prompt(world)
        assert 'b\n' not in _prompt(world)

    def test_only_selected_rows_under_a_source_prefix_are_merged(self, world):
        world.projects.query.return_value = {'Items': [
            {'document_id': 'doc_a', 'title': 'No sort key'},
            {'sk': 'PERSONA#doc_b', 'document_id': 'doc_b', 'title': 'A persona row'},
            {'sk': 'PRD#doc_c', 'document_id': 'doc_c', 'title': 'Not selected'},
            DOC_A, DOC_B,
        ]}
        _run()

        assert _prompt(world).count('### Document') == 2
        assert TWO_DOCS_BLOCK in _prompt(world)
        world.projects.query.assert_called_once_with(
            KeyConditionExpression=Key('pk').eq(f'PROJECT#{PROJECT_ID}'),
        )


class TestPersonas:
    def test_only_selected_persona_rows_reach_the_prompt(self, world):
        persona = {'sk': 'PERSONA#p1', 'persona_id': 'p1', 'name': 'Pat'}
        world.projects.query.return_value = {'Items': [
            DOC_A, DOC_B, persona,
            {'sk': 'PERSONA#p2', 'persona_id': 'p2'},
            {'sk': 'PRD#x', 'persona_id': 'p1'},
        ]}
        _run(selected_persona_ids=['p1'])

        world.personas.assert_called_once_with([persona], header='## USER PERSONAS FOR CONTEXT')
        assert f'{TWO_DOCS_BLOCK}\n\nPERSONA BLOCK\n\nCreate a new' in _prompt(world)
        assert _derivation(world)['persona_ids'] == ['p1']

    def test_an_empty_persona_block_is_left_out(self, world):
        world.personas.return_value = ''
        world.projects.query.return_value = {'Items': [DOC_A, DOC_B, {'sk': 'PERSONA#p1', 'persona_id': 'p1'}]}
        _run(selected_persona_ids=['p1'])

        assert f'{TWO_DOCS_BLOCK}\n\nCreate a new' in _prompt(world)


class TestFeedback:
    def test_feedback_is_not_read_unless_asked_for(self, world):
        _run()
        world.query_feedback.assert_not_called()
        assert _derivation(world)['feedback_count'] == 0

    def test_the_query_defaults(self, world):
        _run(use_feedback=True)
        world.query_feedback.assert_called_once_with(
            world.feedback, days=30, sources=None, categories=None, limit=100, category_scope=None,
        )
        assert _derivation(world)['feedback_count'] == 0
        assert f'{TWO_DOCS_BLOCK}\n\nCreate a new' in _prompt(world)

    def test_the_query_carries_the_config(self, world):
        _run(use_feedback=True, days=7, feedback_sources=['app'], feedback_categories=['billing'],
             category_scope={'all': False, 'categories': ['billing']})
        world.query_feedback.assert_called_once_with(
            world.feedback, days=7, sources=['app'], categories=['billing'], limit=100,
            category_scope=CategoryScope(all=False, categories=frozenset({'billing'})),
        )

    def test_the_section_caps_reviews_and_text(self, world):
        rows = [{'source_platform': 'web', 'sentiment_label': 'negative', 'original_text': f'r{i}'}
                for i in range(21)]
        rows[0] = {'original_text': 'x' * 250 + 'y'}
        rows[1] = {}
        world.query_feedback.return_value = rows
        _run(use_feedback=True)

        expected = (
            '## ADDITIONAL CUSTOMER FEEDBACK\n\n'
            f'**Review 1** (unknown, unknown): {"x" * 250}\n\n'
            '**Review 2** (unknown, unknown): \n\n'
            + ''.join(f'**Review {i + 1}** (web, negative): r{i}\n\n' for i in range(2, 20))
        )
        assert _prompt(world).endswith(
            f'{TWO_DOCS_BLOCK}\n\n{expected}\n\nCreate a new document incorporating all relevant feedback.'
        )
        assert _derivation(world)['feedback_count'] == 20


class TestTheSave:
    def test_a_custom_document_row(self, world):
        _run(title='T', instructions='I', selected_document_ids=['doc_a', 'doc_b', 'gone'])

        expected_item = {
            'gsi1pk': f'PROJECT#{PROJECT_ID}#DOCUMENTS',
            'gsi1sk': FIXED_ISO,
            'content': MERGED,
            'job_id': JOB_ID,
            'source_documents': ['doc_a', 'doc_b', 'gone'],
            'merge_instructions': 'I',
            'derivation': {
                'sources': [{'document_id': 'doc_a', 'role': 'merge_input'},
                            {'document_id': 'doc_b', 'role': 'merge_input'}],
                'selected_document_count': 3,
                'feedback_count': 0,
                'persona_ids': [],
                'visual_document_ids': [],
                'product_context_included': False,
            },
            'created_at': FIXED_ISO,
            'pk': f'PROJECT#{PROJECT_ID}',
            'sk': 'DOC#doc_20250102030405_a1b2c3d4',
            'document_id': 'doc_20250102030405_a1b2c3d4',
            'document_type': 'custom',
            'title': 'T',
        }
        world.put_and_increment.assert_called_once_with(
            world.projects, PROJECT_ID, expected_item, 'document_count',
        )
        world.persist.assert_not_called()
        world.lookup.assert_not_called()

    @pytest.mark.parametrize('output_type', ['prd', 'prfaq'])
    def test_a_versioned_document_goes_through_the_allocator(self, world, output_type):
        result = _run(output_type=output_type, title='T')

        world.lookup.assert_called_once_with(world.projects, PROJECT_ID, output_type, JOB_ID)
        (table, project_id, document_type, title, allocation, fields), _ = world.persist.call_args
        assert (table, project_id, document_type, title, allocation) == (
            world.projects, PROJECT_ID, output_type, 'T', JOB_ID,
        )
        assert fields['content'] == MERGED
        assert result == {'success': True, 'document_id': 'prd_v', 'title': 'Merged (v2)'}
        world.put_and_increment.assert_not_called()

    def test_the_progress_ladder(self, world):
        world.projects.query.return_value = {'Items': [DOC_A, DOC_B, {'sk': 'PERSONA#p1', 'persona_id': 'p1'}]}
        _run(selected_persona_ids=['p1'], use_feedback=True)

        assert _ladder(world.jobs) == [
            (10, 'gathering_documents'), (20, 'preparing_context'), (30, 'fetching_personas'),
            (40, 'fetching_feedback'), (50, 'generating_merged_document'), (60, 'calling_ai'),
            (90, 'saving_document'), (100, 'complete'),
        ]


class TestTheEnvironment:
    def test_the_tables_come_from_the_environment(self, world):
        _run()
        # lambda/conftest.py sets both; the module read them at import.
        assert (os.environ['PROJECTS_TABLE'], os.environ['FEEDBACK_TABLE']) == ('test-projects', 'test-feedback')
        assert world.resource.Table.call_args_list == [call('test-projects'), call('test-feedback')]

    def test_both_default_to_empty_when_unset(self, monkeypatch):
        with monkeypatch.context() as env:
            env.delenv('PROJECTS_TABLE')
            env.delenv('FEEDBACK_TABLE')
            try:
                importlib.reload(handler)
                assert (handler.PROJECTS_TABLE, handler.FEEDBACK_TABLE) == ('', '')
            finally:
                env.undo()
                importlib.reload(handler)
        assert (handler.PROJECTS_TABLE, handler.FEEDBACK_TABLE) == ('test-projects', 'test-feedback')


def _context() -> SimpleNamespace:
    # Plain attributes: a MagicMock answers `.lambda_context` too, which the
    # logger reads as a durable-execution wrapper around the real context.
    return SimpleNamespace(
        function_name='voc-document-merger', memory_limit_in_mb=256,
        invoked_function_arn='arn:aws:lambda:us-east-1:123456789012:function:voc-document-merger',
        aws_request_id='req-merge-1', get_remaining_time_in_millis=lambda: 300_000,
    )


class TestLambdaHandlerIsWrapped:
    @pytest.mark.usefixtures('world')
    def test_the_entry_log_line_and_the_logger_context(self):
        logger.remove_keys(['function_name', 'cold_start'])
        with patch.object(logger, 'info') as info:
            result = handler.lambda_handler(_event(), _context())

        assert result['document_id'] == 'doc_20250102030405_a1b2c3d4'
        assert info.call_args_list[0] == call(
            "Document merger invoked with event keys: ['project_id', 'job_id', 'merge_config']",
        )
        assert logger.get_current_keys()['function_name'] == 'voc-document-merger'

    @pytest.mark.usefixtures('world')
    def test_the_cold_start_metric_is_flushed_as_emf(self, capsys):
        invoke = partial(handler.lambda_handler, _event(), _context())
        assert cold_start_metric_names(metrics, invoke, capsys) == {'ColdStart'}

    def test_logger_tracer_and_metrics_wrap_the_handler_in_that_order(self):
        layers = []
        func = handler.lambda_handler
        while func is not None:
            layers.append(os.path.basename(func.__code__.co_filename))
            func = vars(func).get('__wrapped__')
        # logger.inject_lambda_context → tracer.capture_lambda_handler → metrics.log_metrics
        # → the invocation_cost line → the handler
        assert layers == ['logger.py', 'tracer.py', 'base.py', 'invocation_cost.py', 'handler.py']
        assert inspect.unwrap(handler.handle_job).__name__ == 'handle_job'
