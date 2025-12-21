"""
Projects API endpoints for VoC Analytics.
Handles projects, personas, PRDs, PR/FAQs with multi-step LLM orchestration.
"""
import json
import os
import re
import boto3
from botocore.config import Config
from datetime import datetime, timezone
from decimal import Decimal
from typing import Any
from boto3.dynamodb.conditions import Key, Attr

# Shared module imports
from shared.logging import logger, tracer
from shared.aws import get_dynamodb_resource, BEDROCK_MODEL_ID

# AWS Clients (using shared module for connection reuse)
dynamodb = get_dynamodb_resource()
# Extended timeout for long-running LLM calls (persona generation uses 3-step chain)
bedrock_config = Config(read_timeout=300, connect_timeout=10, retries={'max_attempts': 2})
bedrock = boto3.client('bedrock-runtime', config=bedrock_config)

PROJECTS_TABLE = os.environ.get('PROJECTS_TABLE', '')
FEEDBACK_TABLE = os.environ.get('FEEDBACK_TABLE', '')
AGGREGATES_TABLE = os.environ.get('AGGREGATES_TABLE', '')

projects_table = dynamodb.Table(PROJECTS_TABLE) if PROJECTS_TABLE else None
feedback_table = dynamodb.Table(FEEDBACK_TABLE) if FEEDBACK_TABLE else None
aggregates_table = dynamodb.Table(AGGREGATES_TABLE) if AGGREGATES_TABLE else None

MODEL_ID = BEDROCK_MODEL_ID


class DecimalEncoder(json.JSONEncoder):
    def default(self, obj):
        if isinstance(obj, Decimal):
            return float(obj)
        return super().default(obj)


def validate_days(value: str | int | None, default: int = 30, min_val: int = 1, max_val: int = 365) -> int:
    """Validate and bound days parameter."""
    try:
        days = int(value) if value is not None else default
        return max(min_val, min(days, max_val))
    except (ValueError, TypeError):
        return default


def invoke_bedrock(system_prompt: str, user_message: str, max_tokens: int = 4096, thinking_budget: int = 0) -> str:
    """Invoke Bedrock with Claude Sonnet 4.5.
    
    Args:
        system_prompt: System instructions
        user_message: User message
        max_tokens: Maximum output tokens
        thinking_budget: If > 0, enables extended thinking with this token budget
    """
    request_body = {
        'anthropic_version': 'bedrock-2023-05-31',
        'max_tokens': max_tokens,
        'system': system_prompt,
        'messages': [{'role': 'user', 'content': user_message}]
    }
    
    # Add extended thinking if budget specified
    if thinking_budget > 0:
        request_body['thinking'] = {
            'type': 'enabled',
            'budget_tokens': thinking_budget
        }
    
    response = bedrock.invoke_model(
        modelId=MODEL_ID,
        contentType='application/json',
        accept='application/json',
        body=json.dumps(request_body)
    )
    result = json.loads(response['body'].read())
    
    # Handle response with thinking blocks
    for block in result.get('content', []):
        if block.get('type') == 'text':
            return block.get('text', '')
    
    return result['content'][0]['text']


def invoke_bedrock_chain(steps: list[dict], progress_callback: callable = None) -> list[str]:
    """Execute a chain of LLM calls, each building on the previous.
    
    Each step can have:
        - system: System prompt
        - user: User message (use {previous} to inject previous result)
        - max_tokens: Max output tokens (default 4096)
        - thinking_budget: Extended thinking budget (default 0 = disabled)
        - step_name: Optional name for progress reporting
    
    Args:
        steps: List of step configurations
        progress_callback: Optional callback(progress: int, step: str) to report progress
    """
    results = []
    context = ""
    total_steps = len(steps)
    
    for i, step in enumerate(steps, 1):
        step_name = step.get('step_name', f'llm_step_{i}')
        logger.info(f"Executing LLM chain step {i}/{total_steps}: {step_name}")
        
        # Report progress (distribute 15-75% across LLM steps)
        if progress_callback:
            progress = 15 + int((i - 1) / total_steps * 60)
            try:
                progress_callback(progress, step_name)
            except Exception as e:
                logger.warning(f"Progress callback failed: {e}")
        
        system = step.get('system', '')
        user = step.get('user', '').replace('{previous}', context)
        thinking_budget = step.get('thinking_budget', 0)
        result = invoke_bedrock(system, user, step.get('max_tokens', 4096), thinking_budget)
        results.append(result)
        context = result
        logger.info(f"Step {i} completed, output length: {len(result)} chars")
    
    return results


@tracer.capture_method
def list_projects() -> dict:
    """List all projects."""
    if not projects_table:
        return {'projects': []}
    
    response = projects_table.query(
        IndexName='gsi1-by-type',
        KeyConditionExpression=Key('gsi1pk').eq('TYPE#PROJECT'),
        ScanIndexForward=False
    )
    
    projects = []
    for item in response.get('Items', []):
        projects.append({
            'project_id': item.get('project_id'),
            'name': item.get('name'),
            'description': item.get('description'),
            'status': item.get('status', 'active'),
            'created_at': item.get('created_at'),
            'updated_at': item.get('updated_at'),
            'persona_count': item.get('persona_count', 0),
            'document_count': item.get('document_count', 0),
        })
    
    return {'projects': projects}


@tracer.capture_method
def create_project(body: dict) -> dict:
    """Create a new project."""
    if not projects_table:
        return {'success': False, 'message': 'Projects table not configured'}
    
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


AVATARS_CDN_URL = os.environ.get('AVATARS_CDN_URL', '')


def get_avatar_cdn_url(s3_uri: str) -> str | None:
    """Convert S3 URI to CloudFront CDN URL for avatar images.
    
    S3 URI format: s3://bucket/avatars/{persona_id}.png
    CDN URL format: https://{cdn_domain}/{persona_id}.png
    """
    if not s3_uri or not s3_uri.startswith('s3://'):
        return None
    
    if not AVATARS_CDN_URL:
        logger.warning("AVATARS_CDN_URL not configured")
        return None
    
    try:
        # Extract filename from s3://bucket/avatars/{persona_id}.png
        # The CloudFront distribution has originPath='/avatars' so we just need the filename
        parts = s3_uri.split('/')
        if len(parts) < 2:
            return None
        filename = parts[-1]  # e.g., persona_20241128123456_0.png
        
        cdn_url = f"{AVATARS_CDN_URL.rstrip('/')}/{filename}"
        return cdn_url
    except Exception as e:
        logger.warning(f"Failed to generate CDN URL for {s3_uri}: {e}")
        return None


@tracer.capture_method
def get_project(project_id: str) -> dict:
    """Get a project with all its data."""
    if not projects_table:
        return {'error': 'Projects table not configured'}
    
    # Get all items for this project
    response = projects_table.query(
        KeyConditionExpression=Key('pk').eq(f'PROJECT#{project_id}')
    )
    
    items = response.get('Items', [])
    if not items:
        return {'error': 'Project not found'}
    
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
        elif sk.startswith('PRD#') or sk.startswith('PRFAQ#') or sk.startswith('RESEARCH#') or sk.startswith('DOC#'):
            documents.append(item)
    
    if not project:
        return {'error': 'Project metadata not found'}
    
    return {
        'project': project,
        'personas': personas,
        'documents': documents
    }


@tracer.capture_method
def update_project(project_id: str, body: dict) -> dict:
    """Update a project."""
    if not projects_table:
        return {'success': False, 'message': 'Projects table not configured'}
    
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
        return {'success': False, 'message': 'Projects table not configured'}
    
    # Get all items for this project
    response = projects_table.query(
        KeyConditionExpression=Key('pk').eq(f'PROJECT#{project_id}')
    )
    
    # Delete all items
    with projects_table.batch_writer() as batch:
        for item in response.get('Items', []):
            batch.delete_item(Key={'pk': item['pk'], 'sk': item['sk']})
    
    return {'success': True}


