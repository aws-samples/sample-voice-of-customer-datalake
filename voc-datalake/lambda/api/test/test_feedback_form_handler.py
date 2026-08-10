"""
Tests for feedback_form_handler.py - /feedback-forms/* endpoints.
"""
import json
from unittest.mock import patch


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


class TestValidationLink:
    """Tests for the optional project_id / document_id validation link.

    A feedback form may record which project — and, as a refinement, which
    document — it validates, so the Prioritization page can show the ratings
    collected about the artefact being scored. Both fields are optional: a
    standalone website survey stores neither and must behave exactly as it
    did before they existed.
    """

    @patch('feedback_form_handler.aggregates_table')
    def test_create_persists_and_returns_the_link(
        self, mock_table, api_gateway_event, lambda_context
    ):
        """A create request carrying the link persists it and echoes it back.

        Asserts on the *persisted item*, not only the response: the two are
        built by different code paths (DEFAULT_FORM_CONFIG seeding vs. the
        item_to_form allowlist), and a field declared in only one of them is
        silently dropped on the next read.
        """
        import sys
        import os
        sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
        from feedback_form_handler import lambda_handler

        event = api_gateway_event(
            method='POST',
            path='/feedback-forms',
            body={
                'name': 'PR/FAQ validation',
                'project_id': 'proj-1',
                'document_id': 'doc-9',
            },
        )

        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])

        assert body['form']['project_id'] == 'proj-1'
        assert body['form']['document_id'] == 'doc-9'

        stored_item = mock_table.put_item.call_args.kwargs['Item']
        assert stored_item['project_id'] == 'proj-1'
        assert stored_item['document_id'] == 'doc-9'

    @patch('feedback_form_handler.aggregates_table')
    def test_create_without_the_link_stores_empty_strings(
        self, mock_table, api_gateway_event, lambda_context
    ):
        """A form that validates nothing keeps working: link fields default empty."""
        import sys
        import os
        sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
        from feedback_form_handler import lambda_handler

        event = api_gateway_event(
            method='POST', path='/feedback-forms', body={'name': 'Website Footer Form'}
        )

        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])

        assert body['form']['project_id'] == ''
        assert body['form']['document_id'] == ''

    @patch('feedback_form_handler.aggregates_table')
    def test_get_returns_a_stored_link(
        self, mock_table, api_gateway_event, lambda_context
    ):
        """A stored link is readable back through the authenticated get route."""
        mock_table.get_item.return_value = {
            'Item': {
                'form_id': 'form-123',
                'name': 'Test Form',
                'enabled': True,
                'project_id': 'proj-1',
                'document_id': 'doc-9',
            }
        }

        import sys
        import os
        sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
        from feedback_form_handler import lambda_handler

        event = api_gateway_event(
            method='GET',
            path='/feedback-forms/form-123',
            path_params={'form_id': 'form-123'},
        )

        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])

        assert body['form']['project_id'] == 'proj-1'
        assert body['form']['document_id'] == 'doc-9'

    @patch('feedback_form_handler.aggregates_table')
    def test_update_writes_the_link(
        self, mock_table, api_gateway_event, lambda_context
    ):
        """PUT accepts the link fields — they are in UPDATABLE_FIELDS."""
        mock_table.update_item.return_value = {
            'Attributes': {
                'form_id': 'form-123',
                'name': 'Test Form',
                'project_id': 'proj-2',
                'document_id': 'doc-7',
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
            body={'project_id': 'proj-2', 'document_id': 'doc-7'},
        )

        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])

        assert body['form']['project_id'] == 'proj-2'
        expr_values = mock_table.update_item.call_args.kwargs['ExpressionAttributeValues']
        assert expr_values[':project_id'] == 'proj-2'
        assert expr_values[':document_id'] == 'doc-7'

    @patch('feedback_form_handler.aggregates_table')
    def test_update_can_clear_the_link(
        self, mock_table, api_gateway_event, lambda_context
    ):
        """Clearing the link (empty strings) reaches DynamoDB rather than being
        dropped as falsy — an admin must be able to unlink a form."""
        mock_table.update_item.return_value = {
            'Attributes': {'form_id': 'form-123', 'project_id': '', 'document_id': ''}
        }

        import sys
        import os
        sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
        from feedback_form_handler import lambda_handler

        event = api_gateway_event(
            method='PUT',
            path='/feedback-forms/form-123',
            path_params={'form_id': 'form-123'},
            body={'project_id': '', 'document_id': ''},
        )

        lambda_handler(event, lambda_context)

        expr_values = mock_table.update_item.call_args.kwargs['ExpressionAttributeValues']
        assert expr_values[':project_id'] == ''
        assert expr_values[':document_id'] == ''

    def test_item_to_form_declares_every_default_config_field(self):
        """Every DEFAULT_FORM_CONFIG field must also be in the item_to_form
        allowlist. build_form_item seeds the record from that dict and
        item_to_form projects it on read, so a field in one and not the other
        persists but is never returned (or vice versa)."""
        import sys
        import os
        sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
        from feedback_form_handler import DEFAULT_FORM_CONFIG, UPDATABLE_FIELDS, item_to_form

        projected = set(item_to_form({}))

        assert set(DEFAULT_FORM_CONFIG) <= projected
        assert set(UPDATABLE_FIELDS) <= projected


