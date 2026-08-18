"""
Idempotent Cognito admin bootstrap (issue #196).

Custom resource handler (cr.Provider protocol). Decision table on Create:
  - admin missing: create it (email pre-verified, invite suppressed), set
    a TEMPORARY runtime-generated password (first login forces a change),
    add it to the admins group, and return the password so the stack
    outputs it once — that is how operators find their first login.
  - admin half-bootstrapped (an earlier run failed after create: never
    logged in AND no groups): finish the job — fresh password + group.
  - admin healthy, or Update/Delete: strict no-op. Redeploys never create
    users or touch a live admin's password.

Dependency-free by design (no powertools): this file ships inlined via
Code.fromInline, so only stdlib + boto3 exist. Keep it under 4096 bytes
(CloudFormation ZipFile limit; a test enforces this).
"""
import secrets

import boto3

# No ambiguous characters (0/O, 1/l/I): operators retype this from a log.
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


def get_admin(user_pool_id, username):
    """The user record, or None. Anything but UserNotFound (e.g. throttling)
    raises: fail loud and let CloudFormation retry/roll back."""
    try:
        return cognito.admin_get_user(UserPoolId=user_pool_id, Username=username)
    except cognito.exceptions.UserNotFoundException:
        return None


def needs_repair(user, user_pool_id, username):
    """True only for a half-bootstrapped admin: never logged in AND no
    group memberships. A healthy admin (logged in, or in any group) is
    never touched."""
    if user['UserStatus'] != 'FORCE_CHANGE_PASSWORD':
        return False
    groups = cognito.admin_list_groups_for_user(
        UserPoolId=user_pool_id, Username=username,
    )
    return not groups['Groups']


def finish_bootstrap(user_pool_id, username, group_name):
    """Password + group steps, idempotent for an existing user."""
    password = generate_password()
    cognito.admin_set_user_password(
        UserPoolId=user_pool_id, Username=username, Password=password,
    )
    cognito.admin_add_user_to_group(
        UserPoolId=user_pool_id, Username=username, GroupName=group_name,
    )
    return password


def handler(event, _context):
    props = event['ResourceProperties']
    user_pool_id = props['UserPoolId']
    physical_id = event.get('PhysicalResourceId') or f'admin-bootstrap-{user_pool_id}'

    def result(password, outcome):
        return {'PhysicalResourceId': physical_id,
                'Data': {'Password': password, 'Bootstrap': outcome}}

    if event['RequestType'] != 'Create':
        return result(UNCHANGED, 'skipped')

    username = props['Username']
    user = get_admin(user_pool_id, username)

    if user is None:
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
        return result(finish_bootstrap(user_pool_id, username, props['GroupName']), 'created')

    if needs_repair(user, user_pool_id, username):
        return result(finish_bootstrap(user_pool_id, username, props['GroupName']), 'repaired')

    return result(UNCHANGED, 'skipped')