def get_feedback_context(filters: dict, limit: int = 50) -> list[dict]:
    """Get feedback items based on filters for LLM context."""
    if not feedback_table:
        return []
    
    days = filters.get('days', 30)
    categories = filters.get('categories', [])
    sentiments = filters.get('sentiments', [])
    sources = filters.get('sources', [])
    
    items = []
    current_date = datetime.now(timezone.utc)
    from datetime import timedelta
    
    # If specific sources are selected, query each source
    if sources:
        for source in sources:
            response = feedback_table.query(
                KeyConditionExpression=Key('pk').eq(f'SOURCE#{source}'),
                Limit=limit // len(sources) + 1,
                ScanIndexForward=False
            )
            items.extend(response.get('Items', []))
    # If specific categories are selected, query each category
    elif categories:
        for category in categories:
            response = feedback_table.query(
                IndexName='gsi2-by-category',
                KeyConditionExpression=Key('gsi2pk').eq(f'CATEGORY#{category}'),
                Limit=limit // len(categories) + 1,
                ScanIndexForward=False
            )
            items.extend(response.get('Items', []))
    else:
        # Query by date
        for i in range(min(days, 30)):
            date = (current_date - timedelta(days=i)).strftime('%Y-%m-%d')
            response = feedback_table.query(
                IndexName='gsi1-by-date',
                KeyConditionExpression=Key('gsi1pk').eq(f'DATE#{date}'),
                Limit=limit - len(items),
                ScanIndexForward=False
            )
            items.extend(response.get('Items', []))
            if len(items) >= limit:
                break
    
    # Apply sentiment filter
    if sentiments:
        items = [i for i in items if i.get('sentiment_label') in sentiments]
    
    # Apply category filter if we didn't query by category
    if categories and not sources:
        items = [i for i in items if i.get('category') in categories]
    
    # Apply source filter if we didn't query by source
    if sources and categories:
        items = [i for i in items if i.get('source_platform') in sources]
    
    return items[:limit]


def format_feedback_for_llm(items: list[dict]) -> str:
    """Format feedback items for LLM context with rich details."""
    lines = []
    for i, item in enumerate(items, 1):
        # Build optional fields
        quote = item.get('direct_customer_quote', '')
        root_cause = item.get('problem_root_cause_hypothesis', '')
        persona_type = item.get('persona_type', '')
        journey_stage = item.get('journey_stage', '')
        
        lines.append(f"""
### Review {i}
- Source: {item.get('source_platform', 'unknown')}
- Date: {item.get('source_created_at', '')[:10] if item.get('source_created_at') else 'N/A'}
- Sentiment: {item.get('sentiment_label', 'unknown')} (score: {item.get('sentiment_score', 0):.2f})
- Category: {item.get('category', 'other')}
- Rating: {item.get('rating', 'N/A')}/5
- Urgency: {item.get('urgency', 'low')}
- Customer Type: {persona_type if persona_type else 'unknown'}
- Journey Stage: {journey_stage if journey_stage else 'unknown'}
- Full Text: "{item.get('original_text', '')[:600]}"
{f'- Key Quote: "{quote}"' if quote else ''}
{f'- Problem Summary: {item.get("problem_summary", "")}' if item.get('problem_summary') else ''}
{f'- Root Cause Hypothesis: {root_cause}' if root_cause else ''}
""")
    return '\n'.join(lines)


def get_feedback_statistics(items: list[dict]) -> str:
    """Generate summary statistics from feedback items."""
    if not items:
        return "No feedback data available."
    
    # Count by sentiment
    sentiments = {}
    categories = {}
    sources = {}
    urgency_counts = {'high': 0, 'medium': 0, 'low': 0}
    ratings = []
    
    for item in items:
        sent = item.get('sentiment_label', 'unknown')
        sentiments[sent] = sentiments.get(sent, 0) + 1
        
        cat = item.get('category', 'other')
        categories[cat] = categories.get(cat, 0) + 1
        
        src = item.get('source_platform', 'unknown')
        sources[src] = sources.get(src, 0) + 1
        
        urg = item.get('urgency', 'low')
        if urg in urgency_counts:
            urgency_counts[urg] += 1
        
        if item.get('rating'):
            ratings.append(float(item['rating']))
    
    avg_rating = sum(ratings) / len(ratings) if ratings else 0
    
    stats = f"""## Feedback Statistics (n={len(items)})

**Sentiment Distribution:**
{chr(10).join([f"- {k}: {v} ({v/len(items)*100:.1f}%)" for k, v in sorted(sentiments.items(), key=lambda x: x[1], reverse=True)])}

**Top Categories:**
{chr(10).join([f"- {k}: {v}" for k, v in sorted(categories.items(), key=lambda x: x[1], reverse=True)[:5]])}

**Sources:**
{chr(10).join([f"- {k}: {v}" for k, v in sorted(sources.items(), key=lambda x: x[1], reverse=True)])}

**Urgency Levels:**
- High: {urgency_counts['high']} | Medium: {urgency_counts['medium']} | Low: {urgency_counts['low']}

**Average Rating:** {avg_rating:.1f}/5 (from {len(ratings)} rated reviews)
"""
    return stats


# =============================================================================
# PERSONA AVATAR GENERATION
# Uses Claude to generate an image prompt, then Nova Canvas to create the avatar
# Nova Canvas is only available in us-east-1, so we create a region-specific client
# Search: "avatar generation for personas" or "PERSONA_AVATAR"
# =============================================================================

def generate_avatar_prompt_with_llm(persona_data: dict) -> str:
    """Use Claude to generate an optimal image prompt from persona data."""
    name = persona_data.get('name', 'Unknown')
    tagline = persona_data.get('tagline', '')
    identity = persona_data.get('identity', {})
    bio = identity.get('bio', '')
    age_range = identity.get('age_range', '')
    occupation = identity.get('occupation', '')
    location = identity.get('location', '')
    
    system_prompt = """You are an expert at writing image generation prompts for professional headshot portraits.
Given a user persona, create a single image prompt for generating their avatar photo.

Rules:
- Infer gender from the name (e.g., Sofia = female, Carlos = male)
- Include: gender, approximate age, ethnicity hints from name/location, occupation-appropriate attire
- Always end with: "professional headshot, soft studio lighting, neutral background, photorealistic"
- Keep it under 200 characters
- Output ONLY the prompt, nothing else"""

    user_msg = f"""Create an image prompt for this persona:
Name: {name}
Tagline: {tagline}
Age: {age_range}
Occupation: {occupation}
Location: {location}
Bio: {bio[:300] if bio else 'N/A'}"""

    try:
        result = invoke_bedrock(system_prompt, user_msg, max_tokens=200)
        return result.strip()
    except Exception as e:
        logger.warning(f"[PERSONA_AVATAR] LLM prompt generation failed: {e}, using fallback")
        # Fallback to simple prompt
        return f"Professional headshot of a {occupation or 'professional'}, friendly expression, soft studio lighting, neutral background, photorealistic"


