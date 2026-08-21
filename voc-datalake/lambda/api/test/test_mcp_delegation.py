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

import hashlib
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


# Persona fixtures copied from the SHAPES OF LIVE ROWS, not invented.
#
# Two writers exist and they do not agree. `projects.py` generation follows
# `schemas/persona.schema.json`; `jobs/persona_importer` does not constrain the
# model, so imported rows carry keys this file cannot predict and sometimes a
# scalar where the schema says array. Both are represented here, because a
# fixture that only covered the tidy writer is exactly what hid the defect.
_GENERATED_PERSONA: dict = {
    "persona_id": "persona_20260802204425",
    "name": "Priya Shah",
    "tagline": "The Habitual Skimmer",
    "confidence": "high",
    "feedback_count": 42,
    "identity": {"age_range": "35-44", "occupation": "Solicitor", "location": "Leeds, UK"},
    "goals_motivations": {
        "primary_goal": "Stay informed in ten minutes",
        "secondary_goals": ["Follow local council news"],
    },
    "pain_points": {
        "current_challenges": ["Alerts bury the real news"],
        "blockers": ["Nothing blocking her today"],
        "workarounds": ["Curated her notification categories"],
        "emotional_impact": "Calm but quietly resigned",
    },
    "behaviors": {
        "current_solutions": ["Home-screen widget"],
        "tools_used": ["iOS app"],
        "tech_savviness": "medium-high",
        "decision_style": "Research-heavy at setup, habitual after",
    },
    "context_environment": {
        "usage_context": "First coffee of the day",
        "devices": ["iPhone", "iPad"],
        "time_constraints": "Ten minutes before the school run",
    },
    "scenario": {
        "title": "The morning catch-up",
        "narrative": "She opens the app while the kettle boils and wants the day in one screen.",
        "trigger": "A push notification she did not ask for",
        "outcome": "Knows what matters before she leaves the house",
    },
    # Avatar keys, source ids and notes are present on real rows and must be
    # dropped by the projection — asserted in test_storage_layout_is_not_exposed.
    "avatar_url": "s3://bucket/avatars/p.png",
    "source_feedback_ids": ["1ae1eb6abcd7d3a2e364f46139f98466"],
    "research_notes": [{"note_id": "n1", "text": "seen twice", "created_at": "t"}],
    "quotes": [{
        "text": "I just want the headlines.",
        "context": "onboarding",
        # The quote's own citation, which IS reported: it is the id
        # `get_feedback_detail` takes, unlike the row's `source_feedback_ids`.
        "source_feedback_id": "1ae1eb6abcd7d3a2e364f46139f98466",
    }],
}

# `imported_from` rows: unpredictable keys, and `workarounds` is a STRING here
# while it is a list above. Same key, two types, both live.
_IMPORTED_PERSONA: dict = {
    "persona_id": "persona_20260814135248",
    "name": "Priya Raman",
    "tagline": "Ops lead under audit pressure",
    "imported_from": "text",
    "identity": {"role": "Ops Lead", "industry": "Logistics", "company_size": "200-500"},
    "goals_motivations": {"primary_goal": "Close the audit", "motivations": ["Avoid fines"]},
    "pain_points": {"primary_frustration": "No audit trail", "related_issues": ["Manual exports"]},
    "behaviors": {"workarounds": "Keeps a private spreadsheet", "current_practices": "Weekly review"},
    "quotes": [{"text": "I cannot prove what changed."}],
}

# The thinnest live row: one key per section, no quotes, no confidence.
_SPARSE_PERSONA: dict = {
    "persona_id": "persona_20260815121940",
    "name": "Tobias Krenzler",
    "tagline": "Night-shift supervisor",
    "identity": {"location": "Hamburg"},
    "goals_motivations": {"primary_goal": "Finish the handover"},
    "pain_points": {"frustration": "Shift notes get lost"},
    "behaviors": {},
}

_LIVE_PERSONA_SHAPES: tuple[dict, ...] = (
    _GENERATED_PERSONA, _IMPORTED_PERSONA, _SPARSE_PERSONA,
)


def _tool_output_schema(name: str) -> dict:
    """The tool's OWN declared `outputSchema`, read from the live registry.

    Read rather than restated so the check cannot drift from what the server
    publishes — a copy in this file would keep passing after the schema changed.
    """
    for tool in mcp_handler.MCP_TOOLS:
        if tool["name"] == name:
            return tool["outputSchema"]
    raise AssertionError(f"no tool named {name}")


# The canonical persona declaration, read from the repo rather than restated, for
# the same reason as `_tool_output_schema` above.
_CANONICAL_PERSONA_SCHEMA = Path(__file__).resolve().parents[3] / "schemas" / "persona.schema.json"

# The one canonical section `list_personas` deliberately does not report, with the
# reason it does not. `research_notes` is researcher annotation added through
# `/personas/{id}/notes` after the fact — a human's working notes about the
# persona, not the persona — and it is asserted absent by
# `test_storage_layout_is_not_exposed`.
_UNREPORTED_SECTIONS = frozenset({"research_notes"})


