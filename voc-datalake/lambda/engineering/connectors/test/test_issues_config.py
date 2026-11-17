"""voc-engineering-issues-config (issues_config.py, 7.50.02): three actions and nothing else, refused before anything
is read; only the three keys the connections own ever written, every other key (another plugin's, the token, the
webhook secret) written back as read; a concurrent save never lost; the schedule turned on only when a repository was
added; answers of exactly six fields, and no answer or log line carrying a value of the secret."""
from __future__ import annotations

import json
import logging
from typing import Any
from unittest.mock import patch

import pytest

from engineering.connectors import issues_config
from engineering.connectors.issues_config import (
    FIELDS,
    IssuesConfig,
    IssuesConfigRefused,
    IssuesSettingsFull,
    IssuesSettingsUnavailable,
    answer,
    dispatch,
    parse_request,
)
from engineering.connectors.issues_sync import APP_KEY, MANAGED_KEY, REPOS_KEY, TOKEN_KEY, WRITABLE_KEYS
from engineering.connectors.test.issues_fakes import (
    OTHER_PLUGINS,
    RULE,
    SETTINGS_ID,
    STORED_HOOK_KEY,
    STORED_PAT,
    FakeEvents,
    FakeSecrets,
)

APP_ID = '4242'
FOLLOW = {'action': 'follow', 'connection_id': 'shop', 'repository': 'acme/shop', 'app_id': APP_ID}
ANSWER_FIELDS = {'repos', 'repos_managed', 'github_app_id', 'sign_in', 'token_set', 'schedule_enabled'}


def config(secrets: FakeSecrets, events: FakeEvents | None = None) -> IssuesConfig:
    rule = events or FakeEvents()
    return IssuesConfig(SETTINGS_ID, RULE, lambda: secrets, lambda: rule,
                        request_token=lambda: f't{len(secrets.tokens) + 1}')


def run(secrets: FakeSecrets, request: dict[str, Any], events: FakeEvents | None = None) -> dict[str, Any]:
    return dispatch(config(secrets, events), *parse_request(request))


# --- what the function takes ------------------------------------------------------------------------------------------


@pytest.mark.parametrize('event', [
    {}, [], 'status', {'action': 'write', 'key': 'github_issues_token'}, {'action': 'status', 'workspace_id': 'w'},
    {'action': 'status', 'secret': SETTINGS_ID}, {**FOLLOW, 'token': 'x'}, {**FOLLOW, 'repos': 'acme/x'},
    {'action': 'follow', 'connection_id': 'shop', 'repository': 'acme/shop'},
    {**FOLLOW, 'repository': '../etc'}, {**FOLLOW, 'repository': 'acme/shop\nother/x'}, {**FOLLOW, 'app_id': '0123'},
    {**FOLLOW, 'app_id': 4242}, {**FOLLOW, 'connection_id': 'Shop!'},
    {'action': 'unfollow', 'connection_id': 'shop', 'repositories': []},
    {'action': 'unfollow', 'connection_id': 'shop', 'repositories': 'acme/shop'},
    {'action': 'unfollow', 'connection_id': 'shop', 'repositories': [f'acme/r{n}' for n in range(21)]},
    {'action': 'unfollow', 'connection_id': 'shop', 'repositories': ['acme/shop'], 'github_app_id': '1'},
])
def test_anything_but_its_three_actions_on_their_shapes_is_refused_before_anything_is_read(event: Any) -> None:
    with patch.object(issues_config, 'issues_config', side_effect=AssertionError('read')) as built, \
            pytest.raises(IssuesConfigRefused):
        issues_config.lambda_handler(event, None)
    built.assert_not_called()


def test_the_three_actions_parse_to_their_arguments() -> None:
    assert set(FIELDS) == {'follow', 'unfollow', 'status'}
    assert parse_request({'action': 'status'}) == ('status', {})
    assert parse_request(FOLLOW) == ('follow', {'connection_id': 'shop', 'repository': 'acme/shop', 'app_id': APP_ID})
    assert parse_request({'action': 'unfollow', 'connection_id': 'shop', 'repositories': ['acme/a', 'acme/a']}) == (
        'unfollow', {'connection_id': 'shop', 'repositories': ['acme/a']})


