"""The submitted patch for the roles that judge it without running code, and a reviewer's verdict (7.54.00).

The first live engineering run's commit reviewer was handed a fixer's patch key in its task's text. ``read_file`` reads
the checkout, and the patch is a workspace object, so it was refused; the reviewer read the unchanged files, wrote no
finding and finished, and the board's ``review.no_blocking`` passed on its zero findings
(01M7QXJN02WSFMG92VWWZ00NKB, 2026-11-18). So:

- ``read_patch`` (the commit reviewer, the PR reviewer, the final go: ``outputs.PATCH_READERS``): the submitted patch
  the task names (``TaskBrief.patch``: a fixer's or builder's ``submit_work`` of this run at its commit, the broker's
  own rule), read through the agent's own role (its run's keys) and answered as data, in pages of at most
  ``PAGE_CHARS`` characters cut at line ends, the first with the files it changes. A task that names none, a key that
  is no submitted patch of the run, or an object that cannot be read is a refusal that says so.
- the reviewers' checkout (``show_submitted_patch``, at the session's start): the same patch applied to it, working
  tree and index, by the harness's own git, so ``read_file`` shows each changed file as the patch leaves it. A patch
  that does not apply is told to the model (git's words, as data), never a crash: the diff is still readable. The
  final go's checkout has it already (``role_tools.judge_submitted_patch``: the gate's tree).
- ``write_review`` (the reviewers: ``outputs.REVIEW_ROLES``): a ``voc-review/1`` record under the agent's own keys,
  built by the harness: its verdict (``approve``, ``request_changes`` or ``could_not_review``) and its reasons. An
  approval or a request for changes only once this session read every page of the task's patch (a commit reviewer's
  task must name one), a request for changes only with a blocking finding written, an approval with none.
  ``could_not_review`` is always taken, and is never a pass: its finish sends the task to a person (``ending``), and a
  board's ``review.no_blocking`` fails on it, or on a reviewer that recorded no review at all.

The reviewer gets both: the diff (``read_patch``) and the changed files in context (``read_file`` on the checkout the
patch was applied to). A tool, and not only the apply, because a large patch must be paged (a model's input is
bounded) and a patch that does not apply must still be readable; the apply beside it, because a hunk's three lines of
context are not the file.

``ending`` is also where a gate runner's STOPPED record (its setup failed, it checked nothing) sends its task to a
person: a stopped gate says nothing about the code, so it is never a reason to revise the fix. Since 7.71.02 it also
sends a writer's task to a person when the broker made no write for it: the first live Bug fixer run's committer and
PR author read the broker and finished, their tasks done with nothing pushed and no pull request opened
(01M83JQWMKAYK9GJB8FBAVZV7E, 2026-11-23).
"""
from __future__ import annotations

import json
import os
from collections.abc import Callable, Mapping
from typing import Any, Final

from engineering.runtime.checkout import repo_git
from engineering.runtime.checkpoints import artifact_prefix
from engineering.runtime.harness.coordinator import REVIEWS_A_PATCH, Built, Record, Tool, listed
from engineering.runtime.outputs import (
    APPROVE,
    COULD_NOT_REVIEW,
    FINDING_SCHEMA,
    GATE_RECORD_FILE,
    MAX_REVIEW_REASON,
    MAX_REVIEW_REASONS,
    MAX_SUBMITTED_PATCH_BYTES,
    PATCH_READERS,
    REQUEST_CHANGES,
    REVIEW_FILE,
    REVIEW_ROLES,
    REVIEW_SCHEMA,
    REVIEW_VERDICTS,
    is_submitted_patch,
    review_verdict,
)

#: The patch text one page holds at most (about 10 000 tokens: a reviewer's input is bounded, 120 000 tokens).
PAGE_CHARS: Final = 40_000
#: The changed files the first page lists at most.
MAX_LISTED_FILES: Final = 200
#: What git said of a patch that did not apply, at most (its end).
MAX_UNAPPLIED: Final = 1_500
#: An own findings shard or record read back at most (a shard is at most 200 lines of 8 KB).
MAX_OWN_BYTES: Final = 2 * 1024 * 1024
#: The roles ``read_patch`` and ``write_review`` are for (role_tools ``ROLE_TOOLS``).
TOOL_ROLES: Final[Mapping[str, frozenset[str]]] = {'read_patch': PATCH_READERS, 'write_review': REVIEW_ROLES}
NO_PATCH: Final = ("your task names no submitted patch, so there is no change to read: write_review could_not_review, "
                   'saying so (a commit reviewer\'s task names the fixer\'s or builder\'s patch)')