def _canonical_persona_properties() -> dict:
    """The canonical persona declaration's `properties`, read from the schema file."""
    return json.loads(_CANONICAL_PERSONA_SCHEMA.read_text(encoding="utf-8"))["properties"]


def _canonical_persona_sections() -> dict[str, str]:
    """The canonical schema's own numbered sections, read from the schema file.

    Keyed off the `Section N:` marker the schema itself writes in each
    description, so this cannot drift from the file and a ninth section added
    there fails this suite instead of quietly never reaching a client — which is
    exactly how sections 5 and 7 went missing from the first version of the
    projection.
    """
    return {
        key: declared["description"]
        for key, declared in _canonical_persona_properties().items()
        if str(declared.get("description", "")).startswith("Section ")
    }


_JSON_TYPES: dict[str, type | tuple[type, ...]] = {
    "object": dict,
    "array": (list, tuple),
    "string": str,
    "integer": int,
    "number": (int, float),
    "boolean": bool,
}


def _schema_errors(value, schema: dict, path: str = "") -> list[str]:
    """Validate against the JSON Schema subset these tool schemas actually use.

    Deliberately NOT a general implementation, and deliberately not a new
    dependency: `jsonschema` is not installed in this suite, and a hand-rolled
    general validator is the kind of thing that passes for the wrong reason. This
    covers exactly `type`, `properties`, `items`, `required`, `enum` and
    `additionalProperties: false` — every construct present in `MCP_TOOLS` — and
    `test_the_schema_checker_itself_rejects_a_bad_payload` is its positive
    control.
    """
    declared = schema.get("type")
    expected = _JSON_TYPES.get(declared) if declared else None
    if expected is not None:
        # bool is a subclass of int in Python; an integer field must not accept it.
        if declared in ("integer", "number") and isinstance(value, bool):
            return [f"{path or '<root>'}: bool where {declared} declared"]
        if not isinstance(value, expected):
            return [f"{path or '<root>'}: {type(value).__name__} where {declared} declared"]

    if "enum" in schema and value not in schema["enum"]:
        return [f"{path or '<root>'}: {value!r} not in enum"]

    errors: list[str] = []
    if declared == "object" and isinstance(value, dict):
        properties = schema.get("properties", {})
        for key in schema.get("required", []):
            if key not in value:
                errors.append(f"{path}.{key}: required but absent")
        if schema.get("additionalProperties") is False:
            for key in value:
                if key not in properties:
                    errors.append(f"{path}.{key}: not declared (additionalProperties is false)")
        for key, inner in value.items():
            if key in properties:
                errors += _schema_errors(inner, properties[key], f"{path}.{key}")
    elif declared == "array" and isinstance(value, (list, tuple)) and "items" in schema:
        for i, entry in enumerate(value):
            errors += _schema_errors(entry, schema["items"], f"{path}[{i}]")
    return errors


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

    def test_every_reported_persona_section_carries_its_content(self):
        """The seven content sections of `schemas/persona.schema.json`.

        The fixture this replaced was `{"goals": ["g"], "pain_points": ["pp"],
        "behaviors": ["b"], "quote": "q"}` — flat string lists and a `quote`
        string. No writer has ever produced that, and believing it is precisely
        what made `list_personas` uncallable against real data while this test
        passed.

        One assertion per section, so a section that is declared but never
        populated fails here. The first version of this projection declared
        neither `context_environment` nor `scenario`, and a test that sampled
        only some sections is what let that pass.
        """
        fake = _FakeLambda({f"/projects/{_PROJECT}": {
            "project": {"name": "P"},
            "personas": [_GENERATED_PERSONA],
            "documents": [],
        }})
        payload = _call("list_personas", {"project_id": _PROJECT}, fake)["result"]["structuredContent"]

        assert payload["count"] == 1
        persona = payload["personas"][0]
        assert persona["tagline"] == "The Habitual Skimmer"
        assert persona["identity"]["age_range"] == "35-44"
        assert persona["goals_motivations"]["primary_goal"] == "Stay informed in ten minutes"
        assert persona["pain_points"]["current_challenges"] == ["Alerts bury the real news"]
        assert persona["behaviors"]["tech_savviness"] == "medium-high"
        assert persona["context_environment"]["usage_context"] == "First coffee of the day"
        assert persona["context_environment"]["devices"] == ["iPhone", "iPad"]
        assert persona["scenario"]["title"] == "The morning catch-up"
        assert persona["quotes"][0]["text"] == "I just want the headlines."
        assert persona["quotes"][0]["source_feedback_id"] == _FEEDBACK_ID

    def test_every_canonical_persona_section_is_reported_or_excluded(self):
        """The completeness claim, enforced against the schema instead of asserted.

        `context_environment` and `scenario` are persisted by BOTH writers and
        were declared by neither the tool's schema nor its projection, so a
        client could not reach them while the docstrings claimed the canonical
        shape. Prose cannot fail; this can. A ninth section added to
        `persona.schema.json` now fails here until it is either reported or
        listed as an exclusion with a reason.
        """
        sections = _canonical_persona_sections()
        # Anti-vacuity only: the schema's own title says eight sections, so a
        # marker that stopped matching must fail rather than pass with an empty
        # set. Deliberately `>=`, not `==` — a ninth section that IS correctly
        # reported has to fail on the reporting check below, with a message that
        # names it, rather than on a count that misdirects.
        assert len(sections) >= 8, f"expected at least 8 numbered sections, found {sorted(sections)}"

        declared = set(mcp_handler._PERSONA_PROPERTIES)
        missing = set(sections) - declared - _UNREPORTED_SECTIONS
        assert not missing, f"canonical sections neither reported nor excluded: {sorted(missing)}"

        # The exclusion list is not a dumping ground: every name in it must be a
        # section that really exists, and must really not be reported.
        assert _UNREPORTED_SECTIONS <= set(sections)
        assert not _UNREPORTED_SECTIONS & declared

    def test_a_quote_declares_every_field_the_canonical_schema_gives_it(self):
        """Section 6's own fields, checked against the schema for the same reason.

        An undeclared key still travels — the quote object is
        `additionalProperties: true` — so the cost of leaving one out is not lost
        data but a client that cannot rely on the citation being there.
        `source_feedback_id` is the id `get_feedback_detail` takes, which makes it
        the one worth relying on.
        """
        quote_fields = set(_canonical_persona_properties()["quotes"]["items"]["properties"])

        assert quote_fields, "the canonical quote item declares no fields; marker moved?"
        assert quote_fields <= set(mcp_handler._QUOTE_PROPERTIES), (
            f"canonical quote fields not declared: {sorted(quote_fields - set(mcp_handler._QUOTE_PROPERTIES))}"
        )

    def test_storage_layout_is_not_exposed(self):
        """Avatar keys, source ids and notes are dropped; the persona is the answer."""
        fake = _FakeLambda({f"/projects/{_PROJECT}": {
            "project": {"name": "P"}, "personas": [_GENERATED_PERSONA], "documents": [],
        }})
        result = _call("list_personas", {"project_id": _PROJECT}, fake)

        for leaked in ("avatar_url", "source_feedback_ids", "research_notes"):
            assert leaked not in json.dumps(result), f"{leaked} reached the client"

    @pytest.mark.parametrize(
        "persona", _LIVE_PERSONA_SHAPES, ids=["generated", "imported", "sparse"]
    )
    def test_every_live_persona_shape_satisfies_the_declared_output_schema(self, persona):
        """The gate that did not exist, and its absence is the whole defect.

        `list_personas` declared `pain_points`/`behaviors` as `array<string>`
        while every stored row holds an OBJECT. The declaration was published as
        a contract and never checked against real data, so 2 944 pytest cases,
        268 CDK cases and an 84/84 live curl battery all passed while a
        schema-validating client — the official MCP SDK, by default — rejected
        every call with `-32602`.

        Reverting the projection to `item.get('pain_points', [])` fails this,
        because a `.get` default fires only on an ABSENT key and cannot correct a
        value of the wrong TYPE.
        """
        fake = _FakeLambda({f"/projects/{_PROJECT}": {
            "project": {"name": "P"}, "personas": [persona], "documents": [],
        }})
        payload = _call("list_personas", {"project_id": _PROJECT}, fake)["result"]["structuredContent"]

        errors = _schema_errors(payload, _tool_output_schema("list_personas"))
        assert errors == [], f"payload violates its own outputSchema: {errors}"

    def test_an_undeclared_key_keeps_its_own_type(self):
        """Live shape: the imported row files `workarounds` under `behaviors`.

        `workarounds` is a declared array under `pain_points` and undeclared under
        `behaviors`, so here it is neither coerced nor dropped — it is preserved
        as the string it is, which `additionalProperties: true` permits. Coercing
        by key NAME regardless of section would fail this and would also make the
        answer claim a structure the row does not have.
        """
        fake = _FakeLambda({f"/projects/{_PROJECT}": {
            "project": {"name": "P"}, "personas": [_IMPORTED_PERSONA], "documents": [],
        }})
        payload = _call("list_personas", {"project_id": _PROJECT}, fake)["result"]["structuredContent"]

        assert payload["personas"][0]["behaviors"]["workarounds"] == "Keeps a private spreadsheet"

    def test_a_scalar_in_a_DECLARED_array_slot_is_coerced(self):
        """Defensive, and the reason is a trust boundary, not a known bad row.

        No live row currently holds a scalar in a declared array slot, but every
        one of these values is LLM-authored and the live rows already prove the
        shape varies per writer. A scalar arriving in `secondary_goals` would
        reproduce M1 exactly — a payload contradicting its own schema — so the
        boundary coerces. Deleting the list branch of `_as_string_list` fails this
        AND the conformance test above.
        """
        persona = {
            **_SPARSE_PERSONA,
            "goals_motivations": {"primary_goal": "Ship", "secondary_goals": "Only one"},
            "pain_points": {"current_challenges": "Just the one"},
        }
        fake = _FakeLambda({f"/projects/{_PROJECT}": {
            "project": {"name": "P"}, "personas": [persona], "documents": [],
        }})
        payload = _call("list_personas", {"project_id": _PROJECT}, fake)["result"]["structuredContent"]

        projected = payload["personas"][0]
        assert projected["goals_motivations"]["secondary_goals"] == ["Only one"]
        assert projected["pain_points"]["current_challenges"] == ["Just the one"]
        assert _schema_errors(payload, _tool_output_schema("list_personas")) == []

    def test_a_list_in_a_DECLARED_STRING_slot_is_coerced(self):
        """The mirror image, and the hole the first version of this fix left.

        Coercing only the declared ARRAYS meant a list arriving in a declared
        string — `emotional_impact`, `primary_goal`, or top-level `confidence` —
        reproduced M1 exactly: a payload contradicting its own `outputSchema`.
        Every one of these values is LLM-authored, so the boundary coerces
        whatever type it declared, not the subset that happened to be listed.
        """
        persona = {
            **_SPARSE_PERSONA,
            "confidence": ["high"],
            "feedback_count": "42",
            "pain_points": {"emotional_impact": ["Tired", "Resigned"]},
            "scenario": {"narrative": {"step": "Opens the app"}},
        }
        fake = _FakeLambda({f"/projects/{_PROJECT}": {
            "project": {"name": "P"}, "personas": [persona], "documents": [],
        }})
        payload = _call("list_personas", {"project_id": _PROJECT}, fake)["result"]["structuredContent"]

        projected = payload["personas"][0]
        assert projected["confidence"] == "high"
        assert projected["feedback_count"] == 42
        assert projected["pain_points"]["emotional_impact"] == "Tired; Resigned"
        # A dict in a string slot is JSON, not a Python repr: the reader is a
        # model, and `{'step': 'Opens the app'}` is not machine-readable.
        assert projected["scenario"]["narrative"] == '{"step": "Opens the app"}'
        assert _schema_errors(payload, _tool_output_schema("list_personas")) == []

    def test_a_quote_stored_as_a_bare_string_still_reaches_the_client(self):
        """`quotes` entries were filtered by `isinstance(q, dict)`.

        That answered "this persona has no quotes" about a persona who had them.
        The shape is not hypothetical: the import path's own test fixture models
        the model returning `quotes: ["I spend too much time in meetings"]`, and
        until this change nothing pinned the schema it was asked for.
        """
        persona = {**_SPARSE_PERSONA, "quotes": ["I cannot prove what changed.", ""]}
        fake = _FakeLambda({f"/projects/{_PROJECT}": {
            "project": {"name": "P"}, "personas": [persona], "documents": [],
        }})
        payload = _call("list_personas", {"project_id": _PROJECT}, fake)["result"]["structuredContent"]

        quotes = payload["personas"][0]["quotes"]
        # The empty entry carried no content, so it is not reported as a quote.
        assert quotes == [{"text": "I cannot prove what changed."}]
        assert _schema_errors(payload, _tool_output_schema("list_personas")) == []

    def test_a_section_that_cannot_be_reported_is_logged_not_swallowed(self):
        """An absent section is normal; a section of the wrong shape is not.

        No writer produces a non-object section and all five live rows are
        objects, so there is nothing to salvage and guessing a destination key
        would file content under a misleading heading. Dropping it silently is
        still the wrong half of that: the operator gets a warning, and the
        persona's own text is never logged because it is customer-derived.
        """
        persona = {**_SPARSE_PERSONA, "behaviors": ["Checks the app twice a day"]}
        fake = _FakeLambda({f"/projects/{_PROJECT}": {
            "project": {"name": "P"}, "personas": [persona], "documents": [],
        }})
        with patch.object(mcp_handler.logger, "warning") as warned:
            payload = _call("list_personas", {"project_id": _PROJECT}, fake)["result"]["structuredContent"]

        assert payload["personas"][0]["behaviors"] == {}
        assert warned.call_count == 1
        logged = json.dumps(warned.call_args.kwargs.get("extra", {}))
        assert "behaviors" in logged
        assert "Checks the app twice a day" not in logged

    def test_every_declared_persona_type_has_a_coercion(self):
        """A declared type with no coercion is M1 waiting to happen again.

        The projection coerces by DECLARED TYPE, so adding a `boolean` or
        `number` field to the persona schema without teaching `_COERCIONS` about
        it would publish a type the boundary does not enforce. This is the
        structural version of the finding that `confidence` went uncoerced while
        `feedback_count` was guarded.
        """
        declared = set(mcp_handler._PERSONA_SCALAR_TYPES.values())
        declared |= set(mcp_handler._QUOTE_TYPES.values())
        for section in mcp_handler._PERSONA_SECTION_TYPES.values():
            declared |= set(section.values())

        uncoerced = declared - set(mcp_handler._COERCIONS)
        assert not uncoerced, f"declared but never coerced: {sorted(uncoerced)}"

        # The array coercion produces a list of STRINGS, so a declared array of
        # objects would be flattened into JSON strings — the same contradiction
        # one level down. `quotes` is the only array of objects and it has its own
        # projection, so every array declared INSIDE a section must be strings.
        for section, properties in mcp_handler._PERSONA_SECTIONS.items():
            for key, declared_property in properties.items():
                if declared_property.get("type") == "array":
                    assert declared_property.get("items") == {"type": "string"}, (
                        f"{section}.{key} declares array items that "
                        "_as_string_list would flatten into strings"
                    )

    def test_the_project_summary_coerces_the_persona_fields_it_declares(self):
        """`get_project` reads the same LLM-authored rows and declares strings.

        It is the tool that WAS callable, so this is the live half of the same
        defect: `tagline` is new to this summary and comes from the writer that
        pinned nothing, and `p.get('tagline', '')` cannot correct a list.
        """
        persona = {**_SPARSE_PERSONA, "tagline": ["Night-shift", "supervisor"]}
        fake = _FakeLambda({f"/projects/{_PROJECT}": {
            "project": {"name": "P"}, "personas": [persona], "documents": [],
        }})
        payload = _call("get_project", {"project_id": _PROJECT}, fake)["result"]["structuredContent"]

        assert payload["personas"][0]["tagline"] == "Night-shift; supervisor"
        assert _schema_errors(payload, _tool_output_schema("get_project")) == []

    def test_an_absent_section_is_not_logged(self):
        """The positive control for the warning above.

        Most live rows omit some sections entirely — the sparse row omits three —
        so warning on absence would make the log useless and the previous test
        would pass for the wrong reason.
        """
        fake = _FakeLambda({f"/projects/{_PROJECT}": {
            "project": {"name": "P"}, "personas": [_SPARSE_PERSONA], "documents": [],
        }})
        with patch.object(mcp_handler.logger, "warning") as warned:
            _call("list_personas", {"project_id": _PROJECT}, fake)

        assert warned.call_count == 0

    def test_unpredicted_section_keys_are_preserved(self):
        """An imported persona's pain points live under keys this file never chose.

        Dropping them would answer "this persona has no pain points" about a
        persona whose pain points are simply filed elsewhere — the same silent
        under-report the surface is being fixed for. Restricting the projection to
        the declared keys fails this.
        """
        fake = _FakeLambda({f"/projects/{_PROJECT}": {
            "project": {"name": "P"}, "personas": [_IMPORTED_PERSONA], "documents": [],
        }})
        payload = _call("list_personas", {"project_id": _PROJECT}, fake)["result"]["structuredContent"]

        pains = payload["personas"][0]["pain_points"]
        assert pains["primary_frustration"] == "No audit trail"
        assert pains["related_issues"] == ["Manual exports"]

    def test_the_schema_checker_itself_rejects_a_bad_payload(self):
        """Positive control. A conformance test that cannot fail proves nothing.

        Every violation the real defect produced must be caught: a dict where an
        array is declared, a scalar where an array is declared, a string where an
        integer is declared, and an undeclared top-level key.
        """
        schema = _tool_output_schema("list_personas")
        good = {"count": 1, "personas": [{
            "persona_id": "p", "name": "n", "tagline": "t", "confidence": "high",
            "feedback_count": 1, "identity": {}, "goals_motivations": {},
            "pain_points": {}, "behaviors": {}, "quotes": [],
        }]}
        assert _schema_errors(good, schema) == []

        def broken(**changes):
            persona = {**good["personas"][0], **changes}
            return {"count": 1, "personas": [persona]}

        # The exact shape of the live defect: an object where array was declared.
        assert _schema_errors(
            broken(pain_points={"current_challenges": {"a": 1}}), schema)
        assert _schema_errors(broken(feedback_count="42"), schema)
        assert _schema_errors(broken(tagline=["not", "a", "string"]), schema)
        # A list in a declared STRING slot, nested and top-level: the violation the
        # scalar coercion prevents. Without these two the checker would pass a
        # payload the string coercion is the only thing stopping.
        assert _schema_errors(broken(confidence=["high"]), schema)
        assert _schema_errors(
            broken(pain_points={"emotional_impact": ["tired", "resigned"]}), schema)
        assert _schema_errors(broken(journey_stage="undeclared"), schema)
        assert _schema_errors({"count": "1", "personas": []}, schema)

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

    def test_a_changed_published_tool_shape_moves_the_server_version(self):
        """`serverInfo.version` is the only signal a client gets, so it is pinned
        to the shapes it describes.

        The check above (`major >= 2`) passes forever, which means it would have
        let #356's own persona-shape change ship under the version that described
        the previous one. Fingerprinting the PUBLISHED tool declarations in
        lockstep makes any edit to a published shape fail here until the version
        is reconsidered — the repo's lockstep pattern, applied to the one contract
        that leaves the account.

        The fingerprint covers the WHOLE published entry, not just `outputSchema`,
        and that widening is deliberate: a client caches `tools/list` at connect,
        so its `inputSchema`, its `annotations` and its `_meta` are as much of the
        cached contract as the output shape is. Fingerprinting only the output half
        let the envelope change (annotations, cost classes) move what clients cache
        without moving the number that tells them to re-fetch it.

        OBJECT key order does not count (`sort_keys`), so reformatting a
        declaration is free. LIST order does count, and `required` and `enum` are
        lists: reordering their entries is semantically identical but will move
        the fingerprint, so treat such a failure as a prompt to restore the order
        rather than to bump the version.
        """
        shapes = {}
        for tool in mcp_handler.MCP_TOOLS:
            # Named rather than a KeyError from inside the fingerprint: presence is
            # `test_every_tool_declares_an_output_schema`'s claim, and this test
            # should say which tool broke it, not where it noticed.
            assert "outputSchema" in tool, f"{tool['name']} declares no output shape"
            shapes[tool["name"]] = tool

        serialized = json.dumps(shapes, sort_keys=True)
        fingerprint = hashlib.sha256(serialized.encode("utf-8")).hexdigest()[:16]

        assert (mcp_handler.MCP_SERVER_VERSION, fingerprint) == ("3.7.0", "941e33f48bcca829"), (
            "a tool's published declaration changed. Move MCP_SERVER_VERSION — minor "
            "for an added field, MAJOR for a removal or a retype, because a client "
            "validates structuredContent against these schemas and caches the whole "
            "declaration at connect — then update the fingerprint here in the same "
            "commit."
        )


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

        ⚠️ Single-file by design, and only sound while these handlers register
        every route inline. Powertools also supports `Router` objects in other
        modules included into an app; a route registered that way would be
        invisible here and the reserved set would be quietly incomplete. Neither
        handler does that today, and it is asserted rather than assumed — see
        `test_no_route_is_registered_outside_the_scanned_file`.
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

    def test_autoseed_reports_a_missing_declaration_as_a_server_fault(self):
        """The autoseed path answers 502, not 400, for a misconfiguration.

        `_domain_call` can raise EITHER kind — `InvalidToolArgument` for a
        malformed path parameter, `DelegationUnavailable` for a missing
        reserved-segment declaration — so both are caught around the same step. A
        `try` that caught only the first let the second escape to the outer
        catch-all and answer something other than the 502 this route establishes.
        Unreachable in a deployed build; asserted so the two paths cannot diverge.
        """
        minted = mint_token()
        client = MagicMock()
        future = {"project_autoseed": (mcp_handler.DOMAIN_PROJECTS, "GET",
                                       "/whatever/{project_id}/autoseed")}
        with patch("mcp_handler.projects_table") as table, \
             patch("shared.mcp_delegate.get_delegate_lambda_client", return_value=client), \
             patch.dict(mcp_handler.DOMAIN_ROUTES, future), \
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
                "path": f"/v1/mcp/autoseed/{_PROJECT}",
                "headers": {"authorization": f"Bearer {minted.raw}"},
            }, MagicMock())

        assert response["statusCode"] == 502, response["body"]
        client.invoke.assert_not_called()

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


