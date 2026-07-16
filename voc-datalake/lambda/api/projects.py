"""
Projects API endpoints for VoC Analytics.
Handles projects, personas, PRDs, PR/FAQs with multi-step LLM orchestration.
"""
import json
import re
from datetime import datetime, timezone
from boto3.dynamodb.conditions import Key

# Shared module imports
from shared.logging import logger, tracer
from shared.aws import get_dynamodb_resource, get_bedrock_client, BEDROCK_MODEL_ID
from shared.api import validate_days
from shared.converse import converse_chain
from shared.exceptions import (
    ConfigurationError,
    NotFoundError,
    ValidationError,
    ServiceError,
)
from shared.prompts import (
    get_persona_generation_steps,
    get_prd_generation_steps,
    get_prfaq_generation_steps,
    get_research_analysis_steps,
)
from shared.feedback import (
    get_feedback_context as _get_feedback_context,
    format_feedback_for_llm,
    get_feedback_statistics,
)
from shared.avatar import (
    generate_persona_avatar as _generate_persona_avatar,
    get_avatar_cdn_url,
)

from shared.tables import get_projects_table, get_feedback_table

# AWS Clients (using shared module for connection reuse)
dynamodb = get_dynamodb_resource()


def generate_persona_avatar(persona_data: dict, s3_bucket: str = None) -> dict:
    """Wrapper for shared avatar generation that provides the bedrock client.
    
    Args:
        persona_data: Dict with persona info (name, tagline, identity, persona_id)
        s3_bucket: Optional S3 bucket override
        
    Returns:
        dict with 'avatar_url' and 'avatar_prompt'
    """
    bedrock_client = get_bedrock_client()
    return _generate_persona_avatar(persona_data, bedrock_client, s3_bucket)


def get_feedback_context(filters: dict, limit: int = 50) -> list[dict]:
    """Get feedback items based on filters for LLM context."""
    return _get_feedback_context(feedback_table, filters, limit)


projects_table = get_projects_table()
feedback_table = get_feedback_table()


def fix_persona_name(name: str) -> str:
    """Fix persona names that may be missing spaces between words.
    
    LLMs sometimes generate names like "VeronicaChen" instead of "Veronica Chen".
    This function adds spaces between lowercase and uppercase letter transitions.
    """
    return re.sub(r'([a-z])([A-Z])', r'\1 \2', name)


@tracer.capture_method
def list_projects() -> dict:
    """List all projects with accurate persona/document counts."""
    if not projects_table:
        return {'projects': []}
    
    response = projects_table.query(
        IndexName='gsi1-by-type',
        KeyConditionExpression=Key('gsi1pk').eq('TYPE#PROJECT'),
        ScanIndexForward=False
    )
    
    projects = []
    for item in response.get('Items', []):
        project_id = item.get('project_id')
        
        # Query actual items to get accurate counts
        items_response = projects_table.query(
            KeyConditionExpression=Key('pk').eq(f'PROJECT#{project_id}'),
            ProjectionExpression='sk'
        )
        
        persona_count = 0
        document_count = 0
        for proj_item in items_response.get('Items', []):
            sk = proj_item.get('sk', '')
            if sk.startswith('PERSONA#'):
                persona_count += 1
            elif sk.startswith('PRD#') or sk.startswith('PRFAQ#') or sk.startswith('RESEARCH#') or sk.startswith('DOC#') or sk.startswith('PRODUCT_REPORT#') or sk.startswith('PROTOTYPE#'):
                document_count += 1
        
        projects.append({
            'project_id': project_id,
            'name': item.get('name'),
            'description': item.get('description'),
            'status': item.get('status', 'active'),
            'created_at': item.get('created_at'),
            'updated_at': item.get('updated_at'),
            'persona_count': persona_count,
            'document_count': document_count,
        })
    
    return {'projects': projects}


@tracer.capture_method
def create_project(body: dict) -> dict:
    """Create a new project."""
    if not projects_table:
        raise ConfigurationError('Projects table not configured')
    
    project_id = f"proj_{datetime.now().strftime('%Y%m%d%H%M%S')}"
    now = datetime.now(timezone.utc).isoformat()
    
    item = {
        'pk': f'PROJECT#{project_id}',
        'sk': 'META',
        'gsi1pk': 'TYPE#PROJECT',
        'gsi1sk': now,
        'project_id': project_id,
        'name': body.get('name', 'New Project'),
        'description': body.get('description', ''),
        'status': 'active',
        'created_at': now,
        'updated_at': now,
        'persona_count': 0,
        'document_count': 0,
        'filters': body.get('filters', {}),
        'kiro_export_prompt': body.get('kiro_export_prompt', ''),
    }
    
    projects_table.put_item(Item=item)
    
    return {'success': True, 'project': item}


@tracer.capture_method
def get_project(project_id: str) -> dict:
    """Get a project with all its data."""
    if not projects_table:
        raise ConfigurationError('Projects table not configured')
    
    # Get all items for this project
    response = projects_table.query(
        KeyConditionExpression=Key('pk').eq(f'PROJECT#{project_id}')
    )
    
    items = response.get('Items', [])
    if not items:
        raise NotFoundError('Project not found')
    
    project = None
    personas = []
    documents = []
    
    for item in items:
        sk = item.get('sk', '')
        if sk == 'META':
            project = item
        elif sk.startswith('PERSONA#'):
            # Convert S3 URI to CloudFront CDN URL for avatar
            if item.get('avatar_url') and item['avatar_url'].startswith('s3://'):
                item['avatar_url'] = get_avatar_cdn_url(item['avatar_url'])
            personas.append(item)
        elif sk.startswith('PRD#') or sk.startswith('PRFAQ#') or sk.startswith('RESEARCH#') or sk.startswith('DOC#') or sk.startswith('PRODUCT_REPORT#') or sk.startswith('PROTOTYPE#'):
            documents.append(item)
    
    if not project:
        raise NotFoundError('Project metadata not found')
    
    return {
        'project': project,
        'personas': personas,
        'documents': documents
    }


@tracer.capture_method
def update_project(project_id: str, body: dict) -> dict:
    """Update a project."""
    if not projects_table:
        raise ConfigurationError('Projects table not configured')
    
    now = datetime.now(timezone.utc).isoformat()
    
    update_expr = 'SET updated_at = :now'
    expr_values = {':now': now}
    expr_names = {}
    
    if 'name' in body:
        update_expr += ', #name = :name'
        expr_values[':name'] = body['name']
        expr_names['#name'] = 'name'
    if 'description' in body:
        update_expr += ', description = :desc'
        expr_values[':desc'] = body['description']
    if 'status' in body:
        update_expr += ', #status = :status'
        expr_values[':status'] = body['status']
        expr_names['#status'] = 'status'
    if 'filters' in body:
        update_expr += ', filters = :filters'
        expr_values[':filters'] = body['filters']
    if 'kiro_export_prompt' in body:
        update_expr += ', kiro_export_prompt = :kiro_prompt'
        expr_values[':kiro_prompt'] = body['kiro_export_prompt']
    
    update_params = {
        'Key': {'pk': f'PROJECT#{project_id}', 'sk': 'META'},
        'UpdateExpression': update_expr,
        'ExpressionAttributeValues': expr_values,
    }
    if expr_names:
        update_params['ExpressionAttributeNames'] = expr_names
    
    projects_table.update_item(**update_params)
    
    return {'success': True}


