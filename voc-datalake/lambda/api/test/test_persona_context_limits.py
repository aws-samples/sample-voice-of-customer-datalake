"""
Tests for the persona context-limit fix (issue #231).

Design intent
-------------
The defect was that three caps stacked between DynamoDB and the model, and the
narrowest one silently decided how much of the corpus the personas were actually
based on:

1. ``FEEDBACK_LIMIT_PERSONA``     — how many records are fetched
2. ``MAX_PERSONA_CONTEXT_CHARS``  — a char cap in ``generate_personas``
3. ``feedback_context[:15000]``   — a char cap in ``get_persona_generation_steps``

(3) is the one that bound in practice, because ``persona-generation.json``
interpolates ``{feedback_sample}`` — not ``{feedback_context}`` — into the
``persona_synthesis`` step, and that is the step that emits the persona JSON.
So the personas were written from ~18 reviews no matter what was fetched.

Where these tests assert
------------------------
On the BUILT PROMPT, via the real ``get_persona_generation_steps``. That
function is a pure string transform with no I/O, so there is no reason to stub
it — and stubbing it is precisely what would hide cap (3): a test that inspects
the ``feedback_context`` argument *passed to* the builder sees the string before
the cap that matters is applied. ``count_persona_sample_records`` reads the
number of complete records reaching the synthesis step off the finished prompt,
so every cap is baked into what these tests observe.

Vacuity
-------
Fixture sizes are derived from a measurement
(``len(format_feedback_for_llm([_make_feedback_item(0)]))``, ~820 chars for a
600-char ``original_text``) rather than a hardcoded estimate, and an undersized
fixture fails rather than skipping — a skip here would mean the test is broken,
not that the environment is unsuitable, and would silently remove the only
coverage of the truncation branch.
"""
import json
from unittest.mock import MagicMock, patch

import pytest
from shared.feedback import (
    FEEDBACK_CHARS_PER_ITEM_MAX,
    REVIEW_BLOCK_MARKER,
    format_feedback_for_llm,
)

# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

MINIMAL_PERSONA_JSON = json.dumps([{
    "name": "TestUser",
    "tagline": "a tester",
    "confidence": "high",
    "feedback_count": 10,
    "identity": {},
    "goals_motivations": {},
    "pain_points": {},
    "behaviors": {},
    "context_environment": {},
    "quotes": [],
    "scenario": {},
    "supporting_evidence": [],
}])

# The old hard cap in generate_personas, and the old cap in prompts.py. Named so
# the assertions below can say which revert each one catches.
OLD_CONTEXT_CAP = 30_000
OLD_SAMPLE_CAP = 15_000


def _make_feedback_item(idx: int, text_len: int = 600) -> dict:
    """Return a feedback item whose ``original_text`` is ``text_len`` chars."""
    prefix = f"Review {idx}: "
    return {
        "feedback_id": f"fb-{idx}",
        "source_platform": "test_source",
        "original_text": prefix + ("x" * (text_len - len(prefix))),
        "sentiment_label": "positive",
        "sentiment_score": 0.9,
        "category": "product_quality",
        "urgency": "low",
        "rating": 5,
        "source_created_at": "2025-01-01T00:00:00",
        "date": "2025-01-01",
    }


def _chars_per_item() -> int:
    """Measured formatted size of one item, so fixtures can't go stale."""
    return len(format_feedback_for_llm([_make_feedback_item(0)]))