# ===========================================================================
# The feedback projection's declared types — the M1 class, second instance
# ===========================================================================

_DETAIL_ROUTE = "/feedback/1ae1eb6abcd7d3a2e364f46139f98466"
_DETAIL_ARGS = {"feedback_id": "1ae1eb6abcd7d3a2e364f46139f98466"}


def _detail(row: dict) -> dict:
    fake = _FakeLambda({_DETAIL_ROUTE: row})
    return _call("get_feedback_detail", _DETAIL_ARGS, fake)["result"]["structuredContent"]


def _summary(row: dict) -> dict:
    fake = _FakeLambda({"/feedback/search": {"items": [row]}})
    return _call("search_feedback", {"query": "late"}, fake)["result"]["structuredContent"]["items"][0]


class TestFeedbackDeclaredTypes:
    """`_project_feedback` read every field with `item.get(key, default)`.

    A default fires only when a key is ABSENT — it cannot correct a value of the
    WRONG TYPE. That is precisely the defect that made `list_personas` uncallable
    (M1), living a second time in the feedback projection, and #356's PR body
    named it as the owed follow-on.
    """

    def test_a_dict_where_a_string_is_declared_does_not_kill_the_tool(self):
        """The sharp end: `date` and `text` are SLICED, so a wrong type RAISED.

        A list answer clips `date[:10]` and `text[:_SUMMARY_TEXT_LIMIT]`. Read
        with `item.get(key, '') or ''`, a dict or a number passes straight
        through and the slice then raises `TypeError` — which is not one bad
        field in one entry, it is the whole `search_feedback` call failing on
        account of a single malformed row. Coercing first makes both slices safe
        by construction. Reverting the coercion fails this test.
        """
        item = _summary(_feedback_row(source_created_at={"S": "2026-08-01"}, original_text=12345))

        assert isinstance(item["date"], str), "a dict in a declared-string field must not survive"
        assert isinstance(item["text"], str)
        assert item["text"] == "12345"

    def test_a_number_in_a_declared_string_field_is_stringified(self):
        item = _detail(_feedback_row(category=7, problem_summary=42))

        assert item["category"] == "7"
        assert item["problem_summary"] == "42"

    def test_a_bare_string_in_the_declared_keywords_array_becomes_a_list(self):
        """`keywords` is the one declared array, and a writer may leave it flat."""
        item = _detail(_feedback_row(keywords="late"))

        assert item["keywords"] == ["late"]

    def test_a_zero_rating_reports_as_zero_rather_than_as_unrated(self):
        """Presence, not truthiness: 0 is a rating a customer actually gave.

        `_row_value` tests `is not None and != ''` for exactly this reason. A
        truthiness test here would report a zero rating as `'N/A'`.
        """
        assert _detail(_feedback_row(rating=0))["rating"] == "0"

    def test_a_stored_null_rating_reads_as_not_applicable(self):
        """`str(None)` used to put the literal `'None'` in front of a model.

        DynamoDB stores nulls, so this is a live shape, and `'None'` reads as a
        value rather than as an absence.
        """
        assert _detail(_feedback_row(rating=None))["rating"] == "N/A"

    def test_a_row_of_entirely_wrong_types_still_conforms_to_its_own_schema(self):
        """The M1 assertion, applied to feedback: no payload may contradict its
        own declaration, whatever the row holds."""
        hostile = _feedback_row(
            source_platform=["webscraper"], source_created_at={"S": "x"},
            sentiment_label=None, sentiment_score={"N": "-0.8"}, category=7,
            urgency=["high"], persona_type={"a": "b"}, original_text=12345,
            problem_summary=[1, 2], journey_stage=9,
            problem_root_cause_hypothesis={"k": "v"}, direct_customer_quote=3.5,
            keywords="late",
        )
        payload = _detail(hostile)

        errors = _schema_errors(payload, _tool_output_schema("get_feedback_detail"))
        assert errors == [], f"payload violates its own outputSchema: {errors}"

    def test_source_key_map_covers_every_declared_field(self):
        """A declared property with no entry in the map reads the row key of its
        own name — a silent wrong-key read, which is the same silent
        under-report class. The runtime fallback keeps it from being a dead tool;
        this test is what keeps it from being invisible.
        """
        detail = set(mcp_handler._FEEDBACK_DETAIL_TYPES)
        summary = set(mcp_handler._FEEDBACK_SUMMARY_TYPES)
        mapped = set(mcp_handler._FEEDBACK_SOURCE_KEYS)

        assert detail - mapped == set(), "declared but unmapped: reads its own name"
        assert mapped - detail == set(), "mapped but undeclared: dead entry"
        # BOTH declaration sets, asserted separately. Detail is built as
        # `{**summary, ...}` so it is a superset today and covering it covers
        # summary — but that is an implementation detail of one dict literal, and
        # if it ever stops holding, a summary-only property would fall through to
        # the `.get(key, (key,))` self-name read with nothing failing. The
        # superset relation is asserted too, so the redundancy is visible rather
        # than accidental.
        assert summary <= detail, "detail is expected to extend summary"
        assert summary - mapped == set(), "summary-only declaration would read its own name"


