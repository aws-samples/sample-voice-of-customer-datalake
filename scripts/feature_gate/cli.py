"""scripts/feature_gate.py: the roadmap gate's command line (docs/feature-tests/README.md).

  check [--strict-base]                   static, seconds, no test imported (a validate.sh step, `features`)
  seed                                    add a registry item for every CHANGELOG release that has none
  baseline --init | --shrink              write the allowed gaps once; drop the ones that closed
  stats [--section <slice file>]          items, proven, gaps, exemptions and checks elsewhere per kind
  register <item> <test>                  the author registers a test (resolved, digested, not yet accepted)
  brief <item> <test>                     what an evaluator gets: the item's CHANGELOG section, the test, the command
  accept|reject <item> <test> --verdict <file>        an evaluator records a verdict
  exempt <item> --layer L --kind K --reason R         propose an exemption
  review-exemption <item> --record <file>             another session reviews it
  run --sha <sha>                         every registered test on one build (a stub: report.py)

A session is ``--session <id>``, else ``$FEATURE_GATE_SESSION``. The base branch is ``$FEATURE_GATE_BASE_REF``
(default origin/voc-multiplayer). Every command that writes the registry holds its lock
(``.cache/feature-gate/registry.lock``). Exit codes: 0 ok; 1 the check found problems; 2 a command refused (it says
why); 3 the run stub.
"""
from __future__ import annotations

import argparse
import contextlib
import fcntl
import os
import sys
from collections.abc import Iterator
from pathlib import Path
from typing import Any

from . import checks, gitio, items, ratchet, records, registry, report, resolve, verdict
from .checks import Ctx

ROOT = Path(__file__).resolve().parents[2]
LOCK = '.cache/feature-gate/registry.lock'


class Refused(Exception):
    """A command that will not do what it was asked (the message says why); exit 2."""


@contextlib.contextmanager
def registry_lock(root: Path) -> Iterator[None]:
    """One read-modify-write of the registry at a time, across every session of the tree (never through a link on
    ``.cache`` or ``.cache/feature-gate``)."""
    path = root / LOCK
    if (link := registry.link_on_path(path, root)) is not None:
        raise Refused(f'{link} is a link: the registry lock is never taken through one')
    path.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX)
        yield
    finally:
        os.close(fd)


def _session(args: argparse.Namespace) -> str:
    value = getattr(args, 'session', None) or os.environ.get('FEATURE_GATE_SESSION', '')
    if not value:
        raise Refused('no session: pass --session or set FEATURE_GATE_SESSION')
    if not registry.is_session(value):
        raise Refused(f'{value!r} is not a session id (letters, digits, ".", "_", ":", "-", parts joined by "/")')
    return value


def _strict(args: argparse.Namespace) -> bool:
    return bool(getattr(args, 'strict_base', False) or os.environ.get('GITHUB_ACTIONS'))


def _base(ctx: Ctx, args: argparse.Namespace, problems: list[str]) -> gitio.Base:
    given = getattr(args, 'base', None)
    if given:
        if not registry.is_sha(given):
            raise Refused(f'--base takes a commit sha (e.g. a last green one), not {given!r}')
        ctx.base_ref = given
    if ctx.base_ref == gitio.ZERO:
        if os.environ.get('GITHUB_ACTIONS') and os.environ.get('GITHUB_EVENT_NAME') == 'push':
            ctx.say('no base commit (the first push of a new branch): nothing to compare against')
        elif _strict(args):
            problems.append('the base ref is all zeros outside a push: no base to compare against (pass the base '
                            "branch's commit)")
        else:
            ctx.say('WARNING: the base ref is all zeros outside a push: nothing to compare against')
        return gitio.Base(ctx.base_ref, exists=True)
    base = gitio.read_base(ctx.git, ctx.base_ref)
    if base.note:
        ctx.say(base.note)
    if base.no_parent:
        lonely = f'the base ref {ctx.base_ref} is HEAD and HEAD has no parent here (a shallow clone?)'
        if _strict(args):
            problems.append(f'{lonely}: fetch the history (fetch-depth: 0) so the ratchet has a base to compare')
        else:
            ctx.say(f'WARNING: {lonely}: nothing to compare against (--strict-base makes this fail)')
    if not base.exists:
        if _strict(args):
            problems.append(f'the base ref {ctx.base_ref} does not exist (--strict-base or CI): fetch it '
                            '(git fetch origin) so the ratchet can compare against the base branch')
        else:
            ctx.say(f'WARNING: the base ref {ctx.base_ref} does not exist here: the ratchet ran without the base '
                    "branch's registry and allowed gaps (git fetch origin; --strict-base makes this fail)")
    problems += base.problems
    return base


