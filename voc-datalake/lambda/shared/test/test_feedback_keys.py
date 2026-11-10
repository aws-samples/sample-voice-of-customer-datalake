"""``shared.feedback_keys`` is a persisted contract: every stored item was keyed with it (issue #411).

The processor and the CSV dataset preview both call it, so a lockstep test between them cannot
notice the recipe itself moving. These literals were computed outside the code under test
(``printf '%s' 'manual_import:abc' | shasum -a 256 | cut -c1-32``), and reproduce the
processor's pre-#411 inline ``sha256(f"{source_platform}:{source_id}")[:32]``.
"""
from shared.feedback_keys import FEEDBACK_ID_LENGTH, feedback_item_id, feedback_item_key

PINNED_ID = '5ec4bf548fd8d4357e0a9de9c0ae877f'


def test_the_feedback_id_recipe_is_pinned_to_a_literal():
    assert feedback_item_id('manual_import', 'abc') == PINNED_ID
    assert len(PINNED_ID) == FEEDBACK_ID_LENGTH


def test_the_key_is_the_source_partition_and_the_pinned_id():
    assert feedback_item_key('manual_import', 'abc') == {
        'pk': 'SOURCE#manual_import',
        'sk': f'FEEDBACK#{PINNED_ID}',
    }
