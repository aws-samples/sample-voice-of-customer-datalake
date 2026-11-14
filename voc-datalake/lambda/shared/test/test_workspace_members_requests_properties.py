"""Properties of what a membership change sends and records (shared/workspace_members.py), on a recording double.

The moto-backed properties (test_workspace_members_properties.py) check the rules' outcome; these check the requests
that carry them: each change is ONE transaction whose items and conditions are exactly the documented ones, a
cancelled transaction is answered by which item failed (in the documented order of precedence), every change writes
its audit row before the change with every field, the reads are strongly consistent, and each outcome is logged with
the workspace only. The table double answers reads from a dict, records every call, and cancels the transaction with
the codes the test gives.
"""
from __future__ import annotations

import hashlib
from typing import Any
from unittest.mock import patch

import pytest
from botocore.exceptions import ClientError
from hypothesis import example, given
from hypothesis import strategies as st

from shared.exceptions import AuthorizationError, ConflictError, NotFoundError
from shared.test.ws_properties import PROPERTY, exactly, workspace_ids
from shared.workspace import NOT_FOUND, WorkspaceContext
from shared.workspace_members import (
    ACCOUNT_CREATION,
    ALREADY_MEMBER,
    CHANGED_MEANWHILE,
    MEMBER_ADDED,
    MEMBER_LEFT,
    MEMBER_NOT_FOUND,
    MEMBER_REMOVED,
    MEMBER_ROLE_CHANGED,
    NO_LONGER_ADMIN,
    Account,
    add_member,
    audit_account_creation,
    change_role,
    plan_user_removal,
    remove_member,
    remove_user_memberships,
)

NOW = '2026-11-14T08:00:00+00:00'
TABLE = 'voc-workspaces'
FAILED = 'ConditionalCheckFailed'
CODES = st.sampled_from([None, FAILED, 'TransactionConflict', 'ValidationError'])
ROLES = ('viewer', 'editor', 'admin')


class Recorder:
    """voc-workspaces: rows by key; every call recorded; the transaction cancelled with ``codes`` when given."""

    name = TABLE

    def __init__(self, rows: dict[tuple[str, str], dict[str, Any]], codes: list[str | None] | None = None) -> None:
        self.rows = rows
        self.codes = codes
        self.gets: list[dict[str, Any]] = []
        self.queries: list[dict[str, Any]] = []
        self.puts: list[dict[str, Any]] = []
        self.transactions: list[list[dict[str, Any]]] = []
        self.meta = self
        self.client = self
        self.error: ClientError | None = None

    def get_item(self, **request: Any) -> dict[str, Any]:
        self.gets.append(request)
        row = self.rows.get((request['Key']['pk'], request['Key']['sk']))
        return {} if row is None else {'Item': {**request['Key'], **row}}

    def put_item(self, **request: Any) -> None:
        self.puts.append(request)

    def query(self, **request: Any) -> dict[str, Any]:
        self.queries.append(request)
        values = request['ExpressionAttributeValues']
        prefix = values.get(':member', values.get(':ws', ''))
        # One partition, in sort-key order, as DynamoDB answers a Query.
        rows = sorted(({'pk': pk, 'sk': sk, **row} for (pk, sk), row in self.rows.items()
                       if pk == values[':pk'] and sk.startswith(prefix)), key=lambda row: row['sk'])
        if 'FilterExpression' in request:
            rows = [row for row in rows if row.get('role') == values[':admin']]
        return {'Items': rows}

    def transact_write_items(self, **request: Any) -> None:
        self.transactions.append(request['TransactItems'])
        assert len(request['ClientRequestToken']) == 32
        if self.codes is not None:
            answer: Any = {'Error': {'Code': 'TransactionCanceledException'},
                           'CancellationReasons': [{'Code': code or 'None'} for code in self.codes]}
            self.error = ClientError(answer, 'TransactWriteItems')
            raise self.error


def _workspace(ws: str, members: dict[str, str]) -> dict[tuple[str, str], dict[str, Any]]:
    rows: dict[tuple[str, str], dict[str, Any]] = {(f'WS#{ws}', 'META'): {'status': 'active'}}
    for sub, role in members.items():
        rows[(f'WS#{ws}', f'MEMBER#{sub}')] = {'role': role}
        rows[(f'USER#{sub}', f'WS#{ws}')] = {'role': role, 'name': 'Team', 'slug': 't'}
    return rows


def _context(ws: str, platform_admin: bool) -> WorkspaceContext:
    return WorkspaceContext(ws=ws, role='admin', name='Team', slug='t', platform_admin=platform_admin)


