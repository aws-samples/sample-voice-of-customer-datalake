# Code audit detectors

Small scripts in `scripts/audit/` that find the dead and duplicated code the other gates miss: the patterns the
5.26–5.28 audits found by hand, turned into something you can re-run. Every one is a step of `scripts/validate.sh`
(see [In the gate](#in-the-gate)), so a change that adds a finding fails the gate. Run them before an audit or a
clean-up too, inspect every finding, then delete, consolidate or allowlist it with a reason.

```bash
npm run audit:code     # every detector (scripts/audit/run-all.sh): exit 0 clean, 1 findings, 2 error
npm run test:audit     # the detectors' own tests: pytest scripts/audit + node --test scripts/audit/*.test.mjs
npm run lint:audit     # ruff + pyright over scripts/audit
node scripts/audit/ts_locale_keys.mjs --help   # any one detector, with its own flags
```

| Detector | Finds | Time |
|---|---|---|
| `py_reachability.py` | Python no deployed entry point can execute | ~5 s* |
| `py_env_contract.py` | CDK env vars a function never reads, reads of vars never set, dead `os.environ.get` fallbacks | ~4 s* |
| `py_iam_contract.py` | grants on resources no code of the role names | ~3 s* |
| `py_route_callers.py` | API routes with no product caller | ~1 s |
| `py_stored_attrs.py` | DynamoDB attributes written but never read | ~3 s |
| `ts_reachability.mjs` | TS declarations and members nothing live reads | ~25 s |
| `ts_union_members.mjs` | string-union members nothing produces | ~17 s |
| `ts_locale_keys.mjs` | English locale keys nothing reaches (`--delete` removes them from all 9 locales) | ~1 s |
| `ts_api_callers.mjs` | SPA API functions only specs call, with their route | ~5 s |
| `clones_struct.py` / `.mjs` | renamed and near clones (Python / TS+JS) | ~9 s / ~4 s |
| `patterns.py` | re-implementations of helpers the platform already has | ~5 s |

\* plus one ~15 s offline synth, cached in `.cache/audit/` and shared by the three.

## How to run and read them

`run-all.sh` discovers detectors by a marker comment, `audit-detector:`, in the first 5 lines of a
`scripts/audit/*.py` / `*.mjs` file. Libraries (`audit_common.py`, `audit_common.mjs`, `py_assembly.py`, …),
fixtures and tests carry none. Each detector runs from the repo root on the real tree with
`--json .cache/audit/<name>.json`. The umbrella prints one row per detector (status, seconds, first report line)
and the first lines of each failing report; `.cache/audit/<name>.log` holds the full report and `summary.json`
the exit codes. `--list` prints what it would run. Env: `PYTHON_BIN`, `AUDIT_OUT`.

**The contract every detector keeps** (shared code in `audit_common.py` / `audit_common.mjs`; `contract.test.mjs`
checks `--help` on every discovered detector):

- `--help` prints the usage and exits 0. `--json` alone prints the JSON report (`{tool, summary, findings, …}`)
  INSTEAD of the text one; `--json PATH` writes it there AS WELL.
- The first text line is the summary: `<tool>: N finding(s); <what it scanned>`.
- Exit `0` clean, `1` findings, `2` the scan cannot be trusted: a bad allowlist, an unknown bundling step, or a
  vacuity guard (each detector checks it saw a plausible number of files, functions or symbols).
- One test-path rule for every tool: tests, specs, `test-support/`, `__fixtures__/`, `*-fixtures.ts` and dev
  mocks are not production code.
- Tests plant an instance in a temp dir, prove it is reported, and prove a legitimate look-alike is not.

**Allowlisting.** `scripts/audit/allowlists/<tool>.json` is `{"entries": [...]}`. Every entry needs a `reason`
(else exit 2). An entry that excuses nothing is reported as a `stale-allowlist` finding on a full run, so a list
cannot outlive the code it excuses. The entry shape depends on the tool:

| Tools | Entry | Matches |
|---|---|---|
| `py_*`, `ts_*` | `{"key", "kind"?, "reason"}` | the finding key; `*` = any characters (`*::AVATARS_ENABLED`), `kind:<kind>` = a whole documented pattern, `"kind"` narrows to one kind |
| `clones_struct.*` | `{"files": [globs], "name"?, "reason"}` | a group whose EVERY copy's file matches a glob (and, with `name`, one copy is that function) |
| `patterns.py` | `{"rule", "path" (glob), "scope"?, "contains"?, "reason"}` | one finding of a rule; `scope` is the enclosing function, so the entry survives line shifts |

Path globs use `**` for any directories and `*` within one segment. Keep clone globs to the exact files of the
group, so a new copy elsewhere is still reported. Reasons starting `OPEN (owner)` mark findings judged dead whose
removal is a product decision.

## Dead code

Finding keys carry no line numbers: `lambda/shared/api.py::read_earliest_date`,
`VocApiStack/ChatApiD29796E1::FEEDBACK_TABLE`, `GET /memory/stats`, `frontend:src/api/client.ts#api.getPersonas`,
`common:nav.oldLabel`.

### Python and its CDK contracts (`py_*.py`)

**How they see the deployed code.** `cdk.out` exists only after a Docker-bundled synth, so they do not read it.
`py_assembly.py` runs `bin/voc-datalake.ts` like `lib/test-support/synth-app.ts` does (offline, bundling
skipped; a lockstep test pins this) with a preload (`py_capture_bundling.cjs`) that records each asset's bundling
command, then replays its `cp` / `mkdir` / `if [ -f ]` / `find -prune` steps over the source tree. That gives each
Lambda's exact file set and import root (`api/projects.py` is `projects` in one bundle and `api.projects` in
another); an unknown step is exit 2, never a guess. A second synth flips every optional feature, so context-only
Lambdas and env vars are known. `--refresh` re-synthesizes; `--cdk-dir` audits another tree; `--no-allowlist`
reports everything.

| Detector | How | Kinds |
|---|---|---|
| `py_reachability.py` | AST reachability per bundle from the template's handler string, through imports, attribute chains, route / validator decorators, `import_module` (literal, constant or `f'agents.nodes.{kind}'`), `getattr` / ASL / conductor string dispatch, third-party overrides and dunders, to a fixed point. `__all__` is not a use. `--why PATH::QUALNAME` prints the chain that reaches a symbol. | `dead`, `test-only`, `unused-reexport`, `unreached-module`, `unbundled-module` |
| `py_env_contract.py` | template env per function vs the live code of its bundle | `set-never-read`, `read-never-set`, `read-never-set-fatal`, `dead-fallback`, `dead-fallback-empty` (the `''` import-under-test default, excused as a kind) |
| `py_iam_contract.py` | grants on tables, buckets, queues, topics, secrets, functions, state machines and user pools that no function of the role can name (env var, physical-name literal, self re-invoke); event sources, DLQs and notifications are wiring, never judged | `grant-unused` |
| `py_route_callers.py` | `@app.<verb>(path)` with no caller in the SPA, stream tools and plan writes, MCP tools, agent runtime, plan-step delegates, the static widget or Python delegates; the method is read near the literal | `no-caller`, `weak-caller-only`, `method-uncalled` |
| `py_stored_attrs.py` | attributes in `put_item` / `update_item` items, `Item=` builders, write-helper arguments and `SET` / `ADD` targets that no reader names (Python, stream, SPA, widget, JSON) | `written-never-read` |

**Why the reference tools miss these.** vulture matches bare names repo-wide (one `.clear()` keeps every
`clear`), counts `__all__` as a use and knows no entry points. Env names, grants, routes and attributes are strings
across a language boundary, which no linter joins; the CDK route tests check gateway ↔ handler, never handler ↔
caller.

**False-positive classes.** A name built at run time (`_int_env(name)`, a wildcard ARN) is not judged. A route
whose last segment is a typed union (`${action}`) needs an entry. `py_route_callers` counts any product literal, so
a route whose only caller is a DEAD SPA wrapper surfaces only after `ts_api_callers` removes the wrapper: run the
TS pass first.

### TypeScript (`ts_*.mjs`)

They load the repo's three programs (SPA `tsconfig.test.json`, stream `tsconfig.json`, CDK `tsconfig.json` +
`tsconfig.tools.json`) with the repo's own `typescript`, so types resolve as in CI. `--program` limits a run;
`--no-allowlist` reports everything.

