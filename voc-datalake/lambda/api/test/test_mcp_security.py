"""
Tests for MCP handler security hardening (issue #260):
  1. Constant-time token comparison (hmac.compare_digest)
  2. Scope enforcement at dispatch (fail-closed)
  3. Partial-result reporting — retired at server 2.0.0 (see section 3 below)
  4. Claim synthesis: the request cannot influence the delegated identity

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

  defect 3 (partial): RETIRED at server 2.0.0, along with the behaviour it
    guarded. The tool no longer reads DynamoDB, so there are no per-read
    failures to degrade and no is_partial to track. The replacement invariant is
    test_a_route_server_error_is_a_protocol_error in test_mcp_delegation.py: a
    failing route is now reported as an error rather than as a plausible-looking
    answer with a flag on it. Full reasoning in the section-3 comment below.

  defect 4 (claim forgery): TestClaimSynthesis
    — delegating made this function an authorization authority: it tells the
    domain Lambda who is calling, and that Lambda believes it, because in every
    other case those claims came from API Gateway's Cognito authorizer. Passing
    the request into the claim builder — or merging `arguments` into the
    synthesized authorizer context — fails test_arguments_cannot_forge_the_subject
    and test_arguments_cannot_forge_group_membership. Highest-value test here.

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
    — the `days` coercion tests moved with `_resolve_days`, which delegation
      deleted. The window is now bounded by the route's shared `validate_days`,
      and its non-finite / non-numeric cases live in
      lambda/shared/test/test_api.py. One case genuinely changed behaviour
      (`days: true`); it is recorded at the section-3 comment below rather than
      here, next to the reasoning.

  delegation:
    test_every_tool_touches_the_table_only_to_authenticate /
    test_autoseed_reads_no_project_rows_in_this_process
    — the Python half of the IAM lockstep, and both got STRONGER when the tools
      started delegating: the expected projects-table query count per tool is now
      exactly one (the credential lookup), and autoseed — the last in-process
      reader of project artifacts — must not touch that table at all. Together
      they are what justifies the `dynamodb:LeadingKeys` condition on the role,
      which api-stack.test.ts pins from the other side.
"""

import io
import json
import os
import sys
from decimal import Decimal
from typing import ClassVar
from unittest.mock import MagicMock, patch

import pytest
from boto3.dynamodb.conditions import Key

# botocore names its own `ConnectionError`/`HTTPClientError`; imported via the
# module so `botocore_exceptions.ConnectionError` cannot be misread as the
# builtin, matching how mcp_handler refers to them.
from botocore import exceptions as botocore_exceptions
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
from botocore.parsers import ResponseParserError
from shared.mcp_tokens import (
    ALL_READ_SCOPES,
    MCP_TOKEN_PK,
    REACH_KIND_PROJECT,
    REACH_KIND_WORKSPACE,
    REACH_NONE,
    REACH_PROJECT_SET,
    REACH_WORKSPACE,
    SCOPE_FEEDBACK_READ,
    SCOPE_METRICS_READ,
    SCOPE_PROJECTS_READ,
    VALID_SCOPES,
    mint_token,
    token_sk,
)

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


# ---------------------------------------------------------------------------
# Credential fixtures
# ---------------------------------------------------------------------------
# One real credential for the whole module, minted through the production
# helper rather than hand-written. Hand-writing it would let the tests keep
# passing after a format change that broke every real client — the token must
# parse, and mint_token is what decides whether it does.
_MINTED = mint_token()
_VALID_TOKEN = _MINTED.raw
# Shaped like an id the product actually mints (`proj_` + a timestamp), because
# the path-parameter guard in _domain_call refuses anything else — any test that
# reaches a delegated call needs a realistic one. The reach tests, which stub the
# tool handler, are unaffected either way.
_TOKEN_PROJECT = "proj_20260819143000"


def _token_row(**extra) -> dict:
    """A stored token row that authenticates _VALID_TOKEN.

    Defaults to the widest shape (every read scope, workspace reach) so a test
    about something else does not accidentally also test a permission refusal.
    """
    return {
        "pk": MCP_TOKEN_PK,
        "sk": token_sk(_MINTED.token_id),
        "token_id": _MINTED.token_id,
        "name": "test token",
        "secret_hash": _MINTED.secret_hash,
        "scopes": list(ALL_READ_SCOPES),
        "projects": [_TOKEN_PROJECT],
        "read_reach": REACH_WORKSPACE,
        **extra,
    }


# A credential that is FORMAT-VALID (so it reaches the token store) but whose
# secret is a greppable constant, for the "no token material in logs" tests.
# It has to be real hex, so the sentinel is a hex word rather than a readable
# one — `voc_SENTINELTOKEN` would now be rejected by the parser before any
# lookup happened, which would make those tests vacuously green.
_SENTINEL_SECRET = 'deadbeef' * 8          # 64 hex chars
_SENTINEL_TOKEN_ID = 'tok_' + 'cafe' * 4   # 16 hex chars
_SENTINEL_TOKEN = f'voc_{_SENTINEL_TOKEN_ID}_{_SENTINEL_SECRET}'


def _make_event(token: str = _VALID_TOKEN) -> dict:
    """Build the minimal auth-header event _authenticate reads.

    No X-Project-Id: the credential resolves on its own now. A test that needs
    to prove the header is irrelevant passes it explicitly.
    """
    return {"headers": {"authorization": f"Bearer {token}"}}


def _stub_domain_client(body: dict | None = None, status: int = 200):
    """A Lambda client that answers any delegated route with a 200.

    These tests are about the credential and the dispatch, so the domain
    function's answer is deliberately uninteresting — the route translation
    itself is covered in test_mcp_delegation.py.
    """
    client = MagicMock()
    client.invoke.side_effect = lambda **_kwargs: {
        "Payload": io.BytesIO(json.dumps({
            "statusCode": status,
            "body": json.dumps(body if body is not None else {"ok": True}),
        }).encode()),
    }
    return client


def _ok_result():
    """What a tool returns now: a ToolResult, not a list of content blocks.

    These tests stub the TOOL EXECUTION so they can be about the credential and
    the dispatch instead of about data. The stub still has to honour the real
    contract — when tools started returning `ToolResult` (structured output,
    server 2.0.0), a stub returning the old list shape made every one of these
    fail on `result.text`, which is the contract check working rather than
    breaking.
    """
    import mcp_handler
    return mcp_handler.ToolResult({"ok": True})


def _rpc_event(tool: str = "get_project", arguments: dict | None = None,
               token: str = _VALID_TOKEN) -> dict:
    """Build a full JSON-RPC tools/call event for the lambda_handler path."""
    return {
        "httpMethod": "POST",
        "path": "/v1/mcp",
        "headers": {"authorization": f"Bearer {token}"},
        "body": json.dumps({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "tools/call",
            "params": {"name": tool, "arguments": arguments or {}},
        }),
    }


# ===========================================================================
# 1. Constant-time token comparison
# ===========================================================================

