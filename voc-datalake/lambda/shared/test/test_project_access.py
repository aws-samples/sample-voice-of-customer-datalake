"""Policy tests for shared.project_access — the single per-project ACL authority."""

import dataclasses
from typing import Any

import pytest

from shared import project_access as pa
from shared.mcp_delegate import SYNTHETIC_SUBJECT_PREFIX

OWNER = 'sub-owner'
EDITOR = 'sub-editor'
VIEWER = 'sub-viewer'
STRANGER = 'sub-stranger'


def _assign(target: object, field: str, value: object) -> None:
    """Plain attribute assignment, spelled so a frozen dataclass can be probed."""
    setattr(target, field, value)


def _meta(visibility: str | None = 'private', owner: str | None = OWNER,
          members: dict | None = None) -> dict[str, Any]:
    meta: dict[str, Any] = {'sk': 'META', 'project_id': 'proj_1'}
    if visibility is not None:
        meta['visibility'] = visibility
    if owner is not None:
        meta['owner_sub'] = owner
        meta['owner_username'] = 'olivia'
        meta['owner_email'] = 'olivia@example.com'
    meta['members'] = members if members is not None else {
        EDITOR: {'role': 'editor', 'username': 'ed'},
        VIEWER: {'role': 'viewer', 'username': 'vi'},
    }
    return meta


def _user(sub, admin=False):
    return pa.Caller(subject=sub, is_admin=admin)


class TestPinnedConstants:
    """Values other code (API, docs, the MCP Lambda) relies on literally."""

    def test_new_projects_default_to_private(self):
        assert pa.DEFAULT_NEW_PROJECT_VISIBILITY == 'private'

    def test_member_cap_is_one_hundred(self):
        assert pa.MAX_PROJECT_MEMBERS == 100

    def test_acting_subject_claim_name_is_the_wire_name(self):
        assert pa.ACTING_SUBJECT_CLAIM == 'voc:acting_subject'

    def test_delegated_prefix_matches_mcp_delegate(self):
        assert pa.DELEGATED_SUBJECT_PREFIX == SYNTHETIC_SUBJECT_PREFIX

    def test_access_attributes_are_exactly_what_the_policy_reads(self):
        assert pa.ACCESS_ATTRIBUTES == (
            'owner_sub', 'owner_username', 'owner_email', 'visibility', 'members',
            'created_by_agent',
        )


def test_meta_gate_read_is_a_consistent_projected_get():
    assert pa.meta_gate_read('proj_1', 'deleting_at') == {
        'Key': {'pk': 'PROJECT#proj_1', 'sk': 'META'},
        'ConsistentRead': True,
        'ProjectionExpression': (
            'pk, owner_sub, owner_username, owner_email, visibility, members, '
            'created_by_agent, #status, #deleting'
        ),
        'ExpressionAttributeNames': {'#status': 'status', '#deleting': 'deleting_at'},
    }


class TestCallerDataclass:
    def test_defaults_are_a_plain_non_admin_user_with_blank_display_fields(self):
        caller = pa.Caller(subject='s')

        assert dataclasses.asdict(caller) == {
            'subject': 's', 'is_admin': False, 'username': '', 'email': '', 'delegated': False,
            'agent_id': '', 'agent_owner_sub': '', 'agent_editor_subs': (),
        }
        assert pa.owner_attributes(caller) == {
            'owner_sub': 's', 'owner_username': '', 'owner_email': '',
        }

    def test_a_principal_cannot_be_mutated_after_construction(self):
        caller = pa.Caller(subject='s')

        with pytest.raises(dataclasses.FrozenInstanceError):
            _assign(caller, 'is_admin', True)

    def test_an_access_decision_cannot_be_mutated_after_construction(self):
        access = pa.ProjectAccess(role='viewer')

        with pytest.raises(dataclasses.FrozenInstanceError):
            _assign(access, 'role', 'owner')


@pytest.mark.parametrize(
    ('sub', 'admin', 'role', 'view', 'edit', 'manage'),
    [
        (OWNER, False, 'owner', True, True, True),
        (EDITOR, False, 'editor', True, True, False),
        (VIEWER, False, 'viewer', True, False, False),
        (STRANGER, False, None, False, False, False),
        (STRANGER, True, 'admin', True, True, True),
        (OWNER, True, 'owner', True, True, True),
    ],
)
def test_private_project_roles(sub, admin, role, view, edit, manage):
    access = pa.resolve_access(_meta(), _user(sub, admin))
    assert access.role == role
    assert (access.can_view, access.can_edit, access.can_manage) == (view, edit, manage)
    assert access.to_dict() == {
        'role': role, 'can_view': view, 'can_edit': edit, 'can_manage': manage,
    }


def test_public_project_lets_every_signed_in_user_edit_but_not_manage():
    access = pa.resolve_access(_meta('public'), _user(STRANGER))
    assert access.role == 'editor'
    assert access.can_edit
    assert not access.can_manage


