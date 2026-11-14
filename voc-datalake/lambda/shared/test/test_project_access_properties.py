"""Property tests of who may do what to a project (shared/project_access.py).

The access decision is the one place a wrong answer leaks a project: a bearer token that administers,
a viewer who edits, a private project a stranger can see. These check the policy over many projects,
members and callers, in words a person would use:

- A token acts for its minter and never administers; a project's owner keeps owning it.
- A public project is editable by every signed-in person, and a private one is only as open as its
  owner, its admins, its agents and its listed members make it; a listed member never gets more than
  the role recorded for them.
- A route that writes is edit by default; a read is view by default; a write under the project that
  deletes it, changes its visibility or its members is manage.
- A project id survives the trip through the route's path, and a role or visibility is accepted only
  when it is one of the named values.
"""
from __future__ import annotations

import pytest
from hypothesis import assume, given
from hypothesis import strategies as st

from shared import project_access as pa
from shared.test.property_settings import PROPERTY

SUBJECTS = st.sampled_from(['sub-ada', 'sub-bo', 'sub-cy', 'sub-dee', 'sub-eve'])
ROLES = st.sampled_from([pa.ROLE_VIEWER, pa.ROLE_EDITOR])
SEGMENTS = st.sampled_from(['members', 'candidates', 'visibility', 'owner', 'documents', 'comments', 'x-1'])


@st.composite
def member_maps(draw) -> dict:
    """A members map as stored: mostly well-formed entries, sometimes a malformed one (a bad role, a
    non-object entry, an empty subject) that the reader must drop rather than trust."""
    members = {}
    for sub in draw(st.lists(SUBJECTS, max_size=4, unique=True)):
        shape = draw(st.sampled_from(['ok', 'ok', 'bad-role', 'not-object']))
        if shape == 'ok':
            members[sub] = {'role': draw(ROLES), 'username': 'Member', 'email': 'member@example.com'}
        elif shape == 'bad-role':
            members[sub] = {'role': draw(st.sampled_from(['owner', 'admin', 'manager', '']))}
        else:
            members[sub] = 'editor'
    if draw(st.booleans()):
        members[''] = {'role': pa.ROLE_EDITOR}
    return members


@st.composite
def projects(draw) -> dict:
    meta = {
        'owner_sub': draw(st.one_of(st.none(), SUBJECTS)),
        'visibility': draw(st.sampled_from([pa.VISIBILITY_PUBLIC, pa.VISIBILITY_PRIVATE, None, 'secret'])),
        'members': draw(member_maps()),
    }
    if draw(st.booleans()):
        meta[pa.CREATED_BY_AGENT_ATTRIBUTE] = draw(st.sampled_from(['agent-1', 'agent-2']))
    return meta


@st.composite
def callers(draw) -> pa.Caller:
    return pa.Caller(
        subject=draw(st.one_of(st.just(''), SUBJECTS)),
        is_admin=draw(st.booleans()),
        delegated=draw(st.booleans()),
        agent_id=draw(st.sampled_from(['', 'agent-1', 'agent-2'])),
    )


class TestATokenActsForItsMinterButNeverAdministers:
    """Invariant: a delegated caller (an MCP token or an agent) is never owner or admin of any project, and
    can never manage one (a delete, the members, the visibility)."""

    @PROPERTY
    @given(meta=projects(), caller=callers())
    def test_a_delegated_caller_is_never_owner_or_admin(self, meta: dict, caller: pa.Caller) -> None:
        assume(caller.delegated)
        access = pa.resolve_access(meta, caller)
        assert access.role not in (pa.ROLE_OWNER, pa.ROLE_ADMIN)
        assert not access.can_manage

    @PROPERTY
    @given(meta=projects(), subject=SUBJECTS)
    def test_the_owner_owns_their_project_and_a_token_of_theirs_only_edits(self, meta: dict, subject: str) -> None:
        meta = {**meta, 'owner_sub': subject}
        assert pa.resolve_access(meta, pa.Caller(subject=subject)).role == pa.ROLE_OWNER
        assert pa.resolve_access(meta, pa.Caller(subject=subject, delegated=True)).role == pa.ROLE_EDITOR