- **`ts_reachability.mjs`** (`dead`, `test-only`, `write-only`, `dead-type`). One pass resolves every identifier
  into read, write, dynamic or escape edges (the work of `findReferences` for every declaration in one walk;
  `--evidence` re-checks each finding with the real one). Structural flow links members wherever a value moves
  between types (contextual types, arguments, returns, `as` / `satisfies`, spreads, `implements`, Array / Promise
  payloads); a value reaching `any`, an index signature or a library type counts as read. Liveness is a fixed point
  from the real entries (`main.tsx`, every `import()`, the stream handlers, `bin/`, the ts-node scripts), solved
  again with every spec as a root to tell `test-only`. Type-only members show with `--all-members`.
- **`ts_union_members.mjs`** (`never-produced`, `unused-member`). Every string literal is a produce, compare,
  key, decoder or table read; a producer counts when its contextual type is that union, a superset or a narrower
  union of its members. Template literals and Python f-strings are wildcards; backend Python / JSON strings produce.
- **`ts_locale_keys.mjs`** (`unreached-key`). Reuses `frontend/scripts/i18n-keys.mjs`, then literal, template
  (wildcard), prefix, `returnObjects` and plural-base matching over the production source.
- **`ts_api_callers.mjs`** (`test-only`, `uncalled`). `findReferences` on every request function in
  `frontend/src/api`, delegate chains solved to a fixed point, each finding with the route it requests.

