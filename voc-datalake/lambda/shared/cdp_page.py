"""Chrome DevTools Protocol constants and the page-settle wait both managed-browser readers use (the design
capture worker and the Web Reviews plugin, which each drive an AgentCore browser session over CDP)."""
from collections.abc import Callable
from dataclasses import dataclass
from typing import Final

#: ``Page.navigate``'s ``errorText`` for a main document answered with an HTTP error status. The page is still
#: read: a 403 bot wall says who blocked it.
HTTP_ERROR_RESPONSE: Final = 'net::ERR_HTTP_RESPONSE_CODE_FAILURE'
#: Evaluated while a page settles: ``[document.readyState, length of the visible text]`` as JSON.
PROGRESS_JS: Final = "JSON.stringify([document.readyState, document.body ? document.body.innerText.length : 0])"


@dataclass(frozen=True)
class SettleTimings:
    """How long a reader waits for a page: a first pause, a ceiling, the poll step, and the visible text a
    settled page must hold (0 = any)."""

    min_seconds: float
    max_seconds: float
    poll_seconds: float
    min_text_chars: int = 0


def wait_until_settled(progress: Callable[[], tuple[str, int]], clock: Callable[[], float],
                       sleep: Callable[[float], object], timings: SettleTimings) -> None:
    """Until ``progress()`` reads a complete document whose text length held still between two polls (and
    reaches ``min_text_chars``), within ``max_seconds``; a page that never settles is read as it is."""
    started = clock()
    sleep(timings.min_seconds)
    previous = -1  # pragma: no mutate  any start below a settled length (or None) can never equal one
    while clock() - started < timings.max_seconds:
        state, length = progress()
        if state == 'complete' and length >= timings.min_text_chars and length == previous:
            return
        previous = length
        sleep(timings.poll_seconds)
