"""Tests for persona importer job handler."""

import pytest


class TestPersonaImporterHandler:
    """Tests for the persona importer job Lambda handler."""

    def test_successful_text_import(
        self, mock_dynamodb, mock_jobs_table, mock_bedrock,
        mock_avatar_generation, text_import_event, mock_bedrock_persona_response, lambda_context
    ):
        """Test successful persona import from text."""
        mock_bedrock.converse.return_value = mock_bedrock_persona_response
        
        from jobs.persona_importer.handler import lambda_handler
        
        result = lambda_handler(text_import_event, lambda_context)
        
        assert result['success'] is True
        assert 'persona_id' in result
        mock_bedrock.converse.assert_called_once()

    def test_successful_image_import(
        self, mock_dynamodb, mock_jobs_table, mock_bedrock,
        mock_avatar_generation, image_import_event, mock_bedrock_persona_response, lambda_context
    ):
        """Test successful persona import from image."""
        mock_bedrock.converse.return_value = mock_bedrock_persona_response
        
        from jobs.persona_importer.handler import lambda_handler
        
        result = lambda_handler(image_import_event, lambda_context)
        
        assert result['success'] is True
        assert 'persona_id' in result
        
        # Verify image was included in converse call
        call_args = mock_bedrock.converse.call_args
        messages = call_args.kwargs.get('messages', [])
        assert any('image' in str(m) for m in messages)

    def test_persona_saved_to_dynamodb(
        self, mock_dynamodb, mock_jobs_table, mock_bedrock,
        mock_avatar_generation, text_import_event, mock_bedrock_persona_response, lambda_context
    ):
        """Test that imported persona is saved to DynamoDB."""
        mock_bedrock.converse.return_value = mock_bedrock_persona_response
        
        from jobs.persona_importer.handler import lambda_handler
        
        lambda_handler(text_import_event, lambda_context)
        
        mock_dynamodb['table'].put_item.assert_called()
        put_call = mock_dynamodb['table'].put_item.call_args
        item = put_call.kwargs.get('Item', {})
        assert item.get('name') == 'Sarah Chen'
        assert item.get('imported_from') == 'text'

    def test_avatar_generated_for_imported_persona(
        self, mock_dynamodb, mock_jobs_table, mock_bedrock,
        mock_avatar_generation, text_import_event, mock_bedrock_persona_response, lambda_context
    ):
        """Test that avatar is generated for imported persona."""
        mock_bedrock.converse.return_value = mock_bedrock_persona_response
        
        from jobs.persona_importer.handler import lambda_handler
        
        lambda_handler(text_import_event, lambda_context)
        
        mock_avatar_generation.assert_called_once()
        
        # Verify avatar URL is saved
        put_call = mock_dynamodb['table'].put_item.call_args
        item = put_call.kwargs.get('Item', {})
        assert 'avatar_url' in item

    def test_handles_json_in_markdown_code_block(
        self, mock_dynamodb, mock_jobs_table, mock_bedrock,
        mock_avatar_generation, text_import_event, lambda_context
    ):
        """Test that handler extracts JSON from markdown code blocks."""
        mock_bedrock.converse.return_value = {
            'output': {
                'message': {
                    'content': [{
                        'text': '''Here's the extracted persona:
                        
```json
{
    "name": "Test User",
    "tagline": "A test persona",
    "confidence": "medium",
    "identity": {},
    "goals_motivations": {},
    "pain_points": {},
    "behaviors": {},
    "context_environment": {},
    "quotes": [],
    "scenario": {}
}
```'''
                    }]
                }
            }
        }
        
        from jobs.persona_importer.handler import lambda_handler
        
        result = lambda_handler(text_import_event, lambda_context)
        
        assert result['success'] is True
        put_call = mock_dynamodb['table'].put_item.call_args
        item = put_call.kwargs.get('Item', {})
        assert item.get('name') == 'Test User'

    def test_job_fails_on_invalid_json(
        self, mock_dynamodb, mock_jobs_table, mock_bedrock,
        mock_avatar_generation, text_import_event, lambda_context
    ):
        """Test that job fails when LLM returns invalid JSON."""
        from jobs.persona_importer.handler import lambda_handler
        from shared.exceptions import ServiceError
        
        mock_bedrock.converse.return_value = {
            'output': {
                'message': {
                    'content': [{'text': 'This is not valid JSON'}]
                }
            }
        }
        
        with pytest.raises(ServiceError):
            lambda_handler(text_import_event, lambda_context)
        
        mock_jobs_table.update_item.assert_called()

    def test_persona_count_incremented(
        self, mock_dynamodb, mock_jobs_table, mock_bedrock,
        mock_avatar_generation, text_import_event, mock_bedrock_persona_response, lambda_context
    ):
        """Test that project persona count is incremented."""
        mock_bedrock.converse.return_value = mock_bedrock_persona_response
        
        from jobs.persona_importer.handler import lambda_handler
        
        lambda_handler(text_import_event, lambda_context)
        
        # Verify update_item was called to increment persona_count
        update_calls = [c for c in mock_dynamodb['table'].update_item.call_args_list]
        assert any('persona_count' in str(c) for c in update_calls)


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

    def test_the_prompt_names_the_canonical_inner_keys(
        self, mock_dynamodb, mock_jobs_table, mock_bedrock,
        mock_avatar_generation, text_import_event, mock_bedrock_persona_response, lambda_context
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

    def test_the_schema_shown_pins_types_not_just_key_names(
        self, mock_dynamodb, mock_jobs_table, mock_bedrock,
        mock_avatar_generation, text_import_event, mock_bedrock_persona_response, lambda_context
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

    def test_the_text_prompt_interpolates_the_content(
        self, mock_dynamodb, mock_jobs_table, mock_bedrock,
        mock_avatar_generation, text_import_event, mock_bedrock_persona_response, lambda_context
    ):
        """The template's text prompt carries a `{content}` placeholder.

        Sending it unformatted would ask the model to extract a persona from the
        literal word `{content}` — the same class of defect as the hardcoded
        placeholder sentence this handler was already fixed for once.
        """
        mock_bedrock.converse.return_value = mock_bedrock_persona_response
        from jobs.persona_importer.handler import lambda_handler

        lambda_handler(text_import_event, lambda_context)
        prompt = self._prompt_text(mock_bedrock)

        assert '{content}' not in prompt

    def test_the_pdf_prompt_is_not_wired(
        self, mock_dynamodb, mock_jobs_table, mock_bedrock,
        mock_avatar_generation, text_import_event, mock_bedrock_persona_response, lambda_context
    ):
        """The template has a `pdf` user prompt; `pdf` is a DEFERRED input type.

        `validate_import_config` refuses it upstream, so a branch for it here would
        be unreachable code advertising a capability the product declines.

        Asserted against the template's own `pdf` prompt rather than a phrase
        copied out of it, so rewording the template cannot turn this green for a
        reason that has nothing to do with wiring.
        """
        mock_bedrock.converse.return_value = mock_bedrock_persona_response
        from shared.prompts import PERSONA_IMPORT_PROMPTS, load_prompt_file

        from jobs.persona_importer.handler import lambda_handler

        lambda_handler(text_import_event, lambda_context)

        pdf_prompt = load_prompt_file(PERSONA_IMPORT_PROMPTS)['user_prompts']['pdf']
        assert pdf_prompt not in self._prompt_text(mock_bedrock)

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

    def test_the_persisted_prompt_version_matches_the_template(
        self, mock_dynamodb, mock_jobs_table, mock_bedrock,
        mock_avatar_generation, text_import_event, mock_bedrock_persona_response, lambda_context
    ):
        """Lockstep, copying the `persona-generation.json` precedent.

        An imported persona used to record no prompt version at all, so a row with
        odd inner keys could not be attributed to the prompt that produced it —
        which is precisely the diagnosis that had to be reconstructed by hand.
        """
        mock_bedrock.converse.return_value = mock_bedrock_persona_response
        from shared.prompts import PERSONA_IMPORT_PROMPTS, load_prompt_file
        from jobs.persona_importer.handler import lambda_handler

        lambda_handler(text_import_event, lambda_context)

        item = mock_dynamodb['table'].put_item.call_args.kwargs.get('Item', {})
        expected = load_prompt_file(PERSONA_IMPORT_PROMPTS)['version']
        assert item['llm_metadata']['prompt_version'] == expected