**Why the reference tools miss these.** knip counts a spec import as a use, cannot see object members, and
`--production` still sees `api` itself used; tsc only reports unused locals.

**False-positive classes.** Text-pinned lockstep exports and test seams; CSS custom properties and Recharts
`dataKey` strings; platform-produced union values (`Notification.permission`); wire and decoder shapes; a call
through a computed member (`api[name]()`).

## Similar code

### `clones_struct.py` (Python) and `clones_struct.mjs` (TypeScript / JavaScript)

**Finds** the same statements and expressions in the same order with other names and literals: the renamed
clones jscpd cannot see, because it compares token text. Each module is parsed (`ast`, or the repo's
`typescript`). A fragment is a function body (signature included) or a window of `--window` (3) consecutive
statements, turned into a stream of node kinds with identifiers renamed per fragment (`i0…`, attributes `a0…`),
literals reduced to their type, and JSX tags / attribute names kept verbatim. It reports:

- **`function`**: identical streams;
- **`near-function`**: blinded 4-grams overlapping by at least `--similarity` (0.8, sizes within 30 %), clustered;
- **`statements`**: identical windows, adjacent ones merged.

Fragments under `--min-nodes` (Python 40, TS 60) are ignored, nested groups dropped, and only groups spanning two
files reported (`--same-file` adds more). Pass paths to scan only those (the vacuity floor is then 1 and the
allowlist is not judged stale); `--include-tests` adds tests. Read `[3] near-function, ~58 nodes, 3 copies,
similarity >= 0.89` as three functions of ~58 nodes whose least similar pair shares 89 % of its shape; look at what
differs (a limit, a message, a key) and decide: one helper, or a deliberate copy.

**False-positive classes.** Copies that must stay separate (`product_doc_extractor` is stdlib + boto3 only;
`plugins/_shared` vs `lambda/shared` are separate bundles; the SPA ↔ stream mirrors pinned by
`*.lockstep.test.ts`); request validators with per-route limits and wording; small React components sharing
Tailwind vocabulary; CDK builders repeating one construct per Lambda (the 20 KB IAM split). Tiny decorator-registered
functions (the seven `shared/api.py` exception handlers of 5.28) sit under the size floor and in one file: they show
with `--min-nodes 20 --same-file <file>`.

### `patterns.py`: known anti-patterns that already have a shared helper

