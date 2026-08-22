"""Every published tool's `outputSchema` checked against a real payload shape.

Plan §10 Phase 3 adds roughly thirty delegated tools, each declaring an
`outputSchema` with `additionalProperties: false`. Until this file, NOTHING
compared a declaration against the shape the delegated route actually returns,
and the cost of that gap is on record as finding M1 of
`analysis/BUG-mcp-tool-truthfulness-GITHUB-ISSUE.md`: `list_personas` declared
`pain_points` and `behaviors` as `array` while live rows held nested objects, so
a validating client — the official MCP SDK, by default — rejected the whole
response with `-32602`. The tool was UNCALLABLE in production while every test
passed. #356 fixed that tool; this file closes the class.

What makes it a guard rather than a test of six tools:

  • the tool list is READ from `mcp_handler.MCP_TOOLS`, so a Phase 3 tool is
    covered the moment it is published, without anyone remembering this file;
  • a tool with NO registered sample FAILS. It does not skip. The tool most
    likely to be wrong is the one nobody wrote a sample for, so an opt-out would
    make the whole file decorative;
  • the payload is not a dict written to match the schema — it is what the tool
    ITSELF produces from a route body taken from the delegation suite's stubs.
    Writing the schema out twice would prove only that it can be copied.

⚠️ This file REPORTS mismatches, it does not fix them. A declaration that
disagrees with a real payload surfaces as a FAILING parametrised case and is
fixed in a separate follow-up; changing a schema in the same commit would make
the guard's own correctness unfalsifiable, because a reviewer could not tell
whether it passes because it works or because the declaration was bent to fit
it. If a fix genuinely has to be deferred, the marker is
`pytest.mark.xfail(strict=True, reason=...)` naming the field and the tracking
issue — strict, so the day the declaration is corrected this file says so
instead of silently keeping a stale exemption. There is no such marker today: no
published tool mismatches its declaration.

REVERT STORY — which mutation makes which assertion fail:

  test_every_published_tool_has_a_registered_sample_payload
    — the load-bearing one. Delete a tool's entry from `_TOOL_SAMPLES` and this
      fails, naming it. Turn it into a `pytest.skip` and it passes for a tool
      whose declaration nobody has ever validated, which is the state this file
      exists to end. Its own positive control is
      test_the_completeness_check_notices_a_tool_with_no_sample: the check is a
      function, called with a registry missing an entry, so "the check cannot
      detect anything" is itself a failure.

  test_a_real_payload_validates_against_its_declared_output_schema
    — the guard proper. Verified non-vacuous two ways rather than by inspection:
      test_breaking_a_declared_type_in_a_copy_of_a_schema_rejects_a_real_payload
      mutates a COPY of a schema and asserts the same sample stops validating,
      and the negative controls below reject payloads a partial validator would
      wave through.

  test_an_undeclared_key_is_rejected_where_the_schema_closes_the_door
    — proves the validator RUNS and that `additionalProperties: false` means
      what it says. Drop it and a hand-rolled validator ignoring
      `additionalProperties` would pass exactly the declarations that are wrong
      — the reason this file takes a `jsonschema` dependency instead of
      recursing over `properties` itself.

  test_an_undeclared_key_inside_an_array_item_is_rejected
    — the same closure one level DOWN, where M1 lived. The top-level control
      cannot reach it, because merging a key into the payload root never touches
      an element of `items`. Its anti-vacuity control is
      test_some_array_closes_its_item_schema, and its positive counterpart is
      test_an_unrecognised_key_on_a_route_row_is_not_forwarded, which pins the
      projection behaviour that keeps the shape unreachable from a route.

  test_a_nested_object_where_an_array_is_declared_is_rejected
    — M1's exact shape, in the two places a live writer can still produce it.
      Drop it and a validator that never descends into `items` reads as green.
      Every negative control here asserts the unmutated payload validates FIRST
      and then matches the error's PATH (`_rejects_at`), not the message prose:
      a substring matcher on prose is satisfied by an unrelated field failing,
      and a control with no "valid first" assertion goes green the day its sample
      stops conforming for a reason it was never about. `_rejects_at` therefore
      has its own positive control,
      test_the_path_matcher_distinguishes_one_field_from_another — rewrite it to
      `return True` and every other control here still passes, because none of
      them ever asks it to say no.

  test_every_tool_declares_what_section_5_4_requires
    — `outputSchema`, `annotations` (the four hints plus a title) and a cost
      class under `_meta`. #360 already ships all three, so this passes on
      arrival by design: it is here so a Phase 3 tool cannot land without them.

WHERE THE SAMPLES CAME FROM. Each entry below names its provenance. None was
invented to fit a schema; where a field's real shape is uncertain the MESSIER
variant is preferred, because the nested-object case is what broke M1 and the
tidy one is what hid it. `_TOOL_SAMPLES` states the ranked convention a Phase 3
author should follow when a route has no fixture yet.
"""

import copy
import sys
from pathlib import Path

import pytest

# 🔑 A hard failure, NOT `pytest.importorskip`. `jsonschema` is pinned in
# `requirements-dev.txt` and installed by the venv recipe in
# `docs/deployment.md`, which is where `npm run test:backend` gets its
# interpreter. An `importorskip` would skip this whole file whenever the pin is
# missing and report a successful run that validated nothing — precisely the
# "green suite, uncallable tool" state M1 lived in. So the import stays fatal.
#
# Re-raised only to NAME the fix: a bare ModuleNotFoundError in a venv created
# before this pin reads as a broken checkout, and the failure a developer sees
# should say which file to install. It stays a collection error either way.
try:
    from jsonschema import Draft202012Validator