@tracer.capture_method
def generate_persona_avatar(persona_data: dict, s3_bucket: str = None) -> dict:
    """
    [PERSONA_AVATAR] Generate an AI avatar image for a persona.
    
    Uses Claude to create an intelligent image prompt from persona data (name, bio, occupation),
    then Nova Canvas to generate the actual image.
    
    Args:
        persona_data: Dict with name, tagline, identity (bio, age_range, occupation, location)
        s3_bucket: Optional S3 bucket override, defaults to RAW_DATA_BUCKET env var
        
    Returns:
        dict with 'avatar_url' (S3 URI or None) and 'avatar_prompt' (the prompt used)
    """
    import base64
    
    persona_id = persona_data.get('persona_id', 'unknown')
    persona_name = persona_data.get('name', 'Unknown')
    
    logger.info(f"[PERSONA_AVATAR] Starting avatar generation for {persona_name}", extra={
        "persona_id": persona_id
    })
    
    if not s3_bucket:
        s3_bucket = os.environ.get('RAW_DATA_BUCKET', '')
    
    if not s3_bucket:
        logger.warning("[PERSONA_AVATAR] No S3 bucket configured - RAW_DATA_BUCKET env var is empty")
        return {'avatar_url': None, 'avatar_prompt': None}
    
    # Use Claude to generate an intelligent image prompt from persona data
    logger.info(f"[PERSONA_AVATAR] Generating image prompt with Claude for {persona_name}")
    avatar_prompt = generate_avatar_prompt_with_llm(persona_data)
    logger.info(f"[PERSONA_AVATAR] Generated prompt: {avatar_prompt}")
    
    try:
        # Nova Canvas is only available in us-east-1
        # IAM policy must include: arn:aws:bedrock:us-east-1::foundation-model/amazon.nova-canvas-v1:0
        logger.info("[PERSONA_AVATAR] Creating Bedrock client for us-east-1 (Nova Canvas region)")
        bedrock_runtime = boto3.client('bedrock-runtime', region_name='us-east-1')
        
        # Nova Canvas request format - must use 1024x1024 dimensions
        # Do NOT include 'quality' or 'cfgScale' params - they cause ValidationException
        persona_id = persona_data.get('persona_id', 'unknown')
        request_body = {
            "taskType": "TEXT_IMAGE",
            "textToImageParams": {
                "text": avatar_prompt,
            },
            "imageGenerationConfig": {
                "numberOfImages": 1,
                "width": 1024,
                "height": 1024,
                "seed": hash(persona_id) % 2147483647  # Consistent seed per persona
            }
        }
        
        logger.info(f"[PERSONA_AVATAR] Invoking Nova Canvas model: amazon.nova-canvas-v1:0")
        
        response = bedrock_runtime.invoke_model(
            modelId='amazon.nova-canvas-v1:0',
            body=json.dumps(request_body)
        )
        
        result = json.loads(response['body'].read())
        images = result.get('images', [])
        
        if not images:
            logger.warning("[PERSONA_AVATAR] Nova Canvas returned empty images array")
            return {'avatar_url': None, 'avatar_prompt': avatar_prompt}
        
        logger.info(f"[PERSONA_AVATAR] Nova Canvas generated {len(images)} image(s)")
        
        # Decode base64 image and upload to S3
        image_data = base64.b64decode(images[0])
        s3_key = f"avatars/{persona_id}.png"
        
        logger.info(f"[PERSONA_AVATAR] Uploading avatar to S3: s3://{s3_bucket}/{s3_key}")
        
        s3_client = boto3.client('s3')
        s3_client.put_object(
            Bucket=s3_bucket,
            Key=s3_key,
            Body=image_data,
            ContentType='image/png'
        )
        
        avatar_url = f"s3://{s3_bucket}/{s3_key}"
        logger.info(f"[PERSONA_AVATAR] SUCCESS - Avatar generated for {persona_data.get('name')}: {avatar_url}")
        
        return {'avatar_url': avatar_url, 'avatar_prompt': avatar_prompt}
        
    except Exception as e:
        error_type = type(e).__name__
        if 'AccessDenied' in error_type or 'AccessDenied' in str(e):
            logger.error(f"[PERSONA_AVATAR] ACCESS DENIED - Check IAM policy includes arn:aws:bedrock:us-east-1::foundation-model/amazon.nova-canvas-v1:0", extra={"error": str(e)})
        elif 'ValidationException' in error_type or 'ValidationException' in str(e):
            logger.error(f"[PERSONA_AVATAR] VALIDATION ERROR - Check Nova Canvas request format (must use 1024x1024, no quality/cfgScale params)", extra={"error": str(e)})
        else:
            logger.error(f"[PERSONA_AVATAR] FAILED - Avatar generation error: {error_type}: {e}", extra={
                "persona_id": persona_data.get('persona_id'),
                "error_type": error_type,
                "error": str(e)
            })
        return {'avatar_url': None, 'avatar_prompt': avatar_prompt}


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
    
    Args:
        project_id: The project ID
        filters: Filter parameters for feedback selection
        progress_callback: Optional callback(progress: int, step: str) to report progress
    """
    def update_progress(progress: int, step: str):
        """Update progress if callback provided."""
        if progress_callback:
            try:
                progress_callback(progress, step)
            except Exception as e:
                logger.warning(f"Progress callback failed: {e}")
    
    if not projects_table:
        return {'success': False, 'message': 'Projects table not configured'}
    
    # Extract filter parameters
    persona_count = filters.get('persona_count', 3)
    custom_instructions = filters.get('custom_instructions', '')
    generate_avatars = filters.get('generate_avatars', True)
    
    update_progress(5, 'fetching_feedback')
    
    # Get feedback data
    feedback_items = get_feedback_context(filters, limit=50)
    if not feedback_items:
        return {'success': False, 'message': 'No feedback data found for the given filters'}
    
    logger.info(f"Starting enhanced persona generation for project {project_id} with {len(feedback_items)} feedback items")
    
    update_progress(10, 'formatting_data')
    feedback_context = format_feedback_for_llm(feedback_items)
    feedback_stats = get_feedback_statistics(feedback_items)
    
    # Truncate context if too large
    if len(feedback_context) > 30000:
        feedback_context = feedback_context[:30000] + "\n\n[... additional feedback truncated ...]"
    
    custom_section = f"\n\n## ADDITIONAL INSTRUCTIONS:\n{custom_instructions}\n" if custom_instructions else ""
    
    # Step 1: Deep Research Analysis
    research_system = """You are a senior UX researcher specializing in Voice of Customer analysis and persona development.

Your task is to identify distinct user segments from real customer feedback. You must:
1. Be rigorously data-driven - cite specific reviews and quotes
2. Look for behavioral patterns, not just demographics
3. Identify emotional drivers and underlying motivations
4. Consider customer journey stages
5. Pay attention to urgency levels and sentiment patterns
6. Look for workarounds and coping mechanisms
7. Identify tech savviness signals from language used"""
    
    research_prompt = f"""Analyze this customer feedback dataset and identify exactly {persona_count} distinct user segments.

{feedback_stats}
{custom_section}

## CUSTOMER FEEDBACK DATA:
{feedback_context}

---

For EACH of the {persona_count} segments, provide detailed analysis:

1. **Segment Name**: A memorable, descriptive name
2. **Size Estimate**: What % of feedback represents this segment?
3. **Demographic Signals**: Age hints, occupation hints, location hints (only if evident)
4. **Defining Characteristics**: What makes this segment unique?
5. **Goals & Motivations**: What are they trying to achieve? Why?
6. **Pain Points**: What frustrates them? (cite specific reviews by number)
7. **Behaviors**: How do they interact? What tools do they mention?
8. **Emotional State**: How do they feel? What language reveals this?
9. **Tech Savviness**: Low/Medium/High based on language and expectations
10. **Representative Quotes**: Copy 3-4 EXACT quotes from the feedback
11. **Journey Stage**: awareness/consideration/purchase/usage/support/advocacy
12. **Workarounds**: How do they currently cope with problems?
13. **Context Clues**: When/where do they use the product? Time constraints?

Be specific and ground every insight in actual feedback data."""

    # Step 2: Full Persona Synthesis with 8 Sections
    synthesis_system = """You are a UX researcher creating comprehensive persona profiles following an 8-section template.

Each persona must:
- Feel like a real, specific person with a name and story
- Be grounded in actual customer quotes (use REAL quotes only)
- Have actionable insights for product teams
- Include realistic scenarios
- Have appropriate confidence levels based on data support

CRITICAL: Output ONLY valid JSON. No markdown, no explanation, just the JSON array."""
    
    synthesis_prompt = f"""Based on the segment analysis, create exactly {persona_count} comprehensive persona profiles.

## PREVIOUS ANALYSIS:
{{previous}}

## ORIGINAL FEEDBACK DATA (for accurate quotes):
{feedback_context[:15000]}
{custom_section}

---

Create exactly {persona_count} personas with ALL 8 SECTIONS. Output ONLY valid JSON:

