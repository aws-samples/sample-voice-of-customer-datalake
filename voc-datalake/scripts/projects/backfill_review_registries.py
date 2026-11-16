"""List the deployment's review links, commented series and projects made before 7.47.00 (docs/multi-workspace.md,
the project plan's 3g-d; CHANGELOG 7.47.00, "Upgrade notes").

Since 7.47.00 a deployment's review link create puts the link in the deployment's link registry (``DOCSHARE_IDS`` /
``{share id}``) and its series in the series registry (``COMMENT_SERIES_IDS`` / ``{project}#{series}``), a series'
first thread (and the project bundle's import) puts its series there too, and a project's create (and the import)
puts the project in the project registry (``PROJECT_IDS`` / ``{id}``, which its delete keeps), so an erasure by email
finds every link (a revoked one too), every comment partition and every project (a deleted one too) by a Query
(``shared/review_registries.py``). What was made before has no such row. This script, once, for one deployment:

1. scans voc-projects for the deployment's review links (``DOCSHARE#{id}`` / ``META`` rows naming no workspace: a
   workspace link's routing row is left alone) and puts each one's registry row if absent, naming its project and
   series as the link create does;
2. scans it again for the comment partitions (``DCOMMENTS#{project}#{series}``) and puts each series' registry row if
   absent;
3. scans it a third time for the projects (``PROJECT#{id}`` / ``META``, a deleted one's tombstone too; the persona
   library's container left out) and puts each one's registry row if absent, with its ``created_at``;
4. with ``--apply``, once one applied walk reached the end of the table, puts the marker (``DOCSHARE_IDS`` /
   ``MIGRATION#review-registries``: when, what each pass found, and the release it was taken under), but only once
   there is exactly one of each function that writes links, threads or projects (the projects API and its assist
   twin, found in the API stack), each reports ``APP_VERSION`` 7.47.0 or later, its last update applied
   (``LastUpdateStatus`` ``Successful``), and was last updated at least the drain before the walk began: the longest
   of their ``Timeout`` plus 5 minutes, so no invocation of an older container can still write a link, a thread or
   a project behind the Scans (``link_writers``, read with the operator's own credentials, read-only:
   ``cloudformation:ListStackResources`` and ``lambda:GetFunctionConfiguration``, plus
   ``cloudformation:DescribeStacks`` when the table is not named; GetFunctionConfiguration also answers each
   function's environment variable names and values, ARNs among them, which the script reads only for
   ``APP_VERSION``). It is judged before an applied walk starts (none starts otherwise) and again at its end, against
   when it began: a writer updated during the walk (another deploy) voids it, and its progress row goes. Until the
   marker is there an erasure finds the same rows by these Scans itself, whether or not this ran. It never changes or
   deletes a link, a thread, a project or anything else.

DRY RUN BY DEFAULT: it reads, then prints a summary of what it would list. Idempotent: every put is conditional (a row
the stores, or an earlier run, wrote is kept as it is), so a second run lists nothing and only rewrites the marker.
Resumable: an applied walk keeps its progress in a row of its own (``MIGRATION#review-registries#progress``: the run's
id, its pass, the Scan's key, the counts so far), each update conditioned on the run's id, so a second ``--apply``
started meanwhile takes the walk over and the first one stops. ``--max-pages N`` stops after N Scan pages (without it a
run fails past ``MAX_PAGES``); ``--resume`` goes on from that row only (nothing a person types names where), under a
new run id put on the condition of the old one (the run it resumes, if still alive, stops), and the marker's put and
the progress row's delete are one transaction on the condition of the run id, so the marker is written only at the
end of one applied walk nobody took over. ``--unmark`` deletes the marker and any progress row: do it before rolling
back to a release older than 7.47.00 (which writes no registry row), so the next upgrade's erasures fall back to their
own Scans until this runs again.

Usage (from voc-datalake/):
    .venv/bin/python scripts/projects/backfill_review_registries.py [--stack VocCoreStack] [--region us-west-2]
    .venv/bin/python scripts/projects/backfill_review_registries.py --projects-table NAME --apply [--max-pages N]
    .venv/bin/python scripts/projects/backfill_review_registries.py --apply --resume
    .venv/bin/python scripts/projects/backfill_review_registries.py --unmark
Table name: the flag, else the PROJECTS_TABLE environment, else the core stack's ProjectsTableName output. The writers
are the API stack's (``--api-stack``, default VocApiStack).
"""
from __future__ import annotations

import argparse
import os
import sys
import uuid
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

# `lambda/`, so the keys, the Scan and the rows are the ones the stores and the erasure use.
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'lambda'))