except ModuleNotFoundError as exc:  # pragma: no cover - environment, not logic
    raise ModuleNotFoundError(
        "jsonschema is required by this MCP outputSchema conformance suite and is "
        "pinned in voc-datalake/requirements-dev.txt. A virtualenv created before "
        "that pin will not have it: re-run "
        "`.venv/bin/pip install -r requirements-dev.txt`. This suite is NOT "
        "skippable — skipping it would report a passing run that validated no "
        "tool declaration at all."
    ) from exc

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import mcp_handler

# The delegation suite's stubs and row fixtures, imported rather than copied.
#
# Copying them is the one thing this file must not do: a fixture that drifts from
# the shapes the routes really produce is how M1 survived a full green suite, and
# two copies drift by construction.
#
# 🔑 Imported by PACKAGE PATH, not as a bare `test_mcp_delegation`. Both resolve —
# `conftest.py` puts `lambda/` and this directory on `sys.path` — but they do not
# resolve to the same object. `lambda/api/test/__init__.py` exists, so pytest
# imports the delegation suite as `api.test.test_mcp_delegation`; a bare import
# executes its module body a SECOND time under a second name, leaving two sets of
# fixture objects for the same source file. That is the "two copies drift by
# construction" failure this import exists to avoid, arriving through the import
# system instead of through a copy-paste. `sys.modules` proves it: with the bare
# form, `[n for n in sys.modules if "mcp_delegation" in n]` has two entries.
#
# `_FakeLambda` is the ground truth that matters most here: it replays a canned
# ROUTE BODY, so the payload this file validates is the tool's own output for a
# realistic route answer, not a dict transcribed from the declaration.
from api.test.test_mcp_delegation import (
    _GENERATED_PERSONA,
    _IMPORTED_PERSONA,
    _PROJECT,
    _SPARSE_PERSONA,
    _call,
    _FakeLambda,
    _feedback_row,
)

# `search_feedback`'s text-search branch; the filter-only branch answers from
# `/feedback`. Both are exercised below because they are different route bodies.
_SEARCH_ROUTE = "/feedback/search"
_LIST_ROUTE = "/feedback"
_FEEDBACK_ID = "1ae1eb6abcd7d3a2e364f46139f98466"
_DETAIL_ROUTE = f"/feedback/{_FEEDBACK_ID}"
_PROJECT_ROUTE = f"/projects/{_PROJECT}"


@pytest.fixture(autouse=True)
def _functions_configured(monkeypatch):
    """Both delegation targets named, as the stack supplies them.

    Declared here rather than imported: an autouse fixture applies to the module
    that DEFINES it, so importing the delegation suite's copy would give this
    file the stub bodies and none of the environment they need.
    """
    monkeypatch.setenv("METRICS_FUNCTION", "voc-metrics-api")
    monkeypatch.setenv("PROJECTS_FUNCTION", "voc-projects-api")


# ---------------------------------------------------------------------------
# Route bodies, per delegated route
# ---------------------------------------------------------------------------
#
# Each of these is the shape the route that owns the data actually returns. The
# provenance is on every one, because "a representative payload" is only worth
# something if someone can check where it came from.

# A raw feedback row as the processor writes it, from the delegation suite's
# `_feedback_row()` — real-shaped id, `source_platform` / `original_text` /
# `sentiment_label` under their storage names, `rating` as a number, a 900-char
# verbatim so the summary truncation is exercised.
_FEEDBACK_ROW = _feedback_row()

# The SAME row with every field replaced by the wrong type. Copied from
# `test_mcp_delegation.py::TestFeedbackDeclaredTypes` — a row of DynamoDB
# attribute-value dicts, lists in string slots, a `None`, a float — and kept
# because M1 was a wrong TYPE reaching a client, not a missing key. If the
# projection ever stops coercing, THIS is the sample that catches it.
_HOSTILE_FEEDBACK_ROW = _feedback_row(
    source_platform=["webscraper"],
    source_created_at={"S": "2026-08-01T10:11:12Z"},
    sentiment_label=None,
    sentiment_score={"N": "-0.8"},
    category=7,
    urgency=["high"],
    persona_type={"a": "b"},
    original_text=12345,
    problem_summary=[1, 2],
    journey_stage=9,
    problem_root_cause_hypothesis={"k": "v"},
    direct_customer_quote=3.5,
    keywords="late",
)

# The legacy row: a plain `id`, no `feedback_id`, and nothing else. Rows this
# thin predate most of the enrichment and are still in the corpus, so the
# typed-default half of the projection is what this sample proves.
_LEGACY_FEEDBACK_ROW = {"id": "legacy-1", "original_text": "arrived late"}

# One document per storage prefix, keyed by sort key exactly as
# `projects.get_project` returns them (asserted against the real route by
# `test_mcp_delegation.py::test_the_document_sort_key_is_still_there`). All six
# kinds, because the in-process tool recognised two of them.
_DOCUMENTS = [
    {"sk": f"{prefix}{i}", "document_id": f"doc_2026081914300{i}", "title": f"doc {i}"}
    for i, prefix in enumerate(mcp_handler._DOCUMENT_KINDS)
]

# `/metrics/summary`'s own return dict, field for field, from
# `metrics_handler.get_summary` — `avg_sentiment` a rounded float, the two daily
# series as lists of `{date, count}` / `{date, avg_sentiment, count}`. The
# values are the ones `test_metrics_handler.py::TestGetSummaryEndpoint` asserts
# the route computes from one aggregate row.
_METRICS_SUMMARY_BODY = {
    "period_days": 7,
    "total_feedback": 50,
    "avg_sentiment": 0.5,
    "urgent_count": 50,
    "is_partial": False,
    "daily_totals": [{"date": "2026-01-07", "count": 50}],
    "daily_sentiment": [{"date": "2026-01-07", "avg_sentiment": 0.5, "count": 50}],
}

