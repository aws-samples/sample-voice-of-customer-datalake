"""
Tests for feedback_form_handler.py - coverage for uncovered endpoints:
submissions, stats, iframe, widget, form config, and error paths.
"""
import json
from unittest.mock import patch, MagicMock


class TestGetFormSubmissions:
    """Tests for GET /feedback-forms/<form_id>/submissions endpoint."""

    @patch('feedback_form_handler.feedback_table')
    @patch('feedback_form_handler.aggregates_table')
    def test_returns_submissions_with_computed_stats(
        self, mock_agg, mock_fb, api_gateway_event, lambda_context
    ):
        """Returns submissions list with correctly computed average rating."""
        mock_agg.get_item.return_value = {
            'Item': {'form_id': 'form-1', 'name': 'Test Form', 'enabled': True}
        }
        mock_fb.query.return_value = {
            'Items': [
                {'feedback_id': 'fb-1', 'original_text': 'Great!', 'rating': 5,
                 'sentiment_label': 'positive', 'sentiment_score': 0.9,
                 'category': 'product', 'source_created_at': '2026-01-01', 'source_channel': 'form_form-1'},
                {'feedback_id': 'fb-2', 'original_text': 'OK', 'rating': 3,
                 'sentiment_label': 'neutral', 'sentiment_score': 0.1,
                 'category': 'service', 'source_created_at': '2026-01-02', 'source_channel': 'form_form-1'},
            ]
        }

        from feedback_form_handler import lambda_handler

        event = api_gateway_event(
            method='GET',
            path='/feedback-forms/form-1/submissions',
            path_params={'form_id': 'form-1'}
        )

        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])

        assert response['statusCode'] == 200
        assert body['success'] is True
        assert body['form_id'] == 'form-1'
        # (5 + 3) / 2 = 4.0
        assert body['stats']['total_submissions'] == 2
        assert body['stats']['avg_rating'] == 4.0
        assert body['stats']['rating_count'] == 2
        # Verify submission fields are shaped correctly
        assert body['submissions'][0]['feedback_id'] == 'fb-1'
        assert body['submissions'][0]['rating'] == 5.0
        assert body['submissions'][1]['feedback_id'] == 'fb-2'

    @patch('feedback_form_handler.feedback_table')
    @patch('feedback_form_handler.aggregates_table')
    def test_returns_404_with_error_when_form_not_found(
        self, mock_agg, mock_fb, api_gateway_event, lambda_context
    ):
        """Returns 404 with error message when form doesn't exist."""
        mock_agg.get_item.return_value = {}

        from feedback_form_handler import lambda_handler

        event = api_gateway_event(
            method='GET',
            path='/feedback-forms/nonexistent/submissions',
            path_params={'form_id': 'nonexistent'}
        )

        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])

        assert response['statusCode'] == 404
        assert 'error' in body
        assert 'not found' in body['error'].lower()


