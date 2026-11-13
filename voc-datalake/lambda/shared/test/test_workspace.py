"""shared/workspace.py: the workspace a request acts in (docs/multi-workspace.md, "Request flow")."""
from collections.abc import Iterator
from unittest.mock import patch

import pytest
from botocore.exceptions import ClientError
from moto import mock_aws

from shared.exceptions import AuthorizationError, NotFoundError, ValidationError
from shared.test.moto_tables import create_pk_sk_table
from shared.workspace import (
    MAX_CACHED_MEMBERSHIPS,
    NOT_FOUND,
    PLATFORM_ADMIN_ENTRY,
    MembershipCache,
    WorkspaceContext,
    audit_key,
    is_workspace_id,
    list_my_workspaces,
    require_workspace_admin,
    resolve_workspace,
    ws_key,
)

WS = 'ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D8'
OTHER_WS = 'ws_7ZZZZZZZZZZZZZZZZZZZZZZZZZ'
MEMBER = {'sub': 'sub-ana', 'cognito:groups': 'users'}
STRANGER = {'sub': 'sub-sam', 'cognito:groups': 'users'}
PLATFORM_ADMIN = {'sub': 'sub-pat', 'cognito:groups': '[admins, platform-admins]'}


class LiveCheck:
    """The live platform-admin check double: answers ``confirmed`` (or raises ``fault``) and records each event."""

    def __init__(self, confirmed: bool = True, fault: Exception | None = None) -> None:
        self.confirmed = confirmed
        self.fault = fault
        self.calls: list[dict] = []

    def __call__(self, event: dict) -> bool:
        self.calls.append(event)
        if self.fault is not None:
            raise self.fault
        return self.confirmed


def _resolve(table, event, cache, live: LiveCheck | None = None) -> WorkspaceContext:
    return resolve_workspace(table, event, cache, confirm_platform_admin=live or LiveCheck())


class FakeClock:
    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now


def _event(claims, headers=None):
    return {'headers': headers, 'requestContext': {'authorizer': {'claims': claims}}}


def _ws_event(claims, ws=WS, header='X-Workspace-Id'):
    return _event(claims, {header: ws, 'Content-Type': 'application/json'})


@pytest.fixture
def table() -> Iterator:
    with mock_aws():
        created = create_pk_sk_table('workspaces')
        created.put_item(Item={'pk': f'WS#{WS}', 'sk': 'META', 'name': 'Acme Outfitters', 'slug': 'acme',
                               'status': 'active'})
        created.put_item(Item={'pk': f'WS#{WS}', 'sk': 'MEMBER#sub-ana', 'role': 'editor'})
        yield created


def _audit_rows(table, ws=WS):
    return table.query(KeyConditionExpression='pk = :pk',
                       ExpressionAttributeValues={':pk': f'AUDIT#WS#{ws}'})['Items']


def _workspace_rows(table, ws=WS):
    return table.query(KeyConditionExpression='pk = :pk', ExpressionAttributeValues={':pk': f'WS#{ws}'})['Items']


# ── The header ───────────────────────────────────────────────────────────────

@pytest.mark.parametrize('header', ['X-Workspace-Id', 'x-workspace-id', 'X-WORKSPACE-ID'])
def test_the_header_is_found_whatever_its_case(table, header):
    context = _resolve(table,_ws_event(MEMBER, header=header), MembershipCache())
    assert context == WorkspaceContext(ws=WS, role='editor', name='Acme Outfitters', slug='acme',
                                       platform_admin=False)


@pytest.mark.parametrize('headers', [None, {}, {'X-Workspace-Id': ''}, {'X-Workspace-Id': '   '},
                                     {'X-Workspace-Id': None}], ids=['none', 'empty', 'blank', 'spaces', 'null'])
def test_a_missing_header_is_a_400(table, headers):
    with pytest.raises(ValidationError, match='X-Workspace-Id'):
        _resolve(table,_event(MEMBER, headers), MembershipCache())


