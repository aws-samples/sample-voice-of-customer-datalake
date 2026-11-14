"""The launchable roles' own tools, beyond the checkout's and the code's: their outputs, a sub-task, the broker's writes.

Each tool is for the roles whose job needs it (``ROLE_TOOLS``) and no other: ``tools.ToolBox`` offers a role only
these and the tools its skill names, whatever a record says.

- ``write_findings`` (the hunter, the commit reviewer, the PR reviewer): a ``voc-finding/1`` shard,
  ``<shard>.jsonl`` under the agent's own keys for the package
  (``ws/<ws>/runs/<run>/<agent>/commits/<sha>/<package>/attempt-<n>/<shard>.jsonl``, workspace/layout.py);
- ``write_notes`` (the mapper): a ``voc-note/1`` shard, at the same place;
- ``write_gate_record`` (the gate runner, the final go): a ``voc-gate-record/1`` record, ``record.json`` under its
  ``_gate/attempt-<n>/`` (the final go's is the run's verdict: flow/ledger.py). Its tree is the one the harness
  hashed (``AgentContext.gate_tree``): the run's commit with the patch the task names applied, the tree every check
  ran on; the model never types it;
- ``post_subtask`` (the hunter, the builder): one task on the board, for the one role each posts for (the board's own
  rule, board/api.py ``POSTERS``: a hunter's fixes, a builder's sub-builds);
- ``push_commit`` (the committer), ``open_draft_pr`` (the PR author), ``post_comment`` (the PR reviewer): the broker's
  one write for each role (connectors/broker.py), which checks the run, the dial, the GO and the write rules first.

Every output is written once (the workspace's puts are create-only) and its key is recorded on the task when the agent
finishes (``AgentContext.result_keys``), so the steps after it read what the board recorded, never a listing. The
harness checks each line's shape so a model's slip is a result it reads; the readers check every line again
(workspace/findings.py, knowledge/notes.py, quality_gate/record.py), since what an agent writes is data.
"""
from __future__ import annotations

import fcntl
import json
import os
import re
from collections.abc import Callable, Mapping, Sequence
from typing import Any, Final

from engineering.runtime import outputs
from engineering.runtime.checkout import check_sparse_path, repo_git, share_working_tree
from engineering.runtime.checkpoints import SHA, agent_prefix, artifact_prefix, check_place
from engineering.runtime.harness.coordinator import Built, Tool, answered, bounded, listed, optional, post_for
from engineering.runtime.outputs import (
    AGENT_BRANCH_PREFIX,
    FINDING_FILE,
    FINDING_SCHEMA,
    GATE_SCHEMA,
    GATE_VERDICTS,
    NOTE_KINDS,
    NOTE_SCHEMA,
    PLAIN_NAME,
    SEVERITIES,
    STOP_REASON,
    encode_package,
    is_submitted_patch,
)

#: The roles each tool is for (the ToolBox offers it to no other).
ROLE_TOOLS: Final[Mapping[str, frozenset[str]]] = {
    'write_findings': frozenset({'hunter', 'commit-reviewer', 'pr-reviewer'}),
    'write_notes': frozenset({'mapper'}),
    'write_gate_record': frozenset({'gate-runner', 'final-go'}),
    'post_subtask': frozenset({'hunter', 'builder'}),
    'push_commit': frozenset({'committer'}),
    'open_draft_pr': frozenset({'pr-author'}),
    'post_comment': frozenset({'pr-reviewer'}),
}
#: The one role each poster posts for (board/api.py ``POSTERS``, but the coordinator's, which posts with post_task).
POSTS_FOR: Final[Mapping[str, str]] = {'hunter': 'fixer', 'builder': 'builder'}

#: The outputs' shapes are ``runtime/outputs.py``'s (shipped with the harness, read by the readers too); the bounds
#: below the readers keep apart, a test holds to theirs.
MAX_LINE_BYTES: Final = 8 * 1024
MAX_PACKS: Final = 20
MAX_REASONS: Final = 20
MAX_REASON: Final = 400
#: The roles whose record names the tree the gate judged: the harness applies their task's submitted patch to their
#: checkout before anything runs and hashes that tree itself (``main.judge_submitted_patch``).
GATE_ROLES: Final = frozenset({'gate-runner', 'final-go'})
MAX_CLAIM: Final = 400
MAX_CITATIONS: Final = 8
#: Lines one shard holds at most (a reader's ``MAX_NOTES``; findings alike).
MAX_LINES: Final = 200
#: The keys one task keeps at most (board/store.py ``MAX_RESULT_KEYS``).
MAX_RESULT_KEYS: Final = 16
#: The broker's own bounds (connectors/handler.py ``MAX_TEXT``, ``MAX_NAME``).
MAX_TEXT: Final = 65_536
MAX_NAME: Final = 1024
_SHARD: Final = re.compile(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,121}\Z')


