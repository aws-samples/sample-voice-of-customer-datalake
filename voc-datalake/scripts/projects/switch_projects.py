"""Run the switch's upgrade check (docs/multi-workspace.md, the project plan's 3h; CHANGELOG 7.100.00, "Upgrade
notes"): before the deployment's projects may work in a workspace, check that the review registries can be trusted,
and with ``--apply`` record that they were (the switch row).

Run with the operator's own credentials, as scripts/projects/backfill_review_registries.py is, from the same code the
retention worker runs (jobs/retention/registries.py, the marker read and the gap step) and the backfill's judgement of
the writers. In this order, each refusal writing nothing and saying what to do next:

1. the backfill's marker, read strongly consistent: without a complete one, ``not_backfilled`` (reported before any
   other reason);
2. the switch row: current for that marker (shared/project_scope.py ``switch_row_current``), ``already_switched`` (a
   dry run too), and nothing more is read; complete but for an older marker, it is replaced below; malformed,
   ``switch_row_malformed``;
3. who runs the check (``sts:GetCallerIdentity``), recorded as the row's ``applied_by``, an assumed role's session
   name dropped since it may be a person's address (``applied_by``);
4. the writers of links, threads and projects (the API stack's projects API and its assist twin, read as the backfill
   reads them, ``link_writers``): exactly one of each, each on 7.48.0 or later, its last update ``Successful`` and
   drained (``writers_ready``), else ``writers_not_ready``;
5. the gap check, walked to its end: every live project on ``gsi1-by-type`` listed in ``PROJECT_IDS``, one index page
   (``ID_PAGE`` projects) and one strongly consistent BatchGetItem a step, at most ``MAX_STEPS`` steps (10 million
   live projects; past it ``too_many_steps``, never a switch unchecked); a gap is ``incomplete`` (the backfill's
   ``--unmark``, then its ``--apply``, then this check again);
6. the writers read again: any change since the first read (a deploy during the walk) is ``writers_not_ready``;
7. with ``--apply`` only, the one switch row (``switch_row``), in one transaction: a ConditionCheck that the marker is
   still the one read (its ``completed_at`` and ``release``, else ``marker_changed``) and a Put conditioned on the row
   being absent, or, replacing a stale row, on its ``marker_at``. A lost race reads the row again and judges it.

What a passed check proves, and what it does not: docs/deployment.md ("The switch's upgrade check").

DRY RUN BY DEFAULT. Exit status: 0 when the check passed (or the projects had switched already), 1 when it refused, 2 on
any AWS error (a permission, a throttle, an expired session), printed with its code. The credentials needed:
docs/deployment.md.

Usage (from voc-datalake/):
    .venv/bin/python scripts/projects/switch_projects.py [--stack VocCoreStack] [--api-stack VocApiStack]
    .venv/bin/python scripts/projects/switch_projects.py --projects-table NAME --apply
"""
from __future__ import annotations

import argparse
import os
import re
import sys
from collections.abc import Callable, Generator, Mapping
from contextlib import contextmanager
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

# This folder, for the backfill's table and writer reads; importing the backfill puts `lambda/` on the path too, so
# the keys, the marker's rule and the gap step are the ones the stores and the worker use.
sys.path.insert(0, str(Path(__file__).resolve().parent))

import backfill_review_registries as backfill
from botocore.exceptions import BotoCoreError, ClientError

from jobs.retention import registries
from shared.project_keys import DEPLOYMENT_PROJECT_REGISTRY_PK, REVIEW_REGISTRIES_MARKER_KEY
from shared.project_scope import (
    MARKER_AT,
    SWITCH_KEY,
    switch_row,
    switch_row_complete,
    switch_row_current,
)
from shared.project_walk import ID_PAGE
from shared.retention import MALFORMED_ID_COUNTER
from shared.review_registries import MARKER_RELEASE, MARKER_TIME, marker_complete

#: At most this many steps of ``ID_PAGE`` live projects (10 million): an operator's run has no Lambda ceiling, but a
#: walk that never ends must stop, refusing.
MAX_STEPS = 100_000

