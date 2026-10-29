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
| `py_layers.py` | layer libraries no attached function needs, few of them need, or the runtime already ships | ~5 s* |
| `py_route_callers.py` | API routes with no product caller | ~1 s |
| `py_stored_attrs.py` | DynamoDB attributes written but never read | ~3 s |
| `stack_outputs.py` | CloudFormation outputs scripts and docs read that no stack declares | ~1 s |
| `repo_contracts.mjs` | undocumented or unread CDK context keys, `cdk.json` flags for unused modules, npm scripts nothing runs or that name missing files, orphan script files | ~2 s |
| `doc_contract.py` | docs and steering that cite missing files, anchors, paths or routes, or a handler list out of step with `lambda/api/` | ~2 s |
| `ts_reachability.mjs` | TS declarations and members nothing live reads | ~25 s |
| `ts_union_members.mjs` | string-union members nothing produces | ~17 s |
| `ts_locale_keys.mjs` | English locale keys nothing reaches (`--delete` removes them from all 9 locales) | ~1 s |
| `ts_api_callers.mjs` | SPA API functions only specs call, with their route | ~5 s |
| `clones_struct.py` / `.mjs` | renamed and near clones (Python / TS+JS) | ~9 s / ~4 s |
| `patterns.py` | re-implementations of helpers the platform already has | ~5 s |
| `py_sfn_errors.py` | Step Functions `Retry` / `Catch` error names no Lambda of the task can report | ~1 s* |
| `py_shared_constants.py` | one constant value kept in several modules that ship together | ~3 s* |
| `py_dead_params.py` | defaulted parameters no call passes, arguments every call spells the same, dead JSON-config fallbacks | ~5 s |
| `py_doc_refs.py` | comments and docstrings naming code, paths or routes that do not exist | ~9 s* |
| `clones_struct.py --kind function` | small whole-function copies (from 8 nodes) whose copies could share one home | ~10 s* |
| `ts_prop_usage.mjs` | optional component props no production call site passes | ~8 s |
| `ts_css_tokens.mjs` | CSS custom properties, keyframes and classes nothing uses | ~1 s |
| `ts_mock_routes.mjs` | dev-mock routes no SPA call reaches, mock exports nothing imports | ~1 s |
| `ts_stale_refs.mjs` | comments naming a file, a test (a claimed pin) or an identifier that no longer exists | ~4 s |
| `ts_name_twins.mjs` | one small helper declared under the same name in two modules of a package | ~2 s |
| `ts_query_keys.mjs` | TanStack Query keys spelled inline where another file spells or owns them | ~2 s |

\* plus one ~15 s offline synth, cached in `.cache/audit/` and shared by every detector marked so.

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
group, so a new copy elsewhere is still reported. A reason may start `OPEN (owner)` to mark a finding judged dead whose
removal is a product decision; no allowlist holds one today.

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
| `py_route_callers.py` | `@app.<verb>(path)` with no caller in the SPA, stream tools and plan writes, MCP tools, agent runtime, plan-step delegates, the static widget or Python delegates; the method is read near the literal. The inverse: a request no route serves (`route_targets.py`, below) | `no-caller`, `weak-caller-only`, `method-uncalled`, `called-no-route` |
| `py_stored_attrs.py` | attributes in `put_item` / `update_item` items, `Item=` builders, write-helper arguments and `SET` / `ADD` targets that no reader names (Python, stream, SPA, widget, JSON) | `written-never-read` |

**`py_layers.py`: what the dependency layers ship.** `py_assembly` also records each `LayerVersion`: its
source dir and bundling command. Per layer, `requirements.txt` is resolved offline against the installed metadata
of the interpreter running the detector. In the gate that is `voc-datalake/.venv`, which CI installs from the
same files; `--site-packages DIR` points elsewhere. From that metadata it takes:

- each distribution's version and its `Requires-Dist`, with markers evaluated for the Lambda arm64 Python 3.14
  runtime and requested extras followed;
- its import names and size, from `RECORD`.

