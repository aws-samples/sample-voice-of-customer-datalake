"""Tests for the MCP protocol ENVELOPE (plan Phase 2b).

Phase 2a moved what the tools read — every tool delegates to the route that owns
its data, covered by `test_mcp_delegation.py`. This file is the envelope around
those tools: the version handshake, the transport headers, the result
discriminator, the catalogue's shape, and what happens to a request this server
cannot serve. A separate file from `test_mcp_security.py` and
`test_mcp_delegation.py` for the reason those two are separate from each other —
credential rules, data correctness and protocol conformance are three subjects
with three failure modes, and one 4 000-line file about all three is a file
nobody can navigate.

Same standard as its siblings: assert the invariant, and be able to say which
revert makes each assertion fail.

  TestVersionNegotiation
    — the handler pinned ONE protocol version and answered `initialize` with it
      whatever was asked, which is a handshake in shape only. Replacing
      `_negotiate_protocol_version` with a constant fails
      test_each_supported_version_is_echoed_back.

  TestProtocolVersionHeader
    — a client speaking a revision this server does not implement used to be
      answered as though it spoke one that it does; the failure then surfaced
      several calls later as a field it could not parse. Deleting the header
      check fails test_an_unsupported_version_header_is_refused.

  TestEncodedWordHeaders
    — the `=?base64?...?=` sentinel form is what a conforming client sends when
      it cannot be sure a value survives an intermediary. Treating it as literal
      text fails test_an_encoded_protocol_version_is_decoded, and — worse —
      would report "unsupported version =?base64?…?=" for a version this server
      does speak.

  TestRoutingHeaders
    — `MCP-Method` / `MCP-Name` let an intermediary route without parsing a body,
      which means the header and the body can DISAGREE. Serving the body anyway
      fails test_a_method_header_contradicting_the_body_is_refused: one hop
      routed on a value the next hop ignored.

  TestResultDiscriminator
    — every result carried a bare object and a client had to infer its shape
      from which keys were present (`{}` is both a pong and an ack; a tool error
      differs from a tool result by a boolean). Making `resultType` optional in
      `_jsonrpc_result` fails test_every_method_answers_with_a_declared_result_type,
      and the AST check fails the moment a result is built outside the builder.

  TestMethodNotAllowed / TestUnknownMethod
    — GET and DELETE are transport methods this server does not implement, so
      they are 405 with an `Allow` header; an unknown JSON-RPC method is -32601.
      Answering either any other way fails these.

  TestToolCatalogueIsFilteredByAuthorization
    — the spec blesses a credential-shaped tool set, and every caller used to see
      every tool regardless of its scopes: it was shown a tool, called it, and was
      refused -32003. Reverting `_handle_tools_list` to `{"tools": MCP_TOOLS}`
      fails test_a_single_scope_credential_sees_only_that_domains_tools.

  TestAnnotationsAndCostClass
    — a client cannot tell a keyed read from a capped scan by looking at a tool
      name. Dropping the `_published_tool` wrapper fails every test here.

  TestADeadCredentialFailsTheHandshake
    — the honesty defect: a revoked or expired token completed `initialize` and
      failed only at the first `tools/call`, so a dead credential presented as a
      connected server. Deleting `_refuse_a_dead_credential` fails
      test_an_expired_credential_is_refused_at_initialize, and reverting it to
      refuse an ABSENT credential too fails
      test_no_credential_at_all_still_initializes.
"""

import ast
import base64
import inspect
import io
import json
import os
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import ClassVar
from unittest.mock import MagicMock, patch

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import mcp_handler
from shared.mcp_tokens import (
    ALL_READ_SCOPES,
    MCP_TOKEN_PK,
    REACH_NONE,
    REACH_PROJECT_SET,
    REACH_WORKSPACE,
    SCOPE_FEEDBACK_READ,
    SCOPE_METRICS_READ,
    SCOPE_PROJECTS_READ,
    mint_token,
    token_sk,
)

# One real credential for the module, minted through the production helper for
# the reason test_mcp_security.py states: a hand-written token would let these
# tests keep passing after a format change that broke every real client.
_MINTED = mint_token()
_TOKEN = _MINTED.raw
_PROJECT = "proj_20260819143000"


def _token_row(**extra) -> dict:
    """A stored row that authenticates `_TOKEN`, widest shape by default."""
    return {
        "pk": MCP_TOKEN_PK,
        "sk": token_sk(_MINTED.token_id),
        "token_id": _MINTED.token_id,
        "name": "envelope test token",
        "secret_hash": _MINTED.secret_hash,
        "scopes": list(ALL_READ_SCOPES),
        "projects": [_PROJECT],
        "read_reach": REACH_WORKSPACE,
        **extra,
    }


def _event(method: str = "initialize", *, params: dict | None = None,
           headers: dict | None = None, token: str | None = None,
           http_method: str = "POST", path: str = "/v1/mcp",
           body: str | None = None) -> dict:
    """A Lambda proxy event for one JSON-RPC request.

    Header names are passed through as given rather than lowercased, because both
    spellings are real: API Gateway lowercases in proxy mode, a direct invoke does
    not, and the guard has to hold for both.
    """
    request_headers = dict(headers or {})
    if token is not None:
        request_headers["authorization"] = f"Bearer {token}"
    return {
        "httpMethod": http_method,
        "path": path,
        "headers": request_headers,
        "body": body if body is not None else json.dumps({
            "jsonrpc": "2.0", "id": 1, "method": method, "params": params or {},
        }),
    }


def _stub_domain_client():
    """A Lambda client answering any delegated route with an empty 200 payload."""
    client = MagicMock()
    client.invoke.side_effect = lambda **_kwargs: {
        "Payload": io.BytesIO(json.dumps({
            "statusCode": 200, "body": json.dumps({"items": [], "project": {}}),
        }).encode()),
    }
    return client


def _call(event: dict, *, row: dict | None = None) -> tuple[int, dict]:
    """Drive `lambda_handler` end to end; return (status, parsed body).

    The token store and the delegation client are stubbed because this file is
    about the envelope: what the store holds is `test_mcp_security.py`'s subject
    and what the routes answer is `test_mcp_delegation.py`'s.
    """
    with patch("mcp_handler.projects_table") as table, \
         patch("shared.mcp_delegate.get_delegate_lambda_client",
               return_value=_stub_domain_client()), \
         patch.dict(os.environ, {"METRICS_FUNCTION": "m", "PROJECTS_FUNCTION": "p"}):
        table.query.return_value = {"Items": [row] if row is not None else [_token_row()]}
        table.update_item.return_value = {}
        response = mcp_handler.lambda_handler(event, MagicMock())
    return response["statusCode"], json.loads(response["body"])


def _encoded(value: str) -> str:
    """The encoded-word sentinel form of a header value."""
    return f"=?base64?{base64.b64encode(value.encode()).decode()}?="


# ===========================================================================
# Version negotiation
# ===========================================================================

