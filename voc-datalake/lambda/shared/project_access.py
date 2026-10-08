"""Per-project access control: visibility, ownership and invited members.

This module is the ONE place that decides who may do what to a project. It is
pure (no AWS clients) so every caller — the projects API middleware, the list
filter, the chat-context route the streaming assistant reads through, and the
MCP delegation path — reaches the same answer from the same META item.

Model (stored on the project's ``META`` item):

- ``owner_sub`` / ``owner_username`` / ``owner_email`` — the creator. Display
  fields are captured at write time; only ``owner_sub`` is ever compared.
- ``visibility`` — ``'public'`` (every signed-in user may view AND edit, which
  is the pre-permissions behaviour) or ``'private'`` (owner, invited members
  and workspace admins only).
- ``members`` — a map ``{cognito_sub: {role, username, email, added_by,
  added_at}}`` with ``role`` in ``{'viewer', 'editor'}``.

Levels, from least to most privileged: ``view`` < ``edit`` < ``manage``.
``manage`` (change visibility, invite/remove members, transfer ownership,
delete the project) belongs to the owner and to workspace admins only.

Legacy projects created before this module have no ``visibility`` and no
``owner_sub``. They read as PUBLIC, so nobody loses access on deploy, and only
an admin can manage them until an admin transfers ownership to someone.

Identity is the Cognito ``sub``. The streaming assistant forwards the caller's
own claims, so the assistant can never see or touch more than the person
chatting with it. An MCP credential arrives with the synthetic subject
``mcp:{token_id}``; it acts as the user who minted it (``voc:acting_subject``),
never as an admin, and never above ``edit``.

An autonomous agent arrives the same way with ``agent:{agent_id}``: it acts as
the agent's OWNER (``voc:acting_subject``), never as an admin, never above
``edit``. Two things only an agent principal may additionally do, both carried
as claims the agents runtime sets on a direct (IAM-authorised) invoke:

- create a project owned by somebody else (``voc:agent_owner_sub`` — the
  category owner the run hands off to) with invited editors
  (``voc:agent_editor_subs``); the project records ``created_by_agent``;
- keep EDIT on the projects it created (``created_by_agent`` equals its agent
  id) even though its acting owner is not a member of them.

API Gateway builds ``requestContext.authorizer.claims`` from the verified JWT
alone, so none of these claims can be produced by a browser.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any, Final

VISIBILITY_PUBLIC: Final = 'public'
VISIBILITY_PRIVATE: Final = 'private'
VISIBILITIES: Final = frozenset({VISIBILITY_PUBLIC, VISIBILITY_PRIVATE})
# New projects are private unless the creator chooses otherwise: the safe
# default for anything that may hold customer verbatims.
DEFAULT_NEW_PROJECT_VISIBILITY: Final = VISIBILITY_PRIVATE

ROLE_VIEWER: Final = 'viewer'
ROLE_EDITOR: Final = 'editor'
ROLE_OWNER: Final = 'owner'
ROLE_ADMIN: Final = 'admin'
MEMBER_ROLES: Final = frozenset({ROLE_VIEWER, ROLE_EDITOR})

LEVEL_VIEW: Final = 'view'
LEVEL_EDIT: Final = 'edit'
LEVEL_MANAGE: Final = 'manage'
_LEVEL_RANK: Final = {
    LEVEL_VIEW: 1,
    LEVEL_EDIT: 2,
    # Only the order matters; any rank above edit's is the same policy.
    LEVEL_MANAGE: 3,  # pragma: no mutate
}
_ROLE_LEVEL: Final = {
    ROLE_VIEWER: LEVEL_VIEW,
    ROLE_EDITOR: LEVEL_EDIT,
    ROLE_OWNER: LEVEL_MANAGE,
    ROLE_ADMIN: LEVEL_MANAGE,
}

MAX_PROJECT_MEMBERS: Final = 100

# Must equal shared.mcp_delegate.SYNTHETIC_SUBJECT_PREFIX (pinned by a test).
# Duplicated rather than imported so this module stays dependency-free.
DELEGATED_SUBJECT_PREFIX: Final = 'mcp:'
# Claim the MCP Lambda sets to the minting user's sub. Honoured ONLY when the
# subject carries the delegated prefix, which a Cognito sub (a UUID) never does,
# and which only an IAM-authorised direct invoke can produce — API Gateway
# builds `requestContext.authorizer.claims` from the verified JWT alone.
ACTING_SUBJECT_CLAIM: Final = 'voc:acting_subject'
# Claim the GLOBAL MCP Lambda (api/mcp_global_handler.py) adds to exactly one kind
# of delegated call: `run_agent`, after it has verified, per call, that the token is
# a write token minted by an administrator who is STILL an administrator in
# Cognito. Honoured only beside a delegated `mcp:` subject acting for a person (see
# delegated_agent_run_allowed) — API Gateway never produces either from a JWT.
MCP_AGENT_RUN_CLAIM: Final = 'voc:mcp_agent_run'
ADMIN_GROUP: Final = 'admins'

# The autonomous-agent principal (see the module docstring). Like the MCP
# prefix, it can never collide with a Cognito sub (a UUID).
AGENT_SUBJECT_PREFIX: Final = 'agent:'
# Every synthetic subject namespace. A synthetic subject never owns, is never a
# member, and is never what another synthetic principal acts as.
SYNTHETIC_SUBJECT_PREFIXES: Final = (DELEGATED_SUBJECT_PREFIX, AGENT_SUBJECT_PREFIX)
# Honoured ONLY for an `agent:` subject, and only by project creation.
AGENT_OWNER_CLAIM: Final = 'voc:agent_owner_sub'
AGENT_EDITORS_CLAIM: Final = 'voc:agent_editor_subs'  # comma-separated subs
MAX_AGENT_EDITORS: Final = 10
# META attribute recording the agent that created a project. Written only by
# create_project for an agent principal; update_project's allowlist never sets it.
CREATED_BY_AGENT_ATTRIBUTE: Final = 'created_by_agent'
_MAX_AGENT_ID_LENGTH: Final = 64


def is_synthetic_subject(sub: object) -> bool:
    """True for a service subject (``mcp:`` / ``agent:``), never a person."""
    return isinstance(sub, str) and sub.startswith(SYNTHETIC_SUBJECT_PREFIXES)

# META attributes this module reads. Exposed so readers can project only these.
ACCESS_ATTRIBUTES: Final = (
    'owner_sub', 'owner_username', 'owner_email', 'visibility', 'members',
    CREATED_BY_AGENT_ATTRIBUTE,
)
# `pk` is projected so a legacy META carrying none of the access attributes still
# comes back as a non-empty item (an empty projection reads as "missing").
_GATE_PROJECTION: Final = ', '.join(['pk', *ACCESS_ATTRIBUTES, '#status', '#deleting'])


def meta_gate_read(project_id: str, deletion_attribute: str) -> dict[str, Any]:
    """``get_item`` kwargs for the strongly consistent META read an access gate makes.

    Shared by every Lambda that gates on a project (projects API, ballots), so
    they read the same attributes the same way. ``deletion_attribute`` is passed
    in to keep this module free of imports.
    """
    return {
        'Key': {'pk': f'PROJECT#{project_id}', 'sk': 'META'},
        'ConsistentRead': True,
        'ProjectionExpression': _GATE_PROJECTION,
        'ExpressionAttributeNames': {
            '#status': 'status',
            '#deleting': deletion_attribute,
        },
    }


@dataclass(frozen=True)
class Caller:
    """The authenticated principal a request is evaluated for.

    ``subject`` is the Cognito sub permissions are evaluated against. For an MCP
    credential it is the minter's sub (or ``''`` when the token predates
    ``created_by``, which leaves only public projects reachable).
    """

    subject: str
    is_admin: bool = False
    username: str = ''
    email: str = ''
    delegated: bool = False
    # Set only for an `agent:` principal (see caller_from_claims).
    agent_id: str = ''
    agent_owner_sub: str = ''
    agent_editor_subs: tuple[str, ...] = ()


@dataclass(frozen=True)
class ProjectAccess:
    """The caller's effective permissions on one project."""

    role: str | None

    @property
    def level(self) -> str | None:
        return _ROLE_LEVEL.get(self.role) if self.role else None

    def allows(self, level: str) -> bool:
        mine = self.level
        return mine is not None and _LEVEL_RANK[mine] >= _LEVEL_RANK[level]

    @property
    def can_view(self) -> bool:
        return self.allows(LEVEL_VIEW)

    @property
    def can_edit(self) -> bool:
        return self.allows(LEVEL_EDIT)

    @property
    def can_manage(self) -> bool:
        return self.allows(LEVEL_MANAGE)

    def to_dict(self) -> dict[str, Any]:
        return {
            'role': self.role,
            'can_view': self.can_view,
            'can_edit': self.can_edit,
            'can_manage': self.can_manage,
        }