def pages(text: str, size: int = PAGE_CHARS) -> list[str]:
    """``text`` in pages of at most ``size`` characters, cut at line ends (a longer line is cut into pages of its
    own); one empty page for no text."""
    found: list[str] = []
    current = ''
    for whole in text.splitlines(keepends=True):
        line = whole
        while len(line) > size:
            if current:
                found.append(current)
                current = ''
            found.append(line[:size])
            line = line[size:]
        if len(current) + len(line) > size:
            found.append(current)
            current = ''
        current += line
    if current or not found:
        found.append(current)
    return found


def changed_files(text: str) -> list[str]:
    """Each file a unified git diff changes, with its added and removed lines (``path (+a -b)``; a rename as
    ``old -> new``, a new, deleted or binary file said so), in the diff's order."""
    files: list[list[Any]] = []
    for line in text.splitlines():
        if line.startswith('diff --git '):
            old, _, new = line.removeprefix('diff --git ').partition(' b/')
            old = old.removeprefix('a/')
            files.append([new if old == new else f'{old} -> {new}', 0, 0, ''])
        elif not files:
            continue
        elif line.startswith('new file mode'):
            files[-1][3] = ', new'
        elif line.startswith('deleted file mode'):
            files[-1][3] = ', deleted'
        elif line.startswith(('GIT binary patch', 'Binary files ')):
            files[-1][3] = ', binary'
        elif line.startswith('+') and not line.startswith('+++ '):
            files[-1][1] += 1
        elif line.startswith('-') and not line.startswith('--- '):
            files[-1][2] += 1
    return [f'{path} (+{added} -{removed}{what})' for path, added, removed, what in files]


def _error_code(error: Exception) -> str:
    """An S3 error's code (``NoSuchKey``, ``AccessDenied``), else the exception's type."""
    response = getattr(error, 'response', None)
    code = response.get('Error', {}).get('Code') if isinstance(response, Mapping) else None
    return str(code) if code else type(error).__name__


def task_patch(context: Built) -> str:
    """The submitted patch the task names, its key checked by the broker's rule (a fixer's or builder's submission of
    this run at its commit); ``ValueError`` naming what is wrong."""
    key = context.brief.patch
    if not key:
        raise ValueError(NO_PATCH)
    if not is_submitted_patch(key, context.run_id, context.commit):
        raise ValueError(f'the task\'s patch {key[:300]!r} is not a patch a fixer or builder of this run submitted at '
                         'its commit: there is no change to read (write_review could_not_review, saying so)')
    return key


def patch_body(context: Built, key: str) -> bytes:
    """The submitted patch, read through the agent's own role; ``ValueError`` when it cannot be read, is empty or is
    over the broker's size."""
    name = key.rsplit('/', 1)[-1]
    try:
        body = context.store.get(key, MAX_SUBMITTED_PATCH_BYTES)
    except Exception as error:   # (an object that cannot be read is a refusal the model reads, its code said)
        raise ValueError(f'the submitted patch {name} could not be read ({_error_code(error)}): write_review '
                         'could_not_review, saying so') from error
    if len(body) > MAX_SUBMITTED_PATCH_BYTES:
        raise ValueError(f'the submitted patch {name} is over {MAX_SUBMITTED_PATCH_BYTES // (1024 * 1024)} MB: the '
                         'broker would not push it either')
    if not body.strip():
        raise ValueError(f'the submitted patch {name} is empty: there is no change to review')
    return body


def harness_git(context: Built, *argv: str) -> Mapping[str, Any]:
    """The harness's own git on the checkout (never repository code)."""
    return context.runner.run(repo_git(*argv), timeout_seconds=600, repository_code=False, in_checkout=False)


def show_submitted_patch(context: Built) -> None:
    """A reviewer's checkout with the submitted patch its task names applied (working tree and index, by the
    harness's own git), so ``read_file`` shows each changed file as the patch leaves it. Never raising: a task that
    names none leaves the checkout as it is, and a patch that cannot be read or does not apply leaves it too, with why
    (``AgentContext.patch_unapplied``), which the opening tells the model."""
    if context.role not in REVIEW_ROLES or not context.brief.patch:
        return
    try:
        key = task_patch(context)
        body = patch_body(context, key)
    except ValueError as refused:
        context.patch_unapplied = str(refused)[:MAX_UNAPPLIED]
        return
    os.makedirs(context.patch_dir, mode=0o700, exist_ok=True)
    local = os.path.join(context.patch_dir, 'reviewed.diff')
    with open(local, 'wb') as stream:
        stream.write(body)
    # (the index's file times first, as the gate's apply does: the checkout opened its files to the group after git
    # wrote them, and ``apply --index`` takes a file whose times changed for one that changed)
    harness_git(context, 'update-index', '-q', '--refresh')
    applied = harness_git(context, 'apply', '--index', '--binary', local)
    if applied.get('exit_code') != 0:
        context.patch_unapplied = (f'git apply exited {applied.get("exit_code")}: '
                                   f'{str(applied.get("stderr_tail", "")).strip()[-MAX_UNAPPLIED:]}')
        return
    context.progress(f'reviewing {key.rsplit("/", 1)[-1]}: applied to the checkout')


