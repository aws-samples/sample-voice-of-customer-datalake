"""
Product/service description input — per-project context that feeds PRD/PR-FAQ generation.

Three pieces:
  1. ProductContext  — single mutable record per project (structured fields + free-form notes).
  2. ProductDoc      — internal documents uploaded by the user; extracted to text by an
                       S3-triggered extractor lambda (see lambda/product_doc_extractor).
  3. interview_turn  — one round of AI interview chat. The model uses a `update_product_context`
                       tool to patch the structured record; the assistant text is the user-facing
                       reply. Synchronous, returns {assistant_message, applied_patch} for simplicity.

`build_product_context_block(project_id) -> str` is consumed by projects.generate_prd /
generate_prfaq and substituted into the {product_context} placeholder.
"""
import os
import secrets
from datetime import datetime, timezone
from typing import Any

from boto3.dynamodb.conditions import Key

from shared.logging import logger, tracer
from shared.aws import get_dynamodb_resource, get_bedrock_client
from shared.model_config import get_active_model_id, omits_temperature
from shared.exceptions import (
    ConfigurationError, NotFoundError, ValidationError, ServiceError,
)
from shared.tables import get_projects_table


projects_table = get_projects_table()
dynamodb = get_dynamodb_resource()
s3 = None


def _s3():
    """
    Lazy S3 client. Forces SigV4 + the bucket's actual region:
    KMS-encrypted buckets reject SigV2 presigned URLs with HTTP 400
    ("Requests specifying Server Side Encryption with AWS KMS managed keys
    require AWS Signature Version 4."), and boto3's default signature in some
    legacy paths is SigV2. Specifying region_name also avoids the path-style
    redirect that breaks browser PUTs.
    """
    global s3
    if s3 is None:
        import boto3
        from botocore.config import Config
        s3 = boto3.client(
            's3',
            region_name=os.environ.get('AWS_REGION', 'us-east-1'),
            config=Config(signature_version='s3v4'),
        )
    return s3


# ── Schema ────────────────────────────────────────────────────────────────────

CONTEXT_SK = 'PRODUCT_CONTEXT'

# Free-text fields, each with a character cap. Lists were removed because they
# read as a file-list / upload control in the UI; comment-style textareas are
# clearer when the field is descriptive prose.
STRING_FIELDS = {
    'product_name': 200,
    'one_liner': 200,
    'target_users': 1000,
    'problem_solved': 2000,
    'key_features': 2000,
    'differentiators': 2000,
    'known_limitations': 2000,
    'non_goals': 2000,
    'success_metrics': 2000,
    'free_form_notes': 4000,
}

# Single-choice enum
LIFECYCLE_STATES = {'idea', 'mvp', 'beta', 'ga', 'mature'}

# (List fields removed — see note above.)
LIST_FIELDS: dict[str, tuple[int, int]] = {}

ALL_FIELDS = set(STRING_FIELDS) | set(LIST_FIELDS) | {'current_state'}

# Upload limits
MAX_FILE_BYTES = 10 * 1024 * 1024
MAX_DOCS_PER_PROJECT = 20
MAX_EXTRACTED_INJECTION_CHARS = 50_000
ALLOWED_CONTENT_TYPES = {
    'application/pdf': 'pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
    'text/markdown': 'md',
    'text/plain': 'txt',
}


def _empty_context() -> dict:
    """Default-empty context shape returned when no record exists yet."""
    out: dict[str, object] = {f: '' for f in STRING_FIELDS}
    out['current_state'] = ''
    for f in LIST_FIELDS:
        out[f] = []
    return out


def _coerce_legacy_list(value) -> str:
    """Convert legacy list-field DDB values (from the prior schema) to a string."""
    if isinstance(value, list):
        return '\n'.join(str(v) for v in value if v).strip()
    return value if isinstance(value, str) else ''


