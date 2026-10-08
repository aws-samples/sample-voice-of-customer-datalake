"""
Persona Importer Job Lambda Handler

Imports personas from an image or pasted text using LLM extraction.

PDF is NOT handled: nothing in this repo extracts text from a PDF, so a PDF
import is refused (here and, first, at the API boundary in
api/projects_handler.py) rather than half-worked. The rules both layers enforce
live in shared/persona_import.py.
"""

import base64
import json
import os
from datetime import UTC, datetime

from api.projects import generate_persona_avatar
from shared.aws import get_bedrock_client, get_dynamodb_resource
from shared.converse import bedrock_call_with_retry
from shared.ids import timestamped_id
from shared.image_limits import converse_image_format
from shared.invocation_cost import instrumented_handler
from shared.jobs import JobContext, job_handler
from shared.logging import logger
from shared.model_config import get_active_model_id
from shared.persona_import import validate_import_config
from shared.project_writes import put_project_item_and_increment
from shared.prompts import PERSONA_IMPORT_PROMPTS, format_prompt, load_prompt_file

# Environment
PROJECTS_TABLE = os.environ.get('PROJECTS_TABLE', '')
RAW_DATA_BUCKET = os.environ.get('RAW_DATA_BUCKET', '')


@job_handler(error_message='Persona import failed')
def handle_job(ctx: JobContext, project_id: str, _job_id: str, import_config: dict) -> dict:
    """Handle async persona import job.

    Args:
        ctx: Job context for progress updates
        project_id: Project ID
        _job_id: Job ID (unused; part of the job_handler callback signature)
        import_config: Import configuration (input_type, content, media_type)

    Returns:
        Result dict with persona_id and title
    """
    dynamodb = get_dynamodb_resource()
    projects_table = dynamodb.Table(PROJECTS_TABLE)

    ctx.update_progress(10, 'extracting_persona')

    content = import_config.get('content')
    content = content if isinstance(content, str) else ''
    # No default: text never reads it, and for an image validate_import_config
    # refuses None and '' with the same message.
    media_type = import_config.get('media_type')

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

    # The prompt comes from `persona-import.json`, which carries the canonical key
    # set with example values that pin the TYPES (`"workarounds": ["Workaround 1"]`)
    # and enums (`low|medium|high`). It replaces a schema string built here whose
    # every section was the literal `{...}`, which named the sections and nothing
    # about their contents — so the model invented inner keys per document and
    # `.get(k, {})` below persisted whatever came back.
    #
    # The template needs no bundling change: `createJobLambdaCode` copies
    # `api/prompts` to the bundle root, so `get_prompts_dir()` resolves
    # `/var/task/prompts` first.
    prompt_config = load_prompt_file(PERSONA_IMPORT_PROMPTS)
    system_prompt = prompt_config['system_prompt']
    # Dumped from the template rather than restated here, so the schema the model
    # is shown cannot drift from the schema the file declares.
    json_schema = json.dumps(prompt_config['output_schema'], indent=2)
    user_prompts = prompt_config['user_prompts']

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
            'text': f"{user_prompts['image']}\n\nSchema:\n{json_schema}"
        })
    else:
        # `input_type` is 'text' here — the guard above left no other possibility,
        # so there is no fallback content to substitute and nothing to invent.
        #
        # The template's `pdf` prompt is deliberately NOT wired: `pdf` is in
        # `DEFERRED_INPUT_TYPES` and `validate_import_config` refuses it upstream,
        # so a branch for it here would be unreachable code advertising a
        # capability the product declines.
        converse_content.append({
            'text': f"{format_prompt(user_prompts['text'], content=content)}\n\nSchema:\n{json_schema}"
        })

    ctx.update_progress(30, 'calling_ai')

    bedrock = get_bedrock_client()
    # Persona import is a document-generation surface. Raw client call (image
    # input isn't supported by the text-only shared converse helper), so resolve
    # the model through the picker directly. No temperature is sent, so there's
    # nothing to omit for temperature-restricted models.
    model_id = get_active_model_id('documents')
    logger.info(f"[IMPORT_PERSONA_JOB] Invoking Bedrock with model {model_id}")
    # Through the shared retry policy, because this raw call does not go through
    # converse() and the shared client makes one botocore attempt by design (see
    # BEDROCK_READ_TIMEOUT_SECONDS): without it a single throttle would fail the
    # import job outright, and this surface is reached straight after an upload.
    response = bedrock_call_with_retry(
        lambda: bedrock.converse(
            modelId=model_id,
            system=[{'text': system_prompt}],
            messages=[{'role': 'user', 'content': converse_content}],
            # From the template too, so the budget lives beside the schema it has
            # to produce rather than as a literal here that nobody updates when
            # the schema grows.
            inferenceConfig={'maxTokens': prompt_config['max_tokens']}
        ),
        step_name='import_persona',
    )

    response_text = response.get('output', {}).get('message', {}).get('content', [{}])[0].get('text', '')  # pragma: no mutate - any non-JSON fallback fails json.loads below with the same 'Expecting value' message

    # Parse JSON
    json_text = response_text
    if '```json' in json_text:
        json_text = json_text.split('```json')[1].split('```')[0]
    elif '```' in json_text:
        # The piece between the first two fences cannot contain a fence, so no
        # second split is needed to drop the closing one.
        json_text = json_text.split('```')[1]

    persona_data = json.loads(json_text.strip())
    logger.info(f"[IMPORT_PERSONA_JOB] Extracted persona: {persona_data.get('name', 'Unknown')}")

    ctx.update_progress(60, 'generating_avatar')

    now_dt = datetime.now(UTC)
    now = now_dt.isoformat()
    # Collision-safe (shared/ids.py) but not retried: the avatar below is keyed
    # on this id before the row is written.
    persona_id = timestamped_id('persona', now_dt)

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
        # Attributability, matching what the generation path already records. An
        # imported persona previously carried no prompt version at all, so a row
        # with odd inner keys could not be traced to the prompt that produced it —
        # which is exactly the diagnosis this fix had to reconstruct by hand.
        'llm_metadata': {
            'model': model_id,
            'prompt_version': prompt_config['version'],
        },
        'created_at': now,
        'updated_at': now,
    }

    # Generate avatar. A copy, so what the generator was shown stays distinct from
    # the row the avatar fields are added to below. The project is stamped on the
    # object so a project delete removes only avatars it owns (flat key space).
    avatar_result = generate_persona_avatar(dict(item), RAW_DATA_BUCKET, project_id=project_id)
    if avatar_result.get('avatar_url'):
        item['avatar_url'] = avatar_result['avatar_url']
        item['avatar_prompt'] = avatar_result.get('avatar_prompt', '')

    ctx.update_progress(90, 'saving_persona')

    put_project_item_and_increment(
        projects_table, project_id, item, 'persona_count',
    )

    # Always set above (the model's name or the 'Imported Persona' default).
    persona_name = item['name']
    # No CDN-URL conversion here: `item` is not part of the return value below,
    # so the old conversion was dead. It also could not work now that avatar
    # URLs must be signed (issue #229) — this Lambda has no signing key. The
    # projects API signs at read time, which is the only place a browser gets
    # an avatar URL from.

    logger.info(f"[IMPORT_PERSONA_JOB] Successfully imported persona: {persona_name}")
    return {'persona_id': persona_id, 'title': f'Imported: {persona_name}'}


@instrumented_handler
def lambda_handler(event: dict, context) -> dict:
    """Lambda entry point."""
    logger.info(f"Persona importer invoked with event keys: {list(event.keys())}")
    return handle_job(event, context)