class TestSearchQueryMinimumIsDeclared:
    """M2: the tool's description promised a minimum its schema did not declare.

    The sentence "Must be at least 2 characters" has always been in the tool
    description, so a model reading the catalogue was told the rule — while the
    `inputSchema` accepted `"a"`, the route answered it with `{'count': 0}`, and
    nothing anywhere failed. A prose promise cannot fail CI.
    """

    @staticmethod
    def _query_schema() -> dict:
        """The tool's OWN declared `query` argument, read from the live registry
        for the same reason `_tool_output_schema` is."""
        for tool in mcp_handler.MCP_TOOLS:
            if tool["name"] == "search_feedback":
                return tool["inputSchema"]["properties"]["query"]
        raise AssertionError("no search_feedback tool")

    def test_the_query_argument_declares_the_minimum_the_route_enforces(self):
        """Lockstep: one constant, read by the schema and by the route.

        Read from `shared.api` rather than restated as `2`, so a change to the
        bound cannot leave the declaration behind.
        """
        from shared.api import SEARCH_QUERY_MIN_LENGTH

        assert self._query_schema()["minLength"] == SEARCH_QUERY_MIN_LENGTH

    def test_the_description_states_the_same_minimum_it_declares(self):
        """The prose and the constraint are generated from one value, so this
        pins that they cannot disagree again."""
        schema = self._query_schema()

        assert f"at least {schema['minLength']} characters" in schema["description"]

    def test_a_short_query_reaches_the_model_as_an_error_not_as_no_matches(self):
        """The harm, end to end.

        A non-validating client can still send `"a"`. The route refuses, and the
        adapter must surface that refusal as an MCP error carrying the route's
        own message — NOT as a successful `count: 0`, which a model reports as
        "no customer mentioned that". The body shape is the one
        `shared.exceptions.ValidationError` actually produces.
        """
        fake = _FakeLambda(
            {"/feedback/search": {
                "success": False,
                "error": "Search query must be at least 2 characters after trimming; received 1.",
            }},
            status=400,
        )

        result = _call("search_feedback", {"query": "a"}, fake)["result"]

        assert result["isError"] is True, "a refused search must not read as empty"
        assert "at least 2 characters" in result["content"][0]["text"]
        assert "structuredContent" not in result, "a refusal carries no count to misread"