class TestATokenOrAnAgentIsNeverAnAdminWhateverItsGroupsSay:
    """Invariant: a caller built from an MCP token's or an agent's claims has is_admin exactly False (a bool,
    not merely something falsy), even when its groups name the admin group; a person's own claims are admin
    exactly when their groups name it."""

    @PROPERTY
    @given(acting=SUBJECTS, groups=st.lists(st.sampled_from([pa.ADMIN_GROUP, 'users', 'staff']), max_size=3))
    def test_a_token_caller_is_not_an_admin(self, acting: str, groups: list[str]) -> None:
        claims = {'sub': f'{pa.DELEGATED_SUBJECT_PREFIX}token-1', pa.ACTING_SUBJECT_CLAIM: acting}
        caller = pa.caller_from_claims(claims, groups)
        assert caller.is_admin is False
        assert caller.delegated is True
        assert caller.subject == acting

    @PROPERTY
    @given(acting=SUBJECTS, agent_id=st.from_regex(r'[a-z0-9-]{1,20}', fullmatch=True),
           groups=st.lists(st.sampled_from([pa.ADMIN_GROUP, 'users', 'staff']), max_size=3))
    def test_an_agent_caller_is_not_an_admin(self, acting: str, agent_id: str, groups: list[str]) -> None:
        claims = {'sub': f'{pa.AGENT_SUBJECT_PREFIX}{agent_id}', pa.ACTING_SUBJECT_CLAIM: acting}
        caller = pa.caller_from_claims(claims, groups)
        assert caller.is_admin is False
        assert caller.delegated is True
        assert caller.agent_id == agent_id

    def test_a_caller_built_without_is_admin_is_not_an_admin(self) -> None:
        # mutmut does not mutate a dataclass default, so this pins it: the token and agent callers spell
        # is_admin=False out, and a later change of the default must not turn every other caller into one.
        assert pa.Caller(subject='sub-ada').is_admin is False
        assert pa.Caller(subject='sub-ada', delegated=True).is_admin is False

    @PROPERTY
    @given(subject=SUBJECTS, groups=st.lists(st.sampled_from([pa.ADMIN_GROUP, 'users', 'staff']), max_size=3))
    def test_a_person_is_an_admin_exactly_when_their_groups_say_so(self, subject: str, groups: list[str]) -> None:
        caller = pa.caller_from_claims({'sub': subject}, groups)
        assert caller.is_admin is (pa.ADMIN_GROUP in groups)
        assert caller.delegated is False


USERNAMES = st.sampled_from(['ann', 'Ann', 'ann_b', 'annz', 'AnnZ', 'bo', 'Bo-1', 'cy', '', 'zed', 'z_ed'])


class TestTheMemberListIsInOneStableOrder:
    """Invariant: the members a client sees are sorted by username without regard to letter case (as
    lower-case text, so 'ann_b' comes before 'annz' as it does in a lower-case listing), then by subject,
    whatever order they were stored in."""

    @PROPERTY
    @given(entries=st.dictionaries(SUBJECTS, st.tuples(USERNAMES, ROLES), max_size=5))
    def test_members_come_back_sorted_by_lower_case_username_then_subject(self, entries: dict) -> None:
        meta = {'members': {sub: {'role': role, 'username': name} for sub, (name, role) in entries.items()}}
        rows = pa.public_members(meta)
        keys = [(row['username'].lower(), row['sub']) for row in rows]
        assert keys == sorted(keys)
        assert {row['sub'] for row in rows} == set(entries)

    def test_an_underscore_sorts_as_it_does_in_lower_case_text(self) -> None:
        meta = {'members': {
            'sub-bo': {'role': pa.ROLE_VIEWER, 'username': 'AnnZ'},
            'sub-ada': {'role': pa.ROLE_EDITOR, 'username': 'ann_b'},
        }}
        assert [row['username'] for row in pa.public_members(meta)] == ['ann_b', 'AnnZ']


class TestAPublicProjectIsEditableByEverySignedInPerson:
    """Invariant: a public project gives every signed-in person editing, whatever its members say; a
    private project gives a stranger nothing and a listed member exactly the role listed for them."""

    @PROPERTY
    @given(meta=projects(), caller=callers())
    def test_a_public_project_is_at_least_editable_by_a_signed_in_caller(self, meta: dict, caller: pa.Caller) -> None:
        meta = {**meta, 'visibility': pa.VISIBILITY_PUBLIC}
        assume(caller.subject)
        assert pa.resolve_access(meta, caller).can_edit

    @PROPERTY
    @given(subject=SUBJECTS, role=ROLES, members=member_maps())
    def test_a_private_project_gives_a_member_their_recorded_role_and_nothing_to_a_stranger(
            self, subject: str, role: str, members: dict) -> None:
        members = {k: v for k, v in members.items() if k != subject}
        members[subject] = {'role': role}
        meta = {'owner_sub': 'sub-owner', 'visibility': pa.VISIBILITY_PRIVATE, 'members': members}

        member_access = pa.resolve_access(meta, pa.Caller(subject=subject))
        assert member_access.role == role
        assert member_access.can_edit is (role == pa.ROLE_EDITOR)
        assert not member_access.can_manage

        stranger = pa.resolve_access(meta, pa.Caller(subject='sub-stranger'))
        assert stranger.role is None
        assert not stranger.can_view

    @PROPERTY
    @given(meta=projects())
    def test_the_stored_visibility_is_always_public_or_private(self, meta: dict) -> None:
        assert pa.project_visibility(meta) in pa.VISIBILITIES

    @PROPERTY
    @given(meta=projects())
    def test_only_well_formed_members_survive_reading(self, meta: dict) -> None:
        members = pa.project_members(meta)
        raw = meta.get('members') or {}
        assert set(members) <= set(raw)
        for sub, entry in members.items():
            assert sub
            assert entry['role'] in pa.MEMBER_ROLES
            assert raw[sub] == entry