@pytest.mark.parametrize('ws', [
    'ws_01jc3q8zk6v7w9x2y4a5b6c7d8',   # lower case
    'ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D',    # 25 characters
    'ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D8A',  # 27 characters
    'ws_81JC3Q8ZK6V7W9X2Y4A5B6C7D8',   # first character above 7 (more than 128 bits)
    'ws_01JC3Q8ZK6V7W9X2Y4A5B6C7DI',   # I is not Crockford base32
    'WS#01JC3Q8ZK6V7W9X2Y4A5B6C7D8',
    f'{WS}#MEMBER#sub-ana',
], ids=['lower', 'short', 'long', 'overflow', 'letter-i', 'key-prefix', 'key-injection'])
def test_a_malformed_id_is_the_same_404_as_any_other(table, ws):
    with pytest.raises(NotFoundError, match=NOT_FOUND):
        _resolve(table,_ws_event(MEMBER, ws=ws), MembershipCache())


# ── Membership ───────────────────────────────────────────────────────────────

def test_a_caller_who_is_not_a_member_gets_404(table):
    with pytest.raises(NotFoundError, match=NOT_FOUND):
        _resolve(table,_ws_event(STRANGER), MembershipCache())


@pytest.mark.parametrize('ws', [WS, OTHER_WS], ids=['exists', 'does-not-exist'])
def test_a_non_member_costs_one_read_whether_or_not_the_workspace_exists(table, ws):
    # Neither the answer nor its timing confirms another team's workspace: the membership row is read first.
    with patch.object(table, 'get_item', wraps=table.get_item) as get_item, pytest.raises(NotFoundError, match=NOT_FOUND):
        _resolve(table,_ws_event(STRANGER, ws=ws), MembershipCache())
    assert [call.kwargs['Key'] for call in get_item.call_args_list] == [{'pk': f'WS#{ws}', 'sk': 'MEMBER#sub-sam'}]


def test_a_workspace_that_does_not_exist_is_404_even_for_a_platform_admin(table):
    with pytest.raises(NotFoundError, match=NOT_FOUND):
        _resolve(table,_ws_event(PLATFORM_ADMIN, ws=OTHER_WS), MembershipCache())
    assert _audit_rows(table, OTHER_WS) == []


@pytest.mark.parametrize('claims', [MEMBER, PLATFORM_ADMIN], ids=['member', 'platform-admin'])
def test_a_deleting_workspace_is_404_for_everyone(table, claims):
    table.update_item(Key={'pk': f'WS#{WS}', 'sk': 'META'}, UpdateExpression='SET #s = :s',
                      ExpressionAttributeNames={'#s': 'status'}, ExpressionAttributeValues={':s': 'deleting'})
    with pytest.raises(NotFoundError, match=NOT_FOUND):
        _resolve(table,_ws_event(claims), MembershipCache())
    assert _audit_rows(table) == []


def test_a_workspace_without_a_status_is_not_active(table):
    table.put_item(Item={'pk': f'WS#{WS}', 'sk': 'META', 'name': 'Acme Outfitters', 'slug': 'acme'})
    with pytest.raises(NotFoundError, match=NOT_FOUND):
        _resolve(table,_ws_event(MEMBER), MembershipCache())


@pytest.mark.parametrize('role', ['admin', 'editor', 'viewer'])
def test_a_member_acts_with_the_role_of_their_row(table, role):
    table.put_item(Item={'pk': f'WS#{WS}', 'sk': 'MEMBER#sub-ana', 'role': role})
    assert _resolve(table,_ws_event(MEMBER), MembershipCache()).role == role


@pytest.mark.parametrize('role', ['owner', 'Admin', ''], ids=['unknown', 'case', 'empty'])
def test_a_member_row_with_an_unknown_role_is_no_membership(table, role):
    table.put_item(Item={'pk': f'WS#{WS}', 'sk': 'MEMBER#sub-ana', 'role': role})
    with pytest.raises(NotFoundError, match=NOT_FOUND):
        _resolve(table,_ws_event(MEMBER), MembershipCache())


