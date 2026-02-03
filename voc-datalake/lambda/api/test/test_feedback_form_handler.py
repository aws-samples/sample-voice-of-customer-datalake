"""
Tests for feedback_form_handler.py - /feedback-forms/* endpoints.
"""
import json
import pytest
from unittest.mock import patch, MagicMock
from datetime import datetime, timezone


class TestListForms:
    """Tests for GET /feedback-forms endpoint."""

    @patch('feedback_form_handler.aggregates_table')
    def test_returns_empty_list_when_no_forms(
        self, mock_table, api_gateway_event, lambda_context
    ):
        """Returns empty list when no forms exist."""
        mock_table.query.return_value = {'Items': []}
        
        import sys
        import os
        sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
        from feedback_form_handler import lambda_handler
        
        event = api_gateway_event(method='GET', path='/feedback-forms')
        
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        
        assert body['success'] is True
        assert body['forms'] == []

    @patch('feedback_form_handler.aggregates_table')
    def test_returns_list_of_forms(
        self, mock_table, api_gateway_event, lambda_context
    ):
        """Returns list of all feedback forms."""
        mock_table.query.return_value = {
            'Items': [
                {
                    'form_id': 'form-1',
                    'name': 'Product Feedback',
                    'enabled': True,
                    'title': 'Product Feedback Form',
                    'created_at': '2026-01-01T00:00:00Z'
                },
                {
                    'form_id': 'form-2',
                    'name': 'Support Feedback',
                    'enabled': False,
                    'title': 'Support Feedback Form',
                    'created_at': '2026-01-02T00:00:00Z'
                }
            ]
        }
        
        import sys
        import os
        sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
        from feedback_form_handler import lambda_handler
        
        event = api_gateway_event(method='GET', path='/feedback-forms')
        
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        
        assert body['success'] is True
        assert len(body['forms']) == 2
        # Should be sorted by created_at descending
        assert body['forms'][0]['form_id'] == 'form-2'


class TestCreateForm:
    """Tests for POST /feedback-forms endpoint."""

    @patch('feedback_form_handler.aggregates_table')
    def test_creates_form_with_defaults(
        self, mock_table, api_gateway_event, lambda_context
    ):
        """Creates form with default values."""
        import sys
        import os
        sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
        from feedback_form_handler import lambda_handler
        
        event = api_gateway_event(
            method='POST',
            path='/feedback-forms',
            body={'name': 'New Form'}
        )
        
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        
        assert body['success'] is True
        assert 'form' in body
        assert body['form']['name'] == 'New Form'
        assert body['form']['enabled'] is False
        mock_table.put_item.assert_called_once()

    @patch('feedback_form_handler.aggregates_table')
    def test_creates_form_with_custom_config(
        self, mock_table, api_gateway_event, lambda_context
    ):
        """Creates form with custom configuration."""
        import sys
        import os
        sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
        from feedback_form_handler import lambda_handler
        
        event = api_gateway_event(
            method='POST',
            path='/feedback-forms',
            body={
                'name': 'Custom Form',
                'enabled': True,
                'title': 'Custom Title',
                'rating_type': 'emoji',
                'category': 'product',
                'subcategory': 'quality'
            }
        )
        
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        
        assert body['success'] is True
        assert body['form']['name'] == 'Custom Form'
        assert body['form']['category'] == 'product'
        assert body['form']['subcategory'] == 'quality'