def shard_key(context: Built, package: str, shard: str) -> str:
    """The agent's own key for one shard of ``package`` at its task's commit and attempt."""
    if not context.commit:
        raise ValueError('this session has no commit to write outputs under')
    check_place(context.commit, context.attempt)
    if not _SHARD.fullmatch(shard):
        raise ValueError('a shard is a name of letters, digits, ".", "_" and "-", at most 122 characters')
    plain = '.' if package in ('', '.') else check_sparse_path(package)
    return (f'{agent_prefix(context.run_id, context.agent_id)}commits/{context.commit}/{encode_package(plain)}/'
            f'attempt-{context.attempt}/{shard}.jsonl')


def _text(item: Mapping[str, Any], name: str, limit: int, *, required: bool = True) -> str:
    value = item.get(name, '' if not required else None)
    if not isinstance(value, str) or (required and not value.strip()) or len(value) > limit:
        raise ValueError(f'{name} is text of {1 if required else 0}-{limit} characters')
    return value


def _items(arguments: Mapping[str, Any], name: str) -> list[Mapping[str, Any]]:
    return listed(arguments, name, MAX_LINES, Mapping, 'objects')


def _finding(item: Mapping[str, Any]) -> dict[str, Any]:
    path, line, severity = item.get('file'), item.get('line'), item.get('severity')
    if not isinstance(path, str) or not FINDING_FILE.fullmatch(path) or path.startswith('/') or '..' in path.split('/'):
        raise ValueError('a finding\'s file is a repository path')
    if type(line) is not int or line < 0:
        raise ValueError('a finding\'s line is a whole number from 0')
    if severity not in SEVERITIES:
        raise ValueError(f'a finding\'s severity is one of {", ".join(SEVERITIES)}')
    return {'schema': FINDING_SCHEMA, 'file': path, 'line': line, 'severity': severity,
            'rule': _text(item, 'rule', 100, required=False), 'title': _text(item, 'title', 200),
            'evidence': _text(item, 'evidence', 500, required=False)}


def _note(item: Mapping[str, Any], package: str) -> dict[str, Any]:
    if item.get('kind') not in NOTE_KINDS:
        raise ValueError(f'a note\'s kind is one of {", ".join(NOTE_KINDS)}')
    citations = item.get('citations')
    if (not isinstance(citations, list) or not 0 < len(citations) <= MAX_CITATIONS
            or not all(isinstance(c, str) and 0 < len(c) <= 600 for c in citations)):
        raise ValueError(f'a note cites 1-{MAX_CITATIONS} places (path:line)')
    return {'schema': NOTE_SCHEMA, 'kind': item['kind'], 'package': package,
            'subject': _text(item, 'subject', 80, required=False), 'claim': _text(item, 'claim', MAX_CLAIM),
            'citations': list(citations)}


def _lines(rows: Sequence[Mapping[str, Any]]) -> bytes:
    lines = [json.dumps(row, ensure_ascii=False, sort_keys=True) for row in rows]
    if any(len(line.encode()) > MAX_LINE_BYTES for line in lines):
        raise ValueError(f'a line is at most {MAX_LINE_BYTES} bytes: shorten its text')
    return ''.join(f'{line}\n' for line in lines).encode()


def _reasons(arguments: Mapping[str, Any]) -> list[str]:
    reasons = listed(arguments, 'reasons', MAX_REASONS, str, 'reasons, each text')
    if not all(0 < len(reason.strip()) <= MAX_REASON for reason in reasons):
        raise ValueError(f'a reason is text of 1-{MAX_REASON} characters')
    return reasons


