"""Tests for document generator job handler (multi-step chain)."""

import pytest
from unittest.mock import MagicMock


class TestDocumentGeneratorHandler:
    """Tests for the document generator job Lambda handler."""

    @pytest.fixture(autouse=True)
    def setup_empty_query_response(self, mock_dynamodb):
        """Set default empty query response for all tests."""
        mock_dynamodb['table'].query.return_value = {'Items': []}

    def test_successful_prd_generation(
        self, mock_dynamodb, mock_jobs_table, mock_converse_chain, mock_prompt_steps,
        prd_generation_event, lambda_context
    ):
        """Test successful PRD generation using multi-step chain."""
        from jobs.document_generator.handler import lambda_handler

        result = lambda_handler(prd_generation_event, lambda_context)

        assert result['success'] is True
        assert 'document_id' in result
        assert result['document_id'].startswith('prd_')
        mock_converse_chain.assert_called_once()

    def test_successful_prfaq_generation(
        self, mock_dynamodb, mock_jobs_table, mock_converse_chain, mock_prompt_steps,
        prfaq_generation_event, lambda_context
    ):
        """Test successful PR-FAQ generation using multi-step chain."""
        mock_converse_chain.return_value = [
            "Customer insights", "Press release content",
            "Customer FAQ content", "Internal FAQ content",
        ]

        from jobs.document_generator.handler import lambda_handler

        result = lambda_handler(prfaq_generation_event, lambda_context)

        assert result['success'] is True
        assert result['document_id'].startswith('prfaq_')
        mock_converse_chain.assert_called_once()

    def test_prd_uses_multi_step_chain_from_prompt_template(
        self, mock_dynamodb, mock_jobs_table, mock_converse_chain, mock_prompt_steps,
        prd_generation_event, lambda_context
    ):
        """PRD generation should use get_prd_generation_steps to build the chain."""
        from jobs.document_generator.handler import lambda_handler

        lambda_handler(prd_generation_event, lambda_context)

        mock_prompt_steps['prd'].assert_called_once()
        call_kwargs = mock_prompt_steps['prd'].call_args.kwargs
        assert call_kwargs['feature_idea'] == 'Improve user onboarding flow'

    def test_prfaq_uses_multi_step_chain_from_prompt_template(
        self, mock_dynamodb, mock_jobs_table, mock_converse_chain, mock_prompt_steps,
        prfaq_generation_event, lambda_context
    ):
        """PR-FAQ generation should use get_prfaq_generation_steps to build the chain."""
        mock_converse_chain.return_value = [
            "Insights", "Press release", "Customer FAQ", "Internal FAQ",
        ]

        from jobs.document_generator.handler import lambda_handler

        lambda_handler(prfaq_generation_event, lambda_context)

        mock_prompt_steps['prfaq'].assert_called_once()
        call_kwargs = mock_prompt_steps['prfaq'].call_args.kwargs
        assert call_kwargs['feature_idea'] == 'New mobile app feature'

    def test_prd_stores_analysis_sections(
        self, mock_dynamodb, mock_jobs_table, mock_converse_chain, mock_prompt_steps,
        prd_generation_event, lambda_context
    ):
        """PRD should store problem/solution analysis from intermediate chain steps."""
        mock_converse_chain.return_value = [
            "Deep problem analysis", "Solution design", "Final PRD document",
        ]

        from jobs.document_generator.handler import lambda_handler

        lambda_handler(prd_generation_event, lambda_context)

        put_call = mock_dynamodb['table'].put_item.call_args
        item = put_call.kwargs.get('Item', {})
        assert item['analysis']['problem'] == 'Deep problem analysis'
        assert item['analysis']['solution'] == 'Solution design'
        assert item['content'] == 'Final PRD document'

    def test_prfaq_composes_full_document_from_chain_results(
        self, mock_dynamodb, mock_jobs_table, mock_converse_chain, mock_prompt_steps,
        prfaq_generation_event, lambda_context
    ):
        """PR-FAQ should compose press release + FAQ sections into a single document."""
        mock_converse_chain.return_value = [
            "Customer insights", "The press release text",
            "Customer FAQ section", "Internal FAQ section",
        ]

        from jobs.document_generator.handler import lambda_handler

        lambda_handler(prfaq_generation_event, lambda_context)

        put_call = mock_dynamodb['table'].put_item.call_args
        item = put_call.kwargs.get('Item', {})
        content = item['content']
        assert 'The press release text' in content
        assert 'Customer FAQ section' in content
        assert 'Internal FAQ section' in content
        # Sections should be stored separately too
        assert item['analysis']['press_release'] == 'The press release text'
        assert item['analysis']['customer_faq'] == 'Customer FAQ section'

    def test_document_saved_to_dynamodb(
        self, mock_dynamodb, mock_jobs_table, mock_converse_chain, mock_prompt_steps,
        prd_generation_event, lambda_context
    ):
        """Test that generated document is saved to DynamoDB."""
        from jobs.document_generator.handler import lambda_handler

        lambda_handler(prd_generation_event, lambda_context)

        mock_dynamodb['table'].put_item.assert_called()
        put_call = mock_dynamodb['table'].put_item.call_args
        item = put_call.kwargs.get('Item', {})
        assert 'document_id' in item
        assert item.get('document_type') == 'prd'
        assert item.get('title') == 'Test PRD (v1)'
        assert item.get('base_title') == 'Test PRD'
        assert item.get('version') == 1
        assert 'content' in item
        assert 'created_at' in item
        assert item.get('feature_idea') == 'Improve user onboarding flow'

    def test_project_document_count_updated(
        self, mock_dynamodb, mock_jobs_table, mock_converse_chain, mock_prompt_steps,
        prd_generation_event, lambda_context
    ):
        """Test that project document_count is incremented after generation."""
        from jobs.document_generator.handler import lambda_handler

        lambda_handler(prd_generation_event, lambda_context)

        update_calls = mock_dynamodb['table'].update_item.call_args_list
        meta_update = next(
            (c for c in update_calls if 'META' in str(c.kwargs.get('Key', {}))),
            None
        )
        assert meta_update is not None, "Project META should be updated"
        assert 'document_count' in meta_update.kwargs.get('UpdateExpression', '')

    def test_job_status_updated_on_failure(
        self, mock_dynamodb, mock_jobs_table, mock_converse_chain, mock_prompt_steps,
        prd_generation_event, lambda_context
    ):
        """Test that job status is updated to failed on error."""
        from jobs.document_generator.handler import lambda_handler
        from shared.exceptions import ServiceError

        mock_converse_chain.side_effect = Exception("Bedrock error")

        with pytest.raises(ServiceError, match="Document generation failed"):
            lambda_handler(prd_generation_event, lambda_context)

        mock_jobs_table.update_item.assert_called()
        update_call = mock_jobs_table.update_item.call_args
        expr_values = update_call.kwargs.get('ExpressionAttributeValues', {})
        assert expr_values.get(':status') == 'failed'

    def test_progress_updates_during_generation(
        self, mock_dynamodb, mock_jobs_table, mock_converse_chain, mock_prompt_steps,
        prd_generation_event, lambda_context
    ):
        """Test that progress is updated at key stages."""
        from jobs.document_generator.handler import lambda_handler

        lambda_handler(prd_generation_event, lambda_context)

        update_calls = mock_jobs_table.update_item.call_args_list
        assert len(update_calls) >= 2, "Should have multiple progress updates"

    def test_gathers_feedback_when_enabled(
        self, mock_dynamodb, mock_jobs_table, mock_converse_chain, mock_prompt_steps,
        prd_generation_event, lambda_context
    ):
        """Test that feedback is gathered when data_sources.feedback is True."""
        mock_feedback_table = MagicMock()
        mock_feedback_table.query.return_value = {
            'Items': [
                {
                    'original_text': 'Great app!',
                    'source_platform': 'app_store',
                    'sentiment_label': 'positive'
                },
            ]
        }

        def table_factory(name):
            if 'feedback' in name.lower():
                return mock_feedback_table
            return mock_dynamodb['table']

        mock_dynamodb['resource'].Table.side_effect = table_factory

        from jobs.document_generator.handler import lambda_handler

        lambda_handler(prd_generation_event, lambda_context)

        assert mock_feedback_table.query.called, "Feedback table should be queried"

    def test_skips_feedback_when_disabled(
        self, mock_dynamodb, mock_jobs_table, mock_converse_chain, mock_prompt_steps,
        prd_generation_event, lambda_context
    ):
        """Test that feedback is not gathered when data_sources.feedback is False."""
        prd_generation_event['doc_config']['data_sources']['feedback'] = False
        mock_feedback_table = MagicMock()

        def table_factory(name):
            if 'feedback' in name.lower():
                return mock_feedback_table
            return mock_dynamodb['table']

        mock_dynamodb['resource'].Table.side_effect = table_factory

        from jobs.document_generator.handler import lambda_handler

        lambda_handler(prd_generation_event, lambda_context)

        assert not mock_feedback_table.query.called, "Feedback table should not be queried"

    def test_returns_title_in_result(
        self, mock_dynamodb, mock_jobs_table, mock_converse_chain, mock_prompt_steps,
        prd_generation_event, lambda_context
    ):
        """Test that result includes the document title."""
        from jobs.document_generator.handler import lambda_handler

        result = lambda_handler(prd_generation_event, lambda_context)

        assert result.get('title') == 'Test PRD (v1)'

    def test_passes_response_language_to_chain_steps(
        self, mock_dynamodb, mock_jobs_table, mock_converse_chain, mock_prompt_steps,
        prd_generation_event, lambda_context
    ):
        """Regression: response_language must be forwarded for CJK language support."""
        prd_generation_event['doc_config']['response_language'] = 'ko'

        from jobs.document_generator.handler import lambda_handler

        lambda_handler(prd_generation_event, lambda_context)

        call_kwargs = mock_prompt_steps['prd'].call_args.kwargs
        assert call_kwargs['response_language'] == 'ko'

    def test_chain_steps_passed_to_converse_chain(
        self, mock_dynamodb, mock_jobs_table, mock_converse_chain, mock_prompt_steps,
        prd_generation_event, lambda_context
    ):
        """The steps from get_prd_generation_steps should be passed directly to converse_chain."""
        from jobs.document_generator.handler import lambda_handler

        lambda_handler(prd_generation_event, lambda_context)

        chain_call_args = mock_converse_chain.call_args
        steps = chain_call_args[0][0]  # First positional arg
        assert len(steps) == 3  # problem_analysis, solution_design, prd_document
        assert steps[0]['step_name'] == 'problem_analysis'


