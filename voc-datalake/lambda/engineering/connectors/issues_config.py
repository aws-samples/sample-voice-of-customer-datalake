"""voc-engineering-issues-config (7.50.02; docs/github-issues.md, "Configured by your GitHub connection"): the one
function that reads and writes the deployment's GitHub Issues source's settings for the repository connections, so
the Agents API holds no grant on the shared API-credentials secret or the source's schedule rule
(lib/stacks/engineering-issues-config.ts: its own role, no function URL, no resource policy, no table, no bucket).

It takes three actions, each a direct invoke by the Agents API (issues_sync.py ``IssuesFollow``), and refuses every
other, and any request off its shape (another key, a value off its pattern), before anything is read
(``IssuesConfigRefused``, the Agents API's 400):

* ``follow`` ``{connection_id, repository, app_id}``: the repository added as issues_sync.py ``plan`` allows (an
  administrator's entries never removed or claimed, a token source untouched, another App's source kept, at most
  ``MAX_REPOS``); when it added it or signed the source in with the App, the schedule rule turned on if it was off;
* ``unfollow`` ``{connection_id, repositories}``: those repositories taken out, only the ones ``repos_managed`` names;
* ``status`` ``{}``: the source as it stands.

It writes ``github_issues_repos``, ``github_issues_repos_managed`` and ``github_issues_github_app_id`` only
(``WRITABLE_KEYS``: every other key of the secret, other plugins' included, is written back as read). The secret is
read and written whole, so a concurrent save of the Integrations API must not be lost: the version read
(``AWSCURRENT``'s ``VersionId``) is checked again just before the write (changed: read again, up to ``ATTEMPTS``),
each write has its own ``ClientRequestToken``, and after it ``AWSPREVIOUS`` must be the version read; when another
save landed between the check and the write, the change is applied again on top of that save (its content is
``AWSPREVIOUS``), so both stand.

Every answer is ``{repos, repos_managed, github_app_id, sign_in, token_set, schedule_enabled}`` (``answer``): never
the token, the webhook secret or any other plugin's key, and no log line carries a value of the secret. A failed read
or write is ``IssuesSettingsUnavailable`` (try again), settings too large to store ``IssuesSettingsFull``.
"""
from __future__ import annotations

import json
import os
import uuid
from collections.abc import Callable, Mapping
from functools import lru_cache
from typing import Any, Final

from botocore.exceptions import BotoCoreError, ClientError

from engineering.connectors.connections import CONNECTION_ID, REPOSITORY
from engineering.connectors.issues_sync import MAX_REPOS, WRITABLE_KEYS, Plan, SourceState, merged, plan
from shared.github_rest import GITHUB_NUMBER
from shared.invocation_cost import measure_invocation_cost
from shared.logging import logger
from shared.model_fallback import error_code

FOLLOW: Final = 'follow'
UNFOLLOW: Final = 'unfollow'
STATUS: Final = 'status'
#: Each action's exact keys (``action`` included): anything else is refused before anything is read.
FIELDS: Final = {FOLLOW: frozenset({'action', 'connection_id', 'repository', 'app_id'}),
                 UNFOLLOW: frozenset({'action', 'connection_id', 'repositories'}),
                 STATUS: frozenset({'action'})}
#: The function's environment (engineering-issues-config.ts): the shared secret's ARN and the schedule rule's name.
SETTINGS_ARN_ENV: Final = 'ISSUES_SETTINGS_ARN'
RULE_ENV: Final = 'ISSUES_SCHEDULE_RULE'
#: The shared secret's limit (shared/aws.py SECRET_STRING_MAX_BYTES).
MAX_SECRET_BYTES: Final = 65536
#: How many times a write is tried when the secret changed between its read and its write.
ATTEMPTS: Final = 3
CURRENT: Final = 'AWSCURRENT'
PREVIOUS: Final = 'AWSPREVIOUS'
_AWS_ERRORS: Final = (ClientError, BotoCoreError)


class IssuesConfigRefused(Exception):
    """A request this function does not take: another action, a key off its shape. Raised before anything is read."""


class IssuesSettingsUnavailable(Exception):
    """The settings could not be read or written (or kept changing meanwhile): try again. Never quotes a value."""


class IssuesSettingsFull(Exception):
    """The shared secret would pass its size limit."""


