"""
Shared avatar generation utilities for persona avatars.
Uses Claude to generate image prompts, then the Bedrock image model configured
in avatar-generation.json ("image_model") to create the images.
"""

from __future__ import annotations

import hashlib
import json
import os
import threading
from typing import TYPE_CHECKING

import boto3

from shared.logging import logger, tracer
from shared.prompts import format_prompt, get_avatar_prompt_config

if TYPE_CHECKING:
    from mypy_boto3_bedrock_runtime import BedrockRuntimeClient

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

# AI surface (shared/model_config.py) the avatar image-PROMPT writer resolves its
# text model through. 'utility' is the picker's bucket for small helper calls; the
# persona text itself runs on 'documents'.
AVATAR_PROMPT_SURFACE = 'utility'

# Used when the LLM call fails or answers empty and avatar-generation.json has no
# fallback_prompt_template of its own.
_DEFAULT_FALLBACK_PROMPT_TEMPLATE = (
    'Professional headshot of a {occupation}, friendly expression, soft studio '
    'lighting, neutral background, photorealistic'
)

# S3 user-metadata key recording which project an avatar object belongs to.
#
# The key space `avatars/{persona_id}/{digest}.{ext}` (legacy: the flat
# `avatars/{persona_id}.{ext}`) carries no project component — the only one a
# project owns without one — and persona ids are not globally unique:
# `create_persona` and the persona importer both mint `persona_{YYYYMMDDHHMMSS}`
# with no project part and no randomness, so two personas created in the same
# second in DIFFERENT projects name one object. Ownership therefore cannot be
# inferred from the key; a project delete that assumed it could would remove a
# live avatar from a project nobody deleted. Recorded at write time instead (the
# only moment the owner is known for certain). boto3 hands user metadata back
# under this exact key, so writer and reader share the constant. Ported from
# PR #407 (perrozzi).
AVATAR_OWNER_METADATA_KEY = 'project-id'

# Region-pinned image-model clients, cached for the life of the execution
# environment (one per region, since the region is config-driven). Building a
# boto3 client costs a botocore session + endpoint resolution, and the persona
# generator used to pay that per persona — with the avatar loop now concurrent,
# several threads would also build clients simultaneously. boto3 clients are
# thread-safe to USE but creating them is not, hence the lock.
_image_model_clients: dict[str, BedrockRuntimeClient] = {}
_image_model_clients_lock = threading.Lock()


# Connection pool for the shared image-model client. Caching the client turned it from
# "one per persona" into "one shared by every avatar thread", and botocore's default pool
# is 10 — exactly the fan-out ceiling, i.e. zero headroom. urllib3 builds that pool with
# block=False, so a connection over the limit is served by a throwaway socket plus a
# "Connection pool is full" warning rather than by queueing: the degradation is silent and
# no test would catch it. Sized above the ceiling so the pool is never the binding limit.
#
# Kept as a literal here rather than importing shared.api because this module keeps a
# deliberately narrow import graph (see the lazy imports below, and the guard test that
# importing it must not pull in `cryptography`). A lockstep test pins it to
# MAX_PERSONAS_PER_GENERATION so the two cannot drift.
IMAGE_CLIENT_POOL_CONNECTIONS = 16

# Retries: botocore's default is the `legacy` mode, which does not back off on
# throttling. A 10-wide fan-out against on-demand image-model quota makes
# ThrottlingException the expected failure, and `standard` is what turns it into a retry
# instead of an avatar that silently comes back empty.
IMAGE_CLIENT_MAX_ATTEMPTS = 3
IMAGE_CLIENT_READ_TIMEOUT = 120
IMAGE_CLIENT_CONNECT_TIMEOUT = 10


def get_image_model_client(region: str) -> BedrockRuntimeClient:
    """Bedrock runtime client pinned to the image model's region, cached.

    Cached per region rather than globally because the region comes from
    avatar-generation.json, so a config change must not keep handing back a
    client for the old region.

    Configured explicitly rather than on botocore defaults: this one client now serves
    every avatar thread, so the connection pool and the retry mode are properties of the
    fan-out, not of a single call. See the constants above for why each value.
    """
    client = _image_model_clients.get(region)
    if client is None:
        with _image_model_clients_lock:
            client = _image_model_clients.get(region)
            if client is None:
                # Imported here, not at module scope, to keep this module's import graph
                # narrow — same reason shared.aws is imported inside the functions below.
                from botocore.config import Config
                logger.info(f"[PERSONA_AVATAR] Creating Bedrock client for {region} (image model region)")
                client = boto3.client(
                    'bedrock-runtime',
                    region_name=region,
                    config=Config(
                        max_pool_connections=IMAGE_CLIENT_POOL_CONNECTIONS,
                        retries={'mode': 'standard', 'max_attempts': IMAGE_CLIENT_MAX_ATTEMPTS},
                        read_timeout=IMAGE_CLIENT_READ_TIMEOUT,
                        connect_timeout=IMAGE_CLIENT_CONNECT_TIMEOUT,
                    ),
                )
                _image_model_clients[region] = client
    return client


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


