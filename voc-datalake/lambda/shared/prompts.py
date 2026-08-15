"""
Shared prompt loading utilities for VoC Lambda functions.
Loads LLM prompts from external JSON files in the prompts/ directory.
"""

import json
from pathlib import Path
from functools import lru_cache

from shared.logging import logger

# Fallback token budget for a chain step whose config omits max_tokens. Kept as a
# named constant because two readers apply it (the chain builder and the
# inference-config accessor) and they must not drift.
DEFAULT_STEP_MAX_TOKENS = 4096

# Prompt config filenames. Named so a file referenced from more than one place
# (research: the sync chain builder AND the async step accessor; avatar: the
# prompt config AND the image-model block) can't drift by typo.
PERSONA_GENERATION_PROMPTS = 'persona-generation.json'
PRD_GENERATION_PROMPTS = 'prd-generation.json'
PRFAQ_GENERATION_PROMPTS = 'prfaq-generation.json'
RESEARCH_ANALYSIS_PROMPTS = 'research-analysis.json'
AVATAR_GENERATION_PROMPTS = 'avatar-generation.json'


def get_prompts_dir() -> Path:
    """Get the prompts directory path."""
    # Lambda packages prompts at the root level
    lambda_path = Path('/var/task/prompts')
    if lambda_path.exists():
        return lambda_path
    
    # Local development / tests - repo layout keeps them in lambda/api/prompts
    repo_path = Path(__file__).parent.parent / 'api' / 'prompts'
    if repo_path.exists():
        return repo_path
    
    # Fallback - try current working directory
    cwd_path = Path.cwd() / 'prompts'
    if cwd_path.exists():
        return cwd_path
    
    raise FileNotFoundError("Could not locate prompts directory")


@lru_cache(maxsize=32)
def load_prompt_file(filename: str) -> dict:
    """
    Load a prompt configuration file.
    
    Args:
        filename: Name of the prompt file (e.g., 'persona-generation.json')
    
    Returns:
        Parsed JSON content as dict
    
    Raises:
        FileNotFoundError: If prompt file doesn't exist
        json.JSONDecodeError: If file is not valid JSON
    """
    prompts_dir = get_prompts_dir()
    filepath = prompts_dir / filename
    
    if not filepath.exists():
        raise FileNotFoundError(f"Prompt file not found: {filepath}")
    
    # Explicit encoding: prompt files carry em dashes / typographic quotes,
    # and open()'s default encoding is locale-dependent outside Lambda.
    with open(filepath, 'r', encoding='utf-8') as f:
        content = json.load(f)
    
    logger.debug(f"Loaded prompt file: {filename}")
    return content


def format_prompt(template: str, **kwargs) -> str:
    """
    Format a prompt template with provided values.
    
    Uses str.format() style placeholders: {variable_name}
    Missing keys are left as-is (no error).
    
    Args:
        template: Prompt template string
        **kwargs: Values to substitute
    
    Returns:
        Formatted prompt string
    """
    try:
        return template.format(**kwargs)
    except KeyError:
        # Partial formatting - replace what we can
        result = template
        for key, value in kwargs.items():
            result = result.replace('{' + key + '}', str(value))
        return result


def _get_step(filename: str, step_name: str) -> dict:
    """Fetch one step's raw config block, with a clear error if it's absent."""
    steps_config = load_prompt_file(filename).get('steps', {})
    if step_name not in steps_config:
        raise KeyError(f"Step '{step_name}' not found in {filename}")
    return steps_config[step_name]


def _inference_from_step(step: dict, step_name: str) -> dict:
    """Pull the inference settings out of a raw step config block.

    Single home for the per-field defaults so the chain builder and the public
    accessor below cannot drift apart — including 'step_name', which both paths
    report to Bedrock logging and which must therefore resolve identically.
    """
    return {
        'system_prompt': step.get('system_prompt', ''),
        'max_tokens': step.get('max_tokens', DEFAULT_STEP_MAX_TOKENS),
        'thinking_budget': step.get('thinking_budget', 0),
        'step_name': step.get('name', step_name),
    }


