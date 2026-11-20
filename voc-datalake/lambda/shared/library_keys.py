"""The Documents Library's keys (docs/documents-library.md), spelled once for every reader and writer.

In voc-projects, the deployment's library and a workspace's copy of it (shared/scoped_keys.py ``scoped_pk``):

    pk = LIBRARY                        (WS#{ws}#LIBRARY)
    sk = ITEM#{item_id}                 one item: its metadata, status and counts
    sk = SLUG#{slug}                    the slug's guard (``item_id``), put in the item's own transaction

    pk = LIBRARY_CHUNKS#{item_id}       (WS#{ws}#LIBRARY_CHUNKS#{item_id})
    sk = C#{00001}                      one passage of the extracted text: ``text``, ``page``, ``chars``, ``embedding``

In the raw-data bucket (customer-managed key, versioned), never under ``raw/`` (a library item is never feedback):

    library/{item_id}/original          the uploaded file as it was sent (its name is the item's ``filename``)
    library/{item_id}/extracted         the extracted text (UTF-8)

and under ``ws/{ws}/`` in a workspace. Neither key ends in a file extension: the product-doc extractor's
notifications fire on ``ws/`` objects by suffix (``.md``, ``.txt``, ``.png``, …: lib/stacks/core-product-doc-extractor.ts),
and a library object must never invoke it.
"""
from __future__ import annotations

import re
from collections.abc import Mapping
from typing import TYPE_CHECKING, Final

from shared.scoped_keys import scoped_object_key, scoped_pk

if TYPE_CHECKING:
    from shared.ws_repo import WorkspaceScope

LIBRARY_PK: Final = 'LIBRARY'
LIBRARY_CHUNKS_PREFIX: Final = 'LIBRARY_CHUNKS#'
ITEM_SK_PREFIX: Final = 'ITEM#'
SLUG_SK_PREFIX: Final = 'SLUG#'
CHUNK_SK_PREFIX: Final = 'C#'
#: The library's folder in the raw-data bucket (a workspace's is under ``ws/{ws}/``).
_OBJECT_FOLDER: Final = 'library/'

#: ``lib_<UTC stamp>_<8 hex>`` (shared/ids.py ``timestamped_id``): what a route accepts as an item id.
ITEM_ID_PATTERN: Final = re.compile(r'lib_[0-9]{14}_[0-9a-f]{8}')
#: A slug: lower-case letters, digits and hyphens, 1 to 64, no leading or trailing hyphen.
SLUG_PATTERN: Final = re.compile(r'[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?')


def is_item_id(value: object) -> bool:
    return isinstance(value, str) and ITEM_ID_PATTERN.fullmatch(value) is not None


def library_pk(*, workspace: WorkspaceScope | None = None) -> str:
    """The library's partition: ``LIBRARY``, ``WS#{ws}#LIBRARY`` in a workspace."""
    return scoped_pk(workspace, LIBRARY_PK)


def item_key(item_id: str, *, workspace: WorkspaceScope | None = None) -> dict[str, str]:
    return {'pk': library_pk(workspace=workspace), 'sk': f'{ITEM_SK_PREFIX}{item_id}'}


def slug_key(slug: str, *, workspace: WorkspaceScope | None = None) -> dict[str, str]:
    return {'pk': library_pk(workspace=workspace), 'sk': f'{SLUG_SK_PREFIX}{slug}'}


def chunks_pk(item_id: str, *, workspace: WorkspaceScope | None = None) -> str:
    """An item's passages: ``LIBRARY_CHUNKS#{item}``, ``WS#{ws}#LIBRARY_CHUNKS#{item}`` in a workspace."""
    return scoped_pk(workspace, f'{LIBRARY_CHUNKS_PREFIX}{item_id}')


def chunk_sk(index: int) -> str:
    """``C#00001``: passages sort in reading order (index from 1)."""
    return f'{CHUNK_SK_PREFIX}{index:05d}'


def library_prefix(*, workspace: WorkspaceScope | None = None) -> str:
    """Every library object of the scope starts with this: ``library/``, ``ws/{ws}/library/``."""
    return scoped_object_key(workspace, _OBJECT_FOLDER)


def item_object_prefix(item_id: str, *, workspace: WorkspaceScope | None = None) -> str:
    return f'{library_prefix(workspace=workspace)}{item_id}/'


def original_key(item_id: str, *, workspace: WorkspaceScope | None = None) -> str:
    return f'{item_object_prefix(item_id, workspace=workspace)}original'


def extracted_key(item_id: str, *, workspace: WorkspaceScope | None = None) -> str:
    return f'{item_object_prefix(item_id, workspace=workspace)}extracted'


def listed_chunk_partitions(workspace: WorkspaceScope, row: Mapping[str, object]) -> list[str]:
    """The passages' partition an item row of ``workspace``'s library names (``ITEM#{id}`` → its
    ``LIBRARY_CHUNKS#{id}``); none for its slug guards and count (the hard delete's owner list:
    jobs/workspace_delete/sweeps.py)."""
    sort_key = row.get('sk')
    if not isinstance(sort_key, str) or not sort_key.startswith(ITEM_SK_PREFIX):
        return []
    item_id = sort_key.removeprefix(ITEM_SK_PREFIX)
    return [chunks_pk(item_id, workspace=workspace)] if item_id else []
