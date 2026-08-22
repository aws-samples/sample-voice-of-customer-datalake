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
      detect anything" is itself a failure. It compares SET DIFFERENCES rather
      than asserting `== [victim]`, so it does not also fail whenever an
      unrelated tool is missing a sample — a control that fails alongside its
      own subject cannot say which of the two broke.

  test_every_declared_property_is_demonstrated_by_some_sample
    — the SUBSTANCE half of the above, because the presence half counts dict
      keys rather than evidence. Both metrics tools end at
      `ToolResult(body if isinstance(body, dict) else {})` and declare no
      `required`, so a route body of `{}` is a SUCCESSFUL call whose empty
      payload validates against an open schema: replacing only those two tools'
      bodies with `{}` once left every case green. Now it names the properties
      the sample failed to produce. Its own positive control is
      test_the_substance_check_notices_a_sample_that_demonstrates_nothing, which
      hollows a sample and requires the check to object.

      It measures EVERY DEPTH, not the payload root. Stopping at the root left the
      level this file's own architecture argument singles out unmeasured: a
      property declared inside a closed `items` could be demonstrated by no sample
      and still pass everything here, because item schemas declare no `required`
      and `additionalProperties: false` constrains only keys that are PRESENT.
      Injecting a property no route emits into
      `list_personas.personas.items.properties` left 66 passing; it is now
      reported as `personas/[]/nested_prop_no_route_emits`. Descending also found
      nine canonical persona fields below the item level that no sample reached,
      which is why a fifth `list_personas` case exists. Two controls, because the
      requirement passing cannot distinguish "descends and finds everything
      demonstrated" from "does not descend":
      test_the_substance_check_measures_below_the_payload_root asserts the
      derivation reaches inside an array item at all, and
      test_the_substance_check_descends_into_array_items hollows an ELEMENT of a
      schema it OWNS — owned rather than registry-driven because the projections
      fill every declared item key unconditionally, so no route body can produce
      an element missing one, and a control that cannot construct its own negative
      case only reports what the production code already does.

      And through every KEYWORD that nests a schema, not only `properties` and
      `items`. `Draft202012Validator` follows `$ref`, `anyOf`/`allOf`/`oneOf`,
      `prefixItems` and a schema-valued `additionalProperties`/`patternProperties`,
      so a declaration nesting that way was live for a client and invisible here —
      an asymmetry, not merely a gap. Worse than invisible: `_stale_exemptions`
      measures "declared" over the same walk, so a legitimate exemption for a
      `$ref`'d property was reported as a TYPO and the only way to satisfy the file
      was to delete a correct entry. The reviewer's five-construct probe found one
      site, the root, with all five nested properties unmeasured; it now finds
      six. test_the_substance_check_measures_through_every_keyword_that_nests_a
      _schema is the control, asserting both directions over a schema it owns, and
      what the walk CANNOT follow is refused by name rather than lost — see
      test_no_published_declaration_nests_through_a_keyword_the_walk_cannot_follow.

  test_no_published_declaration_uses_a_property_name_that_collides_with_a_label
    — `_label` joins a path with `/`, so a property literally named `a/b` at the
      root produces the same label as `b` inside object `a`, and one exemption
      would silence both indistinguishably. The flat namespace is deliberate — an
      allowlist's whole job is to be writable by hand, and escaping would put a
      second addressing scheme in the one structure that must not need one — so
      the assumption is CHECKED rather than only documented, which is the
      treatment this file gives its other deliberate limitations. `[]` and `{}`
      are reserved for the same reason.

  test_no_exemption_from_the_substance_check_has_gone_stale
    — the check above can be opted out of via
      `_PROPERTIES_NO_SAMPLE_CAN_SHOW`, and an allowlist is the one structure
      here whose FUNCTION is to remove a declaration from the checked set, so a
      stale entry is the most costly silence available. All three stale forms
      were silent: an entry for a property some sample does demonstrate (dead
      weight that suppresses a real requirement the day the sample changes), an
      entry for a property no schema declares (a typo, protecting nothing while
      reading as though it does), and an entry for an unpublished tool — the same
      condition test_the_registry_holds_no_sample_for_a_tool_that_is_not_published
      catches for `_TOOL_SAMPLES`. This is the module's own `xfail(strict=True)`
      argument applied to its other exemption mechanism. The dict is empty, so it
      passes trivially and the FIRST entry anyone adds is checked. Its positive
      control, test_the_staleness_check_notices_each_way_an_exemption_can_go
      _stale, asserts each form separately — one combined dict would pass while
      two of three detections were broken — and requires SILENCE for an exemption
      that is still doing work, since a check reporting everything would satisfy
      all three while making the allowlist unusable.

  _payload_reaching, at the three controls that mutate an array element
    — `_TOOL_SAMPLES[tool][0]` made those controls depend on the FIRST registered
      case populating a particular array, so reordering the registry — an
      apparently cosmetic edit — broke them: only one of `get_project`'s three
      cases populates `documents`, and moving the empty-project case first was
      enough. Two of them failed with a bare `IndexError` from
      `payload["personas"][0]` rather than a sentence. Selecting whichever case
      reaches the site removes the coupling instead of only diagnosing it;
      reordering now changes nothing, and the genuine "no case reaches it"
      condition fails naming the tool, the site and how many samples were
      searched. It takes a PATH rather than a root property, so it reaches a site
      at any depth — a helper that could only look up a root key would have kept
      the control shallower than the derivation feeding it.

  TestTheDerivationsSurviveAnUnusualDeclaration
    — nothing read at IMPORT time may raise on a declaration a client accepts, or
      on a fixture this file imports. `_closed_schema_tools()`,
      `_closed_item_schemas()` and `_TOOL_SAMPLES` are all read inside
      `@pytest.mark.parametrize`, so a raise there is a collection error that
      aborts collection of the ENTIRE `lambda/api` suite and is attributed to
      whatever ran next. Three did exactly that: a published tool with no
      `outputSchema` (`KeyError`, in place of the precise message §5.4's test
      already carries); a boolean sub-schema, which Draft 2020-12 permits and
      `check_schema` accepts (`AttributeError`) — this file crashing on a schema
      it also certifies as valid; and `_GENERATED_PERSONA["identity"]` in a
      sample, where renaming that key in `test_mcp_delegation.py` gave
      `KeyError: 'identity'` and took the suite to ZERO collected tests. The third
      is the only one where the raising code was this file's own, and the coupling
      is one-directional and to a PRIVATE name in another module, so nothing over
      there will stop the rename. All three now degrade — "no schema, closes
      nothing" and `.get(section, {})` — leaving the §5.4 test and the substance
      check as the named reporters: the rename now reads as *"list_personas
      declares ['personas/[]/identity/age_range', …] and no registered sample
      produces them"* beside a test naming the fixture's owner, with 2199 other
      tests still running. The tolerance has its own positive control,
      test_the_derivations_still_find_the_real_closures: making `_output_schema`
      return `{}` unconditionally would satisfy that whole class while rendering
      the file vacuous, since an empty schema validates every payload.

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

      Parametrised from `_closed_item_schemas`, which now derives from the SAME
      walk the substance check uses. It used to walk root-level `properties` only,
      so a closed `items` nested inside another array's item schema — or inside a
      nested object — was parametrised by nothing while `_declared_sites` saw it
      perfectly well: the two halves of the file disagreed about how deep a
      declaration goes, and the shallower half was the one guarding M1's level.
      Confirmed reachable through production code, not only synthetically: a closed
      nested array added to `_PERSONA_PROPERTIES` gave one substance-check failure
      and ZERO from this control. Its depth has its own anti-vacuity control,
      test_the_closed_item_derivation_can_find_a_closure_below_the_payload_root,
      because test_some_array_closes_its_item_schema is satisfied by one closure at
      the root and so passed throughout the round the derivation was shallow —
      "finds nothing deep" read as "there is nothing deep".

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
        # The fully-populated generated row, carrying the canonical fields the
        # three fixtures above happen not to. Required because the substance check
        # descends to EVERY depth: nine properties declared inside
        # `personas[].identity` / `.goals_motivations` / `.behaviors` /
        # `.context_environment` were reached by no sample, so nothing validated
        # their declared types — the item-level gap in miniature. See
        # `_PROPERTIES_NO_SAMPLE_CAN_SHOW` for why they were sampled rather than
        # exempted.
        #
        # Every key and value below is a field of `schemas/persona.schema.json`,
        # the contract `projects.py` generation writes to, at the type that schema
        # declares — an optional field a generated row carries when the model
        # answered that part of the prompt, which is the ordinary case, not an
        # exotic one. This is provenance level 2 of the convention above: a
        # transcription from the schema that owns the shape, not a dict written by
        # reading the tool's `outputSchema`.
        #
        # 🔑 `.get(section, {})`, never `_GENERATED_PERSONA["section"]`. This dict
        # is module-level and `_cases()` reads it inside a
        # `@pytest.mark.parametrize` decorator, so a subscript here evaluates at
        # IMPORT: renaming one section key in `test_mcp_delegation.py` — a
        # plausible edit, since that suite re-derives its section names from
        # `schemas/persona.schema.json` — raised `KeyError: 'identity'` and took
        # the whole `lambda/api` suite to zero collected tests. That is exactly the
        # blast radius `TestTheDerivationsSurviveAnUnusualDeclaration` exists to
        # prevent, arriving from a fixture instead of from a declaration, and the
        # coupling is one-directional and to a PRIVATE name in another module, so
        # nothing over there will stop the rename.
        #
        # Degrading instead hands the report to this round's own addition: the
        # substance check names the properties the samples stopped demonstrating
        # (`personas/[]/identity/age_range` …), which is a diagnosis rather than a
        # traceback. `test_the_imported_persona_fixture_still_carries_the_sections
        # _this_sample_extends` is the assertion that says so by name.
        ("a generated row carrying every canonical persona field",
         {"project_id": _PROJECT}, {
             _PROJECT_ROUTE: {
                 "project": {"name": "Morning Briefing"},
                 "personas": [{
                     **_GENERATED_PERSONA,
                     "identity": {
                         **_GENERATED_PERSONA.get("identity", {}),
                         "bio": "Reads on the commute, decides at the weekend.",
                         "education": "LLB, University of Leeds",
                         "family_status": "Two children at primary school",
                         "income_bracket": "£60k-£80k",
                     },
                     "goals_motivations": {
                         **_GENERATED_PERSONA.get("goals_motivations", {}),
                         "success_definition": "Nothing important was missed",
                         "underlying_motivations": ["Be the informed one at work"],
                     },
                     "behaviors": {
                         **_GENERATED_PERSONA.get("behaviors", {}),
                         "activity_frequency": "Every weekday morning",
                     },
                     "context_environment": {
                         **_GENERATED_PERSONA.get("context_environment", {}),
                         "social_context": "Alone, before the household wakes",
                         "influencers": ["Her local WhatsApp group"],
                     },
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

# Declared properties that no sample can demonstrate, `tool` → `{label}`, where a
# label is `_label`'s path: a root property is its own name, `"[]"` marks a descent
# through an array and `"{}"` a descent through a schema-valued map
# (`additionalProperties`) — `personas/[]/identity/bio`.
#
# 🔑 EMPTY, and it must stay hard to add to. Every property declared by the six
# tools published today is carried by at least one sample payload, at every depth,
# so `test_every_declared_property_is_demonstrated_by_some_sample` passes on
# arrival — which is the point, exactly as with the §5.4 class: it is here so a
# Phase 3 tool cannot satisfy the sample requirement with a route body of `{}`.
#
# It was empty when the requirement stopped at the payload root, and it is STILL
# empty now that the requirement descends to every depth — but that is a fact
# about this diff, not a property of the samples it inherited. Descending found
# nine declared properties below the item level that no sample reached
# (`personas/[]/identity/bio`, `education`, `family_status`, `income_bracket`,
# `goals_motivations/success_definition`, `underlying_motivations`,
# `behaviors/activity_frequency`, `context_environment/social_context`,
# `influencers`), every one of them a real field of
# `schemas/persona.schema.json` that a generated row can carry. So the samples
# were extended to carry them rather than the declarations exempted: nine
# exemptions would have been nine claims that a canonical persona field cannot
# appear in a real answer, which is false, and an allowlist that absorbs the first
# finding it is asked about is one that will absorb the next.
#
# An entry here is a claim that a declared property CANNOT appear in any real
# answer, which is nearly always a sign the declaration is wrong rather than the
# sample. Anything added needs a comment saying why the route can never produce
# it; if the honest reason is "I did not want to build the body", the answer is to
# build the body.
#
# 🔑 Checked in BOTH directions, by `_stale_exemptions` and
# `test_no_exemption_from_the_substance_check_has_gone_stale`. An allowlist is the
# one structure in this file whose function is to REMOVE a declaration from the
# checked set, so an entry that has stopped being true is the most costly kind of
# silence here — and all three ways it can stop being true were silent before that
# test existed: an entry for a property some sample does demonstrate (dead weight
# that would suppress a real requirement the day the sample changed), an entry for
# a property no schema declares (a typo, or a renamed declaration, protecting
# nothing while reading as though it does), and an entry for a tool that is no
# longer published (exactly what
# `test_the_registry_holds_no_sample_for_a_tool_that_is_not_published` exists to
# catch for `_TOOL_SAMPLES`). This is the same reasoning the module docstring
# gives for choosing `xfail(strict=True)` over a plain skip, applied to the other
# exemption mechanism the file has: an exemption may not outlive its reason.
_PROPERTIES_NO_SAMPLE_CAN_SHOW: dict[str, frozenset[str]] = {}


def _output_schema(name: str) -> dict:
    """One tool's declared `outputSchema`, read from the published registry.

    🔑 CANNOT raise for a published tool. `tool["outputSchema"]` was here first
    and a published tool declaring none raised a bare `KeyError` — from inside
    `_closed_schema_tools()` and `_closed_item_schemas()`, which are evaluated in
    `@pytest.mark.parametrize` decorators, so at MODULE IMPORT. That is a
    collection error aborting the ENTIRE `lambda/api` suite, and the
    message a Phase 3 author reads is `KeyError: 'outputSchema'` rather than
    `test_every_tool_declares_what_section_5_4_requires`'s
    `f"{name} declares no outputSchema"` — the assertion written for exactly this
    case, which never gets to run. `"outputSchema": None` was the same abort with
    an `AttributeError` instead.

    So a missing or non-dict declaration degrades to `{}`: an empty schema is
    open and validates anything, `_closed_schema_tools()` reports the tool as not
    closed, `_closed_item_schemas()` finds no arrays in it, and the §5.4 test
    stays the single named reporter of the gap. Pinned by
    `TestTheDerivationsSurviveAnUnusualDeclaration`.
    """
    for tool in mcp_handler.MCP_TOOLS:
        if tool["name"] == name:
            declared = tool.get("outputSchema")
            return declared if isinstance(declared, dict) else {}
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


def _first_sample(tool: str) -> tuple[str, dict, dict]:
    """This tool's first registered `(case, arguments, bodies)` triple.

    🔑 `_TOOL_SAMPLES[tool][0]` was written directly at seven sites, and the
    controls that use them are parametrised from the PUBLISHED registry rather
    than from `_TOOL_SAMPLES` — deliberately, since the two disagreeing is the
    state this file exists to report. So a published tool with no sample turned
    four of those controls into bare `KeyError` tracebacks that say nothing about
    samples, drowning the three tests that do name the tool.
    `test_every_published_tool_has_a_registered_sample_payload` stays the single
    authoritative reporter; this just makes the collateral failures legible.
    """
    samples = _TOOL_SAMPLES.get(tool) or ()
    if not samples:
        pytest.fail(
            f"{tool} is published and has no registered sample; add one to "
            "_TOOL_SAMPLES, taken from the shape the delegated route really "
            "returns. test_every_published_tool_has_a_registered_sample_payload "
            "is the authoritative report of this."
        )
    return samples[0]


def _payload_reaching(tool: str, path: tuple) -> tuple[dict, tuple, dict]:
    """A payload from whichever case reaches `path`, plus the object found there.

    Returns `(payload, concrete path, object)` where the object is a REFERENCE
    into the payload, so a caller holding it can mutate through it and then ask
    `_rejects_at` about the concrete path it mutated.

    🔑 Searches the cases rather than taking `_TOOL_SAMPLES[tool][0]`, which
    removes an ordering coupling instead of only diagnosing it. Several controls
    need a populated array to mutate, and taking the first case made them depend
    on that case being one that populates it — a dependency an apparently cosmetic
    reordering of the registry silently breaks. Only one of `get_project`'s three
    cases populates `documents`, so moving the empty-project case first was
    enough, and two of the controls then failed with a bare `IndexError` from
    `payload["personas"][0]` rather than a sentence.

    🔑 Takes a PATH, not a root property, so it reaches a site at any depth for
    the same reason `_closed_item_schemas` now derives them: a closed `items`
    nested below the root has an element to mutate too, and a helper that could
    only look up a root key would have kept this control shallower than the
    derivation feeding it.
    """
    samples = _TOOL_SAMPLES.get(tool) or ()
    if not samples:
        pytest.fail(
            f"{tool} is published and has no registered sample; add one to "
            "_TOOL_SAMPLES. "
            "test_every_published_tool_has_a_registered_sample_payload is the "
            "authoritative report of this."
        )
    label = "/".join(path) or "<root>"
    for _case, arguments, bodies in samples:
        payload = _payload(tool, arguments, bodies)
        found = _located_objects(payload, path)
        if found:
            at, obj = found[0]
            return payload, at, obj
    pytest.fail(
        f"none of {tool}'s {len(samples)} registered samples reaches {label}, so "
        "there is nothing for this control to mutate. Give one of its cases a "
        f"route body that populates {label}, or point the control at another site "
        "declared by this tool."
    )


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


def _subschemas(schema: dict) -> dict:
    """A schema's `properties` map, with anything that is not a dict schema dropped.

    🔑 A sub-schema in Draft 2020-12 may be a BOOLEAN, not only an object:
    `{"properties": {"x": true}}` is well-formed — `check_schema` accepts it —
    and means "any value here", while `false` means "nothing is valid here".
    `declared.get("type")` on one of those raised
    `AttributeError: 'bool' object has no attribute 'get'`, and because
    `_closed_item_schemas()` is evaluated in a `@pytest.mark.parametrize`
    decorator the raise landed at module import: a collection error aborting the
    entire `lambda/api` suite, on a declaration this very file also certifies as
    valid via `test_the_declaration_is_itself_a_valid_json_schema`.

    A boolean sub-schema constrains no keys and closes no door, so dropping it
    here is not a loss of coverage — it is the derivation saying "nothing to
    control", which is what `test_some_array_closes_its_item_schema` then
    reports if that were ever true of every array. No published tool uses one
    today; Phase 3's ~thirty declarations are where an unusual-but-legal
    construct first shows up. Pinned by
    `TestTheDerivationsSurviveAnUnusualDeclaration`.
    """
    properties = schema.get("properties")
    if not isinstance(properties, dict):
        return {}
    return {k: v for k, v in properties.items() if isinstance(v, dict)}


# The two path markers that stand for "descend through a container" rather than
# naming a key: an array element, and an arbitrary key of a schema-valued map
# (`additionalProperties` / `patternProperties`). Both are reserved words in the
# label namespace `_label` builds — see its docstring.
_ARRAY = "[]"
_MAP = "{}"

# The keywords `_reachable_schemas` follows to another object schema. Named so
# `test_no_published_declaration_nests_through_a_keyword_the_walk_cannot_follow`
# can report what is NOT here rather than leaving it silent.
_FOLLOWED_KEYWORDS: tuple[str, ...] = (
    "$ref", "properties", "items", "prefixItems", "additionalProperties",
    "patternProperties", "anyOf", "allOf", "oneOf",
)

# Draft 2020-12's other ways to nest an object schema. `Draft202012Validator`
# enforces every one of them, so a declaration nesting this way is LIVE for a
# client while being invisible to the walk — the same asymmetry the `$ref` finding
# was about. Not implemented, because none has a single payload path a label could
# name: `if`/`then` and `not` describe conditional or negated shapes, and
# `contains` matches an unknown subset of elements, so "which property is
# demonstrated where" has no well-defined answer. Rejected loudly instead.
_UNFOLLOWED_KEYWORDS: tuple[str, ...] = (
    "contains", "if", "then", "else", "not", "dependentSchemas", "propertyNames",
    "unevaluatedProperties", "unevaluatedItems", "$dynamicRef",
)


def _resolve_ref(ref: str, root) -> dict:
    """A local `$ref` pointer resolved against the declaration it lives in.

    Local only: a declaration is published inside `tools/list` and a client
    resolves it without fetching anything, so a remote pointer would be a defect
    of a different kind. An unresolvable pointer yields `{}` — no site — for the
    same reason every other derivation here degrades rather than raises: this runs
    at import, under a `@pytest.mark.parametrize` decorator.
    """
    if not ref.startswith("#"):
        return {}
    target = root
    for raw in ref[1:].split("/"):
        if not raw:
            continue
        token = raw.replace("~1", "/").replace("~0", "~")
        if isinstance(target, list):
            if not token.isdigit() or int(token) >= len(target):
                return {}
            target = target[int(token)]
        elif isinstance(target, dict) and token in target:
            target = target[token]
        else:
            return {}
    return target if isinstance(target, dict) else {}


def _reachable_schemas(
    schema, root=None, path: tuple = (), seen: frozenset = frozenset()
) -> list[tuple[tuple, dict]]:
    """Every object schema a declaration reaches, with the payload path to it.

    🔑 ONE walk, shared by the substance check (`_declared_sites`) and by the
    closed-door controls (`_closed_item_schemas`). They used to be two walks of
    different depths, and the shallower one fed
    `test_an_undeclared_key_inside_an_array_item_is_rejected` — the control this
    file singles out as the architecturally important one, because M1 was inside
    `items`. A closed `items` nested below the root was parametrised by nothing
    while the substance check happily saw it, so the two halves of the file
    disagreed about how deep a declaration goes and the shallower half was the one
    guarding M1's level.

    🔑 Follows every keyword in `_FOLLOWED_KEYWORDS`, not just `properties` and
    `items`. `Draft202012Validator` follows all of them, which is what made the
    old gap asymmetric: a `$ref`'d `additionalProperties: false` is enforced
    against a real client while being invisible here. Worse than invisible, in
    fact — `_stale_exemptions` measures "declared" over this walk, so a legitimate
    exemption for a `$ref`'d property was reported as a typo and the only way to
    satisfy the file was to delete a CORRECT entry. Phase 3's ~thirty declarations
    are built "from shared pieces" per `mcp_handler.py`'s own comment, so `$defs`
    plus `$ref` is the natural next step for deduplicating the persona sections.
    What it cannot follow is refused by name in
    `test_no_published_declaration_nests_through_a_keyword_the_walk_cannot_follow`
    rather than lost.

    Paths mark a descent through a container with `_ARRAY` or `_MAP` and name a
    key otherwise, so one flat tuple locates a site at any depth:
    `("personas", "[]", "identity")`. Containers are collapsed rather than indexed
    — element 0 carrying a key and element 1 not is a difference between rows, not
    between declarations, and the union across elements is what "some sample
    demonstrates this" means. `anyOf`/`allOf`/`oneOf` branches and a `$ref` target
    contribute at the SAME path as their parent, because they describe the same
    place in the payload.

    Tolerant throughout, and for the reason above: a boolean sub-schema, a
    non-dict `items`, a `properties` that is not a map, an unresolvable pointer —
    all legal or all harmless, and all simply contribute no site. `seen` carries
    the pointers already followed on this branch, so a self-referential `$defs`
    entry terminates instead of recursing forever.
    """
    if not isinstance(schema, dict):
        return []
    if root is None:
        root = schema

    found: list[tuple[tuple, dict]] = [(path, schema)]

    # Same place in the payload: a `$ref` target and each composition branch
    # describe the object at `path`, not one below it.
    ref = schema.get("$ref")
    if isinstance(ref, str) and ref not in seen:
        found += _reachable_schemas(
            _resolve_ref(ref, root), root, path, seen | {ref}
        )
    for keyword in ("anyOf", "allOf", "oneOf"):
        for branch in schema.get(keyword) or ():
            if isinstance(branch, dict):
                found += _reachable_schemas(branch, root, path, seen)

    for prop, sub in _subschemas(schema).items():
        found += _reachable_schemas(sub, root, path + (prop,), seen)

    # `items` and `prefixItems` both describe elements, and both collapse to the
    # same `_ARRAY` marker: a tuple-typed array's element 0 and element 1 are still
    # rows of one list as far as "some sample carries this key" is concerned.
    items = schema.get("items")
    if isinstance(items, dict):
        found += _reachable_schemas(items, root, path + (_ARRAY,), seen)
    for entry in schema.get("prefixItems") or ():
        if isinstance(entry, dict):
            found += _reachable_schemas(entry, root, path + (_ARRAY,), seen)

    # A schema-valued `additionalProperties` / `patternProperties` is a map whose
    # KEYS are data — `{"mapped": {"additionalProperties": {...}}}`. `False` and
    # `True` are the closure flags the other derivations read and nest nothing.
    for keyword in ("additionalProperties", "patternProperties"):
        declared = schema.get(keyword)
        if isinstance(declared, dict) and keyword == "additionalProperties":
            found += _reachable_schemas(declared, root, path + (_MAP,), seen)
        elif isinstance(declared, dict):
            for sub in declared.values():
                if isinstance(sub, dict):
                    found += _reachable_schemas(sub, root, path + (_MAP,), seen)
    return found


def _declared_sites(schema) -> dict[tuple, frozenset[str]]:
    """The properties declared at each payload path, unioned across branches.

    🔑 Built from `_reachable_schemas`, so the substance check stopping at the
    payload ROOT is closed at every depth and through every keyword the walk
    follows. Stopping at the root left the level this file's own architecture
    argument singles out unmeasured: a property declared inside a closed `items`
    could be demonstrated by no sample and still pass everything here, because
    item schemas declare no `required` and `additionalProperties: false`
    constrains only keys that are PRESENT. Verified by injecting an item-level
    property no route emits into a published declaration — 66 passed, in both
    `list_personas.personas` and `search_feedback.items`.

    Unioned rather than overwritten, because several branches can describe one
    path: an `allOf` of two object schemas declares the properties of both, and a
    `$ref` beside sibling keywords is legal in 2020-12.
    """
    sites: dict[tuple, frozenset[str]] = {}
    for path, sub in _reachable_schemas(schema):
        declared = frozenset(_subschemas(sub))
        if declared:
            sites[path] = sites.get(path, frozenset()) | declared
    return sites


def _located_objects(value, path: tuple, at: tuple = ()) -> list[tuple[tuple, dict]]:
    """Every object `path` reaches in `value`, with its CONCRETE payload path.

    The payload-side counterpart of `_reachable_schemas`, and the reason it
    returns concrete paths rather than only the objects: a control that mutates an
    element has to name where it mutated, so `_rejects_at` can be asked about that
    exact element instead of about the whole subtree. `("personas", "[]")` locates
    `("personas", 0)`.

    References into `value`, so a caller holding a deep copy can mutate through
    them. A path this payload does not reach contributes nothing rather than
    raising: a sample that does not reach a site is precisely the "no sample
    demonstrates it" finding, and it has to be reportable as a sentence rather
    than a `KeyError`.
    """
    if not path:
        return [(at, value)] if isinstance(value, dict) else []
    head, rest = path[0], path[1:]
    if head == _ARRAY:
        if not isinstance(value, list):
            return []
        return [
            found
            for index, element in enumerate(value)
            for found in _located_objects(element, rest, at + (index,))
        ]
    if head == _MAP:
        if not isinstance(value, dict):
            return []
        return [
            found
            for key, sub in value.items()
            for found in _located_objects(sub, rest, at + (key,))
        ]
    if not isinstance(value, dict) or head not in value:
        return []
    return _located_objects(value[head], rest, at + (head,))


def _keys_at(value, path: tuple) -> set[str]:
    """Every key some part of `value` carries at `path`, unioned across elements.

    A thin reading of `_located_objects`, so there is exactly ONE payload-side
    walk to keep in step with the schema-side one. Two would be the same
    "derivations disagree about depth" defect the schema side just had.
    """
    return {key for _at, obj in _located_objects(value, path) for key in obj}


def _dig(value, at: tuple):
    """The object at a CONCRETE payload path — real keys and indices, no markers.

    The counterpart of `_located_objects` for a caller that already knows where it
    is going: a control locates an element in the payload it validated, deep-copies
    that payload, and then has to reach the same element in the copy. Mutating the
    reference from the original instead would leave the payload the control
    asserted valid and the payload it asserted rejected as two different objects,
    which is the one thing every negative control here depends on not being true.
    """
    for key in at:
        value = value[key]
    return value


def _label(path: tuple, prop: str) -> str:
    """One declared property as a single string, `personas/[]/identity/bio`.

    A flat label rather than a `(path, prop)` pair so that
    `_PROPERTIES_NO_SAMPLE_CAN_SHOW` stays one namespace an exemption can name,
    and so `_stale_exemptions` can check an entry against the declarations and the
    samples without a second addressing scheme. A root property is its own name,
    unprefixed, which keeps every existing message reading the way it did.

    🔑 The namespace ASSUMES no declared property name contains `/`, and that
    `_ARRAY` / `_MAP` are not property names either. JSON Schema permits all
    three, and a property literally named `a/b` at the root produces the same
    label as property `b` inside object `a` — so one exemption would silence both
    declarations and `_stale_exemptions` could not tell a reader which. Escaping,
    or keeping the tuple and rendering it only for messages, would remove the
    ambiguity at the cost of a second addressing scheme in the one structure whose
    entire job is to be writable by hand. The trade is taken deliberately, and
    CHECKED rather than merely documented, by
    `test_no_published_declaration_uses_a_property_name_that_collides_with_a_label`
    — so the day a Phase 3 declaration uses a slash, this file says so instead of
    quietly conflating two properties.
    """
    return "/".join((*path, prop))


def _undemonstrated_labels(schema: dict, payloads: list, exempt=frozenset()) -> set[str]:
    """Declared properties, at ANY depth, that none of these payloads carries.

    🔑 Pure: a schema and a list of payloads in, labels out, with no reference to
    the live registry. That is what lets the item-level descent have a positive
    control over a schema and payloads the control OWNS
    (`test_the_substance_check_descends_into_array_items`), instead of one that can
    only be exercised by whatever the real projections happen to emit. The
    registry-driven requirement is the thin wrapper below.
    """
    missing: set[str] = set()
    for path, declared in _declared_sites(schema).items():
        seen: set[str] = set()
        for payload in payloads:
            seen |= _keys_at(payload, path)
        for prop in declared - seen:
            label = _label(path, prop)
            if label not in exempt:
                missing.add(label)
    return missing


def _undemonstrated_properties(tool: str, registry: dict) -> set[str]:
    """Declared properties that no sample payload for `tool` carries.

    🔑 The substance half of the completeness check, and it exists because the
    presence half counts ENTRIES rather than evidence. Both metrics tools end at
    `ToolResult(body if isinstance(body, dict) else {})` and declare no
    `required`, so a route body of `{}` is a fully SUCCESSFUL call producing
    `structuredContent: {}` — which validates against an open schema, satisfies
    `_payload`'s error checks, and turns `-NO-SAMPLE` green while demonstrating
    nothing. Replacing only those two tools' bodies with `{}` left all 52 cases
    passing before this function existed.

    Union across a tool's cases rather than per-case, because the cases exist
    precisely to cover different branches: `get_metrics_breakdown`'s `sentiment`
    dimension cannot carry `categories`, and demanding every case show every
    property would be demanding one route answer with another's fields.

    A property whose absence is legitimate goes in
    `_PROPERTIES_NO_SAMPLE_CAN_SHOW` with a reason, so the exemption is a line of
    the diff rather than a silence.
    """
    return _undemonstrated_labels(
        _output_schema(tool),
        _sample_payloads(tool, registry),
        _PROPERTIES_NO_SAMPLE_CAN_SHOW.get(tool, frozenset()),
    )


def _sample_payloads(tool: str, registry: dict) -> list[dict]:
    """Every payload this tool's registered cases produce, in registry order."""
    return [
        _payload(tool, arguments, bodies)
        for _case, arguments, bodies in registry.get(tool) or ()
    ]


def _declared_properties(tool: str) -> set[str]:
    """Every property this tool declares, at any depth, as a label."""
    return {
        _label(path, prop)
        for path, declared in _declared_sites(_output_schema(tool)).items()
        for prop in declared
    }


def _demonstrated_properties(tool: str, registry: dict) -> set[str]:
    """Every declared property the union of this tool's sample payloads carries.

    Split out of `_undemonstrated_properties` so the staleness check for
    `_PROPERTIES_NO_SAMPLE_CAN_SHOW` measures demonstration the SAME way the
    requirement does. Two independent notions of "demonstrated" would let an
    exemption be simultaneously necessary and stale, which is a contradiction no
    reader could act on.

    Restricted to DECLARED labels, because that is the vocabulary an exemption is
    written in: a payload key at a site the schema does not describe is not
    something anyone could exempt, and reporting it would make the staleness
    check's "a sample demonstrates this anyway" finding unactionable.
    """
    payloads = _sample_payloads(tool, registry)
    schema = _output_schema(tool)
    demonstrated: set[str] = set()
    for path, declared in _declared_sites(schema).items():
        seen: set[str] = set()
        for payload in payloads:
            seen |= _keys_at(payload, path)
        demonstrated |= {_label(path, prop) for prop in declared & seen}
    return demonstrated


def _stale_exemptions(exemptions: dict, registry: dict) -> list[str]:
    """Every way an entry in an exemption allowlist has stopped being true.

    🔑 A FUNCTION, taking the allowlist as an argument, for the same reason
    `_tools_missing_samples` is one: a check on an empty dict passes trivially
    whether or not it can detect anything, so its own positive control has to be
    able to hand it entries that ARE stale
    (`test_the_staleness_check_notices_each_way_an_exemption_can_go_stale`).

    Returns prose rather than raising, so one run reports every stale entry
    instead of the first.
    """
    findings: list[str] = []
    for tool in sorted(exemptions):
        properties = exemptions[tool]
        if tool not in _PUBLISHED_TOOL_NAMES:
            findings.append(
                f"{tool} is exempted from the substance check and is not a "
                f"published tool; the exemption protects nothing. Remove it, or "
                f"correct the name to one of {sorted(_PUBLISHED_TOOL_NAMES)}."
            )
            # No schema and no samples to compare against, so the two checks
            # below would only add noise about a name that does not exist.
            continue

        # Every declared label, at any depth, because an exemption may name an
        # item-level or nested property — `personas/[]/identity/bio` — now that the
        # requirement descends there. Measuring "declared" only at the root would
        # report every legitimate nested exemption as a typo.
        declared = _declared_properties(tool)
        undeclared = sorted(set(properties) - declared)
        if undeclared:
            findings.append(
                f"{tool} exempts {undeclared}, which its outputSchema does not "
                "declare — a typo, or a declaration that was renamed. The "
                "exemption reads as though it protects something and does not."
            )

        # The `xfail(strict=True)` equivalent: an exemption that has become
        # unnecessary must say so rather than persist. Left in place, it silently
        # suppresses a real requirement the day the sample stops producing the
        # property.
        unnecessary = sorted(
            set(properties) & _demonstrated_properties(tool, registry)
        )
        if unnecessary:
            findings.append(
                f"{tool} exempts {unnecessary} from the substance check and a "
                "registered sample demonstrates them anyway; the exemption is no "
                "longer needed and should be deleted."
            )
    return findings


def _closed_item_schemas() -> list[tuple[str, tuple]]:
    """`(tool, path)` for every ELEMENT schema that closes the door, at any depth.

    Needed one level down from `_closed_schema_tools` for the reason this file
    singles out: M1 lived inside `items`, so the nested closure is the
    architecturally important one to control, and the top-level control cannot
    reach it — merging a key into the payload root never touches an element of an
    array.

    🔑 Derived from `_reachable_schemas`, at ANY depth, not from a second walk of
    root-level `properties`. The shallow version reported only arrays declared at
    the payload root, so a closed `items` inside another array's item schema — or
    inside a nested object — was parametrised by nothing, while
    `_declared_sites` saw it perfectly well. That is the same "a derivation that
    stops short produces silence" defect the substance check had one round
    earlier, in the sibling derivation feeding the control that argument is
    about. Confirmed reachable through production code: a closed nested array
    added to `_PERSONA_PROPERTIES` gave one substance-check failure and ZERO from
    this control, which did not know the array existed; populated, both were
    silent.

    Keyed by the same `_ARRAY`-marked path the substance check uses, so the two
    halves of the file cannot drift back into disagreeing about depth. `type:
    array` is deliberately NOT required: `{"items": {...}}` with no `type` still
    constrains elements, and a validator enforces it.
    """
    found = []
    for name in _PUBLISHED_TOOL_NAMES:
        for path, sub in _reachable_schemas(_output_schema(name)):
            # `_reachable_schemas` already dropped a boolean `items`, which is
            # legal (`{"items": true}`) and closes nothing.
            if path and path[-1] == _ARRAY and sub.get("additionalProperties") is False:
                found.append((name, path))
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

        🔑 A set DIFFERENCE against the unthinned registry, not
        `== [victim]`. Exact equality made this control fail whenever some OTHER
        tool was also missing a sample — `assert ['get_feedback_detail',
        'search_feedback'] == ['search_feedback']` — so the control failed
        alongside the very thing it controls and could not say which of the two
        broke. That is the same reasoning `_rejects_at` needed its own positive
        control for: a control must be sensitive to its own subject and to
        nothing else.
        """
        victim = _PUBLISHED_TOOL_NAMES[0]
        already = set(_tools_missing_samples(_TOOL_SAMPLES))
        thinned = {k: v for k, v in _TOOL_SAMPLES.items() if k != victim}

        assert set(_tools_missing_samples(thinned)) - already == {victim}
        # An empty entry is as useless as an absent one and must read the same.
        assert set(
            _tools_missing_samples({**_TOOL_SAMPLES, victim: ()})
        ) - already == {victim}

    @pytest.mark.parametrize("tool", _PUBLISHED_TOOL_NAMES)
    def test_every_declared_property_is_demonstrated_by_some_sample(self, tool):
        """A registered sample must EXERCISE the declaration, not merely exist.

        🔑 The presence check above is satisfied by a dict key. For a tool with an
        open schema and no `required` — which is both metrics tools, and the
        archetype for Phase 3's pass-through tools — a route body of `{}` yields a
        successful call with `structuredContent: {}` that validates, so every
        assertion in this file passes while nothing about the declaration was
        tested. Emptying only those two tools' bodies left 52/52 green.

        Requiring every declared property to appear in the union of a tool's
        payloads is what makes the registry un-gameable: a `{}` body now names the
        seven properties it failed to show.

        🔑 At EVERY depth, not just the payload root. Measuring only top-level
        `properties` left the level this file's own architecture argument singles
        out unmeasured: an item-level declaration could be demonstrated by no
        sample and still pass everything here, because item schemas declare no
        `required` and `additionalProperties: false` constrains only keys that are
        present. Injecting `nested_prop_no_route_emits` into
        `list_personas.personas.items.properties` used to leave 66 passing; it is
        now reported as `personas/[]/nested_prop_no_route_emits`.
        """
        undemonstrated = _undemonstrated_properties(tool, _TOOL_SAMPLES)

        assert undemonstrated == set(), (
            f"{tool} declares {sorted(undemonstrated)} and no registered sample "
            "produces them, so nothing here validates those declarations. A label "
            "like personas/[]/identity/bio is a property declared inside an array "
            "item. Give the sample a route body that carries them — or, if a real "
            "answer genuinely cannot, add them to _PROPERTIES_NO_SAMPLE_CAN_SHOW "
            "with the reason."
        )

    def test_the_substance_check_measures_below_the_payload_root(self):
        """Anti-vacuity for the descent: the requirement above must reach an
        item schema, not merely be capable of it.

        🔑 `_declared_sites` returning only the root — the behaviour this round
        replaced — would satisfy every case of the requirement above while leaving
        26 item-level and nested declarations unmeasured, which is the silence the
        finding was about. The requirement passing cannot distinguish "descends and
        finds everything demonstrated" from "does not descend", so the derivation
        is asserted to reach depth directly.

        Derived, not named: it asks whether SOME published tool declares properties
        below the root, and says to delete the control if that ever stops being
        true. Hardcoding `list_personas` would go stale in the silent direction the
        moment the persona item schema were flattened.
        """
        deep = {
            tool: sorted(
                path for path in _declared_sites(_output_schema(tool)) if path
            )
            for tool in _PUBLISHED_TOOL_NAMES
        }
        with_depth = {tool: paths for tool, paths in deep.items() if paths}

        assert with_depth, (
            "no published tool declares any property below the payload root, so "
            "the descent this control is about covers nothing; if the declarations "
            "are genuinely all flat now, delete this control and say so"
        )
        assert any(
            "[]" in path for paths in with_depth.values() for path in paths
        ), (
            "no published declaration nests properties inside an array item — the "
            f"level M1 lived at. Sites found: {with_depth}"
        )

    def test_the_substance_check_measures_through_every_keyword_that_nests_a_schema(self):
        """The descent must follow `$ref` and the composition keywords, not only
        `properties` and `items`.

        🔑 `Draft202012Validator` follows all of them, which is what made the old
        gap asymmetric rather than merely incomplete: a `$ref`'d
        `additionalProperties: false` is enforced against a real client while being
        invisible here, so the declaration's first check would be a client's —
        exactly M1. Worse, `_stale_exemptions` measures "declared" over this walk,
        so a legitimate exemption for a `$ref`'d property was reported as a typo and
        the only way to satisfy the file was to delete a CORRECT entry.

        Over a schema this control owns, and `check_schema`'d first so it cannot
        pass because the constructs are nonsense. No published declaration uses any
        of them today — Phase 3's ~thirty, built "from shared pieces" per
        `mcp_handler.py`'s own comment, are where `$defs` plus `$ref` is the natural
        way to deduplicate the persona sections.
        """
        schema = {
            "type": "object",
            "$defs": {"Row": {"type": "object", "properties": {"via_ref": {"type": "string"}}}},
            "properties": {
                "rows": {"type": "array", "items": {"$ref": "#/$defs/Row"}},
                "either": {"anyOf": [{"type": "object", "properties": {"via_anyof": {}}}]},
                "merged": {"allOf": [{"type": "object", "properties": {"via_allof": {}}}]},
                "one": {"oneOf": [{"type": "object", "properties": {"via_oneof": {}}}]},
                "tuples": {
                    "type": "array",
                    "prefixItems": [{"type": "object", "properties": {"via_prefix": {}}}],
                },
                "mapped": {
                    "type": "object",
                    "additionalProperties": {
                        "type": "object", "properties": {"via_ap": {}},
                    },
                },
                "patterned": {
                    "type": "object",
                    "patternProperties": {
                        "^x": {"type": "object", "properties": {"via_pp": {}}},
                    },
                },
            },
        }
        Draft202012Validator.check_schema(schema)

        # Every one of the seven is measured: an empty payload demonstrates none of
        # them, and each must be REPORTED rather than silently unmeasured.
        reported = _undemonstrated_labels(schema, [{}])
        for label in (
            "rows/[]/via_ref", "either/via_anyof", "merged/via_allof", "one/via_oneof",
            "tuples/[]/via_prefix", "mapped/{}/via_ap", "patterned/{}/via_pp",
        ):
            assert label in reported, (
                f"{label} is declared and no payload demonstrates it, and the walk "
                f"did not report it — a client's validator enforces it. Got: "
                f"{sorted(reported)}"
            )

        # And the other direction, or a walk that reported every conceivable label
        # would satisfy the loop above: a payload that really does carry them must
        # be credited, at each marker.
        populated = {
            "rows": [{"via_ref": "a"}],
            "either": {"via_anyof": 1},
            "merged": {"via_allof": 1},
            "one": {"via_oneof": 1},
            "tuples": [{"via_prefix": 1}],
            "mapped": {"any_key": {"via_ap": 1}},
            "patterned": {"xkey": {"via_pp": 1}},
        }
        assert _undemonstrated_labels(schema, [populated]) == set(), (
            "a payload carrying every declared property was still reported as "
            f"demonstrating some of them: {sorted(_undemonstrated_labels(schema, [populated]))}"
        )

    def test_a_self_referential_declaration_does_not_hang_the_walk(self):
        """A `$defs` entry that refers to itself is legal and describes a tree.

        The walk follows `$ref`, so without a visited set a recursive declaration
        recurses until the interpreter stops it — and because the walk runs inside a
        `@pytest.mark.parametrize` decorator, that is a `RecursionError` at import
        aborting collection of the whole `lambda/api` suite, which is the failure
        class this file has a test class for.
        """
        schema = {
            "type": "object",
            "$defs": {"Node": {
                "type": "object",
                "properties": {
                    "value": {"type": "string"},
                    "children": {"type": "array", "items": {"$ref": "#/$defs/Node"}},
                },
            }},
            "properties": {"root": {"$ref": "#/$defs/Node"}},
        }
        Draft202012Validator.check_schema(schema)

        sites = _declared_sites(schema)

        assert sites[("root",)] == frozenset({"value", "children"}), sites
        assert "root/value" in _undemonstrated_labels(schema, [{}])

    def test_no_published_declaration_nests_through_a_keyword_the_walk_cannot_follow(self):
        """What the walk cannot follow is REFUSED, not silently unmeasured.

        🔑 `contains`, `if`/`then`, `not`, `propertyNames`, `dependentSchemas` and
        the `unevaluated*` keywords nest a schema at no single payload path a label
        could name — a conditional or negated shape has no "the property lives
        here", and `contains` matches an unknown subset of elements. So the walk
        does not follow them, and rather than leave that as the silence this whole
        round was about, a declaration using one fails HERE with the tool and the
        keyword. A Phase 3 author is then told to teach the derivation, which is the
        actionable version of "your declaration is measured by nothing".

        Derived from `_UNFOLLOWED_KEYWORDS` and the live registry, so adding support
        for one is a single edit to that tuple rather than to a test.
        """
        findings = []
        for name in _PUBLISHED_TOOL_NAMES:
            for path, sub in _reachable_schemas(_output_schema(name)):
                used = sorted(k for k in _UNFOLLOWED_KEYWORDS if k in sub)
                if used:
                    findings.append(f"{name} at {'/'.join(path) or '<root>'}: {used}")

        assert findings == [], (
            "these declarations nest a schema through a keyword _reachable_schemas "
            "does not follow, so the properties beneath it are measured by nothing "
            "here while a client's validator enforces them:\n"
            + "\n".join(f"  • {f}" for f in findings)
            + "\nTeach _reachable_schemas to follow it (and give it a path marker "
            "the way `[]` and `{}` are), or restate the declaration in terms of "
            f"{list(_FOLLOWED_KEYWORDS)}."
        )

    def test_no_published_declaration_uses_a_property_name_that_collides_with_a_label(self):
        """`_label`'s flat namespace assumes no property name contains `/`.

        🔑 The assumption CHECKED rather than only documented, which is the
        treatment this file gives its other deliberate limitations. A property
        literally named `a/b` at the root produces the same label as property `b`
        inside object `a`, so one `_PROPERTIES_NO_SAMPLE_CAN_SHOW` entry would
        silence two declarations and `_stale_exemptions` could not tell a reader
        which. JSON Schema permits the name; nothing declares one today, and the
        trade — a flat namespace an exemption can be written by hand, over escaping
        or a second addressing scheme — is taken deliberately.

        The two path markers are reserved for the same reason: a property named
        `[]` would be indistinguishable from a descent through an array.
        """
        collisions = []
        for name in _PUBLISHED_TOOL_NAMES:
            for path, sub in _reachable_schemas(_output_schema(name)):
                for prop in _subschemas(sub):
                    if "/" in prop or prop in (_ARRAY, _MAP):
                        collisions.append(
                            f"{name} declares {prop!r} at {'/'.join(path) or '<root>'}"
                        )

        assert collisions == [], (
            "these property names collide with the label namespace "
            "_PROPERTIES_NO_SAMPLE_CAN_SHOW is written in, so an exemption could "
            "not name one unambiguously:\n"
            + "\n".join(f"  • {c}" for c in collisions)
            + f"\nA name containing '/' is ambiguous with a nested path, and "
            f"{_ARRAY!r}/{_MAP!r} are the markers for a descent through a "
            "container. Either rename the property, or give _label an escaping "
            "scheme and say why it became worth the second addressing scheme."
        )

    def test_the_substance_check_notices_a_sample_that_demonstrates_nothing(self):
        """The positive control for the check above — the same shape of mutation
        that used to pass unnoticed.

        A registry whose route bodies are all `{}` is the exact loophole: the call
        succeeds, the payload is empty, and only a substance check objects. If
        `_undemonstrated_properties` were reduced to `return set()`, this is the
        one test that fails.
        """
        # An open schema with no `required`, so `{}` really is a valid payload —
        # a closed-schema tool would fail for the unrelated reason that its
        # projection cannot produce `{}`.
        victim = next(
            (
                name for name in _PUBLISHED_TOOL_NAMES
                if _output_schema(name).get("additionalProperties") is not False
                and not _output_schema(name).get("required")
                and _subschemas(_output_schema(name))
                and _TOOL_SAMPLES.get(name)
            ),
            None,
        )
        assert victim, (
            "no published tool has an open, unrequired schema, so the `{}`-body "
            "loophole this control is about no longer exists; delete it and say so"
        )

        case, arguments, bodies = _first_sample(victim)
        # A distinct dict per route: `dict.fromkeys(bodies, {})` would share one
        # object across every route, which `_FakeLambda` could mutate through.
        hollowed = {
            **_TOOL_SAMPLES,
            victim: ((case, arguments, {route: {} for route in bodies}),),
        }

        assert _undemonstrated_properties(victim, _TOOL_SAMPLES) == set()
        assert _undemonstrated_properties(victim, hollowed), (
            f"{victim}'s sample was reduced to an empty route body and the "
            "substance check still found every declared property demonstrated"
        )

    def test_the_substance_check_descends_into_array_items(self):
        """The positive control for the descent: hollow an array ELEMENT and the
        check must name the item properties it no longer demonstrates.

        🔑 Over a schema and payloads this control OWNS, rather than through the
        registry. The registry-driven version could only be exercised by whatever
        the real projections happen to emit — and the projections fill every
        declared item key unconditionally, so no route body can produce an element
        missing one. A control that cannot construct its own negative case is a
        control that reports whatever the production code already does, which is
        the opposite of the point.

        Two directions, because a check that descends but never returns is as
        useless as one that never descends: a populated element must be measured
        as demonstrating its keys, and a hollow one must be reported by name. The
        second is what fails if `_declared_sites` is reverted to the root only.
        """
        schema = {
            "type": "object",
            "properties": {
                "rows": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "additionalProperties": False,
                        "properties": {
                            "shown": {"type": "string"},
                            "unshown": {"type": "string"},
                            "nested": {
                                "type": "object",
                                "properties": {"deep": {"type": "string"}},
                            },
                        },
                    },
                },
            },
        }
        # Legal, so the control cannot pass because the schema is nonsense.
        Draft202012Validator.check_schema(schema)

        populated = {"rows": [{"shown": "a", "nested": {"deep": "d"}}]}
        assert _undemonstrated_labels(schema, [populated]) == {"rows/[]/unshown"}, (
            "the descent misreported a populated element; it must credit the keys "
            "an element carries and report only the ones it does not"
        )

        # A hollow element loses `nested/deep` too: a site no payload reaches
        # demonstrates nothing beneath it either, which is the reporting a reader
        # needs — "this whole subtree is unsampled", not just its topmost key.
        hollow = {"rows": [{}]}
        assert _undemonstrated_labels(schema, [hollow]) == {
            "rows/[]/shown", "rows/[]/unshown", "rows/[]/nested", "rows/[]/nested/deep",
        }, "an element hollowed to {} was still counted as demonstrating its keys"

        # And the exemption vocabulary has to be able to name a nested label,
        # otherwise a legitimate item-level exemption is unwritable.
        assert _undemonstrated_labels(
            schema, [populated], frozenset({"rows/[]/unshown"})
        ) == set()

        # An empty array demonstrates nothing inside it, which is why the
        # empty-project cases cannot satisfy the requirement on their own.
        assert _undemonstrated_labels(schema, [{"rows": []}]) == {
            "rows/[]/shown", "rows/[]/unshown", "rows/[]/nested", "rows/[]/nested/deep",
        }

    def test_no_exemption_from_the_substance_check_has_gone_stale(self):
        """An exemption may not outlive its reason.

        🔑 The one direction this file otherwise always checks, applied to the
        allowlist — the structure where a stale entry costs the most, because its
        whole function is to remove a declaration from the checked set. All three
        stale forms were silent: an entry for a property a sample DOES demonstrate,
        an entry for a property no schema declares, and an entry for a tool that is
        no longer published. The third is the exact condition
        `test_the_registry_holds_no_sample_for_a_tool_that_is_not_published`
        exists to catch for `_TOOL_SAMPLES`; the first is the
        `pytest.mark.xfail(strict=True)` reasoning the module docstring gives —
        the day an exemption becomes unnecessary, it says so.

        Passes trivially while the dict is empty, which is why it is cheap to add
        now: the first entry anyone writes is checked from the moment it lands,
        rather than after someone remembers to come back for it.
        """
        stale = _stale_exemptions(_PROPERTIES_NO_SAMPLE_CAN_SHOW, _TOOL_SAMPLES)

        assert stale == [], "stale entries in _PROPERTIES_NO_SAMPLE_CAN_SHOW:\n" + "\n".join(
            f"  • {finding}" for finding in stale
        )

    def test_the_staleness_check_notices_each_way_an_exemption_can_go_stale(self):
        """The positive control for the check above, one assertion per stale form.

        🔑 The check runs against an EMPTY dict in real life, so it passes whether
        or not it can detect anything — the precise shape of vacuity
        `_tools_missing_samples` needed a control for. Each form is asserted
        separately rather than by handing over one dict with all three: a single
        combined assertion passes while two of the three detections are broken.
        """
        published = _PUBLISHED_TOOL_NAMES[0]
        # Declared AND demonstrated, so an exemption naming it is stale for the
        # "no longer necessary" reason ONLY — an undeclared payload key would also
        # trip the "not declared" finding and the two would be indistinguishable.
        demonstrated = sorted(
            set(_subschemas(_output_schema(published)))
            & _demonstrated_properties(published, _TOOL_SAMPLES)
        )
        assert demonstrated, (
            f"{published} demonstrates no declared property at all, so this control "
            "cannot construct an unnecessary exemption; the substance check is the "
            "authoritative report of that"
        )

        # 1. An exemption for a tool that is not published.
        renamed = _stale_exemptions(
            {"a_tool_that_was_renamed_away": frozenset({"whatever"})}, _TOOL_SAMPLES
        )
        assert any("a_tool_that_was_renamed_away" in f for f in renamed), renamed

        # 2. An exemption for a property no schema declares.
        undeclared = _stale_exemptions(
            {published: frozenset({"a_property_that_does_not_exist"})}, _TOOL_SAMPLES
        )
        assert any("a_property_that_does_not_exist" in f for f in undeclared), undeclared

        # 3. An exemption that has become unnecessary, which is the form a
        #    reviewer is least likely to notice by reading: the entry names a real
        #    property of a real tool, and only comparing it against what the
        #    samples actually produce shows it is dead weight.
        unnecessary = _stale_exemptions(
            {published: frozenset({demonstrated[0]})}, _TOOL_SAMPLES
        )
        assert any(demonstrated[0] in f for f in unnecessary), unnecessary

        # And it must stay SILENT about an exemption that is still doing work. A
        # check rewritten to report every entry would satisfy all three assertions
        # above while making the allowlist unusable — the mirror of the `return
        # True` failure mode `_rejects_at` needed its own control for.
        #
        # Every declared property is demonstrated today, so an exemption that is
        # still necessary has to be constructed: with no samples registered for the
        # tool, nothing is demonstrated, and an exemption for a property its schema
        # really declares is exactly the entry the allowlist is for.
        still_needed = _stale_exemptions(
            {published: frozenset({demonstrated[0]})}, {**_TOOL_SAMPLES, published: ()}
        )
        assert still_needed == [], (
            "the staleness check objected to an exemption that is still doing "
            f"work, so no entry could ever survive it: {still_needed}"
        )


class TestTheDerivationsSurviveAnUnusualDeclaration:
    """Nothing read at import time may raise on a declaration a client accepts.

    🔑 `_closed_schema_tools()`, `_closed_item_schemas()` and `_TOOL_SAMPLES` are
    all read inside `@pytest.mark.parametrize` decorators, so anything they raise
    is a COLLECTION error: every test in `lambda/api` aborts, attributed to
    whatever ran next, and no pull-request gate would report it (the one workflow
    runs a single stdlib-only file). The scope is named rather than counted on
    purpose — the count drifts on nearly every PR, and a number a reader can see is
    wrong invites them to discount the argument it is making, which is that a
    collection error is a different KIND of event from a test failure. Three
    declarations did exactly that —

      • no `outputSchema` at all → `KeyError: 'outputSchema'`, in place of
        `test_every_tool_declares_what_section_5_4_requires`'s precise
        `f"{name} declares no outputSchema"`, which never got to run;
      • a BOOLEAN sub-schema, which Draft 2020-12 permits and
        `check_schema` accepts → `AttributeError: 'bool' object has no
        attribute 'get'`, i.e. this file crashing on a schema it also certifies;
      • a renamed key in the delegation suite's persona fixture, which the
        samples used to SUBSCRIPT → `KeyError: 'identity'`. Same class and same
        radius, reached from a fixture rather than a declaration, and the one
        instance where the raising code was this file's own samples.

    — so the file's own primary anticipated failure mode degraded into the least
    diagnostic signal available. These tests keep the degradation graceful, which
    is what leaves the §5.4 test and the substance check as the named reporters.
    """

    def test_a_tool_declaring_no_output_schema_reads_as_an_empty_schema(self, monkeypatch):
        """No raise, and no false claim that the tool closes anything."""
        published = [dict(tool) for tool in mcp_handler.MCP_TOOLS]
        published[0].pop("outputSchema", None)
        monkeypatch.setattr(mcp_handler, "MCP_TOOLS", published)

        assert _output_schema(published[0]["name"]) == {}
        assert published[0]["name"] not in _closed_schema_tools()
        assert all(name != published[0]["name"] for name, _ in _closed_item_schemas())

    def test_a_tool_whose_output_schema_is_not_a_dict_reads_as_an_empty_schema(
        self, monkeypatch
    ):
        """`"outputSchema": None` was the same abort with a different exception."""
        published = [dict(tool) for tool in mcp_handler.MCP_TOOLS]
        published[0]["outputSchema"] = None
        monkeypatch.setattr(mcp_handler, "MCP_TOOLS", published)

        assert _output_schema(published[0]["name"]) == {}
        assert published[0]["name"] not in _closed_schema_tools()

    def test_a_boolean_sub_schema_is_skipped_rather_than_crashing_the_derivation(
        self, monkeypatch
    ):
        """`{"properties": {"x": true}}` is legal, means "anything", closes nothing.

        Asserted to be legal here rather than assumed, so the test says WHY the
        derivation has to tolerate it: `check_schema` accepting the declaration is
        the whole reason a crash on it is this file's bug and not the tool's.
        """
        published = [copy.deepcopy(tool) for tool in mcp_handler.MCP_TOOLS]
        published[0]["outputSchema"] = {
            "type": "object",
            "properties": {"anything": True, "nothing": False},
        }
        Draft202012Validator.check_schema(published[0]["outputSchema"])
        monkeypatch.setattr(mcp_handler, "MCP_TOOLS", published)

        assert _subschemas(published[0]["outputSchema"]) == {}
        # The assertion that matters: no AttributeError at what would be import.
        assert all(name != published[0]["name"] for name, _ in _closed_item_schemas())

    def test_a_boolean_items_schema_is_skipped_rather_than_crashing_the_derivation(
        self, monkeypatch
    ):
        """`{"items": true}` is the same construct one level down, and it closes
        no door either — so the array must simply not be reported as closed."""
        published = [copy.deepcopy(tool) for tool in mcp_handler.MCP_TOOLS]
        published[0]["outputSchema"] = {
            "type": "object",
            "properties": {"rows": {"type": "array", "items": True}},
        }
        Draft202012Validator.check_schema(published[0]["outputSchema"])
        monkeypatch.setattr(mcp_handler, "MCP_TOOLS", published)

        assert all(name != published[0]["name"] for name, _ in _closed_item_schemas())

    def test_the_imported_persona_fixture_still_carries_the_sections_this_sample_extends(
        self,
    ):
        """The fixture coupling reported as an assertion, not a `KeyError`.

        🔑 `_TOOL_SAMPLES` spreads `_GENERATED_PERSONA`'s section dicts, and it is
        a MODULE-LEVEL dict read inside a `@pytest.mark.parametrize` decorator, so
        a subscript there evaluates at import: `_GENERATED_PERSONA["identity"]`
        raised `KeyError: 'identity'` when that key was renamed in
        `test_mcp_delegation.py` and took the whole `lambda/api` suite to zero
        collected tests, with the bare `KeyError` as the entire diagnostic. Same
        class and same blast radius as the round-two `KeyError: 'outputSchema'`,
        reached from a fixture rather than a declaration.

        The samples now use `.get(section, {})`, so the rename degrades into
        `test_every_declared_property_is_demonstrated_by_some_sample` naming the
        properties no sample produces any more — which is the better signal, and
        the outcome the round-two fix was designed for. This test is the one that
        says WHY those fields went missing, so a reader is pointed at the fixture's
        owner instead of at this file's samples.

        Derived from the registry, not from a list of four names: it asks which
        canonical persona sections the sample writes as objects and requires the
        fixture to still carry each. A hardcoded list would go stale in the silent
        direction the moment a fifth section were spread in.
        """
        extended = {
            key
            for _case, _arguments, bodies in _TOOL_SAMPLES.get("list_personas") or ()
            for body in bodies.values()
            for persona in body.get("personas") or ()
            for key, value in persona.items()
            if key in mcp_handler._PERSONA_SECTIONS and isinstance(value, dict)
        }
        assert extended, (
            "no registered list_personas sample writes a canonical persona section "
            "as an object, so this control has no coupling to check; if the samples "
            "no longer spread the delegation suite's fixture, delete it and say so"
        )

        missing = sorted(section for section in extended if section not in _GENERATED_PERSONA)
        assert missing == [], (
            f"_GENERATED_PERSONA no longer carries {missing}, which this file's "
            "samples extend to demonstrate the canonical persona fields. The "
            "fixture is owned by api/test/test_mcp_delegation.py, which cannot "
            "know these keys are load-bearing for a second suite — so if a section "
            "was renamed there, rename it in _TOOL_SAMPLES too. The samples use "
            "`.get(section, {})` precisely so this reads as a failure here and in "
            "test_every_declared_property_is_demonstrated_by_some_sample, rather "
            "than as a KeyError that aborts collection of the whole lambda/api "
            "suite."
        )

    def test_the_derivations_still_find_the_real_closures(self):
        """The positive control for all four above.

        `_output_schema` returning `{}` unconditionally, or `_subschemas`
        returning `{}` unconditionally, would satisfy every test in this class
        while making the whole file vacuous — an empty schema validates every
        payload. So the tolerant path must be shown NOT to be the only path.
        """
        assert _closed_schema_tools(), "the closed-schema derivation found nothing"
        assert _closed_item_schemas(), "the closed-items derivation found nothing"
        assert all(
            _subschemas(_output_schema(name)) for name in _closed_schema_tools()
        ), "a closed schema declared no usable properties"


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
        case, arguments, bodies = _first_sample(tool)
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

    def test_the_closed_item_derivation_can_find_a_closure_below_the_payload_root(
        self, monkeypatch
    ):
        """Anti-vacuity for the DEPTH of the derivation above, not just its size.

        🔑 `test_some_array_closes_its_item_schema` is satisfied by one closure at
        the payload root, so it passed throughout the round in which this
        derivation walked root-level `properties` only — "finds nothing deep" read
        as "there is nothing deep". Every published closure happens to be at the
        root today, so the capability is asserted directly instead: a closed
        `items` nested inside another array's item schema must be FOUND.

        🔑 Through `_closed_item_schemas()` ITSELF, over a substituted registry —
        not by re-implementing its filter over `_reachable_schemas`. Written the
        second way first, and reverting the derivation to its old root-only walk
        then left all 75 tests passing: the control was exercising the shared walk,
        which the substance check already proves is deep, while the derivation that
        actually feeds the parametrisation went unmeasured. A control has to call
        the function whose depth it claims to be about.

        The registry is substituted rather than a published declaration used,
        because no published declaration nests a closure today — the same reason
        `test_the_substance_check_descends_into_array_items` owns its schema.
        """
        nested = {
            "type": "object", "additionalProperties": False,
            "properties": {"groups": {"type": "array", "items": {
                "type": "object", "additionalProperties": False,
                "properties": {"rows": {"type": "array", "items": {
                    "type": "object", "additionalProperties": False,
                    "properties": {"a": {"type": "string"}},
                }}},
            }}},
        }
        Draft202012Validator.check_schema(nested)

        published = [copy.deepcopy(tool) for tool in mcp_handler.MCP_TOOLS]
        published[0]["outputSchema"] = nested
        monkeypatch.setattr(mcp_handler, "MCP_TOOLS", published)

        found = [
            path for name, path in _closed_item_schemas()
            if name == published[0]["name"]
        ]

        assert ("groups", _ARRAY) in found, found
        assert ("groups", _ARRAY, "rows", _ARRAY) in found, (
            "a closed item schema nested below the payload root was not "
            "parametrised, so no undeclared-key control covers it — the level M1 "
            f"lived at. Found: {found}"
        )

    @pytest.mark.parametrize(
        "tool,path", _closed_item_schemas(), ids=lambda p: p if isinstance(p, str) else "/".join(p)
    )
    def test_an_undeclared_key_inside_an_array_item_is_rejected(self, tool, path):
        """The nested half of the closed-door control, one level DOWN.

        🔑 Architecturally the more important of the two, because M1 was inside
        `items`: a client's validator descends there, and a validator of ours that
        did not would pass exactly the declarations that are wrong. The top-level
        control cannot reach this — merging a key into the payload root never
        touches an element of an array.

        🔑 Mutates the element at the DERIVED path, at any depth, rather than
        `payload[prop][0]`. The derivation used to see only root-level arrays, so a
        closure nested below the root was covered by nothing; keying on the path
        `_reachable_schemas` produced is what keeps this control's reach equal to
        the derivation's.

        Not reachable from a route body today, and that is itself the thing worth
        pinning: the projections whitelist item keys, so an unrecognised field on
        a route's row is dropped before it reaches the payload (asserted by
        `test_an_unrecognised_key_on_a_route_row_is_not_forwarded`). A projection
        that started forwarding unknown keys would break every validating client;
        this control is what says the declaration forbids it.

        🔑 Whichever case reaches the path, not case zero. Only one of
        `get_project`'s three cases populates `documents`, so making the
        empty-project case first — a reordering that reads as cosmetic — used to
        break this. `_payload_reaching` searches instead, and reports "none of the
        N samples reaches it" when that is genuinely true, which is the condition
        worth failing on.
        """
        schema = _output_schema(tool)
        label = "/".join(path)
        payload, at, _element = _payload_reaching(tool, path)

        assert _errors(payload, schema) == [], f"{tool} does not validate to begin with"

        broken = copy.deepcopy(payload)
        # Dug out of the COPY: the element `_payload_reaching` returned references
        # the original, and mutating that would leave the payload this control
        # asserted valid and the payload it asserts is rejected as one object.
        _dig(broken, at)["a_field_no_one_declared"] = 1

        assert _rejects_at(broken, schema, at), (
            f"{tool}.{label} items declare additionalProperties: false and the "
            f"validator accepted an undeclared key inside {at}: "
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
        # Whichever case reaches a persona element, not case zero:
        # `payload["personas"][0]` raised a bare `IndexError` when the first
        # registered case was one of the empty-project ones, so an apparently
        # cosmetic reordering of the registry produced a traceback rather than a
        # sentence.
        payload, at, persona = _payload_reaching("list_personas", ("personas", _ARRAY))
        assert _errors(payload, personas_schema) == [], "the sample must validate first"

        # Asserted, not assumed: a valid payload need not CONTAIN this path — the
        # persona item schema declares no `required`, so `_GENERATED_PERSONA` or
        # the projection could stop emitting the section and the mutation below
        # would raise KeyError instead of failing with a diagnosis.
        section = persona.get("pain_points")
        assert isinstance(section, dict) and isinstance(
            section.get("current_challenges"), list
        ), (
            "the sample no longer contains a nested string-list section at "
            f"{'/'.join(str(p) for p in at)}.pain_points.current_challenges, which "
            f"is the exact shape M1 was; found {section!r}. Point this control at "
            "another nested list declared `array`, or restore a sample that carries "
            "one."
        )

        broken = copy.deepcopy(payload)
        _dig(broken, at)["pain_points"]["current_challenges"] = {"a": "alerts"}

        assert _rejects_at(
            broken, personas_schema, (*at, "pain_points", "current_challenges")
        ), _errors(broken, personas_schema)

        detail_schema = _output_schema("get_feedback_detail")
        detail = _payload("get_feedback_detail", *_first_sample("get_feedback_detail")[1:])
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
        # As above: any case that reaches a persona element, so registry order
        # cannot turn this control into an `IndexError`.
        payload, at, _persona = _payload_reaching("list_personas", ("personas", _ARRAY))
        assert _errors(payload, schema) == [], "the sample must validate first"

        broken = copy.deepcopy(payload)
        _dig(broken, at)["feedback_count"] = "42"

        assert _rejects_at(broken, schema, (*at, "feedback_count")), _errors(
            broken, schema
        )

    def test_a_required_field_that_is_absent_is_rejected(self):
        """`search_feedback` promises `is_partial` on every answer. A flag that
        is sometimes missing reads as "not truncated", which is the same wrong
        answer as asserting it false."""
        schema = _output_schema("search_feedback")
        payload = _payload("search_feedback", *_first_sample("search_feedback")[1:])
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
        payload = _payload("get_feedback_detail", *_first_sample("get_feedback_detail")[1:])

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
