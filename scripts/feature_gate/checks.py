"""The evaluation behind ``check``: every item, test entry, verdict, exemption, and the changes the base branch's
registry would refuse without a reviewed decision record (docs/feature-tests/README.md)."""
from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, TextIO

from . import gitio, items, ratchet, records, registry, resolve, verdict

ENTRY_KEYS = ('written_by', 'accepted_by', 'accepted_at', 'digest', 'verdict', 'rejections')
RUNNER_KEYS = {'pytest': ('node',), 'vitest': ('suite', 'file', 'name'), 'playwright': ('spec', 'title')}
LAYER_RUNNERS = {'unit': resolve.UNIT_RUNNERS, 'e2e': resolve.E2E_RUNNERS}


@dataclass
class Ctx:
    root: Path
    git: gitio.Git
    out: TextIO
    err: TextIO
    base_ref: str = gitio.DEFAULT_BASE

    def say(self, text: str = '') -> None:
        self.out.write(text + '\n')


@dataclass
class Evaluation:
    registry: registry.Registry
    problems: list[str] = field(default_factory=list)
    accepted: set[tuple[str, str]] = field(default_factory=set)   # (item id, test id) whose acceptance holds
    exempted: set[str] = field(default_factory=set)               # items whose exemption's review holds
    refined: dict[str, list[str]] = field(default_factory=dict)   # an item -> the slice items a decision put in its place
    tests: int = 0
    base_commit: str | None = None                                # the base branch's commit, when there is one
    released: set[str] = field(default_factory=set)               # items a reviewed removed / refine decision let go

    def is_accepted(self, item_id: str, entry: dict[str, Any]) -> bool:
        return entry.get('runner') in RUNNER_KEYS and (item_id, resolve.test_id(entry)) in self.accepted

    def is_exempted(self, item: dict[str, Any]) -> bool:
        return str(item.get('id')) in self.exempted

    def gaps(self) -> ratchet.Gaps:
        return ratchet.all_gaps(self.registry.items, self.is_accepted, self.is_exempted)


def changelog(root: Path) -> str:
    return (root / 'CHANGELOG.md').read_text(encoding='utf-8')


def package_version(root: Path) -> tuple[str | None, str | None]:
    """(package.json's version as written, the problem reading it): the file is parsed once per check."""
    try:
        return str(json.loads((root / 'package.json').read_text(encoding='utf-8')).get('version')), None
    except (OSError, ValueError, AttributeError) as err:
        return None, f'package.json: no version to read ({err})'


def _package_version_problems(version: str | None, error: str | None, releases: list[items.Release]) -> list[str]:
    """The release the repository says it is (package.json, the version check's own number) must be this line's newest
    CHANGELOG section."""
    if version is None:
        return [str(error)]
    two = items.two_digit(version)
    if two is None:
        return [f"package.json's version {version!r} is not MAJOR.MINOR.PATCH"]
    versions = [r.version for r in releases]
    if two not in versions:
        return [(f"package.json's version {two} is not a release of this line's CHANGELOG (no section the reader "
                 'finds: a suffix, a code fence, a heading below a suffixed one)')]
    if versions[0] != two:
        return [f"package.json's version {two} is not this line's newest release ({versions[0]})"]
    return []


def history_tip(git: gitio.Git) -> str:
    """The line whose bumps are its releases: in a pull_request run the PR's own head (HEAD^2 of its merge ref; the
    target's bumps are the target's), anywhere else HEAD."""
    if os.environ.get('GITHUB_EVENT_NAME') == 'pull_request' and gitio.commit_of(git, 'HEAD^2', ours=True):
        return 'HEAD^2'
    return 'HEAD'


def package_releases(ctx: Ctx, version: str | None) -> tuple[list[str], list[str]]:
    """(the line's releases: every version the root package.json held on this line since the gate came, its git
    history on the first parent, and holds now, the working tree staged or not, newest first; the history's problems)."""
    versions, problems = gitio.package_history_report(ctx.git, tip=history_tip(ctx.git))
    current = items.two_digit(version) if version else None
    if current and versions and current != versions[0] and (
            registry.parse_version(current) < registry.parse_version(versions[0])):
        # Not committed yet, the version still never goes back: a pushed release is never renumbered.
        problems = [*problems, (f"package.json's version {current} is not above the line's last release "
                                f'{versions[0]}: a pushed bump is never renumbered')]
    if current and current not in versions:
        versions.insert(0, current)
    floor = registry.parse_version(registry.FLOOR)
    return [v for v in versions if registry.parse_version(v) >= floor], problems