class TestExtractHtml:
    """Tests for the _extract_html helper (pulls an HTML doc from model output)."""

    def test_extracts_plain_document(self):
        from jobs.document_generator.handler import _extract_html
        html = '<!DOCTYPE html><html><body>Hi</body></html>'
        assert _extract_html(html) == html

    def test_strips_code_fences(self):
        from jobs.document_generator.handler import _extract_html
        raw = '```html\n<!DOCTYPE html><html></html>\n```'
        assert _extract_html(raw) == '<!DOCTYPE html><html></html>'

    def test_strips_preamble_and_trailing_prose(self):
        from jobs.document_generator.handler import _extract_html
        raw = 'Sure! Here it is:\n<!DOCTYPE html><html></html>\nHope this helps.'
        assert _extract_html(raw) == '<!DOCTYPE html><html></html>'

    def test_matches_html_tag_without_doctype(self):
        from jobs.document_generator.handler import _extract_html
        raw = '<html lang="ko"><body></body></html>'
        assert _extract_html(raw) == raw

    def test_returns_empty_when_no_html(self):
        from jobs.document_generator.handler import _extract_html
        assert _extract_html('{"screens": []}') == ''
        assert _extract_html('') == ''


class TestBuildPrototype:
    """Tests for the HTML prototype build path (Opus 5, iframe-rendered)."""

    HTML = '<!DOCTYPE html><html><head><style>:root{--primary:#FF540F}</style></head><body><h1>Demo</h1></body></html>'

    def _prototype_event(self, sample_job_event, **config):
        return {
            **sample_job_event,
            'doc_config': {'doc_type': 'build_prototype', 'title': 'Test Prototype', **config},
        }

    def _wire_tables(self, mock_dynamodb):
        """A PRD exists so the prototype build has source material; META returns a name."""
        mock_dynamodb['table'].query.return_value = {
            'Items': [{'document_id': 'prd_1', 'content': 'PRD body', 'created_at': '2026-01-01'}],
        }
        mock_dynamodb['table'].get_item.return_value = {'Item': {'name': 'My Project'}}

    def test_build_prototype_saves_html_with_format_marker(
        self, mock_dynamodb, mock_jobs_table, mock_converse, mock_s3, sample_job_event, lambda_context
    ):
        self._wire_tables(mock_dynamodb)
        mock_converse.return_value = self.HTML

        from jobs.document_generator.handler import lambda_handler
        result = lambda_handler(self._prototype_event(sample_job_event), lambda_context)

        assert result['success'] is True
        assert result['document_id'].startswith('prototype_')
        put_item = mock_dynamodb['table'].put_item.call_args.kwargs['Item']
        assert put_item['document_type'] == 'prototype'
        assert put_item['prototype_format'] == 'html'
        # S3-only storage (2026-07-10 fix): no `content` field on new prototype
        # items — the HTML lives in S3.
        assert 'content' not in put_item
        # And NO prototype_url either (issue #229). `/prototypes/*` needs a
        # signed URL with a short expiry, so persisting one would store a link
        # that is expired for most of its life. The projects API mints it per
        # request from prototypes/{project_id}/{document_id}.html.
        assert 'prototype_url' not in put_item

    def test_build_prototype_writes_html_to_s3(
        self, mock_dynamodb, mock_jobs_table, mock_converse, mock_s3, sample_job_event, lambda_context
    ):
        """The generated HTML is written to S3 under prototypes/{project_id}/{doc_id}.html."""
        self._wire_tables(mock_dynamodb)
        mock_converse.return_value = self.HTML

        from jobs.document_generator.handler import lambda_handler
        result = lambda_handler(self._prototype_event(sample_job_event), lambda_context)

        mock_s3.put_object.assert_called_once()
        put_kwargs = mock_s3.put_object.call_args.kwargs
        assert put_kwargs['Key'] == f"prototypes/proj_20250101120000/{result['document_id']}.html"
        assert put_kwargs['Body'] == self.HTML.encode('utf-8')
        assert put_kwargs['ContentType'] == 'text/html; charset=utf-8'

    def test_build_prototype_uses_prototype_surface(
        self, mock_dynamodb, mock_jobs_table, mock_converse, mock_s3, sample_job_event, lambda_context
    ):
        """The prototype build resolves its model through the 'prototype'
        surface of the AI-model picker (whose default is Opus 5) instead of
        hard-pinning a model id — admins can repoint it (issue #96)."""
        self._wire_tables(mock_dynamodb)
        mock_converse.return_value = self.HTML

        from jobs.document_generator.handler import lambda_handler
        from shared.model_config import surface_default
        lambda_handler(self._prototype_event(sample_job_event), lambda_context)

        assert mock_converse.call_args.kwargs['surface'] == 'prototype'
        assert 'model_id' not in mock_converse.call_args.kwargs
        # The surface's Automatic default remains the flagship Opus — now Opus 5.
        assert surface_default('prototype') == 'global.anthropic.claude-opus-5'

    def test_build_prototype_passes_brand_and_language(
        self, mock_dynamodb, mock_jobs_table, mock_converse, mock_s3, sample_job_event, lambda_context
    ):
        self._wire_tables(mock_dynamodb)
        mock_converse.return_value = self.HTML

        from jobs.document_generator.handler import lambda_handler
        lambda_handler(
            self._prototype_event(sample_job_event, brand='UNNI', response_language='ko'),
            lambda_context,
        )

        prompt = mock_converse.call_args.kwargs['prompt']
        assert 'UNNI' in prompt
        assert 'Korean' in prompt  # ko → Korean UI-text hint

    def test_build_prototype_feedback_revision_reads_prior_html_from_s3(
        self, mock_dynamodb, mock_jobs_table, mock_converse, mock_s3, sample_job_event, lambda_context
    ):
        """Feedback + base_prototype_id → prior HTML is read from S3 (new-style
        prototype with `prototype_url`, not `content`), fed into the prompt,
        and item records lineage.
        """
        mock_dynamodb['table'].query.return_value = {
            'Items': [{'document_id': 'prd_1', 'content': 'PRD body', 'created_at': '2026-01-01'}],
        }
        prior = '<!DOCTYPE html><html><body>OLD user-facing screens</body></html>'

        def get_item(Key=None, **kwargs):
            sk = (Key or {}).get('sk', '')
            if sk == 'META':
                return {'Item': {'name': 'My Project'}}
            if sk.startswith('PROTOTYPE#'):
                # New-style item: prototype_url present, no inline `content`.
                return {
                    'Item': {
                        'document_id': 'prototype_20260101000000',
                        'prototype_url': (
                            'https://cdn.example.com/prototypes/'
                            'proj_20250101120000/prototype_20260101000000.html'
                        ),
                    },
                }
            if sk == 'PRD#prd_1':
                # The newest-of-type read ranks over a projection, then fetches the
                # winner by key — so the double must answer that keyed read too.
                return {'Item': {'document_id': 'prd_1', 'content': 'PRD body', 'created_at': '2026-01-01'}}
            return {}
        mock_dynamodb['table'].get_item.side_effect = get_item

        mock_body = MagicMock()
        mock_body.read.return_value = prior.encode('utf-8')
        mock_s3.get_object.return_value = {'Body': mock_body}
        mock_converse.return_value = self.HTML

        from jobs.document_generator.handler import lambda_handler
        lambda_handler(
            self._prototype_event(
                sample_job_event,
                feedback='Switch to the admin perspective',
                base_prototype_id='prototype_20260101000000',
            ),
            lambda_context,
        )

        mock_s3.get_object.assert_called_once()
        assert mock_s3.get_object.call_args.kwargs['Key'] == 'prototypes/proj_20250101120000/prototype_20260101000000.html'
        prompt = mock_converse.call_args.kwargs['prompt']
        assert 'Switch to the admin perspective' in prompt  # feedback is in the prompt
        assert 'OLD user-facing screens' in prompt          # prior HTML included for revision
        assert 'PRD body' in prompt                          # PRD still honored
        put_item = mock_dynamodb['table'].put_item.call_args.kwargs['Item']
        assert put_item['revised_from_id'] == 'prototype_20260101000000'
        assert put_item['revision_feedback'] == 'Switch to the admin perspective'

    def test_build_prototype_feedback_revision_falls_back_to_legacy_content(
        self, mock_dynamodb, mock_jobs_table, mock_converse, mock_s3, sample_job_event, lambda_context
    ):
        """A pre-migration prototype (no `prototype_url`, has inline `content`)
        still works as a revision base — the regen path falls back to reading
        `content` directly instead of hitting S3.
        """
        mock_dynamodb['table'].query.return_value = {
            'Items': [{'document_id': 'prd_1', 'content': 'PRD body', 'created_at': '2026-01-01'}],
        }
        prior = '<!DOCTYPE html><html><body>LEGACY prior prototype</body></html>'

        def get_item(Key=None, **kwargs):
            sk = (Key or {}).get('sk', '')
            if sk == 'META':
                return {'Item': {'name': 'My Project'}}
            if sk.startswith('PROTOTYPE#'):
                return {'Item': {'content': prior}}  # legacy shape, no prototype_url
            if sk == 'PRD#prd_1':
                # See the sibling test: the winner is fetched by key after ranking.
                return {'Item': {'document_id': 'prd_1', 'content': 'PRD body', 'created_at': '2026-01-01'}}
            return {}
        mock_dynamodb['table'].get_item.side_effect = get_item
        mock_converse.return_value = self.HTML

        from jobs.document_generator.handler import lambda_handler
        lambda_handler(
            self._prototype_event(
                sample_job_event,
                feedback='Switch to the admin perspective',
                base_prototype_id='prototype_legacy_1',
            ),
            lambda_context,
        )

        mock_s3.get_object.assert_not_called()
        prompt = mock_converse.call_args.kwargs['prompt']
        assert 'LEGACY prior prototype' in prompt

    def test_build_prototype_fails_without_source_documents(
        self, mock_dynamodb, mock_jobs_table, mock_converse, mock_s3, sample_job_event, lambda_context
    ):
        # No PRD/PRFAQ found → query returns empty.
        mock_dynamodb['table'].query.return_value = {'Items': []}
        mock_dynamodb['table'].get_item.return_value = {'Item': {'name': 'Empty'}}

        from jobs.document_generator.handler import lambda_handler
        from shared.exceptions import ServiceError

        with pytest.raises(ServiceError, match="Document generation failed"):
            lambda_handler(self._prototype_event(sample_job_event), lambda_context)

        mock_converse.assert_not_called()

    def test_build_prototype_fails_when_model_returns_no_html(
        self, mock_dynamodb, mock_jobs_table, mock_converse, mock_s3, sample_job_event, lambda_context
    ):
        self._wire_tables(mock_dynamodb)
        mock_converse.return_value = 'I cannot build that.'  # no HTML doc

        from jobs.document_generator.handler import lambda_handler
        from shared.exceptions import ServiceError

        with pytest.raises(ServiceError, match="Document generation failed"):
            lambda_handler(self._prototype_event(sample_job_event), lambda_context)

        # Should fail before ever attempting the S3 write.
        mock_s3.put_object.assert_not_called()


