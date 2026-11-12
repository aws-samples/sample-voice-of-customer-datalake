"""MicroVM auth tokens: minted when needed, refreshed before they lapse, never stored.

A token is valid for at most 60 minutes. It lives only in the memory of the Lambda that
minted it: it has no readable ``repr``, refuses to be pickled or turned into JSON, and
``checkpoints.py`` refuses any state that holds one. A unit that outlives its token mints
a new one (``TokenSource.current``); nothing ever reads a token back from storage.
"""
from __future__ import annotations

import time
from collections.abc import Callable
from dataclasses import dataclass
from typing import Final, NoReturn

#: The service's ceiling on one token's life.
MAX_TOKEN_SECONDS: Final = 60 * 60
#: A token with less than this left is refreshed before use.
REFRESH_MARGIN_SECONDS: Final = 5 * 60


class TokenNotStorable(TypeError):
    """Something tried to serialise an auth token."""


@dataclass(frozen=True, repr=False, eq=False)
class AuthToken:
    """One MicroVM auth token and when it lapses (epoch seconds)."""

    value: str
    expires_at: float

    def __repr__(self) -> str:
        return f'AuthToken(<hidden>, expires_at={self.expires_at:.0f})'

    def __reduce__(self) -> NoReturn:
        raise TokenNotStorable('a MicroVM auth token is never stored')

    def seconds_left(self, now: float) -> float:
        return self.expires_at - now


def bounded_expiry(issued_at: float, expires_at: float) -> float:
    """``expires_at`` cut to the 60-minute ceiling after ``issued_at``."""
    return min(expires_at, issued_at + MAX_TOKEN_SECONDS)


class TokenSource:
    """The current token of one MicroVM, minted again when it has under 5 minutes left."""

    def __init__(self, mint: Callable[[], AuthToken], clock: Callable[[], float] = time.time) -> None:
        self._mint = mint
        self._clock = clock
        self._token: AuthToken | None = None

    def __reduce__(self) -> NoReturn:
        raise TokenNotStorable('a token source holds an auth token and is never stored')

    def current(self) -> AuthToken:
        token = self._token
        if token is None or token.seconds_left(self._clock()) < REFRESH_MARGIN_SECONDS:
            token = self._mint()
            self._token = token
        return token
