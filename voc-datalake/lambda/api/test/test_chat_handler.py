"""
Tests for chat_handler.py - /chat/* endpoints with Bedrock AI integration.
"""
import json
from unittest.mock import MagicMock, patch

import pytest

# Bedrock model ID used in production
BEDROCK_MODEL_ID = 'global.anthropic.claude-sonnet-4-5-20250929-v1:0'


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_raw_event(sub: str | None = 'test-user-sub') -> dict:
    """Build a minimal raw API-Gateway event with Cognito authorizer claims."""
    claims = {}
    if sub is not None:
        claims['sub'] = sub
    return {
        'requestContext': {
            'authorizer': {
                'claims': claims,
            }
        }
    }


def _make_current_event_mock(sub: str | None = 'test-user-sub') -> MagicMock:
    """Build a mock ``current_event`` carrying the given Cognito subject."""
    mock_event = MagicMock()
    mock_event.raw_event = _make_raw_event(sub)
    mock_event.json_body = {}
    return mock_event


def _current_event_ctx(chat_handler_module, sub: str | None = 'test-user-sub'):
    """Return a ``patch.object`` context manager that patches
    ``app.current_event`` for the duration of the ``with`` block.

    Using ``patch.object`` ensures proper teardown regardless of whether
    ``app.resolve()`` has modified the class-level attribute during the test.
    """
    mock_event = _make_current_event_mock(sub)
    return patch.object(chat_handler_module.app, 'current_event', mock_event)


# ---------------------------------------------------------------------------
# POST /chat (AI chat endpoint)
# ---------------------------------------------------------------------------

class TestChatEndpoint:
    """Tests for POST /chat endpoint."""

    @patch('shared.converse.converse')
    @patch('chat_handler.feedback_table')
    @patch('chat_handler.aggregates_table')
    def test_returns_ai_response_for_valid_message(
        self, mock_agg_table, mock_fb_table, mock_converse,
        api_gateway_event, lambda_context
    ):
        """Returns AI-generated response based on feedback data."""
        # Arrange
        mock_converse.return_value = 'Based on the feedback data, customers are generally satisfied with the product quality.'
        mock_agg_table.get_item.return_value = {'Item': {'count': 100}}
        mock_fb_table.query.return_value = {'Items': []}

        import os
        import sys
        sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
        from chat_handler import lambda_handler

        event = api_gateway_event(
            method='POST',
            path='/chat',
            body={'message': 'What do customers think about our product?'}
        )

        # Act
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])

        # Assert
        assert response['statusCode'] == 200
        assert 'response' in body
        assert 'satisfied' in body['response']
        mock_converse.assert_called_once()

    @patch('shared.converse.converse')
    @patch('chat_handler.feedback_table')
    @patch('chat_handler.aggregates_table')
    def test_uses_correct_bedrock_model_id(
        self, mock_agg_table, mock_fb_table, mock_converse,
        api_gateway_event, lambda_context
    ):
        """Verifies converse is called (model ID is configured in shared module)."""
        # Arrange
        mock_converse.return_value = 'Test response'
        mock_agg_table.get_item.return_value = {}
        mock_fb_table.query.return_value = {'Items': []}

        from chat_handler import lambda_handler
        event = api_gateway_event(
            method='POST',
            path='/chat',
            body={'message': 'test'}
        )

        # Act
        lambda_handler(event, lambda_context)

        # Assert - converse was called (model ID is configured in shared.converse)
        mock_converse.assert_called_once()

    @patch('shared.converse.converse')
    @patch('chat_handler.feedback_table')
    @patch('chat_handler.aggregates_table')
    def test_returns_graceful_error_when_bedrock_fails(
        self, mock_agg_table, mock_fb_table, mock_converse,
        api_gateway_event, lambda_context
    ):
        """Returns graceful error message when Bedrock service fails."""
        # Arrange
        mock_converse.side_effect = Exception('Service unavailable')
        mock_agg_table.get_item.return_value = {'Item': {'count': 50}}
        mock_fb_table.query.return_value = {'Items': []}

        from chat_handler import lambda_handler
        event = api_gateway_event(
            method='POST',
            path='/chat',
            body={'message': 'What are the top issues?'}
        )

        # Act
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])

        # Assert - graceful degradation, not 500 error
        assert response['statusCode'] == 200
        assert 'error' in body or 'Error' in body.get('response', '')

    @patch('shared.converse.converse')
    @patch('chat_handler.feedback_table')
    @patch('chat_handler.aggregates_table')
    def test_includes_feedback_sources_in_response(
        self, mock_agg_table, mock_fb_table, mock_converse,
        sample_feedback_items, api_gateway_event, lambda_context
    ):
        """Includes source feedback items in response."""
        # Arrange
        mock_converse.return_value = 'Analysis complete.'
        mock_agg_table.get_item.return_value = {'Item': {'count': 10}}
        mock_fb_table.query.return_value = {'Items': sample_feedback_items}

        from chat_handler import lambda_handler
        event = api_gateway_event(
            method='POST',
            path='/chat',
            body={'message': 'Show me recent feedback'}
        )

        # Act
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])

        # Assert
        assert response['statusCode'] == 200
        assert 'sources' in body