@tracer.capture_method
def delete_project(project_id: str) -> dict:
    """Delete a project and all its data."""
    if not projects_table:
        raise ConfigurationError('Projects table not configured')
    
    # Get all items for this project
    response = projects_table.query(
        KeyConditionExpression=Key('pk').eq(f'PROJECT#{project_id}')
    )
    
    # Delete all items
    with projects_table.batch_writer() as batch:
        for item in response.get('Items', []):
            batch.delete_item(Key={'pk': item['pk'], 'sk': item['sk']})
    
    return {'success': True}



@tracer.capture_method
def generate_personas(project_id: str, filters: dict, progress_callback: callable = None) -> dict:
    """Generate full UX research personas from feedback data using multi-step LLM chain.
    
    Creates comprehensive personas with 8 sections:
    1. Identity & Demographics
    2. Goals & Motivations
    3. Pain Points & Frustrations
    4. Behaviors & Habits
    5. Context & Environment
    6. Representative Quotes
    7. Scenario/User Story
    8. Research Notes (empty, for user to fill)
    """
    import time
    
    logger.info("[PERSONA] ========== STARTING PERSONA GENERATION ==========")
    logger.info(f"[PERSONA] Project: {project_id}")
    logger.info(f"[PERSONA] Filters: {filters}")
    overall_start = time.time()
    
    def update_progress(progress: int, step: str):
        """Update progress if callback provided."""
        logger.info(f"[PERSONA] Progress update: {progress}% - step: {step}")
        if progress_callback:
            try:
                progress_callback(progress, step)
                logger.info("[PERSONA] Progress callback succeeded")
            except Exception as e:
                logger.warning(f"[PERSONA] Progress callback failed: {e}")
    
    if not projects_table:
        logger.error("[PERSONA] Projects table not configured")
        raise ConfigurationError('Projects table not configured')
    
    # Extract filter parameters
    persona_count = filters.get('persona_count', 3)
    custom_instructions = filters.get('custom_instructions', '')
    generate_avatars = filters.get('generate_avatars', True)
    logger.info(f"[PERSONA] Config: persona_count={persona_count}, generate_avatars={generate_avatars}")
    
    logger.info("[PERSONA] Step 1/6: Fetching feedback data...")
    update_progress(5, 'fetching_feedback')
    
    # Get feedback data
    try:
        feedback_items = get_feedback_context(filters, limit=50)
        logger.info(f"[PERSONA] Fetched {len(feedback_items) if feedback_items else 0} feedback items")
    except Exception as e:
        logger.error(f"[PERSONA] Failed to fetch feedback: {e}")
        raise
    
    if not feedback_items:
        logger.warning("[PERSONA] No feedback data found for filters")
        raise ValidationError('No feedback data found for the given filters')
    
    logger.info("[PERSONA] Step 2/6: Formatting feedback data for LLM...")
    update_progress(10, 'formatting_data')
    
    try:
        feedback_context = format_feedback_for_llm(feedback_items)
        feedback_stats = get_feedback_statistics(feedback_items)
        logger.info(f"[PERSONA] Formatted context: {len(feedback_context)} chars")
        logger.info(f"[PERSONA] Stats: {feedback_stats}")
    except Exception as e:
        logger.error(f"[PERSONA] Failed to format feedback: {e}")
        raise
    
    # Truncate context if too large
    if len(feedback_context) > 30000:
        feedback_context = feedback_context[:30000] + "\n\n[... additional feedback truncated ...]"
        logger.info("[PERSONA] Context truncated to 30000 chars")
    
    try:
        llm_start_time = time.time()
        
        logger.info("[PERSONA] Step 3/6: Building LLM chain steps from prompts...")
        update_progress(15, 'building_prompts')
        
        # Build chain steps from external prompt files
        try:
            chain_steps = get_persona_generation_steps(
                persona_count=persona_count,
                feedback_stats=feedback_stats,
                feedback_context=feedback_context,
                custom_instructions=custom_instructions,
                response_language=filters.get('response_language'),
            )
            logger.info(f"[PERSONA] Built {len(chain_steps)} chain steps")
        except Exception as e:
            logger.error(f"[PERSONA] Failed to build chain steps: {e}")
            raise
        
        logger.info("[PERSONA] Step 4/6: Executing LLM chain (this may take several minutes)...")
        update_progress(20, 'executing_llm_chain')
        
        try:
            results = converse_chain(chain_steps, progress_callback=lambda p, s: update_progress(p, s), surface='documents')
            logger.info(f"[PERSONA] LLM chain returned {len(results)} results")
        except Exception as e:
            logger.error(f"[PERSONA] LLM chain execution failed: {e}")
            raise
        
        llm_time = int((time.time() - llm_start_time) * 1000)
        logger.info(f"[PERSONA] LLM chain completed in {llm_time}ms")
        
        logger.info("[PERSONA] Step 5/6: Parsing personas from LLM output...")
        # Parse personas from output
        personas_data = []
        for idx, result_text in enumerate([results[1], results[2]]):
            logger.info(f"[PERSONA] Trying to parse result {idx}, length: {len(result_text)} chars")
            json_match = re.search(r'\[\s*\{[\s\S]*\}\s*\]', result_text)
            if json_match:
                try:
                    parsed = json.loads(json_match.group())
                    if isinstance(parsed, list) and len(parsed) > 0:
                        personas_data = parsed
                        logger.info(f"[PERSONA] Successfully parsed {len(personas_data)} personas from result {idx}")
                        break
                except json.JSONDecodeError as e:
                    logger.warning(f"[PERSONA] JSON parse failed for result {idx}: {e}")
                    continue
            else:
                logger.warning(f"[PERSONA] No JSON array found in result {idx}")
        
        if not personas_data:
            logger.error("[PERSONA] Failed to parse personas from any LLM output")
            raise ServiceError('Failed to parse persona data from LLM response')
        
        logger.info("[PERSONA] Step 6/6: Saving personas to database...")
        update_progress(80, 'saving_personas')

        # Replace semantics: delete any existing personas for this project first,
        # so re-running generation doesn't accumulate duplicates (e.g. "김지수" x2).
        # Without this, each generation appended a fresh set and @all roundtable
        # chat would have the same persona answer multiple times.
        existing_count = 0
        try:
            existing = projects_table.query(
                KeyConditionExpression=Key('pk').eq(f'PROJECT#{project_id}')
                & Key('sk').begins_with('PERSONA#'),
                ProjectionExpression='pk, sk',
            ).get('Items', [])
            if existing:
                with projects_table.batch_writer() as batch:
                    for it in existing:
                        batch.delete_item(Key={'pk': it['pk'], 'sk': it['sk']})
                existing_count = len(existing)
                logger.info(f"[PERSONA] Cleared {existing_count} existing persona(s) before regeneration")
        except Exception as e:
            logger.warning(f"[PERSONA] Failed to clear existing personas (continuing): {e}")

        # Calculate source breakdown
        source_breakdown = {}
        for item in feedback_items:
            src = item.get('source_platform', 'unknown')
            source_breakdown[src] = source_breakdown.get(src, 0) + 1
        
        # Save personas to project
        now = datetime.now(timezone.utc).isoformat()
        saved_personas = []
        
        for i, persona in enumerate(personas_data):
            persona_id = f"persona_{datetime.now().strftime('%Y%m%d%H%M%S')}_{i}"
            logger.info(f"[PERSONA] Saving persona {i+1}/{len(personas_data)}: {persona.get('name', 'unnamed')}")
            
            # Build the full persona item with all 8 sections
            item = {
                'pk': f'PROJECT#{project_id}',
                'sk': f'PERSONA#{persona_id}',
                'gsi1pk': f'PROJECT#{project_id}#PERSONAS',
                'gsi1sk': now,
                'persona_id': persona_id,
                'name': fix_persona_name(persona.get('name', f'Persona {i+1}')),
                'tagline': persona.get('tagline', ''),
                'confidence': persona.get('confidence', 'medium'),
                'feedback_count': persona.get('feedback_count', len(feedback_items) // persona_count),
                'identity': persona.get('identity', {}),
                'goals_motivations': persona.get('goals_motivations', {}),
                'pain_points': persona.get('pain_points', {}),
                'behaviors': persona.get('behaviors', {}),
                'context_environment': persona.get('context_environment', {}),
                'quotes': persona.get('quotes', []),
                'scenario': persona.get('scenario', {}),
                'research_notes': [],
                'supporting_evidence': persona.get('supporting_evidence', []),
                'source_breakdown': source_breakdown,
                'source_feedback_ids': [item.get('feedback_id', '') for item in feedback_items[:20]],
                'avatar_url': None,
                'avatar_prompt': None,
                'created_at': now,
                'updated_at': now,
                'llm_metadata': {
                    'model': BEDROCK_MODEL_ID,
                    'prompt_version': '2.0.0',
                    'generation_time_ms': llm_time
                },
            }
            
            # Generate avatar if enabled
            if generate_avatars:
                logger.info(f"[PERSONA] Generating avatar for persona {i+1}...")
                update_progress(85 + i * 3, f'generating_avatar_{i+1}')
                try:
                    avatar_result = generate_persona_avatar({'persona_id': persona_id, **persona})
                    item['avatar_url'] = avatar_result.get('avatar_url')
                    item['avatar_prompt'] = avatar_result.get('avatar_prompt')
                    logger.info(f"[PERSONA] Avatar generated: {item['avatar_url']}")
                except Exception as e:
                    logger.warning(f"[PERSONA] Avatar generation failed for persona {i+1}: {e}")
            
            projects_table.put_item(Item=item)
            saved_personas.append(item)
            logger.info(f"[PERSONA] Saved persona: {persona.get('name')}")
        
        # Set persona count to the new total (we cleared the old set above, so
        # this is a replace, not an increment — keeps the count accurate).
        projects_table.update_item(
            Key={'pk': f'PROJECT#{project_id}', 'sk': 'META'},
            UpdateExpression='SET persona_count = :count, updated_at = :now',
            ExpressionAttributeValues={':count': len(saved_personas), ':now': now}
        )
        
        overall_elapsed = time.time() - overall_start
        logger.info("[PERSONA] ========== PERSONA GENERATION COMPLETE ==========")
        logger.info(f"[PERSONA] Total time: {overall_elapsed:.2f}s, Personas created: {len(saved_personas)}")
        
        return {
            'success': True,
            'personas': saved_personas,
            'analysis': {
                'research': results[0],
                'validation': results[2]
            },
            'metadata': {
                'feedback_count': len(feedback_items),
                'source_breakdown': source_breakdown,
                'generation_time_ms': llm_time
            }
        }
        
    except Exception as e:
        overall_elapsed = time.time() - overall_start
        logger.exception(f"[PERSONA] FAILED after {overall_elapsed:.2f}s: {type(e).__name__}: {e}")
        raise ServiceError('Failed to generate personas. Please try again.')


@tracer.capture_method
def generate_prd(project_id: str, body: dict) -> dict:
    """Generate a Product Requirements Document using multi-step LLM chain."""
    if not projects_table:
        raise ConfigurationError('Projects table not configured')
    
    # Get project data including personas - exceptions will propagate
    project_data = get_project(project_id)
    
    personas = project_data.get('personas', [])
    filters = project_data.get('project', {}).get('filters', {})
    
    # Get feedback context
    feedback_items = get_feedback_context(filters, limit=50)
    feedback_context = format_feedback_for_llm(feedback_items)
    
    # Format personas for context
    personas_context = ""
    for p in personas:
        personas_context += f"""
**{p.get('name')}** - {p.get('tagline', '')}
- Quote: "{p.get('quote', '')}"
- Goals: {', '.join(p.get('goals', [])[:3])}
- Frustrations: {', '.join(p.get('frustrations', [])[:3])}
"""
    
    feature_idea = body.get('feature_idea', 'Improve customer experience based on feedback')

    # Inject the per-project product/service context (structured fields + uploaded internal docs).
    try:
        from product_context import build_product_context_block
        product_context = build_product_context_block(project_id)
    except Exception as e:
        logger.warning(f"Failed to build product context: {e}")
        product_context = "(No product context provided.)"

    # Build chain steps from external prompt files
    chain_steps = get_prd_generation_steps(
        feature_idea=feature_idea,
        personas_context=personas_context,
        feedback_context=feedback_context,
        product_context=product_context,
        response_language=body.get('response_language'),
    )

    try:
        results = converse_chain(chain_steps, surface='documents')
        
        # Save PRD
        now = datetime.now(timezone.utc).isoformat()
        prd_id = f"prd_{datetime.now().strftime('%Y%m%d%H%M%S')}"
        
        item = {
            'pk': f'PROJECT#{project_id}',
            'sk': f'PRD#{prd_id}',
            'gsi1pk': f'PROJECT#{project_id}#DOCUMENTS',
            'gsi1sk': now,
            'document_id': prd_id,
            'document_type': 'prd',
            'title': body.get('title', f'PRD: {feature_idea[:50]}'),
            'feature_idea': feature_idea,
            'content': results[2],
            'analysis': {
                'problem': results[0],
                'solution': results[1]
            },
            'created_at': now,
        }
        projects_table.put_item(Item=item)
        
        # Update document count
        projects_table.update_item(
            Key={'pk': f'PROJECT#{project_id}', 'sk': 'META'},
            UpdateExpression='SET document_count = document_count + :one, updated_at = :now',
            ExpressionAttributeValues={':one': 1, ':now': now}
        )
        
        return {'success': True, 'document': item}
        
    except Exception as e:
        logger.exception(f"PRD generation failed: {e}")
        raise ServiceError('Failed to generate PRD. Please try again.')


@tracer.capture_method
def autofill_prfaq_questions(project_id: str, body: dict) -> dict:
    """
    Pre-populate the 5 Working-Backwards customer questions from existing project
    context (personas, feedback, uploaded product context). Synchronous because
    the user is interactively waiting in the wizard; runs in well under 30s.

    Returns: {"answers": [str, str, str, str, str]} — empty strings for any
    field the model can't reasonably draft.
    """
    if not projects_table:
        raise ConfigurationError('Projects table not configured')

    from shared.converse import converse

    project_data = get_project(project_id)
    personas = project_data.get('personas', [])
    filters = project_data.get('project', {}).get('filters', {})

    feedback_items = get_feedback_context(filters, limit=20)
    feedback_context = format_feedback_for_llm(feedback_items)

    personas_context = ""
    for p in personas:
        personas_context += (
            f"\n**{p.get('name')}** — {p.get('tagline', '')}\n"
            f"Quote: \"{p.get('quote', '')}\"\n"
            f"Goals: {', '.join(p.get('goals', [])[:3])}\n"
            f"Frustrations: {', '.join(p.get('frustrations', [])[:3])}\n"
        )

    feature_idea = (body or {}).get('feature_idea', '').strip()
    title = (body or {}).get('title', '').strip()
    response_language = (body or {}).get('response_language')

    try:
        from product_context import build_product_context_block
        product_context = build_product_context_block(project_id)
    except Exception as e:
        logger.warning(f"Failed to build product context: {e}")
        product_context = "(No product context provided.)"

    from shared.prompts import get_response_language_instruction
    language_instruction = get_response_language_instruction(response_language)

    system_prompt = (
        "You are a senior product manager drafting answers to Amazon's 5 "
        "Working-Backwards customer questions for a PR/FAQ. Use the provided "
        "personas, customer feedback, and product context — DO NOT invent "
        "details that aren't supported. If a question can't be answered from "
        "the available context, return an empty string for that question.\n\n"
        "Return STRICT JSON in this exact shape (no prose, no markdown fences):\n"
        '{"answers": ["...", "...", "...", "...", "..."]}\n'
        "Each answer should be 2-5 sentences, concrete, and grounded in the inputs.\n\n"
        + (language_instruction or "")
    ).strip()

    user_prompt = (
        f"FEATURE TITLE: {title or '(unspecified)'}\n"
        f"FEATURE IDEA: {feature_idea or '(unspecified)'}\n\n"
        f"PRODUCT CONTEXT:\n{product_context}\n\n"
        f"PERSONAS:\n{personas_context or '(none)'}\n\n"
        f"CUSTOMER FEEDBACK SAMPLE:\n{feedback_context or '(none)'}\n\n"
        "Draft answers (in order) for these 5 questions:\n"
        "1. Who is the customer?\n"
        "2. What is the customer problem or opportunity?\n"
        "3. What is the most important customer benefit?\n"
        "4. How do you know what customers need or want? (cite the feedback/personas above)\n"
        "5. What does the customer experience look like?"
    )

    # 4096: strict-JSON output must fit ONE call (see the strict-JSON
    # doctrine in shared/converse.py).
    raw = converse(
        prompt=user_prompt,
        system_prompt=system_prompt,
        max_tokens=4096,
        temperature=0.3,
        surface='documents',
        step_name='prfaq_autofill',
    )

    # Parse JSON, tolerating fences if the model includes them.
    text = (raw or '').strip()
    if text.startswith('```'):
        lines = [ln for ln in text.splitlines() if not ln.strip().startswith('```')]
        text = '\n'.join(lines).strip()
    try:
        parsed = json.loads(text)
        answers = parsed.get('answers', [])
    except json.JSONDecodeError:
        logger.warning(f"Autofill JSON parse failed; returning best-effort. raw={text[:200]}")
        answers = []

    if not isinstance(answers, list):
        answers = []
    cleaned = [(a if isinstance(a, str) else '').strip() for a in answers]
    while len(cleaned) < 5:
        cleaned.append('')
    return {'answers': cleaned[:5]}


@tracer.capture_method
def suggest_document_brief(project_id: str, body: dict) -> dict:
    """Draft a feature title + description for a PRD/PR-FAQ from project context.

    A single fast LLM call (within API Gateway's 29s budget). Looks at the
    project's product context and a sample of its customer feedback, then
    proposes a concise feature/product title and a 2-4 sentence description so
    the user doesn't have to write the PRD/PR-FAQ brief from scratch.
    Returns {"title": str, "feature_idea": str}.
    """
    if not projects_table:
        raise ConfigurationError('Projects table not configured')

    from shared.converse import converse

    project_data = get_project(project_id)
    filters = (body or {}).get('filters') or project_data.get('project', {}).get('filters', {})

    feedback_items = get_feedback_context(filters, limit=40)
    feedback_context = format_feedback_for_llm(feedback_items)
    feedback_stats = get_feedback_statistics(feedback_items) if feedback_items else "(no feedback yet)"

    try:
        from product_context import build_product_context_block
        product_context = build_product_context_block(project_id)
    except Exception as e:
        logger.warning(f"Failed to build product context: {e}")
        product_context = "(No product context provided.)"

    doc_type = (body or {}).get('doc_type', 'prd')
    doc_label = 'PR-FAQ' if doc_type == 'prfaq' else 'PRD'
    response_language = (body or {}).get('response_language')
    from shared.prompts import get_response_language_instruction
    language_instruction = get_response_language_instruction(response_language)

    system_prompt = (
        f"You are a senior product manager about to write a {doc_label}. Based on "
        "the product context and the most salient customer feedback, propose ONE "
        "concrete feature or product improvement worth documenting. The title "
        "should name the feature crisply; the description should explain what it "
        "is and the customer problem it solves, grounded in the feedback. Do not "
        "invent problems that aren't supported by the feedback.\n\n"
        "Return STRICT JSON in this exact shape (no prose, no markdown fences):\n"
        '{"title": "feature/product title", "feature_idea": "2-4 sentence description"}\n'
        "Title <= 10 words. Description 2-4 sentences.\n\n"
        + (language_instruction or "")
    ).strip()

    user_prompt = (
        f"PRODUCT CONTEXT:\n{product_context}\n\n"
        f"FEEDBACK STATISTICS:\n{feedback_stats}\n\n"
        f"CUSTOMER FEEDBACK SAMPLE ({len(feedback_items)} reviews):\n{feedback_context or '(none)'}\n\n"
        f"Propose one feature worth writing a {doc_label} for."
    )

    raw = converse(
        prompt=user_prompt,
        system_prompt=system_prompt,
        max_tokens=2048,  # strict JSON: fit ONE call (doctrine in shared/converse.py)
        temperature=0.4,
        surface='documents',
        step_name='document_brief_suggest',
    )

    text = (raw or '').strip()
    if text.startswith('```'):
        lines = [ln for ln in text.splitlines() if not ln.strip().startswith('```')]
        text = '\n'.join(lines).strip()
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError:
        logger.warning(f"Document-brief JSON parse failed; raw={text[:200]}")
        parsed = {}

    title = (parsed.get('title') or '').strip() if isinstance(parsed, dict) else ''
    feature_idea = (parsed.get('feature_idea') or '').strip() if isinstance(parsed, dict) else ''
    return {'title': title, 'feature_idea': feature_idea}


@tracer.capture_method
def suggest_research_questions(project_id: str, body: dict) -> dict:
    """Suggest research questions tailored to this project's feedback + context.

    A single fast LLM call (well within API Gateway's 29s budget) that looks at
    the project's product context and a sample of its actual customer feedback,
    then proposes 3 concrete, decision-oriented research questions. Used by the
    "AI suggest" button in the Research wizard so users don't start from a blank
    box. Returns {"suggestions": [{"title": str, "question": str}, ...]}.
    """
    if not projects_table:
        raise ConfigurationError('Projects table not configured')

    from shared.converse import converse

    project_data = get_project(project_id)
    project = project_data.get('project', {})
    filters = (body or {}).get('filters') or project.get('filters', {})

    # Sample real feedback so suggestions are grounded in what was actually said.
    feedback_items = get_feedback_context(filters, limit=40)
    feedback_context = format_feedback_for_llm(feedback_items)
    feedback_stats = get_feedback_statistics(feedback_items) if feedback_items else "(no feedback yet)"

    try:
        from product_context import build_product_context_block
        product_context = build_product_context_block(project_id)
    except Exception as e:
        logger.warning(f"Failed to build product context: {e}")
        product_context = "(No product context provided.)"

    response_language = (body or {}).get('response_language')
    from shared.prompts import get_response_language_instruction
    language_instruction = get_response_language_instruction(response_language)

    system_prompt = (
        "You are a senior UX researcher helping a PM frame a research study on "
        "their product's customer feedback. Propose research questions that are "
        "specific, decision-oriented, and answerable from the customer feedback "
        "provided — favor questions about root causes, priorities, frequency/"
        "severity, and opportunities for new features. Avoid vague questions "
        "like 'what do customers think?'. Ground every suggestion in the actual "
        "feedback themes and product context provided; do not invent topics that "
        "aren't supported by the data.\n\n"
        "Return STRICT JSON in this exact shape (no prose, no markdown fences):\n"
        '{"suggestions": [{"title": "short report title", "question": "the research question"}, ...]}\n'
        "Provide exactly 3 suggestions. Titles <= 8 words. Questions 1-2 sentences.\n\n"
        + (language_instruction or "")
    ).strip()

    user_prompt = (
        f"PRODUCT CONTEXT:\n{product_context}\n\n"
        f"FEEDBACK STATISTICS:\n{feedback_stats}\n\n"
        f"CUSTOMER FEEDBACK SAMPLE ({len(feedback_items)} reviews):\n{feedback_context or '(none)'}\n\n"
        "Based on the above, propose 3 research questions worth running on this feedback."
    )

    raw = converse(
        prompt=user_prompt,
        system_prompt=system_prompt,
        max_tokens=2048,  # strict JSON: fit ONE call (doctrine in shared/converse.py)
        temperature=0.4,
        surface='documents',
        step_name='research_suggest',
    )

    text = (raw or '').strip()
    if text.startswith('```'):
        lines = [ln for ln in text.splitlines() if not ln.strip().startswith('```')]
        text = '\n'.join(lines).strip()
    try:
        parsed = json.loads(text)
        suggestions = parsed.get('suggestions', [])
    except json.JSONDecodeError:
        logger.warning(f"Research-suggest JSON parse failed; raw={text[:200]}")
        suggestions = []

    cleaned = []
    if isinstance(suggestions, list):
        for s in suggestions:
            if not isinstance(s, dict):
                continue
            q = (s.get('question') or '').strip()
            t = (s.get('title') or '').strip()
            if q:
                cleaned.append({'title': t, 'question': q})
    return {'suggestions': cleaned[:3]}


@tracer.capture_method
def generate_prfaq(project_id: str, body: dict) -> dict:
    """Generate an Amazon-style PR/FAQ document using multi-step LLM chain."""
    if not projects_table:
        raise ConfigurationError('Projects table not configured')
    
    # Get project data including personas - exceptions will propagate
    project_data = get_project(project_id)
    
    personas = project_data.get('personas', [])
    filters = project_data.get('project', {}).get('filters', {})
    
    # Get feedback context
    feedback_items = get_feedback_context(filters, limit=30)
    feedback_context = format_feedback_for_llm(feedback_items)
    
    # Format personas
    personas_context = ""
    for p in personas:
        personas_context += f"""
**{p.get('name')}**: {p.get('tagline', '')}
Quote: "{p.get('quote', '')}"
"""
    
    feature_idea = body.get('feature_idea', 'New feature based on customer feedback')

    # Inject the per-project product/service context (structured fields + uploaded internal docs).
    try:
        from product_context import build_product_context_block
        product_context = build_product_context_block(project_id)
    except Exception as e:
        logger.warning(f"Failed to build product context: {e}")
        product_context = "(No product context provided.)"

    # Build chain steps from external prompt files
    chain_steps = get_prfaq_generation_steps(
        feature_idea=feature_idea,
        personas_context=personas_context,
        feedback_context=feedback_context,
        product_context=product_context,
        response_language=body.get('response_language'),
    )

    try:
        results = converse_chain(chain_steps, surface='documents')
        
        # Combine into final document
        full_document = f"""# PR/FAQ: {feature_idea}

## Press Release

{results[1]}

---

## Frequently Asked Questions

### Customer FAQ

{results[2]}

### Internal FAQ

{results[3]}
"""
        
        # Save PR/FAQ
        now = datetime.now(timezone.utc).isoformat()
        prfaq_id = f"prfaq_{datetime.now().strftime('%Y%m%d%H%M%S')}"
        
        item = {
            'pk': f'PROJECT#{project_id}',
            'sk': f'PRFAQ#{prfaq_id}',
            'gsi1pk': f'PROJECT#{project_id}#DOCUMENTS',
            'gsi1sk': now,
            'document_id': prfaq_id,
            'document_type': 'prfaq',
            'title': body.get('title', f'PR/FAQ: {feature_idea[:50]}'),
            'feature_idea': feature_idea,
            'content': full_document,
            'sections': {
                'customer_insights': results[0],
                'press_release': results[1],
                'customer_faq': results[2],
                'internal_faq': results[3]
            },
            'created_at': now,
        }
        projects_table.put_item(Item=item)
        
        # Update document count
        projects_table.update_item(
            Key={'pk': f'PROJECT#{project_id}', 'sk': 'META'},
            UpdateExpression='SET document_count = document_count + :one, updated_at = :now',
            ExpressionAttributeValues={':one': 1, ':now': now}
        )
        
        return {'success': True, 'document': item}
        
    except Exception as e:
        logger.exception(f"PR/FAQ generation failed: {e}")
        raise ServiceError('Failed to generate PR/FAQ. Please try again.')


@tracer.capture_method
def create_document(project_id: str, body: dict) -> dict:
    """Create a custom document in the project."""
    if not projects_table:
        raise ConfigurationError('Projects table not configured')
    
    title = body.get('title', 'Untitled Document')
    content = body.get('content', '')
    document_type = body.get('document_type', 'custom')
    
    if not content:
        raise ValidationError('Content is required')
    
    now = datetime.now(timezone.utc).isoformat()
    doc_id = f"doc_{datetime.now().strftime('%Y%m%d%H%M%S')}"
    
    item = {
        'pk': f'PROJECT#{project_id}',
        'sk': f'DOC#{doc_id}',
        'gsi1pk': f'PROJECT#{project_id}#DOCUMENTS',
        'gsi1sk': now,
        'document_id': doc_id,
        'document_type': document_type,
        'title': title,
        'content': content,
        'created_at': now,
        'updated_at': now,
    }
    
    projects_table.put_item(Item=item)
    
    # Update document count
    projects_table.update_item(
        Key={'pk': f'PROJECT#{project_id}', 'sk': 'META'},
        UpdateExpression='SET document_count = document_count + :one, updated_at = :now',
        ExpressionAttributeValues={':one': 1, ':now': now}
    )
    
    return {'success': True, 'document': item}


@tracer.capture_method
def update_document(project_id: str, document_id: str, body: dict) -> dict:
    """Update a document."""
    from boto3.dynamodb.conditions import Attr
    
    if not projects_table:
        raise ConfigurationError('Projects table not configured')
    
    now = datetime.now(timezone.utc).isoformat()
    
    update_expr = 'SET updated_at = :now'
    expr_values = {':now': now}
    expr_names = {}
    
    if 'title' in body:
        update_expr += ', title = :title'
        expr_values[':title'] = body['title']
    if 'content' in body:
        update_expr += ', #content = :content'
        expr_values[':content'] = body['content']
        expr_names['#content'] = 'content'
    
    # Find the SK for this document
    response = projects_table.query(
        KeyConditionExpression=Key('pk').eq(f'PROJECT#{project_id}'),
        FilterExpression=Attr('document_id').eq(document_id)
    )
    
    items = response.get('Items', [])
    if not items:
        raise NotFoundError('Document not found')
    
    sk = items[0].get('sk')
    
    update_params = {
        'Key': {'pk': f'PROJECT#{project_id}', 'sk': sk},
        'UpdateExpression': update_expr,
        'ExpressionAttributeValues': expr_values,
    }
    if expr_names:
        update_params['ExpressionAttributeNames'] = expr_names
    
    projects_table.update_item(**update_params)
    
    return {'success': True}


@tracer.capture_method
def delete_document(project_id: str, document_id: str) -> dict:
    """Delete a document."""
    from boto3.dynamodb.conditions import Attr
    
    if not projects_table:
        raise ConfigurationError('Projects table not configured')
    
    # Find the SK for this document
    response = projects_table.query(
        KeyConditionExpression=Key('pk').eq(f'PROJECT#{project_id}'),
        FilterExpression=Attr('document_id').eq(document_id)
    )
    
    items = response.get('Items', [])
    if not items:
        raise NotFoundError('Document not found')
    
    sk = items[0].get('sk')
    
    projects_table.delete_item(Key={'pk': f'PROJECT#{project_id}', 'sk': sk})
    
    # Update document count
    now = datetime.now(timezone.utc).isoformat()
    projects_table.update_item(
        Key={'pk': f'PROJECT#{project_id}', 'sk': 'META'},
        UpdateExpression='SET document_count = document_count - :one, updated_at = :now',
        ExpressionAttributeValues={':one': 1, ':now': now}
    )
    
    return {'success': True}


# ============================================================================
# Persona CRUD Operations
# ============================================================================

@tracer.capture_method
def create_persona(project_id: str, body: dict) -> dict:
    """Create a new persona manually."""
    if not projects_table:
        raise ConfigurationError('Projects table not configured')
    
    name = body.get('name', 'New Persona')
    
    now = datetime.now(timezone.utc).isoformat()
    persona_id = f"persona_{datetime.now().strftime('%Y%m%d%H%M%S')}"
    
    item = {
        'pk': f'PROJECT#{project_id}',
        'sk': f'PERSONA#{persona_id}',
        'gsi1pk': f'PROJECT#{project_id}#PERSONAS',
        'gsi1sk': now,
        'persona_id': persona_id,
        'name': name,
        'tagline': body.get('tagline', ''),
        'identity': body.get('identity', {}),
        'goals_motivations': body.get('goals_motivations', {}),
        'pain_points': body.get('pain_points', {}),
        'behaviors': body.get('behaviors', {}),
        'context_environment': body.get('context_environment', {}),
        'quotes': body.get('quotes', []),
        'scenario': body.get('scenario', {}),
        'research_notes': body.get('research_notes', []),
        'created_at': now,
        'updated_at': now,
    }
    
    projects_table.put_item(Item=item)
    
    # Update persona count
    projects_table.update_item(
        Key={'pk': f'PROJECT#{project_id}', 'sk': 'META'},
        UpdateExpression='SET persona_count = persona_count + :one, updated_at = :now',
        ExpressionAttributeValues={':one': 1, ':now': now}
    )
    
    return {'success': True, 'persona': item}


@tracer.capture_method
def update_persona(project_id: str, persona_id: str, body: dict) -> dict:
    """Update a persona with support for all 8 sections."""
    if not projects_table:
        raise ConfigurationError('Projects table not configured')
    
    # Fix persona name if provided
    if 'name' in body and body['name']:
        body['name'] = fix_persona_name(body['name'])
    
    now = datetime.now(timezone.utc).isoformat()
    
    update_expr = 'SET updated_at = :now'
    expr_values = {':now': now}
    expr_names = {}
    
    # All updatable fields - use expression attribute names for ALL fields
    # to avoid DynamoDB reserved keyword issues (identity, name, etc.)
    updatable_fields = [
        'name', 'tagline', 'confidence',
        'identity', 'goals_motivations', 'pain_points', 'behaviors',
        'context_environment', 'quotes', 'scenario', 'research_notes',
        'avatar_url', 'avatar_prompt',
    ]
    
    for field in updatable_fields:
        if field in body:
            attr_name = f'#{field}'
            update_expr += f', {attr_name} = :{field}'
            expr_names[attr_name] = field
            expr_values[f':{field}'] = body[field]
    
    update_params = {
        'Key': {'pk': f'PROJECT#{project_id}', 'sk': f'PERSONA#{persona_id}'},
        'UpdateExpression': update_expr,
        'ExpressionAttributeValues': expr_values,
    }
    if expr_names:
        update_params['ExpressionAttributeNames'] = expr_names
    
    try:
        projects_table.update_item(**update_params)
        return {'success': True}
    except Exception as e:
        logger.exception(f"Failed to update persona: {e}")
        raise ServiceError('Failed to update persona')


@tracer.capture_method
def add_persona_note(project_id: str, persona_id: str, body: dict) -> dict:
    """Add a research note to a persona."""
    if not projects_table:
        raise ConfigurationError('Projects table not configured')
    
    note_text = body.get('text', '')
    if not note_text:
        raise ValidationError('Note text is required')
    
    now = datetime.now(timezone.utc).isoformat()
    note_id = f"note_{datetime.now().strftime('%Y%m%d%H%M%S')}"
    
    new_note = {
        'note_id': note_id,
        'text': note_text,
        'author': body.get('author', 'anonymous'),
        'created_at': now,
        'updated_at': None,
        'tags': body.get('tags', [])
    }
    
    try:
        projects_table.update_item(
            Key={'pk': f'PROJECT#{project_id}', 'sk': f'PERSONA#{persona_id}'},
            UpdateExpression='SET research_notes = list_append(if_not_exists(research_notes, :empty), :note), updated_at = :now',
            ExpressionAttributeValues={
                ':note': [new_note],
                ':empty': [],
                ':now': now
            }
        )
        return {'success': True, 'note': new_note}
    except Exception as e:
        logger.exception(f"Failed to add persona note: {e}")
        raise ServiceError('Failed to add note')


@tracer.capture_method
def update_persona_note(project_id: str, persona_id: str, note_id: str, body: dict) -> dict:
    """Update a research note on a persona."""
    if not projects_table:
        raise ConfigurationError('Projects table not configured')
    
    # Get current persona to find the note index
    response = projects_table.get_item(
        Key={'pk': f'PROJECT#{project_id}', 'sk': f'PERSONA#{persona_id}'}
    )
    
    item = response.get('Item')
    if not item:
        raise NotFoundError('Persona not found')
    
    notes = item.get('research_notes', [])
    note_index = None
    
    for i, note in enumerate(notes):
        if note.get('note_id') == note_id:
            note_index = i
            break
    
    if note_index is None:
        raise NotFoundError('Note not found')
    
    now = datetime.now(timezone.utc).isoformat()
    
    try:
        update_expr = f'SET research_notes[{note_index}].updated_at = :now'
        expr_values = {':now': now}
        expr_names = {}
        
        if 'text' in body:
            update_expr += f', research_notes[{note_index}].#text = :text'
            expr_values[':text'] = body['text']
            expr_names['#text'] = 'text'
        
        if 'tags' in body:
            update_expr += f', research_notes[{note_index}].tags = :tags'
            expr_values[':tags'] = body['tags']
        
        update_expr += ', updated_at = :persona_updated'
        expr_values[':persona_updated'] = now
        
        projects_table.update_item(
            Key={'pk': f'PROJECT#{project_id}', 'sk': f'PERSONA#{persona_id}'},
            UpdateExpression=update_expr,
            ExpressionAttributeValues=expr_values,
            ExpressionAttributeNames=expr_names if expr_names else None
        )
        return {'success': True}
    except Exception as e:
        logger.exception(f"Failed to update persona note: {e}")
        raise ServiceError('Failed to update note')


@tracer.capture_method
def delete_persona_note(project_id: str, persona_id: str, note_id: str) -> dict:
    """Delete a research note from a persona."""
    if not projects_table:
        raise ConfigurationError('Projects table not configured')
    
    # Get current persona to find the note index
    response = projects_table.get_item(
        Key={'pk': f'PROJECT#{project_id}', 'sk': f'PERSONA#{persona_id}'}
    )
    
    item = response.get('Item')
    if not item:
        raise NotFoundError('Persona not found')
    
    notes = item.get('research_notes', [])
    note_index = None
    
    for i, note in enumerate(notes):
        if note.get('note_id') == note_id:
            note_index = i
            break
    
    if note_index is None:
        raise NotFoundError('Note not found')
    
    now = datetime.now(timezone.utc).isoformat()
    
    try:
        projects_table.update_item(
            Key={'pk': f'PROJECT#{project_id}', 'sk': f'PERSONA#{persona_id}'},
            UpdateExpression=f'REMOVE research_notes[{note_index}] SET updated_at = :now',
            ExpressionAttributeValues={':now': now}
        )
        return {'success': True}
    except Exception as e:
        logger.exception(f"Failed to delete persona note: {e}")
        raise ServiceError('Failed to delete note')


@tracer.capture_method
def regenerate_persona_avatar(project_id: str, persona_id: str) -> dict:
    """Regenerate the avatar for a persona."""
    if not projects_table:
        raise ConfigurationError('Projects table not configured')
    
    # Get persona data
    response = projects_table.get_item(
        Key={'pk': f'PROJECT#{project_id}', 'sk': f'PERSONA#{persona_id}'}
    )
    
    item = response.get('Item')
    if not item:
        raise NotFoundError('Persona not found')
    
    # Generate new avatar
    avatar_result = generate_persona_avatar(item)
    
    if not avatar_result.get('avatar_url'):
        raise ServiceError('Avatar generation failed')
    
    # Update persona with new avatar
    now = datetime.now(timezone.utc).isoformat()
    projects_table.update_item(
        Key={'pk': f'PROJECT#{project_id}', 'sk': f'PERSONA#{persona_id}'},
        UpdateExpression='SET avatar_url = :url, avatar_prompt = :prompt, updated_at = :now',
        ExpressionAttributeValues={
            ':url': avatar_result['avatar_url'],
            ':prompt': avatar_result['avatar_prompt'],
            ':now': now
        }
    )
    
    return {
        'success': True,
        'avatar_url': avatar_result['avatar_url'],
        'avatar_prompt': avatar_result['avatar_prompt']
    }


@tracer.capture_method
def delete_persona(project_id: str, persona_id: str) -> dict:
    """Delete a persona."""
    if not projects_table:
        raise ConfigurationError('Projects table not configured')
    
    try:
        projects_table.delete_item(
            Key={'pk': f'PROJECT#{project_id}', 'sk': f'PERSONA#{persona_id}'}
        )
        
        # Update persona count
        now = datetime.now(timezone.utc).isoformat()
        projects_table.update_item(
            Key={'pk': f'PROJECT#{project_id}', 'sk': 'META'},
            UpdateExpression='SET persona_count = persona_count - :one, updated_at = :now',
            ExpressionAttributeValues={':one': 1, ':now': now}
        )
        
        return {'success': True}
    except Exception as e:
        logger.exception(f"Failed to delete persona: {e}")
        raise ServiceError('Failed to delete persona')


@tracer.capture_method
def run_research(project_id: str, body: dict) -> dict:
    """Run deep research analysis on feedback data."""
    if not projects_table:
        raise ConfigurationError('Projects table not configured')
    
    research_question = body.get('question', 'What are the main customer pain points?')
    
    # Get project data - exceptions will propagate
    project_data = get_project(project_id)
    
    # Use filters from request body, fallback to project filters
    filters = {
        'sources': body.get('sources', []),
        'categories': body.get('categories', []),
        'sentiments': body.get('sentiments', []),
        'days': validate_days(body.get('days'), default=30)
    }
    # If no filters provided, use project defaults
    if not any([filters['sources'], filters['categories'], filters['sentiments']]):
        filters = project_data.get('project', {}).get('filters', filters)
    
    # Get feedback for research - this is the PRIMARY data source
    logger.info(f"Fetching feedback with filters: {filters}")
    feedback_items = get_feedback_context(filters, limit=100)
    logger.info(f"Found {len(feedback_items)} feedback items for research")
    
    if not feedback_items:
        raise ValidationError('No feedback data found matching the filters. Try adjusting your filter criteria.')
    
    feedback_context = format_feedback_for_llm(feedback_items)
    feedback_stats = get_feedback_statistics(feedback_items)
    
    # Build chain steps from external prompt files
    chain_steps = get_research_analysis_steps(
        research_question=research_question,
        feedback_stats=feedback_stats,
        feedback_context=feedback_context,
        feedback_count=len(feedback_items),
        response_language=body.get('response_language'),
    )

    try:
        results = converse_chain(chain_steps, surface='documents')
        
        # Save research - combine all results into a comprehensive report
        now = datetime.now(timezone.utc).isoformat()
        research_id = f"research_{datetime.now().strftime('%Y%m%d%H%M%S')}"
        
        # Build comprehensive research report from all steps
        full_report = f"""# Research Report: {research_question}

**Generated:** {now[:10]}
**Feedback Analyzed:** {len(feedback_items)} items
**Filters:** Sources: {', '.join(filters.get('sources', [])) or 'All'} | Categories: {', '.join(filters.get('categories', [])) or 'All'} | Sentiments: {', '.join(filters.get('sentiments', [])) or 'All'} | Days: {filters.get('days', 30)}

---

## Executive Summary & Key Findings

{results[1]}

---

## Detailed Analysis

{results[0]}

---

## Validation & Confidence Assessment

{results[2]}
"""
        
        # DynamoDB has 400KB limit - truncate if needed
        max_content_size = 350000
        if len(full_report) > max_content_size:
            full_report = full_report[:max_content_size] + "\n\n---\n\n*[Report truncated due to size limits]*"
            logger.warning(f"Research report truncated from {len(full_report)} to {max_content_size} chars")
        
        item = {
            'pk': f'PROJECT#{project_id}',
            'sk': f'RESEARCH#{research_id}',
            'gsi1pk': f'PROJECT#{project_id}#DOCUMENTS',
            'gsi1sk': now,
            'document_id': research_id,
            'document_type': 'research',
            'title': body.get('title', f'Research: {research_question[:50]}'),
            'question': research_question,
            'content': full_report,
            'feedback_count': len(feedback_items),
            'created_at': now,
        }
        
        logger.info(f"Saving research document, content size: {len(full_report)} chars, feedback items: {len(feedback_items)}")
        projects_table.put_item(Item=item)
        
        # Update document count
        projects_table.update_item(
            Key={'pk': f'PROJECT#{project_id}', 'sk': 'META'},
            UpdateExpression='SET document_count = document_count + :one, updated_at = :now',
            ExpressionAttributeValues={':one': 1, ':now': now}
        )
        
        return {'success': True, 'document': item}
        
    except Exception as e:
        logger.exception(f"Research failed: {e}")
        raise ServiceError('Failed to run research. Please try again.')


def _slugify(text: str) -> str:
    """Convert text to a URL/filename-safe slug."""
    slug = text.lower().strip()
    slug = re.sub(r'[^\w\s-]', '', slug)
    slug = re.sub(r'[\s_]+', '-', slug)
    slug = re.sub(r'-+', '-', slug)
    return slug.strip('-')[:80]


def _persona_to_markdown(persona: dict) -> str:
    """Format a persona dict as a standalone markdown document."""
    name = persona.get('name', 'Unknown')
    tagline = persona.get('tagline', '')
    lines = [f'# {name}', '']
    if tagline:
        lines.append(f'**{tagline}**')
        lines.append('')

    # Representative quotes
    quotes = persona.get('quotes', [])
    if quotes:
        for q in quotes[:3]:
            text = q.get('text', q) if isinstance(q, dict) else q
            lines.append(f'> "{text}"')
        lines.append('')

    # Identity & Demographics
    identity = persona.get('identity', {})
    if identity:
        lines.append('## Demographics')
        for key in ('age_range', 'location', 'occupation', 'income_bracket', 'education', 'family_status'):
            val = identity.get(key)
            if val:
                label = key.replace('_', ' ').title()
                lines.append(f'- **{label}:** {val}')
        bio = identity.get('bio')
        if bio:
            lines.extend(['', bio])
        lines.append('')

    # Goals & Motivations
    goals = persona.get('goals_motivations', {})
    if goals:
        lines.append('## Goals & Motivations')
        primary = goals.get('primary_goal')
        if primary:
            lines.append(f'- **Primary Goal:** {primary}')
        for g in goals.get('secondary_goals', []):
            lines.append(f'- {g}')
        success = goals.get('success_definition')
        if success:
            lines.append(f'- **Success:** {success}')
        lines.append('')

    # Pain Points
    pains = persona.get('pain_points', {})
    if pains:
        lines.append('## Pain Points & Frustrations')
        for p in pains.get('current_challenges', []):
            lines.append(f'- {p}')
        emotional = pains.get('emotional_impact')
        if emotional:
            lines.append(f'- **Emotional Impact:** {emotional}')
        lines.append('')

    # Behaviors
    behaviors = persona.get('behaviors', {})
    if behaviors:
        lines.append('## Behaviors & Habits')
        for key in ('activity_frequency', 'tech_savviness', 'decision_style'):
            val = behaviors.get(key)
            if val:
                label = key.replace('_', ' ').title()
                lines.append(f'- **{label}:** {val}')
        for tool in behaviors.get('tools_used', []):
            lines.append(f'- Uses: {tool}')
        lines.append('')

    # Scenario
    scenario = persona.get('scenario', {})
    if scenario:
        title = scenario.get('title')
        narrative = scenario.get('narrative')
        if title or narrative:
            lines.append('## Scenario')
            if title:
                lines.append(f'**{title}**')
                lines.append('')
            if narrative:
                lines.append(narrative)
            lines.append('')

    return '\n'.join(lines)


def _document_to_markdown(doc: dict) -> str:
    """Format a project document as markdown (content is already markdown)."""
    title = doc.get('title', 'Untitled')
    content = doc.get('content', '')
    # If content already starts with a heading, use it as-is
    if content.strip().startswith('#'):
        return content
    return f'# {title}\n\n{content}'


def _build_steering_file(project: dict, personas: list, documents: list) -> str:
    """Generate a Kiro steering file from project data."""
    name = project.get('name', 'Project')
    description = project.get('description', '')
    kiro_prompt = project.get('kiro_export_prompt', '')

    lines = [f'# {name} — Implementation Context', '']
    if description:
        lines.extend([description, ''])

    # Personas section
    if personas:
        lines.append('## Personas')
        lines.append('')
        lines.append(f'This project has {len(personas)} personas in `.kiro/personas/`. When building features:')
        lines.append('- Consider which persona the feature serves')
        lines.append('- Reference their goals, frustrations, and needs')
        lines.append('- Use their quotes to validate UX decisions')
        lines.append('')
        lines.append('Available personas:')
        for p in personas:
            pname = p.get('name', 'Unknown')
            tagline = p.get('tagline', '')
            lines.append(f'- **{pname}** — {tagline}')
        lines.append('')

    # Documents section
    if documents:
        lines.append('## Documents')
        lines.append('')
        lines.append('Project documents are in `.kiro/docs/`:')
        for d in documents:
            dtitle = d.get('title', 'Untitled')
            dtype = d.get('document_type', 'custom')
            lines.append(f'- {dtitle} ({dtype})')
        lines.append('')
        lines.append('Use PRDs for acceptance criteria and scope. Use PR/FAQs for customer-facing messaging.')
        lines.append('')

    # Custom instructions
    if kiro_prompt:
        lines.append('## Custom Instructions')
        lines.append('')
        lines.append(kiro_prompt)
        lines.append('')

    return '\n'.join(lines)


@tracer.capture_method
def autoseed_project(project_id: str, persona_ids: list[str] | None = None, document_ids: list[str] | None = None) -> dict:
    """Generate a Kiro autoseed payload with selected project context as files.
    
    Args:
        project_id: The project to export.
        persona_ids: Optional list of persona IDs to include. None means all.
        document_ids: Optional list of document IDs to include. None means all.
    """
    project_data = get_project(project_id)
    project = project_data['project']
    all_personas = project_data['personas']
    all_documents = project_data['documents']

    # Filter to selected items (None = include all)
    personas = all_personas if persona_ids is None else [
        p for p in all_personas if p.get('persona_id') in persona_ids
    ]
    documents = all_documents if document_ids is None else [
        d for d in all_documents if d.get('document_id') in document_ids
    ]

    project_name = project.get('name', 'project')
    project_slug = _slugify(project_name)

    files = []

    # Persona files
    for persona in personas:
        persona_slug = _slugify(persona.get('name', 'unknown'))
        files.append({
            'path': f'.kiro/personas/{persona_slug}.md',
            'content': _persona_to_markdown(persona),
        })

    # Document files
    for doc in documents:
        doc_slug = _slugify(doc.get('title', 'untitled'))
        files.append({
            'path': f'.kiro/docs/{doc_slug}.md',
            'content': _document_to_markdown(doc),
        })

    # Steering file (generated last so it can reference the above)
    steering_content = _build_steering_file(project, personas, documents)
    files.insert(0, {
        'path': f'.kiro/steering/project-{project_slug}.md',
        'content': steering_content,
    })

    return {
        'project': {
            'name': project_name,
            'description': project.get('description', ''),
        },
        'files': files,
    }