def _verdict(context: Built, arguments: Mapping[str, Any]) -> tuple[str, str, list[dict[str, Any]], Any]:
    """The verdict, stop reason, rounds and final go section of the role's record, from what the harness saw: the
    gate runner's checks are the ones it ran (``AgentContext.checks``), and a GO only when there is one and every one
    passed; the final go's section names this session's own agent and model, and only the final go writes one. A GO
    of either needs the tree the harness hashed (``AgentContext.gate_tree``): a task that names no submitted patch
    judged none."""
    verdict = arguments.get('verdict')
    if verdict == 'GO' and not context.gate_tree:
        raise ValueError('a GO is for the tree of the submitted patch your task names, and it names none: '
                         'write NO-GO or STOPPED, and say so in your finish')
    if context.role == 'final-go':
        if verdict not in ('GO', 'NO-GO'):
            raise ValueError('the final go answers GO or NO-GO')
        if not context.model:
            raise ValueError('this session names no model for its final go')
        return verdict, '', [], {'agent': context.agent_id, 'model_id': context.model, 'verdict': verdict,
                                 'reasons': _reasons(arguments)}
    if verdict not in GATE_VERDICTS:
        raise ValueError(f'the verdict is one of {", ".join(sorted(GATE_VERDICTS))}')
    checks = [dict(check) for check in context.checks]
    if verdict == 'GO' and (not checks or any(check['status'] != 'pass' for check in checks)):
        raise ValueError('a GO needs a check you ran, and every check you ran passed')
    stop = optional(arguments, 'stop_reason', 40)
    if (verdict == 'STOPPED') != bool(stop) or not STOP_REASON.fullmatch(stop):
        raise ValueError('a STOPPED record says why in stop_reason (lower case and "_"), and only it does')
    return verdict, stop, [{'number': 1, 'checks': checks, 'reviewed': False, 'complete': True,
                            'finding_ids': []}], None


def gate_record(context: Built, arguments: Mapping[str, Any]) -> bytes:
    """The role's ``voc-gate-record/1`` record, built by the harness, field by field (the model gives its verdict,
    the packs and, for a STOPPED one, why; the final go its reasons): nothing a model types is taken for a check that
    passed, for the tree or for another agent's GO. The tree is the one the harness hashed when it applied the task's
    submitted patch (``AgentContext.gate_tree``: '' when the task names none, never with a GO). Every record it
    builds reads back as GateRecord.from_dict reads it (quality_gate/record.py, which does not ship in the images; a
    test holds the two together)."""
    packs = listed(arguments, 'packs', MAX_PACKS, str, 'gate pack names') if arguments.get('packs') else []
    if not all(PLAIN_NAME.fullmatch(pack) for pack in packs):
        raise ValueError('a pack is a gate pack\'s name (letters, digits, ".", "_", "-")')
    verdict, stop, rounds, final_go = _verdict(context, arguments)
    if verdict == 'GO':
        # The checkout's tree now, every change in it taken: a GO only when it is still the tree judged. The limit:
        # this compares the tree at the record's write only, and no check is tied to the tree it ran on, so a command
        # that changes the tree and another that changes it back leave the judged tree, and the checks between them
        # ran on another one.
        now = checkout_tree(context)
        if now != context.gate_tree:
            raise ValueError(f'the checkout\'s tree is now {now}, which differs from the judged {context.gate_tree} '
                             '(the submitted patch applied to the run\'s commit), so its checks are not for the judged '
                             'tree: write NO-GO, and say which command changed it')
    record = {'schema': GATE_SCHEMA, 'verdict': verdict, 'stop_reason': stop, 'tree_hash': context.gate_tree,
              'packs': list(dict.fromkeys(packs)), 'own_gate': False, 'tool_versions': {}, 'max_rounds': 1,
              'reviewers': [], 'model_calls': 0, 'accepted_by': '', 'rounds': rounds, 'findings': [],
              'final_go': final_go}
    return json.dumps(record, sort_keys=True).encode()


