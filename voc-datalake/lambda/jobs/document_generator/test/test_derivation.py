"""Every document the generator creates records what it was built from.

The fixture here deliberately selects MORE reference documents than the
generator consumes (five selected, three used) and orders them so the used
three are not the first three of the selection. A fixture with three or fewer
selected documents cannot tell "what was used" from "what was requested", and a
fixture whose selection order matches the query order cannot tell either apart
from a slice of the request.
"""
import sys
from unittest.mock import MagicMock, patch

import pytest

# The wizard selected five reference documents...
SELECTED_IDS = ['doc_a', 'doc_b', 'doc_c', 'doc_d', 'doc_e']

# ...and the project table returns them in the REVERSE order, so the three the
# generator actually feeds the model (the first three it iterates) are doc_e,
# doc_d, doc_c — not the first three of the selection.
PROJECT_DOCS = [
    {
        'sk': f'PRD#{doc_id}',
        'document_id': doc_id,
        'document_type': 'prd',
        'base_title': doc_id.upper(),
        'version': 1,
        'title': f'{doc_id.upper()} (v1)',
        'content': f'body of {doc_id}',
    }
    for doc_id in reversed(SELECTED_IDS)
]

USED_SOURCES = [
    {'document_id': 'doc_e', 'role': 'reference'},
    {'document_id': 'doc_d', 'role': 'reference'},
    {'document_id': 'doc_c', 'role': 'reference'},
]


def _saved_item(mock_dynamodb):
    return mock_dynamodb['table'].put_item.call_args.kwargs['Item']


class TestReferenceDocumentProvenance:
    """The PRD/PR-FAQ path: records the documents that reached the model."""

    @pytest.fixture
    def event(self, sample_job_event):
        return {
            **sample_job_event,
            'doc_config': {
                'doc_type': 'prd',
                'title': 'Test PRD',
                'feature_idea': 'Improve onboarding',
                'data_sources': {'feedback': False, 'personas': False, 'documents': True},
                'selected_document_ids': SELECTED_IDS,
                'days': 30,
            },
        }

    @pytest.fixture(autouse=True)
    def wire_project_documents(self, mock_dynamodb):
        mock_dynamodb['table'].query.return_value = {'Items': PROJECT_DOCS}

    def test_records_the_three_documents_used_not_the_five_selected(
        self, mock_dynamodb, mock_jobs_table, mock_converse_chain, mock_prompt_steps,
        event, lambda_context,
    ):
        from jobs.document_generator.handler import lambda_handler

        lambda_handler(event, lambda_context)

        assert _saved_item(mock_dynamodb)['derivation']['sources'] == USED_SOURCES

    def test_states_how_many_were_selected_so_the_drop_is_visible(
        self, mock_dynamodb, mock_jobs_table, mock_converse_chain, mock_prompt_steps,
        event, lambda_context,
    ):
        from jobs.document_generator.handler import lambda_handler

        lambda_handler(event, lambda_context)

        assert _saved_item(mock_dynamodb)['derivation']['selected_document_count'] == 5

    def test_a_selected_document_that_no_longer_exists_counts_as_selected_only(
        self, mock_dynamodb, mock_jobs_table, mock_converse_chain, mock_prompt_steps,
        event, lambda_context,
    ):
        """A deleted document can still be in the request. It cannot be a source
        (it never reached the model) but it was selected, so the count includes it."""
        event['doc_config']['selected_document_ids'] = ['doc_deleted'] + SELECTED_IDS

        from jobs.document_generator.handler import lambda_handler

        lambda_handler(event, lambda_context)

        derivation = _saved_item(mock_dynamodb)['derivation']
        assert derivation['sources'] == USED_SOURCES
        assert derivation['selected_document_count'] == 6

    def test_records_feedback_and_persona_inputs_actually_used(
        self, mock_dynamodb, mock_jobs_table, mock_converse_chain, mock_prompt_steps,
        event, lambda_context,
    ):
        """A PRD built from feedback and personas must not read as built from
        nothing: the counts and persona ids that reached the prompt are recorded."""
        event['doc_config']['data_sources'] = {'feedback': True, 'personas': True, 'documents': False}
        # One day of lookback, so the mocked table answers the date loop once.
        event['doc_config']['days'] = 1
        mock_dynamodb['table'].query.return_value = {
            'Items': [
                {'sk': 'PERSONA#persona_1', 'persona_id': 'persona_1', 'name': 'Ana'},
                {'sk': 'PERSONA#persona_2', 'persona_id': 'persona_2', 'name': 'Bo'},
            ],
        }
        feedback_table = MagicMock()
        feedback_table.query.return_value = {
            'Items': [
                {'original_text': f'review {i}', 'source_platform': 'webscraper', 'sentiment_label': 'negative'}
                for i in range(4)
            ],
        }
        mock_dynamodb['resource'].Table.side_effect = (
            lambda name: feedback_table if 'feedback' in name.lower() else mock_dynamodb['table']
        )

        from jobs.document_generator.handler import lambda_handler

        lambda_handler(event, lambda_context)

        derivation = _saved_item(mock_dynamodb)['derivation']
        assert derivation['feedback_count'] == 4
        assert derivation['persona_ids'] == ['persona_1', 'persona_2']
        assert derivation['sources'] == []

    def test_records_whether_the_product_context_block_was_included(
        self, mock_dynamodb, mock_jobs_table, mock_converse_chain, mock_prompt_steps,
        event, lambda_context,
    ):
        from jobs.document_generator import handler

        with patch.object(handler, '_product_context', return_value=('### Product\nreal context', True)):
            handler.lambda_handler(event, lambda_context)

        assert _saved_item(mock_dynamodb)['derivation']['product_context_included'] is True

    def test_a_document_with_no_inputs_records_an_empty_derivation(
        self, mock_dynamodb, mock_jobs_table, mock_converse_chain, mock_prompt_steps,
        event, lambda_context,
    ):
        """The question must always be answerable — "nothing" is an answer, and
        it is recorded with every key present rather than by omission."""
        event['doc_config']['data_sources'] = {'feedback': False, 'personas': False, 'documents': False}

        from jobs.document_generator.handler import lambda_handler

        lambda_handler(event, lambda_context)

        assert _saved_item(mock_dynamodb)['derivation'] == {
            'sources': [],
            'selected_document_count': 0,
            'feedback_count': 0,
            'persona_ids': [],
            'visual_document_ids': [],
            'product_context_included': False,
        }