class TestPrototypeVersionReplayAndStorage:
    """Regression contracts at the prototype allocator/S3 boundary."""

    HTML = '<!DOCTYPE html><html><body><h1>Winner</h1></body></html>'

    @staticmethod
    def _event(sample_job_event, **config):
        return {
            **sample_job_event,
            'doc_config': {
                'doc_type': 'build_prototype',
                'title': 'Test Prototype',
                **config,
            },
        }

    @staticmethod
    def _wire_source(mock_dynamodb):
        mock_dynamodb['table'].query.return_value = {
            'Items': [
                {
                    'document_id': 'prd_1',
                    'content': 'PRD body',
                    'created_at': '2026-01-01',
                },
            ],
        }
        mock_dynamodb['table'].get_item.return_value = {
            'Item': {'name': 'My Project'},
        }

    def test_completed_replay_returns_before_sources_bedrock_or_s3(
        self, mock_dynamodb, mock_jobs_table, mock_converse, mock_s3,
        sample_job_event, lambda_context,
    ):
        from unittest.mock import patch

        from jobs.document_generator import handler

        existing = {
            'document_id': 'prototype_existing',
            'title': 'Test Prototype (v1)',
        }
        with patch.object(
            handler,
            'get_versioned_document_by_allocation',
            return_value=existing,
        ) as lookup:
            result = handler.lambda_handler(
                self._event(sample_job_event), lambda_context,
            )

        assert result == {'success': True, **existing}
        lookup.assert_called_once_with(
            mock_dynamodb['table'],
            sample_job_event['project_id'],
            'prototype',
            sample_job_event['job_id'],
        )
        mock_dynamodb['table'].query.assert_not_called()
        mock_dynamodb['table'].get_item.assert_not_called()
        mock_converse.assert_not_called()
        mock_s3.put_object.assert_not_called()
        mock_s3.get_object.assert_not_called()
        mock_s3.head_object.assert_not_called()
        assert mock_dynamodb['transactions'] == []

    def test_persists_deterministic_s3_identity_in_the_four_item_transaction(
        self, mock_dynamodb, mock_jobs_table, mock_converse, mock_s3,
        sample_job_event, lambda_context,
    ):
        from shared.document_versions import versioned_document_id

        from jobs.document_generator.handler import lambda_handler

        self._wire_source(mock_dynamodb)
        mock_converse.return_value = self.HTML
        mock_s3.put_object.return_value = {
            'ETag': '"winning-etag"',
            'VersionId': 'winning-version',
        }

        result = lambda_handler(self._event(sample_job_event), lambda_context)

        expected_id = versioned_document_id(
            sample_job_event['project_id'],
            'prototype',
            sample_job_event['job_id'],
        )
        expected_key = (
            f"prototypes/{sample_job_event['project_id']}/{expected_id}.html"
        )
        assert result['document_id'] == expected_id
        assert mock_s3.put_object.call_args.kwargs == {
            'Bucket': 'test-raw-data-bucket',
            'Key': expected_key,
            'Body': self.HTML.encode('utf-8'),
            'ContentType': 'text/html; charset=utf-8',
            'IfNoneMatch': '*',
        }

        assert len(mock_dynamodb['transactions']) == 1
        transaction = mock_dynamodb['transactions'][0]
        assert len(transaction) == 4
        assert set(transaction[0]) <= {'Put', 'Update'}
        allocation = transaction[1]['Put']['Item']
        document = transaction[2]['Put']['Item']
        assert allocation['sk'].startswith('ALLOCATION#PROTOTYPE#')
        assert allocation['document_id'] == expected_id
        assert allocation['document_sk'] == f'PROTOTYPE#{expected_id}'
        assert document['sk'] == f'PROTOTYPE#{expected_id}'
        assert document['prototype_etag'] == '"winning-etag"'
        assert document['prototype_version_id'] == 'winning-version'
        assert transaction[3]['Update']['Key'] == {
            'pk': f"PROJECT#{sample_job_event['project_id']}",
            'sk': 'META',
        }

    @pytest.mark.parametrize(
        'error_code',
        ['PreconditionFailed', 'ConditionalRequestConflict'],
    )
    def test_conditional_s3_conflict_heads_and_persists_the_winner(
        self, mock_dynamodb, mock_jobs_table, mock_converse, mock_s3,
        sample_job_event, lambda_context, error_code,
    ):
        from botocore.exceptions import ClientError
        from shared.document_versions import versioned_document_id

        from jobs.document_generator.handler import lambda_handler

        self._wire_source(mock_dynamodb)
        mock_converse.return_value = self.HTML
        mock_s3.put_object.side_effect = ClientError(
            {
                'Error': {
                    'Code': error_code,
                    'Message': 'the deterministic object already exists',
                },
            },
            'PutObject',
        )
        mock_s3.head_object.return_value = {
            'ETag': '"existing-etag"',
            'VersionId': 'existing-version',
        }

        result = lambda_handler(self._event(sample_job_event), lambda_context)

        expected_id = versioned_document_id(
            sample_job_event['project_id'],
            'prototype',
            sample_job_event['job_id'],
        )
        expected_object = {
            'Bucket': 'test-raw-data-bucket',
            'Key': (
                f"prototypes/{sample_job_event['project_id']}/{expected_id}.html"
            ),
        }
        assert result['document_id'] == expected_id
        mock_s3.head_object.assert_called_once_with(**expected_object)
        document = mock_dynamodb['transactions'][0][2]['Put']['Item']
        assert document['prototype_etag'] == '"existing-etag"'
        assert document['prototype_version_id'] == 'existing-version'

    def test_missing_conflict_winner_identity_fails_before_dynamodb(
        self, mock_dynamodb, mock_s3,
    ):
        from botocore.exceptions import ClientError

        from jobs.document_generator.handler import _put_prototype_html

        mock_s3.put_object.side_effect = ClientError(
            {
                'Error': {
                    'Code': 'PreconditionFailed',
                    'Message': 'the deterministic object already exists',
                },
            },
            'PutObject',
        )
        mock_s3.head_object.return_value = {'VersionId': 'version-without-etag'}

        with pytest.raises(
            RuntimeError,
            match='S3 did not identify the winning prototype object',
        ):
            _put_prototype_html('project-1', 'prototype-1', self.HTML)

        mock_s3.head_object.assert_called_once_with(
            Bucket='test-raw-data-bucket',
            Key='prototypes/project-1/prototype-1.html',
        )
        assert mock_dynamodb['transactions'] == []

    def test_revision_reads_current_s3_only_base_without_a_persisted_url(
        self, mock_dynamodb, mock_jobs_table, mock_converse, mock_s3,
        sample_job_event, lambda_context,
    ):
        from jobs.document_generator.handler import lambda_handler

        prior = '<!DOCTYPE html><html><body>S3-ONLY BASE</body></html>'
        mock_dynamodb['table'].query.return_value = {
            'Items': [
                {
                    'document_id': 'prd_1',
                    'content': 'PRD body',
                    'created_at': '2026-01-01',
                },
            ],
        }

        def get_item(Key=None, **kwargs):
            sk = (Key or {}).get('sk', '')
            if sk == 'META':
                return {'Item': {'name': 'My Project'}}
            if sk == 'PROTOTYPE#prototype_s3_only':
                return {
                    'Item': {
                        'document_id': 'prototype_s3_only',
                        'prototype_format': 'html',
                        'prototype_etag': '"base-etag"',
                    },
                }
            if sk == 'PRD#prd_1':
                return {
                    'Item': {
                        'document_id': 'prd_1',
                        'content': 'PRD body',
                        'created_at': '2026-01-01',
                    },
                }
            return {}

        mock_dynamodb['table'].get_item.side_effect = get_item
        body = MagicMock()
        body.read.return_value = prior.encode('utf-8')
        mock_s3.get_object.return_value = {'Body': body}
        mock_converse.return_value = self.HTML

        lambda_handler(
            self._event(
                sample_job_event,
                feedback='Revise the existing flow',
                base_prototype_id='prototype_s3_only',
            ),
            lambda_context,
        )

        mock_s3.get_object.assert_called_once_with(
            Bucket='test-raw-data-bucket',
            Key=(
                'prototypes/proj_20250101120000/'
                'prototype_s3_only.html'
            ),
        )
        assert 'S3-ONLY BASE' in mock_converse.call_args.kwargs['prompt']
        document = mock_dynamodb['transactions'][0][2]['Put']['Item']
        assert document['revised_from_id'] == 'prototype_s3_only'
        assert 'prototype_url' not in document


