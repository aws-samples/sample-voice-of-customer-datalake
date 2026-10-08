"""Mutation hardening for `_shared/normalized_item.py`.

The earlier coverage was indirect: `test_schemas.py` validates each producer's
message against the queue schema (which accepts any string, so a renamed read
key or a changed default still validates), and `test_github_mapping.py` builds
items that carry every field. A mutation run found unseen:

* which ITEM key each field is read from (``channel``, ``url``, ``rating``,
  ``created_at``, ``brand_handles_matched``) — a misspelt key silently falls
  back to the default;
* the defaults for a missing field: ``""`` for ``id``/``url``/``text``,
  ``None`` for ``rating``, ``[]`` for the brand handles, ``default_channel``
  for the channel and *now* (UTC, ISO) for ``created_at``;
* that ``ingested_at`` is always *now*, and that ``issue_attributes`` appears
  only when the item carries a non-empty value.
"""
from datetime import UTC
from unittest.mock import MagicMock, patch

import pytest

from _shared.normalized_item import normalized_item_fields

_NOW = '2026-01-05T10:00:00+00:00'

_FULL_ITEM = {
    'id': 'item-1',
    'channel': 'review',
    'url': 'https://example.com/r/1',
    'text': 'Loved it',
    'rating': 4,
    'created_at': '2026-01-01T00:00:00+00:00',
    'brand_handles_matched': ['Acme'],
}


def _fields(item: dict) -> tuple[dict, MagicMock]:
    """Build the fields with ``datetime`` replaced, so *now* is a literal."""
    with patch('_shared.normalized_item.datetime') as clock:
        clock.now.return_value.isoformat.return_value = _NOW
        fields = normalized_item_fields(
            item, source_platform='webscraper', default_channel='unknown', brand_name='Acme'
        )
    return fields, clock


class TestEveryFieldIsReadFromItsOwnKey:
    def test_a_full_item_is_copied_field_for_field(self):
        fields, _ = _fields(dict(_FULL_ITEM))

        assert fields == {
            'id': 'item-1',
            'source_platform': 'webscraper',
            'source_channel': 'review',
            'url': 'https://example.com/r/1',
            'text': 'Loved it',
            'rating': 4,
            'created_at': '2026-01-01T00:00:00+00:00',
            'ingested_at': _NOW,
            'brand_name': 'Acme',
            'brand_handles_matched': ['Acme'],
        }


class TestEveryMissingFieldGetsItsDefault:
    def test_an_empty_item_gets_every_default(self):
        fields, clock = _fields({})

        assert fields == {
            'id': '',
            'source_platform': 'webscraper',
            'source_channel': 'unknown',
            'url': '',
            'text': '',
            'rating': None,
            'created_at': _NOW,
            'ingested_at': _NOW,
            'brand_name': 'Acme',
            'brand_handles_matched': [],
        }
        assert clock.now.call_args_list == [((UTC,),), ((UTC,),)]


class TestIssueAttributesOnlyWhenPresent:
    def test_a_non_empty_value_is_carried(self):
        attributes = {'kind': 'issue', 'repo': 'o/r', 'number': 7}

        fields, _ = _fields({**_FULL_ITEM, 'issue_attributes': attributes})

        assert fields['issue_attributes'] == {'kind': 'issue', 'repo': 'o/r', 'number': 7}

    @pytest.mark.parametrize('value', [None, {}])
    def test_an_empty_value_leaves_the_key_out(self, value):
        fields, _ = _fields({**_FULL_ITEM, 'issue_attributes': value})

        assert 'issue_attributes' not in fields
