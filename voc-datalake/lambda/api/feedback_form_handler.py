"""
VoC Feedback Form API Lambda
Handles: /feedback-forms/* - multiple forms management
"""
import json
import os
import uuid
from datetime import datetime, timezone
from typing import Any
from pathlib import Path

from aws_lambda_powertools.event_handler import Response

from boto3.dynamodb.conditions import Key
from botocore.exceptions import ClientError

# Shared module imports
from shared.logging import logger, tracer, metrics
from shared.aws import get_dynamodb_resource, get_sqs_client
from shared.api import create_api_resolver, api_handler, validate_limit
from shared.exceptions import (
    ApiError,
    ConfigurationError,
    ValidationError,
    NotFoundError,
    ServiceError,
)

# AWS Clients
dynamodb = get_dynamodb_resource()
sqs = get_sqs_client()

# Configuration
AGGREGATES_TABLE = os.environ.get('AGGREGATES_TABLE', '')
FEEDBACK_TABLE = os.environ.get('FEEDBACK_TABLE', '')
PROCESSING_QUEUE_URL = os.environ.get('PROCESSING_QUEUE_URL', '')
BRAND_NAME = os.environ.get('BRAND_NAME', '')

aggregates_table = dynamodb.Table(AGGREGATES_TABLE) if AGGREGATES_TABLE else None
feedback_table = dynamodb.Table(FEEDBACK_TABLE) if FEEDBACK_TABLE else None


# ============================================
# Form Configuration Schema & Defaults
# ============================================

DEFAULT_THEME = {
    'primary_color': '#3B82F6',
    'background_color': '#FFFFFF',
    'text_color': '#1F2937',
    'border_radius': '8px'
}

DEFAULT_FORM_CONFIG = {
    'name': 'New Feedback Form',
    'enabled': False,
    'title': 'Share Your Feedback',
    'description': 'We value your opinion.',
    'question': 'How was your experience?',
    'placeholder': 'Tell us about your experience...',
    'rating_enabled': True,
    'rating_type': 'stars',
    'rating_max': 5,
    'submit_button_text': 'Submit Feedback',
    'success_message': 'Thank you for your feedback!',
    'theme': DEFAULT_THEME,
    'collect_email': False,
    'collect_name': False,
    'custom_fields': [],
    'category': '',
    'subcategory': '',
    # Optional link to the artefact this form validates (issue: prioritization
    # evidence). Empty string means "validates nothing in particular" — the
    # standalone website-survey case, which must keep behaving exactly as it
    # did before these fields existed. `project_id` is the durable half of the
    # link: regenerating a document mints a new document_id, so readers match
    # on project first and treat document_id as a refinement.
    'project_id': '',
    'document_id': '',
}

# Fields that can be updated via PUT
#
# `brand_name` is deliberately absent, and that is a decision rather than an
# omission: it is the form's partition key input (see _form_source_pk), so
# editing it moves where this form's stats read looks WITHOUT moving the
# submissions already stored under the old value — the exact stranding this
# module's write/read agreement exists to prevent, only triggered by hand. A
# form's brand is therefore set once (build_form_item, or _anchor_form_brand for
# a record created without one) and then fixed for the life of the form. If a
# brand ever genuinely needs correcting, it needs a migration that rewrites the
# feedback records' partition too, not a PUT.
UPDATABLE_FIELDS = [
    'name', 'enabled', 'title', 'description', 'question', 'placeholder',
    'rating_enabled', 'rating_type', 'rating_max', 'submit_button_text',
    'success_message', 'theme', 'collect_email', 'collect_name',
    'custom_fields', 'category', 'subcategory', 'project_id', 'document_id'
]


# The link fields hold server-minted identifiers (`proj_20260101120000`,
# `prfaq_...`), so anything long is not one. A cap keeps a client from writing an
# arbitrarily large blob into an attribute the Prioritization page then reads
# back, and keeps the item within DynamoDB's 400 KB limit for reasons a caller
# cannot argue with.
LINK_FIELD_MAX_LENGTH = 128

# Fields whose value is an identifier the API mints, not free text the caller
# composes. Validated on the way in — see validate_link_fields.
LINK_FIELDS = ('project_id', 'document_id')