class TestARouteWritesByDefaultAndReadsByDefault:
    """Invariant: a route with no declared level needs view to read and edit to write. Only the routes
    listed as overrides differ, and the ones that delete the project or change who is in it need manage."""

    @PROPERTY
    @given(method=st.sampled_from(['POST', 'PUT', 'PATCH', 'DELETE']),
           rest=st.lists(st.sampled_from(['alpha', 'beta', 'gamma']), min_size=1, max_size=3).map(tuple))
    def test_an_undeclared_write_needs_edit(self, method: str, rest: tuple[str, ...]) -> None:
        assert pa.required_level(method, rest) == pa.LEVEL_EDIT

    @PROPERTY
    @given(method=st.sampled_from(['GET', 'HEAD', 'get']),
           rest=st.lists(st.sampled_from(['alpha', 'beta', 'gamma']), max_size=3).map(tuple))
    def test_an_undeclared_read_needs_view(self, method: str, rest: tuple[str, ...]) -> None:
        assert pa.required_level(method, rest) == pa.LEVEL_VIEW

    @PROPERTY
    @given(method=st.sampled_from(['GET', 'POST', 'PUT', 'DELETE']), rest=st.lists(SEGMENTS, max_size=4).map(tuple))
    def test_every_route_resolves_to_a_known_level(self, method: str, rest: tuple[str, ...]) -> None:
        assert pa.required_level(method, rest) in (pa.LEVEL_VIEW, pa.LEVEL_EDIT, pa.LEVEL_MANAGE)

    def test_a_viewer_can_comment_on_a_document_so_that_route_needs_view(self) -> None:
        assert pa.required_level('POST', ('documents', 'doc-1', 'comments')) == pa.LEVEL_VIEW
        assert pa.required_level('POST', ('documents', 'doc-1', 'comments', 'c-1', 'replies')) == pa.LEVEL_VIEW


class TestAProjectIdSurvivesItsRoute:
    """Invariant: the project id and the rest of the path come back exactly as they went in, except the
    reserved workspace segment ('prioritization'), which addresses no project."""

    @PROPERTY
    @given(project_id=st.from_regex(r'[a-z0-9][a-z0-9-]{0,20}', fullmatch=True),
           rest=st.lists(st.from_regex(r'[a-z][a-z0-9-]{0,10}', fullmatch=True), max_size=4))
    def test_split_gives_back_the_id_and_the_rest(self, project_id: str, rest: list[str]) -> None:
        path = '/'.join(['/projects', project_id, *rest])
        if project_id in pa.NON_PROJECT_SEGMENTS:
            assert pa.project_route(path) is None
        else:
            assert pa.project_route(path) == (project_id, tuple(rest))

    @PROPERTY
    @given(path=st.text(alphabet='/projects-ab', max_size=30))
    def test_a_path_outside_projects_addresses_no_project(self, path: str) -> None:
        segments = [part for part in path.split('/') if part]
        addresses_nothing = len(segments) < 2 or segments[0] != 'projects' or segments[1] in pa.NON_PROJECT_SEGMENTS
        assert (pa.project_route(path) is None) is addresses_nothing


class TestARoleAndVisibilityAreOnlyTheNamedValues:
    """Invariant: a visibility is 'public' or 'private' and a member's role 'viewer' or 'editor'; any other
    value is refused, never stored or read as a near miss."""

    @PROPERTY
    @given(value=st.text(max_size=12))
    def test_a_visibility_is_refused_unless_it_is_named(self, value: str) -> None:
        assume(value not in ('public', 'private'))
        with pytest.raises(ValueError, match="visibility must be 'public' or 'private'"):
            pa.validate_visibility(value)

    @PROPERTY
    @given(value=st.text(max_size=12))
    def test_a_member_role_is_refused_unless_it_is_named(self, value: str) -> None:
        assume(value not in ('viewer', 'editor'))
        with pytest.raises(ValueError, match="role must be 'viewer' or 'editor'"):
            pa.validate_member_role(value)
