"""
Tests for MCP handler security hardening (issue #260):
  1. Constant-time token comparison (hmac.compare_digest)
  2. Scope enforcement at dispatch (fail-closed)
  3. Partial-result reporting in get_metrics_summary (is_partial flag)

Regression coverage
-------------------
Revert test that catches each defect:

  defect 1 (timing): test_authenticate_uses_compare_digest
    — asserts that hmac.compare_digest is called instead of ==.
    Reverting the hmac.compare_digest fix makes this test fail immediately
    because the mock would never be called.

  defect 2 (scope): test_read_token_rejected_for_write_tool
    — registers a synthetic "read-write"-scoped tool inside the test and
    asserts that a read-scoped token is rejected.  Reverting the scope
    enforcement block in _handle_tools_call (removing the TOOL_SCOPE_REQUIREMENTS
    lookup and the _scope_allows check) causes this test to fail because the
    tool would execute instead of returning an error.

  defect 3 (partial): test_partial_read_sets_is_partial_flag
    — forces one DynamoDB read to raise and asserts the response carries
    is_partial=True while the successful reads are still present.
    Reverting the is_partial tracking (restoring bare `except Exception: pass`)
    causes this test to fail because is_partial would be False even when a
    read raised.

  additional scope tests:
    test_every_registered_tool_has_scope_declaration
    — asserts TOOL_HANDLERS and TOOL_SCOPE_REQUIREMENTS have identical keys,
      so adding a handler without a scope declaration breaks this test.

    test_read_write_token_allowed_for_read_tool
    — asserts that a read-write token can call a read tool (upward compat).
"""

import json
import os
import sys
from unittest.mock import MagicMock, patch

# ---------------------------------------------------------------------------
# Ensure lambda/ and lambda/api/ are on the path (mirrors conftest.py)
# ---------------------------------------------------------------------------
_api_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_lambda_dir = os.path.dirname(_api_dir)
for _p in (_lambda_dir, _api_dir):
    if _p not in sys.path:
        sys.path.insert(0, _p)


# ===========================================================================
# 1. Constant-time token comparison
# ===========================================================================

class TestConstantTimeTokenComparison:
    """hmac.compare_digest must be called for every hash comparison in _authenticate."""

    def _make_event(self, token: str, project_id: str = "proj-1") -> dict:
        return {
            "headers": {
                "authorization": f"Bearer {token}",
                "x-project-id": project_id,
            }
        }

    @patch("mcp_handler.projects_table")
    @patch("mcp_handler.hmac.compare_digest")
    def test_authenticate_uses_compare_digest(self, mock_digest, mock_table):
        """compare_digest is called for every stored hash; == is never used."""
        mock_digest.return_value = False  # force no-match so _authenticate returns None

        # Simulate one stored token in DynamoDB
        mock_table.query.return_value = {
            "Items": [{"sk": "TOKEN#1", "token_hash": "somehash", "scope": "read"}]
        }

        from mcp_handler import _authenticate
        result = _authenticate(self._make_event("voc_testtoken"))

        # compare_digest was called (not ==)
        assert mock_digest.called, "hmac.compare_digest was never called"
        # And the result is None because we forced it to return False
        assert result is None

    @patch("mcp_handler.projects_table")
    @patch("mcp_handler.hmac.compare_digest")
    def test_authenticate_returns_token_on_digest_match(self, mock_digest, mock_table):
        """When compare_digest returns True, _authenticate returns the token item."""
        mock_digest.return_value = True

        stored_item = {"sk": "TOKEN#1", "token_hash": "somehash", "scope": "read"}
        mock_table.query.return_value = {"Items": [stored_item]}
        mock_table.update_item.return_value = {}

        from mcp_handler import _authenticate
        result = _authenticate(self._make_event("voc_testtoken", project_id="proj-1"))

        assert result is not None
        assert result["scope"] == "read"
        assert result["project_id"] == "proj-1"

    @patch("mcp_handler.projects_table")
    def test_authenticate_no_match_returns_none(self, mock_table):
        """A token whose hash does not match any stored hash returns None."""
        # Return an item whose hash is deliberately wrong
        mock_table.query.return_value = {
            "Items": [{"sk": "TOKEN#1", "token_hash": "wronghash", "scope": "read"}]
        }

        from mcp_handler import _authenticate
        # The real hash won't match "wronghash"
        result = _authenticate(self._make_event("voc_realtoken"))
        assert result is None

    @patch("mcp_handler.projects_table")
    def test_authenticate_returns_none_when_query_raises(self, mock_table):
        """When projects_table.query raises, _authenticate returns None (not a 500).

        A transient DynamoDB error in the token-lookup path must not propagate
        as an unhandled exception; the caller should receive a clean 401 instead.
        """
        mock_table.query.side_effect = Exception("ProvisionedThroughputExceededException")

        from mcp_handler import _authenticate
        result = _authenticate(self._make_event("voc_testtoken"))

        assert result is None, "DynamoDB query failure must return None, not raise"


# ===========================================================================
# 2. Scope enforcement
# ===========================================================================