class TestConstantTimeTokenComparison:
    """hmac.compare_digest must be used for the secret comparison.

    The comparison moved into shared.mcp_tokens.secret_matches with the new
    format, so the patch target moved with it. Patching the handler for a
    function it no longer owns would silently stop testing anything.
    """

    # NOTE: `shared.mcp_tokens.hmac` is the shared stdlib module object from
    # sys.modules, so this patch replaces `hmac.compare_digest` *process-wide*
    # for the duration of the test — not just that module's view of it.  That
    # is safe under serial execution (nothing else in this test calls it;
    # botocore's HMAC signing happens outside the mocked DynamoDB calls), but
    # it would affect any concurrent code that calls `hmac.compare_digest`
    # (e.g. under pytest-xdist, or a fixture that signs a real AWS request).
    @patch("mcp_handler.projects_table")
    @patch("shared.mcp_tokens.hmac.compare_digest")
    def test_authenticate_uses_compare_digest(self, mock_digest, mock_table):
        """compare_digest is called for the stored secret hash; == is never used."""
        mock_digest.return_value = False  # force no-match so _authenticate returns None

        mock_table.query.return_value = {"Items": [_token_row()]}

        from mcp_handler import _authenticate
        result = _authenticate(_make_event())

        assert mock_digest.called, "hmac.compare_digest was never called"
        assert result is None

    @patch("mcp_handler.projects_table")
    def test_authenticate_returns_the_row_on_a_matching_secret(self, mock_table):
        """A correct secret returns the stored row, with its scopes and reach.

        No patched comparison here — the real credential from mint_token is
        presented against the real stored hash, so this also proves the mint
        and authenticate halves agree about the format.
        """
        mock_table.query.return_value = {"Items": [_token_row()]}
        mock_table.update_item.return_value = {}

        from mcp_handler import _authenticate
        result = _authenticate(_make_event())

        assert result is not None
        assert result["scopes"] == list(ALL_READ_SCOPES)
        assert result["projects"] == [_TOKEN_PROJECT]
        assert result["read_reach"] == REACH_WORKSPACE

    @patch("mcp_handler.projects_table")
    def test_authenticate_looks_the_token_up_by_its_own_id(self, mock_table):
        """The lookup is ONE keyed read in the token partition.

        This is the behaviour that removed the X-Project-Id requirement: a scan
        of a project's token rows cannot answer "which projects exist". If this
        ever goes back to a begins_with over a PROJECT# partition, the header
        comes back with it.
        """
        mock_table.query.return_value = {"Items": [_token_row()]}
        mock_table.update_item.return_value = {}

        from mcp_handler import _authenticate
        assert _authenticate(_make_event()) is not None

        # Compared as CONDITION OBJECTS, not as strings: boto3's conditions
        # stringify to "<...conditions.And object at 0x...>", so a substring
        # assertion would be vacuously true forever. ConditionBase implements
        # __eq__ over its operands, so this compares the real key expression —
        # and a begins_with, or a PROJECT# partition, fails it.
        expected = Key('pk').eq(MCP_TOKEN_PK) & Key('sk').eq(token_sk(_MINTED.token_id))
        actual = mock_table.query.call_args.kwargs["KeyConditionExpression"]
        assert actual == expected, (
            "the lookup must be an exact keyed read of the token row "
            f"(pk={MCP_TOKEN_PK}, sk={token_sk(_MINTED.token_id)}), not a range "
            "scan over a project's token rows — that scan is what required the "
            "X-Project-Id header"
        )

    @patch("mcp_handler.projects_table")
    def test_authentication_needs_no_project_header(self, mock_table):
        """The credential is self-describing: no X-Project-Id, no project hint."""
        mock_table.query.return_value = {"Items": [_token_row()]}
        mock_table.update_item.return_value = {}

        from mcp_handler import _authenticate
        event = {"headers": {"authorization": f"Bearer {_VALID_TOKEN}"}}
        assert _authenticate(event) is not None

    @patch("mcp_handler.projects_table")
    def test_authenticate_wrong_secret_returns_none(self, mock_table):
        """A real token id with the wrong secret is refused."""
        mock_table.query.return_value = {"Items": [_token_row(secret_hash="wronghash")]}

        from mcp_handler import _authenticate
        assert _authenticate(_make_event()) is None

    @patch("mcp_handler.projects_table")
    def test_authenticate_unknown_token_id_returns_none(self, mock_table):
        """An id with no row is a plain 401, indistinguishable from a bad secret."""
        mock_table.query.return_value = {"Items": []}

        from mcp_handler import _authenticate
        assert _authenticate(_make_event()) is None

    @patch("mcp_handler.projects_table")
    def test_malformed_credential_never_reaches_the_token_store(self, mock_table):
        """Strict parsing means caller text does not become a key lookup.

        Includes the retired `voc_<64 hex>` format: dropping legacy support was
        a deliberate decision (no production users), so a legacy credential must
        fail closed rather than quietly resolve.
        """
        from mcp_handler import _authenticate
        for bad in ("voc_testtoken", "voc_" + "a" * 64, "Bearer-less", "voc_tok_xyz_abc"):
            assert _authenticate(_make_event(token=bad)) is None, f"{bad!r} authenticated"
        mock_table.query.assert_not_called()

    @patch("mcp_handler.projects_table")
    def test_authenticate_returns_none_on_retryable_dynamodb_error(self, mock_table):
        """A throttle in the token-lookup path returns None (a clean 401), not a 500.

        A transient DynamoDB error must not propagate as an unhandled exception.
        The token may well be valid, so 401 + retry is an acceptable answer.
        """
        mock_table.query.side_effect = _client_error('ProvisionedThroughputExceededException')

        from mcp_handler import _authenticate
        result = _authenticate(_make_event())

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
                mcp_handler._authenticate(_make_event())

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
                    "authorization": f"Bearer {_VALID_TOKEN}",
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

_NO_SCOPES_KEY = object()  # sentinel: build token_info with no 'scopes' key at all