def opening_parts(context: Built) -> list[str]:
    """What a patch reader's opening says of the submitted patch its task names ('' parts for another role)."""
    if context.role not in PATCH_READERS:
        return []
    key = context.brief.patch
    if not key:
        return ['', ('Your task names no submitted patch: there is no change to read. Say so with write_review '
                     'could_not_review, then finish.')] if context.role == REVIEWS_A_PATCH else []
    name = key.rsplit('/', 1)[-1]
    parts = ['', (f'Your task names the submitted patch {name}. Read it with read_patch, page 1 first and every page '
                  'before your verdict.')]
    if context.role not in REVIEW_ROLES:
        return parts   # (the final go's checkout is the gate's tree: the harness applied it, its skill says so)
    if context.patch_unapplied:
        parts += [('It could not be put on your checkout, so read_file shows the files as they were before the '
                   'change: review the patch itself. Why:'), context.data('patch_unapplied', context.patch_unapplied)]
    else:
        parts.append('It is applied to your checkout: read_file shows each changed file as the patch leaves it.')
    return parts


def blocking_written(context: Built) -> int:
    """The blocking findings this task's sessions wrote (its own findings shards, read back from its outputs)."""
    count = 0
    for key in context.result_keys:
        if not key.endswith('.jsonl'):
            continue
        for line in context.store.get(key, MAX_OWN_BYTES).decode('utf-8', 'replace').splitlines():
            try:
                row = json.loads(line)
            except ValueError:
                continue
            count += isinstance(row, dict) and row.get('schema') == FINDING_SCHEMA and row.get('severity') == 'blocking'
    return count


def own_record(context: Built, kind: str, name: str) -> dict[str, Any] | None:
    """The session's own record of ``kind`` (``<kind>/attempt-<n>/<name>``) among the outputs its task recorded, read
    back; None for none (or one that does not parse)."""
    if not context.commit:
        return None
    key = f'{artifact_prefix(context.run_id, context.agent_id, context.commit, context.attempt, kind)}{name}'
    if key not in context.result_keys:
        return None
    try:
        record = json.loads(context.store.get(key, MAX_OWN_BYTES))
    except ValueError:
        return None
    return record if isinstance(record, dict) else None


def _unread(context: Built) -> str:
    """What of the task's patch this session has not read ('' once every page was)."""
    if not context.patch_pages:
        return 'read it with read_patch'
    missing = sorted(set(range(1, context.patch_pages + 1)) - context.patch_pages_read)
    return f'pages {", ".join(map(str, missing[:10]))} of {context.patch_pages} are unread' if missing else ''


def _judged(context: Built, verdict: str) -> int:
    """An approval's or a request for changes' conditions (``ValueError`` naming the one that fails); the blocking
    findings written."""
    if context.brief.patch:
        unread = _unread(context)
        if unread:
            raise ValueError(f'{verdict} is for a change you read: {unread} (read_patch). A review that did not read the '
                             'change is no review: if you cannot read it, write could_not_review')
    elif context.role == REVIEWS_A_PATCH:
        raise ValueError(NO_PATCH)
    blocking = blocking_written(context)
    if verdict == APPROVE and blocking:
        raise ValueError(f'you wrote {blocking} blocking finding(s): the change must not go on as it is, so that is '
                         'request_changes, not approve')
    if verdict == REQUEST_CHANGES and not blocking:
        raise ValueError('a request for changes names what must change: write it as a blocking finding '
                         '(write_findings) first, or approve')
    return blocking


def review_record(context: Built, arguments: Mapping[str, Any]) -> bytes:
    """The reviewer's ``voc-review/1`` record, built by the harness: the verdict and reasons the model gives, the
    patch its task names and what of it this session read, and the blocking findings its task wrote."""
    verdict = arguments.get('verdict')
    if verdict not in REVIEW_VERDICTS:
        raise ValueError(f'the verdict is one of {", ".join(REVIEW_VERDICTS)}')
    reasons = listed(arguments, 'reasons', MAX_REVIEW_REASONS, str, 'reasons, each text')
    if not all(0 < len(reason.strip()) <= MAX_REVIEW_REASON for reason in reasons):
        raise ValueError(f'a reason is text of 1-{MAX_REVIEW_REASON} characters')
    blocking = blocking_written(context) if verdict == COULD_NOT_REVIEW else _judged(context, verdict)
    patch = context.brief.patch if is_submitted_patch(context.brief.patch, context.run_id, context.commit) else ''
    return json.dumps({'schema': REVIEW_SCHEMA, 'verdict': verdict, 'reasons': [reason.strip() for reason in reasons],
                       'patch': patch, 'pages': context.patch_pages, 'pages_read': sorted(context.patch_pages_read),
                       'applied': bool(patch) and not context.patch_unapplied, 'blocking': blocking},
                      sort_keys=True).encode()


