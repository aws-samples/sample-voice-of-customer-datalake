"""
Shared avatar generation utilities for persona avatars.
Uses Claude to generate image prompts and Nova Canvas to create images.
"""

import json
import os
import boto3

from shared.logging import logger, tracer
from shared.prompts import get_avatar_prompt_config, format_prompt


# Nova Canvas is only available in us-east-1
NOVA_CANVAS_REGION = 'us-east-1'
NOVA_CANVAS_MODEL_ID = 'amazon.nova-canvas-v1:0'


def generate_avatar_prompt_with_llm(persona_data: dict, bedrock_client) -> str:
    """Use Claude to generate an optimal image prompt from persona data.
    
    Args:
        persona_data: Dict with persona info (name, tagline, identity, etc.)
        bedrock_client: Bedrock runtime client for Claude calls
        
    Returns:
        Generated image prompt string
    """
    from shared.aws import BEDROCK_MODEL_ID
    
    name = persona_data.get('name', 'Unknown')
    tagline = persona_data.get('tagline', '')
    identity = persona_data.get('identity', {})
    bio = identity.get('bio', '')
    age_range = identity.get('age_range', '')
    occupation = identity.get('occupation', '')
    location = identity.get('location', '')
    
    # Load prompt config from external file
    config = get_avatar_prompt_config()
    system_prompt = config.get('system_prompt', '')
    user_template = config.get('user_prompt_template', '')
    
    user_msg = format_prompt(
        user_template,
        name=name,
        tagline=tagline,
        age_range=age_range,
        occupation=occupation,
        location=location,
        bio=bio[:300] if bio else 'N/A'
    )

    try:
        request_body = {
            'anthropic_version': 'bedrock-2023-05-31',
            'max_tokens': config.get('max_tokens', 200),
            'system': system_prompt,
            'messages': [{'role': 'user', 'content': user_msg}]
        }
        
        response = bedrock_client.invoke_model(
            modelId=BEDROCK_MODEL_ID,
            contentType='application/json',
            accept='application/json',
            body=json.dumps(request_body)
        )
        result = json.loads(response['body'].read())
        
        # Handle response with thinking blocks
        for block in result.get('content', []):
            if block.get('type') == 'text':
                return block.get('text', '').strip()
        
        return result['content'][0]['text'].strip()
    except Exception as e:
        logger.warning(f"[PERSONA_AVATAR] LLM prompt generation failed: {e}, using fallback")
        fallback_template = config.get('fallback_prompt_template', 'Professional headshot of a {occupation}, friendly expression, soft studio lighting, neutral background, photorealistic')
        return format_prompt(fallback_template, occupation=occupation or 'professional')


@tracer.capture_method
def generate_persona_avatar(persona_data: dict, bedrock_client, s3_bucket: str = None) -> dict:
    """
    Generate an AI avatar image for a persona.
    
    Uses Claude to create an intelligent image prompt from persona data (name, bio, occupation),
    then Nova Canvas to generate the actual image.
    
    Args:
        persona_data: Dict with name, tagline, identity (bio, age_range, occupation, location), persona_id
        bedrock_client: Bedrock runtime client for Claude calls
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
    avatar_prompt = generate_avatar_prompt_with_llm(persona_data, bedrock_client)
    logger.info(f"[PERSONA_AVATAR] Generated prompt: {avatar_prompt}")
    
    try:
        # Nova Canvas is only available in us-east-1
        # IAM policy must include: arn:aws:bedrock:us-east-1::foundation-model/amazon.nova-canvas-v1:0
        logger.info(f"[PERSONA_AVATAR] Creating Bedrock client for {NOVA_CANVAS_REGION} (Nova Canvas region)")
        bedrock_runtime = boto3.client('bedrock-runtime', region_name=NOVA_CANVAS_REGION)
        
        # Nova Canvas request format - must use 1024x1024 dimensions
        # Do NOT include 'quality' or 'cfgScale' params - they cause ValidationException
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
        
        logger.info(f"[PERSONA_AVATAR] Invoking Nova Canvas model: {NOVA_CANVAS_MODEL_ID}")
        
        response = bedrock_runtime.invoke_model(
            modelId=NOVA_CANVAS_MODEL_ID,
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
            ContentType='image/png',
            CacheControl='public, max-age=31536000, immutable',
        )
        
        avatar_url = f"s3://{s3_bucket}/{s3_key}"
        logger.info(f"[PERSONA_AVATAR] SUCCESS - Avatar generated for {persona_name}: {avatar_url}")
        
        return {'avatar_url': avatar_url, 'avatar_prompt': avatar_prompt}
        
    except Exception as e:
        error_type = type(e).__name__
        if 'AccessDenied' in error_type or 'AccessDenied' in str(e):
            logger.error(f"[PERSONA_AVATAR] ACCESS DENIED - Check IAM policy includes arn:aws:bedrock:{NOVA_CANVAS_REGION}::foundation-model/{NOVA_CANVAS_MODEL_ID}", extra={"error": str(e)})
        elif 'ValidationException' in error_type or 'ValidationException' in str(e):
            logger.error(f"[PERSONA_AVATAR] VALIDATION ERROR - Check Nova Canvas request format (must use 1024x1024, no quality/cfgScale params)", extra={"error": str(e)})
        else:
            logger.error(f"[PERSONA_AVATAR] FAILED - Avatar generation error: {error_type}: {e}", extra={
                "persona_id": persona_id,
                "error_type": error_type,
                "error": str(e)
            })
        return {'avatar_url': None, 'avatar_prompt': avatar_prompt}


def get_avatar_cdn_url(s3_uri: str, cdn_url: str = None) -> str | None:
    """Convert S3 URI to CloudFront CDN URL for avatar images.
    
    S3 URI format: s3://bucket/avatars/{persona_id}.png
    CDN URL format: https://{cdn_domain}/{persona_id}.png
    
    Args:
        s3_uri: S3 URI of the avatar image
        cdn_url: Optional CDN URL override, defaults to AVATARS_CDN_URL env var
        
    Returns:
        CloudFront CDN URL or None if conversion fails
    """
    if not s3_uri or not s3_uri.startswith('s3://'):
        return None
    
    avatars_cdn_url = cdn_url or os.environ.get('AVATARS_CDN_URL', '')
    if not avatars_cdn_url:
        logger.warning("AVATARS_CDN_URL not configured")
        return None
    
    try:
        # Extract filename from s3://bucket/avatars/{persona_id}.png
        # The CloudFront distribution has originPath='/avatars' so we just need the filename
        parts = s3_uri.split('/')
        if len(parts) < 2:
            return None
        filename = parts[-1]  # e.g., persona_20241128123456_0.png
        
        return f"{avatars_cdn_url.rstrip('/')}/{filename}"
    except Exception as e:
        logger.warning(f"Failed to generate CDN URL for {s3_uri}: {e}")
        return None