def _still_admin(ws: str, sub: str) -> dict[str, Any]:
    return {'ConditionCheck': {'TableName': TABLE, 'Key': {'pk': f'WS#{ws}', 'sk': f'MEMBER#{sub}'},
                               'ConditionExpression': '#role = :admin', 'ExpressionAttributeNames': {'#role': 'role'},
                               'ExpressionAttributeValues': {':admin': 'admin'}}}


def _audit_row(ws: str, put: dict[str, Any], **fields: Any) -> None:
    """The audit put: a new row (conditional), in the workspace's audit partition, at ``NOW``, with ``fields``."""
    assert put['ConditionExpression'] == 'attribute_not_exists(pk)'
    item = put['Item']
    assert item['sk'].startswith(f'{NOW}#')
    assert item == {'pk': f'AUDIT#WS#{ws}', 'sk': item['sk'], 'at': NOW, **fields}


def _member_reads_are_consistent(table: Recorder) -> None:
    for get in table.gets:
        assert get == {'Key': get['Key'], 'ConsistentRead': True}


# An add is its audit row, then ONE transaction: the MEMBER# and USER# puts (each only on a new key), a check that
# the workspace is active, and, for a member admin acting on someone else, a check that they are still admin. A
# cancelled add is answered by which item failed, in this order: the actor's own check (403), the member row (409),
# the workspace (the one 404), the inverse row (409, logged), a conflict (409), anything else as it came.
@PROPERTY
@given(workspace_ids(), st.sampled_from(ROLES), st.booleans(), st.booleans(), st.booleans(),
       st.one_of(st.none(), st.lists(CODES, min_size=4, max_size=4)))
def test_an_add_is_one_transaction_and_its_failure_says_which(ws, role, platform_admin, self_add, created, codes):
    actor = 'nia' if self_add else 'ada'
    account = Account(sub='nia', email='nia@example.com', name='Nia', created=created)
    actor_checked = not platform_admin and actor != account.sub
    codes = None if codes is None else codes[:4 if actor_checked else 3]
    table = Recorder(_workspace(ws, {'ada': 'admin'}), codes)
    with patch('shared.workspace_members.now_iso', return_value=NOW), \
            patch('shared.workspace_members.logger') as logger:
        expected = _add_refusal(codes, actor_checked)
        answer = None
        if expected is None:
            answer = add_member(table, _context(ws, platform_admin), account, role, actor)
        else:
            with pytest.raises(expected[0], match=expected[1] and exactly(expected[1])) as raised:
                add_member(table, _context(ws, platform_admin), account, role, actor)
            assert table.error in (raised.value, raised.value.__cause__)
    member = {'role': role, 'invited_by': actor, 'joined_at': NOW, 'email': 'nia@example.com', 'name': 'Nia'}
    [transaction] = table.transactions
    assert transaction == [
        {'Put': {'TableName': TABLE, 'Item': {'pk': f'WS#{ws}', 'sk': 'MEMBER#nia', **member},
                 'ConditionExpression': 'attribute_not_exists(pk)'}},
        {'Put': {'TableName': TABLE, 'Item': {'pk': 'USER#nia', 'sk': f'WS#{ws}', 'name': 'Team', 'slug': 't',
                                              'role': role}, 'ConditionExpression': 'attribute_not_exists(pk)'}},
        {'ConditionCheck': {'TableName': TABLE, 'Key': {'pk': f'WS#{ws}', 'sk': 'META'},
                            'ConditionExpression': '#status = :active', 'ExpressionAttributeNames': {'#status': 'status'},
                            'ExpressionAttributeValues': {':active': 'active'}}},
        *([_still_admin(ws, actor)] if actor_checked else []),
    ]
    [put] = table.puts
    _audit_row(ws, put, kind=MEMBER_ADDED, actor=actor, target='nia', platform_admin=platform_admin, role_after=role,
               account='created' if created else 'existing')
    _member_reads_are_consistent(table)
    if expected is None:
        assert answer == {'sub': 'nia', **member}
        message = ('Workspace member added with a new account (Cognito emailed the temporary password)' if created
                   else 'Workspace member added; no notification email is sent')
        logger.info.assert_called_once_with(message, extra={'workspace_id': ws})
    else:
        assert not logger.info.called
    inverse_only = expected is not None and codes is not None and codes[:1] != [FAILED] and codes[2:3] != [FAILED] \
        and codes[1:2] == [FAILED] and not (actor_checked and codes[3:4] == [FAILED])
    assert logger.warning.called is inverse_only