AVATAR_KEY_PREFIX = 'avatars/'

# Hex characters of the content digest in an avatar key: enough that two images of
# one persona never share a key, short enough to keep the URL readable.
AVATAR_DIGEST_CHARS = 24


def avatar_object_key(persona_id: str, image_data: bytes, image_format: str) -> str:
    """The S3 key one generated image is stored under: new per image, never reused.

    Content-addressed (`avatars/{persona_id}/{sha256}.{ext}`). The key used to be
    `avatars/{persona_id}.{ext}`, overwritten by every regeneration, while the
    object is served `immutable` for a year and the `/avatars/*` CloudFront cache
    key ignores the query string (so the signature does not bust it either): a
    regenerated avatar kept showing the OLD image until the edge copy expired. A
    new key per image makes the new URL a cache miss by construction, and the
    long-lived immutable caching becomes correct rather than harmful.
    """
    digest = hashlib.sha256(image_data).hexdigest()[:AVATAR_DIGEST_CHARS]
    return f'{AVATAR_KEY_PREFIX}{persona_id}/{digest}.{image_format}'


def avatar_object_keys(persona_id: str) -> tuple[str, ...]:
    """Every LEGACY flat key one persona's avatar may occupy (`avatars/{id}.{ext}`).

    The flat key embedded the image format, so a persona regenerated across an
    `output_format` change could have an object under more than one extension.
    Current images live under the persona's prefix instead; see
    ``persona_avatar_keys`` for the complete inventory. A caller deleting on behalf
    of a project must still check ownership (see AVATAR_OWNER_METADATA_KEY).
    """
    return tuple(f'{AVATAR_KEY_PREFIX}{persona_id}.{extension}' for extension in _HISTORICAL_EXTENSIONS)


def persona_avatar_keys(s3_client, bucket: str, persona_id: str) -> list[str]:
    """Every key one persona's avatar may occupy: the legacy flat keys + its prefix.

    The flat keys are candidates (they may not exist — the owner HEAD answers
    that); the per-persona prefix is listed, so every image ever generated for the
    persona is found, however many regenerations ago. A listing failure raises: a
    sweep that silently saw nothing would leave the objects behind for good.
    """
    keys = list(avatar_object_keys(persona_id))
    paginator = s3_client.get_paginator('list_objects_v2')
    for page in paginator.paginate(Bucket=bucket, Prefix=f'{AVATAR_KEY_PREFIX}{persona_id}/'):
        keys.extend(entry['Key'] for entry in page.get('Contents', []) if isinstance(entry.get('Key'), str))
    return keys


def avatar_key_from_uri(s3_uri: object, bucket: str) -> str | None:
    """The key an `s3://{bucket}/avatars/...` URI names, or None for anything else."""
    prefix = f's3://{bucket}/{AVATAR_KEY_PREFIX}'
    if not isinstance(s3_uri, str) or not s3_uri.startswith(prefix):
        return None
    return s3_uri.removeprefix(f's3://{bucket}/')


def avatar_object_owner(s3_client, bucket: str, key: str) -> str | None:
    """Which project this avatar object belongs to, or None if it cannot be told.

    None covers three cases a deleting caller must treat alike: the object does
    not exist, it predates the owner stamp, or the HEAD itself failed. Deleting on
    None would reintroduce the cross-project deletion this exists to prevent, so
    the safe reading leaves an ambiguous object alone.
    """
    try:
        response = s3_client.head_object(Bucket=bucket, Key=key)
    except Exception:  # noqa: BLE001 - absent or unreadable both mean "cannot tell"
        return None
    metadata = response.get('Metadata') if isinstance(response, dict) else None
    if not isinstance(metadata, dict):
        return None
    owner = metadata.get(AVATAR_OWNER_METADATA_KEY)
    return owner if isinstance(owner, str) and owner else None