def _allowed(ctx: Ctx) -> ratchet.Gaps | None:
    try:
        return ratchet.load_allowed(ctx.root)
    except ValueError as err:
        raise Refused(str(err)) from err


# ---- commands ----

def cmd_check(ctx: Ctx, args: argparse.Namespace) -> int:
    problems: list[str] = []
    base = _base(ctx, args, problems)
    ev = checks.evaluate(ctx, base)
    problems += ev.problems
    allowed = _allowed(ctx)
    if allowed is None:
        problems.append(f'no {ratchet.ALLOWED}: run `python3 scripts/feature_gate.py baseline --init` once')
    gaps = ev.gaps()
    problems += [f'{item_id}: an item after the gate ({registry.GATE}) never holds an allowed gap ({", ".join(layers)}): '
                 'it lands with its tests accepted'
                 for item_id, layers in sorted((allowed or {}).items())
                 if layers and registry.after_gate(registry.item_version(item_id))]
    base_gaps = ratchet.expand(base.allowed, ev.refined) if base.allowed is not None else None
    problems += ratchet.compare(gaps, ratchet.expand(allowed or {}, ev.refined), base_gaps)
    for p in problems:
        ctx.say(p)
    summary = (f'{len(ev.registry.items)} items, {ev.tests} tests registered ({len(ev.accepted)} accepted), '
               f'{ratchet.count(gaps)} gaps')
    ctx.say(f'feature_gate check: {summary}: {"FAILED, " + str(len(problems)) + " problem(s)" if problems else "ok"}')
    return 1 if problems else 0


def cmd_seed(ctx: Ctx, _args: argparse.Namespace) -> int:
    with registry_lock(ctx.root):
        reg = registry.load(ctx.root)
        added = items.seed(reg, items.line_releases(checks.changelog(ctx.root)))
        registry.save(ctx.root, reg)
    for it in added:
        ctx.say(f'  {it["id"]} {it["kind"]}{" (uncertain: " + it["uncertain"] + ")" if it.get("uncertain") else ""}')
    ctx.say(f'seeded {len(added)} item(s)')
    return 0


def cmd_baseline(ctx: Ctx, args: argparse.Namespace) -> int:
    with registry_lock(ctx.root):
        allowed = _allowed(ctx)
        ev = checks.evaluate(ctx, _base(ctx, args, []))
        gaps = ev.gaps()
        if args.init:
            if allowed is not None:
                raise Refused(f'{ratchet.ALLOWED} already exists: the baseline is written once (use --shrink)')
            ratchet.save_allowed(ctx.root, gaps)
            ctx.say(f'allowed gaps: {ratchet.count(gaps)}')
            return 0
        if allowed is None:
            raise Refused(f'no {ratchet.ALLOWED} to shrink (baseline --init first)')
        kept = ratchet.shrink(ratchet.expand(allowed, ev.refined), gaps)
        ratchet.save_allowed(ctx.root, kept)
    ctx.say(f'allowed gaps: {ratchet.count(kept)} (was {ratchet.count(allowed)})')
    return 0


