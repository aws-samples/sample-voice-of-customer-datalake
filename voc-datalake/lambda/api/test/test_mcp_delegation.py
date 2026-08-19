"""Tests for the MCP delegation adapter (plan Phase 2, D1).

The MCP handler no longer reads the data lake. Every tool translates its
arguments into a route call, invokes the domain function that owns that route
with a synthesized API Gateway proxy event, and reshapes the answer. These tests
cover that translation; `test_mcp_security.py` covers the credential and the
claim synthesis that authorizes it.

A separate file from `test_mcp_security.py` deliberately: that file is 2 400
lines of credential and protocol invariants, and route-translation mechanics are
a different subject with a different failure mode. Same standard, though —
assert the invariant, then prove the assertion fails when the invariant is
removed. The revert map:

  test_search_without_a_query_uses_the_list_route
    — `/feedback/search` REFUSES a query under two characters, so mapping this
      tool onto that route alone (the obvious reading of the plan's route table)
      makes every filter-only call return nothing at all. Collapsing the two
      branches to one fails this.

  test_a_route_server_error_is_a_protocol_error
    — replaces the deleted `is_partial` suite. The old tool wrapped each
      DynamoDB read in its own try/except and reported a degraded answer; the
      adapter has no reads to degrade, so the equivalent honesty is that a
      failing route becomes an error rather than a plausible-looking empty
      answer. Mapping 5xx to an empty result fails this.

  test_a_route_refusal_is_a_tool_error_not_a_protocol_error
    — a 404 must arrive as `isError: true` inside a successful JSON-RPC call, so
      the model can correct itself. Making it a JSON-RPC error fails this; so
      does the old behaviour of returning prose with `isError: false`.

  test_unknown_dimension_is_refused_before_any_invoke
    — the enum is the tool's own contract, so an unknown value must not become a
      route lookup. Deleting the guard fails this on the invoke count.

  test_summary_list_truncates_the_verbatim /
  test_detail_keeps_the_whole_verbatim
    — the two feedback tools share one projection parameterized by `summary`.
      Dropping the parameter (one projection for both) fails one or the other.

  test_every_document_kind_is_reported
    — the defect this phase retires by construction: the in-process tool
      recognised 2 of 6 document sort-key prefixes, so an MCP client saw a third
      of a project's documents and was told nothing was filtered. Narrowing
      _DOCUMENT_KINDS back to PRD#/PRFAQ# fails this.

  test_boolean_query_values_are_sent_as_json_booleans
    — several routes' boolean validators are strict on purpose (a coerced
      "false" must not authorize a billed generation). `str(True)` is `'True'`,
      which none of them accept. Removing the bool branch in `_stringify` fails
      this.

  test_every_declared_route_is_reachable
    — DOMAIN_ROUTES is load-bearing at runtime, and a route key with no entry
      raises KeyError at call time rather than at import. This walks the table.
"""

import io
import json
import sys
from pathlib import Path
from unittest.mock import patch

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import mcp_handler
from shared.mcp_tokens import ALL_READ_SCOPES, REACH_WORKSPACE

_PROJECT = "proj-1"


def _token(**extra) -> dict:
    """A token record wide enough that no test trips a permission refusal."""
    return {
        "token_id": "tok_0123456789abcdef",
        "scopes": list(ALL_READ_SCOPES),
        "projects": [_PROJECT],
        "read_reach": REACH_WORKSPACE,
        **extra,
    }


class _FakeLambda:
    """A Lambda client that records invocations and replays canned responses.

    Keyed by route path so a test states the route it expects to be called,
    which is the thing under test — a stub keyed by call ORDER would pass even
    if the adapter chose the wrong route.
    """

    def __init__(self, bodies: dict, status: int = 200, function_error: str | None = None):
        self.bodies = bodies
        self.status = status
        self.function_error = function_error
        self.calls: list[tuple[str, dict]] = []

    def invoke(self, **kwargs):
        event = json.loads(kwargs["Payload"])
        self.calls.append((kwargs["FunctionName"], event))
        response: dict = {}
        if self.function_error:
            response["FunctionError"] = self.function_error
        body = self.bodies.get(event["path"], {})
        response["Payload"] = io.BytesIO(json.dumps({
            "statusCode": self.status,
            "body": json.dumps(body),
        }).encode())
        return response

    @property
    def paths(self) -> list[str]:
        return [event["path"] for _fn, event in self.calls]

    @property
    def last_query(self) -> dict:
        return self.calls[-1][1].get("queryStringParameters") or {}