from botocore.exceptions import ClientError

from shared.aws import is_conditional_check_failure
from shared.project_keys import (
    DEPLOYMENT_LINK_REGISTRY_PK,
    REVIEW_REGISTRIES_MARKER_SK,
    deployment_link_registry_key,
    deployment_project_item,
    deployment_series_item,
    series_registry_ids,
)
from shared.review_registries import FIRST_RELEASE, LINKS, PROJECTS, SERIES, release_of, scan_page

#: The three passes, in order (the links first, as the erasure reads them), and the progress row's ``pass`` once all
#: are done but the marker is not written yet (a later ``--resume`` writes only the marker).
PASSES = (LINKS, SERIES, PROJECTS)
DONE = 'done'
#: How long after a writer's last update its containers of the release before may still run: the longest writer's
#: ``Timeout`` (an invocation started just before the update runs that long at most) plus ``DRAIN_MARGIN``.
DRAIN_MARGIN = timedelta(minutes=5)
#: The functions that write links, threads or projects (lib/stacks/api-projects-lambda.ts: the projects API and its
#: assist twin; a CDK test holds the functions bundling those writers to exactly these): exactly one of each.
WRITER_NAMES = ('voc-projects-api', 'voc-projects-assist')
MARKER_KEY = {'pk': DEPLOYMENT_LINK_REGISTRY_PK, 'sk': REVIEW_REGISTRIES_MARKER_SK}
PROGRESS_KEY = {'pk': DEPLOYMENT_LINK_REGISTRY_PK, 'sk': f'{REVIEW_REGISTRIES_MARKER_SK}#progress'}
#: What the progress row keeps of the walk (the rest of the row is ``applied`` and ``updated_at``).
STATE_FIELDS = ('run_id', 'pass', 'start', 'after', *(f'{kind}_found' for kind in PASSES), 'started_at')
#: The Scan pages one run reads at most without ``--max-pages`` (about 500 million rows a pass at 100 a page): a walk
#: that never ends fails rather than loop.
MAX_PAGES = 5_000_000
_TAKEN_OVER = 'another run of the backfill took the walk over; this one stops'

Writers = Callable[[], list[dict[str, Any]]]


def _per_pass() -> dict[str, int]:
    return dict.fromkeys(PASSES, 0)


@dataclass
class Report:
    #: Rows the Scans evaluated (this run), what each pass found, rows listed now, rows already listed, malformed.
    scanned: int = 0
    found: dict[str, int] = field(default_factory=_per_pass)
    listed: dict[str, int] = field(default_factory=_per_pass)
    already_listed: dict[str, int] = field(default_factory=_per_pass)
    malformed: int = 0
    #: Stopped by ``max_pages`` (a later ``--resume`` goes on), the marker written, or why it was not.
    stopped: bool = False
    marked: bool = False
    unmarked: str | None = None


def _registry_row(kind: str, found: str, row: Mapping[str, Any], at: str) -> dict[str, Any]:
    """The registry row the stores write for a link, a series or a project."""
    if kind == LINKS:
        return {**deployment_link_registry_key(found), 'created_at': str(row.get('created_at') or at),
                'project_id': str(row.get('project_id') or ''), 'series_id': str(row.get('series_id') or '')}
    if kind == PROJECTS:
        return deployment_project_item(found, str(row.get('created_at') or at))
    project_id, series_id = series_registry_ids(found) or ('', '')
    return deployment_series_item(project_id, series_id, at)


def _put_if_absent(table: Any, item: Mapping[str, Any], apply: bool) -> bool:
    """Whether the row was missing (``apply``: then put; a dry run reads it)."""
    if not apply:
        return 'Item' not in table.get_item(Key={'pk': item['pk'], 'sk': item['sk']}, ConsistentRead=True,
                                            ProjectionExpression='pk')
    try:
        table.put_item(Item=dict(item), ConditionExpression='attribute_not_exists(pk)')
    except ClientError as error:
        if is_conditional_check_failure(error):
            return False
        raise
    return True


def _drain(writers: list[dict[str, Any]]) -> timedelta | None:
    """The longest writer's ``Timeout`` plus ``DRAIN_MARGIN``; None when a writer names no Timeout."""
    timeouts = [writer.get('timeout') for writer in writers]
    if not all(isinstance(each, int) and not isinstance(each, bool) and each > 0 for each in timeouts):
        return None
    return timedelta(seconds=max(int(each) for each in timeouts if isinstance(each, int))) + DRAIN_MARGIN


