"""``shared.raw_versions.item_stem``: one folder per item, also for items without an id."""
import pytest

from shared.archive_keys import archive_key_stem
from shared.raw_versions import content_digest, item_stem


def test_an_item_with_an_id_uses_its_ids_stem() -> None:
    assert item_stem('review-42', 'abc') == archive_key_stem('review-42')


@pytest.mark.parametrize('missing', [None, '', 0])
def test_an_item_without_an_id_is_named_after_its_content(missing: object) -> None:
    digest = content_digest({'text': 'slow checkout'})
    assert item_stem(missing, digest) == f'noid-{digest}'


def test_two_items_without_ids_never_share_a_folder() -> None:
    first = item_stem(None, content_digest({'text': 'a'}))
    second = item_stem(None, content_digest({'text': 'b'}))
    assert first != second


def test_an_id_literally_named_item_does_not_collide_with_items_without_ids() -> None:
    # The old constant stem 'item' let an erasure of an item with id 'item' remove every id-less copy.
    assert item_stem('item', 'abc') != item_stem(None, 'abc')