def delete_superseded_avatars(
    s3_client, bucket: str, persona_id: str, *, keep: str, project_id: str | None,
    previous_key: str | None = None,
) -> None:
    """Remove this persona's earlier avatar images once a new one is referenced.

    Called AFTER the persona row points at ``keep``, so a failure between upload
    and update can never leave the row naming a deleted object. Removed:

    * every image under the persona's prefix stamped as this project's;
    * the image the row named before (``previous_key``) unless another project's
      stamp is on it — the row is the evidence it was ours, which covers a legacy
      object written before the owner stamp existed;
    * the legacy flat keys stamped as this project's.

    An object stamped by ANOTHER project is always kept: persona ids are not
    unique across projects. Best-effort: a failure is logged, never raised —
    the new avatar is already live.
    """
    try:
        candidates = persona_avatar_keys(s3_client, bucket, persona_id)
    except Exception as e:  # noqa: BLE001 - cleanup must not fail the regeneration
        logger.warning(f"[PERSONA_AVATAR] Could not list superseded avatars of {persona_id}: {e}")
        candidates = []
    if previous_key and previous_key not in candidates:
        candidates.append(previous_key)
    for key in dict.fromkeys(candidates):
        if key == keep:
            continue
        owner = avatar_object_owner(s3_client, bucket, key)
        ours = owner == project_id if owner is not None else key == previous_key
        if not ours:
            continue
        try:
            s3_client.delete_object(Bucket=bucket, Key=key)
        except Exception as e:  # noqa: BLE001 - cleanup must not fail the regeneration
            logger.warning(f"[PERSONA_AVATAR] Could not remove superseded {key}: {e}")


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


def generate_avatar_prompt_with_llm(persona_data: dict) -> str:
    """Use Claude to generate an optimal image prompt from persona data.

    The text model is resolved through the per-surface model picker
    (``AVATAR_PROMPT_SURFACE`` via shared.converse), never a hardcoded id: a
    raw ``BEDROCK_MODEL_ID`` invoke AccessDenied in any deployment where that
    one model was not enabled, and the fallback below then hid it (issue #273).

    Args:
        persona_data: Dict with persona info (name, tagline, identity, etc.)

    Returns:
        Generated image prompt string
    """
    # Lazy, like shared.aws below: keeps this module's import graph narrow.
    from shared.converse import converse

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

    fallback_prompt = format_prompt(
        config.get('fallback_prompt_template', _DEFAULT_FALLBACK_PROMPT_TEMPLATE),
        occupation=occupation or 'professional',
    )
    try:
        prompt = converse(
            prompt=user_msg,
            system_prompt=system_prompt,
            max_tokens=config.get('max_tokens', 200),
            # The raw invoke this replaced sent no temperature; keep that rather
            # than imposing converse()'s 0.1 on a creative one-liner.
            temperature=None,
            surface=AVATAR_PROMPT_SURFACE,
            step_name='persona_avatar_prompt',
            # A one-line prompt: continuing a truncated one is not worth a call.
            max_continuations=0,
        ).strip()
    except Exception as e:
        logger.exception(f"[PERSONA_AVATAR] LLM prompt generation failed: {e}, using fallback")
        return fallback_prompt
    if not prompt:
        logger.warning("[PERSONA_AVATAR] LLM returned an empty image prompt, using fallback")
        return fallback_prompt
    return prompt


def avatars_enabled() -> bool:
    """False when the deployment switched avatars off (``AVATARS_ENABLED=false``).

    An EU deployment (``-c inferenceScope=eu``, docs/eu-deployment.md) sets it: the
    image model only runs in us-west-2, so avatars degrade to none rather than
    sending a persona description out of the EU. Anything but ``false`` (any case)
    keeps them on.
    """
    return os.environ.get('AVATARS_ENABLED', '').strip().lower() != 'false'


