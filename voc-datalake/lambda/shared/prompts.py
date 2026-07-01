"""
Shared prompt loading utilities for VoC Lambda functions.
Loads LLM prompts from external JSON files in the prompts/ directory.
"""

import json
from pathlib import Path
from functools import lru_cache

from shared.logging import logger


def get_prompts_dir() -> Path:
    """Get the prompts directory path."""
    # Lambda packages prompts at the root level
    lambda_path = Path('/var/task/prompts')
    if lambda_path.exists():
        return lambda_path
    
    # Local development - relative to lambda directory
    local_path = Path(__file__).parent.parent.parent / 'prompts'
    if local_path.exists():
        return local_path
    
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
    
    with open(filepath, 'r') as f:
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
    config = load_prompt_file(filename)
    steps_config = config.get('steps', {})
    response_language = context.pop('response_language', None)
    language_instruction = get_response_language_instruction(response_language)
    
    chain_steps = []
    for step_name in step_names:
        if step_name not in steps_config:
            raise KeyError(f"Step '{step_name}' not found in {filename}")
        
        step = steps_config[step_name]
        system = step.get('system_prompt', '')
        if language_instruction:
            system = f"{system}\n\n{language_instruction}"
        chain_steps.append({
            'system': system,
            'user': format_prompt(step.get('user_prompt_template', ''), **context),
            'max_tokens': step.get('max_tokens', 4096),
            'thinking_budget': step.get('thinking_budget', 0),
            'step_name': step.get('name', step_name),
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
    
    return build_chain_steps(
        'persona-generation.json',
        ['research_analysis', 'persona_synthesis', 'validation'],
        context
    )


def get_prd_generation_steps(
    feature_idea: str,
    personas_context: str,
    feedback_context: str,
    response_language: str | None = None,
) -> list[dict]:
    """Build PRD generation chain steps."""
    context = {
        'feature_idea': feature_idea,
        'personas_context': personas_context,
        'feedback_context': feedback_context,
        'previous': '{previous}',
        'response_language': response_language,
    }
    
    return build_chain_steps(
        'prd-generation.json',
        ['problem_analysis', 'solution_design', 'prd_document'],
        context
    )


def get_prfaq_generation_steps(
    feature_idea: str,
    personas_context: str,
    feedback_context: str,
    response_language: str | None = None,
) -> list[dict]:
    """Build PR/FAQ generation chain steps."""
    context = {
        'feature_idea': feature_idea,
        'personas_context': personas_context,
        'feedback_context': feedback_context,
        'previous': '{previous}',
        'response_language': response_language,
    }
    
    return build_chain_steps(
        'prfaq-generation.json',
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
        'research-analysis.json',
        ['data_analysis', 'synthesis', 'validation'],
        context
    )


def get_avatar_prompt_config() -> dict:
    """Get avatar generation prompt configuration."""
    return load_prompt_file('avatar-generation.json')



