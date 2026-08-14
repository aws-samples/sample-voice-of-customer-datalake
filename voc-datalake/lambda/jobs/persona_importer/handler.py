"""
Persona Importer Job Lambda Handler

Imports personas from an image or pasted text using LLM extraction.

PDF is NOT handled: nothing in this repo extracts text from a PDF, so a PDF
import is refused (here and, first, at the API boundary in
api/projects_handler.py) rather than half-worked. The rules both layers enforce
live in shared/persona_import.py.
"""

import os
import sys
import json
import base64
from datetime import datetime, timezone

# Add parent directory to path for shared module imports
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

from shared.logging import logger, tracer, metrics
from shared.jobs import job_handler, JobContext
from shared.persona_import import converse_image_format, validate_import_config
from shared.aws import get_dynamodb_resource, get_bedrock_client
from shared.model_config import get_active_model_id
from api.projects import generate_persona_avatar

# Environment
PROJECTS_TABLE = os.environ.get('PROJECTS_TABLE', '')
RAW_DATA_BUCKET = os.environ.get('RAW_DATA_BUCKET', '')


@job_handler(error_message='Persona import failed')
def handle_job(ctx: JobContext, project_id: str, job_id: str, import_config: dict) -> dict:
    """Handle async persona import job.
    
    Args:
        ctx: Job context for progress updates
        project_id: Project ID
        job_id: Job ID
        import_config: Import configuration (input_type, content, media_type)
        
    Returns:
        Result dict with persona_id and title
    """
    dynamodb = get_dynamodb_resource()
    projects_table = dynamodb.Table(PROJECTS_TABLE)
    
    ctx.update_progress(10, 'extracting_persona')
    
    content = import_config.get('content')
    content = content if isinstance(content, str) else ''
    media_type = import_config.get('media_type', '')

    # INVARIANT: refuse, never substitute placeholder content — this handler used
    # to hand the model a hardcoded sentence in place of input it could not read,
    # and the model invented a persona from it. See test/test_unsupported_input.py.
    #
    # Re-validated here even though api/projects_handler.py already refused at the
    # click: a replayed async invoke or a job row queued before that boundary
    # shipped reaches this Lambda directly. The messages are user-facing because
    # shared/jobs.py::job_handler writes str(e) into the job record.
    input_type = validate_import_config(
        import_config.get('input_type', 'text'), content, media_type
    )

    logger.info(f"[IMPORT_PERSONA_JOB] Starting import from {input_type} for project {project_id}")
    
    system_prompt = """You are a UX researcher expert at extracting persona information from documents and images.
Extract persona data from the provided input and output a structured JSON object.
CRITICAL: Output ONLY valid JSON, no markdown, no explanation."""

    json_schema = '{"name": "Full Name", "tagline": "One sentence", "confidence": "high", "identity": {...}, "goals_motivations": {...}, "pain_points": {...}, "behaviors": {...}, "context_environment": {...}, "quotes": [...], "scenario": {...}}'
    
    # Build converse content
    converse_content = []
    if input_type == 'image':
        converse_content.append({
            'image': {
                # Looked up, not derived: validate_import_config already refused
                # anything absent from this map, and splitting the media type would
                # send Converse 'jpg', which it rejects.
                'format': converse_image_format(media_type),
                'source': {'bytes': base64.b64decode(content)}
            }
        })
        converse_content.append({
            'text': f"Extract the persona information from this image.\n\nOutput a JSON object with this structure:\n{json_schema}\n\nOutput ONLY the JSON object."
        })
    else:
        # `input_type` is 'text' here — the guard above left no other possibility,
        # so there is no fallback content to substitute and nothing to invent.
        converse_content.append({
            'text': f"Extract the persona information from this text:\n\n---\n{content}\n---\n\nOutput a JSON object with this structure:\n{json_schema}\n\nOutput ONLY the JSON object."
        })
    
    ctx.update_progress(30, 'calling_ai')
    
    bedrock = get_bedrock_client()
    # Persona import is a document-generation surface. Raw client call (image
    # input isn't supported by the text-only shared converse helper), so resolve
    # the model through the picker directly. No temperature is sent, so there's
    # nothing to omit for temperature-restricted models.
    model_id = get_active_model_id('documents')
    logger.info(f"[IMPORT_PERSONA_JOB] Invoking Bedrock with model {model_id}")
    response = bedrock.converse(
        modelId=model_id,
        system=[{'text': system_prompt}],
        messages=[{'role': 'user', 'content': converse_content}],
        inferenceConfig={'maxTokens': 4096}
    )
    
    response_text = response.get('output', {}).get('message', {}).get('content', [{}])[0].get('text', '')
    
    # Parse JSON
    json_text = response_text
    if '```json' in json_text:
        json_text = json_text.split('```json')[1].split('```')[0]
    elif '```' in json_text:
        json_text = json_text.split('```')[1].split('```')[0]
    
    persona_data = json.loads(json_text.strip())
    logger.info(f"[IMPORT_PERSONA_JOB] Extracted persona: {persona_data.get('name', 'Unknown')}")
    
    ctx.update_progress(60, 'generating_avatar')
    
    now = datetime.now(timezone.utc).isoformat()
    persona_id = f"persona_{datetime.now().strftime('%Y%m%d%H%M%S')}"
    
    item = {
        'pk': f'PROJECT#{project_id}',
        'sk': f'PERSONA#{persona_id}',
        'gsi1pk': f'PROJECT#{project_id}#PERSONAS',
        'gsi1sk': now,
        'persona_id': persona_id,
        'name': persona_data.get('name', 'Imported Persona'),
        'tagline': persona_data.get('tagline', ''),
        'confidence': persona_data.get('confidence', 'medium'),
        'identity': persona_data.get('identity', {}),
        'goals_motivations': persona_data.get('goals_motivations', {}),
        'pain_points': persona_data.get('pain_points', {}),
        'behaviors': persona_data.get('behaviors', {}),
        'context_environment': persona_data.get('context_environment', {}),
        'quotes': persona_data.get('quotes', []),
        'scenario': persona_data.get('scenario', {}),
        'research_notes': [],
        'imported_from': input_type,
        'created_at': now,
        'updated_at': now,
    }
    
    # Generate avatar
    avatar_data = {'persona_id': persona_id, **item}
    avatar_result = generate_persona_avatar(avatar_data, RAW_DATA_BUCKET)
    if avatar_result.get('avatar_url'):
        item['avatar_url'] = avatar_result['avatar_url']
        item['avatar_prompt'] = avatar_result.get('avatar_prompt', '')
    
    ctx.update_progress(90, 'saving_persona')
    
    projects_table.put_item(Item=item)
    projects_table.update_item(
        Key={'pk': f'PROJECT#{project_id}', 'sk': 'META'},
        UpdateExpression='SET persona_count = persona_count + :one, updated_at = :now',
        ExpressionAttributeValues={':one': 1, ':now': now}
    )
    
    persona_name = item.get('name', 'Imported Persona')
    # No CDN-URL conversion here: `item` is not part of the return value below,
    # so the old conversion was dead. It also could not work now that avatar
    # URLs must be signed (issue #229) — this Lambda has no signing key. The
    # projects API signs at read time, which is the only place a browser gets
    # an avatar URL from.
    
    logger.info(f"[IMPORT_PERSONA_JOB] Successfully imported persona: {persona_name}")
    return {'persona_id': persona_id, 'title': f'Imported: {persona_name}'}


@logger.inject_lambda_context
@tracer.capture_lambda_handler
@metrics.log_metrics(capture_cold_start_metric=True)
def lambda_handler(event: dict, context) -> dict:
    """Lambda entry point."""
    logger.info(f"Persona importer invoked with event keys: {list(event.keys())}")
    return handle_job(event)
