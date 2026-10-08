"""Editing a persona research note, against moto (#267 item 5).

A tags-only edit builds no `#text` alias, and the update used to send
`ExpressionAttributeNames=None` — which botocore's parameter validation rejects
before the request leaves the client. A MagicMock table accepts it, so this runs
against moto, where the real validation applies.
"""
from collections.abc import Iterator
from typing import Any
from unittest.mock import patch

import pytest
from moto import mock_aws
from moto_helpers import pk_sk_table

KEY = {'pk': 'PROJECT#p1', 'sk': 'PERSONA#persona_1'}


@pytest.fixture
def table() -> Iterator[Any]:
    with mock_aws():
        projects = pk_sk_table('projects')
        projects.put_item(Item={
            **KEY,
            'research_notes': [{'note_id': 'n1', 'text': 'old', 'tags': ['a']}],
        })
        with patch('projects.projects_table', projects):
            yield projects


def _note(table: Any) -> dict:
    return table.get_item(Key=KEY)['Item']['research_notes'][0]


def test_a_tags_only_edit_is_saved(table):
    from projects import update_persona_note

    update_persona_note('p1', 'persona_1', 'n1', {'tags': ['b', 'c']})

    assert (_note(table)['tags'], _note(table)['text']) == (['b', 'c'], 'old')


def test_a_text_edit_still_uses_the_reserved_word_alias(table):
    from projects import update_persona_note

    update_persona_note('p1', 'persona_1', 'n1', {'text': 'new'})

    assert _note(table)['text'] == 'new'