PASSED, SWITCHED, ALREADY_SWITCHED, REFUSED, ERROR = 'passed', 'switched', 'already_switched', 'refused', 'error'
NOT_BACKFILLED = registries.REGISTRIES_NOT_BACKFILLED
INCOMPLETE = registries.REGISTRIES_INCOMPLETE
SWITCH_ROW_MALFORMED = 'switch_row_malformed'
WRITERS_NOT_READY = 'writers_not_ready'
TOO_MANY_STEPS = 'too_many_steps'
MARKER_CHANGED = 'marker_changed'
SWITCH_ROW_CHANGED = 'switch_row_changed'
_BACKFILL = 'scripts/projects/backfill_review_registries.py'
_AGAIN = 'then run scripts/projects/switch_projects.py again'
NEXT_STEPS = {
    NOT_BACKFILLED: f'the review registries are not backfilled (no complete marker): run {_BACKFILL} --apply, {_AGAIN}',
    INCOMPLETE: f'a live project is missing from the project registry: run {_BACKFILL} --unmark, then {_BACKFILL} '
                f'--apply, {_AGAIN}',
    SWITCH_ROW_MALFORMED: 'a switch row is there but does not say it all (voc-projects PROJECTS_SWITCH / '
                          'MIGRATION#projects-switch): delete it, then run the check again; nothing was written',
    TOO_MANY_STEPS: f'the gap check reached {MAX_STEPS:,} steps ({MAX_STEPS * ID_PAGE:,} live projects) before its '
                    'end, so the switch is refused rather than made unchecked and nothing was written',
    MARKER_CHANGED: 'the marker changed during the check (a backfill, an --unmark or a reset), so nothing was '
                    'written: run the check again',
    SWITCH_ROW_CHANGED: 'the switch row changed during the check (another writer removed it), so nothing was '
                        'written: run the check again',
}
_ERROR_NEXT = ('check the credentials and their permission on voc-projects, CloudFormation, Lambda and STS '
               '(docs/deployment.md), then run the check again: it answers already_switched if a write landed')
#: An assumed role's ARN: the account and role are kept, the session name (which may be a person's address) dropped.
_ASSUMED_ROLE = re.compile(r'^arn:(?P<partition>[^:]+):sts::(?P<account>\d{12}):assumed-role/(?P<role>[^/]+)/.+$')
#: A federated user's ARN: the account kept, the user's name (chosen by the caller, maybe an address) dropped.
_FEDERATED_USER = re.compile(r'^arn:(?P<partition>[^:]+):sts::(?P<account>\d{12}):federated-user/.+$')
_IAM_USER = re.compile(r'^arn:(?P<partition>[^:]+):iam::(?P<account>\d{12}):user/.+$')


def _utc_now() -> datetime:
    return datetime.now(UTC)


def applied_by(caller_arn: str) -> str:
    """Who applied the check, as the row records it: an assumed role as ``arn:<partition>:iam::<account>:role/<role>``
    (its session name dropped, and any path the role has, which the caller's ARN does not carry); a federated user as
    ``arn:<partition>:sts::<account>:federated-user`` (its name, caller-chosen, dropped); an IAM user as
    ``arn:<partition>:iam::<account>:user`` (its name, which may be a person's, dropped: the row is kept for good and no
    erasure reaches it); any other ARN (the account's root) as it is."""
    match = _ASSUMED_ROLE.match(caller_arn)
    if match is not None:
        return f"arn:{match['partition']}:iam::{match['account']}:role/{match['role']}"
    federated = _FEDERATED_USER.match(caller_arn)
    if federated is not None:
        return f"arn:{federated['partition']}:sts::{federated['account']}:federated-user"
    user = _IAM_USER.match(caller_arn)
    if user is not None:
        return f"arn:{user['partition']}:iam::{user['account']}:user"
    return caller_arn


def _error_code(error: BaseException) -> str:
    """An AWS error's code, or a failure's name without a leading underscore (registries.py's private
    ``_RegistryUnreadable`` is ``RegistryUnreadable``)."""
    if isinstance(error, ClientError):
        return str(error.response.get('Error', {}).get('Code') or 'ClientError')
    return type(error).__name__.lstrip('_')