def _validate_patch(patch: dict) -> dict:
    """
    Validate + truncate a partial product-context update.
    Unknown keys are dropped silently (the LLM sometimes invents fields).
    Over-length strings are truncated; over-count lists are clipped.
    """
    if not isinstance(patch, dict):
        raise ValidationError('patch must be an object')

    clean: dict = {}
    for key, value in patch.items():
        if key not in ALL_FIELDS:
            continue

        if key == 'current_state':
            if value in LIFECYCLE_STATES:
                clean[key] = value
            continue

        if key in STRING_FIELDS:
            if value is None:
                clean[key] = ''
                continue
            if not isinstance(value, str):
                continue
            clean[key] = value[: STRING_FIELDS[key]]
            continue

        if key in LIST_FIELDS:
            max_items, max_len = LIST_FIELDS[key]
            if not isinstance(value, list):
                continue
            cleaned_items = []
            for item in value[:max_items]:
                if isinstance(item, str) and item.strip():
                    cleaned_items.append(item.strip()[:max_len])
            clean[key] = cleaned_items
            continue

    return clean


# ── ProductContext CRUD ──────────────────────────────────────────────────────

@tracer.capture_method
def get_context(project_id: str) -> dict:
    if not projects_table:
        raise ConfigurationError('Projects table not configured')

    resp = projects_table.get_item(
        Key={'pk': f'PROJECT#{project_id}', 'sk': CONTEXT_SK}
    )
    item = resp.get('Item')
    if not item:
        return {'context': _empty_context()}

    out = _empty_context()
    for k in ALL_FIELDS:
        if k not in item:
            continue
        # Coerce legacy list values written by the previous schema into newline-joined strings.
        if k in STRING_FIELDS and isinstance(item[k], list):
            out[k] = _coerce_legacy_list(item[k])
        else:
            out[k] = item[k]
    out['updated_at'] = item.get('updated_at')
    return {'context': out}


@tracer.capture_method
def update_context(project_id: str, body: dict) -> dict:
    """Apply a validated patch to the product context. Creates the record on first PUT."""
    if not projects_table:
        raise ConfigurationError('Projects table not configured')

    patch = _validate_patch(body or {})
    now = datetime.now(timezone.utc).isoformat()

    # Build UpdateExpression for whatever fields are present in the patch.
    # Always set updated_at; ensure base item exists with put_item if missing.
    resp = projects_table.get_item(
        Key={'pk': f'PROJECT#{project_id}', 'sk': CONTEXT_SK},
        ProjectionExpression='pk',
    )
    if not resp.get('Item'):
        base = {
            'pk': f'PROJECT#{project_id}',
            'sk': CONTEXT_SK,
            'created_at': now,
            'updated_at': now,
        }
        base.update(_empty_context())
        base.update(patch)
        projects_table.put_item(Item=base)
        return get_context(project_id)

    if not patch:
        # No-op patch; just bump updated_at so clients can detect activity.
        projects_table.update_item(
            Key={'pk': f'PROJECT#{project_id}', 'sk': CONTEXT_SK},
            UpdateExpression='SET updated_at = :now',
            ExpressionAttributeValues={':now': now},
        )
        return get_context(project_id)

    set_parts = ['updated_at = :now']
    expr_vals: dict[str, Any] = {':now': now}
    expr_names: dict[str, str] = {}
    for i, (key, value) in enumerate(patch.items()):
        # Use placeholders to avoid clashing with reserved words.
        placeholder = f':v{i}'
        name_alias = f'#k{i}'
        set_parts.append(f'{name_alias} = {placeholder}')
        expr_vals[placeholder] = value
        expr_names[name_alias] = key

    projects_table.update_item(
        Key={'pk': f'PROJECT#{project_id}', 'sk': CONTEXT_SK},
        UpdateExpression='SET ' + ', '.join(set_parts),
        ExpressionAttributeValues=expr_vals,
        ExpressionAttributeNames=expr_names,
    )
    return get_context(project_id)


# ── Interview chat (synchronous, single Bedrock turn with tool-use) ──────────

INTERVIEW_TOOL_NAME = 'update_product_context'