def _add_refusal(codes: list[str | None] | None, actor_checked: bool) -> tuple[type[Exception], str | None] | None:
    if codes is None:
        return None
    if actor_checked and codes[3] == FAILED:
        return AuthorizationError, NO_LONGER_ADMIN
    if codes[0] == FAILED or (codes[1] == FAILED and codes[2] != FAILED):
        return ConflictError, ALREADY_MEMBER
    if codes[2] == FAILED:
        return NotFoundError, NOT_FOUND
    if 'TransactionConflict' in codes:
        return ConflictError, CHANGED_MEANWHILE
    return ClientError, None  # raised as it came: the same error object


# A role change or a removal is its audit row, then ONE transaction: the member's row (only while it still holds the
# role read), the inverse row, the other admin's check when the member stops being admin, and the acting admin's own
# check unless the transaction already names them. A cancelled one is answered: the actor's own check (403), the
# member's row or the other admin's or a conflict (409 "changed meanwhile"), anything else as it came.
@PROPERTY
@given(workspace_ids(), st.sampled_from(['change', 'remove', 'leave']), st.sampled_from(ROLES),
       st.sampled_from(ROLES), st.sampled_from(['ada', 'ben', 'platform']),
       st.one_of(st.none(), st.lists(CODES, min_size=4, max_size=4)))
# Regression: only the other admin's check (not the last item: the actor's follows it) failed.
@example('ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D8', 'remove', 'admin', 'viewer', 'ben', [None, None, FAILED, None])
def test_a_change_is_one_transaction_and_its_failure_says_which(ws, what, before, after, actor, codes):
    members = {'ada': 'admin', 'ben': 'admin', 'nia': before}
    target = 'nia'
    by: str = 'nia' if what == 'leave' else ('platform-admin' if actor == 'platform' else str(actor))
    if what == 'change' and before == after:
        # Asking for the role a member already has changes and records nothing: no audit row, no transaction.
        unchanged = Recorder(_workspace(ws, members))
        assert change_role(unchanged, _context(ws, actor == 'platform'), target, after, by) == {'sub': target,
                                                                                                 'role': after}
        assert unchanged.puts == unchanged.transactions == unchanged.queries == []
        return
    other: str | None = 'ada' if before == 'admin' and (what != 'change' or after != 'admin') else None
    actor_checked = actor != 'platform' and by not in (target, other)
    items = 2 + (other is not None) + actor_checked
    codes = None if codes is None else codes[:items]
    table = Recorder(_workspace(ws, members), codes)
    with patch('shared.workspace_members.now_iso', return_value=NOW), \
            patch('shared.workspace_members.logger') as logger:
        run = (lambda: change_role(table, _context(ws, actor == 'platform'), target, after, by)) if what == 'change' \
            else (lambda: remove_member(table, _context(ws, actor == 'platform'), target, by))
        expected = _change_refusal(codes, other is not None, actor_checked)
        if expected is None:
            run()
        else:
            with pytest.raises(expected[0], match=expected[1] and exactly(expected[1])) as raised:
                run()
            assert table.error in (raised.value, raised.value.__cause__)
    names = {'#role': 'role'}
    if what == 'change':
        rows = [{'Update': {'TableName': TABLE, 'Key': {'pk': f'WS#{ws}', 'sk': 'MEMBER#nia'},
                            'UpdateExpression': 'SET #role = :after',
                            'ConditionExpression': 'attribute_exists(pk) AND #role = :before',
                            'ExpressionAttributeNames': names,
                            'ExpressionAttributeValues': {':after': after, ':before': before}}},
                {'Update': {'TableName': TABLE, 'Key': {'pk': 'USER#nia', 'sk': f'WS#{ws}'},
                            'UpdateExpression': 'SET #role = :after', 'ConditionExpression': 'attribute_exists(pk)',
                            'ExpressionAttributeNames': names, 'ExpressionAttributeValues': {':after': after}}}]
    else:
        rows = [{'Delete': {'TableName': TABLE, 'Key': {'pk': f'WS#{ws}', 'sk': 'MEMBER#nia'},
                            'ConditionExpression': 'attribute_exists(pk) AND #role = :before',
                            'ExpressionAttributeNames': names, 'ExpressionAttributeValues': {':before': before}}},
                {'Delete': {'TableName': TABLE, 'Key': {'pk': 'USER#nia', 'sk': f'WS#{ws}'}}}]
    other_check = [] if other is None else [_still_admin(ws, other)]
    assert table.transactions == [[*rows, *other_check,
                                   *([_still_admin(ws, by)] if actor_checked else [])]]
    kind = {'change': MEMBER_ROLE_CHANGED, 'remove': MEMBER_REMOVED, 'leave': MEMBER_LEFT}[what]
    [put] = table.puts
    _audit_row(ws, put, kind=kind, actor=by, target='nia', platform_admin=actor == 'platform', role_before=before,
               **({'role_after': after} if what == 'change' else {}))
    _member_reads_are_consistent(table)
    if other is not None:
        assert table.queries == [{
            'KeyConditionExpression': 'pk = :pk AND begins_with(sk, :member)', 'FilterExpression': '#role = :admin',
            'ProjectionExpression': 'sk', 'ExpressionAttributeNames': {'#role': 'role'},
            'ExpressionAttributeValues': {':pk': f'WS#{ws}', ':member': 'MEMBER#', ':admin': 'admin'},
            'ConsistentRead': True}]
    if expected is None:
        message = 'Workspace member role changed' if what == 'change' else 'Workspace member removed'
        logger.info.assert_called_once_with(message, extra={'workspace_id': ws})
    else:
        assert not logger.info.called