class TestSearchReportsItsTruncation:
    """M5: the tool most likely to truncate was the only one hiding it.

    `get_metrics_breakdown` has always published `is_partial`. `search_feedback`
    collected the same flag from the route and discarded it (`candidates, _ =`),
    so a caller could not tell "nothing in your window matches" from "the scan
    stopped before it reached the end of your window".
    """

    def test_a_truncated_search_reports_is_partial(self):
        fake = _FakeLambda({"/feedback/search": {
            "items": [_feedback_row()], "is_partial_window": True,
        }})

        payload = _call("search_feedback", {"query": "late"}, fake)["result"]["structuredContent"]

        assert payload["is_partial"] is True

    def test_a_complete_search_reports_is_partial_false(self):
        fake = _FakeLambda({"/feedback/search": {
            "items": [_feedback_row()], "is_partial_window": False,
        }})

        payload = _call("search_feedback", {"query": "late"}, fake)["result"]["structuredContent"]

        assert payload["is_partial"] is False

    def test_the_filter_only_branch_reports_it_too(self):
        """`/feedback` publishes the same flag under the same name, so the
        no-query branch is covered by the same read."""
        fake = _FakeLambda({"/feedback": {
            "items": [_feedback_row()], "is_partial_window": True,
        }})

        payload = _call("search_feedback", {"days": 7}, fake)["result"]["structuredContent"]

        assert payload["is_partial"] is True

    def test_a_route_that_omits_the_flag_reports_false_rather_than_null(self):
        """The declaration says boolean and it is REQUIRED, so a missing flag has
        to become `False` — a `null` here would reproduce M1 inside the field
        added to fix M5."""
        fake = _FakeLambda({"/feedback/search": {"items": [_feedback_row()]}})

        payload = _call("search_feedback", {"query": "late"}, fake)["result"]["structuredContent"]

        assert payload["is_partial"] is False
        assert _schema_errors(payload, _tool_output_schema("search_feedback")) == []

    def test_the_flag_is_declared_required_so_absence_cannot_read_as_complete(self):
        schema = _tool_output_schema("search_feedback")

        assert "is_partial" in schema["required"]
        assert schema["properties"]["is_partial"]["type"] == "boolean"