# The degraded answer from the same route: a window wider than aggregates are
# retained for. `is_partial` true with real counts beside it, which is the shape
# `test_metrics_partial_window` pins.
_METRICS_SUMMARY_PARTIAL_BODY = {
    **_METRICS_SUMMARY_BODY,
    "period_days": 365,
    "is_partial": True,
}

# `/metrics/sentiment` — note `total`, which the route publishes and the tool's
# schema does not declare. Legal, and deliberately so: the metrics tools pass
# their route's body through unprojected, so their schemas leave
# `additionalProperties` open. Kept in the sample precisely BECAUSE it is
# undeclared: it is the evidence that the open declaration is load-bearing.
_METRICS_SENTIMENT_BODY = {
    "period_days": 7,
    "total": 6239,
    "is_partial": False,
    "breakdown": {"positive": 1200, "neutral": 2000, "negative": 3000, "mixed": 39},
    "percentages": {"positive": 19.2, "neutral": 32.1, "negative": 48.1, "mixed": 0.6},
}
# `/metrics/categories`, `/metrics/sources`, `/metrics/personas` — the three
# routes that answer with one counts object, sorted descending by count.
_METRICS_CATEGORIES_BODY = {
    "period_days": 7,
    "is_partial": False,
    "categories": {"delivery": 300, "pricing": 120, "product_quality": 8},
}
_METRICS_SOURCES_BODY = {
    "period_days": 7,
    "is_partial": True,
    "sources": {"webscraper": 4000, "feedback-form": 21},
}
_METRICS_PERSONAS_BODY = {
    "period_days": 7,
    "is_partial": False,
    "personas": {"Priya Shah": 42, "Tobias Krenzler": 3},
}


