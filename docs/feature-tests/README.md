# The roadmap gate: every released item proven by accepted tests

Every release this line shipped is a roadmap item, and every item that is done maps to the tests that prove it: a
unit or integration test that runs the real code path, and an end-to-end test of the user's flow. A test counts only
once an **independent evaluator** accepts it with written evidence: a session other than its author's (never the
author's own sub-agent), started fresh on the item and the test, which breaks the feature on purpose in a scratch
tree, sees the test go red, restores it and sees it green three times. The program that holds this is
`scripts/feature_gate.py` (the package `scripts/feature_gate/`); it runs in `scripts/validate.sh` as the `features`
step. See [CONTRIBUTING.md](../../CONTRIBUTING.md#the-roadmap-gate) for the workflow.

**What the program proves, and what it does not.** `check` is static: it reads the registry, the test files, the
verdicts and the records, and never imports or runs a test. It proves what it reads: that every named test exists in
its file; that it sits where `voc-datalake/pytest.ini` (testpaths, norecursedirs, `--ignore`, the class and function
patterns) or the mock list (`MOCK_SPEC_NAMES`) says the suite looks; that none of the skip forms listed below is in
its file; that each verdict and record is complete and names the right test, digest, sessions and commit. It does not
prove that pytest or vitest collects the test: a plugin, a `pytest_collection_modifyitems` hook, a vitest `include`
pattern or a skip computed at run time is not read. That the test really fails on the break and
passes three times is the evaluator's written evidence, not a run of the program's; the runtime proof comes with
`run` (below). **Independence is checked on declared session ids**: the program refuses an evaluator whose id shares
its root with the author's, but it cannot see who typed an id. The next step is a coordinator's ledger of the sessions
it started (who, when, for which item), against which `accept` checks the evaluator's id.

**Scope.** The registry holds this line's releases from 6.05.00 on. Not in it: the releases before 6.05.00, the
merged branches' own sections in the CHANGELOG (voc-wiki, voc-autonomous, voc-wiki-mut, main's), and the pending
items of the plan that no release holds yet (they come in as `planned` items, which need nothing until done).

## The files

| File | Holds |
|---|---|
| `phase1-2.json` | 6.05.00 to 7.14.00: phase 1 and phase 2 of the multi-workspace plan |
| `phase3a-4.json` | 7.15.00 to 7.49.00: phase 3a to 3g and phase 4, the merges of the other tracks |
| `product-7.5x-7.7x.json` | 7.50.00 to 7.75.03: the product releases (engineering agents, forms, the import wizard, …) |
| `phase3-switch.json` | 7.76.00 onward: phase 3g's erasure, phase 4's costs and 3h, the switch |
| `allowed-gaps.json` | the gaps allowed today; written by the program, it only shrinks |

A slice file is `{"slice": <name>, "from": <first version>, "until": <first version not in it, or null>,
"items": [...]}`, its items in version order. An item belongs in the slice of its version; `check` says when one is in
the wrong file, and reports a file that is not JSON as a problem. Every command that writes the registry holds one
lock (.cache/feature-gate/registry.lock in the tree), so two sessions never interleave a read-modify-write. It refuses a link on `.cache` or `.cache/feature-gate` and
opens the lock file without following links; the link check and the open are not one atomic step, so on a machine
other users can write to, keep the tree in a folder only you can write.

## Which releases

