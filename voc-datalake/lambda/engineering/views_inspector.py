"""The run workspace's inspector tabs of one agent (7.51.00): its changes, the files it read and wrote, its gate, its
memory.

- **Changes** (``…/agents/<agent>/changes?source=submitted|checkpoint&attempt=&key=``, D51-1): the agent's patches in
  the workspace bucket, the exact bytes the gate judged and the committer pushed (``…/_patches/attempt-<n>/``: the
  submitted ones, ``<task>-<nonce>.diff``, and each checkpoint's, ``checkpoint-<seq>-<nonce>.diff``), listed under its
  own prefix; one of them parsed into its files (path, the old path of a rename or copy, status, lines added and
  removed, binary), the newest submitted one unless the query names another. With the run's pull request's address
  (``pr_url``) and its pushed change on the host (``commit_url``: the committer's pushed branch compared with its base,
  since the broker records the branch and tree it pushed, not the commit's id), each None until there is one, so a
  large diff can be opened there. ``…/changes/file?key=&path=`` answers one file's part of a patch (unified, at most
  ``MAX_FILE_PATCH`` bytes). Nothing is computed or checked out: this parses a patch, it never makes one.
- **Files**: the files its tool calls read, listed or wrote, from its transcript (``views_thread.ThreadView.events``).
- **Gate**: its gate record (``…/_gate/attempt-<n>/record.json``, ``voc-gate-record/1``, checked by
  ``GateRecord.from_dict``), read once the record was written (its task recorded it, or its transcript shows the write),
  and the checks of its latest ``run_gate`` with each one's output tail, from its transcript; since 7.52.00 with each
  check's pack and language (the bundle's gate steps), the gate run's round, the tools' versions, and the record's
  verdict, stop (``GET …/gates``' stop codes: registry/views.py ``stop_view``) and final go's decision. It is read
  per agent: a step's view reads its gate runner's lane, and its final go's.
- **Memory**: the approved lessons its task's brief took (the brief's ``memory:<n>`` blocks, its transcript's first
  prompt) and what Learn made of its task's failures (the run's ``LEARNED#<task>#…`` rows, learning/loop.py).

Every text is ``views_thread.cleaned``: redacted, without control characters, bounded.
"""
from __future__ import annotations

import json
import re
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from typing import Any, Final
from urllib.parse import quote

from engineering.board.model import Task, task_key
from engineering.connectors.identity import PUSH_BUNDLE, WORKSPACE
from engineering.quality_gate.record import GateRecord
from engineering.rows import get_row, partition_rows, run_pk, run_rows, string_attr
from engineering.run_links import HOSTS, run_pull_request, writes_pk
from engineering.run_objects import Listed, RunObjects
from engineering.runtime.harness.transcript import tool_kind
from engineering.views_thread import DATA_FENCE, Subject, ThreadView, cleaned, display

#: The patch bytes read at most (the broker's own bound on a submitted patch is 6 MB).
MAX_PATCH_READ: Final = 8 * 1024 * 1024
MAX_FILE_PATCH: Final = 1024 * 1024
MAX_FILES: Final = 2_000
MAX_PATCHES: Final = 200
MAX_TRACKED_FILES: Final = 2_000
#: A gate check's output tail, as the gate runner kept it (harness/gate_tools.py MAX_CHECK_OUTPUT).
MAX_OUTPUT_TAIL: Final = 2_000
SOURCES: Final = ('submitted', 'checkpoint')
CHECKPOINT_PATCH: Final = 'checkpoint-'
_PATCH_NAME: Final = re.compile(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,122}\.diff\Z')
#: The committer's write claims (connectors/records.py ``WRITE#<agent>#<attempt>#<op>#<digest>``).
_COMMITTER_CLAIMS: Final = 'WRITE#committer-'
_BRANCH: Final = re.compile(r'[\x21-\x7e]{1,255}\Z')
_COMPARE: Final = {'github': 'compare', 'gitlab': '-/compare'}


@dataclass(frozen=True)
class FilePatch:
    """One file of a patch: where its part starts and ends in the patch's text."""

    path: str
    old_path: str
    status: str
    additions: int
    deletions: int
    binary: bool
    start: int
    end: int

    def view(self) -> dict[str, Any]:
        view: dict[str, Any] = {'path': self.path, 'status': self.status, 'additions': self.additions,
                                'deletions': self.deletions, 'binary': self.binary}
        if self.old_path and self.old_path != self.path:
            view['old_path'] = self.old_path
        return view


