"""
Shared avatar generation utilities for persona avatars.
Uses Claude to generate image prompts, then the Bedrock image model configured
in avatar-generation.json ("image_model") to create the images.
"""

import hashlib
import json
import os
import threading
import boto3

from shared.logging import logger, tracer
from shared.prompts import get_avatar_prompt_config, format_prompt

# `shared.cloudfront_signing` (and through it `cryptography`) is imported LAZILY
# inside get_avatar_cdn_url — the only function here that signs. The rest of this
# module is the avatar WRITER path (generate_persona_avatar), used by the
# persona-generator and persona-importer jobs, which never mint a URL. Keeping
# the import here would make those jobs fail at cold start over a dependency they
# do not use. Same reasoning as shared/prototypes.py.


# Image-model defaults, used only if avatar-generation.json omits the field.
# The authoritative values live in that config's "image_model" block, kept in
# lockstep with lib/utils/model-allowlist.ts (which builds the IAM grant) by
# test_avatar_image_model_lockstep.py.
#
# The region is deliberately NOT the platform's us-east-1: no active
# text-to-image model is offered there (Nova Canvas was the only one and went
# legacy), so this calls us-west-2 cross-region. See model-allowlist.ts.
DEFAULT_IMAGE_MODEL_REGION = 'us-west-2'
DEFAULT_IMAGE_MODEL_ID = 'stability.stable-image-core-v1:1'
DEFAULT_ASPECT_RATIO = '1:1'
# JPEG, not PNG: the model emits 1536x1536 and these render at 32-128 CSS px
# (w-8 in chat bubbles, up to max-w-[128px] for the large variant, 80px in the
# PDF export). Measured on the same seed/prompt: PNG 2,677,833 bytes vs JPEG
# 401,603 — 6.7x smaller for photographic content that is downscaled anyway.
# Lossless compression of a photo is the wrong trade here. ('webp' is rejected
# by the model as an invalid output_format.)
DEFAULT_OUTPUT_FORMAT = 'jpeg'

# Stability's seed field is a 32-bit unsigned range, and it treats 0 as "pick a
# random seed" — so a derived seed must never land on 0 or that one hash bucket
# silently loses determinism.
_MAX_SEED = 4294967294

# Formats the model accepts for output_format. 'webp' is rejected by Bedrock
# ("not a valid"), so an unknown value is coerced to the default rather than
# failing generation at invoke time.
_SUPPORTED_OUTPUT_FORMATS = frozenset({'png', 'jpeg'})

# Extensions a persona's avatar may have been written under previously. The key
# embeds the format, so changing output_format would otherwise leave the old
# object orphaned forever.
_HISTORICAL_EXTENSIONS = ('png', 'jpeg', 'jpg', 'webp')

# Region-pinned image-model clients, cached for the life of the execution
# environment (one per region, since the region is config-driven). Building a
# boto3 client costs a botocore session + endpoint resolution, and the persona
# generator used to pay that per persona — with the avatar loop now concurrent,
# several threads would also build clients simultaneously. boto3 clients are
# thread-safe to USE but creating them is not, hence the lock.
_image_model_clients: dict[str, object] = {}
_image_model_clients_lock = threading.Lock()


def get_image_model_client(region: str):
    """Bedrock runtime client pinned to the image model's region, cached.

    Cached per region rather than globally because the region comes from
    avatar-generation.json, so a config change must not keep handing back a
    client for the old region.
    """
    client = _image_model_clients.get(region)
    if client is None:
        with _image_model_clients_lock:
            client = _image_model_clients.get(region)
            if client is None:
                logger.info(f"[PERSONA_AVATAR] Creating Bedrock client for {region} (image model region)")
                client = boto3.client('bedrock-runtime', region_name=region)
                _image_model_clients[region] = client
    return client


def clear_image_model_client_cache() -> None:
    """Drop the cached region-pinned clients.

    Exists for tests: the cache lives for the whole process, so a test that
    patches boto3 would otherwise be served a client built by an earlier test.
    """
    with _image_model_clients_lock:
        _image_model_clients.clear()


