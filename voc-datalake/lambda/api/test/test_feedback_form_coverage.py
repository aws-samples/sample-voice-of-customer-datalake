"""
Additional tests for feedback_form_handler.py to reach 100% coverage.
Covers: get_widget_js, _get_fallback_widget_js, error paths for CRUD,
get_form_config_by_id, submit with metadata, get_form_iframe,
_get_form_source_pk, get_form_submissions, get_form_stats.
"""
import json
import pytest
from unittest.mock import patch, MagicMock
from datetime import datetime, timezone


class TestGetWidgetJs:

    def test_returns_cached_value(self):
        import feedback_form_handler as fh
        fh._widget_js_cache = 'cached_js'
        try:
            result = fh.get_widget_js()
            assert result == 'cached_js'
        finally:
            fh._widget_js_cache = None

    def test_loads_from_file(self, tmp_path):
        import feedback_form_handler as fh
        fh._widget_js_cache = None
        static_dir = tmp_path / 'static'
        static_dir.mkdir()
        js_file = static_dir / 'feedback-widget.js'
        js_file.write_text('file_js_content')
        with patch.object(fh.Path, '__new__', return_value=tmp_path):
            # Directly test by setting cache
            fh._widget_js_cache = None
            # Simulate the path resolution
            from pathlib import Path
            original_path = Path(fh.__file__).parent / 'static' / 'feedback-widget.js'
            with patch.object(Path, 'read_text', return_value='file_js_content'):
                result = fh.get_widget_js()
                assert result == 'file_js_content'
        fh._widget_js_cache = None

    def test_uses_fallback_on_file_not_found(self):
        import feedback_form_handler as fh
        fh._widget_js_cache = None
        from pathlib import Path
        with patch.object(Path, 'read_text', side_effect=FileNotFoundError()):
            result = fh.get_widget_js()
            assert 'VoCFeedbackForm' in result
        fh._widget_js_cache = None


class TestGetFallbackWidgetJs:

    def test_returns_minimal_js(self):
        from feedback_form_handler import _get_fallback_widget_js
        result = _get_fallback_widget_js()
        assert 'VoCFeedbackForm' in result
        assert 'init' in result


class TestCrudErrorPaths:

    @patch('feedback_form_handler.aggregates_table')
    def test_list_forms_error(self, mock_table, api_gateway_event, lambda_context):
        from feedback_form_handler import lambda_handler
        mock_table.query.side_effect = Exception('DDB error')
        event = api_gateway_event(method='GET', path='/feedback-forms')
        response = lambda_handler(event, lambda_context)
        assert response['statusCode'] == 500

    @patch('feedback_form_handler.aggregates_table')
    def test_create_form_error(self, mock_table, api_gateway_event, lambda_context):
        from feedback_form_handler import lambda_handler
        mock_table.put_item.side_effect = Exception('DDB error')
        event = api_gateway_event(method='POST', path='/feedback-forms', body={'name': 'F'})
        response = lambda_handler(event, lambda_context)
        assert response['statusCode'] == 500

    @patch('feedback_form_handler.aggregates_table')
    def test_get_form_error(self, mock_table, api_gateway_event, lambda_context):
        from feedback_form_handler import lambda_handler
        mock_table.get_item.side_effect = Exception('DDB error')
        event = api_gateway_event(method='GET', path='/feedback-forms/f1', path_params={'form_id': 'f1'})
        response = lambda_handler(event, lambda_context)
        assert response['statusCode'] == 500

    @patch('feedback_form_handler.aggregates_table')
    def test_update_form_error(self, mock_table, api_gateway_event, lambda_context):
        from feedback_form_handler import lambda_handler
        mock_table.update_item.side_effect = Exception('DDB error')
        event = api_gateway_event(method='PUT', path='/feedback-forms/f1',
                                   path_params={'form_id': 'f1'}, body={'name': 'X'})
        response = lambda_handler(event, lambda_context)
        assert response['statusCode'] == 500

    @patch('feedback_form_handler.aggregates_table')
    def test_delete_form_error(self, mock_table, api_gateway_event, lambda_context):
        from feedback_form_handler import lambda_handler
        mock_table.delete_item.side_effect = Exception('DDB error')
        event = api_gateway_event(method='DELETE', path='/feedback-forms/f1',
                                   path_params={'form_id': 'f1'})
        response = lambda_handler(event, lambda_context)
        assert response['statusCode'] == 500


