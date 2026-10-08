"""Document-type dispatch (#397) and the feedback budget (#231).

Dispatch: an unmapped doc_type used to fall through to PR-FAQ on every path and
be billed and saved as one. These tests pin that it now fails BEFORE any model
call or feedback read, on the single-shot path and on each Step Functions step.

Budget: the generator fetched 100 reviews and then kept 30, reporting nothing.
It now sizes the fetch and the prompt from the resolved model's window (the
shared/feedback.py derivation personas use) and records what reached the model.
"""
import json
from unittest.mock import MagicMock, patch

import pytest

from jobs.document_generator import handler
from shared.exceptions import ServiceError
from shared.feedback import feedback_char_budget, feedback_item_limit

from .conftest import TEST_CONTEXT_WINDOW_TOKENS

UNKNOWN_DOC_TYPE = 'onepager'
# conftest pins the 'documents' model window to TEST_CONTEXT_WINDOW_TOKENS.
FETCH_LIMIT = feedback_item_limit(feedback_char_budget(window_tokens=TEST_CONTEXT_WINDOW_TOKENS))


def _reviews(count: int) -> list[dict]:
    return [
        {'original_text': f'review number {i}', 'source_platform': 'webscraper',
         'sentiment_label': 'negative'}
        for i in range(count)
    ]


def _sample(reviews: list[dict]) -> tuple[handler.FeedbackSample, MagicMock]:
    """``_feedback_context`` over ``reviews``, plus the patched fetch it called."""
    with patch.object(handler, 'query_feedback_by_date', return_value=reviews) as fetch:
        return handler._feedback_context(MagicMock(), {}), fetch


def _save_with_scratch(read) -> tuple[MagicMock, MagicMock]:
    """Run the Step Functions save step over ``read`` (the scratch reader).

    Returns the patched ``persist_versioned_document`` and ``update_job_status``.
    """
    with patch.object(handler, '_get_text', side_effect=read), \
            patch.object(handler, 'update_job_status') as status, \
            patch.object(handler, 'persist_versioned_document',
                         return_value={'document_id': 'prd_1', 'title': 'T (v1)'}) as persist:
        handler._assemble_and_save('p1', 'j1', 'prd', 'T', 'idea', 3)
    return persist, status


def _scratch_reader(texts: dict[str, str]):
    """A scratch reader serving ``texts`` and a placeholder for every step output."""
    return lambda key: texts.get(key, 'step output')


class TestUnknownDocTypeMakesNoModelCall:
    @pytest.mark.usefixtures('mock_dynamodb', 'mock_prompt_steps')
    def test_single_shot_job_fails_without_a_chain_or_feedback_read(
        self, mock_converse_chain, mock_jobs_table, prd_generation_event, lambda_context,
    ):
        """Models a real widening: the new type is already version-managed (it must
        be, to persist), so only the dispatch map stands between it and a PR-FAQ."""
        prd_generation_event['doc_config']['doc_type'] = UNKNOWN_DOC_TYPE
        widened = frozenset({'prd', 'prfaq', 'prototype', UNKNOWN_DOC_TYPE})
        with patch('shared.document_versions.VERSIONED_DOCUMENT_TYPES', widened), \
                patch.object(handler, 'query_feedback_by_date') as fetch, \
                pytest.raises(ServiceError, match='Document generation failed'):
            handler.lambda_handler(prd_generation_event, lambda_context)
        assert mock_converse_chain.call_count == 0
        assert fetch.call_count == 0
        assert mock_jobs_table.update_item.call_args.kwargs[
            'ExpressionAttributeValues'][':status'] == 'failed'

    @pytest.mark.usefixtures('mock_dynamodb', 'mock_jobs_table', 'mock_s3')
    def test_gather_step_raises_before_any_read_or_scratch_write(self, prd_generation_event):
        doc_config = {**prd_generation_event['doc_config'], 'doc_type': UNKNOWN_DOC_TYPE}
        with patch.object(handler, '_gather_context') as gather, \
                patch.object(handler, '_put_text') as put, \
                pytest.raises(handler.UnsupportedDocTypeError, match=UNKNOWN_DOC_TYPE):
            handler._build_steps('p1', 'j1', doc_config)
        assert gather.call_count == 0
        assert put.call_count == 0

    @pytest.mark.usefixtures('mock_dynamodb', 'mock_jobs_table')
    def test_save_step_raises_before_reading_results(self):
        with patch.object(handler, '_get_text') as read, \
                pytest.raises(handler.UnsupportedDocTypeError, match='supported: prd, prfaq'):
            handler._assemble_and_save('p1', 'j1', UNKNOWN_DOC_TYPE, 'T', 'idea', 3)
        assert read.call_count == 0


class TestEachMappedTypeUsesItsOwnChain:
    @pytest.mark.parametrize(('doc_type', 'builder'), [('prd', 'prd'), ('prfaq', 'prfaq')])
    def test_build_steps_reaches_the_matching_builder(self, mock_prompt_steps, doc_type, builder):
        handler.CHAIN_DOC_TYPES[doc_type].build_steps(feature_idea='x')
        assert mock_prompt_steps[builder].call_count == 1