def _unquoted(path: str) -> str:
    """A path as git writes it: C-quoted (``"a/sp\\303\\251cial"``) when it holds special characters."""
    if not (len(path) >= 2 and path.startswith('"') and path.endswith('"')):
        return path
    raw = path[1:-1].encode('latin-1', 'backslashreplace').decode('unicode_escape', 'replace')
    return raw.encode('latin-1', 'replace').decode('utf-8', 'replace')


def _side(raw: str, prefix: str) -> str:
    """A ``---``/``+++`` line's path: '' for ``/dev/null``, its ``a/``/``b/`` dropped, cut at a tab (a timestamp)."""
    path = _unquoted(raw.split('\t', 1)[0].rstrip('\r'))
    if path == '/dev/null':
        return ''
    return path[2:] if path.startswith(prefix) else path


def _git_header(rest: str) -> tuple[str, str]:
    """``diff --git a/X b/Y``'s two paths: the halves of ``a/P b/P`` when they name one path (a space in it too)."""
    half = (len(rest) - 1) // 2
    if len(rest) % 2 == 1 and rest[:2] == 'a/' and rest[half + 1:half + 3] == 'b/' and rest[2:half] == rest[half + 3:]:
        return rest[2:half], rest[2:half]
    match = re.fullmatch(r'("?a/.+?"?) ("?b/.+"?)', rest)
    if match is None:
        return '', ''
    return _side(match.group(1), 'a/'), _side(match.group(2), 'b/')


class _Section:
    def __init__(self, start: int, old: str, new: str) -> None:
        self.start, self.old, self.new = start, old, new
        self.status = ''
        self.additions = self.deletions = 0
        self.binary = self.in_hunk = False

    def line(self, line: str) -> None:
        if self.in_hunk:
            if line.startswith('+'):
                self.additions += 1
            elif line.startswith('-'):
                self.deletions += 1
            return
        if line.startswith('@@'):
            self.in_hunk = True
        elif line.startswith('--- '):
            self.old = _side(line[4:].rstrip('\n'), 'a/')
            self.status = self.status or ('added' if not self.old else '')
        elif line.startswith('+++ '):
            self.new = _side(line[4:].rstrip('\n'), 'b/')
            self.status = self.status or ('deleted' if not self.new else '')
        elif line.startswith(('new file mode', 'deleted file mode')):
            self.status = 'added' if line.startswith('new') else 'deleted'
        elif line.startswith(('rename ', 'copy ')):
            self._moved(line.rstrip('\r\n'))
        elif line.startswith(('Binary files ', 'GIT binary patch')):
            self.binary = True

    def _moved(self, line: str) -> None:
        """``rename from <old>``, ``rename to <new>`` (``copy`` alike)."""
        verb, _, rest = line.partition(' ')
        side, _, path = rest.partition(' ')
        if side == 'from':
            self.old = _unquoted(path)
        elif side == 'to':
            self.new = _unquoted(path)
        self.status = 'renamed' if verb == 'rename' else 'copied'

    def done(self, end: int) -> FilePatch | None:
        path = self.old if self.status == 'deleted' else self.new or self.old
        if not path:
            return None
        return FilePatch(path=path, old_path=self.old if self.status in ('renamed', 'copied') else '',
                         status=self.status or 'modified', additions=self.additions, deletions=self.deletions,
                         binary=self.binary, start=self.start, end=end)


def patch_files(text: str) -> list[FilePatch]:
    """The files of a unified git patch (``git diff --binary``), in order: each from its ``diff --git`` line to the
    next. A file is named by its ``+++ b/`` side, else its ``--- a/`` side (``/dev/null`` is none: an added or a
    deleted file), else its ``rename``/``copy`` lines, else its ``diff --git`` header; lines are counted inside its
    hunks only (``\\ No newline at end of file`` counts as neither)."""
    files: list[FilePatch] = []
    section: _Section | None = None
    offset = 0
    for line in text.splitlines(keepends=True):
        if line.startswith('diff --git '):
            if section is not None and (done := section.done(offset)) is not None:
                files.append(done)
            old, new = _git_header(line[len('diff --git '):].rstrip('\r\n'))
            section = _Section(offset, old, new)
        elif section is not None:
            section.line(line)
        offset += len(line)
    if section is not None and (done := section.done(offset)) is not None:
        files.append(done)
    return files