def validate_link_fields(body: dict) -> None:
    """Reject a malformed project_id / document_id before it is persisted.

    These two are the only writable fields whose values another surface later
    matches on (Prioritization pairs a form to a document by them), so a
    non-string — a dict, a list, a number — would be stored verbatim and then
    silently match nothing. Failing the request says so instead.

    Absent is always fine: the link is optional, and '' is how "validates
    nothing" is spelled.
    """
    for field in LINK_FIELDS:
        if field not in body:
            continue
        value = body[field]
        if not isinstance(value, str):
            raise ValidationError(f'{field} must be a string')
        if len(value) > LINK_FIELD_MAX_LENGTH:
            raise ValidationError(
                f'{field} must be at most {LINK_FIELD_MAX_LENGTH} characters'
            )


def _anchor_form_brand(form_id: str, effective_brand: str) -> None:
    """Pin a form with no stored brand to the brand its submissions are going to.

    build_form_item writes 'brand_name': BRAND_NAME, so a form created while
    BRAND_NAME was unset is stored with ''. For those records BOTH sides of the
    partition fall through to the live environment variable — the write's
    `form.get('brand_name') or BRAND_NAME` and _form_source_pk's identical
    fallback. They agree at any instant, so nothing looks wrong, but the
    agreement is only as stable as the environment: rename the deployment and
    every submission collected before the rename becomes unreachable to the
    form's own stats read. That is exactly the stranding the write-site fix was
    chosen to avoid.

    Writing the resolved brand back onto the form record removes the dependence
    on the environment for good: from here on both sides read a stored value the
    next deployment cannot move.

    Conditional so it is idempotent and can never overwrite a real brand — if a
    concurrent submission (or an admin edit) got there first, the condition fails
    and that value stands, which is the outcome we want either way. Best effort:
    the submission itself must not fail because the anchor did not stick, since
    the record being enqueued already carries the same brand.

    Writes updated_at as well, because brand_name is not an internal detail: it
    is published by item_to_form AND by the public item_to_widget_config, and
    every other write path here maintains updated_at (build_form_item sets it,
    update_form always appends it). A published field that changes with no trace
    of when is harder to explain later than the split this prevents.
    """
    try:
        aggregates_table.update_item(
            Key={'pk': 'FEEDBACK_FORM', 'sk': f'FORM#{form_id}'},
            UpdateExpression='SET brand_name = :brand, updated_at = :now',
            # attribute_exists(sk) leads, because UpdateItem is an UPSERT and
            # attribute_not_exists(brand_name) is SATISFIED by a missing item: a
            # form deleted between submit_form_feedback's get_item and this write
            # (a widget on a customer's site racing DELETE /feedback-forms/<id>)
            # would otherwise be written back as a bare {pk, sk, brand_name}
            # stub — a nameless row in list_forms whose own form_id is '', and a
            # deleted form answering 200 with total_submissions 0 again on the
            # very route this change made honest. Existence-first turns that into
            # a ConditionalCheckFailedException, i.e. nothing.
            #
            # The parentheses are load-bearing: `A AND B OR C` would let
            # brand_name = '' satisfy the condition on its own and reopen it.
            ConditionExpression=(
                'attribute_exists(sk) AND '
                '(attribute_not_exists(brand_name) OR brand_name = :empty)'
            ),
            ExpressionAttributeValues={
                ':brand': effective_brand,
                ':empty': '',
                ':now': datetime.now(timezone.utc).isoformat(),
            },
        )
        logger.info(f"Anchored form {form_id} to brand '{effective_brand}'")
    except Exception as e:  # noqa: BLE001 - see below; a submission outlives it
        # One handler, so there is exactly one place this can be logged from.
        # Deliberately blind: an anchor is a convenience for future reads, and no
        # failure of it — throttling, a denied grant, a bug in this function — is
        # worth dropping a customer's feedback for. The record already on its way
        # to the queue carries the same brand either way.
        if _is_conditional_check_failure(e):
            # The condition did its job: the form already carries a brand, or the
            # record no longer exists. The stored state wins; nothing to do.
            return
        logger.warning(f"Could not anchor brand_name for form {form_id}: {e}")


def _is_conditional_check_failure(error: Exception) -> bool:
    """Was this DynamoDB refusing a write because its condition did not hold?"""
    if not isinstance(error, ClientError):
        return False
    return (
        error.response.get('Error', {}).get('Code')
        == 'ConditionalCheckFailedException'
    )


