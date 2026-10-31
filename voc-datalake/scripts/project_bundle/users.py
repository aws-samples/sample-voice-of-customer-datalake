"""Find a person in the TARGET deployment's Cognito user pool by email.

A Cognito sub is minted per user pool, so the same person has a different sub on each
deployment; the email is the one thing both pools share.
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any

# No quote, backslash or whitespace: the address goes into a ListUsers filter string.
_EMAIL_RE = re.compile(r'^[^"\\\s@]+@[^"\\\s@]+\.[^"\\\s@]+\Z')


@dataclass(frozen=True)
class TargetUser:
    sub: str
    username: str
    email: str


def _attribute(user: dict[str, Any], name: str) -> str | None:
    return next((a.get('Value') for a in user.get('Attributes', []) if a.get('Name') == name), None)


class UserDirectory:
    def __init__(self, cognito: Any, user_pool_id: str) -> None:
        self.cognito = cognito
        self.user_pool_id = user_pool_id
        self._cache: dict[str, TargetUser | None] = {}

    def find(self, email: object) -> TargetUser | None:
        """The one user with this email (case-insensitive), else None (absent, ambiguous, malformed)."""
        if not isinstance(email, str) or not _EMAIL_RE.match(email.strip()):
            return None
        address = email.strip().lower()
        if address not in self._cache:
            self._cache[address] = self._lookup(address)
        return self._cache[address]

    def _lookup(self, address: str) -> TargetUser | None:
        # Two is enough to tell "exactly one" from "ambiguous".
        users = self.cognito.list_users(UserPoolId=self.user_pool_id, Filter=f'email = "{address}"',
                                        Limit=2).get('Users', [])
        if len(users) != 1:
            return None
        sub = _attribute(users[0], 'sub')
        return TargetUser(sub=sub, username=users[0]['Username'], email=address) if sub else None
