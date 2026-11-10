"""Fakes shared by the admin_bootstrap suites (test_admin_bootstrap.py and its
mutation suite). The `cognito` fixture that injects `UserNotFound` lives in
conftest.py."""


class UserNotFound(Exception):
    """Stands in for cognito's UserNotFoundException."""


def make_event(request_type='Create', physical_id=None):
    event = {
        'RequestType': request_type,
        'ResourceProperties': {
            'UserPoolId': 'us-east-1_TEST',
            'Username': 'admin',
            'Email': 'admin@local.host',
            'GroupName': 'admins',
        },
    }
    if physical_id is not None:
        event['PhysicalResourceId'] = physical_id
    return event