def _section_problems(ctx: Ctx, text: str, releases: list[items.Release], version: str | None) -> list[str]:
    """Every release (a package.json version bump) has exactly one CHANGELOG section the reader finds: the text the
    gate seeds its kind from. A section the reader cannot find, in whatever Markdown form, is a release with no
    section; Markdown can hide a heading, not a bump."""
    read = {r.version for r in releases}
    bumped, out = package_releases(ctx, version)
    out += [f'release {v} has no CHANGELOG section in the form the gate reads (`## [{v}] - <date>` at the start of a '
            'line, above the merged branches\' sections)' for v in bumped if v not in read]
    out += [f'CHANGELOG.md line {n}: {shown!r} is not a release number (MAJOR.MM.PP)' for n, shown in items.malformed(text)]
    return out


def tid_of(entry: dict[str, Any]) -> str | None:
    return resolve.test_id(entry) if entry.get('runner') in RUNNER_KEYS else None


# ---- one entry ----

def _entry_shape(layer: str, entry: dict[str, Any]) -> list[str]:
    runner = entry.get('runner')
    if runner not in LAYER_RUNNERS[layer]:
        return [f'{layer}: runner must be one of {", ".join(LAYER_RUNNERS[layer])} (got {runner!r})']
    allowed = {'runner', *RUNNER_KEYS[str(runner)], *ENTRY_KEYS, 'needs_rewrite'}
    out = [f'missing {key!r}' for key in (*RUNNER_KEYS[str(runner)], *ENTRY_KEYS) if key not in entry]
    out += [f'unknown key {key!r}' for key in entry if key not in allowed]
    if out:
        return out
    if not isinstance(entry['rejections'], list):
        out.append('rejections must be a list')
    if runner == 'vitest' and resolve.entry_from_id(resolve.test_id(entry)).get('suite') != entry['suite']:
        out.append(f'suite {entry["suite"]!r} is not the suite of {entry["file"]}')
    if not registry.is_session(entry['written_by']):
        out.append('written_by must be a session id')
    return out


def _front_problems(v: verdict.Verdict, item_id: str, tid: str, session: str, author: str, outcome: str) -> list[str]:
    out = []
    if registry.session_root(session) == registry.session_root(author):
        out.append(f"the evaluator {session} is the author {author} or the author's own sub-agent")
    if v.front.get('evaluator') != session:
        out.append(f"the verdict's evaluator {v.front.get('evaluator')} is not the session {session}")
    if v.front.get('author') != author:
        out.append(f"the verdict's author {v.front.get('author')} is not the test's author {author}")
    if v.front.get('item') != item_id or v.front.get('test') != tid:
        out.append(f'the verdict names {v.front.get("item")} / {v.front.get("test")}, not {item_id} / {tid}')
    if v.front.get('verdict') != outcome:
        out.append(f'the verdict is {v.front.get("verdict")}; this needs {outcome}')
    return out


def read_verdict(ctx: Ctx, rel: str) -> tuple[verdict.Verdict | None, str | None]:
    return verdict.read_file(ctx.root, rel)