@pytest.fixture(autouse=True)
def _functions_configured(monkeypatch):
    """Both delegation targets named, as the stack supplies them."""
    monkeypatch.setenv("METRICS_FUNCTION", "voc-metrics-api")
    monkeypatch.setenv("PROJECTS_FUNCTION", "voc-projects-api")


def _call(tool: str, arguments: dict, fake: _FakeLambda) -> dict:
    with patch("shared.mcp_delegate.get_lambda_client", return_value=fake):
        return mcp_handler._handle_tools_call(1, {"name": tool, "arguments": arguments}, _token())


def _feedback_row(**extra) -> dict:
    return {
        "id": "f1",
        "source_platform": "webscraper",
        "source_created_at": "2026-08-01T10:11:12Z",
        "sentiment_label": "negative",
        "sentiment_score": "-0.8",
        "category": "delivery",
        "urgency": "high",
        "rating": 2,
        "persona_type": "shopper",
        "original_text": "x" * 900,
        "problem_summary": "arrived late",
        "problem_root_cause_hypothesis": "carrier backlog",
        "direct_customer_quote": "never again",
        "keywords": ["late", "delivery"],
        "journey_stage": "post_purchase",
        **extra,
    }


# ===========================================================================
# Route selection
# ===========================================================================

class TestRouteSelection:
    def test_search_with_a_query_uses_the_search_route(self):
        fake = _FakeLambda({"/feedback/search": {"count": 0, "items": []}})
        _call("search_feedback", {"query": "late"}, fake)

        assert fake.paths == ["/feedback/search"]
        assert fake.last_query["q"] == "late"

    def test_search_without_a_query_uses_the_list_route(self):
        """The filter-only branch. /feedback/search refuses a query under two
        characters, so one route for both cases answers nothing for every call
        that filters without searching."""
        fake = _FakeLambda({"/feedback": {"count": 0, "items": []}})
        _call("search_feedback", {"category": "delivery"}, fake)

        assert fake.paths == ["/feedback"]
        assert "q" not in fake.last_query
        assert fake.last_query["category"] == "delivery"

    def test_a_blank_query_is_not_a_search(self):
        """Whitespace is not a search term, and the route would refuse it."""
        fake = _FakeLambda({"/feedback": {"count": 0, "items": []}})
        _call("search_feedback", {"query": "   "}, fake)

        assert fake.paths == ["/feedback"]

    @pytest.mark.parametrize("dimension,route", [
        ("sentiment", "/metrics/sentiment"),
        ("categories", "/metrics/categories"),
        ("sources", "/metrics/sources"),
        ("personas", "/metrics/personas"),
    ])
    def test_each_breakdown_dimension_reaches_its_own_route(self, dimension, route):
        fake = _FakeLambda({route: {"period_days": 7, "is_partial": False}})
        result = _call("get_metrics_breakdown", {"dimension": dimension}, fake)

        assert fake.paths == [route]
        assert result["result"]["isError"] is False

    def test_unknown_dimension_is_refused_before_any_invoke(self):
        fake = _FakeLambda({})
        result = _call("get_metrics_breakdown", {"dimension": "phase_of_moon"}, fake)

        assert result["error"]["code"] == -32602
        assert fake.calls == [], "a bad enum value must not become a route lookup"

    def test_the_project_id_lands_in_the_path(self):
        fake = _FakeLambda({f"/projects/{_PROJECT}": {"project": {"name": "P"}}})
        _call("get_project", {"project_id": _PROJECT}, fake)

        assert fake.paths == [f"/projects/{_PROJECT}"]
        assert fake.calls[-1][1]["pathParameters"] == {"project_id": _PROJECT}

    def test_each_domain_is_invoked_by_its_own_function_name(self):
        fake = _FakeLambda({
            "/metrics/summary": {"period_days": 7},
            f"/projects/{_PROJECT}": {"project": {}},
        })
        _call("get_metrics_summary", {}, fake)
        _call("get_project", {"project_id": _PROJECT}, fake)

        assert [fn for fn, _ in fake.calls] == ["voc-metrics-api", "voc-projects-api"]

    def test_every_declared_route_is_reachable(self):
        """Each DOMAIN_ROUTES entry resolves to a configured function and a path.

        The table is consulted at call time, so a key that names an unknown
        domain raises KeyError on the first client that touches that tool rather
        than at import.
        """
        for key, (domain, method, template) in mcp_handler.DOMAIN_ROUTES.items():
            assert domain in mcp_handler._DOMAIN_FUNCTION_ENV, f"{key} names an unknown domain"
            params = {name.strip("{}"): "x" for name in template.split("/") if name.startswith("{")}
            call = mcp_handler._domain_call(key, path_parameters=params)
            assert call.function_name, f"{key} resolved to no function name"
            assert call.method == method
            assert "{" not in call.path, f"{key} left an unformatted placeholder: {call.path}"


