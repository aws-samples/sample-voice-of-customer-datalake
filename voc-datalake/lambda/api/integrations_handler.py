"""
Integrations API Lambda - Handles /integrations/*, /sources/*
Manages API credentials and data source schedules.
"""

import json
import os
from typing import Any

from shared.logging import logger, tracer, metrics
from shared.aws import get_secrets_client
from shared.api import create_api_resolver, api_handler
from shared.exceptions import ConfigurationError, ServiceError, ValidationError

import boto3

secretsmanager = get_secrets_client()
events_client = boto3.client("events")

SECRETS_ARN = os.environ.get("SECRETS_ARN", "")
AWS_ACCOUNT_ID = os.environ.get("DEPLOY_ACCOUNT_ID", os.environ.get("AWS_ACCOUNT_ID", ""))
AWS_REGION = os.environ.get("DEPLOY_REGION", os.environ.get("AWS_REGION", ""))

app = create_api_resolver()


def _build_rule_name(source: str) -> str:
    """Build EventBridge rule name matching CDK's uniqueName() pattern."""
    suffix = f"-{AWS_ACCOUNT_ID}-{AWS_REGION}" if AWS_ACCOUNT_ID and AWS_REGION else ""
    return f"voc-ingest-{source}-schedule{suffix}"


@app.get("/integrations/status")
@tracer.capture_method
def get_integration_status():
    """Get status of all integrations."""
    if not SECRETS_ARN:
        raise ConfigurationError('Secrets not configured')
    
    try:
        response = secretsmanager.get_secret_value(SecretId=SECRETS_ARN)
        secrets = json.loads(response.get('SecretString', '{}'))
        
        integrations = {
            'webscraper': ['webscraper_api_key'],
        }
        
        status = {}
        for source, keys in integrations.items():
            configured_keys = [k for k in keys if secrets.get(k)]
            status[source] = {'configured': len(configured_keys) == len(keys), 'credentials_set': configured_keys}
        
        return status
    except ConfigurationError:
        raise
    except Exception as e:
        logger.exception(f"Failed to get integration status: {e}")
        raise ServiceError('Failed to retrieve integration status')


@app.get("/integrations/<source>/credentials")
@tracer.capture_method
def get_credentials(source: str):
    """Get saved configuration values for an integration so the Settings UI
    can pre-populate form fields (e.g. app_name, sort_by, frequency).

    This is NOT returning sensitive API keys — the app review plugins use
    public endpoints with no authentication. The values stored in Secrets
    Manager for these plugins are non-secret configuration like app names,
    package names, and tuning parameters. Secrets Manager is reused as the
    storage backend because the existing plugin infrastructure already
    reads config from there via BaseIngestor._load_secrets().

    The caller must specify which keys to retrieve via the `keys` query
    parameter (comma-separated). Only matching keys are returned.
    """
    if not SECRETS_ARN:
        raise ConfigurationError('Secrets not configured')

    params = app.current_event.query_string_parameters or {}
    keys_param = params.get('keys', '')
    if not keys_param:
        raise ValidationError('Missing required query parameter: keys')

    requested_keys = [k.strip() for k in keys_param.split(',') if k.strip()]

    try:
        response = secretsmanager.get_secret_value(SecretId=SECRETS_ARN)
        secrets = json.loads(response.get('SecretString', '{}'))

        prefix = f"{source}_"
        result = {}
        for key in requested_keys:
            prefixed_key = f"{prefix}{key}"
            if prefixed_key in secrets and secrets[prefixed_key]:
                result[key] = secrets[prefixed_key]
            elif key in secrets and secrets[key]:
                # Fallback to unprefixed for backward compatibility
                result[key] = secrets[key]

        return result
    except ConfigurationError:
        raise
    except Exception as e:
        logger.exception(f"Failed to get credentials for {source}: {e}")
        raise ServiceError('Failed to retrieve credentials')