```json
[
  {{
    "name": "First Last",
    "tagline": "The [Descriptive Label] - one compelling sentence",
    "confidence": "high|medium|low",
    "feedback_count": 12,
    
    "identity": {{
      "age_range": "30-45",
      "location": "Urban, US",
      "occupation": "Specific job title",
      "income_bracket": "$100k-150k or null",
      "education": "Bachelor's degree or null",
      "family_status": "Married with kids or null",
      "bio": "2-3 sentence background story that feels real and specific. Include their career path, current situation, and what drives them."
    }},
    
    "goals_motivations": {{
      "primary_goal": "Their main objective in one clear sentence",
      "secondary_goals": ["Goal 2", "Goal 3"],
      "success_definition": "What success looks like to them in their own words",
      "underlying_motivations": ["Deeper emotional driver 1", "Driver 2"]
    }},
    
    "pain_points": {{
      "current_challenges": ["Challenge 1 with specific context", "Challenge 2", "Challenge 3"],
      "blockers": ["What specifically prevents them from achieving goals"],
      "workarounds": ["How they currently cope with the problem"],
      "emotional_impact": "How these frustrations make them feel - be specific"
    }},
    
    "behaviors": {{
      "current_solutions": ["How they solve the problem now"],
      "tools_used": ["Tool 1", "Tool 2", "Tool 3"],
      "activity_frequency": "Daily|Weekly|Monthly|As needed",
      "tech_savviness": "low|medium|high",
      "decision_style": "Data-driven|Gut instinct|Consensus-seeking|Research-heavy"
    }},
    
    "context_environment": {{
      "usage_context": "When and where they typically engage with the product",
      "devices": ["iPhone", "MacBook", "etc"],
      "time_constraints": "Specific time constraints they face",
      "social_context": "Their work/social environment and who they interact with",
      "influencers": ["Who influences their decisions"]
    }},
    
    "quotes": [
      {{"text": "Exact quote from feedback that captures their voice", "context": "Source/situation"}},
      {{"text": "Another real quote showing their perspective", "context": "Context"}}
    ],
    
    "scenario": {{
      "title": "Short descriptive title for the scenario",
      "narrative": "A 3-4 sentence story showing them in a realistic situation. Describe the trigger, their actions, their thought process, and the outcome they're seeking.",
      "trigger": "What triggers this scenario",
      "outcome": "What they hope to achieve"
    }},
    
    "supporting_evidence": ["Review #X", "Review #Y", "Review #Z"]
  }}
]
```

IMPORTANT: Output ONLY the JSON array, no other text."""

    # Step 3: Validation
    validate_system = """You are a critical reviewer ensuring personas are grounded in real data.
Validate claims, verify quotes, and ensure actionability."""
    
    validate_prompt = f"""Review and validate these personas against the original feedback data.

## PERSONAS TO VALIDATE:
{{previous}}

## ORIGINAL FEEDBACK STATISTICS:
{feedback_stats}

## SAMPLE FEEDBACK FOR VERIFICATION:
{feedback_context[:8000]}

---

For each persona:
1. **Data Support**: Is this persona supported by multiple feedback items?
2. **Quote Accuracy**: Are quotes accurate or appropriately paraphrased?
3. **Consistency**: Any contradictions in the profile?
4. **Actionability**: Can product teams act on these insights?
5. **Confidence**: HIGH (5+ reviews) / MEDIUM (2-4 reviews) / LOW (1 review or inferred)

Output the FINAL validated personas as a JSON array with any refinements."""

    try:
        import re
        import time
        start_time = time.time()
        
        update_progress(15, 'analyzing_feedback')
        logger.info("Starting enhanced LLM chain for persona generation")
        results = invoke_bedrock_chain([
            {'system': research_system, 'user': research_prompt, 'max_tokens': 4000, 'step_name': 'research_analysis'},
            {'system': synthesis_system, 'user': synthesis_prompt, 'max_tokens': 9000, 'step_name': 'persona_synthesis'},
            {'system': validate_system, 'user': validate_prompt, 'max_tokens': 3000, 'step_name': 'validation'},
        ], progress_callback=lambda p, s: update_progress(p, s))
        
        llm_time = int((time.time() - start_time) * 1000)
        logger.info(f"LLM chain completed in {llm_time}ms")
        
        # Parse personas from output
        personas_data = []
        for result_text in [results[1], results[2]]:
            json_match = re.search(r'\[\s*\{[\s\S]*\}\s*\]', result_text)
            if json_match:
                try:
                    parsed = json.loads(json_match.group())
                    if isinstance(parsed, list) and len(parsed) > 0:
                        personas_data = parsed
                        logger.info(f"Parsed {len(personas_data)} personas from LLM output")
                        break
                except json.JSONDecodeError as e:
                    logger.warning(f"JSON parse failed: {e}")
                    continue
        
        if not personas_data:
            logger.error("Failed to parse personas from LLM output")
            return {
                'success': False,
                'message': 'Failed to parse persona data from LLM response',
                'raw_output': results[1][:2000]
            }
        
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
            
            # Build the full persona item with all 8 sections
            # Fix names that may be missing spaces (e.g., "VeronicaChen" -> "Veronica Chen")
            raw_name = persona.get('name', f'Persona {i+1}')
            fixed_name = re.sub(r'([a-z])([A-Z])', r'\1 \2', raw_name)
            
            item = {
                'pk': f'PROJECT#{project_id}',
                'sk': f'PERSONA#{persona_id}',
                'gsi1pk': f'PROJECT#{project_id}#PERSONAS',
                'gsi1sk': now,
                'persona_id': persona_id,
                
                # Basic info
                'name': fixed_name,
                'tagline': persona.get('tagline', ''),
                'confidence': persona.get('confidence', 'medium'),
                'feedback_count': persona.get('feedback_count', len(feedback_items) // persona_count),
                
                # Section 1: Identity & Demographics
                'identity': persona.get('identity', {}),
                
                # Section 2: Goals & Motivations
                'goals_motivations': persona.get('goals_motivations', {}),
                
                # Section 3: Pain Points & Frustrations
                'pain_points': persona.get('pain_points', {}),
                
                # Section 4: Behaviors & Habits
                'behaviors': persona.get('behaviors', {}),
                
                # Section 5: Context & Environment
                'context_environment': persona.get('context_environment', {}),
                
                # Section 6: Representative Quotes
                'quotes': persona.get('quotes', []),
                
                # Section 7: Scenario/User Story
                'scenario': persona.get('scenario', {}),
                
                # Section 8: Research Notes (empty, for user to fill)
                'research_notes': [],
                
                # Metadata
                'supporting_evidence': persona.get('supporting_evidence', []),
                'source_breakdown': source_breakdown,
                'source_feedback_ids': [item.get('feedback_id', '') for item in feedback_items[:20]],
                'avatar_url': None,
                'avatar_prompt': None,
                'created_at': now,
                'updated_at': now,
                'llm_metadata': {
                    'model': MODEL_ID,
                    'prompt_version': '2.0.0',
                    'generation_time_ms': llm_time
                },
                
                # Legacy fields for backward compatibility
                'demographics': persona.get('identity', {}),
                'quote': persona.get('quotes', [{}])[0].get('text', '') if persona.get('quotes') else '',
                'goals': persona.get('goals_motivations', {}).get('secondary_goals', []),
                'frustrations': persona.get('pain_points', {}).get('current_challenges', []),
                'needs': persona.get('goals_motivations', {}).get('underlying_motivations', []),
            }
            
            # Generate avatar if enabled
            if generate_avatars:
                update_progress(85 + i * 3, f'generating_avatar_{i+1}')
                avatar_result = generate_persona_avatar({'persona_id': persona_id, **persona})
                item['avatar_url'] = avatar_result.get('avatar_url')
                item['avatar_prompt'] = avatar_result.get('avatar_prompt')
            
            projects_table.put_item(Item=item)
            saved_personas.append(item)
            logger.info(f"Saved enhanced persona: {persona.get('name')}")
        
        # Update persona count
        projects_table.update_item(
            Key={'pk': f'PROJECT#{project_id}', 'sk': 'META'},
            UpdateExpression='SET persona_count = persona_count + :count, updated_at = :now',
            ExpressionAttributeValues={':count': len(saved_personas), ':now': now}
        )
        
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
        logger.exception(f"Enhanced persona generation failed: {e}")
        return {'success': False, 'message': 'Failed to generate personas. Please try again.'}


@tracer.capture_method
def generate_prd(project_id: str, body: dict) -> dict:
    """Generate a Product Requirements Document using multi-step LLM chain."""
    if not projects_table:
        return {'success': False, 'message': 'Projects table not configured'}
    
    # Get project data including personas
    project_data = get_project(project_id)
    if 'error' in project_data:
        return {'success': False, 'message': project_data['error']}
    
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
    
    # Multi-step PRD generation
    # Step 1: Problem Analysis
    problem_system = """You are a product manager analyzing customer problems to define product requirements.