def test_the_name_and_slug_default_to_empty_text(table):
    table.put_item(Item={'pk': f'WS#{WS}', 'sk': 'META', 'status': 'active', 'name': 7})
    context = _resolve(table,_ws_event(MEMBER), MembershipCache())
    assert (context.name, context.slug) == ('', '')


# ── Platform admins ──────────────────────────────────────────────────────────

def test_a_platform_admin_who_is_not_a_member_enters_as_admin_and_is_audited(table):
    with patch('shared.workspace.now_iso', return_value='2026-11-11T09:00:00+00:00'):
        context = _resolve(table,_ws_event(PLATFORM_ADMIN), MembershipCache())
    assert (context.role, context.platform_admin) == ('admin', True)
    [row] = _audit_rows(table)
    # The partition starts with AUDIT# (the audit-row guard covers it, lib/utils/audit-row-guard.ts).
    assert row['pk'] == f'AUDIT#WS#{WS}' == audit_key(WS)
    assert row['sk'].startswith('2026-11-11T09:00:00+00:00#')
    assert {key: row[key] for key in ('kind', 'actor', 'at')} == {
        'kind': PLATFORM_ADMIN_ENTRY, 'actor': 'sub-pat', 'at': '2026-11-11T09:00:00+00:00'}
    # Nothing is written in the workspace's own partition (META and the members only).
    assert sorted(item['sk'] for item in _workspace_rows(table)) == ['MEMBER#sub-ana', 'META']


@pytest.mark.parametrize('role', ['viewer', 'editor'])
def test_a_platform_admin_who_is_a_lower_member_still_enters_as_admin_and_is_audited(table, role):
    # Decision 2: full admin rights in any workspace; a viewer or editor membership does not cap them.
    table.put_item(Item={'pk': f'WS#{WS}', 'sk': 'MEMBER#sub-pat', 'role': role})
    context = _resolve(table,_ws_event(PLATFORM_ADMIN), MembershipCache())
    assert (context.role, context.platform_admin) == ('admin', True)
    assert len(_audit_rows(table)) == 1


def test_a_platform_admin_who_is_a_member_admin_is_a_member_and_writes_no_audit_row(table):
    table.put_item(Item={'pk': f'WS#{WS}', 'sk': 'MEMBER#sub-pat', 'role': 'admin'})
    context = _resolve(table,_ws_event(PLATFORM_ADMIN), MembershipCache())
    assert (context.role, context.platform_admin) == ('admin', False)
    assert _audit_rows(table) == []


def test_an_audit_row_is_written_once_per_cache_fill_not_per_request(table):
    clock = FakeClock()
    cache = MembershipCache(ttl_seconds=30, clock=clock)
    for _ in range(3):
        _resolve(table,_ws_event(PLATFORM_ADMIN), cache)
    assert len(_audit_rows(table)) == 1
    clock.now += 30
    _resolve(table,_ws_event(PLATFORM_ADMIN), cache)
    assert len(_audit_rows(table)) == 2


_FIXED_SK = '2026-11-11T09:00:00+00:00#00000000'


def _fixed_audit_key():
    """The entry's audit row lands at ``_FIXED_SK``: its time and random suffix are pinned."""
    return (patch('shared.workspace.now_iso', return_value='2026-11-11T09:00:00+00:00'),
            patch('shared.workspace.secrets.token_hex', return_value='00000000'))


def test_the_audit_put_never_overwrites_another_row(table):
    other = {'pk': audit_key(WS), 'sk': _FIXED_SK, 'kind': PLATFORM_ADMIN_ENTRY, 'actor': 'sub-someone-else',
             'at': '2026-11-11T09:00:00+00:00'}
    table.put_item(Item=other)
    clock, suffix = _fixed_audit_key()
    with clock, suffix, pytest.raises(ClientError, match='ConditionalCheckFailed'):
        _resolve(table,_ws_event(PLATFORM_ADMIN), MembershipCache())
    assert _audit_rows(table) == [other]


