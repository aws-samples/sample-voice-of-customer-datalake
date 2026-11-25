"""The Documents Library's keys (docs/documents-library.md), spelled once for every reader and writer.

In voc-projects:

    pk = LIBRARY
    sk = ITEM#{item_id}                 one item: its metadata, status and counts
    sk = SLUG#{slug}                    the slug's guard (``item_id``), put in the item's own transaction

    pk = LIBRARY_CHUNKS#{item_id}
    sk = C#{00001}                      one passage of the extracted text: ``text``, ``page``, ``chars``, ``embedding``

In the raw-data bucket (customer-managed key, versioned), never under ``raw/`` (a library item is never feedback):

    library/{item_id}/original          the uploaded file as it was sent (its name is the item's ``filename``)
    library/{item_id}/extracted         the extracted text (UTF-8)

The product-doc extractor's bucket notification filters the ``projects/`` prefix (lib/stacks/core-stack.ts), so a
library object never triggers it.
"""
from __future__ import annotations

import re
from typing import Final

LIBRARY_PK: Final = 'LIBRARY'
LIBRARY_CHUNKS_PREFIX: Final = 'LIBRARY_CHUNKS#'
ITEM_SK_PREFIX: Final = 'ITEM#'
SLUG_SK_PREFIX: Final = 'SLUG#'
CHUNK_SK_PREFIX: Final = 'C#'
#: The library's folder in the raw-data bucket.
LIBRARY_OBJECT_FOLDER: Final = 'library/'

#: ``lib_<UTC stamp>_<8 hex>`` (shared/ids.py ``timestamped_id``): what a route accepts as an item id.
ITEM_ID_PATTERN: Final = re.compile(r'lib_[0-9]{14}_[0-9a-f]{8}')
#: A slug: lower-case letters, digits and hyphens, 1 to 64, no leading or trailing hyphen.
SLUG_PATTERN: Final = re.compile(r'[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?')


def is_item_id(value: object) -> bool:
    return isinstance(value, str) and ITEM_ID_PATTERN.fullmatch(value) is not None


def item_key(item_id: str) -> dict[str, str]:
    return {'pk': LIBRARY_PK, 'sk': f'{ITEM_SK_PREFIX}{item_id}'}


def slug_key(slug: str) -> dict[str, str]:
    return {'pk': LIBRARY_PK, 'sk': f'{SLUG_SK_PREFIX}{slug}'}


def chunks_pk(item_id: str) -> str:
    """An item's passages: ``LIBRARY_CHUNKS#{item}``."""
    return f'{LIBRARY_CHUNKS_PREFIX}{item_id}'


def chunk_sk(index: int) -> str:
    """``C#00001``: passages sort in reading order (index from 1)."""
    return f'{CHUNK_SK_PREFIX}{index:05d}'


def item_object_prefix(item_id: str) -> str:
    """Every object of one item starts with this: ``library/{item_id}/``."""
    return f'{LIBRARY_OBJECT_FOLDER}{item_id}/'


def original_key(item_id: str) -> str:
    return f'{item_object_prefix(item_id)}original'


def extracted_key(item_id: str) -> str:
    return f'{item_object_prefix(item_id)}extracted'
