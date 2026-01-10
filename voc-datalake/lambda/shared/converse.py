"""
Bedrock Converse API utilities for VoC Lambda functions.
Provides a unified interface for LLM interactions with optional tool use.
"""

import random
import time
from typing import Callable
from botocore.exceptions import ClientError
from shared.logging import logger
from shared.aws import get_bedrock_client, BEDROCK_MODEL_ID


# Retry configuration
DEFAULT_MAX_RETRIES = 5
DEFAULT_BASE_DELAY = 1.0  # seconds
DEFAULT_MAX_DELAY = 30.0  # seconds

# Retryable error codes
RETRYABLE_ERROR_CODES = frozenset({
    'ThrottlingException',
    'ServiceUnavailableException',
    'ModelStreamErrorException',
})


class BedrockThrottlingError(Exception):
    """Raised when Bedrock is throttled after max retries."""
    pass


def converse(
    prompt: str,
    system_prompt: str = "",
    max_tokens: int = 2048,
    temperature: float = 0.1,
    thinking_budget: int = 0,
    model_id: str | None = None,
    max_retries: int = DEFAULT_MAX_RETRIES,
    raise_on_throttle: bool = True,
    step_name: str = "unknown",
) -> str:
    """
    Simple text completion using Bedrock Converse API with retry support.

    Args:
        prompt: User message/prompt
        system_prompt: Optional system prompt
        max_tokens: Maximum tokens in response (default: 2048)
        temperature: Model temperature (default: 0.1)
        thinking_budget: If > 0, enables extended thinking with this token budget
        model_id: Optional model ID override
        max_retries: Maximum retry attempts for throttling (default: 5)
        raise_on_throttle: If True, raise BedrockThrottlingError after max retries
        step_name: Name of the current step for logging

    Returns:
        Model response text

    Raises:
        BedrockThrottlingError: If throttled after max retries and raise_on_throttle=True
        ClientError: For non-retryable AWS errors
    """
    used_model = model_id or BEDROCK_MODEL_ID
    logger.info(f"[BEDROCK] Starting converse call for step '{step_name}' with model {used_model}")
    logger.info(f"[BEDROCK] Request params: max_tokens={max_tokens}, temperature={temperature}, thinking_budget={thinking_budget}")
    logger.info(f"[BEDROCK] Prompt length: {len(prompt)} chars, system_prompt length: {len(system_prompt)} chars")
    
    try:
        client = get_bedrock_client()
        logger.info(f"[BEDROCK] Got Bedrock client successfully")
    except Exception as e:
        logger.error(f"[BEDROCK] Failed to get Bedrock client: {e}")
        raise
    
    messages = [{'role': 'user', 'content': [{'text': prompt}]}]
    system = [{'text': system_prompt}] if system_prompt else None
    
    kwargs = {
        'modelId': used_model,
        'messages': messages,
        'inferenceConfig': {
            'maxTokens': max_tokens,
            'temperature': temperature,
        }
    }
    if system:
        kwargs['system'] = system
    
    # Add extended thinking if budget specified
    if thinking_budget > 0:
        kwargs['additionalModelRequestFields'] = {
            'thinking': {
                'type': 'enabled',
                'budget_tokens': thinking_budget
            }
        }
    
    logger.info(f"[BEDROCK] Invoking Bedrock converse API for step '{step_name}'...")
    start_time = time.time()
    
    try:
        result = _invoke_with_retry(
            client=client,
            kwargs=kwargs,
            max_retries=max_retries,
            raise_on_throttle=raise_on_throttle,
            step_name=step_name,
        )
        elapsed = time.time() - start_time
        logger.info(f"[BEDROCK] Step '{step_name}' completed in {elapsed:.2f}s, response length: {len(result)} chars")
        return result
    except Exception as e:
        elapsed = time.time() - start_time
        logger.error(f"[BEDROCK] Step '{step_name}' FAILED after {elapsed:.2f}s: {type(e).__name__}: {e}")
        raise


