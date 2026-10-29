"""What a voc-conversations item is: the kinds the chat API and the assistant stream write, read by the memory workers."""
from typing import Final

#: A unified-assistant session (``POST /chat/conversations/{id}`` with ``kind: 'assistant'``, and the stream Lambda).
ASSISTANT_KIND: Final = 'assistant'

#: The sort-key prefix of a conversation item (``sk CONV#{id}``); the partition also holds other rows.
CONVERSATION_SK_PREFIX: Final = 'CONV#'