@dataclass(frozen=True)
class Patch:
    key: str
    source: str
    at: str
    size: int

    def view(self) -> dict[str, Any]:
        return {'key': self.key, 'source': self.source, 'at': self.at, 'size': self.size}


def _patch_of(listed: Listed, prefix: str) -> Patch | None:
    name = listed.key.removeprefix(prefix)
    if not _PATCH_NAME.fullmatch(name):
        return None
    return Patch(listed.key, 'checkpoint' if name.startswith(CHECKPOINT_PATCH) else 'submitted', listed.at, listed.size)


def _attempt_subject(subject: Subject, attempt: int | None) -> Subject:
    if attempt is None or attempt == subject.attempt:
        return subject
    return Subject(run_id=subject.run_id, agent=subject.agent, role=subject.role, task_id=subject.task_id,
                   attempt=attempt, commit=subject.commit, status=subject.status)


def _compare_url(host: str, repository: str, base: str, branch: str) -> str | None:
    if host not in HOSTS or not repository or not _BRANCH.fullmatch(base) or not _BRANCH.fullmatch(branch):
        return None
    return f'https://{HOSTS[host]}/{repository}/{_COMPARE[host]}/{quote(base, safe="/")}...{quote(branch, safe="/")}'


def _first_text(content: object) -> str:
    return '\n'.join(str(block['text']) for block in content if isinstance(block, Mapping)
                     and isinstance(block.get('text'), str)) if isinstance(content, list) else ''


def _gate_run(text: str) -> dict[str, Any] | None:
    """A ``run_gate`` result's JSON, from inside its DATA fence (None for one that does not read)."""
    fenced = DATA_FENCE.search(text)
    try:
        found = json.loads(fenced.group(3) if fenced else text)
    except ValueError:
        return None
    return found if isinstance(found, dict) and isinstance(found.get('checks'), list) else None


def _versions(raw: object) -> dict[str, str]:
    """A gate's tools' versions as it recorded them (``{tool: version}``: at most 20, each bounded)."""
    if not isinstance(raw, Mapping):
        return {}
    return {str(tool)[:64]: display(str(version))[:200] for tool, version in list(raw.items())[:20]}


def _check_view(check: Mapping[str, Any]) -> dict[str, Any]:
    output = str(check.get('output', ''))
    exit_code = check.get('exit_code')
    duration = check.get('duration_s')
    return {'key': str(check.get('key', ''))[:200], 'name': str(check.get('name', ''))[:200],
            'status': str(check.get('status', ''))[:40], 'reason': display(str(check.get('reason', '')))[:500],
            'exit_code': exit_code if isinstance(exit_code, int) and not isinstance(exit_code, bool) else None,
            'duration_s': duration if isinstance(duration, int | float) and not isinstance(duration, bool) else None,
            'output_tail': display(output[-MAX_OUTPUT_TAIL:])}