class TestVersionNegotiation:
    """`initialize` answers with the version the SESSION will speak.

    A single pinned constant answered the same string whatever the client asked
    for, which is not negotiation — and bumping that constant without the rest of
    this file would have claimed a conformance the envelope did not have.
    """

    def test_more_than_one_version_is_supported(self):
        """Anti-vacuity: every test below is about a RANGE.

        With one entry, echoing and falling back are the same answer and the
        whole class would pass while negotiating nothing.
        """
        assert len(mcp_handler.SUPPORTED_PROTOCOL_VERSIONS) >= 3, (
            f"expected a range of revisions, found "
            f"{mcp_handler.SUPPORTED_PROTOCOL_VERSIONS}"
        )
        assert len(set(mcp_handler.SUPPORTED_PROTOCOL_VERSIONS)) == len(
            mcp_handler.SUPPORTED_PROTOCOL_VERSIONS
        ), "a repeated revision would make the preference order meaningless"

    def test_the_supported_versions_are_ordered_newest_first(self):
        """The order is load-bearing: the first entry is the counter-offer.

        Asserted as a property of the values (ISO dates sort lexically) rather
        than by restating the list, so adding a revision cannot leave this test
        agreeing with a stale copy of it.
        """
        versions = list(mcp_handler.SUPPORTED_PROTOCOL_VERSIONS)
        assert versions == sorted(versions, reverse=True)
        assert mcp_handler.PREFERRED_PROTOCOL_VERSION == versions[0]

    @pytest.mark.parametrize("version", mcp_handler.SUPPORTED_PROTOCOL_VERSIONS)
    def test_each_supported_version_is_echoed_back(self, version):
        """A client asking for a revision this server speaks gets that revision.

        Parametrized over the live tuple, so a revision added to the server is
        covered here without an edit — and one that is listed but not honoured
        fails.
        """
        status, body = _call(_event("initialize", params={"protocolVersion": version}))

        assert status == 200, body
        assert body["result"]["protocolVersion"] == version

    def test_an_unknown_requested_version_is_answered_with_the_newest(self):
        """A counter-offer, not an error.

        `initialize` is where a client learns what it is talking to, so refusing
        an unknown request would leave it with nothing to fall back to. Declining
        the counter-offer is the client's decision, made by closing the
        connection.
        """
        status, body = _call(_event("initialize", params={"protocolVersion": "1999-01-01"}))

        assert status == 200, body
        assert body["result"]["protocolVersion"] == mcp_handler.PREFERRED_PROTOCOL_VERSION
        assert "error" not in body

    @pytest.mark.parametrize("requested", [None, "", 2025, ["2025-06-18"], {}])
    def test_an_unusable_requested_version_still_negotiates(self, requested):
        """`params.protocolVersion` is caller-controlled JSON and need not be a
        string. A non-string must not become a 500 or an echo of itself."""
        params = {} if requested is None else {"protocolVersion": requested}
        status, body = _call(_event("initialize", params=params))

        assert status == 200, body
        assert body["result"]["protocolVersion"] == mcp_handler.PREFERRED_PROTOCOL_VERSION

    def test_the_negotiated_version_is_one_the_server_declares(self):
        """Whatever is asked, the answer is from the declared set.

        The property that matters to a client: it can always validate the answer
        against `server/discover`.
        """
        for requested in (*mcp_handler.SUPPORTED_PROTOCOL_VERSIONS, "nonsense", None):
            negotiated = mcp_handler._negotiate_protocol_version(requested)
            assert negotiated in mcp_handler.SUPPORTED_PROTOCOL_VERSIONS


# ===========================================================================
# server/discover
# ===========================================================================

class TestServerDiscover:
    """A client can learn what this server supports without a failed call.

    Discovering a method by receiving -32601 for it cannot distinguish "not
    implemented here" from "spelled differently here", and costs a round trip per
    guess.
    """

    def _discover(self) -> dict:
        status, body = _call(_event("server/discover"))
        assert status == 200, body
        return body["result"]

    def test_discover_needs_no_credential(self):
        """It answers what the SERVER supports, which a client needs before it has
        decided what to present. It names no project, no tool and no data."""
        with patch("mcp_handler.projects_table") as table:
            response = mcp_handler.lambda_handler(_event("server/discover"), MagicMock())
        assert response["statusCode"] == 200, response["body"]
        table.query.assert_not_called()

    def test_it_reports_every_protocol_version_the_server_speaks(self):
        result = self._discover()

        assert result["protocolVersions"] == list(mcp_handler.SUPPORTED_PROTOCOL_VERSIONS)
        assert result["preferredProtocolVersion"] == mcp_handler.PREFERRED_PROTOCOL_VERSION

    def test_it_reports_every_method_the_server_dispatches(self):
        """Derived from the dispatch tables, so a method that exists is listed and
        one that is only listed cannot exist."""
        result = self._discover()
        dispatched = {*mcp_handler.MCP_METHODS, *mcp_handler.MCP_AUTH_METHODS}

        assert set(result["methods"]) == dispatched
        assert set(result["authenticatedMethods"]) == set(mcp_handler.MCP_AUTH_METHODS)
        # And the split is real: an authenticated method is not also served
        # without a credential.
        assert not set(mcp_handler.MCP_AUTH_METHODS) & set(mcp_handler.MCP_METHODS)

    def test_it_reports_the_transport_headers_it_validates(self):
        """A client cannot conform to a rule it cannot discover.

        Compared case-insensitively against what the handler READS, because the
        two spellings are deliberately different: discovery reports the form a
        client sends, the guard reads the form API Gateway delivers. Both must name
        the same set of headers.
        """
        result = self._discover()

        assert {name.lower() for name in result["transportHeaders"]} == set(
            mcp_handler.TRANSPORT_HEADERS
        )

    def test_it_reports_them_in_the_spelling_a_client_sends(self):
        """The internal lowercase form is an artefact of API Gateway's
        normalisation, and publishing it would document an implementation detail
        as a contract."""
        result = self._discover()

        assert "MCP-Protocol-Version" in result["transportHeaders"]
        assert result["transportHeaders"] == sorted(result["transportHeaders"])

    def test_it_reports_the_result_type_vocabulary(self):
        result = self._discover()

        assert set(result["resultTypes"]) == set(mcp_handler.RESULT_TYPES)

    def test_it_reports_the_cost_class_vocabulary_in_order(self):
        """Cheapest first: an unordered set of adjectives does not say which of
        two classes is the expensive one."""
        result = self._discover()

        assert result["costClasses"] == list(mcp_handler.COST_CLASSES)

    def test_it_says_the_tool_list_varies_by_credential(self):
        """Cheaper than letting a client find out by calling a tool it was never
        granted — and it is why discovery does not list tools itself."""
        result = self._discover()

        assert result["toolsVaryByCredential"] is True
        assert "tools" not in result

    def test_the_declared_capabilities_match_the_handshake(self):
        """One statement of what this server can do, or the two answers disagree
        about the same fact."""
        result = self._discover()
        _status, initialize = _call(_event("initialize"))

        assert result["capabilities"] == initialize["result"]["capabilities"]

    def test_a_disallowed_origin_is_refused_before_discovery_answers(self):
        """The DNS-rebinding guard covers the new method too.

        Discovery is unauthenticated and describes the server, which is exactly
        the sort of endpoint that gets added after a guard and outside it.
        """
        with patch("mcp_handler.ALLOWED_ORIGIN", "https://voc.example.com"):
            response = mcp_handler.lambda_handler(
                _event("server/discover", headers={"Origin": "https://evil.example.net"}),
                MagicMock(),
            )

        assert response["statusCode"] == 403, response["body"]