def _claim(claims: Mapping[str, Any], key: str) -> str:
    value = claims.get(key)
    return value.strip() if isinstance(value, str) else ''


def claims_from_event(event: Mapping[str, Any]) -> Mapping[str, Any]:
    """The API Gateway authorizer claims, or ``{}`` for any malformed shape."""
    request_context = event.get('requestContext')
    authorizer = request_context.get('authorizer') if isinstance(request_context, Mapping) else None
    claims = authorizer.get('claims') if isinstance(authorizer, Mapping) else None
    return claims if isinstance(claims, Mapping) else {}


def caller_from_claims(
    claims: Mapping[str, Any], groups: list[str],
) -> Caller:
    """Build a Caller from authorizer claims plus already-parsed groups.

    Raises ValueError when there is no subject at all; callers translate that
    into their own fail-closed error (the API layer already refused a blank sub
    before reaching here).
    """
    sub = _claim(claims, 'sub')
    if not sub:
        raise ValueError('caller has no subject')
    if sub.startswith(AGENT_SUBJECT_PREFIX):
        return _agent_caller(claims, sub[len(AGENT_SUBJECT_PREFIX):])
    if sub.startswith(DELEGATED_SUBJECT_PREFIX):
        acting = _claim(claims, ACTING_SUBJECT_CLAIM)
        if is_synthetic_subject(acting):
            acting = ''  # a credential can never act as another credential
        return Caller(subject=acting, is_admin=False, delegated=True)
    return Caller(
        subject=sub,
        is_admin=ADMIN_GROUP in groups,
        username=_claim(claims, 'cognito:username') or _claim(claims, 'username'),
        email=_claim(claims, 'email'),
    )