def verdict_problems(ctx: Ctx, item_id: str, entry: dict[str, Any], rel: str, session: str,
                     outcome: str) -> list[str]:
    """Why a verdict file does not hold for this test, evaluator and outcome (shared by check, accept, reject)."""
    tid = resolve.test_id(entry)
    runner = str(entry['runner'])
    expected = (verdict.verdict_path(item_id, runner, tid) if outcome == 'ACCEPT'
                else verdict.reject_path(item_id, runner, tid, len(entry['rejections']) + 1))
    if os.path.normpath(rel) != expected:
        return [(f'the verdict file must be {expected} (docs/test-verdicts/<item>/<runner>-<hash>[.reject-<n>].md), '
                 f'not {rel}')]
    v, error = read_verdict(ctx, expected)
    if v is None:
        return [str(error)]
    author = str(entry['written_by'])
    out = [f'{expected}: {p}' for p in verdict.evidence_problems(
        v, resolve.command(entry), resolve.red_name(entry), str(entry['runner']))]
    out += _front_problems(v, item_id, tid, session, author, outcome)
    current = resolve.resolve(ctx.root, entry)
    if v.front.get('digest') != current.digest:
        out.append(f"the verdict's digest {v.front.get('digest')} is not the test's ({current.digest}): the test, its "
                   'file or its conftest.py chain changed since it was evaluated, or the verdict names another test')
    sha = v.front.get('sha', '')
    if registry.is_sha(sha):
        out += gitio.sha_problems(ctx.git, sha)
        if outcome == 'ACCEPT':
            out += [f'{expected}: Break: {p} does not exist at {sha}' for p in break_paths(v)
                    if not gitio.exists_at(ctx.git, sha, p)]
    return out


def break_paths(v: verdict.Verdict) -> list[str]:
    return [f.path for d in verdict.fences(v.sections.get('Break', ''), 'diff') for f in verdict.diff_files(d) if f.path]


def _acceptance(ctx: Ctx, item_id: str, entry: dict[str, Any]) -> list[str]:
    rel = entry.get('verdict')
    if not isinstance(rel, str):
        return ['accepted, but names no verdict file']
    out = verdict_problems(ctx, item_id, entry, rel, str(entry['accepted_by']), 'ACCEPT')
    if not out:
        v, _ = read_verdict(ctx, rel)
        sha = v.front.get('sha') if v else None
        if sha != entry.get('accepted_at'):
            out.append(f"accepted_at {entry.get('accepted_at')} is not the verdict's sha {sha}")
    return out


def rewrite_problems(ctx: Ctx, item_id: str, entry: dict[str, Any]) -> list[str]:
    """After two REJECTs only a reviewed ``rewrite <test id>`` record clears the rewrite bar, whatever the digests say:
    another session than its proposer judged the rewrite, on a commit that comes after the last REJECT."""
    tid = resolve.test_id(entry)
    rel = verdict.record_path(item_id, records.rewrite_name(tid))
    out = _record_holds(ctx, None, item_id, rel, f'rewrite {tid}')
    last = entry['rejections'][-1] if entry.get('rejections') else {}
    record = records.read(ctx.root, rel)
    sha = record.front.get('sha', '') if record else ''
    if not out and registry.is_sha(str(last.get('at'))) and not gitio.descends(ctx.git, str(last.get('at')), sha):
        out = [f'its sha {sha} does not come after the last REJECT ({last.get("at")})']
    return out


SHA256_RE = re.compile(r'[0-9a-f]{64}')
REJECTION_KEYS = ('by', 'at', 'digest', 'reasons')


def _rejection_shape(ctx: Ctx, n: int, r: Any) -> list[str]:
    """One rejection: ``by`` a session, ``at`` a commit HEAD descends from (refused, never skipped, when it is not a
    sha), ``digest`` a sha256, ``reasons``; nothing else (nothing is hashed from a break's paths)."""
    if not isinstance(r, dict):
        return [f'rejection {n} is not an object']
    out = []
    if not registry.is_session(r.get('by')):
        out.append(f'rejection {n}: by {r.get("by")!r} is not a session id')
    if not registry.is_sha(r.get('at')):
        out.append(f'rejection {n}: at {r.get("at")!r} is not a commit sha')
    else:
        out += [f'rejection {n}: {p}' for p in gitio.sha_problems(ctx.git, str(r['at']))]
    if not isinstance(r.get('digest'), str) or not SHA256_RE.fullmatch(r['digest']):
        out.append(f'rejection {n}: digest {r.get("digest")!r} is not a sha256')
    out += [f'rejection {n}: unknown key {key!r}' for key in r if key not in REJECTION_KEYS]
    return out


