"""The GitHub Issues source configured from the connections (issues_sync.py, 7.50.02): merged, never overwritten; only
what the automation added is ever taken out; a token-configured source is untouched; the schedule turned on with an
audit row; the ``voc-agent`` label ensured once per connection; a source not deployed here answers so. The follow asks
voc-engineering-issues-config (issues_config.py, its real code over fakes of the secret and the rule:
issues_fakes.py), as the Agents API does."""
from __future__ import annotations

import json
from collections.abc import Iterator
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

import pytest
from moto import mock_aws

from engineering.connectors.connections import PARTITION, Actor, ConnectionRefused
from engineering.connectors.issues_sync import (
    APP_KEY,
    LABEL,
    MANAGED_KEY,
    MAX_REPOS,
    REPOS_KEY,
    TOKEN_KEY,
    IssuesFollow,
    SourceState,
    plan,
    repository_of,
)
from engineering.connectors.test.issues_fakes import OTHER_PLUGINS, RULE, FakeConfigFunction, FakeEvents, FakeSecrets
from shared.test.moto_tables import create_pk_sk_table

APP_ID = '4242'
OTHER_APP = '5151'
ADMIN = Actor(subject='admin-sub', name='alice')
WHEN = datetime(2026, 11, 17, 9, 0, tzinfo=UTC)


def state(**secrets: str) -> SourceState:
    return SourceState.of({f'github_issues_{key}': value for key, value in secrets.items()})


# --- the rule ---------------------------------------------------------------------------------------------------------


def test_a_first_connection_adds_its_repository_and_signs_the_source_in_with_its_app() -> None:
    planned = plan(state(), APP_ID, add=['acme/shop'])
    assert planned.changes == {REPOS_KEY: 'acme/shop', MANAGED_KEY: 'acme/shop', APP_KEY: APP_ID}
    assert (planned.added, planned.app_set, planned.skipped) == (('acme/shop',), True, ())


def test_a_repository_is_merged_in_and_an_administrators_entries_stay_as_typed_and_unclaimed() -> None:
    typed = state(repos='kirodotdev/Kiro\nhttps://github.com/Acme/Shop/issues', github_app_id=APP_ID)
    planned = plan(typed, APP_ID, add=['acme/shop', 'acme/api'])
    # (acme/shop is the administrator's URL entry: already read, never added again nor claimed as managed)
    assert planned.changes == {REPOS_KEY: 'kirodotdev/Kiro\nhttps://github.com/Acme/Shop/issues\nacme/api',
                               MANAGED_KEY: 'acme/api'}
    assert planned.added == ('acme/api',)
    assert planned.app_set is False


def test_only_a_repository_the_automation_added_is_ever_taken_out() -> None:
    mixed = state(repos='kirodotdev/Kiro\nacme/api', repos_managed='acme/api', github_app_id=APP_ID)
    planned = plan(mixed, APP_ID, remove=['acme/api', 'kirodotdev/Kiro', 'ACME/API'])
    assert planned.changes == {REPOS_KEY: 'kirodotdev/Kiro', MANAGED_KEY: ''}
    assert planned.removed == ('acme/api',)
    assert plan(mixed, APP_ID, remove=['kirodotdev/kiro']).changes == {}


def test_a_token_configured_source_is_untouched() -> None:
    token = state(repos='kirodotdev/Kiro', token='github_pat_x', repos_managed='acme/api')
    assert token.signs_in == 'token'
    planned = plan(token, APP_ID, add=['acme/shop'], remove=['acme/api'])
    assert planned.changes == {}
    assert planned.skipped == (('acme/shop', 'token'),)
    assert planned.removed == ()


def test_a_source_signed_in_with_another_app_keeps_it() -> None:
    other = state(repos='acme/web', github_app_id=OTHER_APP)
    planned = plan(other, APP_ID, add=['acme/shop'])
    assert (planned.changes, planned.skipped) == ({}, (('acme/shop', 'other_app'),))


