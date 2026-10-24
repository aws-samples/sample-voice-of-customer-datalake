"""
Tests for chat_handler.py - the /chat/conversations/* session endpoints.
"""
from unittest.mock import MagicMock, patch

import pytest
from boto3.dynamodb.conditions import ConditionBase, ConditionExpressionBuilder

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
    # What Powertools hands a route for a request with no query string.
    mock_event.query_string_parameters = None
    return mock_event


def _current_event_ctx(chat_handler_module, sub: str | None = 'test-user-sub'):
    """Return a ``patch.object`` context manager that patches
    ``app.current_event`` for the duration of the ``with`` block.

    ``create=True`` is required because ``current_event`` is only a type
    annotation on the base class; it becomes an instance attribute only after
    ``app.resolve()`` is called.  ``patch.object(..., create=True)`` sets the
    attribute for the duration of the block and removes it on exit, regardless
    of whether the attribute existed beforehand.
    """
    mock_event = _make_current_event_mock(sub)
    return patch.object(chat_handler_module.app, 'current_event', mock_event, create=True)


def _save_event_ctx(chat_handler_module, body: dict, sub: str | None):
    """``app.current_event`` patched to a save request: ``body`` from caller ``sub``."""
    mock_event = MagicMock()
    mock_event.json_body = body
    mock_event.raw_event = _make_raw_event(sub=sub)
    return patch.object(chat_handler_module.app, 'current_event', mock_event, create=True)


def _pk_from_condition(expr) -> str:
    """Extract the partition key value from a boto3 ``KeyConditionExpression``.

    Uses the public ``ConditionExpressionBuilder`` API rather than the private
    ``_values`` attribute, so the assertion is stable across boto3 versions.

    Raises:
        TypeError: If ``expr`` is not a boto3 condition.  Failing here with a
            clear message beats the opaque ``DynamoDBNeedsConditionError`` that
            ``build_expression`` would raise on, say, a ``MagicMock``.
    """
    if not isinstance(expr, ConditionBase):
        raise TypeError(
            f'expected a boto3 ConditionBase, got {type(expr).__name__}'
        )
    built = ConditionExpressionBuilder().build_expression(expr)
    return next(iter(built.attribute_value_placeholders.values()))


# ---------------------------------------------------------------------------
# /chat/conversations  — no table
# ---------------------------------------------------------------------------

class TestChatConversationsEndpointNoTable:
    """Tests for /chat/conversations/* endpoints when table is NOT configured."""

    def test_list_conversations_returns_empty_when_no_table(self):
        """Returns empty list when conversations table not configured (authenticated request)."""
        import chat_handler

        original_table = chat_handler.conversations_table
        chat_handler.conversations_table = None

        try:
            with _current_event_ctx(chat_handler, sub='user-abc'):
                result = chat_handler.get_conversations(conversation_id='_list')

            assert result['conversations'] == []
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
            pk_value = _pk_from_condition(KeyConditionExpression)
            if pk_value == user_a_pk:
                return {'Items': [user_a_item]}
            return {'Items': []}

        mock_table.query.side_effect = query_side_effect
        mock_table.put_item.return_value = {}
        mock_table.delete_item.return_value = {}
        return mock_table

    def test_cross_user_cannot_read_by_id(self):
        """User B cannot read user A's conversation by id."""
        from aws_lambda_powertools.event_handler.exceptions import NotFoundError

        import chat_handler

        mock_table = self._get_mock_table_with_user_a_conv()
        original_table = chat_handler.conversations_table
        chat_handler.conversations_table = mock_table

        try:
            with _current_event_ctx(chat_handler, sub=self.USER_B_SUB), pytest.raises(NotFoundError):
                chat_handler.get_conversations(conversation_id=self.CONV_ID)
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
                result = chat_handler.get_conversations(conversation_id='_list')

            assert result['conversations'] == []
            # User B's query must use USER_B_SUB, not USER_A_SUB
            call_kwargs = mock_table.query.call_args.kwargs
            pk_expr = call_kwargs['KeyConditionExpression']
            actual_pk = _pk_from_condition(pk_expr)
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

        body = {
            'id': self.CONV_ID,  # same conversation id as user A's
            'title': 'Overwrite attempt',
            'messages': [],
            'filters': {},
        }

        try:
            with _save_event_ctx(chat_handler, body, self.USER_B_SUB):
                chat_handler.save_conversation(conversation_id=self.CONV_ID)

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
                result = chat_handler.delete_conversation(conversation_id=self.CONV_ID)

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
                chat_handler.get_conversations(conversation_id='conv-123')
            mock_table.get_item.assert_not_called()
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
                chat_handler.get_conversations(conversation_id='_list')
            mock_table.query.assert_not_called()
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

        try:
            with _save_event_ctx(chat_handler, {'title': 'New', 'messages': []}, None), \
                    pytest.raises(AuthorizationError):
                chat_handler.save_conversation(conversation_id='new')
            mock_table.put_item.assert_not_called()
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
                chat_handler.delete_conversation(conversation_id='conv-123')
            mock_table.delete_item.assert_not_called()
        finally:
            chat_handler.conversations_table = original_table
