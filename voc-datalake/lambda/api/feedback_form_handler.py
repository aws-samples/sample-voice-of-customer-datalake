"""
VoC Feedback Form API Lambda
Handles: /feedback-form/* - legacy single form
Handles: /feedback-forms/* - multiple forms management
"""
import json
import os
import uuid
from datetime import datetime, timezone
from decimal import Decimal
from typing import Any
from aws_lambda_powertools.event_handler import APIGatewayRestResolver, CORSConfig, Response

# Shared module imports
from shared.logging import logger, tracer, metrics
from shared.aws import get_dynamodb_resource, get_sqs_client

from boto3.dynamodb.conditions import Key

# AWS Clients (using shared module for connection reuse)
dynamodb = get_dynamodb_resource()
sqs = get_sqs_client()

# Configuration
AGGREGATES_TABLE = os.environ.get('AGGREGATES_TABLE', '')
FEEDBACK_TABLE = os.environ.get('FEEDBACK_TABLE', '')
PROCESSING_QUEUE_URL = os.environ.get('PROCESSING_QUEUE_URL', '')
BRAND_NAME = os.environ.get('BRAND_NAME', '')

aggregates_table = dynamodb.Table(AGGREGATES_TABLE) if AGGREGATES_TABLE else None
feedback_table = dynamodb.Table(FEEDBACK_TABLE) if FEEDBACK_TABLE else None

# CORS config for embeddable feedback form
# NOTE: This form is designed to be embedded on external websites, so it allows
# any origin by default. Set ALLOWED_ORIGIN env var to restrict if needed.
# For the main dashboard API handlers, CORS is restricted to the CloudFront domain.
ALLOWED_ORIGIN = os.environ.get('ALLOWED_ORIGIN', '*')
cors_config = CORSConfig(
    allow_origin=ALLOWED_ORIGIN,
    allow_headers=["Content-Type", "Authorization", "X-Requested-With"],
    expose_headers=["Content-Type"],
    max_age=300,
    allow_credentials=False
)

app = APIGatewayRestResolver(cors=cors_config, enable_validation=True)


# ============================================
# Legacy Single Form Endpoints (backward compat)
# ============================================

@app.get("/feedback-form/config")
@tracer.capture_method
def get_form_config():
    """Get feedback form configuration (legacy single form)."""
    try:
        response = aggregates_table.get_item(
            Key={'pk': 'SETTINGS#feedback_form', 'sk': 'config'}
        )
        item = response.get('Item', {})
        
        return {
            'success': True,
            'config': {
                'enabled': item.get('enabled', False),
                'title': item.get('title', 'Share Your Feedback'),
                'description': item.get('description', 'We value your opinion.'),
                'question': item.get('question', 'How was your experience?'),
                'placeholder': item.get('placeholder', 'Tell us about your experience...'),
                'rating_enabled': item.get('rating_enabled', True),
                'rating_type': item.get('rating_type', 'stars'),
                'rating_max': item.get('rating_max', 5),
                'submit_button_text': item.get('submit_button_text', 'Submit Feedback'),
                'success_message': item.get('success_message', 'Thank you for your feedback!'),
                'theme': item.get('theme', {
                    'primary_color': '#3B82F6',
                    'background_color': '#FFFFFF',
                    'text_color': '#1F2937',
                    'border_radius': '8px'
                }),
                'collect_email': item.get('collect_email', False),
                'collect_name': item.get('collect_name', False),
                'custom_fields': item.get('custom_fields', []),
                'brand_name': item.get('brand_name', BRAND_NAME),
            }
        }
    except Exception as e:
        logger.error(f"Error fetching form config: {e}")
        return {'success': False, 'error': 'Failed to load form configuration'}