def test_a_retried_put_whose_first_attempt_landed_counts_as_audited(table):
    # botocore retries a put whose answer was lost; the retry then fails the condition on the row it wrote itself.
    real_put = table.put_item

    def landed_then_lost(**kwargs):
        real_put(**kwargs)
        return real_put(**kwargs)

    clock, suffix = _fixed_audit_key()
    with clock, suffix, patch.object(table, 'put_item', side_effect=landed_then_lost):
        context = _resolve(table,_ws_event(PLATFORM_ADMIN), MembershipCache())
    assert (context.role, context.platform_admin) == ('admin', True)
    assert [(row['sk'], row['actor']) for row in _audit_rows(table)] == [(_FIXED_SK, 'sub-pat')]


def test_an_entry_whose_audit_row_cannot_be_written_is_refused_and_not_cached(table):
    cache = MembershipCache()
    table.put_item(Item={'pk': audit_key(WS), 'sk': _FIXED_SK, 'kind': 'other'})
    clock, suffix = _fixed_audit_key()
    with clock, suffix, pytest.raises(ClientError):
        _resolve(table,_ws_event(PLATFORM_ADMIN), cache)
    assert cache.get(WS, 'sub-pat') is None


def test_an_audit_put_that_fails_otherwise_is_not_retried_as_audited(table):
    denied = ClientError({'Error': {'Code': 'AccessDeniedException', 'Message': 'no'}}, 'PutItem')
    with patch.object(table, 'put_item', side_effect=denied), patch.object(table, 'get_item', wraps=table.get_item) as get, \
            pytest.raises(ClientError, match='AccessDenied'):
        _resolve(table,_ws_event(PLATFORM_ADMIN), MembershipCache())
    # Only the membership and META reads: no look-up of the audit row for a failure that is not the condition.
    assert [call.kwargs['Key']['sk'] for call in get.call_args_list] == ['MEMBER#sub-pat', 'META']


# ── The live platform-admin check on entry ───────────────────────────────────

def test_an_elevating_entry_runs_the_live_check_once_per_cache_fill(table):
    live = LiveCheck()
    cache = MembershipCache()
    for _ in range(3):
        assert _resolve(table, _ws_event(PLATFORM_ADMIN), cache, live).platform_admin is True
    assert len(live.calls) == 1
    assert live.calls[0]['requestContext']['authorizer']['claims'] == PLATFORM_ADMIN


def test_a_revoked_or_disabled_platform_admin_who_is_not_a_member_gets_404_and_no_audit_row(table):
    # The token still carries the group; the live check (membership and enabled account) says no.
    cache = MembershipCache()
    with pytest.raises(NotFoundError, match=NOT_FOUND):
        _resolve(table, _ws_event(PLATFORM_ADMIN), cache, LiveCheck(confirmed=False))
    assert _audit_rows(table) == []
    assert cache.get(WS, 'sub-pat', platform_admin=True) is None


@pytest.mark.parametrize('role', ['viewer', 'editor'])
def test_a_revoked_platform_admin_who_is_a_member_enters_with_the_member_role(table, role):
    table.put_item(Item={'pk': f'WS#{WS}', 'sk': 'MEMBER#sub-pat', 'role': role})
    context = _resolve(table, _ws_event(PLATFORM_ADMIN), MembershipCache(), LiveCheck(confirmed=False))
    assert (context.role, context.platform_admin) == (role, False)
    assert _audit_rows(table) == []


@pytest.mark.parametrize('claims', [MEMBER, PLATFORM_ADMIN], ids=['no-group', 'member-admin'])
def test_no_live_check_runs_when_nothing_would_elevate(table, claims):
    table.put_item(Item={'pk': f'WS#{WS}', 'sk': 'MEMBER#sub-pat', 'role': 'admin'})
    live = LiveCheck(fault=AssertionError('the live check must not run'))
    _resolve(table, _ws_event(claims), MembershipCache(), live)
    assert live.calls == []