# ---------------------------------------------------------------------------
# The sample registry
# ---------------------------------------------------------------------------
#
# One tool → one or more cases, each `(case name, tool arguments, route bodies)`.
# The registry holds ROUTE BODIES rather than finished payloads on purpose: the
# payload is then produced by the tool under test, so this file cannot
# accidentally validate a shape the tool never emits.
#
# 🔑 Adding a tool to `MCP_TOOLS` and not to this dict is a FAILING test, not a
# silent gap. That is the whole point — see the module docstring's revert story.
#
# WHERE A PHASE 3 AUTHOR SHOULD GET A ROUTE BODY, in order of preference. This is
# the one decision each of the ~30 new tools has to make, so it is stated once
# here rather than left to be inferred from the provenance comments above:
#
#   1. An existing fixture from the suite that owns the route. Best, because it
#      is already maintained against the route and cannot drift independently —
#      `_feedback_row()` and the three persona shapes come from
#      `test_mcp_delegation.py`, which took them from live rows.
#   2. The route handler's own `return` dict, transcribed field for field, with a
#      comment naming the function and the test that pins those values. This is
#      what the metrics bodies below are, and it is second-best because a human
#      transcription is exactly the link that can drift.
#   3. Driving the route handler with a stubbed table. Strongest chain of custody
#      and NOT used here: it would make this file depend on a second handler's
#      stubbing (`metrics_handler`'s `aggregates_table`, which
#      `test_metrics_handler.py` already sets up), so a change to that stubbing
#      would break a schema-conformance suite for a reason that has nothing to do
#      with schemas. Worth reaching for if a route's shape is hard to state by
#      hand — a many-branch aggregation — but not by default.
#
# What is NOT acceptable at any level: a dict written by reading the outputSchema.
# That proves a declaration can be copied, which is not in question.
_TOOL_SAMPLES: dict[str, tuple[tuple[str, dict, dict], ...]] = {
    "search_feedback": (
        # The text-search branch, with the route's own truncation flag set. The
        # tool renames it to `is_partial`, which it declares REQUIRED.
        ("search branch, truncated scan", {"query": "late"}, {
            _SEARCH_ROUTE: {
                "count": 1,
                "query": "late",
                "items": [_FEEDBACK_ROW],
                "is_partial_window": True,
            },
        }),
        # The filter-only branch: a different route, a different body.
        ("filter-only branch", {"category": "delivery"}, {
            _LIST_ROUTE: {
                "count": 1, "total": 1, "offset": 0, "limit": 20,
                "is_partial_window": False,
                "items": [_FEEDBACK_ROW, _LEGACY_FEEDBACK_ROW],
            },
        }),
        # The messy variant. A row of entirely wrong types must still yield a
        # payload that satisfies the declaration — otherwise the answer is M1.
        ("a row of wrong types", {"query": "late"}, {
            _SEARCH_ROUTE: {"items": [_HOSTILE_FEEDBACK_ROW]},
        }),
        # The empty answer, which is a real answer and still has a shape.
        ("nothing matched", {"query": "late"}, {
            _SEARCH_ROUTE: {"count": 0, "items": [], "is_partial_window": False},
        }),
    ),
    "get_feedback_detail": (
        ("an enriched row", {"feedback_id": _FEEDBACK_ID}, {
            _DETAIL_ROUTE: _FEEDBACK_ROW,
        }),
        ("a row of wrong types", {"feedback_id": _FEEDBACK_ID}, {
            _DETAIL_ROUTE: _HOSTILE_FEEDBACK_ROW,
        }),
        ("a legacy row carrying only a plain id", {"feedback_id": _FEEDBACK_ID}, {
            _DETAIL_ROUTE: _LEGACY_FEEDBACK_ROW,
        }),
    ),
    "get_metrics_summary": (
        ("a complete window", {}, {"/metrics/summary": _METRICS_SUMMARY_BODY}),
        ("a partial window", {"days": 365},
         {"/metrics/summary": _METRICS_SUMMARY_PARTIAL_BODY}),
    ),
    "get_metrics_breakdown": (
        # All four dimensions, because each reaches a DIFFERENT route with a
        # different body, and one tool schema has to describe all four.
        ("sentiment", {"dimension": "sentiment"},
         {"/metrics/sentiment": _METRICS_SENTIMENT_BODY}),
        ("categories", {"dimension": "categories"},
         {"/metrics/categories": _METRICS_CATEGORIES_BODY}),
        ("sources", {"dimension": "sources"},
         {"/metrics/sources": _METRICS_SOURCES_BODY}),
        ("personas", {"dimension": "personas"},
         {"/metrics/personas": _METRICS_PERSONAS_BODY}),
    ),
    "get_project": (
        ("metadata, three live persona shapes and all six document kinds",
         {"project_id": _PROJECT}, {
             _PROJECT_ROUTE: {
                 "project": {
                     "name": "Morning Briefing",
                     "description": "The daily catch-up app",
                     "created_at": "2026-08-19T14:30:00+00:00",
                     # Present on every real row and dropped by the tool: the
                     # route injects it at read time.
                     "kiro_default_export_prompt": "…",
                 },
                 "personas": [_GENERATED_PERSONA, _IMPORTED_PERSONA, _SPARSE_PERSONA],
                 "documents": _DOCUMENTS,
             },
         }),
        # A `tagline` that is a list, from the writer that constrains nothing.
        # `get_project` is the tool that WAS callable, so this is the live half
        # of M1: `p.get('tagline', '')` cannot correct a list.
        ("a persona whose tagline is a list", {"project_id": _PROJECT}, {
            _PROJECT_ROUTE: {
                "project": {"name": "Morning Briefing"},
                "personas": [{**_SPARSE_PERSONA, "tagline": ["Night-shift", "supervisor"]}],
                "documents": [],
            },
        }),
        ("an empty project", {"project_id": _PROJECT}, {
            _PROJECT_ROUTE: {"project": {"name": "Empty"}, "personas": [], "documents": []},
        }),
    ),
    "list_personas": (
        # The three live persona shapes together: the schema-following writer,
        # the importer that constrains nothing (`workarounds` a STRING where the
        # generated row has a list, section keys this file never chose), and the
        # thinnest row in the corpus. All three from the delegation suite, which
        # took them from live rows.
        ("the three live persona shapes", {"project_id": _PROJECT}, {
            _PROJECT_ROUTE: {
                "project": {"name": "Morning Briefing"},
                "personas": [_GENERATED_PERSONA, _IMPORTED_PERSONA, _SPARSE_PERSONA],
                "documents": _DOCUMENTS,
            },
        }),
        # M1's exact shape at the source: nested objects inside the sections that
        # were once declared `array`, and a scalar where the generated row has a
        # list. This is the row that made the tool uncallable.
        ("a persona carrying nested objects where lists are declared",
         {"project_id": _PROJECT}, {
             _PROJECT_ROUTE: {
                 "project": {"name": "Morning Briefing"},
                 "personas": [{
                     **_SPARSE_PERSONA,
                     "confidence": ["high"],
                     "feedback_count": "42",
                     "pain_points": {
                         "current_challenges": {"a": "alerts", "b": "noise"},
                         "emotional_impact": ["tired", "resigned"],
                     },
                     "behaviors": {"tools_used": {"ios": True}},
                     "quotes": {"text": "not even a list"},
                 }],
                 "documents": [],
             },
         }),
        ("a project with no personas", {"project_id": _PROJECT}, {
            _PROJECT_ROUTE: {"project": {"name": "Empty"}, "personas": [], "documents": []},
        }),
    ),
}

# The declared tool names, read from the published registry. Parametrising over
# THIS rather than over `_TOOL_SAMPLES` is what makes a new tool with no sample a
# red test instead of an absence nobody sees.
_PUBLISHED_TOOL_NAMES: tuple[str, ...] = tuple(
    tool["name"] for tool in mcp_handler.MCP_TOOLS
)

# §5.4's behaviour hints. Named here so the assertion says which one is missing.
_REQUIRED_HINTS: tuple[str, ...] = (
    "readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint",
)


def _output_schema(name: str) -> dict:
    """One tool's declared `outputSchema`, read from the published registry."""
    for tool in mcp_handler.MCP_TOOLS:
        if tool["name"] == name:
            return tool["outputSchema"]
    raise AssertionError(f"no published tool named {name}")


def _payload(tool: str, arguments: dict, bodies: dict) -> dict:
    """What the tool puts in `structuredContent` for these route bodies.

    Fails rather than returns on an errored call: a tool that refused the sample
    produces no payload, and validating `{}` against an open schema is how a
    conformance suite goes green while proving nothing.
    """
    result = _call(tool, arguments, _FakeLambda(bodies))
    assert "error" not in result, f"{tool}: the sample call failed: {result['error']}"
    inner = result["result"]
    assert inner["isError"] is False, f"{tool}: the sample call was a tool error: {inner}"
    assert "structuredContent" in inner, f"{tool}: the call returned no structuredContent"
    return inner["structuredContent"]


