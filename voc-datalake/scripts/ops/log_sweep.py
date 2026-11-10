"""Read-only error sweep of one VoC deployment's logs (docs/deployment.md → After a deploy).

    .venv/bin/python scripts/ops/log_sweep.py [--hours 2] [--prefix <stack prefix>] [--region <region>]
                                              [--pattern <Logs Insights regex>] [--include-tests] [--limit 80]

Runs one CloudWatch Logs Insights query over every log group of the deployment: each `[<prefix>-]voc-*` Lambda's
REAL log group (its LoggingConfig; some functions log to a CloudFormation-named group), the Step Functions groups
and the stacks' own groups. The default pattern matches ERROR / WARNING / CRITICAL lines, tracebacks, timeouts,
access denials and import errors. Lines of e2e test traffic (`test_run`, frontend/e2e/README.md → Test traffic
tag) are left out unless `--include-tests`. Prints the newest lines first and exits 1 when any line matched (0
when clean, 2 on an AWS error). Uses the operator's ambient AWS credentials; writes nothing to AWS.
"""
from __future__ import annotations

import argparse
import sys
import time
from collections.abc import Callable, Iterable, Iterator
from typing import Any

DEFAULT_PATTERN = (
    r'/"level":\s*"(ERROR|WARNING|WARN|CRITICAL)"|\[ERROR\]|\[WARN|Task timed out|Traceback|AccessDenied'
    r'|not authorized|ImportModuleError|Runtime\.|bad magic number/'
)
#: The stacks whose CloudFormation-named log groups are swept too (custom resources, Cognito triggers).
STACKS = ('VocCoreStack', 'VocIngestionStack', 'VocProcessingStack', 'VocApiStack')
#: Logs Insights takes at most 50 log groups per query.
GROUPS_PER_QUERY = 50
POLL_SECONDS = 2
MESSAGE_CHARS = 300


def name_prefix(prefix: str | None) -> str:
    """`voc-`, or `<prefix>-voc-` for a prefixed deployment (the stacks' `uniqueName()`)."""
    return f'{prefix}-voc-' if prefix else 'voc-'


def stack_prefixes(prefix: str | None) -> list[str]:
    """The log group prefixes of the Step Functions and of the stacks' own groups."""
    stacks = [f'{prefix}-{stack}-' if prefix else f'{stack}-' for stack in STACKS]
    return [f'/aws/stepfunctions/{name_prefix(prefix)}', *stacks]


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


def build_query(pattern: str, include_tests: bool, limit: int) -> str:
    """The Logs Insights query: matching lines, test traffic left out unless asked for, newest first."""
    tests = '' if include_tests else ' | filter not ispresent(test_run)'
    return (f'fields @timestamp, @log, @message | filter @message like {pattern}{tests}'
            f' | sort @timestamp desc | limit {limit}')


def chunks(items: list[str], size: int = GROUPS_PER_QUERY) -> Iterator[list[str]]:
    for start in range(0, len(items), size):
        yield items[start:start + size]


def row_of(result: list[dict[str, str]]) -> tuple[str, str, str]:
    """(timestamp, log group name, message clipped to one line) of one Logs Insights result."""
    fields = {field['field']: field['value'] for field in result}
    message = fields.get('@message', '')[:MESSAGE_CHARS].replace('\n', ' ')
    return fields.get('@timestamp', ''), fields.get('@log', '').split(':')[-1], message


def run_query(logs: Any, groups: list[str], start: int, end: int, query: str,
              sleep: Callable[[float], None] = time.sleep) -> list[tuple[str, str, str]]:
    query_id = logs.start_query(logGroupNames=groups, startTime=start, endTime=end, queryString=query)['queryId']
    while (response := logs.get_query_results(queryId=query_id))['status'] in ('Running', 'Scheduled'):
        sleep(POLL_SECONDS)
    if response['status'] != 'Complete':
        raise RuntimeError(f'Logs Insights query {query_id} ended {response["status"]}')
    return [row_of(result) for result in response.get('results', [])]


def existing_groups(logs: Any, lambda_client: Any, prefix: str | None) -> list[str]:
    """Every log group of the deployment that exists (a function that never ran has none).

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


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description='Read-only error sweep of one VoC deployment\'s logs.')
    parser.add_argument('--hours', type=float, default=2.0, help='how far back to look (default 2)')
    parser.add_argument('--prefix', help='the deployment\'s stack prefix (-c stackPrefix), if any')
    parser.add_argument('--region', help='AWS region (default: the configured one)')
    parser.add_argument('--pattern', default=DEFAULT_PATTERN, help='Logs Insights `like` regex, e.g. /Task timed out/')
    parser.add_argument('--include-tests', action='store_true', help='keep the e2e suite\'s tagged lines')
    parser.add_argument('--limit', type=int, default=80, help='lines printed (default 80)')
    args = parser.parse_args(argv)
    if args.hours <= 0 or args.limit < 1:
        parser.error('--hours must be > 0 and --limit >= 1')
    return args


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    import boto3  # deferred so the module imports (and its tests run) without AWS config

    session = boto3.Session(region_name=args.region)
    logs = session.client('logs')
    try:
        groups = existing_groups(logs, session.client('lambda'), args.prefix)
        end = int(time.time())
        start = int(end - args.hours * 3600)
        query = build_query(args.pattern, args.include_tests, args.limit)
        rows = [row for chunk in chunks(groups) for row in run_query(logs, chunk, start, end, query)]
    except Exception as error:  # noqa: BLE001 - a CLI: any AWS failure is reported, not a traceback
        print(f'log sweep failed: {error}', file=sys.stderr)
        return 2
    print(f'{len(groups)} log groups, {len(rows)} matching lines in the last {args.hours:g} h')
    for timestamp, group, message in sorted(rows, reverse=True)[:args.limit]:
        print(timestamp, group, '|', message)
    return 1 if rows else 0


if __name__ == '__main__':
    sys.exit(main())