def _human_sub(value: str) -> str:
    """``value`` when it can name a person, else ``''`` (blank or synthetic)."""
    return '' if not value or is_synthetic_subject(value) else value


def delegated_agent_run_allowed(claims: Mapping[str, Any]) -> bool:
    """True for a global-MCP ``run_agent`` call the MCP Lambda has cleared.

    The ONE delegated path to an admin-only action, and deliberately narrow: an
    ``mcp:`` subject, acting for a real person, carrying ``MCP_AGENT_RUN_CLAIM``
    exactly ``'true'``. The claim is never forwarded from a request; the MCP Lambda
    adds it from the stored token row after its own per-call admin check.
    """
    return (
        _claim(claims, 'sub').startswith(DELEGATED_SUBJECT_PREFIX)
        and _claim(claims, MCP_AGENT_RUN_CLAIM) == 'true'
        and bool(_human_sub(_claim(claims, ACTING_SUBJECT_CLAIM)))
    )


def _agent_caller(claims: Mapping[str, Any], agent_id: str) -> Caller:
    """An ``agent:{agent_id}`` principal: acts as its owner, never admin.

    Groups are ignored entirely (an agent never administers). The owner and
    editor claims are dropped when they name a synthetic subject, so an agent
    can never hand a project to a credential or to another agent.
    """
    if not agent_id or len(agent_id) > _MAX_AGENT_ID_LENGTH or ',' in agent_id:
        raise ValueError('agent principal has no usable agent id')
    editors: list[str] = []
    for raw in _claim(claims, AGENT_EDITORS_CLAIM).split(','):
        sub = _human_sub(raw.strip())
        if sub and sub not in editors:
            editors.append(sub)
    return Caller(
        subject=_human_sub(_claim(claims, ACTING_SUBJECT_CLAIM)),
        is_admin=False,
        delegated=True,
        agent_id=agent_id,
        agent_owner_sub=_human_sub(_claim(claims, AGENT_OWNER_CLAIM)),
        agent_editor_subs=tuple(editors[:MAX_AGENT_EDITORS]),
    )


