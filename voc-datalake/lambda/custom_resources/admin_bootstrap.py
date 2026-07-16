"""
Idempotent Cognito admin bootstrap (issue #196).

CloudFormation custom resource handler (cr.Provider protocol). On Create,
when the admin user does not exist: create it (email pre-verified,
invitation mail suppressed), set a TEMPORARY random password generated here
at runtime (Cognito forces a change on first login), add it to the admins
group, and return the password so the stack can expose it via the
InitialAdminPassword output — printing it on the very first deployment is
how operators find their first login.

On Create when the admin already exists (e.g. resource replacement), and on
every Update/Delete: change NOTHING. Redeployments must never create users
or touch a live admin's password.

The stack inlines this file (Code.fromInline), so keep it under 4096 bytes.
"""
import secrets

import boto3

# No ambiguous characters (0/O, 1/l/I) — operators retype this from a log.
UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ'
LOWER = 'abcdefghjkmnpqrstuvwxyz'
DIGITS = '123456789'
SPECIAL = '!@#$%^&*'
PASSWORD_LENGTH = 16
UNCHANGED = '(unchanged: admin already existed, password not touched)'

cognito = boto3.client('cognito-idp')


def generate_password():
    """Random password with every character class the pool policy requires."""
    classes = [UPPER, LOWER, DIGITS, SPECIAL]
    chars = [secrets.choice(char_class) for char_class in classes]
    pool = ''.join(classes)
    chars += [secrets.choice(pool) for _ in range(PASSWORD_LENGTH - len(chars))]
    secrets.SystemRandom().shuffle(chars)
    return ''.join(chars)


def admin_exists(user_pool_id, username):
    try:
        cognito.admin_get_user(UserPoolId=user_pool_id, Username=username)
        return True
    except cognito.exceptions.UserNotFoundException:
        return False


def handler(event, _context):
    props = event['ResourceProperties']
    user_pool_id = props['UserPoolId']
    physical_id = event.get('PhysicalResourceId') or f'admin-bootstrap-{user_pool_id}'
    no_change = {
        'PhysicalResourceId': physical_id,
        'Data': {'Password': UNCHANGED, 'AdminCreated': 'false'},
    }

    if event['RequestType'] != 'Create':
        return no_change

    username = props['Username']
    if admin_exists(user_pool_id, username):
        return no_change

    password = generate_password()
    cognito.admin_create_user(
        UserPoolId=user_pool_id,
        Username=username,
        UserAttributes=[
            {'Name': 'email', 'Value': props['Email']},
            {'Name': 'email_verified', 'Value': 'true'},
            {'Name': 'name', 'Value': 'Admin'},
        ],
        MessageAction='SUPPRESS',
    )
    # Temporary on purpose: first login forces a change, so the printed
    # password stops working the moment the operator uses it.
    cognito.admin_set_user_password(
        UserPoolId=user_pool_id,
        Username=username,
        Password=password,
    )
    cognito.admin_add_user_to_group(
        UserPoolId=user_pool_id,
        Username=username,
        GroupName=props['GroupName'],
    )
    return {
        'PhysicalResourceId': physical_id,
        'Data': {'Password': password, 'AdminCreated': 'true'},
    }