# ===========================================================================
# The MCP-Protocol-Version transport header
# ===========================================================================

class TestProtocolVersionHeader:
    """The transport's own version statement, checked rather than assumed."""

    @pytest.mark.parametrize("version", mcp_handler.SUPPORTED_PROTOCOL_VERSIONS)
    def test_a_supported_version_header_is_served(self, version):
        status, body = _call(_event(
            "initialize", headers={"MCP-Protocol-Version": version},
        ))

        assert status == 200, body
        assert "result" in body

    def test_an_unsupported_version_header_is_refused(self):
        """400 and -32600, and the message names what the server does speak.

        `-32600 Invalid Request` rather than `-32602 Invalid params`: the BODY may
        be perfectly well formed, and it is the request as a whole that is not.
        """
        status, body = _call(_event(
            "initialize", headers={"MCP-Protocol-Version": "1999-01-01"},
        ))

        assert status == 400
        assert body["error"]["code"] == -32600
        assert mcp_handler.PREFERRED_PROTOCOL_VERSION in body["error"]["message"]

    def test_an_absent_version_header_is_served(self):
        """The header postdates the first revisions of the transport, so requiring
        it would refuse every client written against one of those."""
        status, body = _call(_event("initialize"))

        assert status == 200, body

    def test_an_empty_version_header_is_refused(self):
        """A client that sent the header empty said something, and what it said is
        not a version. Reading it as absence would let a client that MEANT to name
        a version be served silently on another one."""
        status, body = _call(_event(
            "initialize", headers={"MCP-Protocol-Version": ""},
        ))

        assert status == 400
        assert body["error"]["code"] == -32600

    def test_the_header_is_matched_case_insensitively(self):
        """API Gateway lowercases header names in proxy mode; a direct invoke does
        not. The guard has to hold for both, which is the lesson `Origin` already
        taught this handler."""
        for spelling in ("MCP-Protocol-Version", "mcp-protocol-version",
                         "Mcp-Protocol-Version"):
            status, _body = _call(_event(
                "initialize", headers={spelling: "1999-01-01"},
            ))
            assert status == 400, f"{spelling} was not read"

    def test_a_bad_version_header_never_reaches_the_token_store(self):
        """Header validation runs before authentication: a malformed request must
        not buy a probe of the credential store, the same property the Origin
        guard has."""
        with patch("mcp_handler.projects_table") as table:
            response = mcp_handler.lambda_handler(
                _event("tools/list", headers={"MCP-Protocol-Version": "1999-01-01"},
                       token=_TOKEN),
                MagicMock(),
            )

        assert response["statusCode"] == 400
        table.query.assert_not_called()

    def test_the_header_is_validated_on_the_authenticated_path_too(self):
        """Not only on the handshake: a session that drifts mid-stream is exactly
        what the header exists to catch."""
        status, body = _call(_event(
            "tools/list", headers={"MCP-Protocol-Version": "1999-01-01"}, token=_TOKEN,
        ))

        assert status == 400
        assert body["error"]["code"] == -32600

    def test_the_declared_headers_are_all_reachable_from_a_browser(self):
        """A header the server validates but a browser's preflight blocks is a
        rule with no reachable subject.

        Compared case-insensitively because CORS header matching is, and because
        the wire spelling and the read spelling are deliberately different.
        """
        allowed = {
            name.strip().lower()
            for name in mcp_handler.CORS_HEADERS['Access-Control-Allow-Headers'].split(',')
        }
        for header in mcp_handler.TRANSPORT_HEADERS:
            assert header in allowed, (
                f"{header} is validated but not allowed through a CORS preflight"
            )


# ===========================================================================
# The encoded-word sentinel form
# ===========================================================================

class TestEncodedWordHeaders:
    """`=?base64?<payload>?=` — what a conforming client sends when it cannot be
    sure a header value survives an intermediary.

    Treating it as literal text is not merely a missing feature: it reports
    "unsupported version =?base64?…?=" for a version this server does speak,
    sending the caller after a version number.
    """

    def test_an_encoded_protocol_version_is_decoded(self):
        status, body = _call(_event("initialize", headers={
            "MCP-Protocol-Version": _encoded(mcp_handler.PREFERRED_PROTOCOL_VERSION),
        }))

        assert status == 200, body

    def test_an_encoded_unsupported_version_is_still_refused(self):
        """Decoding is not permitting: the sentinel changes the spelling, not the
        rule. The message names the DECODED value, which is what the caller can
        act on."""
        status, body = _call(_event("initialize", headers={
            "MCP-Protocol-Version": _encoded("1999-01-01"),
        }))

        assert status == 400
        assert "1999-01-01" in body["error"]["message"]
        assert "=?base64?" not in body["error"]["message"]

    def test_an_encoded_method_header_is_decoded(self):
        status, body = _call(_event("ping", headers={
            "MCP-Method": _encoded("ping"),
        }))

        assert status == 200, body

    def test_an_encoded_name_header_is_decoded(self):
        status, body = _call(_event(
            "tools/call",
            params={"name": "get_metrics_summary", "arguments": {}},
            headers={"MCP-Name": _encoded("get_metrics_summary")},
            token=_TOKEN,
        ))

        assert status == 200, body
        assert "error" not in body, body

    @pytest.mark.parametrize("payload", [
        "not-base64!!",          # not base64 at all
        "//////",                # decodes to bytes that are not UTF-8
        "",                      # the sentinel with nothing in it
        "aGVsbG8=extra",         # trailing junk after valid base64
    ])
    def test_a_malformed_sentinel_is_refused_as_an_encoding_fault(self, payload):
        """Refused, and refused for the right REASON.

        Comparing `=?base64?not-base64?=` literally against the version list
        would report an unsupported-version error, which sends the caller looking
        for a version number when the fault is the encoding. The message has to
        name the encoding.
        """
        status, body = _call(_event("initialize", headers={
            "MCP-Protocol-Version": f"=?base64?{payload}?=",
        }))

        assert status == 400
        assert body["error"]["code"] == -32600
        assert "base64" in body["error"]["message"]

    def test_a_plain_value_is_not_treated_as_encoded(self):
        """The sentinel is optional and a plain value is the ordinary spelling.

        Pinned so a decoder that got greedy — stripping `=` padding, say — cannot
        start mangling ordinary values.
        """
        assert mcp_handler._decoded_header("2025-06-18", "x") == "2025-06-18"
        # A value that merely CONTAINS the marker is not in sentinel form.
        assert mcp_handler._decoded_header("x=?base64?y?=", "x") == "x=?base64?y?="

    def test_a_decoded_value_is_compared_after_decoding_not_before(self):
        """Unit-level, so the property holds for every header rather than for the
        one an end-to-end test happens to exercise."""
        for value in ("tools/call", "search_feedback", "2026-07-28"):
            assert mcp_handler._decoded_header(_encoded(value), "x") == value