@app.put("/feedback-form/config")
@tracer.capture_method
def save_form_config():
    """Save feedback form configuration (legacy single form)."""
    body = app.current_event.json_body or {}
    now = datetime.now(timezone.utc).isoformat()
    
    item = {
        'pk': 'SETTINGS#feedback_form',
        'sk': 'config',
        'enabled': body.get('enabled', False),
        'title': body.get('title', 'Share Your Feedback'),
        'description': body.get('description', ''),
        'question': body.get('question', 'How was your experience?'),
        'placeholder': body.get('placeholder', 'Tell us about your experience...'),
        'rating_enabled': body.get('rating_enabled', True),
        'rating_type': body.get('rating_type', 'stars'),
        'rating_max': body.get('rating_max', 5),
        'submit_button_text': body.get('submit_button_text', 'Submit Feedback'),
        'success_message': body.get('success_message', 'Thank you for your feedback!'),
        'theme': body.get('theme', {}),
        'collect_email': body.get('collect_email', False),
        'collect_name': body.get('collect_name', False),
        'custom_fields': body.get('custom_fields', []),
        'brand_name': body.get('brand_name', BRAND_NAME),
        'updated_at': now,
    }
    
    try:
        aggregates_table.put_item(Item=item)
        return {'success': True, 'message': 'Form configuration saved'}
    except Exception as e:
        logger.error(f"Error saving form config: {e}")
        return {'success': False, 'error': 'Failed to save form configuration'}


@app.post("/feedback-form/submit")
@tracer.capture_method
def submit_feedback():
    """Submit feedback from the legacy embeddable form."""
    body = app.current_event.json_body or {}
    
    text = body.get('text', '').strip()
    if not text:
        return {'success': False, 'error': 'Feedback text is required'}
    
    try:
        config_response = aggregates_table.get_item(
            Key={'pk': 'SETTINGS#feedback_form', 'sk': 'config'}
        )
        config = config_response.get('Item', {})
        
        if not config.get('enabled', False):
            return {'success': False, 'error': 'Feedback form is not enabled'}
    except Exception as e:
        logger.warning(f"Could not fetch form config: {e}")
        config = {}
    
    now = datetime.now(timezone.utc)
    feedback_id = str(uuid.uuid4())
    
    normalized_record = {
        'id': feedback_id,
        'source_platform': 'feedback_form',
        'source_channel': body.get('source_channel', 'web_form'),
        'text': text,
        'rating': body.get('rating'),
        'created_at': now.isoformat(),
        'ingested_at': now.isoformat(),
        'brand_name': config.get('brand_name', BRAND_NAME),
        'url': body.get('page_url'),
        'metadata': {
            'form_version': '1.0',
            'submitter_email': body.get('email') if config.get('collect_email') else None,
            'submitter_name': body.get('name') if config.get('collect_name') else None,
            'custom_fields': body.get('custom_fields', {}),
        }
    }
    normalized_record['metadata'] = {k: v for k, v in normalized_record['metadata'].items() if v is not None}
    
    try:
        sqs.send_message(
            QueueUrl=PROCESSING_QUEUE_URL,
            MessageBody=json.dumps(normalized_record, default=str)
        )
        logger.info(f"Submitted feedback form: {feedback_id}")
        return {
            'success': True,
            'feedback_id': feedback_id,
            'message': config.get('success_message', 'Thank you for your feedback!')
        }
    except Exception as e:
        logger.error(f"Error submitting feedback: {e}")
        return {'success': False, 'error': 'Failed to submit feedback. Please try again.'}


@app.get("/feedback-form/iframe")
@tracer.capture_method
def get_iframe_page():
    """Serve HTML page for legacy iframe embedding."""
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
    configEndpoint: '/feedback-form/config',
    submitEndpoint: '/feedback-form/submit'
  }});
  </script>