@pytest.mark.parametrize('document_type', ['prd', 'prfaq'])
def test_generated_document_replay_returns_before_context_or_model_work(
    document_type,
    mock_dynamodb,
    mock_jobs_table,
    mock_converse_chain,
    mock_s3,
    sample_job_event,
    lambda_context,
):
    from unittest.mock import patch

    from jobs.document_generator import handler

    existing = {
        'document_id': f'{document_type}_existing',
        'title': f'Launch {document_type.upper()} (v1)',
    }
    event = {
        **sample_job_event,
        'doc_config': {
            'doc_type': document_type,
            'title': f'Launch {document_type.upper()}',
        },
    }
    with patch.object(
        handler,
        'get_versioned_document_by_allocation',
        return_value=existing,
    ) as lookup:
        result = handler.lambda_handler(event, lambda_context)

    assert result == {'success': True, **existing}
    lookup.assert_called_once_with(
        mock_dynamodb['table'],
        sample_job_event['project_id'],
        document_type,
        sample_job_event['job_id'],
    )
    mock_dynamodb['table'].query.assert_not_called()
    mock_converse_chain.assert_not_called()
    mock_s3.get_object.assert_not_called()
    mock_s3.put_object.assert_not_called()
    assert mock_dynamodb['transactions'] == []


def test_execution_claim_stops_overlapping_direct_delivery_before_bedrock(
    mock_dynamodb,
    mock_jobs_table,
    mock_converse_chain,
    mock_prompt_steps,
    prd_generation_event,
    lambda_context,
):
    from unittest.mock import patch

    from jobs.document_generator.handler import lambda_handler

    with (
        patch(
            'shared.jobs.claim_job_execution',
            side_effect=[True, False],
        ) as claim,
        patch(
            'shared.jobs.recover_job_execution_claim',
            return_value=False,
        ) as recover,
    ):
        first = lambda_handler(prd_generation_event, lambda_context)
        duplicate = lambda_handler(prd_generation_event, lambda_context)

    assert first['success'] is True
    assert duplicate == {'success': True, 'skipped': True}
    assert claim.call_count == 2
    recover.assert_called_once_with(prd_generation_event, lambda_context)
    mock_converse_chain.assert_called_once()
