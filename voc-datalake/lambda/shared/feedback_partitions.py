"""The keys and index partitions of a processed feedback item in voc-feedback, on either path
(docs/multi-workspace.md).

* In a workspace (a ``WorkspaceScope``): the workspace layer's builders (shared/ws_repo.py ``feedback_key``,
  ``date_pk``, ``category_pk``, ``urgency_pk``, ``feedback_id_pk``, ``channel_pk``), every partition ``WS#{ws}#…``.
* Deployment-wide (``scope`` None): the keys the deployment always had, ``SOURCE#{source}`` / ``FEEDBACK#{id}``,
  ``DATE#``, ``CATEGORY#``, ``URGENCY#``, and the two index partitions written since gsi4 and gsi5 were re-keyed off
  the raw ``feedback_id`` and ``source_channel``: ``gsi4pk`` ``FEEDBACK#{feedback_id}`` and ``gsi5pk``
  ``CHANNEL#{channel}``. The deployment-wide path stays until phase 2's last slice moves the API and the processor
  onto workspaces, and is then removed.

One place for both, so the processor, the in-place refreshes (shared/source_updates.py) and the readers of gsi4 and
gsi5 build the same partition (shared/test/test_ws_raw_access.py counts this module's deployment-wide keys).
"""
from __future__ import annotations

from typing import Final

from shared.ws_repo import (
    WorkspaceScope,
    category_pk,
    channel_pk,
    date_pk,
    feedback_id_pk,
    feedback_key,
    urgency_pk,
)

__all__ = [
    'CHANNEL_INDEX_PARTITION',
    'FEEDBACK_ID_INDEX_PARTITION',
    'category_partition',
    'channel_partition',
    'date_partition',
    'feedback_id_partition',
    'item_key',
    'urgency_partition',
]

#: gsi4-by-feedback-id's partition attribute (lib/stacks/core-stack.ts).
FEEDBACK_ID_INDEX_PARTITION: Final = 'gsi4pk'
#: gsi5-by-channel's partition attribute (lib/stacks/core-stack.ts); its sort key is ``gsi1sk``.
CHANNEL_INDEX_PARTITION: Final = 'gsi5pk'


def item_key(scope: WorkspaceScope | None, source: str, feedback_id: str) -> dict[str, str]:
    """``{pk, sk}``: ``SOURCE#{source}`` / ``FEEDBACK#{id}``, or the workspace's ``WS#{ws}#SOURCE#{source}``."""
    if scope is not None:
        return feedback_key(scope, source, feedback_id)
    return {'pk': f'SOURCE#{source}', 'sk': f'FEEDBACK#{feedback_id}'}


def date_partition(scope: WorkspaceScope | None, day: str) -> str:
    """gsi1 (by date): ``DATE#{yyyy-mm-dd}``, or ``WS#{ws}#DATE#…``."""
    return date_pk(scope, day) if scope is not None else f'DATE#{day}'


def category_partition(scope: WorkspaceScope | None, category: str) -> str:
    """gsi2 (by category): ``CATEGORY#{category}``, or ``WS#{ws}#CATEGORY#…``."""
    return category_pk(scope, category) if scope is not None else f'CATEGORY#{category}'


def urgency_partition(scope: WorkspaceScope | None, urgency: str) -> str:
    """gsi3 (by urgency): ``URGENCY#{urgency}``, or ``WS#{ws}#URGENCY#…``."""
    return urgency_pk(scope, urgency) if scope is not None else f'URGENCY#{urgency}'


def feedback_id_partition(scope: WorkspaceScope | None, feedback_id: str) -> str:
    """gsi4 (by feedback id, ``gsi4pk``): ``FEEDBACK#{feedback_id}``, or ``WS#{ws}#FEEDBACK#…``."""
    return feedback_id_pk(scope, feedback_id) if scope is not None else f'FEEDBACK#{feedback_id}'


def channel_partition(scope: WorkspaceScope | None, channel: str) -> str:
    """gsi5 (by channel, ``gsi5pk``): ``CHANNEL#{channel}``, or ``WS#{ws}#CHANNEL#…``."""
    return channel_pk(scope, channel) if scope is not None else f'CHANNEL#{channel}'