# ===========================================================================
# The MCP-Method and MCP-Name routing echoes
# ===========================================================================

class TestRoutingHeaders:
    """A routing echo that contradicts its body has not said what it wants.

    These headers exist so an intermediary can route without parsing a body,
    which is exactly what makes a disagreement dangerous: one hop routes on the
    header, the next acts on the body, and the two hops are serving different
    requests. Refused rather than resolved in either direction — there is no way
    to know which statement was the caller's intent.
    """

    def test_a_matching_method_header_is_served(self):
        status, body = _call(_event("ping", headers={"MCP-Method": "ping"}))

        assert status == 200, body
        assert "result" in body

    def test_a_method_header_contradicting_the_body_is_refused(self):
        status, body = _call(_event("ping", headers={"MCP-Method": "tools/call"}))

        assert status == 400
        assert body["error"]["code"] == -32600
        assert "tools/call" in body["error"]["message"]
        assert "ping" in body["error"]["message"]

    def test_an_absent_method_header_is_served(self):
        """Both echoes are optional; absence is silent."""
        status, body = _call(_event("ping"))

        assert status == 200, body

    def test_a_matching_name_header_is_served(self):
        status, body = _call(_event(
            "tools/call",
            params={"name": "get_metrics_summary", "arguments": {}},
            headers={"MCP-Name": "get_metrics_summary"},
            token=_TOKEN,
        ))

        assert status == 200, body
        assert "error" not in body, body

    def test_a_name_header_contradicting_the_body_is_refused(self):
        """And refused BEFORE the tool runs: a header naming one tool while the
        body calls another must not spend anyone's permissions on either."""
        with patch("mcp_handler.projects_table") as table, \
             patch("shared.mcp_delegate.get_delegate_lambda_client") as client:
            table.query.return_value = {"Items": [_token_row()]}
            response = mcp_handler.lambda_handler(_event(
                "tools/call",
                params={"name": "get_metrics_summary", "arguments": {}},
                headers={"MCP-Name": "search_feedback"},
                token=_TOKEN,
            ), MagicMock())

        assert response["statusCode"] == 400, response["body"]
        assert json.loads(response["body"])["error"]["code"] == -32600
        client.assert_not_called()

    def test_a_name_header_on_a_method_that_names_no_tool_is_refused(self):
        """`MCP-Name` names a TOOL, so on `tools/list` it asks for something this
        server cannot do — and answering the list would answer a different
        question."""
        status, body = _call(_event(
            "tools/list", headers={"MCP-Name": "search_feedback"}, token=_TOKEN,
        ))

        assert status == 400
        assert body["error"]["code"] == -32600
        assert "tools/call" in body["error"]["message"]

    def test_a_name_header_with_no_name_in_the_body_is_refused(self):
        """A `tools/call` with no `name` is malformed anyway, but a header naming
        a tool while the body names none is the disagreement case: it must not be
        read as agreement."""
        status, body = _call(_event(
            "tools/call", params={"arguments": {}},
            headers={"MCP-Name": "search_feedback"}, token=_TOKEN,
        ))

        assert status == 400
        assert body["error"]["code"] == -32600

    def test_both_echoes_are_matched_case_insensitively(self):
        for spelling in ("MCP-Method", "mcp-method"):
            status, _body = _call(_event("ping", headers={spelling: "tools/call"}))
            assert status == 400, f"{spelling} was not read"


# ===========================================================================
# The resultType discriminator
# ===========================================================================

class TestResultDiscriminator:
    """Every result says what SHAPE it is, rather than being inferred from keys.

    `{}` is both a `ping` answer and a notification acknowledgement; a tool error
    differs from a tool result by a boolean and by whether `structuredContent`
    happens to be present. A client switching on inferred shape re-derives that
    table from scratch and gets it subtly wrong — in the client, where nothing
    here can catch it.
    """

    # Every dispatchable method, with whatever it needs to reach an answer. Keyed
    # by method so a method added to the tables without a line here fails
    # `test_every_dispatchable_method_is_covered` rather than going unchecked.
    CASES: ClassVar[dict[str, tuple[dict, str | None]]] = {
        "initialize": ({}, None),
        "ping": ({}, None),
        "server/discover": ({}, None),
        "notifications/initialized": ({}, None),
        "tools/list": ({}, _TOKEN),
        "tools/call": ({"name": "get_metrics_summary", "arguments": {}}, _TOKEN),
    }

    def test_every_dispatchable_method_is_covered(self):
        """Anti-vacuity for the parametrized test below."""
        dispatched = {*mcp_handler.MCP_METHODS, *mcp_handler.MCP_AUTH_METHODS}

        assert set(self.CASES) == dispatched, (
            f"uncovered methods: {sorted(dispatched - set(self.CASES))}; "
            f"stale cases: {sorted(set(self.CASES) - dispatched)}"
        )

    @pytest.mark.parametrize("method", sorted(CASES))
    def test_every_method_answers_with_a_declared_result_type(self, method):
        params, token = self.CASES[method]
        status, body = _call(_event(method, params=params, token=token))

        assert status == 200, body
        result = body["result"]
        declared = result.get(mcp_handler.RESULT_TYPE_KEY)
        assert declared in mcp_handler.RESULT_TYPES, (
            f"{method} answered with resultType {declared!r}"
        )

    def test_the_types_a_client_cannot_otherwise_tell_apart_differ(self):
        """The pairs that motivated the discriminator.

        A pong and an acknowledgement are both `{}` on the wire; a tool result and
        a tool error are the same object with one flag flipped. If either pair
        shared a type the discriminator would not be discriminating.
        """
        _s, pong = _call(_event("ping"))
        _s, ack = _call(_event("notifications/initialized"))

        assert pong["result"][mcp_handler.RESULT_TYPE_KEY] != (
            ack["result"][mcp_handler.RESULT_TYPE_KEY]
        )

    def test_a_tool_error_is_a_different_type_from_a_tool_result(self):
        """A refusal carries no `structuredContent` to validate, and the type says
        so without the client testing for the key."""
        ok = mcp_handler._jsonrpc_result(
            1, mcp_handler.RESULT_TYPE_TOOL_RESULT, {"isError": False},
        )
        bad = mcp_handler._tool_error(1, "nope")

        assert ok["result"][mcp_handler.RESULT_TYPE_KEY] == (
            mcp_handler.RESULT_TYPE_TOOL_RESULT
        )
        assert bad["result"][mcp_handler.RESULT_TYPE_KEY] == (
            mcp_handler.RESULT_TYPE_TOOL_ERROR
        )
        # And the flag the spec defines is still there: the type describes the
        # payload, it does not replace `isError`.
        assert bad["result"]["isError"] is True

    def test_a_delegated_refusal_still_carries_the_tool_error_type(self):
        """End to end, through the route error path rather than the builder."""
        client = MagicMock()
        client.invoke.side_effect = lambda **_kwargs: {
            "Payload": io.BytesIO(json.dumps({
                "statusCode": 404, "body": json.dumps({"message": "Feedback not found"}),
            }).encode()),
        }
        with patch("mcp_handler.projects_table") as table, \
             patch("shared.mcp_delegate.get_delegate_lambda_client", return_value=client), \
             patch.dict(os.environ, {"METRICS_FUNCTION": "m"}):
            table.query.return_value = {"Items": [_token_row()]}
            table.update_item.return_value = {}
            response = mcp_handler.lambda_handler(_event(
                "tools/call",
                params={"name": "get_feedback_detail",
                        "arguments": {"feedback_id": "1ae1eb6abcd7d3a2e364f46139f98466"}},
                token=_TOKEN,
            ), MagicMock())

        result = json.loads(response["body"])["result"]
        assert result[mcp_handler.RESULT_TYPE_KEY] == mcp_handler.RESULT_TYPE_TOOL_ERROR
        assert result["isError"] is True

    def test_an_undeclared_result_type_cannot_be_sent(self):
        """A client cannot switch on a typo, and finding out at the client is
        finding out too late."""
        with pytest.raises(ValueError, match="undeclared resultType"):
            mcp_handler._jsonrpc_result(1, "toolresult", {})

    def test_the_discriminator_is_required_not_optional(self):
        """The signature is the enforcement: a new result shape cannot ship
        without naming itself.

        An optional keyword would make the discriminator a thing authors
        remember, which is the same class of defect as a declaration nothing
        checks. Read off the SIGNATURE rather than by calling it, so the failure
        names the design rather than an arbitrary TypeError.
        """
        parameters = inspect.signature(mcp_handler._jsonrpc_result).parameters
        result_type = parameters.get("result_type")

        assert result_type is not None, "_jsonrpc_result no longer takes a result type"
        assert result_type.default is inspect.Parameter.empty, (
            "result_type has a default, so a result can ship without naming its shape"
        )

    def test_no_result_is_built_outside_the_builder(self):
        """Structural, via the AST, because a substring search cannot tell code
        from a comment about code.

        Every JSON-RPC envelope in this module must come from one of the two
        builders — that is what makes "every result carries a resultType" a
        property of the module rather than of the six call sites somebody
        remembered. A seventh hand-rolled envelope fails here.
        """
        tree = ast.parse(inspect.getsource(mcp_handler))
        builders = {"_jsonrpc_result", "_jsonrpc_error"}
        offenders = []
        for node in ast.walk(tree):
            if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                continue
            for inner in ast.walk(node):
                if not isinstance(inner, ast.Dict):
                    continue
                keys = {
                    key.value for key in inner.keys
                    if isinstance(key, ast.Constant) and isinstance(key.value, str)
                }
                if "jsonrpc" in keys and node.name not in builders:
                    offenders.append(node.name)
        assert offenders == [], (
            f"JSON-RPC envelopes built outside the builders, so their resultType "
            f"is not enforced: {sorted(set(offenders))}"
        )
        # Positive control: the walker must actually see the builders' own
        # literals, or the check above passes by finding nothing at all.
        found = {
            node.name
            for node in ast.walk(tree)
            if isinstance(node, ast.FunctionDef)
            and any(
                isinstance(inner, ast.Dict)
                and any(isinstance(k, ast.Constant) and k.value == "jsonrpc"
                        for k in inner.keys)
                for inner in ast.walk(node)
            )
        }
        assert found == builders, f"the AST walk lost sight of the builders: {found}"