def _outcome(status: str, counts: Mapping[str, int], *, reason: str | None = None, next_steps: str = '',
             written: bool = False, **more: Any) -> dict[str, Any]:
    return {'status': status, 'reason': reason, 'next_steps': next_steps or NEXT_STEPS.get(reason or '', ''),
            'written': written, 'steps': counts.get('steps', 0), 'projects_checked': counts.get('listed', 0),
            MALFORMED_ID_COUNTER: counts.get(MALFORMED_ID_COUNTER, 0), **more}


def _read(table: Any, key: Mapping[str, str]) -> dict[str, Any] | None:
    item = table.get_item(Key=dict(key), ConsistentRead=True).get('Item')
    return dict(item) if isinstance(item, Mapping) else None


@contextmanager
def _counting_listed(table: Any, counts: dict[str, int]) -> Generator[None]:
    """Count the ``PROJECT_IDS`` rows the walk's BatchGetItems answer (each live project looked up and found once)."""
    def counted(parsed: Mapping[str, Any] | None = None, **_kwargs: Any) -> None:
        for row in ((parsed or {}).get('Responses') or {}).get(table.name) or []:
            pk = row.get('pk')
            counts['listed'] += (pk.get('S') if isinstance(pk, Mapping) else pk) == DEPLOYMENT_PROJECT_REGISTRY_PK

    events = table.meta.client.meta.events
    events.register('after-call.dynamodb.BatchGetItem', counted)
    try:
        yield
    finally:
        events.unregister('after-call.dynamodb.BatchGetItem', counted)


def _walk(table: Any, counts: dict[str, int], max_steps: int) -> str | None:
    """The gap check to its end (registries.py ``step``), at most ``max_steps`` steps, counted in ``counts`` as they
    run: the refusal, or None when every live project is listed."""
    run: dict[str, Any] = {}
    cursor: dict[str, Any] | None = None
    try:
        with _counting_listed(table, counts):
            for _ in range(max_steps):
                cursor = registries.step(table, run, cursor)
                counts['steps'] += 1
                if cursor is None:
                    result = run.get(registries.RESULT)
                    return None if result == registries.REGISTRIES_COMPLETE else (
                        INCOMPLETE if result == registries.REGISTRIES_INCOMPLETE else NOT_BACKFILLED)
            return TOO_MANY_STEPS
    finally:
        counts[MALFORMED_ID_COUNTER] = int(run.get(MALFORMED_ID_COUNTER) or 0)


def _write(table: Any, row: dict[str, Any], marker: Mapping[str, Any], stale: Mapping[str, Any] | None) -> str | None:
    """The row, in one transaction with a ConditionCheck of the marker as read, put if absent or, replacing ``stale``,
    while it still names its marker: None when written, ``MARKER_CHANGED``, or the row's put lost a race (``RACE``)."""
    put = ({'ConditionExpression': '#marker_at = :old', 'ExpressionAttributeNames': {'#marker_at': MARKER_AT},
            'ExpressionAttributeValues': {':old': stale[MARKER_AT]}} if stale is not None
           else {'ConditionExpression': 'attribute_not_exists(pk)'})
    try:
        # The resource's own client: it serializes the plain values as the table's calls do.
        table.meta.client.transact_write_items(TransactItems=[
            {'ConditionCheck': {'TableName': table.name, 'Key': dict(REVIEW_REGISTRIES_MARKER_KEY),
                                'ConditionExpression': '#at = :at AND #release = :release',
                                'ExpressionAttributeNames': {'#at': MARKER_TIME, '#release': MARKER_RELEASE},
                                'ExpressionAttributeValues': {':at': marker[MARKER_TIME],
                                                              ':release': marker[MARKER_RELEASE]}}},
            {'Put': {'TableName': table.name, 'Item': row, **put}},
        ])
    except ClientError as error:
        codes = [reason.get('Code') for reason in error.response.get('CancellationReasons') or []]
        if len(codes) == 2 and codes[0] == 'ConditionalCheckFailed':
            return MARKER_CHANGED
        if len(codes) == 2 and codes[1] == 'ConditionalCheckFailed':
            return _RACE
        raise
    return None


_RACE = 'race'


