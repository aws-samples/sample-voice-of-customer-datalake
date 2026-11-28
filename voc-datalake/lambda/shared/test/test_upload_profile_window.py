"""An upload's profile carries the deployment's retention window, as every other ingestion path does (7.108.00).

A workspace's profile refuses a retention window (``workspace_profiles_problem``): the window is the deployment's
and voc-retention applies it to every workspace's items. ``cached_source_profile_strict`` merges that window into a
workspace's profile, so ``archive_mode`` keeps a raw copy per item wherever the window deletes item by item. Before
7.108.00 ``upload_profile`` (the manual import's reader) did not: a workspace's upload of a windowed source that
the workspace's own profile allows PII for was archived as one whole file, which per-item retention never deletes.
Both readers now give the same profile for the same source and scope. Made-up names only.
"""
from __future__ import annotations

from collections.abc import Iterator
from types import SimpleNamespace
from typing import Any
from unittest.mock import patch

import boto3
import pytest
from botocore.exceptions import ClientError
from moto import mock_aws

from shared import source_profiles
from shared.ingest_archive import upload_profile
from shared.source_policy import ARCHIVE_FILE, ARCHIVE_ITEM, archive_mode
from shared.source_profiles import SOURCES_SETTINGS_KEY, SourceProfilesUnavailable, cached_source_profile_strict
from shared.workspace_settings import settings_key
from shared.ws_repo import WorkspaceScope

WS = 'ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D8'
SCOPE = WorkspaceScope(WS)
TABLE = 'window-aggregates'
WINDOW = (90, 'Contract clause 4')

#: The deployment's profiles: one source with a window, one kept for good, and one with a window whose deployment
#: profile redacts (the deployment's PII policy never reaches a workspace's upload; its window does).
DEPLOYMENT = [
    {'id': 'webscraper', 'label': 'Reviews', 'pii': 'allow', 'retention_days': WINDOW[0],
     'retention_legal_basis': WINDOW[1]},
    {'id': 'feedback_form', 'label': 'Forms', 'pii': 'allow'},
    {'id': 'trail_forum', 'label': 'Forum', 'pii': 'redact', 'retention_days': WINDOW[0],
     'retention_legal_basis': WINDOW[1]},
]
#: The workspace's own: all allow PII, none may set a window.
WORKSPACE = [{'id': 'webscraper', 'label': 'Trail reviews', 'pii': 'allow'},
             {'id': 'feedback_form', 'label': 'Trail forms', 'pii': 'allow'},
             {'id': 'trail_forum', 'label': 'Trail forum', 'pii': 'allow'}]


@pytest.fixture
def table() -> Iterator[Any]:
    """Both rows stored in one aggregates table; both readers read it (the strict one through its cache)."""
    with mock_aws():
        aggregates = boto3.resource('dynamodb', region_name='us-east-1').create_table(
            TableName=TABLE, KeySchema=[{'AttributeName': 'pk', 'KeyType': 'HASH'},
                                        {'AttributeName': 'sk', 'KeyType': 'RANGE'}],
            AttributeDefinitions=[{'AttributeName': 'pk', 'AttributeType': 'S'},
                                  {'AttributeName': 'sk', 'AttributeType': 'S'}],
            BillingMode='PAY_PER_REQUEST')
        aggregates.put_item(Item={**SOURCES_SETTINGS_KEY, 'sources': DEPLOYMENT})
        aggregates.put_item(Item={**settings_key(WS, 'sources'), 'sources': WORKSPACE})
        resource = SimpleNamespace(Table=lambda name: aggregates if name == TABLE else None)
        source_profiles.clear_source_profiles_cache()
        with patch.dict('os.environ', {'AGGREGATES_TABLE': TABLE}), \
                patch.object(source_profiles, 'get_dynamodb_resource', return_value=resource):
            yield aggregates
        source_profiles.clear_source_profiles_cache()


def _window(profile: dict[str, Any]) -> tuple[object, object]:
    return profile['retention_days'], profile['retention_legal_basis']


@pytest.mark.parametrize(('scope', 'source_id'), [
    (None, 'webscraper'), (None, 'feedback_form'), (SCOPE, 'webscraper'), (SCOPE, 'feedback_form'),
], ids=['deployment-windowed', 'deployment-unwindowed', 'workspace-windowed', 'workspace-unwindowed'])
def test_an_upload_and_the_strict_reader_give_the_same_window(table, scope, source_id):
    """The whole profile agrees, the window included: the two readers differ only in how they read (the upload
    uncached and strongly consistent, and refusing a source id nobody configured), never in what they give."""
    upload = upload_profile(table, source_id, scope)

    assert _window(upload) == _window(cached_source_profile_strict(source_id, scope))
    assert upload == cached_source_profile_strict(source_id, scope)


def test_a_workspace_upload_of_a_windowed_pii_allowed_source_is_archived_per_item(table):
    profile = upload_profile(table, 'webscraper', SCOPE)

    assert (profile['label'], profile['pii'], _window(profile)) == ('Trail reviews', 'allow', WINDOW)
    assert archive_mode(profile) == ARCHIVE_ITEM


def test_a_workspace_allow_upload_takes_the_window_of_a_source_the_deployment_redacts(table):
    """PII from the workspace's own profile (allow), the window from the deployment's (whose PII policy, redact,
    never applies here): archived per item."""
    profile = upload_profile(table, 'trail_forum', SCOPE)

    assert (profile['pii'], _window(profile)) == ('allow', WINDOW)
    assert archive_mode(profile) == ARCHIVE_ITEM


def test_a_workspace_upload_of_an_unwindowed_source_still_keeps_the_whole_file(table):
    assert archive_mode(upload_profile(table, 'feedback_form', SCOPE)) == ARCHIVE_FILE


def test_a_workspace_upload_fails_closed_when_the_deployments_window_is_unreadable(table):
    def get_item(Key, **options):
        if Key == SOURCES_SETTINGS_KEY:
            raise ClientError({'Error': {'Code': 'ProvisionedThroughputExceededException'}}, 'GetItem')
        return table.get_item(Key=Key, **options)

    with pytest.raises(SourceProfilesUnavailable):
        upload_profile(SimpleNamespace(get_item=get_item), 'webscraper', SCOPE)


def test_a_workspace_upload_fails_closed_when_the_deployments_row_is_corrupt(table):
    """A deployment row that does not parse (a ValueError) is the 503 too, as the strict reader's: never an upload
    filed without the window it may have."""
    table.put_item(Item={**SOURCES_SETTINGS_KEY, 'sources': [{'id': 'Not A Source Id'}]})

    with pytest.raises(SourceProfilesUnavailable):
        upload_profile(table, 'webscraper', SCOPE)
