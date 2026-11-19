"""The user-auth parameters' names and shapes (7.57.00; ``user_auth.py``), shared by their writers and readers: the
Agents API (the App's OAuth client, a removal), voc-engineering-user-auth (the code's exchange) and the broker (a
refresh). Under ``ENGINEERING_USER_AUTH_PREFIX`` (``/[<prefix>-]voc/engineering-user-auth/``), outside the connections'
path, so no reader of the connections reads them. Names only, and the JSON a client parameter holds: no AWS, no host.
"""
from __future__ import annotations

import hashlib
import json
import re
from typing import Final

from shared.plan_canonical import FINGERPRINT_RE

#: The env var with the user-auth parameters' prefix (the function's, the broker's and the Agents API's).
USER_AUTH_PREFIX_ENV: Final = 'ENGINEERING_USER_AUTH_PREFIX'
#: The SPA's page GitHub sends the browser back to after a user authorization (the App's callback URL).
AUTHORIZED_PATH: Final = '/agents/connections/github/authorized'
#: A GitHub App's client id (``Iv1.…`` or ``Iv23…``) and its client secret (40 hex characters).
CLIENT_ID: Final = re.compile(r'Iv[0-9A-Za-z.]{1,40}')
CLIENT_SECRET: Final = re.compile(r'[0-9a-f]{40}')
#: A GitHub login (a user's or an organization's): letters, digits and single hyphens, at most 39.
GITHUB_LOGIN: Final = re.compile(r'[A-Za-z0-9](?:-?[A-Za-z0-9]){0,38}')
#: GitHub's OAuth code as a request carries it (a path segment's characters, at most 200).
OAUTH_CODE: Final = re.compile(r'[A-Za-z0-9_-]{1,200}')
#: A person's key: the sha256 of their subject, in hex (a lowercase sha256 hex digest's shape).
SUBJECT_HASH: Final = FINGERPRINT_RE


def subject_hash(subject: str) -> str:
    """A person's key in the user-auth parameters: the sha256 of their subject (never the subject itself)."""
    return hashlib.sha256(subject.encode()).hexdigest()


def client_parameter(prefix: str, app_id: str) -> str:
    """App ``app_id``'s OAuth client: ``{app_id, client_id, client_secret}``."""
    return f'{prefix}app/{app_id}/client'


def user_parameter(prefix: str, app_id: str, owner: str) -> str:
    """One person's (``owner``: their subject's sha256) user token of App ``app_id``."""
    return f'{prefix}user/{app_id}/{owner}'


def client_value(app_id: str, client_id: str, client_secret: str) -> str:
    """The client parameter's JSON (the Agents API writes it; ``repr`` of nothing here holds it)."""
    return json.dumps({'app_id': app_id, 'client_id': client_id, 'client_secret': client_secret})
