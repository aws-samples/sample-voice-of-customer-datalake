"""Who is calling the engagement API.

``/participants/*`` sits behind the main Cognito authorizer (the app pool only), so
its callers are app users: ``shared.project_gate.caller_from_event`` as everywhere.

``/feature-requests/*`` sits behind the BOARD authorizer, which accepts the app pool
AND the board's own pool (docs/feature-requests.md -> Sign-in). The pool is read from
the verified ``iss`` claim; the caller is the lower-cased ``email`` claim, which must
be verified. Only an app-pool caller in ``admins`` is a board admin: a board-pool
token is never admin, whatever groups it claims. A board token cannot reach any
other route at all, because every other authorizer knows the app pool only.
"""
from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any, Final

from shared import engagement_config
from shared.api import is_admin
from shared.engagement_common import normalize_email
from shared.exceptions import AuthorizationError, ConfigurationError, NotFoundError
from shared.project_access import LEVEL_VIEW, claim_text, claims_from_event
from shared.project_gate import PROJECT_NOT_FOUND, caller_from_event, read_gate_meta, require_project_level
from shared.project_writes import is_project_tombstone
from shared.row_ids import OPAQUE_ID_RE
from shared.tables import get_projects_table

POOL_APP: Final = 'app'
POOL_BOARD: Final = 'board'
_ISSUER_PREFIX: Final = 'https://cognito-idp.'
MAX_NAME_CHARS: Final = 160
ADMIN_REQUIRED: Final = 'Only an administrator can do this'


@dataclass(frozen=True)
class BoardViewer:
    email: str
    name: str
    pool: str
    is_admin: bool
    subject: str

    def view(self) -> dict[str, Any]:
        return {'email': self.email, 'name': self.name, 'is_admin': self.is_admin, 'pool': self.pool}


def issuer_pool(issuer: str) -> str | None:
    """``'app'`` / ``'board'`` for a Cognito issuer of this deployment's pools, else None."""
    if not issuer.startswith(_ISSUER_PREFIX) or '/' not in issuer:
        return None
    pool_id = issuer.rsplit('/', 1)[-1]
    if pool_id and pool_id == engagement_config.app_pool_id():
        return POOL_APP
    if pool_id and pool_id == engagement_config.board_pool_id():
        return POOL_BOARD
    return None


def is_verified(value: object) -> bool:
    """API Gateway hands claims over as strings: ``'true'``; a raw JWT has ``True``."""
    return value is True or (isinstance(value, str) and value.strip().lower() == 'true')


def board_viewer(event: Mapping[str, Any]) -> BoardViewer:
    """The board caller, or 403 (unknown pool, no email, unverified email)."""
    claims = claims_from_event(event)
    pool = issuer_pool(claim_text(claims, 'iss'))
    if pool is None:
        raise AuthorizationError('This sign-in is not accepted here')
    try:
        _, email_lc = normalize_email(claims.get('email'))
    except ValueError as exc:
        raise AuthorizationError('Your sign-in has no email address') from exc
    if not is_verified(claims.get('email_verified')):
        raise AuthorizationError('Your email address is not verified')
    return BoardViewer(
        email=email_lc,
        name=claim_text(claims, 'name')[:MAX_NAME_CHARS],
        pool=pool,
        is_admin=pool == POOL_APP and is_admin(dict(event)),
        subject=claim_text(claims, 'sub'),
    )


def require_board_admin(event: Mapping[str, Any]) -> BoardViewer:
    """The board caller, or 403 unless they are a board admin (an app-pool admin). A shared admin
    gate: ``lambda/api/test/test_route_admin_gates.py`` lists it with ``require_admin``."""
    viewer = board_viewer(event)
    if not viewer.is_admin:
        raise AuthorizationError(ADMIN_REQUIRED)
    return viewer


def verified_email(event: Mapping[str, Any]) -> str:
    """An app caller's email when Cognito verified it, else '' (the ask's Reply-To)."""
    claims = claims_from_event(event)
    if not is_verified(claims.get('email_verified')):
        return ''
    try:
        email, _ = normalize_email(claims.get('email'))
    except ValueError:
        return ''
    return email




def require_project_access(event: Mapping[str, Any], project_id: object, level: str) -> str:
    """The project id when the app caller has ``level`` on it (404 without view, 403 without the level)."""
    if not isinstance(project_id, str) or not OPAQUE_ID_RE.match(project_id):
        raise NotFoundError(PROJECT_NOT_FOUND)
    table = get_projects_table()
    if table is None:
        raise ConfigurationError('PROJECTS_TABLE not configured')
    # Read even for an admin (the gate skips the read for them): a missing project is never linked.
    meta = read_gate_meta(table, project_id)
    if meta is None or is_project_tombstone(meta):
        raise NotFoundError(PROJECT_NOT_FOUND)
    require_project_level(lambda: meta, caller_from_event(event), level)
    return project_id


def can_view_project(event: Mapping[str, Any], project_id: str) -> bool:
    try:
        require_project_access(event, project_id, LEVEL_VIEW)
    except (NotFoundError, AuthorizationError):
        return False
    return True
