"""Properties of the workspace a request acts in (shared/workspace.py ``resolve_workspace`` and its readers).

A non-member who gets in, a workspace being deleted that still answers, a delegated credential that acts as an admin,
an answer that tells a stranger another team's workspace exists, or a cached membership that outlives its 30 s: each
is a trust failure. The documented rules are written once below as a plain oracle, and generated requests (members of
every role, strangers, platform admins confirmed or not, delegated credentials and agents, malformed and missing
headers, active and deleting workspaces) are checked against it. The generators lean towards the common case (a
well-formed header, a person, an active workspace), so the rarer paths (a confirmed platform admin's entry) still
come up dozens of times a run.
"""
from __future__ import annotations

import re
from typing import Any
from unittest.mock import patch

import pytest
from hypothesis import given
from hypothesis import strategies as st

from shared.exceptions import AuthorizationError, NotFoundError, ValidationError
from shared.test.ws_properties import PROPERTY, exactly, two_workspace_ids, workspace_ids
from shared.workspace import (
    DELEGATED_ROLE_CAP,
    MEMBERSHIP_TTL_SECONDS,
    NOT_FOUND,
    PLATFORM_ADMIN_ENTRY,
    MembershipCache,
    WorkspaceContext,
    is_active,
    list_my_workspaces,
    require_workspace_admin,
    resolve_workspace,
)

PERSON = 'sub-ana'
#: What every resolver read asks for: a strongly consistent read of the row's own attributes only.
MEMBER_READ = {'ConsistentRead': True, 'ProjectionExpression': '#a0, #a1, #a2',
               'ExpressionAttributeNames': {'#a0': 'pk', '#a1': 'sk', '#a2': 'role'}}
META_READ = {'ConsistentRead': True, 'ProjectionExpression': '#a0, #a1, #a2, #a3, #a4',
             'ExpressionAttributeNames': {'#a0': 'pk', '#a1': 'sk', '#a2': 'status', '#a3': 'name', '#a4': 'slug'}}


class Rows:
    """The voc-workspaces double: rows by key; ``get_item`` answers what is stored and records the request,
    ``put_item`` records (audit), ``query`` answers one partition's rows."""

    def __init__(self, rows: dict[tuple[str, str], dict[str, Any]]) -> None:
        self.rows = rows
        self.puts: list[dict[str, Any]] = []
        self.reads: list[dict[str, Any]] = []
        self.queries: list[dict[str, Any]] = []

    def get_item(self, **request: Any) -> dict[str, Any]:
        self.reads.append(request)
        row = self.rows.get((request['Key']['pk'], request['Key']['sk']))
        return {} if row is None else {'Item': dict(row)}

    def put_item(self, **request: Any) -> None:
        self.puts.append(request['Item'])

    def query(self, **request: Any) -> dict[str, Any]:
        self.queries.append(request)
        pk = request['ExpressionAttributeValues'][':pk']
        return {'Items': [{'pk': key[0], 'sk': key[1], **row} for key, row in self.rows.items() if key[0] == pk]}


class Clock:
    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now


CALLERS = ['person'] * 4 + ['mcp', 'agent', 'mcp-for-nobody', 'mcp-for-mcp', 'agent-bad']


@st.composite
def requests(draw: st.DrawFn) -> dict[str, Any]:
    """One request's world: the workspace, the caller and what is stored about them."""
    ws, other = draw(two_workspace_ids())
    return {
        'ws': ws,
        'header': draw(st.sampled_from(['ok'] * 3 + ['padded', 'other', 'missing', 'blank', 'malformed'])),
        'header_name': draw(st.sampled_from(['X-Workspace-Id', 'x-workspace-id', 'X-WORKSPACE-ID'])),
        'other': other,
        'role': draw(st.sampled_from([None, 'viewer', 'editor', 'admin', 'owner', ''])),
        'status': draw(st.sampled_from(['active'] * 3 + ['deleting', None])),
        'group': draw(st.booleans()),
        'live': draw(st.booleans()),
        'caller': draw(st.sampled_from(CALLERS)),
    }


def _event(world: dict[str, Any], person: str = PERSON) -> dict[str, Any]:
    value = {'ok': world['ws'], 'other': world['other'], 'missing': None, 'blank': '  ',
             'malformed': world['ws'].lower() + 'x', 'padded': f"  {world['ws']} "}[world['header']]
    headers = {} if value is None else {world['header_name']: value}
    claims: dict[str, Any] = {'sub': person, 'cognito:groups': '[users, platform-admins]' if world['group'] else 'users'}
    acting = {'mcp': ('mcp:tok_1', person), 'mcp-for-nobody': ('mcp:tok_1', None), 'agent': ('agent:ag_1', person),
              'mcp-for-mcp': ('mcp:tok_1', 'mcp:tok_2'), 'agent-bad': ('agent:a,b', person)}.get(world['caller'])
    if acting is not None:
        claims = {**claims, 'sub': acting[0], **({'voc:acting_subject': acting[1]} if acting[1] else {})}
    return {'headers': headers, 'requestContext': {'authorizer': {'claims': claims}}}


