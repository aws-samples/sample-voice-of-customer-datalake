"""The leadership view's read (7.70.00, docs/leadership-view.md), included by ``api/metrics_handler.py``:

    GET /metrics/adoption?from=YYYY-MM&to=YYYY-MM&grain=month|quarter
        -> {scope, grain, from, to, as_of, complete, covered_from, agent_runs_counted, periods, totals, time_saved}

On the metrics proxy (no new API Gateway resource). With ``X-Workspace-Id`` the workspace's own view, for its admins (a
member admin, or a platform admin who entered, audited: shared/request_workspace.py); without it the deployment's, for
the deployment's ``admins`` and for a platform admin (live-checked). A delegated caller reads only the deployment's
view, and only through the MCP tool ``insights_get_adoption``, which the MCP Lambda offers to a token an administrator
minted and clears per call with its live admin check (``project_access.delegated_agent_run_allowed``, the claim it adds
to an ``admin_only`` tool's call); in a workspace a credential is never an admin (shared/workspace.py), so it is
refused there. Read-only: the newest rollup item of the scope and its baselines row (shared/adoption.py), never a
project, a feedback item or a person. The answer holds counts only, no per-person figure (owner decision 11).
"""
from __future__ import annotations

from collections.abc import Callable
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Any, Final

from aws_lambda_powertools.event_handler.api_gateway import Router
from botocore.exceptions import BotoCoreError, ClientError

from shared.adoption import ADOPTION_KIND, DEPLOYMENT_KEY, rollup_partition
from shared.adoption_view import adoption_view, parse_range
from shared.api import get_caller_groups
from shared.exceptions import AuthorizationError, ServiceError
from shared.ingest_tables import table_view
from shared.logging import logger, tracer
from shared.platform_admin import is_platform_admin
from shared.platform_admin_gate import confirm_live_platform_admin
from shared.project_access import ADMIN_GROUP, claims_from_event, delegated_agent_run_allowed
from shared.project_gate import caller_from_event
from shared.request_workspace import request_workspace
from shared.tables import configured_table
from shared.workspace import WorkspaceContext, require_workspace_admin
from shared.workspace_config import get_config_item
from shared.ws_repo import optional_scope

if TYPE_CHECKING:
    from shared.ws_repo import WorkspaceScope

__all__ = ['app', 'bind_aggregates_table']

app = Router()
#: voc-aggregates as the including handler holds it (``bind_aggregates_table``: the metrics handler's own table).
_bound: list[Callable[[], Any]] = []

FAILED_READ: Final = 'Failed to read the leadership view'
ADMINS_ONLY: Final = 'The leadership view is for administrators'
DELEGATED_REFUSED: Final = ("The leadership view reaches a credential only through insights_get_adoption, on a token "
                            'an administrator minted, outside a workspace')


def bind_aggregates_table(getter: Callable[[], Any]) -> None:
    """Read voc-aggregates through ``getter`` (the including handler's table, read at call time)."""
    _bound[:] = [getter]


def require_adoption_reader(event: dict, context: WorkspaceContext | None) -> None:
    """403 unless the caller may read the scope's leadership view (see the module docstring)."""
    if caller_from_event(event).delegated:
        if context is None and delegated_agent_run_allowed(claims_from_event(event)):
            return
        raise AuthorizationError(DELEGATED_REFUSED)
    if context is not None:
        require_workspace_admin(context)
        return
    if ADMIN_GROUP in get_caller_groups(event):
        return
    try:
        if is_platform_admin(event) and confirm_live_platform_admin(event):
            return
    except (ClientError, BotoCoreError) as exc:
        logger.exception('Platform admin check failed for the leadership view')
        raise ServiceError(FAILED_READ) from exc
    raise AuthorizationError(ADMINS_ONLY)


def _newest_rollup(table: Any, scope: WorkspaceScope | None) -> dict[str, Any] | None:
    """The scope's newest rollup item (its sort key is the day it was rolled up), None before the first."""
    page = table_view(scope, table).query('pk', rollup_partition(scope), ScanIndexForward=False, Limit=1)
    items = page.get('Items') or []
    return dict(items[0]) if items and isinstance(items[0], dict) else None


@app.get('/metrics/adoption')
@tracer.capture_method
def get_adoption():
    """The scope's leadership view for a range of months (shared/adoption_view.py)."""
    event = app.current_event.raw_event
    context = request_workspace(event, FAILED_READ)
    require_adoption_reader(event, context)
    chosen = parse_range(app.current_event.query_string_parameters or {}, datetime.now(UTC).date())
    scope = optional_scope(context)
    table = configured_table(_bound[0]() if _bound else None, 'Aggregates')
    try:
        item = _newest_rollup(table, scope)
        settings_row = get_config_item(table, ADOPTION_KIND, DEPLOYMENT_KEY, scope, consistent=False)
    except (ClientError, BotoCoreError) as exc:
        logger.exception('Leadership view read failed')
        raise ServiceError(FAILED_READ) from exc
    logger.info('Leadership view read', extra={'months': len(chosen.months), 'grain': chosen.grain,
                                                'in_workspace': scope is not None, 'rolled_up': item is not None})
    return adoption_view(item, settings_row, chosen, scope='deployment' if scope is None else 'workspace')