def writers_ready(writers: list[dict[str, Any]], began: datetime) -> str | None:
    """None when there is exactly one function of each ``WRITER_NAMES`` base, each runs ``FIRST_RELEASE`` or later,
    its last update applied (``LastUpdateStatus`` ``Successful``), and last updated at least the drain (the longest
    writer's ``Timeout`` plus ``DRAIN_MARGIN``) before the walk ``began`` (its old containers had ended every
    invocation before the first Scan page), else why not."""
    for base in WRITER_NAMES:
        count = sum(1 for writer in writers if writer.get('base') == base)
        if count != 1:
            return f'exactly one {base} function must be in the API stack (found {count})'
    drain = _drain(writers)
    for writer in writers:
        version = release_of(writer.get('version'))
        if version is None or version < FIRST_RELEASE:
            return f"{writer.get('name')} runs a release older than 7.47.0 (or names none)"
        if writer.get('status') != 'Successful':
            return f"{writer.get('name')}'s last update is not Successful (LastUpdateStatus {writer.get('status')})"
    for writer in writers:
        modified = writer.get('last_modified')
        if drain is None or not isinstance(modified, datetime) or began - modified < drain:
            minutes = 'its Timeout' if drain is None else f'{int(drain.total_seconds() // 60)} minutes'
            return (f"{writer.get('name')} was updated less than {minutes} before the walk began: its older "
                    'containers may not have drained')
    return None


def link_writers(cloudformation: Any, lambda_client: Any, api_stack: str) -> list[dict[str, Any]]:
    """The API stack's functions that write links or threads, each with its ``APP_VERSION`` and last update."""
    names, token = [], None
    for _page in range(100):
        response = cloudformation.list_stack_resources(StackName=api_stack, **({'NextToken': token} if token else {}))
        names += [str(each.get('PhysicalResourceId') or '') for each in response.get('StackResourceSummaries', [])
                  if each.get('ResourceType') == 'AWS::Lambda::Function'
                  and any(base in str(each.get('PhysicalResourceId') or '') for base in WRITER_NAMES)]
        token = response.get('NextToken')
        if not token:
            break
    found = []
    for name in names:
        config = lambda_client.get_function_configuration(FunctionName=name)
        variables = (config.get('Environment') or {}).get('Variables') or {}
        modified = datetime.strptime(str(config.get('LastModified')), '%Y-%m-%dT%H:%M:%S.%f%z').astimezone(UTC)
        found.append({'name': name, 'base': next(base for base in WRITER_NAMES if base in name),
                      'version': variables.get('APP_VERSION'), 'last_modified': modified,
                      'status': config.get('LastUpdateStatus'), 'timeout': config.get('Timeout')})
    return found


def _progress(table: Any) -> dict[str, Any] | None:
    item = table.get_item(Key=PROGRESS_KEY, ConsistentRead=True).get('Item')
    return dict(item) if isinstance(item, Mapping) else None


def _save(table: Any, state: dict[str, Any], now: str) -> None:
    """The walk's progress, only while the row is still this run's (another ``--apply``, or a ``--resume``, took the
    walk over: this one stops)."""
    try:
        table.put_item(Item={**PROGRESS_KEY, **{name: state[name] for name in STATE_FIELDS}, 'applied': True,
                             'updated_at': now},
                       ConditionExpression='run_id = :run', ExpressionAttributeValues={':run': state['run_id']})
    except ClientError as error:
        if is_conditional_check_failure(error):
            raise SystemExit(_TAKEN_OVER) from error
        raise


def _resumed(table: Any, now: str) -> dict[str, Any]:
    """The stopped walk's state, taken over under a new run id (a put conditioned on the old one, so the run it
    resumes, if still alive, stops at its next save), keeping when it began and where it was."""
    stored = _progress(table)
    if (stored is None or stored.get('applied') is not True or stored.get('pass') not in (*PASSES, DONE)
            or not isinstance(stored.get('started_at'), str) or not isinstance(stored.get('run_id'), str)):
        raise SystemExit('no stopped run to resume: start one with --apply')
    state = {'run_id': uuid.uuid4().hex, 'pass': stored['pass'], 'start': stored.get('start') or None,
             'after': stored.get('after'), **{f'{kind}_found': int(stored.get(f'{kind}_found') or 0) for kind in PASSES},
             'started_at': stored['started_at']}
    try:
        table.put_item(Item={**PROGRESS_KEY, **state, 'applied': True, 'updated_at': now},
                       ConditionExpression='run_id = :run', ExpressionAttributeValues={':run': stored['run_id']})
    except ClientError as error:
        if is_conditional_check_failure(error):
            raise SystemExit(_TAKEN_OVER) from error
        raise
    return state