# ===========================================================================
# Error mapping — the three outcomes the spec separates
# ===========================================================================

class TestErrorMapping:
    def test_a_route_refusal_is_a_tool_error_not_a_protocol_error(self):
        fake = _FakeLambda({"/feedback/f-missing": {"message": "Feedback not found"}}, status=404)
        result = _call("get_feedback_detail", {"feedback_id": "f-missing"}, fake)

        assert "error" not in result, "a 404 is a tool outcome, not a protocol fault"
        assert result["result"]["isError"] is True
        assert "not found" in result["result"]["content"][0]["text"].lower()

    def test_a_tool_error_carries_no_structured_content(self):
        """structuredContent must validate against outputSchema, and a refusal
        has no payload to validate — so it is absent rather than empty."""
        fake = _FakeLambda({"/feedback/f-missing": {"message": "nope"}}, status=404)
        result = _call("get_feedback_detail", {"feedback_id": "f-missing"}, fake)

        assert "structuredContent" not in result["result"]

    def test_a_route_server_error_is_a_protocol_error(self):
        fake = _FakeLambda({"/metrics/summary": {"message": "boom"}}, status=500)
        result = _call("get_metrics_summary", {}, fake)

        assert result["error"]["code"] == -32603
        assert "result" not in result

    def test_a_server_error_detail_never_reaches_the_client(self):
        """The 5xx message is a FIXED string, asserted exactly.

        Pinned as equality rather than as "does not contain the function name",
        which is the weaker form this test started as and which a mutation walked
        straight through: interpolating the exception gave
        `Internal error: GET /metrics/summary returned 500` — no function name in
        it, so a substring check passed while the client learned the upstream
        route and status anyway. Any interpolation at all now fails here.

        What is being protected is not embarrassment: an upstream body can carry a
        table name, an ARN or a stack trace, and the topology of the account is
        not the caller's business.
        """
        fake = _FakeLambda({"/metrics/summary": {"message": "voc-metrics-api exploded"}}, status=500)
        result = _call("get_metrics_summary", {}, fake)

        assert result["error"]["message"] == "Internal error: upstream service unavailable"

    def test_an_unhandled_exception_in_the_domain_function_is_a_protocol_error(self):
        fake = _FakeLambda({"/metrics/summary": {}}, function_error="Unhandled")
        result = _call("get_metrics_summary", {}, fake)

        assert result["error"]["code"] == -32603

    def test_an_unconfigured_function_is_a_protocol_error(self, monkeypatch):
        monkeypatch.delenv("METRICS_FUNCTION", raising=False)
        fake = _FakeLambda({"/metrics/summary": {}})
        result = _call("get_metrics_summary", {}, fake)

        assert result["error"]["code"] == -32603
        assert fake.calls == [], "an unnamed function must not be invoked"

    def test_a_malformed_feedback_id_is_refused_before_any_invoke(self):
        fake = _FakeLambda({})
        result = _call("get_feedback_detail", {"feedback_id": ""}, fake)

        assert result["error"]["code"] == -32602
        assert fake.calls == []