def _writers_ready(deployed: backfill.Writers, clock: Callable[[], datetime],
                   first: list[dict[str, Any]] | None = None) -> tuple[list[dict[str, Any]], str | None]:
    """The writers and why they are not ready (None when they are); with ``first``, also any change since it."""
    writers = deployed()
    why = backfill.writers_ready(writers, clock())
    if why is None and first is not None and _fingerprint(writers) != _fingerprint(first):
        why = 'the writers changed during the check (a deploy)'
    return writers, why


def _fingerprint(writers: list[dict[str, Any]]) -> list[tuple[str, ...]]:
    return sorted(tuple(str(each.get(name)) for name in ('name', 'version', 'status', 'last_modified'))
                  for each in writers)


def _before_walk(table: Any, counts: dict[str, int], deployed: backfill.Writers, clock: Callable[[], datetime]
                 ) -> tuple[dict[str, Any], dict[str, Any] | None, list[dict[str, Any]], dict[str, Any] | None]:
    """The marker (first), the switch row, then the writers: (the marker, a stale row to replace, the writers, the
    outcome that ends the check before its walk, or None)."""
    marker = _read(table, REVIEW_REGISTRIES_MARKER_KEY) or {}
    if not marker_complete(marker):
        return marker, None, [], _outcome(REFUSED, counts, reason=NOT_BACKFILLED)
    existing = _read(table, SWITCH_KEY)
    if existing is not None and not switch_row_complete(existing):
        return marker, None, [], _outcome(REFUSED, counts, reason=SWITCH_ROW_MALFORMED)
    if switch_row_current(existing, marker):
        return marker, None, [], _outcome(ALREADY_SWITCHED, counts, next_steps='the projects have switched already, '
                                          'for this marker: nothing was read further or written')
    writers, why = _writers_ready(deployed, clock)
    if why is not None:
        return marker, None, writers, _outcome(REFUSED, counts, reason=WRITERS_NOT_READY,
                                               next_steps=f'{why}; nothing was written: deploy or wait, then run the '
                                                          'check again')
    return marker, existing, writers, None


def _after_race(table: Any, marker: Mapping[str, Any], counts: dict[str, int]) -> dict[str, Any]:
    """The row's put lost a race (another writer put or removed the row first): judge what it left."""
    row = _read(table, SWITCH_KEY)
    if row is None:
        return _outcome(REFUSED, counts, reason=SWITCH_ROW_CHANGED)
    if switch_row_current(row, marker):
        return _outcome(ALREADY_SWITCHED, counts, next_steps='another check wrote the switch row meanwhile')
    # A complete row for another marker is a concurrent change, not a malformed row: run the check again.
    return _outcome(REFUSED, counts, reason=SWITCH_ROW_CHANGED if switch_row_complete(row) else SWITCH_ROW_MALFORMED)


def run_check(table: Any, *, apply: bool, deployed: backfill.Writers, identity: Callable[[], str],
              now: Callable[[], str] | None = None, clock: Callable[[], datetime] = _utc_now,
              max_steps: int = MAX_STEPS) -> dict[str, Any]:
    """The check (the module docstring): its outcome, as ``summary`` prints it. ``identity`` answers the caller's ARN
    (``sts:GetCallerIdentity``)."""
    counts = {'steps': 0, 'listed': 0, MALFORMED_ID_COUNTER: 0}
    try:
        marker, stale, first, early = _before_walk(table, counts, deployed, clock)
        if early is not None:
            return early
        who = applied_by(identity())
        refusal = _walk(table, counts, max_steps)
        if refusal is not None:
            return _outcome(REFUSED, counts, reason=refusal)
        writers, why = _writers_ready(deployed, clock, first)
        if why is not None:
            return _outcome(REFUSED, counts, reason=WRITERS_NOT_READY,
                            next_steps=f'{why}; nothing was written: run the check again')
        # The earlier check's record a replacement overwrites, printed first (follow-up 3h-S0-history keeps it).
        replaces = ({name: stale.get(name) for name in ('switched_at', 'release', 'applied_by')}
                    if stale is not None else None)
        if not apply:
            return _outcome(PASSED, counts, applied_by=who, replaces=replaces, next_steps='the check passed and '
                            'nothing was written: run it with --apply to write the switch row')
        row = switch_row((now or (lambda: clock().isoformat()))(), backfill.oldest_release(writers),
                         counts['listed'], counts['steps'], str(marker[MARKER_TIME]), who)
        written = _write(table, row, marker, stale)
        if written == _RACE:
            return _after_race(table, marker, counts)
    except (ClientError, BotoCoreError, RuntimeError, ValueError) as error:
        return _outcome(ERROR, counts, error_code=_error_code(error), next_steps=_ERROR_NEXT)
    if written == MARKER_CHANGED:
        return _outcome(REFUSED, counts, reason=MARKER_CHANGED)
    return _outcome(SWITCHED, counts, written=True, next_steps='the switch row is written',
                    switched_at=row['switched_at'], release=row['release'], applied_by=who, replaces=replaces)