class AgentTabs:
    """The inspector's reads of one agent: ``client`` and ``table`` the voc-engineering table's, ``objects`` the
    workspace bucket's, ``thread`` its transcript's reader."""

    def __init__(self, client: Any, table: str, objects: RunObjects, thread: ThreadView) -> None:
        self.client, self.table = client, table
        self.objects = objects
        self.thread = thread

    def patches(self, subject: Subject) -> list[Patch]:
        prefix = subject.prefix('patches')
        if not prefix:
            return []
        found = [patch for listed in self.objects.listed(prefix, limit=MAX_PATCHES)
                 if (patch := _patch_of(listed, prefix)) is not None]
        return sorted(found, key=lambda patch: (patch.at, patch.key))

    def changes(self, subject: Subject, *, source: str | None, attempt: int | None, key: str | None,
                host: Callable[[str], str] | None = None) -> dict[str, Any]:
        """The agent's patches and one of them parsed into its files (``{source, key, commit, attempt, files,
        truncated, patches, commit_url, pr_url}``; ``key`` None when it has none of that source). ``host``: a
        connection's host kind by its id (``github``, ``gitlab``), asked only for a pushed change with no pull request
        yet (whose record names its host)."""
        mine = _attempt_subject(subject, attempt)
        patches = self.patches(mine)
        chosen = self._chosen(patches, source, key)
        files: list[dict[str, Any]] = []
        truncated = False
        if chosen is not None:
            text, cut = self._patch_text(chosen.key)
            parsed = patch_files(text)
            files = [file.view() for file in parsed[:MAX_FILES]]
            truncated = cut or len(parsed) > MAX_FILES
        links = self._links(subject.run_id, host)
        return {'source': chosen.source if chosen else (source or 'submitted'), 'key': chosen.key if chosen else None,
                'commit': mine.commit or None, 'attempt': mine.attempt, 'files': files, 'truncated': truncated,
                'patches': [patch.view() for patch in reversed(patches)], **links}

    def _chosen(self, patches: Sequence[Patch], source: str | None, key: str | None) -> Patch | None:
        if key is not None:
            return next((patch for patch in patches if patch.key == key), None)
        wanted = [patch for patch in patches if source is None or patch.source == source]
        submitted = [patch for patch in wanted if patch.source == 'submitted']
        return (submitted or wanted or [None])[-1]

    def _patch_text(self, key: str) -> tuple[str, bool]:
        read = self.objects.read(key, 0, MAX_PATCH_READ)
        if read is None:
            return '', False
        return read.body.decode('utf-8', 'replace'), read.total > len(read.body)

    def file_patch(self, subject: Subject, key: str, path: str) -> dict[str, Any] | None:
        """One file's part of one of the agent's patches (``{path, patch, truncated}``), None when the agent has no
        such patch or the patch no such file."""
        mine = _attempt_subject(subject, _key_attempt(key) or subject.attempt)
        known = next((patch for patch in self.patches(mine) if patch.key == key), None)
        if known is None:
            return None
        text, _ = self._patch_text(known.key)
        found = next((file for file in patch_files(text) if path in (file.path, file.old_path)), None)
        if found is None:
            return None
        raw = text[found.start:found.end].encode('utf-8')
        cut = len(raw) > MAX_FILE_PATCH
        part = raw[:MAX_FILE_PATCH].decode('utf-8', 'ignore') if cut else text[found.start:found.end]
        return {'path': found.path, 'key': known.key, 'patch': part, 'truncated': cut}

    def _links(self, run_id: str, host: Callable[[str], str] | None) -> dict[str, str | None]:
        """The run's pull request's address and its pushed change's (``commit_url``), each None until there is one."""
        meta = get_row(self.client, self.table, {'pk': {'S': run_pk(WORKSPACE, run_id)}, 'sk': {'S': 'META'}}) or {}
        repository = string_attr(meta, 'repo')
        pull = run_pull_request(self.client, self.table, WORKSPACE, run_id, repository) if repository else None
        branch = self._pushed_branch(run_id)
        if not branch:
            return {'pr_url': pull.url if pull is not None else None, 'commit_url': None}
        base = pull.base if pull is not None else string_attr(meta, 'default_branch')
        kind = pull.host if pull is not None else host(string_attr(meta, 'connection')) if host is not None else ''
        return {'pr_url': pull.url if pull is not None else None,
                'commit_url': _compare_url(kind, repository, base, branch)}

    def _pushed_branch(self, run_id: str) -> str:
        """The branch of the committer's latest done push ('' for none)."""
        rows = partition_rows(self.client, self.table, writes_pk(WORKSPACE, run_id), _COMMITTER_CLAIMS, max_items=200)
        pushed = [row for row in rows if string_attr(row, 'op') == PUSH_BUNDLE and string_attr(row, 'state') == 'done']
        for row in sorted(pushed, key=lambda row: int(row.get('closed_at', {}).get('N', '0')), reverse=True):
            try:
                result = json.loads(string_attr(row, 'result') or '{}')
            except ValueError:
                continue
            branch = result.get('branch') if isinstance(result, dict) else None
            if isinstance(branch, str) and _BRANCH.fullmatch(branch):
                return branch
        return ''

    def files(self, subject: Subject) -> dict[str, Any]:
        """The files its tool calls read, listed or wrote (``{files: [{path, read, written, listed, last_at}],
        truncated}``), by path."""
        seen: dict[str, dict[str, Any]] = {}
        for event in self.thread.events(subject):
            data = event.data
            if data.get('kind') != 'tool_call' or not isinstance(data.get('input'), Mapping):
                continue
            path, name = data['input'].get('path'), str(data.get('tool', ''))
            how = {'read_file': 'read', 'list_files': 'listed', 'write_file': 'written'}.get(name) or \
                {'read': 'read', 'edit': 'written', 'delete': 'written', 'move': 'written'}.get(tool_kind(name))
            if not isinstance(path, str) or how is None or (path not in seen and len(seen) >= MAX_TRACKED_FILES):
                continue
            entry = seen.setdefault(path, {'path': display(path)[:300], 'read': 0, 'written': 0, 'listed': 0,
                                           'last_at': ''})
            entry[how] += 1
            entry['last_at'] = str(data.get('at', ''))
        return {'files': [seen[path] for path in sorted(seen)], 'truncated': len(seen) >= MAX_TRACKED_FILES}

    def gate(self, subject: Subject) -> dict[str, Any]:
        """Its gate record and its latest gate run's checks with their output tails (``{key, record, checks,
        passed, packs, ran_at}``); since 7.52.00 each check's pack and language, the run's ``round`` (its number among
        this agent's runs of the gate), the tools' versions it recorded, the record's ``verdict``, its ``stop`` as
        ``GET …/gates`` names the stops and a final go's decision (``final_go``)."""
        from engineering.registry.views import check_place, final_go_view, step_places, stop_view
        from shared.engineering_templates import bundle

        latest: tuple[str, dict[str, Any], int] | None = None
        written = False
        for event in self.thread.events(subject):
            data = event.data
            if data.get('kind') != 'tool_result' or data.get('error'):
                continue
            if data.get('tool') == 'run_gate' and (ran := _gate_run(str(data.get('text', '')))) is not None:
                latest = (str(data.get('at', '')), ran, (latest[2] if latest else 0) + 1)
            written = written or data.get('tool') == 'write_gate_record'
        key = f'{subject.prefix("gate")}record.json' if subject.prefix('gate') else ''
        record = self._record(key) if key and (written or self._recorded(subject, key)) else None
        ran = latest[1] if latest else {}
        places = step_places(bundle()['gates'])
        return {'key': key if record is not None else None, 'record': record,
                'checks': [{**_check_view(check), **check_place(str(check.get('key', '')), places)}
                           for check in ran.get('checks', [])[:100] if isinstance(check, Mapping)],
                'passed': ran.get('passed') if isinstance(ran.get('passed'), bool) else None,
                'packs': [str(pack)[:64] for pack in ran.get('packs', [])[:20]] if isinstance(ran.get('packs'), list) else [],
                'ran_at': latest[0] if latest else None, 'round': latest[2] if latest else None,
                'tool_versions': _versions(ran.get('tool_versions')) or _versions((record or {}).get('tool_versions')),
                'verdict': (record or {}).get('verdict'), 'stop': stop_view(record), 'final_go': final_go_view(record)}

    def _recorded(self, subject: Subject, key: str) -> bool:
        if not subject.task_id:
            return False
        item = get_row(self.client, self.table, task_key(WORKSPACE, subject.run_id, subject.task_id))
        return item is not None and key in Task.from_item(item).result_keys

    def _record(self, key: str) -> dict[str, Any] | None:
        read = self.objects.read(key, 0, MAX_FILE_PATCH)
        if read is None:
            return None
        try:
            record = GateRecord.from_dict(json.loads(read.body))
        except ValueError:
            return {'unreadable': True}
        return cleaned(record.to_dict(), 2_000)

    def memory(self, subject: Subject) -> dict[str, Any]:
        """The lessons its brief took and what Learn made of its task (``{recalled: [{name, text}], learned}``)."""
        brief = next((event for event in self.thread.events(subject, 2 * MAX_FILE_PATCH)
                      if event.data.get('kind') == 'message' and event.data.get('role') == 'user'), None)
        text = _first_text(brief.data.get('content')) if brief is not None else ''
        recalled = [{'name': match.group(1), 'text': display(match.group(3))[:4_000]}
                    for match in DATA_FENCE.finditer(text) if match.group(1).startswith('memory:')][:50]
        rows = run_rows(self.client, self.table, WORKSPACE, subject.run_id, f'LEARNED#{subject.task_id}#') \
            if subject.task_id else []
        learned = [{'key': string_attr(row, 'sk').removeprefix('LEARNED#'),
                    'memory_id': string_attr(row, 'memory_id') or None,
                    'lesson': display(string_attr(row, 'lesson'))[:400], 'coach': display(string_attr(row, 'coach'))[:400],
                    'proposed_version': int(row.get('proposed_version', {}).get('N', '0')) or None,
                    'at': string_attr(row, 'at') or None} for row in rows]
        return {'recalled': recalled, 'learned': learned}


def _key_attempt(key: str) -> int:
    match = re.search(r'/_patches/attempt-([1-9][0-9]{0,3})/', key)
    return int(match.group(1)) if match else 0