A rule engine over `scripts/audit/pattern-rules.json`. A rule has an `id`, a `language` (`python`, `ts`, `json`),
`include` globs, `exclude` globs each with a `reason` (normally the helper's own home), a `message`, the helper to
`use`, and EITHER a line `regex` (comment lines and Python docstrings skipped; `"code_only": true` also blanks
Python string literals) OR a Python AST `predicate`. Python findings are reported once per rule and function.

| Rule | Finds | Use instead |
|---|---|---|
| `dynamo-paging-loop` | `LastEvaluatedKey` outside `shared/dynamo_paging.py` | `iter_query` / `query_all` (keep a loop only for a cursor, a budget, a cap or an early exit) |
| `decimal-plain-copy` | `int(v) if v == v.to_integral_value() else float(v)` | `shared.dynamo_values.plain` |
| `boto3-in-function` (AST) | `boto3.client/resource` built inside a function, not cached | a module-level client or a `shared.aws` getter |
| `lazy-getter-without-warm` (AST) | a handler module with a `global`-cached getter and no `warm_at_init` | `shared.warm_init.warm_at_init(getter, …)` |
| `swallowed-exception` (AST) | a broad `except` whose body only passes, continues or returns a constant | catch the specific error, or log it |
| `inline-admin-check` | `'admins' in …` outside `shared/api.py` / `project_access.py` | `shared.api.is_admin` / `require_admin` |
| `raw-bedrock-call` | `.converse(` / `.invoke_model(` outside `shared/converse.py` (documented exclusions) | `converse` / `converse_blocks` |
| `stream-raw-bedrock-command` | `new Converse*Command(` outside `lambda/stream/src/bedrock/` | the stream Lambda's bedrock module |
| `ui-tofixed` | `.toFixed(` in `frontend/src` | `formatDecimal(v, lang, digits)` |
| `ui-locale-less-format` | `toLocaleString()` / `toLocaleDateString(undefined, …)` | `numberFormat` / `dateUtils` with the app language |
| `local-date-formatter` | `new Intl.DateTimeFormat(`, `toLocale{Date,Time}String(` outside `utils/dateUtils.ts` | `formatDate` / `formatDateTime` / `formatTime` / `formatCalendarDay` |
| `raw-clipboard` | `navigator.clipboard.writeText` outside `hooks/useCopyToClipboard.ts` | `useCopyToClipboard` / `useCopiedFlag` |
| `locale-raw-count` | `{{count}}` in `public/locales` | `{{count, number}}` |

`datetime.now(UTC).isoformat()` (86 inline copies) has no rule on purpose: 39 tests patch module-local clocks, so
a shared clock is a test redesign. Options: `--rule ID` (repeatable), `--include-tests`, `--min-files`, `--rules`,
`--allowlist`. To add a rule: add it to `pattern-rules.json`, add a `CASES` entry (planted hit + look-alike) in
`test_patterns.py` (a rule without one fails), run it on the real tree and triage. A whole file that legitimately
does the thing gets a rule `exclude`; one finding gets an allowlist entry.

**False-positive classes.** A regex sees text: a variable named like the API, a test double, a string naming the
call. The predicates are heuristic (a getter cached in a non-standard way). Some copies are deliberate (a package
that cannot import `shared`, a fixed-locale PDF).

## Proof against the 5.26 → 5.28 audits

Run on 5.28's base (`37fc16f6`, the state the hand audits read) with `--no-allowlist`:

| 5.28 finding (deadpy.md / deadts.md / dupes.md) | Caught by | Result |
|---|---|---|
| deadpy §1a: 11 dead Python names (`fetch_with_retry`, `read_earliest_date`, `DecimalEncoder`, …) | py_reachability | 11 / 11 |
| deadpy §1a #3: six `plugins/_shared/__init__.py` re-exports | py_reachability `unused-reexport` | 6 / 6 |
| deadpy §1b: six test-only members (`ResponseCache.clear`, `BatchBump.reset`, …) | py_reachability | 6 / 6 |
| deadpy §2: persona notes PUT + DELETE, `GET /data-explorer/stats`, `GET /memory/stats` | py_route_callers | 4 / 4 (+ one more 5.28 removed) |
| routes held alive by dead SPA wrappers (`POST /projects/{id}/personas`, …) | ts_api_callers reports the wrappers; py_route_callers sees the routes once they are gone | 0 / 4 Python alone |
| deadpy §3a env vars and §3b dead fallbacks | py_env_contract | all |
| deadpy §3a grants (ChatApi feedback + aggregates, processor projects, webhook feedback) | py_iam_contract | 4 / 4 |
| deadpy §4 stored attributes (`last_run_finished_at`, `approved_at`) | py_stored_attrs | 2 / 2 |
| deadts §1a–§3 runtime and member findings | ts_reachability | all but two cosmetic type-only ones |
| deadts §1a API functions | ts_api_callers | all, with routes |
| deadts §1c union members (`Tone 'aim'`, `OverviewStep 'remix'`) | ts_union_members | 2 / 2 |
| deadts §1d locale keys | ts_locale_keys | 48 / 48, plus 51 the hand audit missed |
| dupes: five `plain()` copies, i18n script copies | clones_struct.py / .mjs | caught |
| dupes: 25 drain loops, 3 inline admin checks, 4 raw Bedrock calls, 2 clipboard copies, 7 date formatters, 15 `toFixed`, 3,122 raw `{{count}}` lines | patterns.py | all |

Not caught: the seven exception handlers (under the clone size floor), `useCopiedFlash` (a hook duplicate with no
shared call to match), and counts rendered without `formatCount` in JSX. Found that no hand audit had: the
`AVATARS_CDN_URL` env on the two persona jobs, and the memory extractor's missing queue env + grant (a page import
longer than one chunk stopped after chunk 1; fixed).

