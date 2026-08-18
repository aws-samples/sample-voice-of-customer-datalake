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

    test_missing_scope_defaults_to_read
    — asserts a legacy token row with no `scope` attribute can still call a
      read tool.  Reverting DEFAULT_TOKEN_SCOPE (back to `.get('scope', '')`)
      makes this fail with -32003, which is the lockout this test guards.

    test_enforcement_default_matches_list_path_default
    — calls projects_handler.api_list_tokens with a scope-less row and compares
      its output to mcp_handler.DEFAULT_TOKEN_SCOPE.  Changing either file's
      default without the other fails this test; reformatting the literal does
      not (it is behavioural, not a source grep).

    test_empty_scope_string_resolves_to_the_default /
    test_empty_scope_string_still_rejected_for_write_tool
    — a present-but-empty scope is resolved like an absent one, and the fallback
      is still least-privilege.  Narrowing to `.get('scope', DEFAULT)` makes the
      first fail with the -32003 "token scope ''" it exists to prevent.

  auth-backend faults:
    test_authenticate_raises_on_permanent_dynamodb_error /
    test_permanent_auth_fault_surfaces_as_500_not_401
    — assert a permanent DynamoDB fault (missing table, AccessDenied) is a 500,
      not a 401 that blames the caller's token.  Reverting to a blanket
      `except Exception: return None` makes both fail.

    TestBotoCoreErrorHandling
    — BotoCoreError is a sibling of ClientError, not a subclass, so the family
      used to escape _authenticate: a 502 with no JSON-RPC envelope and no CORS
      headers.  Removing the `except BotoCoreError` clause fails these; so does
      collapsing it to a blanket `return None` (NoCredentialsError would be
      reported as a bad token).

    TestUnconfiguredTableIsAServerFault
    — an unset PROJECTS_TABLE answers 500 like a missing table resource, on both
      _authenticate call sites.  Reverting to `return None` fails these with 401.

    test_former_leaf_classes_are_still_transient /
    test_permanent_faults_are_not_caught_by_the_base_classes
    — _RETRYABLE_BOTOCORE_ERRORS names botocore's ConnectionError and
      HTTPClientError instead of four hand-listed leaves.  The first asserts no
      coverage was lost (every former leaf still matches by inheritance); the
      second asserts none was wrongly gained (NoCredentialsError and friends stay
      permanent).  The leaf enumeration missed SSLError, ProxyConnectionError,
      ResponseStreamingError and the two bases themselves, which answered 500 for
      a transient network fault — those now ride the transient parametrize list.

    TestUnclassifiedAuthFaultsAreServerErrors
    — makes the no-502-without-CORS property structural rather than per-family.
      ResponseParserError and a plain TypeError are neither ClientError nor
      BotoCoreError, so they escaped as a 502 with no envelope and no CORS
      headers.  Deleting the trailing `except Exception` fails these; changing it
      to `return None` fails them too (that is the original bug), and
      test_retryable_client_error_still_returns_401 fails if the catch-all is
      ordered ahead of the specific handlers.

  schema agreement:
    test_resolve_days_rejects_values_the_schema_forbids
    — `days` must be an integer by the tool's own inputSchema; `int(True) == 1`
      and `int(2.9) == 2` would answer a window the caller never asked for.

    test_resolve_days_falls_back_on_infinity /
    test_json_parsed_infinity_reports_the_default_window
    — `int(float('inf'))` raises OverflowError, not ValueError, so an infinite
      `days` bypassed the fallback and surfaced as an opaque error.  Reachable
      from plain JSON: both `1e400` and `Infinity` parse to `inf`.  Dropping
      OverflowError from the except tuple fails both.