def build_form_item(body: dict, form_id: str | None = None) -> dict:
    """Build DynamoDB item from request body with defaults.

    Validates the link fields here rather than leaving it to the caller: this is
    the only way a new record is constructed, so a future second caller cannot
    reach the table with an unvalidated link by forgetting a line.
    """
    validate_link_fields(body)
    now = datetime.now(timezone.utc).isoformat()
    fid = form_id or str(uuid.uuid4())[:8]
    
    item = {
        'pk': 'FEEDBACK_FORM',
        'sk': f'FORM#{fid}',
        'form_id': fid,
        'brand_name': BRAND_NAME,
        'created_at': now,
        'updated_at': now,
    }
    
    # Apply defaults, then override with provided values
    for field, default in DEFAULT_FORM_CONFIG.items():
        item[field] = body.get(field, default)
    
    return item


def item_to_form(item: dict) -> dict:
    """Convert DynamoDB item to form response."""
    return {
        'form_id': item.get('form_id', ''),
        'name': item.get('name', ''),
        'enabled': item.get('enabled', False),
        'title': item.get('title', ''),
        'description': item.get('description', ''),
        'question': item.get('question', ''),
        'placeholder': item.get('placeholder', ''),
        'rating_enabled': item.get('rating_enabled', True),
        'rating_type': item.get('rating_type', 'stars'),
        'rating_max': int(item.get('rating_max', 5)),
        'submit_button_text': item.get('submit_button_text', ''),
        'success_message': item.get('success_message', ''),
        'theme': item.get('theme', {}),
        'collect_email': item.get('collect_email', False),
        'collect_name': item.get('collect_name', False),
        'custom_fields': item.get('custom_fields', []),
        'category': item.get('category', ''),
        'subcategory': item.get('subcategory', ''),
        # Optional validation link — authenticated callers only. Deliberately
        # absent from item_to_widget_config below.
        'project_id': item.get('project_id', ''),
        'document_id': item.get('document_id', ''),
        'brand_name': item.get('brand_name', ''),
        'created_at': item.get('created_at', ''),
        'updated_at': item.get('updated_at', ''),
    }


def item_to_widget_config(item: dict) -> dict:
    """Convert DynamoDB item to the PUBLIC widget config response.

    Deliberately a separate, narrower projection from `item_to_form` rather
    than "item_to_form minus a few keys": `GET /feedback-forms/<id>/config` is
    unauthenticated and fetched by the widget from the customer's own website,
    so every field here is one someone chose to publish. Adding a field to
    `item_to_form` must not leak it; it has to be added here too, on purpose.

    Mirrors `FeedbackFormConfig` in frontend/src/api/types.ts — the rendering
    fields the widget reads plus `enabled` and `brand_name`.
    """
    return {
        'enabled': item.get('enabled', False),
        'title': item.get('title', ''),
        'description': item.get('description', ''),
        'question': item.get('question', ''),
        'placeholder': item.get('placeholder', ''),
        'rating_enabled': item.get('rating_enabled', True),
        'rating_type': item.get('rating_type', 'stars'),
        'rating_max': int(item.get('rating_max', 5)),
        'submit_button_text': item.get('submit_button_text', ''),
        'success_message': item.get('success_message', ''),
        'theme': item.get('theme', {}),
        'collect_email': item.get('collect_email', False),
        'collect_name': item.get('collect_name', False),
        'custom_fields': item.get('custom_fields', []),
        'brand_name': item.get('brand_name', ''),
    }


# ============================================
# Widget JavaScript Loader
# ============================================

_widget_js_cache: str | None = None


def get_widget_js() -> str:
    """Load widget JavaScript from static file (cached)."""
    global _widget_js_cache
    
    if _widget_js_cache is not None:
        return _widget_js_cache
    
    # Try to load from static file
    static_path = Path(__file__).parent / 'static' / 'feedback-widget.js'
    try:
        _widget_js_cache = static_path.read_text()
        return _widget_js_cache
    except FileNotFoundError:
        logger.warning(f"Widget JS not found at {static_path}, using fallback")
        _widget_js_cache = _get_fallback_widget_js()
        return _widget_js_cache


def _get_fallback_widget_js() -> str:
    """Minimal fallback if static file is missing."""
    return '''
(function() {
  window.VoCFeedbackForm = {
    init: function(options) {
      var container = document.querySelector(options.container);
      if (container) container.innerHTML = '<p style="color:#666;text-align:center;padding:40px;">Widget loading error.</p>';
    }
  };
})();
'''


# ============================================
# API Setup - Embeddable form allows any origin
# ============================================