class TestScopeEnforcement:
    """Dispatch is fail-closed: scope must be declared and satisfied."""

    def _call_tool(self, tool_name: str, token_scope: str, handlers_extra=None, scopes_extra=None):
        """Call _handle_tools_call with the given tool and token scope."""
        import mcp_handler

        token_info = {"project_id": "proj-1", "scope": token_scope}

        # Optionally inject synthetic entries into the registries
        original_handlers = mcp_handler.TOOL_HANDLERS.copy()
        original_scopes = mcp_handler.TOOL_SCOPE_REQUIREMENTS.copy()
        try:
            if handlers_extra:
                mcp_handler.TOOL_HANDLERS.update(handlers_extra)
            if scopes_extra:
                mcp_handler.TOOL_SCOPE_REQUIREMENTS.update(scopes_extra)
            return mcp_handler._handle_tools_call(
                req_id=1,
                params={"name": tool_name, "arguments": {}},
                token_info=token_info,
            )
        finally:
            # Restore originals so tests don't bleed into each other
            mcp_handler.TOOL_HANDLERS.clear()
            mcp_handler.TOOL_HANDLERS.update(original_handlers)
            mcp_handler.TOOL_SCOPE_REQUIREMENTS.clear()
            mcp_handler.TOOL_SCOPE_REQUIREMENTS.update(original_scopes)

    def test_every_registered_tool_has_scope_declaration(self):
        """TOOL_HANDLERS and TOOL_SCOPE_REQUIREMENTS must have identical keys.

        Adding a handler without a corresponding scope entry (or vice-versa)
        breaks this test, signalling the author that the table needs updating.
        """
        from mcp_handler import TOOL_HANDLERS, TOOL_SCOPE_REQUIREMENTS

        assert set(TOOL_HANDLERS.keys()) == set(TOOL_SCOPE_REQUIREMENTS.keys()), (
            "Mismatch between TOOL_HANDLERS and TOOL_SCOPE_REQUIREMENTS keys. "
            "Every handler must have a declared scope requirement and vice-versa."
        )

    def test_read_token_rejected_for_write_tool(self):
        """A read-scoped token must be rejected when calling a read-write tool.

        The write tool is registered inside the test so no production write
        tool needs to exist yet.  The scope guard must still fire.
        """
        write_handler = MagicMock(return_value=[{"type": "text", "text": "ok"}])
        result = self._call_tool(
            tool_name="fake_write_tool",
            token_scope="read",
            handlers_extra={"fake_write_tool": write_handler},
            scopes_extra={"fake_write_tool": "read-write"},
        )

        assert "error" in result, "Expected a JSON-RPC error response"
        # -32003 = Forbidden (scope insufficient); -32001 is reserved for Unauthorized (bad/missing token)
        assert result["error"]["code"] == -32003, (
            f"Expected -32003 (Forbidden) for scope failure, got {result['error']['code']}"
        )
        assert "Forbidden" in result["error"]["message"]
        # The handler must NOT have been called
        write_handler.assert_not_called()

    def test_read_write_token_allowed_for_read_tool(self):
        """A read-write token satisfies a read-scope requirement."""
        read_handler = MagicMock(return_value=[{"type": "text", "text": "ok"}])
        result = self._call_tool(
            tool_name="fake_read_tool",
            token_scope="read-write",
            handlers_extra={"fake_read_tool": read_handler},
            scopes_extra={"fake_read_tool": "read"},
        )

        # Should succeed
        assert "result" in result, f"Expected success, got: {result}"
        read_handler.assert_called_once()

    def test_read_token_allowed_for_read_tool(self):
        """A read-scoped token can call a read-scope tool."""
        read_handler = MagicMock(return_value=[{"type": "text", "text": "ok"}])
        result = self._call_tool(
            tool_name="fake_read_tool2",
            token_scope="read",
            handlers_extra={"fake_read_tool2": read_handler},
            scopes_extra={"fake_read_tool2": "read"},
        )

        assert "result" in result, f"Expected success, got: {result}"
        read_handler.assert_called_once()

    def test_tool_without_scope_declaration_is_rejected(self):
        """A handler that exists in TOOL_HANDLERS but not TOOL_SCOPE_REQUIREMENTS is rejected."""
        undeclared_handler = MagicMock(return_value=[{"type": "text", "text": "ok"}])
        result = self._call_tool(
            tool_name="undeclared_tool",
            token_scope="read-write",
            # inject handler but NOT into scopes
            handlers_extra={"undeclared_tool": undeclared_handler},
            scopes_extra={},  # no entry added
        )

        assert "error" in result, "Expected a JSON-RPC error for undeclared tool scope"
        undeclared_handler.assert_not_called()

    def test_scope_allows_helper(self):
        """Unit-test _scope_allows to cover all cases."""
        from mcp_handler import _scope_allows

        assert _scope_allows("read", "read") is True
        assert _scope_allows("read-write", "read") is True
        assert _scope_allows("read", "read-write") is False
        assert _scope_allows("read-write", "read-write") is True
        assert _scope_allows("", "read") is False
        assert _scope_allows("", "read-write") is False
        assert _scope_allows("read", "unknown") is False

    def test_unrecognised_required_scope_logs_error(self):
        """When TOOL_SCOPE_REQUIREMENTS contains an unrecognised value, _scope_allows
        logs at ERROR level so the misconfiguration is surfaced in logs rather than
        silently looking like a token permission problem.
        """
        import mcp_handler
        with patch("mcp_handler.logger") as mock_logger:
            result = mcp_handler._scope_allows("read-write", "write")  # "write" is not valid
            assert result is False
            assert mock_logger.error.called, (
                "_scope_allows must log at ERROR for an unrecognised required_scope value"
            )