Be specific, data-driven, and focus on measurable outcomes."""
    
    problem_prompt = f"""Analyze the customer feedback and personas to deeply understand the problem space.

FEATURE IDEA: {feature_idea}

USER PERSONAS:
{personas_context}

CUSTOMER FEEDBACK:
{feedback_context}

Provide a thorough problem analysis:
1. What are the core problems customers are experiencing?
2. How do these problems affect different personas?
3. What is the business impact of not solving these problems?
4. What are the root causes?
5. What constraints should we consider?"""

    # Step 2: Solution Design
    solution_system = """You are a senior product manager designing solutions that address real customer needs.
Focus on feasibility, impact, and user-centered design."""
    
    solution_prompt = """Based on the problem analysis, design a solution.

Previous analysis:
{previous}

Define:
1. **Solution Overview**: High-level description
2. **Key Features**: 3-5 core features with descriptions
3. **User Stories**: For each persona, write 2-3 user stories
4. **Success Metrics**: How will we measure success?
5. **Risks & Mitigations**: What could go wrong?"""

    # Step 3: PRD Document
    prd_system = """You are creating a professional Product Requirements Document.
Be comprehensive but concise. Use clear formatting."""
    
    prd_prompt = """Create a complete PRD document.

Previous analysis and solution design:
{previous}

Generate a PRD with these sections:
1. **Executive Summary**
2. **Problem Statement**
3. **Goals & Success Metrics**
4. **User Personas** (reference the personas)
5. **Requirements**
   - Functional Requirements (prioritized P0/P1/P2)
   - Non-Functional Requirements
6. **User Stories & Acceptance Criteria**
7. **Out of Scope**
8. **Dependencies & Risks**
9. **Timeline Considerations**

Format as a professional document in Markdown."""

    try:
        results = invoke_bedrock_chain([
            {'system': problem_system, 'user': problem_prompt, 'max_tokens': 3000},
            {'system': solution_system, 'user': solution_prompt, 'max_tokens': 3000},
            {'system': prd_system, 'user': prd_prompt, 'max_tokens': 5000},
        ])
        
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
        return {'success': False, 'message': 'Failed to generate PRD. Please try again.'}


@tracer.capture_method
def generate_prfaq(project_id: str, body: dict) -> dict:
    """Generate an Amazon-style PR/FAQ document using multi-step LLM chain."""
    if not projects_table:
        return {'success': False, 'message': 'Projects table not configured'}
    
    # Get project data including personas
    project_data = get_project(project_id)
    if 'error' in project_data:
        return {'success': False, 'message': project_data['error']}
    
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
    
    # Multi-step PR/FAQ generation
    # Step 1: Customer-centric thinking
    customer_system = """You are thinking deeply about customers and their needs.
Channel the voice of real customers based on the feedback data."""
    
    customer_prompt = f"""Think deeply about what customers really want and need.

FEATURE IDEA: {feature_idea}

USER PERSONAS:
{personas_context}

CUSTOMER FEEDBACK:
{feedback_context}

Answer these questions from the customer's perspective:
1. What problem does this solve for me?
2. Why should I care about this?
3. How will this make my life better?
4. What would make me skeptical?
5. What would delight me about this?"""

    # Step 2: Press Release
    pr_system = """You are writing an Amazon-style press release announcing a new feature.
Write as if the feature is already launched and successful. Be specific and customer-focused."""
    
    pr_prompt = """Write a press release for this feature.

Customer insights:
{previous}

The press release should include:
1. **Headline**: Attention-grabbing, customer-benefit focused
2. **Subheadline**: Expand on the headline
3. **City, Date**: [City, Date]
4. **Opening Paragraph**: Who, what, when, where, why
5. **Problem Paragraph**: The customer problem being solved
6. **Solution Paragraph**: How the feature solves it
7. **Quote from Leadership**: Vision and commitment
8. **Customer Quote**: From one of the personas
9. **How It Works**: Brief explanation
10. **Call to Action**: How to get started

Write in professional press release style."""

    # Step 3: FAQ - Customer Questions
    faq_customer_system = """You are anticipating customer questions about a new feature.
Think like a skeptical but interested customer."""
    
    faq_customer_prompt = """Generate the Customer FAQ section.

Press Release:
{previous}

Create 5-7 customer FAQs covering:
- How does this work?
- How much does it cost?
- When is it available?
- What if I have problems?
- How is this different from alternatives?
- Questions specific to each persona

Format as Q&A pairs."""

    # Step 4: FAQ - Internal Questions
    faq_internal_system = """You are anticipating internal stakeholder questions.
Think like executives, engineers, and business partners."""
    
    faq_internal_prompt = """Generate the Internal FAQ section.

Press Release and Customer FAQ:
{previous}

Create 5-7 internal FAQs covering:
- Why now? Why this?
- What are the technical requirements?
- What are the risks?
- How do we measure success?
- What resources are needed?
- What's the timeline?

Format as Q&A pairs."""

    try:
        results = invoke_bedrock_chain([
            {'system': customer_system, 'user': customer_prompt, 'max_tokens': 2000},
            {'system': pr_system, 'user': pr_prompt, 'max_tokens': 2500},
            {'system': faq_customer_system, 'user': faq_customer_prompt, 'max_tokens': 2000},
            {'system': faq_internal_system, 'user': faq_internal_prompt, 'max_tokens': 2000},
        ])
        
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
        return {'success': False, 'message': 'Failed to generate PR/FAQ. Please try again.'}


@tracer.capture_method
def project_chat(project_id: str, body: dict) -> dict:
    """AI chat within project context, with persona mentions and document references support."""
    if not projects_table:
        return {'success': False, 'message': 'Projects table not configured'}
    
    message = body.get('message', '')
    if not message:
        return {'success': False, 'message': 'Message is required'}
    
    # Get selected personas and documents from request
    selected_persona_ids = body.get('selected_personas', [])
    selected_document_ids = body.get('selected_documents', [])
    
    # Get project data
    project_data = get_project(project_id)
    if 'error' in project_data:
        return {'success': False, 'message': project_data['error']}
    
    project = project_data.get('project', {})
    personas = project_data.get('personas', [])
    documents = project_data.get('documents', [])
    filters = project.get('filters', {})
    
    # Build persona map for mention detection
    persona_map = {}
    selected_personas = []
    
    for p in personas:
        name = p.get('name', '')
        persona_id = p.get('persona_id', '')
        persona_map[name.lower()] = p
        
        if persona_id in selected_persona_ids:
            selected_personas.append(p)
    
    # Check for persona mentions in message (e.g., @Marcus)
    import re
    mentions = re.findall(r'@(\w+)', message)
    mentioned_personas = []
    for mention in mentions:
        for name, persona in persona_map.items():
            if mention.lower() in name.lower() and persona not in mentioned_personas:
                mentioned_personas.append(persona)
    
    # Combine selected and mentioned personas
    all_active_personas = list({p.get('persona_id'): p for p in (selected_personas + mentioned_personas)}.values())
    
    # Build documents context - ONLY include selected documents with full content
    selected_docs_content = ""
    other_docs_list = []
    
    for doc in documents:
        doc_id = doc.get('document_id', '')
        doc_type = doc.get('document_type', 'doc').upper()
        doc_title = doc.get('title', 'Untitled')
        
        if doc_id in selected_document_ids:
            # Include FULL content for selected/tagged documents
            content = doc.get('content', '')
            selected_docs_content += f"""
## 📄 DOCUMENT: {doc_title} ({doc_type})

{content}

---
"""
        else:
            other_docs_list.append(f"- {doc_type}: {doc_title}")
    
    # Build active personas detail ONLY if personas are selected/mentioned
    active_personas_detail = ""
    if all_active_personas:
        active_personas_detail = "\n## 👤 ACTIVE PERSONAS (Respond from their perspective)\n"
        for p in all_active_personas:
            active_personas_detail += f"""
### {p.get('name')} - {p.get('tagline', '')}

**Their voice:** "{p.get('quote', '')}"

**Goals:**
{chr(10).join(['- ' + g for g in p.get('goals', [])[:4]])}

