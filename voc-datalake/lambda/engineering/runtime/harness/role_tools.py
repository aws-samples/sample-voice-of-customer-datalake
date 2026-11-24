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
  rule, board/api.py ``POSTERS``: a hunter's fixes, a builder's sub-builds), on the board step it names, else
  (7.71.02) the one board step that takes the poster's posts (board/flow_guard.py);
- ``push_commit`` (the committer), ``open_draft_pr`` (the PR author: the run's pull request, ready for review or a draft
  as the run's flow says), ``post_comment`` (the PR reviewer, on the run's pull request; the understander, on the run's
  issue, its lines code spans: ``issues.issue_comment``): the broker's writes, which check the run, the dial, the
  GO and the write rules first (the understander's comment and labels are on its issue: no dial, 7.50.00). Since
  7.71.02 the harness fills in a writer's identifiers, as ``write_gate_record`` does its tree: the committer's patch
  is its task's (``TaskBrief.patch``), its tree the one the harness applied that patch to and hashed
  (``AgentContext.gate_tree``) and its branch the run's own (``run_branch``), the PR author's branch that one
  too; the model writes only the message, the title and the body (the first live Bug fixer run's committer was shown
  none of them and pushed nothing). A writer that finishes without its write goes to a person
  (``review_tools.ending``);
- the issue's tools (``issues.py``: ``read_issue``, ``write_triage``, ``label_issue``) and the gate's
  (``gate_tools.py``: ``run_gate``, ``read_gate_record``, ``read_findings``), 7.50.00;
- the tenets' (``tenets_tools.py``: ``read_tenets``, ``write_tenets``), 7.52.00;
- the submitted patch's and the reviewers' (``review_tools.py``: ``read_patch``, ``write_review``), 7.54.00;
- the skills library's (``library_tools.py``: ``read_skill``, the role's own library skills), 7.56.00.

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

from engineering.quality_gate.packs import STOPS
from engineering.runtime import outputs
from engineering.runtime.checkout import check_sparse_path, share_working_tree
from engineering.runtime.checkpoints import SHA, agent_prefix, artifact_prefix, check_place
from engineering.runtime.harness import gate_tools, issues, library_tools, review_tools, tenets_tools
from engineering.runtime.harness.coordinator import Built, Record, Tool, answered, bounded, listed, optional, post_for
from engineering.runtime.harness.review_tools import harness_git
from engineering.runtime.harness.transcript import already_written
from engineering.runtime.outputs import (
    FINDING_FILE,
    FINDING_SCHEMA,
    GATE_SCHEMA,
    GATE_VERDICTS,
    NOTE_KINDS,
    NOTE_SCHEMA,
    PLAIN_NAME,
    PULL_REQUEST_DRAFT,
    PULL_REQUEST_READY,
    SEVERITIES,
    STOP_REASON,
    encode_package,
    is_submitted_patch,
    run_branch,
)

