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

  TestTheHandshakeIsExemptFromTheVersionRefusal
    — and then the refusal met the handshake, where a current-generation client
      MUST send its own revision and has nothing else to send: its first contact
      was a 400 and the counter-offer was unreachable. Reverting the
      `method == 'initialize'` exemption in `_validated_protocol_version` fails
      test_a_current_generation_first_contact_is_counter_offered; widening it past
      the handshake fails test_every_other_method_still_refuses_the_same_header.

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
      from which keys were present (a tool error differs from a tool result by a
      boolean; `ping` answers a bare `{}`). Making the shape optional in
      `_jsonrpc_result` fails test_every_method_answers_with_a_declared_result_shape,
      and the AST check fails the moment a result is built outside the builder.

  TestNotificationsAreAccepted
    — a notification was answered 200 with a result carrying `id: null`, and every
      notification this server does not dispatch was answered 404 — which on this
      endpoint means "your session was terminated, re-initialize", so routine
      `notifications/cancelled` traffic tore down live sessions. Deleting the
      `_is_notification` branch in `lambda_handler` fails every test in that class;
      answering a notification anywhere but 202-with-no-body fails
      test_a_notification_is_202_with_an_empty_body. And a REFUSED notification kept
      the `id: null` the accepted one had lost: passing `req_id` instead of `_NO_ID`
      in the `InvalidTransportHeader` catch fails
      test_a_refused_notification_carries_no_id_member, while omitting the id
      unconditionally fails test_a_refused_request_still_carries_its_id.

  TestBatchBodiesAreRefused
    — 2025-03-26 was advertised and is the one revision that mandates JSON-RPC
      batching, which this handler does not implement: a legal array body fell through
      to the unknown-method branch and was answered `404 -32601 "Method not found: "`,
      and that 404 tells an advertised-revision client its session died. Re-adding
      the revision to `SUPPORTED_PROTOCOL_VERSIONS` raises at import and fails
      test_no_advertised_revision_requires_a_body_grammar_this_server_refuses;
      deleting the `_is_batch` branch fails the rest.

  TestCacheScopeMatchesWhatTheResponseDependsOn
    — `server/discover` declared `cacheScope: public` while being liveness-checked, so
      a shared cache was licensed to replay its unauthenticated 200 across
      authorization contexts — to the request carrying a revoked token that was owed a
      401. Restoring `CACHE_SCOPE_PUBLIC` there fails
      test_no_public_answer_is_credential_gated.

  TestTheHttpLayerStatesWhatTheBodyStates
    — `cacheScope` travels in the JSON-RPC body and the caches in front of this
      endpoint read headers, so the mitigation reached only body-parsing clients.
      Removing `Vary` or `Cache-Control` from `CORS_HEADERS` fails this class.

  TestMethodNotAllowed / TestUnknownMethod
    — GET and DELETE are transport methods this server does not implement, so
      they are 405 with an `Allow` header; an unknown JSON-RPC REQUEST is -32601
      with a 404. Answering either any other way fails these, and collapsing the
      request/notification split back into one answer fails
      test_the_two_message_kinds_get_different_answers.

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