def get_image_model_config() -> dict:
    """Resolve the avatar image model settings from the prompt config.

    Reads the "image_model" block of avatar-generation.json. That block existed
    for a long time while this module ignored it in favour of hardcoded
    constants, so editing the config had no effect — the same decoy-config trap
    the research prompts had. Defaults above apply only to absent keys.
    """
    image_model = get_avatar_prompt_config().get('image_model', {})
    output_format = image_model.get('output_format', DEFAULT_OUTPUT_FORMAT)
    if output_format not in _SUPPORTED_OUTPUT_FORMATS:
        # Validate here rather than discovering it as a Bedrock ValidationException
        # mid-generation: the format also names the S3 object, so a bad value would
        # produce a misleading key and ContentType before the call even failed.
        logger.warning(
            f"[PERSONA_AVATAR] Unsupported output_format {output_format!r}; "
            f"falling back to {DEFAULT_OUTPUT_FORMAT!r} "
            f"(supported: {sorted(_SUPPORTED_OUTPUT_FORMATS)})"
        )
        output_format = DEFAULT_OUTPUT_FORMAT
    return {
        'model_id': image_model.get('model_id', DEFAULT_IMAGE_MODEL_ID),
        'region': image_model.get('region', DEFAULT_IMAGE_MODEL_REGION),
        'aspect_ratio': image_model.get('aspect_ratio', DEFAULT_ASPECT_RATIO),
        'output_format': output_format,
    }


def _delete_superseded_avatars(s3_client, bucket: str, persona_id: str, keep: str) -> None:
    """Remove this persona's avatar stored under a different extension.

    The S3 key embeds the image format, so regenerating a persona after an
    output_format change writes a NEW object (avatars/x.jpeg) and leaves the old
    one (avatars/x.png) behind with nothing referencing it. Best-effort: a failure
    here must never fail avatar generation, and deleting an absent key is a no-op
    in S3, so this costs nothing when there is nothing to clean.
    """
    for extension in _HISTORICAL_EXTENSIONS:
        if extension == keep:
            continue
        try:
            s3_client.delete_object(Bucket=bucket, Key=f"avatars/{persona_id}.{extension}")
        except Exception as e:  # noqa: BLE001 - cleanup must not break generation
            logger.warning(
                f"[PERSONA_AVATAR] Could not remove superseded avatars/{persona_id}.{extension}: {e}"
            )


def _stable_seed(persona_id: str) -> int:
    """Deterministic seed so regenerating one persona reproduces its avatar.

    Uses sha256 rather than hash(): Python randomises str hashing per process
    unless PYTHONHASHSEED is fixed, so the previous hash(persona_id) gave a
    DIFFERENT seed on every cold start despite the code claiming consistency.
    """
    digest = hashlib.sha256(persona_id.encode('utf-8')).hexdigest()
    # Offset by 1: seed 0 means "choose randomly" to Stability, so a digest that
    # happened to land on 0 would silently lose determinism for that one bucket.
    return 1 + int(digest[:8], 16) % (_MAX_SEED - 1)


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
    then the configured image model to generate the actual image.
    
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
    
    image_model = get_image_model_config()
    model_id = image_model['model_id']
    model_region = image_model['region']

    try:
        # The image model is region-pinned; the IAM grant is built from the same
        # values via imageModelArn() in lib/utils/model-allowlist.ts. The client
        # is cached per region for the execution environment, so a batch of
        # personas builds it once instead of once each.
        bedrock_runtime = get_image_model_client(model_region)

        # Stability text-to-image request format (shared by stable-image-core,
        # stable-image-ultra and sd3-5-large). Note this is NOT interchangeable
        # with the Nova Canvas taskType/textToImageParams body it replaced — a
        # model from another vendor needs its own builder here.
        request_body = {
            "prompt": avatar_prompt,
            "mode": "text-to-image",
            "aspect_ratio": image_model['aspect_ratio'],
            "output_format": image_model['output_format'],
            "seed": _stable_seed(persona_id),
        }
        
        logger.info(f"[PERSONA_AVATAR] Invoking image model: {model_id}")
        
        response = bedrock_runtime.invoke_model(
            modelId=model_id,
            body=json.dumps(request_body)
        )
        
        result = json.loads(response['body'].read())
        images = result.get('images', [])
        
        if not images:
            # finish_reasons explains a content-filtered or failed generation,
            # which returns 200 with no image rather than raising.
            logger.warning(
                f"[PERSONA_AVATAR] {model_id} returned no images "
                f"(finish_reasons={result.get('finish_reasons')})"
            )
            return {'avatar_url': None, 'avatar_prompt': avatar_prompt}
        
        logger.info(f"[PERSONA_AVATAR] {model_id} generated {len(images)} image(s)")
        
        # Decode base64 image and upload to S3. Extension and content type follow
        # the configured output_format so they cannot disagree with the bytes.
        image_data = base64.b64decode(images[0])
        image_format = image_model['output_format']
        s3_key = f"avatars/{persona_id}.{image_format}"
        
        logger.info(f"[PERSONA_AVATAR] Uploading avatar to S3: s3://{s3_bucket}/{s3_key}")
        
        s3_client = boto3.client('s3')
        s3_client.put_object(
            Bucket=s3_bucket,
            Key=s3_key,
            Body=image_data,
            # No jpg/jpeg special case needed: get_image_model_config() has already
            # constrained the format to _SUPPORTED_OUTPUT_FORMATS.
            ContentType=f"image/{image_format}",
            CacheControl='public, max-age=31536000, immutable',
        )
        # The key embeds the format, so a format change would otherwise leave the
        # persona's previous avatar orphaned in the bucket.
        _delete_superseded_avatars(s3_client, s3_bucket, persona_id, image_format)
        
        avatar_url = f"s3://{s3_bucket}/{s3_key}"
        logger.info(f"[PERSONA_AVATAR] SUCCESS - Avatar generated for {persona_name}: {avatar_url}")
        
        return {'avatar_url': avatar_url, 'avatar_prompt': avatar_prompt}
        
    except Exception as e:
        error_type = type(e).__name__
        if 'AccessDenied' in error_type or 'AccessDenied' in str(e):
            logger.error(f"[PERSONA_AVATAR] ACCESS DENIED - Check IAM policy includes arn:aws:bedrock:{model_region}::foundation-model/{model_id}", extra={"error": str(e)})
        elif 'ResourceNotFound' in error_type or 'ResourceNotFound' in str(e):
            # A legacy model reports itself as "not found" once the account loses
            # access (15+ days idle during the legacy window, or past EOL). Name
            # the cause explicitly: the generic branch below made a past outage
            # look like a transient error for far too long.
            logger.error(
                f"[PERSONA_AVATAR] MODEL NOT AVAILABLE - {model_id} was not found in "
                f"{model_region}. A LEGACY model returns this once the account loses "
                "access (idle 15+ days) or after its EOL date. Check its lifecycle "
                "state and migrate: aws bedrock list-foundation-models "
                "--by-output-modality IMAGE",
                extra={"error": str(e), "model_id": model_id, "region": model_region},
            )
        elif 'ValidationException' in error_type or 'ValidationException' in str(e):
            logger.error(
                f"[PERSONA_AVATAR] VALIDATION ERROR - Check the request format for {model_id}. "
                "Stability models take prompt/mode/aspect_ratio/output_format; a model "
                "from another vendor needs its own request body, not this one",
                extra={"error": str(e)},
            )
        else:
            logger.error(f"[PERSONA_AVATAR] FAILED - Avatar generation error: {error_type}: {e}", extra={
                "persona_id": persona_id,
                "error_type": error_type,
                "error": str(e)
            })
        return {'avatar_url': None, 'avatar_prompt': avatar_prompt}


