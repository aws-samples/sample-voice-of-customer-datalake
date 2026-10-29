"""HTTP statuses several readers of web pages judge the same way (standard library only)."""
from typing import Final

#: The page does not exist (404 Not Found, 410 Gone): not a block, and not worth retrying as is.
NOT_FOUND_STATUSES: Final = frozenset({404, 410})