# ===========================================================================
# Projections
# ===========================================================================

class TestProjections:
    def test_summary_list_truncates_the_verbatim(self):
        fake = _FakeLambda({"/feedback/search": {"items": [_feedback_row()]}})
        result = _call("search_feedback", {"query": "late"}, fake)
        item = result["result"]["structuredContent"]["items"][0]

        assert len(item["text"]) == 500
        assert item["date"] == "2026-08-01", "a list answer carries the day, not the timestamp"

    def test_detail_keeps_the_whole_verbatim(self):
        fake = _FakeLambda({"/feedback/f1": _feedback_row()})
        result = _call("get_feedback_detail", {"feedback_id": "f1"}, fake)
        item = result["result"]["structuredContent"]

        assert len(item["text"]) == 900
        assert item["date"] == "2026-08-01T10:11:12Z", "a single item carries the full timestamp"
        assert item["problem_root_cause"] == "carrier backlog"
        assert item["direct_quote"] == "never again"
        assert item["keywords"] == ["late", "delivery"]

    def test_the_renames_the_tools_have_always_reported(self):
        fake = _FakeLambda({"/feedback/f1": _feedback_row()})
        item = _call("get_feedback_detail", {"feedback_id": "f1"}, fake)["result"]["structuredContent"]

        assert item["source"] == "webscraper"
        assert item["sentiment"] == "negative"
        assert item["rating"] == "2", "rating stays stringified"

    def test_an_unrated_item_still_reads_as_not_applicable(self):
        row = _feedback_row()
        del row["rating"]
        fake = _FakeLambda({"/feedback/f1": row})
        item = _call("get_feedback_detail", {"feedback_id": "f1"}, fake)["result"]["structuredContent"]

        assert item["rating"] == "N/A"

    def test_every_document_kind_is_reported(self):
        """The DUP2 defect, retired by construction.

        One document per storage prefix; all six must be counted and labelled.
        The in-process tool recognised two.
        """
        documents = [
            {"sk": f"{prefix}{i}", "document_id": f"d{i}", "title": f"doc {i}"}
            for i, prefix in enumerate(mcp_handler._DOCUMENT_KINDS)
        ]
        fake = _FakeLambda({f"/projects/{_PROJECT}": {
            "project": {"name": "P", "description": "d", "created_at": "t"},
            "personas": [],
            "documents": documents,
        }})
        payload = _call("get_project", {"project_id": _PROJECT}, fake)["result"]["structuredContent"]

        assert payload["document_count"] == 6
        assert sorted(d["kind"] for d in payload["documents"]) == sorted(
            mcp_handler._DOCUMENT_KINDS.values()
        )

    def test_document_bodies_are_never_inlined(self):
        """A prototype body is hundreds of kilobytes; listing is the contract."""
        fake = _FakeLambda({f"/projects/{_PROJECT}": {
            "project": {"name": "P"},
            "personas": [],
            "documents": [{"sk": "PRD#1", "document_id": "d1", "title": "t",
                           "content": "SECRET-BODY" * 100}],
        }})
        result = _call("get_project", {"project_id": _PROJECT}, fake)

        assert "SECRET-BODY" not in json.dumps(result)

    def test_personas_are_listed_in_full_by_the_persona_tool(self):
        fake = _FakeLambda({f"/projects/{_PROJECT}": {
            "project": {"name": "P"},
            "personas": [{"persona_id": "p1", "name": "Ann", "goals": ["g"],
                          "pain_points": ["pp"], "behaviors": ["b"], "quote": "q"}],
            "documents": [],
        }})
        payload = _call("list_personas", {"project_id": _PROJECT}, fake)["result"]["structuredContent"]

        assert payload["count"] == 1
        assert payload["personas"][0]["goals"] == ["g"]
        assert payload["personas"][0]["age_range"] == "", "absent fields get typed defaults"

    def test_a_pass_through_tool_does_not_reshape_the_route_payload(self):
        """The metrics tools forward the route's answer verbatim. Reshaping here
        would reintroduce the second implementation delegating exists to remove
        — including the route's own is_partial, which must survive."""
        body = {"period_days": 7, "is_partial": True, "categories": {"delivery": 3},
                "a_field_added_later": 1}
        fake = _FakeLambda({"/metrics/categories": body})
        payload = _call("get_metrics_breakdown", {"dimension": "categories"}, fake)

        assert payload["result"]["structuredContent"] == body