def _errors(payload, schema: dict) -> list[str]:
    """Every way this payload violates this schema, as prose, for a failure message.

    A REAL validator, not a subset of one. A hand-rolled check that skipped
    `additionalProperties` or never descended into `items` would pass exactly the
    declarations that are wrong — both constructs carry a live finding between
    them (M1 was inside `items`).

    Unordered — `iter_errors` yields in the validator's own keyword and property
    iteration order, so a shallow violation can precede a deep one. Nothing here
    reads `errors[0]`, and a control that wants to name WHICH field failed must
    use `_error_paths` rather than searching this prose: a message can mention
    `'array'` because some other declared array broke.
    """
    validator = Draft202012Validator(schema)
    return [
        f"{'/'.join(str(p) for p in error.absolute_path) or '<root>'}: {error.message}"
        for error in validator.iter_errors(payload)
    ]


def _error_paths(payload, schema: dict) -> list[tuple]:
    """The payload path of every violation, as a tuple of keys and indices.

    🔑 The attributable half of `_errors`. A control that asserts "this field is
    rejected" by searching the message prose for a substring accepts an error
    raised somewhere else entirely: `any("array" in e for e in errors)` passes
    when an UNRELATED declared array is broken, and `list_personas` payloads
    carry several. Matching on `absolute_path` names the field the control claims
    to be about, so the control fails if that field stops being checked even
    while the payload keeps failing for another reason.
    """
    return [
        tuple(error.absolute_path)
        for error in Draft202012Validator(schema).iter_errors(payload)
    ]


def _rejects_at(payload, schema: dict, path: tuple) -> bool:
    """Whether some violation is at `path` or inside it.

    Prefix rather than equality: `additionalProperties: false` reports at the
    OBJECT that carried the undeclared key, while a wrong type reports at the
    value, so a control that wants "the failure is attributable to this subtree"
    cannot pin the exact depth without restating the validator's own reporting
    rules.
    """
    return any(p[: len(path)] == path for p in _error_paths(payload, schema))


def _tools_missing_samples(registry: dict) -> list[str]:
    """Published tools with no sample in this registry.

    A FUNCTION rather than a comprehension inside the test, so the completeness
    check can itself be called with a registry that is missing an entry —
    `test_the_completeness_check_notices_a_tool_with_no_sample`. A check nobody
    checks is the one that quietly returns nothing.
    """
    return sorted(
        name for name in _PUBLISHED_TOOL_NAMES if not registry.get(name)
    )


def _closed_schema_tools() -> list[str]:
    """The tools whose `outputSchema` forbids undeclared top-level keys.

    Derived from the declarations rather than listed: the split between closed
    (projected answers) and open (pass-through route bodies) is a real design
    decision in `mcp_handler`, and a list here would be a second opinion about
    it.
    """
    return [
        name for name in _PUBLISHED_TOOL_NAMES
        if _output_schema(name).get("additionalProperties") is False
    ]


def _closed_item_schemas() -> list[tuple[str, str]]:
    """`(tool, array property)` for every array whose ITEMS close the door.

    Derived the same way as `_closed_schema_tools`, and needed for the same
    reason one level down: M1 lived inside `items`, so the nested closure is the
    architecturally important one to control, and the top-level control cannot
    reach it — merging a key into the payload root never touches an element of
    `items`.
    """
    found = []
    for name in _PUBLISHED_TOOL_NAMES:
        for prop, declared in (_output_schema(name).get("properties") or {}).items():
            if declared.get("type") != "array":
                continue
            if (declared.get("items") or {}).get("additionalProperties") is False:
                found.append((name, prop))
    return found


# ===========================================================================
# Coverage — a tool with no sample fails
# ===========================================================================

class TestEveryToolBringsASample:
    def test_every_published_tool_has_a_registered_sample_payload(self):
        """The load-bearing requirement: this cannot be opted out of.

        A Phase 3 tool either brings a payload taken from the route it delegates
        to, or the suite is red. Skipping the unregistered ones would leave the
        tool most likely to be wrong — the one nobody wrote a sample for — as the
        only tool nothing validates.
        """
        missing = _tools_missing_samples(_TOOL_SAMPLES)

        assert missing == [], (
            f"published with no sample payload: {missing}. Add one to "
            "_TOOL_SAMPLES, taken from the shape the delegated route really "
            "returns — not written to match the schema."
        )

    def test_the_registry_holds_no_sample_for_a_tool_that_is_not_published(self):
        """The other direction. A renamed tool leaves a sample validating
        nothing, and an entry that no longer matches a published name is exactly
        as invisible as a missing one."""
        stale = sorted(set(_TOOL_SAMPLES) - set(_PUBLISHED_TOOL_NAMES))

        assert stale == [], f"samples for tools that are not published: {stale}"

    def test_the_completeness_check_notices_a_tool_with_no_sample(self):
        """The positive control for the check above.

        Called with the real registry minus one entry, so "the check found
        nothing" cannot be because the check finds nothing ever. Deleting the
        `_tools_missing_samples` body to `return []` fails HERE, with the name of
        the tool it should have reported.
        """
        victim = _PUBLISHED_TOOL_NAMES[0]
        thinned = {k: v for k, v in _TOOL_SAMPLES.items() if k != victim}

        assert _tools_missing_samples(thinned) == [victim]
        # An empty entry is as useless as an absent one and must read the same.
        assert _tools_missing_samples({**_TOOL_SAMPLES, victim: ()}) == [victim]


# ===========================================================================
# The guard — a real payload against its own declaration
# ===========================================================================

def _cases() -> list:
    """Every (tool, case) pair, as pytest parameters named for the case.

    Built from the PUBLISHED tool list, so a tool with no samples contributes one
    parameter that fails with its own name rather than silently contributing
    none.
    """
    params = []
    for name in _PUBLISHED_TOOL_NAMES:
        samples = _TOOL_SAMPLES.get(name) or ()
        if not samples:
            params.append(pytest.param(name, None, id=f"{name}-NO-SAMPLE"))
            continue
        for case, arguments, bodies in samples:
            params.append(pytest.param(
                name, (arguments, bodies), id=f"{name}-{case.replace(' ', '_')}",
            ))
    return params