**Frustrations:**
{chr(10).join(['- ' + f for f in p.get('frustrations', [])[:4]])}

**Needs:**
{chr(10).join(['- ' + n for n in p.get('needs', [])[:4]])}

**Typical scenario:** {p.get('scenario', 'N/A')}

---
"""

    # Build system prompt - ONLY include relevant context
    system_prompt = f"""You are an AI product research assistant working on the project "{project.get('name', 'Project')}".

"""

    # Add selected documents FIRST (most important context)
    if selected_docs_content:
        system_prompt += f"""## REFERENCED DOCUMENTS (Use this content to answer the question)
{selected_docs_content}

"""

    # Add active personas if any are selected/mentioned
    if all_active_personas:
        persona_names = [p.get('name') for p in all_active_personas]
        system_prompt += f"""{active_personas_detail}

🎯 PERSONA MODE ACTIVE: {', '.join(persona_names)}
Respond AS IF you are this persona - use first person ("I think...", "As someone who..."), channel their specific frustrations, goals, and needs.

"""

    # Only fetch and include feedback if NO documents are selected (to keep context focused)
    if not selected_document_ids:
        feedback_items = get_feedback_context(filters, limit=30)
        feedback_context = format_feedback_for_llm(feedback_items[:15])
        system_prompt += f"""## Recent Customer Feedback
{feedback_context}

"""
    else:
        feedback_items = []

    # List other available resources (brief)
    if other_docs_list:
        system_prompt += f"""## Other Available Documents (not currently referenced)
{chr(10).join(other_docs_list[:5])}

"""
    
    if personas and not all_active_personas:
        persona_names_list = [f"@{p.get('name')}" for p in personas[:5]]
        system_prompt += f"""## Available Personas (mention with @ to activate)
{', '.join(persona_names_list)}

"""

    # Add instructions based on what's selected
    if selected_document_ids:
        doc_titles = [doc.get('title') for doc in documents if doc.get('document_id') in selected_document_ids]
        system_prompt += f"""📄 IMPORTANT: The user has tagged the document(s): {', '.join(doc_titles)}
You MUST use the document content provided above to answer their question.
- Cite specific sections, findings, or data points from the document
- If summarizing, capture the key points from the actual document content
- Do NOT make up information - only use what's in the document

"""

    system_prompt += """Be specific, accurate, and base your response on the provided context."""

    user_message = message
    
    try:
        response = invoke_bedrock(system_prompt, user_message, max_tokens=3000)
        
        return {
            'success': True,
            'response': response,
            'mentioned_personas': [p.get('name') for p in mentioned_personas],
            'selected_personas': [p.get('name') for p in selected_personas],
            'referenced_documents': [doc.get('title') for doc in documents if doc.get('document_id') in selected_document_ids],
            'context': {
                'feedback_count': len(feedback_items) if not selected_document_ids else 0,
                'persona_count': len(personas),
                'document_count': len(documents)
            }
        }
        
    except Exception as e:
        logger.exception(f"Project chat failed: {e}")
        return {'success': False, 'message': 'Failed to process chat request. Please try again.'}


@tracer.capture_method
def create_document(project_id: str, body: dict) -> dict:
    """Create a custom document in the project."""
    if not projects_table:
        return {'success': False, 'message': 'Projects table not configured'}
    
    title = body.get('title', 'Untitled Document')
    content = body.get('content', '')
    document_type = body.get('document_type', 'custom')
    
    if not content:
        return {'success': False, 'message': 'Content is required'}
    
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
    if not projects_table:
        return {'success': False, 'message': 'Projects table not configured'}
    
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
        return {'success': False, 'message': 'Document not found'}
    
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
    if not projects_table:
        return {'success': False, 'message': 'Projects table not configured'}
    
    # Find the SK for this document
    response = projects_table.query(
        KeyConditionExpression=Key('pk').eq(f'PROJECT#{project_id}'),
        FilterExpression=Attr('document_id').eq(document_id)
    )
    
    items = response.get('Items', [])
    if not items:
        return {'success': False, 'message': 'Document not found'}
    
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
        return {'success': False, 'message': 'Projects table not configured'}
    
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
        'demographics': body.get('demographics', {}),
        'quote': body.get('quote', ''),
        'goals': body.get('goals', []),
        'frustrations': body.get('frustrations', []),
        'behaviors': body.get('behaviors', []),
        'needs': body.get('needs', []),
        'scenario': body.get('scenario', ''),
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
def import_persona(project_id: str, body: dict) -> dict:
    """Import a persona from PDF, image, or text using Claude's multimodal capabilities.
    
    Extracts persona data from the input and creates a new persona with avatar generation.
    
    Args:
        project_id: The project ID
        body: Dict with:
            - input_type: 'pdf' | 'image' | 'text'
            - content: base64 encoded file (for pdf/image) or plain text
            - media_type: MIME type for files (e.g., 'application/pdf', 'image/png')
    """
    if not projects_table:
        return {'success': False, 'message': 'Projects table not configured'}
    
    input_type = body.get('input_type', 'text')
    content = body.get('content', '')
    media_type = body.get('media_type', '')
    
    if not content:
        return {'success': False, 'message': 'No content provided'}
    
    logger.info(f"[IMPORT_PERSONA] Starting import from {input_type} for project {project_id}")
    
    # Build the multimodal message for Claude
    system_prompt = """You are a UX researcher expert at extracting persona information from documents and images.

Extract persona data from the provided input and output a structured JSON object.
If information is not available, use reasonable defaults or null.

CRITICAL: Output ONLY valid JSON, no markdown, no explanation."""

    user_content = []
    
    if input_type == 'pdf':
        # Claude supports PDF via document block
        user_content.append({
            "type": "document",
            "source": {
                "type": "base64",
                "media_type": "application/pdf",
                "data": content
            }
        })
        user_content.append({
            "type": "text",
            "text": """Extract the persona information from this PDF document.

Output a JSON object with this exact structure:
```json
{
    "name": "Full Name",
    "tagline": "One sentence describing this persona",
    "confidence": "high",
    "identity": {
        "age_range": "30-45",
        "location": "City, Country",
        "occupation": "Job Title",
        "income_bracket": "$50k-100k or null",
        "education": "Degree or null",
        "family_status": "Status or null",
        "bio": "2-3 sentence background story"
    },
    "goals_motivations": {
        "primary_goal": "Main objective",
        "secondary_goals": ["Goal 2", "Goal 3"],
        "success_definition": "What success looks like",
        "underlying_motivations": ["Motivation 1", "Motivation 2"]
    },
    "pain_points": {
        "current_challenges": ["Challenge 1", "Challenge 2"],
        "blockers": ["Blocker 1"],
        "workarounds": ["Workaround 1"],
        "emotional_impact": "How frustrations affect them"
    },
    "behaviors": {
        "current_solutions": ["Solution 1"],
        "tools_used": ["Tool 1", "Tool 2"],
        "activity_frequency": "Daily|Weekly|Monthly",
        "tech_savviness": "low|medium|high",
        "decision_style": "Data-driven|Gut instinct|Research-heavy"
    },
    "context_environment": {
        "usage_context": "When and where they use the product",
        "devices": ["Device 1", "Device 2"],
        "time_constraints": "Time constraints",
        "social_context": "Work/social environment",
        "influencers": ["Influencer 1"]
    },
    "quotes": [
        {"text": "Quote from the persona", "context": "Context"}
    ],
    "scenario": {
        "title": "Scenario title",
        "narrative": "3-4 sentence user story",
        "trigger": "What triggers this scenario",
        "outcome": "Desired outcome"
    }
}
```

Output ONLY the JSON object."""
        })
    
    elif input_type == 'image':
        # Claude supports images directly
        user_content.append({
            "type": "image",
            "source": {
                "type": "base64",
                "media_type": media_type or "image/png",
                "data": content
            }
        })
        user_content.append({
            "type": "text",
            "text": """Extract the persona information from this image.

This may be a persona card, infographic, or screenshot of a persona document.
Extract all visible information and structure it.

