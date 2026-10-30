"""The OAuth discovery documents of the global MCP server (docs/mcp.md → "OAuth sign-in").

Served anonymously by ``voc-mcp-tokens-api`` under the API stage (execute-api puts ``/v1`` at the path
start, so the host root is not ours):

* protected-resource metadata (RFC 9728) at ``/.well-known/oauth-protected-resource`` and the
  path-suffixed ``/.well-known/oauth-protected-resource/mcp/global`` — the URL the 401 challenge names;
* authorization-server metadata (RFC 8414) at ``/.well-known/oauth-authorization-server`` and
  ``/.well-known/openid-configuration`` (MCP 2025-11-25 clients try the latter for a path issuer).

The authorization server is THIS API's facade, not Cognito: Cognito's own discovery omits
``code_challenge_methods_supported`` (MCP clients must refuse an AS without it) and has no registration
endpoint. Keys stay Cognito's (``jwks_uri``).
"""

from __future__ import annotations

from typing import Any, Final

from shared.mcp_oauth_config import AUTHORIZE_PATH, EXCHANGE_PATH, REGISTER_PATH, REVOKE_PATH, OAuthConfig

RESOURCE_NAME: Final = 'VoC Data Lake'


def protected_resource_metadata(config: OAuthConfig) -> dict[str, Any]:
    return {
        'resource': config.resource,
        'authorization_servers': [config.issuer],
        'scopes_supported': config.scopes_supported,
        'bearer_methods_supported': ['header'],
        'resource_name': RESOURCE_NAME,
    }


def authorization_server_metadata(config: OAuthConfig) -> dict[str, Any]:
    return {
        'issuer': config.issuer,
        'authorization_endpoint': f'{config.issuer}{AUTHORIZE_PATH}',
        'token_endpoint': f'{config.issuer}{EXCHANGE_PATH}',
        'revocation_endpoint': f'{config.issuer}{REVOKE_PATH}',
        'registration_endpoint': f'{config.issuer}{REGISTER_PATH}',
        'jwks_uri': config.jwks_uri,
        'response_types_supported': ['code'],
        'response_modes_supported': ['query'],
        'grant_types_supported': ['authorization_code', 'refresh_token'],
        'code_challenge_methods_supported': ['S256'],
        'token_endpoint_auth_methods_supported': ['none'],
        'revocation_endpoint_auth_methods_supported': ['none'],
        'scopes_supported': ['openid', *config.scopes_supported],
        'subject_types_supported': ['public'],
        'id_token_signing_alg_values_supported': ['RS256'],
    }
