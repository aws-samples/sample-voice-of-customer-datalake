"""What a voc-conversations item is: the kinds the chat API and the assistant stream write, read by the memory workers.

Whose conversations a partition holds (docs/multi-workspace.md, "Request flow": the assistant's conversations): ``USER#{sub}`` for a request that
names no workspace (the deployment as before), ``WS#{ws}#USER#{sub}`` inside a workspace the caller is a member of
(``conversation_partition``; the stream Lambda builds the same, lambda/stream/src/assistant/session/record.ts
``callerPartition``, LOCKSTEP). The memory workers read only ``USER#`` partitions: a workspace's conversations are
not mined for memories until memory moves under its workspace.

Who has conversations in a workspace (since 7.19.00): ``WS#{ws}#CONVERSANTS`` / ``{sub}`` with ``first_at``, one row
per person who ever kept a conversation there (``conversant_key``; record.ts ``conversantKey``, LOCKSTEP, both pinned
by voc-datalake/schemas/conversation-keys-cases.json). Each writer puts it if absent (``record_conversant``) before
the conversation row, so a stored conversation is always listed; nothing removes it when the person leaves the
workspace, as nothing removes their conversations. The workspace's export and its delete find the
``WS#{ws}#USER#{sub}`` partitions from it with one Query on the workspace's own partition.
"""
from __future__ import annotations

from typing import TYPE_CHECKING, Final

from boto3.dynamodb.conditions import Attr
from botocore.exceptions import ClientError

from shared.ws_repo import conversants_pk

if TYPE_CHECKING:
    from shared.ws_repo import WorkspaceScope, WorkspaceTable

#: A unified-assistant session (``POST /chat/conversations/{id}`` with ``kind: 'assistant'``, and the stream Lambda).
ASSISTANT_KIND: Final = 'assistant'

#: The sort-key prefix of a conversation item (``sk CONV#{id}``); the partition also holds other rows.
CONVERSATION_SK_PREFIX: Final = 'CONV#'

#: The start of a person's own partition outside any workspace (the memory workers read only these).
USER_PARTITION_PREFIX: Final = 'USER#'

#: When the person's first conversation in the workspace was kept (an ISO time), the one attribute beside the key.
#: The row carries no ``kind`` and no ``updated_at``, so it stays off ``gsi1-by-kind-updated-at``.
CONVERSANT_FIRST_AT: Final = 'first_at'


def conversation_partition(sub: str, workspace: WorkspaceScope | None) -> str:
    """The partition of ``sub``'s conversations: their own (``USER#{sub}``), or theirs inside ``workspace``."""
    return f'{USER_PARTITION_PREFIX}{sub}' if workspace is None else workspace.key('USER', sub)


def conversant_key(workspace: WorkspaceScope, sub: str) -> dict[str, str]:
    """``sub``'s row in the workspace's list of conversation owners: ``WS#{ws}#CONVERSANTS`` / ``{sub}``. Refuses
    (ValueError) an empty sub."""
    if not sub:
        raise ValueError('a conversant needs a subject')
    return {'pk': conversants_pk(workspace), 'sk': sub}


def record_conversant(table: WorkspaceTable, sub: str, first_at: str) -> bool:
    """List ``sub`` among the conversation owners of ``table``'s workspace if they are not listed yet: one PutItem
    conditioned on the row being absent, so a listed person keeps their first ``first_at`` and nothing is ever
    duplicated. True when this call wrote the row, False when it was already there; any other fault is raised, so the
    caller does not store the conversation unlisted."""
    try:
        table.put_item({**conversant_key(table.scope, sub), CONVERSANT_FIRST_AT: first_at},
                       ConditionExpression=Attr('pk').not_exists())
    except ClientError as error:
        if error.response.get('Error', {}).get('Code') == 'ConditionalCheckFailedException':
            return False
        raise
    return True
