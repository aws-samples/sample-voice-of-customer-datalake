"""Request builders and AWS stubs shared by the integrations_handler test modules.

Plain functions rather than fixtures: each takes the conftest `api_gateway_event`
factory and `lambda_context` it needs, so a test still states which fixtures it
uses. `integrations_handler` is imported at call time, after the test's patches
are active, exactly as the tests did inline.
"""
import json


def secret_string(values) -> dict:
    """A `get_secret_value` response whose SecretString is *values* as JSON."""
    return {'SecretString': json.dumps(values)}


def call_integrations(api_gateway_event, lambda_context, *, groups=None, **event_kwargs) -> dict:
    """Invoke `integrations_handler.lambda_handler` on one event and return its response.

    *groups* overrides the `cognito:groups` claim (the conftest default is
    `admins`); pass `'users'` for a non-admin caller.
    """
    from integrations_handler import lambda_handler

    event = api_gateway_event(**event_kwargs)
    if groups is not None:
        event['requestContext']['authorizer']['claims']['cognito:groups'] = groups
    return lambda_handler(event, lambda_context)


def call_credentials(
    api_gateway_event, lambda_context, method, *, source='webscraper', **event_kwargs
) -> dict:
    """`<method> /integrations/<source>/credentials`."""
    return call_integrations(
        api_gateway_event, lambda_context,
        method=method,
        path=f'/integrations/{source}/credentials',
        path_params={'source': source},
        **event_kwargs,
    )


def call_apps(
    api_gateway_event, lambda_context, method, source, *, app_id=None, **event_kwargs
) -> dict:
    """`<method> /integrations/<source>/apps[/<app_id>]`."""
    path_params = {'source': source}
    path = f'/integrations/{source}/apps'
    if app_id is not None:
        path_params['app_id'] = app_id
        path = f'{path}/{app_id}'
    return call_integrations(
        api_gateway_event, lambda_context,
        method=method, path=path, path_params=path_params, **event_kwargs,
    )


def call_source_action(
    api_gateway_event, lambda_context, method, source, action, **event_kwargs
) -> dict:
    """`<method> /sources/<source>/<action>` (run, enable, disable)."""
    return call_integrations(
        api_gateway_event, lambda_context,
        method=method,
        path=f'/sources/{source}/{action}',
        path_params={'source': source},
        **event_kwargs,
    )


def stub_ingestor_invoke(lambda_client, status_code=202):
    """Give a mocked Lambda client a modelled ResourceNotFoundException and an invoke result."""
    lambda_client.exceptions.ResourceNotFoundException = type(
        'ResourceNotFoundException', (Exception,), {}
    )
    lambda_client.invoke.return_value = {'StatusCode': status_code}
    return lambda_client


def ingestor_behind(mock_boto3, status_code=202):
    """Make `mock_boto3.client(...)` hand out one stubbed ingestor Lambda client, and return it."""
    from unittest.mock import MagicMock

    lambda_client = stub_ingestor_invoke(MagicMock(), status_code)
    mock_boto3.client.return_value = lambda_client
    return lambda_client


def stub_rule_lookup(mock_events, *, schedule='rate(1 day)', missing=False):
    """Stub EventBridge `describe_rule`: an ENABLED rule on *schedule*, or not found."""
    not_found = type('ResourceNotFoundException', (Exception,), {})
    mock_events.exceptions.ResourceNotFoundException = not_found
    if missing:
        mock_events.describe_rule.side_effect = not_found
    else:
        mock_events.describe_rule.return_value = {
            'State': 'ENABLED', 'ScheduleExpression': schedule,
        }