#: The roles each tool is for (the ToolBox offers it to no other).
ROLE_TOOLS: Final[Mapping[str, frozenset[str]]] = {
    'write_findings': frozenset({'hunter', 'commit-reviewer', 'pr-reviewer'}),
    'write_notes': frozenset({'mapper'}),
    'write_gate_record': frozenset({'gate-runner', 'final-go'}),
    'post_subtask': frozenset({'hunter', 'builder'}),
    'push_commit': frozenset({'committer'}),
    'open_draft_pr': frozenset({'pr-author'}),
    'post_comment': frozenset({'pr-reviewer', 'understander'}),
    # (7.50.00: the run's issue, the deterministic gate and what the final go reads)
    'read_issue': frozenset({'understander', 'hunter', 'fixer', 'committer', 'pr-author', 'coordinator'}),
    'write_triage': frozenset({'understander'}),
    'label_issue': frozenset({'understander'}),
    'run_gate': frozenset({'gate-runner'}),
    # (7.71.02: the PR author quotes the gate record's section in the pull request it opens)
    'read_gate_record': frozenset({'final-go', 'pr-author'}),
    'read_findings': frozenset({'final-go'}),
    # (7.52.00: the accepted tenets a triage may cite, and the Tenets flow's draft of them)
    'read_tenets': frozenset({'understander'}),
    'write_tenets': frozenset({'understander'}),
    # (7.54.00: the submitted patch read by the roles that judge it without running code, and a reviewer's verdict)
    **review_tools.TOOL_ROLES,
    # (7.56.00: the role's own library skills, every launchable role whose card names any)
    **library_tools.TOOL_ROLES,
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
#: (7.71.02) The roles whose session judges that tree so: the gate's, and the committer, whose push names it.
JUDGED_ROLES: Final = GATE_ROLES | {'committer'}
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
    if context.gate_stop:
        # (7.54.00: a gate whose setup failed, that planned nothing or found only missing tools judged no code: it is
        # STOPPED, with the gate's own reason, never a NO-GO that would send the fix back to be revised)
        stop = optional(arguments, 'stop_reason', 40)
        if verdict != 'STOPPED' or stop not in ('', context.gate_stop):
            raise ValueError(f'the gate stopped ({context.gate_stop}: {STOPS[context.gate_stop]}), so no check judged '
                             f'the code: write STOPPED, its stop_reason {context.gate_stop}')
        return 'STOPPED', context.gate_stop, [{'number': 1, 'checks': [dict(check) for check in context.checks],
                                               'reviewed': False, 'complete': True, 'finding_ids': []}], None
    if verdict == 'GO' and not context.gate_ran:
        raise ValueError('a GO is the gate\'s: run run_gate first (its checks are the ones a GO needs)')
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
    if context.gate_packs:   # (the gate's own plan's packs, never the model's word)
        packs = list(context.gate_packs)
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
              'packs': list(dict.fromkeys(packs)), 'own_gate': False,
              # (7.52.00: what run_gate found of its packs' tools; none for a final go, which runs no gate)
              'tool_versions': dict(context.gate_tool_versions), 'max_rounds': 1,
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
        tool_spec('post_subtask', f'Post one task on the board for a {POSTS_FOR.get(role, "")}: the board takes it '
                  'on the board step that takes your posts.', {
                      'title': text, 'instructions': text, 'paths': paths,
                      'step': {'type': 'string', 'description': 'The board step, only when your task names one.'}},
                  ('title', 'instructions')),
        tool_spec('push_commit', 'Have the broker push your task\'s submitted patch as one commit, with your '
                  'message, to the run\'s branch, for the tree the harness applied it to (your opening names all '
                  'three).', {'message': text}, ('message',)),
        tool_spec('open_draft_pr', 'Have the broker open (or update) the run\'s pull request from the run\'s branch, '
                  'ready for review or a draft as your opening says: you give its title and body.',
                  {'title': text, 'body': text}, ('title', 'body')),
        tool_spec('post_comment', 'Post a short summary of your triage on the run\'s issue (each line shown as '
                  'written).' if role == 'understander' else 'Post your review as a comment on the run\'s pull '
                  'request.', {'number': {'type': 'integer'}, 'body': text}, ('number', 'body')),
    )
    return (*(spec for spec in all_specs if role in ROLE_TOOLS[spec.name]),
            *issues.specs(tool_spec, role, ROLE_TOOLS), *gate_tools.specs(tool_spec, role, ROLE_TOOLS),
            *tenets_tools.specs(tool_spec, role, ROLE_TOOLS), *review_tools.specs(tool_spec, role),
            *library_tools.specs(tool_spec, role))


def _number(arguments: Mapping[str, Any]) -> int:
    number = arguments.get('number')
    if type(number) is not int or number < 1:
        raise ValueError('number is the pull request\'s number, a whole number from 1')
    return number


def handlers(context: Built, result: Callable[..., Built]) -> dict[str, Tool]:
    """This module's tools on ``context`` (and the issue's and the gate's: ``issues``, ``gate_tools``)."""
    outputs, record = _output_handlers(context, result)
    return {**outputs, **_writer_handlers(context, result), **issues.handlers(context, result, record),
            **gate_tools.handlers(context, result), **tenets_tools.handlers(context, result, record),
            **review_tools.handlers(context, result, record), **library_tools.handlers(context, result)}


def _output_handlers(context: Built, result: Callable[..., Built]
                     ) -> tuple[dict[str, Tool], Record]:
    """The outputs under the agent's own keys, and the sub-task post; and ``record``, the create-only output write
    (recorded on the task) the issue's and the tenets' tools write through."""

    def record(key: str, body: bytes, what: str) -> Built:
        if key in context.result_keys:
            raise ValueError(f'{key.rsplit("/", 1)[-1]} is written already: an output is written once')
        if len(context.result_keys) >= MAX_RESULT_KEYS:
            raise ValueError(f'a task records at most {MAX_RESULT_KEYS} outputs')
        try:
            context.store.put(key, body)
        except Exception as error:
            if not already_written(error):
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
        key = (f'{artifact_prefix(context.run_id, context.agent_id, context.commit, context.attempt, "gate")}'
               f'{outputs.GATE_RECORD_FILE}')
        return record(key, body, 'the gate record')

    def post_subtask(arguments: Mapping[str, Any]) -> Built:
        return post_for(context, result, arguments, POSTS_FOR[context.role])

    return {'write_findings': write_findings, 'write_notes': write_notes, 'write_gate_record': write_gate_record,
            'post_subtask': answered(post_subtask, result)}, record


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


