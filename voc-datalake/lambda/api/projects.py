"""
Projects API endpoints for VoC Analytics.
Handles projects, personas, PRDs, PR/FAQs with multi-step LLM orchestration.
"""
import json
import os
import re
from datetime import datetime, timezone
from boto3.dynamodb.conditions import Key

# Shared module imports
from shared.logging import logger, tracer
from shared.aws import get_dynamodb_resource, get_bedrock_client, BEDROCK_MODEL_ID
from shared.api import validate_days
from shared.converse import converse, converse_chain
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


PROJECTS_TABLE = os.environ.get('PROJECTS_TABLE', '')
FEEDBACK_TABLE = os.environ.get('FEEDBACK_TABLE', '')

projects_table = dynamodb.Table(PROJECTS_TABLE) if PROJECTS_TABLE else None
feedback_table = dynamodb.Table(FEEDBACK_TABLE) if FEEDBACK_TABLE else None


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
            elif sk.startswith('PRD#') or sk.startswith('PRFAQ#') or sk.startswith('RESEARCH#') or sk.startswith('DOC#'):
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
        elif sk.startswith('PRD#') or sk.startswith('PRFAQ#') or sk.startswith('RESEARCH#') or sk.startswith('PROCESS_ANALYSIS#') or sk.startswith('DOC#'):
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
    
    logger.info(f"[PERSONA] ========== STARTING PERSONA GENERATION ==========")
    logger.info(f"[PERSONA] Project: {project_id}")
    logger.info(f"[PERSONA] Filters: {filters}")
    overall_start = time.time()
    
    def update_progress(progress: int, step: str):
        """Update progress if callback provided."""
        logger.info(f"[PERSONA] Progress update: {progress}% - step: {step}")
        if progress_callback:
            try:
                progress_callback(progress, step)
                logger.info(f"[PERSONA] Progress callback succeeded")
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
    
    logger.info(f"[PERSONA] Step 2/6: Formatting feedback data for LLM...")
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
        logger.info(f"[PERSONA] Context truncated to 30000 chars")
    
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
                custom_instructions=custom_instructions
            )
            logger.info(f"[PERSONA] Built {len(chain_steps)} chain steps")
        except Exception as e:
            logger.error(f"[PERSONA] Failed to build chain steps: {e}")
            raise
        
        logger.info("[PERSONA] Step 4/6: Executing LLM chain (this may take several minutes)...")
        update_progress(20, 'executing_llm_chain')
        
        try:
            results = converse_chain(chain_steps, progress_callback=lambda p, s: update_progress(p, s))
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
        
        # Update persona count
        projects_table.update_item(
            Key={'pk': f'PROJECT#{project_id}', 'sk': 'META'},
            UpdateExpression='SET persona_count = persona_count + :count, updated_at = :now',
            ExpressionAttributeValues={':count': len(saved_personas), ':now': now}
        )
        
        overall_elapsed = time.time() - overall_start
        logger.info(f"[PERSONA] ========== PERSONA GENERATION COMPLETE ==========")
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
    
    # Build chain steps from external prompt files
    chain_steps = get_prd_generation_steps(
        feature_idea=feature_idea,
        personas_context=personas_context,
        feedback_context=feedback_context
    )

    try:
        results = converse_chain(chain_steps)
        
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
    
    # Build chain steps from external prompt files
    chain_steps = get_prfaq_generation_steps(
        feature_idea=feature_idea,
        personas_context=personas_context,
        feedback_context=feedback_context
    )

    try:
        results = converse_chain(chain_steps)
        
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
def project_chat(project_id: str, body: dict) -> dict:
    """AI chat within project context, with persona mentions and document references support.
    
    Uses shared.project_chat.build_chat_context for context building.
    """
    # Import here to avoid circular imports at module level
    from shared.project_chat import build_chat_context
    
    if not projects_table:
        raise ConfigurationError('Projects table not configured')
    
    message = body.get('message', '')
    if not message:
        raise ValidationError('Message is required')
    
    # Build chat context using shared helper - exceptions will propagate
    system_prompt, user_message, metadata = build_chat_context(
        projects_table,
        feedback_table,
        project_id,
        message,
        selected_persona_ids=body.get('selected_personas', []),
        selected_document_ids=body.get('selected_documents', []),
    )
    
    try:
        response = converse(prompt=user_message, system_prompt=system_prompt, max_tokens=3000)
        
        return {
            'success': True,
            'response': response,
            **metadata
        }
        
    except Exception as e:
        logger.exception(f"Project chat failed: {e}")
        raise ServiceError('Failed to process chat request. Please try again.')


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
        feedback_count=len(feedback_items)
    )

    try:
        results = converse_chain(chain_steps)
        
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
