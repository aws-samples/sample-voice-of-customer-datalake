"""The deploy-time seed of the review registries' marker (7.93.00, projects 3g-d2, review round 2: fp-2;
custom_resources/review_registries_marker.py, lib/stacks/review-registries-marker.ts).

A new deployment, with no project on ``gsi1-by-type``, gets a complete marker on the resource's Create, so an erasure
by email works out of the box; one that has a project gets none (the reset deleted it; the backfill writes it). The
one Query it sends is ``Limit`` 1 and the keys only (the policy allows that Query alone). In moto; every test here was
seen failing before the handler existed.
"""
import sys
from pathlib import Path
from typing import Any

import boto3
import pytest
from moto import mock_aws

# The inline handler, imported by its own name as its Lambda runs it (``index.handler``).
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import review_registries_marker as seed

from shared import review_registries
from shared.indexes import PROJECTS_BY_TYPE_INDEX
from shared.project_keys import DEPLOYMENT_LINK_REGISTRY_PK, REVIEW_REGISTRIES_MARKER_SK, project_type_pk
from shared.test.moto_tables import create_projects_table_with_type_index

TABLE = 'voc-projects-test'
MARKER_KEY = {'pk': DEPLOYMENT_LINK_REGISTRY_PK, 'sk': REVIEW_REGISTRIES_MARKER_SK}


@pytest.fixture
def table():
    with mock_aws():
        yield create_projects_table_with_type_index(TABLE, boto3.resource('dynamodb', region_name='us-east-1'))


def _event(request_type: str = 'Create', **props: Any) -> dict[str, Any]:
    """The event as the stack sends it: the table, and the index and partition its policy allows (the Python stores'
    names; review-registries-marker.test.ts holds the stack's to the same values)."""
    return {'RequestType': request_type, 'ResourceProperties': {
        'TableName': TABLE, 'IndexName': PROJECTS_BY_TYPE_INDEX, 'Partition': project_type_pk(), 'Release': '7.93.0',
        **props}}


def _marker(table) -> dict[str, Any] | None:
    return table.get_item(Key=dict(MARKER_KEY), ConsistentRead=True).get('Item')


def _project(table, project_id: str = 'proj_live_000001') -> None:
    table.put_item(Item={'pk': f'PROJECT#{project_id}', 'sk': 'META', 'gsi1pk': project_type_pk(),
                         'gsi1sk': '2026-11-01T00:00:00+00:00'})


def test_a_new_deployment_gets_a_complete_marker(table):
    answer = seed.handler(_event(), None)

    assert answer == {'PhysicalResourceId': seed.PHYSICAL_ID, 'Data': {'outcome': 'marked'}}
    marker = _marker(table)
    assert marker is not None
    assert review_registries.marker_complete(marker)
    assert [marker[name] for name in review_registries.MARKER_COUNTS] == [0, 0, 0]
    assert marker[review_registries.MARKER_RELEASE] == '7.93.0'


def test_a_deployment_with_a_project_gets_none(table):
    _project(table)

    assert seed.handler(_event(), None)['Data'] == {'outcome': 'left_to_the_backfill'}
    assert _marker(table) is None


def test_a_workspaces_project_alone_is_not_the_deployments(table):
    table.put_item(Item={'pk': 'WS#ws_1#PROJECT#p1', 'sk': 'META', 'gsi1pk': 'WS#ws_1#TYPE#PROJECT',
                         'gsi1sk': '2026-11-01T00:00:00+00:00'})
    assert seed.handler(_event(), None)['Data'] == {'outcome': 'marked'}


def test_a_marker_already_there_is_never_overwritten(table):
    table.put_item(Item={**MARKER_KEY, 'completed_at': 'earlier', 'links_found': 4, 'series_found': 2,
                         'projects_found': 1, 'release': '7.48.0'})
    assert seed.handler(_event(), None)['Data'] == {'outcome': 'kept'}
    assert (_marker(table) or {})['links_found'] == 4


@pytest.mark.parametrize('request_type', ['Update', 'Delete'])
def test_update_and_delete_do_nothing(table, request_type):
    assert seed.handler(_event(request_type), None)['Data'] == {'outcome': 'skipped'}
    assert _marker(table) is None


@pytest.mark.parametrize('name', ['TableName', 'IndexName', 'Partition', 'Release'])
def test_a_missing_property_fails_the_deploy(name):
    with pytest.raises(ValueError, match=f'missing {name}'):
        seed.handler(_event(**{name: ''}), None)


def test_the_stack_sends_the_same_index_and_partition():
    stack = (Path(seed.__file__).parents[2] / 'lib' / 'stacks' / 'retention-worker.ts').read_text(encoding='utf-8')
    assert f"export const PROJECTS_INDEX = '{PROJECTS_BY_TYPE_INDEX}';" in stack
    assert f"export const DEPLOYMENT_PROJECTS_PARTITION = '{project_type_pk()}';" in stack


def test_the_one_query_reads_one_row_of_keys_on_the_index():
    calls: list[dict[str, Any]] = []

    class Recording:
        def query(self, **kwargs: Any) -> dict[str, Any]:
            calls.append(kwargs)
            return {'Items': []}

    assert seed.has_a_project(Recording(), PROJECTS_BY_TYPE_INDEX, project_type_pk()) is False
    [call] = calls
    names = call['ExpressionAttributeNames']
    assert (call['IndexName'], call['Limit'], call['Select']) == (PROJECTS_BY_TYPE_INDEX, 1, 'SPECIFIC_ATTRIBUTES')
    assert {names[part.strip()] for part in call['ProjectionExpression'].split(',')} == {'pk', 'sk'}
    assert call['ExpressionAttributeValues'] == {':p': project_type_pk()}


def test_its_names_are_the_python_stores():
    assert (seed.MARKER_PK, seed.MARKER_SK) == (DEPLOYMENT_LINK_REGISTRY_PK, REVIEW_REGISTRIES_MARKER_SK)
    assert seed.MARKER_COUNTS == review_registries.MARKER_COUNTS


def test_it_fits_inline():
    """CloudFormation's documented ceiling for an inline ``ZipFile`` is 4096 characters (lib/stacks/core-cdn.ts)."""
    assert len(Path(seed.__file__).read_text(encoding='utf-8')) <= 4096