def _build_interview_tool() -> dict:
    """JSON-schema for the update tool the LLM calls during the interview.

    All fields are plain strings — comment-style, multi-line allowed. Each tool call
    REPLACES the field; if the user adds to existing content the model should send
    the merged value.
    """
    properties: dict = {k: {'type': 'string', 'maxLength': max_len}
                        for k, max_len in STRING_FIELDS.items()}
    properties['current_state'] = {
        'type': 'string',
        'enum': sorted(LIFECYCLE_STATES),
    }
    return {
        'toolSpec': {
            'name': INTERVIEW_TOOL_NAME,
            'description': (
                'Patch the structured product context with concrete information the '
                'user just shared. Only include fields you have new information for. '
                'Each field REPLACES the prior value — if the user is adding to an '
                'existing field, include the merged combined text in the patch.'
            ),
            'inputSchema': {
                'json': {
                    'type': 'object',
                    'properties': properties,
                    'additionalProperties': False,
                }
            },
        }
    }


def _format_context_for_prompt(ctx: dict) -> str:
    """Render the current context for the system prompt — only filled fields."""
    lines: list[str] = []
    for k in ('product_name', 'one_liner', 'current_state',
              'target_users', 'problem_solved',
              'key_features', 'differentiators', 'known_limitations',
              'non_goals', 'success_metrics', 'free_form_notes'):
        v = ctx.get(k)
        if not v:
            continue
        if isinstance(v, str) and len(v) > 500:
            v = v[:500] + '...'
        lines.append(f'{k}: {v}')
    return '\n'.join(lines) if lines else '(empty)'


@tracer.capture_method
def interview_turn(project_id: str, body: dict) -> dict:
    """
    One round of interview. Body: {message: str, history?: [{role, content}], response_language?: str}
    Returns: {assistant_message, applied_patch, context}
    """
    from shared.prompts import get_response_language_instruction

    message = (body or {}).get('message', '').strip()
    if not message:
        raise ValidationError('message is required')

    history = (body or {}).get('history') or []
    if not isinstance(history, list):
        history = []
    response_language = (body or {}).get('response_language')

    current_ctx = get_context(project_id)['context']

    base_instructions = (
        "You are interviewing the user about their product/service to fill a structured "
        "context record that downstream PRD and PR/FAQ generators will consume. "
        "Ask ONE focused question at a time, prioritizing fields that are still empty. "
        "When the user gives concrete information, you MUST call the "
        f"`{INTERVIEW_TOOL_NAME}` tool with a patch of just the fields you learned BEFORE "
        "writing your reply text. Don't invent — only patch fields with information the "
        "user actually provided. Each field REPLACES the prior value, so if the user is "
        "adding to an existing field include the merged combined text in the patch. After "
        "the tool call, briefly confirm what was captured and ask the next most useful question.\n\n"
        f"CURRENT CONTEXT:\n{_format_context_for_prompt(current_ctx)}\n\n"
        "Fields you can patch (all are free-text strings):\n"
        f"- product_name (≤{STRING_FIELDS['product_name']} chars)\n"
        f"- one_liner (≤{STRING_FIELDS['one_liner']} chars)\n"
        "- target_users, problem_solved (free text)\n"
        f"- current_state (one of: {sorted(LIFECYCLE_STATES)})\n"
        "- key_features, differentiators, known_limitations, non_goals, success_metrics (free text comments)\n"
        "- free_form_notes (anything that doesn't fit above)\n"
    )
    language_instruction = get_response_language_instruction(response_language)
    system_prompt = (f"{base_instructions}\n\n{language_instruction}".strip()
                     if language_instruction else base_instructions)

    # Build messages: prior history + new user turn.
    messages: list[dict] = []
    for m in history[-12:]:
        role = m.get('role')
        content = m.get('content', '')
        if role in ('user', 'assistant') and isinstance(content, str) and content.strip():
            messages.append({'role': role, 'content': [{'text': content}]})
    messages.append({'role': 'user', 'content': [{'text': message}]})

    client = get_bedrock_client()
    # Product-interview chat surface. Raw client call (tool use isn't wrapped by
    # the shared converse helper), so resolve the model and omit temperature for
    # models that reject it (Sonnet 5 / Opus 4.8) exactly as converse() does.
    model = get_active_model_id('chat')
    inference_config: dict = {'maxTokens': 1024}
    if not omits_temperature(model):
        inference_config['temperature'] = 0.3
    try:
        resp = client.converse(
            modelId=model,
            messages=messages,
            system=[{'text': system_prompt}],
            inferenceConfig=inference_config,
            toolConfig={'tools': [_build_interview_tool()]},
        )
    except Exception as e:
        logger.exception(f'Interview Bedrock call failed: {e}')
        raise ServiceError('AI interview unavailable. Please try again.')

    output_blocks = resp.get('output', {}).get('message', {}).get('content', [])

    assistant_text_parts: list[str] = []
    raw_patch: dict | None = None
    for block in output_blocks:
        if 'text' in block:
            assistant_text_parts.append(block['text'])
        elif 'toolUse' in block:
            tu = block['toolUse']
            if tu.get('name') == INTERVIEW_TOOL_NAME:
                raw_patch = tu.get('input') or {}

    applied: dict = {}
    if raw_patch is not None:
        cleaned = _validate_patch(raw_patch)
        if cleaned:
            update_context(project_id, cleaned)
            applied = cleaned

    assistant_message = '\n'.join(p for p in assistant_text_parts if p).strip()
    if not assistant_message:
        # Tool-only turn — return a stable code; the frontend localizes it.
        assistant_message = '__captured__' if applied else '__elaborate__'

    fresh_ctx = get_context(project_id)['context']
    return {
        'assistant_message': assistant_message,
        'applied_patch': applied,
        'context': fresh_ctx,
    }