Output a JSON object with this exact structure:
```json
{
    "name": "Full Name",
    "tagline": "One sentence describing this persona",
    "confidence": "high",
    "identity": {
        "age_range": "30-45",
        "location": "City, Country",
        "occupation": "Job Title",
        "income_bracket": "$50k-100k or null",
        "education": "Degree or null",
        "family_status": "Status or null",
        "bio": "2-3 sentence background story"
    },
    "goals_motivations": {
        "primary_goal": "Main objective",
        "secondary_goals": ["Goal 2", "Goal 3"],
        "success_definition": "What success looks like",
        "underlying_motivations": ["Motivation 1", "Motivation 2"]
    },
    "pain_points": {
        "current_challenges": ["Challenge 1", "Challenge 2"],
        "blockers": ["Blocker 1"],
        "workarounds": ["Workaround 1"],
        "emotional_impact": "How frustrations affect them"
    },
    "behaviors": {
        "current_solutions": ["Solution 1"],
        "tools_used": ["Tool 1", "Tool 2"],
        "activity_frequency": "Daily|Weekly|Monthly",
        "tech_savviness": "low|medium|high",
        "decision_style": "Data-driven|Gut instinct|Research-heavy"
    },
    "context_environment": {
        "usage_context": "When and where they use the product",
        "devices": ["Device 1", "Device 2"],
        "time_constraints": "Time constraints",
        "social_context": "Work/social environment",
        "influencers": ["Influencer 1"]
    },
    "quotes": [
        {"text": "Quote from the persona", "context": "Context"}
    ],
    "scenario": {
        "title": "Scenario title",
        "narrative": "3-4 sentence user story",
        "trigger": "What triggers this scenario",
        "outcome": "Desired outcome"
    }
}
```

Output ONLY the JSON object."""
        })
    
    else:  # text
        user_content.append({
            "type": "text",
            "text": f"""Extract the persona information from this text:

---
{content}
---

Output a JSON object with this exact structure:
```json
{{
    "name": "Full Name",
    "tagline": "One sentence describing this persona",
    "confidence": "high",
    "identity": {{
        "age_range": "30-45",
        "location": "City, Country",
        "occupation": "Job Title",
        "income_bracket": "$50k-100k or null",
        "education": "Degree or null",
        "family_status": "Status or null",
        "bio": "2-3 sentence background story"
    }},
    "goals_motivations": {{
        "primary_goal": "Main objective",
        "secondary_goals": ["Goal 2", "Goal 3"],
        "success_definition": "What success looks like",
        "underlying_motivations": ["Motivation 1", "Motivation 2"]
    }},
    "pain_points": {{
        "current_challenges": ["Challenge 1", "Challenge 2"],
        "blockers": ["Blocker 1"],
        "workarounds": ["Workaround 1"],
        "emotional_impact": "How frustrations affect them"
    }},
    "behaviors": {{
        "current_solutions": ["Solution 1"],
        "tools_used": ["Tool 1", "Tool 2"],
        "activity_frequency": "Daily|Weekly|Monthly",
        "tech_savviness": "low|medium|high",
        "decision_style": "Data-driven|Gut instinct|Research-heavy"
    }},
    "context_environment": {{
        "usage_context": "When and where they use the product",
        "devices": ["Device 1", "Device 2"],
        "time_constraints": "Time constraints",
        "social_context": "Work/social environment",
        "influencers": ["Influencer 1"]
    }},
    "quotes": [
        {{"text": "Quote from the persona", "context": "Context"}}
    ],
    "scenario": {{
        "title": "Scenario title",
        "narrative": "3-4 sentence user story",
        "trigger": "What triggers this scenario",
        "outcome": "Desired outcome"
    }}
}}
```