class TestGetForm:
    """Tests for GET /feedback-forms/<form_id> endpoint."""

    @patch('feedback_form_handler.aggregates_table')
    def test_returns_not_found_for_missing_form(
        self, mock_table, api_gateway_event, lambda_context
    ):
        """Returns error when form doesn't exist."""
        mock_table.get_item.return_value = {}
        
        import sys
        import os
        sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
        from feedback_form_handler import lambda_handler
        
        event = api_gateway_event(
            method='GET',
            path='/feedback-forms/nonexistent',
            path_params={'form_id': 'nonexistent'}
        )
        
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        
        # Now returns 404 with error key
        assert response['statusCode'] == 404
        assert 'error' in body
        assert 'not found' in body['error'].lower()

    @patch('feedback_form_handler.aggregates_table')
    def test_returns_form_details(
        self, mock_table, api_gateway_event, lambda_context
    ):
        """Returns form details for existing form."""
        mock_table.get_item.return_value = {
            'Item': {
                'form_id': 'form-123',
                'name': 'Test Form',
                'enabled': True,
                'title': 'Test Title',
                'rating_type': 'stars',
                'rating_max': 5
            }
        }
        
        import sys
        import os
        sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
        from feedback_form_handler import lambda_handler
        
        event = api_gateway_event(
            method='GET',
            path='/feedback-forms/form-123',
            path_params={'form_id': 'form-123'}
        )
        
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        
        assert body['success'] is True
        assert body['form']['form_id'] == 'form-123'
        assert body['form']['name'] == 'Test Form'


class TestUpdateForm:
    """Tests for PUT /feedback-forms/<form_id> endpoint."""

    @patch('feedback_form_handler.aggregates_table')
    def test_returns_error_when_no_fields_to_update(
        self, mock_table, api_gateway_event, lambda_context
    ):
        """Returns error when no updatable fields provided."""
        import sys
        import os
        sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
        from feedback_form_handler import lambda_handler
        
        event = api_gateway_event(
            method='PUT',
            path='/feedback-forms/form-123',
            path_params={'form_id': 'form-123'},
            body={}
        )
        
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        
        # Now returns 400 with error key
        assert response['statusCode'] == 400
        assert 'error' in body
        assert 'No fields to update' in body['error']

    @patch('feedback_form_handler.aggregates_table')
    def test_updates_form_fields(
        self, mock_table, api_gateway_event, lambda_context
    ):
        """Updates form with provided fields."""
        mock_table.update_item.return_value = {
            'Attributes': {
                'form_id': 'form-123',
                'name': 'Updated Name',
                'enabled': True,
                'title': 'Updated Title'
            }
        }
        
        import sys
        import os
        sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
        from feedback_form_handler import lambda_handler
        
        event = api_gateway_event(
            method='PUT',
            path='/feedback-forms/form-123',
            path_params={'form_id': 'form-123'},
            body={
                'name': 'Updated Name',
                'enabled': True,
                'title': 'Updated Title'
            }
        )
        
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        
        assert body['success'] is True
        assert body['form']['name'] == 'Updated Name'
        mock_table.update_item.assert_called_once()


class TestDeleteForm:
    """Tests for DELETE /feedback-forms/<form_id> endpoint."""

    @patch('feedback_form_handler.aggregates_table')
    def test_deletes_form_successfully(
        self, mock_table, api_gateway_event, lambda_context
    ):
        """Successfully deletes a form."""
        import sys
        import os
        sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
        from feedback_form_handler import lambda_handler
        
        event = api_gateway_event(
            method='DELETE',
            path='/feedback-forms/form-123',
            path_params={'form_id': 'form-123'}
        )
        
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        
        assert body['success'] is True
        mock_table.delete_item.assert_called_once_with(
            Key={'pk': 'FEEDBACK_FORM', 'sk': 'FORM#form-123'}
        )