def _reject_file_problems(ctx: Ctx, rel: str, r: dict[str, Any]) -> list[str]:
    """The n-th REJECT file says REJECT and names its rejection's evaluator, sha and digest."""
    v, error = verdict.read_file(ctx.root, rel)
    if v is None:
        return [str(error)]
    out = []
    if v.front.get('verdict') != 'REJECT':
        out.append(f'{rel} says {v.front.get("verdict")}, not REJECT')
    for key, field_ in (('evaluator', 'by'), ('sha', 'at'), ('digest', 'digest')):
        if v.front.get(key) != r.get(field_):
            out.append(f"{rel} names the {key} {v.front.get(key)}, not the rejection's {r.get(field_)}")
    return out


def _history_problems(ctx: Ctx, item_id: str, entry: dict[str, Any], current: str) -> list[str]:
    tid = resolve.test_id(entry)
    # A slice item's entry may carry REJECTs given while it was its parent's (before a refine).
    owners = [item_id, item_id.split('/', 1)[0]] if '/' in item_id else [item_id]
    files = [f for owner in owners for f in verdict.reject_files(ctx.root, owner, str(entry['runner']), tid)]
    out = []
    if len(files) != len(entry['rejections']):
        out.append(f'{len(files)} REJECT verdict file(s), {len(entry["rejections"])} rejection(s) recorded')
    for n, r in enumerate(entry['rejections'], 1):
        shape = _rejection_shape(ctx, n, r)
        out += shape
        if shape:
            continue
        rel = next((p for owner in owners if (ctx.root / (p := verdict.reject_path(owner, str(entry['runner']), tid, n))
                                              ).exists()), verdict.reject_path(item_id, str(entry['runner']), tid, n))
        out += _reject_file_problems(ctx, rel, r)
    if not entry.get('accepted_by'):
        return out
    if entry.get('digest') != current:
        out.append(f"the entry's digest {entry.get('digest')} is not the test's current one ({current})")
    if len(entry['rejections']) >= 2 and (why := rewrite_problems(ctx, item_id, entry)):
        rel = verdict.record_path(item_id, records.rewrite_name(tid))
        out.append(f'accepted after {len(entry["rejections"])} REJECTs without a reviewed `rewrite {tid}` record '
                   f'({rel}): ' + '; '.join(why))
    return out


def _entry_problems(ctx: Ctx, ev: Evaluation, item_id: str, layer: str, entry: dict[str, Any]) -> list[str]:
    shape = _entry_shape(layer, entry)
    if shape:
        return shape
    ev.tests += 1
    found = resolve.resolve(ctx.root, entry)
    out = list(found.problems) + _history_problems(ctx, item_id, entry, found.digest)
    if entry.get('accepted_by'):
        acceptance = _acceptance(ctx, item_id, entry)
        out += acceptance
        if not acceptance and not found.problems:
            ev.accepted.add((item_id, resolve.test_id(entry)))
    return [f'{resolve.test_id(entry)}: {p}' for p in out]


# ---- one item ----

def _placement(reg: registry.Registry, item: dict[str, Any], released: set[str]) -> list[str]:
    item_id = str(item['id'])
    version = registry.item_version(item_id)
    if version is None:
        return ['a done item is named for its release (<version> or <version>/<slice>)'] if item['status'] == 'done' else []
    try:
        expected = registry.slice_for(version)
    except ValueError as err:
        return [str(err)]
    out = []
    if reg.slice_of[item_id] != expected:
        out.append(f'belongs in {expected.file}')
    if item['status'] == 'done' and version not in released:
        out.append(f'done, but {version} is not a CHANGELOG release of this line')
    if item['status'] == 'planned':
        # A plan id, never a release number: a release first registered as planned would land done with the kind it
        # was planned under, past the new item's floor.
        out.append('a planned item takes a plan id (lowercase words), never a release number')
    return out


def exemption_problems(ctx: Ctx, item_id: str, ex: dict[str, Any], sha: str, base_commit: str | None) -> list[str]:
    """Why a reviewed exemption's record does not hold (the review's sha: a commit HEAD descends from, and, for an
    exemption the base branch does not hold as it is, one that descends from the base branch's commit)."""
    rel = verdict.record_path(item_id, records.EXEMPTION)
    out, front = records.problems(ctx.root, rel, item_id=item_id, change=records.exemption_change(ex),
                                  proposer=ex['proposed_by'], reviewer=ex['reviewed_by'])
    if out:
        return out
    if front['sha'] != sha:
        return [f"reviewed_at {sha} is not the record's sha {front['sha']}"]
    out = gitio.sha_problems(ctx.git, sha)
    if not out and base_commit and not gitio.descends(ctx.git, base_commit, sha):
        out = [f"the sha {sha} does not descend from the base branch's commit {base_commit}"]
    return out