Output ONLY the JSON object."""
        })
    
    try:
        # Call Claude with multimodal content
        request_body = {
            'anthropic_version': 'bedrock-2023-05-31',
            'max_tokens': 4096,
            'system': system_prompt,
            'messages': [{'role': 'user', 'content': user_content}]
        }
        
        response = bedrock.invoke_model(
            modelId=MODEL_ID,
            body=json.dumps(request_body),
            contentType='application/json',
            accept='application/json'
        )
        
        result = json.loads(response['body'].read())
        response_text = result['content'][0]['text']
        
        # Parse JSON from response (handle markdown code blocks)
        json_text = response_text
        if '```json' in json_text:
            json_text = json_text.split('```json')[1].split('```')[0]
        elif '```' in json_text:
            json_text = json_text.split('```')[1].split('```')[0]
        
        persona_data = json.loads(json_text.strip())
        logger.info(f"[IMPORT_PERSONA] Extracted persona: {persona_data.get('name', 'Unknown')}")
        
    except json.JSONDecodeError as e:
        logger.error(f"[IMPORT_PERSONA] Failed to parse JSON: {e}")
        return {'success': False, 'message': 'Failed to parse persona data from the provided input'}
    except Exception as e:
        logger.exception(f"[IMPORT_PERSONA] Claude extraction failed: {e}")
        return {'success': False, 'message': 'Failed to extract persona from the provided input'}
    
    # Create the persona in DynamoDB
    now = datetime.now(timezone.utc).isoformat()
    persona_id = f"persona_{datetime.now().strftime('%Y%m%d%H%M%S')}"
    
    # Fix names that may be missing spaces (e.g., "VeronicaChen" -> "Veronica Chen")
    raw_name = persona_data.get('name', 'Imported Persona')
    fixed_name = re.sub(r'([a-z])([A-Z])', r'\1 \2', raw_name)
    
    item = {
        'pk': f'PROJECT#{project_id}',
        'sk': f'PERSONA#{persona_id}',
        'gsi1pk': f'PROJECT#{project_id}#PERSONAS',
        'gsi1sk': now,
        'persona_id': persona_id,
        'name': fixed_name,
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
    
    # Generate avatar using existing flow
    logger.info(f"[IMPORT_PERSONA] Generating avatar for {item['name']}")
    s3_bucket = os.environ.get('RAW_DATA_BUCKET', '')
    
    avatar_data = {'persona_id': persona_id, **item}
    avatar_result = generate_persona_avatar(avatar_data, s3_bucket)
    
    if avatar_result.get('avatar_url'):
        item['avatar_url'] = avatar_result['avatar_url']
        item['avatar_prompt'] = avatar_result.get('avatar_prompt', '')
        logger.info(f"[IMPORT_PERSONA] Avatar generated: {avatar_result['avatar_url']}")
    
    # Save to DynamoDB
    projects_table.put_item(Item=item)
    
    # Update persona count
    projects_table.update_item(
        Key={'pk': f'PROJECT#{project_id}', 'sk': 'META'},
        UpdateExpression='SET persona_count = persona_count + :one, updated_at = :now',
        ExpressionAttributeValues={':one': 1, ':now': now}
    )
    
    # Convert S3 URI to CDN URL for response
    if item.get('avatar_url') and item['avatar_url'].startswith('s3://'):
        item['avatar_url'] = get_avatar_cdn_url(item['avatar_url'])
    
    logger.info(f"[IMPORT_PERSONA] Successfully imported persona: {item['name']}")
    return {'success': True, 'persona': item}


@tracer.capture_method
def update_persona(project_id: str, persona_id: str, body: dict) -> dict:
    """Update a persona with support for all 8 sections."""
    if not projects_table:
        return {'success': False, 'message': 'Projects table not configured'}
    
    # Fix names that may be missing spaces (e.g., "VeronicaChen" -> "Veronica Chen")
    if 'name' in body and body['name']:
        body['name'] = re.sub(r'([a-z])([A-Z])', r'\1 \2', body['name'])
    
    now = datetime.now(timezone.utc).isoformat()
    
    update_expr = 'SET updated_at = :now'
    expr_values = {':now': now}
    expr_names = {}
    
    # All updatable fields - use expression attribute names for ALL fields
    # to avoid DynamoDB reserved keyword issues (identity, name, etc.)
    updatable_fields = [
        # Basic info
        'name', 'tagline', 'confidence',
        # Section 1: Identity
        'identity',
        # Section 2: Goals & Motivations
        'goals_motivations',
        # Section 3: Pain Points
        'pain_points',
        # Section 4: Behaviors
        'behaviors',
        # Section 5: Context & Environment
        'context_environment',
        # Section 6: Quotes
        'quotes',
        # Section 7: Scenario
        'scenario',
        # Section 8: Research Notes
        'research_notes',
        # Avatar
        'avatar_url', 'avatar_prompt',
        # Legacy fields for backward compatibility
        'demographics', 'quote', 'goals', 'frustrations', 'needs',
    ]
    
    for field in updatable_fields:
        if field in body:
            # Use expression attribute names for ALL fields to avoid reserved keyword issues
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
        return {'success': False, 'message': 'Failed to update persona'}


@tracer.capture_method
def add_persona_note(project_id: str, persona_id: str, body: dict) -> dict:
    """Add a research note to a persona."""
    if not projects_table:
        return {'success': False, 'message': 'Projects table not configured'}
    
    note_text = body.get('text', '')
    if not note_text:
        return {'success': False, 'message': 'Note text is required'}
    
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
        # Append note to research_notes array
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
        return {'success': False, 'message': 'Failed to add note'}


@tracer.capture_method
def update_persona_note(project_id: str, persona_id: str, note_id: str, body: dict) -> dict:
    """Update a research note on a persona."""
    if not projects_table:
        return {'success': False, 'message': 'Projects table not configured'}
    
    # Get current persona to find the note index
    response = projects_table.get_item(
        Key={'pk': f'PROJECT#{project_id}', 'sk': f'PERSONA#{persona_id}'}
    )
    
    item = response.get('Item')
    if not item:
        return {'success': False, 'message': 'Persona not found'}
    
    notes = item.get('research_notes', [])
    note_index = None
    
    for i, note in enumerate(notes):
        if note.get('note_id') == note_id:
            note_index = i
            break
    
    if note_index is None:
        return {'success': False, 'message': 'Note not found'}
    
    now = datetime.now(timezone.utc).isoformat()
    
    try:
        update_expr = f'SET research_notes[{note_index}].updated_at = :now'
        expr_values = {':now': now}
        
        if 'text' in body:
            update_expr += f', research_notes[{note_index}].#text = :text'
            expr_values[':text'] = body['text']
        
        if 'tags' in body:
            update_expr += f', research_notes[{note_index}].tags = :tags'
            expr_values[':tags'] = body['tags']
        
        update_expr += ', updated_at = :persona_updated'
        expr_values[':persona_updated'] = now
        
        projects_table.update_item(
            Key={'pk': f'PROJECT#{project_id}', 'sk': f'PERSONA#{persona_id}'},
            UpdateExpression=update_expr,
            ExpressionAttributeValues=expr_values,
            ExpressionAttributeNames={'#text': 'text'} if 'text' in body else {}
        )
        return {'success': True}
    except Exception as e:
        logger.exception(f"Failed to update persona note: {e}")
        return {'success': False, 'message': 'Failed to update note'}


@tracer.capture_method
def delete_persona_note(project_id: str, persona_id: str, note_id: str) -> dict:
    """Delete a research note from a persona."""
    if not projects_table:
        return {'success': False, 'message': 'Projects table not configured'}
    
    # Get current persona to find the note index
    response = projects_table.get_item(
        Key={'pk': f'PROJECT#{project_id}', 'sk': f'PERSONA#{persona_id}'}
    )
    
    item = response.get('Item')
    if not item:
        return {'success': False, 'message': 'Persona not found'}
    
    notes = item.get('research_notes', [])
    note_index = None
    
    for i, note in enumerate(notes):
        if note.get('note_id') == note_id:
            note_index = i
            break
    
    if note_index is None:
        return {'success': False, 'message': 'Note not found'}
    
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
        return {'success': False, 'message': 'Failed to delete note'}


@tracer.capture_method
def regenerate_persona_avatar(project_id: str, persona_id: str) -> dict:
    """Regenerate the avatar for a persona."""
    if not projects_table:
        return {'success': False, 'message': 'Projects table not configured'}
    
    # Get persona data
    response = projects_table.get_item(
        Key={'pk': f'PROJECT#{project_id}', 'sk': f'PERSONA#{persona_id}'}
    )
    
    item = response.get('Item')
    if not item:
        return {'success': False, 'message': 'Persona not found'}
    
    # Generate new avatar
    avatar_result = generate_persona_avatar(item)
    
    if not avatar_result.get('avatar_url'):
        return {'success': False, 'message': 'Avatar generation failed'}
    
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
        return {'success': False, 'message': 'Projects table not configured'}
    
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
        return {'success': False, 'message': 'Failed to delete persona'}


@tracer.capture_method
def run_research(project_id: str, body: dict) -> dict:
    """Run deep research analysis on feedback data."""
    if not projects_table:
        return {'success': False, 'message': 'Projects table not configured'}
    
    research_question = body.get('question', 'What are the main customer pain points?')
    
    # Get project data
    project_data = get_project(project_id)
    if 'error' in project_data:
        return {'success': False, 'message': project_data['error']}
    
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
    # Note: We don't include personas in research - it should be purely data-driven
    logger.info(f"Fetching feedback with filters: {filters}")
    feedback_items = get_feedback_context(filters, limit=100)
    logger.info(f"Found {len(feedback_items)} feedback items for research")
    
    if not feedback_items:
        return {'success': False, 'message': 'No feedback data found matching the filters. Try adjusting your filter criteria.'}
    
    feedback_context = format_feedback_for_llm(feedback_items)
    feedback_stats = get_feedback_statistics(feedback_items)
    
    # Multi-step research chain
    # Step 1: Data Analysis - Focus on ACTUAL FEEDBACK DATA
    analysis_system = """You are a senior user researcher conducting rigorous analysis of REAL customer feedback data.
Your analysis must be grounded in the actual feedback provided - cite specific reviews, quote customers directly, and identify patterns from the data.
Be thorough, data-driven, and cite specific examples."""
    
    analysis_prompt = f"""Conduct a thorough analysis to answer this research question based on the ACTUAL CUSTOMER FEEDBACK DATA provided below.

RESEARCH QUESTION: {research_question}

## FEEDBACK STATISTICS:
{feedback_stats}

## ACTUAL CUSTOMER FEEDBACK DATA ({len(feedback_items)} reviews):
{feedback_context}

---

Based on the ACTUAL FEEDBACK DATA above, analyze:
1. **Key Themes & Patterns**: What recurring themes appear in the feedback related to the research question?
2. **Frequency & Severity**: How often do issues appear? How severe are they based on sentiment and urgency?
3. **Customer Quotes**: Include 5-10 direct quotes from the feedback that best illustrate the findings
4. **Sentiment Analysis**: What is the overall sentiment? Are there differences by category or source?
5. **Root Causes**: What underlying issues do customers identify?
6. **Gaps in Data**: What questions remain unanswered?

IMPORTANT: Base ALL findings on the actual feedback data provided. Do not make assumptions beyond what the data shows."""

    # Step 2: Synthesis
    synthesis_system = """You are synthesizing research findings into actionable insights.
Focus on clarity, prioritization, and recommendations."""
    
    synthesis_prompt = """Synthesize the analysis into clear findings.

Previous analysis:
{previous}

Provide:
1. **Executive Summary** (2-3 sentences)
2. **Key Findings** (prioritized list)
3. **Supporting Evidence** (quotes and data points)
4. **Recommendations** (actionable next steps)
5. **Areas for Further Research**"""

    # Step 3: Validation
    validate_system = """You are a critical reviewer ensuring research quality.
Challenge assumptions and verify conclusions."""
    
    validate_prompt = """Review and validate the research findings.

Findings to validate:
{previous}

Check:
1. Are conclusions supported by the data?
2. Are there alternative interpretations?
3. What are the confidence levels?
4. What biases might be present?

Provide a final validated research report."""

    try:
        results = invoke_bedrock_chain([
            {'system': analysis_system, 'user': analysis_prompt, 'max_tokens': 9000, 'thinking_budget': 5000},
            {'system': synthesis_system, 'user': synthesis_prompt, 'max_tokens': 9000},
            {'system': validate_system, 'user': validate_prompt, 'max_tokens': 9000},
        ])
        
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
        
        # DynamoDB has 400KB limit - truncate if needed (leave room for other fields)
        max_content_size = 350000  # ~350KB to be safe
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
        return {'success': False, 'message': 'Failed to run research. Please try again.'}
