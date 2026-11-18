"""A route's own JSON answer and its query text, the same way in every Agents API router (agents_handler.py and the
``agents_engineering_*_routes`` modules it includes). Lives in ``shared/`` because ``shared/`` ships with every API
bundle."""
from __future__ import annotations

import json
from collections.abc import Mapping
from typing import Any

from aws_lambda_powertools.event_handler import Response, content_types


def json_response(status: int, body: Mapping[str, Any] | list[Any]) -> Response:
    """``body`` as the route's JSON answer, with ``status``."""
    return Response(status_code=status, content_type=content_types.APPLICATION_JSON, body=json.dumps(body))


def query_text(event: Any, name: str) -> str | None:
    """The request's ``name`` query parameter, None when it is absent."""
    value = (event.query_string_parameters or {}).get(name)
    return value if isinstance(value, str) else None