def test_public_project_viewer_membership_does_not_lower_access():
    assert pa.resolve_access(_meta('public'), _user(VIEWER)).role == 'editor'


def test_legacy_project_reads_public_and_only_admins_manage():
    legacy = _meta(visibility=None, owner=None, members={})
    assert pa.project_visibility(legacy) == 'public'
    assert pa.resolve_access(legacy, _user(STRANGER)).role == 'editor'
    assert pa.resolve_access(legacy, _user(STRANGER, admin=True)).can_manage


def test_unknown_visibility_value_reads_public():
    assert pa.project_visibility({'visibility': 'secret'}) == 'public'


def test_missing_meta_grants_nothing():
    assert pa.resolve_access(None, _user(OWNER, admin=True)).role is None


def test_malformed_member_entries_are_ignored():
    meta = _meta(members={
        STRANGER: {'role': 'owner'},  # not a member role
        'x': 'editor',  # not a mapping
        '': {'role': 'editor'},
    })
    assert pa.project_members(meta) == {}
    assert pa.resolve_access(meta, _user(STRANGER)).role is None


def test_members_that_are_not_a_map_read_as_none():
    assert pa.project_members({'members': ['sub-a']}) == {}
    assert pa.project_members({}) == {}


def test_blank_subject_never_matches_an_ownerless_or_memberless_entry():
    meta = _meta(owner='', members={'': {'role': 'editor'}})
    assert pa.resolve_access(meta, pa.Caller(subject='')).role is None


class TestCallerFromClaims:
    def test_cognito_user(self):
        caller = pa.caller_from_claims(
            {'sub': ' abc ', 'cognito:username': 'ann', 'email': 'a@x.io'}, ['admins'],
        )
        assert caller == pa.Caller(subject='abc', is_admin=True, username='ann', email='a@x.io')

    def test_access_token_username_claim_is_the_fallback(self):
        caller = pa.caller_from_claims({'sub': 'abc', 'username': 'ann'}, [])

        assert caller.username == 'ann'

    def test_non_string_claims_read_blank(self):
        caller = pa.caller_from_claims(
            {'sub': 'abc', 'cognito:username': 7, 'email': None}, [],
        )

        assert (caller.username, caller.email) == ('', '')

    @pytest.mark.parametrize('claims', [{}, {'sub': '   '}, {'sub': 7}])
    def test_missing_sub_fails_closed(self, claims):
        with pytest.raises(ValueError, match='caller has no subject') as raised:
            pa.caller_from_claims(claims, [])
        assert str(raised.value) == 'caller has no subject'

    def test_delegated_credential_acts_as_minter_and_never_as_admin(self):
        caller = pa.caller_from_claims(
            {'sub': 'mcp:tok1', pa.ACTING_SUBJECT_CLAIM: OWNER}, ['admins'],
        )
        assert caller.subject == OWNER
        assert caller.delegated
        assert not caller.is_admin
        access = pa.resolve_access(_meta(), caller)
        assert access.role == 'editor'
        assert not access.can_manage

    def test_delegated_credential_without_minter_reaches_only_public(self):
        caller = pa.caller_from_claims({'sub': 'mcp:tok1'}, [])
        assert pa.resolve_access(_meta(), caller).role is None
        assert pa.resolve_access(_meta('public'), caller).role == 'editor'

    def test_credential_cannot_act_as_another_credential(self):
        caller = pa.caller_from_claims(
            {'sub': 'mcp:tok1', pa.ACTING_SUBJECT_CLAIM: 'mcp:tok2'}, [],
        )
        assert caller.subject == ''

    def test_acting_claim_ignored_for_cognito_users(self):
        caller = pa.caller_from_claims(
            {'sub': STRANGER, pa.ACTING_SUBJECT_CLAIM: OWNER}, [],
        )
        assert caller.subject == STRANGER
        assert pa.resolve_access(_meta(), caller).role is None


@pytest.mark.parametrize('event', [
    {},
    {'requestContext': 'x'},
    {'requestContext': {'authorizer': None}},
    {'requestContext': {'authorizer': {'claims': ['sub']}}},
])
def test_claims_from_event_reads_a_malformed_shape_as_no_claims(event):
    assert pa.claims_from_event(event) == {}


def test_claims_from_event_reads_the_authorizer_claims():
    event = {'requestContext': {'authorizer': {'claims': {'sub': 'u1'}}}}

    assert pa.claims_from_event(event) == {'sub': 'u1'}


def test_sharing_summary_and_public_members():
    summary = pa.sharing_summary(_meta(), _user(VIEWER))
    assert summary == {
        'visibility': 'private',
        'owner': {'sub': OWNER, 'username': 'olivia', 'email': 'olivia@example.com'},
        'access': {'role': 'viewer', 'can_view': True, 'can_edit': False, 'can_manage': False},
        'member_count': 2,
    }
    assert [m['username'] for m in pa.public_members(_meta())] == ['ed', 'vi']


