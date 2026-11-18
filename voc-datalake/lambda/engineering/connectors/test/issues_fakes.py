"""Fakes of the GitHub Issues source's settings for the connections' follow (7.50.02): Secrets Manager's shared secret
with its versions and stages, the schedule rule, and voc-engineering-issues-config over them (issues_config.py), as
the Agents API's ``_invoke_issues_config`` answers."""
from __future__ import annotations

import json
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

from botocore.exceptions import ClientError

from engineering.connectors.connections import ConnectionRefused, Kind
from engineering.connectors.issues_config import (
    IssuesConfig,
    IssuesConfigRefused,
    IssuesSettingsFull,
    IssuesSettingsUnavailable,
    dispatch,
    parse_request,
)

SETTINGS_ID = 'arn:secret'
RULE = 'voc-ingest-github_issues-schedule'
#: Another plugin's keys in the same shared secret, and the source's own secrets: never answered, logged or lost.
OTHER_PLUGINS = {'webscraper_configs': '[]', 'app_reviews_ios_app_id': '123', 'github_issues_labels': 'bug',
                 'design_api_key': 'sk-other-plugin-secret-value'}
STORED_PAT = 'github_pat_11AAAAtokenvalue'
STORED_HOOK_KEY = 'whsec-the-repository-webhook-secret'


def _expect(holds: bool, named: str) -> None:
    if not holds:
        raise AssertionError(f'unexpected {named}')


@dataclass
class FakeSecrets:
    """The shared secret: its versions in order (the last is AWSCURRENT, the one before AWSPREVIOUS). ``concurrent``:
    another writer's save that lands just before the next put (then cleared); ``after_reads``: a callable run once
    after that many reads (a save between a read and the check before a write)."""

    initial: dict[str, Any]
    versions: list[tuple[str, dict[str, Any]]] = field(default_factory=list)
    writes: list[dict[str, Any]] = field(default_factory=list)
    fail: bool = False
    concurrent: dict[str, Any] | None = None
    after_reads: dict[int, Callable[[FakeSecrets], None]] = field(default_factory=dict)
    reads: int = 0
    tokens: list[str] = field(default_factory=list)

    def __post_init__(self) -> None:
        self.versions.append(('v0', dict(self.initial)))

    @property
    def value(self) -> dict[str, Any]:
        """AWSCURRENT's content (edited in place by a test: an administrator's save made before)."""
        return self.versions[-1][1]

    def save(self, change: dict[str, Any]) -> None:
        """What the Integrations API's save does: the whole secret read and written back with ``change``."""
        self.versions.append((f'other-{len(self.versions)}', {**self.value, **change}))

    def get_secret_value(self, SecretId: str, VersionStage: str = 'AWSCURRENT') -> dict[str, Any]:
        _expect(SecretId == SETTINGS_ID, SecretId)
        if self.fail:
            raise ClientError({'Error': {'Code': 'AccessDeniedException', 'Message': 'no'}}, 'GetSecretValue')
        self.reads += 1
        index = -1 if VersionStage == 'AWSCURRENT' else -2
        version, content = self.versions[index]
        found = {'VersionId': version, 'SecretString': json.dumps(content)}
        hook = self.after_reads.pop(self.reads, None)
        if hook is not None:
            hook(self)
        return found

    def put_secret_value(self, SecretId: str, SecretString: str, ClientRequestToken: str) -> None:
        _expect(SecretId == SETTINGS_ID, SecretId)
        if self.concurrent is not None:
            change, self.concurrent = self.concurrent, None
            self.save(change)
        self.tokens.append(ClientRequestToken)
        self.versions.append((ClientRequestToken, json.loads(SecretString)))
        self.writes.append(self.value)


@dataclass
class FakeEvents:
    state: str = 'DISABLED'
    enabled: list[str] = field(default_factory=list)

    def describe_rule(self, Name: str) -> dict[str, Any]:
        _expect(Name == RULE, Name)
        return {'State': self.state}

    def enable_rule(self, Name: str) -> None:
        _expect(Name == RULE, Name)
        self.enabled.append(Name)
        self.state = 'ENABLED'


_KINDS: dict[type[Exception], Kind] = {IssuesConfigRefused: 'invalid', IssuesSettingsFull: 'conflict',
                                      IssuesSettingsUnavailable: 'unavailable'}


@dataclass
class FakeConfigFunction:
    """voc-engineering-issues-config as the Agents API sees it: the real code over the fakes, its errors as
    ``_invoke_issues_config`` maps them; every request kept."""

    secrets: FakeSecrets
    events: FakeEvents
    requests: list[dict[str, Any]] = field(default_factory=list)

    def __call__(self, request: dict[str, Any]) -> dict[str, Any]:
        self.requests.append(request)
        config = IssuesConfig(SETTINGS_ID, RULE, lambda: self.secrets, lambda: self.events,
                              request_token=lambda: f't{len(self.secrets.tokens) + 1}')
        try:
            return dispatch(config, *parse_request(request))
        except tuple(_KINDS) as error:
            raise ConnectionRefused(_KINDS[type(error)], str(error)) from None