def cmd_stats(ctx: Ctx, args: argparse.Namespace) -> int:
    ev = checks.evaluate(ctx, _base(ctx, args, []))
    chosen = ev.registry.items
    if args.section:
        try:
            chosen = ev.registry.in_slice(registry.slice_by_file(args.section))
        except ValueError as err:
            raise Refused(str(err)) from err
    for line in report.stats_lines(chosen, ev.gaps(), ev.exempted):
        ctx.say(line)
    return 0


def _find(reg: registry.Registry, item_id: str, test: str) -> tuple[dict[str, Any], dict[str, Any] | None]:
    item = reg.by_id.get(item_id)
    if item is None:
        raise Refused(f'no registry item {item_id}')
    entry = next((e for layer in ('unit', 'e2e') for e in item.get(layer, []) if checks.tid_of(e) == test), None)
    return item, entry


def cmd_register(ctx: Ctx, args: argparse.Namespace) -> int:
    session = _session(args)
    with registry_lock(ctx.root):
        reg = registry.load(ctx.root)
        item, existing = _find(reg, args.item, args.test)
        if existing is not None:
            raise Refused(f'{args.test} is already registered for {args.item}')
        try:
            fields = resolve.entry_from_id(args.test)
        except ValueError as err:
            raise Refused(str(err)) from err
        found = resolve.resolve(ctx.root, fields)
        if found.problems:
            raise Refused('; '.join(found.problems))
        entry: dict[str, Any] = {**fields, 'written_by': session, 'accepted_by': None, 'accepted_at': None,
                                 'digest': found.digest, 'verdict': None, 'rejections': []}
        item[resolve.layer_of(entry)].append(entry)
        registry.save(ctx.root, reg)
    ctx.say(f'registered {args.test} for {args.item} ({resolve.layer_of(entry)}); it counts once an evaluator accepts it')
    return 0


def _registered(reg: registry.Registry, item_id: str, test: str) -> tuple[dict[str, Any], dict[str, Any]]:
    item, entry = _find(reg, item_id, test)
    if entry is None:
        raise Refused(f'{test} is not registered for {item_id} (the author runs `register` first)')
    return item, entry


def cmd_brief(ctx: Ctx, args: argparse.Namespace) -> int:
    item, entry = _registered(registry.load(ctx.root), args.item, args.test)
    version = registry.item_version(str(item['id']))
    try:
        section = items.section(checks.changelog(ctx.root), version or '')
    except KeyError:
        section = f'(no CHANGELOG section for {item["id"]}: a planned item; read its design doc)'
    ctx.out.write(report.brief_text(item, entry, section, resolve.resolve(ctx.root, entry)))
    return 0


def _decide(ctx: Ctx, args: argparse.Namespace, outcome: str) -> tuple[registry.Registry, dict[str, Any], verdict.Verdict]:
    session = _session(args)
    reg = registry.load(ctx.root)
    _item, entry = _registered(reg, args.item, args.test)
    problems = checks.verdict_problems(ctx, args.item, entry, args.verdict, session, outcome)
    if problems:
        raise Refused('\n  '.join(['the verdict does not hold:', *problems]))
    v, error = checks.read_verdict(ctx, args.verdict)
    if v is None:
        raise Refused(str(error))
    return reg, entry, v


def cmd_accept(ctx: Ctx, args: argparse.Namespace) -> int:
    with registry_lock(ctx.root):
        reg, entry, v = _decide(ctx, args, 'ACCEPT')
        digest = resolve.resolve(ctx.root, entry).digest
        if len(entry['rejections']) >= 2 and (why := checks.rewrite_problems(ctx, args.item, entry)):
            rel = verdict.record_path(args.item, records.rewrite_name(args.test))
            raise Refused(f'{args.test} needs a rewrite: a reviewed `rewrite {args.test}` record ({rel}) clears it '
                          '(propose-change --rewrite, then another session review-change --rewrite): ' + '; '.join(why))
        entry.update(accepted_by=v.front['evaluator'], accepted_at=v.front['sha'],
                     verdict=os.path.normpath(args.verdict), digest=digest)
        entry.pop('needs_rewrite', None)
        registry.save(ctx.root, reg)
    ctx.say(f'accepted {args.test} for {args.item} by {v.front["evaluator"]} at {v.front["sha"]}')
    return 0


