"""
User Administration API Lambda - Handles /users/*

Provides Cognito user management for admins:
- List users
- Create users
- Update user groups (admins/users)
- Reset passwords
- Enable/disable users

Only accessible by users in the 'admins' group.
"""
import os
import uuid
import boto3
from typing import Any

from shared.logging import logger, tracer
from shared.api import create_api_resolver, api_handler
from shared.exceptions import ValidationError, NotFoundError, ServiceError, ConflictError, AuthorizationError

# AWS Clients
cognito = boto3.client('cognito-idp')

# Configuration
USER_POOL_ID = os.environ.get('USER_POOL_ID', '')

app = create_api_resolver()


def get_caller_groups(event: dict) -> list[str]:
    """Extract user groups from Cognito authorizer claims."""
    try:
        claims = event.get('requestContext', {}).get('authorizer', {}).get('claims', {})
        groups_str = claims.get('cognito:groups', '')
        logger.info(f"Claims: {claims}")
        logger.info(f"Groups string: {groups_str}, type: {type(groups_str)}")
        if not groups_str:
            return []
        # Groups come as space-separated string or already a list
        if isinstance(groups_str, list):
            return groups_str
        # Handle comma-separated groups (API Gateway format)
        if ',' in groups_str:
            return [g.strip() for g in groups_str.split(',')]
        return groups_str.split(' ') if ' ' in groups_str else [groups_str]
    except Exception as e:
        logger.error(f"Error parsing groups: {e}")
        return []


def require_admin(event: dict) -> None:
    """Verify caller is in admins group."""
    groups = get_caller_groups(event)
    if 'admins' not in groups:
        raise AuthorizationError('Admin access required')


@app.get('/users')
@tracer.capture_method
def list_users():
    """List all users in the Cognito User Pool."""
    require_admin(app.current_event._data)
    
    try:
        users = []
        pagination_token = None
        
        while True:
            params = {
                'UserPoolId': USER_POOL_ID,
                'Limit': 60,
            }
            if pagination_token:
                params['PaginationToken'] = pagination_token
            
            response = cognito.list_users(**params)
            
            for user in response.get('Users', []):
                # Get user's groups
                groups_response = cognito.admin_list_groups_for_user(
                    Username=user['Username'],
                    UserPoolId=USER_POOL_ID
                )
                groups = [g['GroupName'] for g in groups_response.get('Groups', [])]
                
                # Extract attributes
                attrs = {attr['Name']: attr['Value'] for attr in user.get('Attributes', [])}
                
                users.append({
                    'username': user['Username'],
                    'email': attrs.get('email', ''),
                    'name': attrs.get('name', ''),
                    'given_name': attrs.get('given_name', ''),
                    'family_name': attrs.get('family_name', ''),
                    'status': user['UserStatus'],
                    'enabled': user['Enabled'],
                    'groups': groups,
                    'created_at': user['UserCreateDate'].isoformat() if user.get('UserCreateDate') else None,
                    'last_modified': user['UserLastModifiedDate'].isoformat() if user.get('UserLastModifiedDate') else None,
                })
            
            pagination_token = response.get('PaginationToken')
            if not pagination_token:
                break
        
        return {'success': True, 'users': users}
    
    except Exception as e:
        logger.exception(f'Error listing users: {e}')
        raise ServiceError(str(e))


@app.post('/users')
@tracer.capture_method
def create_user():
    """Create a new user in Cognito."""
    require_admin(app.current_event._data)
    
    body = app.current_event.json_body or {}
    email = body.get('email', '').strip()
    name = body.get('name', '').strip()
    given_name = body.get('given_name', '').strip()
    family_name = body.get('family_name', '').strip()
    group = body.get('group', 'users')  # Default to users
    
    if not email:
        raise ValidationError('Email is required')
    
    if group not in ['admins', 'users']:
        raise ValidationError('Group must be "admins" or "users"')
    
    try:
        # Create user with temporary password (they'll be forced to change on first login)
        user_attrs = [
            {'Name': 'email', 'Value': email},
            {'Name': 'email_verified', 'Value': 'true'},
        ]
        # Build display name from given/family name if provided
        if given_name:
            user_attrs.append({'Name': 'given_name', 'Value': given_name})
        if family_name:
            user_attrs.append({'Name': 'family_name', 'Value': family_name})
        # Use given_name + family_name as display name, or fall back to provided name
        display_name = f'{given_name} {family_name}'.strip() if (given_name or family_name) else name
        if display_name:
            user_attrs.append({'Name': 'name', 'Value': display_name})
        
        response = cognito.admin_create_user(
            UserPoolId=USER_POOL_ID,
            Username=str(uuid.uuid4()),  # Generate unique username (email is set as alias attribute)
            UserAttributes=user_attrs,
            DesiredDeliveryMediums=['EMAIL'],
        )
        
        username = response['User']['Username']
        
        # Add user to group
        cognito.admin_add_user_to_group(
            UserPoolId=USER_POOL_ID,
            Username=username,
            GroupName=group
        )
        
        display_name = f'{given_name} {family_name}'.strip() if (given_name or family_name) else name
        return {
            'success': True,
            'message': f'User created. Temporary password sent to {email}',
            'user': {
                'username': username,
                'email': email,
                'name': display_name,
                'given_name': given_name,
                'family_name': family_name,
                'groups': [group],
                'status': 'FORCE_CHANGE_PASSWORD',
            }
        }
    
    except cognito.exceptions.UsernameExistsException:
        raise ConflictError('A user with this email already exists')
    except Exception as e:
        logger.exception(f'Error creating user: {e}')
        raise ServiceError(str(e))