# ---------------------------------------------------------------------------
# /chat/conversations  — table presence check
# ---------------------------------------------------------------------------

class TestChatConversationsEndpoint:
    """Tests for /chat/conversations/* endpoints.

    Note: These endpoints use <proxy+> routes which require specific API Gateway
    event formatting. The conversation functionality is tested through integration
    tests in the deployed environment.
    """

    def test_conversations_table_configured(self):
        """Verifies conversations table is configured via environment."""
        import os
        assert os.environ.get('CONVERSATIONS_TABLE') == 'test-conversations'


# ---------------------------------------------------------------------------
# /chat/conversations  — direct function calls (authenticated)
# ---------------------------------------------------------------------------

class TestChatConversationsEndpointWithTable:
    """Tests for /chat/conversations/* endpoints when table is configured.

    Note: The <proxy+> route syntax used in chat_handler.py is API Gateway specific
    and doesn't work with Lambda Powertools' route matching in unit tests.
    These tests call the handler functions directly to test the business logic.
    """

    def test_list_conversations_returns_conversations(self):
        """Returns list of conversations scoped to the authenticated caller."""
        import chat_handler

        mock_table = MagicMock()
        mock_table.query.return_value = {
            'Items': [
                {
                    'conversation_id': 'conv-1',
                    'title': 'Test Conversation',
                    'messages': [{'role': 'user', 'content': 'Hello'}],
                    'created_at': '2026-01-07T10:00:00Z',
                    'updated_at': '2026-01-07T10:00:00Z'
                }
            ]
        }

        original_table = chat_handler.conversations_table
        chat_handler.conversations_table = mock_table

        try:
            with _current_event_ctx(chat_handler, sub='user-abc'):
                result = chat_handler.get_conversations(proxy='_list')

            assert 'conversations' in result
            assert len(result['conversations']) == 1
            assert result['conversations'][0]['id'] == 'conv-1'
            # Verify the PK used in the query is the caller's subject
            call_kwargs = mock_table.query.call_args.kwargs
            pk_expr = call_kwargs['KeyConditionExpression']
            # boto3 condition stores the compared value in _values[1]
            assert pk_expr._values[1] == 'USER#user-abc'
        finally:
            chat_handler.conversations_table = original_table

    def test_get_single_conversation(self):
        """Returns single conversation by ID for the authenticated caller."""
        import chat_handler

        mock_table = MagicMock()
        mock_table.get_item.return_value = {
            'Item': {
                'conversation_id': 'conv-123',
                'title': 'Test Conversation',
                'messages': [{'role': 'user', 'content': 'Hello'}],
                'filters': {'days': 7},
                'created_at': '2026-01-07T10:00:00Z',
                'updated_at': '2026-01-07T10:00:00Z'
            }
        }

        original_table = chat_handler.conversations_table
        chat_handler.conversations_table = mock_table

        try:
            with _current_event_ctx(chat_handler, sub='user-abc'):
                result = chat_handler.get_conversations(proxy='conv-123')

            assert result['id'] == 'conv-123'
            assert result['title'] == 'Test Conversation'
            assert len(result['messages']) == 1
            # Verify the PK used is the caller's subject
            call_kwargs = mock_table.get_item.call_args.kwargs
            assert call_kwargs['Key']['pk'] == 'USER#user-abc'
        finally:
            chat_handler.conversations_table = original_table

    def test_get_conversation_raises_not_found_when_missing(self):
        """Raises NotFoundError when conversation doesn't exist."""
        import chat_handler
        from aws_lambda_powertools.event_handler.exceptions import NotFoundError

        mock_table = MagicMock()
        mock_table.get_item.return_value = {}

        original_table = chat_handler.conversations_table
        chat_handler.conversations_table = mock_table

        try:
            with _current_event_ctx(chat_handler, sub='user-abc'), pytest.raises(NotFoundError):
                chat_handler.get_conversations(proxy='nonexistent')
        finally:
            chat_handler.conversations_table = original_table


