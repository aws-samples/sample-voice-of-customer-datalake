"""
Integrations API Lambda - Handles /integrations/*, /sources/*
Manages API credentials and data source schedules.
"""
import json
import os
from typing import Any
from aws_lambda_powertools import Logger, Tracer
from aws_lambda_powertools.event_handler import APIGatewayRestResolver, CORSConfig
import boto3

logger = Logger()
tracer = Tracer()

secretsmanager = boto3.client('secretsmanager')
events_client = boto3.client('events')

SECRETS_ARN = os.environ.get('SECRETS_ARN', '')

cors_config = CORSConfig(allow_origin="*", allow_headers=["Content-Type", "Authorization"], max_age=300)
app = APIGatewayRestResolver(cors=cors_config, enable_validation=True)


@app.get("/integrations/status")
@tracer.capture_method
def get_integration_status():
    """Get status of all integrations."""
    if not SECRETS_ARN:
        return {'error': 'Secrets not configured'}
    
    try:
        response = secretsmanager.get_secret_value(SecretId=SECRETS_ARN)
        secrets = json.loads(response.get('SecretString', '{}'))
        
        integrations = {
            'trustpilot': ['trustpilot_api_key', 'trustpilot_api_secret', 'trustpilot_business_unit_id'],
            'google_reviews': ['google_api_key'],
            'twitter': ['twitter_bearer_token'],
            'meta': ['meta_access_token'],
            'reddit': ['reddit_client_id', 'reddit_client_secret'],
            'tavily': ['tavily_api_key'],
            'youtube': ['youtube_api_key'],
            'tiktok': ['tiktok_access_token'],
            'linkedin': ['linkedin_access_token'],
        }
        
        status = {}
        for source, keys in integrations.items():
            configured_keys = [k for k in keys if secrets.get(k)]
            status[source] = {'configured': len(configured_keys) == len(keys), 'credentials_set': configured_keys}
        
        return status
    except Exception as e:
        logger.exception(f"Failed to get integration status: {e}")
        return {'error': str(e)}


@app.put("/integrations/<source>/credentials")
@tracer.capture_method
def update_credentials(source: str):
    """Update credentials for an integration."""
    if not SECRETS_ARN:
        return {'success': False, 'message': 'Secrets not configured'}
    
    body = app.current_event.json_body
    
    try:
        response = secretsmanager.get_secret_value(SecretId=SECRETS_ARN)
        secrets = json.loads(response.get('SecretString', '{}'))
        
        for key, value in body.items():
            if value:
                secrets[key] = value
        
        secretsmanager.put_secret_value(SecretId=SECRETS_ARN, SecretString=json.dumps(secrets))
        return {'success': True, 'message': f'Credentials updated for {source}'}
    except Exception as e:
        logger.exception(f"Failed to update credentials: {e}")
        return {'success': False, 'message': str(e)}


@app.post("/integrations/<source>/test")
@tracer.capture_method
def test_integration(source: str):
    """Test an integration connection."""
    return {'success': True, 'message': f'Integration {source} test not implemented'}


@app.get("/sources/status")
@tracer.capture_method
def get_sources_status():
    """Get status of all data source schedules."""
    sources = ['trustpilot', 'google_reviews', 'twitter', 'instagram', 'facebook', 
               'reddit', 'tavily', 'appstore_apple', 'appstore_google', 'webscraper',
               'youtube', 'tiktok', 'linkedin', 's3_import']
    
    status = {}
    for source in sources:
        rule_name = f"voc-ingest-{source}-schedule"
        try:
            response = events_client.describe_rule(Name=rule_name)
            status[source] = {
                'enabled': response.get('State') == 'ENABLED',
                'schedule': response.get('ScheduleExpression'),
                'rule_name': rule_name,
                'exists': True
            }
        except events_client.exceptions.ResourceNotFoundException:
            status[source] = {'enabled': False, 'exists': False}
        except Exception as e:
            status[source] = {'enabled': False, 'error': str(e)}
    
    return {'sources': status}


@app.put("/sources/<source>/enable")
@tracer.capture_method
def enable_source(source: str):
    """Enable a data source schedule."""
    rule_name = f"voc-ingest-{source}-schedule"
    try:
        events_client.enable_rule(Name=rule_name)
        return {'success': True, 'source': source, 'enabled': True}
    except Exception as e:
        return {'success': False, 'message': str(e)}


@app.put("/sources/<source>/disable")
@tracer.capture_method
def disable_source(source: str):
    """Disable a data source schedule."""
    rule_name = f"voc-ingest-{source}-schedule"
    try:
        events_client.disable_rule(Name=rule_name)
        return {'success': True, 'source': source, 'enabled': False}
    except Exception as e:
        return {'success': False, 'message': str(e)}


@logger.inject_lambda_context
@tracer.capture_lambda_handler
def lambda_handler(event: dict, context: Any) -> dict:
    return app.resolve(event, context)
