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
import os
import re
import sys
from pathlib import Path
from typing import ClassVar
from unittest.mock import MagicMock, patch

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import mcp_handler
from shared.mcp_delegate import DelegationUnavailable
from shared.mcp_tokens import ALL_READ_SCOPES, REACH_WORKSPACE, mint_token

# REAL-SHAPED ids throughout, not `proj-1` / `f1`.
#
# The path-parameter guard refuses anything that is not shaped like an id the
# product actually mints, so a convenient-looking fixture would fail — and that
# is the right way round. Unrealistic fixtures are what let the `feedback_id`
# bug survive a full suite: every fixture set both `id` and `feedback_id`, so no
# test could notice that real rows carry only one.
_PROJECT = "proj_20260819143000"
_FEEDBACK_ID = "1ae1eb6abcd7d3a2e364f46139f98466"
_OTHER_FEEDBACK_ID = "78be6bbfbbfa701284c9491d2cec4e1a"


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
    with patch("shared.mcp_delegate.get_delegate_lambda_client", return_value=fake):
        return mcp_handler._handle_tools_call(1, {"name": tool, "arguments": arguments}, _token())


def _feedback_row(**extra) -> dict:
    return {
        "id": "1ae1eb6abcd7d3a2e364f46139f98466",
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
        # Real-shaped values per parameter: the path guard refuses placeholders,
        # which is the point of it.
        sample = {"project_id": _PROJECT, "feedback_id": _FEEDBACK_ID}
        for key, (domain, method, template) in mcp_handler.DOMAIN_ROUTES.items():
            assert domain in mcp_handler._DOMAIN_FUNCTION_ENV, f"{key} names an unknown domain"
            params = {}
            for segment in template.split("/"):
                if segment.startswith("{"):
                    name = segment.strip("{}")
                    assert name in sample, f"{key} interpolates '{name}'; add a sample value here"
                    params[name] = sample[name]
            call = mcp_handler._domain_call(key, path_parameters=params)
            assert call.function_name, f"{key} resolved to no function name"
            assert call.method == method
            assert "{" not in call.path, f"{key} left an unformatted placeholder: {call.path}"


# ===========================================================================
# Error mapping — the three outcomes the spec separates
# ===========================================================================

class TestErrorMapping:
    def test_a_route_refusal_is_a_tool_error_not_a_protocol_error(self):
        fake = _FakeLambda({"/feedback/00000000000000000000000000000000": {"message": "Feedback not found"}}, status=404)
        result = _call("get_feedback_detail", {"feedback_id": "00000000000000000000000000000000"}, fake)

        assert "error" not in result, "a 404 is a tool outcome, not a protocol fault"
        assert result["result"]["isError"] is True
        assert "not found" in result["result"]["content"][0]["text"].lower()

    def test_a_tool_error_carries_no_structured_content(self):
        """structuredContent must validate against outputSchema, and a refusal
        has no payload to validate — so it is absent rather than empty."""
        fake = _FakeLambda({"/feedback/00000000000000000000000000000000": {"message": "nope"}}, status=404)
        result = _call("get_feedback_detail", {"feedback_id": "00000000000000000000000000000000"}, fake)

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
        fake = _FakeLambda({"/feedback/1ae1eb6abcd7d3a2e364f46139f98466": _feedback_row()})
        result = _call("get_feedback_detail", {"feedback_id": "1ae1eb6abcd7d3a2e364f46139f98466"}, fake)
        item = result["result"]["structuredContent"]

        assert len(item["text"]) == 900
        assert item["date"] == "2026-08-01T10:11:12Z", "a single item carries the full timestamp"
        assert item["problem_root_cause"] == "carrier backlog"
        assert item["direct_quote"] == "never again"
        assert item["keywords"] == ["late", "delivery"]

    def test_the_reported_id_is_the_one_the_detail_tool_needs(self):
        """search_feedback must report an id get_feedback_detail can look up.

        Both tools read `item.get('id')` before this change, and the processor
        never writes a plain `id` — the identifier is `feedback_id`, which is what
        the detail route keys its GSI on. So every search result carried
        `"id": ""` and there was no way for an agent to reach a single item: the
        only source of a feedback id is a search, and search reported none.
        Caught against the deployed API, not by a unit test, because every
        fixture in the suite happened to set both fields.
        """
        row = _feedback_row(feedback_id="78be6bbfbbfa701284c9491d2cec4e1a")
        row.pop("id", None)
        fake = _FakeLambda({"/feedback/search": {"items": [row]}})
        item = _call("search_feedback", {"query": "late"}, fake)["result"]["structuredContent"]["items"][0]

        assert item["id"] == "78be6bbfbbfa701284c9491d2cec4e1a"

    def test_a_row_carrying_only_a_plain_id_still_reports_it(self):
        """The fallback, so the fix does not break a row shaped the old way."""
        fake = _FakeLambda({"/feedback/1ae1eb6abcd7d3a2e364f46139f98466": {"id": "legacy-1", "original_text": "t"}})
        item = _call("get_feedback_detail", {"feedback_id": "1ae1eb6abcd7d3a2e364f46139f98466"}, fake)["result"]["structuredContent"]

        assert item["id"] == "legacy-1"

    def test_the_renames_the_tools_have_always_reported(self):
        fake = _FakeLambda({"/feedback/1ae1eb6abcd7d3a2e364f46139f98466": _feedback_row()})
        item = _call("get_feedback_detail", {"feedback_id": "1ae1eb6abcd7d3a2e364f46139f98466"}, fake)["result"]["structuredContent"]

        assert item["source"] == "webscraper"
        assert item["sentiment"] == "negative"
        assert item["rating"] == "2", "rating stays stringified"

    def test_an_unrated_item_still_reads_as_not_applicable(self):
        row = _feedback_row()
        del row["rating"]
        fake = _FakeLambda({"/feedback/1ae1eb6abcd7d3a2e364f46139f98466": row})
        item = _call("get_feedback_detail", {"feedback_id": "1ae1eb6abcd7d3a2e364f46139f98466"}, fake)["result"]["structuredContent"]

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

    def test_count_never_exceeds_the_items_it_describes(self):
        """`count` describes what the CALLER received, not what the route sent.

        The projection skips a non-dict entry, so counting the route's list
        instead would report a count larger than `len(items)` in the same
        payload — a client trusting `count` would then read past the end.
        """
        fake = _FakeLambda({"/feedback/search": {
            "items": [_feedback_row(), "not-a-record", None],
        }})
        payload = _call("search_feedback", {"query": "late"}, fake)["result"]["structuredContent"]

        assert payload["count"] == len(payload["items"]) == 1

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


# ===========================================================================
# Path-parameter confinement — the adapter's route choice is not the caller's
# ===========================================================================

class TestPathParameterConfinement:
    """A path parameter is part of the routing key, so it is validated as one.

    The delegated path is what the Powertools resolver matches on, and
    `pathParameters` is never consulted, so an unvalidated value does not just
    reach the wrong record — it reaches the wrong ROUTE. Two ways, both real and
    both found in review:

      • extra segments — `project_id='p/api-tokens'` builds
        `/projects/p/api-tokens` and lands on the token-list route;
      • a collision with a STATIC sibling — `project_id='prioritization'` builds
        `/projects/prioritization`, and Powertools checks static routes BEFORE
        dynamic ones, so it lands on `api_get_prioritization_scores`: the
        prioritization surface that is deliberately excluded from MCP entirely.
        Segment counting does not catch this, which is why the guard is a format
        check.

    Reverting `_validated_path_parameters` fails every test here.
    """

    @pytest.mark.parametrize("hostile", [
        "prioritization",            # a static sibling — the excluded surface
        "config",                    # another static sibling
        "proj_1/api-tokens",         # segment injection
        "proj_1/jobs",
        "../metrics/summary",        # traversal
        "..",
        ".",
        "proj_1?x=1",
        "proj_1#frag",
        "proj%2F1",                  # percent-encoded separator
        "proj 1",                    # internal whitespace
        "",
    ])
    def test_a_hostile_project_id_never_becomes_a_route(self, hostile):
        fake = _FakeLambda({})
        result = _call("get_project", {"project_id": hostile}, fake)

        assert result.get("error", {}).get("code") == -32602, result
        assert fake.calls == [], f"{hostile!r} reached a domain function"

    @pytest.mark.parametrize("hostile", ["search", "urgent", "entities", "f1/similar", "../urgent"])
    def test_a_hostile_feedback_id_never_becomes_a_route(self, hostile):
        """`/feedback/search`, `/feedback/urgent` and `/feedback/entities` are
        static siblings of `/feedback/<feedback_id>`."""
        fake = _FakeLambda({})
        result = _call("get_feedback_detail", {"feedback_id": hostile}, fake)

        assert result.get("error", {}).get("code") == -32602, result
        assert fake.calls == [], f"{hostile!r} reached a domain function"

    def test_a_real_project_id_is_still_accepted(self):
        """The guard must not refuse the ids the product actually mints."""
        fake = _FakeLambda({"/projects/proj_20260717165917": {"project": {"name": "P"}}})
        result = _call("get_project", {"project_id": "proj_20260717165917"}, fake)

        assert result["result"]["isError"] is False
        assert fake.paths == ["/projects/proj_20260717165917"]

    def test_a_real_feedback_id_is_still_accepted(self):
        fid = "1ae1eb6abcd7d3a2e364f46139f98466"
        fake = _FakeLambda({f"/feedback/{fid}": {"feedback_id": fid, "original_text": "t"}})
        result = _call("get_feedback_detail", {"feedback_id": fid}, fake)

        assert result["result"]["isError"] is False

    def test_a_padded_project_id_is_normalized_rather_than_refused(self):
        """Surrounding whitespace is stripped upstream, so it never reaches here.

        `_resolve_project_id` strips an explicit argument before authorization, so
        `' proj_1'` and `'proj_1'` are the same request — which is why the guard's
        own no-whitespace rule sees an already-clean value. Pinned so a change to
        either side is a deliberate one: if the strip were removed, the guard
        would start refusing a padded id that used to work.
        """
        fake = _FakeLambda({f"/projects/{_PROJECT}": {"project": {"name": "P"}}})
        result = _call("get_project", {"project_id": f"  {_PROJECT}  "}, fake)

        assert result["result"]["isError"] is False
        assert fake.paths == [f"/projects/{_PROJECT}"]

    def test_the_guard_does_not_bet_on_where_an_id_came_from(self):
        """An id of an unexpected SHAPE is delegated, not refused.

        The first version of this guard was a format allowlist (`proj_` + a
        timestamp, 32 hex). It stopped both attacks, and it also bet on id
        PROVENANCE: a project seeded, imported, or minted by an older generator
        would be permanently unreachable through MCP and reported as a malformed
        argument rather than a missing project. That trades an availability
        property for a security one that the shape rule already provides.
        """
        legacy = "legacy-project-42"
        fake = _FakeLambda({f"/projects/{legacy}": {"project": {"name": "Old"}}})
        result = _call("get_project", {"project_id": legacy}, fake)

        assert result["result"]["isError"] is False
        assert fake.paths == [f"/projects/{legacy}"]

    # Every decorator form Powertools registers a route with. `patch` is not
    # hypothetical — projects_handler uses it twice, and an earlier version of
    # this regex missed it, which is precisely how a security argument that rests
    # on set completeness goes quietly wrong.
    ROUTE_DECORATOR = re.compile(
        r'@\w+\.(?:get|post|put|delete|patch|head|options|route)\(\s*[\'"]([^\'"]+)[\'"]'
    )
    OWNERS: ClassVar[dict[str, str]] = {
        "/projects": "projects_handler.py",
        "/feedback": "metrics_handler.py",
    }

    def _static_siblings(self, prefix: str, handler: str) -> set[str]:
        """Static route segments at the parameter's position, from ONE file.

        ⚠️ Single-file by design and only sound while these handlers register
        every route inline. Powertools also supports `Router` objects in other
        modules included into an app; a route registered that way would be
        invisible here, and the reserved set would be quietly incomplete. That is
        not documented and left to trust — `test_no_route_is_registered_outside_
        the_scanned_file` asserts the pattern is absent.
        """
        source = (Path(__file__).resolve().parents[1] / handler).read_text()
        depth = len(prefix.strip("/").split("/"))
        siblings = set()
        for match in self.ROUTE_DECORATOR.finditer(source):
            parts = match.group(1).strip("/").split("/")
            if (len(parts) > depth
                    and "/".join(parts[:depth]) == prefix.strip("/")
                    and not parts[depth].startswith("<")):
                siblings.add(parts[depth])
        return siblings

    def test_the_sibling_derivation_actually_finds_routes(self):
        """Positive control, because the assertion below is a subset test.

        `siblings <= declared` passes trivially when the regex matches nothing —
        so a decorator form this pattern does not know (a new verb, a Router, a
        rename of `app`) would turn the whole reserved-segment argument green and
        empty. This is the test that fails instead.
        """
        for prefix, handler in self.OWNERS.items():
            siblings = self._static_siblings(prefix, handler)
            assert siblings, (
                f"no static routes found under {prefix} in {handler} — the route "
                f"decorator pattern has drifted, and the lockstep below is vacuous"
            )
        # And a specific one, so "found something" cannot pass on an unrelated match.
        assert "prioritization" in self._static_siblings("/projects", "projects_handler.py")
        assert "search" in self._static_siblings("/feedback", "metrics_handler.py")

    def test_no_route_is_registered_outside_the_scanned_file(self):
        """The sibling scan reads one file per prefix, so nothing may hide.

        Powertools supports `Router` objects declared in another module and
        included into an app. Neither owning handler uses that today, and the
        reserved-segment argument depends on it staying that way — a routed module
        would be invisible to the scan and the set would be quietly incomplete.
        Asserted rather than trusted, because "we don't use Routers" is exactly
        the kind of claim that stops being true without anyone revisiting this.
        """
        for handler in self.OWNERS.values():
            source = (Path(__file__).resolve().parents[1] / handler).read_text()
            assert "Router" not in source, (
                f"{handler} now references a Router; _static_siblings reads only "
                f"this file, so routes registered elsewhere would be missed and "
                f"the reserved-segment sets could be incomplete"
            )
            assert "include_router" not in source

    def test_reserved_segments_cover_every_static_sibling(self):
        """Lockstep: the reserved sets are derived from the handlers, not guessed.

        This is what replaces the provenance bet. A static route added to one of
        those handlers at the same position as a templated parameter would
        otherwise become quietly reachable through the tool that interpolates
        there; adding it now fails this test until it is reserved.
        """
        for prefix, handler in self.OWNERS.items():
            siblings = self._static_siblings(prefix, handler)
            declared = mcp_handler._RESERVED_PATH_SEGMENTS[prefix]
            assert siblings <= declared, (
                f"{handler} has static routes under {prefix} that are not reserved: "
                f"{sorted(siblings - declared)} — a tool interpolating a parameter "
                f"there could reach them"
            )

    def test_every_interpolated_prefix_declares_a_reserved_set(self):
        """BOTH directions, because only one of them is a security property.

        A prefix with no entry used to fall back to an empty set, which meant a
        future templated route silently permitted sibling collisions — the exact
        hole the redesign was supposed to close, reintroduced by omission rather
        than by choice. `_reserved_for` now raises for an unknown prefix, and this
        asserts the table covers every prefix any declared route interpolates, so
        the failure is at build time rather than on a caller's first attempt.
        """
        interpolated = set()
        for _domain, _method, template in mcp_handler.DOMAIN_ROUTES.values():
            segments = template.strip("/").split("/")
            for index, segment in enumerate(segments):
                if segment.startswith("{"):
                    interpolated.add("/" + "/".join(segments[:index]))

        declared = set(mcp_handler._RESERVED_PATH_SEGMENTS)
        assert interpolated <= declared, (
            f"routes interpolate a parameter under prefixes with no reserved set: "
            f"{sorted(interpolated - declared)} — declare one (an explicit "
            f"frozenset() if the prefix genuinely has no static siblings)"
        )
        assert declared <= interpolated, (
            f"reserved segments declared for prefixes no route interpolates: "
            f"{sorted(declared - interpolated)}"
        )

    def test_an_undeclared_prefix_fails_closed_as_a_server_error(self):
        """A templated route whose prefix has no entry is refused, not allowed.

        And refused as a SERVER fault (-32603 via DelegationUnavailable), not as
        `-32602 Invalid params`: a missing declaration is a misconfiguration, and
        blaming the caller's arguments would send it looking for a different id
        when nothing it could send would work.
        """
        future = {"future": (mcp_handler.DOMAIN_PROJECTS, "GET", "/whatever/{project_id}")}
        with patch.dict(mcp_handler.DOMAIN_ROUTES, future), \
             pytest.raises(DelegationUnavailable, match="reserved-segment"):
            mcp_handler._validated_path_parameters("future", {"project_id": _PROJECT})

    def test_that_server_error_is_not_reported_as_a_bad_argument(self):
        """End to end: the caller sees -32603, never -32602."""
        future = {"project_get": (mcp_handler.DOMAIN_PROJECTS, "GET", "/whatever/{project_id}")}
        fake = _FakeLambda({})
        with patch.dict(mcp_handler.DOMAIN_ROUTES, future):
            result = _call("get_project", {"project_id": _PROJECT}, fake)

        assert result["error"]["code"] == -32603, result
        assert fake.calls == []

    def test_a_parameter_the_template_does_not_use_is_refused(self):
        with pytest.raises(mcp_handler.InvalidToolArgument):
            mcp_handler._validated_path_parameters("project_get", {"surprise": "value"})

    def test_autoseed_refuses_a_hostile_project_id_with_a_400(self):
        """Autoseed takes its id straight from the URL, so it needs the same guard.

        A 400 rather than a 403: the credential is fine and the path is not.
        """
        import json as _json

        # Minted through the production helper: parse_token requires the secret
        # half to be 64 lowercase HEX characters, so a hand-written 's' * 64
        # never reaches the token store and the route answers 401 instead of the
        # 400 under test.
        minted = mint_token()
        client = MagicMock()
        with patch("mcp_handler.projects_table") as table, \
             patch("shared.mcp_delegate.get_delegate_lambda_client", return_value=client), \
             patch.dict(os.environ, {"PROJECTS_FUNCTION": "p"}):
            table.query.return_value = {"Items": [{
                "pk": "MCPTOKEN", "sk": f"TOKEN#{minted.token_id}",
                "token_id": minted.token_id, "secret_hash": minted.secret_hash,
                "scopes": list(ALL_READ_SCOPES), "projects": [_PROJECT],
                "read_reach": REACH_WORKSPACE,
            }]}
            table.update_item.return_value = {}
            response = mcp_handler.lambda_handler({
                "httpMethod": "GET",
                "path": "/v1/mcp/autoseed/prioritization",
                "headers": {"authorization": f"Bearer {minted.raw}"},
            }, MagicMock())

        assert response["statusCode"] == 400, response["body"]
        assert _json.loads(response["body"])["message"]
        client.invoke.assert_not_called()


class TestDocumentKindLockstep:
    """`_document_kind` reads `sk`, so the route must keep returning it.

    Raised in review as the same trap the `feedback_id` bug fell into: the unit
    test supplies `sk` itself, so it cannot notice the route dropping it. If
    `GET /projects/{project_id}` ever projects its documents, every kind silently
    becomes `""` — and the outputSchema enum permits `""`, so nothing fails.

    Pinned against the real `projects.get_project`, not a fixture of it.
    """

    def test_the_project_route_returns_the_sort_key_on_documents(self):
        import projects as projects_module

        table = MagicMock()
        table.query.return_value = {"Items": [
            {"pk": "PROJECT#p1", "sk": "META", "name": "P"},
            {"pk": "PROJECT#p1", "sk": "PROTOTYPE#1", "document_id": "d1", "title": "T"},
        ]}
        with patch.object(projects_module, "projects_table", table):
            payload = projects_module.get_project("p1")

        documents = payload["documents"]
        assert documents, "the route returned no documents to check"
        assert "sk" in documents[0], (
            "projects.get_project no longer returns `sk` on documents, so "
            "_document_kind in mcp_handler will report '' for every document"
        )
        assert mcp_handler._document_kind(documents[0]) == "prototype"

    def test_a_document_without_a_sort_key_reports_no_kind_rather_than_guessing(self):
        assert mcp_handler._document_kind({"document_id": "d1"}) == ""