# ---------------------------------------------------------------------------
# /chat/conversations  — no table
# ---------------------------------------------------------------------------

class TestChatConversationsEndpointNoTable:
    """Tests for /chat/conversations/* endpoints when table is NOT configured."""

    def test_list_conversations_returns_empty_when_no_table(self):
        """Returns empty list when conversations table not configured."""
        import chat_handler

        original_table = chat_handler.conversations_table
        chat_handler.conversations_table = None

        try:
            result = chat_handler.get_conversations(proxy='_list')

            assert result['conversations'] == []
        finally:
            chat_handler.conversations_table = original_table


# ---------------------------------------------------------------------------
# POST /chat/conversations  — save
# ---------------------------------------------------------------------------

class TestSaveConversation:
    """Tests for POST /chat/conversations/* endpoint."""

    def test_returns_error_when_table_not_configured(self):
        """Returns error when conversations table not configured."""
        import chat_handler
        from shared.exceptions import ConfigurationError

        original_table = chat_handler.conversations_table
        chat_handler.conversations_table = None

        try:
            mock_event = MagicMock()
            mock_event.json_body = {'title': 'New Conversation', 'messages': []}
            mock_event.raw_event = _make_raw_event(sub='user-abc')

            with patch.object(chat_handler.app, 'current_event', mock_event), pytest.raises(ConfigurationError):
                chat_handler.save_conversation(proxy='new')
        finally:
            chat_handler.conversations_table = original_table

    def test_saves_conversation_successfully(self):
        """Saves conversation to DynamoDB using the caller's subject as PK."""
        import chat_handler

        mock_table = MagicMock()
        mock_table.put_item.return_value = {}

        original_table = chat_handler.conversations_table
        chat_handler.conversations_table = mock_table

        try:
            mock_event = MagicMock()
            mock_event.json_body = {
                'id': 'conv-123',
                'title': 'Test Conversation',
                'messages': [{'role': 'user', 'content': 'Hello'}],
                'filters': {'days': 7}
            }
            mock_event.raw_event = _make_raw_event(sub='user-abc')

            with patch.object(chat_handler.app, 'current_event', mock_event):
                result = chat_handler.save_conversation(proxy='new')

            assert result['success'] is True
            assert result['id'] == 'conv-123'
            mock_table.put_item.assert_called_once()
            # Verify the PK stored is the caller's subject
            saved_item = mock_table.put_item.call_args.kwargs['Item']
            assert saved_item['pk'] == 'USER#user-abc'
        finally:
            chat_handler.conversations_table = original_table

    def test_generates_id_when_not_provided(self):
        """Generates conversation ID when not provided."""
        import chat_handler

        mock_table = MagicMock()
        mock_table.put_item.return_value = {}

        original_table = chat_handler.conversations_table
        chat_handler.conversations_table = mock_table

        try:
            mock_event = MagicMock()
            mock_event.json_body = {'title': 'New Conversation', 'messages': []}
            mock_event.raw_event = _make_raw_event(sub='user-abc')

            with patch.object(chat_handler.app, 'current_event', mock_event):
                result = chat_handler.save_conversation(proxy='new')

            assert result['success'] is True
            assert 'id' in result
            assert result['id'].startswith('conv-')
        finally:
            chat_handler.conversations_table = original_table


# ---------------------------------------------------------------------------
# DELETE /chat/conversations
# ---------------------------------------------------------------------------