def summary(outcome: Mapping[str, Any]) -> str:
    """What the check found and what to do next, in a few lines."""
    lines = [str(outcome.get('status')) + (f" ({outcome['reason']})" if outcome.get('reason') else ''),
             (f"{outcome.get('steps', 0)} steps; {outcome.get('projects_checked', 0)} live projects looked up in the "
              f"project registry; {outcome.get(MALFORMED_ID_COUNTER, 0)} malformed rows skipped")]
    replaces = outcome.get('replaces')
    if isinstance(replaces, Mapping):
        verb = 'replaced' if outcome.get('status') == SWITCHED else 'would replace (with --apply)'
        lines.append(f"{verb} the earlier check's row for an older marker: switched at {replaces.get('switched_at')}, "
                     f"writers on {replaces.get('release')}, applied by {replaces.get('applied_by')}")
    if outcome.get('status') == SWITCHED:
        lines.append(f"switch row written at {outcome.get('switched_at')}, writers on {outcome.get('release')}")
    if outcome.get('applied_by'):
        lines.append(f"applied by {outcome['applied_by']}")
    if outcome.get('error_code'):
        lines.append(f"AWS error: {outcome['error_code']}")
    if outcome.get('next_steps'):
        lines.append(str(outcome['next_steps']))
    return '\n'.join(lines)


def exit_code(outcome: Mapping[str, Any]) -> int:
    """0 passed or already switched, 1 refused, 2 an AWS error."""
    status = outcome.get('status')
    return 0 if status in (PASSED, SWITCHED, ALREADY_SWITCHED) else 2 if status == ERROR else 1


def parse_args(argv: list[str] | None) -> argparse.Namespace:
    """A dry run unless ``--apply``; the table and the writers found as the backfill finds them."""
    parser = argparse.ArgumentParser(description="Run the switch's upgrade check (a dry run unless --apply).")
    parser.add_argument('--apply', action='store_true', help='write the switch row when the check passes')
    for flag, default, text in (
            ('--projects-table', os.environ.get('PROJECTS_TABLE'),
             f'table name (default: PROJECTS_TABLE, else the stack output {backfill.TABLE_OUTPUT})'),
            ('--stack', 'VocCoreStack', 'core stack holding that output'),
            ('--api-stack', 'VocApiStack', 'the stack of the functions that write links, threads and projects'),
            ('--region', None, 'AWS region (default: the configured one)')):
        parser.add_argument(flag, default=default, help=text)
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    """Resolve the table, run the check, print the outcome; an AWS error, or no table, exits 2, named."""
    options = parse_args(argv)
    import boto3  # deferred: the module imports, and its tests run, with no AWS configuration

    try:
        aws = boto3.session.Session(region_name=options.region)
        cloudformation = aws.client('cloudformation')
        table = aws.resource('dynamodb').Table(backfill.table_name(options, cloudformation))
    except (ClientError, BotoCoreError) as error:
        print(f'AWS error: {_error_code(error)}; {_ERROR_NEXT}', file=sys.stderr)
        return 2
    except SystemExit as stop:  # the backfill's table_name: the stack names no table
        print(str(stop.code), file=sys.stderr)
        return 2
    outcome = run_check(table, apply=options.apply, clock=_utc_now,
                        identity=lambda: str(aws.client('sts').get_caller_identity()['Arn']),
                        deployed=lambda: backfill.link_writers(cloudformation, aws.client('lambda'),
                                                               options.api_stack))
    print(summary(outcome))
    return exit_code(outcome)


if __name__ == '__main__':
    raise SystemExit(main())