def specs(tool_spec: Callable[..., Built], role: str) -> tuple[Built, ...]:
    """The tools of this module ``role`` may have (none for a role none of them is for)."""
    text, path = {'type': 'string'}, {'type': 'string', 'description': 'A repository path ("." for the root).'}
    shard = {'type': 'string', 'description': 'The shard\'s name (letters, digits, ".", "_", "-").'}
    finding = {'type': 'object', 'properties': {
        'file': text, 'line': {'type': 'integer'}, 'severity': {'type': 'string', 'enum': list(SEVERITIES)},
        'rule': text, 'title': text, 'evidence': text}, 'required': ['file', 'line', 'severity', 'title']}
    note = {'type': 'object', 'properties': {
        'kind': {'type': 'string', 'enum': list(NOTE_KINDS)}, 'subject': text, 'claim': text,
        'citations': {'type': 'array', 'items': text}}, 'required': ['kind', 'claim', 'citations']}
    paths = {'type': 'array', 'items': text, 'description': 'Repository paths (relative, no "..").'}
    all_specs = (
        tool_spec('write_findings', 'Write your findings for one package as one shard (written once).',
                  {'package': path, 'shard': shard, 'findings': {'type': 'array', 'items': finding}},
                  ('package', 'shard', 'findings')),
        tool_spec('write_notes', 'Write your notes on one shard of a package (written once).',
                  {'package': path, 'shard': shard, 'notes': {'type': 'array', 'items': note}},
                  ('package', 'shard', 'notes')),
        tool_spec('write_gate_record', f'Write your gate record ({GATE_SCHEMA}), once: the harness builds it, its '
                  'tree the one it applied your task\'s submitted patch to and hashed, its checks the ones you ran '
                  'and a final go\'s section yours.',
                  {'verdict': {'type': 'string', 'enum': sorted(GATE_VERDICTS)},
                   'packs': {'type': 'array', 'items': text},
                   'stop_reason': {'type': 'string', 'description': 'Why a STOPPED record stopped (a_reason).'},
                   'reasons': {'type': 'array', 'items': text, 'description': 'The final go\'s reasons.'}},
                  ('verdict',)),
        tool_spec('post_subtask', f'Post one task on the board for a {POSTS_FOR.get(role, "")} (your task names the '
                  'board step).', {'title': text, 'instructions': text, 'paths': paths,
                                   'step': {'type': 'string', 'description': 'The board step your task names.'}},
                  ('title', 'instructions')),
        tool_spec('push_commit', 'Have the broker push the patch a fixer or builder submitted (its key, from your '
                  'task) as one commit to one of the run\'s branches, for the tree the gate\'s GO names.',
                  {'branch': {'type': 'string', 'description': f'{AGENT_BRANCH_PREFIX}<run id>/<name>'},
                   'patch': {'type': 'string', 'description': 'The submitted patch\'s key (…/_patches/….diff).'},
                   'tree_hash': text, 'message': text}, ('branch', 'patch', 'tree_hash', 'message')),
        tool_spec('open_draft_pr', 'Have the broker open (or update) the run\'s draft pull request from a branch.',
                  {'branch': text, 'title': text, 'body': text}, ('branch', 'title', 'body')),
        tool_spec('post_comment', 'Post your review as a comment on the run\'s pull request.',
                  {'number': {'type': 'integer'}, 'body': text}, ('number', 'body')),
    )
    return tuple(spec for spec in all_specs if role in ROLE_TOOLS[spec.name])


def _branch(context: Built, arguments: Mapping[str, Any]) -> str:
    branch = bounded(arguments, 'branch', MAX_NAME)
    if not branch.startswith(f'{AGENT_BRANCH_PREFIX}{context.run_id}/'):
        raise ValueError(f'a branch of this run is {AGENT_BRANCH_PREFIX}{context.run_id}/<name>')
    return branch


def _number(arguments: Mapping[str, Any]) -> int:
    number = arguments.get('number')
    if type(number) is not int or number < 1:
        raise ValueError('number is the pull request\'s number, a whole number from 1')
    return number


def handlers(context: Built, result: Callable[..., Built]) -> dict[str, Tool]:
    """This module's tools on ``context``."""
    return {**_output_handlers(context, result), **_writer_handlers(context, result)}


def _already_written(error: Exception) -> bool:
    """S3's answer to a create-only put of a key that exists (``If-None-Match``): the output was written before, by
    this agent's own earlier session (its keys are its own), so it is there, as it was written then."""
    response = getattr(error, 'response', None)
    return isinstance(response, Mapping) and response.get('Error', {}).get('Code') == 'PreconditionFailed'