# NOTE: This form is designed to be embedded on external websites, so it allows
# any origin by default. Set ALLOWED_ORIGIN env var to restrict if needed.
ALLOWED_ORIGIN = os.environ.get('ALLOWED_ORIGIN', '*')
app = create_api_resolver(ALLOWED_ORIGIN)


# ============================================
# Forms CRUD Endpoints
# ============================================

@app.get("/feedback-forms")
@tracer.capture_method
def list_forms():
    """List all feedback forms."""
    try:
        response = aggregates_table.query(
            KeyConditionExpression='pk = :pk',
            ExpressionAttributeValues={':pk': 'FEEDBACK_FORM'}
        )
        
        forms = [item_to_form(item) for item in response.get('Items', [])]
        forms.sort(key=lambda x: x.get('created_at', ''), reverse=True)
        
        return {'success': True, 'forms': forms}
    except Exception as e:
        logger.error(f"Error listing forms: {e}")
        raise ServiceError('Failed to list forms')


@app.post("/feedback-forms")
@tracer.capture_method
def create_form():
    """Create a new feedback form."""
    body = app.current_event.json_body or {}
    # Link fields are validated inside build_form_item, structurally.
    item = build_form_item(body)
    
    try:
        aggregates_table.put_item(Item=item)
        logger.info(f"Created feedback form: {item['form_id']}")
        return {'success': True, 'form': item_to_form(item)}
    except Exception as e:
        logger.error(f"Error creating form: {e}")
        raise ServiceError('Failed to create form')


@app.get("/feedback-forms/<form_id>")
@tracer.capture_method
def get_form(form_id: str):
    """Get a specific feedback form."""
    try:
        response = aggregates_table.get_item(
            Key={'pk': 'FEEDBACK_FORM', 'sk': f'FORM#{form_id}'}
        )
        item = response.get('Item')
        
        if not item:
            raise NotFoundError('Form not found')
        
        return {'success': True, 'form': item_to_form(item)}
    except NotFoundError:
        raise
    except Exception as e:
        logger.error(f"Error getting form: {e}")
        raise ServiceError('Failed to get form')


@app.put("/feedback-forms/<form_id>")
@tracer.capture_method
def update_form(form_id: str):
    """Update a feedback form."""
    body = app.current_event.json_body or {}
    validate_link_fields(body)
    now = datetime.now(timezone.utc).isoformat()
    
    # Build update expression dynamically
    update_parts = []
    expr_names = {'#updated_at': 'updated_at'}
    expr_values = {':updated_at': now}
    
    for field in UPDATABLE_FIELDS:
        if field in body:
            update_parts.append(f'#{field} = :{field}')
            expr_names[f'#{field}'] = field
            expr_values[f':{field}'] = body[field]
    
    if not update_parts:
        raise ValidationError('No fields to update')
    
    update_parts.append('#updated_at = :updated_at')
    
    try:
        response = aggregates_table.update_item(
            Key={'pk': 'FEEDBACK_FORM', 'sk': f'FORM#{form_id}'},
            UpdateExpression='SET ' + ', '.join(update_parts),
            ExpressionAttributeNames=expr_names,
            ExpressionAttributeValues=expr_values,
            ReturnValues='ALL_NEW'
        )
        
        return {'success': True, 'form': item_to_form(response.get('Attributes', {}))}
    except Exception as e:
        logger.error(f"Error updating form: {e}")
        raise ServiceError('Failed to update form')


@app.delete("/feedback-forms/<form_id>")
@tracer.capture_method
def delete_form(form_id: str):
    """Delete a feedback form."""
    try:
        aggregates_table.delete_item(
            Key={'pk': 'FEEDBACK_FORM', 'sk': f'FORM#{form_id}'}
        )
        logger.info(f"Deleted feedback form: {form_id}")
        return {'success': True}
    except Exception as e:
        logger.error(f"Error deleting form: {e}")
        raise ServiceError('Failed to delete form')


# ============================================
# Form Widget Endpoints (Public)
# ============================================

@app.get("/feedback-forms/<form_id>/config")
@tracer.capture_method
def get_form_config_by_id(form_id: str):
    """Get form config for widget (public endpoint)."""
    try:
        response = aggregates_table.get_item(
            Key={'pk': 'FEEDBACK_FORM', 'sk': f'FORM#{form_id}'}
        )
        item = response.get('Item')
        
        if not item:
            raise NotFoundError('Form not found')

        # Narrower projection than item_to_form on purpose: this route is public.
        return {'success': True, 'config': item_to_widget_config(item)}
    except NotFoundError:
        raise
    except Exception as e:
        logger.error(f"Error getting form config: {e}")
        raise ServiceError('Failed to get form configuration')