class TestMetricsToolsDeclareTheFlagTheyPassThrough:
    """M4: the metrics routes now MEASURE window completeness on their aggregates
    path instead of reporting a hardcoded `False`, and these tools forward the
    route body unprojected — so the flag arrives whether or not it is declared.

    Declaring it is what makes it READABLE. `additionalProperties` is absent
    (not `false`) from these two output shapes, so an undeclared `is_partial`
    validates and is then invisible to a model reading the catalogue to decide
    what the answer contains: a truncated total presented as authoritative, which
    is the defect itself.

    Deleting either declaration below fails these tests; nothing else in the
    suite notices, because a pass-through tool cannot fail on a field it does not
    reshape.
    """

    @pytest.mark.parametrize("tool", ["get_metrics_summary", "get_metrics_breakdown"])
    def test_the_flag_is_declared_on_both_metrics_tools(self, tool):
        declared = _tool_output_schema(tool)["properties"]

        assert "is_partial" in declared, f"{tool} forwards is_partial without declaring it"
        assert declared["is_partial"]["type"] == "boolean"

    @pytest.mark.parametrize("tool", ["get_metrics_summary", "get_metrics_breakdown"])
    def test_the_description_names_both_reasons_a_window_can_be_short(self, tool):
        """The two causes are independent, so a description naming one teaches a
        reader that the other cannot happen. This is prose a model reasons about,
        not a comment."""
        description = _tool_output_schema(tool)["properties"]["is_partial"]["description"]

        assert "stopped short" in description, description
        assert "retained" in description, description
        assert "lower bound" in description, description

    @pytest.mark.parametrize("tool,route", [
        ("get_metrics_summary", "/metrics/summary"),
        ("get_metrics_breakdown", "/metrics/categories"),
    ])
    def test_a_partial_route_answer_reaches_the_client_intact(self, tool, route):
        args = {"dimension": "categories"} if tool == "get_metrics_breakdown" else {}
        fake = _FakeLambda({route: {"period_days": 365, "is_partial": True,
                                    "total_feedback": 99, "categories": {"delivery": 99}}})

        payload = _call(tool, args, fake)["result"]["structuredContent"]

        assert payload["is_partial"] is True
        assert _schema_errors(payload, _tool_output_schema(tool)) == []

    @pytest.mark.parametrize("tool,route", [
        ("get_metrics_summary", "/metrics/summary"),
        ("get_metrics_breakdown", "/metrics/categories"),
    ])
    def test_a_complete_route_answer_is_not_reported_partial(self, tool, route):
        """The positive control: a flag that is always true says nothing."""
        args = {"dimension": "categories"} if tool == "get_metrics_breakdown" else {}
        fake = _FakeLambda({route: {"period_days": 7, "is_partial": False,
                                    "total_feedback": 6239, "categories": {"delivery": 12}}})

        payload = _call(tool, args, fake)["result"]["structuredContent"]

        assert payload["is_partial"] is False