# ===========================================================================
# HTTP methods the transport defines and this server does not implement
# ===========================================================================

class TestMethodNotAllowed:
    """GET and DELETE are transport methods, and 405 is how a client is told to
    stop rather than to retry differently.

    GET opens an SSE stream and DELETE terminates a session in the Streamable
    HTTP transport; neither is implemented here.
    """

    @pytest.mark.parametrize("http_method", ["GET", "DELETE"])
    def test_the_unimplemented_transport_methods_are_405(self, http_method):
        response = mcp_handler.lambda_handler(
            _event(http_method=http_method, path="/v1/mcp"), MagicMock(),
        )

        assert response["statusCode"] == 405, response["body"]

    @pytest.mark.parametrize("http_method", ["GET", "DELETE", "PUT", "PATCH"])
    def test_a_405_names_what_is_allowed(self, http_method):
        """RFC 9110 §15.5.6 REQUIRES `Allow` on a 405, and it is the difference
        between "not here" and "not like that".

        The header is PARSED into methods rather than substring-searched: `PUT` is
        not a substring of `POST` today, but a check that depends on that is a
        check that breaks on an unrelated method name.
        """
        response = mcp_handler.lambda_handler(
            _event(http_method=http_method, path="/v1/mcp"), MagicMock(),
        )

        assert response["statusCode"] == 405
        allowed = {m.strip() for m in response["headers"]["Allow"].split(",")}
        assert allowed == {"POST", "OPTIONS"}
        assert http_method not in allowed

    def test_the_allow_header_agrees_with_the_cors_declaration(self):
        """One statement of which methods this endpoint serves, to two audiences.

        A hand-written second copy is how a preflight and a 405 come to disagree
        about the same endpoint.
        """
        response = mcp_handler.lambda_handler(
            _event(http_method="PUT"), MagicMock(),
        )
        allowed = {
            m.strip() for m in response["headers"]["Allow"].split(",")
        }
        declared = {
            m.strip()
            for m in mcp_handler.CORS_HEADERS["Access-Control-Allow-Methods"].split(",")
        }

        assert allowed == declared

    def test_a_405_carries_a_json_rpc_envelope_and_cors_headers(self):
        """Every answer from this endpoint is parseable by the client that asked,
        including the refusals — the property the BotoCoreError clause records."""
        response = mcp_handler.lambda_handler(_event(http_method="GET"), MagicMock())
        body = json.loads(response["body"])

        assert body["jsonrpc"] == "2.0"
        assert body["error"]["code"] == -32600
        assert response["headers"]["Access-Control-Allow-Origin"] == "*"

    def test_a_405_never_reaches_the_token_store(self):
        with patch("mcp_handler.projects_table") as table:
            mcp_handler.lambda_handler(
                _event(http_method="DELETE", token=_TOKEN), MagicMock(),
            )
        table.query.assert_not_called()

    def test_the_autoseed_get_route_is_unaffected(self):
        """The 405 is for the JSON-RPC endpoint, and autoseed is a GET by design.

        Pinned because "GET is not allowed" is exactly the kind of rule that gets
        applied one layer too early.
        """
        with patch("mcp_handler.projects_table") as table, \
             patch("shared.mcp_delegate.get_delegate_lambda_client",
                   return_value=_stub_domain_client()), \
             patch.dict(os.environ, {"PROJECTS_FUNCTION": "p"}):
            table.query.return_value = {"Items": [_token_row()]}
            table.update_item.return_value = {}
            response = mcp_handler.lambda_handler({
                "httpMethod": "GET",
                "path": f"/v1/mcp/autoseed/{_PROJECT}",
                "headers": {"authorization": f"Bearer {_TOKEN}"},
            }, MagicMock())

        assert response["statusCode"] == 200, response["body"]

    def test_options_still_preflights(self):
        """A browser-based client's preflight is not a method refusal."""
        response = mcp_handler.lambda_handler(
            _event(http_method="OPTIONS"), MagicMock(),
        )

        assert response["statusCode"] == 200