class TestPublicConfigDoesNotLeakTheLink:
    """The widget config route is UNAUTHENTICATED and fetched cross-origin from
    customers' own websites (lambda/api/static/feedback-widget.js). Internal
    identifiers for the project and document a form validates must never appear
    in it. This is the security-relevant assertion for this change."""

    @patch('feedback_form_handler.aggregates_table')
    def test_public_config_omits_project_and_document_ids(
        self, mock_table, api_gateway_event, lambda_context
    ):
        """GET /feedback-forms/<id>/config must not expose the link fields."""
        mock_table.get_item.return_value = {
            'Item': {
                'form_id': 'form-123',
                'name': 'Internal name',
                'enabled': True,
                'title': 'Rate this concept',
                'project_id': 'proj-secret',
                'document_id': 'doc-secret',
            }
        }

        import sys
        import os
        sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
        from feedback_form_handler import lambda_handler

        event = api_gateway_event(
            method='GET',
            path='/feedback-forms/form-123/config',
            path_params={'form_id': 'form-123'},
        )

        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])

        config = body['config']
        assert 'project_id' not in config
        assert 'document_id' not in config
        # Not merely absent-by-name: the values must not appear anywhere in the
        # serialized public payload under any other key either.
        assert 'proj-secret' not in response['body']
        assert 'doc-secret' not in response['body']
        # And the fields the widget actually renders are still served.
        assert config['enabled'] is True
        assert config['title'] == 'Rate this concept'

    @patch('feedback_form_handler.aggregates_table')
    def test_public_config_serves_every_field_the_widget_reads(
        self, mock_table, api_gateway_event, lambda_context
    ):
        """The narrower public projection must not have dropped a field the
        embedded widget depends on."""
        mock_table.get_item.return_value = {
            'Item': {
                'form_id': 'form-123',
                'enabled': True,
                'theme': {'primary_color': '#3B82F6'},
                'rating_max': 5,
            }
        }

        import sys
        import os
        sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
        from feedback_form_handler import lambda_handler

        event = api_gateway_event(
            method='GET',
            path='/feedback-forms/form-123/config',
            path_params={'form_id': 'form-123'},
        )

        body = json.loads(lambda_handler(event, lambda_context)['body'])

        # Field names read by lambda/api/static/feedback-widget.js.
        for field in (
            'enabled', 'title', 'description', 'question', 'rating_enabled',
            'rating_type', 'rating_max', 'placeholder', 'collect_name',
            'collect_email', 'success_message', 'theme', 'custom_fields',
        ):
            assert field in body['config'], f'widget reads config.{field}'