class TestGetFormStats:
    """Tests for GET /feedback-forms/<form_id>/stats endpoint."""

    @patch('feedback_form_handler.feedback_table')
    @patch('feedback_form_handler.aggregates_table')
    def test_computes_stats_including_items_without_rating(
        self, mock_agg, mock_fb, api_gateway_event, lambda_context
    ):
        """Counts all submissions but only rated ones for avg_rating."""
        mock_agg.get_item.return_value = {
            'Item': {'form_id': 'form-1', 'name': 'Test'}
        }
        mock_fb.query.return_value = {
            'Items': [
                {'feedback_id': 'fb-1', 'rating': 4},
                {'feedback_id': 'fb-2', 'rating': 5},
                {'feedback_id': 'fb-3'},  # no rating
            ]
        }

        from feedback_form_handler import lambda_handler

        event = api_gateway_event(
            method='GET',
            path='/feedback-forms/form-1/stats',
            path_params={'form_id': 'form-1'}
        )

        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])

        assert response['statusCode'] == 200
        assert body['form_id'] == 'form-1'
        # 3 total submissions, but only 2 have ratings
        assert body['stats']['total_submissions'] == 3
        assert body['stats']['rating_count'] == 2
        # (4 + 5) / 2 = 4.5
        assert body['stats']['avg_rating'] == 4.5

    @patch('feedback_form_handler.feedback_table')
    @patch('feedback_form_handler.aggregates_table')
    def test_returns_null_avg_rating_when_no_ratings(
        self, mock_agg, mock_fb, api_gateway_event, lambda_context
    ):
        """Returns None for avg_rating when no submissions have ratings."""
        mock_agg.get_item.return_value = {'Item': {'form_id': 'form-1'}}
        mock_fb.query.return_value = {
            'Items': [{'feedback_id': 'fb-1'}]  # no rating field
        }

        from feedback_form_handler import lambda_handler

        event = api_gateway_event(
            method='GET',
            path='/feedback-forms/form-1/stats',
            path_params={'form_id': 'form-1'}
        )

        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])

        assert body['stats']['total_submissions'] == 1
        assert body['stats']['avg_rating'] is None
        assert body['stats']['rating_count'] == 0

    @patch('feedback_form_handler.feedback_table')
    @patch('feedback_form_handler.aggregates_table')
    def test_returns_zero_stats_on_query_error(
        self, mock_agg, mock_fb, api_gateway_event, lambda_context
    ):
        """Degrades gracefully to zero stats when DynamoDB query fails."""
        mock_agg.get_item.return_value = {'Item': {'form_id': 'form-1'}}
        mock_fb.query.side_effect = Exception('DynamoDB error')

        from feedback_form_handler import lambda_handler

        event = api_gateway_event(
            method='GET',
            path='/feedback-forms/form-1/stats',
            path_params={'form_id': 'form-1'}
        )

        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])

        assert response['statusCode'] == 200
        assert body['stats']['total_submissions'] == 0
        assert body['stats']['avg_rating'] is None


class TestGetFormConfigById:
    """Tests for GET /feedback-forms/<form_id>/config endpoint (public)."""

    @patch('feedback_form_handler.aggregates_table')
    def test_returns_form_config_with_all_fields(
        self, mock_table, api_gateway_event, lambda_context
    ):
        """Returns form config including form_id and name for widget embedding."""
        mock_table.get_item.return_value = {
            'Item': {
                'form_id': 'form-1', 'name': 'Widget Form', 'enabled': True,
                'title': 'Give Feedback', 'rating_type': 'stars'
            }
        }

        from feedback_form_handler import lambda_handler

        event = api_gateway_event(
            method='GET',
            path='/feedback-forms/form-1/config',
            path_params={'form_id': 'form-1'}
        )

        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])

        assert response['statusCode'] == 200
        assert body['success'] is True
        assert body['config']['form_id'] == 'form-1'
        assert body['config']['name'] == 'Widget Form'
        assert body['config']['enabled'] is True

    @patch('feedback_form_handler.aggregates_table')
    def test_returns_404_with_error_for_missing_form(
        self, mock_table, api_gateway_event, lambda_context
    ):
        """Returns 404 with error message when form doesn't exist."""
        mock_table.get_item.return_value = {}

        from feedback_form_handler import lambda_handler

        event = api_gateway_event(
            method='GET',
            path='/feedback-forms/missing/config',
            path_params={'form_id': 'missing'}
        )

        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])

        assert response['statusCode'] == 404
        assert 'error' in body
        assert 'not found' in body['error'].lower()


class TestGetFormIframe:
    """Tests for GET /feedback-forms/<form_id>/iframe endpoint."""

    @patch('feedback_form_handler.aggregates_table')
    def test_returns_html_with_form_id_in_widget_init(
        self, mock_table, api_gateway_event, lambda_context
    ):
        """Returns valid HTML page with VoCFeedbackForm.init configured for the form ID."""
        from feedback_form_handler import lambda_handler

        event = api_gateway_event(
            method='GET',
            path='/feedback-forms/form-1/iframe',
            path_params={'form_id': 'form-1'}
        )

        response = lambda_handler(event, lambda_context)

        assert response['statusCode'] == 200

        # Content-Type may be in headers or multiValueHeaders depending on resolver
        content_type = response.get('headers', {}).get('Content-Type', '')
        if not content_type:
            mvh = response.get('multiValueHeaders', {})
            content_type = mvh.get('Content-Type', [''])[0] if 'Content-Type' in mvh else ''
        assert 'text/html' in content_type

        html = response['body']
        assert '<!DOCTYPE html>' in html
        assert 'VoCFeedbackForm.init(' in html
        assert "formId: 'form-1'" in html
        assert "/feedback-forms/form-1/config" in html
        assert "/feedback-forms/form-1/submit" in html


