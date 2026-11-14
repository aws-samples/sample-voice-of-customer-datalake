"""Properties of a workspace's membership rules (shared/workspace_members.py), against a moto table.

A workspace left with no admin can never be administered again by its team; a removed member who keeps a row keeps
access; a role that differs between the ``MEMBER#`` row and the person's ``USER#`` row shows one thing in "my
workspaces" and enforces another. So random runs of adds, role changes, removals and leaves, by admins, by platform
admins and by members acting on themselves, are checked against a plain model after every step.

One moto table serves the whole module: each generated run gets a workspace id of its own and its rows are removed
after it (``EmptiedAfter``), so runs never meet.
"""
from __future__ import annotations

from collections.abc import Iterator
from itertools import count

import pytest
from hypothesis import given
from hypothesis import strategies as st
from moto import mock_aws

from shared.exceptions import AuthorizationError, ConflictError, NotFoundError
from shared.test.moto_tables import create_pk_sk_table
from shared.test.ws_properties import PROPERTY, EmptiedAfter, exactly
from shared.workspace import WorkspaceContext
from shared.workspace_members import (
    ALREADY_MEMBER,
    LAST_ADMIN,
    MEMBER_NOT_FOUND,
    NO_LONGER_ADMIN,
    Account,
    UserMembership,
    add_member,
    change_role,
    last_admin_message,
    plan_user_removal,
    remove_member,
    remove_user_memberships,
)

ROLES = ('viewer', 'editor', 'admin')
PEOPLE = ('ada', 'ben', 'cleo', 'dev', 'eli')
#: One step: (what, who acts, on whom, the role). ``who acts`` None = a platform admin who is not a member.
STEPS = st.lists(st.tuples(st.sampled_from(['add', 'change', 'remove', 'leave']),
                           st.one_of(st.none(), st.sampled_from(PEOPLE)), st.sampled_from(PEOPLE),
                           st.sampled_from(ROLES)), min_size=1, max_size=12)
_RUNS = count()


@pytest.fixture(scope='module')
def table() -> Iterator:
    with mock_aws():
        yield create_pk_sk_table('workspaces')


def _new_workspace(table) -> str:
    """A workspace of its own for one generated run, with ``ada`` as its one admin."""
    ws = f'ws_0{next(_RUNS):025d}'
    table.put_item(Item={'pk': f'WS#{ws}', 'sk': 'META', 'name': f'Team {ws[-4:]}', 'slug': 't', 'status': 'active'})
    for pk, sk in ((f'WS#{ws}', 'MEMBER#ada'), ('USER#ada', f'WS#{ws}')):
        table.put_item(Item={'pk': pk, 'sk': sk, 'role': 'admin', 'name': 'Team', 'slug': 't'})
    return ws


def _stored(table, ws: str) -> tuple[dict[str, str], dict[str, str]]:
    """The roles of the workspace's ``MEMBER#`` rows and of its people's ``USER#`` rows."""
    members = table.query(KeyConditionExpression='pk = :pk AND begins_with(sk, :m)',
                          ExpressionAttributeValues={':pk': f'WS#{ws}', ':m': 'MEMBER#'})['Items']
    users = {}
    for person in PEOPLE:
        row = table.get_item(Key={'pk': f'USER#{person}', 'sk': f'WS#{ws}'}).get('Item')
        if row is not None:
            users[person] = row['role']
    return {row['sk'].removeprefix('MEMBER#'): row['role'] for row in members}, users


def _context(ws: str, actor: str | None, model: dict[str, str]) -> WorkspaceContext:
    if actor is None:
        return WorkspaceContext(ws=ws, role='admin', name='Team', slug='t', platform_admin=True)
    return WorkspaceContext(ws=ws, role=model.get(actor, ''), name='Team', slug='t', platform_admin=False)


def _apply(table, ws: str, model: dict[str, str], step: tuple) -> None:
    """Run one step the way the members routes would (only an admin, or a platform admin, changes others; anyone
    leaves), and change the model the way the rules say; a refusal must be the one the rules give."""
    what, actor, target, role = step
    if what == 'leave':
        actor = target
    elif actor is not None and model.get(actor) != 'admin':
        return  # the routes refuse a non-admin before the module runs (require_workspace_admin)
    context = _context(ws, actor, model)
    by = actor or 'platform-admin'
    account = Account(sub=target, email=f'{target}@example.com', name=target.title(), created=False)
    run = {'add': lambda: add_member(table, context, account, role, by),
           'change': lambda: change_role(table, context, target, role, by)}.get(
        what, lambda: remove_member(table, context, target, by))
    refusal = _refusal(model, what, target, role)
    if refusal is not None:
        with pytest.raises(refusal[0], match=exactly(refusal[1])):
            run()
        return
    answer = run()
    if what == 'change':
        assert answer == {'sub': target, 'role': role}
    if what in ('add', 'change'):
        model[target] = role
    else:
        del model[target]


def _refusal(model: dict[str, str], what: str, target: str, role: str) -> tuple[type[Exception], str] | None:
    """The refusal the rules give a step, or None when it goes through."""
    if what == 'add':
        return (ConflictError, ALREADY_MEMBER) if target in model else None
    if target not in model:
        return NotFoundError, MEMBER_NOT_FOUND
    loses_admin = model[target] == 'admin' and (what != 'change' or role != 'admin')
    admins_left = [person for person, held in model.items() if held == 'admin' and person != target]
    return (ConflictError, LAST_ADMIN) if loses_admin and not admins_left else None


