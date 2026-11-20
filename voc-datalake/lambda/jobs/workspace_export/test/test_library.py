"""voc-workspace-export (7.62.00, jobs/workspace_export/library.py): a workspace's Documents Library items in its
export, each with only the fields it lists; never another workspace's, its passages, slug guards or claim token."""
from __future__ import annotations

import json

from boto3.dynamodb.types import Binary

from jobs.workspace_export import library
from jobs.workspace_export.test.conftest import OTHER, WS, World, seed
from jobs.workspace_export.test.test_handler import _jsonl, _unzip
from jobs.workspace_export.test.test_memory import _run
from shared.library_keys import chunks_pk, item_key, library_pk, slug_key
from shared.ws_repo import WorkspaceScope

ITEM = 'lib_20261102000000_0000a001'


def _seed_library(world: World) -> None:
    for ws, title in ((WS, 'Ours'), (OTHER, 'Theirs')):
        scope = WorkspaceScope(ws)
        world.projects.put_item(Item={**item_key(ITEM, workspace=scope), 'item_id': ITEM, 'title': title,
                                      'slug': 'q3', 'status': 'ready', 'extract_token': 'secret-claim',
                                      'tags': ['market'], 'later_field': 'x',
                                      's3_key': f'ws/{ws}/library/{ITEM}/original'})
        world.projects.put_item(Item={**slug_key('q3', workspace=scope), 'item_id': ITEM})
        world.projects.put_item(Item={'pk': library_pk(workspace=scope), 'sk': 'META', 'items': 1})
        world.projects.put_item(Item={'pk': chunks_pk(ITEM, workspace=scope), 'sk': 'C#00001',
                                      'text': 'passage-of-ours', 'embedding': Binary(b'v')})


def test_the_library_items_are_exported_with_their_listed_fields_only(world):
    seed(world)
    _seed_library(world)
    _run(world)
    files = _unzip(world)
    [row] = _jsonl(files, 'library')
    assert (row['item_id'], row['title'], row['tags']) == (ITEM, 'Ours', ['market'])
    assert row['s3_key'] == f'ws/{WS}/library/{ITEM}/original'
    assert 'extract_token' not in row
    assert 'later_field' not in row
    exported = json.dumps({name: body.decode(errors='replace') for name, body in files.items()})
    assert 'Theirs' not in exported
    assert 'passage-of-ours' not in exported
    manifest = json.loads(files['manifest.json'])
    assert manifest['entities']['library']['count'] == 1
    assert 'library_passages' in manifest['excluded']
    assert 'library_bookkeeping' in manifest['not_exported']


def test_the_fields_are_an_allowlist_without_the_claim():
    assert 'extract_token' not in library.FIELDS
    assert {'pk', 'sk', 'item_id', 'title', 'slug', 'status'} <= set(library.FIELDS)
