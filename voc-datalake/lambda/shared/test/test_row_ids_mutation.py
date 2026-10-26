"""Mutation hardening for `shared/row_ids.py`.

`test_row_ids.py` pins that each of the three rules refuses, but it does so with
`pytest.raises(match=...)` — a regex SEARCH — and spells the bound as the
imported constant. A mutation run found two things that leaves unseen:

* the EXACT refusal text. Every message is the 400 body a caller reads, and a
  search matches when the module wraps it (``XXrow_id is requiredXX`` still
  contains ``row_id is required``). Each message is pinned here with ``==``.
* the bound itself. A test that asserts ``MAX_KEY_SEGMENT_ID_LEN + 1`` is
  refused agrees with any value the constant takes, so `256` becoming `257`
  survived. The literal 256 — accepted at 256, refused at 257, named as
  ``256 characters`` in the message — is pinned here.
"""
import pytest

from shared.exceptions import ValidationError
from shared.row_ids import MAX_KEY_SEGMENT_ID_LEN, validated_row_id


class TestEveryRefusalIsExactlyWorded:
    @pytest.mark.parametrize(('raw', 'kwargs', 'message'), [
        (None, {}, 'row_id is required'),
        ('   ', {'field': 'document_id'}, 'document_id is required'),
        ('', {'field': 'scores keys', 'missing_message': 'scores keys must be non-empty row id strings'},
         'scores keys must be non-empty row id strings'),
        ('a#b', {}, "row_id must not contain '#', the sort-key delimiter"),
        ('p#1', {'field': 'project_id'}, "project_id must not contain '#', the sort-key delimiter"),
        ('x' * 257, {}, 'row_id must be at most 256 characters'),
        ('x' * 300, {'field': 'document_id'}, 'document_id must be at most 256 characters'),
    ])
    def test_the_message_is_the_whole_body(self, raw, kwargs, message):
        with pytest.raises(ValidationError) as refusal:
            validated_row_id(raw, **kwargs)
        assert refusal.value.message == message
        assert str(refusal.value) == message
        assert refusal.value.status_code == 400


class TestTheBoundIs256:
    def test_the_constant_is_256(self):
        assert MAX_KEY_SEGMENT_ID_LEN == 256

    def test_exactly_256_characters_are_accepted(self):
        assert validated_row_id('y' * 256) == 'y' * 256

    def test_256_characters_after_stripping_are_accepted(self):
        assert validated_row_id('  ' + 'y' * 256 + '  ') == 'y' * 256