class TestUnknownMethod:
    """An unknown JSON-RPC method is -32601 and nothing else."""

    def test_an_unknown_method_is_method_not_found(self):
        status, body = _call(_event("tools/teleport"))

        assert body["error"]["code"] == -32601
        assert "tools/teleport" in body["error"]["message"]
        assert status == 200, (
            "JSON-RPC transports a method-not-found in a 200 HTTP response: the "
            "HTTP layer delivered the request fine"
        )

    def test_an_unknown_method_never_reaches_the_token_store(self):
        """A method that does not exist cannot need a credential, so asking for
        one would be a free probe of the auth path."""
        with patch("mcp_handler.projects_table") as table:
            mcp_handler.lambda_handler(_event("tools/teleport", token=_TOKEN), MagicMock())
        table.query.assert_not_called()

    def test_an_absent_method_is_also_method_not_found(self):
        """A body with no `method` names no method, which is the same answer."""
        status, body = _call(_event(
            body=json.dumps({"jsonrpc": "2.0", "id": 1, "params": {}}),
        ))

        assert status == 200
        assert body["error"]["code"] == -32601

    @pytest.mark.parametrize("body_text", ["[]", '"a string"', "42", "null"])
    def test_a_non_object_body_is_not_a_crash(self, body_text):
        """The body is caller-controlled JSON and need not be an object. `[]`
        used to reach `.get` on a list — an AttributeError, i.e. a 502 with no
        envelope and no CORS headers, which is the failure mode the auth path's
        catch-all exists to prevent."""
        status, body = _call(_event(body=body_text))

        assert status == 200, body
        assert body["error"]["code"] == -32601
        assert body["id"] is None


# ===========================================================================
# tools/list, filtered by the authorization actually presented
# ===========================================================================

class TestToolCatalogueIsFilteredByAuthorization:
    """The spec blesses a credential-shaped tool set; this server had one shape.

    Every caller saw every tool regardless of the scopes on its token, so a
    `metrics:read` credential was shown `search_feedback`, called it, and was
    refused -32003. A catalogue that has to be tried to be believed is not a
    catalogue.
    """

    def _names(self, row: dict) -> list[str]:
        status, body = _call(_event("tools/list", token=_TOKEN), row=row)
        assert status == 200, body
        return [tool["name"] for tool in body["result"]["tools"]]

    def test_a_full_credential_sees_every_tool(self):
        """The positive control. Without it, a filter that returned nothing at all
        would pass every negative test below."""
        assert set(self._names(_token_row())) == set(mcp_handler.TOOL_HANDLERS)

    @pytest.mark.parametrize("scope", [
        SCOPE_FEEDBACK_READ, SCOPE_METRICS_READ, SCOPE_PROJECTS_READ,
    ])
    def test_a_single_scope_credential_sees_only_that_domains_tools(self, scope):
        """Derived from the scope table rather than restated, so a tool moved
        between domains is covered without an edit here."""
        listed = set(self._names(_token_row(scopes=[scope])))
        expected = {
            name for name, required in mcp_handler.TOOL_SCOPE_REQUIREMENTS.items()
            if required == scope
        }

        assert expected, f"no tool requires {scope}; the table moved"
        assert listed == expected

    def test_a_project_set_credential_is_not_shown_the_workspace_tools(self):
        """The load-bearing refusal, mirrored into the catalogue.

        `voc-feedback` is keyed by source with no project dimension, so
        `project-set` reach has nothing to narrow and those tools are refused at
        call time. Listing them would advertise the refusal.
        """
        listed = set(self._names(_token_row(read_reach=REACH_PROJECT_SET)))
        expected = {
            name for name, kind in mcp_handler.TOOL_REACH_KINDS.items()
            if kind != mcp_handler.REACH_KIND_WORKSPACE
        }

        assert listed == expected

    def test_a_none_reach_credential_sees_no_tools(self):
        """It can call nothing, so it is shown nothing — and an empty list is an
        answer rather than an error, because the credential is valid."""
        status, body = _call(_event("tools/list", token=_TOKEN),
                             row=_token_row(read_reach=REACH_NONE))

        assert status == 200, body
        assert body["result"]["tools"] == []

    def test_a_project_set_credential_with_no_projects_sees_no_project_tools(self):
        """Sealed to a set that names nothing reaches nothing."""
        listed = self._names(_token_row(read_reach=REACH_PROJECT_SET, projects=[]))

        assert listed == []

    def test_a_workspace_credential_with_no_projects_still_sees_the_project_tools(self):
        """The asymmetry with the test above, and it is the honest one.

        Workspace reach admits every project without consulting the id — a
        workspace token reads a project it was not minted from, which
        `test_workspace_token_reads_a_project_outside_its_own_set` pins on the
        dispatch side. So an empty project set does not bound it, and a listing
        that refused these tools would hide tools the dispatch allows.

        This is the case the representative-project stand-in exists for: a listing
        has to ask a project-shaped question with no project in hand.
        """
        listed = set(self._names(_token_row(projects=[])))
        expected = set(mcp_handler.TOOL_HANDLERS)

        assert listed == expected

    def test_an_unusable_project_entry_does_not_pass_for_a_project(self):
        """A row whose `projects` holds junk names no project.

        `projects` is stored data and these values are what a `project-set` token
        is bounded BY, so an entry that is not a usable id must not be counted as
        one — the fail-closed reading, matching how a damaged `scopes` grants
        nothing.
        """
        listed = self._names(_token_row(read_reach=REACH_PROJECT_SET,
                                        projects=[None, "", 7, {}]))

        assert listed == []

    def test_a_damaged_scope_set_lists_nothing_rather_than_everything(self):
        """Fail-closed, matching the dispatch: a row whose `scopes` is unusable
        grants nothing, so it must not be shown everything."""
        for damaged in (None, "", "feedback:read", 7, {}):
            listed = self._names(_token_row(scopes=damaged))
            assert listed == [], f"scopes={damaged!r} listed {listed}"

    def test_every_listed_tool_is_actually_callable_by_that_credential(self):
        """The claim the filter makes, checked end to end.

        A listing that included a tool the dispatch refuses would be the original
        defect with extra steps; one that excluded a callable tool would be a new
        one. Both directions are checked — the exclusion half against the
        workspace tools a project-set token is refused.
        """
        row = _token_row(scopes=[SCOPE_METRICS_READ])
        listed = set(self._names(row))
        assert listed, "the positive half of this test needs a non-empty list"

        for name in mcp_handler.TOOL_HANDLERS:
            arguments = {"dimension": "categories"} if name == "get_metrics_breakdown" else {}
            status, body = _call(
                _event("tools/call", params={"name": name, "arguments": arguments},
                       token=_TOKEN),
                row=row,
            )
            assert status == 200, body
            refused = body.get("error", {}).get("code") == -32003
            assert refused == (name not in listed), (
                f"{name}: listed={name in listed} but the dispatch "
                f"{'refused' if refused else 'allowed'} it"
            )

    def test_the_order_is_deterministic_and_not_declaration_order(self):
        """A cached list is comparable to a fresh one only if the order is stable,
        and the etag over it means nothing otherwise. Declaration order would make
        the answer depend on where somebody inserted a literal."""
        names = self._names(_token_row())

        assert names == sorted(names)
        # Anti-vacuity: if the declarations happened to already be alphabetical,
        # this test would pass without the sort. They are not.
        declared = [tool["name"] for tool in mcp_handler.MCP_TOOLS]
        assert declared != sorted(declared), (
            "the declarations are now alphabetical, so this test no longer proves "
            "the sort is what produces the order — reorder a declaration or drop "
            "this assertion deliberately"
        )

    def test_the_list_carries_its_own_cache_hints(self):
        """`listChanged: false` means nothing will tell the client the list moved,
        so the answer says how long to hold it and how to detect staleness."""
        status, body = _call(_event("tools/list", token=_TOKEN))
        assert status == 200, body
        hints = body["result"]["_meta"]["cacheHints"]

        assert hints["cacheable"] is True
        assert isinstance(hints["maxAgeSeconds"], int) and hints["maxAgeSeconds"] > 0
        assert hints["etag"]
        assert hints["serverVersion"] == mcp_handler.MCP_SERVER_VERSION
        assert hints["listChangedNotifications"] is False

    def test_the_cache_scope_is_the_credential_not_the_endpoint(self):
        """The load-bearing hint. A shared cache keyed on the endpoint alone would
        serve one token's catalogue to another token — which only became possible
        the moment the list started varying by credential."""
        _status, body = _call(_event("tools/list", token=_TOKEN))

        assert body["result"]["_meta"]["cacheHints"]["scope"] == "credential"

    def test_the_cache_hint_agrees_with_the_declared_capability(self):
        """Two statements about notifications, from one fact."""
        _status, initialize = _call(_event("initialize"))
        _status, listing = _call(_event("tools/list", token=_TOKEN))

        assert (
            listing["result"]["_meta"]["cacheHints"]["listChangedNotifications"]
            is initialize["result"]["capabilities"]["tools"]["listChanged"]
        )

    def test_two_credentials_with_different_reach_get_different_etags(self):
        """An etag that did not move with the catalogue would let a client keep
        serving a stale one — the failure the hint exists to prevent."""
        _s, full = _call(_event("tools/list", token=_TOKEN), row=_token_row())
        _s, narrow = _call(_event("tools/list", token=_TOKEN),
                           row=_token_row(scopes=[SCOPE_METRICS_READ]))

        assert (
            full["result"]["_meta"]["cacheHints"]["etag"]
            != narrow["result"]["_meta"]["cacheHints"]["etag"]
        )

    def test_the_etag_is_stable_across_identical_requests(self):
        """Otherwise a client re-fetches forever and the hint is noise."""
        _s, first = _call(_event("tools/list", token=_TOKEN))
        _s, second = _call(_event("tools/list", token=_TOKEN))

        assert (
            first["result"]["_meta"]["cacheHints"]["etag"]
            == second["result"]["_meta"]["cacheHints"]["etag"]
        )

    def test_the_list_still_requires_a_credential(self):
        """Filtering by authorization presupposes authorization: an unauthenticated
        `tools/list` must not fall back to "everything" or to "nothing"."""
        response = mcp_handler.lambda_handler(_event("tools/list"), MagicMock())

        assert response["statusCode"] == 401, response["body"]