"""

import json
import os
import sys
from unittest.mock import MagicMock, patch

import pytest
from botocore.exceptions import (
    ClientError,
    ConnectionClosedError,
    ConnectTimeoutError,
    EndpointConnectionError,
    NoCredentialsError,
    NoRegionError,
    ParamValidationError,
    ProxyConnectionError,
    ReadTimeoutError,
    ResponseStreamingError,
    SSLError,
)
# botocore names its own `ConnectionError`/`HTTPClientError`; imported via the
# module so `botocore_exceptions.ConnectionError` cannot be misread as the
# builtin, matching how mcp_handler refers to them.
from botocore import exceptions as botocore_exceptions
from botocore.parsers import ResponseParserError

# ---------------------------------------------------------------------------
# Ensure lambda/ and lambda/api/ are on the path (mirrors conftest.py)
# ---------------------------------------------------------------------------
_api_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_lambda_dir = os.path.dirname(_api_dir)
for _p in (_lambda_dir, _api_dir):
    if _p not in sys.path:
        sys.path.insert(0, _p)


def _client_error(code: str, operation: str = "Query") -> ClientError:
    """Build a botocore ClientError carrying the given DynamoDB error code."""
    return ClientError(
        {"Error": {"Code": code, "Message": code}},
        operation,
    )


def _make_event(token: str = "voc_testtoken", project_id: str = "proj-1") -> dict:
    """Build the minimal auth-header event _authenticate reads."""
    return {
        "headers": {
            "authorization": f"Bearer {token}",
            "x-project-id": project_id,
        }
    }


def _rpc_event() -> dict:
    """Build a full JSON-RPC tools/call event for the lambda_handler path."""
    return {
        "httpMethod": "POST",
        "path": "/v1/mcp",
        "headers": {
            "authorization": "Bearer voc_testtoken",
            "x-project-id": "proj-1",
        },
        "body": json.dumps({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "tools/call",
            "params": {"name": "get_project", "arguments": {}},
        }),
    }


# ===========================================================================
# 1. Constant-time token comparison
# ===========================================================================

class TestConstantTimeTokenComparison:
    """hmac.compare_digest must be called for every hash comparison in _authenticate."""

    # NOTE: `mcp_handler.hmac` is the shared stdlib module object from
    # sys.modules, so this patch replaces `hmac.compare_digest` *process-wide*
    # for the duration of the test — not just the handler's view of it.  That
    # is safe under serial execution (nothing else in this test calls it;
    # botocore's HMAC signing happens outside the mocked DynamoDB calls), but
    # it would affect any concurrent code that calls `hmac.compare_digest`
    # (e.g. under pytest-xdist, or a fixture that signs a real AWS request).
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
        result = _authenticate(_make_event("voc_testtoken"))

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
        result = _authenticate(_make_event("voc_testtoken", project_id="proj-1"))

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
        result = _authenticate(_make_event("voc_realtoken"))
        assert result is None

    @patch("mcp_handler.projects_table")
    def test_authenticate_returns_none_on_retryable_dynamodb_error(self, mock_table):
        """A throttle in the token-lookup path returns None (a clean 401), not a 500.

        A transient DynamoDB error must not propagate as an unhandled exception.
        The token may well be valid, so 401 + retry is an acceptable answer.
        """
        mock_table.query.side_effect = _client_error('ProvisionedThroughputExceededException')

        from mcp_handler import _authenticate
        result = _authenticate(_make_event("voc_testtoken"))

        assert result is None, "A retryable DynamoDB error must return None, not raise"

    @patch("mcp_handler.projects_table")
    def test_authenticate_raises_on_permanent_dynamodb_error(self, mock_table):
        """A permanent fault must NOT be reported as an authentication failure.

        A missing table or an IAM AccessDenied is a server-side configuration
        problem: the credential was never checked, so answering "your token is
        invalid" misdirects the operator into re-minting tokens.  _authenticate
        raises AuthBackendUnavailable so lambda_handler can answer 500.
        """
        import mcp_handler

        for code in ('ResourceNotFoundException', 'AccessDeniedException'):
            mock_table.query.side_effect = _client_error(code)
            with pytest.raises(mcp_handler.AuthBackendUnavailable):
                mcp_handler._authenticate(_make_event("voc_testtoken"))

    @patch("mcp_handler.projects_table")
    def test_permanent_auth_fault_surfaces_as_500_not_401(self, mock_table, lambda_context):
        """lambda_handler answers 500/-32603 (not 401/-32001) for a permanent fault."""
        mock_table.query.side_effect = _client_error('AccessDeniedException')

        import mcp_handler
        response = mcp_handler.lambda_handler(
            {
                "httpMethod": "POST",
                "path": "/v1/mcp",
                "headers": {
                    "authorization": "Bearer voc_testtoken",
                    "x-project-id": "proj-1",
                },
                "body": json.dumps({
                    "jsonrpc": "2.0",
                    "id": 1,
                    "method": "tools/call",
                    "params": {"name": "get_project", "arguments": {}},
                }),
            },
            lambda_context,
        )

        assert response["statusCode"] == 500, (
            f"A permanent token-store fault must not be a 401; got {response['statusCode']}"
        )
        body = json.loads(response["body"])
        assert body["error"]["code"] == -32603, (
            f"Expected -32603 (internal error), got {body['error']['code']}"
        )


# ===========================================================================
# 2. Scope enforcement
# ===========================================================================

_NO_SCOPE_KEY = object()  # sentinel: build token_info with no 'scope' key at all


class TestScopeEnforcement:
    """Dispatch is fail-closed: scope must be declared and satisfied."""

    def _call_tool(self, tool_name: str, token_scope: str, handlers_extra=None, scopes_extra=None):
        """Call _handle_tools_call with the given tool and token scope.

        ``token_scope=_NO_SCOPE_KEY`` builds a token_info with no ``scope`` key
        at all, reproducing a legacy row minted before the field existed.
        """
        import mcp_handler

        token_info = {"project_id": "proj-1"}
        if token_scope is not _NO_SCOPE_KEY:
            token_info["scope"] = token_scope

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
        """TOOL_HANDLERS, TOOL_SCOPE_REQUIREMENTS, and MCP_TOOLS must all have identical keys.

        Adding a handler without a corresponding scope entry (or vice-versa)
        breaks this test, signalling the author that the table needs updating.
        A tool in MCP_TOOLS without a handler returns -32602; a handler not in
        MCP_TOOLS is silently unreachable — both are caught here.
        """
        from mcp_handler import TOOL_HANDLERS, TOOL_SCOPE_REQUIREMENTS, MCP_TOOLS

        handler_keys = set(TOOL_HANDLERS.keys())
        scope_keys = set(TOOL_SCOPE_REQUIREMENTS.keys())
        mcp_names = {t['name'] for t in MCP_TOOLS}

        assert handler_keys == scope_keys, (
            "Mismatch between TOOL_HANDLERS and TOOL_SCOPE_REQUIREMENTS keys. "
            "Every handler must have a declared scope requirement and vice-versa."
        )
        assert mcp_names == handler_keys, (
            f"MCP_TOOLS names {mcp_names} must match TOOL_HANDLERS keys {handler_keys}. "
            "A tool in MCP_TOOLS without a handler causes -32602; a handler not in "
            "MCP_TOOLS is silently unreachable."
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

    def test_missing_scope_defaults_to_read(self):
        """A token row with NO `scope` attribute can still call a read tool.

        Legacy rows minted before the `scope` field existed have no such
        attribute.  The token *list* path (projects_handler.api_list_tokens)
        resolves a missing scope to 'read', so the MCP Access tab shows the row
        as a working read token.  Enforcement must agree, or a token the UI
        presents as usable is refused on every single call with a message that
        blames the caller ("token scope '' cannot call ...").

        Reverting DEFAULT_TOKEN_SCOPE (back to `token_info.get('scope', '')`)
        makes this test fail with -32003 — the lockout it guards against.
        """
        read_handler = MagicMock(return_value=[{"type": "text", "text": "ok"}])
        result = self._call_tool(
            tool_name="legacy_read_tool",
            token_scope=_NO_SCOPE_KEY,  # no 'scope' key at all
            handlers_extra={"legacy_read_tool": read_handler},
            scopes_extra={"legacy_read_tool": "read"},
        )

        assert "result" in result, (
            f"A scope-less legacy token must still satisfy a read tool, got: {result}"
        )
        read_handler.assert_called_once()

    def test_missing_scope_still_rejected_for_write_tool(self):
        """The 'read' default is least-privilege: it does not grant read-write.

        Defaulting a missing scope to 'read' must not silently escalate a legacy
        row into a read-write token.
        """
        write_handler = MagicMock(return_value=[{"type": "text", "text": "ok"}])
        result = self._call_tool(
            tool_name="legacy_write_tool",
            token_scope=_NO_SCOPE_KEY,
            handlers_extra={"legacy_write_tool": write_handler},
            scopes_extra={"legacy_write_tool": "read-write"},
        )

        assert result["error"]["code"] == -32003
        write_handler.assert_not_called()

    def test_empty_scope_string_resolves_to_the_default(self):
        """A present-but-empty `scope` is treated like an absent one, not like a value.

        `token_info.get('scope') or DEFAULT_TOKEN_SCOPE` covers both a missing key
        and a falsy value ('', None) on purpose: a partial write or a migration
        that stored '' is the same server-side data problem as a row minted before
        the field existed.  Resolving it to the default is what keeps the response
        from being "Forbidden: token scope ''" — a message that blames the caller
        for a row it can neither see nor fix.

        Reverting to `.get('scope', DEFAULT_TOKEN_SCOPE)` makes this fail with
        -32003, which is exactly the misdirection it guards.
        """
        read_handler = MagicMock(return_value=[{"type": "text", "text": "ok"}])
        result = self._call_tool(
            tool_name="blank_scope_read_tool",
            token_scope="",
            handlers_extra={"blank_scope_read_tool": read_handler},
            scopes_extra={"blank_scope_read_tool": "read"},
        )

        assert "result" in result, (
            f"An empty scope must resolve to the default, not be refused, got: {result}"
        )
        read_handler.assert_called_once()

    def test_empty_scope_string_still_rejected_for_write_tool(self):
        """Resolving '' to the default must not escalate it past least privilege.

        The refusal message names the resolved scope ('read'), not the raw '',
        so it does not read as a caller error about a value the caller never sent.
        """
        write_handler = MagicMock(return_value=[{"type": "text", "text": "ok"}])
        result = self._call_tool(
            tool_name="blank_scope_write_tool",
            token_scope="",
            handlers_extra={"blank_scope_write_tool": write_handler},
            scopes_extra={"blank_scope_write_tool": "read-write"},
        )

        assert result["error"]["code"] == -32003
        assert "scope ''" not in result["error"]["message"], (
            "The message must report the resolved scope, not the empty raw value; "
            f"got: {result['error']['message']}"
        )
        write_handler.assert_not_called()

    def test_enforcement_default_matches_list_path_default(self):
        """mcp_handler and projects_handler must agree on the missing-scope default.

        The MCP Access tab renders whatever projects_handler.api_list_tokens
        reports; enforcement uses mcp_handler.DEFAULT_TOKEN_SCOPE.  If the two
        drift, a token the UI displays as a working read token is refused on
        every call — or, worse, one displayed as read-only is enforced as
        something wider.  This is the only mechanical guarantee behind that
        agreement, so it is asserted on *behaviour*: the list path is called with
        a scope-less row and its output compared to the constant.

        Deliberately not `inspect.getsource`: matching the literal
        "'scope', 'read'" fails on a reformat to double quotes (claiming the
        default changed when it did not) and passes when the real default moves
        but a stale copy of the literal survives in a comment.
        """
        import mcp_handler
        import projects_handler

        table = MagicMock()
        # A legacy row: the keys the list path indexes directly, and no 'scope'.
        table.query.return_value = {
            "Items": [
                {
                    "token_id": "tok_legacy",
                    "name": "legacy token",
                    "created_at": "2024-01-01T00:00:00+00:00",
                }
            ]
        }

        with patch("projects_handler.get_projects_table", return_value=table):
            result = projects_handler.api_list_tokens("some-project")

        tokens = result["tokens"]
        assert len(tokens) == 1, f"Expected exactly one token in the list output, got: {tokens}"
        assert tokens[0]["scope"] == mcp_handler.DEFAULT_TOKEN_SCOPE, (
            "projects_handler.api_list_tokens reports a missing scope as "
            f"{tokens[0]['scope']!r} while enforcement assumes "
            f"{mcp_handler.DEFAULT_TOKEN_SCOPE!r}. A token shown as usable in the "
            "MCP Access tab would be refused on every call (or vice-versa) — bring "
            "the two back into agreement."
        )

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
        """An unrecognised required_scope value is an internal error (-32603), not -32003.

        A typo in TOOL_SCOPE_REQUIREMENTS ("write" instead of "read-write") is the
        same class of bug as omitting the entry entirely, which already returns
        -32603.  Returning -32003 Forbidden and naming the caller's scope would
        tell an operator holding the most-privileged token available that their
        token is insufficient — sending them to re-mint a token, which cannot
        help.  The message must not mention the caller's token scope.

        The log originates from _handle_tools_call (not the pure _scope_allows
        predicate) so that the tool name and scope value are available together.
        """
        bad_handler = MagicMock(return_value=[{"type": "text", "text": "ok"}])
        with patch("mcp_handler.logger") as mock_logger:
            result = self._call_tool(
                tool_name="misconfigured_tool",
                token_scope="read-write",
                handlers_extra={"misconfigured_tool": bad_handler},
                scopes_extra={"misconfigured_tool": "write"},  # "write" is not a valid scope
            )
            assert result["error"]["code"] == -32603, (
                "A misconfigured scope declaration is a server fault, expected -32603, "
                f"got {result['error']['code']}"
            )
            message = result["error"]["message"]
            assert "read-write" not in message and "Forbidden" not in message, (
                f"The message must not blame the caller's token scope; got: {message}"
            )
            assert "misconfigured_tool" in message
            assert mock_logger.error.called, (
                "_handle_tools_call must log at ERROR for an unrecognised required_scope value"
            )
        bad_handler.assert_not_called()


# ===========================================================================
# 3. Partial-result reporting
# ===========================================================================

# The four sentiment buckets get_metrics_summary reads per day.  Asserted as a
# set on the response payload rather than as a read count: the payload is the
# contract, so a batch_get_item rewrite that still returns all four passes,
# while three of the four reads quietly disappearing does not.
_ALL_SENTIMENTS = {"positive", "negative", "neutral", "mixed"}


class TestPartialResultReporting:
    """get_metrics_summary sets is_partial=True and logs when any read fails."""

    @patch("mcp_handler.aggregates_table")
    def test_partial_read_sets_is_partial_flag(self, mock_table):
        """When the daily_total read raises, is_partial=True appears in the response.

        The sentiment counts (from successful reads) must still appear — the
        readable portion of the answer must not be lost.

        The surviving reads are pinned on the *payload* rather than on a read
        count: every sentiment bucket must be present with the value its read
        returned, and the failed daily_total must contribute nothing.  That is
        read-strategy independent (a batch_get_item rewrite returning the same
        four buckets still passes) but not vacuous — a `>= 1` call-count check
        held even when three of the four sentiment reads were deleted.
        """
        def get_item_side_effect(Key, **kwargs):  # noqa: N803
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
        # Every sentiment bucket the tool claims to report is present, with the
        # value its read returned — not merely "some sentiment key survived".
        assert payload["sentiment_breakdown"] == dict.fromkeys(_ALL_SENTIMENTS, 2), (
            "every sentiment bucket must survive a daily_total failure; got "
            f"{payload['sentiment_breakdown']}"
        )
        # The failed read contributes nothing rather than a stale/invented total.
        assert payload["total_feedback"] == 0

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
    def test_totals_cover_every_day_in_the_window(self, mock_table):
        """period_days days of aggregates are summed, not just the latest day.

        Stated on the payload so it holds under any read strategy: with a
        uniform count of 5 per aggregate row, a 3-day window must report
        3 x 5 for the total and for each sentiment bucket.  Without this, a
        window that silently collapsed to a single day (or sentiment buckets
        that quietly stopped being read) still produced a well-shaped,
        is_partial=False answer that under-reported the period.
        """
        mock_table.get_item.return_value = {"Item": {"count": 5}}
        mock_table.query.return_value = {"Items": []}

        from mcp_handler import _tool_get_metrics_summary
        payload = json.loads(_tool_get_metrics_summary({"days": 3}, {})[0]["text"])

        assert payload["period_days"] == 3
        assert payload["is_partial"] is False
        assert payload["total_feedback"] == 15, (
            "a 3-day window must sum all 3 daily_total rows, got "
            f"{payload['total_feedback']} (1 day would be 5)"
        )
        assert payload["sentiment_breakdown"] == dict.fromkeys(_ALL_SENTIMENTS, 15), (
            "each sentiment bucket must accumulate across the whole window; got "
            f"{payload['sentiment_breakdown']}"
        )

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
        """A failed read is logged at WARNING level (not silently swallowed),
        and the WARNING log must not contain token or token_hash values.

        The docstring promises failures are logged "without any token or hash" —
        this test enforces that promise so a future refactor that accidentally
        adds a sensitive field trips CI immediately.  Both the `extra` dict and
        the positional message text are inspected: a hash interpolated into an
        f-string message would leak just as readily as one in `extra`.
        """
        mock_table.get_item.side_effect = Exception("Throttled")
        mock_table.query.return_value = {"Items": []}

        # A token_info carrying a recognisable secret; none of it may reach a log.
        token_info = {"project_id": "proj-1", "token_hash": "SENTINELHASH"}

        from mcp_handler import _tool_get_metrics_summary
        with patch("mcp_handler.logger") as mock_logger:
            _tool_get_metrics_summary({"days": 1}, token_info)
            assert mock_logger.warning.called, "Failure must be logged at WARNING level"
            for call in mock_logger.warning.call_args_list:
                extra = (call.kwargs or {}).get("extra", {})
                assert "token" not in extra and "token_hash" not in extra, (
                    f"WARNING log must not contain token/hash fields; extra={extra}"
                )
                rendered = " ".join(str(a) for a in call.args) + " " + str(extra)
                assert "SENTINELHASH" not in rendered, (
                    f"WARNING log must not contain the token hash; got: {rendered}"
                )

    @patch("mcp_handler.aggregates_table")
    def test_existing_fields_unchanged_when_partial(self, mock_table):
        """Existing response fields keep their meaning when is_partial=True.

        total_feedback, sentiment_breakdown, and top_categories are still
        present so a client that already reads total_feedback does not break.

        Presence is asserted on the payload, and sentiment_breakdown is checked
        to still be fully populated: "the field exists" alone would hold for an
        empty dict, which is a broken answer wearing the right shape.
        """
        def get_item_side_effect(Key, **kwargs):  # noqa: N803
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
        assert set(payload["sentiment_breakdown"]) == _ALL_SENTIMENTS, (
            "sentiment_breakdown must still carry every bucket when partial; got "
            f"{sorted(payload['sentiment_breakdown'])}"
        )

    @patch("mcp_handler.aggregates_table", None)
    def test_aggregates_table_not_configured_includes_is_partial(self):
        """When aggregates_table is None, the response includes is_partial=True
        and the full five-field payload shape with zeroed values.

        The docstring promises is_partial is always present in the response.
        The early-exit path must honour the full payload shape so clients can
        read total_feedback, period_days, sentiment_breakdown, and top_categories
        unconditionally without a KeyError.
        """
        from mcp_handler import _tool_get_metrics_summary
        content = _tool_get_metrics_summary({"days": 1}, {})
        assert len(content) == 1
        payload = json.loads(content[0]["text"])
        assert "is_partial" in payload, "is_partial must be present even on the early-exit path"
        assert payload["is_partial"] is True
        # All four normal-path fields must be present with zeroed/empty values
        assert "total_feedback" in payload, "total_feedback must be present on early-exit path"
        assert payload["total_feedback"] == 0
        assert "period_days" in payload, "period_days must be present on early-exit path"
        assert payload["period_days"] == 1  # from args
        assert "sentiment_breakdown" in payload, "sentiment_breakdown must be present on early-exit path"
        assert "top_categories" in payload, "top_categories must be present on early-exit path"

    @patch("mcp_handler.aggregates_table", None)
    def test_early_exit_period_days_is_clamped(self):
        """period_days is clamped identically on the early-exit and normal paths.

        Before this fix the early exit echoed the raw `args['days']`, so the same
        request reported period_days=999 when aggregates_table happened to be
        unconfigured and 30 otherwise — the field stopped describing the window.
        """
        from mcp_handler import _tool_get_metrics_summary
        payload = json.loads(_tool_get_metrics_summary({"days": 50}, {})[0]["text"])
        assert payload["period_days"] == 30, (
            f"days=50 must clamp to 30 on the early-exit path, got {payload['period_days']}"
        )

    @patch("mcp_handler.aggregates_table")
    def test_normal_path_period_days_is_clamped(self, mock_table):
        """The normal path clamps the same way, so the two agree."""
        mock_table.get_item.return_value = {}
        mock_table.query.return_value = {"Items": []}

        from mcp_handler import _tool_get_metrics_summary
        payload = json.loads(_tool_get_metrics_summary({"days": 50}, {})[0]["text"])
        assert payload["period_days"] == 30

    @patch("mcp_handler.aggregates_table", None)
    def test_early_exit_non_numeric_days_falls_back_to_default(self):
        """A non-numeric `days` is coerced, not echoed back verbatim.

        `period_days` is the only response field taken from caller input, so a
        client doing arithmetic on it must not receive a str.
        """
        from mcp_handler import _tool_get_metrics_summary
        payload = json.loads(_tool_get_metrics_summary({"days": "abc"}, {})[0]["text"])
        assert payload["period_days"] == 7, (
            f"A non-numeric days must fall back to 7, got {payload['period_days']!r}"
        )

    @patch("mcp_handler.aggregates_table")
    def test_normal_path_non_numeric_days_falls_back_to_default(self, mock_table):
        """The normal path also coerces rather than raising on a non-numeric days.

        Previously `min(args.get('days', 7), 30)` raised TypeError, which the
        _handle_tools_call catch-all turned into an opaque isError result.
        """
        mock_table.get_item.return_value = {}
        mock_table.query.return_value = {"Items": []}

        from mcp_handler import _tool_get_metrics_summary
        payload = json.loads(_tool_get_metrics_summary({"days": "abc"}, {})[0]["text"])
        assert payload["period_days"] == 7

    def test_resolve_days_helper(self):
        """Unit-test the coercion/clamping helper across its cases."""
        from mcp_handler import _resolve_days

        assert _resolve_days(None) == 7        # missing → default
        assert _resolve_days(1) == 1
        assert _resolve_days(30) == 30
        assert _resolve_days(999) == 30        # clamped down
        assert _resolve_days(0) == 1           # clamped up
        assert _resolve_days(-5) == 1
        assert _resolve_days("14") == 14       # numeric string coerced
        assert _resolve_days("abc") == 7       # non-numeric → default
        assert _resolve_days([1]) == 7         # wrong type → default

    def test_resolve_days_falls_back_on_infinity(self):
        """An infinite `days` falls back rather than raising.

        `int(float('inf'))` raises **OverflowError**, which is neither TypeError
        nor ValueError, so it was not caught: the documented "falls back rather
        than raising" contract did not hold for infinities.  This is reachable
        from a plain JSON body — `json` parses both `1e400` and the non-standard
        `Infinity` literal to `inf` — so the value arrives without the caller
        doing anything exotic.  `float('nan')` raises ValueError and was already
        covered; asserted here so the two stay distinguished.
        """
        from mcp_handler import _resolve_days

        assert _resolve_days(float("inf")) == 7, "+inf must fall back, not raise"
        assert _resolve_days(float("-inf")) == 7, "-inf must fall back, not raise"
        assert _resolve_days(float("nan")) == 7  # ValueError path, already covered

    def test_resolve_days_rejects_values_the_schema_forbids(self):
        """`days` values that are not integers per the tool's own inputSchema.

        `inputSchema` declares "integer", and JSON Schema counts neither a bool
        nor a fractional number as one — but Python does: `int(True) == 1` and
        `int(2.9) == 2`.  Coercing those answers a window the caller never asked
        for, so they fall back to the default instead.  An integral float (2.0)
        *is* an integer by the schema and is still accepted.
        """
        from mcp_handler import _resolve_days

        assert _resolve_days(True) == 7, "days=true is not an integer window of 1"
        assert _resolve_days(False) == 7
        assert _resolve_days(2.9) == 7, "a fractional days must not truncate to 2"
        assert _resolve_days(0.5) == 7
        assert _resolve_days(2.0) == 2, "an integral float is an integer per JSON Schema"
        # The tolerated case, kept deliberately: "14" can only mean 14.
        assert _resolve_days("14") == 14

    @patch("mcp_handler.aggregates_table")
    def test_json_parsed_infinity_reports_the_default_window(self, mock_table):
        """End-to-end from a real JSON body: `{"days": 1e400}` reports 7.

        Built by parsing JSON rather than passing `float('inf')` directly, so the
        test pins the path an actual client takes: `json` widens 1e400 to `inf`,
        `int(inf)` raises OverflowError, and without that in the except tuple the
        fault reached the _handle_tools_call catch-all and came back as an opaque
        isError result instead of the documented 7-day default.
        """
        mock_table.get_item.return_value = {}
        mock_table.query.return_value = {"Items": []}

        args = json.loads('{"days": 1e400}')
        assert args["days"] == float("inf"), "json must widen 1e400 to inf for this test to bite"

        from mcp_handler import _tool_get_metrics_summary
        payload = json.loads(_tool_get_metrics_summary(args, {})[0]["text"])
        assert payload["period_days"] == 7, (
            f"days=1e400 must report the default window, got {payload['period_days']!r}"
        )

    @patch("mcp_handler.aggregates_table", None)
    def test_bool_days_reported_as_the_default_window(self):
        """The rejection is visible end-to-end: period_days echoes 7, not 1."""
        from mcp_handler import _tool_get_metrics_summary
        payload = json.loads(_tool_get_metrics_summary({"days": True}, {})[0]["text"])
        assert payload["period_days"] == 7, (
            f"days=true must report the default window, got {payload['period_days']!r}"
        )


# ===========================================================================
# 4. Non-string token_hash type safety
# ===========================================================================

class TestTokenHashTypeSafety:
    """_authenticate must not raise when a DynamoDB row has a non-str token_hash."""

    @patch("mcp_handler.projects_table")
    def test_non_string_token_hash_skipped(self, mock_table):
        """A DynamoDB item with a non-str token_hash is skipped, not raised.

        A malformed/migrated row (e.g. token_hash stored as Binary or Decimal)
        must not cause an AttributeError that propagates out of _authenticate
        and turns a single bad row into a 500 for every request in that project.
        """
        from decimal import Decimal
        # Row 1: non-string hash (simulates a malformed/migrated row)
        # Row 2: correct string hash that won't match (so _authenticate returns None)
        mock_table.query.return_value = {
            "Items": [
                {"sk": "TOKEN#1", "token_hash": Decimal("12345"), "scope": "read"},
                {"sk": "TOKEN#2", "token_hash": b"binary_bytes", "scope": "read"},
                {"sk": "TOKEN#3", "token_hash": "correcthash_that_wont_match", "scope": "read"},
            ]
        }

        from mcp_handler import _authenticate
        # Must return None without raising
        result = _authenticate(_make_event("voc_testtoken"))
        assert result is None, "Non-string token_hash must not raise; should return None"

    @patch("mcp_handler.projects_table")
    def test_non_string_token_hash_logs_warning(self, mock_table):
        """A non-str token_hash row triggers a WARNING log with the type name, not the value."""
        from decimal import Decimal
        mock_table.query.return_value = {
            "Items": [
                {"sk": "TOKEN#1", "token_hash": Decimal("99"), "scope": "read"},
            ]
        }

        from mcp_handler import _authenticate
        with patch("mcp_handler.logger") as mock_logger:
            _authenticate(_make_event("voc_testtoken"))
            assert mock_logger.warning.called, "A non-str token_hash must trigger a WARNING log"
            # The log must include the type name but NOT the value itself
            call_kwargs = mock_logger.warning.call_args
            extra = call_kwargs[1].get("extra", {}) if call_kwargs[1] else {}
            assert "type" in extra, "WARNING extra must include 'type' (the type name)"


# ===========================================================================
# 5. Auth-backend faults that are not ClientError
# ===========================================================================

_ENDPOINT = "https://dynamodb.us-east-1.amazonaws.com"

# The four leaves _RETRYABLE_BOTOCORE_ERRORS used to enumerate by name.  Kept as
# a named list so the no-coverage-lost property is asserted explicitly: the tuple
# now names the two base classes instead, and every one of these must still be
# classified transient by inheritance.
_FORMER_TRANSIENT_LEAVES = [
    pytest.param(EndpointConnectionError(endpoint_url=_ENDPOINT), id="EndpointConnectionError"),
    pytest.param(ConnectTimeoutError(endpoint_url=_ENDPOINT), id="ConnectTimeoutError"),
    pytest.param(ReadTimeoutError(endpoint_url=_ENDPOINT), id="ReadTimeoutError"),
    pytest.param(ConnectionClosedError(endpoint_url=_ENDPOINT), id="ConnectionClosedError"),
]

# Transient types the leaf enumeration MISSED.  Each is a subclass of
# botocore's ConnectionError or HTTPClientError but of none of the four leaves
# above, so before the tuple named the bases every one of these fell through to
# the permanent branch and answered 500 for a transient network fault.
#
# Constructor signatures differ per class — botocore formats `fmt` from the
# kwargs, and a missing one raises KeyError at construction — so the arguments
# here are per-class, not a shared shape.
_NEWLY_TRANSIENT_BOTOCORE = [
    pytest.param(SSLError(endpoint_url=_ENDPOINT, error="certificate verify failed"), id="SSLError"),
    pytest.param(ProxyConnectionError(proxy_url="http://proxy.internal:8080"), id="ProxyConnectionError"),
    pytest.param(ResponseStreamingError(error="connection reset mid-body"), id="ResponseStreamingError"),
    # The bases themselves were not covered by an enumeration of their own leaves.
    pytest.param(botocore_exceptions.ConnectionError(error="could not connect"), id="ConnectionError"),
    pytest.param(botocore_exceptions.HTTPClientError(error="unhandled client fault"), id="HTTPClientError"),
]

# The transient half of the BotoCoreError family: a connection or timeout fault
# behaves like a throttle, so the token may well be valid.
_TRANSIENT_BOTOCORE = _FORMER_TRANSIENT_LEAVES + _NEWLY_TRANSIENT_BOTOCORE

# The permanent half: configuration faults.  Re-minting a token cannot fix any
# of these, so they must not be reported as an authentication failure.
_PERMANENT_BOTOCORE = [
    pytest.param(NoCredentialsError(), id="NoCredentialsError"),
    pytest.param(NoRegionError(), id="NoRegionError"),
    pytest.param(ParamValidationError(report="bad parameter"), id="ParamValidationError"),
]


class TestBotoCoreErrorHandling:
    """BotoCoreError is a *sibling* of ClientError, not a subclass.

    Without a clause of its own the whole family escaped _authenticate, so
    API Gateway answered 502 with no JSON-RPC envelope and no CORS headers —
    a browser-based MCP client could only see an opaque CORS failure, with
    nothing parseable to tell it what went wrong.  EndpointConnectionError and
    ReadTimeoutError are the most common transient DynamoDB faults after
    throttles, so this was the ordinary failure mode, not an exotic one.

    The family is split the same way ClientError already was, because it spans
    both fault classes.  A blanket `except BotoCoreError: return None` would
    report NoCredentialsError — a pure configuration fault — as "your token is
    invalid", which is the misdirection AuthBackendUnavailable exists to remove.
    """

    @pytest.mark.parametrize("exc", _TRANSIENT_BOTOCORE)
    @patch("mcp_handler.projects_table")
    def test_transient_botocore_error_returns_none(self, mock_table, exc):
        """A connection/timeout fault returns None (a clean 401), not an escape."""
        mock_table.query.side_effect = exc

        from mcp_handler import _authenticate
        assert _authenticate(_make_event()) is None, (
            f"{type(exc).__name__} must be handled like a throttle, not propagate"
        )

    @pytest.mark.parametrize("exc", _FORMER_TRANSIENT_LEAVES)
    def test_former_leaf_classes_are_still_transient(self, exc):
        """No coverage was LOST when the tuple moved from leaves to base classes.

        _RETRYABLE_BOTOCORE_ERRORS used to enumerate these four by name and now
        names botocore's ConnectionError and HTTPClientError instead.  That is
        only safe if each former leaf is still matched, by inheritance — asserted
        here against the tuple directly, so the property holds even if the
        end-to-end tests above were to change shape.
        """
        from mcp_handler import _RETRYABLE_BOTOCORE_ERRORS

        assert isinstance(exc, _RETRYABLE_BOTOCORE_ERRORS), (
            f"{type(exc).__name__} was transient under the leaf enumeration and "
            "must remain transient under the base classes"
        )

    @pytest.mark.parametrize("exc", _PERMANENT_BOTOCORE)
    def test_permanent_faults_are_not_caught_by_the_base_classes(self, exc):
        """Widening to the bases must not reclassify a configuration fault.

        The counterpart to the test above: naming two base classes is only safe
        if it did not quietly swallow NoCredentialsError, NoRegionError or
        ParamValidationError into the transient branch, which would answer 401
        ("your token is invalid") for a fault re-minting cannot fix.
        """
        from mcp_handler import _RETRYABLE_BOTOCORE_ERRORS

        assert not isinstance(exc, _RETRYABLE_BOTOCORE_ERRORS), (
            f"{type(exc).__name__} is a configuration fault and must stay permanent"
        )

    @pytest.mark.parametrize("exc", _PERMANENT_BOTOCORE)
    @patch("mcp_handler.projects_table")
    def test_permanent_botocore_error_raises_auth_backend_unavailable(self, mock_table, exc):
        """A configuration fault raises rather than returning None.

        This is the assertion that rules out a blanket
        `except BotoCoreError: return None`: absent credentials or a missing
        region never checked the credential, so 401 is a lie.
        """
        import mcp_handler

        mock_table.query.side_effect = exc
        with pytest.raises(mcp_handler.AuthBackendUnavailable):
            mcp_handler._authenticate(_make_event())

    @patch("mcp_handler.projects_table")
    def test_permanent_botocore_fault_surfaces_as_500_with_json_rpc_envelope(
        self, mock_table, lambda_context
    ):
        """End-to-end: 500/-32603 *with* CORS headers and a parseable body.

        The 502-with-no-envelope outcome is the defect; asserting the status code
        alone would not catch a response that carried no CORS headers, which is
        all a browser client can observe.
        """
        mock_table.query.side_effect = NoCredentialsError()

        import mcp_handler
        response = mcp_handler.lambda_handler(_rpc_event(), lambda_context)

        assert response["statusCode"] == 500
        assert response["headers"]["Access-Control-Allow-Origin"] == "*", (
            "A browser MCP client sees only a CORS failure without this header"
        )
        body = json.loads(response["body"])
        assert body["jsonrpc"] == "2.0"
        assert body["error"]["code"] == -32603, (
            f"Expected -32603 (internal error), got {body['error']['code']}"
        )

    @patch("mcp_handler.projects_table")
    def test_transient_botocore_fault_surfaces_as_401_with_json_rpc_envelope(
        self, mock_table, lambda_context
    ):
        """A transient fault is a 401 the client can retry — still enveloped."""
        mock_table.query.side_effect = EndpointConnectionError(endpoint_url=_ENDPOINT)

        import mcp_handler
        response = mcp_handler.lambda_handler(_rpc_event(), lambda_context)

        assert response["statusCode"] == 401
        assert response["headers"]["Access-Control-Allow-Origin"] == "*"
        assert json.loads(response["body"])["error"]["code"] == -32001

    @patch("mcp_handler.projects_table")
    def test_server_fault_detail_never_reaches_the_client(self, mock_table, lambda_context):
        """The -32603 body carries a fixed message, never the exception detail.

        Both call sites answer with a literal ("token store unavailable"), and
        the fault detail goes to the log instead.  That split is a deliberate
        no-disclosure boundary on an *unauthenticated* path: this request never
        presented a valid credential, so anything echoed here is readable by
        anyone who can reach the endpoint.

        There are two layers, and this pins the outer one.  `_authenticate`
        already sanitises at the raise site — `AuthBackendUnavailable` is
        constructed with `type(exc).__name__`, so a botocore report never
        travels with it.  What *can* still travel is the class name
        ("ParamValidationError", "NoCredentialsError" — which names the
        credential subsystem), and an `f"Internal error: {exc}"` at either call
        site would publish it.  This asserts the response body carries neither.

        Unguarded before this test.  The class-name assertion is the load-bearing
        one: verified by mutating both call sites to interpolate the exception,
        which fails this test.  The sentinel assertion is defence in depth and
        would hold even if the raise site stopped sanitising.  The log side is
        asserted too — "absent from the body" alone would also be satisfied by a
        fault that was swallowed entirely.
        """
        sentinel = "SENTINEL_INTERNAL_DETAIL"
        mock_table.query.side_effect = ParamValidationError(report=sentinel)

        import mcp_handler
        with patch("mcp_handler.logger") as mock_logger:
            response = mcp_handler.lambda_handler(_rpc_event(), lambda_context)

            assert response["statusCode"] == 500
            body = response["body"]
            assert json.loads(body)["error"]["code"] == -32603
            # The botocore report is dropped at the raise site, so it could not
            # reach here even via an interpolated message.  The *class name* can,
            # and is what an f-string on the exception would expose.
            assert "ParamValidationError" not in body, (
                "The fault's class name must not reach an unauthenticated caller; "
                f"body was: {body}"
            )
            assert sentinel not in body, (
                "Defence in depth: the botocore report must not appear either; "
                f"body was: {body}"
            )

            # Positive control: the detail must still be recorded server-side,
            # or "absent from the body" would also hold for a fault that was
            # swallowed entirely.
            logged = " ".join(
                str(c.args) + str((c.kwargs or {}).get("extra", ""))
                for c in mock_logger.exception.call_args_list
            )
            assert "ParamValidationError" in logged, (
                "The fault must be logged for an operator, not merely hidden from "
                f"the client; exception() calls were: {logged}"
            )

    @pytest.mark.parametrize("exc", _TRANSIENT_BOTOCORE + _PERMANENT_BOTOCORE)
    @patch("mcp_handler.projects_table")
    def test_botocore_logs_carry_no_token_material(self, mock_table, exc):
        """Only the exception *type* is logged — never the token or its hash.

        The Bearer token is a recognisable sentinel here, so an f-string or an
        `extra` field that interpolated it would trip this immediately.
        """
        import mcp_handler

        mock_table.query.side_effect = exc
        event = _make_event(token="voc_SENTINELTOKEN")

        with patch("mcp_handler.logger") as mock_logger:
            try:
                mcp_handler._authenticate(event)
            except mcp_handler.AuthBackendUnavailable:
                pass

            calls = mock_logger.warning.call_args_list + mock_logger.exception.call_args_list
            assert calls, f"{type(exc).__name__} must be logged"
            for call in calls:
                extra = (call.kwargs or {}).get("extra", {})
                rendered = " ".join(str(a) for a in call.args) + " " + str(extra)
                assert "SENTINELTOKEN" not in rendered, (
                    f"Log must not contain token material; got: {rendered}"
                )
                assert "token_hash" not in extra, f"Log extra must not carry a hash; got: {extra}"


# ===========================================================================
# 5b. Auth-backend faults that are neither ClientError nor BotoCoreError
# ===========================================================================

# Faults out of projects_table.query that belong to neither handled family, so
# before the trailing `except Exception` they escaped _authenticate outright.
_UNCLASSIFIED_AUTH_FAULTS = [
    # A malformed/truncated service response — botocore.parsers.ResponseParserError
    # descends from Exception, not BotoCoreError and not ClientError.
    pytest.param(ResponseParserError("Unable to parse response"), id="ResponseParserError"),
    # The DynamoDB serializer raises a plain TypeError on a key it cannot encode.
    pytest.param(TypeError("Float types are not supported"), id="TypeError"),
]


class TestUnclassifiedAuthFaultsAreServerErrors:
    """The no-502-without-CORS property, made structural rather than per-family.

    Adding `except BotoCoreError` closed one hole by name.  Anything outside both
    handled families still escaped and produced exactly the defect that clause
    existed to prevent: an API Gateway 502 with no JSON-RPC envelope and no CORS
    headers, which a browser MCP client can only surface as an opaque CORS error.
    A trailing `except Exception` closes the property for good.

    The clause RAISES rather than returning None, and that is the load-bearing
    part.  This guard was once `except Exception: return None`, and that was the
    bug being fixed: a configuration fault reported as "your token is invalid".
    An unrecognised fault means the credential was never compared, so 500 is the
    only honest answer.  test_retryable_client_error_still_returns_401 pins the
    other side — the catch-all must not shadow the specific handlers above it.
    """

    @pytest.mark.parametrize("exc", _UNCLASSIFIED_AUTH_FAULTS)
    @patch("mcp_handler.projects_table")
    def test_unclassified_fault_raises_auth_backend_unavailable(self, mock_table, exc):
        """Neither family matches, so the catch-all must raise — never return None.

        `return None` here would be the reintroduced bug: a 401 telling the
        caller its token is bad when the token was never even compared.
        """
        import mcp_handler

        mock_table.query.side_effect = exc
        with pytest.raises(mcp_handler.AuthBackendUnavailable):
            mcp_handler._authenticate(_make_event())

    @pytest.mark.parametrize("exc", _UNCLASSIFIED_AUTH_FAULTS)
    @patch("mcp_handler.projects_table")
    def test_unclassified_fault_answers_500_with_cors_headers(
        self, mock_table, exc, lambda_context
    ):
        """End-to-end: 500/-32603 *with* CORS headers and a parseable envelope.

        The CORS assertion is not decoration.  A 500 carrying no
        Access-Control-Allow-Origin is indistinguishable from the 502 defect to a
        browser client — both arrive as an opaque CORS failure with nothing
        parseable in the body — so asserting the status code alone would let the
        defect back in.
        """
        mock_table.query.side_effect = exc

        import mcp_handler
        response = mcp_handler.lambda_handler(_rpc_event(), lambda_context)

        assert response["statusCode"] == 500, (
            f"{type(exc).__name__} must not escape as a 502; got {response['statusCode']}"
        )
        assert response["headers"]["Access-Control-Allow-Origin"] == "*", (
            "A 500 without this header is indistinguishable from the 502 defect "
            "to a browser MCP client"
        )
        body = json.loads(response["body"])
        assert body["jsonrpc"] == "2.0"
        assert body["error"]["code"] == -32603, (
            f"Expected -32603 (internal error), got {body['error']['code']}"
        )

    @pytest.mark.parametrize("exc", _UNCLASSIFIED_AUTH_FAULTS)
    @patch("mcp_handler.projects_table")
    def test_unclassified_fault_is_logged_with_its_type(self, mock_table, exc):
        """The fault reaches an operator, and only its type — never token material."""
        import mcp_handler

        mock_table.query.side_effect = exc
        with patch("mcp_handler.logger") as mock_logger:
            with pytest.raises(mcp_handler.AuthBackendUnavailable):
                mcp_handler._authenticate(_make_event(token="voc_SENTINELTOKEN"))

            calls = mock_logger.exception.call_args_list
            assert calls, f"{type(exc).__name__} must be logged for an operator"
            rendered = " ".join(
                str(c.args) + str((c.kwargs or {}).get("extra", "")) for c in calls
            )
            assert type(exc).__name__ in rendered, (
                f"The log must name the fault type; got: {rendered}"
            )
            assert "SENTINELTOKEN" not in rendered, (
                f"Log must not contain token material; got: {rendered}"
            )

    @patch("mcp_handler.projects_table")
    def test_retryable_client_error_still_returns_401(self, mock_table):
        """Clause ordering: the specific handlers still win over the catch-all.

        A throttle is a ClientError, which is also an Exception.  If the
        catch-all were ordered first (or the ClientError clause removed) this
        would raise AuthBackendUnavailable and a retryable throttle would become
        a 500 instead of a retryable 401.
        """
        mock_table.query.side_effect = _client_error("ThrottlingException")

        from mcp_handler import _authenticate
        assert _authenticate(_make_event()) is None, (
            "A retryable ClientError must still be handled as a transient 401, "
            "not swallowed by the trailing except Exception"
        )

    @patch("mcp_handler.projects_table")
    def test_transient_botocore_error_still_returns_401(self, mock_table):
        """Same ordering property for the BotoCoreError clause."""
        mock_table.query.side_effect = SSLError(
            endpoint_url=_ENDPOINT, error="certificate verify failed"
        )

        from mcp_handler import _authenticate
        assert _authenticate(_make_event()) is None, (
            "A transient BotoCoreError must still be handled as a 401, not "
            "swallowed by the trailing except Exception"
        )

    @patch("mcp_handler.projects_table")
    def test_permanent_client_error_still_raises(self, mock_table):
        """And a permanent ClientError keeps its own 500 path."""
        import mcp_handler

        mock_table.query.side_effect = _client_error("AccessDeniedException")
        with pytest.raises(mcp_handler.AuthBackendUnavailable):
            mcp_handler._authenticate(_make_event())


# ===========================================================================
# 6. An unconfigured projects table is a server fault, not a bad credential
# ===========================================================================

class TestUnconfiguredTableIsAServerFault:
    """A missing table *env var* must answer the same way as a missing table
    *resource*.

    `if not projects_table: return None` gave 401 for an unset PROJECTS_TABLE
    while ResourceNotFoundException gave 500 — the credential was never checked
    in either case.  The 401 is the expensive one: it sends an operator off to
    re-mint tokens for what is a deployment problem.
    """

    @patch("mcp_handler.projects_table", None)
    def test_authenticate_raises_when_table_unconfigured(self):
        import mcp_handler

        with pytest.raises(mcp_handler.AuthBackendUnavailable):
            mcp_handler._authenticate(_make_event())

    @patch("mcp_handler.projects_table", None)
    def test_unconfigured_table_surfaces_as_500_not_401(self, lambda_context):
        """The JSON-RPC path answers 500/-32603, matching the missing-resource case."""
        import mcp_handler

        response = mcp_handler.lambda_handler(
            {
                "httpMethod": "POST",
                "path": "/v1/mcp",
                "headers": {
                    "authorization": "Bearer voc_testtoken",
                    "x-project-id": "proj-1",
                },
                "body": json.dumps({
                    "jsonrpc": "2.0",
                    "id": 1,
                    "method": "tools/list",
                    "params": {},
                }),
            },
            lambda_context,
        )

        assert response["statusCode"] == 500, (
            "An unset PROJECTS_TABLE must not be reported as a bad token; got "
            f"{response['statusCode']}"
        )
        assert json.loads(response["body"])["error"]["code"] == -32603

    @patch("mcp_handler.projects_table", None)
    def test_autoseed_path_also_answers_500(self, lambda_context):
        """The second _authenticate call site handles the raise as well.

        A raise that escapes here would be a 502 with no CORS headers, so both
        call sites are pinned rather than just the JSON-RPC one.
        """
        import mcp_handler

        response = mcp_handler.lambda_handler(
            {
                "httpMethod": "GET",
                "path": "/v1/mcp/autoseed/proj-1",
                "headers": {
                    "authorization": "Bearer voc_testtoken",
                    "x-project-id": "proj-1",
                },
            },
            lambda_context,
        )

        assert response["statusCode"] == 500
        assert response["headers"]["Access-Control-Allow-Origin"] == "*"


# ===========================================================================
# Origin validation (MCP transport DNS-rebinding guard)
# ===========================================================================

class TestOriginValidation:
    """A present, foreign Origin is refused 403 before anything else runs.

    The MCP Streamable HTTP transport REQUIRES this: without it a malicious
    page can use DNS rebinding to drive a victim's browser against this
    endpoint.  Real MCP clients are not browsers and send no Origin header,
    so the guard must be a no-op for them.

    Revert stories:
      - deleting the lambda_handler guard fails every 403 assertion here;
      - moving the guard AFTER authentication fails
        test_foreign_origin_never_reaches_the_token_store, which is the
        difference between "refused" and "refused after a free probe".
    """

    def _initialize_event(self, origin: str | None) -> dict:
        headers = {}
        if origin is not None:
            headers["Origin"] = origin
        return {
            "httpMethod": "POST",
            "path": "/v1/mcp",
            "headers": headers,
            "body": json.dumps({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}}),
        }

    @patch("mcp_handler.ALLOWED_ORIGIN", "https://voc.example.com")
    def test_absent_origin_passes(self, lambda_context):
        """No Origin header — every real MCP client — is untouched by the guard."""
        import mcp_handler
        response = mcp_handler.lambda_handler(self._initialize_event(None), lambda_context)
        assert response["statusCode"] == 200
        assert "result" in json.loads(response["body"])

    @patch("mcp_handler.ALLOWED_ORIGIN", "https://voc.example.com")
    def test_matching_origin_passes(self, lambda_context):
        import mcp_handler
        response = mcp_handler.lambda_handler(
            self._initialize_event("https://voc.example.com"), lambda_context
        )
        assert response["statusCode"] == 200

    @patch("mcp_handler.ALLOWED_ORIGIN", "https://voc.example.com")
    def test_foreign_origin_refused_403(self, lambda_context):
        """Present-and-wrong Origin → 403, with a JSON-RPC envelope and CORS headers."""
        import mcp_handler
        response = mcp_handler.lambda_handler(
            self._initialize_event("https://evil.example.net"), lambda_context
        )
        assert response["statusCode"] == 403
        body = json.loads(response["body"])
        assert body["error"]["code"] == -32600
        assert response["headers"]["Access-Control-Allow-Origin"] == "*"

    @patch("mcp_handler.ALLOWED_ORIGIN", "https://voc.example.com")
    def test_lowercase_origin_header_is_also_checked(self, lambda_context):
        """API Gateway lowercases header names in proxy mode; the guard must too."""
        import mcp_handler
        event = self._initialize_event(None)
        event["headers"]["origin"] = "https://evil.example.net"
        response = mcp_handler.lambda_handler(event, lambda_context)
        assert response["statusCode"] == 403

    @patch("mcp_handler.ALLOWED_ORIGIN", "*")
    def test_wildcard_config_disables_the_guard(self, lambda_context):
        """Dev deployments set ALLOWED_ORIGIN='*'; any Origin then passes."""
        import mcp_handler
        response = mcp_handler.lambda_handler(
            self._initialize_event("http://localhost:5173"), lambda_context
        )
        assert response["statusCode"] == 200

    @patch("mcp_handler.projects_table")
    @patch("mcp_handler.ALLOWED_ORIGIN", "https://voc.example.com")
    def test_foreign_origin_never_reaches_the_token_store(self, mock_table, lambda_context):
        """The guard runs BEFORE _authenticate: a rebound page gets no free probe.

        Asserted on the table mock, not on the status code — a 403 issued after
        the token query would pass a status-only assertion while still letting
        the attacker measure the auth path.
        """
        import mcp_handler
        event = _rpc_event()
        event["headers"]["Origin"] = "https://evil.example.net"
        response = mcp_handler.lambda_handler(event, lambda_context)
        assert response["statusCode"] == 403
        mock_table.query.assert_not_called()


# ===========================================================================
# WWW-Authenticate challenge on 401 (RFC 6750 §3)
# ===========================================================================

class TestWwwAuthenticateChallenge:
    """Every 401 carries a Bearer challenge; successful responses carry none.

    The challenge is attached inside _cors_response — the one choke point all
    responses pass through — so a future 401 path cannot forget it.  Reverting
    that placement (re-attaching it per call site) is caught by the autoseed
    test below the moment any site is missed.
    """

    @patch("mcp_handler.projects_table")
    def test_invalid_token_401_carries_bearer_challenge(self, mock_table, lambda_context):
        import mcp_handler
        mock_table.query.return_value = {"Items": []}
        response = mcp_handler.lambda_handler(_rpc_event(), lambda_context)
        assert response["statusCode"] == 401
        assert response["headers"]["WWW-Authenticate"].startswith("Bearer ")

    @patch("mcp_handler.projects_table")
    def test_autoseed_401_carries_the_same_challenge(self, mock_table, lambda_context):
        """The REST side-door 401s through the same choke point."""
        import mcp_handler
        mock_table.query.return_value = {"Items": []}
        response = mcp_handler.lambda_handler(
            {
                "httpMethod": "GET",
                "path": "/v1/mcp/autoseed/proj-1",
                "headers": {"authorization": "Bearer voc_testtoken"},
            },
            lambda_context,
        )
        assert response["statusCode"] == 401
        assert response["headers"]["WWW-Authenticate"].startswith("Bearer ")

    def test_success_carries_no_challenge(self, lambda_context):
        """A 200 must not advertise an auth failure."""
        import mcp_handler
        response = mcp_handler.lambda_handler(
            {
                "httpMethod": "POST",
                "path": "/v1/mcp",
                "headers": {},
                "body": json.dumps(
                    {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}}
                ),
            },
            lambda_context,
        )
        assert response["statusCode"] == 200
        assert "WWW-Authenticate" not in response["headers"]


# ===========================================================================
# Token expiry (enforced in the credential check, not by DynamoDB TTL)
# ===========================================================================

class TestTokenExpiry:
    """expires_at is compared at auth time; a TTL alone is not expiry.

    DynamoDB TTL deletion is eventual (up to ~48 h), so enforcement lives in
    _credential_expired on the MATCHED row.  Revert stories:
      - deleting the _credential_expired call in _authenticate fails
        test_expired_token_is_refused_401;
      - turning the malformed-value branch into `return False` (fail-open)
        fails test_malformed_expires_at_fails_closed — an unreadable expiry
        must not become an unlimited one.
    """

    def _row(self, **extra) -> dict:
        from shared.tokens import hash_token
        return {
            "sk": "TOKEN#1",
            "token_id": "tok_1",
            "token_hash": hash_token("voc_testtoken"),
            "scope": "read",
            **extra,
        }

    def _auth(self, row: dict):
        """Run _authenticate against a single stored row; return its result."""
        import mcp_handler
        with patch("mcp_handler.projects_table") as mock_table:
            mock_table.query.return_value = {"Items": [row]}
            mock_table.update_item.return_value = {}
            return mcp_handler._authenticate(_make_event())

    def test_absent_expires_at_authenticates(self):
        """Every row minted before the field existed keeps working."""
        assert self._auth(self._row()) is not None

    def test_empty_expires_at_authenticates(self):
        """A falsy value means non-expiring, matching the scope field's falsy rule."""
        assert self._auth(self._row(expires_at="")) is not None

    def test_future_expires_at_authenticates(self):
        from datetime import datetime, timedelta, timezone
        future = (datetime.now(timezone.utc) + timedelta(days=1)).isoformat()
        assert self._auth(self._row(expires_at=future)) is not None

    def test_past_expires_at_is_refused(self):
        from datetime import datetime, timedelta, timezone
        past = (datetime.now(timezone.utc) - timedelta(seconds=1)).isoformat()
        assert self._auth(self._row(expires_at=past)) is None

    def test_expired_token_is_refused_401(self, lambda_context):
        """End to end: the expired credential answers 401, not 500."""
        from datetime import datetime, timedelta, timezone

        import mcp_handler
        past = (datetime.now(timezone.utc) - timedelta(days=1)).isoformat()
        with patch("mcp_handler.projects_table") as mock_table:
            mock_table.query.return_value = {"Items": [self._row(expires_at=past)]}
            response = mcp_handler.lambda_handler(_rpc_event(), lambda_context)
        assert response["statusCode"] == 401

    def test_malformed_expires_at_fails_closed(self):
        """An unreadable expiry refuses the credential rather than ignoring it."""
        assert self._auth(self._row(expires_at="not-a-date")) is None

    def test_naive_datetime_fails_closed(self):
        """A tz-naive timestamp cannot be compared to an aware now(); comparing
        raises TypeError, which must land in the fail-closed branch rather than
        escape as a 500."""
        assert self._auth(self._row(expires_at="2099-01-01T00:00:00")) is None

    def test_non_string_expires_at_fails_closed(self):
        """A Decimal or number in the attribute is a data problem, not a 500."""
        assert self._auth(self._row(expires_at=12345)) is None

    @patch("mcp_handler.projects_table")
    def test_expiry_logs_carry_no_token_material(self, mock_table):
        """The refusal logs name the token_id and never the token or its hash.

        Same mock-logger idiom as test_botocore_logs_carry_no_token_material —
        caplog is NOT used because Powertools does not reliably propagate to
        the root logger, which would make a caplog assertion vacuously green.
        """
        import mcp_handler
        from shared.tokens import hash_token
        sentinel = "voc_SENTINELTOKEN"
        row = {
            "sk": "TOKEN#1",
            "token_id": "tok_1",
            "token_hash": hash_token(sentinel),
            "scope": "read",
            "expires_at": "not-a-date",
        }
        mock_table.query.return_value = {"Items": [row]}
        with patch("mcp_handler.logger") as mock_logger:
            result = mcp_handler._authenticate(_make_event(token=sentinel))
            assert result is None
            calls = mock_logger.warning.call_args_list
            assert calls, "the malformed expiry must be logged"
            for call in calls:
                extra = (call.kwargs or {}).get("extra", {})
                rendered = " ".join(str(a) for a in call.args) + " " + str(extra)
                assert "SENTINELTOKEN" not in rendered
                assert hash_token(sentinel) not in rendered
                assert extra.get("token_id") == "tok_1", (
                    "the log must name the row so an operator can fix it"
                )

    def test_only_the_matching_row_is_expiry_checked(self):
        """An expired NON-matching row must not block a valid matching row."""
        from datetime import datetime, timedelta, timezone

        import mcp_handler
        past = (datetime.now(timezone.utc) - timedelta(days=1)).isoformat()
        expired_other = {
            "sk": "TOKEN#0",
            "token_id": "tok_0",
            "token_hash": "hash-of-some-other-token",
            "scope": "read",
            "expires_at": past,
        }
        with patch("mcp_handler.projects_table") as mock_table:
            mock_table.query.return_value = {"Items": [expired_other, self._row()]}
            mock_table.update_item.return_value = {}
            assert mcp_handler._authenticate(_make_event()) is not None