@app.put('/users/<username>')
@tracer.capture_method
def update_user(username: str):
    """Update user attributes (given_name, family_name)."""
    require_admin(app.current_event._data)

    body = app.current_event.json_body or {}
    given_name = body.get('given_name', '').strip()
    family_name = body.get('family_name', '').strip()

    if not given_name and not family_name:
        raise ValidationError('At least one of given_name or family_name is required')

    try:
        user_attrs = []
        if given_name:
            user_attrs.append({'Name': 'given_name', 'Value': given_name})
        if family_name:
            user_attrs.append({'Name': 'family_name', 'Value': family_name})
        # Update display name
        display_name = f'{given_name} {family_name}'.strip()
        if display_name:
            user_attrs.append({'Name': 'name', 'Value': display_name})

        cognito.admin_update_user_attributes(
            UserPoolId=USER_POOL_ID,
            Username=username,
            UserAttributes=user_attrs,
        )

        return {
            'success': True,
            'message': 'User updated',
            'username': username,
            'given_name': given_name,
            'family_name': family_name,
            'name': display_name,
        }

    except cognito.exceptions.UserNotFoundException:
        raise NotFoundError('User not found')
    except Exception as e:
        logger.exception(f'Error updating user: {e}')
        raise ServiceError(str(e))


@app.put('/users/<username>/group')
@tracer.capture_method
def update_user_group(username: str):
    """Update user's group (admins/users)."""
    require_admin(app.current_event._data)
    
    body = app.current_event.json_body or {}
    new_group = body.get('group', '').strip()
    
    if new_group not in ['admins', 'users']:
        raise ValidationError('Group must be "admins" or "users"')
    
    try:
        # Get current groups
        groups_response = cognito.admin_list_groups_for_user(
            Username=username,
            UserPoolId=USER_POOL_ID
        )
        current_groups = [g['GroupName'] for g in groups_response.get('Groups', [])]
        
        # Remove from old groups
        for group in current_groups:
            if group in ['admins', 'users']:
                cognito.admin_remove_user_from_group(
                    UserPoolId=USER_POOL_ID,
                    Username=username,
                    GroupName=group
                )
        
        # Add to new group
        cognito.admin_add_user_to_group(
            UserPoolId=USER_POOL_ID,
            Username=username,
            GroupName=new_group
        )
        
        return {
            'success': True,
            'message': f'User group updated to {new_group}',
            'username': username,
            'group': new_group
        }
    
    except cognito.exceptions.UserNotFoundException:
        raise NotFoundError('User not found')
    except Exception as e:
        logger.exception(f'Error updating user group: {e}')
        raise ServiceError(str(e))


@app.post('/users/<username>/reset-password')
@tracer.capture_method
def reset_user_password(username: str):
    """Reset user's password (sends new temporary password via email)."""
    require_admin(app.current_event._data)
    
    try:
        cognito.admin_reset_user_password(
            UserPoolId=USER_POOL_ID,
            Username=username
        )
        
        return {
            'success': True,
            'message': 'Password reset email sent to user',
            'username': username
        }
    
    except cognito.exceptions.UserNotFoundException:
        raise NotFoundError('User not found')
    except Exception as e:
        logger.exception(f'Error resetting password: {e}')
        raise ServiceError(str(e))


@app.put('/users/<username>/enable')
@tracer.capture_method
def enable_user(username: str):
    """Enable a disabled user."""
    require_admin(app.current_event._data)
    
    try:
        cognito.admin_enable_user(
            UserPoolId=USER_POOL_ID,
            Username=username
        )
        
        return {
            'success': True,
            'message': 'User enabled',
            'username': username
        }
    
    except cognito.exceptions.UserNotFoundException:
        raise NotFoundError('User not found')
    except Exception as e:
        logger.exception(f'Error enabling user: {e}')
        raise ServiceError(str(e))


@app.put('/users/<username>/disable')
@tracer.capture_method
def disable_user(username: str):
    """Disable a user (prevents login)."""
    require_admin(app.current_event._data)
    
    try:
        cognito.admin_disable_user(
            UserPoolId=USER_POOL_ID,
            Username=username
        )
        
        return {
            'success': True,
            'message': 'User disabled',
            'username': username
        }
    
    except cognito.exceptions.UserNotFoundException:
        raise NotFoundError('User not found')
    except Exception as e:
        logger.exception(f'Error disabling user: {e}')
        raise ServiceError(str(e))


@app.delete('/users/<username>')
@tracer.capture_method
def delete_user(username: str):
    """Delete a user from Cognito."""
    require_admin(app.current_event._data)
    
    try:
        cognito.admin_delete_user(
            UserPoolId=USER_POOL_ID,
            Username=username
        )
        
        return {
            'success': True,
            'message': 'User deleted',
            'username': username
        }
    
    except cognito.exceptions.UserNotFoundException:
        raise NotFoundError('User not found')
    except Exception as e:
        logger.exception(f'Error deleting user: {e}')
        raise ServiceError(str(e))


@api_handler
def lambda_handler(event: dict, context: Any) -> dict:
    """Main Lambda handler."""
    return app.resolve(event, context)