def _exemption(ctx: Ctx, item: dict[str, Any], base_item: dict[str, Any] | None,
               base_commit: str | None) -> tuple[list[str], bool]:
    """The exemption's problems, and whether its review holds."""
    ex = item['exemption']
    if not ex or ex['reviewed_by'] is None:
        return [], False
    base_ex = base_item.get('exemption') if base_item else None
    new = base_ex != ex   # not on the base branch as it is: its review must be of this change
    out = exemption_problems(ctx, str(item['id']), ex, str(ex['reviewed_at']), base_commit if new else None)
    if isinstance(base_ex, dict) and base_ex != ex and base_ex.get('reviewed_at') == ex['reviewed_at']:
        out.append('it changed since its review on the base branch: review it again (review-exemption)')
    return [f'exemption: {p}' for p in out], not out


def _item_problems(ctx: Ctx, ev: Evaluation, item: dict[str, Any], released: set[str],
                   base_item: dict[str, Any] | None) -> list[str]:
    shape = registry.item_problems(item)
    if shape:
        return shape
    out = _placement(ev.registry, item, released)
    exemption, reviewed = _exemption(ctx, item, base_item, ev.base_commit)
    out += exemption
    if reviewed:
        ev.exempted.add(str(item['id']))
    seen: set[str] = set()
    keys: dict[tuple[str, str], str] = {}
    for layer in ('unit', 'e2e'):
        for entry in item[layer]:
            tid = tid_of(entry) or repr(entry.get('runner'))
            if tid in seen:
                out.append(f'{tid}: registered twice')
            elif tid_of(entry) and (key := resolve.test_key(entry)) in keys:
                out.append(f'{tid}: names the same test as {keys[key]}')
            elif tid_of(entry):
                keys[resolve.test_key(entry)] = tid
            seen.add(tid)
            out += _entry_problems(ctx, ev, str(item['id']), layer, entry)
    return out


def _alias_problems(reg: registry.Registry) -> list[str]:
    owner: dict[str, str] = {}
    out = []
    for it in reg.items:
        for name in [str(it.get('id')), *it.get('aliases', [])]:
            if name in owner and owner[name] != it.get('id'):
                out.append(f'{it.get("id")}: alias {name!r} is also {owner[name]}\'s')
            owner.setdefault(name, str(it.get('id')))
    return out


# ---- against the base branch ----

@dataclass(frozen=True)
class Required:
    """A change that only a reviewed decision record lets through."""
    change: str
    against_base: bool               # it changes what the base branch holds (its record then descends from it)
    slices: tuple[str, ...] = ()     # a refine's slice items


def _rank(kind: object) -> int:
    return registry.KIND_RANK.get(str(kind), -1)


def seeded_kinds(releases: list[items.Release]) -> dict[str, str]:
    """The kind each release's own text gives (items.classify): the floor a kind may not sink below unreviewed."""
    return {r.version: items.classify(r)[0] for r in releases}


def _kind_part(now: object, seeded: str | None, was: object) -> tuple[str | None, bool]:
    """(``kind <reference> -> <now>`` when the kind sinks below the seeded one or the base branch's, against base)."""
    reference = max([k for k in (seeded, was) if k is not None], key=_rank, default=None)
    if reference is None or _rank(now) >= _rank(reference):
        return None, False
    return f'kind {reference} -> {now}', was is not None and _rank(now) < _rank(was)