def _notification_event(method: str, *, params: dict | None = None,
                        headers: dict | None = None,
                        token: str | None = None) -> dict:
    """A Lambda proxy event for a JSON-RPC NOTIFICATION.

    The `id` MEMBER is absent, which is JSON-RPC's own definition of a
    notification — not `"id": null`, which is a present member and is a request
    with a null id. `_event` cannot express this, because it always writes an id,
    and the distinction is exactly what the 202 path turns on.
    """
    request_headers = dict(headers or {})
    if token is not None:
        request_headers["authorization"] = f"Bearer {token}"
    return {
        "httpMethod": "POST",
        "path": "/v1/mcp",
        "headers": request_headers,
        "body": json.dumps({
            "jsonrpc": "2.0", "method": method, "params": params or {},
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


def _raw_call(event: dict, *, row: dict | None = None) -> dict:
    """Drive `lambda_handler` end to end; return the RAW proxy response.

    The token store and the delegation client are stubbed because this file is
    about the envelope: what the store holds is `test_mcp_security.py`'s subject
    and what the routes answer is `test_mcp_delegation.py`'s.

    Separate from `_call` because a 202 carries no body to parse, and a helper that
    always parses one cannot express "there is nothing here" — it raises
    `JSONDecodeError` and the failure names the helper rather than the assertion.
    """
    with patch("mcp_handler.projects_table") as table, \
         patch("shared.mcp_delegate.get_delegate_lambda_client",
               return_value=_stub_domain_client()), \
         patch.dict(os.environ, {"METRICS_FUNCTION": "m", "PROJECTS_FUNCTION": "p"}):
        table.query.return_value = {"Items": [row] if row is not None else [_token_row()]}
        table.update_item.return_value = {}
        return mcp_handler.lambda_handler(event, MagicMock())


def _call(event: dict, *, row: dict | None = None) -> tuple[int, dict]:
    """Drive `lambda_handler` end to end; return (status, parsed body)."""
    response = _raw_call(event, row=row)
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

    def test_only_handshake_based_revisions_are_advertised(self):
        """This server advertises only revisions it actually implements.

        The 2026-07-28 revision REMOVES the `initialize` handshake: every request
        carries its protocol version and client capabilities in `_meta` as required
        fields, a request missing them must be refused with -32602, and the header
        must match the `_meta` value. This handler does none of that — it reads the
        version from the header alone, ignores request `_meta`, and dispatches
        `initialize`. Advertising that revision would counter-offer it to any client
        whose version this server does not know, and a client that took the offer at
        face value would then send modern requests to a handler that ignores the
        metadata the spec told it to trust.

        Written as "the handshake is what we implement, so the handshake is what we
        advertise" — a bare `!= '2026-07-28'` would pass again the moment somebody
        added 2027-xx-xx to the tuple without implementing it either.
        """
        assert 'initialize' in mcp_handler.MCP_METHODS, (
            "this server is handshake-based; if that changed, this test's premise did"
        )
        # The handshake-based revisions, which is every published revision up to and
        # including 2025-11-25. Anything later removed the handshake.
        handshake_era = {
            "2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05",
        }
        advertised = set(mcp_handler.SUPPORTED_PROTOCOL_VERSIONS)

        assert advertised <= handshake_era, (
            f"advertising a post-handshake revision this envelope does not "
            f"implement: {sorted(advertised - handshake_era)}. Implementing the "
            f"per-request `_meta` era is a phase, not a tuple entry."
        )

    def test_the_revision_the_deployed_server_negotiated_is_still_accepted(self):
        """A client that handshook against the DEPLOYED server must keep working.

        The deployed handler pinned 2024-11-05, so every connected client sends
        `MCP-Protocol-Version: 2024-11-05` on every subsequent request. Dropping it
        from the accepted set — while the header validator refuses anything not in
        that set — turns each of those clients into a 400 at the next call.

        Accepting a revision is not preferring it: neither is the counter-offer.

        2025-03-26 was here too and is deliberately gone; see
        `TestBatchBodiesAreRefused` for why (it mandates batching, which this handler
        does not implement) and for why dropping it breaks no deployed client.
        """
        version = "2024-11-05"
        assert version in mcp_handler.SUPPORTED_PROTOCOL_VERSIONS, (
            f"{version} was negotiable against a deployed build; refusing it "
            f"now breaks every client that handshook on it"
        )
        status, _body = _call(_event(
            "initialize", headers={"MCP-Protocol-Version": version},
        ))
        assert status == 200, f"{version} header refused"

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

    def _detail(self) -> dict:
        """The vendor-prefixed sub-object carrying this server's own reporting.

        Everything the SPEC does not define lives here rather than at the top
        level, which is the correction this class exercises: a `DiscoverResult`
        carrying undefined top-level keys is one a strict client cannot validate.
        """
        return self._discover()["_meta"][
            f"{mcp_handler.VENDOR_META_PREFIX}serverDetail"
        ]

    def test_discover_needs_no_credential(self):
        """It answers what the SERVER supports, which a client needs before it has
        decided what to present. It names no project, no tool and no data."""
        with patch("mcp_handler.projects_table") as table:
            response = mcp_handler.lambda_handler(_event("server/discover"), MagicMock())
        assert response["statusCode"] == 200, response["body"]
        table.query.assert_not_called()

    def test_it_reports_every_protocol_version_the_server_speaks(self):
        result = self._discover()

        # The SPEC's field name. A client calls this method precisely to learn the
        # versions, so publishing them under a name of our own invention left it
        # reading `supportedVersions`, finding nothing, and no better off than if
        # the method did not exist.
        assert result["supportedVersions"] == list(mcp_handler.SUPPORTED_PROTOCOL_VERSIONS)
        assert self._detail()["preferredProtocolVersion"] == (
            mcp_handler.PREFERRED_PROTOCOL_VERSION
        )

    def test_it_reports_every_method_the_server_dispatches(self):
        """Derived from the dispatch tables, so a method that exists is listed and
        one that is only listed cannot exist."""
        detail = self._detail()
        dispatched = {*mcp_handler.MCP_METHODS, *mcp_handler.MCP_AUTH_METHODS}

        assert set(detail["methods"]) == dispatched
        assert set(detail["authenticatedMethods"]) == set(mcp_handler.MCP_AUTH_METHODS)
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
        detail = self._detail()

        assert {name.lower() for name in detail["transportHeaders"]} == set(
            mcp_handler.TRANSPORT_HEADERS
        )

    def test_it_reports_them_in_the_spelling_a_client_sends(self):
        """The internal lowercase form is an artefact of API Gateway's
        normalisation, and publishing it would document an implementation detail
        as a contract."""
        published = self._detail()["transportHeaders"]

        # The spec's own spellings, which are NOT one rule: the version header
        # carries the acronym in caps and the two routing echoes title-case it.
        # A single `MCP` rule published `MCP-Method`, a spelling the spec does not
        # use.
        assert set(published) == {"MCP-Protocol-Version", "Mcp-Method", "Mcp-Name"}
        assert published == sorted(published)

    def test_it_reports_the_result_shape_vocabulary_under_its_own_name(self):
        """Named `resultShapes`, not `resultTypes`.

        The spec owns the `resultType` vocabulary and this list is not it, so
        publishing it as `resultTypes` would have claimed otherwise — in the very
        answer a client reads to learn what this server means.
        """
        detail = self._detail()

        assert set(detail["resultShapes"]) == set(mcp_handler.RESULT_SHAPES)
        assert "resultTypes" not in detail

    def test_it_reports_the_cost_class_vocabulary_in_order(self):
        """Cheapest first: an unordered set of adjectives does not say which of
        two classes is the expensive one."""
        assert self._detail()["costClasses"] == list(mcp_handler.COST_CLASSES)

    def test_it_says_the_tool_list_varies_by_credential(self):
        """Cheaper than letting a client find out by calling a tool it was never
        granted — and it is why discovery does not list tools itself."""
        result = self._discover()

        assert self._detail()["toolsVaryByCredential"] is True
        assert "tools" not in result

    def test_server_info_travels_under_the_spec_reserved_meta_key(self):
        """`serverInfo` is a `_meta` field in this revision, not a top-level one.

        Publishing it at the top level put a key the `DiscoverResult` schema does
        not define into a result a strict client validates.
        """
        result = self._discover()

        assert "serverInfo" not in result
        info = result["_meta"]["io.modelcontextprotocol/serverInfo"]
        assert info == {"name": "voc-datalake", "version": mcp_handler.MCP_SERVER_VERSION}

    def test_discovery_carries_the_caching_hints_the_spec_requires(self):
        """`server/discover` is in the spec's cacheable-results list, so the two
        hints are REQUIRED rather than optional.

        `ttlMs` is MILLISECONDS — asserted as a magnitude rather than against the
        constant, because the unit was the actual defect: a seconds value in a
        milliseconds field reads as 0.3s, and an absent one reads as 0 (immediately
        stale) per the spec's own default.
        """
        result = self._discover()

        assert isinstance(result["ttlMs"], int)
        assert result["ttlMs"] >= 60_000, (
            f"ttlMs={result['ttlMs']} looks like seconds, not milliseconds"
        )
        # `private`, and the earlier `public` was the defect: it was argued from the
        # PAYLOAD (which names no project, no tool and no data — true) where the
        # field is about the RESPONSE. This method is liveness-checked, so whether
        # there is a 200 at all depends on the credential, and `public` licenses a
        # shared cache to replay the unauthenticated 200 across authorization
        # contexts — including to the request carrying a revoked token that was owed
        # a 401. `TestCacheScopeMatchesWhatTheResponseDependsOn` pins the invariant
        # generally; this pins the value a client actually reads.
        assert result["cacheScope"] == "private"

    def test_the_discovery_answer_carries_no_undefined_top_level_fields(self):
        """The whole correction, stated once as a closed set.

        A client validating a `DiscoverResult` rejects unknown top-level keys, so
        every local field has to sit in `_meta`. Written as "nothing outside this
        set" rather than as individual absences, so a future field added at the top
        level fails here instead of being noticed by a client.
        """
        result = self._discover()

        allowed = {
            # Spec-defined members of DiscoverResult (`instructions` is optional
            # and this server sends none).
            "supportedVersions", "capabilities", "ttlMs", "cacheScope",
            "resultType", "_meta",
        }
        assert set(result) <= allowed, (
            f"undefined top-level fields in DiscoverResult: {sorted(set(result) - allowed)}"
        )

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
        """400 and `-32022 UnsupportedProtocolVersion`, the spec's own code.

        Not `-32600`: a generic invalid-request code makes the refusal
        indistinguishable from a malformed body, and the transport's
        backward-compatibility rules have a dual-era client read a 400 body for a
        RECOGNIZED modern error to decide the server is modern. `-32600` there means
        "legacy server", so the client falls back to `initialize` while this server
        is advertising a modern revision.

        On `ping` rather than `initialize`, and that is the subject of
        `TestTheHandshakeIsExemptFromTheVersionRefusal` below: past the handshake a
        client has a negotiated version to send, so one this server never offered is
        the client contradicting itself. On the handshake it is a client that has not
        been told yet.
        """
        status, body = _call(_event(
            "ping", headers={"MCP-Protocol-Version": "1999-01-01"},
        ))

        assert status == 400
        assert body["error"]["code"] == -32022
        assert mcp_handler.PREFERRED_PROTOCOL_VERSION in body["error"]["message"]

    def test_the_refusal_carries_the_supported_list_a_client_can_retry_with(self):
        """The spec's recovery path is "pick from `data.supported` and retry".

        With the versions only in the prose message — as the first draft had them —
        that recovery path requires parsing English.
        """
        _status, body = _call(_event(
            "ping", headers={"MCP-Protocol-Version": "1999-01-01"},
        ))

        data = body["error"]["data"]
        assert data["supported"] == list(mcp_handler.SUPPORTED_PROTOCOL_VERSIONS)
        # Echoed so a client with several requests in flight knows which one this
        # answers, and can tell "I sent a bad version" from "a proxy rewrote it".
        assert data["requested"] == "1999-01-01"

    def test_a_malformed_encoding_is_not_reported_as_a_version_problem(self):
        """The two faults are different codes because they have different fixes.

        A sentinel that does not decode is `-32600`: the caller's version may be
        perfectly supported and the ENCODING is what failed, so answering -32022
        with a supported-version list would send them to change a version number
        that was never the problem.
        """
        _status, body = _call(_event(
            "initialize", headers={"MCP-Protocol-Version": "=?base64?not-base64!!?="},
        ))

        assert body["error"]["code"] == -32600
        assert "data" not in body["error"]

    def test_an_absent_version_header_is_served(self):
        """The header postdates the first revisions of the transport, so requiring
        it would refuse every client written against one of those."""
        status, body = _call(_event("initialize"))

        assert status == 200, body

    def test_an_absent_header_reads_as_the_revision_the_spec_names(self):
        """2025-03-26, not the newest revision this server speaks.

        The header arrived in 2025-06-18, so a request without it comes from a
        client written against something earlier. Reading absence as the NEWEST
        supported revision silently upgrades exactly the clients that cannot be
        upgraded — to a value the client never claimed.
        """
        assert mcp_handler.ASSUMED_PROTOCOL_VERSION == "2025-03-26"
        assert mcp_handler._validated_protocol_version(_event("initialize")) == (
            mcp_handler.ASSUMED_PROTOCOL_VERSION
        )

    def test_the_assumed_revision_is_a_reading_and_not_an_advertisement(self):
        """It is deliberately NOT in the advertised range, and that is the point.

        This test used to assert the opposite — that the assumed value is one the
        server serves — on the reasoning that otherwise the guard would refuse every
        header-less client on its next line. That reasoning was about the CODE PATH,
        and the path returns before it compares anything, so the assertion was
        pinning a coincidence rather than a requirement.

        The requirement is the distinction: 2025-03-26 mandates batching, which this
        handler does not implement, so it must not be OFFERED — and it is the value
        the spec names as the reading for a header-less request, so it must not be
        dropped. A fallback reading is not an advertisement, and conflating the two
        is what re-added the revision in the first place.

        A header-less request is still served, which is the property that reasoning
        was reaching for; asserted directly rather than via the tuple.
        """
        assert mcp_handler.ASSUMED_PROTOCOL_VERSION not in (
            mcp_handler.SUPPORTED_PROTOCOL_VERSIONS
        ), (
            "the assumed revision is being advertised; if it is now implementable "
            "in full, say so here rather than letting the two facts merge"
        )
        status, _body = _call(_event("initialize"))
        assert status == 200, "a header-less client must still be served"

    def test_an_empty_version_header_is_refused(self):
        """A client that sent the header empty said something, and what it said is
        not a version. Reading it as absence would let a client that MEANT to name
        a version be served silently on another one.

        Refused on `initialize` too, which the unsupported-version case is NOT: an
        empty value names no revision, so there is no claim for the handshake to
        counter-offer against. The exemption below is for a client that stated a
        version this server does not implement, not for one that stated nothing.
        """
        status, body = _call(_event(
            "initialize", headers={"MCP-Protocol-Version": ""},
        ))

        assert status == 400
        assert body["error"]["code"] == -32022

    def test_the_header_is_matched_case_insensitively(self):
        """API Gateway lowercases header names in proxy mode; a direct invoke does
        not. The guard has to hold for both, which is the lesson `Origin` already
        taught this handler."""
        for spelling in ("MCP-Protocol-Version", "mcp-protocol-version",
                         "Mcp-Protocol-Version"):
            status, _body = _call(_event(
                "ping", headers={spelling: "1999-01-01"},
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
        assert body["error"]["code"] == -32022

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


class TestTheHandshakeIsExemptFromTheVersionRefusal:
    """A client's FIRST request may name a revision this server does not have.

    The header refusal and the `initialize` counter-offer are both right and they
    met in a place that served neither: a client whose newest revision is
    2026-07-28 must send that value in the header on its very first POST — that
    revision requires the header on every request and has no handshake to learn a
    different value from — and header validation runs before dispatch, so the
    request was refused 400 and `_handle_initialize` never ran. The counter-offer
    that exists for exactly this client was unreachable by it.

    Reverting the `method == 'initialize'` exemption in
    `_validated_protocol_version` fails
    test_a_current_generation_first_contact_is_counter_offered.
    """

    # The revision this server deliberately does not advertise, which is precisely
    # the value a current SDK puts in the header. Written as a literal rather than
    # derived: the point is a version OUTSIDE the supported tuple, and deriving it
    # from the tuple would make the test agree with whatever the tuple says.
    _UNIMPLEMENTED = "2026-07-28"

    def test_the_unimplemented_revision_really_is_unimplemented(self):
        """Anti-vacuity. If this revision were added to the tuple, every test in
        this class would pass by the ordinary supported-version path and would stop
        testing the exemption at all."""
        assert self._UNIMPLEMENTED not in mcp_handler.SUPPORTED_PROTOCOL_VERSIONS

    def test_a_current_generation_first_contact_is_counter_offered(self):
        """The whole finding, end to end: 200 and a usable version, not a 400.

        The client sends its newest revision in BOTH places, which is what a fresh
        SDK does, and gets the newest revision this server speaks — one round trip,
        no error to parse.
        """
        status, body = _call(_event(
            "initialize",
            params={"protocolVersion": self._UNIMPLEMENTED},
            headers={"MCP-Protocol-Version": self._UNIMPLEMENTED},
        ))

        assert status == 200, body
        assert "error" not in body, body
        assert body["result"]["protocolVersion"] == mcp_handler.PREFERRED_PROTOCOL_VERSION

    def test_the_exemption_covers_the_header_alone_as_well(self):
        """A client may state the transport version and leave `params` empty; the
        header must not refuse what the body would have been counter-offered."""
        status, body = _call(_event(
            "initialize", headers={"MCP-Protocol-Version": self._UNIMPLEMENTED},
        ))

        assert status == 200, body
        assert body["result"]["protocolVersion"] == mcp_handler.PREFERRED_PROTOCOL_VERSION

    @pytest.mark.parametrize("method", ["ping", "server/discover", "tools/list"])
    def test_every_other_method_still_refuses_the_same_header(self, method):
        """The asymmetry is the point, and it is not "initialize is special".

        Past the handshake a client HAS a negotiated value to send, so one this
        server never offered is the client contradicting itself. Parametrized across
        both halves of the dispatch so an exemption that leaked into the
        unauthenticated methods generally, or into the authenticated path, fails.
        """
        status, body = _call(_event(
            method, headers={"MCP-Protocol-Version": self._UNIMPLEMENTED},
            token=_TOKEN,
        ))

        assert status == 400, body
        assert body["error"]["code"] == -32022
        assert body["error"]["data"]["requested"] == self._UNIMPLEMENTED

    def test_the_exempted_handshake_still_negotiates_a_declared_version(self):
        """Exempt from the REFUSAL, not from the rule.

        The session must still speak something this server implements — an
        exemption that returned the client's own unimplemented version would have
        replaced a wrong refusal with a wrong promise.
        """
        negotiated = mcp_handler._validated_protocol_version(
            _event("initialize", headers={"MCP-Protocol-Version": self._UNIMPLEMENTED}),
            "initialize",
        )

        assert negotiated in mcp_handler.SUPPORTED_PROTOCOL_VERSIONS

    def test_a_malformed_sentinel_is_still_refused_on_the_handshake(self):
        """The exemption is for an unsupported VERSION, not for a broken encoding.

        There is nothing to counter-offer about a value that does not decode: the
        fault is the encoding and no negotiation fixes it.
        """
        status, body = _call(_event("initialize", headers={
            "MCP-Protocol-Version": "=?base64?not-base64!!?=",
        }))

        assert status == 400
        assert body["error"]["code"] == -32600
        assert "base64" in body["error"]["message"]

    def test_a_contradicting_routing_header_is_still_refused_on_the_handshake(self):
        """And the exemption is confined to the VERSION check, not to header
        validation as a whole."""
        status, body = _call(_event(
            "initialize", headers={"MCP-Method": "tools/call"},
        ))

        assert status == 400
        assert body["error"]["code"] == -32020


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
        act on.

        On `ping`, because the handshake counter-offers rather than refuses an
        unsupported version — and the rule under test here is that the sentinel
        does not change which rule applies.
        """
        status, body = _call(_event("ping", headers={
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
        """400 and `-32020 HeaderMismatch`, which is the spec's code for exactly
        this and carries the spec's own rationale: a load balancer routes on the
        header while the server executes on the body. `-32600` made the refusal
        indistinguishable, to a client, from a malformed JSON-RPC body."""
        status, body = _call(_event("ping", headers={"Mcp-Method": "tools/call"}))

        assert status == 400
        assert body["error"]["code"] == -32020
        assert "tools/call" in body["error"]["message"]
        assert "ping" in body["error"]["message"]

    def test_the_refusal_is_worded_the_way_the_spec_words_it(self):
        """`Header mismatch: Mcp-Name header value 'x' does not match body value 'y'`.

        The spec gives this exact shape, and matching it is what lets an operator
        reading two implementations' logs recognize one fault. It also pins the
        canonical header SPELLING, which is the one the client actually sent.
        """
        _status, body = _call(_event(
            "tools/call",
            params={"name": "get_metrics_summary", "arguments": {}},
            headers={"Mcp-Name": "search_feedback"},
            token=_TOKEN,
        ))

        message = body["error"]["message"]
        assert message.startswith("Header mismatch: Mcp-Name header value ")
        assert "does not match body value" in message
        # The spelling the spec uses, not the `MCP-Name` an over-general acronym
        # rule produced.
        assert "MCP-Name" not in message

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
        assert json.loads(response["body"])["error"]["code"] == -32020
        client.assert_not_called()

    def test_a_name_header_on_a_method_that_names_no_tool_is_refused(self):
        """`MCP-Name` names a TOOL, so on `tools/list` it asks for something this
        server cannot do — and answering the list would answer a different
        question."""
        status, body = _call(_event(
            "tools/list", headers={"Mcp-Name": "search_feedback"}, token=_TOKEN,
        ))

        assert status == 400
        assert body["error"]["code"] == -32020
        assert "tools/call" in body["error"]["message"]

    def test_a_name_header_with_no_name_in_the_body_is_refused(self):
        """A `tools/call` with no `name` is malformed anyway, but a header naming
        a tool while the body names none is the disagreement case: it must not be
        read as agreement."""
        status, body = _call(_event(
            "tools/call", params={"arguments": {}},
            headers={"Mcp-Name": "search_feedback"}, token=_TOKEN,
        ))

        assert status == 400
        assert body["error"]["code"] == -32020

    def test_both_echoes_are_matched_case_insensitively(self):
        for spelling in ("Mcp-Method", "MCP-METHOD", "mcp-method"):
            status, _body = _call(_event("ping", headers={spelling: "tools/call"}))
            assert status == 400, f"{spelling} was not read"


# ===========================================================================
# The result discriminator: spec resultType, local shape in _meta
# ===========================================================================

class TestResultDiscriminator:
    """Every result says what SHAPE it is, rather than being inferred from keys.

    A tool error differs from a tool result by a boolean and by whether
    `structuredContent` happens to be present, and `ping` answers a bare `{}`. A
    client switching on inferred shape re-derives that table from scratch and gets
    it subtly wrong — in the client, where nothing here can catch it.

    The mechanism is split across two fields on purpose, and the split IS the
    subject of this class: `resultType` carries the spec's `"complete"`, and the
    local vocabulary lives in `_meta` under a vendor prefix. Putting the local
    names in `resultType` — as the first draft did — obliged a conforming client
    of the newest advertised revision to reject every result this server sends,
    because the spec says an unrecognized `resultType` value MUST be considered
    invalid and this server declares no capability-advertised extension.

    ⚠️ Notifications are absent from `CASES`, and that is not an omission: a
    notification is answered 202 with no body, so it has no result to discriminate.
    `TestNotificationsAreAccepted` owns that path. An earlier version of this class
    justified the discriminator partly on "`{}` is both a pong and an ack" — a pair
    that only existed because a notification was being answered at all.
    """

    # Every dispatchable method that RETURNS A RESULT, with whatever it needs to
    # reach an answer. Keyed by method so a method added to the tables without a
    # line here fails `test_every_dispatchable_method_is_covered`.
    CASES: ClassVar[dict[str, tuple[dict, str | None]]] = {
        "initialize": ({}, None),
        "ping": ({}, None),
        "server/discover": ({}, None),
        "tools/list": ({}, _TOKEN),
        "tools/call": ({"name": "get_metrics_summary", "arguments": {}}, _TOKEN),
    }

    def test_every_result_carries_the_spec_result_type(self):
        """`complete` is the spec's value and the only one this server can mean.

        Pinned as a literal rather than through the constant: the point is the
        value a client on the wire sees, and a test that reads the constant would
        keep passing if the constant were changed to something the spec does not
        define.
        """
        for method, (params, token) in sorted(self.CASES.items()):
            _status, body = _call(_event(method, params=params, token=token))
            assert body["result"]["resultType"] == "complete", (
                f"{method} answered resultType {body['result'].get('resultType')!r}"
            )

    def test_the_local_vocabulary_is_not_in_the_spec_field(self):
        """The regression guard for the defect this class documents.

        Every local shape name must be absent from `resultType` everywhere. Written
        as a search over the whole vocabulary rather than one example, so a future
        shape cannot be added straight back into the spec's field.
        """
        seen = set()
        for method, (params, token) in sorted(self.CASES.items()):
            _status, body = _call(_event(method, params=params, token=token))
            seen.add(body["result"]["resultType"])

        assert seen == {"complete"}
        assert not (seen & mcp_handler.RESULT_SHAPES), (
            f"local shape names are travelling in the spec's resultType field: "
            f"{sorted(seen & mcp_handler.RESULT_SHAPES)}"
        )

    def test_the_vendor_prefix_is_not_one_the_spec_reserves(self):
        """The prefix has to be legal, or the `_meta` move solves nothing.

        The spec reserves any prefix whose SECOND LABEL is `modelcontextprotocol`
        or `mcp`. Asserted as that property rather than by restating the literal,
        so a future re-namespacing is still checked.
        """
        prefix = mcp_handler.VENDOR_META_PREFIX
        assert prefix.endswith('/'), prefix
        labels = prefix.rstrip('/').split('.')
        assert len(labels) >= 2, f"a vendor prefix needs a second label: {prefix}"
        assert labels[1] not in ('modelcontextprotocol', 'mcp'), (
            f"{prefix} is reserved for MCP use"
        )
        # And every key this module publishes actually sits behind it.
        for key in (mcp_handler.RESULT_SHAPE_KEY, mcp_handler.COST_CLASS_KEY):
            assert key.startswith(prefix), key

    def test_every_dispatchable_method_is_covered(self):
        """Anti-vacuity for the parametrized test below.

        The result-bearing methods are the dispatch tables MINUS the notifications,
        and the subtraction is derived from the table (a `None` handler is a method
        that produces no result) rather than by naming them here — so a notification
        added to the dispatch does not silently become an uncovered case, and one
        that gains a handler does not stay excluded.
        """
        dispatched = {*mcp_handler.MCP_METHODS, *mcp_handler.MCP_AUTH_METHODS}
        answers_with_a_result = {
            method for method in dispatched
            if mcp_handler.MCP_METHODS.get(method, 'authenticated') is not None
        }

        assert set(self.CASES) == answers_with_a_result, (
            f"uncovered methods: {sorted(answers_with_a_result - set(self.CASES))}; "
            f"stale cases: {sorted(set(self.CASES) - answers_with_a_result)}"
        )
        # Positive control: the subtraction must actually remove something, or this
        # test is the old one with more code.
        assert dispatched - answers_with_a_result, (
            "no notification is dispatched, so the exclusion above is vacuous"
        )

    @pytest.mark.parametrize("method", sorted(CASES))
    def test_every_method_answers_with_a_declared_result_shape(self, method):
        params, token = self.CASES[method]
        status, body = _call(_event(method, params=params, token=token))

        assert status == 200, body
        declared = body["result"]["_meta"].get(mcp_handler.RESULT_SHAPE_KEY)
        assert declared in mcp_handler.RESULT_SHAPES, (
            f"{method} answered with result shape {declared!r}"
        )

    def test_no_two_methods_share_a_shape(self):
        """The discriminator has to DISCRIMINATE.

        This replaces a pong/ack comparison, which compared two answers to two
        messages only one of which should have been answered at all. The surviving
        property is the general one and a stronger claim: every result-bearing
        method names a shape no other method names, so a client switching on the
        value never has to fall back to inferring from keys.
        """
        shapes = {}
        for method, (params, token) in sorted(self.CASES.items()):
            _status, body = _call(_event(method, params=params, token=token))
            shapes[method] = body["result"]["_meta"][mcp_handler.RESULT_SHAPE_KEY]

        assert len(set(shapes.values())) == len(shapes), f"shared shapes: {shapes}"
        # …while every one still says `complete` in the spec's field, which is the
        # whole reason the local discriminator had to move out of it.
        for method, (params, token) in sorted(self.CASES.items()):
            _status, body = _call(_event(method, params=params, token=token))
            assert body["result"]["resultType"] == "complete", method

    def test_there_is_no_shape_for_a_notification(self):
        """The `ack` shape is gone, and it must not come back.

        It named the answer to a notification — and a notification is answered 202
        with no body, which every advertised revision states as a MUST. A shape
        describing that response describes a response that must not be sent, so its
        absence is the invariant rather than a tidying.
        """
        assert 'ack' not in mcp_handler.RESULT_SHAPES
        assert not hasattr(mcp_handler, 'RESULT_SHAPE_ACK')

    def test_a_tool_error_is_a_different_shape_from_a_tool_result(self):
        """A refusal carries no `structuredContent` to validate, and the shape says
        so without the client testing for the key."""
        ok = mcp_handler._jsonrpc_result(
            1, mcp_handler.RESULT_SHAPE_TOOL_RESULT, {"isError": False},
        )
        bad = mcp_handler._tool_error(1, "nope")

        assert ok["result"]["_meta"][mcp_handler.RESULT_SHAPE_KEY] == (
            mcp_handler.RESULT_SHAPE_TOOL_RESULT
        )
        assert bad["result"]["_meta"][mcp_handler.RESULT_SHAPE_KEY] == (
            mcp_handler.RESULT_SHAPE_TOOL_ERROR
        )
        # And the flag the spec defines is still there: the shape describes the
        # payload, it does not replace `isError`.
        assert bad["result"]["isError"] is True

    def test_a_callers_meta_survives_alongside_the_shape(self):
        """`_meta` is MERGED, not replaced.

        The shape is injected into the same object the caller uses for its own
        `_meta` (cache hints on `tools/list`, the cost class on a tool result), so
        an implementation that assigned rather than merged would silently drop
        whichever of the two was written second.
        """
        built = mcp_handler._jsonrpc_result(
            1, mcp_handler.RESULT_SHAPE_TOOL_RESULT,
            {"isError": False, "_meta": {"com.example/own": "kept"}},
        )

        meta = built["result"]["_meta"]
        assert meta["com.example/own"] == "kept"
        assert meta[mcp_handler.RESULT_SHAPE_KEY] == mcp_handler.RESULT_SHAPE_TOOL_RESULT

    def test_a_payload_cannot_overwrite_the_discriminator(self):
        """Refused rather than resolved, in EITHER direction.

        The earlier builder spread the payload last, so a `result` carrying
        `resultType` replaced the validated value and the "an undeclared value
        cannot travel" guarantee was bypassed. Ordering the spread the other way
        would have silently discarded the caller's value instead, which is the same
        defect wearing the opposite sign — so both are a `ValueError`.
        """
        with pytest.raises(ValueError, match="already carries"):
            mcp_handler._jsonrpc_result(
                1, mcp_handler.RESULT_SHAPE_PONG, {"resultType": "input_required"},
            )
        with pytest.raises(ValueError, match="already carries"):
            mcp_handler._jsonrpc_result(
                1, mcp_handler.RESULT_SHAPE_PONG,
                {"_meta": {mcp_handler.RESULT_SHAPE_KEY: "toolResult"}},
            )

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
        assert result["_meta"][mcp_handler.RESULT_SHAPE_KEY] == (
            mcp_handler.RESULT_SHAPE_TOOL_ERROR
        )
        assert result["isError"] is True

    def test_an_undeclared_result_shape_cannot_be_sent(self):
        """A client cannot switch on a typo, and finding out at the client is
        finding out too late."""
        with pytest.raises(ValueError, match="undeclared result shape"):
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
        result_shape = parameters.get("result_shape")

        assert result_shape is not None, "_jsonrpc_result no longer takes a result shape"
        assert result_shape.default is inspect.Parameter.empty, (
            "result_shape has a default, so a result can ship without naming its shape"
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
# The envelope's forward-compatible extras are ADDITIVE
# ===========================================================================

class TestTheForwardCompatibleExtrasAreAdditive:
    """This envelope sends 2026-07-28 constructs under a range that predates them.

    `resultType`, `ttlMs`/`cacheScope`, `-32020`/`-32022` and `server/discover` are
    all defined by 2026-07-28, and this server deliberately advertises only the
    handshake-based revisions. That is a documented forward-compatibility bet (the
    PROVENANCE block at `ASSUMED_PROTOCOL_VERSION`) and it is safe for exactly one
    reason: those revisions' result schemas are permissive about members they do not
    know, so an extra field is IGNORED rather than rejected.

    This class pins the half of that argument which could break a client: the extras
    only ever ADD. A field an advertised revision defines is never replaced, retyped
    or renamed by them — because a client of an advertised revision reads those
    fields, and no permissiveness rule protects it there.

    Making any extra replace a spec-defined member fails these.
    """

    # What the advertised revisions define for the results this server sends, and
    # what a client written against one of them therefore reads. Deliberately a
    # LITERAL table rather than something derived from the handler: it is the other
    # side of the contract, so deriving it from the code under test would let the
    # code define its own obligations.
    REQUIRED_MEMBERS: ClassVar[dict[str, dict[str, type | tuple[type, ...]]]] = {
        "initialize": {
            "protocolVersion": str,
            "capabilities": dict,
            "serverInfo": dict,
        },
        "tools/list": {"tools": list},
        # `structuredContent` belongs HERE and not among the extras below: it is
        # defined by 2025-06-18, which is inside the advertised range. It arrived
        # ahead of the version that defined it once already — the skew the
        # SUPPORTED_PROTOCOL_VERSIONS comment records — and negotiating that range
        # is what ended that. Listing it as an extra would re-file a resolved
        # problem as an open one.
        "tools/call": {"content": list, "isError": bool, "structuredContent": dict},
    }

    @pytest.mark.parametrize("method", sorted(REQUIRED_MEMBERS))
    def test_every_member_the_advertised_revisions_define_is_still_there(self, method):
        """The extras did not displace anything.

        A client on 2025-11-25 reads exactly these members; an extra field beside
        them costs it nothing, and an extra field INSTEAD of one breaks it.
        """
        params, token = TestResultDiscriminator.CASES[method]
        status, body = _call(_event(method, params=params, token=token))

        assert status == 200, body
        for member, expected_type in self.REQUIRED_MEMBERS[method].items():
            assert member in body["result"], (
                f"{method} no longer sends {member!r}, which the advertised "
                f"revisions define"
            )
            assert isinstance(body["result"][member], expected_type), (
                f"{method}.{member} is {type(body['result'][member]).__name__}, "
                f"not {expected_type.__name__}: a retype, not an addition"
            )

    def test_the_extras_are_the_only_new_members(self):
        """Stated as a closed set, so an undocumented extra fails too.

        The provenance note is only worth having if it is complete: a field added to
        a result without a line in that note is exactly the "deliberate bet or
        mistake?" question the note exists to answer.
        """
        # `_meta` is the spec's own extension point and is defined by every
        # advertised revision, so it is not an extra — what is INSIDE it is
        # vendor-prefixed and covered by `test_the_vendor_prefix_is_not_one_the_
        # spec_reserves`.
        documented_extras = {"resultType", "ttlMs", "cacheScope", "_meta"}

        for method, required in sorted(self.REQUIRED_MEMBERS.items()):
            params, token = TestResultDiscriminator.CASES[method]
            _status, body = _call(_event(method, params=params, token=token))
            extras = set(body["result"]) - set(required)
            assert extras <= documented_extras, (
                f"{method} sends undocumented extra members {sorted(extras - documented_extras)}; "
                f"add them to the PROVENANCE note in mcp_handler.py or remove them"
            )

    def test_the_extras_are_actually_present(self):
        """Positive control for the subset assertion above.

        With no extras at all, `extras <= documented_extras` holds vacuously and
        this class would pass while the envelope sent nothing it claims to.
        """
        _status, body = _call(_event("initialize"))
        assert "resultType" in body["result"]

        _status, listing = _call(_event("tools/list", token=_TOKEN))
        assert {"ttlMs", "cacheScope"} <= set(listing["result"])

    def test_a_tool_result_keeps_the_text_block_a_pre_structured_client_reads(self):
        """The oldest advertised revision has no `structuredContent`.

        `content[0].text` carries the same payload serialized, so a 2024-11-05
        client is unaffected by everything this envelope added — which is the
        additive claim at its furthest reach.
        """
        _status, body = _call(_event(
            "tools/call",
            params={"name": "get_metrics_summary", "arguments": {}},
            token=_TOKEN,
        ))

        content = body["result"]["content"]
        assert content[0]["type"] == "text"
        assert json.loads(content[0]["text"]) == body["result"]["structuredContent"]

    def test_the_error_codes_outside_the_advertised_range_are_only_the_two_named(self):
        """The reserved-range judgement call, pinned to its stated scope.

        -32020 and -32022 are 2026-07-28's and are kept deliberately; the argument
        is in the provenance note. What must NOT happen is a third code appearing in
        that reserved sub-range, because "we use exactly the two the spec defines" is
        the whole basis for keeping them.
        """
        reserved = range(-32099, -32019)
        emitted = {
            mcp_handler.JSONRPC_HEADER_MISMATCH,
            mcp_handler.JSONRPC_UNSUPPORTED_PROTOCOL_VERSION,
        }
        module_codes = {
            value for name, value in vars(mcp_handler).items()
            if name.startswith('JSONRPC_') and isinstance(value, int)
        }

        assert module_codes & set(reserved) == emitted, (
            f"a code in the spec-reserved -32020..-32099 range that is not one of "
            f"the two 2026-07-28 defines: "
            f"{sorted((module_codes & set(reserved)) - emitted)}"
        )
        # Positive control: the two ARE in the reserved range, or the assertion
        # above is comparing two empty sets.
        assert emitted <= set(reserved)


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

    def test_the_json_rpc_endpoint_allows_what_it_serves(self):
        """`Allow` names the methods of the TARGET RESOURCE (RFC 9110 §15.5.6).

        For this endpoint that happens to coincide with the CORS declaration, and
        the coincidence is why deriving one from the other looked safe. It is not
        safe in general — see the autoseed test below.
        """
        response = mcp_handler.lambda_handler(
            _event(http_method="PUT"), MagicMock(),
        )
        allowed = {
            m.strip() for m in response["headers"]["Allow"].split(",")
        }

        assert allowed == {"POST", "OPTIONS"}

    @pytest.mark.parametrize("http_method", ["DELETE", "PUT", "PATCH"])
    def test_the_autoseed_path_allows_the_method_it_actually_serves(self, http_method):
        """The defect that made `Allow` per-path instead of per-function.

        `Access-Control-Allow-Methods` is one constant for the whole Lambda and
        answers "what may a browser preflight here"; `Allow` answers "what does
        THIS RESOURCE support". Deriving the second from the first refused
        `DELETE /v1/mcp/autoseed/{id}` with `Allow: POST, OPTIONS` — advertising a
        set that omits the one method that path serves, and sending a client to
        retry with POST on a path that only handles GET.

        POST is NOT among these: a POST to this path is still routed to JSON-RPC
        dispatch by the catch-all proxy route, so it answers -32601/404 rather than
        405. That is existing routing behaviour and not this header's subject.
        """
        response = mcp_handler.lambda_handler({
            "httpMethod": http_method,
            "path": f"/v1/mcp/autoseed/{_PROJECT}",
            "headers": {},
        }, MagicMock())

        assert response["statusCode"] == 405, response["body"]
        allowed = {m.strip() for m in response["headers"]["Allow"].split(",")}
        assert allowed == {"GET", "OPTIONS"}
        assert http_method not in allowed

    def test_the_two_paths_advertise_different_allow_sets(self):
        """Stated as a difference, because that IS the property.

        A single hard-coded set would satisfy each test above on its own; only
        comparing the two answers shows the header is resolved per resource.
        """
        jsonrpc = mcp_handler.lambda_handler(_event(http_method="PUT"), MagicMock())
        autoseed = mcp_handler.lambda_handler({
            "httpMethod": "PUT",
            "path": f"/v1/mcp/autoseed/{_PROJECT}",
            "headers": {},
        }, MagicMock())

        assert jsonrpc["headers"]["Allow"] != autoseed["headers"]["Allow"]

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


class TestNotificationsAreAccepted:
    """A notification is 202 with NO body, and never a JSON-RPC response.

    Every advertised revision says it in identical words: "If the input is a
    JSON-RPC response or notification: If the server accepts the input, the server
    MUST return HTTP status code 202 Accepted with no body."

    Two defects lived here, and both were client-visible:

      • `notifications/initialized` was answered 200 with a full result carrying
        `id: null` — a reply to a message that gets no reply, and an ill-formed one,
        because a result's id must not be null and a client correlating by id holds
        a response matching no request it sent.
      • every OTHER notification fell through to the unknown-method branch and got
        404. On this endpoint, in the revisions this server advertises, a 404 means
        the SESSION was terminated and the client "MUST start a new session by
        sending a new InitializeRequest" — so `notifications/cancelled`, the
        transport's own cancellation mechanism, told a client to tear down a live
        session over routine traffic.

    Reverting the `_is_notification` branch in `lambda_handler` fails every test in
    this class.
    """

    # The notification this server dispatches, plus three a conforming client may
    # send that it does not. All four get the same answer, which is the point: a
    # notification carries no obligation to act, so accepting and ignoring one is
    # what a server with no cancellation semantics honestly does.
    NOTIFICATIONS: ClassVar[tuple[str, ...]] = (
        "notifications/initialized",
        "notifications/cancelled",
        "notifications/progress",
        "notifications/roots/list_changed",
    )

    @pytest.mark.parametrize("method", NOTIFICATIONS)
    def test_a_notification_is_202_with_an_empty_body(self, method):
        response = _raw_call(_notification_event(method))

        assert response["statusCode"] == 202, response["body"]
        assert response["body"] == "", (
            f"{method} was answered with a body: {response['body']}"
        )

    def test_the_undispatched_notifications_really_are_undispatched(self):
        """Anti-vacuity for the parametrisation above.

        Three of those four are not in the dispatch tables, and that is what makes
        them the interesting cases: they used to reach the unknown-method branch.
        If they were all dispatched, this class would only be testing the one that
        always had a handler.
        """
        dispatched = {*mcp_handler.MCP_METHODS, *mcp_handler.MCP_AUTH_METHODS}
        undispatched = [m for m in self.NOTIFICATIONS if m not in dispatched]

        assert len(undispatched) >= 3, (
            f"only {undispatched} are undispatched; this class needs the "
            f"not-implemented notifications to be the subject"
        )

    @pytest.mark.parametrize("method", NOTIFICATIONS)
    def test_a_notification_is_never_answered_404(self, method):
        """The finding, stated as the thing that must not happen.

        A 404 on this endpoint instructs a client to re-initialize, so this is not
        a matter of tidiness: normal cancellation traffic was corrupting session
        state.
        """
        response = _raw_call(_notification_event(method))

        assert response["statusCode"] != 404, (
            f"{method} was answered 404, which tells the client its session died"
        )

    def test_a_notification_keeps_its_cors_headers(self):
        """A browser-based client must be able to read the 202.

        Without `Access-Control-Allow-Origin` the answer is opaque to it, which is
        the same property every other response on this endpoint has.
        """
        response = _raw_call(_notification_event("notifications/initialized"))

        assert response["headers"]["Access-Control-Allow-Origin"] == "*"

    def test_an_accepted_notification_announces_no_content_type(self):
        """There is no content to describe.

        `Content-Type: application/json` on an empty body is a small lie a strict
        client is entitled to complain about — and it is what a shared
        `_cors_response` would have sent.
        """
        response = _raw_call(_notification_event("notifications/initialized"))

        assert "Content-Type" not in response["headers"]

    def test_a_notification_with_an_id_is_a_request_and_is_answered(self):
        """JSON-RPC's definition is the id MEMBER, not the method name.

        A `notifications/`-named message carrying an id is a request by that
        definition, so it gets the request answer rather than being silently
        accepted — a client that sent an id is waiting for something.
        """
        status, body = _call(_event("notifications/initialized"))

        assert status == 404, body
        assert body["error"]["code"] == -32601
        assert body["id"] == 1

    def test_a_null_id_is_not_a_notification(self):
        """`"id": null` is a PRESENT member, so this is a malformed request rather
        than a notification. Accepting it as one would let a client that meant to
        correlate a response be answered with silence."""
        response = _raw_call(_event(
            body=json.dumps({"jsonrpc": "2.0", "id": None,
                             "method": "notifications/cancelled", "params": {}}),
        ))

        assert response["statusCode"] != 202
        assert json.loads(response["body"])["error"]["code"] == -32601

    def test_a_non_notification_method_without_an_id_is_not_accepted(self):
        """Both halves of `_is_notification` are required.

        A `tools/call` with no id is not a notification — MCP defines none by that
        name — and accepting it 202 would silently drop a request a client is
        waiting on.
        """
        response = _raw_call(_notification_event("tools/call", token=_TOKEN))

        assert response["statusCode"] != 202, response["body"]

    def test_a_notification_never_reaches_the_token_store(self):
        """It is accepted before dispatch and before authentication, so a
        credential presented on one buys no probe of the store."""
        with patch("mcp_handler.projects_table") as table:
            response = mcp_handler.lambda_handler(
                _notification_event("notifications/cancelled", token=_TOKEN), MagicMock(),
            )

        assert response["statusCode"] == 202
        table.query.assert_not_called()

    def test_a_notification_still_passes_the_transport_guards(self):
        """202 is for a notification this server ACCEPTS.

        A malformed transport is not accepted: the message has not said what it is,
        and the Origin and header guards run before the message kind is considered.
        """
        response = _raw_call(_notification_event(
            "notifications/initialized",
            headers={"MCP-Protocol-Version": "1999-01-01"},
        ))

        assert response["statusCode"] == 400, response["body"]
        assert json.loads(response["body"])["error"]["code"] == -32022

    def test_a_disallowed_origin_is_refused_before_a_notification_is_accepted(self):
        """The DNS-rebinding guard covers this path too — a 202 is still an answer
        to a request a rebound page made."""
        with patch("mcp_handler.ALLOWED_ORIGIN", "https://voc.example.com"):
            response = mcp_handler.lambda_handler(
                _notification_event("notifications/initialized",
                                    headers={"Origin": "https://evil.example.net"}),
                MagicMock(),
            )

        assert response["statusCode"] == 403, response["body"]

    # A refused notification, one per transport fault that can refuse one, with the
    # status and code each is owed. The 202 fix covered the ACCEPTED case; these are
    # the four requests that still came back carrying `id: null`.
    REFUSALS: ClassVar[tuple[tuple[str, dict, int], ...]] = (
        ("notifications/cancelled", {"MCP-Protocol-Version": "1999-01-01"}, -32022),
        ("notifications/cancelled", {"Mcp-Method": "ping"}, -32020),
        ("notifications/cancelled", {"Mcp-Name": "search_feedback"}, -32020),
        ("notifications/progress", {"Mcp-Method": "=?base64?!!!?="}, -32600),
    )

    @pytest.mark.parametrize("method,headers,code", REFUSALS)
    def test_a_refused_notification_carries_no_id_member(self, method, headers, code):
        """The `id: null` defect, one branch over from where it was fixed.

        Every advertised revision says a notification the server cannot accept gets an
        HTTP error status whose body "MAY comprise a JSON-RPC error response that has
        NO `id`". `"id": null` is a PRESENT member with a null value, which this module
        already holds is a different thing — it is what `_is_notification` turns on,
        what `test_a_null_id_is_not_a_notification` pins, and what the 3.4.0 entry
        records about a result's id. A client correlating by id held an error entry
        matching no request it ever sent.

        Asserted with `not in` rather than against a value, because the whole
        distinction is presence.
        """
        response = _raw_call(_notification_event(method, headers=headers))
        body = json.loads(response["body"])

        assert "id" not in body, (
            f"{method} refused with an id member: {body}"
        )

    @pytest.mark.parametrize("method,headers,code", REFUSALS)
    def test_a_refused_notification_keeps_its_status_and_its_code(self, method, headers, code):
        """Only the envelope changed.

        The 400 is what the advertised revisions require for a notification the server
        cannot accept, and the code is the spec's own per-fault code — the machine
        readable half a dual-era client's era probe reads. A fix that quietly
        collapsed these to one generic answer would be the earlier `-32600` regression
        wearing a different hat.
        """
        response = _raw_call(_notification_event(method, headers=headers))

        assert response["statusCode"] == 400, response["body"]
        assert json.loads(response["body"])["error"]["code"] == code

    def test_a_refused_request_still_carries_its_id(self):
        """Anti-vacuity, and the property that makes the change narrow.

        Omitting the id unconditionally would break every client that correlates a
        REQUEST's refusal — which is most of them, and it is why `_NO_ID` is a
        sentinel rather than `None`: a request whose id could not be detected is still
        reported as null.
        """
        response = _raw_call(_event(
            "ping", headers={"MCP-Protocol-Version": "1999-01-01"},
        ))
        body = json.loads(response["body"])

        assert body["id"] == 1, body

    def test_a_rebound_origin_refusal_carries_no_id_either(self):
        """The 403 runs before the body is even parsed, so it cannot know it is
        answering a request — and the transport's wording for this refusal is the same
        "no `id`".

        Sending `id: null` there guessed at an id for a message that may have carried
        none.
        """
        with patch("mcp_handler.ALLOWED_ORIGIN", "https://voc.example.com"):
            response = mcp_handler.lambda_handler(
                _notification_event("notifications/initialized",
                                    headers={"Origin": "https://evil.example.net"}),
                MagicMock(),
            )

        assert response["statusCode"] == 403
        assert "id" not in json.loads(response["body"])


class TestUnknownMethod:
    """An unknown JSON-RPC REQUEST is -32601 with a 404, and nothing else.

    A request, not a notification: the two used to share this branch, and 404 means
    something different to a notification's sender. `TestNotificationsAreAccepted`
    owns that half.
    """

    def test_an_unknown_method_is_method_not_found(self):
        """-32601 with HTTP 404, which the Streamable HTTP transport REQUIRES.

        The 200 this used to answer was not merely untidy: the status is what a
        dual-era client's fallback probe reads, and the JSON-RPC body is what
        distinguishes this 404 from the 404 of a legacy HTTP+SSE server that does
        not host the modern endpoint at all. A 200 said "your request was fine"
        about a method that does not exist.
        """
        status, body = _call(_event("tools/teleport"))

        assert body["error"]["code"] == -32601
        assert "tools/teleport" in body["error"]["message"]
        assert status == 404, body

    def test_the_two_message_kinds_get_different_answers(self):
        """The split, asserted as a difference.

        A single hard-coded answer satisfied both branches before, and that was the
        defect: one status for "this method does not exist" and for "your session
        died". Comparing the two answers is what stops one answer serving both.
        """
        request = _raw_call(_event("notifications/cancelled"))
        notification = _raw_call(_notification_event("notifications/cancelled"))

        assert request["statusCode"] == 404
        assert notification["statusCode"] == 202
        assert request["statusCode"] != notification["statusCode"]

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

        assert status == 404
        assert body["error"]["code"] == -32601

    @pytest.mark.parametrize("body_text", ['"a string"', "42", "null"])
    def test_a_non_object_body_is_not_a_crash(self, body_text):
        """The body is caller-controlled JSON and need not be an object. `[]`
        used to reach `.get` on a list — an AttributeError, i.e. a 502 with no
        envelope and no CORS headers, which is the failure mode the auth path's
        catch-all exists to prevent.

        `[]` is no longer parametrised here: an ARRAY is a batch, which has its own
        answer and its own reason (`TestBatchBodiesAreRefused`). It reached this
        branch — and its 404 — precisely because "not a dict" was the only thing this
        handler noticed about it.
        """
        status, body = _call(_event(body=body_text))

        assert status == 404, body
        assert body["error"]["code"] == -32601
        # `null`, not omitted: JSON-RPC reports an id it could not detect as null, and
        # a malformed body is exactly that case. `_NO_ID` is for a message that
        # carries no id BY DESIGN — a notification — which this is not.
        assert body["id"] is None


# ===========================================================================
# Batch bodies — the grammar of a revision this server no longer advertises
# ===========================================================================

class TestBatchBodiesAreRefused:
    """An array body is refused NAMING batching, and 2025-03-26 is not advertised.

    Batching is defined by exactly one revision: 2025-03-26 added it to the transport
    ("an array batching one or more requests and/or notifications") and 2025-06-18
    removed it again. This handler implements none of it, and it USED TO ADVERTISE
    that revision — so a conforming client was told it could send a shape that was
    then answered `404 -32601 "Method not found: "`, because a list has no `method`
    to find. On the advertised revisions a 404 on this endpoint means the SESSION was
    terminated and the client MUST re-initialize, so a client batching its
    `initialized` notification was told to tear down a live session, and
    re-initializing brought it straight back.

    Two halves, and both are needed: the revision is no longer offered (so no client
    is told this server accepts batches) AND an array is refused legibly (so a client
    that sends one anyway learns the actual constraint).

    Re-adding "2025-03-26" to `SUPPORTED_PROTOCOL_VERSIONS` fails
    test_no_advertised_revision_requires_a_body_grammar_this_server_refuses — and
    raises at IMPORT, from the guard beside the tuple. Deleting the `_is_batch`
    branch in `lambda_handler` fails the rest.
    """

    ONLY_NOTIFICATIONS: ClassVar[str] = json.dumps([
        {"jsonrpc": "2.0", "method": "notifications/initialized"},
        {"jsonrpc": "2.0", "method": "notifications/cancelled", "params": {"requestId": 1}},
    ])
    CONTAINS_A_REQUEST: ClassVar[str] = json.dumps([
        {"jsonrpc": "2.0", "id": 1, "method": "ping"},
    ])

    def test_no_advertised_revision_requires_a_body_grammar_this_server_refuses(self):
        """The rule, so a future entry is checked rather than reasoned about.

        2025-03-26 was re-added in this PR for a good reason — a header validator was
        refusing clients that had handshook against the deployed build — by reasoning
        about the HEADER and not about the body grammar. That is the mistake this
        assertion exists to catch, and the module raises on it at import too.
        """
        overlap = set(mcp_handler.SUPPORTED_PROTOCOL_VERSIONS) & (
            mcp_handler.BODY_GRAMMAR_UNIMPLEMENTED_VERSIONS
        )
        assert overlap == set(), (
            f"advertising {sorted(overlap)}, whose body grammar this handler refuses. "
            f"Either implement the grammar or stop offering the revision."
        )
        # Positive control: the constraint names something, or the line above is
        # comparing an empty intersection of an empty set.
        assert "2025-03-26" in mcp_handler.BODY_GRAMMAR_UNIMPLEMENTED_VERSIONS

    @pytest.mark.parametrize("label", ["ONLY_NOTIFICATIONS", "CONTAINS_A_REQUEST"])
    def test_a_batch_is_refused_as_a_malformed_request_not_a_missing_method(self, label):
        """-32600, not -32601: there is no method here to be found.

        `-32601 "Method not found: "` — with the empty method name the fall-through
        produced — told a caller nothing about what it had actually done, and sent it
        looking for a method name it never sent.
        """
        status, body = _call(_event(body=getattr(self, label)))

        assert status == 400, body
        assert body["error"]["code"] == -32600
        assert "batch" in body["error"]["message"].lower(), (
            f"the refusal does not name batching: {body['error']['message']!r}"
        )

    @pytest.mark.parametrize("label", ["ONLY_NOTIFICATIONS", "CONTAINS_A_REQUEST"])
    def test_a_batch_is_never_answered_404(self, label):
        """The finding, stated as the thing that must not happen.

        A 404 here instructed the client to tear down its session and re-initialize,
        so this was not untidiness: normal batched traffic was destroying sessions,
        and the retry landed on the same answer.
        """
        status, _body = _call(_event(body=getattr(self, label)))

        assert status != 404, (
            "a batch answered 404 tells the client its session died"
        )

    def test_the_refusal_carries_a_machine_readable_recovery_path(self):
        """A client should not have to parse English to find out what to do.

        Same standard the -32022 refusal already meets: `supported` is what to retry
        on, and `batchingSupported: false` is the constraint stated as data.
        """
        _status, body = _call(_event(body=self.CONTAINS_A_REQUEST))

        data = body["error"]["data"]
        assert data["supported"] == list(mcp_handler.SUPPORTED_PROTOCOL_VERSIONS)
        assert data["batchingSupported"] is False

    def test_a_batch_never_reaches_the_token_store(self):
        """Refused before authentication, like every other malformed transport: a
        body shape this server does not accept buys no probe of the credential
        store."""
        with patch("mcp_handler.projects_table") as table:
            response = mcp_handler.lambda_handler(
                _event(body=self.CONTAINS_A_REQUEST, token=_TOKEN), MagicMock(),
            )

        assert response["statusCode"] == 400
        table.query.assert_not_called()

    def test_a_batch_is_refused_before_a_routing_header_is_compared(self):
        """A batch has no single `method`, so there is nothing for `Mcp-Method` to
        contradict.

        Validating the routing echoes first reported a header/body mismatch against
        `''` — an answer about a header, for a request whose whole shape this server
        does not accept. The ordering is asserted through the CODE a client receives,
        because that is the part a client acts on.
        """
        _status, body = _call(_event(
            body=self.CONTAINS_A_REQUEST, headers={"Mcp-Method": "ping"},
        ))

        assert body["error"]["code"] == -32600, (
            f"a batch was diagnosed as a header mismatch: {body['error']}"
        )

    def test_a_single_message_is_still_served(self):
        """Anti-vacuity, and the only thing this refusal must not do.

        A guard on "is the body a list" that caught the ordinary object body would
        refuse every request this server has ever served.
        """
        status, body = _call(_event("initialize"))

        assert status == 200, body
        assert "result" in body

    def test_an_array_body_is_the_only_thing_this_refuses(self):
        """The other non-object bodies keep their existing answer.

        `"a string"`, `42` and `null` are malformed rather than batched, and reporting
        batching for them would send a caller after a feature it never used.
        `TestUnknownMethod` owns that half; this pins that the batch branch did not
        swallow it.
        """
        for body_text in ('"a string"', "42", "null"):
            status, body = _call(_event(body=body_text))
            assert status == 404, f"{body_text} was answered {status}: {body}"


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

    def test_the_list_carries_the_caching_hints_the_spec_requires(self):
        """The spec's own two fields, at the TOP LEVEL where a client reads them.

        `tools/list` is in the spec's cacheable-results list, so these are required.
        The earlier `_meta.cacheHints` object had the right semantics in a shape
        nothing reads: a spec-reading client found no `ttlMs`, applied the spec's
        default of 0, and cached nothing.

        `ttlMs` is asserted as a MAGNITUDE rather than against the constant, because
        the unit is the point — 300 in a milliseconds field is 0.3 seconds.
        """
        status, body = _call(_event("tools/list", token=_TOKEN))
        assert status == 200, body
        result = body["result"]

        assert isinstance(result["ttlMs"], int)
        assert result["ttlMs"] >= 60_000, (
            f"ttlMs={result['ttlMs']} looks like seconds, not milliseconds"
        )
        # And it is the same duration the seconds-denominated constant states,
        # converted rather than restated.
        assert result["ttlMs"] == mcp_handler._TOOL_LIST_MAX_AGE_SECONDS * 1000

        catalogue = result["_meta"][f"{mcp_handler.VENDOR_META_PREFIX}catalogue"]
        assert catalogue["etag"]
        assert catalogue["serverVersion"] == mcp_handler.MCP_SERVER_VERSION
        assert catalogue["listChangedNotifications"] is False

    def test_the_cache_scope_is_private_because_the_list_varies_by_credential(self):
        """The load-bearing hint, in the spec's own encoding of it.

        `private` is defined as "MAY be reused for the same authorization context;
        caches MUST NOT be shared across authorization contexts" — exactly the
        property that became necessary the moment the list started varying. With no
        `cacheScope` at all, nothing told a gateway cache not to serve one token's
        catalogue to another, which is the safety-relevant half of this fix.
        """
        _status, body = _call(_event("tools/list", token=_TOKEN))

        assert body["result"]["cacheScope"] == "private"

    def test_both_cacheable_answers_declare_the_scope_their_table_states(self):
        """Read from `METHOD_CACHE_SCOPES` rather than restated, because the value is
        now the same for both and a restated literal would be a second copy of it.

        This test used to assert the two DIFFER — discovery `public`, the catalogue
        `private` — as an anti-vacuity guard against one hard-coded value. That guard
        was pinning the very bug the `public` finding named: the difference it
        protected was wrong, and asserting a difference made the wrong value look
        deliberate. The vacuity it was worried about is covered instead by
        `TestCacheScopeMatchesWhatTheResponseDependsOn`, which derives the rule from
        what the response actually depends on — a stronger claim than "these two
        strings are not equal".
        """
        _s, discovery = _call(_event("server/discover"))
        _s, listing = _call(_event("tools/list", token=_TOKEN))

        assert discovery["result"]["cacheScope"] == (
            mcp_handler.METHOD_CACHE_SCOPES["server/discover"]
        )
        assert listing["result"]["cacheScope"] == (
            mcp_handler.METHOD_CACHE_SCOPES["tools/list"]
        )
        # And the table says something: a scope not in the spec's vocabulary is a
        # value no client can act on.
        assert set(mcp_handler.METHOD_CACHE_SCOPES.values()) <= {
            mcp_handler.CACHE_SCOPE_PUBLIC, mcp_handler.CACHE_SCOPE_PRIVATE,
        }

    def test_the_cache_hint_agrees_with_the_declared_capability(self):
        """Two statements about notifications, from one fact."""
        _status, initialize = _call(_event("initialize"))
        _status, listing = _call(_event("tools/list", token=_TOKEN))

        catalogue = listing["result"]["_meta"][
            f"{mcp_handler.VENDOR_META_PREFIX}catalogue"
        ]
        assert (
            catalogue["listChangedNotifications"]
            is initialize["result"]["capabilities"]["tools"]["listChanged"]
        )

    def test_two_credentials_with_different_reach_get_different_etags(self):
        """An etag that did not move with the catalogue would let a client keep
        serving a stale one — the failure the hint exists to prevent."""
        _s, full = _call(_event("tools/list", token=_TOKEN), row=_token_row())
        _s, narrow = _call(_event("tools/list", token=_TOKEN),
                           row=_token_row(scopes=[SCOPE_METRICS_READ]))

        key = f"{mcp_handler.VENDOR_META_PREFIX}catalogue"
        assert (
            full["result"]["_meta"][key]["etag"]
            != narrow["result"]["_meta"][key]["etag"]
        )

    def test_the_etag_is_stable_across_identical_requests(self):
        """Otherwise a client re-fetches forever and the hint is noise."""
        _s, first = _call(_event("tools/list", token=_TOKEN))
        _s, second = _call(_event("tools/list", token=_TOKEN))

        key = f"{mcp_handler.VENDOR_META_PREFIX}catalogue"
        assert (
            first["result"]["_meta"][key]["etag"]
            == second["result"]["_meta"][key]["etag"]
        )

    def test_the_list_still_requires_a_credential(self):
        """Filtering by authorization presupposes authorization: an unauthenticated
        `tools/list` must not fall back to "everything" or to "nothing"."""
        response = mcp_handler.lambda_handler(_event("tools/list"), MagicMock())

        assert response["statusCode"] == 401, response["body"]


# ===========================================================================
# cacheScope describes the RESPONSE, and the HTTP layer says so too
# ===========================================================================

class TestCacheScopeMatchesWhatTheResponseDependsOn:
    """`public` licenses a shared cache to serve a response ACROSS authorization
    contexts, so it must not be declared by an answer that depends on one.

    `server/discover` declared `public`, argued from its payload — which names no
    project, no tool and no data, and is beside the point. The method is in
    `_LIVENESS_CHECKED_METHODS`, so whether it answers 200 at all depends on the
    credential presented: none is a 200, a revoked one is a 401. An intermediary was
    therefore permitted to cache the unauthenticated 200 for an hour and replay it to
    the request carrying the dead token — defeating the liveness check on precisely
    the method that is in that set for the client which starts at discovery.

    Two changes each correct on their own terms (the liveness check made discovery
    credential-sensitive; the cache hints declared it credential-insensitive), which
    is why the invariant is asserted across BOTH constants rather than either being
    re-read on its own.

    Restoring `CACHE_SCOPE_PUBLIC` on discovery fails
    test_no_public_answer_is_credential_gated.
    """

    def test_no_public_answer_is_credential_gated(self):
        """The invariant, derived from both constants rather than restating either."""
        public_methods = {
            method for method, scope in mcp_handler.METHOD_CACHE_SCOPES.items()
            if scope == mcp_handler.CACHE_SCOPE_PUBLIC
        }
        gated = public_methods & mcp_handler._LIVENESS_CHECKED_METHODS

        assert gated == set(), (
            f"{sorted(gated)} declare cacheScope 'public' while their RESPONSE "
            f"depends on the credential (liveness-checked), so a shared cache may "
            f"serve a 200 where a 401 was owed. Either scope them 'private' or take "
            f"them out of the liveness set."
        )

    def test_the_invariant_has_a_subject(self):
        """Positive control: an empty intersection proves nothing about empty inputs.

        Both sides have to be non-empty, and they have to OVERLAP in methods — this
        rule is only about a method that is both cacheable and credential-gated, and
        `server/discover` is the one that is. If it stopped being either, the test
        above would pass while enforcing nothing.
        """
        assert mcp_handler.METHOD_CACHE_SCOPES, "no cacheable answers to check"
        assert mcp_handler._LIVENESS_CHECKED_METHODS, "no credential-gated methods"
        assert "server/discover" in mcp_handler.METHOD_CACHE_SCOPES
        assert "server/discover" in mcp_handler._LIVENESS_CHECKED_METHODS

    def test_the_credential_gate_on_discovery_is_real(self):
        """The premise, driven rather than read off a constant.

        The whole argument is that discovery's RESPONSE varies by credential. If it
        did not — if a dead token got the same 200 as no token — `public` would have
        been fine and this class would be enforcing a rule about nothing.
        """
        expired = _token_row(
            expires_at=(datetime.now(timezone.utc) - timedelta(days=1)).isoformat()
        )
        anonymous, _body = _call(_event("server/discover"))
        with_a_dead_token, _body = _call(
            _event("server/discover", token=_TOKEN), row=expired,
        )

        assert anonymous == 200
        assert with_a_dead_token == 401, (
            "discovery no longer depends on the credential, so the cache-scope rule "
            "this class enforces has lost its subject"
        )


class TestTheHttpLayerStatesWhatTheBodyStates:
    """`cacheScope` lives in the JSON-RPC body; the caches in front of this endpoint
    read HEADERS.

    API Gateway, a CDN and a corporate proxy do not parse a JSON-RPC result, so
    `cacheScope: private` reached only the clients that were never the risk. The
    catalogue genuinely varies — a full credential lists six tools, a `metrics:read`
    one lists two, with different etags — and it was served with no HTTP-level signal
    that it varies at all.

    Removing `Vary` or `Cache-Control` from `CORS_HEADERS` fails this class.
    """

    def _headers(self, event: dict, **kwargs) -> dict:
        return _raw_call(event, **kwargs)["headers"]

    @pytest.mark.parametrize("event_kwargs", [
        {"method": "tools/list", "token": _TOKEN},
        {"method": "initialize"},
        {"method": "server/discover"},
        {"method": "tools/teleport"},
    ])
    def test_every_answer_names_authorization_as_the_axis_it_varies_on(self, event_kwargs):
        """Unconditional, from the one choke point, rather than on the answers that
        vary today.

        The header costs nothing on an answer that does not vary — it forbids a cache
        hit that would have been correct — while a missing one costs a
        cross-credential hit. That asymmetry is the argument for having no condition
        to get wrong, and it matches how the module treats fail-closed elsewhere.
        """
        headers = self._headers(_event(**event_kwargs))

        varies_on = {name.strip().lower() for name in headers["Vary"].split(",")}
        assert "authorization" in varies_on, (
            f"{event_kwargs} answered without naming Authorization in Vary: "
            f"{headers.get('Vary')!r}"
        )

    def test_the_401_says_it_varies_too(self):
        """The most credential-dependent answer of all.

        A cached 401 replayed to a request carrying a good credential is the same
        defect facing the other way, and a refusal is exactly the kind of response an
        intermediary is happy to reuse.
        """
        headers = self._headers(_event("tools/list"))

        assert "authorization" in headers["Vary"].lower()

    def test_origin_is_not_named_because_the_answer_does_not_vary_by_it(self):
        """`Access-Control-Allow-Origin` is the static `*`, so naming `Origin` would
        forbid cache hits for no reason.

        Written as an absence with its reason, because "list every request header" is
        the tempting wrong answer and it silently disables caching altogether.
        """
        headers = self._headers(_event("initialize"))

        assert "origin" not in headers["Vary"].lower()
        assert mcp_handler.CORS_HEADERS["Access-Control-Allow-Origin"] == "*", (
            "the Allow-Origin header is no longer static, so Origin IS now an axis "
            "this endpoint varies on and Vary must name it"
        )

    def test_a_shared_cache_is_told_not_to_store_the_answer(self):
        """`Vary` says which header partitions the cache; `Cache-Control: private`
        says a shared cache must not store the response at all.

        Both, because a cache may honour one and not the other — a proxy that ignores
        `Vary` and respects `private` still cannot serve one credential's catalogue to
        another.
        """
        headers = self._headers(_event("tools/list", token=_TOKEN))

        directives = {d.strip().lower() for d in headers["Cache-Control"].split(",")}
        assert "private" in directives

    def test_the_client_is_not_forbidden_the_reuse_the_body_invites(self):
        """`no-store`/`no-cache` would contradict `ttlMs` at the HTTP layer.

        The two statements have to agree, and the one they agree on is "yours to
        reuse, not to share" — a client caching its OWN catalogue for `ttlMs` is
        exactly what the hint asks for.
        """
        response = _raw_call(_event("tools/list", token=_TOKEN))
        directives = {
            d.strip().lower() for d in response["headers"]["Cache-Control"].split(",")
        }

        assert "no-store" not in directives
        assert "no-cache" not in directives
        # Positive control: the body really does invite reuse, or there is nothing to
        # contradict.
        assert json.loads(response["body"])["result"]["ttlMs"] > 0

    def test_a_browser_can_read_the_header_that_says_the_answer_varies(self):
        """`Vary` is not CORS-safelisted, so a browser receives it and hides it.

        A statement the client cannot read is a statement to nobody — the same
        failure `WWW-Authenticate` already documents on this endpoint.
        """
        headers = self._headers(_event("tools/list", token=_TOKEN))

        exposed = {
            name.strip().lower()
            for name in headers["Access-Control-Expose-Headers"].split(",")
        }
        assert "vary" in exposed

    def test_an_accepted_notification_carries_the_same_statement(self):
        """The 202 builds its headers separately from `_cors_response`, which is how
        one of them comes to be missing a header the other has.

        Nothing caches a 202 in practice; the point is that the two builders do not
        disagree about what this endpoint's answers depend on.
        """
        response = _raw_call(_notification_event("notifications/initialized"))

        assert "authorization" in response["headers"]["Vary"].lower()


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
            cost = tool["_meta"][mcp_handler.COST_CLASS_KEY]
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
                assert tool["_meta"][mcp_handler.COST_CLASS_KEY] == mcp_handler.COST_EXPENSIVE, (
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
        assert body["result"]["_meta"][mcp_handler.COST_CLASS_KEY] == (
            mcp_handler.TOOL_COST_CLASSES["search_feedback"]
        )

    def test_the_advertised_and_the_reported_class_are_the_same_value(self):
        """Across every tool, not just the one an example exercises."""
        published = {
            tool["name"]: tool["_meta"][mcp_handler.COST_CLASS_KEY]
            for tool in mcp_handler.MCP_TOOLS
        }
        for name, advertised in published.items():
            arguments = {"dimension": "categories"} if name == "get_metrics_breakdown" else {}
            if name == "get_feedback_detail":
                arguments = {"feedback_id": "1ae1eb6abcd7d3a2e364f46139f98466"}
            status, body = _call(_event(
                "tools/call", params={"name": name, "arguments": arguments}, token=_TOKEN,
            ))
            assert status == 200, body
            assert body["result"]["_meta"][mcp_handler.COST_CLASS_KEY] == advertised, name

    def test_a_tool_error_carries_no_cost_class_to_misread(self):
        """A refusal did not perform the read, so reporting its class would
        attribute a cost to a call that never paid it.

        Same reasoning as `structuredContent` being absent on a refusal rather
        than empty.

        `_meta` itself is PRESENT — it carries the result shape now — so the
        assertion is about the cost key specifically rather than about the whole
        object, which is what it used to be able to say.
        """
        error = mcp_handler._tool_error(1, "nope")

        assert mcp_handler.COST_CLASS_KEY not in error["result"]["_meta"]

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

    @pytest.mark.parametrize("method", sorted(mcp_handler._LIVENESS_CHECKED_METHODS))
    def test_an_expired_credential_is_refused_where_a_client_decides_it_connected(
        self, method,
    ):
        """The methods a client uses to conclude it has a working session.

        Parametrized over the live set rather than a restated list, so a method
        added to it is covered here without an edit — and one that is listed but
        not actually checked fails.
        """
        status, body = _call(_event(method, token=_TOKEN), row=self._expired_row())

        assert status == 401, body
        assert body["error"]["code"] == -32001

    def test_the_checked_set_is_the_handshake_shaped_methods_only(self):
        """The scope of the check, stated as a property of the two halves.

        It must be a strict subset of the unauthenticated methods — checking an
        authenticated one would be redundant, and checking ALL of them is the
        cost/notification problem below.
        """
        checked = set(mcp_handler._LIVENESS_CHECKED_METHODS)

        assert checked < set(mcp_handler.MCP_METHODS), (
            "the liveness check must cover unauthenticated methods, and not all of them"
        )
        assert not checked & set(mcp_handler.MCP_AUTH_METHODS)

    def test_a_keepalive_is_not_a_liveness_probe(self):
        """`ping` is deliberately NOT checked.

        Cost: `ping` is a keepalive, so checking it put a token-store read on every
        heartbeat of every session — on a route throttled at 20 rps whose authorizer
        caches for 300 s, which is how one valid-shaped token drives that stream
        past the cache. Before this, `ping` touched nothing.
        """
        status, body = _call(_event("ping", token=_TOKEN), row=self._expired_row())

        assert status == 200, body
        assert "error" not in body

    def test_a_notification_with_a_dead_credential_is_still_accepted(self):
        """The other half of the same rule, now enforced structurally.

        A NOTIFICATION CARRIES NO ID, so a 401 to one is a response to a message
        JSON-RPC says must not receive one — and nobody concludes "connected" from
        an un-refused notification, so the honesty defect was never here. The 202
        answer reaches this before the dispatch does, which is why this is no longer
        a matter of `_LIVENESS_CHECKED_METHODS`'s contents.
        """
        response = _raw_call(
            _notification_event("notifications/initialized", token=_TOKEN),
            row=self._expired_row(),
        )

        assert response["statusCode"] == 202, response["body"]
        assert response["body"] == ""

    def test_the_liveness_check_never_stamps_last_used_at(self):
        """"Last used" means "last used to read something".

        Stamping it from a liveness probe would make a keepalive loop read as
        "last used: continuously" on the MCP Access tab — a field an operator reads
        to decide whether a credential is still wanted.
        """
        with patch("mcp_handler.projects_table") as table, \
             patch.dict(os.environ, {"METRICS_FUNCTION": "m"}):
            table.query.return_value = {"Items": [_token_row()]}
            mcp_handler.lambda_handler(_event("initialize", token=_TOKEN), MagicMock())

        table.update_item.assert_not_called()

    def test_a_live_credential_reading_data_still_stamps_last_used_at(self):
        """The positive control for the test above.

        Without it, an `_authenticate` that never wrote `last_used_at` at all would
        pass — and the field would silently stop meaning anything.
        """
        with patch("mcp_handler.projects_table") as table, \
             patch("shared.mcp_delegate.get_delegate_lambda_client",
                   return_value=_stub_domain_client()), \
             patch.dict(os.environ, {"METRICS_FUNCTION": "m"}):
            table.query.return_value = {"Items": [_token_row()]}
            mcp_handler.lambda_handler(_event(
                "tools/call",
                params={"name": "get_metrics_summary", "arguments": {}},
                token=_TOKEN,
            ), MagicMock())

        table.update_item.assert_called_once()

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