@tracer.capture_method
def generate_persona_avatar(
    persona_data: dict, s3_bucket: str | None = None, project_id: str | None = None,
) -> dict:
    """
    Generate an AI avatar image for a persona.

    Uses Claude to create an intelligent image prompt from persona data (name, bio, occupation),
    then the configured image model to generate the actual image.

    Args:
        persona_data: Dict with name, tagline, identity (bio, age_range, occupation, location), persona_id
        s3_bucket: Optional S3 bucket override, defaults to RAW_DATA_BUCKET env var
        project_id: The owning project, stamped on the object as
            AVATAR_OWNER_METADATA_KEY. Without it the object carries no owner and
            a project delete declines to remove it (the safe direction).

    Returns:
        dict with 'avatar_url' (S3 URI or None) and 'avatar_prompt' (the prompt used)
    """
    import base64

    persona_id = persona_data.get('persona_id', 'unknown')
    persona_name = persona_data.get('name', 'Unknown')

    if not avatars_enabled():
        # Before the prompt model call too: nothing is spent on an avatar that will not exist.
        logger.info("[PERSONA_AVATAR] Avatars disabled for this deployment (AVATARS_ENABLED=false); skipping")
        return {'avatar_url': None, 'avatar_prompt': None}

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
        s3_key = avatar_object_key(persona_id, image_data, image_format)

        logger.info(f"[PERSONA_AVATAR] Uploading avatar to S3: s3://{s3_bucket}/{s3_key}")

        # The shared accessor, not boto3.client('s3'), for two reasons that both arrived
        # with the concurrent avatar loop:
        #  1. This function now runs on several threads at once. boto3 clients are
        #     thread-safe to USE but building one is not (aws/boto3#1592) — the same
        #     hazard the region-pinned client above is cached to avoid. get_s3_client()
        #     is module-cached, so the construction happens once.
        #  2. It pins signature_version='s3v4', which RAW_DATA_BUCKET needs because it is
        #     KMS-encrypted. Constructing the client here inherited botocore's default
        #     signer instead.
        # Imported inside the function to keep this module's import graph narrow.
        from shared.aws import get_s3_client
        s3_client = get_s3_client()
        # Owner stamped by the same put that writes the bytes, so it cannot be
        # present on a half-failed upload. No key at all without a project (an
        # empty map writes no metadata), so "unowned" never reads as an owner.
        owner_metadata = {AVATAR_OWNER_METADATA_KEY: project_id} if project_id else {}
        s3_client.put_object(
            Bucket=s3_bucket,
            Key=s3_key,
            Body=image_data,
            # No jpg/jpeg special case needed: get_image_model_config() has already
            # constrained the format to _SUPPORTED_OUTPUT_FORMATS.
            ContentType=f"image/{image_format}",
            CacheControl='public, max-age=31536000, immutable',
            Metadata=owner_metadata,
        )
        # Earlier images are NOT removed here: the persona row still names one of
        # them until the caller saves this URL. A regeneration sweeps them after
        # its update (delete_superseded_avatars); a new persona has none.

        avatar_url = f"s3://{s3_bucket}/{s3_key}"
        logger.info(f"[PERSONA_AVATAR] SUCCESS - Avatar generated for {persona_name}: {avatar_url}")

    except Exception as e:
        error_type = type(e).__name__
        if 'AccessDenied' in error_type or 'AccessDenied' in str(e):
            # Two grants can cause this, and the second is the one a fresh account
            # hits (issue #274): a Marketplace-listed model (Stability) is invoked
            # only by a role that may also view/accept its subscription.
            logger.error(
                f"[PERSONA_AVATAR] ACCESS DENIED - Check the role's IAM policy grants "
                f"bedrock:InvokeModel on arn:aws:bedrock:{model_region}::foundation-model/{model_id} "
                "AND aws-marketplace:ViewSubscriptions + aws-marketplace:Subscribe "
                "(Marketplace models such as Stability need these on first use in an account)",
                extra={"error": str(e)},
                exc_info=True,
            )
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
                exc_info=True,
            )
        elif 'ValidationException' in error_type or 'ValidationException' in str(e):
            logger.error(
                f"[PERSONA_AVATAR] VALIDATION ERROR - Check the request format for {model_id}. "
                "Stability models take prompt/mode/aspect_ratio/output_format; a model "
                "from another vendor needs its own request body, not this one",
                extra={"error": str(e)},
                exc_info=True,
            )
        else:
            logger.error(f"[PERSONA_AVATAR] FAILED - Avatar generation error: {error_type}: {e}", extra={
                "persona_id": persona_id,
                "error_type": error_type,
                "error": str(e)
            }, exc_info=True)
        return {'avatar_url': None, 'avatar_prompt': avatar_prompt}
    else:
        return {'avatar_url': avatar_url, 'avatar_prompt': avatar_prompt}


def get_avatar_cdn_url(s3_uri: str | None, cdn_url: str | None = None) -> str | None:
    """Convert S3 URI to a SIGNED CloudFront CDN URL for avatar images.

    S3 URI format: s3://bucket/avatars/{persona_id}/{digest}.{ext}
    (legacy: s3://bucket/avatars/{persona_id}.{ext})
    CDN URL format: https://{cdn_domain}/avatars/{same path}?Expires=...
    The `/avatars/*` behavior maps 1:1 to the `avatars/` key prefix, so the URL
    path is the key below that prefix.

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
        # AVATARS_CDN_URL already ends in /avatars (the cache behavior's path
        # prefix maps 1:1 to the S3 key prefix), so the path is the key after
        # `avatars/`: `{persona_id}/{digest}.jpeg`, or a legacy `{persona_id}.jpeg`.
        # A URI outside that prefix keeps the old reading (its last segment).
        key = s3_uri.removeprefix('s3://').partition('/')[2]
        filename = (key.removeprefix(AVATAR_KEY_PREFIX) if key.startswith(AVATAR_KEY_PREFIX)
                    else s3_uri.split('/')[-1])

        # Lazy on purpose — see the note beside the imports at the top.
        from shared.cloudfront_signing import sign_url

        return sign_url(f"{avatars_cdn_url.rstrip('/')}/{filename}")
    except Exception as e:
        logger.exception(f"Failed to generate CDN URL for {s3_uri}: {e}")
        return None