class TestProductContextFlag:
    """_product_context reports whether the block carries anything, without
    letting a failure to build it fail the job."""

    def test_a_real_block_reports_included(self):
        from jobs.document_generator.handler import _product_context

        fake = MagicMock()
        fake.build_product_context_block.return_value = '### Structured product context\n**Product**: Acme'
        with patch.dict(sys.modules, {'api.product_context': fake}):
            block, included = _product_context('proj_1')

        assert included is True
        assert block == '### Structured product context\n**Product**: Acme'

    def test_the_empty_placeholder_reports_not_included(self):
        from jobs.document_generator.handler import _product_context

        fake = MagicMock()
        fake.build_product_context_block.return_value = '(No product context provided.)'
        with patch.dict(sys.modules, {'api.product_context': fake}):
            _, included = _product_context('proj_1')

        assert included is False

    def test_a_failure_falls_back_to_the_placeholder_and_reports_not_included(self):
        from jobs.document_generator.handler import _product_context

        fake = MagicMock()
        fake.build_product_context_block.side_effect = RuntimeError('table gone')
        with patch.dict(sys.modules, {'api.product_context': fake}):
            block, included = _product_context('proj_1')

        assert block == '(No product context provided.)'
        assert included is False


class TestPrototypeProvenance:
    """A prototype records the PRD and PR/FAQ it was built from in the shared
    shape as well as in its own two fixed fields."""

    HTML = '<!DOCTYPE html><html><body><h1>Demo</h1></body></html>'

    def _event(self, sample_job_event):
        return {
            **sample_job_event,
            'doc_config': {'doc_type': 'build_prototype', 'title': 'Test Prototype'},
        }

    def _latest(self, prd, prfaq):
        """Stand in for the per-prefix "newest document" lookup, whose real
        DynamoDB key condition a MagicMock table cannot distinguish."""
        return lambda _table, _project_id, prefix: prd if prefix == 'PRD#' else prfaq

    def test_records_both_source_documents_with_distinct_roles(
        self, mock_dynamodb, mock_jobs_table, mock_converse, mock_s3, sample_job_event, lambda_context,
    ):
        mock_dynamodb['table'].get_item.return_value = {'Item': {'name': 'My Project'}}
        mock_converse.return_value = self.HTML

        from jobs.document_generator import handler
        with patch.object(handler, '_latest_doc_by_prefix', self._latest(
            {'document_id': 'prd_1', 'content': 'PRD body'},
            {'document_id': 'prfaq_1', 'content': 'PRFAQ body'},
        )):
            handler.lambda_handler(self._event(sample_job_event), lambda_context)

        item = _saved_item(mock_dynamodb)
        assert item['derivation']['sources'] == [
            {'document_id': 'prd_1', 'role': 'prototype_prd'},
            {'document_id': 'prfaq_1', 'role': 'prototype_prfaq'},
        ]
        assert item['derivation']['selected_document_count'] == 2
        # The original fixed-arity fields are untouched.
        assert item['source_prd_id'] == 'prd_1'
        assert item['source_prfaq_id'] == 'prfaq_1'

    def test_a_prototype_built_from_one_document_records_only_that_one(
        self, mock_dynamodb, mock_jobs_table, mock_converse, mock_s3, sample_job_event, lambda_context,
    ):
        """`source_prfaq_id` is written as a REAL stored null here; the shared
        shape must not turn that null into a source."""
        mock_dynamodb['table'].get_item.return_value = {'Item': {'name': 'My Project'}}
        mock_converse.return_value = self.HTML

        from jobs.document_generator import handler
        with patch.object(handler, '_latest_doc_by_prefix', self._latest(
            {'document_id': 'prd_1', 'content': 'PRD body'}, None,
        )):
            handler.lambda_handler(self._event(sample_job_event), lambda_context)

        item = _saved_item(mock_dynamodb)
        assert item['derivation']['sources'] == [{'document_id': 'prd_1', 'role': 'prototype_prd'}]
        assert item['derivation']['selected_document_count'] == 1
        assert item['source_prfaq_id'] is None