def _invoke_with_retry(
    client,
    kwargs: dict,
    max_retries: int = DEFAULT_MAX_RETRIES,
    raise_on_throttle: bool = True,
    step_name: str = "unknown",
) -> str:
    """
    Invoke Bedrock converse with exponential backoff retry.

    Args:
        client: Bedrock runtime client
        kwargs: Arguments for client.converse()
        max_retries: Maximum retry attempts
        raise_on_throttle: If True, raise BedrockThrottlingError after max retries
        step_name: Name of the current step for logging

    Returns:
        Model response text

    Raises:
        BedrockThrottlingError: If throttled after max retries and raise_on_throttle=True
    """
    last_exception = None
    
    for attempt in range(max_retries):
        logger.info(f"[BEDROCK] Attempt {attempt + 1}/{max_retries} for step '{step_name}'")
        attempt_start = time.time()
        
        try:
            logger.info(f"[BEDROCK] Calling client.converse() for step '{step_name}'...")
            response = client.converse(**kwargs)
            attempt_elapsed = time.time() - attempt_start
            
            # Log response metadata
            usage = response.get('usage', {})
            stop_reason = response.get('stopReason', 'unknown')
            input_tokens = usage.get('inputTokens', 0)
            output_tokens = usage.get('outputTokens', 0)
            
            logger.info(f"[BEDROCK] Response received for step '{step_name}' in {attempt_elapsed:.2f}s")
            logger.info(f"[BEDROCK] Usage: input_tokens={input_tokens}, output_tokens={output_tokens}, stop_reason={stop_reason}")
            
            content = response.get('output', {}).get('message', {}).get('content', [])
            
            if attempt > 0:
                logger.info(f"[BEDROCK] Bedrock succeeded after {attempt + 1} attempts for step '{step_name}'")
            
            result = _extract_text(content)
            logger.info(f"[BEDROCK] Extracted {len(result)} chars from response for step '{step_name}'")
            return result
            
        except ClientError as e:
            attempt_elapsed = time.time() - attempt_start
            error_code = e.response.get('Error', {}).get('Code', '')
            error_message = e.response.get('Error', {}).get('Message', str(e))
            last_exception = e
            
            logger.error(f"[BEDROCK] ClientError for step '{step_name}' after {attempt_elapsed:.2f}s: {error_code} - {error_message}")
            
            if error_code in RETRYABLE_ERROR_CODES:
                if attempt < max_retries - 1:
                    delay = _calculate_backoff(attempt)
                    logger.warning(
                        f"[BEDROCK] Retryable error {error_code} for step '{step_name}' "
                        f"(attempt {attempt + 1}/{max_retries}), retrying in {delay:.2f}s"
                    )
                    time.sleep(delay)
                    continue
                else:
                    logger.error(f"[BEDROCK] Step '{step_name}' throttled after {max_retries} attempts")
                    if raise_on_throttle:
                        raise BedrockThrottlingError(
                            f"Bedrock throttled after {max_retries} retries for step '{step_name}'"
                        ) from e
            else:
                # Non-retryable error
                logger.error(f"[BEDROCK] Non-retryable error for step '{step_name}': {error_code} - {error_message}")
                raise
                
        except Exception as e:
            attempt_elapsed = time.time() - attempt_start
            last_exception = e
            logger.error(f"[BEDROCK] Unexpected error for step '{step_name}' after {attempt_elapsed:.2f}s: {type(e).__name__}: {e}")
            
            if attempt < max_retries - 1:
                delay = _calculate_backoff(attempt)
                logger.warning(
                    f"[BEDROCK] Retrying step '{step_name}' in {delay:.2f}s "
                    f"(attempt {attempt + 1}/{max_retries})"
                )
                time.sleep(delay)
            else:
                logger.error(f"[BEDROCK] Step '{step_name}' failed after {max_retries} attempts: {e}")
                raise
    
    # Should not reach here, but handle gracefully
    logger.error(f"[BEDROCK] Step '{step_name}' exhausted all retries without success")
    if raise_on_throttle and last_exception:
        raise BedrockThrottlingError(
            f"Bedrock failed after {max_retries} retries for step '{step_name}': {last_exception}"
        )
    return ""


def _calculate_backoff(attempt: int) -> float:
    """Calculate exponential backoff delay with jitter."""
    delay = min(
        DEFAULT_BASE_DELAY * (2 ** attempt) + random.uniform(0, 1),
        DEFAULT_MAX_DELAY
    )
    return delay