#: Each argument's pattern and what it is: a value off it refuses the request (``repositories``: a list of 1 to
#: ``MAX_REPOS`` of ``repository``).
ARGUMENTS: Final = {'connection_id': (CONNECTION_ID, 'a connection\'s id'), 'repository': (REPOSITORY, 'owner/name'),
                    'app_id': (GITHUB_NUMBER, 'a GitHub App\'s id (digits)')}


def _matches(key: str, value: object) -> bool:
    return isinstance(value, str) and ARGUMENTS[key][0].fullmatch(value) is not None


def parse_request(event: object) -> tuple[str, dict[str, Any]]:
    """The action and its checked arguments, or ``IssuesConfigRefused`` (nothing read yet)."""
    action = event.get('action') if isinstance(event, Mapping) else None
    if not isinstance(event, Mapping) or not isinstance(action, str) or action not in FIELDS:
        raise IssuesConfigRefused(f'this function takes {FOLLOW!r}, {UNFOLLOW!r} or {STATUS!r} only')
    if frozenset(event) != FIELDS[action]:
        raise IssuesConfigRefused(f'the request is {{{", ".join(sorted(FIELDS[action]))}}}')
    arguments = {key: event[key] for key in sorted(FIELDS[action] - {'action'})}
    for key, value in arguments.items():
        if key != 'repositories' and not _matches(key, value):
            raise IssuesConfigRefused(f'{key} is {ARGUMENTS[key][1]}')
    if 'repositories' in arguments:
        listed = arguments['repositories']
        if not (isinstance(listed, list) and 1 <= len(listed) <= MAX_REPOS
                and all(_matches('repository', item) for item in listed)):
            raise IssuesConfigRefused(f'repositories is a list of 1 to {MAX_REPOS} owner/name')
        arguments['repositories'] = list(dict.fromkeys(listed))
    return action, arguments


def answer(secrets: Mapping[str, Any], schedule: bool | None) -> dict[str, Any]:
    """The source as this function answers it: its repositories, those the connections added, its App, how it signs
    in, whether a token is set (never the token) and whether its schedule is on (None: not known)."""
    state = SourceState.of(secrets)
    return {'repos': list(state.repositories), 'repos_managed': list(state.managed), 'github_app_id': state.app_id,
            'sign_in': state.signs_in, 'token_set': state.token, 'schedule_enabled': schedule}


