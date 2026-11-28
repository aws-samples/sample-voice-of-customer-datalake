"""What the gate prints: the stats per kind, the evaluator's brief, and the per-sha run (a stub for now).

THE RUN (``feature_gate.py run --sha <sha> [--base <last good sha>] [--out <file>]``), not built yet: on every green
batch sha, release candidate and deploy it runs EVERY registered test (pytest nodes and vitest names in the gate's
suites, Playwright specs on the mock build and, where they can, the deployed stack), each through its pinned command
under scripts/suite-lock.sh, and writes one JSON report per sha to ``.cache/feature-gate/<sha>.json``:
``{sha, base, items: {<id>: {status: green|red|unproven, tests: {<test id>: green|red}}}, regressions: [<id>…]}``,
a regression being an item green on ``--base`` and red on ``--sha``, named with the commit range. Exit 0 when no item
is red, 1 when one is (whether a red item blocks the release, and who may waive it, is an open question for the
maintainers: docs/feature-tests/README.md), 3 while it is a stub.
Its next step: replay each accepted verdict's break (apply the recorded diff in a scratch tree, run the test, see it
red, restore), so the evaluator's written evidence is proven again on every build.
"""
from __future__ import annotations

from collections import Counter
from typing import Any

from . import ratchet, registry, resolve, verdict

STUB_EXIT = 3


COLUMNS = ('items', 'proven', 'gaps', 'exempt', 'elsewhere', 'uncertain')


def _row(name: str, values: list[int]) -> str:
    return f'{name:<14} ' + ' '.join(f'{v:>{len(c)}}' for v, c in zip(values, COLUMNS, strict=True))


def stats_lines(items: list[dict[str, Any]], gaps: dict[str, list[str]], exempted: set[str]) -> list[str]:
    """Per kind: items, proven (done, no gap), gaps (layers), exempt (a reviewed exemption that closes a layer),
    elsewhere (a reviewed platform-only / live-only exemption: checked elsewhere, closing nothing), uncertain kinds."""
    rows = [f'{"kind":<14} ' + ' '.join(COLUMNS)]
    totals = [0] * len(COLUMNS)
    for kind in registry.KINDS:
        of_kind = [it for it in items if it.get('kind') == kind]
        reviewed = [it for it in of_kind if str(it['id']) in exempted]
        row = [
            len(of_kind),
            sum(1 for it in of_kind if it.get('status') == 'done' and str(it['id']) not in gaps),
            sum(len(gaps.get(str(it['id']), [])) for it in of_kind),
            sum(1 for it in reviewed if not ratchet.elsewhere(it)),
            sum(1 for it in reviewed if ratchet.elsewhere(it)),
            sum(1 for it in of_kind if it.get('uncertain')),
        ]
        totals = [a + b for a, b in zip(totals, row, strict=True)]
        rows.append(_row(kind, row))
    rows.append(_row('total', totals))
    return rows


def brief_text(item: dict[str, Any], entry: dict[str, Any], section: str, found: resolve.Resolved) -> str:
    """What an evaluator starts from: the item, its CHANGELOG section, the test and its command. Nothing the author
    wrote about the test (who wrote it, why, or a rejection's reasons) is in it."""
    tid = resolve.test_id(entry)
    lines = [
        f'Item: {item["id"]} ({item["kind"]}): {item["title"]}',
        f'Design doc: {item["source"].get("doc") or "none named"}',
        '',
        'What the release says the user gets (CHANGELOG.md):',
        '',
        section.rstrip(),
        '',
        f'Test: {tid}',
        f'Runner: {entry["runner"]} ({resolve.layer_of(entry)} layer)',
        f'File: {resolve.entry_file(entry)}',
        f'Digest: {found.digest}',
        f'Command (from the repository root): {resolve.command(entry)}',
        *[f'Note: {n}' for n in found.notes],
        '',
        (f'Verdict file: {verdict.verdict_path(str(item["id"]), str(entry["runner"]), tid)} '
         '(copy docs/test-verdicts/TEMPLATE.md; break the feature in a scratch tree, never in the shared one)'),
    ]
    return '\n'.join(lines) + '\n'


def run_plan(items: list[dict[str, Any]], sha: str) -> list[str]:
    runners = Counter(e.get('runner') for it in items for layer in ('unit', 'e2e') for e in it.get(layer, []))
    return [
        f'feature_gate run --sha {sha}: not built yet (the full run per sha is the next slice; see report.py)',
        'it would run every registered test:',
        *[f'  {name}: {runners.get(name, 0)}' for name in ('pytest', 'vitest', 'playwright')],
    ]