# ===========================================================================
# Annotations and the cost class
# ===========================================================================

class TestAnnotationsAndCostClass:
    """A client cannot tell a keyed read from a soft-capped scan by tool name.

    The cost class is what lets a model choose between two tools that answer
    nearly the same question before making the expensive call rather than after.
    """

    def test_every_published_tool_carries_annotations(self):
        for tool in mcp_handler.MCP_TOOLS:
            annotations = tool.get("annotations")
            assert annotations, f"{tool['name']} publishes no annotations"
            assert annotations["title"], f"{tool['name']} has no human-readable title"

    def test_every_published_tool_declares_all_four_behaviour_hints(self):
        """A read-only tool that does not SAY it is read-only gets prompted for
        like a write, because a client that cannot tell assumes the worse case."""
        expected = {"readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"}
        for tool in mcp_handler.MCP_TOOLS:
            hints = set(tool["annotations"]) - {"title"}
            assert hints == expected, f"{tool['name']}: {sorted(hints)}"

    def test_every_tool_in_this_phase_is_declared_read_only(self):
        """True of every tool here, and the assertion that has to MOVE when the
        first write tool lands — deliberately, in the same commit as its write
        scope, because a hint alone is a label and a scope alone makes a client
        prompt for a write as though it were a read."""
        for tool in mcp_handler.MCP_TOOLS:
            assert tool["annotations"]["readOnlyHint"] is True, tool["name"]
            assert tool["annotations"]["destructiveHint"] is False, tool["name"]

    def test_no_tool_claims_to_reach_the_open_world(self):
        """Every tool reads this workspace's own data lake. A client would
        otherwise have to assume the internet."""
        for tool in mcp_handler.MCP_TOOLS:
            assert tool["annotations"]["openWorldHint"] is False, tool["name"]

    def test_every_published_tool_carries_a_cost_class_from_the_vocabulary(self):
        for tool in mcp_handler.MCP_TOOLS:
            cost = tool["_meta"]["costClass"]
            assert cost in mcp_handler.COST_CLASSES, f"{tool['name']}: {cost!r}"

    def test_the_cost_class_table_covers_exactly_the_registered_tools(self):
        """Fail-closed at publication: a missing class would read as `cheap` to a
        model that expected every tool to carry one, and a stale entry is a claim
        about a tool that no longer exists."""
        assert set(mcp_handler.TOOL_COST_CLASSES) == set(mcp_handler.TOOL_HANDLERS)
        assert set(mcp_handler.TOOL_TITLES) == set(mcp_handler.TOOL_HANDLERS)

    def test_a_tool_with_no_cost_class_cannot_be_published(self):
        """The enforcement, exercised rather than asserted about.

        Building the catalogue is what refuses, so the failure is at import in a
        deployed build rather than at a client's first `tools/list`.
        """
        with pytest.raises(KeyError, match="cost class"):
            mcp_handler._published_tool({"name": "unregistered_tool"})

    def test_an_undeclared_cost_class_cannot_be_published(self):
        with patch.dict(mcp_handler.TOOL_COST_CLASSES, {"search_feedback": "free"}), \
             patch.dict(mcp_handler.TOOL_TITLES, {"search_feedback": "x"}), \
             pytest.raises(ValueError, match="cost class"):
            mcp_handler._published_tool({"name": "search_feedback"})

    def test_the_expensive_class_is_the_tool_that_can_truncate(self):
        """The class is about the SHAPE of the read, and `is_partial` is the same
        fact surfacing at answer time: a candidate scan bounded by a soft cap
        rather than by an index. Asserted against the declared output schema, so
        the two cannot drift into disagreement.
        """
        for tool in mcp_handler.MCP_TOOLS:
            declares_truncation = "is_partial" in tool["outputSchema"].get("required", [])
            if declares_truncation:
                assert tool["_meta"]["costClass"] == mcp_handler.COST_EXPENSIVE, (
                    f"{tool['name']} can report truncation but is not the "
                    f"expensive class"
                )

    def test_a_tool_result_reports_the_cost_it_actually_carried(self):
        """The same class the catalogue advertised, read from one table, so an
        advertised `cheap` and a billed `expensive` cannot be two facts."""
        status, body = _call(_event(
            "tools/call", params={"name": "search_feedback", "arguments": {"query": "late"}},
            token=_TOKEN,
        ))

        assert status == 200, body
        assert body["result"]["_meta"]["costClass"] == (
            mcp_handler.TOOL_COST_CLASSES["search_feedback"]
        )

    def test_the_advertised_and_the_reported_class_are_the_same_value(self):
        """Across every tool, not just the one an example exercises."""
        published = {
            tool["name"]: tool["_meta"]["costClass"] for tool in mcp_handler.MCP_TOOLS
        }
        for name, advertised in published.items():
            arguments = {"dimension": "categories"} if name == "get_metrics_breakdown" else {}
            if name == "get_feedback_detail":
                arguments = {"feedback_id": "1ae1eb6abcd7d3a2e364f46139f98466"}
            status, body = _call(_event(
                "tools/call", params={"name": name, "arguments": arguments}, token=_TOKEN,
            ))
            assert status == 200, body
            assert body["result"]["_meta"]["costClass"] == advertised, name

    def test_a_tool_error_carries_no_cost_class_to_misread(self):
        """A refusal did not perform the read, so reporting its class would
        attribute a cost to a call that never paid it.

        Same reasoning as `structuredContent` being absent on a refusal rather
        than empty.
        """
        error = mcp_handler._tool_error(1, "nope")

        assert "_meta" not in error["result"]

    def test_the_declaration_the_annotations_wrap_is_not_mutated(self):
        """`_published_tool` composes; it must not edit the literal in place.

        A mutating implementation would work exactly once and then double-wrap on
        any future rebuild, which is the kind of fault that shows up as a
        fingerprint that moves without a diff.
        """
        for declaration in mcp_handler._TOOL_DECLARATIONS:
            assert "annotations" not in declaration, declaration["name"]
            assert "_meta" not in declaration, declaration["name"]