#: (7.71.02) Each writer's one write, and what its finish without it says: the broker answered none as made.
WRITERS: Final[Mapping[str, tuple[str, str]]] = {
    'committer': ('push_commit', 'finished without pushing: the broker made no push of the submitted patch'),
    'pr-author': ('open_draft_pr', 'finished without opening the pull request: the broker opened none'),
}


def ending(context: Built) -> tuple[str, str]:
    """Where a session's ``finish`` moves its task: ``('done', '')``, or ``('needs_human', why)`` when its own record
    says it could not do its job: a reviewer's ``could_not_review`` (7.54.00), a gate runner's STOPPED (its setup
    failed, it checked nothing: never a reason to revise the code), and (7.71.02) a committer or PR author whose one
    write the broker never answered as made (``AgentContext.host_writes``: refused, never asked, or its outcome
    unknown). ``ValueError`` for a reviewer that recorded no review: its finish waits for one."""
    write = WRITERS.get(context.role)
    if write is not None and write[0] not in context.host_writes:
        return 'needs_human', write[1]
    if context.role in REVIEW_ROLES:
        verdict, reason = review_verdict(own_record(context, 'review', REVIEW_FILE))
        if not verdict:
            raise ValueError('write your review first (write_review: approve, request_changes, or could_not_review '
                             'when you could not read or judge the change), then finish')
        if verdict == COULD_NOT_REVIEW:
            return 'needs_human', f'could not review the change ({reason or "no reason given"})'
    if context.role == 'gate-runner':
        record = own_record(context, 'gate', GATE_RECORD_FILE)
        if record is not None and record.get('verdict') == 'STOPPED':
            return 'needs_human', f'the gate stopped ({record.get("stop_reason") or "no reason"}), so it judged no code'
    return 'done', ''


def specs(tool_spec: Callable[..., Built], role: str) -> tuple[Built, ...]:
    """The tools of this module ``role`` may have."""
    all_specs = (
        tool_spec('read_patch', 'Read the submitted patch your task names (data): one page of its diff, the first '
                  'with the files it changes. Read every page before your verdict.',
                  {'page': {'type': 'integer', 'description': 'The page, from 1 (the first when left out).'}}),
        tool_spec('write_review', 'Write your review\'s verdict, once: approve (no blocking finding), request_changes '
                  '(your blocking findings say what must change) or could_not_review (you could not read or judge the '
                  'change: your task then goes to a person). Approve and request_changes only once you read every '
                  'page of the patch.',
                  {'verdict': {'type': 'string', 'enum': list(REVIEW_VERDICTS)},
                   'reasons': {'type': 'array', 'items': {'type': 'string'},
                               'description': f'Why, 1-{MAX_REVIEW_REASONS} short reasons.'}},
                  ('verdict', 'reasons')),
    )
    return tuple(spec for spec in all_specs if role in TOOL_ROLES[spec.name])


def handlers(context: Built, result: Callable[..., Built], record: Record) -> dict[str, Tool]:
    def read_patch(arguments: Mapping[str, Any]) -> Built:
        key = task_patch(context)
        text = patch_body(context, key).decode('utf-8', 'replace')
        split = pages(text)
        page = arguments.get('page', 1)
        if type(page) is not int or not 1 <= page <= len(split):
            raise ValueError(f'page is a whole number from 1 to {len(split)}')
        context.patch_pages = len(split)
        context.patch_pages_read.add(page)
        name = key.rsplit('/', 1)[-1]
        parts = [f'The submitted patch {name}: page {page} of {len(split)}.']
        if page == 1:
            files = changed_files(text)
            listed_files = files[:MAX_LISTED_FILES] + ([f'... and {len(files) - MAX_LISTED_FILES} more']
                                                       if len(files) > MAX_LISTED_FILES else [])
            parts.append(context.data(f'patch-files:{name}', '\n'.join(listed_files) or '(no file header)'))
        parts.append(context.data(f'patch:{name}:{page}', split[page - 1]))
        parts.append('(the last page)' if page == len(split) else f'(read_patch with page {page + 1} for the next)')
        return result('\n'.join(parts))

    def write_review(arguments: Mapping[str, Any]) -> Built:
        body = review_record(context, arguments)
        key = (f'{artifact_prefix(context.run_id, context.agent_id, context.commit, context.attempt, "review")}'
               f'{REVIEW_FILE}')
        return record(key, body, f'the review ({arguments["verdict"]})')

    return {'read_patch': read_patch, 'write_review': write_review}