class TestGetFormConfigById:

    @patch('feedback_form_handler.aggregates_table')
    def test_returns_config(self, mock_table, api_gateway_event, lambda_context):
        from feedback_form_handler import lambda_handler
        mock_table.get_item.return_value = {
            'Item': {'form_id': 'f1', 'name': 'Form', 'enabled': True}
        }
        event = api_gateway_event(method='GET', path='/feedback-forms/f1/config',
                                   path_params={'form_id': 'f1'})
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        assert body['success'] is True
        assert body['config']['form_id'] == 'f1'

    @patch('feedback_form_handler.aggregates_table')
    def test_returns_not_found(self, mock_table, api_gateway_event, lambda_context):
        from feedback_form_handler import lambda_handler
        mock_table.get_item.return_value = {}
        event = api_gateway_event(method='GET', path='/feedback-forms/f1/config',
                                   path_params={'form_id': 'f1'})
        response = lambda_handler(event, lambda_context)
        assert response['statusCode'] == 404

    @patch('feedback_form_handler.aggregates_table')
    def test_returns_error_on_exception(self, mock_table, api_gateway_event, lambda_context):
        from feedback_form_handler import lambda_handler
        mock_table.get_item.side_effect = Exception('fail')
        event = api_gateway_event(method='GET', path='/feedback-forms/f1/config',
                                   path_params={'form_id': 'f1'})
        response = lambda_handler(event, lambda_context)
        assert response['statusCode'] == 500


class TestSubmitWithMetadata:

    @patch('feedback_form_handler.PROCESSING_QUEUE_URL', 'https://sqs/q')
    @patch('feedback_form_handler.sqs')
    @patch('feedback_form_handler.aggregates_table')
    def test_submit_with_email_name_custom_fields(self, mock_table, mock_sqs,
                                                    api_gateway_event, lambda_context):
        from feedback_form_handler import lambda_handler
        mock_table.get_item.return_value = {
            'Item': {'form_id': 'f1', 'enabled': True, 'collect_email': True,
                     'collect_name': True, 'name': 'Form', 'category': '', 'subcategory': ''}
        }
        event = api_gateway_event(
            method='POST', path='/feedback-forms/f1/submit',
            path_params={'form_id': 'f1'},
            body={'text': 'Great!', 'email': 'user@test.com', 'name': 'User',
                  'custom_fields': {'field1': 'val1'}, 'page_url': 'https://example.com'}
        )
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        assert body['success'] is True
        msg = json.loads(mock_sqs.send_message.call_args.kwargs['MessageBody'])
        assert msg['metadata']['submitter_email'] == 'user@test.com'
        assert msg['metadata']['submitter_name'] == 'User'
        assert msg['metadata']['custom_fields'] == {'field1': 'val1'}

    @patch('feedback_form_handler.PROCESSING_QUEUE_URL', 'https://sqs/q')
    @patch('feedback_form_handler.sqs')
    @patch('feedback_form_handler.aggregates_table')
    def test_submit_sqs_error(self, mock_table, mock_sqs, api_gateway_event, lambda_context):
        from feedback_form_handler import lambda_handler
        mock_table.get_item.return_value = {
            'Item': {'form_id': 'f1', 'enabled': True, 'name': 'F'}
        }
        mock_sqs.send_message.side_effect = Exception('SQS fail')
        event = api_gateway_event(
            method='POST', path='/feedback-forms/f1/submit',
            path_params={'form_id': 'f1'},
            body={'text': 'Feedback'}
        )
        response = lambda_handler(event, lambda_context)
        assert response['statusCode'] == 500

    @patch('feedback_form_handler.sqs')
    @patch('feedback_form_handler.aggregates_table')
    def test_submit_form_fetch_error(self, mock_table, mock_sqs, api_gateway_event, lambda_context):
        from feedback_form_handler import lambda_handler
        mock_table.get_item.side_effect = Exception('DDB fail')
        event = api_gateway_event(
            method='POST', path='/feedback-forms/f1/submit',
            path_params={'form_id': 'f1'},
            body={'text': 'Feedback'}
        )
        response = lambda_handler(event, lambda_context)
        assert response['statusCode'] == 500


