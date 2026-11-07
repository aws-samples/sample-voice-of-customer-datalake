"""The building blocks of the GLOBAL MCP server's tools (shared/mcp_global_tools.py, docs/mcp.md).

The tool dataclasses, the argument readers every tool validates with, and the
projections that drop storage keys and signed URLs. Split out of the catalogue
so the catalogue modules (``mcp_global_tools`` and ``mcp_global_tools_steps``)
share one copy.
"""

from __future__ import annotations

from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from typing import Any, Final

from shared import mcp_global_tokens as gt

DOMAIN_METRICS: Final = 'metrics'
DOMAIN_SETTINGS: Final = 'settings'
DOMAIN_MEMORY: Final = 'memory'
DOMAIN_PROJECTS: Final = 'projects'
DOMAIN_AGENTS: Final = 'agents'
DOMAIN_ENGAGEMENT: Final = 'engagement'
DOMAIN_RADAR: Final = 'radar'
DOMAIN_FEEDBACK_EDIT: Final = 'feedback_edit'
DOMAIN_INTEGRATIONS: Final = 'integrations'

# Keys never forwarded to an MCP client: storage keys, index keys, and anything
# carrying a signed URL.
_HIDDEN_KEYS: Final = frozenset({'pk', 'sk', 'gsi1pk', 'gsi1sk', 'gsi2pk', 'gsi2sk', 'secret_hash',
                                 'kiro_default_export_prompt', 'kiro_export_prompt'})


class InvalidToolArgument(ValueError):
    """The arguments do not satisfy the tool's contract; a tool error the model can fix."""


@dataclass(frozen=True)
class RouteRequest:
    """The route a tool call becomes, before a function name and claims are attached."""

    domain: str
    method: str
    path: str
    query: dict[str, Any] = field(default_factory=dict)
    body: dict | None = None


def _unchanged(payload: Any, _args: Mapping[str, Any]) -> Any:
    return payload


@dataclass(frozen=True)
class FollowUp:
    """A second read whose shaped answer joins a successful tool result under ``key``.

    Best effort: the handler records a refusal or fault as ``{key}_error`` and keeps the main result.
    """

    key: str
    request: RouteRequest
    shape: Callable[[Any], Any]


def _no_follow_ups(_args: Mapping[str, Any]) -> tuple[FollowUp, ...]:
    return ()


@dataclass(frozen=True)
class GlobalTool:
    name: str
    title: str
    description: str
    input_schema: dict
    build: Callable[[Mapping[str, Any], str | None], RouteRequest]
    shape: Callable[[Any, Mapping[str, Any]], Any] = _unchanged
    write: bool = False
    admin_only: bool = False
    # Takes a `project_id` argument; a pinned token's pin applies (and defaults it).
    project_scoped: bool = False
    # Extra reads after the main route answered (validated by ``build`` first).
    follow_ups: Callable[[Mapping[str, Any]], tuple[FollowUp, ...]] = _no_follow_ups
    # A feedback-board route (`/feature-requests/*`): the delegated claims also carry the app pool's
    # issuer and a verified service address (``board_route_claims``), which the board scope reads.
    board_route: bool = False
    # Reaches data of every project the minter can view (not one project): refused to a project-pinned token.
    workspace_wide: bool = False

    def declaration(self) -> dict:
        """The tool as `tools/list` publishes it.

        Only the hints that differ from the MCP defaults or carry meaning are published, which keeps
        `tools/list` inside its context budget (test_mcp_global_tools_budget.py):
        ``destructiveHint: false`` on write tools only (the spec defines it only when ``readOnlyHint``
        is false; its default is true); the idempotent hint never (false, its default, on a write; undefined
        on a read); ``openWorldHint: false`` always (default true). The display name is the top-level
        ``title``: every protocol version this server negotiates that knows annotations also knows it,
        and the spec reads it before ``annotations.title``.
        """
        annotations: dict[str, Any] = {'readOnlyHint': not self.write}
        if self.write:
            annotations['destructiveHint'] = False
        annotations['openWorldHint'] = False
        return {
            'name': self.name,
            'title': self.title,
            'description': self.description,
            'inputSchema': self.input_schema,
            'annotations': annotations,
        }


# ── Argument readers ────────────────────────────────────────────────────────
def int_arg(args: Mapping[str, Any], name: str, *, default: int, low: int, high: int) -> int:
    value = args.get(name, default)
    if isinstance(value, bool) or not isinstance(value, int) or not low <= value <= high:
        raise InvalidToolArgument(f'{name} must be an integer between {low} and {high}')
    return value


def text_arg(args: Mapping[str, Any], name: str, *, max_length: int, required: bool = False) -> str | None:
    """A trimmed string argument; absent or blank is None unless ``required``."""
    value = args.get(name)
    if value is not None and not isinstance(value, str):
        raise InvalidToolArgument(f'{name} must be a string')
    text = (value or '').strip()
    if not text:
        if required:
            raise InvalidToolArgument(f'{name} is required')
        return None
    if len(text) > max_length:
        raise InvalidToolArgument(f'{name} must be at most {max_length} characters')
    return text


def bool_arg(args: Mapping[str, Any], name: str) -> bool:
    value = args.get(name, False)
    if not isinstance(value, bool):
        raise InvalidToolArgument(f'{name} must be true or false')
    return value


def id_arg(args: Mapping[str, Any], name: str) -> str:
    value = args.get(name)
    if not gt.is_path_id(value):
        raise InvalidToolArgument(f'{name} is required and must be an id (letters, digits, _ and -)')
    return str(value)


def require_project(project_id: str | None) -> str:
    if not project_id:
        raise InvalidToolArgument('project_id is required')
    return project_id


def schema(properties: dict, required: tuple[str, ...] = ()) -> dict:
    schema: dict[str, Any] = {'type': 'object', 'properties': properties, 'additionalProperties': False}
    if required:
        schema['required'] = list(required)
    return schema


BOOL_SCHEMA = {'type': 'boolean', 'default': False}
ID_SCHEMA = {'type': 'string', 'pattern': '^[A-Za-z0-9_-]{1,128}$'}
PROJECT_ID_SCHEMA = {**ID_SCHEMA, 'description': 'Optional with a pinned token.'}


# ── Projections ─────────────────────────────────────────────────────────────
def public(row: object) -> dict:
    """A row without storage keys and without any signed URL."""
    if not isinstance(row, Mapping):
        return {}
    return {key: value for key, value in row.items()
            if key not in _HIDDEN_KEYS and 'url' not in key.lower()}


def rows_at(payload: object, key: str) -> list:
    value = payload.get(key) if isinstance(payload, Mapping) else None
    return value if isinstance(value, list) else []


def public_value(value: object) -> object:
    """A list of rows loses its rows' hidden keys; anything else passes through."""
    if isinstance(value, list) and all(isinstance(v, Mapping) for v in value):
        return [public(v) for v in value]
    return value


def stripped(payload: object, _args: Mapping[str, Any]) -> object:
    """The route body without hidden keys, one level of row lists deep."""
    if not isinstance(payload, Mapping):
        return payload
    return {key: public_value(value) for key, value in public(payload).items()}