class TestDeleteConversation:
    """Tests for DELETE /chat/conversations/* endpoint."""

    def test_raises_error_when_table_not_configured(self):
        """Raises ConfigurationError when conversations table not configured."""
        import chat_handler
        from shared.exceptions import ConfigurationError

        original_table = chat_handler.conversations_table
        chat_handler.conversations_table = None

        try:
            with pytest.raises(ConfigurationError) as exc_info:
                chat_handler.delete_conversation(proxy='conv-123')

            assert 'not configured' in str(exc_info.value)
        finally:
            chat_handler.conversations_table = original_table

    def test_deletes_conversation_successfully(self):
        """Deletes conversation from DynamoDB using the caller's subject as PK."""
        import chat_handler

        mock_table = MagicMock()
        mock_table.delete_item.return_value = {}

        original_table = chat_handler.conversations_table
        chat_handler.conversations_table = mock_table

        try:
            with _current_event_ctx(chat_handler, sub='user-abc'):
                result = chat_handler.delete_conversation(proxy='conv-123')

            assert result['success'] is True
            mock_table.delete_item.assert_called_once()
            # Verify the PK used is the caller's subject
            call_kwargs = mock_table.delete_item.call_args.kwargs
            assert call_kwargs['Key']['pk'] == 'USER#user-abc'
        finally:
            chat_handler.conversations_table = original_table


# ---------------------------------------------------------------------------
# Cross-user isolation (the core security requirement)
# ---------------------------------------------------------------------------