@app.post("/feedback-forms/<form_id>/submit")
@tracer.capture_method
def submit_form_feedback(form_id: str):
    """Submit feedback to a specific form."""
    body = app.current_event.json_body or {}
    
    text = body.get('text', '').strip()
    if not text:
        raise ValidationError('Feedback text is required')
    
    # Get form config
    try:
        response = aggregates_table.get_item(
            Key={'pk': 'FEEDBACK_FORM', 'sk': f'FORM#{form_id}'}
        )
        form = response.get('Item')
        
        if not form:
            raise NotFoundError('Form not found')
        
        if not form.get('enabled', False):
            raise ValidationError('This form is not enabled')
    except (NotFoundError, ValidationError):
        raise
    except Exception as e:
        logger.error(f"Error fetching form: {e}")
        raise ServiceError('Failed to load form configuration')
    
    # The FORM's brand, not the deployment's: the stats read builds its partition
    # from the form's stored brand_name (_form_source_pk), so stamping BRAND_NAME
    # here would split a form's submissions across two partitions the day the
    # deployment is renamed. `or` rather than a get() default because a stored ''
    # must take the fallback too — that is how the read side treats it.
    #
    # The trade-off, stated because it is chosen rather than incidental: after a
    # rename, a pre-rename form keeps writing under its OLD brand, so its
    # submissions carry a brand the deployment no longer uses. That is deliberate
    # — the alternative strands every submission the form already collected. It
    # costs nothing in the read paths as they stand: the processor derives the
    # pk from this value (source_display = brand_name or source_platform), and
    # every other reader is scoped by source_platform, not by brand —
    # metrics_handler queries the DATE# GSI filtering source_platform, and
    # data_explorer_handler builds SOURCE#<source_platform>. No aggregate is
    # scoped by BRAND_NAME, so there is nothing for a pre-rename form to fall out
    # of. A future brand-scoped view would have to reckon with this and should
    # read the form's brand rather than the environment's.
    effective_brand = form.get('brand_name') or BRAND_NAME
    if not form.get('brand_name') and effective_brand:
        # Store it, so this form stops depending on the environment variable —
        # see _anchor_form_brand.
        _anchor_form_brand(form_id, effective_brand)

    now = datetime.now(timezone.utc)
    feedback_id = str(uuid.uuid4())

    # Build normalized record with category routing
    metadata = {
        'form_id': form_id,
        'form_name': form.get('name', ''),
        'form_version': '2.0',
    }
    if form.get('collect_email') and body.get('email'):
        metadata['submitter_email'] = body['email']
    if form.get('collect_name') and body.get('name'):
        metadata['submitter_name'] = body['name']
    if body.get('custom_fields'):
        metadata['custom_fields'] = body['custom_fields']
    
    normalized_record = {
        'id': feedback_id,
        'source_platform': 'feedback_form',
        'source_channel': f'form_{form_id}',
        'text': text,
        'rating': body.get('rating'),
        'created_at': now.isoformat(),
        'ingested_at': now.isoformat(),
        # Resolved above, from the form record already loaded for the enabled
        # check: the form's own brand, so this submission lands in the partition
        # _form_source_pk queries for the whole life of the form.
        'brand_name': effective_brand,
        'url': body.get('page_url'),
        'preset_category': form.get('category', ''),
        'preset_subcategory': form.get('subcategory', ''),
        'metadata': metadata,
    }
    
    try:
        sqs.send_message(
            QueueUrl=PROCESSING_QUEUE_URL,
            MessageBody=json.dumps(normalized_record, default=str)
        )
        logger.info(f"Submitted feedback to form {form_id}: {feedback_id}")
        return {
            'success': True,
            'feedback_id': feedback_id,
            'message': form.get('success_message', 'Thank you for your feedback!')
        }
    except Exception as e:
        logger.error(f"Error submitting feedback: {e}")
        raise ServiceError('Failed to submit feedback. Please try again.')


