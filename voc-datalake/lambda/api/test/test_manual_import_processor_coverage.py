"""
Additional coverage tests for manual_import_processor.py.
Covers: parse_llm_response edge cases, process_job branches, rating sanitization.
"""
import json
import pytest
from unittest.mock import patch, MagicMock


class TestParseLlmResponseEdgeCases:
    """Cover parse_llm_response edge cases (lines 72-73, 79-82)."""

    def test_extracts_json_from_markdown_code_block(self):
        from manual_import_processor import parse_llm_response
        response = '```json\n{"reviews": [{"text": "Good"}], "unparsed_sections": []}\n```'
        result = parse_llm_response(response)
        assert len(result['reviews']) == 1

    def test_extracts_json_with_reviews_key_pattern(self):
        from manual_import_processor import parse_llm_response
        response = 'Here is the result: {"reviews": [{"text": "Nice"}], "unparsed_sections": []}'
        result = parse_llm_response(response)
        assert len(result['reviews']) == 1

    def test_returns_unparsed_when_no_json_found(self):
        from manual_import_processor import parse_llm_response
        response = 'This is not JSON at all'
        result = parse_llm_response(response)
        assert result['reviews'] == []
        assert 'This is not JSON at all' in result['unparsed_sections']

    def test_handles_invalid_json_in_code_block(self):
        from manual_import_processor import parse_llm_response
        response = '```json\n{invalid json}\n```'
        result = parse_llm_response(response)
        # Falls through to next pattern or returns unparsed
        assert isinstance(result, dict)


class TestProcessJobBranches:
    """Cover process_job edge cases (lines 157, 178-181, 210-211)."""

    @patch('manual_import_processor.aggregates_table', None)
    def test_returns_early_when_no_table(self):
        from manual_import_processor import process_job
        # Should not raise
        process_job('job-123')

    @patch('manual_import_processor.aggregates_table')
    def test_returns_early_when_job_not_found(self, mock_table):
        from manual_import_processor import process_job
        mock_table.get_item.return_value = {}
        process_job('job-123')
        # Should not call update_item since job not found
        mock_table.update_item.assert_not_called()

    @patch('manual_import_processor.aggregates_table')
    def test_marks_failed_when_no_raw_text(self, mock_table):
        from manual_import_processor import process_job
        mock_table.get_item.return_value = {
            'Item': {'raw_text': '', 'source_origin': 'g2'}
        }
        process_job('job-123')
        mock_table.update_item.assert_called_once()
        call_kwargs = mock_table.update_item.call_args.kwargs
        assert call_kwargs['ExpressionAttributeValues'][':status'] == 'failed'

    @patch('manual_import_processor.bedrock')
    @patch('manual_import_processor.aggregates_table')
    def test_successful_processing(self, mock_table, mock_bedrock):
        from manual_import_processor import process_job
        mock_table.get_item.return_value = {
            'Item': {'raw_text': 'Great product! 5 stars.', 'source_origin': 'g2'}
        }
        mock_response_body = MagicMock()
        mock_response_body.read.return_value = json.dumps({
            'content': [{'type': 'text', 'text': json.dumps({
                'reviews': [{'text': 'Great product!', 'rating': 5, 'author': 'John', 'date': '2026-01-01', 'title': 'Good'}],
                'unparsed_sections': []
            })}]
        }).encode()
        mock_bedrock.invoke_model.return_value = {'body': mock_response_body}

        process_job('job-123')

        # Should update with completed status
        update_calls = mock_table.update_item.call_args_list
        last_call = update_calls[-1]
        assert last_call.kwargs['ExpressionAttributeValues'][':status'] == 'completed'

    @patch('manual_import_processor.bedrock')
    @patch('manual_import_processor.aggregates_table')
    def test_handles_bedrock_failure(self, mock_table, mock_bedrock):
        from manual_import_processor import process_job
        mock_table.get_item.return_value = {
            'Item': {'raw_text': 'Some text', 'source_origin': 'g2'}
        }
        mock_bedrock.invoke_model.side_effect = Exception('Bedrock error')

        process_job('job-123')

        # Should update with failed status
        update_calls = mock_table.update_item.call_args_list
        last_call = update_calls[-1]
        assert last_call.kwargs['ExpressionAttributeValues'][':status'] == 'failed'

    @patch('manual_import_processor.bedrock')
    @patch('manual_import_processor.aggregates_table')
    def test_handles_no_text_in_response(self, mock_table, mock_bedrock):
        from manual_import_processor import process_job
        mock_table.get_item.return_value = {
            'Item': {'raw_text': 'Some text', 'source_origin': 'g2'}
        }
        mock_response_body = MagicMock()
        mock_response_body.read.return_value = json.dumps({
            'content': [{'type': 'thinking', 'text': 'thinking...'}]
        }).encode()
        mock_bedrock.invoke_model.return_value = {'body': mock_response_body}

        process_job('job-123')

        # Should fail with "No text response from Bedrock"
        update_calls = mock_table.update_item.call_args_list
        last_call = update_calls[-1]
        assert last_call.kwargs['ExpressionAttributeValues'][':status'] == 'failed'

    @patch('manual_import_processor.bedrock')
    @patch('manual_import_processor.aggregates_table')
    def test_sanitizes_rating_to_int(self, mock_table, mock_bedrock):
        from manual_import_processor import process_job
        mock_table.get_item.return_value = {
            'Item': {'raw_text': 'Review text', 'source_origin': 'g2'}
        }
        mock_response_body = MagicMock()
        mock_response_body.read.return_value = json.dumps({
            'content': [{'type': 'text', 'text': json.dumps({
                'reviews': [
                    {'text': 'Good', 'rating': 4.5, 'author': None, 'date': None, 'title': None},
                    {'text': 'Bad', 'rating': 'invalid', 'author': None, 'date': None, 'title': None},
                    {'text': 'Ok', 'rating': None, 'author': None, 'date': None, 'title': None},
                ],
                'unparsed_sections': []
            })}]
        }).encode()
        mock_bedrock.invoke_model.return_value = {'body': mock_response_body}

        process_job('job-123')

        update_calls = mock_table.update_item.call_args_list
        last_call = update_calls[-1]
        reviews = last_call.kwargs['ExpressionAttributeValues'][':reviews']
        assert reviews[0]['rating'] == 4  # 4.5 rounded to 4 (Python rounds to even)
        assert reviews[1]['rating'] is None  # 'invalid' -> None
        assert reviews[2]['rating'] is None  # None stays None