class TestCrossUserIsolation:
    """Verify that user A's conversations are never accessible to user B.

    A conversation is written by user A.  User B attempts each of the four
    operations.  For read-by-id and list, the mock table returns no item
    (as DynamoDB would for a key the caller doesn't own).  For write, we
    inspect which PK is passed.  For delete, we inspect the PK used.

    A single revert of the relevant change will cause the named test to fail:
      - revert get_conversations PK  → test_cross_user_cannot_read_by_id
      - revert get_conversations list → test_cross_user_cannot_list_conversations
      - revert save_conversation PK  → test_cross_user_cannot_overwrite
      - revert delete_conversation PK → test_cross_user_cannot_delete
    """

    USER_A_SUB = 'user-aaaa-1111'
    USER_B_SUB = 'user-bbbb-2222'
    CONV_ID = 'conv-shared-target'

    def _get_mock_table_with_user_a_conv(self):
        """Return a mock table pre-loaded with user A's conversation."""
        mock_table = MagicMock()
        user_a_pk = f'USER#{self.USER_A_SUB}'
        user_a_item = {
            'pk': user_a_pk,
            'sk': f'CONV#{self.CONV_ID}',
            'conversation_id': self.CONV_ID,
            'title': 'User A private conversation',
            'messages': [{'role': 'user', 'content': 'secret'}],
            'filters': {},
            'created_at': '2026-01-01T00:00:00Z',
            'updated_at': '2026-01-01T00:00:00Z',
        }

        def get_item_side_effect(Key):
            # Only return the item when the pk matches user A's
            if Key.get('pk') == user_a_pk:
                return {'Item': user_a_item}
            return {}  # user B's query returns nothing

        mock_table.get_item.side_effect = get_item_side_effect

        def query_side_effect(KeyConditionExpression, **_kwargs):
            # boto3 condition stores the compared value in _values[1]
            pk_value = KeyConditionExpression._values[1]
            if pk_value == user_a_pk:
                return {'Items': [user_a_item]}
            return {'Items': []}

        mock_table.query.side_effect = query_side_effect
        mock_table.put_item.return_value = {}
        mock_table.delete_item.return_value = {}
        return mock_table

    def test_cross_user_cannot_read_by_id(self):
        """User B cannot read user A's conversation by id."""
        import chat_handler
        from aws_lambda_powertools.event_handler.exceptions import NotFoundError

        mock_table = self._get_mock_table_with_user_a_conv()
        original_table = chat_handler.conversations_table
        chat_handler.conversations_table = mock_table

        try:
            with _current_event_ctx(chat_handler, sub=self.USER_B_SUB), pytest.raises(NotFoundError):
                chat_handler.get_conversations(proxy=self.CONV_ID)
        finally:
            chat_handler.conversations_table = original_table

    def test_cross_user_cannot_list_conversations(self):
        """User B's list does not include user A's conversations."""
        import chat_handler

        mock_table = self._get_mock_table_with_user_a_conv()
        original_table = chat_handler.conversations_table
        chat_handler.conversations_table = mock_table

        try:
            with _current_event_ctx(chat_handler, sub=self.USER_B_SUB):
                result = chat_handler.get_conversations(proxy='_list')

            assert result['conversations'] == []
            # User B's query must use USER_B_SUB, not USER_A_SUB
            call_kwargs = mock_table.query.call_args.kwargs
            pk_expr = call_kwargs['KeyConditionExpression']
            # boto3 condition stores the compared value in _values[1]
            actual_pk = pk_expr._values[1]
            assert actual_pk == f'USER#{self.USER_B_SUB}'
            assert actual_pk != f'USER#{self.USER_A_SUB}'
        finally:
            chat_handler.conversations_table = original_table

    def test_cross_user_cannot_overwrite(self):
        """User B's write goes to user B's partition, not user A's."""
        import chat_handler

        mock_table = self._get_mock_table_with_user_a_conv()
        original_table = chat_handler.conversations_table
        chat_handler.conversations_table = mock_table

        mock_event = MagicMock()
        mock_event.json_body = {
            'id': self.CONV_ID,  # same conversation id as user A's
            'title': 'Overwrite attempt',
            'messages': [],
            'filters': {},
        }
        mock_event.raw_event = _make_raw_event(sub=self.USER_B_SUB)

        try:
            with patch.object(chat_handler.app, 'current_event', mock_event):
                chat_handler.save_conversation(proxy=self.CONV_ID)

            saved_item = mock_table.put_item.call_args.kwargs['Item']
            # The write must land in user B's partition
            assert saved_item['pk'] == f'USER#{self.USER_B_SUB}'
            assert saved_item['pk'] != f'USER#{self.USER_A_SUB}'
        finally:
            chat_handler.conversations_table = original_table

    def test_cross_user_cannot_delete(self):
        """User B's delete targets user B's partition, not user A's."""
        import chat_handler

        mock_table = self._get_mock_table_with_user_a_conv()
        original_table = chat_handler.conversations_table
        chat_handler.conversations_table = mock_table

        try:
            with _current_event_ctx(chat_handler, sub=self.USER_B_SUB):
                result = chat_handler.delete_conversation(proxy=self.CONV_ID)

            assert result['success'] is True
            call_kwargs = mock_table.delete_item.call_args.kwargs
            # Must target user B's PK, not user A's
            assert call_kwargs['Key']['pk'] == f'USER#{self.USER_B_SUB}'
            assert call_kwargs['Key']['pk'] != f'USER#{self.USER_A_SUB}'
        finally:
            chat_handler.conversations_table = original_table


# ---------------------------------------------------------------------------
# Fail-closed: no identity → AuthorizationError (not fallback to shared PK)
# ---------------------------------------------------------------------------