def get_avatar_cdn_url(s3_uri: str, cdn_url: str = None) -> str | None:
    """Convert S3 URI to a SIGNED CloudFront CDN URL for avatar images.

    S3 URI format: s3://bucket/avatars/{persona_id}.{ext}
    CDN URL format: https://{cdn_domain}/avatars/{persona_id}.{ext}?Expires=...
    The extension follows the configured output_format; parsing below is
    extension-agnostic (it takes the trailing path segment).

    The `/avatars/*` cache behavior is restricted by a CloudFront trusted key
    group (issue #229), so the URL is only useful to a browser once signed.
    Signing happens HERE, at read time, rather than where the avatar is
    generated: the stored value stays a plain `s3://` URI, so a URL is never
    persisted with a baked-in expiry.

    Returns None rather than an unsigned URL when signing is unavailable — an
    unsigned URL would 403 anyway, and returning one would mean handing out an
    unauthenticated link the moment the key group were ever removed. Callers
    already treat None as "no avatar" (the SPA renders a gradient fallback).

    Args:
        s3_uri: S3 URI of the avatar image
        cdn_url: Optional CDN URL override, defaults to AVATARS_CDN_URL env var

    Returns:
        Signed CloudFront CDN URL, or None if it cannot be produced
    """
    if not s3_uri or not s3_uri.startswith('s3://'):
        return None
    
    avatars_cdn_url = cdn_url or os.environ.get('AVATARS_CDN_URL', '')
    if not avatars_cdn_url:
        logger.warning("AVATARS_CDN_URL not configured")
        return None
    
    try:
        # Extract filename from s3://bucket/avatars/{persona_id}.{ext}
        # AVATARS_CDN_URL already ends in /avatars (the cache behavior's path
        # prefix maps 1:1 to the S3 key prefix), so only the filename is needed.
        parts = s3_uri.split('/')
        if len(parts) < 2:
            return None
        filename = parts[-1]  # e.g., persona_20241128123456_0.jpeg
        
        # Lazy on purpose — see the note beside the imports at the top.
        from shared.cloudfront_signing import sign_url

        return sign_url(f"{avatars_cdn_url.rstrip('/')}/{filename}")
    except Exception as e:
        logger.warning(f"Failed to generate CDN URL for {s3_uri}: {e}")
        return None