def _required_for(item_id: str, cur: dict[str, Any] | None, base_item: dict[str, Any] | None,
                  reg: registry.Registry, seeded: dict[str, str]) -> Required | None:
    if cur is None:
        subs = tuple(sorted(i for i in reg.by_id if i.startswith(item_id + '/')))
        if not subs:
            return Required('removed', against_base=True)
        words = ', '.join(f'{s} ({reg.by_id[s].get("kind")})' for s in subs)
        return Required(f'refine -> {words}', against_base=True, slices=subs)
    version = registry.item_version(item_id)
    kind, against = _kind_part(cur.get('kind'), seeded.get(version or ''), base_item.get('kind') if base_item else None)
    against = against or (kind is not None and base_item is None)   # a new item's record is of this change too
    parts = [kind] if kind else []
    if base_item and base_item.get('status') == 'done' and cur.get('status') == 'planned':
        parts.append('status done -> planned')
        against = True
    return Required('; '.join(parts), against_base=against) if parts else None


def required_changes(reg: registry.Registry, base: gitio.Base | None, seeded: dict[str, str]) -> dict[str, Required]:
    base_items = base.registry.by_id if base and base.registry else {}
    # Every release after the gate's own (7.105.00) has the floor feature, whatever its text seeds and whatever the base
    # holds: a lower kind stands only with a reviewed decision (the proposal). The rule is keyed on the version, never on
    # the base, so a base from before the gate opens no door. Up to the gate, once the base branch has a registry, a
    # new item's floor is feature too; the bootstrap (7.105.00 itself, on a base with no registry) takes the seeded
    # kinds as they are. An item the base holds but not as done (planned) is new as a release.
    seeded = {v: 'feature' if registry.after_gate(v) else s for v, s in seeded.items()}
    floor = dict.fromkeys(seeded, 'feature') if base and base.registry is not None else seeded
    out: dict[str, Required] = {}
    for item_id, base_item in base_items.items():
        first = floor if base_item.get('status') != 'done' else seeded
        if (req := _required_for(item_id, reg.by_id.get(item_id), base_item, reg, first)) is not None:
            out[item_id] = req
    covered = {s for req in out.values() for s in req.slices}
    for item_id, cur in reg.by_id.items():
        if item_id in out or item_id in covered or item_id in base_items:
            continue
        if (req := _required_for(item_id, cur, None, reg, floor)) is not None:
            out[item_id] = req
    return out


def _decision(ctx: Ctx, ev: Evaluation, base: gitio.Base | None, item_id: str, req: Required) -> list[str]:
    rel = verdict.record_path(item_id, records.DECISION)
    # A change against the base branch: its record is of this change (after the fork), never a later one's words.
    out = _record_holds(ctx, base if req.against_base else None, item_id, rel, req.change)
    if out:
        return [f'{item_id}: {req.change} needs a reviewed decision record ({rel}): ' + '; '.join(out)]
    if req.slices:
        ev.refined[item_id] = list(req.slices)
    if req.slices or req.change == 'removed':
        ev.released.add(item_id)
    return []


def _record_holds(ctx: Ctx, base: gitio.Base | None, item_id: str, rel: str, change: str) -> list[str]:
    """Why a reviewed record does not hold: its words, its two sessions, its sha (HEAD's history, after the fork)."""
    out, front = records.problems(ctx.root, rel, item_id=item_id, change=change)
    if not out:
        out = gitio.sha_problems(ctx.git, front['sha'])
    if not out and base and base.fork and not gitio.descends(ctx.git, base.fork, front['sha']):
        out = [f"the sha {front['sha']} does not descend from the base branch's commit {base.fork}"]
    return out


def _entries_now(reg: registry.Registry, item_id: str) -> dict[str | None, dict[str, Any]]:
    """The item's test entries, or, for an item refined away, its slice items' entries."""
    owners = [reg.by_id[item_id]] if item_id in reg.by_id else [
        it for i, it in reg.by_id.items() if i.startswith(item_id + '/')]
    return {tid_of(e): e for it in owners for layer in ('unit', 'e2e') for e in it.get(layer, []) if isinstance(e, dict)}


def _entry_history(item_id: str, tid: str, was: dict[str, Any], now: dict[str, Any] | None) -> list[str]:
    out = []
    if now is not None and was.get('written_by') and now.get('written_by') != was.get('written_by'):
        out.append(f"written_by {now.get('written_by')} is not the base branch's {was.get('written_by')} "
                   '(the author of a test never changes)')
    before = was.get('rejections') or []
    kept = (now or {}).get('rejections') or []
    if len(kept) < len(before):
        out.append(f"{len(kept)} rejection(s), fewer than the base branch's {len(before)}")
    elif kept[:len(before)] != before:
        out.append("its rejections are not the base branch's followed by new ones (a REJECT is never rewritten)")
    return [f'{item_id}: {tid}: {p}' for p in out]


