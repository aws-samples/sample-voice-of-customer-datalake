"""Mutation hardening for `shared/archive_keys.py`.

`test_retention.py` exercises the stem only through `item_raw_key` with short
plain ids, `a/b`, and two 65-character ids. A mutation run found that nothing
pinned the length bound itself: `MAX_PLAIN_STEM_CHARS = 65` survived, because
no test put an id of exactly 65 characters (the first one that must be hashed)
next to one of exactly 64 (the last one that stays plain). The bound decides
the S3 key every writer produces and the retention worker matches, so both
sides are pinned here as literals, together with the exact hashed form.
"""
import pytest

from shared.archive_keys import archive_key_stem


class TestTheLengthBoundIsSixtyFourCharacters:
    def test_a_64_character_safe_id_is_its_own_stem(self):
        assert archive_key_stem('a' * 64) == 'a' * 64

    def test_a_65_character_safe_id_is_hashed(self):
        assert archive_key_stem('a' * 65) == 'h.635361c48bb9eab14198e76ea8ab7f1a41685d6ad62aa9146d301d4f17eb0ae0'


class TestTheStemOfOtherIds:
    @pytest.mark.parametrize('raw_id', ['r1', 'A-z_09', '-', '_'])
    def test_a_filename_safe_id_is_unchanged(self, raw_id: str):
        assert archive_key_stem(raw_id) == raw_id

    @pytest.mark.parametrize(('raw_id', 'expected'), [
        ('a/b', 'h.c14cddc033f64b9dea80ea675cf280a015e672516090a5626781153dc68fea11'),
        ('x.y', 'h.b24ca9b75eb7b75775b5fdd41e0ef5cfbb6d233fcf305df9d3d5b347bb3b8ca8'),
        ('', 'h.e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'),
        ('é', 'h.4a99557e4033c3539de2eb65472017cad5f9557f7a0625a09f1c3f6e2ba69c4c'),
    ])
    def test_any_other_id_gets_the_sha256_of_its_utf8_text(self, raw_id: str, expected: str):
        assert archive_key_stem(raw_id) == expected

    def test_a_non_string_id_is_stemmed_from_its_text(self):
        assert archive_key_stem(123) == '123'

    @pytest.mark.parametrize(('raw_id', 'expected'), [
        ('abc\n', 'h.edeaaff3f1774ad2888673770c6d64097e391bc362d7d6fb34982ddf0efd18cb'),
        ('abc\r\n', 'h.552bab6864c7a7b69a502ed1854b9245c0e1a30f008aaa0b281da62585fdb025'),
    ])
    def test_an_id_ending_in_a_newline_is_hashed_so_no_key_holds_a_newline(self, raw_id: str, expected: str):
        assert archive_key_stem(raw_id) == expected
