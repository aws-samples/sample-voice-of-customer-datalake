"""Properties of what the erasure worker deletes for one item, and the tombstone it writes first
(lambda/jobs/retention/copies.py).

A tombstone with the wrong id or time no longer proves which item was erased and when; a radar item read as a
workspace's, a whole-file upload deleted by a run that only erases one person's rows, or a count that is overwritten
instead of added to, each makes the run do or report the wrong thing. The stores and S3 are doubles.
"""
from __future__ import annotations

from typing import Any
from unittest.mock import MagicMock, patch

from hypothesis import given
from hypothesis import strategies as st

from jobs.retention import copies
from jobs.retention.copies import ItemDeleter, item_source, write_tombstones
from jobs.retention.runs import MODE_ERASE, MODE_RETENTION
from shared.retention import STORE_FEEDBACK, STORE_RADAR
from shared.test.ws_properties import PROPERTY

NOW = '2026-11-14T08:00:00+00:00'
IDS = st.text(alphabet='abc012-_', min_size=1, max_size=10)


# An item's source is its source_platform when that is text, else "unknown" (never a missing or empty label).
@PROPERTY
@given(st.one_of(st.text(alphabet='abc_', min_size=1, max_size=8), st.just(''), st.none(), st.integers()))
def test_an_item_source_is_its_platform_or_unknown(platform):
    expected = platform if isinstance(platform, str) and platform else 'unknown'
    assert item_source({'source_platform': platform}) == expected
    assert item_source({}) == 'unknown'


# One tombstone per item, each written with the run's one time and the item's own id: its feedback_id when it has
# one, else its sort key without the FEEDBACK# prefix; nothing at all (not even the clock) for an empty page.
@PROPERTY
@given(st.lists(st.tuples(IDS, st.booleans()), max_size=4, unique_by=lambda pair: pair[0]),
       st.sampled_from([MODE_ERASE, MODE_RETENTION]))
def test_each_item_gets_its_own_tombstone_at_the_run_time(items, mode):
    run = {'mode': mode, 'run_id': 'r1', 'legal_basis': 'gdpr_art17', 'legal_bases': {}}
    # With its field, an item's sort key names another id (a row keyed before the field existed): the field decides.
    stored = [{'pk': 'SOURCE#web', 'sk': f'FEEDBACK#{"key-" if has_field else ""}{feedback_id}',
               'source_platform': 'web', **({'feedback_id': feedback_id} if has_field else {'feedback_id': ''})}
              for feedback_id, has_field in items]
    table = MagicMock()
    with patch.object(copies, 'now_iso', return_value=NOW) as clock:
        write_tombstones(table, run, stored, STORE_FEEDBACK)
    assert clock.called is bool(items)
    written = [call.kwargs['Item'] for call in table.put_item.call_args_list]
    assert [(row['sk'], row['feedback_id'], row['deleted_at']) for row in written] == [
        (feedback_id, feedback_id, NOW) for feedback_id, _ in items]


def _deleter(run: dict[str, Any]) -> ItemDeleter:
    return ItemDeleter(run, MagicMock(), 'raw-bucket', {STORE_FEEDBACK: MagicMock(), STORE_RADAR: MagicMock(),
                                                       'aggregates': MagicMock()})


# Deleting an item adds to the run's counts (never overwrites them); a Radar item is never read as any workspace's
# (its key is not one), and a whole-file upload is deleted once, only by a whole-source erasure of that item's own
# source; any other run lists it for review.
@PROPERTY
@given(st.integers(min_value=0, max_value=50), st.integers(min_value=0, max_value=5),
       st.integers(min_value=1, max_value=9), st.sampled_from(['source', 'email', 'author']),
       st.sampled_from(['web', 'csv_upload']), st.integers(min_value=1, max_value=3))
def test_a_delete_adds_to_its_counts_and_keeps_whole_uploads_for_their_own_erasure(objects_before, item_objects,
                                                                                  upload_objects, field, run_source,
                                                                                  copies_of_upload):
    run = {'mode': MODE_ERASE, 'field': field, 'source': run_source, 'deleted_objects': objects_before,
           'deleted_items': 0, 'deleted_radar_items': 0, 'erased_sources': [], 'review_files': [],
           'review_files_more': False}
    deleter = _deleter(run)
    item = {'pk': 'SOURCE#csv_upload', 'sk': 'FEEDBACK#1', 'source_platform': 'csv_upload'}
    with patch.object(copies.retention, 'whole_upload_key', return_value='raw/csv_upload/file.csv'), \
            patch.object(copies.retention, 'import_originals_prefix', return_value=None), \
            patch.object(copies.retention, 'delete_whole_upload', return_value=upload_objects) as whole, \
            patch.object(copies.retention, 'delete_item', return_value=(None, item_objects)), \
            patch.object(copies, 'note_review_file') as review:
        for _ in range(copies_of_upload):
            deleter.delete(item, STORE_FEEDBACK)
    whole_source = field == 'source' and run_source == 'csv_upload'
    assert whole.call_count == (1 if whole_source else 0)
    assert review.call_count == (0 if whole_source else copies_of_upload)
    assert run['deleted_items'] == copies_of_upload
    assert run['deleted_objects'] == (objects_before + item_objects * copies_of_upload
                                      + (upload_objects if whole_source else 0))

    radar_run = {**run, 'deleted_objects': objects_before}
    radar_item = {'pk': 'WS#not-a-workspace#BRAND#x', 'sk': 'REVIEW#1', 'source_platform': 'radar'}
    with patch.object(copies.retention, 'whole_upload_key', return_value=None), \
            patch.object(copies.retention, 'import_originals_prefix', return_value=None), \
            patch.object(copies.retention, 'delete_radar_item', return_value=(None, item_objects)):
        _deleter(radar_run).delete(radar_item, STORE_RADAR)
    assert radar_run['deleted_radar_items'] == 1
    assert radar_run['deleted_objects'] == objects_before + item_objects
