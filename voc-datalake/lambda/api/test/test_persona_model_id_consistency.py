"""
Regression test for the persona-generation model-id drift fix (PR #372).

``generate_personas`` used to call ``get_active_model_id('documents')`` twice:
once implicitly inside ``converse_chain`` (per step) and again, independently,
when stamping ``llm_metadata.model`` on each saved persona. If the surface's
active model changed between those two reads, the stored metadata would name
a model that never actually produced the persona. The fix resolves the model
once and threads it into both ``converse_chain`` and the saved metadata.

This test forces `get_active_model_id` to return a different value on each
call, which would make the drift observable if the single-resolution fix were
reverted: the metadata would then record the second call's value instead of
the one actually passed to ``converse_chain``.
"""
import json
from unittest.mock import MagicMock, patch


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


def _make_feedback_item(i):
    return {
        "feedback_id": f"fb-{i}",
        "original_text": f"Feedback item {i}.",
        "source_platform": "app_store",
        "sentiment": "neutral",
        "category": "general",
    }


def test_persona_llm_metadata_matches_model_used_for_generation():
    import projects

    mock_table = MagicMock()
    mock_table.query.return_value = {"Items": []}
    batch_writer = MagicMock()
    batch_writer.__enter__ = MagicMock(return_value=MagicMock())
    batch_writer.__exit__ = MagicMock(return_value=False)
    mock_table.batch_writer.return_value = batch_writer

    chain_results = ["Research analysis text.", MINIMAL_PERSONA_JSON]
    converse_chain_mock = MagicMock(return_value=chain_results)

    # Two distinct values: the fix must resolve the model ONCE and reuse it,
    # not call get_active_model_id again when writing llm_metadata.
    model_ids = ["model-at-generation-time", "model-that-changed-afterward"]

    with patch("projects.projects_table", mock_table), \
         patch("projects.get_feedback_context",
               return_value=[_make_feedback_item(i) for i in range(5)]), \
         patch("projects.converse_chain", converse_chain_mock), \
         patch("projects.get_active_model_id", side_effect=model_ids), \
         patch("projects.generate_persona_avatar",
               return_value={"avatar_url": None, "avatar_prompt": None}):
        projects.generate_personas(
            "proj-test",
            {"persona_count": 1, "generate_avatars": False},
        )

    assert converse_chain_mock.called, "generate_personas did not invoke converse_chain"
    _, chain_kwargs = converse_chain_mock.call_args
    assert chain_kwargs.get("model_id") == "model-at-generation-time", (
        "converse_chain must receive the model resolved for this generation, "
        f"got {chain_kwargs.get('model_id')!r}"
    )

    assert mock_table.put_item.called, "generate_personas did not save any persona"
    saved_item = mock_table.put_item.call_args.kwargs["Item"]
    assert saved_item["llm_metadata"]["model"] == "model-at-generation-time", (
        "llm_metadata.model drifted from the model that actually generated "
        f"the persona, got {saved_item['llm_metadata']['model']!r}"
    )