@app.get("/feedback-forms/<form_id>/iframe")
@tracer.capture_method
def get_form_iframe(form_id: str):
    """Serve HTML page for form-specific iframe embedding."""
    host = app.current_event.request_context.get('domainName', '')
    stage = app.current_event.request_context.get('stage', 'v1')
    api_endpoint = f"https://{host}/{stage}" if host else ''
    
    html = f'''<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Feedback Form</title>
  <style>
    * {{ margin: 0; padding: 0; box-sizing: border-box; }}
    body {{ font-family: system-ui, -apple-system, sans-serif; min-height: 100vh; }}
    #voc-feedback-form {{ min-height: 100vh; }}
  </style>
</head>
<body>
  <div id="voc-feedback-form"></div>
  <script>
  {get_widget_js()}
  VoCFeedbackForm.init({{
    container: '#voc-feedback-form',
    apiEndpoint: '{api_endpoint}',
    formId: '{form_id}',
    configEndpoint: '/feedback-forms/{form_id}/config',
    submitEndpoint: '/feedback-forms/{form_id}/submit'
  }});
  </script>
</body>
</html>'''
    
    return Response(status_code=200, content_type="text/html", body=html)


# ============================================
# Form Stats & Submissions
# ============================================

def _form_source_pk(form: dict) -> str:
    """The feedback partition this form's submissions live in.

    Pure: derived from the form record the caller already holds, never from a
    read of its own. A partition GUESSED from a failed form read is the whole
    problem — it resolves to BRAND_NAME, which after a rename is a partition the
    form's submissions were never written to, so the query finds nothing and the
    route reports 0 submissions for a form that has them (issue #312's false zero
    arriving by another door). Callers get the record from _load_form_for_query,
    which fails loudly instead.

    Mirrors submit_form_feedback's write side: the form's own brand, the
    deployment's only for a form recorded without one, and `or` rather than a
    get() default so a stored '' takes the fallback on both sides alike.
    """
    effective_brand = form.get('brand_name') or BRAND_NAME
    return f"SOURCE#{effective_brand}" if effective_brand else 'SOURCE#feedback_form'


def _load_form_for_query(form_id: str, read_failure_message: str) -> dict:
    """Load a form record for a stats/submissions query, failing loudly.

    One get_item answers both questions those routes need, so neither has to be
    guessed:

    - Does this form exist? A form id that was deleted (or never existed) must be
      a 404, not a 200 with a measured-looking 0 — LinkedFormEvidence renders
      that zero as evidence against a work item and has an `evidence.unavailable`
      branch waiting for the error.
    - Which feedback partition are its submissions in? See _form_source_pk: a
      degraded fallback here queries the wrong partition after a brand rename.

    Both failure modes previously produced HTTP 200 with total_submissions: 0 on
    the stats route, which is the exact defect issue #312 is about.
    """
    try:
        response = aggregates_table.get_item(
            Key={'pk': 'FEEDBACK_FORM', 'sk': f'FORM#{form_id}'}
        )
    except Exception as e:
        # Surfaced as a metric because this failure used to be invisible: it was
        # reported to the caller as a zero count and to operations as nothing.
        metrics.add_metric(name='FeedbackFormReadFailed', unit='Count', value=1)
        logger.error(f"Error fetching form {form_id}: {e}")
        raise ServiceError(read_failure_message) from e

    form = response.get('Item')
    if not form:
        raise NotFoundError('Form not found')
    return form


