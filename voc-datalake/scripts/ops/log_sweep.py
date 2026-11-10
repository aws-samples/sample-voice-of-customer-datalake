"""Read-only error sweep of one VoC deployment's logs (docs/deployment.md → Log sweep after a deploy).

    .venv/bin/python scripts/ops/log_sweep.py [--hours 2] [--prefix <deployment prefix>] [--region <region>]
                                              [--pattern <Logs Insights regex>] [--limit 80]

Two reads, both with the operator's ambient AWS credentials; nothing is written to AWS.

1. Lambda and workflow logs: every `[<prefix>-]voc-*` Lambda's REAL log group (its LoggingConfig; some functions log
   to a CloudFormation-named group), the Step Functions groups and the stacks' own groups. Every ERROR / WARNING /
   CRITICAL line, traceback, timeout, access denial and import error is listed, e2e test traffic included (marked
   `[e2e <run>]`): a test run never hides a server-side error.
2. The API Gateway access log: requests by status class, for real traffic and for e2e traffic. Every 5xx is listed.
   Every 4xx is listed too, EXCEPT an e2e request that declared that exact status as expected (the User-Agent token
   `voc-e2e-expect/<status>[,<status>]`, frontend/e2e/lib/trafficTag.ts: a gate the suite probes on purpose, a fake id,
   a GET after a DELETE). Those are only counted.

Exit 1 when it finds a Lambda error / warning line, a 5xx, or an e2e 4xx nobody declared; 0 when clean; 2 on an AWS
error or when it finds no log groups (a wrong prefix or region). Real traffic's 4xx (an expired session's 401, a
mistyped id) are listed but do not fail the sweep.
"""
from __future__ import annotations

import argparse
import re
import sys
import time
from collections.abc import Callable, Iterable, Iterator
from dataclasses import dataclass
from typing import Any

DEFAULT_PATTERN = (
    r'/"level":\s*"(ERROR|WARNING|WARN|CRITICAL)"|\[ERROR\]|\[WARN|Task timed out|Traceback|AccessDenied'
    r'|not authorized|ImportModuleError|Runtime\.|bad magic number/'
)
#: The stacks whose CloudFormation-named log groups are swept too (custom resources, Cognito triggers).
STACKS = ('VocCoreStack', 'VocIngestionStack', 'VocProcessingStack', 'VocApiStack')
#: Base name of the REST API and its access log group (lib/stacks/api-gateway.ts API_NAME_BASE).
API_NAME_BASE = 'analytics-api'
#: Logs Insights takes at most 50 log groups per query.
GROUPS_PER_QUERY = 50
POLL_SECONDS = 2
MESSAGE_CHARS = 300
#: Rows a `stats` query may return; the access log is grouped by status, method and route, far below this.
STATS_LIMIT = 10000
_EXPECT_TOKEN = re.compile(r'(?:\A|[ \t])voc-e2e-expect/((?:4\d\d,)*4\d\d)(?=[ \t]|\Z)')


def name_prefix(prefix: str | None) -> str:
    """`voc-`, or `<prefix>-voc-` for a prefixed deployment (the stacks' `uniqueName()`)."""
    return f'{prefix}-voc-' if prefix else 'voc-'


def stack_prefixes(prefix: str | None) -> list[str]:
    """The log group prefixes of the Step Functions and of the stacks' own groups."""
    stacks = [f'{prefix}-{stack}-' if prefix else f'{stack}-' for stack in STACKS]
    return [f'/aws/stepfunctions/{name_prefix(prefix)}', *stacks]


def access_log_prefix(prefix: str | None) -> str:
    """`/aws/apigateway/[<prefix>-]voc-analytics-api` (followed by `-<account>-<region>`)."""
    return f'/aws/apigateway/{name_prefix(prefix)}{API_NAME_BASE}'


def function_log_groups(functions: Iterable[dict[str, Any]], prefix: str | None) -> set[str]:
    """Each deployment function's real log group: its LoggingConfig group, else `/aws/lambda/<name>`."""
    wanted = name_prefix(prefix)
    groups = set()
    for function in functions:
        name = function.get('FunctionName', '')
        if not name.startswith(wanted):
            continue
        groups.add(function.get('LoggingConfig', {}).get('LogGroup') or f'/aws/lambda/{name}')
    return groups


def build_query(pattern: str, limit: int) -> str:
    """The Lambda-log query: every matching line, e2e ones included (with their run tag), newest first."""
    return (f'fields @timestamp, @log, @message, test_run | filter @message like {pattern}'
            f' | sort @timestamp desc | limit {limit}')