def test_the_source_reads_at_most_twenty_repositories() -> None:
    full = state(repos='\n'.join(f'acme/r{n}' for n in range(MAX_REPOS - 1)), github_app_id=APP_ID)
    planned = plan(full, APP_ID, add=['acme/one', 'acme/two'])
    assert planned.added == ('acme/one',)
    assert planned.skipped == (('acme/two', 'limit'),)


def test_a_source_with_no_app_and_its_repository_typed_gets_the_app() -> None:
    planned = plan(state(repos='acme/shop'), APP_ID, add=['acme/shop'])
    assert planned.changes == {APP_KEY: APP_ID}
    assert planned.app_set is True


@pytest.mark.parametrize(('entry', 'repository'), [
    ('acme/shop', 'acme/shop'), ('https://github.com/acme/shop/issues/7', 'acme/shop'), ('github.com/acme/shop.git',
                                                                                          'acme/shop'),
    ('acme/shop/extra', None), ('https://gitlab.com/acme/shop', None), ('', None)])
def test_an_entry_is_read_as_the_ingestor_reads_it(entry: str, repository: str | None) -> None:
    assert repository_of(entry) == repository == _ingestors_parse_repo()(entry)


def _ingestors_parse_repo() -> Any:
    """plugins/_shared/github_config.py ``parse_repo`` (another tree: loaded from its file)."""
    import importlib.util
    from pathlib import Path

    path = Path(__file__).resolve().parents[4] / 'plugins' / '_shared' / 'github_config.py'
    spec = importlib.util.spec_from_file_location('ingestor_github_config', path)
    assert spec is not None
    assert spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.parse_repo


# --- the follow, over fakes of the shared secret, the schedule rule and the token function ----------------------------


@dataclass
class FakeTokens:
    """The token function's ``ensure_label``: created on its first call per repository, present after."""

    labelled: set[str] = field(default_factory=set)
    calls: list[dict[str, Any]] = field(default_factory=list)
    refuse: bool = False

    def __call__(self, request: dict[str, Any]) -> dict[str, Any]:
        self.calls.append(request)
        if self.refuse:
            raise ConnectionRefused('conflict', 'this installation belongs to another GitHub App')
        created = request['repository'] not in self.labelled
        self.labelled.add(request['repository'])
        return {'repository': request['repository'], 'label': request['label'], 'created': created}


def connection(connection_id: str, repository: str, app_id: str = APP_ID, kind: str = 'app_reference') -> dict:
    return {'connection_id': connection_id, 'host': 'github', 'repository': repository,
            'credential': {'kind': kind, 'set': True, 'app_id': app_id, 'installation_id': '77', 'expires_at': None}}


SHOP, API = connection('shop', 'acme/shop'), connection('api', 'acme/api')


@dataclass
class World:
    secrets: FakeSecrets
    events: FakeEvents
    tokens: FakeTokens
    table: Any
    follow: IssuesFollow
    config: FakeConfigFunction

    def audit(self) -> list[tuple[str, dict[str, Any]]]:
        rows = self.table.query(KeyConditionExpression='pk = :pk AND begins_with(sk, :log)',
                                ExpressionAttributeValues={':pk': PARTITION, ':log': 'LOG#'})['Items']
        return [(row['action'], row['changes']) for row in sorted(rows, key=lambda row: row['sk'])]


@pytest.fixture
def world() -> Iterator[World]:
    with mock_aws():
        table = create_pk_sk_table('voc-agents')
        secrets, events, tokens = FakeSecrets(dict(OTHER_PLUGINS)), FakeEvents(), FakeTokens()
        config = FakeConfigFunction(secrets, events)
        yield World(secrets, events, tokens, table, IssuesFollow(config, table, tokens, lambda: WHEN), config)