def _gone(ctx: Ctx, ev: Evaluation, base: gitio.Base | None, item_id: str, tid: str, n: int) -> list[str]:
    """A rejected test that left the registry: a reviewed ``retire <test id>`` record, or its item's removed or refine
    decision, lets it go; nothing else does."""
    if item_id in ev.released:
        return []
    rel = verdict.record_path(item_id, records.retire_name(tid))
    if not _record_holds(ctx, base, item_id, rel, f'retire {tid}'):
        return []
    return [(f'{item_id}: {tid}: its {n} rejection(s) left the registry: a reviewed `retire {tid}` record ({rel}) '
             'lets a rejected test go')]


def _history(ctx: Ctx, ev: Evaluation, base: gitio.Base | None, base_item: dict[str, Any]) -> list[str]:
    item_id = str(base_item.get('id'))
    now = _entries_now(ev.registry, item_id)
    out = []
    for layer in ('unit', 'e2e'):
        for entry in base_item.get(layer, []) or []:
            tid = tid_of(entry) if isinstance(entry, dict) else None
            if tid is None:
                continue
            if now.get(tid) is None and entry.get('rejections'):
                out += _gone(ctx, ev, base, item_id, tid, len(entry['rejections']))
            elif now.get(tid) is not None:
                out += _entry_history(item_id, tid, entry, now.get(tid))
    return out


def _base_problems(ctx: Ctx, ev: Evaluation, base: gitio.Base | None, seeded: dict[str, str]) -> list[str]:
    out = []
    for item_id, req in required_changes(ev.registry, base, seeded).items():
        out += _decision(ctx, ev, base, item_id, req)
    if base is not None and base.registry is not None:
        for base_item in base.registry.items:
            out += _history(ctx, ev, base, base_item)
    return out


def evaluate(ctx: Ctx, base: gitio.Base | None = None) -> Evaluation:
    reg = registry.load(ctx.root)
    ev = Evaluation(reg, list(reg.problems), base_commit=base.fork if base and base.registry is not None else None)
    text = changelog(ctx.root)   # read once: every rule below sees the same text
    releases = items.line_releases(text)
    released = {r.version for r in releases}
    version, error = package_version(ctx.root)   # read once
    ev.problems += _package_version_problems(version, error, releases)
    ev.problems += _section_problems(ctx, text, releases, version)
    ev.problems += [f'{v}: the CHANGELOG holds {items.heading_count(text, v)} headings for this release (the first is '
                    'read; remove the others)' for v in items.duplicates(text)]
    ev.problems += [f'{r.version}: a CHANGELOG release with no registry item (run `python3 scripts/feature_gate.py seed`)'
                    for r in releases if not items.covered(reg, r.version)]
    ev.problems += _alias_problems(reg)
    base_items = base.registry.by_id if base and base.registry else {}
    for item in reg.items:
        problems = _item_problems(ctx, ev, item, released, base_items.get(str(item.get('id'))))
        ev.problems += [f'{item.get("id")}: {p}' for p in problems]
    ev.problems += _base_problems(ctx, ev, base, seeded_kinds(releases))
    ev.problems += _bootstrap_problems(ctx, base)
    return ev


def _bootstrap_problems(ctx: Ctx, base: gitio.Base | None) -> list[str]:
    """Once the base has the gate, the line's history is bounded by the same bootstrap commit: another one (the allowed
    list added again, or the line rewritten) would move the bound and let releases out of the check."""
    if base is None or base.commit is None or base.registry is None:
        return []
    theirs = gitio.bootstrap_commit(ctx.git, base.commit)
    ours = gitio.bootstrap_commit(ctx.git, history_tip(ctx.git))
    if theirs is not None and ours is None:
        return [f'the line has no bootstrap commit, but the base does ({theirs})']
    if theirs is None or ours is None or theirs == ours:
        return []
    return [(f"the line's bootstrap commit {ours} is not the base's ({theirs}): the allowed list was added again or "
             'the line was rewritten')]
