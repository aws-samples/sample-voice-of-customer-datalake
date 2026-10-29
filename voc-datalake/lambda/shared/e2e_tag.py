"""
Tag the Lambda log lines of e2e test traffic, so an error sweep can exclude it.

WHY. The production e2e suite makes ~1,000 deliberate 4xx calls per run (negative
auth tests, fake-id sweeps, GET-after-DELETE proofs). CloudWatch cannot delete single
events, so every request the suite sends carries a User-Agent token
`voc-e2e/<run id>` (frontend/e2e/lib/trafficTag.ts), and every log line of such an
invocation carries `test_run=<run id>`. A query then drops them with
`filter ispresent(test_run) = 0` (or keeps only them).

The token is matched strictly (`voc-e2e/` + 1-64 of `[A-Za-z0-9._-]`, delimited by a
space or tab, never a newline); anything else is ignored. The full User-Agent is never logged.

Warm containers reuse the logger, so the key is removed at the start of EVERY
invocation before it is (maybe) appended again: an untagged request after a tagged
one never inherits it.
"""

import functools
import re
from collections.abc import Callable, Mapping
from typing import Any

from aws_lambda_powertools import Logger

TEST_RUN_KEY = 'test_run'

_E2E_TOKEN = re.compile(r'(?:\A|[ \t])voc-e2e/([A-Za-z0-9._-]{1,64})(?=[ \t]|\Z)')

# A User-Agent longer than this is not searched (a real one is a few hundred chars).
_MAX_USER_AGENT_CHARS = 2048


def _header_values(event: Mapping[str, Any], name: str) -> list[str]:
    """Every value of header `name` (case-insensitive) in a REST proxy event's
    `headers` and `multiValueHeaders` (either may be absent or None)."""
    wanted = name.lower()

    def matching(field: str) -> list[object]:
        headers = event.get(field)
        if not isinstance(headers, Mapping):
            return []
        return [value for key, value in headers.items() if isinstance(key, str) and key.lower() == wanted]

    single = matching('headers')
    multi = [item for items in matching('multiValueHeaders') if isinstance(items, list) for item in items]
    return [value for value in (*single, *multi) if isinstance(value, str)]


def e2e_run_id(event: object) -> str | None:
    """The run id of a `voc-e2e/<run id>` User-Agent token on the request, else None."""
    if not isinstance(event, Mapping):
        return None
    for user_agent in _header_values(event, 'user-agent'):
        if len(user_agent) > _MAX_USER_AGENT_CHARS:
            continue
        match = _E2E_TOKEN.search(user_agent)
        if match is not None:
            return match.group(1)
    return None


def tag_test_run(logger: Logger, event: object) -> str | None:
    """Reset, then set `test_run` on `logger` for this invocation. Returns the run id."""
    logger.remove_keys([TEST_RUN_KEY])
    run_id = e2e_run_id(event)
    if run_id is not None:
        logger.append_keys(**{TEST_RUN_KEY: run_id})
    return run_id


_Handler = Callable[[Any, Any], Any]


def with_test_run_tag(logger: Logger) -> Callable[[_Handler], _Handler]:
    """Decorate a `(event, context)` handler so `tag_test_run` runs first on every call.

    Put it OUTERMOST (above `inject_lambda_context`), so every line of the
    invocation, the Powertools ones included, carries the key.
    """
    def decorate(func: _Handler) -> _Handler:
        @functools.wraps(func)
        def wrapper(event: Any, context: Any) -> Any:
            tag_test_run(logger, event)
            return func(event, context)
        return wrapper
    return decorate


__all__ = ['with_test_run_tag']