def get_step_inference_config(filename: str, step_name: str) -> dict:
    """
    System prompt and token budgets for one chain step, WITHOUT building the
    user prompt.

    For callers that assemble their own user prompt but must still share the
    chain config — specifically the async Step Functions research path, whose
    prompt carries extra context (personas, documents, web search) that the
    templated sync path does not. Before this existed, that path hardcoded its
    own budgets and duplicated the system prompts, so editing the JSON silently
    did nothing for it (the config looked authoritative but was never read).

    Args:
        filename: Name of the prompt file
        step_name: Step key within the file's "steps" object

    Returns:
        Dict with 'system_prompt', 'max_tokens', 'thinking_budget' and
        'step_name' (the config's 'name', falling back to the step key)
    """
    return _inference_from_step(_get_step(filename, step_name), step_name)


def build_chain_steps(filename: str, step_names: list[str], context: dict) -> list[dict]:
    """
    Build a list of LLM chain steps from a prompt file.
    
    Args:
        filename: Name of the prompt file
        step_names: List of step names to include in order
        context: Dict of values to format into prompts
    
    Returns:
        List of step dicts ready for invoke_bedrock_chain()
    """
    response_language = context.pop('response_language', None)
    language_instruction = get_response_language_instruction(response_language)
    
    chain_steps = []
    for step_name in step_names:
        step = _get_step(filename, step_name)
        inference = _inference_from_step(step, step_name)
        system = inference['system_prompt']
        if language_instruction:
            system = f"{system}\n\n{language_instruction}"
        chain_steps.append({
            'system': system,
            'user': format_prompt(step.get('user_prompt_template', ''), **context),
            'max_tokens': inference['max_tokens'],
            'thinking_budget': inference['thinking_budget'],
            'step_name': inference['step_name'],
        })
    
    return chain_steps


def get_response_language_instruction(language_code: str | None) -> str:
    """
    Build a language instruction to append to system prompts.
    
    Args:
        language_code: ISO language code (e.g. 'en', 'es', 'ko').
                       If None or 'en', returns empty string.
    
    Returns:
        Instruction string like 'IMPORTANT: You MUST respond entirely in Spanish (es).'
    """
    if not language_code or language_code == 'en':
        return ''
    
    # Map of common codes to display names
    _names = {
        'es': 'Spanish', 'fr': 'French', 'de': 'German', 'pt': 'Portuguese',
        'ja': 'Japanese', 'zh': 'Chinese', 'ko': 'Korean', 'it': 'Italian',
        'nl': 'Dutch', 'ru': 'Russian', 'ar': 'Arabic', 'hi': 'Hindi',
        'sv': 'Swedish', 'pl': 'Polish', 'tr': 'Turkish', 'da': 'Danish',
        'no': 'Norwegian', 'fi': 'Finnish', 'th': 'Thai', 'vi': 'Vietnamese',
        'uk': 'Ukrainian', 'ro': 'Romanian', 'cs': 'Czech', 'el': 'Greek',
        'hu': 'Hungarian', 'he': 'Hebrew', 'id': 'Indonesian', 'ms': 'Malay',
        'bg': 'Bulgarian', 'hr': 'Croatian', 'sk': 'Slovak', 'sl': 'Slovenian',
        'sr': 'Serbian', 'ca': 'Catalan', 'tl': 'Filipino',
    }
    name = _names.get(language_code, language_code)
    return f'IMPORTANT: You MUST respond entirely in {name} ({language_code}). All text, headings, labels, and explanations must be in {name}.'


# Convenience functions for specific prompt types