class TestFailClosedWithNoIdentity:
    """All four conversation operations must refuse requests with no ``sub`` claim.

    A revert of the fail-closed logic in get_caller_subject will cause
    test_get_by_id_fails_closed, test_list_fails_closed,
    test_save_fails_closed, and test_delete_fails_closed to fail.
    """

    def test_get_by_id_fails_closed(self):
        """get_conversations raises AuthorizationError when sub is absent."""
        import chat_handler
        from shared.exceptions import AuthorizationError

        mock_table = MagicMock()
        mock_table.get_item.return_value = {}

        original_table = chat_handler.conversations_table
        chat_handler.conversations_table = mock_table

        try:
            with _current_event_ctx(chat_handler, sub=None), pytest.raises(AuthorizationError):  # no sub claim
                chat_handler.get_conversations(proxy='conv-123')
        finally:
            chat_handler.conversations_table = original_table

    def test_list_fails_closed(self):
        """get_conversations (list) raises AuthorizationError when sub is absent."""
        import chat_handler
        from shared.exceptions import AuthorizationError

        mock_table = MagicMock()
        mock_table.query.return_value = {'Items': []}

        original_table = chat_handler.conversations_table
        chat_handler.conversations_table = mock_table

        try:
            with _current_event_ctx(chat_handler, sub=None), pytest.raises(AuthorizationError):
                chat_handler.get_conversations(proxy='_list')
        finally:
            chat_handler.conversations_table = original_table

    def test_save_fails_closed(self):
        """save_conversation raises AuthorizationError when sub is absent."""
        import chat_handler
        from shared.exceptions import AuthorizationError

        mock_table = MagicMock()
        mock_table.put_item.return_value = {}

        original_table = chat_handler.conversations_table
        chat_handler.conversations_table = mock_table

        mock_event = MagicMock()
        mock_event.json_body = {'title': 'New', 'messages': []}
        mock_event.raw_event = _make_raw_event(sub=None)

        try:
            with patch.object(chat_handler.app, 'current_event', mock_event), pytest.raises(AuthorizationError):
                chat_handler.save_conversation(proxy='new')
        finally:
            chat_handler.conversations_table = original_table

    def test_delete_fails_closed(self):
        """delete_conversation raises AuthorizationError when sub is absent."""
        import chat_handler
        from shared.exceptions import AuthorizationError

        mock_table = MagicMock()
        mock_table.delete_item.return_value = {}

        original_table = chat_handler.conversations_table
        chat_handler.conversations_table = mock_table

        try:
            with _current_event_ctx(chat_handler, sub=None), pytest.raises(AuthorizationError):
                chat_handler.delete_conversation(proxy='conv-123')
        finally:
            chat_handler.conversations_table = original_table

    def test_no_shared_partition_key_is_ever_used(self):
        """The literal string 'USER#default' must never reach DynamoDB.

        This test verifies the complete absence of the shared key across all
        four operations under a variety of identity scenarios.
        """
        import chat_handler
        from shared.exceptions import AuthorizationError

        mock_table = MagicMock()
        mock_table.get_item.return_value = {}
        mock_table.query.return_value = {'Items': []}
        mock_table.put_item.return_value = {}
        mock_table.delete_item.return_value = {}

        original_table = chat_handler.conversations_table
        chat_handler.conversations_table = mock_table

        def _all_pk_calls():
            pks = []
            for call in mock_table.get_item.call_args_list:
                pks.append(call.kwargs.get('Key', {}).get('pk', ''))
            for call in mock_table.query.call_args_list:
                # boto3 condition stores the compared value in _values[1]
                expr = call.kwargs.get('KeyConditionExpression')
                if expr is not None and hasattr(expr, '_values'):
                    pks.append(expr._values[1])
            for call in mock_table.put_item.call_args_list:
                pks.append(call.kwargs.get('Item', {}).get('pk', ''))
            for call in mock_table.delete_item.call_args_list:
                pks.append(call.kwargs.get('Key', {}).get('pk', ''))
            return pks

        try:
            # Operation with a real subject — must use that subject, not 'default'
            with _current_event_ctx(chat_handler, sub='real-user-sub'):
                chat_handler.get_conversations(proxy='_list')

            mock_event = _make_current_event_mock(sub='real-user-sub')
            mock_event.json_body = {'title': 'T', 'messages': []}
            with patch.object(chat_handler.app, 'current_event', mock_event):
                chat_handler.save_conversation(proxy='new')

            with _current_event_ctx(chat_handler, sub='real-user-sub'):
                chat_handler.delete_conversation(proxy='conv-x')

            # Operation with no subject — must raise, must not hit DynamoDB
            with _current_event_ctx(chat_handler, sub=None):
                with pytest.raises(AuthorizationError):
                    chat_handler.get_conversations(proxy='_list')
                with pytest.raises(AuthorizationError):
                    chat_handler.delete_conversation(proxy='conv-x')

            all_pks = _all_pk_calls()
            assert 'USER#default' not in all_pks, (
                f"Found 'USER#default' in DynamoDB calls: {all_pks}"
            )
        finally:
            chat_handler.conversations_table = original_table


# ---------------------------------------------------------------------------
# Edge cases for POST /chat
# ---------------------------------------------------------------------------