def test_a_failed_live_check_refuses_the_entry_and_caches_nothing(table):
    cache = MembershipCache()
    fault = ClientError({'Error': {'Code': 'TooManyRequestsException', 'Message': 'slow down'}}, 'AdminGetUser')
    with pytest.raises(ClientError, match='TooManyRequests'):
        _resolve(table, _ws_event(PLATFORM_ADMIN), cache, LiveCheck(fault=fault))
    assert (cache.get(WS, 'sub-pat', platform_admin=True), _audit_rows(table)) == (None, [])


def test_a_live_check_that_ends_is_seen_on_the_next_cache_fill(table):
    clock = FakeClock()
    cache = MembershipCache(ttl_seconds=30, clock=clock)
    live = LiveCheck()
    assert _resolve(table, _ws_event(PLATFORM_ADMIN), cache, live).platform_admin is True
    live.confirmed = False
    clock.now += 30
    with pytest.raises(NotFoundError, match=NOT_FOUND):
        _resolve(table, _ws_event(PLATFORM_ADMIN), cache, live)


# ── The cache ────────────────────────────────────────────────────────────────

def test_a_membership_is_served_from_the_cache_until_its_ttl_passes(table):
    clock = FakeClock()
    cache = MembershipCache(ttl_seconds=30, clock=clock)
    _resolve(table,_ws_event(MEMBER), cache)
    table.delete_item(Key={'pk': f'WS#{WS}', 'sk': 'MEMBER#sub-ana'})
    clock.now += 29.9
    assert _resolve(table,_ws_event(MEMBER), cache).role == 'editor'
    clock.now += 0.1
    with pytest.raises(NotFoundError):
        _resolve(table,_ws_event(MEMBER), cache)


def test_a_refusal_is_not_cached(table):
    cache = MembershipCache()
    with pytest.raises(NotFoundError):
        _resolve(table,_ws_event(STRANGER), cache)
    table.put_item(Item={'pk': f'WS#{WS}', 'sk': 'MEMBER#sub-sam', 'role': 'viewer'})
    assert _resolve(table,_ws_event(STRANGER), cache).role == 'viewer'


def test_the_cache_is_per_workspace_and_caller():
    cache = MembershipCache()
    context = WorkspaceContext(ws=WS, role='admin', name='', slug='', platform_admin=False)
    cache.put(WS, 'sub-ana', context)
    assert (cache.get(WS, 'sub-ana'), cache.get(WS, 'sub-sam'), cache.get(OTHER_WS, 'sub-ana')) == (context, None, None)


def test_a_token_that_lost_the_platform_admin_group_is_resolved_again_not_served_from_the_cache(table):
    cache = MembershipCache()
    assert _resolve(table,_ws_event(PLATFORM_ADMIN), cache).platform_admin is True
    demoted = {'sub': 'sub-pat', 'cognito:groups': '[admins]'}
    with pytest.raises(NotFoundError, match=NOT_FOUND):
        _resolve(table,_ws_event(demoted), cache)


def test_a_full_cache_starts_again_empty():
    cache = MembershipCache()
    context = WorkspaceContext(ws=WS, role='viewer', name='', slug='', platform_admin=False)
    for n in range(MAX_CACHED_MEMBERSHIPS):
        cache.put(WS, f'sub-{n}', context)
    cache.put(WS, 'sub-last', context)
    assert (cache.get(WS, 'sub-0'), cache.get(WS, 'sub-last')) == (None, context)


# ── Keys ─────────────────────────────────────────────────────────────────────

def test_ws_key_prefixes_the_parts_with_the_workspace():
    assert (ws_key(WS), ws_key(WS, 'SOURCE', 'webscraper')) == (f'WS#{WS}', f'WS#{WS}#SOURCE#webscraper')


@pytest.mark.parametrize('ws', ['', 'ws_', WS.lower(), f'{WS}#x', 'USER#sub-ana'],
                         ids=['empty', 'prefix', 'lower', 'suffix', 'other-partition'])
