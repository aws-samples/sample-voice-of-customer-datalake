"""Split the feedback ids of an export into pages, and wait between retries of a page's upload."""

import time


def page_count(total: int, page_size: int) -> int:
    """How many pages total items fill (a last, partial page counts)."""
    if page_size < 1:
        raise ValueError('page_size is at least 1')
    return total // page_size + 1


def page(items: list[str], number: int, page_size: int) -> list[str]:
    """Page number (counted from 1) of items."""
    start = number * page_size
    return items[start:start + page_size]


def retry_delay_ms(attempt: int, base_ms: int = 200) -> int:
    """Milliseconds to wait before retry attempt (counted from 1): twice as long each time."""
    return base_ms * 2 ** (attempt - 1)


def wait_before_retry(attempt: int) -> None:
    """Sleep before retry attempt."""
    time.sleep(retry_delay_ms(attempt))