# Whatever runs of adds, role changes, removals and leaves happen, a workspace keeps at least one admin, each
# member's ``MEMBER#`` and ``USER#`` rows exist together and say the same role, and the rows are exactly the model:
# a removed member keeps no row, an added one has both.
@PROPERTY
@given(steps=STEPS)
def test_a_workspace_always_keeps_an_admin_and_both_rows_agree(table, steps):
    with EmptiedAfter(table):
        ws = _new_workspace(table)
        model = {'ada': 'admin'}
        for step in steps:
            _apply(table, ws, model, step)
            members, users = _stored(table, ws)
            assert members == model
            assert users == model
            assert 'admin' in members.values()


# A demoted admin acts as an admin no more: a change they then try (on someone else) is refused as "no longer an
# admin" by the transaction's own check of their row, and changes nothing.
@PROPERTY
@given(st.sampled_from(['change', 'remove', 'add']), st.sampled_from(ROLES[:2]), st.sampled_from(ROLES))
def test_an_admin_demoted_meanwhile_changes_nothing(table, what, demoted_to, role):
    with EmptiedAfter(table):
        ws = _new_workspace(table)
        model = {'ada': 'admin'}
        _apply(table, ws, model, ('add', None, 'ben', 'admin'))
        _apply(table, ws, model, ('add', None, 'cleo', 'viewer'))
        stale = _context(ws, 'ben', model)  # ben resolved as admin, then demoted before his change commits
        _apply(table, ws, model, ('change', 'ada', 'ben', demoted_to))
        before = _stored(table, ws)
        dev = Account(sub='dev', email='dev@example.com', name='Dev', created=False)
        run = {'change': lambda: change_role(table, stale, 'cleo', 'admin' if role == 'viewer' else role, 'ben'),
               'remove': lambda: remove_member(table, stale, 'cleo', 'ben'),
               'add': lambda: add_member(table, stale, dev, role, 'ben')}[what]
        with pytest.raises(AuthorizationError, match=exactly(NO_LONGER_ADMIN)):
            run()
        assert _stored(table, ws) == before


# A user is deleted only from workspaces where someone else stays admin, unless a platform admin (live-checked)
# deletes them; then every membership row of theirs goes, and the workspaces they leave without an admin are named.
@PROPERTY
@given(st.lists(st.tuples(st.sampled_from(ROLES), st.booleans()), min_size=1, max_size=3), st.booleans())
def test_a_deleted_user_never_silently_orphans_a_workspace(table, memberships, platform_admin):
    with EmptiedAfter(table):
        _check_user_delete(table, memberships, platform_admin)


def _check_user_delete(table, memberships: list[tuple[str, bool]], platform_admin: bool) -> None:
    person = f'del{next(_RUNS)}'
    workspaces = []
    for role, has_other_admin in memberships:
        ws = _new_workspace(table)
        if not has_other_admin:
            table.delete_item(Key={'pk': f'WS#{ws}', 'sk': 'MEMBER#ada'})
            table.delete_item(Key={'pk': 'USER#ada', 'sk': f'WS#{ws}'})
        for pk, sk in ((f'WS#{ws}', f'MEMBER#{person}'), (f'USER#{person}', f'WS#{ws}')):
            table.put_item(Item={'pk': pk, 'sk': sk, 'role': role, 'name': f'Team {ws[-4:]}', 'slug': 't'})
        workspaces.append((ws, role == 'admin' and not has_other_admin))
    orphaned = [f'Team {ws[-4:]}' for ws, orphans in workspaces if orphans]
    asked: list[bool] = []

    def live_check() -> bool:
        asked.append(True)
        return platform_admin

    if orphaned and not platform_admin:
        with pytest.raises(ConflictError, match=exactly(last_admin_message(orphaned))):
            plan_user_removal(table, person, caller_is_platform_admin=live_check)
        assert len(asked) == 1
        assert all(table.get_item(Key={'pk': f'WS#{ws}', 'sk': f'MEMBER#{person}'}).get('Item')
                   for ws, _ in workspaces)
        return
    removal = plan_user_removal(table, person, caller_is_platform_admin=live_check)
    assert len(asked) == 1
    assert removal.platform_admin is platform_admin
    assert sorted(membership.ws for membership in removal.memberships) == sorted(ws for ws, _ in workspaces)
    assert [membership.name for membership in removal.memberships if membership.last_admin] == orphaned
    assert remove_user_memberships(table, removal, 'platform-admin') == len(workspaces)
    for ws, _ in workspaces:
        assert table.get_item(Key={'pk': f'WS#{ws}', 'sk': f'MEMBER#{person}'}).get('Item') is None
        assert table.get_item(Key={'pk': f'USER#{person}', 'sk': f'WS#{ws}'}).get('Item') is None


# The refusal names up to three workspaces, says how many more, and an unnamed one as such, in the order given.
@PROPERTY
@given(st.lists(st.text(alphabet='abcdefgh XYZ', max_size=10), min_size=1, max_size=7))
def test_the_last_admin_refusal_names_up_to_three_workspaces(names):
    message = last_admin_message(names)
    shown = [f'"{name}"' if name else 'an unnamed workspace' for name in names[:3]]
    more = f' and {len(names) - 3} more' if len(names) > 3 else ''
    noun = 'workspace' if len(names) == 1 else 'workspaces'
    assert message == (f'This user is the last admin of the {noun} {", ".join(shown)}{more}: make another member an '
                       'admin there first, or ask a platform admin to delete the user and name a new admin afterwards.')


# A membership is its workspace's last admin exactly when it is an admin with no other admin found.
@PROPERTY
@given(st.one_of(st.none(), st.sampled_from(ROLES)), st.one_of(st.none(), st.sampled_from(PEOPLE)))
def test_last_admin_is_an_admin_with_no_other(role, other):
    membership = UserMembership(ws='ws_00000000000000000000000000', name='n', slug='s', role=role,
                                other_admin=other)
    assert membership.last_admin is (role == 'admin' and other is None)