def _rows(world: dict[str, Any]) -> Rows:
    rows: dict[tuple[str, str], dict[str, Any]] = {}
    if world['status'] is not None:
        rows[(f"WS#{world['ws']}", 'META')] = {'status': world['status'], 'name': 'Acme', 'slug': 'acme'}
    if world['role'] is not None:
        rows[(f"WS#{world['ws']}", f'MEMBER#{PERSON}')] = {'role': world['role']}
    return Rows(rows)


def _stored_role(world: dict[str, Any]) -> str | None:
    """The caller's role in the workspace the header names (one with no rows, 'other', has no member)."""
    named_own = world['header'] in ('ok', 'padded')
    return world['role'] if named_own and world['role'] in ('viewer', 'editor', 'admin') else None


def _oracle(world: dict[str, Any]) -> tuple[str, str] | WorkspaceContext:
    """The documented answer: ('400' | '404', why) or the context."""
    if world['header'] in ('missing', 'blank'):
        return ('400', 'The X-Workspace-Id header is required')
    if world['header'] == 'malformed' or world['caller'] in ('mcp-for-nobody', 'mcp-for-mcp', 'agent-bad'):
        return ('404', NOT_FOUND)
    delegated = world['caller'] != 'person'
    role = _stored_role(world)
    elevated = world['group'] and not delegated and role != 'admin' and world['live']
    active = world['header'] != 'other' and world['status'] == 'active'
    if (role is None and not elevated) or not active:
        return ('404', NOT_FOUND)
    if elevated:
        return WorkspaceContext(ws=world['ws'], role='admin', name='Acme', slug='acme', platform_admin=True)
    capped = DELEGATED_ROLE_CAP if delegated and role == 'admin' else role
    return WorkspaceContext(ws=world['ws'], role=capped or '', name='Acme', slug='acme', platform_admin=False)


def _expected_reads(world: dict[str, Any], answer: tuple[str, str] | WorkspaceContext) -> int:
    """The reads the answer costs: none for a refused header or caller, one for a non-member, two otherwise."""
    if world['header'] in ('missing', 'blank', 'malformed') or world['caller'] in ('mcp-for-nobody', 'mcp-for-mcp',
                                                                                     'agent-bad'):
        return 0
    elevated_candidate = world['group'] and world['caller'] == 'person' and world['live']
    return 2 if isinstance(answer, WorkspaceContext) or _stored_role(world) or elevated_candidate else 1


# Every request gets exactly the documented answer: a missing header 400; a malformed id, an unknown or deleting
# workspace, a stranger and a credential acting for nobody the ONE 404 with the same words; a member their role; a
# platform admin the live check confirms enters as admin (audited, logged); a delegated credential or agent acts as
# its person, never above editor and never elevated. Each read is strongly consistent and of the row's own
# attributes, and a refused caller costs no read at all.
@PROPERTY
@given(requests())
def test_a_request_gets_the_documented_answer(world):
    table = _rows(world)
    live_calls: list[dict] = []

    def live(event: dict) -> bool:
        live_calls.append(event)
        return world['live']

    expected = _oracle(world)
    with patch('shared.workspace.logger') as logger:
        if isinstance(expected, tuple):
            error = ValidationError if expected[0] == '400' else NotFoundError
            with pytest.raises(error, match=exactly(expected[1])):
                resolve_workspace(table, _event(world), MembershipCache(), confirm_platform_admin=live)
        else:
            assert resolve_workspace(table, _event(world), MembershipCache(), confirm_platform_admin=live) == expected
    audits = [row for row in table.puts if row.get('kind') == PLATFORM_ADMIN_ENTRY]
    entered = isinstance(expected, WorkspaceContext) and expected.platform_admin
    assert len(table.puts) == len(audits) == (1 if entered else 0)
    if entered:
        ws = world['ws']
        assert audits[0] == {'pk': f'AUDIT#WS#{ws}', 'sk': audits[0]['sk'], 'kind': PLATFORM_ADMIN_ENTRY,
                             'actor': PERSON, 'at': audits[0]['at']}
        assert re.fullmatch(rf"{re.escape(audits[0]['at'])}#[0-9a-f]{{16}}", audits[0]['sk'])
        logger.info.assert_called_once_with('Platform admin entered a workspace', extra={'workspace_id': ws})
    else:
        assert not logger.info.called
    assert len(table.reads) == _expected_reads(world, expected)
    for read, projection in zip(table.reads, (MEMBER_READ, META_READ), strict=False):
        assert {name: value for name, value in read.items() if name != 'Key'} == projection
    # The live check runs once for a person whose token carries the group and who is not a member admin, else never.
    checks = world['header'] in ('ok', 'padded', 'other') and world['group'] and world['caller'] == 'person'
    assert len(live_calls) == (1 if checks and _stored_role(world) != 'admin' else 0)


