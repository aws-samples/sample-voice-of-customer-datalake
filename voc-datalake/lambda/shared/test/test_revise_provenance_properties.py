"""Property tests of the revise provenance and outcome rules (shared/document_revision.py).

A revised version records which model and which prompt wrote it, and whether the pass applied its changes or only
proposed them. In words:

- The provenance is exactly the model that answered and the prompt version, under the two names personas use.
- An AI-driven caller gets its changes applied; any other caller the gate allowed, or a document type the gate
  does not cover, gets a proposal.
"""
from __future__ import annotations

from hypothesis import given
from hypothesis import strategies as st

from shared import ai_mode
from shared import document_revision as rev
from shared.test.property_settings import PROPERTY

MODELS = st.text(alphabet='abcdefghijklmnop0123456789.:-', min_size=1, max_size=40)
PROMPTS = st.text(alphabet='abcdefghijklmnop0123456789.-', min_size=1, max_size=12)


class TestTheProvenanceNamesTheModelAndThePrompt:
    """Invariant: a revised version carries exactly two keys, the model that answered and the prompt version
    that asked; nothing is added and nothing is taken from them."""

    @PROPERTY
    @given(model=MODELS, prompt=PROMPTS)
    def test_model_and_prompt_version_are_recorded_as_given(self, model: str, prompt: str) -> None:
        assert rev.pass_llm_metadata(model, prompt) == {'model': model, 'prompt_version': prompt}

    @PROPERTY
    @given(model=MODELS)
    def test_the_default_prompt_is_the_current_revise_prompt(self, model: str) -> None:
        assert rev.pass_llm_metadata(model)['prompt_version'] == rev.REVISE_PROMPT_VERSION


class TestOnlyAnAIDrivenCallerGetsItsChangesApplied:
    """Invariant: the outcome is applied only for an AI-driven caller, and a proposal for any other caller the
    gate allowed or did not gate (None)."""

    @PROPERTY
    @given(mode=st.sampled_from([*ai_mode.MODES, 'off', '']))
    def test_applied_only_when_the_mode_is_ai_driven(self, mode: str) -> None:
        caller_mode = ai_mode.AiMode(mode=mode)
        expected = rev.OUTCOME_APPLIED if mode == ai_mode.MODE_AI_DRIVEN else rev.OUTCOME_PROPOSAL
        assert rev.writing_outcome(caller_mode) == expected

    def test_a_type_the_gate_does_not_name_is_a_proposal(self) -> None:
        assert rev.writing_outcome(None) == rev.OUTCOME_PROPOSAL
