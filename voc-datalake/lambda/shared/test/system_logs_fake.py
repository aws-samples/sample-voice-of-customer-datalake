"""A CloudWatch Logs client fake for shared/system_logs.py and the `/logs/system` route.

moto does not run Logs Insights queries, so the boundary is faked: log groups are
listed as `describe_log_groups` pages, every `start_query` gets a fresh id, and each
id answers `get_query_results` from `statuses` (one status per poll, the last one
repeating) with `rows` once it is `Complete`.
"""
from __future__ import annotations

import uuid
from collections.abc import Iterator
from typing import Any

from botocore.exceptions import ClientError

ACCOUNT = '123456789012'
SUFFIX = f'-{ACCOUNT}-us-east-1'
PATTERN = f'/aws/lambda/voc-*{SUFFIX}'


def group(function: str, prefix: str = '') -> str:
    """The log group name of `voc-<function>` in this (optionally prefixed) deployment."""
    return f'/aws/lambda/{prefix}voc-{function}{SUFFIX}'


def row(function: str, timestamp: str, message: str = '', **fields: str) -> list[dict[str, str]]:
    """One Insights result row for `voc-<function>`, as GetQueryResults returns it."""
    values = {'@timestamp': timestamp, '@log': f'{ACCOUNT}:{group(function)}', '@message': message, **fields}
    return [{'field': name, 'value': value} for name, value in values.items()]


class FakeLogs:
    def __init__(self, names: list[str], rows: list[list[dict[str, str]]] | None = None,
                 statuses: list[str] | None = None) -> None:
        self.names = names
        self.rows = rows or []
        self.statuses = statuses or ['Complete']
        self.started: list[dict[str, Any]] = []
        self.stopped: list[str] = []
        self.polls: dict[str, int] = {}
        self.fail_start = False
        self.prefixes: list[str] = []

    # describe_log_groups, through its paginator
    def get_paginator(self, name: str) -> FakeLogs:
        if name != 'describe_log_groups':
            raise AssertionError(name)
        return self

    def paginate(self, *, logGroupNamePrefix: str) -> Iterator[dict]:
        self.prefixes.append(logGroupNamePrefix)
        matching = [name for name in self.names if name.startswith(logGroupNamePrefix)]
        # Two pages, so pagination is exercised.
        half = len(matching) // 2
        yield {'logGroups': [{'logGroupName': name} for name in matching[:half]]}
        yield {'logGroups': [{'logGroupName': name} for name in matching[half:]]}

    def start_query(self, **kwargs: Any) -> dict:
        if self.fail_start:
            raise ClientError({'Error': {'Code': 'LimitExceededException', 'Message': 'secret detail'}}, 'StartQuery')
        query_id = str(uuid.uuid4())
        self.started.append({**kwargs, 'queryId': query_id})
        self.polls[query_id] = 0
        return {'queryId': query_id}

    def get_query_results(self, *, queryId: str) -> dict:
        count = self.polls.get(queryId, 0)
        self.polls[queryId] = count + 1
        status = self.statuses[min(count, len(self.statuses) - 1)]
        # Every row goes to the first query only, so a multi-query search does not double them.
        first = bool(self.started) and queryId == self.started[0]['queryId']
        results = self.rows if status == 'Complete' and (first or not self.started) else []
        return {'status': status, 'results': results}

    def stop_query(self, *, queryId: str) -> dict:
        self.stopped.append(queryId)
        return {'success': True}