**On today's tree** every detector is clean; what remains is allowlisted with a reason: clones 22 (Python) and 48
(TS, 24 of them lockstep mirrors), patterns 47 (cursors, budgets, caps, early exits, documented cases), and the
dead-code detectors' lists of seams, lockstep pins and `OPEN (owner)` decisions.

## In the gate

Owner decision: every detector, plus the detectors' own tests and lint, is a `scripts/validate.sh` step, and
each fails the gate on exit 1 (findings) or 2 (could not run). `bash scripts/validate.sh --list` shows them as
`audit: …`.

| Step | Lane | Group | Runs on a track branch (`validate-affected.sh`) when |
|---|---|---|---|
| `audit: py_reachability + py_env_contract + py_iam_contract` | test, right after the vite build | `audit-py-synth` | `lambda/`, `plugins/`, the CDK app (`lib/`, `bin/`, `cdk*.json`) change |
| `audit: py_route_callers`, `audit: py_stored_attrs` | tsc | `audit-callers` | `lambda/`, `plugins/`, the SPA, the stream Lambda or `voc-datalake/schemas/` change |
| `audit: patterns` | tsc | `audit-patterns` | `lambda/`, `plugins/`, `voc-datalake/scripts/`, the SPA (incl. locales) or the stream change |
| `audit: clones_struct.py` | tsc | `audit-clones-py` | Python in `lambda/`, `plugins/`, `voc-datalake/scripts/` or `scripts/` changes |
| `audit: clones_struct.mjs` | tsc | `audit-clones-ts` | the SPA, the stream, the CDK app, or `scripts/*.mjs` change |
| `audit: ts_reachability` | lint (end) | `audit-ts` | the SPA, the stream or the CDK app change |
| `audit: ts_api_callers` | tsc | `audit-ts` | the SPA, the stream or the CDK app change |
| `audit: ts_union_members` | tsc | `audit-unions` | the same, plus `lambda/` / `plugins/` (their strings produce union members) |
| `audit: ts_locale_keys` | tsc | `audit-locale` | the SPA (source or `public/locales`) changes |
| `audit: detector tests`, `audit: detector lint (ruff + pyright)`, `audit: every detector has a step` | tsc | `audit-tools` | anything in `scripts/audit/` changes (that also runs every detector) |

The three synth-based detectors run in ONE step, one after another, so the cached synth (`.cache/audit/`) is built
once and never by two processes at the same time. The synth stages `frontend/dist`, so the step runs right after the
vite build in the test lane (before the vitest suites, so a failing suite cannot leave it unrun); the slowest,
`ts_reachability`, ends the lint lane, and the rest sit in the tsc lane,
which otherwise ends minutes before the others.
`audit: every detector has a step` fails when `run-all.sh --list` finds a detector no step runs, so a new detector
joins the gate with its own step (and its group in `validate-affected.sh`). CI runs them like every other step: they
need only Node, the CDK `node_modules` and `voc-datalake/.venv` (no Docker, no AWS).

**When a step fails**, its log (`.cache/validate/logs/<run>/`, tail printed by the gate) is the detector's report.
Read each finding, then either fix it (delete the dead code, call the shared helper, merge the clone) or, when it
is deliberate, add an entry to `scripts/audit/allowlists/<tool>.json` with a `reason` that says why (see
Allowlisting above). Do not loosen a detector's thresholds or rules to pass. To reproduce one locally:
`npm run audit:code`, or the single detector (`node scripts/audit/ts_locale_keys.mjs`).
`ts_reachability.mjs` (~25–80 s) is the slowest; its allowlist's `OPEN (owner)` entries stay until the owner decides
them.
