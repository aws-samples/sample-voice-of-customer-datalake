"""Tests for persona importer job handler.

What the handler SENDS and WRITES is pinned literally in
`test_handler_mutation.py`; this file keeps the guards on the prompt template
itself, which no handler mutant can reach.
"""

import pytest


class TestImportPromptComesFromTheTemplate:
    """The root cause of the persona-shape divergence, and its guard.

    This handler used to hand-build its prompt inline with a schema string whose
    every section was the literal `{...}`:

        '{"identity": {...}, "goals_motivations": {...}, "pain_points": {...}, …}'

    so the model was told the section NAMES and nothing about their contents. It
    complied — imported personas carry `primary_frustration`, `frustration`,
    `tooling`, `current_practices` where generated ones carry the canonical keys —
    and the persist block's `.get(k, {})` stored whatever came back.

    `api/prompts/persona-import.json` has held the full canonical key set the whole
    time, with example values that pin the TYPES and enums, and nothing loaded it.

    Revert map: restoring the inline `{...}` schema fails
    `test_the_prompt_names_the_canonical_inner_keys`; dropping the template's
    example values fails `test_the_schema_shown_pins_types_not_just_key_names`.
    """

    @staticmethod
    def _prompt_text(mock_bedrock) -> str:
        """Everything the model was actually shown, system prompt included."""
        kwargs = mock_bedrock.converse.call_args.kwargs
        blocks = [
            block.get('text', '')
            for message in kwargs.get('messages', [])
            for block in message.get('content', [])
        ]
        system = [s.get('text', '') for s in kwargs.get('system', [])]
        return '\n'.join(system + blocks)

    @pytest.mark.usefixtures("mock_dynamodb", "mock_jobs_table", "mock_bedrock", "mock_avatar_generation")
    def test_the_prompt_names_the_canonical_inner_keys(
        self, mock_bedrock,
        text_import_event, mock_bedrock_persona_response, lambda_context
    ):
        """Section names alone are what produced the divergence."""
        mock_bedrock.converse.return_value = mock_bedrock_persona_response
        from jobs.persona_importer.handler import lambda_handler

        lambda_handler(text_import_event, lambda_context)
        prompt = self._prompt_text(mock_bedrock)

        # One inner key per canonical section, covering every section
        # `list_personas` reports: what the reader publishes, the writer must ask
        # for, or the schema is honest about a shape nothing produces.
        for inner_key in ('age_range', 'primary_goal', 'current_challenges',
                          'blockers', 'workarounds', 'emotional_impact',
                          'current_solutions', 'tech_savviness',
                          'usage_context', 'devices', 'narrative', 'trigger'):
            assert inner_key in prompt, f"the model was never told about {inner_key}"

        assert '{...}' not in prompt, "the inline placeholder schema is back"

    @pytest.mark.usefixtures("mock_dynamodb", "mock_jobs_table", "mock_bedrock", "mock_avatar_generation")
    def test_the_schema_shown_pins_types_not_just_key_names(
        self, mock_bedrock,
        text_import_event, mock_bedrock_persona_response, lambda_context
    ):
        """`workarounds` was a STRING on one live row and a LIST on another.

        The example values are the type specification, so they have to reach the
        model: a bare key list would leave the same ambiguity that produced the
        mixed types.
        """
        mock_bedrock.converse.return_value = mock_bedrock_persona_response
        from jobs.persona_importer.handler import lambda_handler

        lambda_handler(text_import_event, lambda_context)
        prompt = self._prompt_text(mock_bedrock)

        assert '"workarounds": [' in prompt, "array-ness of workarounds not shown"
        assert 'low|medium|high' in prompt, "the tech_savviness enum not shown"

    def test_the_template_carries_every_key_the_handler_consumes(self):
        """The handler subscripts the template directly, so a dropped key must be
        caught HERE rather than at runtime.

        Why not `.get()` with fallbacks: a fallback would silently send a degraded
        prompt, which is the exact defect this whole change removes. And why it
        matters that it fails in CI — `shared/jobs.py::job_handler` writes `str(e)`
        into the job record as a USER-FACING message, so an unguarded `KeyError`
        would show someone `KeyError: 'output_schema'`. A red test here makes that
        runtime path unreachable, which is cheaper than a runtime guard for a
        condition CI already prevents.
        """
        from shared.prompts import PERSONA_IMPORT_PROMPTS, load_prompt_file

        config = load_prompt_file(PERSONA_IMPORT_PROMPTS)
        for key in ('system_prompt', 'output_schema', 'user_prompts', 'max_tokens', 'version'):
            assert key in config, f"the handler reads config[{key!r}] and it is gone"

        # Only the input types the product actually accepts need a user prompt;
        # `pdf` is deferred and its prompt is deliberately unwired.
        for input_type in ('text', 'image'):
            assert input_type in config['user_prompts']
        assert '{content}' in config['user_prompts']['text'], (
            "the text prompt lost its placeholder, so content would never be interpolated"
        )
