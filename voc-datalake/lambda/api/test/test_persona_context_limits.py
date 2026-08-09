"""
Tests for the persona context-limit fix (issue #231).

Design intent
-------------
The critical property to preserve is: **no silent truncation above the old
30 000-char threshold**.  The fixture ``large_feedback_corpus`` constructs a
corpus whose formatted string exceeds 30 000 chars but stays well below
MAX_PERSONA_CONTEXT_CHARS (200 000), so the old hard-cap branch would have
fired and the new one must not.

Vacuity guard: every test that asserts `context_truncated is False` also
asserts that the context string passed to the chain is LONGER than 30 000
chars, proving the branch was reachable.  If you restore the old

    if len(feedback_context) > 30000:
        feedback_context = feedback_context[:30000] + "…"

the test ``test_large_corpus_is_not_truncated`` will fail because the
``converse_chain`` stub would receive a string of only 30 031 chars (30 000 +
len("…truncated …")), shorter than 30 000 + 1, which the assertion catches.
"""
import json
from unittest.mock import MagicMock, patch

import pytest

# ---------------------------------------------------------------------------
# Helpers
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


def _make_feedback_item(idx: int, text_len: int = 600) -> dict:
    """Return a feedback item whose ``original_text`` is ``text_len`` chars."""
    return {
        "feedback_id": f"fb-{idx}",
        "source_platform": "test_source",
        "original_text": f"Review {idx}: " + ("x" * (text_len - len(f"Review {idx}: "))),
        "sentiment_label": "positive",
        "sentiment_score": 0.9,
        "category": "product_quality",
        "urgency": "low",
        "rating": 5,
        "source_created_at": "2025-01-01T00:00:00",
        "date": "2025-01-01",
    }


def _large_corpus(n_items: int = 80, text_len: int = 600) -> list[dict]:
    """
    Return a list of n_items feedback items.

    At 600 chars of original_text per item, format_feedback_for_llm produces
    roughly 850 chars per item (headers, labels, quotes).  80 items ≈ 68 000
    chars — comfortably above the old 30 000-char cap and well below the new
    200 000-char cap.
    """
    return [_make_feedback_item(i, text_len) for i in range(n_items)]


# ---------------------------------------------------------------------------
# Common patches used by generate_personas tests
# ---------------------------------------------------------------------------

def _persona_patches(feedback_items):
    """Return a dict of patch targets → return values for generate_personas."""
    return {
        "projects.get_feedback_context": feedback_items,
        "projects.generate_persona_avatar": {"avatar_url": None, "avatar_prompt": None},
    }


def _run_generate_personas(feedback_items, captured_contexts=None):
    """
    Run ``generate_personas`` with ``feedback_items`` as the returned corpus.

    If ``captured_contexts`` is a list, appends the ``feedback_context`` string
    that was passed to ``get_persona_generation_steps`` (lets callers inspect
    what actually reached the prompt-builder).

    Returns the result dict from ``generate_personas``.
    """
    from shared.feedback import format_feedback_for_llm, get_feedback_statistics

    # We want the *real* formatter so the context length is authentic.
    real_formatted = format_feedback_for_llm(feedback_items)
    real_stats = get_feedback_statistics(feedback_items)

    captured_context_holder = []

    def fake_get_persona_steps(**kwargs):
        captured_context_holder.append(kwargs.get("feedback_context", ""))
        if captured_contexts is not None:
            captured_contexts.append(kwargs.get("feedback_context", ""))
        # Minimal stub — the chain step list just needs to be iterable
        return [{"role": "user", "content": "go"}]

    mock_table = MagicMock()
    mock_table.query.return_value = {"Items": []}
    mock_batch_writer = MagicMock()
    mock_batch_writer.__enter__ = MagicMock(return_value=MagicMock())
    mock_batch_writer.__exit__ = MagicMock(return_value=False)
    mock_table.batch_writer.return_value = mock_batch_writer

    # converse_chain must return at least 3 elements:
    #   results[0] = research text, results[1] = persona JSON, results[2] = validation
    chain_results = [
        "Research analysis text.",
        MINIMAL_PERSONA_JSON,
        MINIMAL_PERSONA_JSON,
    ]

    with patch("projects.projects_table", mock_table), \
         patch("projects.get_feedback_context", return_value=feedback_items), \
         patch("projects.format_feedback_for_llm", return_value=real_formatted), \
         patch("projects.get_feedback_statistics", return_value=real_stats), \
         patch("projects.get_persona_generation_steps", side_effect=fake_get_persona_steps), \
         patch("projects.converse_chain", return_value=chain_results), \
         patch("projects.generate_persona_avatar",
               return_value={"avatar_url": None, "avatar_prompt": None}):
        import projects
        result = projects.generate_personas(
            "proj-test",
            {"persona_count": 1, "generate_avatars": False},
        )

    return result, captured_context_holder


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