class TestDeclaredSchemasHoldAgainstRealPayloads:
    @pytest.mark.parametrize("tool,sample", _cases())
    def test_a_real_payload_validates_against_its_declared_output_schema(self, tool, sample):
        """The guard. What the tool emits must satisfy what it advertises.

        `sample is None` is the unregistered case, and it FAILS here as well as
        in the coverage test above — once with the tool's name in the test id,
        which is what a Phase 3 author reads first.
        """
        assert sample is not None, (
            f"{tool} publishes an outputSchema and has no sample payload; "
            "nothing validates its declaration"
        )
        arguments, bodies = sample
        payload = _payload(tool, arguments, bodies)

        errors = _errors(payload, _output_schema(tool))
        assert errors == [], f"{tool} payload violates its own outputSchema: {errors}"

    @pytest.mark.parametrize("tool", _PUBLISHED_TOOL_NAMES)
    def test_the_declaration_is_itself_a_valid_json_schema(self, tool):
        """A malformed declaration is not a validating client's problem to find.

        `check_schema` is what catches `{"type": "arary"}` or an `items` beside a
        `type: object`: constructs a client's validator either rejects outright
        or silently ignores, in which case the field is unvalidated and nothing
        says so.
        """
        Draft202012Validator.check_schema(_output_schema(tool))


# ===========================================================================
# Negative controls — what proves the validator is running
# ===========================================================================