def test_ws_key_refuses_an_id_that_is_not_well_formed(ws):
    with pytest.raises(ValueError, match='not a workspace id'):
        ws_key(ws, 'META')


def test_is_workspace_id_accepts_only_ws_and_a_ulid():
    assert [is_workspace_id(value) for value in (WS, OTHER_WS, WS.lower(), f'{WS}#x', 'ws_')] == [
        True, True, False, False, False]


def test_audit_key_is_an_audit_partition_of_the_workspace():
    """The role's PutItem is scoped to these partitions (lib/stacks/api-workspaces-lambda.ts)."""
    assert audit_key(WS) == f'AUDIT#WS#{WS}'
    with pytest.raises(ValueError, match='not a workspace id'):
        audit_key(f'{WS}#x')


# ── My workspaces ────────────────────────────────────────────────────────────

class PagedTable:
    """A table whose Query answers in the given pages, recording each request."""

    def __init__(self, pages):
        self.pages = pages
        self.requests = []

    def query(self, **request):
        self.requests.append(request)
        index = int(request.get('ExclusiveStartKey', {}).get('page', 0))
        page = {'Items': self.pages[index]}
        if index + 1 < len(self.pages):
            page['LastEvaluatedKey'] = {'page': index + 1}
        return page


def _row(ws, name, role='viewer', slug=None):
    return {'pk': 'USER#sub-ana', 'sk': f'WS#{ws}', 'name': name, 'slug': slug or name.lower(), 'role': role}


def test_my_workspaces_reads_every_page_of_my_partition_and_sorts_by_name():
    first, second, third = 'ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D8', 'ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D9', OTHER_WS
    table = PagedTable([[_row(first, 'zephyr', 'admin')], [_row(second, 'Acme'), _row(third, 'beta', 'editor')]])
    assert list_my_workspaces(table, 'sub-ana') == [
        {'id': second, 'name': 'Acme', 'slug': 'acme', 'role': 'viewer'},
        {'id': third, 'name': 'beta', 'slug': 'beta', 'role': 'editor'},
        {'id': first, 'name': 'zephyr', 'slug': 'zephyr', 'role': 'admin'},
    ]
    assert len(table.requests) == 2
    assert table.requests[0]['ExpressionAttributeValues'] == {':pk': 'USER#sub-ana', ':ws': 'WS#'}


def test_my_workspaces_breaks_a_name_tie_by_id():
    table = PagedTable([[_row(OTHER_WS, 'Acme'), _row(WS, 'acme')]])
    assert [w['id'] for w in list_my_workspaces(table, 'sub-ana')] == [WS, OTHER_WS]


def test_my_workspaces_leaves_out_rows_that_are_not_well_formed():
    table = PagedTable([[
        _row(WS, 'Acme'),
        _row('ws_bad', 'Broken id'),
        _row(OTHER_WS, 'Unknown role', role='owner'),
        {'pk': 'USER#sub-ana', 'sk': f'WS#{OTHER_WS}', 'name': 'No role'},
    ]])
    with patch('shared.workspace.logger') as logger:
        assert [w['name'] for w in list_my_workspaces(table, 'sub-ana')] == ['Acme']
    # Logged by count, never with the caller's sub.
    logger.warning.assert_called_once_with('Left out malformed my-workspaces rows', extra={'count': 3})


def test_my_workspaces_is_empty_for_someone_with_none():
    with mock_aws():
        assert list_my_workspaces(create_pk_sk_table('workspaces'), 'sub-nobody') == []


# ── Invalidation and the workspace-admin gate ────────────────────────────────