class TestGetFormIframe:

    @patch('feedback_form_handler.get_widget_js', return_value='// widget js')
    @patch('feedback_form_handler.aggregates_table')
    def test_returns_html(self, mock_table, mock_js, api_gateway_event, lambda_context):
        from feedback_form_handler import lambda_handler
        event = api_gateway_event(
            method='GET', path='/feedback-forms/f1/iframe',
            path_params={'form_id': 'f1'}
        )
        response = lambda_handler(event, lambda_context)
        assert response['statusCode'] == 200
        # Powertools uses multiValueHeaders for Response objects
        content_type = response.get('headers', {}).get('Content-Type', '') or \
            (response.get('multiValueHeaders', {}).get('Content-Type', [''])[0])
        assert 'text/html' in content_type
        assert 'voc-feedback-form' in response['body']
        assert 'f1' in response['body']


class TestGetFormSourcePk:

    @patch('feedback_form_handler.aggregates_table')
    @patch('feedback_form_handler.BRAND_NAME', 'TestBrand')
    def test_returns_brand_from_form(self, mock_table):
        from feedback_form_handler import _get_form_source_pk
        mock_table.get_item.return_value = {
            'Item': {'brand_name': 'FormBrand'}
        }
        result = _get_form_source_pk('f1')
        assert result == 'SOURCE#FormBrand'

    @patch('feedback_form_handler.aggregates_table')
    @patch('feedback_form_handler.BRAND_NAME', 'TestBrand')
    def test_falls_back_to_env_brand(self, mock_table):
        from feedback_form_handler import _get_form_source_pk
        mock_table.get_item.return_value = {'Item': {'brand_name': ''}}
        result = _get_form_source_pk('f1')
        assert result == 'SOURCE#TestBrand'

    @patch('feedback_form_handler.aggregates_table')
    @patch('feedback_form_handler.BRAND_NAME', '')
    def test_falls_back_to_feedback_form(self, mock_table):
        from feedback_form_handler import _get_form_source_pk
        mock_table.get_item.return_value = {}
        result = _get_form_source_pk('f1')
        assert result == 'SOURCE#feedback_form'

    @patch('feedback_form_handler.aggregates_table')
    @patch('feedback_form_handler.BRAND_NAME', '')
    def test_handles_exception(self, mock_table):
        from feedback_form_handler import _get_form_source_pk
        mock_table.get_item.side_effect = Exception('fail')
        result = _get_form_source_pk('f1')
        assert result == 'SOURCE#feedback_form'