class TestFormCrudErrorPaths:
    """Tests for error paths in form CRUD operations."""

    @patch('feedback_form_handler.aggregates_table')
    def test_list_returns_500_with_error_on_failure(
        self, mock_table, api_gateway_event, lambda_context
    ):
        """Returns 500 with error message when listing forms fails."""
        mock_table.query.side_effect = Exception('DynamoDB error')

        from feedback_form_handler import lambda_handler

        event = api_gateway_event(method='GET', path='/feedback-forms')
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])

        assert response['statusCode'] == 500
        assert 'error' in body

    @patch('feedback_form_handler.aggregates_table')
    def test_create_returns_500_with_error_on_failure(
        self, mock_table, api_gateway_event, lambda_context
    ):
        """Returns 500 with error message when creating a form fails."""
        mock_table.put_item.side_effect = Exception('DynamoDB error')

        from feedback_form_handler import lambda_handler

        event = api_gateway_event(
            method='POST', path='/feedback-forms',
            body={'name': 'Fail Form'}
        )
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])

        assert response['statusCode'] == 500
        assert 'error' in body

    @patch('feedback_form_handler.aggregates_table')
    def test_update_returns_500_with_error_on_failure(
        self, mock_table, api_gateway_event, lambda_context
    ):
        """Returns 500 with error message when updating a form fails."""
        mock_table.update_item.side_effect = Exception('DynamoDB error')

        from feedback_form_handler import lambda_handler

        event = api_gateway_event(
            method='PUT',
            path='/feedback-forms/form-1',
            path_params={'form_id': 'form-1'},
            body={'name': 'Updated'}
        )
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])

        assert response['statusCode'] == 500
        assert 'error' in body

    @patch('feedback_form_handler.aggregates_table')
    def test_delete_returns_500_with_error_on_failure(
        self, mock_table, api_gateway_event, lambda_context
    ):
        """Returns 500 with error message when deleting a form fails."""
        mock_table.delete_item.side_effect = Exception('DynamoDB error')

        from feedback_form_handler import lambda_handler

        event = api_gateway_event(
            method='DELETE',
            path='/feedback-forms/form-1',
            path_params={'form_id': 'form-1'}
        )
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])

        assert response['statusCode'] == 500
        assert 'error' in body

    @patch('feedback_form_handler.aggregates_table')
    def test_get_returns_500_with_error_on_unexpected_failure(
        self, mock_table, api_gateway_event, lambda_context
    ):
        """Returns 500 with error message when get form has unexpected error."""
        mock_table.get_item.side_effect = Exception('DynamoDB error')

        from feedback_form_handler import lambda_handler

        event = api_gateway_event(
            method='GET',
            path='/feedback-forms/form-1',
            path_params={'form_id': 'form-1'}
        )
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])

        assert response['statusCode'] == 500
        assert 'error' in body


class TestSubmitFormErrors:
    """Tests for error paths in form submission."""

    @patch('feedback_form_handler.PROCESSING_QUEUE_URL', 'https://sqs.example.com/queue')
    @patch('feedback_form_handler.sqs')
    @patch('feedback_form_handler.aggregates_table')
    def test_returns_500_with_error_when_sqs_send_fails(
        self, mock_table, mock_sqs, api_gateway_event, lambda_context
    ):
        """Returns 500 with error message when SQS message send fails."""
        mock_table.get_item.return_value = {
            'Item': {'form_id': 'form-1', 'enabled': True}
        }
        mock_sqs.send_message.side_effect = Exception('SQS error')

        from feedback_form_handler import lambda_handler

        event = api_gateway_event(
            method='POST',
            path='/feedback-forms/form-1/submit',
            path_params={'form_id': 'form-1'},
            body={'text': 'Great product!'}
        )

        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])

        assert response['statusCode'] == 500
        assert 'error' in body