class TestFeedbackBudget:
    def test_a_large_corpus_is_not_cut_at_thirty(self):
        sample, _ = _sample(_reviews(60))
        assert sample.items_used == 60
        assert '### Review 60' in sample.context
        assert sample.truncated is False

    def test_reaching_the_fetch_limit_is_reported_as_truncated(self):
        sample, _ = _sample(_reviews(FETCH_LIMIT))
        assert sample.truncated is True

    def test_the_character_budget_trims_on_a_record_boundary_and_says_so(self):
        reviews = _reviews(10)
        with patch.object(handler, 'feedback_char_budget', return_value=600), \
                patch.object(handler, 'query_feedback_by_date', return_value=reviews):
            sample = handler._feedback_context(MagicMock(), {})
        assert 0 < sample.items_used < 10
        assert sample.truncated is True

    def test_a_small_corpus_is_used_whole_and_not_truncated(self):
        sample, _ = _sample(_reviews(3))
        assert sample == handler.FeedbackSample(sample.context, 3, False)


class TestFeedbackUsageIsRecorded:
    @pytest.mark.usefixtures('mock_dynamodb', 'mock_jobs_table', 'mock_converse_chain', 'mock_prompt_steps')
    def test_single_shot_records_it_on_the_result_and_the_document(
        self, mock_dynamodb, prd_generation_event, lambda_context,
    ):
        mock_dynamodb['table'].query.return_value = {'Items': []}
        with patch.object(handler, 'query_feedback_by_date', return_value=_reviews(45)):
            result = handler.lambda_handler(prd_generation_event, lambda_context)
        item = mock_dynamodb['table'].put_item.call_args.kwargs['Item']
        assert (result['feedback_items_used'], result['context_truncated']) == (45, False)
        assert (item['feedback_items_used'], item['context_truncated']) == (45, False)
        assert item['derivation']['feedback_count'] == 45

    @pytest.mark.usefixtures('mock_dynamodb', 'mock_jobs_table', 'mock_s3')
    def test_step_functions_save_records_what_gather_stashed(self):
        usage = {'feedback_items_used': 12, 'context_truncated': True}
        texts = {handler._scratch_key('j1', 'feedback_usage'): json.dumps(usage)}
        persist, status = _save_with_scratch(_scratch_reader(texts))
        assert persist.call_args.args[5]['feedback_items_used'] == 12
        assert status.call_args.kwargs['result'] == {'document_id': 'prd_1', 'title': 'T (v1)', **usage}

    @pytest.mark.usefixtures('mock_dynamodb', 'mock_jobs_table', 'mock_s3')
    def test_an_execution_gathered_before_the_stash_saves_without_the_fields(self):
        def read(key: str) -> str:
            if key.endswith('feedback_usage.txt'):
                raise RuntimeError('NoSuchKey')
            return 'step output'
        persist, _ = _save_with_scratch(read)
        assert 'context_truncated' not in persist.call_args.args[5]


class TestDateBasisIsRecorded:
    """#258: a PRD/PR-FAQ stores the (validated) basis its feedback was read with."""

    @pytest.mark.usefixtures('mock_jobs_table', 'mock_converse_chain', 'mock_prompt_steps')
    def test_single_shot_stores_the_validated_basis_it_queried_with(
        self, mock_dynamodb, prd_generation_event, lambda_context,
    ):
        mock_dynamodb['table'].query.return_value = {'Items': []}
        prd_generation_event['doc_config']['date_basis'] = ' Review '
        with patch.object(handler, 'query_feedback_by_date', return_value=_reviews(2)) as fetch:
            handler.lambda_handler(prd_generation_event, lambda_context)
        item = mock_dynamodb['table'].put_item.call_args.kwargs['Item']
        assert item['date_basis'] == 'review'
        assert fetch.call_args.kwargs['date_basis'] == item['date_basis']

    @pytest.mark.usefixtures('mock_dynamodb', 'mock_jobs_table', 'mock_s3')
    def test_step_functions_save_stores_the_stashed_basis_revalidated(self):
        texts = {handler._scratch_key('j1', 'date_basis'): json.dumps({'date_basis': 'bogus'})}
        persist, _ = _save_with_scratch(_scratch_reader(texts))
        assert persist.call_args.args[5]['date_basis'] == 'imported'

    @pytest.mark.usefixtures('mock_dynamodb', 'mock_jobs_table', 'mock_s3')
    def test_an_execution_gathered_before_the_stash_omits_the_basis(self):
        persist, _ = _save_with_scratch(_scratch_reader({}))
        assert 'date_basis' not in persist.call_args.args[5]

    @pytest.mark.usefixtures('mock_dynamodb', 'mock_jobs_table', 'mock_s3')
    def test_gather_stashes_the_validated_basis(self, prd_generation_event):
        doc_config = {**prd_generation_event['doc_config'], 'date_basis': 'REVIEW'}
        with patch.object(handler, 'query_feedback_by_date', return_value=[]), \
                patch.object(handler, '_put_text') as put:
            handler._build_steps('p1', 'j1', doc_config)
        stashed = {c.args[0]: c.args[1] for c in put.call_args_list}
        assert json.loads(stashed[handler._scratch_key('j1', 'date_basis')]) == {'date_basis': 'review'}