class TestStepFunctionsPath:
    """PRD/PR-FAQ generation is split across Lambda invocations; the derivation
    is decided at gather and must survive to the save step."""

    def test_gather_stashes_the_derivation_and_save_writes_it(
        self, mock_dynamodb, mock_jobs_table, mock_prompt_steps, mock_s3,
        sample_job_event, lambda_context,
    ):
        from jobs.document_generator import handler
        lambda_handler = handler.lambda_handler

        mock_dynamodb['table'].query.return_value = {'Items': PROJECT_DOCS}
        stash: dict[str, bytes] = {}
        mock_s3.put_object.side_effect = lambda **kw: stash.__setitem__(kw['Key'], kw['Body'])

        def get_object(Bucket=None, Key=None, **kwargs):
            body = MagicMock()
            body.read.return_value = stash[Key]
            return {'Body': body}
        mock_s3.get_object.side_effect = get_object

        gathered = lambda_handler({
            'step': 'gather',
            **sample_job_event,
            'doc_config': {
                'doc_type': 'prd',
                'title': 'Test PRD',
                'feature_idea': 'Improve onboarding',
                'data_sources': {'documents': True},
                'selected_document_ids': SELECTED_IDS,
            },
        }, lambda_context)

        # Each chain step runs in its own invocation; the module-level converse
        # binding is what run_step calls.
        with patch.object(handler, 'converse', return_value='step output'):
            for index in range(gathered['num_steps']):
                lambda_handler({'step': 'run_step', **sample_job_event, 'index': index}, lambda_context)

        lambda_handler({
            'step': 'save',
            **sample_job_event,
            'doc_type': 'prd',
            'title': 'Test PRD',
            'feature_idea': 'Improve onboarding',
            'num_steps': gathered['num_steps'],
        }, lambda_context)

        derivation = _saved_item(mock_dynamodb)['derivation']
        assert derivation['sources'] == USED_SOURCES
        assert derivation['selected_document_count'] == 5

    def test_save_still_writes_a_document_when_the_derivation_is_unreadable(
        self, mock_dynamodb, mock_jobs_table, mock_s3, sample_job_event, lambda_context,
    ):
        """An execution replayed against a cleaned scratch prefix must still save
        the document; "no lineage" is a legitimate answer, not a failure."""
        from jobs.document_generator.handler import _assemble_and_save

        def get_object(Bucket=None, Key=None, **kwargs):
            if Key.endswith('derivation.txt'):
                raise RuntimeError('NoSuchKey')
            body = MagicMock()
            body.read.return_value = b'step output'
            return {'Body': body}
        mock_s3.get_object.side_effect = get_object

        _assemble_and_save(
            sample_job_event['project_id'], sample_job_event['job_id'],
            'prd', 'Test PRD', 'Improve onboarding', 3,
        )

        assert _saved_item(mock_dynamodb)['derivation'] == {
            'sources': [],
            'selected_document_count': 0,
            'feedback_count': 0,
            'persona_ids': [],
            'visual_document_ids': [],
            'product_context_included': False,
        }