# ===========================================================================
# IAM lockstep: the handler's projects-table usage vs the narrowed CDK grant
# ===========================================================================

class TestProjectsTableUsageMatchesNarrowGrant:
    """The CDK grant is exactly Query + UpdateItem; the code must not drift.

    api-stack.test.ts pins the IAM side ('mcp Lambda IAM grants'), but every
    backend test mocks projects_table, so a handler that started calling
    get_item would pass the whole suite and then AccessDeniedException in
    production — a runtime-only 500 on the token-authenticated path.  This is
    the Python half of the lockstep: a mock whose non-granted methods raise,
    driven through the full JSON-RPC path for every registered tool AND the
    autoseed side-door (which reaches projects.get_project).
    """

    GRANTED = ("query", "update_item")

    def _strict_table(self):
        """A projects_table where any non-granted DynamoDB method raises."""
        from shared.tokens import hash_token
        table = MagicMock()
        row = {
            "sk": "TOKEN#1",
            "token_id": "tok_1",
            "token_hash": hash_token("voc_testtoken"),
            "scope": "read-write",
        }
        table.query.return_value = {"Items": [row]}
        table.update_item.return_value = {}
        for method in (
            "get_item", "put_item", "delete_item", "scan",
            "batch_get_item", "batch_write_item", "batch_writer",
            "transact_get_items", "transact_write_items",
        ):
            getattr(table, method).side_effect = AssertionError(
                f"mcp_handler called projects_table.{method}, which the narrowed "
                f"IAM grant (Query, UpdateItem) does not permit — widen the grant "
                f"in api-stack.ts AND its 'mcp Lambda IAM grants' test, or fix the code"
            )
        return table

    def _call_tool(self, name: str, arguments: dict, lambda_context):
        import mcp_handler
        event = {
            "httpMethod": "POST",
            "path": "/v1/mcp",
            "headers": {
                "authorization": "Bearer voc_testtoken",
                "x-project-id": "proj-1",
            },
            "body": json.dumps({
                "jsonrpc": "2.0", "id": 1, "method": "tools/call",
                "params": {"name": name, "arguments": arguments},
            }),
        }
        return mcp_handler.lambda_handler(event, lambda_context)

    def test_every_tool_stays_within_the_granted_actions(self, lambda_context):
        """Drive each registered tool end to end against the strict mock."""
        import mcp_handler
        args_for = {"get_feedback_detail": {"feedback_id": "fb-1"}}
        with patch("mcp_handler.projects_table", self._strict_table()), \
             patch("mcp_handler.feedback_table"), \
             patch("mcp_handler.aggregates_table"), \
             patch("mcp_handler.query_feedback_by_date", return_value=[]):
            for tool_name in mcp_handler.TOOL_HANDLERS:
                response = self._call_tool(
                    tool_name, args_for.get(tool_name, {}), lambda_context
                )
                body = json.loads(response["body"])
                # A strict-mock violation surfaces as the AssertionError text
                # inside the tool-error content; fail loudly with the tool name.
                assert "does not permit" not in response["body"], (
                    f"{tool_name} used a non-granted DynamoDB action:\n{body}"
                )

    def test_autoseed_stays_within_the_granted_actions(self, lambda_context):
        """The side-door reaches projects.get_project — pin its usage too."""
        import mcp_handler
        strict = self._strict_table()
        with patch("mcp_handler.projects_table", strict), \
             patch("mcp_handler.autoseed_project") as mock_seed:
            # autoseed_project lives in projects.py and reads through the
            # module-level table there; patching mcp_handler's reference and
            # asserting it is CALLED keeps this test hermetic while the
            # projects.get_project call sites are pinned by the grep half below.
            mock_seed.return_value = {"success": True, "files": []}
            response = mcp_handler.lambda_handler(
                {
                    "httpMethod": "GET",
                    "path": "/v1/mcp/autoseed/proj-1",
                    "headers": {"authorization": "Bearer voc_testtoken"},
                },
                lambda_context,
            )
        assert response["statusCode"] == 200
        mock_seed.assert_called_once()

    def test_no_reachable_call_site_uses_a_non_granted_action(self):
        """Source-level half: the table operations reachable from this Lambda.

        mcp_handler.py's own projects_table call sites, plus projects.py's
        get_project (the only projects.py function the autoseed path reaches),
        must use only the granted actions.  Scanning THOSE functions rather
        than all of projects.py: the rest of that module runs on the projects
        Lambda, whose role legitimately holds the write actions.
        """
        import inspect

        import mcp_handler
        import projects as projects_module

        handler_src = inspect.getsource(mcp_handler)
        get_project_src = inspect.getsource(projects_module.get_project)
        autoseed_src = inspect.getsource(projects_module.autoseed_project)

        forbidden = (
            ".get_item(", ".put_item(", ".delete_item(", ".scan(",
            ".batch_get_item(", ".batch_write_item(", ".batch_writer(",
            ".transact_get_items(", ".transact_write_items(",
        )
        for src_name, src in (
            ("mcp_handler", handler_src),
            ("projects.get_project", get_project_src),
            ("projects.autoseed_project", autoseed_src),
        ):
            for op in forbidden:
                # projects_table is the module-level name in both files; a hit
                # on any table variable in these functions is projects-table
                # traffic on this Lambda.
                hits = [
                    line.strip() for line in src.splitlines()
                    if op in line and "projects_table" in line
                ]
                assert hits == [], (
                    f"{src_name} reaches projects_table via {op} which the "
                    f"narrowed grant does not permit: {hits}"
                )