# ── ProductDoc — uploads, listing, deletion ──────────────────────────────────

DOC_SK_PREFIX = 'PRODUCT_DOC#'


def _doc_pk(project_id: str) -> str:
    return f'PROJECT#{project_id}'


def _new_doc_id() -> str:
    # 16 hex chars; collision-free per project for our scale.
    return secrets.token_hex(8)


def _list_doc_items(project_id: str) -> list[dict]:
    if not projects_table:
        return []
    items: list[dict] = []
    last_evaluated = None
    while True:
        kwargs = dict(
            KeyConditionExpression=(
                Key('pk').eq(_doc_pk(project_id)) &
                Key('sk').begins_with(DOC_SK_PREFIX)
            )
        )
        if last_evaluated:
            kwargs['ExclusiveStartKey'] = last_evaluated
        resp = projects_table.query(**kwargs)
        items.extend(resp.get('Items', []))
        last_evaluated = resp.get('LastEvaluatedKey')
        if not last_evaluated:
            break
    return items


def _doc_to_dto(item: dict) -> dict:
    return {
        'doc_id': item.get('doc_id'),
        'filename': item.get('filename'),
        'content_type': item.get('content_type'),
        'size_bytes': int(item.get('size_bytes', 0)),
        'status': item.get('status', 'pending'),
        'error': item.get('error'),
        'extracted_chars': int(item.get('extracted_chars', 0)),
        'created_at': item.get('created_at'),
    }


@tracer.capture_method
def list_docs(project_id: str) -> dict:
    items = _list_doc_items(project_id)
    items.sort(key=lambda i: i.get('created_at', ''), reverse=True)
    return {'docs': [_doc_to_dto(i) for i in items]}


@tracer.capture_method
def create_upload_url(project_id: str, body: dict) -> dict:
    """
    Validate caps and content type, create a pending DDB record, return a presigned PUT URL.
    Frontend uploads the file directly to S3, which triggers the extractor lambda.
    """
    if not projects_table:
        raise ConfigurationError('Projects table not configured')

    bucket = os.environ.get('RAW_DATA_BUCKET')
    if not bucket:
        raise ConfigurationError('RAW_DATA_BUCKET not configured')

    filename = (body or {}).get('filename', '').strip()
    content_type = (body or {}).get('content_type', '').strip()
    size_bytes = int((body or {}).get('size_bytes') or 0)

    if not filename:
        raise ValidationError('filename is required')
    if content_type not in ALLOWED_CONTENT_TYPES:
        raise ValidationError(
            f'Unsupported file type. Allowed: {sorted(ALLOWED_CONTENT_TYPES)}'
        )
    if size_bytes <= 0 or size_bytes > MAX_FILE_BYTES:
        raise ValidationError(
            f'File size must be between 1 byte and {MAX_FILE_BYTES} bytes'
        )

    existing = _list_doc_items(project_id)
    if len(existing) >= MAX_DOCS_PER_PROJECT:
        raise ValidationError(
            f'Maximum {MAX_DOCS_PER_PROJECT} documents per project. Delete some first.'
        )

    doc_id = _new_doc_id()
    ext = ALLOWED_CONTENT_TYPES[content_type]
    s3_raw_key = f'projects/{project_id}/product_docs/raw/{doc_id}.{ext}'
    now = datetime.now(timezone.utc).isoformat()

    item = {
        'pk': _doc_pk(project_id),
        'sk': f'{DOC_SK_PREFIX}{doc_id}',
        'doc_id': doc_id,
        'filename': filename[:255],
        'content_type': content_type,
        'size_bytes': size_bytes,
        's3_raw_key': s3_raw_key,
        's3_extracted_key': None,
        'status': 'pending',
        'error': None,
        'extracted_chars': 0,
        'created_at': now,
    }
    projects_table.put_item(Item=item)

    presigned = _s3().generate_presigned_url(
        ClientMethod='put_object',
        Params={
            'Bucket': bucket,
            'Key': s3_raw_key,
            'ContentType': content_type,
        },
        ExpiresIn=600,
    )
    return {
        'doc_id': doc_id,
        'presigned_url': presigned,
        'headers': {'Content-Type': content_type},
    }