</body>
</html>'''
    
    return Response(status_code=200, content_type="text/html", body=html)


# ============================================
# Multiple Forms Management Endpoints
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
        
        forms = []
        for item in response.get('Items', []):
            forms.append(_item_to_form(item))
        
        # Sort by created_at descending
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
    
    form_id = str(uuid.uuid4())[:8]  # Short ID for URLs
    now = datetime.now(timezone.utc).isoformat()
    
    item = {
        'pk': 'FEEDBACK_FORM',
        'sk': f'FORM#{form_id}',
        'form_id': form_id,
        'name': body.get('name', 'New Feedback Form'),
        'enabled': body.get('enabled', False),
        'title': body.get('title', 'Share Your Feedback'),
        'description': body.get('description', 'We value your opinion.'),
        'question': body.get('question', 'How was your experience?'),
        'placeholder': body.get('placeholder', 'Tell us about your experience...'),
        'rating_enabled': body.get('rating_enabled', True),
        'rating_type': body.get('rating_type', 'stars'),
        'rating_max': body.get('rating_max', 5),
        'submit_button_text': body.get('submit_button_text', 'Submit Feedback'),
        'success_message': body.get('success_message', 'Thank you for your feedback!'),
        'theme': body.get('theme', {
            'primary_color': '#3B82F6',
            'background_color': '#FFFFFF',
            'text_color': '#1F2937',
            'border_radius': '8px'
        }),
        'collect_email': body.get('collect_email', False),
        'collect_name': body.get('collect_name', False),
        'custom_fields': body.get('custom_fields', []),
        'category': body.get('category', ''),
        'subcategory': body.get('subcategory', ''),
        # Store brand_name at creation time for consistent querying
        'brand_name': BRAND_NAME,
        'created_at': now,
        'updated_at': now,
    }
    
    try:
        aggregates_table.put_item(Item=item)
        logger.info(f"Created feedback form: {form_id}")
        return {'success': True, 'form': _item_to_form(item)}
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
        
        return {'success': True, 'form': _item_to_form(item)}
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
    expr_names = {}
    expr_values = {':updated_at': now}
    
    updatable_fields = [
        'name', 'enabled', 'title', 'description', 'question', 'placeholder',
        'rating_enabled', 'rating_type', 'rating_max', 'submit_button_text',
        'success_message', 'theme', 'collect_email', 'collect_name',
        'custom_fields', 'category', 'subcategory'
    ]
    
    for field in updatable_fields:
        if field in body:
            update_parts.append(f'#{field} = :{field}')
            expr_names[f'#{field}'] = field
            expr_values[f':{field}'] = body[field]
    
    if not update_parts:
        return {'success': False, 'error': 'No fields to update'}
    
    update_parts.append('#updated_at = :updated_at')
    expr_names['#updated_at'] = 'updated_at'
    
    try:
        response = aggregates_table.update_item(
            Key={'pk': 'FEEDBACK_FORM', 'sk': f'FORM#{form_id}'},
            UpdateExpression='SET ' + ', '.join(update_parts),
            ExpressionAttributeNames=expr_names,
            ExpressionAttributeValues=expr_values,
            ReturnValues='ALL_NEW'
        )
        
        return {'success': True, 'form': _item_to_form(response.get('Attributes', {}))}
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
        
        return {'success': True, 'config': _item_to_form(item)}
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
        # Pre-assign category from form config
        'preset_category': form.get('category', ''),
        'preset_subcategory': form.get('subcategory', ''),
        'metadata': {
            'form_id': form_id,
            'form_name': form.get('name', ''),
            'form_version': '2.0',
            'submitter_email': body.get('email') if form.get('collect_email') else None,
            'submitter_name': body.get('name') if form.get('collect_name') else None,
            'custom_fields': body.get('custom_fields', {}),
        }
    }
    normalized_record['metadata'] = {k: v for k, v in normalized_record['metadata'].items() if v is not None}
    
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


@app.get("/feedback-forms/<form_id>/submissions")
@tracer.capture_method
def get_form_submissions(form_id: str):
    """Get submissions for a specific form with stats."""
    params = app.current_event.query_string_parameters or {}
    limit = min(int(params.get('limit', 50)), 100)
    
    if not feedback_table:
        return {'success': False, 'error': 'Feedback table not configured'}
    
    # Verify form exists and get its brand_name
    try:
        response = aggregates_table.get_item(
            Key={'pk': 'FEEDBACK_FORM', 'sk': f'FORM#{form_id}'}
        )
        form = response.get('Item')
        if not form:
            return {'success': False, 'error': 'Form not found'}
        # Use form's stored brand_name, fall back to env var, then to source_platform
        form_brand_name = form.get('brand_name') or BRAND_NAME
    except Exception as e:
        logger.error(f"Error fetching form: {e}")
        return {'success': False, 'error': 'Failed to fetch form'}
    
    # Query feedback by source_channel (form_{form_id})
    source_channel = f'form_{form_id}'
    # Use brand_name for pk if set, otherwise fall back to source_platform
    source_pk = f"SOURCE#{form_brand_name}" if form_brand_name else 'SOURCE#feedback_form'
    
    try:
        # Use FilterExpression to filter at DynamoDB level and paginate
        items = []
        total_rating = 0
        rating_count = 0
        
        query_kwargs = {
            'KeyConditionExpression': Key('pk').eq(source_pk),
            'FilterExpression': 'source_channel = :sc',
            'ExpressionAttributeValues': {':sc': source_channel},
            'ScanIndexForward': False,
        }
        
        # Paginate through results until we have enough
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
            
            # Check for more pages
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
    
    # Get form's stored brand_name for correct pk lookup
    try:
        form_response = aggregates_table.get_item(
            Key={'pk': 'FEEDBACK_FORM', 'sk': f'FORM#{form_id}'}
        )
        form = form_response.get('Item')
        form_brand_name = form.get('brand_name', '') if form else ''
    except Exception as e:
        logger.warning(f"Could not fetch form brand_name: {e}")
        form_brand_name = ''
    
    source_channel = f'form_{form_id}'
    # Use form's brand_name, fall back to env var, then to source_platform
    effective_brand = form_brand_name or BRAND_NAME
    source_pk = f"SOURCE#{effective_brand}" if effective_brand else 'SOURCE#feedback_form'
    
    try:
        # Use FilterExpression to filter at DynamoDB level and paginate
        total_rating = 0
        rating_count = 0
        submission_count = 0
        
        query_kwargs = {
            'KeyConditionExpression': Key('pk').eq(source_pk),
            'FilterExpression': 'source_channel = :sc',
            'ExpressionAttributeValues': {':sc': source_channel},
            'ProjectionExpression': 'feedback_id, rating',
        }
        
        # Paginate through all results
        while True:
            response = feedback_table.query(**query_kwargs)
            
            for item in response.get('Items', []):
                submission_count += 1
                if item.get('rating'):
                    total_rating += float(item.get('rating'))
                    rating_count += 1
            
            # Check for more pages
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


def _item_to_form(item: dict) -> dict:
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


def get_widget_js():
    """Return the inline widget JavaScript with support for multiple forms."""
    return '''