class IssuesConfig:
    """The three actions over the shared secret ``secret_id`` (Secrets Manager through ``secrets``) and the schedule
    rule ``rule`` (EventBridge through ``events``)."""

    def __init__(self, secret_id: str, rule: str, secrets: Callable[[], Any], events: Callable[[], Any],
                 request_token: Callable[[], str] = lambda: uuid.uuid4().hex) -> None:
        self._secret_id = secret_id
        self._rule = rule
        self._secrets = secrets
        self._events = events
        self._request_token = request_token

    # --- the secret -------------------------------------------------------------------------------------------------

    def _read(self, stage: str = CURRENT) -> tuple[str, dict[str, Any]]:
        """(the version's id, the whole secret) of ``stage``."""
        try:
            found = self._secrets().get_secret_value(SecretId=self._secret_id, VersionStage=stage)
            secrets = json.loads(found.get('SecretString') or '{}')
        except (*_AWS_ERRORS, ValueError) as error:
            logger.warning('engineering issues settings not read', extra={'stage': stage, 'error_code': error_code(error)})
            raise IssuesSettingsUnavailable('the GitHub Issues source could not be read: try again') from None
        if not isinstance(secrets, dict):
            raise IssuesSettingsUnavailable('the GitHub Issues source\'s settings are not a JSON object')
        return str(found.get('VersionId') or ''), secrets

    def _write(self, secrets: Mapping[str, Any]) -> None:
        payload = json.dumps(dict(secrets))
        if len(payload.encode()) > MAX_SECRET_BYTES:
            raise IssuesSettingsFull('the data sources\' settings are full: remove some entries under Administration → '
                                     'Sources → Source settings')
        try:
            self._secrets().put_secret_value(SecretId=self._secret_id, SecretString=payload,
                                             ClientRequestToken=self._request_token())
        except _AWS_ERRORS as error:
            logger.warning('engineering issues settings not written', extra={'error_code': error_code(error)})
            raise IssuesSettingsUnavailable('the GitHub Issues source could not be saved: try again') from None

    def _apply(self, change: Callable[[SourceState], Plan]) -> tuple[dict[str, Any], Plan]:
        """``change`` applied to the stored settings and written (only ``WRITABLE_KEYS``), never over another save
        (the module's concurrency rule): the settings after, and the plan."""
        version, secrets = self._read()
        restoring = False
        for _ in range(ATTEMPTS):
            planned = change(SourceState.of(secrets))
            if not set(planned.changes) <= WRITABLE_KEYS:
                raise IssuesSettingsUnavailable('the change names a key the connections may not write')
            if not planned.changes and not restoring:
                return secrets, planned
            if self._read()[0] != version:
                version, secrets = self._read()   # (saved meanwhile: plan again on what is stored now)
                restoring = False
                continue
            after = merged(secrets, planned.changes)
            self._write(after)
            previous, landed = self._read(PREVIOUS)
            if previous == version:
                return after, planned
            # Another save landed between the check and the write: it is AWSPREVIOUS now, and the version just written
            # lacks it. Apply the change again on top of it, so both stand.
            logger.warning('engineering issues settings saved meanwhile: the change is applied again on top of it')
            version, secrets, restoring = self._read()[0], landed, True
        raise IssuesSettingsUnavailable('the GitHub Issues source kept changing meanwhile: try again')

    # --- the schedule -----------------------------------------------------------------------------------------------

    def _schedule(self) -> bool | None:
        try:
            state = self._events().describe_rule(Name=self._rule).get('State')
        except _AWS_ERRORS as error:
            logger.warning('engineering issues schedule not read', extra={'error_code': error_code(error)})
            return None
        return state == 'ENABLED' if isinstance(state, str) else None

    def _enable(self) -> bool:
        try:
            self._events().enable_rule(Name=self._rule)
        except _AWS_ERRORS as error:
            logger.warning('engineering issues schedule not enabled', extra={'error_code': error_code(error)})
            return False
        return True

    # --- the actions ------------------------------------------------------------------------------------------------

    def follow(self, connection_id: str, repository: str, app_id: str) -> dict[str, Any]:
        after, planned = self._apply(lambda state: plan(state, app_id, add=[repository]))
        schedule = self._schedule()
        if (planned.added or planned.app_set) and schedule is not True and self._enable():
            schedule = True
        logger.info('engineering issues source followed a connection', extra={
            'connection_id': connection_id, 'added': len(planned.added), 'app_set': planned.app_set,
            'skipped': [reason for _, reason in planned.skipped]})
        return answer(after, schedule)

    def unfollow(self, connection_id: str, repositories: list[str]) -> dict[str, Any]:
        after, planned = self._apply(lambda state: plan(state, '', remove=repositories))
        logger.info('engineering issues source unfollowed a connection',
                    extra={'connection_id': connection_id, 'removed': len(planned.removed)})
        return answer(after, self._schedule())

    def status(self) -> dict[str, Any]:
        return answer(self._read()[1], self._schedule())


@lru_cache(maxsize=1)
def _secrets_client() -> Any:
    import boto3

    return boto3.client('secretsmanager')


@lru_cache(maxsize=1)
def _events_client() -> Any:
    import boto3

    return boto3.client('events')


def issues_config() -> IssuesConfig:
    """The function's, over its environment (``IssuesSettingsUnavailable`` when it names no secret or rule)."""
    secret_id, rule = os.environ.get(SETTINGS_ARN_ENV, ''), os.environ.get(RULE_ENV, '')
    if not (secret_id and rule):
        raise IssuesSettingsUnavailable('the deployment names no GitHub Issues settings or schedule to this function')
    return IssuesConfig(secret_id, rule, _secrets_client, _events_client)


@measure_invocation_cost
def lambda_handler(event: object, context: object) -> dict[str, Any]:
    """voc-engineering-issues-config's entry: ``follow``, ``unfollow`` or ``status``; anything else, and a request off
    its shape, is refused (``IssuesConfigRefused``) before the secret or the rule is read."""
    del context
    try:
        action, request = parse_request(event)
    except IssuesConfigRefused:
        logger.warning('engineering issues config: a request refused',
                       extra={'action': str(event.get('action'))[:40] if isinstance(event, Mapping) else ''})
        raise
    return dispatch(issues_config(), action, request)


def dispatch(config: IssuesConfig, action: str, request: dict[str, Any]) -> dict[str, Any]:
    """``action`` (``parse_request``'s) on ``config``."""
    if action == FOLLOW:
        return config.follow(**request)
    if action == UNFOLLOW:
        return config.unfollow(**request)
    return config.status()