# A stranger's answer and its cost are the same whether or not the workspace exists: the one 404, after one read.
@PROPERTY
@given(two_workspace_ids(), st.sampled_from(['active', 'deleting', None]))
def test_a_stranger_learns_nothing_of_a_workspace(pair, status):
    ws, other = pair
    world = {'ws': ws, 'header': 'ok', 'header_name': 'X-Workspace-Id', 'other': other, 'role': None,
             'status': status, 'group': False, 'live': False, 'caller': 'person'}
    table = _rows(world)
    with pytest.raises(NotFoundError, match=exactly(NOT_FOUND)):
        resolve_workspace(table, _event(world), MembershipCache(), confirm_platform_admin=lambda _event: False)
    assert len(table.reads) == 1


# A resolved membership is served from the container's cache for at most the TTL, per (workspace, person, group or
# not): within it a removal is not seen yet; from the TTL on, it is (the one 404); a refusal is never cached; and
# another person is never served the first one's entry.
@PROPERTY
@given(two_workspace_ids(), st.sampled_from(['viewer', 'editor', 'admin']),
       st.integers(min_value=0, max_value=int(MEMBERSHIP_TTL_SECONDS * 3000)))
def test_a_cached_membership_lives_at_most_the_ttl(pair, role, later_ms):
    later = later_ms / 1000  # whole milliseconds: exact around the 30 s edge, no float rounding across it
    ws, other = pair
    world = {'ws': ws, 'header': 'ok', 'header_name': 'X-Workspace-Id', 'other': other, 'role': role,
             'status': 'active', 'group': False, 'live': False, 'caller': 'person'}
    table = _rows(world)
    clock = Clock()
    cache = MembershipCache(clock=clock)
    event = _event(world)
    first = resolve_workspace(table, event, cache, confirm_platform_admin=lambda _event: False)
    with pytest.raises(NotFoundError, match=exactly(NOT_FOUND)):
        resolve_workspace(table, _event(world, person='sub-sam'), cache, confirm_platform_admin=lambda _event: False)
    del table.rows[(f'WS#{ws}', f'MEMBER#{PERSON}')]
    clock.now += later
    if later < MEMBERSHIP_TTL_SECONDS:
        assert resolve_workspace(table, event, cache, confirm_platform_admin=lambda _event: False) == first
    else:
        with pytest.raises(NotFoundError, match=exactly(NOT_FOUND)):
            resolve_workspace(table, event, cache, confirm_platform_admin=lambda _event: False)
        table.rows[(f'WS#{ws}', f'MEMBER#{PERSON}')] = {'role': role}
        assert resolve_workspace(table, event, cache, confirm_platform_admin=lambda _event: False) == first


# A background worker goes on writing in a workspace only while its META row says active (read strongly consistent).
@PROPERTY
@given(workspace_ids(), st.sampled_from(['active', 'deleting', 'ACTIVE', '', None, 'absent']))
def test_a_worker_sees_a_workspace_active_only_while_it_is(ws, status):
    rows = {} if status == 'absent' else {(f'WS#{ws}', 'META'): {'status': status, 'name': 'n', 'slug': 's'}}
    table = Rows(rows)
    assert is_active(table, ws) is (status == 'active')
    assert table.reads == [{'Key': {'pk': f'WS#{ws}', 'sk': 'META'}, **META_READ}]


# Only an admin context administers: anyone else gets the 403 with its one message.
@PROPERTY
@given(workspace_ids(), st.sampled_from(['viewer', 'editor', '', 'owner', 'Admin']), st.booleans())
def test_only_an_admin_administers(ws, role, platform_admin):
    require_workspace_admin(WorkspaceContext(ws=ws, role='admin', name='n', slug='s', platform_admin=platform_admin))
    with pytest.raises(AuthorizationError, match=exactly('Workspace admin access required')):
        require_workspace_admin(WorkspaceContext(ws=ws, role=role, name='n', slug='s', platform_admin=platform_admin))


# "My workspaces" is the caller's own USER# rows, well formed only, sorted by name (case-folded, then id), read by
# one Query of their own partition.
@PROPERTY
@given(st.lists(st.tuples(workspace_ids(), st.text(alphabet='abAB cZ', max_size=6),
                          st.sampled_from(['viewer', 'editor', 'admin', 'owner']), st.booleans()),
                max_size=6, unique_by=lambda row: row[0]))
def test_my_workspaces_are_my_well_formed_rows_by_name(rows):
    stored = {('USER#sub-ana', f'WS#{ws}' if well_formed else f'WS#{ws.lower()}x'): {'name': name, 'slug': 's',
                                                                                       'role': role}
              for ws, name, role, well_formed in rows}
    stored[('USER#sub-sam', 'WS#ws_7ZZZZZZZZZZZZZZZZZZZZZZZZZ')] = {'name': 'theirs', 'slug': 's', 'role': 'admin'}
    table = Rows(stored)
    expected = sorted(({'id': ws, 'name': name, 'slug': 's', 'role': role} for ws, name, role, well_formed in rows
                       if well_formed and role != 'owner'), key=lambda found: (found['name'].casefold(), found['id']))
    assert list_my_workspaces(table, 'sub-ana') == expected
    assert table.queries == [{'KeyConditionExpression': 'pk = :pk AND begins_with(sk, :ws)',
                              'ExpressionAttributeValues': {':pk': 'USER#sub-ana', ':ws': 'WS#'}}]
