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

# Shared module imports
from shared.logging import logger, tracer, metrics
from shared.aws import get_dynamodb_resource, get_sqs_client
from shared.api import create_api_resolver, api_handler, validate_limit

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
}

# Fields that can be updated via PUT
UPDATABLE_FIELDS = [
    'name', 'enabled', 'title', 'description', 'question', 'placeholder',
    'rating_enabled', 'rating_type', 'rating_max', 'submit_button_text',
    'success_message', 'theme', 'collect_email', 'collect_name',
    'custom_fields', 'category', 'subcategory'
]


def build_form_item(body: dict, form_id: str | None = None) -> dict:
    """Build DynamoDB item from request body with defaults."""
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
        'brand_name': item.get('brand_name', ''),
        'created_at': item.get('created_at', ''),
        'updated_at': item.get('updated_at', ''),
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
        return {'success': False, 'error': 'Failed to list forms', 'forms': []}


@app.post("/feedback-forms")
@tracer.capture_method
def create_form():
    """Create a new feedback form."""
    body = app.current_event.json_body or {}
    item = build_form_item(body)
    
    try:
        aggregates_table.put_item(Item=item)
        logger.info(f"Created feedback form: {item['form_id']}")
        return {'success': True, 'form': item_to_form(item)}
    except Exception as e:
        logger.error(f"Error creating form: {e}")
        return {'success': False, 'error': 'Failed to create form'}


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
            return {'success': False, 'error': 'Form not found'}
        
        return {'success': True, 'form': item_to_form(item)}
    except Exception as e:
        logger.error(f"Error getting form: {e}")
        return {'success': False, 'error': 'Failed to get form'}


@app.put("/feedback-forms/<form_id>")
@tracer.capture_method
def update_form(form_id: str):
    """Update a feedback form."""
    body = app.current_event.json_body or {}
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
        return {'success': False, 'error': 'No fields to update'}
    
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
        return {'success': False, 'error': 'Failed to update form'}


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
        return {'success': False, 'error': 'Failed to delete form'}


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
            return {'success': False, 'error': 'Form not found'}
        
        return {'success': True, 'config': item_to_form(item)}
    except Exception as e:
        logger.error(f"Error getting form config: {e}")
        return {'success': False, 'error': 'Failed to get form configuration'}


@app.post("/feedback-forms/<form_id>/submit")
@tracer.capture_method
def submit_form_feedback(form_id: str):
    """Submit feedback to a specific form."""
    body = app.current_event.json_body or {}
    
    text = body.get('text', '').strip()
    if not text:
        return {'success': False, 'error': 'Feedback text is required'}
    
    # Get form config
    try:
        response = aggregates_table.get_item(
            Key={'pk': 'FEEDBACK_FORM', 'sk': f'FORM#{form_id}'}
        )
        form = response.get('Item')
        
        if not form:
            return {'success': False, 'error': 'Form not found'}
        
        if not form.get('enabled', False):
            return {'success': False, 'error': 'This form is not enabled'}
    except Exception as e:
        logger.error(f"Error fetching form: {e}")
        return {'success': False, 'error': 'Failed to load form configuration'}
    
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
        'brand_name': BRAND_NAME,
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
        return {'success': False, 'error': 'Failed to submit feedback. Please try again.'}


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

def _get_form_source_pk(form_id: str) -> str:
    """Get the source pk for querying feedback by form."""
    try:
        form_response = aggregates_table.get_item(
            Key={'pk': 'FEEDBACK_FORM', 'sk': f'FORM#{form_id}'}
        )
        form = form_response.get('Item')
        form_brand_name = form.get('brand_name', '') if form else ''
    except Exception as e:
        logger.warning(f"Could not fetch form brand_name: {e}")
        form_brand_name = ''
    
    effective_brand = form_brand_name or BRAND_NAME
    return f"SOURCE#{effective_brand}" if effective_brand else 'SOURCE#feedback_form'


@app.get("/feedback-forms/<form_id>/submissions")
@tracer.capture_method
def get_form_submissions(form_id: str):
    """Get submissions for a specific form with stats."""
    params = app.current_event.query_string_parameters or {}
    limit = validate_limit(params.get('limit'), default=50, max_val=100)
    
    if not feedback_table:
        return {'success': False, 'error': 'Feedback table not configured'}
    
    # Verify form exists
    try:
        response = aggregates_table.get_item(
            Key={'pk': 'FEEDBACK_FORM', 'sk': f'FORM#{form_id}'}
        )
        if not response.get('Item'):
            return {'success': False, 'error': 'Form not found'}
    except Exception as e:
        logger.error(f"Error fetching form: {e}")
        return {'success': False, 'error': 'Failed to fetch form'}
    
    source_channel = f'form_{form_id}'
    source_pk = _get_form_source_pk(form_id)
    
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
    except Exception as e:
        logger.error(f"Error fetching submissions: {e}")
        return {'success': False, 'error': 'Failed to fetch submissions'}


@app.get("/feedback-forms/<form_id>/stats")
@tracer.capture_method
def get_form_stats(form_id: str):
    """Get quick stats for a form (lightweight endpoint for card display)."""
    if not feedback_table:
        return {'success': True, 'stats': {'total_submissions': 0, 'avg_rating': None}}
    
    source_channel = f'form_{form_id}'
    source_pk = _get_form_source_pk(form_id)
    
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
    except Exception as e:
        logger.error(f"Error fetching form stats: {e}")
        return {'success': True, 'stats': {'total_submissions': 0, 'avg_rating': None}}


# ============================================
# Lambda Handler
# ============================================

@api_handler
def lambda_handler(event: dict, context: Any) -> dict:
    """Main Lambda handler."""
    return app.resolve(event, context)