def _start(table: Any, apply: bool, resume: bool, began: datetime, now: str) -> dict[str, Any]:
    """The walk's state: a new one (an applied one takes the progress row, with when it ``began``), or the stopped
    one's (``_resumed``: it keeps when it began, as the writers are judged against that)."""
    if resume:
        if not apply:
            raise SystemExit('--resume goes on with an applied walk: pass --apply')
        return _resumed(table, now)
    state = {'run_id': uuid.uuid4().hex, 'pass': LINKS, 'start': None, 'after': None,
             **{f'{kind}_found': 0 for kind in PASSES}, 'started_at': began.isoformat()}
    if apply:
        table.put_item(Item={**PROGRESS_KEY, **state, 'applied': True})
    return state


def _walk_page(table: Any, state: dict[str, Any], report: Report, apply: bool, now: Callable[[], str]) -> None:
    """One Scan page of the current pass, each id found listed if absent, and the state moved past it."""
    kind, start = state['pass'], state['start']
    page = scan_page(table, kind, start, state['after'])
    if page.following is not None and start and page.following == dict(start):
        raise RuntimeError('a Scan answered with the key it started from')
    report.scanned += page.scanned
    report.malformed += page.malformed
    for found in page.ids:
        report.found[kind] += 1
        written = _put_if_absent(table, _registry_row(kind, found, page.rows[found], now()), apply)
        (report.listed if written else report.already_listed)[kind] += 1
    state[f'{kind}_found'] += len(page.ids)
    state['after'] = page.last_pk or state['after']
    state['start'] = page.following
    if page.following is None:
        state['pass'] = PASSES[PASSES.index(kind) + 1] if kind != PASSES[-1] else DONE
        state['start'], state['after'] = None, None


def run(table: Any, *, apply: bool, resume: bool = False, max_pages: int | None = None,
        now: Callable[[], str] = lambda: datetime.now(UTC).isoformat(),
        clock: Callable[[], datetime] = lambda: datetime.now(UTC), deployed: Writers = list) -> Report:
    """Every pass (from the stopped walk's progress row with ``resume``), at most ``max_pages`` Scan pages (or
    ``MAX_PAGES``: past it the run fails); then, with ``apply``, the marker, if every writer was ready when the walk
    began (``writers_ready`` of ``deployed()``, judged both before a new applied walk starts and at its end, against
    when it began)."""
    report = Report()
    if apply and not resume:
        why = writers_ready(deployed(), clock())
        if why is not None:
            report.unmarked = why
            return report
    state = _start(table, apply, resume, clock(), now())
    pages = 0
    while state['pass'] != DONE:
        if max_pages is not None and pages >= max_pages:
            report.stopped = True
            return report
        if max_pages is None and pages >= MAX_PAGES:
            raise RuntimeError(f'the walk read more than {MAX_PAGES} Scan pages and stopped'
                               + ('; go on with --apply --resume' if apply
                                  else '; a dry run keeps no progress: run it again with --max-pages'))
        _walk_page(table, state, report, apply, now)
        pages += 1
        if apply:
            _save(table, state, now())
    if apply:
        _mark(table, state, report, now(), deployed)
    return report


def _mark(table: Any, state: dict[str, Any], report: Report, at: str, deployed: Writers) -> None:
    """The marker, if every writer ran the new release, drained, when the walk began (a writer updated since, a
    second deploy, voids the walk: its progress row goes, so only a new walk can earn the marker). The marker's put
    and the progress row's delete are one transaction, and the void's delete one request, each conditioned on the
    run id: a run another took over meanwhile writes nothing and stops."""
    writers = deployed()
    why = writers_ready(writers, datetime.fromisoformat(str(state['started_at'])))
    condition = {'ConditionExpression': 'run_id = :run', 'ExpressionAttributeValues': {':run': state['run_id']}}
    if why is not None:
        report.unmarked = why
        try:
            table.delete_item(Key=PROGRESS_KEY, **condition)
        except ClientError as error:
            if is_conditional_check_failure(error):
                raise SystemExit(_TAKEN_OVER) from error
            raise
        return
    release = '.'.join(str(part) for part in min(release_of(each.get('version')) or FIRST_RELEASE
                                                 for each in writers))
    marker = {**MARKER_KEY, 'completed_at': at, **{f'{kind}_found': state[f'{kind}_found'] for kind in PASSES},
              'release': release}
    try:
        # The resource's own client: it serializes the plain values as the table's calls do.
        table.meta.client.transact_write_items(TransactItems=[
            {'Put': {'TableName': table.name, 'Item': marker}},
            {'Delete': {'TableName': table.name, 'Key': dict(PROGRESS_KEY), **condition}},
        ])
    except ClientError as error:
        reasons = error.response.get('CancellationReasons') or []
        if any(reason.get('Code') == 'ConditionalCheckFailed' for reason in reasons):
            raise SystemExit(_TAKEN_OVER) from error
        raise
    report.marked = True


