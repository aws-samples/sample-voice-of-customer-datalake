"""
Tests for manual_import_processor.py - Async LLM parsing of pasted reviews.
"""
import datetime as dt
import json
from typing import ClassVar
from unittest.mock import MagicMock, patch

import pytest


class TestCapabilityAwareBedrockBody:
    """The raw invoke_model body must match the resolved model's capabilities.

    Regression for the Sonnet 5 default bump: an explicit `temperature` or
    `thinking` budget in the request body 400s on adaptive-thinking /
    temperature-restricted models. These tests fail if either field is
    reintroduced unconditionally or the model stops routing through the
    utility-surface picker.
    """

    JOB_ITEM: ClassVar[dict[str, dict[str, str]]] = {
        'Item': {
            'raw_text': 'Great product! 5 stars. - John',
            'source_origin': 'g2',
        }
    }
    BEDROCK_RESPONSE: ClassVar[dict[str, MagicMock]] = {
        'body': MagicMock(read=lambda: json.dumps({
            'content': [{'type': 'text', 'text': '{"reviews": [], "unparsed_sections": []}'}]
        }).encode())
    }

    def _invoke_and_capture_body(self, mock_table, mock_bedrock):
        mock_table.get_item.return_value = self.JOB_ITEM
        mock_bedrock.invoke_model.return_value = self.BEDROCK_RESPONSE

        from manual_import_processor import process_job
        process_job('job-123')

        kwargs = mock_bedrock.invoke_model.call_args.kwargs
        return kwargs, json.loads(kwargs['body'])

    @patch('manual_import_processor.get_active_model_id')
    @patch('manual_import_processor.bedrock')
    @patch('manual_import_processor.aggregates_table')
    def test_routes_model_through_utility_surface(self, mock_table, mock_bedrock, mock_resolve):
        """Model ID comes from get_active_model_id('utility'), not a hardcoded env."""
        mock_resolve.return_value = 'global.anthropic.claude-sonnet-5'

        kwargs, _ = self._invoke_and_capture_body(mock_table, mock_bedrock)

        mock_resolve.assert_called_once_with('utility')
        assert kwargs['modelId'] == 'global.anthropic.claude-sonnet-5'

    @patch('manual_import_processor.get_active_model_id')
    @patch('manual_import_processor.bedrock')
    @patch('manual_import_processor.aggregates_table')
    def test_adaptive_thinking_model_omits_thinking_and_temperature(
        self, mock_table, mock_bedrock, mock_resolve
    ):
        """Sonnet 5 (adaptive thinking always-on) rejects both params."""
        mock_resolve.return_value = 'global.anthropic.claude-sonnet-5'

        _, body = self._invoke_and_capture_body(mock_table, mock_bedrock)

        assert 'thinking' not in body
        assert 'temperature' not in body

    @patch('manual_import_processor.get_active_model_id')
    @patch('manual_import_processor.bedrock')
    @patch('manual_import_processor.aggregates_table')
    def test_budgeted_thinking_model_keeps_thinking_but_omits_temperature(
        self, mock_table, mock_bedrock, mock_resolve
    ):
        """Haiku 4.5 accepts an explicit thinking budget; temperature stays
        omitted everywhere (defaults to 1, the only value thinking accepts)."""
        mock_resolve.return_value = 'global.anthropic.claude-haiku-4-5-20251001-v1:0'

        _, body = self._invoke_and_capture_body(mock_table, mock_bedrock)

        assert body['thinking'] == {'type': 'enabled', 'budget_tokens': 5000}
        assert 'temperature' not in body


class TestMissingDatesDefaultToTheImportDate:
    """QA s1 F2: the parse left every date empty, and confirm refuses a review
    without one, so a whole paste could not be imported until each date was typed.
    A review with no usable date now carries the job's import day and says so."""

    JOB_CREATED_AT = '2026-10-05T23:58:01.123456+00:00'

    def _parse(self, mock_table, mock_bedrock, reviews: list[dict]) -> tuple[list[dict], str]:
        mock_table.get_item.return_value = {'Item': {
            'raw_text': 'pasted', 'source_origin': 'g2', 'created_at': self.JOB_CREATED_AT,
        }}
        mock_bedrock.invoke_model.return_value = {'body': MagicMock(read=lambda: json.dumps({
            'content': [{'type': 'text', 'text': json.dumps({'reviews': reviews, 'unparsed_sections': []})}],
        }).encode())}

        from manual_import_processor import process_job
        process_job('job-1')

        stored = mock_table.update_item.call_args.kwargs['ExpressionAttributeValues'][':reviews']
        prompt = json.loads(mock_bedrock.invoke_model.call_args.kwargs['body'])['messages'][0]['content']
        return stored, prompt

    @pytest.mark.parametrize('missing', [None, '', 'a while ago', 'Jan 5', '2026-13-45'])
    @patch('manual_import_processor.bedrock')
    @patch('manual_import_processor.aggregates_table')
    def test_a_review_without_a_usable_date_gets_the_import_date_and_is_flagged(self, mock_table, mock_bedrock, missing):
        stored, _ = self._parse(mock_table, mock_bedrock, [{'text': 'ok', 'date': missing}])

        assert stored[0]['date'] == '2026-10-05'
        assert stored[0]['date_defaulted'] is True

    @pytest.mark.parametrize(('given', 'kept'), [
        ('2025-03-04', '2025-03-04'),
        ('2025-03-04T10:00:00Z', '2025-03-04'),
    ])
    @patch('manual_import_processor.bedrock')
    @patch('manual_import_processor.aggregates_table')
    def test_a_date_from_the_text_is_kept_and_not_flagged(self, mock_table, mock_bedrock, given, kept):
        stored, _ = self._parse(mock_table, mock_bedrock, [{'text': 'ok', 'date': given}])

        assert stored[0]['date'] == kept
        assert stored[0]['date_defaulted'] is False

    @patch('manual_import_processor.bedrock')
    @patch('manual_import_processor.aggregates_table')
    def test_a_review_with_no_date_key_at_all_is_defaulted(self, mock_table, mock_bedrock):
        stored, _ = self._parse(mock_table, mock_bedrock, [{'text': 'ok'}])

        assert (stored[0]['date'], stored[0]['date_defaulted']) == ('2026-10-05', True)

    @patch('manual_import_processor.bedrock')
    @patch('manual_import_processor.aggregates_table')
    def test_the_prompt_names_the_import_date_for_relative_and_missing_dates(self, mock_table, mock_bedrock):
        _, prompt = self._parse(mock_table, mock_bedrock, [])

        assert 'The import date is 2026-10-05.' in prompt

    def test_the_import_date_is_the_jobs_utc_day_or_today(self):
        from manual_import_processor import import_date_of

        assert import_date_of({'created_at': '2026-10-05T23:30:00-02:00'}) == '2026-10-06'
        with patch('manual_import_processor.datetime', wraps=dt.datetime) as clock:
            clock.now.return_value = dt.datetime(2026, 1, 2, tzinfo=dt.UTC)
            assert import_date_of({}) == '2026-01-02'
            assert import_date_of({'created_at': 'not a date'}) == '2026-01-02'
