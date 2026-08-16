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

    # converse_chain returns one string per step: research, persona JSON, validation.
    chain_results = [
        "Research analysis text.",
        MINIMAL_PERSONA_JSON,
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
        to synthesis and validation — meant the benefit of any raised limit
        landed on a step whose prose output the persona-writing step received as
        a lossy summary rather than as evidence.
        """
        corpus = [_make_feedback_item(i) for i in range(100)]
        _, chain_steps = _run_generate_personas(corpus)

        counts = {
            step["step_name"]: step["user"].count(REVIEW_BLOCK_MARKER)
            for step in chain_steps
        }
        assert counts["persona_synthesis"] == counts["research_analysis"]
        assert counts["validation"] == counts["research_analysis"]

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


class TestLimitsReachTheirCallSites:
    """A constant nobody passes to ``get_feedback_context`` is decorative.

    Without these, reverting a call site to a bare literal while leaving the
    constant defined would keep the whole suite green and put the corpus
    silently back where it started.
    """

    @staticmethod
    def _limit_passed_to_get_feedback_context(call_fn):
        """Invoke ``call_fn`` and return the ``limit`` it fetched with."""
        # An empty corpus aborts every one of these paths; we only care about
        # the fetch that already happened.
        with patch("projects.get_feedback_context", return_value=[]) as gfc, \
             pytest.raises(Exception):  # noqa: B017
            call_fn()
        assert gfc.called, "the path did not fetch feedback at all"
        kwargs = gfc.call_args.kwargs
        if "limit" in kwargs:
            return kwargs["limit"]
        return gfc.call_args.args[1]

    def test_persona_path_uses_the_named_limit(self):
        import projects
        limit = self._limit_passed_to_get_feedback_context(
            lambda: projects.generate_personas("proj-test", {})
        )
        assert limit == projects.FEEDBACK_LIMIT_PERSONA

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

    def test_prd_and_prfaq_are_not_imported_by_the_handler(self):
        handler = (self._lambda_dir() / "api" / "projects_handler.py").read_text()
        import_block = handler.split("from projects import (")[1].split(")")[0]
        assert "generate_prd" not in import_block
        assert "generate_prfaq" not in import_block

    def test_the_live_document_path_still_has_its_own_caps(self):
        """The remaining half of #231, recorded so it isn't forgotten."""
        live = (
            self._lambda_dir() / "jobs" / "document_generator" / "handler.py"
        ).read_text()
        assert "feedback_items[:30]" in live, (
            "the live document path's caps changed — update the LEGACY notes in "
            "projects.py and this test, and re-scope issue #231"
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

    def test_oversized_input_names_the_budget_constant(self):
        from shared.exceptions import ServiceError

        with pytest.raises(ServiceError) as excinfo:
            self._generate_with_chain_error(
                self._validation_error("Input is too long for requested model.")
            )
        assert "MAX_PERSONA_CONTEXT_CHARS" in str(excinfo.value)

    def test_unrelated_validation_errors_keep_the_generic_message(self):
        from shared.exceptions import ServiceError

        with pytest.raises(ServiceError) as excinfo:
            self._generate_with_chain_error(
                self._validation_error("Unknown parameter foo.")
            )
        assert "MAX_PERSONA_CONTEXT_CHARS" not in str(excinfo.value)
        assert "try again" in str(excinfo.value).lower()