def unmark(table: Any) -> None:
    """Delete the marker and any progress row (before a rollback below 7.47.00: the erasures then Scan again)."""
    for key in (MARKER_KEY, PROGRESS_KEY):
        table.delete_item(Key=dict(key))


#: The core stack's output naming voc-projects (core-stack.ts).
TABLE_OUTPUT = 'ProjectsTableName'


def _positive(value: str) -> int:
    """``--max-pages``: a whole number of 1 or more (0 would stop before the first page)."""
    try:
        pages = int(value)
    except ValueError as error:
        raise argparse.ArgumentTypeError('--max-pages takes a whole number of 1 or more') from error
    if pages < 1:
        raise argparse.ArgumentTypeError('--max-pages takes a whole number of 1 or more')
    return pages


def parse_args(argv: list[str] | None) -> argparse.Namespace:
    """The command line: a dry run unless ``--apply``."""
    parser = argparse.ArgumentParser(description="List the deployment's review links, commented series and projects "
                                                 'made before 7.47.00.')
    parser.add_argument('--apply', action='store_true', help='write the missing registry rows (default: dry run)')
    parser.add_argument('--projects-table', default=os.environ.get('PROJECTS_TABLE'),
                        help=f'table name (default: PROJECTS_TABLE, else the stack output {TABLE_OUTPUT})')
    parser.add_argument('--stack', default='VocCoreStack', help='core stack holding that output')
    parser.add_argument('--api-stack', default='VocApiStack', help='the stack of the functions that write links')
    parser.add_argument('--region', help='AWS region (default: the configured one)')
    parser.add_argument('--max-pages', type=_positive, help='stop after this many Scan pages, 1 or more (go on with '
                                                            '--resume)')
    parser.add_argument('--resume', action='store_true', help='go on with the stopped applied walk')
    parser.add_argument('--unmark', action='store_true', help='delete the marker and any progress, then stop')
    return parser.parse_args(argv)


def table_name(args: argparse.Namespace, cloudformation: Any) -> str:
    """The flag or the environment, else the core stack's output; exits when none names the table."""
    if args.projects_table:
        return str(args.projects_table)
    stack = cloudformation.describe_stacks(StackName=args.stack)['Stacks'][0]
    name = next((o.get('OutputValue') for o in stack.get('Outputs', []) if o.get('OutputKey') == TABLE_OUTPUT), None)
    if not name:
        raise SystemExit(f'{args.stack} has no {TABLE_OUTPUT} output; pass --projects-table')
    return str(name)


def summary(report: Report, apply: bool) -> str:
    """The end of the run, in a few lines."""
    verb = 'listed' if apply else 'would list (dry run; --apply writes)'
    lines = [f'{report.scanned} rows scanned; {report.malformed} malformed rows left alone',
             *(f'{kind}: {report.found[kind]} found, {verb} {report.listed[kind]}, '
               f'{report.already_listed[kind]} already listed' for kind in PASSES)]
    if report.stopped:
        # A dry run keeps no progress, so it has nothing to resume.
        lines.append('stopped; go on with --apply --resume' if apply
                     else 'stopped after --max-pages; a dry run keeps no progress (run it without --max-pages)')
    elif report.marked:
        lines.append('done: the marker is written, so an erasure by email walks the registries by Query')
    elif report.unmarked:
        lines.append(f'the marker is not written: {report.unmarked}; wait for the drain (the longest writer\'s '
                     'Timeout plus 5 minutes) after the last deploy and run --apply again (a new walk)')
    return '\n'.join(lines)


def main(argv: list[str] | None = None) -> int:
    """Resolve the table, run (or unmark), print the summary."""
    options = parse_args(argv)
    import boto3  # deferred: the module imports, and its tests run, with no AWS configuration

    aws = boto3.session.Session(region_name=options.region)
    cloudformation = aws.client('cloudformation')
    projects = aws.resource('dynamodb').Table(table_name(options, cloudformation))
    if options.unmark:
        unmark(projects)
        print('the marker and any progress are deleted: erasures by email find the deployment\'s rows by Scan')
        return 0
    report = run(projects, apply=options.apply, resume=options.resume, max_pages=options.max_pages,
                 deployed=lambda: link_writers(cloudformation, aws.client('lambda'), options.api_stack))
    print(summary(report, options.apply))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