class TestOriginDefaultFailsClosed:
    """With ALLOWED_ORIGIN unset (''), a present Origin is refused.

    The stack always injects the env var, so '' only happens on a
    misconfigured deployment — and the safe reading of that state is
    fail-closed for browsers while non-browser clients (no Origin header)
    stay unaffected.  Pinned so the default cannot silently flip to
    fail-open in a refactor.
    """

    @patch("mcp_handler.ALLOWED_ORIGIN", "")
    def test_present_origin_refused_when_unconfigured(self, lambda_context):
        import mcp_handler
        response = mcp_handler.lambda_handler(
            {
                "httpMethod": "POST",
                "path": "/v1/mcp",
                "headers": {"Origin": "https://anything.example.com"},
                "body": json.dumps(
                    {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}}
                ),
            },
            lambda_context,
        )
        assert response["statusCode"] == 403

    @patch("mcp_handler.ALLOWED_ORIGIN", "")
    def test_absent_origin_still_passes_when_unconfigured(self, lambda_context):
        """Fail-closed for browsers must not mean broken for MCP clients."""
        import mcp_handler
        response = mcp_handler.lambda_handler(
            {
                "httpMethod": "POST",
                "path": "/v1/mcp",
                "headers": {},
                "body": json.dumps(
                    {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}}
                ),
            },
            lambda_context,
        )
        assert response["statusCode"] == 200