def _change_refusal(codes: list[str | None] | None, other: bool,
                    actor_checked: bool) -> tuple[type[Exception], str | None] | None:
    if codes is None:
        return None
    if actor_checked and codes[-1] == FAILED:
        return AuthorizationError, NO_LONGER_ADMIN
    if codes[0] == FAILED or (other and codes[2] == FAILED) or 'TransactionConflict' in codes:
        return ConflictError, CHANGED_MEANWHILE
    return ClientError, None  # raised as it came: the same error object


# A deleted user's memberships go one workspace at a time: its audit row (``via: user_deleted``, and whether it left
# the workspace without an admin), then ONE transaction of the two deletes (the MEMBER# one only while it holds the
# role read) and the other admin's check; a cancelled one is "changed meanwhile" when a condition or a conflict
# cancelled it, else raised as it came. Each workspace left without an admin is logged by id, and the count at the end.
@PROPERTY
@given(st.lists(st.tuples(workspace_ids(), st.sampled_from(ROLES), st.booleans()), min_size=1, max_size=3,
                unique_by=lambda membership: membership[0]),
       st.one_of(st.none(), st.lists(CODES, min_size=3, max_size=3)))
def test_a_user_delete_removes_each_membership_in_one_transaction(memberships, codes):
    memberships = sorted(memberships)  # the order the user's USER# rows are read in: by workspace id
    rows: dict[tuple[str, str], dict[str, Any]] = {}
    for ws, role, other_admin in memberships:
        rows.update(_workspace(ws, {'nia': role, **({'ada': 'admin'} if other_admin else {})}))
    table = Recorder(rows)
    removal = plan_user_removal(table, 'nia', caller_is_platform_admin=lambda: True)
    _first_ws, first_role, first_other = memberships[0]
    table.codes = None if codes is None else codes[:3 if first_role == 'admin' and first_other else 2]
    with patch('shared.workspace_members.now_iso', return_value=NOW), \
            patch('shared.workspace_members.logger') as logger:
        if table.codes is None:
            assert remove_user_memberships(table, removal, 'pat') == len(memberships)
        elif FAILED in table.codes or 'TransactionConflict' in table.codes:
            with pytest.raises(ConflictError, match=exactly(CHANGED_MEANWHILE)) as raised:
                remove_user_memberships(table, removal, 'pat')
            assert raised.value.__cause__ is table.error
        else:
            with pytest.raises(ClientError) as raised:
                remove_user_memberships(table, removal, 'pat')
            assert raised.value is table.error
    done = memberships if table.codes is None else memberships[:1]
    assert len(table.transactions) == len(table.puts) == len(done)
    for (ws, role, other_admin), transaction, put in zip(done, table.transactions, table.puts, strict=True):
        last = role == 'admin' and not other_admin
        _audit_row(ws, put, kind=MEMBER_REMOVED, actor='pat', target='nia', platform_admin=True, role_before=role,
                   via='user_deleted', left_without_admin=last)
        assert transaction == [
            {'Delete': {'TableName': TABLE, 'Key': {'pk': f'WS#{ws}', 'sk': 'MEMBER#nia'},
                        'ConditionExpression': '#role = :before', 'ExpressionAttributeNames': {'#role': 'role'},
                        'ExpressionAttributeValues': {':before': role}}},
            {'Delete': {'TableName': TABLE, 'Key': {'pk': 'USER#nia', 'sk': f'WS#{ws}'}}},
            *([_still_admin(ws, 'ada')] if role == 'admin' and other_admin else []),
        ]
    if table.codes is None:
        orphaned = [ws for ws, role, other_admin in memberships if role == 'admin' and not other_admin]
        assert [(*call.args, call.kwargs) for call in logger.warning.call_args_list] == [
            ('A deleted user was the last admin of a workspace: a platform admin can name one', {'extra': {
                'workspace_id': ws}}) for ws in orphaned]
        logger.info.assert_called_once_with('Removed a deleted user from their workspaces',
                                            extra={'count': len(memberships)})
    else:
        assert not logger.info.called