class TestScopeEnforcement:
    """Dispatch is fail-closed: scope must be declared and satisfied.

    Scopes are a SET of per-domain grants (`feedback:read`, `projects:read`)
    with no hierarchy, replacing the old ordered `read` / `read-write` pair.
    Two consequences the tests below pin:
      • membership is exact, so nothing "includes" anything else and there is
        no ordering to get wrong;
      • a row with no usable `scopes` grants NOTHING. The old model defaulted a
        missing scope to `read` because deployed rows predated the field; the
        format change means every row carries an explicit set, so a row without
        one is data damage and must not be guessed at in the caller's favour.
    """

    def _call_tool(self, tool_name, token_scopes, handlers_extra=None,
                   scopes_extra=None, reach_extra=None, token_info_extra=None,
                   arguments=None):
        """Call _handle_tools_call with the given tool and token scope set.

        ``token_scopes=_NO_SCOPES_KEY`` builds a token_info with no ``scopes``
        key at all, reproducing a damaged row.
        """
        import mcp_handler

        # Workspace reach by default so a scope test is not silently also a
        # reach test; the reach class below varies it deliberately.
        token_info = {
            "projects": [_TOKEN_PROJECT],
            "read_reach": REACH_WORKSPACE,
            **(token_info_extra or {}),
        }
        if token_scopes is not _NO_SCOPES_KEY:
            token_info["scopes"] = token_scopes

        original_handlers = mcp_handler.TOOL_HANDLERS.copy()
        original_scopes = mcp_handler.TOOL_SCOPE_REQUIREMENTS.copy()
        original_reach = mcp_handler.TOOL_REACH_KINDS.copy()
        try:
            if handlers_extra:
                mcp_handler.TOOL_HANDLERS.update(handlers_extra)
            if scopes_extra:
                mcp_handler.TOOL_SCOPE_REQUIREMENTS.update(scopes_extra)
            # A synthetic tool needs a reach kind too, or the fail-closed reach
            # guard rejects it before the scope check under test is reached.
            if handlers_extra and reach_extra is None:
                reach_extra = {name: REACH_KIND_WORKSPACE for name in handlers_extra}
            if reach_extra:
                mcp_handler.TOOL_REACH_KINDS.update(reach_extra)
            return mcp_handler._handle_tools_call(
                req_id=1,
                params={"name": tool_name, "arguments": arguments or {}},
                token_info=token_info,
            )
        finally:
            # Restore originals so tests don't bleed into each other
            for registry, original in (
                (mcp_handler.TOOL_HANDLERS, original_handlers),
                (mcp_handler.TOOL_SCOPE_REQUIREMENTS, original_scopes),
                (mcp_handler.TOOL_REACH_KINDS, original_reach),
            ):
                registry.clear()
                registry.update(original)

    def test_every_registered_tool_has_scope_and_reach_declarations(self):
        """TOOL_HANDLERS, the two declaration tables, and MCP_TOOLS must agree.

        Adding a handler without a scope entry, without a reach kind, or without
        an MCP_TOOLS entry (or vice-versa) breaks this test, signalling the
        author that a table needs updating. A tool in MCP_TOOLS without a
        handler returns -32602; a handler not in MCP_TOOLS is silently
        unreachable; a handler with no reach kind cannot be authorized at all —
        all three are caught here.
        """
        from mcp_handler import (
            MCP_TOOLS,
            TOOL_HANDLERS,
            TOOL_REACH_KINDS,
            TOOL_SCOPE_REQUIREMENTS,
        )

        handler_keys = set(TOOL_HANDLERS.keys())
        mcp_names = {t['name'] for t in MCP_TOOLS}

        assert handler_keys == set(TOOL_SCOPE_REQUIREMENTS), (
            "Mismatch between TOOL_HANDLERS and TOOL_SCOPE_REQUIREMENTS keys. "
            "Every handler must have a declared scope requirement and vice-versa."
        )
        assert handler_keys == set(TOOL_REACH_KINDS), (
            "Mismatch between TOOL_HANDLERS and TOOL_REACH_KINDS keys. Every "
            "handler must declare how its data is shaped, or read_reach cannot "
            "be applied to it."
        )
        assert mcp_names == handler_keys, (
            f"MCP_TOOLS names {mcp_names} must match TOOL_HANDLERS keys {handler_keys}. "
            "A tool in MCP_TOOLS without a handler causes -32602; a handler not in "
            "MCP_TOOLS is silently unreachable."
        )

    def test_declared_scopes_and_reaches_are_from_the_vocabulary(self):
        """No tool may require a scope or reach kind that does not exist.

        A typo like `project:read` (singular) would otherwise be unsatisfiable
        by any mintable token — the tool would be dead on arrival and the
        failure would look like a permission problem to whoever called it.
        """
        from mcp_handler import TOOL_REACH_KINDS, TOOL_SCOPE_REQUIREMENTS

        assert set(TOOL_SCOPE_REQUIREMENTS.values()) <= VALID_SCOPES, (
            f"undeclared scope(s): {set(TOOL_SCOPE_REQUIREMENTS.values()) - VALID_SCOPES}"
        )
        assert set(TOOL_REACH_KINDS.values()) <= {REACH_KIND_WORKSPACE, REACH_KIND_PROJECT}

    def test_token_without_the_required_scope_is_rejected(self):
        """Holding one domain's scope does not grant another's.

        This is what per-domain scopes buy that the old pair could not express:
        a credential that reads feedback but cannot read anybody's product
        strategy.
        """
        handler = MagicMock(return_value=_ok_result())
        result = self._call_tool(
            tool_name="fake_projects_tool",
            token_scopes=[SCOPE_FEEDBACK_READ],
            handlers_extra={"fake_projects_tool": handler},
            scopes_extra={"fake_projects_tool": SCOPE_PROJECTS_READ},
        )

        assert "error" in result, "Expected a JSON-RPC error response"
        # -32003 = Forbidden (scope insufficient); -32001 is Unauthorized (bad token)
        assert result["error"]["code"] == -32003, (
            f"Expected -32003 (Forbidden) for scope failure, got {result['error']['code']}"
        )
        assert "Forbidden" in result["error"]["message"]
        handler.assert_not_called()

    def test_token_holding_the_required_scope_is_allowed(self):
        handler = MagicMock(return_value=_ok_result())
        result = self._call_tool(
            tool_name="fake_feedback_tool",
            token_scopes=[SCOPE_FEEDBACK_READ],
            handlers_extra={"fake_feedback_tool": handler},
            scopes_extra={"fake_feedback_tool": SCOPE_FEEDBACK_READ},
        )

        assert "result" in result, f"Expected success, got: {result}"
        handler.assert_called_once()

    def test_extra_scopes_do_not_interfere(self):
        """A token holding several scopes satisfies each of them."""
        handler = MagicMock(return_value=_ok_result())
        for required in (SCOPE_FEEDBACK_READ, SCOPE_METRICS_READ, SCOPE_PROJECTS_READ):
            handler.reset_mock()
            result = self._call_tool(
                tool_name="fake_multi_tool",
                token_scopes=list(ALL_READ_SCOPES),
                handlers_extra={"fake_multi_tool": handler},
                scopes_extra={"fake_multi_tool": required},
            )
            assert "result" in result, f"{required} should have been satisfied, got: {result}"
            handler.assert_called_once()

    @pytest.mark.parametrize("scopes", [
        _NO_SCOPES_KEY,   # attribute absent
        None,             # present but null
        [],               # present but empty
        "",               # present but not a list
        "projects:read",  # a bare string, not a list — `in` would match substrings
        {"projects:read": True},
    ])
    def test_an_unusable_scopes_field_grants_nothing(self, scopes):
        """A row without a readable scope SET is refused, not defaulted.

        This deliberately REVERSES the old behaviour, which resolved a missing
        scope to `read`. That default existed because deployed rows predated the
        `scope` field; the format change means every row is minted with an
        explicit set, so a row without one is data damage. Guessing in the
        caller's favour would turn a damaged row into a working credential.

        The bare-string case is the interesting one: `"projects:read" in
        "projects:read"` is True, so a membership test that forgot to require a
        list would let a string masquerade as a scope set — and a row holding
        the string "feedback:read,projects:read" would then satisfy BOTH.
        """
        handler = MagicMock(return_value=_ok_result())
        result = self._call_tool(
            tool_name="damaged_row_tool",
            token_scopes=scopes,
            handlers_extra={"damaged_row_tool": handler},
            scopes_extra={"damaged_row_tool": SCOPE_PROJECTS_READ},
        )

        assert result.get("error", {}).get("code") == -32003, (
            f"an unusable scopes field must be refused, got: {result}"
        )
        handler.assert_not_called()

    def test_list_path_reports_the_reach_enforcement_assumes(self):
        """mcp_handler and projects_handler must agree on the read_reach default.

        The MCP Access tab renders whatever projects_handler.api_list_tokens
        reports; enforcement uses DEFAULT_READ_REACH. If the two drift, a token
        the UI displays as workspace-wide is enforced as something narrower — or,
        worse, one displayed as sealed is enforced as workspace-wide. This is the
        only mechanical guarantee behind that agreement, so it is asserted on
        *behaviour*: the list path is called with a reach-less row and its output
        compared to the constant.

        Deliberately not `inspect.getsource`: matching a literal fails on a
        reformat (claiming the default changed when it did not) and passes when
        the real default moves but a stale copy survives in a comment.
        """
        import mcp_handler
        import projects_handler

        table = MagicMock()
        # A row missing the reach attribute entirely.
        table.query.return_value = {
            "Items": [
                {
                    "token_id": "tok_partial",
                    "name": "partial token",
                    "created_at": "2024-01-01T00:00:00+00:00",
                    "projects": ["some-project"],
                }
            ]
        }

        with patch("projects_handler.get_projects_table", return_value=table):
            result = projects_handler.api_list_tokens("some-project")

        tokens = result["tokens"]
        assert len(tokens) == 1, f"Expected exactly one token in the list output, got: {tokens}"
        assert tokens[0]["read_reach"] == mcp_handler.DEFAULT_READ_REACH, (
            "projects_handler.api_list_tokens reports a missing read_reach as "
            f"{tokens[0]['read_reach']!r} while enforcement assumes "
            f"{mcp_handler.DEFAULT_READ_REACH!r}. The MCP Access tab would then "
            "describe a credential's reach differently from how it is enforced — "
            "bring the two back into agreement."
        )

    def test_tool_without_scope_declaration_is_rejected(self):
        """A handler that exists in TOOL_HANDLERS but not TOOL_SCOPE_REQUIREMENTS is rejected."""
        undeclared_handler = MagicMock(return_value=_ok_result())
        import mcp_handler
        original = mcp_handler.TOOL_SCOPE_REQUIREMENTS.copy()
        try:
            result = self._call_tool(
                tool_name="undeclared_tool",
                token_scopes=list(ALL_READ_SCOPES),
                # inject handler and a reach kind but NOT a scope declaration
                handlers_extra={"undeclared_tool": undeclared_handler},
                reach_extra={"undeclared_tool": REACH_KIND_WORKSPACE},
            )
        finally:
            mcp_handler.TOOL_SCOPE_REQUIREMENTS.clear()
            mcp_handler.TOOL_SCOPE_REQUIREMENTS.update(original)

        assert "error" in result, "Expected a JSON-RPC error for undeclared tool scope"
        undeclared_handler.assert_not_called()

    def test_tool_without_reach_declaration_is_rejected(self):
        """A handler with a scope but no declared reach kind is refused.

        Without a reach kind there is no way to know whether read_reach applies,
        and guessing would mean guessing permissively. Same fail-closed rule as
        the missing scope declaration above.
        """
        handler = MagicMock(return_value=_ok_result())
        import mcp_handler
        original = mcp_handler.TOOL_REACH_KINDS.copy()
        try:
            result = self._call_tool(
                tool_name="reachless_tool",
                token_scopes=list(ALL_READ_SCOPES),
                handlers_extra={"reachless_tool": handler},
                scopes_extra={"reachless_tool": SCOPE_FEEDBACK_READ},
                # An explicit empty dict, not None: None makes _call_tool
                # auto-declare a reach kind for the synthetic tool, which would
                # make this test assert nothing.
                reach_extra={},
            )
        finally:
            mcp_handler.TOOL_REACH_KINDS.clear()
            mcp_handler.TOOL_REACH_KINDS.update(original)

        assert result.get("error", {}).get("code") == -32603, (
            f"a tool with no declared reach kind must be a server error, got: {result}"
        )
        handler.assert_not_called()

    def _tools_call_response(self, arguments, lambda_context, tool="get_project",
                             *, stub_handler=False):
        """Drive tools/call through the full lambda_handler.

        `stub_handler` is opt-in and used ONLY by the null-arguments case, which
        has to reach a *successful* dispatch without a real project read. The
        malformed cases deliberately run against the REAL handler: their whole
        claim is that such input would otherwise reach the project resolution, so
        stubbing the handler there would leave that claim resting on the guard's
        position rather than on the code actually being wired up.
        """
        import mcp_handler
        event = {
            "httpMethod": "POST",
            "path": "/v1/mcp",
            "headers": {"authorization": f"Bearer {_VALID_TOKEN}"},
            "body": json.dumps({
                "jsonrpc": "2.0", "id": 1, "method": "tools/call",
                "params": {"name": tool, "arguments": arguments},
            }),
        }
        handlers = (
            {**mcp_handler.TOOL_HANDLERS,
             tool: MagicMock(return_value=_ok_result())}
            if stub_handler else mcp_handler.TOOL_HANDLERS
        )
        with patch("mcp_handler.projects_table") as mock_table, \
             patch("mcp_handler.TOOL_HANDLERS", handlers):
            mock_table.query.return_value = {"Items": [_token_row()]}
            mock_table.update_item.return_value = {}
            return mcp_handler.lambda_handler(event, lambda_context)

    def test_null_arguments_means_no_arguments_not_a_bad_request(self, lambda_context):
        """An explicit `"arguments": null` is "no arguments", not malformed.

        `params.get('arguments', {})` cannot default it, because the KEY IS
        PRESENT — and some clients serialize an omitted optional object as null.
        Every tool here has only optional arguments, so refusing null would be a
        compatibility edge invented by the type guard rather than a real protocol
        error.

        Revert story: deleting the `arguments is None` coercion fails this with
        -32602.
        """
        response = self._tools_call_response(None, lambda_context, stub_handler=True)
        assert response["statusCode"] == 200, response
        body = json.loads(response["body"])
        assert "error" not in body, (
            f'"arguments": null must be treated as {{}}, got {body}'
        )
        assert body["result"]["isError"] is False, body

    @pytest.mark.parametrize("arguments", [
        ["project_id"], "project_id", 42, 3.5, True,
    ])
    def test_non_object_arguments_are_a_protocol_error_not_a_500(
        self, arguments, lambda_context
    ):
        """`arguments` is caller-controlled JSON and need not be an object.

        A list, string or number reaches the project resolution, where both
        `'project_id' in args` and `args['project_id']` raise TypeError — and
        that resolution runs OUTSIDE the try/except around the handler, so it
        escaped as a 502 with no JSON-RPC envelope and no CORS headers. Driven
        through the FULL lambda_handler path, because the envelope and the status
        code are the part that was broken.

        `null` is deliberately NOT in this list — it means "no arguments" and is
        covered by test_null_arguments_means_no_arguments_not_a_bad_request.

        Revert story: deleting the isinstance(arguments, dict) guard in
        _handle_tools_call fails this with a raised TypeError.
        """
        response = self._tools_call_response(arguments, lambda_context)
        assert response["statusCode"] == 200, response
        body = json.loads(response["body"])
        assert body["error"]["code"] == -32602, body
        assert "arguments" in body["error"]["message"], body
        assert "Access-Control-Allow-Origin" in response["headers"], (
            "a protocol error must still carry CORS headers"
        )

    def test_scope_allows_helper(self):
        """Unit-test _scope_allows: exact membership, no hierarchy, list required."""
        from mcp_handler import _scope_allows

        assert _scope_allows([SCOPE_FEEDBACK_READ], SCOPE_FEEDBACK_READ) is True
        assert _scope_allows(list(ALL_READ_SCOPES), SCOPE_PROJECTS_READ) is True
        assert _scope_allows([SCOPE_FEEDBACK_READ], SCOPE_PROJECTS_READ) is False
        assert _scope_allows([], SCOPE_FEEDBACK_READ) is False
        assert _scope_allows(None, SCOPE_FEEDBACK_READ) is False
        # A bare string must not pass by substring containment.
        assert _scope_allows(SCOPE_FEEDBACK_READ, SCOPE_FEEDBACK_READ) is False
        # An empty requirement never grants anything.
        assert _scope_allows(list(ALL_READ_SCOPES), "") is False