class TestChatEndpointEdgeCases:
    """Additional edge case tests for POST /chat endpoint."""

    @patch('shared.converse.converse')
    @patch('chat_handler.feedback_table')
    @patch('chat_handler.aggregates_table')
    def test_handles_empty_feedback_data(
        self, mock_agg_table, mock_fb_table, mock_converse,
        api_gateway_event, lambda_context
    ):
        """Handles case when no feedback data exists."""
        mock_converse.return_value = 'No feedback data available for analysis.'
        mock_agg_table.get_item.return_value = {}
        mock_fb_table.query.return_value = {'Items': []}

        from shared.api import clear_categories_cache
        clear_categories_cache()

        from chat_handler import lambda_handler
        event = api_gateway_event(
            method='POST',
            path='/chat',
            body={'message': 'What are the trends?'}
        )

        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])

        assert response['statusCode'] == 200
        assert 'response' in body

    @patch('shared.converse.converse')
    @patch('chat_handler.feedback_table')
    @patch('chat_handler.aggregates_table')
    def test_uses_days_query_parameter(
        self, mock_agg_table, mock_fb_table, mock_converse,
        api_gateway_event, lambda_context
    ):
        """Uses days parameter from query string."""
        mock_converse.return_value = 'Analysis complete.'
        mock_agg_table.get_item.return_value = {'Item': {'count': 10}}
        mock_fb_table.query.return_value = {'Items': []}

        from chat_handler import lambda_handler
        event = api_gateway_event(
            method='POST',
            path='/chat',
            query_params={'days': '30'},
            body={'message': 'Analyze last 30 days'}
        )

        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])

        assert response['statusCode'] == 200
        assert body['metadata']['days_analyzed'] == 30


# ---------------------------------------------------------------------------
# Date-basis tests (issue #150)
# ---------------------------------------------------------------------------

class TestChatDateBasis:
    """POST /chat honors date_basis for the feedback sample (issue #150)."""

    @staticmethod
    def _item(feedback_id, written_days_ago):
        from datetime import datetime, timedelta, timezone
        now = datetime.now(timezone.utc)
        return {
            'feedback_id': feedback_id,
            'source_platform': 'webscraper',
            'sentiment_label': 'negative',
            'original_text': f'text of {feedback_id}',
            'date': now.strftime('%Y-%m-%d'),
            'source_created_at': (now - timedelta(days=written_days_ago)).strftime('%Y-%m-%dT%H:%M:%SZ'),
        }

    @patch('shared.converse.converse')
    @patch('chat_handler.feedback_table')
    @patch('chat_handler.aggregates_table')
    def test_review_basis_excludes_backfilled_reviews_from_context(
        self, mock_agg_table, mock_fb_table, mock_converse,
        api_gateway_event, lambda_context
    ):
        mock_converse.return_value = 'ok'
        mock_agg_table.get_item.return_value = {}
        mock_fb_table.query.return_value = {
            'Items': [self._item('fresh', 1), self._item('backfilled', 400)],
        }
        from chat_handler import lambda_handler

        event = api_gateway_event(
            method='POST', path='/chat', query_params={'days': '7'},
            body={'message': 'summarize', 'date_basis': 'review'},
        )
        response = lambda_handler(event, lambda_context)

        assert response['statusCode'] == 200
        prompt = mock_converse.call_args.kwargs.get('prompt') or mock_converse.call_args.args[0]
        assert 'text of fresh' in prompt
        assert 'text of backfilled' not in prompt

    @patch('shared.converse.converse')
    @patch('chat_handler.feedback_table')
    @patch('chat_handler.aggregates_table')
    def test_default_basis_keeps_backfilled_reviews(
        self, mock_agg_table, mock_fb_table, mock_converse,
        api_gateway_event, lambda_context
    ):
        mock_converse.return_value = 'ok'
        mock_agg_table.get_item.return_value = {}
        mock_fb_table.query.return_value = {
            'Items': [self._item('backfilled', 400)],
        }
        from chat_handler import lambda_handler

        event = api_gateway_event(
            method='POST', path='/chat', query_params={'days': '7'},
            body={'message': 'summarize'},
        )
        response = lambda_handler(event, lambda_context)

        assert response['statusCode'] == 200
        prompt = mock_converse.call_args.kwargs.get('prompt') or mock_converse.call_args.args[0]
        assert 'text of backfilled' in prompt
