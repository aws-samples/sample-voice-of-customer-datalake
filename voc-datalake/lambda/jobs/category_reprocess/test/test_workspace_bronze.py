"""A workspace's bronze can be replayed (TENETS.md D3): the raw reader follows a review's link under the bronze root
of the review's own scope, ``raw/`` for a deployment review and ``ws/{ws}/raw/`` for a workspace's, and no other.

No route starts a workspace's reprocess yet (it comes with the workspace's settings); the job itself stays
deployment-wide and skips ``WS#`` items (shared/reprocess_slices.py), so this holds the reader at the unit level.
"""
from unittest.mock import MagicMock, patch

import pytest

from jobs.category_reprocess import handler
from shared.raw_versions import parse_item_key, raw_root
from shared.ws_repo import scope_from_key

WS = 'ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D8'
WS_TWO = 'ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D9'
BUCKET = 'raw-bucket'
WS_KEY = f'ws/{WS}/raw/web/2026/01/10/a/0123456789abcdef.json'
PAYLOAD = b'{"raw_item": {"text": "Paket kam sp\\u00e4t", "rating": 1}}'


def _item(pk: str, key: str) -> dict:
    return {'pk': pk, 'sk': 'FEEDBACK#a', 'feedback_id': 'a', 'source_platform': 'web', 'source_channel': 'reviews',
            'rating': 2, 'original_text': 'stored text', 's3_raw_uri': f's3://{BUCKET}/{key}'}


def _replay(item: dict) -> tuple[tuple[dict, bool], MagicMock]:
    s3_client = MagicMock()
    s3_client.get_object.return_value = {'Body': MagicMock(read=MagicMock(return_value=PAYLOAD))}
    with patch.object(handler, 'RAW_DATA_BUCKET', BUCKET), patch.object(handler, 'get_s3_client', return_value=s3_client):
        return handler.raw_input_for(item), s3_client


def test_a_workspace_review_replays_its_own_workspaces_bronze():
    (record, archived), s3_client = _replay(_item(f'WS#{WS}#SOURCE#web', WS_KEY))
    assert archived is True
    assert (record['text'], record['rating']) == ('Paket kam spät', 1)
    s3_client.get_object.assert_called_once_with(Bucket=BUCKET, Key=WS_KEY)


@pytest.mark.parametrize(('pk', 'key'), [
    # A deployment review never reaches a workspace's bronze, nor a workspace's review the deployment's or another's.
    ('SOURCE#web', WS_KEY),
    (f'WS#{WS}#SOURCE#web', 'raw/web/2026/01/10/a/0123456789abcdef.json'),
    (f'WS#{WS_TWO}#SOURCE#web', WS_KEY),
    (f'WS#{WS}#SOURCE#web', f'ws/{WS}/silver/web/a/v.json'),
    # A WS# key that names no workspace is no scope's.
    ('WS#not-a-workspace#SOURCE#web', WS_KEY),
])
def test_a_link_outside_the_reviews_own_bronze_falls_back_to_the_stored_text(pk: str, key: str):
    (record, archived), s3_client = _replay(_item(pk, key))
    assert archived is False
    assert record['text'] == 'stored text'
    s3_client.get_object.assert_not_called()


def test_the_replay_helpers_read_a_workspace_key():
    archive = parse_item_key(WS_KEY)
    assert archive is not None
    assert (archive.stem, archive.folder) == ('a', f'ws/{WS}/raw/web/2026/01/10/a/')
    assert raw_root(scope_from_key(f'WS#{WS}#SOURCE#web')) == f'ws/{WS}/raw/'
    assert raw_root() == 'raw/'