# ===========================================================================
# 3. Partial-result reporting — REMOVED, and why
# ===========================================================================
#
# `TestPartialResultReporting` (17 tests) tested `get_metrics_summary`'s
# hand-rolled aggregation: a per-read try/except that reported `is_partial` when
# a DynamoDB read failed, plus `_resolve_days`, which coerced and clamped the
# window before that aggregation ran.
#
# Both are gone because the behaviour they tested is gone, not because the tests
# became inconvenient:
#
#   • The tool no longer reads DynamoDB, so there are no per-read failures to
#     degrade. `GET /metrics/summary` either answers or fails, and a failure is
#     now reported as a JSON-RPC error rather than as a plausible-looking answer
#     with a flag on it. `test_a_route_server_error_is_a_protocol_error` in
#     test_mcp_delegation.py is the replacement invariant, and it is the stronger
#     one: a silently under-reported total was the failure mode worth removing.
#
#   • `_resolve_days` is deleted. The window is bounded by the route's own
#     `validate_days`, which — unlike the hand-rolled clamp — is a validator the
#     whole API shares and is documented never to raise. Its non-finite and
#     non-numeric cases are pinned in lambda/shared/test/test_api.py
#     (`test_returns_default_for_a_non_finite_float_instead_of_raising`), so that
#     coverage moved rather than disappeared.
#
#     ⚠️ ONE case genuinely changes behaviour, recorded here rather than glossed:
#     `{"days": true}`. `_resolve_days` refused a bool and reported the 7-day
#     default, on the reasoning that JSON Schema does not count `true` as an
#     integer. `validate_int` COERCES it (`test_a_bool_is_coerced_rather_than_
#     refused`), so the window becomes 1 day. The house-wide validator wins on
#     purpose: a client sending `true` for a field its own inputSchema declares
#     as an integer is already outside the contract, and having one endpoint in
#     the API treat that input differently from the other forty is a worse
#     property than either answer. Server 2.0.0 is where that is allowed to
#     change.
#
# The route's own `is_partial` means something different — "the scan truncated"
# — and is passed through untouched, which
# `test_a_pass_through_tool_does_not_reshape_the_route_payload` pins.


# ===========================================================================
# 4. Non-string secret_hash type safety
# ===========================================================================