The `rm -rf /asset-output/python/…` steps of the bundling command say what the layer strips. For each function
attached to the layer, `py_reachability` gives the modules and defs that run. The detector collects the
third-party imports they execute: at module level, in class bodies and in live functions. `if TYPE_CHECKING`
imports do not count, and imports under an `ImportError` guard are optional. A live string equal to a layer
import name also counts (`BeautifulSoup(html, 'lxml')`). From those roots it adds the library modules they load,
through every unguarded import of the libraries' own code. That is how pydantic is reached through Powertools'
event handler while bs4 never pulls in lxml.

| Kind | Key | Means |
|---|---|---|
| `unused-distribution` | `<stack>/<layer>::<dist>` | no attached function reaches it |
| `narrow-distribution` | same | reached by under a third of the layer's functions and ≥ 2 MB (`NARROW_MB`): a split candidate |
| `runtime-provided` | same | the Lambda runtime ships it (`RUNTIME_PROVIDED` in `layer_dists.py`, checked against the image when Docker has it) and the layer does not strip it |
| `runtime-conflict` | `<layer>::<dist>-><runtime dist>` | a layer library requires a stripped runtime package at a version the runtime lacks |
| `version-mismatch` | `<layer>::<dist>` | the venv's version does not satisfy the requirement, or the venv lacks it (it is then not judged); refresh the venv with the layer requirement files |
| `missing-distribution` | `<function>::<import>` | the function's own live code imports a third-party name no attached layer and not the runtime provides |
| `unused-layer` | `<function>::<layer>` | the function reaches nothing the layer ships |

Sizes come from the venv's `RECORD`, so they are those of the venv's platform. They are deterministic per
platform and used only against the 2 MB line. Real arm64 sizes are in
[lambda-sizing.md → Dependency layers](lambda-sizing.md#dependency-layers).

**`called-no-route`: a call with no route.** The requests are the probes of `frontend/mock-coverage.json` (one per
SPA `fetchApi` call site; `check:mock` keeps it complete) and the stream Lambda's internal-API calls (`method:` and
`path:` literals in one object). A request is served by a Powertools route (the handlers' decorators and the routers
a handler mounts with `include_router`) or by an EXPLICIT API Gateway method in `lib/stacks/*.ts` (the stream behind
`/chat/stream`, webhooks, `/mcp/global`; the CDK route tests pin the Python ones to their handler). A `{proxy+}` is
not a route: it passes the path to a Lambda that answers 404, which is how the Settings → Sources "Test" button
failed from #115 until 5.34. Key: `POST /integrations/{}/test` (the call site's own path template).

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

- **`ts_reachability.mjs`** (`dead`, `test-only`, `write-only`, `dead-type`, `never-written`). One pass resolves every identifier
  into read, write, dynamic or escape edges (the work of `findReferences` for every declaration in one walk;
  `--evidence` re-checks each finding with the real one). Structural flow links members wherever a value moves
  between types (contextual types, arguments, returns, `as` / `satisfies`, spreads, `implements`, Array / Promise
  payloads); a value reaching `any`, an index signature or a library type counts as read. Liveness is a fixed point
  from the real entries (`main.tsx`, every `import()`, the stream handlers, `bin/`, the ts-node scripts), solved
  again with every spec as a root to tell `test-only`. Type-only members show with `--all-members`.
  `never-written` is the reverse of `write-only`, a dead knob: an optional member of an exported `*Options` /
  `*Props` / `*Deps` / `*Config` shape under `lib/` or `scripts/` that live code reads but that nothing, production or
  test, sets and no other type's member flows into (5.34: `CollectOptions.maxPolls`, always its `?? 90`).
- **`ts_union_members.mjs`** (`never-produced`, `unused-member`). Every string literal is a produce, compare,
  key, decoder or table read; a producer counts when its contextual type is that union, a superset or a narrower
  union of its members. Template literals and Python f-strings are wildcards; backend Python / JSON strings produce.
- **`ts_locale_keys.mjs`** (`unreached-key`). Reuses `frontend/scripts/i18n-keys.mjs`, then literal, template
  (wildcard), prefix, `returnObjects` and plural-base matching over the production source.