def converse_chain(
    steps: list[dict],
    progress_callback: Callable[[int, str], None] | None = None,
    max_retries: int = DEFAULT_MAX_RETRIES,
) -> list[str]:
    """
    Execute a chain of LLM calls, each building on the previous.
    
    Each step can have:
        - system: System prompt
        - user: User message (use {previous} to inject previous result)
        - max_tokens: Max output tokens (default 4096)
        - thinking_budget: Extended thinking budget (default 0 = disabled)
        - step_name: Optional name for progress reporting
    
    Args:
        steps: List of step configurations
        progress_callback: Optional callback(progress: int, step: str) to report progress
        max_retries: Maximum retry attempts for throttling (default: 5)
    
    Returns:
        List of results from each step
    """
    results = []
    context = ""
    total_steps = len(steps)
    
    logger.info(f"[CHAIN] Starting LLM chain with {total_steps} steps")
    chain_start = time.time()
    
    for i, step in enumerate(steps, 1):
        step_name = step.get('step_name', f'llm_step_{i}')
        logger.info(f"[CHAIN] ========== STEP {i}/{total_steps}: {step_name} ==========")
        
        # Report progress (distribute 15-75% across LLM steps)
        if progress_callback:
            progress = 15 + int((i - 1) / total_steps * 60)
            logger.info(f"[CHAIN] Reporting progress: {progress}% for step '{step_name}'")
            try:
                progress_callback(progress, step_name)
                logger.info(f"[CHAIN] Progress callback succeeded for step '{step_name}'")
            except Exception as e:
                logger.warning(f"[CHAIN] Progress callback failed for step '{step_name}': {e}")
        
        system = step.get('system', '')
        user = step.get('user', '').replace('{previous}', context)
        thinking_budget = step.get('thinking_budget', 0)
        max_tokens = step.get('max_tokens', 4096)
        
        logger.info(f"[CHAIN] Step '{step_name}' config: max_tokens={max_tokens}, thinking_budget={thinking_budget}")
        logger.info(f"[CHAIN] Step '{step_name}' system_prompt length: {len(system)} chars")
        logger.info(f"[CHAIN] Step '{step_name}' user_prompt length: {len(user)} chars")
        
        step_start = time.time()
        try:
            result = converse(
                prompt=user,
                system_prompt=system,
                max_tokens=max_tokens,
                thinking_budget=thinking_budget,
                max_retries=max_retries,
                step_name=step_name,
            )
            step_elapsed = time.time() - step_start
            logger.info(f"[CHAIN] Step '{step_name}' completed in {step_elapsed:.2f}s, output length: {len(result)} chars")
            results.append(result)
            context = result
        except Exception as e:
            step_elapsed = time.time() - step_start
            logger.error(f"[CHAIN] Step '{step_name}' FAILED after {step_elapsed:.2f}s: {type(e).__name__}: {e}")
            raise
    
    chain_elapsed = time.time() - chain_start
    logger.info(f"[CHAIN] LLM chain completed: {total_steps} steps in {chain_elapsed:.2f}s")
    return results


def converse_with_tools(
    prompt: str,
    system_prompt: str,
    tools: list[dict],
    tool_executor: Callable[[str, dict], str],
    max_tokens: int = 2000,
    max_iterations: int = 4,
    model_id: str | None = None,
) -> tuple[str, list]:
    """
    Converse with tool use support (agentic loop).

    Args:
        prompt: User message/prompt
        system_prompt: System prompt with context
        tools: List of tool specifications in Converse format
        tool_executor: Function(tool_name, tool_input) -> result_string
        max_tokens: Maximum tokens per response
        max_iterations: Maximum tool use iterations
        model_id: Optional model ID override

    Returns:
        Tuple of (response_text, collected_metadata)
        - collected_metadata is a list of dicts from tool executions
    """
    client = get_bedrock_client()
    
    messages = [{'role': 'user', 'content': [{'text': prompt}]}]
    tool_config = {'tools': tools}
    collected_metadata = []
    
    for iteration in range(max_iterations):
        logger.info(f"Converse iteration {iteration + 1}")
        
        kwargs = {
            'modelId': model_id or BEDROCK_MODEL_ID,
            'system': [{'text': system_prompt}],
            'messages': messages,
            'toolConfig': tool_config,
            'inferenceConfig': {'maxTokens': max_tokens}
        }
        
        response = client.converse(**kwargs)
        output = response.get('output', {})
        content = output.get('message', {}).get('content', [])
        
        if response.get('stopReason') == 'tool_use':
            tool_results, metadata = _process_tool_uses(content, tool_executor)
            collected_metadata.extend(metadata)
            
            if not tool_results:
                return _extract_text(content), collected_metadata
            
            messages.append({'role': 'assistant', 'content': content})
            messages.append({'role': 'user', 'content': tool_results})
        else:
            return _extract_text(content), collected_metadata
    
    logger.warning("Max tool iterations reached")
    return "Analysis incomplete. Please try a more specific question.", collected_metadata