def _corpus_of_at_least(chars: int) -> list[dict]:
    """Smallest corpus whose formatted string exceeds ``chars``.

    Sized from the measurement rather than a magic constant, then asserted — if
    ``format_feedback_for_llm`` is ever made more compact this fails loudly
    instead of quietly producing an undersized fixture.
    """
    corpus = [_make_feedback_item(i) for i in range(chars // _chars_per_item() + 10)]
    formatted = len(format_feedback_for_llm(corpus))
    assert formatted > chars, (
        f"fixture is {formatted} chars but must exceed {chars} for the test to "
        f"mean anything — format_feedback_for_llm may have become more compact"
    )
    return corpus


def _run_generate_personas(feedback_items):
    """Run ``generate_personas`` over ``feedback_items``.

    Only I/O is stubbed: DynamoDB, Bedrock, and avatar generation. The feedback
    formatter and the prompt builder run for real, so the captured prompts are
    what a deployed Lambda would send.

    Returns:
        ``(result, chain_steps)`` — the chain steps as actually built.
    """
    import projects

    captured_steps = []
    real_builder = projects.get_persona_generation_steps

    def capturing_builder(**kwargs):
        steps = real_builder(**kwargs)
        captured_steps.append(steps)
        return steps

    mock_table = MagicMock()
    mock_table.query.return_value = {"Items": []}
    batch_writer = MagicMock()
    batch_writer.__enter__ = MagicMock(return_value=MagicMock())
    batch_writer.__exit__ = MagicMock(return_value=False)
    mock_table.batch_writer.return_value = batch_writer

    # One string per chain step. The chain is (research_analysis,
    # persona_synthesis) since PR #331 dropped the third 'validation' step;
    # generate_personas locates the persona JSON BY STEP NAME, so a trailing
    # spare entry is harmless and keeps this fixture working either way.
    chain_results = [
        "Research analysis text.",
        MINIMAL_PERSONA_JSON,
    ]

    with patch("projects.projects_table", mock_table), \
         patch("projects.get_feedback_context", return_value=feedback_items), \
         patch("projects.get_persona_generation_steps", side_effect=capturing_builder), \
         patch("projects.converse_chain", return_value=chain_results), \
         patch("projects.generate_persona_avatar",
               return_value={"avatar_url": None, "avatar_prompt": None}):
        result = projects.generate_personas(
            "proj-test",
            {"persona_count": 1, "generate_avatars": False},
        )

    assert captured_steps, "generate_personas did not build any chain steps"
    return result, captured_steps[0]


def _synthesis_prompt(chain_steps) -> str:
    """The user prompt of the step that writes the personas."""
    return next(
        step["user"] for step in chain_steps
        if step["step_name"] == "persona_synthesis"
    )


# ---------------------------------------------------------------------------
# The cap that actually binds: the persona-synthesis step
# ---------------------------------------------------------------------------

class TestPersonaSynthesisSeesTheCorpus:
    """The step that WRITES the personas must scale with the corpus.

    Before the fix, ``get_persona_generation_steps`` sliced the sample to
    15 000 chars, so ``persona_synthesis`` saw ~18 reviews whether 50 or 500
    were fetched. Every assertion here is on the built prompt, so restoring that
    slice fails them.
    """

    def test_synthesis_step_scales_with_the_corpus(self):
        """A corpus well past the old sample cap reaches the synthesis step whole.

        Catches a revert of ``feedback_context[:15000]`` in shared/prompts.py:
        that slice would deliver ~18 records where this asserts on all 100.
        """
        from shared.prompts import count_persona_sample_records

        corpus = [_make_feedback_item(i) for i in range(100)]
        formatted = len(format_feedback_for_llm(corpus))
        assert formatted > OLD_SAMPLE_CAP, "fixture must exceed the old sample cap"

        _, chain_steps = _run_generate_personas(corpus)

        used = count_persona_sample_records(chain_steps)
        assert used == len(corpus), (
            f"only {used} of {len(corpus)} reviews reached persona_synthesis — "
            f"the {OLD_SAMPLE_CAP}-char feedback_sample slice may be back"
        )

    def test_every_step_sees_the_same_corpus(self):
        """No step is grounded in less than the others.

        The old split — full context to research_analysis, a 15 000-char sample
        to the persona-writing step — meant the benefit of any raised limit
        landed on a step whose prose output the persona-writing step received as
        a lossy summary rather than as evidence.

        Asserted over whatever steps the chain contains rather than a hardcoded
        list of names: PR #331 removed the third ('validation') step, and a test
        naming steps individually fails on that kind of change for a reason
        unrelated to what it is checking.
        """
        corpus = [_make_feedback_item(i) for i in range(100)]
        _, chain_steps = _run_generate_personas(corpus)

        counts = {
            step["step_name"]: step["user"].count(REVIEW_BLOCK_MARKER)
            for step in chain_steps
        }
        assert len(counts) >= 2, f"expected a multi-step chain, got {list(counts)}"
        assert set(counts.values()) == {len(corpus)}, (
            f"steps disagree about how much corpus they were given: {counts} — "
            f"every step should see all {len(corpus)} records"
        )

    def test_a_full_default_corpus_is_not_truncated(self):
        """``FEEDBACK_LIMIT_PERSONA`` items fit the budget without truncation.

        This is the constants-consistency guard. The two headline numbers used
        to be chosen independently and disagreed by 2x: 500 items formatted to
        ~410 000 chars against a 200 000-char cap, so the truncation branch was
        the DEFAULT path and discarded more than half of every full corpus.
        """
        import projects

        corpus = [_make_feedback_item(i) for i in range(projects.FEEDBACK_LIMIT_PERSONA)]
        result, chain_steps = _run_generate_personas(corpus)

        assert result["metadata"]["context_truncated"] is False, (
            f"a full {projects.FEEDBACK_LIMIT_PERSONA}-item corpus "
            f"({len(format_feedback_for_llm(corpus))} chars) must fit the "
            f"{projects.MAX_PERSONA_CONTEXT_CHARS}-char budget — the item limit "
            f"and the char cap have drifted apart"
        )
        assert result["metadata"]["feedback_items_used"] == len(corpus)
        assert _synthesis_prompt(chain_steps).count(REVIEW_BLOCK_MARKER) == len(corpus)


class TestBudgetConstantsAreConsistent:
    """Pin the derivation, not the literals.

    ``assert CONSTANT > old_value`` passes for a typo and for an absurd value,
    and says nothing about whether the constant is used. These assert the
    relationship the constants must satisfy; TestLimitsReachTheirCallSites
    asserts they are actually threaded through.
    """

    def test_item_limit_and_char_cap_cannot_disagree(self):
        import projects

        worst_case = projects.FEEDBACK_LIMIT_PERSONA * FEEDBACK_CHARS_PER_ITEM_MAX
        assert worst_case <= projects.MAX_PERSONA_CONTEXT_CHARS, (
            f"{projects.FEEDBACK_LIMIT_PERSONA} items at up to "
            f"{FEEDBACK_CHARS_PER_ITEM_MAX} chars each is {worst_case} chars, "
            f"over the {projects.MAX_PERSONA_CONTEXT_CHARS}-char budget: the "
            f"char cap would be the operative limit, not a backstop"
        )

    def test_chars_per_item_estimate_still_bounds_the_formatter(self):
        """The derivation rests on this measurement, so pin it here too."""
        enriched = {
            **_make_feedback_item(0),
            "direct_customer_quote": "q" * 200,
            "problem_summary": "s" * 200,
            "problem_root_cause_hypothesis": "r" * 200,
            "persona_type": "power_user",
            "journey_stage": "usage",
        }
        assert len(format_feedback_for_llm([enriched])) <= FEEDBACK_CHARS_PER_ITEM_MAX

    def test_persona_budget_is_derived_not_hardcoded(self):
        """The budget must follow the resolved model's context window.

        A literal would overflow a smaller-window model as a hard Bedrock
        ValidationException — worse than the truncation it replaced.
        """
        import projects
        from shared.feedback import feedback_char_budget

        assert projects.MAX_PERSONA_CONTEXT_CHARS == feedback_char_budget()
        # A narrower window must yield a smaller budget.
        assert feedback_char_budget(window_tokens=100_000) < feedback_char_budget()

    def test_budget_is_above_both_old_caps(self):
        """The whole point: more corpus reaches the model than before."""
        import projects
        from shared.prompts import MAX_PERSONA_SAMPLE_CHARS

        assert projects.MAX_PERSONA_CONTEXT_CHARS > OLD_CONTEXT_CAP
        assert MAX_PERSONA_SAMPLE_CHARS > OLD_SAMPLE_CAP


class _StopAfterFetch(Exception):
    """Ends a path at its feedback fetch, so nothing downstream can run.

    Replaces a ``pytest.raises(Exception)`` that was wrong twice over. It relied
    on an empty corpus aborting each path, and these paths do not abort on one:
    ``suggest_research_questions`` prompts happily with "(no feedback yet)", so
    the assertion was satisfied by whatever failed next — which, on a machine
    with credentials, was a real billed Bedrock call taking ~8 s. And a bare
    ``Exception`` matcher passes just as well on a ``TypeError`` from a signature
    change, i.e. it passes when the test itself is broken.

    Raising from the fetch stub makes the stop deterministic and puts it before
    any LLM entry point, so no network call is reachable from these tests.
    """


class TestLimitsReachTheirCallSites:
    """A constant nobody passes to ``get_feedback_context`` is decorative.

    Without these, reverting a call site to a bare literal while leaving the
    constant defined would keep the whole suite green and put the corpus
    silently back where it started.
    """

    @staticmethod
    def _limit_passed_to_get_feedback_context(call_fn):
        """Invoke ``call_fn`` and return the ``limit`` it fetched with."""
        with patch("projects.get_feedback_context",
                   side_effect=_StopAfterFetch) as gfc, \
             pytest.raises(_StopAfterFetch):
            call_fn()
        assert gfc.called, "the path did not fetch feedback at all"
        kwargs = gfc.call_args.kwargs
        if "limit" in kwargs:
            return kwargs["limit"]
        return gfc.call_args.args[1]

    def test_persona_path_uses_the_resolved_limit(self):
        """The persona fetch uses the limit resolved WITH the char budget.

        Asserted against ``persona_context_budget()`` rather than the
        import-time constant, because the constant is only the default: the
        point of resolving the pair at call time is that a narrower runtime
        model moves both, and an assertion against the constant would keep
        passing while the fetch and the trim drifted apart.
        """
        import projects
        limit = self._limit_passed_to_get_feedback_context(
            lambda: projects.generate_personas("proj-test", {})
        )
        assert limit == projects.persona_context_budget()[1]

    def test_autofill_path_uses_the_named_limit(self):
        import projects
        with patch("projects.get_project",
                   return_value={"project": {"filters": {}}, "personas": []}):
            limit = self._limit_passed_to_get_feedback_context(
                lambda: projects.autofill_prfaq_questions("proj-test", {})
            )
        assert limit == projects.FEEDBACK_LIMIT_AUTOFILL

    def test_brief_path_uses_the_named_limit(self):
        import projects
        with patch("projects.get_project",
                   return_value={"project": {"filters": {}}, "personas": []}):
            limit = self._limit_passed_to_get_feedback_context(
                lambda: projects.suggest_document_brief("proj-test", {})
            )
        assert limit == projects.FEEDBACK_LIMIT_BRIEF

    def test_research_suggest_path_uses_the_named_limit(self):
        import projects
        with patch("projects.get_project",
                   return_value={"project": {"filters": {}}, "personas": []}):
            limit = self._limit_passed_to_get_feedback_context(
                lambda: projects.suggest_research_questions("proj-test", {})
            )
        assert limit == projects.FEEDBACK_LIMIT_RESEARCH_SUGGEST


class TestLegacySurfacesAreNotClaimedAsFixed:
    """Guard the scope claim.

    ``generate_prd`` / ``generate_prfaq`` are unreachable in a deployed system:
    ``projects_handler.py`` does not import them, and document generation routes
    to ``lambda/jobs/document_generator/handler.py``, which fetches its own
    feedback with its own caps. Their limits are therefore deliberately left
    alone. If someone wires them up, or changes the live path, these fail and
    point at the follow-up work rather than letting a decorative constant look
    like a fix.
    """

    @staticmethod
    def _lambda_dir():
        from pathlib import Path
        return Path(__file__).resolve().parents[2]

    @staticmethod
    def _imported_names(source: str) -> set[str]:
        """Every name ``source`` imports, parsed rather than string-sliced.

        The previous form did ``source.split("from projects import (")[1]``,
        which raises IndexError on any change to how that import is written —
        dropping the parentheses, splitting it in two, switching to
        ``import projects`` — and the failure would read as "the handler now
        imports generate_prd" when it means "the import is formatted
        differently".
        """
        import ast

        names: set[str] = set()
        for node in ast.walk(ast.parse(source)):
            if isinstance(node, (ast.Import, ast.ImportFrom)):
                names.update(alias.name for alias in node.names)
        return names

    def test_prd_and_prfaq_are_not_imported_by_the_handler(self):
        handler = (self._lambda_dir() / "api" / "projects_handler.py").read_text()
        imported = self._imported_names(handler)
        assert "generate_prd" not in imported
        assert "generate_prfaq" not in imported

    def test_the_live_document_path_does_not_use_the_persona_budget(self):
        """The scope boundary, asserted as a boundary rather than as a bug.

        The claim this guards is "#231's document half is NOT fixed here": the
        live document path bounds its own corpus, independently of the budget
        this PR derives. Asserting the boundary — that none of the shared budget
        helpers appear there — keeps that claim checkable without pinning the
        exact literal the path currently uses.

        An earlier version asserted ``"feedback_items[:30]" in live``, i.e. that
        a known shortcoming was still present. That inverts the purpose of a
        test: correcting the shortcoming would have broken the build, and
        reformatting the slice would have broken it for no reason at all. This
        version fails when someone adopts the shared budget there, which is
        exactly when the LEGACY notes in projects.py stop being true.
        """
        live = (
            self._lambda_dir() / "jobs" / "document_generator" / "handler.py"
        ).read_text()
        for helper in (
            "feedback_char_budget",
            "feedback_item_limit",
            "MAX_PERSONA_CONTEXT_CHARS",
            "FEEDBACK_LIMIT_PERSONA",
        ):
            assert helper not in live, (
                f"the live document path now uses {helper} — #231's document "
                f"half may be fixed. Update the LEGACY notes in projects.py, "
                f"re-scope the issue, and retire this guard."
            )


# ---------------------------------------------------------------------------
# Reported metadata
# ---------------------------------------------------------------------------

class TestReportedMetadataIsHonest:
    """``feedback_items_used`` must be what the model saw, not what was read.

    Reporting the fetched count overstates precisely when it matters: a corpus
    the caps trimmed. And ``context_truncated is False`` must mean the personas
    were written from the whole corpus — a flag that reads False while a
    downstream cap discarded most of the records is worse than the log line it
    replaced, because it actively asserts the opposite.
    """

    def test_untruncated_corpus_reports_every_item_used(self):
        corpus = [_make_feedback_item(i) for i in range(60)]
        result, _ = _run_generate_personas(corpus)

        assert result["success"] is True
        assert result["metadata"]["feedback_items_used"] == 60
        assert result["metadata"]["context_truncated"] is False

    def test_a_corpus_over_the_budget_is_flagged_and_counted_down(self):
        """Truncation reports the surviving count, not the fetched count."""
        import projects

        corpus = _corpus_of_at_least(projects.MAX_PERSONA_CONTEXT_CHARS)
        result, chain_steps = _run_generate_personas(corpus)

        meta = result["metadata"]
        assert meta["context_truncated"] is True
        assert meta["feedback_items_used"] < len(corpus), (
            "feedback_items_used must report what reached the model, not what "
            "was fetched — it is wrong exactly when truncation happened"
        )
        assert meta["feedback_items_used"] > 0
        # The count is the truth about the prompt, not an estimate of it.
        assert meta["feedback_items_used"] == _synthesis_prompt(chain_steps).count(
            REVIEW_BLOCK_MARKER
        )
        # feedback_count keeps reporting the fetched total.
        assert meta["feedback_count"] == len(corpus)

    def test_truncated_context_never_ends_mid_record(self):
        """A partial record is data the model may reason from as if it were real."""
        import projects

        corpus = _corpus_of_at_least(projects.MAX_PERSONA_CONTEXT_CHARS)
        _, chain_steps = _run_generate_personas(corpus)

        body = _synthesis_prompt(chain_steps).split(
            "[... additional feedback truncated ...]"
        )[0]
        # Each complete record's Full Text line is closed by the formatter's
        # trailing quote; an unterminated one would leave the counts unequal.
        assert body.count('- Full Text: "') == body.count('"\n')

    def test_metadata_fields_are_always_present(self):
        """New observable fields, plus the ones the frontend already reads."""
        corpus = [_make_feedback_item(i) for i in range(5)]
        result, _ = _run_generate_personas(corpus)

        meta = result["metadata"]
        for field in (
            "feedback_items_used", "context_truncated", "feedback_count",
            "fetch_limit_reached", "fetch_limit",
            "source_breakdown", "generation_time_ms",
        ):
            assert field in meta, f"{field} missing from metadata"


class TestOversizedInputErrorIsNamed:
    """An oversized prompt must not surface as a generic "try again".

    A context that does not fit will not fit on a retry either, so the generic
    message sends an operator into an identical multi-minute failure with no
    hint about which knob to turn.
    """

    @staticmethod
    def _validation_error(message):
        from botocore.exceptions import ClientError
        return ClientError(
            {"Error": {"Code": "ValidationException", "Message": message}},
            "Converse",
        )

    def _generate_with_chain_error(self, error):
        import projects

        mock_table = MagicMock()
        mock_table.query.return_value = {"Items": []}
        with patch("projects.projects_table", mock_table), \
             patch("projects.get_feedback_context",
                   return_value=[_make_feedback_item(i) for i in range(5)]), \
             patch("projects.converse_chain", side_effect=error):
            projects.generate_personas("proj-test", {"persona_count": 1})

    def test_oversized_input_points_the_user_at_what_they_control(self):
        """The message must name an action available in the browser.

        It reaches an end user, who can widen or narrow filters and pick a model
        in Settings but cannot set a Lambda environment variable. The env-var
        advice is an operator concern and belongs in the log.
        """
        from shared.exceptions import ServiceError

        with pytest.raises(ServiceError) as excinfo:
            self._generate_with_chain_error(
                self._validation_error("Input is too long for requested model.")
            )
        message = str(excinfo.value)
        assert "filters" in message.lower()
        assert "context window" in message.lower()
        # Distinguishable from the generic failure, so it is not a reworded
        # "try again" that sends the user into an identical multi-minute retry.
        assert "try again" not in message.lower()

    def test_oversized_input_does_not_leak_env_var_names_to_the_user(self):
        from shared.exceptions import ServiceError

        with pytest.raises(ServiceError) as excinfo:
            self._generate_with_chain_error(
                self._validation_error("Input is too long for requested model.")
            )
        message = str(excinfo.value)
        for env_var in ("MAX_PERSONA_CONTEXT_CHARS", "FEEDBACK_LIMIT_PERSONA"):
            assert env_var not in message, (
                f"{env_var} is an internal knob leaking into a user-facing string"
            )

    def test_unrelated_validation_errors_keep_the_generic_message(self):
        from shared.exceptions import ServiceError

        with pytest.raises(ServiceError) as excinfo:
            self._generate_with_chain_error(
                self._validation_error("Unknown parameter foo.")
            )
        assert "try again" in str(excinfo.value).lower()
        assert "context window" not in str(excinfo.value).lower()


class TestBudgetAndFetchLimitCannotDrift:
    """The pair must move together when the resolved model changes.

    The regression this guards is subtle and was latent: the fetch limit was
    derived at IMPORT from the 200 K default window while the trim budget was
    recomputed at runtime from whichever model the 'documents' surface resolves
    to. Repoint that surface at a narrower model and the fetch stays sized for
    200 K while the budget shrinks — so truncation becomes the default path
    again, which is the exact blindness #231 is about.

    All five allowlisted models carry a 200 K window today, so nothing in the
    suite could observe the drift without forcing a narrower one.
    """

    def test_a_narrower_resolved_model_shrinks_both_numbers(self):
        import projects
        from shared.feedback import feedback_char_budget, feedback_item_limit

        wide_budget, wide_limit = projects.persona_context_budget()

        with patch("projects.surface_context_window_tokens", return_value=60_000):
            narrow_budget, narrow_limit = projects.persona_context_budget()

        assert narrow_budget < wide_budget, "the char budget ignored the model"
        assert narrow_limit < wide_limit, (
            "the fetch limit did not follow the narrower window — it is still "
            "sized for the default 200 K, so a full fetch will not fit the "
            "budget and truncation is back on the default path"
        )
        # And they remain mutually consistent at the narrower size.
        assert narrow_limit == feedback_item_limit(narrow_budget)
        assert narrow_budget == feedback_char_budget(window_tokens=60_000)

    def test_the_persona_fetch_follows_a_narrower_model(self):
        """The drift must be absent at the call site, not just in the helper."""
        import projects

        with patch("projects.surface_context_window_tokens", return_value=60_000):
            expected = projects.persona_context_budget()[1]
            limit = TestLimitsReachTheirCallSites._limit_passed_to_get_feedback_context(
                lambda: projects.generate_personas("proj-test", {})
            )
        assert limit == expected
        assert limit < projects.FEEDBACK_LIMIT_PERSONA, (
            "the fetch used the import-time default rather than the resolved "
            "budget — the fixture forces a window narrower than the default"
        )


class TestEnvOverridesAreValidated:
    """A bad environment variable must not break import or invert its meaning.

    Both were live hazards. ``int(os.environ.get(...))`` at module scope raises
    on a typo and takes down every route in the projects Lambda, not just
    persona generation. And a non-positive value is worse than ignored:
    ``truncate_feedback_context`` reads ``<= 0`` as "no limit", so an operator
    setting ``0`` to LOWER the budget would get an unbounded prompt.
    """

    @staticmethod
    def _resolved(env: dict) -> tuple[int, int]:
        import projects
        with patch.dict("os.environ", env, clear=False):
            return projects.persona_context_budget()

    def test_a_valid_override_is_honoured(self):
        budget, _ = self._resolved({"MAX_PERSONA_CONTEXT_CHARS": "50000"})
        assert budget == 50_000

    def test_either_override_can_be_set_alone(self):
        import projects
        from shared.feedback import feedback_item_limit

        budget, limit = self._resolved({"MAX_PERSONA_CONTEXT_CHARS": "50000"})
        assert limit == feedback_item_limit(50_000), (
            "the item limit must stay derived from the overridden budget"
        )

        budget, limit = self._resolved({"FEEDBACK_LIMIT_PERSONA": "7"})
        assert limit == 7
        assert budget == projects.persona_context_budget()[0], (
            "overriding the item limit must not move the char budget"
        )

    def test_a_non_numeric_override_falls_back_instead_of_raising(self):
        import projects

        budget, limit = self._resolved({"MAX_PERSONA_CONTEXT_CHARS": "not-a-number"})
        assert (budget, limit) == projects.persona_context_budget()

    def test_a_zero_override_does_not_mean_no_limit(self):
        """``0`` must not disable the cap it was set to tighten."""
        import projects
        from shared.feedback import truncate_feedback_context

        budget, _ = self._resolved({"MAX_PERSONA_CONTEXT_CHARS": "0"})
        assert budget > 0, (
            "a zero budget reaches truncate_feedback_context as 'no limit', so "
            "lowering the knob to 0 would produce an unbounded prompt"
        )
        # Pin the property that makes 0 dangerous, so this test keeps its reason.
        context = format_feedback_for_llm([_make_feedback_item(i) for i in range(3)])
        _, _, truncated = truncate_feedback_context(context, 0)
        assert truncated is False
        assert budget == projects.persona_context_budget()[0]

    def test_a_negative_override_falls_back(self):
        import projects

        budget, _ = self._resolved({"MAX_PERSONA_CONTEXT_CHARS": "-1"})
        assert budget == projects.persona_context_budget()[0]


class TestTheChainDoesNotAccumulateContext:
    """The budget assumes each step is an independent request.

    ``sample_chars=context_budget`` puts a full-budget corpus into more than one
    step. If ``converse_chain`` accumulated messages the way a conversation does,
    the last step's input would be corpus + corpus + chained output and the 0.5
    utilisation margin would not cover it. It does not accumulate — each step is
    a fresh single-turn ``converse`` call whose only inheritance is the previous
    step's OUTPUT, substituted into ``{previous}`` — and that is what makes the
    budget sound, so it is pinned here rather than assumed.
    """

    def test_each_step_is_a_fresh_single_turn_request(self):
        from shared.converse import converse_chain

        seen = []

        def fake_converse(prompt, **kwargs):
            seen.append(prompt)
            return f"output-of-{kwargs.get('step_name')}"

        steps = [
            {"step_name": "one", "system": "s", "user": "FIRST-MARKER"},
            {"step_name": "two", "system": "s", "user": "SECOND-MARKER {previous}"},
            {"step_name": "three", "system": "s", "user": "THIRD-MARKER {previous}"},
        ]
        with patch("shared.converse.converse", side_effect=fake_converse):
            converse_chain(steps)

        assert len(seen) == 3
        # Step 2 carries its own text plus step 1's OUTPUT — not step 1's input.
        assert "SECOND-MARKER" in seen[1]
        assert "output-of-one" in seen[1]
        assert "FIRST-MARKER" not in seen[1], (
            "step 2's request replayed step 1's input — converse_chain is "
            "accumulating messages, and a full-budget corpus in two steps would "
            "then exceed the context window"
        )
        # And the effect does not compound over a longer chain.
        assert "output-of-two" in seen[2]
        assert "output-of-one" not in seen[2]
        assert "SECOND-MARKER" not in seen[2]


class TestTheFetchLimitIsReported:
    """The fetch limit is a cap too, and the one that binds a large project.

    ``context_truncated`` compares what reached the model against what was
    FETCHED, so it is structurally blind to everything the fetch limit excluded:
    filters matching thousands of records produce exactly ``fetch_limit`` items,
    ``context_truncated`` is False, and the UI would otherwise present that
    number as if it were the whole corpus.
    """

    def test_a_corpus_at_the_fetch_limit_is_flagged(self):
        import projects

        limit = projects.persona_context_budget()[1]
        corpus = [_make_feedback_item(i) for i in range(limit)]
        result, _ = _run_generate_personas(corpus)

        meta = result["metadata"]
        assert meta["fetch_limit_reached"] is True
        assert meta["fetch_limit"] == limit
        # The distinct failure mode: nothing was trimmed, yet the corpus is a
        # floor rather than a total.
        assert meta["context_truncated"] is False

    def test_a_corpus_below_the_fetch_limit_is_not_flagged(self):
        result, _ = _run_generate_personas([_make_feedback_item(i) for i in range(5)])
        assert result["metadata"]["fetch_limit_reached"] is False