- **`ts_api_callers.mjs`** (`test-only`, `uncalled`). `findReferences` on every request function in
  `frontend/src/api`, delegate chains solved to a fixed point, each finding with the route it requests.
- **`ts_stale_refs.mjs`** (`missing-file`, `missing-test`, `missing-identifier`). Reads every comment range of
  the SPA, the stream Lambda and `frontend/mock-*.js` (the AST's leading / trailing comment ranges) sentence by
  sentence. A path-shaped token must resolve from the file's directory, a package root, the repo root, or as a
  suffix of a `git ls-files` path (a `.js` ESM specifier through its `.ts`); a test token, or any path in a
  sentence that claims a pin (`pinned by`, `lockstep`, `fails when`), is `missing-test`: a guard someone believes
  in that does not exist (5.34 found two: `API_AGENT_LIMITS` and `API_WORKFLOW_LIMITS` named lockstep tests that
  never existed, and the cron bound had drifted). In production files a backticked camel / snake identifier of 5+
  characters must appear in some code of the repo (identifiers and string literals of TS/JS, Python without
  comments, JSON incl. the locale catalogues, shell, YAML; never `scripts/audit/` itself). Skipped: URLs, globs,
  runtime artefacts (`config.json`, `mcp.json`), product names (`Node.js`), history clauses (`was`, `old`,
  `renamed`, `used to`, … near the token), absence statements (`no \`X\``, `rather than a \`X\``) and plural
  forms judged by their base. Key `<path>::<token>`.
- **`ts_name_twins.mjs`** (`identical`, `near`, `same-name`). Per package (SPA, stream), every top-level
  function / arrow with a lowercase or `use*` name; a name declared in 2+ production modules is `identical`
  (same renamed-token shape, `clones_struct.mjs`'s normaliser), `near` (>= 0.7 of its shape 4-grams, bodies of 8+
  nodes) or `same-name` (different bodies, one exported: two meanings of one name invite the wrong import).
  PascalCase components and `normalize*` seams are skipped. Key `<pkg>:<name>`.
- **`ts_query_keys.mjs`** (`inline-shared`, `inline-beside-constant`). In SPA production code, an array literal
  with a string head as a `queryKey:` value or a QueryClient call's first argument is a key site; one held by a
  declaration named `*Key` / `*Keys` / `*KEY` is a key constant. The head is the first element, joined with the
  second when that is a string too. Reported: a head written inline in 2+ files, or inline while a constant owns
  it. One page repeating its own private key is the `projectQueryKeys.ts` rule and is not reported. Shared keys
  live in `frontend/src/api/queryKeys.ts`. Key `qk:<head>`.

**Why the reference tools miss these.** knip counts a spec import as a use, cannot see object members, and
`--production` still sees `api` itself used; tsc only reports unused locals.

**False-positive classes.** Text-pinned lockstep exports and test seams; CSS custom properties and Recharts
`dataKey` strings; platform-produced union values (`Notification.permission`); wire and decoder shapes; a call
through a computed member (`api[name]()`). For `ts_stale_refs`: a file of another repository or a sample path
named in prose (allowlisted with the reason). For `ts_name_twins`: per-domain helpers that share a verb on
purpose (`toDraft` in each editor's draft module).

**Known false negatives.** `ts_locale_keys` counts any production literal equal to a key, so a key whose name is
also an ordinary string elsewhere (`'issues'` in a stop-word list) looks reached: 5.34 found
`categories:issues` / `issuesWithPercent` that way, unread by any `t()`.

### Contracts and stale pointers (`py_sfn_errors.py`, `py_dead_params.py`, `py_doc_refs.py`)

- **`py_sfn_errors.py`** (`unknown-error-name`). Every state machine of the synthesized templates is decoded (`Fn::Join`
  pieces and `DefinitionSubstitutions` resolved), each Task joined to its Lambda, and every `ErrorEquals` name that
  is not `States.*` / `Lambda.*` / `Sandbox.*` must be the `__name__` of an exception class defined in that
  Lambda's bundle, or a builtin. A module-level alias (`Old = New`) does not count: Lambda reports
  `type(error).__name__`. It found the research and document workflows retrying on `BedrockThrottlingException`
  while the code raised `BedrockThrottlingError`, so the retry never fired (fixed in this release). Key
  `<stack>/<state machine>::<error name>`.
- **`py_dead_params.py`** (`dead-default`, `constant-arg`, `config-fallback`). For functions whose bare name is
  defined once in `lambda/` + `plugins/` (tests included), not decorated and never escaping as a value or a string,
  every call is bound to the parameters. It reports a default no call overrides, a parameter every production
  call passes the same literal (and no test varies), and `cfg.get('key', default)` on a bundled JSON file that
  always has the key. Key `<path>::<qualname>(<param>)`. ruff `ARG` checks the body, not the callers.
- **`py_doc_refs.py`** (`missing-name`, `missing-path`, `missing-route`). Comments and docstrings of production Python: a back-ticked
  identifier or `name()` (≥ 4 characters) must exist as a code token anywhere in the repo or the installed
  libraries; a repo path must exist; `VERB /path` must match a handler route, a shared router or a gateway method
  of the synthesized app (`{proxy+}` matches deeper paths). A sentence saying the thing is gone (`used to`,
  `removed`, `legacy`, …) is history and skipped. Key `<path>::<reference>`.
**`ts_prop_usage.mjs`: component props by call site** (`never-passed`, `test-only-prop`; advisory
`always-passed`). The SPA program's checker resolves every JSX element to its component (through imports, not by
name), so each top-level PascalCase component's repo-declared optional props are judged against what its call
sites pass (attributes, non-empty children). `never-passed`: no site passes the prop, so its default branch is the
only one that runs. `test-only-prop`: only specs pass it (the other branch exists for the tests). Skipped: a
component with a production `{...spread}` site, one used as a value (`component={X}`, a table of components), one
handed to a library attribute that clones it (Recharts `tick={<X />}`), and the exports of a module loaded with
`import()`. `always-passed` (every one of at least 3 production sites passes an optional prop) is printed and in
the JSON `advisory`, never a finding: an optional prop with a sensible default is often right even when today's
callers all set it; make it required when the fallback is dead weight (`ConfirmModal.confirmLabel`). Key
`src/components/X/X.tsx#X.prop`.

**`ts_css_tokens.mjs`: unused CSS** (`unused-property`, `unused-keyframes`, `unused-class`). Reads
`frontend/src/**.css`: custom properties, `@keyframes`, plain class selectors and `@utility`. A use is a `var()`
or keyframe name in an ordinary declaration, an `@apply`, or the token in the production source (`src/`,
`index.html`, `public/`). Tailwind v4 `@theme` variables count through the utilities they generate
(`--color-foo` ← `bg-foo` / `text-foo` / `border-foo` / …, `--animate-foo` ← `animate-foo`, `--font-*`,
`--radius-*` ← `rounded-*`, `--shadow-*`); Tailwind only generates a utility it sees written in full, so a
template (`` `text-${tone}` ``) uses none, while a template head keeps a plain class family (`` `badge-${t}` ``) or
a property family (`` `var(--chart-${n})` ``) alive. A definition's own value is an edge, solved as a fixed point:
`--card-fg` read only by a dead `--color-card-fg` is dead too. Library namespaces (`--xy-*`, `.react-flow__*`,
`--tw-*`) and preflight's variables are never judged. Key `css:--x`, `css:@keyframes x`, `css:.x`.

**`ts_mock_routes.mjs`: the dev mock against the SPA** (`mock-only`, `mock-export-unused`). Every route of
`frontend/mock-*.js` (`'METHOD /path'` keys and literals, `{method, pattern}` objects, `['METHOD', /re/]` rows,
`pathname === '/x'`, other `/^\/…/` regexes with any method) is matched against the probes of `mock-coverage.json`,
which `check:mock` keeps equal to the SPA's call sites (`fetchApi` and raw `fetch` of the API base). A domain
module's patterns are relative to its mount, so a route matches the probe path or any `/`-suffix of it. A template
call (`` `${pinPath(…)}/${action}` ``) needs one probe per action. `mock-export-unused`: an `export` of a mock
module no other frontend file imports (knip's project excludes the mocks). The presigned-upload fakes (`/mock-*`)
and `/__mock/*` controls are never judged. Key `mock-server.js::GET /path`, `mock-x.js::export name`.

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
| `utc-now-iso` | `datetime.now(UTC).isoformat()` outside `shared/timestamps.py` | `shared.timestamps.now_iso()` (tests freeze it with `shared.test.clock.frozen_clock` or by patching the caller's `now_iso`) |
| `ts-inline-is-record` | the plain-object guard spelled inline (`typeof x === 'object' && x !== null && !Array.isArray(x)`) | SPA `lib/typeGuards` / stream `lib/is-record` `isRecord` |
| `ts-local-request-init` | a module-local `const post / put / del / patch = (…): RequestInit =>` | `api/requestKit` `post` / `put` / `patch` / `del` |
| `locale-manual-plural` | `{{plural}}` or `file(s)` in `public/locales` (English pluralisation inside a string) | `_one` / `_other` forms |
| `ts-manual-plural` | a `plural:` option passed to `t()` | pass `count` |
| `ts-json-equality` | `JSON.stringify(a) === JSON.stringify(b)` | `lib/sameJson` |

Options: `--rule ID` (repeatable), `--include-tests`, `--min-files`, `--rules`,
`--allowlist`. To add a rule: add it to `pattern-rules.json`, add a `CASES` entry (planted hit + look-alike) in
`test_patterns.py` (a rule without one fails), run it on the real tree and triage. A whole file that legitimately
does the thing gets a rule `exclude`; one finding gets an allowlist entry.

**False-positive classes.** A regex sees text: a variable named like the API, a test double, a string naming the
call. The predicates are heuristic (a getter cached in a non-standard way). Some copies are deliberate (a package
that cannot import `shared`, a fixed-locale PDF).

### `clones_struct.py --kind function`: small whole functions that could share one home

The default run keeps a 40-node floor so statement windows stay meaningful. `--kind function` looks only at
whole functions, from 8 nodes (`--min-nodes` overrides), with literals and attribute names kept verbatim and only
local names renamed: `def _now(): stamp = datetime.now(UTC); return stamp.isoformat()` matches its renamed copy,
but two table getters reading different env vars do not. A group is reported only when one copy could serve every
site (`py_bundles`, from the synthesized app: one copy's file ships in every bundle of the others, or every copy
ships `lambda/shared`), so `product_doc_extractor`'s deliberate stdlib copies never show. Its own allowlist is
`allowlists/clones_struct_functions.json` (same entry shape); the entries left are per-module seams the tests
patch (table getters, cached Cognito clients) and the `lambda_handler` entry points.

### `py_shared_constants.py`: one constant value in several modules that ship together

A module-level UPPER_SNAKE constant (literal, or `re.compile` / `frozenset` / `tuple` / `set` of one) with the
same value in two or more production modules, when one copy could serve every site (the same `py_bundles` rule).
A same-name group is always judged; a renamed group only when the value is key-shaped (a regex, a container, a
string with `#` `/` `:` `.` or a space, or ≥ 12 characters). Numbers, booleans and short strings are never judged.
Kinds: `imported-already` (a site already imports the module holding another copy), `same-name`, `renamed`. Key
`<names>::<files>`. It is what moved the writer/reader key contracts (`METRIC#daily_*`, ballot rows, erasure jobs,
memory import prefixes, failure messages the logs page matches) into one `lambda/shared` home. False positives:
equal values that mean different things (`'1.0.0'`, `'USER#'` in two tables); those are allowlisted with the reason.

## Repository contracts

Strings that tie a script, a doc or a config to the code they describe, which no compiler joins.

### `stack_outputs.py`: outputs read that no stack declares

**Finds** (`read-not-declared`, key = the output key) a CloudFormation output a `*.sh`, `*.mjs`, `*.js`, `*.ts`,
`*.py`, `*.yml` or `*.md` file reads by key when no `new cdk.CfnOutput(<scope>, '<Key>'` in `voc-datalake/lib` or
`bin` declares it. `describe-stacks` answers an unknown key with nothing, so the script falls back or writes an
empty value and nothing fails: `deploy.sh` and `test-api.sh` read `ChatStreamUrl` for years after the stream moved
behind API Gateway. A read is a jq / JMESPath `OutputKey==…` comparison, Python `.get('OutputKey') == '…'`, or a
literal argument of a helper that compares `OutputKey` to one of its parameters (`cfn_output "$STACK" ApiEndpoint`,
`_stack_output(cf, stack, 'FeedbackTableName')`). A template-literal id (`` `InboundEmailDkimRecord${n}` ``)
declares its prefix; `contains("X")` matches any declared key containing X. There is no reverse pass: most outputs
are for operators reading the console.

### `repo_contracts.mjs`: context keys, flags, npm scripts, script files

Cheap insurance, one pass (key in brackets):

| Kind | Finds |
|---|---|
| `context-undocumented` [`context:<key>`] | a key the CDK app reads (`tryGetContext('<key>')` or a `*_CONTEXT_KEY` constant) that no doc (`docs/`, `README.md`, `CONTRIBUTING.md`, `.kiro/steering/`) names |
| `context-unread` [`context:<key>`] | a key `cdk.context.json` sets that no CDK TypeScript names |
| `flag-module-unused` [`flag:<flag>`] | a `cdk.json` feature flag for a module nothing in `lib/` / `bin/` imports (5.34 dropped six `cdk init` leftovers; `app-baseline.test.ts` showed the templates unchanged) |
| `script-missing-file` [`<package.json>::<script>`] | an npm script naming a file that does not exist, after its `cd <dir> &&` steps |
| `script-uncalled` [`<package.json>::<script>`] | an npm script no CI workflow, doc, hook, script or other npm script runs (lifecycle scripts excepted). A second spelling of a gate step drifts from the gate, and a bare `cdk deploy <Stack>` skips the API stage refresh; documented dev shortcuts (`watch`, `synth`, `diff`, `test:ui`, `i18n:*`) are allowlisted with a reason |
| `script-file-orphan` [`<path>`] | a file under a `scripts/` directory whose name no other file mentions |

### `doc_contract.py`: what the docs claim about the tree

One pass over `docs/*.md`, `README.md`, `CONTRIBUTING.md` and `.kiro/steering/*.md` (fenced blocks skipped;
the git-ignored history notes are not read). Key `<doc>::<kind>::<target>`:

| Kind | Finds |
|---|---|
| `broken-link` | a relative link to a missing file, or a `#anchor` no heading (GitHub slug) or `<a id>` of the target has |
| `missing-path` | a backticked repo path (a `/` plus an extension, or a trailing `/`) no file or directory ends with. Docs write paths from the root, from `voc-datalake/` or from a package's `src/`, so the tail is judged. Placeholders and globs, one-word prefixes (`raw/`), build outputs, host names and lines saying the path is gone are skipped |
| `route-not-served` | a `\| VERB \| `/path` \|` table row no Powertools route and no explicit API Gateway method serves (the matcher of `called-no-route`); a `{proxy+}` row needs some route under it, and a second path in a cell may continue the first |
| `handler-list` | a doc naming at least 5 `*_handler.py` files names one `lambda/api/` lacks (`extra:`), or, naming at least three quarters of them, omits one (`missing:`) |
| `uncited-file` | a `*.md` file name no directory of the repo holds |

Run on 5.34's base it found the steering's `GET /logs` / `GET /logs/errors` and `POST /integrations/{source}/test`
rows, the handler tables missing `ballots`, `radar` and `s3_import`, three moved or never-created paths, the finished
migration plan in `plugin-architecture.md`, and the uncommitted audit notes `code-audit.md` cited. What stays
allowlisted names files of other repositories (the KiroCrew website the design system links to, a customer repository's UI
component file) and an S3 prefix.

### cdk-nag suppressions that suppress nothing (`voc-datalake/lib/nag-suppressions.test.ts`)

Not a script but a CDK test (it needs cdk-nag's own logger, which only an in-process synth offers), so it runs in
`test:cdk`. It synthesizes `bin/voc-datalake.ts` twice, the default deploy and every context-gated feature on, with
`AwsSolutionsChecks` given one extra `additionalLoggers` entry. Each `onSuppressed` names the resource, rule and
finding; the entry that consumed it is found the way cdk-nag picks it (the FIRST entry, resource-level before
stack-level, whose rule matches and whose `appliesTo`, when it has one, matches the finding). An entry, or one
`appliesTo` item, that consumed nothing in either synth fails the test. An entry is identified by rule, reason and
item, so a list shared by several stacks is judged across all of them. 5.34 removed what it found: an IAM5 entry for
a wildcard the bucket-notifications handler no longer has (and its IAM4 twin, shadowed by the shared
basic-execution entry), the briefing DLQ's SQS3 entry (cdk-nag recognises a DLQ), two state-machine `:*` regexes
for Lambdas invoked by exact ARN, and the Translate `Resource::*` entry that the Comprehend one always shadowed (one
entry now names both); the product-doc extractor's narrow entry moved before the shared S3 list so its reason is the
one used. Removing a suppression changes only template `Metadata`, so `baseline.json` was regenerated with the
name inventory unchanged.

Its sibling `voc-datalake/lib/utils/nag-suppressions.test.ts` checks the `{ regex }` items of
`lib/utils/nag-suppressions.ts`: each compiles the way cdk-nag compiles it, is anchored (`^…$`), escapes every
literal `.` before `Arn>` / `Name>` and every literal `*`, and accepts or refuses a table of finding ids. Until 5.34
those regexes sat in single-quoted strings, which drop a backslash, so `\.` was any character, `/\*` was "zero or more
slashes" and `:\*` matched the bare ARN: the raw bucket's `<RawDataBucket.Arn>/*` entry silently covered every
prefix grant (`avatars/*`, `prototypes/*`, `memory-imports/*`, …). Those prefix grants now have their own entry, one
anchored item per prefix.

## Proof against the 5.26 → 5.28 audits

Run on 5.28's base (`37fc16f6`, the state the hand audits read) with `--no-allowlist`. The three 5.28 hand audits
(dead Python, dead TypeScript, duplicated code) were working notes and are not in the repo; each row says what they
found:

| 5.28 hand-audit finding | Caught by | Result |
|---|---|---|
| Dead Python: 11 dead names (`fetch_with_retry`, `read_earliest_date`, `DecimalEncoder`, …) | py_reachability | 11 / 11 |
| Dead Python: six `plugins/_shared/__init__.py` re-exports | py_reachability `unused-reexport` | 6 / 6 |
| Dead Python: six test-only members (`ResponseCache.clear`, `BatchBump.reset`, …) | py_reachability | 6 / 6 |
| Uncalled routes: persona notes PUT + DELETE, `GET /data-explorer/stats`, `GET /memory/stats` | py_route_callers | 4 / 4 (+ one more 5.28 removed) |
| routes held alive by dead SPA wrappers (`POST /projects/{id}/personas`, …) | ts_api_callers reports the wrappers; py_route_callers sees the routes once they are gone | 0 / 4 Python alone |
| Dead Python: CDK env vars no code reads, and dead `os.environ.get` fallbacks | py_env_contract | all |
| Unused grants (ChatApi feedback + aggregates, processor projects, webhook feedback) | py_iam_contract | 4 / 4 |
| Stored attributes never read (`last_run_finished_at`, `approved_at`) | py_stored_attrs | 2 / 2 |
| Dead TypeScript: declarations and members nothing live reads | ts_reachability | all but two cosmetic type-only ones |
| Dead TypeScript: SPA API functions only specs call | ts_api_callers | all, with routes |
| Dead TypeScript: union members nothing produces (`Tone 'aim'`, `OverviewStep 'remix'`) | ts_union_members | 2 / 2 |
| Dead TypeScript: locale keys nothing reaches | ts_locale_keys | 48 / 48, plus 51 the hand audit missed |
| Duplicates: five `plain()` copies, i18n script copies | clones_struct.py / .mjs | caught |
| Duplicates: 25 drain loops, 3 inline admin checks, 4 raw Bedrock calls, 2 clipboard copies, 7 date formatters, 15 `toFixed`, 3,122 raw `{{count}}` lines | patterns.py | all |

Not caught: the seven exception handlers (under the clone size floor), `useCopiedFlash` (a hook duplicate with no
shared call to match), and counts rendered without `formatCount` in JSX. Found that no hand audit had: the
`AVATARS_CDN_URL` env on the two persona jobs, and the memory extractor's missing queue env + grant (a page import
longer than one chunk stopped after chunk 1; fixed).

**On today's tree** every detector is clean; what remains is allowlisted with a reason: clones 22 (Python) and 48
(TS, 24 of them lockstep mirrors), patterns 47 (cursors, budgets, caps, early exits, documented cases), and the
dead-code detectors' lists of seams and lockstep pins.

## In the gate

Owner decision: every detector, plus the detectors' own tests and lint, is a `scripts/validate.sh` step, and
each fails the gate on exit 1 (findings) or 2 (could not run). `bash scripts/validate.sh --list` shows them as
`audit: …`.

| Step | Lane | Group | Runs on a track branch (`validate-affected.sh`) when |
|---|---|---|---|
| `audit: py_reachability + py_env_contract + py_iam_contract + py_layers + py_sfn_errors + py_shared_constants + py_doc_refs + clones_struct.py --kind function` | test, right after the vite build | `audit-py-synth` | `lambda/` (layer requirement files included), `plugins/`, the CDK app (`lib/`, `bin/`, `cdk*.json`) change |
| `audit: py_route_callers`, `audit: py_stored_attrs` | tsc | `audit-callers` | `lambda/`, `plugins/`, the SPA, the stream Lambda or `voc-datalake/schemas/` change |
| `audit: patterns` | tsc | `audit-patterns` | `lambda/`, `plugins/`, `voc-datalake/scripts/`, the SPA (incl. locales) or the stream change |
| `audit: clones_struct.py` | tsc | `audit-clones-py` | Python in `lambda/`, `plugins/`, `voc-datalake/scripts/` or `scripts/` changes |
| `audit: py_dead_params` | tsc | `audit-clones-py` | the same |
| `audit: clones_struct.mjs` | tsc | `audit-clones-ts` | the SPA, the stream, the CDK app, or `scripts/*.mjs` change |
| `audit: stack_outputs` | tsc | `repo` | always (the `repo` group runs on every track branch; ~1 s) |
| `audit: repo_contracts` | tsc | `repo` | always (~2 s) |
| `audit: doc_contract` | tsc | `repo` | always (~2 s) |
| `audit: ts_stale_refs`, `audit: ts_query_keys` | tsc | `audit-ts` | the SPA (mocks included), the stream or the CDK app change (a Python-only change that strands a TS comment is caught by the full gate) |
| `audit: ts_name_twins` | tsc | `audit-clones-ts` | the SPA, the stream, the CDK app, or `scripts/*.mjs` change |
| `audit: ts_reachability` | lint (end) | `audit-ts` | the SPA, the stream or the CDK app change |
| `audit: ts_api_callers` | tsc | `audit-ts` | the SPA, the stream or the CDK app change |
| `audit: ts_union_members` | tsc | `audit-unions` | the same, plus `lambda/` / `plugins/` (their strings produce union members) |
| `audit: ts_locale_keys` | tsc | `audit-locale` | the SPA (source or `public/locales`) changes |
| `audit: detector tests`, `audit: detector lint (ruff + pyright)`, `audit: every detector has a step` | tsc | `audit-tools` | anything in `scripts/audit/` changes (that also runs every detector) |
| `audit: ts_prop_usage`, `audit: ts_css_tokens`, `audit: ts_mock_routes` | tsc | `audit-ts` | the SPA (incl. its CSS, dev mock and `mock-coverage.json`), the stream or the CDK app change |

The synth-based detectors (the CDK contracts, and the ones that ask `py_bundles` which files ship together or read the gateway's routes) run in ONE step, one after another, so the cached synth (`.cache/audit/`) is built
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
`ts_reachability.mjs` (~25–80 s) is the slowest.