def checkout_tree(context: Built) -> str:
    """The tree of the checkout as it is now, every change taken (``git add --all``, then ``git write-tree``), by the
    harness's own git; under the snapshot's lock (``tools.snapshot``: a CLI's tool server shares the index).
    ``PatchNotJudged`` when git cannot hash it."""
    os.makedirs(context.patch_dir, mode=0o700, exist_ok=True)
    with open(os.path.join(context.patch_dir, '.snapshot.lock'), 'a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        added = harness_git(context, 'add', '--all')
        hashed = harness_git(context, 'write-tree')
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
    harness_git(context, 'update-index', '-q', '--refresh')
    applied = harness_git(context, 'apply', '--index', '--binary', local)
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


#: (7.71.02) How the PR author's opening and its tool say the pull request opens, by META's ``pull_request``.
OPENS_AS: Final[Mapping[str, str]] = {
    PULL_REQUEST_READY: 'ready for review (the run\'s flow sets no draft): call it ready for review, never a draft, '
                        'whatever the task\'s words say',
    PULL_REQUEST_DRAFT: 'as a draft (the run\'s flow says pr: draft)',
}
#: What the committer is told when its task names no submitted patch (its opening, and ``push_commit``'s refusal).
NO_PUSH: Final = ('your task names no submitted patch, so there is nothing to push: finish, and say so (your task then '
                  'goes to a person)')
#: The tool's own words for it (``open_draft_pr``'s progress line on the task).
OPENED_AS: Final[Mapping[str, str]] = {PULL_REQUEST_READY: 'ready for review', PULL_REQUEST_DRAFT: 'a draft'}


def _push_target(context: Built) -> tuple[str, str, str]:
    """The committer's push, as the harness fills it in (7.71.02): its task's submitted patch, the tree the harness
    applied it to and hashed (``judge_submitted_patch``) and the run's own branch; ``ValueError`` when the task names
    no patch, so there is nothing to push."""
    if not context.brief.patch or not context.gate_tree:
        raise ValueError(NO_PUSH)
    return submitted_patch(context, context.brief.patch), context.gate_tree, run_branch(context.run_id)


def writer_parts(context: Built) -> list[str]:
    """What a writer's opening says of the write the harness fills in (7.71.02), and of the run's issue for a role
    that reads it; no part for another role."""
    parts: list[str] = []
    if context.brief.issue and context.role in ROLE_TOOLS['read_issue']:
        parts += ['', f'The run starts from issue #{context.brief.issue}: that is the number read_issue takes.']
    if context.role == 'committer':
        try:
            key, tree, branch = _push_target(context)
        except ValueError:
            return [*parts, '', f'Note: {NO_PUSH}.']
        parts += ['', (f'The harness fills in your push: the submitted patch {key}, applied to the run\'s commit, '
                       f'makes the tree {tree}, which the broker pushes as one commit to the run\'s branch {branch}, '
                       'once the gate\'s GO names that tree. push_commit takes only your commit message.')]
    elif context.role == 'pr-author':
        opens = OPENS_AS.get(context.brief.pull_request, 'ready for review or as a draft, as the run\'s flow says')
        parts += ['', (f'The broker opens the run\'s pull request from the run\'s branch '
                       f'{run_branch(context.run_id)}, {opens}. open_draft_pr takes only its title and body; '
                       'read_gate_record reads the gate record your description quotes.')]
    return parts


def _writer_handlers(context: Built, result: Callable[..., Built]) -> dict[str, Tool]:
    """The broker's one write of each writer; each made write is kept on the session (``AgentContext.host_writes``),
    which its finish reads."""

    def push_commit(arguments: Mapping[str, Any]) -> Built:
        key, tree, branch = _push_target(context)
        answer = context.broker.push(context.run_id, context.agent_id, branch=branch, patch_key=key, tree_hash=tree,
                                     message=bounded(arguments, 'message', MAX_TEXT))
        context.host_writes.add('push_commit')
        context.written(f'pushed {branch}')   # (made: a board that fails now never crashes the session)
        return result(json.dumps({'branch': branch, 'patch': key, 'tree_hash': tree, 'broker': answer}))

    def open_draft_pr(arguments: Mapping[str, Any]) -> Built:
        answer = context.broker.open_draft_pr(context.run_id, context.agent_id, branch=run_branch(context.run_id),
                                              title=bounded(arguments, 'title', MAX_NAME),
                                              body=bounded(arguments, 'body', MAX_TEXT))
        context.host_writes.add('open_draft_pr')
        opened = OPENED_AS.get(context.brief.pull_request, '')
        context.written(f'opened the pull request{f", {opened}" if opened else ""}')
        return result(json.dumps({'branch': run_branch(context.run_id), 'broker': answer}))

    def post_comment(arguments: Mapping[str, Any]) -> Built:
        body = bounded(arguments, 'body', MAX_TEXT)
        if context.role == 'understander':
            # (its run's issue: each line a code span, under the platform's own head)
            answer = context.broker.comment(context.run_id, context.agent_id, number=_number(arguments),
                                            body=issues.issue_comment(body), on='issue')
            context.written('posted the triage on the issue')
        else:
            answer = context.broker.comment(context.run_id, context.agent_id, number=_number(arguments), body=body)
            context.written('posted a review comment')
        return result(json.dumps({'broker': answer}))

    return {'push_commit': push_commit, 'open_draft_pr': open_draft_pr, 'post_comment': post_comment}