class TestPersonaContextNotSilentlyTruncated:
    """
    Core regression suite for issue #231.

    The assertion that matters: given a corpus whose formatted string exceeds
    30 000 chars (the old cap), the context delivered to the LLM must also
    exceed 30 000 chars, and ``context_truncated`` must be False.

    Vacuity check: these tests would FAIL if the old truncation were restored,
    because the ``captured_context_holder`` would show a string of only
    ~30 031 chars (30 000 + the "[… truncated …]" suffix), which is less than
    what ``assert len(ctx) > 30_000`` needs to satisfy *and* the
    ``context_truncated`` flag would be True on the old code-path.
    """

    def test_large_corpus_is_not_truncated(self):
        """
        A corpus that formats to > 30 000 chars passes the full context to
        the LLM and reports context_truncated=False.

        Vacuity guarantee: if the old hard-cap (``feedback_context[:30000]``)
        were restored, two assertions would fail:
          1. ``len(ctx) > 50_000`` — the old code caps at 30 000 chars, so the
             captured string would be ~30 041, well below 50 000.
          2. ``context_truncated is False`` — the old code either omits the
             key (KeyError) or sets it to True.
        """
        corpus = _large_corpus(n_items=80)
        captured = []
        result, _ = _run_generate_personas(corpus, captured)

        ctx = captured[0]

        # The corpus formats to ~61 000 chars; assert well above the old cap so
        # restoring the old ``[:30000]`` slice clearly breaks this assertion.
        assert len(ctx) > 50_000, (
            f"Context delivered to LLM was only {len(ctx)} chars — the old "
            f"30 000-char truncation may have been restored (expected > 50 000)."
        )
        assert result["metadata"]["context_truncated"] is False, (
            "context_truncated should be False for a corpus below MAX_PERSONA_CONTEXT_CHARS"
        )
        assert result["metadata"]["feedback_items_used"] == len(corpus)

    def test_feedback_items_used_is_accurate(self):
        """feedback_items_used in the response matches the actual corpus size."""
        corpus = _large_corpus(n_items=60)
        result, _ = _run_generate_personas(corpus)
        assert result["metadata"]["feedback_items_used"] == 60
        assert result["success"] is True

    def test_small_corpus_below_old_cap_is_unchanged(self):
        """
        A corpus that formats to < 30 000 chars was fine before and remains fine.
        context_truncated must be False and feedback_items_used must match.
        """
        corpus = _large_corpus(n_items=10)
        captured = []
        result, _ = _run_generate_personas(corpus, captured)

        ctx = captured[0]
        # Confirm this fixture is actually below the old cap (vacuity guard for
        # the vacuity guard — we don't want an accidentally large fixture here)
        assert len(ctx) < 30_000, (
            f"Fixture was {len(ctx)} chars; expected < 30 000. "
            "Reduce n_items so this tests the sub-threshold path."
        )
        assert result["metadata"]["context_truncated"] is False
        assert result["metadata"]["feedback_items_used"] == len(corpus)

    def test_corpus_exceeding_new_cap_is_flagged(self):
        """
        A corpus that exceeds MAX_PERSONA_CONTEXT_CHARS is trimmed and
        context_truncated is True.  This verifies the new cap still fires,
        just at a higher threshold.
        """
        import projects
        new_cap = projects.MAX_PERSONA_CONTEXT_CHARS

        # Build a corpus large enough to exceed the new cap.
        # Each formatted item is ~850 chars; need > new_cap / 850 items.
        items_needed = new_cap // 800 + 50  # comfortably over
        corpus = _large_corpus(n_items=items_needed)

        from shared.feedback import format_feedback_for_llm
        formatted = format_feedback_for_llm(corpus)
        if len(formatted) <= new_cap:
            pytest.skip(
                f"Fixture ({len(formatted)} chars) did not exceed new cap "
                f"({new_cap}); increase items_needed."
            )

        captured = []
        result, _ = _run_generate_personas(corpus, captured)

        ctx = captured[0]
        assert len(ctx) <= new_cap + len("\n\n[... additional feedback truncated ...]") + 1
        assert result["metadata"]["context_truncated"] is True
        assert result["metadata"]["feedback_items_used"] == len(corpus)

    def test_metadata_fields_present_in_response(self):
        """
        The response always carries feedback_items_used and context_truncated
        regardless of corpus size (these are new observable fields; the
        frontend must not break if it reads the old metadata shape).
        """
        corpus = _large_corpus(n_items=5)
        result, _ = _run_generate_personas(corpus)

        meta = result["metadata"]
        assert "feedback_items_used" in meta, "feedback_items_used missing from metadata"
        assert "context_truncated" in meta, "context_truncated missing from metadata"
        # Legacy field still present (frontend compatibility)
        assert "feedback_count" in meta, "feedback_count missing from metadata"
        assert "source_breakdown" in meta, "source_breakdown missing from metadata"
        assert "generation_time_ms" in meta, "generation_time_ms missing from metadata"