**Releases come from package.json's history; a feature never released through a version bump is outside the gate.**
A release is a version bump, and a bump is a commit: the line's releases are every version the root `package.json` has
held on this line since the gate came (the commits of `git log --first-parent -- package.json` from the line's
bootstrap commit, the one that added `allowed-gaps.json`, each read as JSON with `git show <commit>:package.json`, so
no formatting or diff setting changes what is read; the branches merged into the line keep their own bumps), plus the
version it holds now (the working tree, staged or not), each in the CHANGELOG's two-digit form (`7.104.0` is
`7.104.00`). In a pull_request run the line is the PR's own head (the merge ref's second parent): a PR into `main`
does not take `main`'s bumps for its own. A version a commit skipped (7.105 to 7.107) never existed and is no release.
**A pushed bump is never renumbered**: every bump after the bootstrap commit is above the one before it, and the first
is not before the gate (the bootstrap's own 7.105.00); a commit that goes back (7.60.0 after 7.105.0), or a
`package.json` in the working tree below the line's last release, is a problem. Before a push, renumbering is a rebase
that drops the old number from the first-parent line.
The walk is `<tip> --not <bootstrap>^@`, so the bootstrap commit is in it whether or not it bumped, and an allowed
list added again later keeps the oldest bound; a commit whose `package.json` version is not a plain
MAJOR.MINOR.PATCH (`7.105.0-hotfix`) is a problem, never skipped. Once the base branch has the gate, the line's
bootstrap commit must be the base's: another one (the list added again, the line rewritten) is a problem. What this
does not see: several bumps that were never committed, or were squashed into one commit, are one net change (only the
version that commit holds is a release), and the releases before the gate came are judged by their sections only.

`CHANGELOG.md` is only where each release's text lives: its section, from which the seed reads its kind. The reader
takes the run of unsuffixed `## [MAJOR.MM.PP] - <date>` headings from the top down to the first suffixed one
(`(voc-wiki)`, `(from main)`, `(voc-autonomous)`, `(voc-wiki-mut)`), `[Unreleased]` skipped; a heading inside a fenced
code block is no heading (CommonMark fences). **Every release must have exactly one section the reader finds**:
a release whose section is missing, or written in any other form (indented, `v7.105.00`, a setext or HTML heading, below
a suffixed heading), is a problem ("release X has no CHANGELOG section in the form the gate reads"), and so is a
version headed twice (only the first copy is ever read). A bracketed heading whose version is not a release number
(`## [7.105.00a]`) is a problem line, never a crash. `check` also requires `package.json`'s version to be the newest
section's. Sections the reader finds without a bump (renumbered patch releases, bumps made only on a merged branch) are
releases' text too, and items like any other. Each release needs an item (`check`); `python3 scripts/feature_gate.py
seed` adds an item for every section that has none, so a new release runs `seed` after writing its CHANGELOG section.
A released version can never be `planned`.

## An item

```json
{
  "id": "7.101.00",
  "aliases": ["7.101.0", "3h-S2"],
  "title": "The access gate decides a workspace's project from that workspace's own membership (…).",
  "source": {"changelog": "7.101.00", "doc": "docs/multi-workspace.md"},
  "kind": "plumbing",
  "status": "done",
  "unit": [],
  "e2e": [],
  "exemption": null
}
```

- `id`: the release (`7.101.00`), or `<version>/<slice>` when a release shipped several slices worth proving apart
  (`7.44.01/card-menu`; lowercase letters, digits and `-`); every release is covered by its own id or by its
  `<version>/…` items. A planned item always has a lowercase plan id (`plan-3h-s4`), never a release number; an item
  the base branch held as planned (or not done) that lands done is a new release and takes the feature floor.
- `aliases`: the semver form and the plan's slice id named in the release's first paragraph (`3h-S2`); no two items
  share one.
- `kind`: `feature` (a user gets something), `fix` (a bug fixed), `plumbing` (code with no behaviour change),
  `no-behaviour` (docs, tests or tooling only). The seed reads it from the release's first paragraph and its `###`
  subsections (`scripts/feature_gate/items.py`). Only the explicit phrasings seed a kind below feature: "no behaviour
  change" (plumbing) and "Tooling only:" (no-behaviour). Other words ("tests only", "internal only", "nothing changes
  for anyone", "plumbing") seed a feature with `"uncertain": "the words … suggest <kind>: a reviewed decision lets it
  stand"`; so do the texts that do not settle it (a merge, a patch release that names no fix). A lower kind than the
  seed's takes a reviewed decision (below); the seed never rewrites an item.
- `status`: `done` (released) or `planned`.
- `unit` and `e2e`: the test entries (below). `exemption`: null or one exemption (below).

## What each kind needs

| Kind | A done item needs |
|---|---|
| feature | an accepted unit test (pytest or vitest) and an accepted e2e test (Playwright) |
| fix | an accepted regression test, of either layer |
| plumbing | an accepted unit test, or a reviewed `no-behaviour` exemption (unit or all layers) |
| no-behaviour | a review: an accepted test, or a reviewed exemption |

Each layer a done item lacks is a **gap** (`unit`, `e2e`, `regression`, `review`). `allowed-gaps.json` lists the
gaps allowed today, and `check` fails on a gap not in it (a new release that is not proven), on a listed gap that
closed (run `python3 scripts/feature_gate.py baseline --shrink`, which only drops lines), and on a listed gap that the
base branch's own list does not hold. `baseline --init` wrote the list once, on 7.105.00, when no test was registered:
every done item's every layer.

## The seeded kind and the base branch

**The seeded kind is a floor.** `check` reads each item's release section again and computes the kind its text gives
(`classify`, `scripts/feature_gate/items.py`; a `<version>/<slice>` item takes its version's section). A kind ranked
below it (feature > fix > plumbing > no-behaviour) needs a reviewed decision record naming `kind <seeded> -> <now>`,
with or without a base branch: a kind cannot be lowered by hand to shrink what an item must prove. **A new item's floor
is feature** once the base branch has a registry: an item the base branch does not hold (a new release) stands below
feature only with a reviewed decision, the lower kind its text gives being a proposal. The one exception is the
**bootstrap**: 7.105.00 itself, which brings the registry while the base branch has none, takes the seeded kinds as
they are; every later release is held to the rule. A base counts as the bootstrap only when it holds no
`docs/feature-tests/` at all, its `package.json` version is before 7.105.0 and it does not descend from the line's
bootstrap commit; a base without a registry that is not all three is a problem (a registry that went missing, not one that never was), and so is a base with a registry but no
`allowed-gaps.json`. **The rules after the gate are keyed on the version, not on the base**: an item whose release is
after 7.105.00 has the feature floor and never holds an allowed gap (it lands with its tests accepted), whatever the
base holds, so a base from before the gate opens no door.

**What still rests on the local gate.** Pushes to this line run no CI workflow (the CI-on-push follow-up, CHANGELOG
7.105.00), so the rules that compare with the base branch, among them that the older items' allowed gaps only shrink,
hold on a push only because the local gate ran `check --strict-base` before it. A PR is checked by CI.


**The program judges with its own code.** `check` runs HEAD's copy of `scripts/feature_gate/`: a change to the
program and to the registry in one commit is judged by the changed program. Changes under `scripts/feature_gate/` go
through the repository's review gate like any code (the commit and tenets reviews of `validate.sh`, the PR review).
Running the base branch's copy of the program on HEAD's data in CI is a follow-up (CHANGELOG 7.105.00).

`check` also reads the base branch's registry and allowed list (`git show <commit>:docs/feature-tests/…`). The base is
`$FEATURE_GATE_BASE_REF` (default `origin/voc-multiplayer`, checked so it can never be read as an option; a public fork
sets it to its own default branch, e.g. `FEATURE_GATE_BASE_REF=origin/main`, or to the sha it last released), or `--base <sha>` (for
a run that compares against a last green sha; no scheduled run does so yet). The `features` step of `validate.sh` passes `--strict-base`
whenever that commit is here; when it is not fetched, the local gate prints a WARNING and runs without the base
branch's registry (run `git fetch origin` for the full check). CI sets `FEATURE_GATE_BASE_REF` itself
(`.github/workflows/quality-gates.yml`: a PR's base sha as the event reports it; a push's `before` commit, fetched
when the clone does not hold it; on a full clone of the tsc lane), and checks strictly. CI's push trigger is `main`
only: a push to this line (voc-multiplayer) is checked by the local gate before the push, and no CI workflow runs on
it (a follow-up, CHANGELOG 7.105.00); CI checks a PR. All zeros means
no base only on a CI push (a new
branch's first push); anywhere else it is a WARNING, and a problem under CI or `--strict-base`. A base that is HEAD
itself (the branch's own check after its push) is compared through HEAD's first parent, since a tree compared with
itself lets every change through; with no parent here (a shallow clone) that is a WARNING, and a problem under CI or
`--strict-base`. A base with no registry yet while HEAD's first parent has one is compared through that parent (so a
second commit cannot undo the first's registry unseen). In a `pull_request` run (`GITHUB_EVENT_NAME`), HEAD is the
PR's merge ref and the fork is taken against its second parent, the PR's own head; anywhere else, a local merge commit
too, against HEAD. For every item the base branch holds, it refuses, unless a
**reviewed decision record** allows it:

- a lower kind than the base branch's (or than the seeded one): `kind feature -> plumbing`;
- a done item made planned (`status done -> planned`; for a released version this is refused outright);
- a removed item (`removed`), or one replaced by its `<version>/<slice>` items (`refine -> 7.44.01/a (feature),
  7.44.01/b (plumbing)`, each slice with its kind: the **refine path**; with the decision, each slice item takes the
  refined item's allowed gaps, so splitting an item later is never blocked, and the record covers the slices' kinds);
- a test entry whose rejections are not the base branch's followed by new ones (a REJECT is never dropped or
  rewritten; a refined item's are looked for in its slices), or whose `written_by` changed;
- a rejected test that left the registry: it goes only with a reviewed `retire <test id>` record
  (`docs/test-verdicts/<item>/retire-<hash>.md`, `propose-change --retire <test id>`, `review-change --retire
  <test id>`), or with its item's reviewed removed or refine decision.

A raised kind needs no decision: its new gaps fail the ratchet until they are proven.

The decision record is `docs/test-verdicts/<item>/decision.md`, written like a verdict: front matter `item`, `change`
(the program's own words above, exactly), `proposed_by`, `reviewer` (another session: no shared root), `sha` and
`tree` (informational: the staged tree the reviewer saw), then `## Reasons`. Its sha is a commit HEAD descends from;
for a change against the base branch it also descends from where HEAD's history left the base branch (their
merge-base: a PR's own commits never descend from its target's later ones), so a record never carries over to a later
change of the same words (lowered, raised, lowered again: the third needs a new review). The same holds for an
exemption's record when the base branch does not hold the exemption as it is.

**What the history rules do not see.** They compare with the base branch, so a REJECT recorded and then erased
inside one change that has not landed yet (its registry line and its `reject-<n>.md` both removed before the push) is
invisible to them; the count of REJECT files keeps the two together, not their existence. Once a REJECT has landed on
the base branch, it can never be dropped or rewritten.
`propose-change <item> --change "<words>" --reason R` writes it with its proposer; another session runs
`review-change <item> --sha <HEAD> --tree <git write-tree>`. A base ref that does not exist here (not fetched) is told
apart from a base branch that has no registry yet: the first prints a WARNING, and fails under CI (`GITHUB_ACTIONS`)
or `check --strict-base`; the second is nothing to compare against only as the bootstrap (no `docs/feature-tests/`,
a `package.json` before 7.105.0, and not descending from the line's bootstrap commit), and a problem otherwise.

## A test entry

```json
{
  "runner": "pytest",
  "node": "voc-datalake/lambda/api/test/test_projects_gate.py::TestGate::test_member_reads",
  "written_by": "voc-h2/3",
  "accepted_by": "voc-eval-4/1",
  "accepted_at": "8c345fb96",
  "digest": "<sha256 of the test file, its conftest.py chain, configs and non-product imports>",
  "verdict": "docs/test-verdicts/7.101.00/pytest-1a2b3c4d5e6f.md",
  "rejections": []
}
```

- The runner's fields: `pytest` a `node`; `vitest` a `suite` (`frontend`, `stream` or `cdk`, from the file's
  package), a `file` and a `name` (`describe > it`, titles joined by ` > `); `playwright` a `spec`
  (`voc-datalake/frontend/e2e/tests/…`) and a `title` (`describe > test`). Paths are from the repository root, never
  absolute and in canonical form (no `./`, `//` or `..`). The CLI names a test by its id: the node,
  `<file>::<name>` or `<spec>::<title>`. Two entries of one item that name the same test (a pytest node with and
  without parameters) are refused.
- `unit` holds pytest and vitest entries, `e2e` holds Playwright ones.
- `written_by` is the author's session; `accepted_by` the evaluator's (null until accepted); `accepted_at` the sha
  the verdict was given on; `verdict` the verdict file; `digest` sha256 over the test's **whole file**, its suite's
  config (`voc-datalake/pytest.ini`, the package's `vitest.config.ts` and the `setupFiles` / `globalSetup` it names,
  the e2e `playwright.config.ts`) and, for pytest, every `conftest.py` from its folder up to the repository root and
  the repository modules it imports (one level), for vitest and Playwright the files it imports by a relative path
  (one level): a change to a neighbour, a fixture, a helper or the config is a change to what the test runs.
  **Product code is left out** (any file under the product roots below): it is what the test proves, so a product
  edit never voids an acceptance; the test's own side (its file, helpers, fixtures, conftest, configs) stays in. What
  it does **not** cover either: `__init__.py` files on the way to the test, `__mocks__` folders, plugins named in
  `pytest_plugins` or by `-p`, the modules those imports import in turn (deeper than one level), and anything the
  test reads at run time (data files, environment). An accepted entry's `digest` must be the test's current one.
  `rejections` keeps every REJECT (`{by, at, digest, reasons}`: nothing is hashed from a break's paths); each REJECT
  keeps its own verdict file (`<runner>-<hash>.reject-<n>.md`, saying REJECT and naming its rejection's evaluator, sha
  and digest), and `check` requires as many files as rejections. A second REJECT sets `"needs_rewrite": true`, prints the `escalate:`
  line and appends it to `$FEATURE_GATE_ESCALATIONS` when that names a file (opened without following a link; no path
  of anyone's machine is committed). After two REJECTs only a reviewed **`rewrite <test id>` record**
  (`docs/test-verdicts/<item>/rewrite-<hash>.md`: `propose-change --rewrite <test id>`, then another session's
  `review-change --rewrite <test id>`, on a commit after the last REJECT) clears the rewrite bar, whatever the digests
  say: `accept` refuses without it, and `check` refuses an acceptance made without it.
- A session id is `<root>/<part>…` (letters, digits, `.`, `_`, `:`, `-`); two sessions with the same root are the same
  author (`voc-h2` and `voc-h2/sub-1`), so an evaluator never shares its root with the author. Each command takes
  `--session <id>`, else `$FEATURE_GATE_SESSION`.

`check` resolves every named test **statically**, without importing it: a pytest node with `ast` under the rules of
`voc-datalake/pytest.ini` (`scripts/feature_gate/pytest_static.py`: the file under `testpaths`, never under
`norecursedirs` or an `--ignore`; a class pytest collects, matching `python_classes` and without `__init__`; a
function matching `python_functions`; one binding of the name in its scope, counting assignments, imports and loop
or `with` targets at any depth of `if` / `try` / `with` / `for`, since pytest keeps the last; a def under an `if` is
found, but one bound only under an always-false `if` (`if False:`, `if 0:`) is refused; no `__test__ = False`), a
vitest or Playwright title from its string literals (`scripts/feature_gate/jsscan.py`). It refuses a test that does
not exist, one that is skipped (`skip`, `skipif`, `xfail`, a plain or annotated `pytestmark`, a mark bound to a
module-level name first; `.skip`, `.skipIf`, `.runIf`, `.todo`, `.fixme`, `.fail`, a `test.skip()` in its body with no
condition or a literal one such as `true`, an options object `{ skip: true }` / `{ todo: true }`, a vitest context's
`ctx.skip()`, a skipping chain bound to a name first (`const later = describe.skip`), any of them on a describe around
it or at file level), a file holding a
`.only`, a title
built at run time (a template with `${…}`), a title named twice, and a Playwright spec the mock run does not take
(not in `MOCK_SPEC_NAMES`, `voc-datalake/frontend/e2e/lib/env.ts`). A conditional `test.skip(cond, …)` in a
Playwright test is a note in the brief. A skip decided at run time is not seen statically: `run` will prove it.

An accepted entry holds while its verdict does: the verdict file is at its place (under `docs/test-verdicts/`),
says ACCEPT, names this item, this test, its author and the evaluator in `accepted_by`, its sha is `accepted_at` and
a commit HEAD descends from (`git cat-file -e`, `git merge-base --is-ancestor`), its digest is the test's current one,
and it holds its evidence (below). A test edited after its acceptance stops counting until it is evaluated again.

## An exemption

```json
{"layer": "e2e", "kind": "no-user-flow", "reason": "…", "proposed_by": "voc-h2/3",
 "reviewed_by": "voc-eval-2/1", "reviewed_at": "8c345fb96"}
```

`layer` is `unit`, `e2e`, `regression` or `all`; `kind` is `no-user-flow` (the e2e layer only: nothing a person does
reaches it), `no-behaviour` (a no-behaviour or plumbing item), `platform-only` (it runs only on one platform this gate does not
run, such as a desktop build) or `live-only`. An exemption goes through
the same flow as a test: `exempt` proposes it (`proposed_by`, `reviewed_by` and `reviewed_at` null), and another
session reviews it with `review-exemption` and the record `docs/test-verdicts/<item>/exemption.md` (written like a
decision record, `change: exemption <layer> <kind> <first 12 hex digits of sha256 of its reason>`, so a changed
reason is a new exemption). Only a reviewed `no-user-flow` or `no-behaviour` exemption
closes a gap. **`platform-only` and `live-only` are "checked elsewhere"**: listed by `stats`, they close nothing, since
nothing in this gate runs them. An exemption changed after its review no longer matches its record and fails
`check` until it is reviewed again. Exemptions are rare.

## The verdicts

`docs/test-verdicts/<item>/<runner>-<hash>.md`, `<hash>` the first 12 hex digits of sha256 of the test id, one per
test of an item (a later verdict replaces it; git keeps the earlier). The format is
[docs/test-verdicts/TEMPLATE.md](../test-verdicts/TEMPLATE.md) (at most 256 kB; a heading inside a code fence is no
section). An ACCEPT has:

- every check true, the exact pinned command (`brief` prints it) and its reasons;
- a ```` ```diff ```` block whose **every file** is product code (`voc-datalake/lambda/**`,
  `voc-datalake/lambda/stream/src/**`, `voc-datalake/frontend/src/**`, `voc-datalake/lib/**`; never a test file, a
  `test/`, `tests/`, `__tests__/`, `test-support/`, `e2e/`, `fixtures/`, `__fixtures__/`, `__mocks__/` or `mocks/`
  folder or a `*fixtures*` file), exists at the verdict's sha
  (`git cat-file -e <sha>:<path>`), and changes at least one line that is not a
  comment, under a normal repository path (no `..`, `./`, `//` or leading `/`) (a file starts at `diff --git`, or at
  a `--- ` line followed by `+++ `, read only outside a hunk, whose length is counted from its `@@` line; the path is
  git's `a/` / `b/` path, or a plain `diff -u`'s with its tab and date dropped, so a `diff -u` of several files is
  read file by file);
- a Red block that names the test (a pytest node id, a vitest or Playwright title) and shows a failure;
- three Green blocks, each showing 1 passed and 0 skipped (pytest, Playwright); for vitest, whose `-t` reports the
  file's other tests as skipped, each shows exactly 1 passed, 0 failed and the test's own title on a passing line
  (skips are allowed for vitest only); no run of any runner shows a failed, error, flaky or rerun count;
- its `sha` and `tree` (below).

A REJECT has its command and reasons.

### Recording a verdict on a change not yet committed

A new release's tests are evaluated before it lands. The author stages the change (`git add`); the evaluator runs the
brief's command on that staged tree and records `sha` (the tree's HEAD, the commit the change will sit on) and `tree`
(`git write-tree`, the staged tree it evaluated); then the change, its verdicts and its registry entries are committed
together. `check` verifies that the sha is HEAD or an ancestor of it; `tree` is informational (what the evaluator
saw), not checked against anything.

## The program

| Command | Does |
|---|---|
| `check [--strict-base] [--base <sha>]` | the static check above, in seconds (`validate.sh --only features`) |
| `propose-change <item> --change "<words>" --reason R` | proposes a change only a reviewed decision record lets through |
| `review-change <item> --sha <HEAD> --tree <tree>` | another session reviews it |
| `seed` | an item for every release without one |
| `baseline --init` / `--shrink` | write the allowed gaps once / drop the ones that closed |
| `stats [--section docs/feature-tests/<slice>.json]` | items, proven, gaps, exempt, checked elsewhere and uncertain, per kind |
| `register <item> <test>` | the author registers a test: resolved, digested, not yet accepted |
| `brief <item> <test>` | what the evaluator gets: the item's CHANGELOG section, the test, its file and the pinned command; nothing from the author |
| `accept <item> <test> --verdict <file>` | records an ACCEPT; refuses the author's session or its sub-agent, a verdict without its evidence, and a test marked for a rewrite that has not changed |
| `reject <item> <test> --verdict <file>` | records a REJECT (its file `<runner>-<hash>.reject-<n>.md`); the second one marks the test for a rewrite |
| `exempt <item> --layer L --kind K --reason R` | proposes an exemption |
| `review-exemption <item> --record <file>` | another session reviews it |
| `run --sha <sha>` | the full run per build: a stub for now (TODO, `scripts/feature_gate/report.py`) |

Run from the repository root: `bash scripts/pinned.sh python scripts/feature_gate.py <command>`. The package:
`scripts/feature_gate/registry.py` (the files and the item schema), `scripts/feature_gate/items.py` (the CHANGELOG's
releases, the kinds and the seed), `scripts/feature_gate/resolve.py`, `scripts/feature_gate/pytest_static.py` and
`scripts/feature_gate/jsscan.py` (a test's static resolution, digest and command), `scripts/feature_gate/verdict.py`
(the verdict files), `scripts/feature_gate/records.py` (decision and exemption records), `scripts/feature_gate/gitio.py`
(the base branch and the recorded shas), `scripts/feature_gate/ratchet.py` (the gaps and the allowed list),
`scripts/feature_gate/checks.py` (the evaluation behind `check`), `scripts/feature_gate/report.py` (stats, the brief,
the run), `scripts/feature_gate/lock.py` (`scripts/suite-lock.sh`) and `scripts/feature_gate/cli.py`. Its tests:
`bash scripts/pinned.sh python -m pytest -q -c scripts/feature_gate/pytest.ini scripts/feature_gate/test`.

### The full run per build (TODO)

`run --sha <sha> [--base <last good sha>]` will run every registered test on one build, not only the changed items:
the pytest nodes and vitest names through their suites, the Playwright specs on the mock build and, where they can,
the deployed stack, each under `scripts/suite-lock.sh`. It writes `.cache/feature-gate/<sha>.json` (each item green,
red or unproven, each test's result) and names the regressions: the items green on `--base` and red on `<sha>`, with
the commit range. Whether a red item blocks the release, and who may waive it, is an open question for the
maintainers (CHANGELOG 7.105.00). Its next step after that is to
**replay each accepted verdict's break**: apply the recorded diff in a scratch tree, run the test, see it red, and
restore, so the evidence an evaluator wrote is proven again on every build. Until it is built, `run` prints what it
would run and exits 3.

## A suite at a time: `scripts/suite-lock.sh`

`bash scripts/suite-lock.sh <name> -- <command…>` runs the command holding an `flock` on `<folder>/<name>.lock`, so
only one session at a time runs that suite on a shared machine; a waiter is told who holds it (pid, start time, the
lock's name and the command's program, never its arguments) and waits. The folder is the user's own:
`$VOC_SUITE_LOCK_DIR`, else `$XDG_RUNTIME_DIR/voc-suite-locks`, else `/tmp/voc-suite-locks-<uid>`, made with mode 0700
and refused when it is a link, someone else's, or writable by group or others; the lock file is opened without
following links, mode 0600. As flock(1) does, the lock is taken, then the command is exec'd in its place with the
locked descriptor inherited: the lock lives exactly as long as the command (and any child it leaves holding the
descriptor), freed by the kernel when the last of them ends, however it ends; the exit code is the command's own.
`validate.sh` runs CodeQL under `suite-lock.sh codeql`.

```bash
bash scripts/suite-lock.sh voc-pytest -- bash scripts/pinned.sh python -m pytest -c voc-datalake/pytest.ini \
  --rootdir voc-datalake -p no:cacheprovider --no-cov -q voc-datalake/lambda/api/test/test_example.py
```