class TestTheValidatorRejectsWhatTheDeclarationsForbid:
    def test_the_path_matcher_distinguishes_one_field_from_another(self):
        """The positive control for `_rejects_at`, which every control below uses.

        🔑 A matcher is the one kind of helper whose failure mode is silent
        approval: rewrite `_rejects_at` to `return True` and every negative
        control below still passes, because each one only ever asks it to confirm
        a rejection. So it is exercised here against a schema and payload owned by
        this test — required to say NO for a path that did not fail, and no for a
        payload with no errors at all, which is what the mutated version cannot
        do.
        """
        schema = {
            "type": "object",
            "properties": {
                "wanted": {"type": "array", "items": {"type": "string"}},
                "other": {"type": "array", "items": {"type": "string"}},
            },
        }
        valid = {"wanted": ["a"], "other": ["b"]}
        broken_elsewhere = {"wanted": ["a"], "other": {"not": "a list"}}

        assert _rejects_at(broken_elsewhere, schema, ("other",))
        assert not _rejects_at(broken_elsewhere, schema, ("wanted",)), (
            "the path matcher attributed a failure to a field that did not fail; "
            "every control below would then pass for the wrong reason"
        )
        assert not _rejects_at(valid, schema, ("wanted",))
        assert not _rejects_at(valid, schema, ()), (
            "the path matcher reported a rejection for a payload with no errors"
        )

    def test_some_tool_closes_its_output_schema(self):
        """Anti-vacuity for the parametrization below: if no schema declared
        `additionalProperties: false`, the extra-key control would be an empty
        parametrization reading as green."""
        assert _closed_schema_tools(), (
            "no published tool closes its outputSchema; the extra-key control "
            "below would cover nothing"
        )

    @pytest.mark.parametrize("tool", _closed_schema_tools())
    def test_an_undeclared_key_is_rejected_where_the_schema_closes_the_door(self, tool):
        """`additionalProperties: false` must mean it.

        This is the control that proves a validator is RUNNING at all: a
        partial implementation that walks `properties` and ignores
        `additionalProperties` passes every payload here, and passes exactly the
        declarations that are wrong.
        """
        case, arguments, bodies = _TOOL_SAMPLES[tool][0]
        payload = _payload(tool, arguments, bodies)
        schema = _output_schema(tool)

        # Valid first, so the rejection below is attributable to the added key
        # and not to a sample that never conformed.
        assert _errors(payload, schema) == [], f"{tool} ({case}) does not validate to begin with"

        errors = _errors({**payload, "a_field_no_one_declared": 1}, schema)
        assert errors, (
            f"{tool} declares additionalProperties: false and accepted an "
            "undeclared key; the validator is not enforcing it"
        )
        assert any("a_field_no_one_declared" in e for e in errors), errors

    def test_some_array_closes_its_item_schema(self):
        """Anti-vacuity for the nested control below, the same way
        `test_some_tool_closes_its_output_schema` is for the top-level one: an
        empty derivation would make an empty parametrization read as green."""
        assert _closed_item_schemas(), (
            "no published array closes its item schema; the nested extra-key "
            "control below would cover nothing — and M1 lived inside `items`"
        )

    @pytest.mark.parametrize("tool,prop", _closed_item_schemas())
    def test_an_undeclared_key_inside_an_array_item_is_rejected(self, tool, prop):
        """The nested half of the closed-door control, one level DOWN.

        🔑 Architecturally the more important of the two, because M1 was inside
        `items`: a client's validator descends there, and a validator of ours that
        did not would pass exactly the declarations that are wrong. The top-level
        control cannot reach this — merging a key into the payload root never
        touches an element of an array.

        Not reachable from a route body today, and that is itself the thing worth
        pinning: the projections whitelist item keys, so an unrecognised field on
        a route's row is dropped before it reaches the payload (asserted by
        `test_an_unrecognised_key_on_a_route_row_is_not_forwarded`). A projection
        that started forwarding unknown keys would break every validating client;
        this control is what says the declaration forbids it.
        """
        case, arguments, bodies = _TOOL_SAMPLES[tool][0]
        payload = _payload(tool, arguments, bodies)
        schema = _output_schema(tool)

        assert _errors(payload, schema) == [], f"{tool} ({case}) does not validate to begin with"
        assert payload.get(prop), (
            f"{tool} ({case}): the sample no longer carries any {prop} item, so "
            "there is nothing to inject an undeclared key into; pick a sample "
            "whose first case populates it"
        )

        broken = copy.deepcopy(payload)
        broken[prop][0]["a_field_no_one_declared"] = 1

        assert _rejects_at(broken, schema, (prop, 0)), (
            f"{tool}.{prop} items declare additionalProperties: false and the "
            f"validator accepted an undeclared key inside {prop}[0]: "
            f"{_errors(broken, schema)}"
        )

    def test_an_unrecognised_key_on_a_route_row_is_not_forwarded(self):
        """The positive half: the projection is what keeps the nested case unreachable.

        The control above proves the DECLARATION forbids an undeclared key inside
        an array item. This proves the tool never produces one, which is the
        reason the control above cannot be driven from a route body — and the
        property that would silently disappear if a projection were rewritten to
        pass rows through.
        """
        search = _payload("search_feedback", {"query": "late"}, {
            _SEARCH_ROUTE: {
                "count": 1,
                "query": "late",
                "is_partial_window": False,
                "items": [{**_FEEDBACK_ROW, "brand_new_route_field": "surprise"}],
            },
        })
        assert search["items"], "the sample produced no items to inspect"
        assert "brand_new_route_field" not in search["items"][0], (
            "an unrecognised key on a feedback row reached the payload; the "
            "declaration closes the item schema, so a validating client would "
            "reject the whole response"
        )

        project = _payload("get_project", {"project_id": _PROJECT}, {
            _PROJECT_ROUTE: {
                "project": {"name": "Morning Briefing"},
                "personas": [],
                "documents": [{**_DOCUMENTS[0], "unexpected": "surprise"}],
            },
        })
        assert project["documents"], "the sample produced no documents to inspect"
        assert "unexpected" not in project["documents"][0]

    def test_an_undeclared_key_is_accepted_where_the_schema_leaves_it_open(self):
        """The other half of that split, and it is deliberate.

        The metrics tools forward a route body unprojected, so they do not
        control the keys and declare `additionalProperties` open. Asserting the
        rejection everywhere would be asserting a design this server
        deliberately does not have — and would turn a route growing a field into
        a failure in this file.

        🔑 The undeclared key is added to the ROUTE BODY and driven through the
        tool, not merged into the schema's input directly. Validating the body
        would assume the tool is a pure pass-through — exactly the assumption the
        rest of this file refuses to make, and the one that would silently stop
        being true the day a projection is added here.
        """
        schema = _output_schema("get_metrics_breakdown")
        assert schema.get("additionalProperties") is not False

        payload = _payload("get_metrics_breakdown", {"dimension": "categories"}, {
            "/metrics/categories": {**_METRICS_CATEGORIES_BODY, "added_next_quarter": 1},
        })

        assert "added_next_quarter" in payload, (
            "the tool dropped the undeclared key before the validator saw it, so "
            "this control no longer says anything about the open declaration; it "
            "now projects its answer and the declaration should say so"
        )
        assert _errors(payload, schema) == []

    def test_a_nested_object_where_an_array_is_declared_is_rejected(self):
        """M1's exact shape: an object in a slot declared `array`.

        Both places a live writer can still produce it — a persona section's
        string list, and the one declared array on the feedback detail. A
        validator that never descends into `items` reads green on both, which is
        what let M1 reach production.

        🔑 Matched on the error PATH, not on the message prose. A disjunction like
        `any("current_challenges" in e or "array" in e ...)` was here first and is
        satisfiable by an unrelated failure: breaking `personas[0].quotes` instead
        yields `personas/0/quotes: ... is not of type 'array'`, which the prose
        matcher accepts while `current_challenges` is untouched. A control that
        can pass for a different field's reason is not a control for this one.
        """
        personas_schema = _output_schema("list_personas")
        payload = _payload("list_personas", *_TOOL_SAMPLES["list_personas"][0][1:])
        assert _errors(payload, personas_schema) == [], "the sample must validate first"

        # Asserted, not assumed: a valid payload need not CONTAIN this path — the
        # persona item schema declares no `required`, so `_GENERATED_PERSONA` or
        # the projection could stop emitting the section and the mutation below
        # would raise KeyError instead of failing with a diagnosis.
        section = payload["personas"][0].get("pain_points")
        assert isinstance(section, dict) and isinstance(
            section.get("current_challenges"), list
        ), (
            "the sample no longer contains a nested string-list section at "
            "personas[0].pain_points.current_challenges, which is the exact shape "
            f"M1 was; found {section!r}. Point this control at another nested "
            "list declared `array`, or restore a sample that carries one."
        )

        broken = copy.deepcopy(payload)
        broken["personas"][0]["pain_points"]["current_challenges"] = {"a": "alerts"}

        assert _rejects_at(
            broken, personas_schema, ("personas", 0, "pain_points", "current_challenges")
        ), _errors(broken, personas_schema)

        detail_schema = _output_schema("get_feedback_detail")
        detail = _payload("get_feedback_detail", *_TOOL_SAMPLES["get_feedback_detail"][0][1:])
        assert _errors(detail, detail_schema) == [], "the detail sample must validate first"

        assert _rejects_at({**detail, "keywords": {"0": "late"}}, detail_schema, ("keywords",))
        # And a string where the array is declared: the flat-value case, which is
        # what the importer really writes.
        assert _rejects_at({**detail, "keywords": "late"}, detail_schema, ("keywords",))

    def test_a_string_where_an_integer_is_declared_is_rejected(self):
        """`feedback_count` arrives as a DynamoDB `Decimal` and on old rows not
        at all, so a writer putting `"42"` there is not hypothetical.

        Valid first and matched on the path, for the same reason as the control
        above: asserting only that the mutated payload has SOME error goes green
        if the sample stops conforming for an unrelated reason, which is a control
        that reports nothing on the day it is needed.
        """
        schema = _output_schema("list_personas")
        payload = _payload("list_personas", *_TOOL_SAMPLES["list_personas"][0][1:])
        assert _errors(payload, schema) == [], "the sample must validate first"

        broken = copy.deepcopy(payload)
        broken["personas"][0]["feedback_count"] = "42"

        assert _rejects_at(broken, schema, ("personas", 0, "feedback_count")), _errors(
            broken, schema
        )

    def test_a_required_field_that_is_absent_is_rejected(self):
        """`search_feedback` promises `is_partial` on every answer. A flag that
        is sometimes missing reads as "not truncated", which is the same wrong
        answer as asserting it false."""
        schema = _output_schema("search_feedback")
        payload = _payload("search_feedback", *_TOOL_SAMPLES["search_feedback"][0][1:])
        assert "is_partial" in schema.get("required", []), (
            "search_feedback no longer requires is_partial; this control moved"
        )
        assert _errors(payload, schema) == [], "the sample must validate first"

        errors = _errors({k: v for k, v in payload.items() if k != "is_partial"}, schema)
        # `required` reports at the OBJECT that lacks the key, so the path is the
        # root for every missing field and cannot distinguish them: this is the one
        # control where the message is the only place the field name appears.
        assert any("is_partial" in e for e in errors), errors

    def test_breaking_a_declared_type_in_a_copy_of_a_schema_rejects_a_real_payload(self):
        """The guard mutation-checked against itself, in the suite.

        A COPY of the declaration, never `mcp_handler`'s own: this file reports
        mismatches and changes nothing. If a declared type can be broken and the
        same real payload still validates, then the payload was never being
        checked against that field and every green run above meant nothing.
        """
        mutated = copy.deepcopy(_output_schema("get_feedback_detail"))
        mutated["properties"]["keywords"]["type"] = "integer"
        payload = _payload("get_feedback_detail", *_TOOL_SAMPLES["get_feedback_detail"][0][1:])

        assert _errors(payload, _output_schema("get_feedback_detail")) == []
        assert _errors(payload, mutated), (
            "a declared type was broken and the payload still validated; the "
            "guard is not reading the declaration it claims to"
        )

    def test_closing_an_open_schema_in_a_copy_rejects_a_real_payload(self):
        """The same mutation for the other half of the split.

        The metrics schemas are open BECAUSE the route sends fields they do not
        declare — `/metrics/sentiment` sends `total`. Closing a copy must reject
        the real payload, which is what makes "open on purpose" a fact about the
        payload rather than an assertion in a comment.

        Driven through the tool for the same reason as the control above: the
        equivalence between a metrics route body and the tool's payload holds only
        while the tool projects nothing, and this file's whole method is to not
        assume that.
        """
        schema = _output_schema("get_metrics_breakdown")
        payload = _payload("get_metrics_breakdown", {"dimension": "sentiment"}, {
            "/metrics/sentiment": _METRICS_SENTIMENT_BODY,
        })
        assert _errors(payload, schema) == []
        assert "total" in payload, (
            "the payload no longer carries `total`, the undeclared field that makes "
            "the open declaration load-bearing; this control needs another one"
        )

        closed = {**copy.deepcopy(schema), "additionalProperties": False}
        errors = _errors(payload, closed)

        # `additionalProperties` reports at the containing object, so the path is
        # the root here and the field name lives only in the message — the same
        # exception `test_a_required_field_that_is_absent_is_rejected` documents.
        assert any("total" in e for e in errors), errors