def test_an_installation_configures_the_source_turns_its_schedule_on_and_labels_each_repository(world: World) -> None:
    block = world.follow.follow_app(APP_ID, [SHOP, API, connection('other', 'acme/x', OTHER_APP)], ADMIN)
    assert world.secrets.value == {**OTHER_PLUGINS, REPOS_KEY: 'acme/shop\nacme/api',
                                   MANAGED_KEY: 'acme/shop\nacme/api', APP_KEY: APP_ID}
    assert world.events.enabled == [RULE]
    assert block == {'signs_in': 'app', 'added': ['acme/shop', 'acme/api'], 'reading': ['acme/shop', 'acme/api'],
                     'skipped': [], 'schedule': 'on', 'error': None,
                     'labels': [{'repository': 'acme/shop', 'state': 'created'},
                                {'repository': 'acme/api', 'state': 'created'}]}
    assert sorted(call['repository'] for call in world.tokens.calls) == ['acme/api', 'acme/shop']
    assert {(call['action'], call['label'], call['app_id'], call['installation_id']) for call in world.tokens.calls} \
        == {('ensure_label', LABEL, APP_ID, 77)}
    actions = [action for action, _ in world.audit()]
    assert sorted(actions) == ['issues_label_created', 'issues_label_created', 'issues_schedule_enabled',
                               'issues_source_added', 'issues_source_added']
    added = [changes for action, changes in world.audit() if action == 'issues_source_added']
    # (one row per connection: the rows share the fixed clock's moment, so their order is the random suffix's)
    assert sorted(added, key=lambda changes: changes['repositories']) == [
        {'repositories': ['acme/api']}, {'repositories': ['acme/shop'], 'github_app_id': APP_ID}]
    # One follow per connection the source does not read yet, then nothing: the function was asked status first.
    assert [request['action'] for request in world.config.requests] == ['status', 'follow', 'follow']


def test_a_second_check_changes_nothing_and_never_asks_for_a_recorded_label_again(world: World) -> None:
    world.follow.follow_app(APP_ID, [SHOP], ADMIN)
    writes, calls, audit = len(world.secrets.writes), len(world.tokens.calls), len(world.audit())
    asked = len(world.config.requests)
    block = world.follow.follow_app(APP_ID, [SHOP], ADMIN)
    assert (len(world.secrets.writes), len(world.tokens.calls), len(world.audit())) == (writes, calls, audit)
    assert [request['action'] for request in world.config.requests[asked:]] == ['status']   # (read already)
    assert block is not None
    assert block['added'] == []
    assert block['reading'] == ['acme/shop']


def test_an_administrator_who_turned_the_schedule_off_keeps_it_off_when_nothing_is_added(world: World) -> None:
    world.follow.follow_app(APP_ID, [SHOP], ADMIN)
    world.events.state, world.events.enabled = 'DISABLED', []
    world.follow.follow_app(APP_ID, [SHOP], ADMIN)
    assert world.events.enabled == []


def test_a_token_configured_source_is_left_as_it_is_and_says_so(world: World) -> None:
    world.secrets.value.update({TOKEN_KEY: 'github_pat_x', REPOS_KEY: 'kirodotdev/Kiro'})
    block = world.follow.follow_app(APP_ID, [SHOP], ADMIN)
    assert world.secrets.writes == []
    assert world.events.enabled == []
    assert block is not None
    assert block['signs_in'] == 'token'
    assert block['skipped'] == [{'repository': 'acme/shop', 'reason': 'token'}]
    assert world.follow.view([SHOP])['connections'][0]['reason'] == 'token'