def _escalate(ctx: Ctx, line: str) -> None:
    ctx.say(line)
    ledger = os.environ.get('FEATURE_GATE_ESCALATIONS')
    if not ledger:
        return
    try:
        fd = os.open(ledger, os.O_WRONLY | os.O_APPEND | os.O_CREAT | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
    except OSError as err:
        ctx.say(f'feature_gate: cannot append to {ledger} ({err.strerror}): the escalate line is above')
        return
    with os.fdopen(fd, 'a', encoding='utf-8') as fh:
        fh.write(line + '\n')


def cmd_reject(ctx: Ctx, args: argparse.Namespace) -> int:
    with registry_lock(ctx.root):
        reg, entry, v = _decide(ctx, args, 'REJECT')
        entry['rejections'].append({'by': v.front['evaluator'], 'at': v.front['sha'],
                                    'digest': resolve.resolve(ctx.root, entry).digest, 'reasons': v.sections['Reasons']})
        entry.update(accepted_by=None, accepted_at=None, verdict=None)
        rewrite = len(entry['rejections']) >= 2
        if rewrite:
            entry['needs_rewrite'] = True
        registry.save(ctx.root, reg)
    ctx.say(f'rejected {args.test} for {args.item} ({len(entry["rejections"])} rejection(s)); its author fixes it')
    if rewrite:
        _escalate(ctx, f'escalate: {args.test}: rejected twice for {args.item}; a rewrite session makes the code testable')
    return 0


def _item(reg: registry.Registry, item_id: str) -> dict[str, Any]:
    item = reg.by_id.get(item_id)
    if item is None:
        raise Refused(f'no registry item {item_id}')
    return item


def cmd_exempt(ctx: Ctx, args: argparse.Namespace) -> int:
    session = _session(args)
    with registry_lock(ctx.root):
        reg = registry.load(ctx.root)
        item = _item(reg, args.item)
        ex = {'layer': args.layer, 'kind': args.kind, 'reason': args.reason, 'proposed_by': session,
              'reviewed_by': None, 'reviewed_at': None}
        problems = registry.exemption_problems(ex, item.get('kind'))
        if problems:
            raise Refused('; '.join(problems))
        item['exemption'] = ex
        registry.save(ctx.root, reg)
    ctx.say(f'proposed the exemption {records.exemption_change(ex)} for {args.item}; it counts once another session '
            f'reviews it ({verdict.record_path(args.item, records.EXEMPTION)}, review-exemption)')
    return 0


def cmd_review_exemption(ctx: Ctx, args: argparse.Namespace) -> int:
    session = _session(args)
    with registry_lock(ctx.root):
        reg = registry.load(ctx.root)
        ex = _item(reg, args.item).get('exemption')
        if not isinstance(ex, dict):
            raise Refused(f'{args.item} has no exemption to review (exempt first)')
        expected = verdict.record_path(args.item, records.EXEMPTION)
        if os.path.normpath(args.record) != expected:
            raise Refused(f'the record must be {expected}, not {args.record}')
        problems, front = records.problems(ctx.root, expected, item_id=args.item, change=records.exemption_change(ex),
                                           proposer=ex['proposed_by'], reviewer=session)
        if not problems:
            base = gitio.read_base(ctx.git, ctx.base_ref)
            ex_reviewed = dict(ex, reviewed_by=session)
            problems = checks.exemption_problems(ctx, args.item, ex_reviewed, front['sha'], base.fork)
        if problems:
            raise Refused('\n  '.join(['the record does not hold:', *problems]))
        ex.update(reviewed_by=session, reviewed_at=front['sha'])
        registry.save(ctx.root, reg)
    ctx.say(f'reviewed the exemption {records.exemption_change(ex)} for {args.item} ({session} at {front["sha"]})')
    return 0


def _decision_of(args: argparse.Namespace) -> tuple[str, str]:
    """(the session, the record) of a propose-change / review-change: the item's decision.md, or with ``--retire``
    the record that lets that rejected test leave the registry."""
    session = _session(args)
    if not registry.ID_RE.fullmatch(args.item):
        raise Refused(f'{args.item!r} is not an item id')
    for name in ('change', 'reason', 'tree', 'sha', 'retire', 'rewrite'):
        value = getattr(args, name, None) or ''
        if any(ord(c) < 32 or ord(c) == 127 for c in value):
            raise Refused(f'--{name} holds a newline or a control character: a record line takes one plain line')
    if getattr(args, 'retire', None) and getattr(args, 'rewrite', None):
        raise Refused('a record is either --retire or --rewrite')
    if getattr(args, 'retire', None):
        name = records.retire_name(args.retire)
    elif getattr(args, 'rewrite', None):
        name = records.rewrite_name(args.rewrite)
    else:
        name = records.DECISION
    return session, verdict.record_path(args.item, name)


def cmd_propose_change(ctx: Ctx, args: argparse.Namespace) -> int:
    session, rel = _decision_of(args)
    existing = records.read(ctx.root, rel)
    if existing is not None and existing.front.get('reviewer'):
        raise Refused(f'{rel} is reviewed: remove it in its own reviewed change (git rm) before proposing another')
    if [bool(args.change), bool(args.retire), bool(args.rewrite)].count(True) != 1:
        raise Refused('give one of --change "<the words check prints>", --retire <test id> or --rewrite <test id>')
    args.change = args.change or (f'retire {args.retire}' if args.retire else f'rewrite {args.rewrite}')
    records.write(ctx.root, rel, {'item': args.item, 'change': args.change, 'proposed_by': session}, args.reason)
    ctx.say(f'proposed {args.change!r} for {args.item} ({rel}); it holds once another session reviews it (review-change)')
    return 0


def cmd_review_change(ctx: Ctx, args: argparse.Namespace) -> int:
    session, rel = _decision_of(args)
    record = records.read(ctx.root, rel)
    if record is None:
        raise Refused(f'no decision record {rel} to review (propose-change first)')
    front = dict(record.front) | {'reviewer': session, 'sha': args.sha, 'tree': args.tree}
    records.write(ctx.root, rel, front, record.sections.get('Reasons', ''))
    problems, _ = records.problems(ctx.root, rel, item_id=args.item, change=front.get('change', ''), reviewer=session)
    problems = problems or gitio.sha_problems(ctx.git, args.sha)
    base = gitio.read_base(ctx.git, ctx.base_ref)
    if not problems and base.fork and not gitio.descends(ctx.git, base.fork, args.sha):
        problems = [f"the sha {args.sha} does not descend from the base branch's commit {base.fork}"]
    if problems:
        records.write(ctx.root, rel, record.front, record.sections.get('Reasons', ''))   # back as it was
        raise Refused('\n  '.join(['the review does not hold:', *problems]))
    ctx.say(f'reviewed {front.get("change")!r} for {args.item} ({session} at {args.sha})')
    return 0


def cmd_run(ctx: Ctx, args: argparse.Namespace) -> int:
    for line in report.run_plan(registry.load(ctx.root).items, args.sha):
        ctx.say(line)
    return report.STUB_EXIT


def _parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog='feature_gate.py', description='The roadmap gate (docs/feature-tests/README.md).')
    sub = p.add_subparsers(dest='command', required=True)
    check = sub.add_parser('check', help='static check of the registry, the tests, the verdicts and the ratchet')
    check.add_argument('--strict-base', action='store_true', help='fail when the base ref does not exist (CI does)')
    sub.add_parser('seed', help='add an item for every CHANGELOG release that has none')
    base = sub.add_parser('baseline', help='write the allowed gaps (--init, once) or drop the closed ones (--shrink)')
    mode = base.add_mutually_exclusive_group(required=True)
    mode.add_argument('--init', action='store_true')
    mode.add_argument('--shrink', action='store_true')
    stats = sub.add_parser('stats', help='items, proven, gaps, exemptions and checks elsewhere per kind')
    stats.add_argument('--section', help='one slice file, e.g. docs/feature-tests/phase1-2.json')
    for cmd in (check, base, stats):
        cmd.add_argument('--base', help='compare against this commit instead of the base ref (e.g. a last green sha)')
    propose = sub.add_parser('propose-change', help='propose a change a reviewed decision record lets through')
    propose.add_argument('item')
    propose.add_argument('--change', help="the program's own words for it, as check prints them")
    propose.add_argument('--reason', required=True)
    propose.add_argument('--session')
    review = sub.add_parser('review-change', help="review another session's proposed change")
    review.add_argument('item')
    for cmd in (propose, review):
        cmd.add_argument('--retire', help='a rejected test id: the record that lets it leave the registry')
        cmd.add_argument('--rewrite', help='a test rejected twice: the record that clears its rewrite bar')
    review.add_argument('--sha', required=True, help='the commit you reviewed it on (HEAD of the tree)')
    review.add_argument('--tree', required=True, help='git write-tree of the staged tree you saw (informational)')
    review.add_argument('--session')
    for name, text in (('register', 'the author registers a test'), ('brief', "an evaluator's brief"),
                       ('accept', 'record an ACCEPT'), ('reject', 'record a REJECT')):
        cmd = sub.add_parser(name, help=text)
        cmd.add_argument('item')
        cmd.add_argument('test')
        if name != 'brief':
            cmd.add_argument('--session', help='your session id (else $FEATURE_GATE_SESSION)')
        if name in ('accept', 'reject'):
            cmd.add_argument('--verdict', required=True)
    exempt = sub.add_parser('exempt', help='propose an exemption for an item')
    exempt.add_argument('item')
    exempt.add_argument('--layer', required=True, choices=registry.LAYERS)
    exempt.add_argument('--kind', required=True, choices=registry.EXEMPTION_KINDS)
    exempt.add_argument('--reason', required=True)
    exempt.add_argument('--session')
    rev = sub.add_parser('review-exemption', help="review another session's exemption")
    rev.add_argument('item')
    rev.add_argument('--record', required=True)
    rev.add_argument('--session')
    run = sub.add_parser('run', help='every registered test on one build (stub)')
    run.add_argument('--sha', required=True)
    return p


COMMANDS = {'check': cmd_check, 'seed': cmd_seed, 'baseline': cmd_baseline, 'stats': cmd_stats,
            'register': cmd_register, 'brief': cmd_brief, 'accept': cmd_accept, 'reject': cmd_reject,
            'exempt': cmd_exempt, 'review-exemption': cmd_review_exemption, 'propose-change': cmd_propose_change,
            'review-change': cmd_review_change, 'run': cmd_run}


def main(argv: list[str], root: Path | None = None, git: gitio.Git | None = None) -> int:
    tree = root or ROOT
    args = _parser().parse_args(argv)
    ctx = Ctx(tree, git or gitio.run_git(tree), sys.stdout, sys.stderr)
    try:
        ctx.base_ref = gitio.check_ref(os.environ.get('FEATURE_GATE_BASE_REF') or gitio.DEFAULT_BASE)
        return COMMANDS[args.command](ctx, args)
    except (Refused, ValueError) as err:
        ctx.err.write(f'feature_gate {args.command}: {err}\n')
        return 2


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