# ===========================================================================
# A dead credential must fail the handshake, not the first tool call
# ===========================================================================

class TestADeadCredentialFailsTheHandshake:
    """The honesty defect this envelope owes.

    `initialize` needs no credential, so a revoked or expired token completed the
    whole handshake, `tools/list` answered, and the FIRST `tools/call` was the
    first refusal. A client shows that as a connected server with failing tools,
    which sends whoever is debugging at the tools, the scopes and the routes —
    anywhere but the credential.
    """

    def _expired_row(self) -> dict:
        past = (datetime.now(timezone.utc) - timedelta(days=1)).isoformat()
        return _token_row(expires_at=past)

    @pytest.mark.parametrize("method", ["initialize", "ping", "server/discover",
                                        "notifications/initialized"])
    def test_an_expired_credential_is_refused_on_every_unauthenticated_method(self, method):
        """Every method in the no-credential half, because a client may open with
        any of them and each one would otherwise report a healthy server."""
        status, body = _call(_event(method, token=_TOKEN), row=self._expired_row())

        assert status == 401, body
        assert body["error"]["code"] == -32001

    def test_a_revoked_credential_is_refused_at_initialize(self):
        """Revocation deletes the row, so the credential parses and matches
        nothing — indistinguishable from a wrong secret, and equally dead."""
        with patch("mcp_handler.projects_table") as table:
            table.query.return_value = {"Items": []}
            response = mcp_handler.lambda_handler(
                _event("initialize", token=_TOKEN), MagicMock(),
            )

        assert response["statusCode"] == 401, response["body"]

    def test_the_refusal_says_the_credential_is_the_problem(self):
        """The whole point: the message has to send the reader at the token.

        A generic "unauthorized" on a handshake that used to succeed is what made
        this worth fixing.
        """
        _status, body = _call(_event("initialize", token=_TOKEN), row=self._expired_row())
        message = body["error"]["message"].lower()

        assert "token" in message
        assert "revoked" in message or "expired" in message

    def test_no_credential_at_all_still_initializes(self):
        """Absence is not a dead credential, it is no credential — and an
        unauthenticated handshake is exactly how a client learns what to present.
        Refusing here would break every client that connects before it has a
        token.
        """
        with patch("mcp_handler.projects_table") as table:
            response = mcp_handler.lambda_handler(_event("initialize"), MagicMock())

        assert response["statusCode"] == 200, response["body"]
        table.query.assert_not_called()

    def test_a_malformed_authorization_header_still_initializes(self):
        """A header that is not a Bearer credential presents no credential.

        Read strictly, so a `Basic` header or a bare word is not mistaken for a
        dead token and reported as one.
        """
        for header in ("", "Basic abc", "Bearer", "bearer voc_x", "voc_x"):
            with patch("mcp_handler.projects_table") as table:
                response = mcp_handler.lambda_handler(
                    _event("initialize", headers={"authorization": header}), MagicMock(),
                )
            assert response["statusCode"] == 200, f"{header!r}: {response['body']}"
            table.query.assert_not_called()

    def test_a_live_credential_still_initializes(self):
        """The positive control. A check that refused every presented credential
        would pass every test above and break every working client."""
        status, body = _call(_event("initialize", token=_TOKEN))

        assert status == 200, body
        assert body["result"]["protocolVersion"] in mcp_handler.SUPPORTED_PROTOCOL_VERSIONS

    def test_a_token_store_fault_is_a_server_error_not_a_dead_credential(self):
        """Reporting "your token is invalid" for a table nobody could read sends
        an operator to re-mint a credential that was never compared — the same
        distinction the authenticated path already draws."""
        with patch("mcp_handler.projects_table", None):
            response = mcp_handler.lambda_handler(
                _event("initialize", token=_TOKEN), MagicMock(),
            )

        assert response["statusCode"] == 500, response["body"]
        assert json.loads(response["body"])["error"]["code"] == -32603

    def test_the_401_carries_the_bearer_challenge(self):
        """Through the same choke point as every other 401 here, so this new path
        cannot be the one that forgets RFC 6750."""
        with patch("mcp_handler.projects_table") as table:
            table.query.return_value = {"Items": [self._expired_row()]}
            response = mcp_handler.lambda_handler(
                _event("initialize", token=_TOKEN), MagicMock(),
            )

        assert response["statusCode"] == 401
        assert response["headers"]["WWW-Authenticate"].startswith("Bearer ")

    def test_the_handshake_is_refused_before_it_reports_a_version(self):
        """A 401 that also carried a negotiated version would still look like a
        connected server to a client that reads the body optimistically."""
        _status, body = _call(_event("initialize", token=_TOKEN), row=self._expired_row())

        assert "result" not in body