def get_persona_generation_steps(
    persona_count: int,
    feedback_stats: str,
    feedback_context: str,
    custom_instructions: str = '',
    response_language: str | None = None,
) -> list[dict]:
    """Build persona generation chain steps."""
    custom_section = f"\n\n## ADDITIONAL INSTRUCTIONS:\n{custom_instructions}\n" if custom_instructions else ""
    
    # Truncate feedback for synthesis step
    feedback_sample = feedback_context[:15000] if len(feedback_context) > 15000 else feedback_context
    
    context = {
        'persona_count': persona_count,
        'feedback_stats': feedback_stats,
        'feedback_context': feedback_context,
        'feedback_sample': feedback_sample,
        'custom_section': custom_section,
        'previous': '{previous}',  # Placeholder for chain
        'response_language': response_language,
    }
    
    # persona_synthesis is LAST on purpose: its output is the JSON that gets
    # saved, so nothing billed runs after the personas exist. A third
    # 'validation' step used to follow it — it cost about half the job's wall
    # clock (131s of 268s measured for 2 personas), its output was never read
    # for persona data, and a failure in it threw away personas that
    # persona_synthesis had already produced.
    return build_chain_steps(
        PERSONA_GENERATION_PROMPTS,
        ['research_analysis', 'persona_synthesis'],
        context
    )


def get_prd_generation_steps(
    feature_idea: str,
    personas_context: str,
    feedback_context: str,
    response_language: str | None = None,
    product_context: str = "(No product context provided.)",
) -> list[dict]:
    """Build PRD generation chain steps."""
    context = {
        'feature_idea': feature_idea,
        'personas_context': personas_context,
        'feedback_context': feedback_context,
        'product_context': product_context,
        'previous': '{previous}',
        'response_language': response_language,
    }
    
    return build_chain_steps(
        PRD_GENERATION_PROMPTS,
        ['problem_analysis', 'solution_design', 'prd_document'],
        context
    )


# NOTE: parameters of this builder are classified (slot vs non-slot) in
# TestPrfaqPromptContract (shared/test/test_prompt_utils.py) — adding or
# renaming a parameter requires updating that classification; its signature
# drift test fails loudly if you forget.
def get_prfaq_generation_steps(
    feature_idea: str,
    personas_context: str,
    feedback_context: str,
    response_language: str | None = None,
    product_context: str = "(No product context provided.)",
) -> list[dict]:
    """Build PR/FAQ generation chain steps."""
    # Pin the launch date roughly three months out from today. Without this,
    # the model defaults to its training-cutoff date and produces dates in the
    # past — confusing for "Working Backwards" docs, which are supposed to
    # describe a near-future launch.
    from datetime import datetime, timedelta, timezone
    launch_date = (datetime.now(timezone.utc) + timedelta(days=90)).strftime('%Y-%m-%d')

    context = {
        'feature_idea': feature_idea,
        'personas_context': personas_context,
        'feedback_context': feedback_context,
        'product_context': product_context,
        'launch_date': launch_date,
        'previous': '{previous}',
        'response_language': response_language,
    }

    return build_chain_steps(
        PRFAQ_GENERATION_PROMPTS,
        ['customer_thinking', 'press_release', 'customer_faq', 'internal_faq'],
        context
    )


def get_research_analysis_steps(
    research_question: str,
    feedback_stats: str,
    feedback_context: str,
    feedback_count: int,
    response_language: str | None = None,
) -> list[dict]:
    """Build research analysis chain steps."""
    context = {
        'research_question': research_question,
        'feedback_stats': feedback_stats,
        'feedback_context': feedback_context,
        'feedback_count': feedback_count,
        'previous': '{previous}',
        'response_language': response_language,
    }
    
    return build_chain_steps(
        RESEARCH_ANALYSIS_PROMPTS,
        ['data_analysis', 'synthesis', 'validation'],
        context
    )


def get_research_step_config(step_name: str) -> dict:
    """Inference config for one research step.

    Used by the async Step Functions research handler so both research paths
    share one set of system prompts and token budgets. See
    get_step_inference_config for why the async path can't use the chain
    builder directly.
    """
    return get_step_inference_config(RESEARCH_ANALYSIS_PROMPTS, step_name)


def get_avatar_prompt_config() -> dict:
    """Get avatar generation prompt configuration."""
    return load_prompt_file(AVATAR_GENERATION_PROMPTS)