class TestPublicOwner:
    @pytest.mark.parametrize('meta', [{}, {'owner_sub': ''}, {'owner_sub': 7}])
    def test_absent_blank_or_non_string_owner_is_none(self, meta):
        assert pa.public_owner(meta) is None

    def test_missing_display_fields_are_blank_strings(self):
        assert pa.public_owner({'owner_sub': 'o', 'owner_username': None}) == {
            'sub': 'o', 'username': '', 'email': '',
        }


class TestPublicMembers:
    def test_rows_carry_every_client_facing_field(self):
        meta = {'members': {'sub-a': {
            'role': 'editor', 'username': 'ann', 'email': 'ann@x.io',
            'added_by': 'sub-owner', 'added_at': '2026-01-02T03:04:05Z',
            'internal_note': 'never exposed',
        }}}

        assert pa.public_members(meta) == [{
            'sub': 'sub-a', 'role': 'editor', 'username': 'ann', 'email': 'ann@x.io',
            'added_by': 'sub-owner', 'added_at': '2026-01-02T03:04:05Z',
        }]

    def test_missing_display_fields_are_blank_strings(self):
        meta = {'members': {'sub-a': {'role': 'viewer', 'email': None}}}

        assert pa.public_members(meta) == [{
            'sub': 'sub-a', 'role': 'viewer', 'username': '', 'email': '',
            'added_by': '', 'added_at': '',
        }]

    def test_sorted_case_insensitively_by_username_then_sub(self):
        meta = {'members': {
            'sub-z': {'role': 'viewer', 'username': 'bob'},
            'sub-b': {'role': 'viewer', 'username': 'Alice'},
            'sub-a': {'role': 'editor', 'username': 'alice'},
            'sub-c': {'role': 'viewer'},
        }}

        assert [row['sub'] for row in pa.public_members(meta)] == [
            'sub-c', 'sub-a', 'sub-b', 'sub-z',
        ]


def test_owner_attributes_record_the_caller_as_owner():
    assert pa.owner_attributes(pa.Caller(subject='s', username='u', email='e')) == {
        'owner_sub': 's', 'owner_username': 'u', 'owner_email': 'e',
    }


@pytest.mark.parametrize('caller', [
    pa.Caller(subject='s', delegated=True),
    pa.Caller(subject=''),
])
def test_owner_attributes_refuses_delegated_or_blank_callers(caller):
    with pytest.raises(ValueError, match='only a signed-in user can own a project') as raised:
        pa.owner_attributes(caller)
    assert str(raised.value) == 'only a signed-in user can own a project'


@pytest.mark.parametrize('value', ['public', 'private'])
def test_validate_visibility_accepts(value):
    assert pa.validate_visibility(value) == value


@pytest.mark.parametrize('value', ['', 'Public', None, 1])
def test_validate_visibility_rejects(value):
    with pytest.raises(ValueError, match="visibility must be 'public' or 'private'") as raised:
        pa.validate_visibility(value)
    assert str(raised.value) == "visibility must be 'public' or 'private'"


@pytest.mark.parametrize('value', ['viewer', 'editor'])
def test_validate_member_role_accepts(value):
    assert pa.validate_member_role(value) == value


@pytest.mark.parametrize('value', ['owner', 'admin', '', None])
def test_validate_member_role_rejects(value):
    with pytest.raises(ValueError, match="role must be 'viewer' or 'editor'") as raised:
        pa.validate_member_role(value)
    assert str(raised.value) == "role must be 'viewer' or 'editor'"


@pytest.mark.parametrize(
    ('path', 'expected'),
    [
        ('', None),
        ('/projects', None),
        ('/projects/', None),
        ('/projects/prioritization', None),
        ('/projects/prioritization/rows/r1', None),
        ('/feedback/x', None),
        ('/projects/proj_1', ('proj_1', ())),
        ('/projects/proj_1/members/abc', ('proj_1', ('members', 'abc'))),
    ],
)
def test_project_route(path, expected):
    assert pa.project_route(path) == expected


@pytest.mark.parametrize(
    ('method', 'rest', 'level'),
    [
        ('GET', (), 'view'),
        ('HEAD', (), 'view'),
        ('get', ('jobs',), 'view'),
        ('PUT', (), 'edit'),
        ('DELETE', (), 'manage'),
        ('POST', ('chat-context',), 'view'),
        ('POST', ('chat-context', 'x'), 'edit'),
        ('POST', ('documents',), 'edit'),
        ('DELETE', ('documents', 'd1'), 'edit'),
        ('GET', ('jobs', 'j1'), 'view'),
        ('PUT', ('visibility',), 'manage'),
        ('POST', ('owner',), 'manage'),
        ('GET', ('members',), 'view'),
        ('GET', ('members', 'candidates'), 'manage'),
        ('POST', ('members',), 'manage'),
        ('PUT', ('members', 's1'), 'manage'),
        ('DELETE', ('members', 's1'), 'view'),
        ('patch', ('anything',), 'edit'),
    ],
)
def test_required_level(method, rest, level):
    assert pa.required_level(method, rest) == level