def _output_handlers(context: Built, result: Callable[..., Built]) -> dict[str, Tool]:
    """The outputs under the agent's own keys, and the sub-task post."""

    def record(key: str, body: bytes, what: str) -> Built:
        if key in context.result_keys:
            raise ValueError(f'{key.rsplit("/", 1)[-1]} is written already: an output is written once')
        if len(context.result_keys) >= MAX_RESULT_KEYS:
            raise ValueError(f'a task records at most {MAX_RESULT_KEYS} outputs')
        try:
            context.store.put(key, body)
        except Exception as error:
            if not _already_written(error):
                raise
            # A continuation writing again what its crashed session wrote (and never got to record): kept as it is,
            # and recorded on the task like any output; the task's progress says so, and the model is told when
            # what stands is not what it asked for now (a gate record's earlier verdict, say).
            context.result_keys.append(key)
            if context.store.get(key, len(body)) == body:
                context.progress(f'kept {what} written before')
                return result(json.dumps({'key': key}))
            context.progress(f'kept {what} written before, with other content than asked now')
            return result(f'{key.rsplit("/", 1)[-1]} was written before by an earlier session of yours, with other '
                          'content than you asked now: that one stands and is recorded on your task (an output is '
                          'written once). Say so in your finish.', error=True)
        context.result_keys.append(key)
        context.progress(f'wrote {what}')
        return result(json.dumps({'key': key}))

    def write_findings(arguments: Mapping[str, Any]) -> Built:
        key = shard_key(context, str(arguments.get('package', '')), str(arguments.get('shard', '')))
        rows = [_finding(item) for item in _items(arguments, 'findings')]
        return record(key, _lines(rows), f'{len(rows)} findings')

    def write_notes(arguments: Mapping[str, Any]) -> Built:
        package = str(arguments.get('package', ''))
        key = shard_key(context, package, str(arguments.get('shard', '')))
        rows = [_note(item, package or '.') for item in _items(arguments, 'notes')]
        return record(key, _lines(rows), f'{len(rows)} notes')

    def write_gate_record(arguments: Mapping[str, Any]) -> Built:
        body = gate_record(context, arguments)
        key = f'{artifact_prefix(context.run_id, context.agent_id, context.commit, context.attempt, "gate")}record.json'
        return record(key, body, 'the gate record')

    def post_subtask(arguments: Mapping[str, Any]) -> Built:
        return post_for(context, result, arguments, POSTS_FOR[context.role])

    return {'write_findings': write_findings, 'write_notes': write_notes, 'write_gate_record': write_gate_record,
            'post_subtask': answered(post_subtask, result)}


def submitted_patch(context: Built, key: str) -> str:
    """``key`` when it is a patch a fixer or builder of this run submitted at its commit (``submit_work``: never a
    checkpoint's snapshot), the one the gate judges and the committer pushes; the broker checks the same before it
    reads it."""
    if not is_submitted_patch(key, context.run_id, context.commit):
        raise ValueError('patch is the key of the patch a fixer or builder of this run submitted '
                         f'(ws/default/runs/{context.run_id}/<fixer-n or builder-n>/commits/<commit>/_patches/...)')
    return key


#: The lines of a patch the broker's reader refuses where git would apply them (connectors/patches.py ``parse``): a
#: copy, and a binary file without its content. The gate refuses them too, so it never judges a tree the broker
#: cannot push (a test holds the two together; the rest of the broker's rules, an exact base and a path git would
#: write, hold at the push itself).
_UNPUSHABLE: Final = ((b'copy from ', 'copies a file'), (b'copy to ', 'copies a file'),
                      (b'Binary files ', 'has a binary file without its content'))


def patch_refusal(patch: bytes) -> str:
    """Why the broker would refuse ``patch`` before it reads a hunk, '' when nothing does: empty, over its size, or a
    line of ``_UNPUSHABLE``."""
    if not patch:
        return 'is empty'
    if len(patch) > outputs.MAX_SUBMITTED_PATCH_BYTES:
        return f'is over {outputs.MAX_SUBMITTED_PATCH_BYTES // (1024 * 1024)} MB'
    for line in patch.split(b'\n'):
        for start, why in _UNPUSHABLE:
            if line.startswith(start):
                return why
    return ''


class PatchNotJudged(RuntimeError):
    """The submitted patch a gate's task names cannot be judged (not a submitted patch of the run, one the broker
    would refuse, or one that does not apply to the checkout): the session stops before anything runs, a crash."""


def _git(context: Built, *argv: str) -> Mapping[str, Any]:
    return context.runner.run(repo_git(*argv), timeout_seconds=600, repository_code=False, in_checkout=False)


