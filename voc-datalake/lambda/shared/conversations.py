"""What a voc-conversations item is: the kinds the chat API and the assistant stream write, read by the memory workers.

Whose conversations a partition holds (docs/multi-workspace.md, "Request flow": the assistant's conversations): ``USER#{sub}`` for a request that
names no workspace (the deployment as before), ``WS#{ws}#USER#{sub}`` inside a workspace the caller is a member of
(``conversation_partition``; the stream Lambda builds the same, lambda/stream/src/assistant/session/record.ts
``callerPartition``, LOCKSTEP). The memory workers read only ``USER#`` partitions: a workspace's conversations are
not mined for memories until memory moves under its workspace.
"""
from __future__ import annotations

from typing import TYPE_CHECKING, Final

if TYPE_CHECKING:
    from shared.ws_repo import WorkspaceScope

#: A unified-assistant session (``POST /chat/conversations/{id}`` with ``kind: 'assistant'``, and the stream Lambda).
ASSISTANT_KIND: Final = 'assistant'

#: The sort-key prefix of a conversation item (``sk CONV#{id}``); the partition also holds other rows.
CONVERSATION_SK_PREFIX: Final = 'CONV#'

#: The start of a person's own partition outside any workspace (the memory workers read only these).
USER_PARTITION_PREFIX: Final = 'USER#'


def conversation_partition(sub: str, workspace: WorkspaceScope | None) -> str:
    """The partition of ``sub``'s conversations: their own (``USER#{sub}``), or theirs inside ``workspace``."""
    return f'{USER_PARTITION_PREFIX}{sub}' if workspace is None else workspace.key('USER', sub)
