"""Which CloudWatch log groups Administration → System → Logs reads (`GET /logs/system*`).

Four kinds of group, each named to the logs Lambda by CDK (lib/stacks/api-logs-diagnostics.ts):

* `SYSTEM_LOG_GROUP_PATTERN`: `/aws/lambda/[<prefix>-]voc-*-<account>-<region>`, every Lambda
  with a `voc-` function name (source `lambda`, function = the name between `voc-` and the suffix);
* `SYSTEM_EXTRA_LOG_GROUPS`: `<function>=<log group name prefix>` pairs for the app's own Lambdas
  whose log group CloudFormation named (`VocCoreStack-ProductDocExtractorLambdaLogs…`); a prefix
  because the generated tail is unknown at synth time (source `lambda`);
* `SYSTEM_WORKFLOW_LOG_GROUP_PATTERN`: `/aws/stepfunctions/[<prefix>-]voc-*-<account>-<region>`,
  the state machines' execution logs (source `workflow`, function = the state machine's short name);
* `SYSTEM_API_ACCESS_LOG_GROUP`: the API Gateway stage's access log (source `api`, function `api`).

Only the first is required; a deployment without the others simply searches fewer groups.
Every group is listed with `DescribeLogGroups` (a prefix plus a check here), so a name that
does not exist is never handed to `StartQuery` (which would fail the whole query). The kinds
are listed concurrently, and the answer is kept for `DISCOVERY_TTL_SECONDS` in the warm Lambda:
a search and each of its `query_id` polls would otherwise list every group again (log groups
change only with a deploy, or when a new function first logs, which then shows within minutes).
"""
from __future__ import annotations

import os
import re
import time
from collections.abc import Callable
from dataclasses import dataclass
from operator import attrgetter
from typing import Any, Final

from shared.concurrency import concurrently
from shared.exceptions import ConfigurationError

PATTERN_ENV: Final = 'SYSTEM_LOG_GROUP_PATTERN'
EXTRA_ENV: Final = 'SYSTEM_EXTRA_LOG_GROUPS'
WORKFLOW_ENV: Final = 'SYSTEM_WORKFLOW_LOG_GROUP_PATTERN'
API_ENV: Final = 'SYSTEM_API_ACCESS_LOG_GROUP'

SOURCE_LAMBDA: Final = 'lambda'
SOURCE_WORKFLOW: Final = 'workflow'
SOURCE_API: Final = 'api'
API_FUNCTION: Final = 'api'
_ACCOUNT_ID = re.compile(r'(?<!\d)\d{12}(?!\d)')
DISCOVERY_TTL_SECONDS: Final = 300.0
# Entries are keyed by (client, sources): one in a Lambda (a cached client, fixed env), a few in tests.
_MAX_CACHED_DISCOVERIES: Final = 8
discovered_log_groups: dict[tuple[Any, LogSources], tuple[float, tuple[LogTarget, ...]]] = {}


@dataclass(frozen=True)
class LogGroupPattern:
    """`/aws/lambda/[<prefix>-]voc-*-<account>-<region>` split around its `*`."""

    prefix: str
    suffix: str

    @classmethod
    def parse(cls, pattern: str) -> LogGroupPattern | None:
        if pattern.count('*') != 1:
            return None
        prefix, suffix = pattern.split('*')
        return cls(prefix, suffix)

    def matches(self, name: str) -> bool:
        return name.startswith(self.prefix) and name.endswith(self.suffix) and \
            len(name) > len(self.prefix) + len(self.suffix)

    def function_of(self, name: str) -> str:
        """`/aws/lambda/voc-projects-assist-<account>-<region>` → `projects-assist`."""
        return name[len(self.prefix):-len(self.suffix) or None] if self.matches(name) else name


@dataclass(frozen=True)
class LogTarget:
    """One log group the search reads, and how its rows are labelled."""

    name: str
    function: str
    source: str


def _pairs(raw: str) -> tuple[tuple[str, str], ...]:
    pairs: list[tuple[str, str]] = []
    for entry in raw.split(','):
        function, sep, prefix = entry.strip().partition('=')
        if sep and function.strip() and prefix.strip():
            pairs.append((function.strip(), prefix.strip()))
    return tuple(pairs)


def _common_prefix(values: list[str]) -> str:
    """The longest STRING prefix every value shares (log group prefixes are compared as text, not as paths)."""
    if not values:
        return ''
    first, last = min(values), max(values)
    shared = next((i for i, (a, b) in enumerate(zip(first, last, strict=False)) if a != b), len(first))
    return first[:shared]


