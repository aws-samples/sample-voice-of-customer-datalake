"""Where an operator route reads and writes a plugin's settings, on either path (docs/multi-workspace.md, Credentials).

The integrations API (plugin credentials, app connectors) and the scrapers API (scraper configs) keep what the plugin
ingestors read in one Secrets Manager secret, as one JSON object of ``<plugin>_<key>`` values
(plugins/_shared/plugin_secrets.py filters a run's keys by that namespace):

* a request without ``X-Workspace-Id``: the deployment's shared secret (``SECRETS_ARN``), as before;
* a request in a workspace: that workspace's own secret, ``{prefix}/{ws}/credentials`` (decision 8), the name built
  ONLY from the request's resolved membership (``credentials_secret_id``, over shared/workspace_ids.py
  ``credentials_secret_name``, which the workspaces API and the ingestors use too) and the prefix CDK hands down in
  ``WORKSPACE_SECRET_PREFIX``; never from a path, a body or a query field. A run in that workspace reads the same
  secret (plugins/_shared/base_ingestor.py ``_load_secrets``).

The workspaces API creates a workspace's secret after the workspace (``secret_status`` ``pending`` on its ``META``
until it exists and is marked ``ready``). Until ``META`` says ``ready`` (the request's resolved membership carries
it, ``WorkspaceContext.secret_status``), every route in that workspace that uses the secret, a read included, is
refused with a 409 starting ``CREDENTIALS_NOT_READY``, even if a secret already exists under the name; a ``ready``
workspace whose secret is missing gets a 409 starting ``CREDENTIALS_MISSING``. Never the shared secret, never an empty
list. No route creates or retries the secret: an operator follows the recovery steps of docs/multi-workspace.md
(Credentials).
"""
from __future__ import annotations

import json
import os
from typing import Any, Final

from botocore.exceptions import ClientError

from shared.exceptions import ConfigurationError, ConflictError
from shared.platform_workspaces import CREDENTIALS_READY
from shared.workspace import WorkspaceContext
from shared.workspace_ids import credentials_secret_name

__all__ = ['credentials_secret_id', 'read_secret_json']

SECRETS_NOT_CONFIGURED: Final = 'Secrets not configured'
#: How the 409 of a workspace whose ``META`` does not say ``secret_status: ready`` starts.
CREDENTIALS_NOT_READY: Final = "This workspace's credentials secret is not ready"
#: How the 409 of a ``ready`` workspace whose secret does not exist starts.
CREDENTIALS_MISSING: Final = "The workspace's credentials secret is missing"
#: Where an operator finds the recovery steps (both 409s name it).
RECOVERY_STEPS: Final = 'see the recovery steps in docs/multi-workspace.md, Credentials'


def credentials_secret_id(context: object, shared_secret: str) -> str:
    """The secret this request reads and writes: ``shared_secret`` deployment-wide (``context`` None), else the
    resolved workspace's ``{prefix}/{ws}/credentials``. ``ConfigurationError`` when the one it needs is not set.
    ``context`` is ``WorkspaceContext | None`` (typed ``object`` so the check below is also a type guard): anything
    else is a ``TypeError``, never a name."""
    if context is None:
        if not shared_secret:
            raise ConfigurationError(SECRETS_NOT_CONFIGURED)
        return shared_secret
    if not isinstance(context, WorkspaceContext):
        raise TypeError('a workspace secret needs a resolved workspace')
    # The workspaces' secret prefix CDK sets (``voc/ws``, or ``<deployment prefix>-voc/ws``).
    prefix = os.environ.get('WORKSPACE_SECRET_PREFIX', '')
    if not prefix:
        raise ConfigurationError(SECRETS_NOT_CONFIGURED)
    name = credentials_secret_name(prefix, context.ws)
    if context.secret_status != CREDENTIALS_READY:
        # The workspace's META says its secret is not made yet (``pending``), or says nothing: not used, even if a
        # secret already exists under the name (it may lack this workspace's tag; the create flow decides that).
        raise ConflictError(f'{CREDENTIALS_NOT_READY}: an operator must create {name} and mark the workspace ready '
                            f'({RECOVERY_STEPS}).')
    return name


def read_secret_json(client: Any, secret_id: str, context: WorkspaceContext | None) -> dict:
    """The secret's JSON object. In a workspace, a secret that does not exist is a 409 (``CREDENTIALS_MISSING``); every
    other failure (and a missing shared secret) raises as boto3 raised it, for the route to answer."""
    try:
        response = client.get_secret_value(SecretId=secret_id)
    except ClientError as error:
        if context is not None and error.response.get('Error', {}).get('Code') == 'ResourceNotFoundException':
            raise ConflictError(f'{CREDENTIALS_MISSING}: {secret_id} does not exist ({RECOVERY_STEPS}).') from error
        raise
    secrets = json.loads(response.get('SecretString', '{}'))
    if not isinstance(secrets, dict):
        # A hand-edited secret that is not a JSON object: the routes answer it as they answer malformed JSON.
        raise ValueError('the credentials secret is not a JSON object')
    return secrets