def _extract_text(content_blocks: list) -> str:
    """Extract text from Converse API content blocks."""
    return ''.join(block.get('text', '') for block in content_blocks if 'text' in block)


def _process_tool_uses(
    content_blocks: list,
    tool_executor: Callable[[str, dict], str],
) -> tuple[list, list]:
    """
    Process all toolUse blocks and execute tools.

    Returns:
        Tuple of (tool_results, metadata_list)
    """
    tool_results = []
    metadata_list = []
    
    for block in content_blocks:
        if 'toolUse' not in block:
            continue
        
        tool_use = block['toolUse']
        tool_name = tool_use.get('name', '')
        tool_use_id = tool_use.get('toolUseId', '')
        tool_input = tool_use.get('input', {})
        
        logger.info(f"Executing tool '{tool_name}': {tool_input}")
        
        try:
            result, metadata = tool_executor(tool_name, tool_input)
            if metadata:
                metadata_list.append(metadata)
        except Exception as e:
            logger.exception(f"Tool execution error: {e}")
            result = f"Error executing tool: {str(e)}"
        
        tool_results.append({
            'toolResult': {
                'toolUseId': tool_use_id,
                'content': [{'text': result}]
            }
        })
    
    return tool_results, metadata_list


def build_tool_spec(
    name: str,
    description: str,
    properties: dict,
    required: list | None = None,
) -> dict:
    """
    Build a tool specification for Converse API.

    Args:
        name: Tool name
        description: Tool description
        properties: JSON Schema properties dict
        required: List of required property names

    Returns:
        Tool spec dict for Converse API toolConfig
    """
    return {
        'toolSpec': {
            'name': name,
            'description': description,
            'inputSchema': {
                'json': {
                    'type': 'object',
                    'properties': properties,
                    'required': required or []
                }
            }
        }
    }


# ============================================
# VoC Chat Tool Definitions
# ============================================

def get_search_feedback_tool() -> dict:
    """
    Get the search_feedback tool specification for VoC AI Chat.
    
    Returns:
        Tool spec dict for Converse API toolConfig
    """
    return build_tool_spec(
        name='search_feedback',
        description=(
            'Search and retrieve customer feedback/reviews from the database. '
            'Use this tool ONLY when the user is asking about customer feedback, reviews, complaints, or opinions. '
            'Do NOT use for greetings, general questions, or non-feedback topics. '
            'You can also look up a specific review by its ID (32-character hex string).'
        ),
        properties={
            'query': {
                'type': 'string',
                'description': 'Search query to find relevant feedback (e.g., "delivery", "pricing", "app crash"). Can also be a feedback ID for direct lookup.'
            },
            'source': {
                'type': 'string',
                'description': 'Filter by source platform (e.g., "trustpilot", "google_reviews", "twitter").'
            },
            'category': {
                'type': 'string',
                'description': 'Filter by category (e.g., "delivery", "customer_support", "product_quality").'
            },
            'sentiment': {
                'type': 'string',
                'enum': ['positive', 'negative', 'neutral', 'mixed'],
                'description': 'Filter by sentiment.'
            },
            'urgency': {
                'type': 'string',
                'enum': ['high', 'medium', 'low'],
                'description': 'Filter by urgency level.'
            },
            'limit': {
                'type': 'integer',
                'description': 'Maximum number of feedback items to return (default: 15, max: 30).'
            }
        },
        required=[]
    )
