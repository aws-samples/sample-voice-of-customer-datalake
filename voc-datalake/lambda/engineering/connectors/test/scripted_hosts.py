"""A scripted host for the connectors' HTTPS clients (``transport.Transport``): its JSON answers, given in turn, and
every request it was sent. Shared by the App tokens', the GitHub Apps' and the user authorizations' suites."""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any

from engineering.connectors.transport import Response


def answer(status: int = 200, data: object = None) -> Response:
    """A host's JSON answer."""
    return Response(status=status, headers={}, body=json.dumps(data).encode())


@dataclass
class ScriptedHost:
    """The answers in turn (an exception is raised; the last one is given again once it alone is left), every request
    recorded as ``(method, path, headers, body)``."""

    answers: list[Response | Exception] = field(default_factory=list)
    sent: list[tuple[str, str, dict[str, str], bytes | None]] = field(default_factory=list)

    def request(self, method: str, path: str, headers: Any, body: bytes | None) -> Response:
        self.sent.append((method, path, dict(headers), body))
        found = self.answers.pop(0) if len(self.answers) > 1 else self.answers[0]
        if isinstance(found, Exception):
            raise found
        return found