@app.get("/feedback-forms/<form_id>/submissions")
@tracer.capture_method
def get_form_submissions(form_id: str):
    """Get submissions for a specific form with stats."""
    params = app.current_event.query_string_parameters or {}
    limit = validate_limit(params.get('limit'), default=50, max_val=100)
    
    if not feedback_table:
        raise ConfigurationError('Feedback table not configured')

    # One read answers both the 404 and the partition, where this route used to
    # do its own existence check and then have _get_form_source_pk re-read the
    # same record (and swallow a failure of it).
    form = _load_form_for_query(form_id, 'Failed to fetch form')

    source_channel = f'form_{form_id}'
    source_pk = _form_source_pk(form)

    try:
        items = []
        total_rating = 0
        rating_count = 0
        
        query_kwargs = {
            'KeyConditionExpression': Key('pk').eq(source_pk),
            'FilterExpression': 'source_channel = :sc',
            'ExpressionAttributeValues': {':sc': source_channel},
            'ScanIndexForward': False,
        }
        
        while len(items) < limit:
            response = feedback_table.query(**query_kwargs)
            
            for item in response.get('Items', []):
                items.append({
                    'feedback_id': item.get('feedback_id', ''),
                    'original_text': item.get('original_text', ''),
                    'rating': float(item.get('rating')) if item.get('rating') else None,
                    'sentiment_label': item.get('sentiment_label', ''),
                    'sentiment_score': float(item.get('sentiment_score', 0)),
                    'category': item.get('category', ''),
                    'created_at': item.get('source_created_at', ''),
                    'persona_name': item.get('persona_name', ''),
                })
                
                if item.get('rating'):
                    total_rating += float(item.get('rating'))
                    rating_count += 1
            
            if 'LastEvaluatedKey' not in response:
                break
            query_kwargs['ExclusiveStartKey'] = response['LastEvaluatedKey']
        
        avg_rating = round(total_rating / rating_count, 2) if rating_count > 0 else None
        
        return {
            'success': True,
            'form_id': form_id,
            'stats': {
                'total_submissions': len(items),
                'avg_rating': avg_rating,
                'rating_count': rating_count,
            },
            'submissions': items[:limit]
        }
    except ApiError:
        # Precautionary, not currently reachable: the only typed raise on this
        # route (_load_form_for_query) happens ABOVE the try, and nothing inside
        # it raises an ApiError today. It is here so that when something in this
        # block eventually does — a validation of a page of items, a helper that
        # 404s — its status survives instead of being flattened to a 500 by the
        # handler below. Pinned by a test that raises a typed exception from
        # feedback_table.query; without this clause that test gets a 500.
        raise
    except Exception as e:
        logger.error(f"Error fetching submissions: {e}")
        raise ServiceError('Failed to fetch submissions') from e


@app.get("/feedback-forms/<form_id>/stats")
@tracer.capture_method
def get_form_stats(form_id: str):
    """Get quick stats for a form (lightweight endpoint for card display).

    Fails loudly, like get_form_submissions above. The count this returns is
    rendered next to a prioritization score, so "0 submissions" is a claim about
    the product, not a placeholder: a read that could not be completed must not
    be reported as a form nobody answered.

    That applies to EVERY read this route makes, not just the feedback query: an
    unconfigured table, a failed form lookup, a form that no longer exists and a
    failed feedback query all used to arrive as total_submissions: 0.
    """
    if not feedback_table:
        raise ConfigurationError('Feedback table not configured')

    # 404 for a deleted form, and the partition its submissions are in, from the
    # one read — never a partition guessed from a read that failed.
    form = _load_form_for_query(form_id, 'Failed to fetch form stats')

    source_channel = f'form_{form_id}'
    source_pk = _form_source_pk(form)

    try:
        total_rating = 0
        rating_count = 0
        submission_count = 0
        
        query_kwargs = {
            'KeyConditionExpression': Key('pk').eq(source_pk),
            'FilterExpression': 'source_channel = :sc',
            'ExpressionAttributeValues': {':sc': source_channel},
            'ProjectionExpression': 'feedback_id, rating',
        }
        
        while True:
            response = feedback_table.query(**query_kwargs)
            
            for item in response.get('Items', []):
                submission_count += 1
                if item.get('rating'):
                    total_rating += float(item.get('rating'))
                    rating_count += 1
            
            if 'LastEvaluatedKey' not in response:
                break
            query_kwargs['ExclusiveStartKey'] = response['LastEvaluatedKey']
        
        avg_rating = round(total_rating / rating_count, 2) if rating_count > 0 else None
        
        return {
            'success': True,
            'form_id': form_id,
            'stats': {
                'total_submissions': submission_count,
                'avg_rating': avg_rating,
                'rating_count': rating_count,
            }
        }
    except ApiError:
        # See get_form_submissions: precautionary. No statement in this block
        # raises a typed exception today (the form load, which does, is above the
        # try), but a future one would otherwise be reported as a server fault —
        # and would take the FeedbackFormStatsReadFailed metric with it, which is
        # meant to count read failures rather than every 4xx-shaped cause.
        raise
    except Exception as e:
        # This read failure was previously reported as a zero count and so was
        # invisible in dashboards; the metric is what makes it observable.
        metrics.add_metric(name='FeedbackFormStatsReadFailed', unit='Count', value=1)
        logger.error(f"Error fetching form stats: {e}")
        raise ServiceError('Failed to fetch form stats') from e


# ============================================
# Lambda Handler
# ============================================

@api_handler
def lambda_handler(event: dict, context: Any) -> dict:
    """Main Lambda handler."""
    return app.resolve(event, context)