def test_invalidate_forgets_one_membership_with_and_without_the_platform_admin_group():
    cache = MembershipCache()
    context = WorkspaceContext(ws=WS, role='editor', name='', slug='', platform_admin=False)
    for ws, sub, elevated in ((WS, 'sub-ana', False), (WS, 'sub-ana', True), (WS, 'sub-sam', False),
                              (OTHER_WS, 'sub-ana', False)):
        cache.put(ws, sub, context, elevated)
    cache.invalidate(WS, 'sub-ana')
    assert [cache.get(WS, 'sub-ana', False), cache.get(WS, 'sub-ana', True)] == [None, None]
    assert cache.get(WS, 'sub-sam') == context
    assert cache.get(OTHER_WS, 'sub-ana') == context
    cache.invalidate(WS, 'sub-nobody')  # nothing cached: no error


@pytest.mark.parametrize(('role', 'platform_admin'), [('admin', False), ('admin', True)])
def test_a_workspace_admin_passes_the_gate(role, platform_admin):
    context = WorkspaceContext(ws=WS, role=role, name='', slug='', platform_admin=platform_admin)
    require_workspace_admin(context)  # raises for anyone below admin
    assert context.role == 'admin'


@pytest.mark.parametrize('role', ['editor', 'viewer', ''])
def test_everyone_below_admin_gets_403(role):
    with pytest.raises(AuthorizationError, match='Workspace admin access required'):
        require_workspace_admin(WorkspaceContext(ws=WS, role=role, name='', slug='', platform_admin=False))



# ── A delegated credential or an agent: the person it acts for ─────────────────

def test_a_credential_acts_with_its_person_s_membership(table):
    """An MCP token minted by ana: ana's MEMBER# row decides."""
    claims = {'sub': 'mcp:tok_1', 'voc:acting_subject': 'sub-ana', 'cognito:groups': ''}
    assert _resolve(table, _ws_event(claims), MembershipCache()).role == 'editor'


def test_a_credential_whose_person_is_not_a_member_gets_the_one_404(table):
    claims = {'sub': 'mcp:tok_1', 'voc:acting_subject': 'sub-nobody', 'cognito:groups': ''}
    with pytest.raises(NotFoundError):
        _resolve(table, _ws_event(claims), MembershipCache())


@pytest.mark.parametrize('claims', [
    {'sub': 'mcp:tok_1', 'cognito:groups': ''},
    {'sub': 'mcp:tok_1', 'voc:acting_subject': 'mcp:tok_2', 'cognito:groups': ''},
], ids=['acting-for-nobody', 'acting-for-a-credential'])
def test_a_credential_acting_for_no_person_gets_the_one_404(table, claims):
    with pytest.raises(NotFoundError):
        _resolve(table, _ws_event(claims), MembershipCache())


def test_an_admin_s_credential_acts_at_most_as_an_editor(table):
    """As for projects: a credential writes what its person may, but administers nothing."""
    table.put_item(Item={'pk': f'WS#{WS}', 'sk': 'MEMBER#sub-adi', 'role': 'admin'})
    human = {'sub': 'sub-adi', 'cognito:groups': 'users'}
    token = {'sub': 'mcp:tok_1', 'voc:acting_subject': 'sub-adi', 'cognito:groups': ''}
    assert _resolve(table, _ws_event(human), MembershipCache()).role == 'admin'
    assert _resolve(table, _ws_event(token), MembershipCache()).role == 'editor'



@pytest.mark.parametrize('first', ['person', 'credential'])
def test_the_person_and_their_credential_share_the_cache_but_not_the_role(table, first):
    """Whichever fills the cache first, the person acts as admin and their credential as editor."""
    table.put_item(Item={'pk': f'WS#{WS}', 'sk': 'MEMBER#sub-adi', 'role': 'admin'})
    human = _ws_event({'sub': 'sub-adi', 'cognito:groups': 'users'})
    token = _ws_event({'sub': 'mcp:tok_1', 'voc:acting_subject': 'sub-adi', 'cognito:groups': ''})
    cache = MembershipCache()
    order = (human, token) if first == 'person' else (token, human)
    roles = {id(event): _resolve(table, event, cache).role for event in order}
    assert (roles[id(human)], roles[id(token)]) == ('admin', 'editor')