def project_visibility(meta: Mapping[str, Any]) -> str:
    """Stored visibility, with legacy (absent/unknown) projects reading public."""
    value = meta.get('visibility')
    return value if value in VISIBILITIES else VISIBILITY_PUBLIC


def project_members(meta: Mapping[str, Any]) -> dict[str, dict[str, Any]]:
    """The members map, dropping malformed entries rather than trusting them."""
    raw = meta.get('members')
    if not isinstance(raw, Mapping):
        return {}
    members: dict[str, dict[str, Any]] = {}
    for sub, entry in raw.items():
        if (
            isinstance(sub, str) and sub
            and isinstance(entry, Mapping)
            and entry.get('role') in MEMBER_ROLES
        ):
            members[sub] = dict(entry)
    return members


def resolve_access(meta: Mapping[str, Any] | None, caller: Caller) -> ProjectAccess:
    """Effective access for ``caller`` on the project described by ``meta``.

    ``meta`` of None (missing project) yields no access; existence checks and
    tombstones are the caller's concern so this stays a pure policy function.
    """
    if not meta:
        return ProjectAccess(role=None)
    role = _base_role(meta, caller)
    if caller.delegated and role in (ROLE_OWNER, ROLE_ADMIN):
        # A bearer credential acts for its minter but never administers.
        role = ROLE_EDITOR
    return ProjectAccess(role=role)


def _base_role(meta: Mapping[str, Any], caller: Caller) -> str | None:
    subject = caller.subject
    owner = meta.get('owner_sub')
    if subject and isinstance(owner, str) and owner == subject:
        return ROLE_OWNER
    if caller.is_admin:
        return ROLE_ADMIN
    if caller.agent_id and meta.get(CREATED_BY_AGENT_ATTRIBUTE) == caller.agent_id:
        # The agent keeps working on what it created after handing it off.
        return ROLE_EDITOR
    if project_visibility(meta) == VISIBILITY_PUBLIC:
        # Public grants edit to every signed-in user; membership cannot lower it.
        return ROLE_EDITOR
    member = project_members(meta).get(subject) if subject else None
    return member.get('role') if member else None


def public_owner(meta: Mapping[str, Any]) -> dict[str, str] | None:
    owner = meta.get('owner_sub')
    if not isinstance(owner, str) or not owner:
        return None
    return {
        'sub': owner,
        'username': str(meta.get('owner_username') or ''),
        'email': str(meta.get('owner_email') or ''),
    }


def public_members(meta: Mapping[str, Any]) -> list[dict[str, Any]]:
    """Members as a stable, client-facing list (sorted by username then sub)."""
    rows = [
        {
            'sub': sub,
            'role': entry['role'],
            'username': str(entry.get('username') or ''),
            'email': str(entry.get('email') or ''),
            'added_by': str(entry.get('added_by') or ''),
            'added_at': str(entry.get('added_at') or ''),
        }
        for sub, entry in project_members(meta).items()
    ]
    return sorted(rows, key=lambda row: (row['username'].lower(), row['sub']))