@dataclass(frozen=True)
class LogSources:
    """The configured groups, read from the Lambda environment."""

    lambdas: LogGroupPattern
    extras: tuple[tuple[str, str], ...] = ()
    workflows: LogGroupPattern | None = None
    api_group: str = ''

    @classmethod
    def from_env(cls) -> LogSources:
        lambdas = LogGroupPattern.parse(os.environ.get(PATTERN_ENV, ''))
        if lambdas is None:
            raise ConfigurationError('System log search is not configured on this deployment')
        return cls(
            lambdas=lambdas,
            extras=_pairs(os.environ.get(EXTRA_ENV, '')),
            workflows=LogGroupPattern.parse(os.environ.get(WORKFLOW_ENV, '')),
            api_group=os.environ.get(API_ENV, '').strip(),
        )

    def deployment_prefix(self) -> str | None:
        """`stg` for `/aws/lambda/stg-voc-`, None for an unprefixed deployment."""
        segment = self.lambdas.prefix.rstrip('/').rsplit('/', 1)[-1]
        head = segment[:-len('voc-')] if segment.endswith('voc-') else ''
        return head.rstrip('-') or None

    def coverage(self) -> dict[str, Any]:
        """What this deployment's search can read, for the download's reader."""
        return {
            # The account id is masked: the answer names only its last four digits elsewhere.
            'lambda_log_group_pattern': _ACCOUNT_ID.sub('<account>', self.lambdas.prefix + '*' + self.lambdas.suffix),
            'extra_lambda_functions': [function for function, _prefix in self.extras],
            'workflow_logs': self.workflows is not None,
            'api_access_log': bool(self.api_group),
        }


def _listed(client: Any, prefix: str) -> list[str]:
    names: list[str] = []
    paginator = client.get_paginator('describe_log_groups')
    for page in paginator.paginate(logGroupNamePrefix=prefix):
        for group in page.get('logGroups', []):
            name = group.get('logGroupName', '')
            if isinstance(name, str) and name:
                names.append(name)
    return names


def _pattern_targets(client: Any, pattern: LogGroupPattern, source: str) -> list[LogTarget]:
    return [LogTarget(name, pattern.function_of(name), source)
            for name in _listed(client, pattern.prefix) if pattern.matches(name)]


def _extra_targets(client: Any, extras: tuple[tuple[str, str], ...]) -> list[LogTarget]:
    # ONE listing for every extra group (they share their stack's name as a prefix), not one per group.
    prefix = _common_prefix([group_prefix for _function, group_prefix in extras])
    if not prefix:
        return []
    targets: list[LogTarget] = []
    for name in _listed(client, prefix):
        function = next((fn for fn, group_prefix in extras if name.startswith(group_prefix)), None)
        if function is not None:
            targets.append(LogTarget(name, function, SOURCE_LAMBDA))
    return targets


def _api_targets(client: Any, api_group: str) -> list[LogTarget]:
    """The access log group, only when it exists (exact name, listed by prefix)."""
    if not api_group:
        return []
    return [LogTarget(name, API_FUNCTION, SOURCE_API) for name in _listed(client, api_group) if name == api_group]


def _listed_targets(client: Any, sources: LogSources) -> list[LogTarget]:
    """Every existing log group of `sources`, sorted by name within each kind (one listing per kind, concurrent)."""
    lambdas, extras, workflows, api = concurrently(
        lambda: _pattern_targets(client, sources.lambdas, SOURCE_LAMBDA),
        lambda: _extra_targets(client, sources.extras),
        lambda: _pattern_targets(client, sources.workflows, SOURCE_WORKFLOW) if sources.workflows else [],
        lambda: _api_targets(client, sources.api_group),
    )
    by_name = attrgetter('name')
    return sorted(lambdas + extras, key=by_name) + sorted(workflows, key=by_name) + api


def discover(client: Any, sources: LogSources, *, clock: Callable[[], float] = time.monotonic) -> list[LogTarget]:
    """Every existing log group of `sources`, sorted by name within each kind; listed at most once per TTL."""
    key = (client, sources)
    now = clock()
    cached = discovered_log_groups.get(key)
    if cached is not None and cached[0] > now:
        return list(cached[1])
    targets = _listed_targets(client, sources)
    if len(discovered_log_groups) >= _MAX_CACHED_DISCOVERIES:
        discovered_log_groups.clear()
    discovered_log_groups[key] = (now + DISCOVERY_TTL_SECONDS, tuple(targets))
    return targets


def log_group_name(log: str) -> str:
    """Insights' `@log` (`<account>:<log group name>`) as the bare log group name."""
    return log.split(':', 1)[1] if ':' in log and not log.startswith('/') else log