# ===========================================================================
# 3. Partial-result reporting
# ===========================================================================

class TestPartialResultReporting:
    """get_metrics_summary sets is_partial=True and logs when any read fails."""

    @patch("mcp_handler.aggregates_table")
    def test_partial_read_sets_is_partial_flag(self, mock_table):
        """When the daily_total read raises, is_partial=True appears in the response.

        The sentiment counts (from successful reads) must still appear — the
        readable portion of the answer must not be lost.
        """
        call_count = 0

        def get_item_side_effect(Key, **kwargs):  # noqa: N803
            nonlocal call_count
            call_count += 1
            pk = Key.get("pk", "")
            if pk == "METRIC#daily_total":
                raise Exception("ProvisionedThroughputExceededException")
            # Sentiment reads return a small positive count
            return {"Item": {"count": 2}}

        mock_table.get_item.side_effect = get_item_side_effect
        mock_table.query.return_value = {"Items": []}

        from mcp_handler import _tool_get_metrics_summary
        content = _tool_get_metrics_summary({"days": 1}, {})

        assert len(content) == 1
        payload = json.loads(content[0]["text"])

        assert payload["is_partial"] is True, "is_partial must be True when a read fails"
        # Sentiment counts from the successful reads are still present
        assert payload["sentiment_breakdown"], "Successful sentiment reads must still be returned"

    @patch("mcp_handler.aggregates_table")
    def test_all_reads_succeed_is_partial_false(self, mock_table):
        """When all reads succeed, is_partial is False."""
        mock_table.get_item.return_value = {"Item": {"count": 5}}
        mock_table.query.return_value = {"Items": []}

        from mcp_handler import _tool_get_metrics_summary
        content = _tool_get_metrics_summary({"days": 1}, {})
        payload = json.loads(content[0]["text"])

        assert payload["is_partial"] is False

    @patch("mcp_handler.aggregates_table")
    def test_category_read_failure_sets_is_partial(self, mock_table):
        """When the category_breakdown query fails, is_partial=True."""
        mock_table.get_item.return_value = {"Item": {"count": 3}}
        mock_table.query.side_effect = Exception("ResourceNotFoundException")

        from mcp_handler import _tool_get_metrics_summary
        content = _tool_get_metrics_summary({"days": 1}, {})
        payload = json.loads(content[0]["text"])

        assert payload["is_partial"] is True
        # total_feedback still populated from the successful get_item calls
        assert payload["total_feedback"] == 3

    @patch("mcp_handler.aggregates_table")
    def test_is_partial_field_always_present(self, mock_table):
        """is_partial is always present in the response regardless of outcome."""
        mock_table.get_item.return_value = {}  # no Item
        mock_table.query.return_value = {"Items": []}

        from mcp_handler import _tool_get_metrics_summary
        content = _tool_get_metrics_summary({"days": 1}, {})
        payload = json.loads(content[0]["text"])

        assert "is_partial" in payload

    @patch("mcp_handler.aggregates_table")
    def test_partial_failure_logged_at_warning(self, mock_table):
        """A failed read is logged at WARNING level (not silently swallowed)."""
        mock_table.get_item.side_effect = Exception("Throttled")
        mock_table.query.return_value = {"Items": []}

        from mcp_handler import _tool_get_metrics_summary
        with patch("mcp_handler.logger") as mock_logger:
            _tool_get_metrics_summary({"days": 1}, {})
            assert mock_logger.warning.called, "Failure must be logged at WARNING level"

    @patch("mcp_handler.aggregates_table")
    def test_existing_fields_unchanged_when_partial(self, mock_table):
        """Existing response fields keep their meaning when is_partial=True.

        total_feedback, sentiment_breakdown, and top_categories are still
        present so a client that already reads total_feedback does not break.
        """
        call_count = 0

        def get_item_side_effect(Key, **kwargs):  # noqa: N803
            nonlocal call_count
            call_count += 1
            pk = Key.get("pk", "")
            if pk == "METRIC#daily_total":
                raise Exception("Throttled")
            return {"Item": {"count": 1}}

        mock_table.get_item.side_effect = get_item_side_effect
        mock_table.query.return_value = {"Items": []}

        from mcp_handler import _tool_get_metrics_summary
        content = _tool_get_metrics_summary({"days": 1}, {})
        payload = json.loads(content[0]["text"])

        assert "total_feedback" in payload
        assert "sentiment_breakdown" in payload
        assert "top_categories" in payload
        assert "period_days" in payload