ACCESS_QUERY = (
    'parse userAgent /voc-e2e-expect\\/(?<declared>[0-9,]+)/'
    ' | stats count() as n by status, httpMethod, resourcePath, (userAgent like /voc-e2e\\//) as e2e, declared'
    f' | limit {STATS_LIMIT}'
)


def chunks(items: list[str], size: int = GROUPS_PER_QUERY) -> Iterator[list[str]]:
    for start in range(0, len(items), size):
        yield items[start:start + size]


def fields_of(result: list[dict[str, str]]) -> dict[str, str]:
    return {field['field']: field['value'] for field in result}


def row_of(result: list[dict[str, str]]) -> tuple[str, str, str]:
    """(timestamp, log group name, message clipped to one line, prefixed `[e2e <run>]` for test traffic)."""
    fields = fields_of(result)
    message = fields.get('@message', '')[:MESSAGE_CHARS].replace('\n', ' ')
    run = fields.get('test_run')
    return fields.get('@timestamp', ''), fields.get('@log', '').split(':')[-1], f'[e2e {run}] {message}' if run else message


def run_insights(logs: Any, groups: list[str], start: int, end: int, query: str,
                 sleep: Callable[[float], None] = time.sleep) -> list[list[dict[str, str]]]:
    query_id = logs.start_query(logGroupNames=groups, startTime=start, endTime=end, queryString=query)['queryId']
    while (response := logs.get_query_results(queryId=query_id))['status'] in ('Running', 'Scheduled'):
        sleep(POLL_SECONDS)
    if response['status'] != 'Complete':
        raise RuntimeError(f'Logs Insights query {query_id} ended {response["status"]}')
    return response.get('results', [])


def run_query(logs: Any, groups: list[str], start: int, end: int, query: str,
              sleep: Callable[[float], None] = time.sleep) -> list[tuple[str, str, str]]:
    return [row_of(result) for result in run_insights(logs, groups, start, end, query, sleep)]


def existing_groups(logs: Any, lambda_client: Any, prefix: str | None) -> list[str]:
    """Every Lambda / workflow / stack log group of the deployment that exists (a function that never ran has none).

    Lists the `/aws/lambda/<name prefix>`, Step Functions and stack groups once (paginated) and keeps the
    functions' groups found there, instead of one DescribeLogGroups call per function.
    """
    candidates: set[str] = set()
    for page in lambda_client.get_paginator('list_functions').paginate():
        candidates |= function_log_groups(page['Functions'], prefix)
    listed: set[str] = set()
    for group_prefix in [f'/aws/lambda/{name_prefix(prefix)}', *stack_prefixes(prefix)]:
        for page in logs.get_paginator('describe_log_groups').paginate(logGroupNamePrefix=group_prefix):
            listed.update(group['logGroupName'] for group in page['logGroups'])
    stack_groups = {group for group in listed if not group.startswith('/aws/lambda/')}
    return sorted((candidates & listed) | stack_groups)


def access_log_groups(logs: Any, prefix: str | None) -> list[str]:
    groups: list[str] = []
    for page in logs.get_paginator('describe_log_groups').paginate(logGroupNamePrefix=access_log_prefix(prefix)):
        groups.extend(group['logGroupName'] for group in page['logGroups'])
    return sorted(groups)


def declared_statuses(declared: str | None) -> frozenset[int]:
    """The statuses of a `voc-e2e-expect/<list>` token (as Logs Insights parsed it), or none."""
    match = _EXPECT_TOKEN.search(f'voc-e2e-expect/{declared}') if declared else None
    return frozenset(int(status) for status in match.group(1).split(',')) if match else frozenset()


@dataclass(frozen=True)
class RequestGroup:
    """One access-log `stats` row: how many requests of one status, method and route, from one kind of traffic."""

    status: int
    method: str
    route: str
    e2e: bool
    declared: frozenset[int]
    count: int

    @property
    def expected(self) -> bool:
        """An e2e request refused with exactly a status it declared it would get."""
        return self.e2e and 400 <= self.status < 500 and self.status in self.declared


def request_group(result: list[dict[str, str]]) -> RequestGroup | None:
    fields = fields_of(result)
    status = fields.get('status', '')
    if not status.isdigit():
        return None
    return RequestGroup(int(status), fields.get('httpMethod', '?'), fields.get('resourcePath', '?'),
                        fields.get('e2e') == '1', declared_statuses(fields.get('declared')), int(fields.get('n', '0')))