(function() {
  window.VoCFeedbackForm = {
    init: function(options) {
      var container = document.querySelector(options.container);
      if (!container) return;
      var apiEndpoint = (options.apiEndpoint || '').replace(/\\/+$/, '');
      if (!apiEndpoint) return;
      var configEndpoint = options.configEndpoint || '/feedback-form/config';
      var submitEndpoint = options.submitEndpoint || '/feedback-form/submit';
      fetch(apiEndpoint + configEndpoint)
        .then(function(r) { return r.json(); })
        .then(function(data) {
          var config = data.config || data;
          if (data.success && config && config.enabled) {
            new TypeformWidget(container, config, apiEndpoint, submitEndpoint);
          } else {
            container.innerHTML = '<p style="color:#666;text-align:center;padding:40px;">Feedback form unavailable.</p>';
          }
        })
        .catch(function() {
          container.innerHTML = '<p style="color:#666;text-align:center;padding:40px;">Failed to load form.</p>';
        });
    }
  };
  function TypeformWidget(container, config, apiEndpoint, submitEndpoint) {
    this.container = container; this.config = config; this.apiEndpoint = apiEndpoint; this.submitEndpoint = submitEndpoint;
    this.currentStep = 0; this.data = { rating: null, text: '', name: '', email: '' };
    this.isSubmitting = false;
    this.steps = this.buildSteps(); this.render();
  }
  TypeformWidget.prototype.buildSteps = function() {
    var steps = [], c = this.config;
    steps.push({ type: 'welcome', title: c.title, subtitle: c.description });
    if (c.rating_enabled) steps.push({ type: 'rating', title: c.question, ratingType: c.rating_type, max: c.rating_max || 5 });
    steps.push({ type: 'text', title: 'Tell us more', placeholder: c.placeholder });
    if (c.collect_name) steps.push({ type: 'name', title: "What's your name?", placeholder: 'Type your name...' });
    if (c.collect_email) steps.push({ type: 'email', title: "What's your email?", placeholder: 'name@example.com' });
    steps.push({ type: 'thanks', title: c.success_message || 'Thank you!' });
    return steps;
  };
  TypeformWidget.prototype.render = function() {
    var t = this.config.theme || {}, primary = t.primary_color || '#3B82F6', bg = t.background_color || '#FFFFFF', text = t.text_color || '#1F2937';
    this.container.innerHTML = '';
    this.container.style.cssText = 'position:relative;min-height:400px;background:' + bg + ';color:' + text + ';font-family:system-ui,-apple-system,sans-serif;overflow:hidden;';
    var progress = document.createElement('div');
    progress.style.cssText = 'position:absolute;top:0;left:0;height:4px;background:' + primary + ';transition:width 0.3s ease;width:0%;z-index:10;';
    this.container.appendChild(progress); this.progressBar = progress;
    var slides = document.createElement('div');
    slides.style.cssText = 'height:100%;min-height:400px;position:relative;';
    this.container.appendChild(slides); this.slidesContainer = slides;
    var self = this;
    this.steps.forEach(function(step, i) { slides.appendChild(self.createSlide(step, i)); });
    var nav = document.createElement('div');
    nav.style.cssText = 'position:absolute;bottom:20px;right:20px;display:flex;gap:8px;';
    var prevBtn = document.createElement('button');
    prevBtn.innerHTML = '&uarr;'; prevBtn.style.cssText = 'width:40px;height:40px;border:1px solid #d1d5db;background:white;border-radius:4px;cursor:pointer;font-size:18px;';
    prevBtn.onclick = function() { self.prev(); }; this.prevBtn = prevBtn;
    var nextBtn = document.createElement('button');
    nextBtn.innerHTML = '&darr;'; nextBtn.style.cssText = 'width:40px;height:40px;border:none;background:' + primary + ';color:white;border-radius:4px;cursor:pointer;font-size:18px;';
    nextBtn.onclick = function() { self.next(); }; this.nextBtn = nextBtn;
    nav.appendChild(prevBtn); nav.appendChild(nextBtn);
    this.container.appendChild(nav); this.nav = nav;
    document.addEventListener('keydown', function(e) {
      if (e.key === 'Enter' && !e.shiftKey) self.next();
      if (e.key === 'ArrowDown') self.next();
      if (e.key === 'ArrowUp') self.prev();
    });
    this.goToStep(0);
  };
  TypeformWidget.prototype.createSlide = function(step, index) {
    var self = this, t = this.config.theme || {}, primary = t.primary_color || '#3B82F6';
    var slide = document.createElement('div');
    slide.dataset.index = index;
    slide.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;display:flex;flex-direction:column;justify-content:center;align-items:center;padding:40px;box-sizing:border-box;opacity:0;transform:translateY(20px);transition:opacity 0.4s ease,transform 0.4s ease;pointer-events:none;';
    var content = document.createElement('div');
    content.style.cssText = 'max-width:600px;width:100%;text-align:center;';
    if (step.type === 'welcome') {
      content.innerHTML = '<h1 style="font-size:32px;font-weight:700;margin:0 0 16px;">' + esc(step.title) + '</h1><p style="font-size:18px;opacity:0.7;margin:0 0 32px;">' + esc(step.subtitle) + '</p><button class="voc-start" style="background:' + primary + ';color:white;border:none;padding:16px 32px;font-size:16px;border-radius:8px;cursor:pointer;">Start &rarr;</button>';
      content.querySelector('.voc-start').onclick = function() { self.next(); };
    } else if (step.type === 'rating') {
      var ratingLabels = ['Poor', 'Fair', 'Good', 'Great', 'Excellent'];
      var emojiLabels = ['Terrible', 'Bad', 'Okay', 'Good', 'Amazing'];
      var ratingHtml = '<h2 style="font-size:28px;font-weight:600;margin:0 0 32px;">' + esc(step.title) + '</h2><div class="voc-rating-container" style="display:flex;justify-content:center;gap:12px;flex-wrap:wrap;">';
      if (step.ratingType === 'emoji') {
        ['&#128545;','&#128533;','&#128528;','&#128578;','&#128525;'].forEach(function(e, i) { ratingHtml += '<button class="voc-rating-btn" data-value="' + (i+1) + '" data-label="' + emojiLabels[i] + '" style="font-size:48px;background:none;border:none;cursor:pointer;opacity:0.4;transition:all 0.2s;padding:8px;">' + e + '</button>'; });
      } else if (step.ratingType === 'numeric') {
        for (var n = 1; n <= 10; n++) ratingHtml += '<button class="voc-rating-btn" data-value="' + n + '" style="width:44px;height:44px;border:2px solid #d1d5db;background:white;border-radius:8px;cursor:pointer;font-size:16px;font-weight:600;transition:all 0.2s;">' + n + '</button>';
      } else {
        for (var s = 1; s <= step.max; s++) ratingHtml += '<button class="voc-rating-btn" data-value="' + s + '" data-label="' + (ratingLabels[s-1] || '') + '" style="font-size:40px;background:none;border:none;cursor:pointer;opacity:0.3;transition:all 0.2s;">&#9733;</button>';
      }
      ratingHtml += '</div><p class="voc-rating-hint" style="margin-top:24px;font-size:14px;opacity:0.5;min-height:20px;">Click to rate</p>';
      content.innerHTML = ratingHtml;
      var hintEl = content.querySelector('.voc-rating-hint');
      content.querySelectorAll('.voc-rating-btn').forEach(function(btn) {
        btn.onmouseenter = function() {
          var hoverVal = parseInt(this.dataset.value);
          var label = this.dataset.label;
          if (label) hintEl.textContent = label;
          if (step.ratingType === 'stars') {
            content.querySelectorAll('.voc-rating-btn').forEach(function(b) { b.style.opacity = parseInt(b.dataset.value) <= hoverVal ? '1' : '0.3'; });
          } else if (step.ratingType === 'emoji') {
            content.querySelectorAll('.voc-rating-btn').forEach(function(b) { var v = parseInt(b.dataset.value); b.style.opacity = v === hoverVal ? '1' : '0.4'; b.style.transform = v === hoverVal ? 'scale(1.2)' : 'scale(1)'; });
          }
        };
        btn.onmouseleave = function() {
          if (self.data.rating) {
            var selBtn = content.querySelector('.voc-rating-btn[data-value="' + self.data.rating + '"]');
            hintEl.textContent = selBtn ? (selBtn.dataset.label || 'Click to rate') : 'Click to rate';
            content.querySelectorAll('.voc-rating-btn').forEach(function(b) {
              var v = parseInt(b.dataset.value);
              if (step.ratingType === 'stars') b.style.opacity = v <= self.data.rating ? '1' : '0.3';
              else if (step.ratingType === 'emoji') { b.style.opacity = v === self.data.rating ? '1' : '0.4'; b.style.transform = v === self.data.rating ? 'scale(1.2)' : 'scale(1)'; }
            });
          } else {
            hintEl.textContent = 'Click to rate';
            content.querySelectorAll('.voc-rating-btn').forEach(function(b) { if (step.ratingType === 'stars') b.style.opacity = '0.3'; else if (step.ratingType === 'emoji') { b.style.opacity = '0.4'; b.style.transform = 'scale(1)'; } });
          }
        };
        btn.onclick = function() {
          self.data.rating = parseInt(this.dataset.value);
          var label = this.dataset.label;
          if (label) hintEl.textContent = label;
          content.querySelectorAll('.voc-rating-btn').forEach(function(b) {
            var v = parseInt(b.dataset.value);
            if (step.ratingType === 'stars') b.style.opacity = v <= self.data.rating ? '1' : '0.3';
            else if (step.ratingType === 'numeric') { b.style.background = v === self.data.rating ? primary : 'white'; b.style.color = v === self.data.rating ? 'white' : 'inherit'; b.style.borderColor = v === self.data.rating ? primary : '#d1d5db'; }
            else { b.style.opacity = v === self.data.rating ? '1' : '0.4'; b.style.transform = v === self.data.rating ? 'scale(1.2)' : 'scale(1)'; }
          });
          setTimeout(function() { self.next(); }, 300);
        };
      });
    } else if (step.type === 'text') {
      content.innerHTML = '<h2 style="font-size:28px;font-weight:600;margin:0 0 24px;">' + esc(step.title) + '</h2><textarea class="voc-input" placeholder="' + esc(step.placeholder) + '" style="width:100%;min-height:150px;padding:16px;font-size:18px;border:2px solid #e5e7eb;border-radius:12px;resize:none;font-family:inherit;box-sizing:border-box;"></textarea><p style="margin-top:16px;font-size:14px;opacity:0.5;">Press Enter to continue</p>';
      var ta = content.querySelector('.voc-input');
      ta.oninput = function() { self.data.text = this.value; };
      ta.onkeydown = function(e) { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); self.next(); } };
    } else if (step.type === 'name' || step.type === 'email') {
      content.innerHTML = '<h2 style="font-size:28px;font-weight:600;margin:0 0 24px;">' + esc(step.title) + '</h2><input type="' + (step.type === 'email' ? 'email' : 'text') + '" class="voc-input" placeholder="' + esc(step.placeholder) + '" style="width:100%;padding:16px;font-size:24px;border:none;border-bottom:2px solid #e5e7eb;text-align:center;outline:none;background:transparent;">';
      var inp = content.querySelector('.voc-input');
      inp.oninput = function() { self.data[step.type] = this.value; };
      inp.onkeydown = function(e) { if (e.key === 'Enter') self.next(); };
    } else if (step.type === 'thanks') {
      content.innerHTML = '<div style="font-size:64px;margin-bottom:24px;">&#10003;</div><h2 style="font-size:32px;font-weight:600;margin:0;">' + esc(step.title) + '</h2>';
    }
    slide.appendChild(content);
    return slide;
  };
  TypeformWidget.prototype.goToStep = function(index) {
    var slides = this.slidesContainer.querySelectorAll('[data-index]'), self = this;
    slides.forEach(function(slide, i) {
      if (i === index) { slide.style.opacity = '1'; slide.style.transform = 'translateY(0)'; slide.style.pointerEvents = 'auto'; var input = slide.querySelector('.voc-input'); if (input) setTimeout(function() { input.focus(); }, 100); }
      else { slide.style.opacity = '0'; slide.style.transform = i < index ? 'translateY(-20px)' : 'translateY(20px)'; slide.style.pointerEvents = 'none'; }
    });
    this.currentStep = index;
    this.progressBar.style.width = ((index) / (this.steps.length - 1)) * 100 + '%';
    var step = this.steps[index];
    this.nav.style.display = (step.type === 'welcome' || step.type === 'thanks') ? 'none' : 'flex';
    this.prevBtn.style.opacity = index <= 1 ? '0.3' : '1';
    this.prevBtn.disabled = index <= 1;
  };
  TypeformWidget.prototype.next = function() {
    var step = this.steps[this.currentStep];
    // Validate current step before proceeding
    if (step.type === 'rating' && !this.data.rating) return;
    if (step.type === 'text' && !this.data.text.trim()) return;
    if (step.type === 'name' && !this.data.name.trim()) return;
    if (step.type === 'email' && !this.data.email.trim()) return;
    if (this.currentStep === this.steps.length - 2) { this.submit(); return; }
    if (this.currentStep < this.steps.length - 1) this.goToStep(this.currentStep + 1);
  };
  TypeformWidget.prototype.prev = function() { if (this.currentStep > 1) this.goToStep(this.currentStep - 1); };
  TypeformWidget.prototype.submit = function() {
    var self = this;
    if (this.isSubmitting) return;
    this.isSubmitting = true;
    fetch(this.apiEndpoint + this.submitEndpoint, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: this.data.text, rating: this.data.rating, name: this.data.name || null, email: this.data.email || null, page_url: window.location.href })
    }).then(function(r) { return r.json(); }).then(function(result) { if (result.success) self.goToStep(self.steps.length - 1); else { self.isSubmitting = false; alert(result.error || 'Failed to submit.'); } }).catch(function() { self.isSubmitting = false; alert('Failed to submit.'); });
  };
  function esc(str) { if (!str) return ''; var d = document.createElement('div'); d.textContent = str; return d.innerHTML; }
})();
'''


# ============================================
# Lambda Handler
# ============================================

@logger.inject_lambda_context
@tracer.capture_lambda_handler
@metrics.log_metrics(capture_cold_start_metric=True)
def lambda_handler(event: dict, context: Any) -> dict:
    """Main Lambda handler."""
    return app.resolve(event, context)