# ===========================================================================
# §5.4 — what every declaration must carry
# ===========================================================================

class TestEveryToolDeclaresWhatTheSpecSectionRequires:
    """#360 already ships all of this, so this class passes on arrival.

    That is the point: it is not here to find a defect today, it is here so a
    Phase 3 tool cannot land without an output schema, without the behaviour
    hints a client uses to decide whether a call needs a human's permission, or
    without the cost class a model uses to choose between two tools.
    """

    @pytest.mark.parametrize("tool", mcp_handler.MCP_TOOLS, ids=lambda t: t["name"])
    def test_every_tool_declares_what_section_5_4_requires(self, tool):
        name = tool["name"]

        assert isinstance(tool.get("outputSchema"), dict), f"{name} declares no outputSchema"
        assert tool["outputSchema"].get("type") == "object", (
            f"{name}: structuredContent is an object, so its schema must say so"
        )

        annotations = tool.get("annotations")
        assert isinstance(annotations, dict), f"{name} publishes no annotations"
        assert annotations.get("title"), (
            f"{name} has no human-readable title; a client shows the raw name in "
            "its permission prompt"
        )
        missing_hints = [hint for hint in _REQUIRED_HINTS if hint not in annotations]
        assert missing_hints == [], f"{name} omits behaviour hints: {missing_hints}"
        for hint in _REQUIRED_HINTS:
            assert isinstance(annotations[hint], bool), (
                f"{name}.{hint} is a hint a client branches on; it must be a boolean"
            )

        cost_class = (tool.get("_meta") or {}).get(mcp_handler.COST_CLASS_KEY)
        assert cost_class in mcp_handler.COST_CLASSES, (
            f"{name} declares cost class {cost_class!r}, not one of "
            f"{mcp_handler.COST_CLASSES}"
        )