class TestSecretHashTypeSafety:
    """_authenticate must not raise when the stored secret_hash is not a str."""

    @pytest.mark.parametrize("bad_hash", [
        pytest.param(Decimal(12345), id="Decimal"),
        pytest.param(b"binary_bytes", id="bytes"),
        pytest.param(None, id="None"),
        pytest.param(["a"], id="list"),
    ])
    @patch("mcp_handler.projects_table")
    def test_non_string_secret_hash_is_refused_not_raised(self, mock_table, bad_hash):
        """A malformed row is a 401, not an AttributeError turned into a 500.

        Calling .encode() on a Decimal or Binary would raise straight out of
        _authenticate. With the keyed lookup there is only ever ONE row, so a
        damaged row can no longer be skipped in favour of a later one — it is
        simply refused, which is the fail-closed answer.
        """
        mock_table.query.return_value = {"Items": [_token_row(secret_hash=bad_hash)]}

        from mcp_handler import _authenticate
        assert _authenticate(_make_event()) is None

    @patch("mcp_handler.projects_table")
    def test_non_string_secret_hash_logs_the_type_and_row(self, mock_table):
        """The warning names the type and the token_id, never the value.

        token_id is deliberately included: it is what lets an operator find and
        re-mint the damaged row, and hashing only the secret half is what makes
        it safe to log.
        """
        from decimal import Decimal
        mock_table.query.return_value = {"Items": [_token_row(secret_hash=Decimal(99))]}

        from mcp_handler import _authenticate
        with patch("mcp_handler.logger") as mock_logger:
            _authenticate(_make_event())
            assert mock_logger.warning.called, "A non-str secret_hash must trigger a WARNING log"
            call = mock_logger.warning.call_args
            extra = (call.kwargs or {}).get("extra", {})
            assert extra.get("type") == "Decimal", (
                f"WARNING extra must name the offending type; got {extra}"
            )
            assert extra.get("token_id") == _MINTED.token_id, (
                f"WARNING extra must name the row so an operator can fix it; got {extra}"
            )
            assert "99" not in str(extra.get("type", "")), "the value must not be logged"


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
        """Only the exception *type* is logged — never the secret or its hash.

        The credential's secret half is a recognisable sentinel here, so an
        f-string or an `extra` field that interpolated it would trip this
        immediately. The token ID is deliberately exempt: hashing only the
        secret half is what makes the id safe to log, and log lines naming the
        row are how an operator fixes one.
        """
        import mcp_handler

        mock_table.query.side_effect = exc
        event = _make_event(token=_SENTINEL_TOKEN)

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
                assert _SENTINEL_SECRET not in rendered, (
                    f"Log must not contain the credential secret; got: {rendered}"
                )
                assert "secret_hash" not in extra, f"Log extra must not carry a hash; got: {extra}"


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
                mcp_handler._authenticate(_make_event(token=_SENTINEL_TOKEN))

            calls = mock_logger.exception.call_args_list
            assert calls, f"{type(exc).__name__} must be logged for an operator"
            rendered = " ".join(
                str(c.args) + str((c.kwargs or {}).get("extra", "")) for c in calls
            )
            assert type(exc).__name__ in rendered, (
                f"The log must name the fault type; got: {rendered}"
            )
            assert _SENTINEL_SECRET not in rendered, (
                f"Log must not contain the credential secret; got: {rendered}"
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
                    "authorization": f"Bearer {_VALID_TOKEN}",
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
                "path": f"/v1/mcp/autoseed/{_TOKEN_PROJECT}",
                "headers": {
                    "authorization": f"Bearer {_VALID_TOKEN}",
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

    @pytest.mark.parametrize("spelling", ["Origin", "origin", "ORIGIN", "oRigin"])
    @patch("mcp_handler.ALLOWED_ORIGIN", "https://voc.example.com")
    def test_every_casing_of_the_header_is_checked(self, spelling, lambda_context):
        """A guard that reads two spellings by hand is bypassed by the third.

        This function matched only `'origin'` and `'Origin'`, so `ORIGIN:` and
        `oRigin:` walked past the DNS-rebinding guard entirely on a direct invoke or
        any non-API-Gateway trigger — a check that fails OPEN. It now reads through
        `_request_header`, the module's one case-insensitive header reader, which is
        the same helper `_authenticate` and the transport headers use.

        HTTP header names are case-insensitive, so all four of these are the same
        header and a browser or a proxy may send any of them.
        """
        import mcp_handler
        event = self._initialize_event(None)
        event["headers"][spelling] = "https://evil.example.net"

        response = mcp_handler.lambda_handler(event, lambda_context)

        assert response["statusCode"] == 403, (
            f"Origin spelled {spelling!r} bypassed the DNS-rebinding guard"
        )

    @patch("mcp_handler.ALLOWED_ORIGIN", "https://voc.example.com")
    def test_two_claimed_origins_are_refused_rather_than_chosen_between(
        self, lambda_context,
    ):
        """Picking one of two claimed origins is the one thing this guard must not do.

        `Origin` is what this function exists to compare, so an intermediary that
        forwarded the victim's origin alongside the attacker's would have it compare
        whichever it happened to read first — and the allowed value is present here,
        so a reader that stopped at the first match would SERVE this request. The
        fail-closed reading is the refusal, which is the same reading the transport
        headers apply to a duplicate (`-32020` there; a 403 here, because that is the
        answer this guard's caller gives).
        """
        import mcp_handler
        event = self._initialize_event(None)
        event["headers"]["origin"] = "https://voc.example.com"
        event["multiValueHeaders"] = {
            "origin": ["https://voc.example.com", "https://evil.example.net"],
        }

        response = mcp_handler.lambda_handler(event, lambda_context)

        assert response["statusCode"] == 403, response["body"]

    @patch("mcp_handler.ALLOWED_ORIGIN", "https://voc.example.com")
    def test_two_unusable_origins_are_refused_not_read_as_absent(self, lambda_context):
        """Two DIFFERENT unusable Origin values must not collapse into no Origin.

        `_header_values` coerces a non-string candidate to `''` — and coercing
        BEFORE deduplicating turned `[None, 42]` into a single `''`, which is how
        this module spells ABSENT, and absent Origin passes the rebinding guard. So
        the one guard whose whole subject is "do not pick between two claimed
        origins" resolved two claimed origins to no origin at all and SERVED the
        request — a fail-open, on the same direct-invoke event shape the non-dict
        `headers` guard below already defends. Deduplicating on the raw candidate
        keeps the two values two, and two values for `Origin` is the 403 the test
        above pins. Moving the coercion back inside the dedup fails this test.
        """
        import mcp_handler
        event = self._initialize_event(None)
        event["multiValueHeaders"] = {"origin": [None, 42]}

        response = mcp_handler.lambda_handler(event, lambda_context)

        assert response["statusCode"] == 403, response["body"]

    @patch("mcp_handler.ALLOWED_ORIGIN", "https://voc.example.com")
    def test_equatable_but_distinct_unusable_origins_are_still_two_values(
        self, lambda_context,
    ):
        """`==` folds the pairs Python equates across types, and the dedup must
        not.

        Deduplicating the raw candidates with `in` (i.e. `==`) collapsed
        `[True, 1]` into one value — `True == 1` — which then coerced to `''`
        and read as an absent Origin: the same fail-open the raw-candidate fix
        closed, one equality quirk deeper. The dedup key is now the `repr`, and
        `repr(True) != repr(1)`. Reverting the key to `==` on the raw candidate
        fails this test and only this test.
        """
        import mcp_handler
        event = self._initialize_event(None)
        event["multiValueHeaders"] = {"origin": [True, 1]}

        response = mcp_handler.lambda_handler(event, lambda_context)

        assert response["statusCode"] == 403, response["body"]

    @patch("mcp_handler.ALLOWED_ORIGIN", "https://voc.example.com")
    def test_a_single_unusable_origin_still_reads_as_absent(self, lambda_context):
        """Anti-overreach: the fix is about TWO values, not about non-strings.

        A single unusable value keeps its existing reading — the empty string,
        which the guard treats as no Origin presented. Refusing it would refuse
        every direct invoke whose builder put something odd in one header, which
        is a different (and unclaimed) policy.
        """
        import mcp_handler
        event = self._initialize_event(None)
        event["multiValueHeaders"] = {"origin": [None]}

        response = mcp_handler.lambda_handler(event, lambda_context)

        assert response["statusCode"] == 200, response["body"]

    @patch("mcp_handler.ALLOWED_ORIGIN", "https://voc.example.com")
    def test_the_same_origin_twice_is_still_served(self, lambda_context):
        """Anti-vacuity: restating one allowed origin is not two origins, and
        refusing it would refuse a request nothing is wrong with."""
        import mcp_handler
        event = self._initialize_event(None)
        event["headers"]["origin"] = "https://voc.example.com"
        event["multiValueHeaders"] = {
            "origin": ["https://voc.example.com", "https://voc.example.com"],
        }

        response = mcp_handler.lambda_handler(event, lambda_context)

        assert response["statusCode"] == 200, response["body"]

    @pytest.mark.parametrize("headers", [["x"], "origin", 7, [("origin", "x")]])
    @patch("mcp_handler.ALLOWED_ORIGIN", "https://voc.example.com")
    def test_a_non_dict_headers_value_is_not_a_crash(self, headers, lambda_context):
        """`event['headers']` is a dict or null from API Gateway — and this is not
        the only way in.

        `headers.get('origin')` on a list raised `AttributeError`, and this guard
        runs FIRST in `lambda_handler`, outside its try/except: the result was a 502
        with no JSON-RPC envelope and no CORS headers, which is precisely the failure
        shape the `BotoCoreError` clause documents as the thing to avoid. A truthy
        non-dict was needed to reach it, so `or {}` hid the falsy cases.

        Reads as absence, which passes the guard — the same answer as no Origin at
        all, and the only honest one: a malformed headers structure states no origin.
        """
        import mcp_handler
        event = self._initialize_event(None)
        event["headers"] = headers

        response = mcp_handler.lambda_handler(event, lambda_context)

        assert response["statusCode"] != 502, response.get("body")
        assert response["statusCode"] == 200, response["body"]

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
                "path": f"/v1/mcp/autoseed/{_TOKEN_PROJECT}",
                "headers": {"authorization": f"Bearer {_VALID_TOKEN}"},
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
        return _token_row(**extra)

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
        from shared.mcp_tokens import hash_secret
        row = self._row(secret_hash=hash_secret(_SENTINEL_SECRET),
                        expires_at="not-a-date")
        mock_table.query.return_value = {"Items": [row]}
        with patch("mcp_handler.logger") as mock_logger:
            result = mcp_handler._authenticate(_make_event(token=_SENTINEL_TOKEN))
            assert result is None
            calls = mock_logger.warning.call_args_list
            assert calls, "the malformed expiry must be logged"
            for call in calls:
                extra = (call.kwargs or {}).get("extra", {})
                rendered = " ".join(str(a) for a in call.args) + " " + str(extra)
                assert _SENTINEL_SECRET not in rendered
                assert hash_secret(_SENTINEL_SECRET) not in rendered
                assert extra.get("token_id") == _MINTED.token_id, (
                    "the log must name the row so an operator can fix it"
                )

    def test_expiry_is_checked_only_after_the_secret_matches(self):
        """A wrong secret on an expired row is refused as a bad secret.

        Ordering matters for timing: checking expiry first would let a caller
        distinguish "this id exists but expired" from "this id does not exist"
        by which work the server performed. With the keyed lookup there is one
        row, so the old "only the matching row is expiry-checked" invariant
        becomes this ordering one.
        """
        from datetime import datetime, timedelta, timezone

        import mcp_handler
        past = (datetime.now(timezone.utc) - timedelta(days=1)).isoformat()
        row = self._row(secret_hash="not-the-right-hash", expires_at=past)
        with patch("mcp_handler.projects_table") as mock_table:
            mock_table.query.return_value = {"Items": [row]}
            with patch("mcp_handler._credential_expired") as mock_expired:
                assert mcp_handler._authenticate(_make_event()) is None
                mock_expired.assert_not_called()


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
        table = MagicMock()
        table.query.return_value = {"Items": [_token_row()]}
        table.update_item.return_value = {}
        for method in self.FORBIDDEN:
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
                "authorization": f"Bearer {_VALID_TOKEN}",
                "x-project-id": "proj-1",
            },
            "body": json.dumps({
                "jsonrpc": "2.0", "id": 1, "method": "tools/call",
                "params": {"name": name, "arguments": arguments},
            }),
        }
        return mcp_handler.lambda_handler(event, lambda_context)

    FORBIDDEN = (
        "get_item", "put_item", "delete_item", "scan",
        "batch_get_item", "batch_write_item", "batch_writer",
        "transact_get_items", "transact_write_items",
    )

    def test_every_tool_touches_the_table_only_to_authenticate(self, lambda_context):
        """Drive each registered tool end to end against the strict mock.

        The invariant STRENGTHENED when the tools started delegating, and this
        is where that shows: the expected projects-table Query count is now
        exactly ONE for every tool — the credential lookup — where get_project
        and list_personas used to pay a second for their own read. Nothing this
        function does reaches a PROJECT#... row any more, which is precisely
        what lets the CDK grant carry a `dynamodb:LeadingKeys` condition
        naming only the token partition. A tool that went back to reading
        directly would still work in production today, and fail here.

        The verdict is read off the MOCK, not the response body: a violation
        raised inside a tool is caught by _handle_tools_call's except clauses
        and could be rephrased into any message, so a body-text assertion would
        go vacuous the day that message changes.
        """
        import mcp_handler
        strict = self._strict_table()
        # The minimum each tool needs to reach its DELEGATED call rather than being
        # refused by its own argument guard first. The assertion below (one query,
        # the credential lookup) would pass either way, which is precisely why these
        # matter: a tool refused at -32602 never reaches the table at all, so it
        # would satisfy this test while proving nothing about the tool.
        args_for = {
            "get_feedback_detail": {"feedback_id": "fb-1"},
            "get_similar_feedback": {"feedback_id": "fb-1"},
            "get_metrics_breakdown": {"dimension": "categories"},
        }
        with patch("mcp_handler.projects_table", strict), \
             patch("shared.mcp_delegate.get_delegate_lambda_client", return_value=_stub_domain_client()), \
             patch.dict(os.environ, {"METRICS_FUNCTION": "m", "PROJECTS_FUNCTION": "p"}):
            for tool_name in mcp_handler.TOOL_HANDLERS:
                before = strict.query.call_count
                self._call_tool(tool_name, args_for.get(tool_name, {}), lambda_context)
                delta = strict.query.call_count - before
                assert delta == 1, (
                    f"{tool_name}: expected exactly 1 projects-table query (the "
                    f"credential lookup), saw {delta}. A tool reading the table "
                    f"itself is what the LeadingKeys condition in api-stack.ts now "
                    f"forbids at deploy time — it would AccessDenied in production."
                )
        for method in self.FORBIDDEN:
            getattr(strict, method).assert_not_called()

    def test_autoseed_reads_no_project_rows_in_this_process(self, lambda_context):
        """Autoseed was the last in-process reader of project artifacts.

        It now delegates to `GET /projects/{id}/autoseed`, so `projects.py`'s own
        table handle must never be touched from this Lambda at all — not even a
        Query. That is a stronger claim than "it stayed within Query+UpdateItem",
        and it is the one the narrowed IAM grant depends on: with the
        `LeadingKeys` condition in place, an in-process project read would be
        refused by IAM rather than merely being untidy.
        """
        import mcp_handler
        import projects as projects_module
        strict_auth = self._strict_table()
        strict_data = self._strict_table()
        # Make even a READ fail: this table must not be consulted at all.
        strict_data.query.side_effect = AssertionError(
            "autoseed read the projects table in-process; it must delegate to "
            "GET /projects/{id}/autoseed instead"
        )
        with patch("mcp_handler.projects_table", strict_auth), \
             patch.object(projects_module, "projects_table", strict_data), \
             patch("shared.mcp_delegate.get_delegate_lambda_client", return_value=_stub_domain_client()), \
             patch.dict(os.environ, {"PROJECTS_FUNCTION": "voc-projects-api"}):
            response = mcp_handler.lambda_handler(
                {
                    "httpMethod": "GET",
                    "path": f"/v1/mcp/autoseed/{_TOKEN_PROJECT}",
                    "headers": {"authorization": f"Bearer {_VALID_TOKEN}"},
                },
                lambda_context,
            )
        assert response["statusCode"] == 200, response["body"]
        strict_data.query.assert_not_called()
        # Positive control: the credential lookup still happened, so this test
        # is exercising the route rather than being refused before it.
        strict_auth.query.assert_called_once()
        for method in self.FORBIDDEN:
            getattr(strict_data, method).assert_not_called()
            getattr(strict_auth, method).assert_not_called()

    @staticmethod
    def _table_calls(src: str) -> set[str]:
        """All methods called on the name `projects_table` in `src`, via AST.

        AST rather than line matching: a call split across lines, or aliased
        formatting, defeats a substring scan silently.  The tree cannot be
        defeated by formatting.
        """
        import ast
        import textwrap
        calls: set[str] = set()
        for node in ast.walk(ast.parse(textwrap.dedent(src))):
            if (
                isinstance(node, ast.Call)
                and isinstance(node.func, ast.Attribute)
                and isinstance(node.func.value, ast.Name)
                and node.func.value.id == "projects_table"
            ):
                calls.add(node.func.attr)
        return calls

    @staticmethod
    def _called_names(src: str) -> set[str]:
        """All bare-name calls (`foo(...)`) in `src`, via AST."""
        import ast
        import textwrap
        return {
            node.func.id
            for node in ast.walk(ast.parse(textwrap.dedent(src)))
            if isinstance(node, ast.Call) and isinstance(node.func, ast.Name)
        }

    def test_no_reachable_call_site_uses_a_non_granted_action(self):
        """Source-level half: the table operations reachable from this Lambda.

        mcp_handler.py's own call sites, plus projects.get_project (the only
        projects.py function the autoseed path reaches).  The rest of
        projects.py runs on the projects Lambda, whose role legitimately
        holds the write actions — scanning it here would be wrong.

        Each scan carries its own positive control: a walker that silently
        resolved nothing would report an empty (passing) set, so the granted
        calls it MUST see are asserted present — the same fix the vitest IAM
        filter got.  autoseed_project's control is different in kind: it has
        no direct table call, so the assertion is that its only path to the
        table is the get_project call this test scans.
        """
        import inspect

        import mcp_handler
        import projects as projects_module

        # Derived from the strict mock's configuration, not restated: GRANTED
        # is the single source of truth for what the IAM role permits, so the
        # AST expectation cannot drift from the runtime one.
        granted = set(self.GRANTED)

        handler_calls = self._table_calls(inspect.getsource(mcp_handler))
        assert handler_calls == granted, (
            f"mcp_handler touches projects_table via {handler_calls - granted} "
            f"which the narrowed IAM grant does not permit (or the scan lost "
            f"sight of the granted calls: saw {handler_calls})"
        )

        get_project_calls = self._table_calls(
            inspect.getsource(projects_module.get_project)
        )
        assert get_project_calls == {"query"}, (
            f"projects.get_project (reached via autoseed) touches "
            f"projects_table via {get_project_calls - granted}, or the scan "
            f"went blind (saw {get_project_calls})"
        )

        # autoseed_project itself: no direct table call, AND every DIRECT
        # bare-name callee resolving to a projects.py callable is on a pinned
        # allowlist whose members are either scanned above or verified
        # table-free here.  Deliberately one level deep and name-form only —
        # deeper indirection (an attribute-form call, or a helper growing its
        # own callee) is the runtime strict-mock test's job, which executes
        # the real path and cannot be fooled by call shape.  A new direct
        # callee (say, a save/update helper) fails this closure instead of
        # slipping past a comment that claimed get_project was the only route.
        autoseed_src = inspect.getsource(projects_module.autoseed_project)
        assert self._table_calls(autoseed_src) == set(), (
            "projects.autoseed_project now touches projects_table directly; "
            "scan its calls and re-check the grant"
        )
        table_free_helpers = {
            "_slugify", "_persona_to_markdown", "_document_to_markdown",
            "_build_steering_file",
        }
        allowed_callees = {"get_project"} | table_free_helpers
        callees = {
            name for name in self._called_names(autoseed_src)
            if hasattr(projects_module, name) and callable(getattr(projects_module, name))
        }
        unexpected = callees - allowed_callees
        assert unexpected == set(), (
            f"projects.autoseed_project now calls {unexpected}, which this "
            f"test has not verified to be table-free — scan them and extend "
            f"the allowlist deliberately"
        )
        assert "get_project" in callees  # positive control: the walker sees calls
        for helper in table_free_helpers:
            # Legible failure over a bare AttributeError when a private
            # helper is renamed/dropped: the allowlist above must move with it.
            assert hasattr(projects_module, helper), (
                f"projects.{helper} no longer exists — update "
                f"table_free_helpers to match autoseed_project's helpers"
            )
            helper_calls = self._table_calls(
                inspect.getsource(getattr(projects_module, helper))
            )
            assert helper_calls == set(), (
                f"projects.{helper} (reached via autoseed) now touches "
                f"projects_table via {helper_calls}"
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


# ===========================================================================
# 11. Read reach — the second axis
# ===========================================================================

class TestReadReachEnforcement:
    """Reach is enforced separately from scope, at dispatch.

    Scope says WHICH KIND of data a credential may read; reach says HOW FAR.
    A token can hold `projects:read` and still be refused a given project, and
    the two refusals are distinct code paths.

    Revert stories:
      • deleting the reach_allows call in _handle_tools_call fails
        test_project_set_token_cannot_read_a_project_outside_its_set;
      • letting a project-set token call a workspace-shaped tool fails
        test_project_set_token_cannot_read_the_feedback_corpus, which is the
        one that matters — the corpus has no project dimension, so allowing it
        hands a supposedly sealed credential every verbatim.
    """

    def _call(self, tool, token_info, arguments=None):
        import mcp_handler
        handler = MagicMock(return_value=_ok_result())
        original = mcp_handler.TOOL_HANDLERS.copy()
        try:
            mcp_handler.TOOL_HANDLERS[tool] = handler
            result = mcp_handler._handle_tools_call(
                req_id=1,
                params={"name": tool, "arguments": arguments or {}},
                token_info=token_info,
            )
        finally:
            mcp_handler.TOOL_HANDLERS.clear()
            mcp_handler.TOOL_HANDLERS.update(original)
        return result, handler

    def _token(self, **extra):
        return {"scopes": list(ALL_READ_SCOPES), "projects": [_TOKEN_PROJECT],
                "read_reach": REACH_WORKSPACE, **extra}

    # --- workspace reach (the default) -----------------------------------
    def test_workspace_token_reads_the_feedback_corpus(self):
        result, handler = self._call("search_feedback", self._token())
        assert "result" in result, result
        handler.assert_called_once()

    def test_workspace_token_reads_a_project_outside_its_own_set(self):
        """The default really is workspace-wide.

        Pinned deliberately, because it is the surprising half of the owner's
        decision: a credential minted inside one project can read another
        project's personas and documents. The mint UI is what has to say so.
        """
        result, handler = self._call(
            "get_project", self._token(), arguments={"project_id": "someone-elses"},
        )
        assert "result" in result, result
        # The tool receives the project it was ASKED for, not the token's own.
        assert handler.call_args.args[1]["project_id"] == "someone-elses"

    # --- project-set reach (the sealed option) ---------------------------
    def test_project_set_token_reads_a_project_in_its_set(self):
        result, handler = self._call(
            "get_project", self._token(read_reach=REACH_PROJECT_SET),
            arguments={"project_id": _TOKEN_PROJECT},
        )
        assert "result" in result, result
        handler.assert_called_once()

    def test_project_set_token_cannot_read_a_project_outside_its_set(self):
        result, handler = self._call(
            "get_project", self._token(read_reach=REACH_PROJECT_SET),
            arguments={"project_id": "someone-elses"},
        )
        assert result.get("error", {}).get("code") == -32003, result
        handler.assert_not_called()

    def test_project_set_token_cannot_read_the_feedback_corpus(self):
        """The load-bearing refusal.

        `voc-feedback` is keyed SOURCE#{platform} with no project_id, so
        `project-set` has nothing to narrow. Allowing the call "because the
        token holds feedback:read" would make a sealed credential a
        workspace-wide one.
        """
        for tool in ("search_feedback", "get_metrics_summary", "get_feedback_detail"):
            result, handler = self._call(tool, self._token(read_reach=REACH_PROJECT_SET))
            assert result.get("error", {}).get("code") == -32003, f"{tool}: {result}"
            handler.assert_not_called()

    # --- none ------------------------------------------------------------
    def test_none_reach_reads_nothing(self):
        for tool in ("search_feedback", "get_project"):
            result, handler = self._call(
                tool, self._token(read_reach=REACH_NONE),
                arguments={"project_id": _TOKEN_PROJECT},
            )
            assert result.get("error", {}).get("code") == -32003, f"{tool}: {result}"
            handler.assert_not_called()

    # --- project resolution ---------------------------------------------
    def test_single_project_token_needs_no_project_argument(self):
        """The common case stays ergonomic: one project, no argument required."""
        result, handler = self._call("list_personas", self._token())
        assert "result" in result, result
        assert handler.call_args.args[1]["project_id"] == _TOKEN_PROJECT

    def test_explicit_argument_wins_over_the_token_default(self):
        result, handler = self._call(
            "list_personas", self._token(), arguments={"project_id": "other"},
        )
        assert "result" in result, result
        assert handler.call_args.args[1]["project_id"] == "other"

    def test_ambiguous_project_set_requires_an_explicit_argument(self):
        """Several projects and no argument resolves to a request, not a guess.

        -32602 (invalid params) rather than -32003: the caller can fix this by
        naming the project, and calling it Forbidden would send them looking for
        a different token instead.
        """
        result, handler = self._call(
            "get_project", self._token(projects=["proj-a", "proj-b"]),
        )
        assert result.get("error", {}).get("code") == -32602, result
        assert "project_id" in result["error"]["message"]
        handler.assert_not_called()

    def test_empty_project_set_cannot_default_a_project(self):
        result, handler = self._call("get_project", self._token(projects=[]))
        assert "error" in result, result
        handler.assert_not_called()

    @pytest.mark.parametrize("bad", ["", "   ", None, 123, ["proj-a"], {}, True])
    def test_a_present_but_unusable_project_argument_is_refused(self, bad):
        """Junk in `project_id` is -32602, NOT a silent fall back to the token's project.

        Falling back would read a DIFFERENT project than the client named and
        report success — the caller receives another project's personas and
        documents believing they are the ones they asked for. An error is the
        only honest answer, and it is why absence and garbage take different
        paths through _resolve_project_id.
        """
        result, handler = self._call(
            "get_project", self._token(), arguments={"project_id": bad},
        )
        assert result.get("error", {}).get("code") == -32602, result
        assert "project_id" in result["error"]["message"]
        handler.assert_not_called()

    def test_an_absent_project_argument_still_defaults(self):
        """Absence is a different intent from garbage and keeps the ergonomics."""
        result, handler = self._call("get_project", self._token())
        assert "result" in result, result
        assert handler.call_args.args[1]["project_id"] == _TOKEN_PROJECT

    def test_none_reach_is_told_about_reach_not_about_an_argument(self):
        """A `none`-reach token cannot be helped by supplying a project_id.

        Reach is checked before the missing-argument branch, so the refusal names
        the thing the caller would have to change. The earlier ordering sent them
        after an argument that could never work.
        """
        result, handler = self._call(
            "get_project", self._token(read_reach=REACH_NONE, projects=["a", "b"]),
        )
        assert result.get("error", {}).get("code") == -32003, result
        assert "read reach" in result["error"]["message"], result["error"]["message"]
        handler.assert_not_called()

    def test_project_set_reach_on_a_workspace_tool_names_reach_too(self):
        """Same ordering rule for the other reach-covers-nothing case."""
        result, handler = self._call(
            "search_feedback", self._token(read_reach=REACH_PROJECT_SET),
        )
        assert result.get("error", {}).get("code") == -32003, result
        assert "read reach" in result["error"]["message"]
        handler.assert_not_called()

    def test_reach_is_checked_even_when_the_scope_is_held(self):
        """The two gates are independent; holding the scope is not enough."""
        token = self._token(read_reach=REACH_PROJECT_SET)
        assert SCOPE_PROJECTS_READ in token["scopes"]
        result, handler = self._call(
            "get_project", token, arguments={"project_id": "not-in-set"},
        )
        assert result.get("error", {}).get("code") == -32003, result
        assert "read reach" in result["error"]["message"], (
            "the refusal must name reach, not scope, or the operator re-mints "
            f"the wrong thing; got: {result['error']['message']}"
        )
        handler.assert_not_called()


# ===========================================================================
# 12. Autoseed goes through the same gates as the tools
# ===========================================================================

class TestAutoseedAuthorization:
    """GET /mcp/autoseed/{project_id} is a project-shaped read.

    It returns the project's personas and documents — exactly what get_project
    serves — so it must pass the same scope and reach checks. The old code
    compared the path project to the token's single project and checked no scope
    at all.
    """

    def _get(self, project_id, row, lambda_context):
        """Drive the autoseed route, stubbing the DELEGATED call.

        `seed` is now the Lambda invoke rather than an in-process
        `autoseed_project`, which makes these assertions stronger than they were:
        `seed.assert_not_called()` used to mean "the helper did not run", and now
        means "nothing was asked of the projects function at all" — the refusal
        happens before this function spends anyone else's permissions.
        """
        import mcp_handler
        seed = MagicMock(return_value={
            "Payload": io.BytesIO(json.dumps({
                "statusCode": 200, "body": json.dumps({"ok": True}),
            }).encode()),
        })
        client = MagicMock()
        client.invoke = seed
        with patch("mcp_handler.projects_table") as mock_table, \
             patch("shared.mcp_delegate.get_delegate_lambda_client", return_value=client), \
             patch.dict(os.environ, {"PROJECTS_FUNCTION": "voc-projects-api"}):
            mock_table.query.return_value = {"Items": [row]}
            mock_table.update_item.return_value = {}
            response = mcp_handler.lambda_handler(
                {
                    "httpMethod": "GET",
                    "path": f"/v1/mcp/autoseed/{project_id}",
                    "headers": {"authorization": f"Bearer {_VALID_TOKEN}"},
                },
                lambda_context,
            )
        return response, seed

    def test_workspace_token_may_autoseed_any_project(self, lambda_context):
        response, seed = self._get("proj_20260603094346", _token_row(), lambda_context)
        assert response["statusCode"] == 200, response["body"]
        seed.assert_called_once()

    def test_project_set_token_may_autoseed_its_own_project(self, lambda_context):
        row = _token_row(read_reach=REACH_PROJECT_SET)
        response, seed = self._get(_TOKEN_PROJECT, row, lambda_context)
        assert response["statusCode"] == 200, response["body"]
        seed.assert_called_once()

    def test_project_set_token_refused_outside_its_set(self, lambda_context):
        row = _token_row(read_reach=REACH_PROJECT_SET)
        response, seed = self._get("proj_20260603094346", row, lambda_context)
        assert response["statusCode"] == 403, response["body"]
        seed.assert_not_called()

    def test_token_without_projects_scope_is_refused(self, lambda_context):
        """The check the old equality test did not perform at all."""
        row = _token_row(scopes=[SCOPE_FEEDBACK_READ])
        response, seed = self._get(_TOKEN_PROJECT, row, lambda_context)
        assert response["statusCode"] == 403, response["body"]
        assert SCOPE_PROJECTS_READ in json.loads(response["body"])["message"]
        seed.assert_not_called()

    def test_none_reach_is_refused(self, lambda_context):
        row = _token_row(read_reach=REACH_NONE)
        response, seed = self._get(_TOKEN_PROJECT, row, lambda_context)
        assert response["statusCode"] == 403, response["body"]
        seed.assert_not_called()


# ===========================================================================
# 12. Claim synthesis — the MCP Lambda as an authorization authority
# ===========================================================================

class TestClaimSynthesis:
    """No field of a JSON-RPC request may influence the synthesized identity.

    Delegating makes this function an authorization authority: it tells the
    domain Lambda who is calling, and that Lambda believes it, because in every
    other case the claims came from API Gateway's Cognito authorizer. So the
    identity must derive ONLY from the stored credential.

    The guarantee is STRUCTURAL rather than filtered — `synthetic_claims` takes
    the token record and nothing else, so the request is not in scope to leak
    from — and these tests exist because that structure is easy to undo by
    "helpfully" passing the arguments in later.

    Revert stories:
      • making synthetic_claims accept the request (or merging `arguments` into
        the authorizer context) fails test_arguments_cannot_forge_the_subject
        and test_arguments_cannot_forge_group_membership;
      • dropping the `mcp:` prefix fails test_the_subject_is_namespaced, which is
        what stops a token id from colliding with a Cognito sub;
      • defaulting `cognito:groups` to the minter's groups fails
        test_no_credential_carries_admin_group, the one that keeps a bearer
        token off every require_admin route.
    """

    HOSTILE_ARGUMENTS: ClassVar[dict] = {
        "sub": "00000000-0000-0000-0000-000000000000",
        "cognito:groups": "admins",
        "email": "admin@example.com",
        "requestContext": {"authorizer": {"claims": {"sub": "impostor",
                                                     "cognito:groups": "admins"}}},
        "authorizer": {"claims": {"sub": "impostor"}},
        "claims": {"sub": "impostor"},
        "project_id": _TOKEN_PROJECT,
    }

    def _claims_from_a_delegated_call(self, arguments, row=None, tool="get_project"):
        """Run a tool and return the claims the domain function was handed."""
        import mcp_handler
        client = _stub_domain_client({"project": {"name": "P"}, "personas": [],
                                      "documents": []})
        with patch("mcp_handler.projects_table") as table, \
             patch("shared.mcp_delegate.get_delegate_lambda_client", return_value=client), \
             patch.dict(os.environ, {"METRICS_FUNCTION": "m", "PROJECTS_FUNCTION": "p"}):
            table.query.return_value = {"Items": [row or _token_row()]}
            table.update_item.return_value = {}
            mcp_handler._handle_tools_call(
                1, {"name": tool, "arguments": arguments}, row or _token_row(),
            )
        event = json.loads(client.invoke.call_args.kwargs["Payload"])
        return event["requestContext"]["authorizer"]["claims"], event

    def test_arguments_cannot_forge_the_subject(self):
        claims, _event = self._claims_from_a_delegated_call(dict(self.HOSTILE_ARGUMENTS))

        assert claims["sub"] == f"mcp:{_MINTED.token_id}"
        assert "impostor" not in json.dumps(claims)

    def test_arguments_cannot_forge_group_membership(self):
        claims, _event = self._claims_from_a_delegated_call(dict(self.HOSTILE_ARGUMENTS))

        assert claims["cognito:groups"] == ""

    def test_arguments_cannot_smuggle_a_whole_request_context(self):
        """A nested `requestContext` in the arguments must not be merged.

        The synthesized event is BUILT, never merged into, so an argument that
        happens to be shaped like an authorizer context has nowhere to land.
        """
        _claims, event = self._claims_from_a_delegated_call(dict(self.HOSTILE_ARGUMENTS))

        assert set(event["requestContext"]) == {"authorizer", "stage"}
        assert set(event["requestContext"]["authorizer"]) == {"claims"}

    def test_the_subject_is_namespaced(self):
        """A service credential can never collide with a Cognito subject.

        Cognito subs are UUIDs; the `mcp:` prefix makes the two sets disjoint by
        construction, which matters wherever a row is keyed by subject — the same
        discipline the ballot keys use with `user:` / `anon:`.
        """
        from shared.mcp_delegate import SYNTHETIC_SUBJECT_PREFIX, synthetic_claims

        claims = synthetic_claims(_token_row())

        assert claims["sub"].startswith(SYNTHETIC_SUBJECT_PREFIX)
        assert claims["sub"] == f"mcp:{_MINTED.token_id}"

    def test_no_credential_carries_admin_group(self):
        """Whatever the row says, the delegated call is not an admin.

        No token record has a groups field to forward — the mint route records
        `created_by` for provenance only — so an admin-gated route stays refused
        even if a later phase maps a tool onto one by mistake.
        """
        from shared.api import get_caller_groups, require_admin
        from shared.mcp_delegate import DomainCall, build_proxy_event, synthetic_claims

        row = _token_row(created_by="an-admins-cognito-sub", acting_groups=["admins"])
        event = build_proxy_event(
            DomainCall(function_name="f", method="GET", path="/x"),
            synthetic_claims(row),
        )

        assert get_caller_groups(event) == []
        with pytest.raises(Exception, match="Admin"):
            require_admin(event)

    def test_the_claim_set_is_exactly_what_is_declared(self):
        """An unconsidered claim cannot arrive unremarked.

        Asserted as an exact set rather than a subset: a claim added here is a
        statement about identity that the domain functions will act on.
        """
        from shared.mcp_delegate import SYNTHETIC_CLAIM_KEYS, synthetic_claims

        assert set(synthetic_claims(_token_row())) == SYNTHETIC_CLAIM_KEYS

    def test_a_row_without_a_token_id_is_refused_rather_than_anonymous(self):
        """An unattributable credential must not produce a call.

        Falling back to a placeholder subject would attribute an agent's actions
        to nobody — and in a later phase, its WRITES to nobody.
        """
        from shared.mcp_delegate import DelegationUnavailable, synthetic_claims

        row = _token_row()
        del row["token_id"]

        with pytest.raises(DelegationUnavailable):
            synthetic_claims(row)

    def test_the_synthesized_identity_is_what_the_route_reads(self):
        """End to end through the helper the domain handlers actually use.

        Asserting the dict shape alone would pass even if the nesting were wrong;
        `get_caller_subject` is the function every project route calls, and it
        raises when the claim is absent.
        """
        from shared.api import get_caller_subject

        _claims, event = self._claims_from_a_delegated_call({"project_id": _TOKEN_PROJECT})

        assert get_caller_subject(event) == f"mcp:{_MINTED.token_id}"
