"""Shared pytest fixtures for plugin tests.

Note: Path setup and environment variables are configured in plugins/conftest.py
which is loaded first by pytest.
"""
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest

from _shared.test.scoped_secret import scoped_secret
from _shared.test.workspace_fixtures import OTHER_WS, WS
from shared.test.source_profile_fixtures import seeded_source_profiles


@pytest.fixture
def ingestor_aws():
    """Patch the AWS client factories and secret read BaseIngestor uses at init.

    Yields the doubles a test configures or asserts on: ``table`` (every
    DynamoDB Table), ``sqs`` and ``s3`` (the clients), and ``get_secret`` (the
    patched reader, returning ``scoped_secret()`` unless a test overrides it).
    """
    table = MagicMock()
    # The test ingestor runs in a workspace by default: each workspace keeps its source's PII here (its own allow
    # profile; a workspace's source without one redacts by default since 7.08.00, test_source_policy_gate.py).
    allow = [{'id': 'test_source', 'pii': 'allow'}]
    with (
        seeded_source_profiles(workspaces={WS: allow, OTHER_WS: allow}),
        patch('_shared.base_ingestor.get_dynamodb_resource') as get_dynamo,
        patch('_shared.base_ingestor.get_s3_client') as get_s3,
        patch('_shared.base_ingestor.get_sqs_client') as get_sqs,
        patch(
            '_shared.base_ingestor.get_secret', return_value=scoped_secret()
        ) as get_secret,
    ):
        get_dynamo.return_value.Table.return_value = table
        yield SimpleNamespace(
            table=table,
            sqs=get_sqs.return_value,
            s3=get_s3.return_value,
            get_secret=get_secret,
        )


@pytest.fixture
def webhook_aws():
    """Patch the SQS client factory and secret read BaseWebhook uses at init.

    Yields ``sqs`` (the client) and ``get_secret`` (the patched reader,
    returning ``scoped_secret()`` unless a test overrides it).
    """
    with (
        patch('_shared.base_webhook.get_sqs_client') as get_sqs,
        patch('_shared.base_webhook.get_s3_client'),
        patch(
            '_shared.base_webhook.get_secret', return_value=scoped_secret()
        ) as get_secret,
    ):
        yield SimpleNamespace(sqs=get_sqs.return_value, get_secret=get_secret)