def test_the_switch_takes_its_repository_out_and_back_with_an_audit_row_each(world: World) -> None:
    world.follow.follow_app(APP_ID, [SHOP, API], ADMIN)
    world.follow.set_read(SHOP, False, ADMIN)
    assert world.secrets.value[REPOS_KEY] == 'acme/api'
    assert world.follow.view([SHOP, API])['connections'][0] == {
        'connection_id': 'shop', 'repository': 'acme/shop', 'read': False, 'reading': False, 'reason': 'off',
        'label': 'created'}
    # Off stays off: a check does not add it back.
    world.follow.follow_app(APP_ID, [SHOP, API], ADMIN)
    assert world.secrets.value[REPOS_KEY] == 'acme/api'
    world.follow.set_read(SHOP, True, ADMIN)
    assert world.secrets.value[REPOS_KEY] == 'acme/api\nacme/shop'
    actions = [action for action, _ in world.audit()]
    assert ('issues_read_off' in actions, 'issues_read_on' in actions) == (True, True)
    assert actions.count('issues_source_removed') == 1


def test_the_switch_on_a_connection_not_made_through_the_deployments_app_is_refused(world: World) -> None:
    pasted = connection('pasted', 'acme/pasted', kind='app')
    with pytest.raises(ConnectionRefused, match='GitHub App') as refused:
        world.follow.set_read(pasted, True, ADMIN)
    assert refused.value.kind == 'conflict'
    assert world.follow.view([pasted])['connections'][0]['reason'] == 'not_app'


def test_a_removed_connection_takes_out_only_what_its_automation_added(world: World) -> None:
    world.secrets.value.update({REPOS_KEY: 'acme/api', APP_KEY: APP_ID})
    world.follow.follow_app(APP_ID, [SHOP, API], ADMIN)
    assert world.follow.connection_removed(API, ADMIN) == []      # (the administrator's own entry)
    assert world.follow.connection_removed(SHOP, ADMIN) == ['acme/shop']
    assert world.secrets.value[REPOS_KEY] == 'acme/api'
    assert world.follow.rows() == {}   # (both rows marked removed: a connection made again starts afresh)


def test_a_connection_made_before_its_first_sync_is_pending_then_read(world: World) -> None:
    view = world.follow.view([SHOP])
    assert (view['deployed'], view['signs_in'], view['connections'][0]['reason']) == (True, 'none', 'pending')
    world.follow.set_read(SHOP, True, ADMIN)
    view = world.follow.view([SHOP])
    assert view['connections'][0] == {'connection_id': 'shop', 'repository': 'acme/shop', 'read': True,
                                      'reading': True, 'reason': None, 'label': 'created'}
    assert (view['signs_in'], view['app_id'], view['repositories'], view['managed'], view['schedule']) == (
        'app', APP_ID, ['acme/shop'], ['acme/shop'], 'on')
    assert 'github_pat' not in json.dumps(view)


def test_a_label_the_token_function_refuses_is_recorded_failed_and_tried_again(world: World) -> None:
    world.tokens.refuse = True
    block = world.follow.follow_app(APP_ID, [SHOP], ADMIN)
    assert block is not None
    assert block['labels'] == [{'repository': 'acme/shop', 'state': 'failed'}]
    world.tokens.refuse = False
    block = world.follow.follow_app(APP_ID, [SHOP], ADMIN)
    assert block is not None
    assert block['labels'] == [{'repository': 'acme/shop', 'state': 'created'}]


def test_a_source_that_cannot_be_read_is_said_in_the_block_never_raised(world: World) -> None:
    world.secrets.fail = True
    block = world.follow.follow_app(APP_ID, [SHOP], ADMIN)
    assert block is not None
    assert block['error'] == 'the GitHub Issues source could not be read: try again'
    assert world.tokens.calls == []


def test_where_the_source_is_not_deployed_nothing_is_read_or_written() -> None:
    follow = IssuesFollow(None, None, FakeTokens())
    assert follow.follow_app(APP_ID, [SHOP], ADMIN) is None
    assert follow.connection_removed(SHOP, ADMIN) == []
    with pytest.raises(ConnectionRefused, match='not deployed'):
        follow.set_read(SHOP, True, ADMIN)