def checkout_tree(context: Built) -> str:
    """The tree of the checkout as it is now, every change taken (``git add --all``, then ``git write-tree``), by the
    harness's own git; under the snapshot's lock (``tools.snapshot``: a CLI's tool server shares the index).
    ``PatchNotJudged`` when git cannot hash it."""
    os.makedirs(context.patch_dir, mode=0o700, exist_ok=True)
    with open(os.path.join(context.patch_dir, '.snapshot.lock'), 'a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        added = _git(context, 'add', '--all')
        hashed = _git(context, 'write-tree')
    lines = str(hashed.get('stdout_tail', '')).split()
    tree = lines[-1] if lines else ''
    if added.get('exit_code') != 0 or hashed.get('exit_code') != 0 or not SHA.fullmatch(tree):
        raise PatchNotJudged('the harness could not hash the tree of the checkout')
    return tree


def judge_submitted_patch(context: Built, store: Built) -> str:
    """The tree a gate's session judges, set up before any check runs: the submitted patch its task names
    (``TaskBrief.patch``) applied to its fresh checkout of the run's commit, working tree and index, and that tree's
    id as the harness's own git hashes it (``git write-tree``). '' when the task names no patch (no GO can be written
    then). The patch is taken by the broker's rules (the key of a fixer's or builder's submission of this run at its
    commit, the broker's size and the lines it refuses) and must apply exactly; anything else is ``PatchNotJudged``.
    The tree is a pure function of the run's commit and the patch, so the gate runner and the final go, each on its
    own checkout, hash the same tree, and the broker pushes that patch only when the tree it rebuilds is that one."""
    key = context.brief.patch
    if not key:
        return ''
    if not is_submitted_patch(key, context.run_id, context.commit):
        raise PatchNotJudged(f'the task\'s patch {key[:300]!r} is not a patch a fixer or builder of this run '
                             'submitted at its commit')
    patch = store.get(key, outputs.MAX_SUBMITTED_PATCH_BYTES)
    refused = patch_refusal(patch)
    if refused:
        raise PatchNotJudged(f'the submitted patch {key} {refused}: the broker would not push it')
    os.makedirs(context.patch_dir, mode=0o700, exist_ok=True)
    local = os.path.join(context.patch_dir, 'judged.diff')
    with open(local, 'wb') as stream:
        stream.write(patch)
    # The index's file times first: the checkout opened its files to the group after git wrote them (a new ctime),
    # and ``apply --index`` takes a file whose times changed for one that changed. A file that does differ still
    # differs, and the apply refuses it.
    _git(context, 'update-index', '-q', '--refresh')
    applied = _git(context, 'apply', '--index', '--binary', local)
    if applied.get('exit_code') != 0:
        raise PatchNotJudged(f'the submitted patch {key} does not apply to the run\'s commit '
                             f'({str(applied.get("stderr_tail", "")).strip()[-300:]})')
    # (hashed as a GO's record hashes it again: a GO only while the checkout's tree is still this one)
    tree = checkout_tree(context)
    if context.runs_code:
        # The files git wrote are the agent's (umask 0022): opened to the group, as the checkout leaves its own.
        opened = context.runner.run(share_working_tree(), timeout_seconds=300, repository_code=False,
                                    in_checkout=False)
        if opened.get('exit_code') != 0:
            raise PatchNotJudged('the submitted patch\'s files could not be opened to repository code')
    context.progress(f'judging {key.rsplit("/", 1)[-1]}: tree {tree}')
    return tree


def _writer_handlers(context: Built, result: Callable[..., Built]) -> dict[str, Tool]:
    """The broker's one write of each writer."""

    def push_commit(arguments: Mapping[str, Any]) -> Built:
        branch, tree = _branch(context, arguments), bounded(arguments, 'tree_hash', 64)
        if not SHA.fullmatch(tree):
            raise ValueError('tree_hash is the full git tree id the gate\'s GO names')
        key = submitted_patch(context, bounded(arguments, 'patch', MAX_NAME))
        message = bounded(arguments, 'message', MAX_TEXT)
        answer = context.broker.push(context.run_id, context.agent_id, branch=branch, patch_key=key, tree_hash=tree,
                                     message=message)
        context.progress(f'pushed {branch}')
        return result(json.dumps({'patch': key, 'broker': answer}))

    def open_draft_pr(arguments: Mapping[str, Any]) -> Built:
        answer = context.broker.open_draft_pr(context.run_id, context.agent_id, branch=_branch(context, arguments),
                                              title=bounded(arguments, 'title', MAX_NAME),
                                              body=bounded(arguments, 'body', MAX_TEXT))
        context.progress('opened the draft pull request')
        return result(json.dumps({'broker': answer}))

    def post_comment(arguments: Mapping[str, Any]) -> Built:
        answer = context.broker.comment(context.run_id, context.agent_id, number=_number(arguments),
                                        body=bounded(arguments, 'body', MAX_TEXT))
        context.progress('posted a review comment')
        return result(json.dumps({'broker': answer}))

    return {'push_commit': push_commit, 'open_draft_pr': open_draft_pr, 'post_comment': post_comment}
