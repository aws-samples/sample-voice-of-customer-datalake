"""Two creates in the same second, against moto (e2e finding: POST /projects 500).

Project ids were ``proj_<YYYYmmddHHMMSS>``, so a second create inside the same
second minted the same id and its ``attribute_not_exists`` put was refused — a
500 to the caller (the e2e fixtures spaced their creates 1.1 s apart to dodge
it). Ids now carry a random tail and a refused put retries once with a fresh
id (``shared/ids.py``). Run against moto so the conditional put and the
transaction's cancellation reasons are DynamoDB's own, not a mock's guess.
"""
import re
from collections.abc import Iterator
from datetime import UTC, datetime
from typing import Any
from unittest.mock import MagicMock, patch

import pytest
from botocore.exceptions import ClientError
from moto import mock_aws
from moto_helpers import pk_sk_table

from shared.project_access import Caller

OWNER = Caller(subject='owner-sub', username='olivia', email='olivia@example.com')
SAME_SECOND = datetime(2026, 10, 6, 12, 0, 0, tzinfo=UTC)
ID_SHAPE = re.compile(r'proj_20261006120000_[0-9a-f]{8}')


@pytest.fixture
def table() -> Iterator[Any]:
    with mock_aws():
        projects = pk_sk_table('projects')
        clock = MagicMock(wraps=datetime)
        clock.now.return_value = SAME_SECOND
        with patch('projects.projects_table', projects), patch('projects.datetime', clock):
            yield projects


def _create_project() -> str:
    from projects import create_project

    return create_project({'name': 'Same second'}, OWNER)['project']['project_id']


def _meta_ids(table: Any) -> set[str]:
    return {item['project_id'] for item in table.scan()['Items'] if item['sk'] == 'META'}


def test_two_creates_in_the_same_second_both_succeed_with_different_ids(table):
    first, second = _create_project(), _create_project()

    assert first != second
    for project_id in (first, second):
        assert ID_SHAPE.fullmatch(project_id), project_id
    assert _meta_ids(table) == {first, second}


def test_a_colliding_id_is_retried_once_with_a_fresh_one(table):
    # The second create draws the first one's tail, collides on the real
    # conditional put, and retries with the next draw.
    with patch('shared.ids.secrets.token_hex', side_effect=['aaaa0000', 'aaaa0000', 'bbbb1111']):
        first, second = _create_project(), _create_project()

    assert (first, second) == ('proj_20261006120000_aaaa0000', 'proj_20261006120000_bbbb1111')
    assert _meta_ids(table) == {first, second}


def test_a_second_collision_is_not_retried_again(table):
    with patch('shared.ids.secrets.token_hex', return_value='aaaa0000'):
        _create_project()
        with pytest.raises(ClientError) as exc:
            _create_project()

    assert exc.value.response.get('Error', {}).get('Code') == 'ConditionalCheckFailedException'
    assert _meta_ids(table) == {'proj_20261006120000_aaaa0000'}


def test_a_colliding_document_id_is_retried_inside_the_transaction(table):
    """A child create is a transaction (put + META count): the collision is the Put's own reason."""
    from projects import create_document

    project_id = _create_project()
    with patch('shared.ids.secrets.token_hex', side_effect=['cccc0000', 'cccc0000', 'dddd1111']):
        first = create_document(project_id, {'title': 'A', 'content': 'a'})['document']['document_id']
        second = create_document(project_id, {'title': 'B', 'content': 'b'})['document']['document_id']

    assert (first, second) == ('doc_20261006120000_cccc0000', 'doc_20261006120000_dddd1111')
    meta = table.get_item(Key={'pk': f'PROJECT#{project_id}', 'sk': 'META'})['Item']
    assert meta['document_count'] == 2