class TestFeedbackLimitConstants:
    """
    Verify that every per-surface limit is a named constant above the old
    smallest values (i.e. we didn't accidentally downgrade any limit).
    """

    def test_persona_limit_above_old_value(self):
        import projects
        assert projects.FEEDBACK_LIMIT_PERSONA > 50, (
            "FEEDBACK_LIMIT_PERSONA must exceed the old hard-coded 50"
        )

    def test_prd_limit_above_old_value(self):
        import projects
        assert projects.FEEDBACK_LIMIT_PRD > 50, (
            "FEEDBACK_LIMIT_PRD must exceed the old hard-coded 50"
        )

    def test_prfaq_limit_above_old_value(self):
        import projects
        assert projects.FEEDBACK_LIMIT_PRFAQ > 30, (
            "FEEDBACK_LIMIT_PRFAQ must exceed the old hard-coded 30"
        )

    def test_autofill_limit_above_old_value(self):
        import projects
        assert projects.FEEDBACK_LIMIT_AUTOFILL > 20, (
            "FEEDBACK_LIMIT_AUTOFILL must exceed the old hard-coded 20"
        )

    def test_brief_limit_above_old_value(self):
        import projects
        assert projects.FEEDBACK_LIMIT_BRIEF > 40, (
            "FEEDBACK_LIMIT_BRIEF must exceed the old hard-coded 40"
        )

    def test_research_suggest_limit_above_old_value(self):
        import projects
        assert projects.FEEDBACK_LIMIT_RESEARCH_SUGGEST > 40, (
            "FEEDBACK_LIMIT_RESEARCH_SUGGEST must exceed the old hard-coded 40"
        )

    def test_research_limit_above_old_value(self):
        import projects
        assert projects.FEEDBACK_LIMIT_RESEARCH > 100, (
            "FEEDBACK_LIMIT_RESEARCH must exceed the old hard-coded 100"
        )

    def test_max_persona_context_chars_above_old_cap(self):
        import projects
        assert projects.MAX_PERSONA_CONTEXT_CHARS > 30_000, (
            "MAX_PERSONA_CONTEXT_CHARS must exceed the old 30 000-char cap"
        )