class TestSubmitFormFeedback:
    """Tests for POST /feedback-forms/<form_id>/submit endpoint."""

    @patch('feedback_form_handler.sqs')
    @patch('feedback_form_handler.aggregates_table')
    def test_returns_error_when_text_empty(
        self, mock_table, mock_sqs, api_gateway_event, lambda_context
    ):
        """Returns error when feedback text is empty."""
        import sys
        import os
        sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
        from feedback_form_handler import lambda_handler
        
        event = api_gateway_event(
            method='POST',
            path='/feedback-forms/form-123/submit',
            path_params={'form_id': 'form-123'},
            body={'text': ''}
        )
        
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        
        # Now returns 400 with error key
        assert response['statusCode'] == 400
        assert 'error' in body
        assert 'required' in body['error'].lower()

    @patch('feedback_form_handler.sqs')
    @patch('feedback_form_handler.aggregates_table')
    def test_returns_error_when_form_not_found(
        self, mock_table, mock_sqs, api_gateway_event, lambda_context
    ):
        """Returns error when form doesn't exist."""
        mock_table.get_item.return_value = {}
        
        import sys
        import os
        sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
        from feedback_form_handler import lambda_handler
        
        event = api_gateway_event(
            method='POST',
            path='/feedback-forms/nonexistent/submit',
            path_params={'form_id': 'nonexistent'},
            body={'text': 'Great product!'}
        )
        
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        
        # Now returns 404 with error key
        assert response['statusCode'] == 404
        assert 'error' in body
        assert 'not found' in body['error'].lower()

    @patch('feedback_form_handler.sqs')
    @patch('feedback_form_handler.aggregates_table')
    def test_returns_error_when_form_disabled(
        self, mock_table, mock_sqs, api_gateway_event, lambda_context
    ):
        """Returns error when form is not enabled."""
        mock_table.get_item.return_value = {
            'Item': {'form_id': 'form-123', 'enabled': False}
        }
        
        import sys
        import os
        sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
        from feedback_form_handler import lambda_handler
        
        event = api_gateway_event(
            method='POST',
            path='/feedback-forms/form-123/submit',
            path_params={'form_id': 'form-123'},
            body={'text': 'Great product!'}
        )
        
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        
        # Now returns 400 with error key
        assert response['statusCode'] == 400
        assert 'error' in body
        assert 'not enabled' in body['error'].lower()

    @patch('feedback_form_handler.PROCESSING_QUEUE_URL', 'https://sqs.example.com/queue')
    @patch('feedback_form_handler.sqs')
    @patch('feedback_form_handler.aggregates_table')
    def test_submits_feedback_with_category_routing(
        self, mock_table, mock_sqs, api_gateway_event, lambda_context
    ):
        """Submits feedback with pre-assigned category from form config."""
        mock_table.get_item.return_value = {
            'Item': {
                'form_id': 'form-123',
                'name': 'Product Form',
                'enabled': True,
                'category': 'product',
                'subcategory': 'quality',
                'success_message': 'Thank you!'
            }
        }
        
        import sys
        import os
        sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
        from feedback_form_handler import lambda_handler
        
        event = api_gateway_event(
            method='POST',
            path='/feedback-forms/form-123/submit',
            path_params={'form_id': 'form-123'},
            body={'text': 'Great product quality!', 'rating': 5}
        )
        
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        
        assert body['success'] is True
        assert 'feedback_id' in body
        assert body['message'] == 'Thank you!'
        
        # Verify SQS message includes category routing
        mock_sqs.send_message.assert_called_once()
        call_args = mock_sqs.send_message.call_args
        message_body = json.loads(call_args.kwargs['MessageBody'])
        assert message_body['preset_category'] == 'product'
        assert message_body['preset_subcategory'] == 'quality'
        assert message_body['source_channel'] == 'form_form-123'


class TestItemToForm:
    """Tests for item_to_form helper function."""

    def test_converts_dynamodb_item_to_form_response(self):
        """Converts DynamoDB item to form response format."""
        import sys
        import os
        sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
        from feedback_form_handler import item_to_form
        
        item = {
            'form_id': 'form-123',
            'name': 'Test Form',
            'enabled': True,
            'title': 'Test Title',
            'description': 'Test description',
            'rating_max': 5,
            'theme': {'primary_color': '#3B82F6'},
            'category': 'product',
            'created_at': '2026-01-01T00:00:00Z'
        }
        
        result = item_to_form(item)
        
        assert result['form_id'] == 'form-123'
        assert result['name'] == 'Test Form'
        assert result['enabled'] is True
        assert result['rating_max'] == 5
        assert result['theme']['primary_color'] == '#3B82F6'
        assert result['category'] == 'product'

    def test_handles_missing_fields_with_defaults(self):
        """Returns default values for missing fields."""
        import sys
        import os
        sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
        from feedback_form_handler import item_to_form
        
        item = {'form_id': 'form-123'}
        
        result = item_to_form(item)
        
        assert result['form_id'] == 'form-123'
        assert result['name'] == ''
        assert result['enabled'] is False
        assert result['rating_enabled'] is True
        assert result['rating_max'] == 5
        assert result['theme'] == {}