@app.put("/integrations/<source>/credentials")
@tracer.capture_method
def update_credentials(source: str):
    """Update credentials for an integration."""
    if not SECRETS_ARN:
        raise ConfigurationError('Secrets not configured')
    
    body = app.current_event.json_body
    
    try:
        response = secretsmanager.get_secret_value(SecretId=SECRETS_ARN)
        secrets = json.loads(response.get('SecretString', '{}'))
        
        prefix = f"{source}_"
        for key, value in body.items():
            if value:
                secrets[f"{prefix}{key}"] = value
        
        secretsmanager.put_secret_value(SecretId=SECRETS_ARN, SecretString=json.dumps(secrets))
        return {'success': True, 'message': f'Credentials updated for {source}'}
    except ConfigurationError:
        raise
    except Exception as e:
        logger.exception(f"Failed to update credentials: {e}")
        raise ServiceError('Failed to update credentials')


@app.post("/integrations/<source>/test")
@tracer.capture_method
def test_integration(source: str):
    """Test an integration connection."""
    return {'success': True, 'message': f'Integration {source} test not implemented'}


@app.post("/sources/<source>/run")
@tracer.capture_method
def run_source(source: str):
    """Manually trigger a data source ingestor Lambda."""
    # Function name follows uniqueName() pattern: voc-ingestor-{id}-{account}-{region}
    suffix = f"-{AWS_ACCOUNT_ID}-{AWS_REGION}" if AWS_ACCOUNT_ID and AWS_REGION else ""
    function_name = f"voc-ingestor-{source}{suffix}"

    lambda_client = boto3.client("lambda")
    try:
        response = lambda_client.invoke(
            FunctionName=function_name,
            InvocationType="Event",
            Payload=json.dumps({"manual_trigger": True}).encode(),
        )
        status_code = response.get("StatusCode", 0)
        if status_code == 202:
            return {"success": True, "message": f"Triggered {source} ingestor", "source": source}
        raise ServiceError(f"Lambda invoke returned status {status_code}")
    except lambda_client.exceptions.ResourceNotFoundException:
        raise ServiceError(f"Ingestor Lambda not found for source: {source}")
    except ServiceError:
        raise
    except Exception as e:
        logger.exception(f"Failed to trigger source {source}: {e}")
        raise ServiceError(f"Failed to trigger {source} ingestor")


@app.get("/sources/status")
@tracer.capture_method
def get_sources_status():
    """Get status of all data source schedules."""
    params = app.current_event.query_string_parameters or {}
    sources_param = params.get('sources', '')
    
    # Use requested sources or fall back to defaults
    if sources_param:
        sources = [s.strip() for s in sources_param.split(',') if s.strip()]
    else:
        sources = ['webscraper', 'manual_import', 's3_import']
    
    status = {}
    for source in sources:
        rule_name = _build_rule_name(source)
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
            logger.warning(f"Failed to get status for source {source}: {e}")
            status[source] = {'enabled': False, 'error': 'Failed to retrieve status'}
    
    return {'sources': status}


@app.put("/sources/<source>/enable")
@tracer.capture_method
def enable_source(source: str):
    """Enable a data source schedule."""
    rule_name = _build_rule_name(source)
    try:
        events_client.enable_rule(Name=rule_name)
        return {'success': True, 'source': source, 'enabled': True}
    except Exception as e:
        logger.exception(f"Failed to enable source {source}: {e}")
        raise ServiceError('Failed to enable data source')


@app.put("/sources/<source>/disable")
@tracer.capture_method
def disable_source(source: str):
    """Disable a data source schedule."""
    rule_name = _build_rule_name(source)
    try:
        events_client.disable_rule(Name=rule_name)
        return {'success': True, 'source': source, 'enabled': False}
    except Exception as e:
        logger.exception(f"Failed to disable source {source}: {e}")
        raise ServiceError('Failed to disable data source')


@api_handler
def lambda_handler(event: dict, context: Any) -> dict:
    return app.resolve(event, context)