@tracer.capture_method
def delete_doc(project_id: str, doc_id: str) -> dict:
    if not projects_table:
        raise ConfigurationError('Projects table not configured')
    bucket = os.environ.get('RAW_DATA_BUCKET')

    resp = projects_table.get_item(
        Key={'pk': _doc_pk(project_id), 'sk': f'{DOC_SK_PREFIX}{doc_id}'}
    )
    item = resp.get('Item')
    if not item:
        raise NotFoundError('document not found')

    if bucket:
        for key in (item.get('s3_raw_key'), item.get('s3_extracted_key')):
            if key:
                try:
                    _s3().delete_object(Bucket=bucket, Key=key)
                except Exception as e:
                    logger.warning(f'Failed to delete s3://{bucket}/{key}: {e}')

    projects_table.delete_item(
        Key={'pk': _doc_pk(project_id), 'sk': f'{DOC_SK_PREFIX}{doc_id}'}
    )
    return {'success': True}


# ── PRD/PR-FAQ injection helper ──────────────────────────────────────────────

@tracer.capture_method
def generate_report(project_id: str, body: dict) -> dict:
    """
    Synthesize the structured product context + uploaded internal docs into a polished
    'Product/Service Description' report and persist it as a ProjectDocument that shows
    up in the Documents tab. The report is what other generators (PRD, PR/FAQ) implicitly
    reference, but having it as a saved doc lets the user read, edit, share, and export it.
    """
    from shared.converse import converse

    if not projects_table:
        raise ConfigurationError('Projects table not configured')

    response_language = (body or {}).get('response_language')
    title_override = ((body or {}).get('title') or '').strip()

    ctx = get_context(project_id)['context']
    has_any = any(ctx.get(k) for k in STRING_FIELDS) or ctx.get('current_state')
    if not has_any:
        # No documents either? then nothing to summarize.
        ready_docs = [d for d in _list_doc_items(project_id) if d.get('status') == 'ready']
        if not ready_docs:
            raise ValidationError(
                'Add at least one product context field or upload an internal document before generating a report.'
            )

    context_block = build_product_context_block(project_id)

    from shared.prompts import get_response_language_instruction
    language_instruction = get_response_language_instruction(response_language)

    system_prompt = (
        "You are a senior product manager writing a clear, concise Product/Service "
        "Description report. The report describes the CURRENT state of the product — "
        "not future features or aspirations. Use the structured input verbatim where "
        "possible; do not invent details that aren't in the input.\n\n"
        + (language_instruction or "")
    ).strip()

    user_prompt = (
        "Write a Product/Service Description report in well-structured Markdown using the input below.\n\n"
        "Required sections (omit a section only if the input has nothing for it):\n"
        "1. **Product overview** — name, one-liner, current state\n"
        "2. **Target users**\n"
        "3. **Problem it solves**\n"
        "4. **Key features**\n"
        "5. **Differentiators**\n"
        "6. **Known limitations**\n"
        "7. **Non-goals**\n"
        "8. **Success metrics**\n"
        "9. **Additional notes** (anything from internal documents that adds context)\n\n"
        "Keep the tone factual and specific. Don't include sections like \"future roadmap\" "
        "or \"go-to-market\" — those belong in PRD/PR-FAQ, not here.\n\n"
        f"INPUT:\n{context_block}"
    )

    try:
        content = converse(
            prompt=user_prompt,
            system_prompt=system_prompt,
            max_tokens=4000,
            temperature=0.2,
            surface='documents',
            step_name='product_report',
        )
    except Exception as e:
        logger.exception(f"Product report generation failed: {e}")
        raise ServiceError('Failed to generate report. Please try again.')

    now = datetime.now(timezone.utc).isoformat()
    report_id = f"product_report_{datetime.now().strftime('%Y%m%d%H%M%S')}"
    product_name = ctx.get('product_name') or 'Product'
    title = title_override or f"Product description: {product_name[:80]}"

    item = {
        'pk': f'PROJECT#{project_id}',
        'sk': f'PRODUCT_REPORT#{report_id}',
        'gsi1pk': f'PROJECT#{project_id}#DOCUMENTS',
        'gsi1sk': now,
        'document_id': report_id,
        'document_type': 'product_report',
        'title': title,
        'content': content,
        'created_at': now,
    }
    projects_table.put_item(Item=item)
    projects_table.update_item(
        Key={'pk': f'PROJECT#{project_id}', 'sk': 'META'},
        UpdateExpression='SET document_count = if_not_exists(document_count, :zero) + :one, updated_at = :now',
        ExpressionAttributeValues={':one': 1, ':zero': 0, ':now': now},
    )
    return {'success': True, 'document': item}