# A row whose role is not one of the three is no membership: a change or a removal of it is the 404, before any
# write, and an add of that person goes on (its transaction's condition is what refuses a row already there).
@PROPERTY
@given(workspace_ids(), st.sampled_from(['owner', '', 'Admin', 'guest']), st.sampled_from(ROLES))
def test_a_row_with_another_role_is_no_membership(ws, stored, role):
    table = Recorder(_workspace(ws, {'ada': 'admin', 'nia': stored}))
    with patch('shared.workspace_members.now_iso', return_value=NOW):
        for run in (lambda: change_role(table, _context(ws, False), 'nia', role, 'ada'),
                    lambda: remove_member(table, _context(ws, False), 'nia', 'ada')):
            with pytest.raises(NotFoundError, match=exactly(MEMBER_NOT_FOUND)):
                run()
        assert not table.puts
        assert not table.transactions
        add_member(table, _context(ws, False), Account(sub='nia', email='n@example.com', name='N', created=False),
                   role, 'ada')
    assert len(table.transactions) == 1


# A new account's creation is recorded before it is made, with the email kept as the sha256 of its trimmed,
# lower-cased form only (no role can ever erase an audit row, so no raw address goes in one).
@PROPERTY
@given(workspace_ids(), st.emails(), st.sampled_from(['', ' ', '  \t']), st.booleans(), st.booleans())
def test_an_account_creation_is_recorded_by_its_email_hash(ws, email, padding, upper, platform_admin):
    table = Recorder({})
    written = f'{padding}{email.upper() if upper else email}{padding}'
    with patch('shared.workspace_members.now_iso', return_value=NOW):
        audit_account_creation(table, _context(ws, platform_admin), 'ada', written)
    [put] = table.puts
    _audit_row(ws, put, kind=ACCOUNT_CREATION, actor='ada', platform_admin=platform_admin,
               email_sha256=hashlib.sha256(email.strip().lower().encode()).hexdigest())


# A deleted user's plan reads their own USER# rows only (one consistent Query), keeps each workspace's name and slug,
# and leaves out a row that names no workspace, logging how many.
@PROPERTY
@given(st.lists(workspace_ids(), max_size=3, unique=True), st.integers(min_value=0, max_value=3))
def test_a_user_delete_plan_reads_the_user_rows_only(workspaces, malformed):
    workspaces = sorted(workspaces)  # the order the user's USER# rows are read in
    rows: dict[tuple[str, str], dict[str, Any]] = {}
    for n, ws in enumerate(workspaces):
        rows.update(_workspace(ws, {'nia': 'editor'}))
        rows[('USER#nia', f'WS#{ws}')] = {'role': 'editor', 'name': f'Team {n}', 'slug': f'team-{n}'}
    for n in range(malformed):
        rows[('USER#nia', f'WS#broken{n}')] = {'role': 'editor', 'name': 'x', 'slug': 'x'}
    table = Recorder(rows)
    with patch('shared.workspace_members.logger') as logger:
        removal = plan_user_removal(table, 'nia', caller_is_platform_admin=lambda: False)
    assert [(m.ws, m.name, m.slug, m.role) for m in removal.memberships] == [
        (ws, f'Team {n}', f'team-{n}', 'editor') for n, ws in enumerate(workspaces)]
    assert table.queries == [{'KeyConditionExpression': 'pk = :pk AND begins_with(sk, :ws)',
                              'ExpressionAttributeValues': {':pk': 'USER#nia', ':ws': 'WS#'}, 'ConsistentRead': True}]
    if malformed:
        logger.warning.assert_called_once_with('Left out malformed my-workspaces rows of a deleted user',
                                               extra={'count': malformed})
    else:
        assert not logger.warning.called