@dataclass(frozen=True)
class ApiFindings:
    totals: dict[tuple[str, str], int]
    server_errors: list[RequestGroup]
    unexpected_e2e: list[RequestGroup]
    real_client_errors: list[RequestGroup]
    expected_count: int


def classify(groups: Iterable[RequestGroup]) -> ApiFindings:
    """Status-class totals per traffic kind, and the groups that need reading."""
    totals: dict[tuple[str, str], int] = {}
    server_errors, unexpected, real_4xx = [], [], []
    expected = 0
    for group in groups:
        traffic = 'e2e' if group.e2e else 'real'
        key = (traffic, f'{group.status // 100}xx')
        totals[key] = totals.get(key, 0) + group.count
        if group.status >= 500:
            server_errors.append(group)
        elif group.status >= 400 and group.expected:
            expected += group.count
        elif group.status >= 400:
            (unexpected if group.e2e else real_4xx).append(group)
    return ApiFindings(totals, _most_first(server_errors), _most_first(unexpected), _most_first(real_4xx), expected)


def _most_first(groups: list[RequestGroup]) -> list[RequestGroup]:
    return sorted(groups, key=lambda group: -group.count)


def describe(group: RequestGroup) -> str:
    declared = f' (declared {",".join(map(str, sorted(group.declared)))})' if group.declared else ''
    return f'{group.count:6d}  {group.status} {group.method} {group.route}{declared}'


def print_api_report(findings: ApiFindings, limit: int) -> None:
    classes = ('2xx', '3xx', '4xx', '5xx')
    print('API requests          ' + ''.join(f'{c:>9}' for c in classes))
    for traffic in ('real', 'e2e'):
        print(f'  {traffic:<20}' + ''.join(f'{findings.totals.get((traffic, c), 0):9d}' for c in classes))
    print(f'  e2e 4xx declared as expected (counted, not listed): {findings.expected_count}')
    for title, items in (('5xx (any traffic)', findings.server_errors),
                         ('e2e 4xx nobody declared', findings.unexpected_e2e),
                         ('real-traffic 4xx (listed, not failing)', findings.real_client_errors)):
        print(f'{title}: {sum(g.count for g in items)}')
        for group in items[:limit]:
            print('  ' + describe(group))


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description='Read-only error sweep of one VoC deployment\'s logs.')
    parser.add_argument('--hours', type=float, default=2.0, help='how far back to look (default 2)')
    parser.add_argument('--prefix', help='the deployment\'s prefix (-c deploymentPrefix), if any')
    parser.add_argument('--region', help='AWS region (default: the configured one)')
    parser.add_argument('--pattern', default=DEFAULT_PATTERN, help='Logs Insights `like` regex, e.g. /Task timed out/')
    parser.add_argument('--limit', type=int, default=80, help='lines printed per list (default 80)')
    args = parser.parse_args(argv)
    if args.hours <= 0 or args.limit < 1:
        parser.error('--hours must be > 0 and --limit >= 1')
    return args


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    import boto3  # deferred so the module imports (and its tests run) without AWS config

    session = boto3.Session(region_name=args.region)
    logs = session.client('logs')
    end = int(time.time())
    start = int(end - args.hours * 3600)
    try:
        groups = existing_groups(logs, session.client('lambda'), args.prefix)
        access = access_log_groups(logs, args.prefix)
        if not groups:
            # Not "clean": a wrong prefix or region finds nothing to sweep.
            print(f'no log groups found for prefix {args.prefix or "(none)"}: check --prefix and --region',
                  file=sys.stderr)
            return 2
        query = build_query(args.pattern, args.limit)
        rows = [row for chunk in chunks(groups) for row in run_query(logs, chunk, start, end, query)]
        findings = classify(group for result in (run_insights(logs, access, start, end, ACCESS_QUERY) if access else [])
                            if (group := request_group(result)) is not None)
    except Exception as error:  # noqa: BLE001 - a CLI: any AWS failure is reported, not a traceback
        print(f'log sweep failed: {error}', file=sys.stderr)
        return 2
    print(f'Lambda / workflow logs: {len(groups)} log groups, {len(rows)} error / warning lines in the last {args.hours:g} h')
    for timestamp, group, message in sorted(rows, reverse=True)[:args.limit]:
        print(' ', timestamp, group, '|', message)
    if not access:
        print('API access log: not found (no API stack in this region?)')
    else:
        print_api_report(findings, args.limit)
    return 1 if rows or findings.server_errors or findings.unexpected_e2e else 0


if __name__ == '__main__':
    sys.exit(main())