class TestGetFormSubmissions:

    @patch('feedback_form_handler.feedback_table', None)
    @patch('feedback_form_handler.aggregates_table')
    def test_raises_when_no_feedback_table(self, mock_agg, api_gateway_event, lambda_context):
        from feedback_form_handler import lambda_handler
        event = api_gateway_event(method='GET', path='/feedback-forms/f1/submissions',
                                   path_params={'form_id': 'f1'})
        response = lambda_handler(event, lambda_context)
        assert response['statusCode'] == 500

    @patch('feedback_form_handler._get_form_source_pk', return_value='SOURCE#test')
    @patch('feedback_form_handler.feedback_table')
    @patch('feedback_form_handler.aggregates_table')
    def test_returns_submissions(self, mock_agg, mock_fb, mock_pk,
                                  api_gateway_event, lambda_context):
        from feedback_form_handler import lambda_handler
        mock_agg.get_item.return_value = {'Item': {'form_id': 'f1'}}
        mock_fb.query.return_value = {
            'Items': [
                {'feedback_id': 'fb1', 'original_text': 'Great', 'rating': 5,
                 'sentiment_label': 'positive', 'sentiment_score': 0.9,
                 'category': 'product', 'source_created_at': '2026-01-01',
                 'persona_name': 'Alice', 'source_channel': 'form_f1'},
                {'feedback_id': 'fb2', 'original_text': 'OK', 'rating': None,
                 'sentiment_label': 'neutral', 'sentiment_score': 0,
                 'category': 'other', 'source_created_at': '2026-01-02',
                 'source_channel': 'form_f1'},
            ]
        }
        event = api_gateway_event(method='GET', path='/feedback-forms/f1/submissions',
                                   path_params={'form_id': 'f1'})
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        assert body['success'] is True
        assert body['stats']['total_submissions'] == 2
        assert body['stats']['avg_rating'] == 5.0
        assert body['stats']['rating_count'] == 1

    @patch('feedback_form_handler._get_form_source_pk', return_value='SOURCE#test')
    @patch('feedback_form_handler.feedback_table')
    @patch('feedback_form_handler.aggregates_table')
    def test_form_not_found(self, mock_agg, mock_fb, mock_pk,
                             api_gateway_event, lambda_context):
        from feedback_form_handler import lambda_handler
        mock_agg.get_item.return_value = {}
        event = api_gateway_event(method='GET', path='/feedback-forms/f1/submissions',
                                   path_params={'form_id': 'f1'})
        response = lambda_handler(event, lambda_context)
        assert response['statusCode'] == 404

    @patch('feedback_form_handler._get_form_source_pk', return_value='SOURCE#test')
    @patch('feedback_form_handler.feedback_table')
    @patch('feedback_form_handler.aggregates_table')
    def test_submissions_query_error(self, mock_agg, mock_fb, mock_pk,
                                      api_gateway_event, lambda_context):
        from feedback_form_handler import lambda_handler
        mock_agg.get_item.return_value = {'Item': {'form_id': 'f1'}}
        mock_fb.query.side_effect = Exception('DDB fail')
        event = api_gateway_event(method='GET', path='/feedback-forms/f1/submissions',
                                   path_params={'form_id': 'f1'})
        response = lambda_handler(event, lambda_context)
        assert response['statusCode'] == 500

    @patch('feedback_form_handler._get_form_source_pk', return_value='SOURCE#test')
    @patch('feedback_form_handler.feedback_table')
    @patch('feedback_form_handler.aggregates_table')
    def test_form_check_error(self, mock_agg, mock_fb, mock_pk,
                               api_gateway_event, lambda_context):
        from feedback_form_handler import lambda_handler
        mock_agg.get_item.side_effect = Exception('DDB fail')
        event = api_gateway_event(method='GET', path='/feedback-forms/f1/submissions',
                                   path_params={'form_id': 'f1'})
        response = lambda_handler(event, lambda_context)
        assert response['statusCode'] == 500


class TestGetFormStats:

    @patch('feedback_form_handler.feedback_table', None)
    @patch('feedback_form_handler.aggregates_table')
    def test_returns_zero_when_no_table(self, mock_agg, api_gateway_event, lambda_context):
        from feedback_form_handler import lambda_handler
        event = api_gateway_event(method='GET', path='/feedback-forms/f1/stats',
                                   path_params={'form_id': 'f1'})
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        assert body['stats']['total_submissions'] == 0

    @patch('feedback_form_handler._get_form_source_pk', return_value='SOURCE#test')
    @patch('feedback_form_handler.feedback_table')
    @patch('feedback_form_handler.aggregates_table')
    def test_returns_stats(self, mock_agg, mock_fb, mock_pk,
                            api_gateway_event, lambda_context):
        from feedback_form_handler import lambda_handler
        mock_fb.query.return_value = {
            'Items': [
                {'feedback_id': 'fb1', 'rating': 4},
                {'feedback_id': 'fb2', 'rating': 5},
                {'feedback_id': 'fb3'},
            ]
        }
        event = api_gateway_event(method='GET', path='/feedback-forms/f1/stats',
                                   path_params={'form_id': 'f1'})
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        assert body['stats']['total_submissions'] == 3
        assert body['stats']['avg_rating'] == 4.5
        assert body['stats']['rating_count'] == 2

    @patch('feedback_form_handler._get_form_source_pk', return_value='SOURCE#test')
    @patch('feedback_form_handler.feedback_table')
    @patch('feedback_form_handler.aggregates_table')
    def test_stats_error_returns_zero(self, mock_agg, mock_fb, mock_pk,
                                       api_gateway_event, lambda_context):
        from feedback_form_handler import lambda_handler
        mock_fb.query.side_effect = Exception('fail')
        event = api_gateway_event(method='GET', path='/feedback-forms/f1/stats',
                                   path_params={'form_id': 'f1'})
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        assert body['stats']['total_submissions'] == 0