def build_product_context_block(project_id: str) -> str:
    """
    Build the {product_context} string that is injected into the PRD/PR-FAQ chains.
    Combines the structured context with the extracted text of READY uploaded docs,
    truncated to MAX_EXTRACTED_INJECTION_CHARS total.
    """
    ctx_resp = get_context(project_id)
    ctx = ctx_resp['context']

    sections: list[str] = []

    structured_lines: list[str] = []
    field_labels = (
        ('product_name', 'Product'),
        ('one_liner', 'One-liner'),
        ('current_state', 'Current state'),
        ('target_users', 'Target users'),
        ('problem_solved', 'Problem solved'),
        ('key_features', 'Key features'),
        ('differentiators', 'Differentiators'),
        ('known_limitations', 'Known limitations'),
        ('non_goals', 'Non-goals'),
        ('success_metrics', 'Success metrics'),
        ('free_form_notes', 'Notes'),
    )
    for key, label in field_labels:
        v = ctx.get(key)
        if not v:
            continue
        if isinstance(v, str) and '\n' in v:
            structured_lines.append(f"**{label}**:\n{v}")
        else:
            structured_lines.append(f"**{label}**: {v}")

    if structured_lines:
        sections.append("### Structured product context\n" + '\n\n'.join(structured_lines))

    bucket = os.environ.get('RAW_DATA_BUCKET')
    if bucket:
        ready = [d for d in _list_doc_items(project_id) if d.get('status') == 'ready' and d.get('s3_extracted_key')]
        ready.sort(key=lambda d: d.get('created_at', ''))
        budget = MAX_EXTRACTED_INJECTION_CHARS
        doc_blocks: list[str] = []
        skipped: list[str] = []
        for d in ready:
            if budget <= 0:
                skipped.append(d.get('filename', ''))
                continue
            try:
                obj = _s3().get_object(Bucket=bucket, Key=d['s3_extracted_key'])
                text = obj['Body'].read().decode('utf-8', errors='replace')
            except Exception as e:
                logger.warning(f'Failed reading extracted text for {d.get("doc_id")}: {e}')
                continue
            chunk = text[:budget]
            budget -= len(chunk)
            doc_blocks.append(f"#### {d.get('filename')}\n{chunk}")
        if doc_blocks:
            sections.append("### Internal documents\n\n" + '\n\n'.join(doc_blocks))
        if skipped:
            sections.append(
                "### Additional documents (not included due to size budget)\n- "
                + '\n- '.join(skipped)
            )

    if not sections:
        return "(No product context provided.)"
    return '\n\n'.join(sections)