# ===========================================================================
# The synthesized event
# ===========================================================================

class TestSynthesizedEvent:
    def test_query_values_are_strings_as_api_gateway_delivers_them(self):
        fake = _FakeLambda({"/metrics/summary": {}})
        _call("get_metrics_summary", {"days": 14}, fake)

        assert fake.last_query == {"days": "14"}

    def test_absent_filters_are_omitted_not_sent_empty(self):
        """An empty string is a filter value to a route; absence is not."""
        fake = _FakeLambda({"/feedback": {"items": []}})
        _call("search_feedback", {}, fake)

        assert "category" not in fake.last_query
        assert "source" not in fake.last_query

    def test_boolean_query_values_are_sent_as_json_booleans(self):
        """`str(True)` is `'True'`, which no route's boolean validator accepts —
        and several are strict on purpose."""
        from shared.mcp_delegate import DomainCall, build_proxy_event

        event = build_proxy_event(
            DomainCall(function_name="f", method="GET", path="/x",
                       query={"yes": True, "no": False}),
            {"sub": "mcp:tok_1"},
        )

        assert event["queryStringParameters"] == {"yes": "true", "no": "false"}

    def test_the_credential_is_never_forwarded(self):
        """The domain function has no use for the MCP token, and forwarding a
        secret past its audience is how secrets reach logs."""
        fake = _FakeLambda({"/metrics/summary": {}})
        _call("get_metrics_summary", {}, fake)
        headers = fake.calls[-1][1]["headers"]

        assert not any(h.lower() == "authorization" for h in headers)

    def test_no_accept_encoding_is_offered(self):
        """Powertools may gzip when the caller advertises it, and the adapter
        decodes plain JSON."""
        fake = _FakeLambda({"/metrics/summary": {}})
        _call("get_metrics_summary", {}, fake)

        assert not any(h.lower() == "accept-encoding" for h in fake.calls[-1][1]["headers"])

    def test_the_event_carries_what_the_powertools_resolver_routes_on(self):
        fake = _FakeLambda({"/metrics/summary": {}})
        _call("get_metrics_summary", {}, fake)
        event = fake.calls[-1][1]

        assert event["httpMethod"] == "GET"
        assert event["path"] == "/metrics/summary"
        assert event["isBase64Encoded"] is False


# ===========================================================================
# Structured output
# ===========================================================================

class TestStructuredOutput:
    def test_the_text_block_is_the_structured_payload_serialized(self):
        """Both come from one value, so a client comparing them cannot find a
        disagreement."""
        fake = _FakeLambda({"/metrics/summary": {"period_days": 7, "total_feedback": 3}})
        result = _call("get_metrics_summary", {}, fake)["result"]

        assert json.loads(result["content"][0]["text"]) == result["structuredContent"]

    def test_every_tool_declares_an_output_schema(self):
        for tool in mcp_handler.MCP_TOOLS:
            assert "outputSchema" in tool, f"{tool['name']} declares no outputSchema"
            assert tool["outputSchema"]["type"] == "object", (
                f"{tool['name']}: structuredContent must be an object"
            )

    def test_every_registered_tool_is_declared_and_routed(self):
        declared = {tool["name"] for tool in mcp_handler.MCP_TOOLS}
        assert declared == set(mcp_handler.TOOL_HANDLERS)
        assert declared == set(mcp_handler.TOOL_SCOPE_REQUIREMENTS)
        assert declared == set(mcp_handler.TOOL_REACH_KINDS)

    def test_the_server_version_is_semver_and_past_1(self):
        """The output shapes changed; a client pinning on 1.x must be able to
        tell."""
        major = mcp_handler.MCP_SERVER_VERSION.split(".")[0]
        assert int(major) >= 2