def test_without_its_settings_named_the_function_answers_unavailable(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv(issues_config.SETTINGS_ARN_ENV, raising=False)
    with pytest.raises(IssuesSettingsUnavailable):
        issues_config.lambda_handler({'action': 'status'}, None)


# --- what it writes ---------------------------------------------------------------------------------------------------


def test_a_follow_writes_only_the_connections_keys_and_every_other_key_as_read() -> None:
    stored = {**OTHER_PLUGINS, 'github_issues_webhook_secret': STORED_HOOK_KEY, REPOS_KEY: 'kirodotdev/Kiro'}
    secrets = FakeSecrets(stored)
    events = FakeEvents()
    found = run(secrets, FOLLOW, events)
    assert secrets.value == {**stored, REPOS_KEY: 'kirodotdev/Kiro\nacme/shop', MANAGED_KEY: 'acme/shop',
                             APP_KEY: APP_ID}
    assert set(secrets.value) - set(stored) <= WRITABLE_KEYS == {REPOS_KEY, MANAGED_KEY, APP_KEY}
    assert found == {'repos': ['kirodotdev/Kiro', 'acme/shop'], 'repos_managed': ['acme/shop'],
                     'github_app_id': APP_ID, 'sign_in': 'app', 'token_set': False, 'schedule_enabled': True}
    assert events.enabled == [RULE]
    assert secrets.tokens == ['t1']   # (each write its own ClientRequestToken)


def test_a_token_source_is_untouched_and_the_schedule_left_as_it_is() -> None:
    secrets = FakeSecrets({**OTHER_PLUGINS, TOKEN_KEY: STORED_PAT, REPOS_KEY: 'kirodotdev/Kiro'})
    events = FakeEvents()
    found = run(secrets, FOLLOW, events)
    assert (secrets.writes, events.enabled) == ([], [])
    assert (found['sign_in'], found['token_set'], found['repos']) == ('token', True, ['kirodotdev/Kiro'])


def test_an_unfollow_takes_out_only_what_the_connections_added() -> None:
    secrets = FakeSecrets({REPOS_KEY: 'kirodotdev/Kiro\nacme/shop', MANAGED_KEY: 'acme/shop', APP_KEY: APP_ID})
    found = run(secrets, {'action': 'unfollow', 'connection_id': 'shop',
                          'repositories': ['acme/shop', 'kirodotdev/Kiro']})
    assert (found['repos'], found['repos_managed']) == (['kirodotdev/Kiro'], [])
    assert secrets.value[REPOS_KEY] == 'kirodotdev/Kiro'


def test_status_reads_and_writes_nothing() -> None:
    secrets = FakeSecrets({REPOS_KEY: 'acme/shop', APP_KEY: APP_ID})
    events = FakeEvents(state='ENABLED')
    assert run(secrets, {'action': 'status'}, events)['schedule_enabled'] is True
    assert (secrets.writes, events.enabled) == ([], [])


def test_settings_past_the_secrets_limit_are_refused_unwritten() -> None:
    secrets = FakeSecrets({'webscraper_configs': 'x' * 65_600})
    with pytest.raises(IssuesSettingsFull):
        run(secrets, FOLLOW)
    assert secrets.writes == []


# --- a concurrent save of the Integrations API ------------------------------------------------------------------------


def test_a_save_between_the_read_and_the_write_is_read_again_never_overwritten() -> None:
    secrets = FakeSecrets(dict(OTHER_PLUGINS))
    # (after the first read, before the check that comes just before the write: an administrator saves a label filter)
    secrets.after_reads[1] = lambda fake: fake.save({'github_issues_labels': 'bug, crash'})
    run(secrets, FOLLOW)
    assert secrets.value['github_issues_labels'] == 'bug, crash'
    assert secrets.value[REPOS_KEY] == 'acme/shop'
    assert len(secrets.writes) == 1


def test_a_save_landing_between_the_check_and_the_write_is_kept_and_the_change_applied_again() -> None:
    secrets = FakeSecrets(dict(OTHER_PLUGINS))
    secrets.concurrent = {'github_issues_product_names': 'Kiro', REPOS_KEY: 'kirodotdev/Kiro'}
    found = run(secrets, FOLLOW)
    assert secrets.value['github_issues_product_names'] == 'Kiro'
    assert secrets.value[REPOS_KEY] == 'kirodotdev/Kiro\nacme/shop'
    assert secrets.value[MANAGED_KEY] == 'acme/shop'
    assert found['repos'] == ['kirodotdev/Kiro', 'acme/shop']
    assert len(secrets.writes) == 2


def test_settings_that_keep_changing_are_unavailable_after_a_few_tries() -> None:
    secrets = FakeSecrets(dict(OTHER_PLUGINS))
    for read in range(1, 20):
        secrets.after_reads[read] = lambda fake: fake.save({'github_issues_labels': f'v{len(fake.versions)}'})
    with pytest.raises(IssuesSettingsUnavailable, match='kept changing'):
        run(secrets, FOLLOW)
    assert secrets.writes == []


def test_a_secret_that_cannot_be_read_is_unavailable() -> None:
    secrets = FakeSecrets({})
    secrets.fail = True
    with pytest.raises(IssuesSettingsUnavailable, match='could not be read'):
        run(secrets, {'action': 'status'})


# --- what it answers and logs -----------------------------------------------------------------------------------------


def test_no_answer_or_log_line_carries_a_value_of_the_secret(caplog: pytest.LogCaptureFixture) -> None:
    stored = {**OTHER_PLUGINS, TOKEN_KEY: STORED_PAT, 'github_issues_webhook_secret': STORED_HOOK_KEY}
    answers = []
    with caplog.at_level(logging.DEBUG):
        for request in (FOLLOW, {'action': 'status'},
                        {'action': 'unfollow', 'connection_id': 'shop', 'repositories': ['acme/shop']}):
            secrets = FakeSecrets(dict(stored))
            answers.append(run(secrets, request))
    seen = json.dumps(answers) + '\n'.join(json.dumps(vars(record), default=str) for record in caplog.records)
    for value in (STORED_PAT, STORED_HOOK_KEY, *OTHER_PLUGINS.values()):
        if len(value) > 3:
            assert value not in seen
    assert all(set(found) == ANSWER_FIELDS for found in answers)


def test_the_answer_says_whether_a_token_is_set_never_the_token() -> None:
    found = answer({TOKEN_KEY: STORED_PAT, APP_KEY: APP_ID, REPOS_KEY: 'https://github.com/Acme/Shop/issues'}, None)
    assert found == {'repos': ['Acme/Shop'], 'repos_managed': [], 'github_app_id': APP_ID, 'sign_in': 'app',
                     'token_set': True, 'schedule_enabled': None}
