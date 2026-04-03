"""
Integrations API Lambda - Handles /integrations/*, /sources/*
Manages API credentials and data source schedules.
"""

import json
import os
from typing import Any

from shared.logging import logger, tracer
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


# ============================================
# App Config CRUD (multi-instance plugins)
# ============================================

APP_CONFIG_PLUGINS = {'app_reviews_ios', 'app_reviews_android'}


def _get_app_configs_key(source: str) -> str:
    """Get the Secrets Manager key for a plugin's app configs array."""
    return f"{source}_configs"


@app.get("/integrations/<source>/apps")
@tracer.capture_method
def list_app_configs(source: str):
    """List all app configurations for a multi-instance plugin."""
    if source not in APP_CONFIG_PLUGINS:
        raise ValidationError(f'Source {source} does not support multiple app configs')
    if not SECRETS_ARN:
        return {'apps': []}

    try:
        response = secretsmanager.get_secret_value(SecretId=SECRETS_ARN)
        secrets = json.loads(response.get('SecretString', '{}'))
        configs_key = _get_app_configs_key(source)
        configs = json.loads(secrets.get(configs_key, '[]'))
        return {'apps': configs}
    except (ConfigurationError, ValidationError):
        raise
    except Exception as e:
        logger.warning(f"Could not read app configs for {source}: {e}")
        return {'apps': []}


@app.post("/integrations/<source>/apps")
@tracer.capture_method
def save_app_config(source: str):
    """Save (create or update) an app configuration for a multi-instance plugin."""
    if source not in APP_CONFIG_PLUGINS:
        raise ValidationError(f'Source {source} does not support multiple app configs')
    if not SECRETS_ARN:
        raise ConfigurationError('Secrets not configured')

    body = app.current_event.json_body or {}
    app_config = body.get('app')
    if not app_config:
        raise ValidationError('No app config provided')

    # Validate required fields
    if not app_config.get('id'):
        import uuid
        app_config['id'] = str(uuid.uuid4())[:8]
    if not app_config.get('app_name'):
        raise ValidationError('app_name is required')

    try:
        response = secretsmanager.get_secret_value(SecretId=SECRETS_ARN)
        secrets = json.loads(response.get('SecretString', '{}'))
        configs_key = _get_app_configs_key(source)
        configs = json.loads(secrets.get(configs_key, '[]'))

        existing_idx = next((i for i, c in enumerate(configs) if c.get('id') == app_config['id']), -1)
        if existing_idx >= 0:
            configs[existing_idx] = app_config
        else:
            configs.append(app_config)

        secrets[configs_key] = json.dumps(configs)
        secretsmanager.put_secret_value(SecretId=SECRETS_ARN, SecretString=json.dumps(secrets))
        return {'success': True, 'app': app_config}
    except (ConfigurationError, ValidationError):
        raise
    except Exception as e:
        logger.exception(f"Failed to save app config for {source}: {e}")
        raise ServiceError('Failed to save app configuration')


@app.delete("/integrations/<source>/apps/<app_id>")
@tracer.capture_method
def delete_app_config(source: str, app_id: str):
    """Delete an app configuration from a multi-instance plugin."""
    if source not in APP_CONFIG_PLUGINS:
        raise ValidationError(f'Source {source} does not support multiple app configs')
    if not SECRETS_ARN:
        raise ConfigurationError('Secrets not configured')

    try:
        response = secretsmanager.get_secret_value(SecretId=SECRETS_ARN)
        secrets = json.loads(response.get('SecretString', '{}'))
        configs_key = _get_app_configs_key(source)
        configs = json.loads(secrets.get(configs_key, '[]'))
        configs = [c for c in configs if c.get('id') != app_id]
        secrets[configs_key] = json.dumps(configs)
        secretsmanager.put_secret_value(SecretId=SECRETS_ARN, SecretString=json.dumps(secrets))
        return {'success': True}
    except (ConfigurationError, ValidationError):
        raise
    except Exception as e:
        logger.exception(f"Failed to delete app config for {source}: {e}")
        raise ServiceError('Failed to delete app configuration')


@app.post("/sources/<source>/run")
@tracer.capture_method
def run_source(source: str):
    """Manually trigger a data source ingestor Lambda.
    
    Optionally accepts a JSON body with `app_id` to run a single app
    config instead of all configs for the source.
    """
    from datetime import datetime, timezone
    from shared.tables import get_aggregates_table

    # Function name follows uniqueName() pattern: voc-ingestor-{id}-{account}-{region}
    suffix = f"-{AWS_ACCOUNT_ID}-{AWS_REGION}" if AWS_ACCOUNT_ID and AWS_REGION else ""
    function_name = f"voc-ingestor-{source}{suffix}"

    execution_id = f"run_{source}_{datetime.now().strftime('%Y%m%d%H%M%S')}"
    payload: dict = {"manual_trigger": True, "execution_id": execution_id}
    try:
        body = app.current_event.json_body or {}
        if body.get("app_id"):
            payload["app_id"] = body["app_id"]
    except Exception:
        pass

    # Create initial run status record
    try:
        table = get_aggregates_table()
        if table:
            table.put_item(Item={
                'pk': f'SOURCE_RUN#{source}', 'sk': execution_id,
                'status': 'running', 'items_found': 0,
                'started_at': datetime.now(timezone.utc).isoformat(),
            })
    except Exception as e:
        logger.warning(f"Failed to create run status: {e}")

    lambda_client = boto3.client("lambda")
    try:
        response = lambda_client.invoke(
            FunctionName=function_name,
            InvocationType="Event",
            Payload=json.dumps(payload).encode(),
        )
        status_code = response.get("StatusCode", 0)
        if status_code == 202:
            return {"success": True, "message": f"Triggered {source} ingestor", "source": source, "execution_id": execution_id}
        raise ServiceError(f"Lambda invoke returned status {status_code}")
    except lambda_client.exceptions.ResourceNotFoundException:
        raise ServiceError(f"Ingestor Lambda not found for source: {source}")
    except ServiceError:
        raise
    except Exception as e:
        logger.exception(f"Failed to trigger source {source}: {e}")
        raise ServiceError(f"Failed to trigger {source} ingestor")


def _get_source_run_status(source: str):
    """Get the latest run status for a data source plugin."""
    from boto3.dynamodb.conditions import Key
    from shared.tables import get_aggregates_table

    table = get_aggregates_table()
    if not table:
        return {'source': source, 'status': 'unknown'}
    try:
        response = table.query(
            KeyConditionExpression=Key('pk').eq(f'SOURCE_RUN#{source}'),
            ScanIndexForward=False, Limit=1,
        )
        items = response.get('Items', [])
        if not items:
            return {'source': source, 'status': 'never_run'}
        run = items[0]
        return {
            'source': source,
            'execution_id': run.get('sk'),
            'status': run.get('status', 'unknown'),
            'started_at': run.get('started_at'),
            'completed_at': run.get('completed_at'),
            'items_found': run.get('items_found', 0),
            'errors': run.get('errors', []),
        }
    except Exception as e:
        logger.warning(f"Failed to get source run status: {e}")
        return {'source': source, 'status': 'unknown'}


@app.get("/sources/status")
@tracer.capture_method
def get_sources_status():
    """Get status of all data source schedules, or run status for a specific source."""
    params = app.current_event.query_string_parameters or {}
    
    # If source param provided, return run status for that source
    run_status_source = params.get('run_status')
    if run_status_source:
        return _get_source_run_status(run_status_source)
    
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