def sharing_summary(meta: Mapping[str, Any], caller: Caller) -> dict[str, Any]:
    """Computed, never-stored fields every project read attaches to META."""
    return {
        'visibility': project_visibility(meta),
        'owner': public_owner(meta),
        'access': resolve_access(meta, caller).to_dict(),
        'member_count': len(project_members(meta)),
    }


def owner_attributes(caller: Caller) -> dict[str, str]:
    """META attributes recording ``caller`` as a new project's owner."""
    if not caller.subject or caller.delegated:
        raise ValueError('only a signed-in user can own a project')
    return {
        'owner_sub': caller.subject,
        'owner_username': caller.username,
        'owner_email': caller.email,
    }


def agent_project_owner_sub(caller: Caller) -> str:
    """Who owns a project an agent principal creates.

    The handoff target (``voc:agent_owner_sub``) when given, else the agent's
    owner (the acting subject). Raises ValueError for any non-agent caller or
    when neither names a person — the caller translates that into a refusal.
    """
    if not caller.agent_id:
        raise ValueError('only an agent principal may name a project owner')
    owner = caller.agent_owner_sub or caller.subject
    if not owner:
        raise ValueError('agent principal has no owner to hand the project to')
    return owner


def validate_visibility(value: object) -> str:
    if value not in VISIBILITIES:
        raise ValueError("visibility must be 'public' or 'private'")
    return str(value)


def validate_member_role(value: object) -> str:
    if value not in MEMBER_ROLES:
        raise ValueError("role must be 'viewer' or 'editor'")
    return str(value)


# --------------------------------------------------------------------------
# Route policy: which level each /projects/{id}/... route requires.
# --------------------------------------------------------------------------

# First path segments under /projects that are NOT project ids. These routes are
# workspace-wide and keep their own checks (prioritization uses require_admin
# and per-reviewer subjects).
NON_PROJECT_SEGMENTS: Final = frozenset({'prioritization'})

# (method, sub-path after /projects/{id}, level). `*` matches one segment.
# Anything not listed falls back to: GET -> view, everything else -> edit.
# Listing a route here is how a write-looking route is declared read-only, or a
# write is promoted to manage.
_ROUTE_OVERRIDES: Final = (
    ('POST', ('chat-context',), LEVEL_VIEW),
    ('DELETE', (), LEVEL_MANAGE),
    ('PUT', ('visibility',), LEVEL_MANAGE),
    ('POST', ('owner',), LEVEL_MANAGE),
    ('GET', ('members', 'candidates'), LEVEL_MANAGE),
    ('POST', ('members',), LEVEL_MANAGE),
    ('PUT', ('members', '*'), LEVEL_MANAGE),
    # Removing a member is manage, EXCEPT a member leaving on their own; the
    # route enforces that distinction, so the gate only requires view here.
    ('DELETE', ('members', '*'), LEVEL_VIEW),
)


def project_route(path: str) -> tuple[str, tuple[str, ...]] | None:
    """Split ``/projects/{id}/a/b`` into ``(id, ('a', 'b'))``.

    Returns None for paths that do not address one project (the collection,
    the reserved workspace routes, anything outside /projects).
    """
    segments = [part for part in path.split('/') if part]
    if len(segments) < 2 or segments[0] != 'projects':
        return None
    project_id = segments[1]
    if project_id in NON_PROJECT_SEGMENTS:
        return None
    return project_id, tuple(segments[2:])


def required_level(method: str, rest: tuple[str, ...]) -> str:
    method = method.upper()
    for override_method, pattern, level in _ROUTE_OVERRIDES:
        # Lengths are equal by the check just before, so strict= cannot fire.
        if override_method == method and len(pattern) == len(rest) and all(
            want in ('*', got) for want, got in zip(pattern, rest, strict=True)  # pragma: no mutate
        ):
            return level
    return LEVEL_VIEW if method in ('GET', 'HEAD') else LEVEL_EDIT
