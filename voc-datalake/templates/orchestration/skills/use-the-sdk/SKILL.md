---
name: use-the-sdk
description: "A gate before writing any new function, class, module, dependency or abstraction, against hand-rolled code and over-building. Climbs a ladder from delete-it through stdlib, platform native, existing dependency and official SDK before custom code. Also for simplifying or reducing a diff."
source: "ai-skill-factory 2.0.0 (Amit Deol), skills/use-the-sdk"
license: MIT
adapted: "The spec-loader step reads the repository's STANDARDS.md and INFRA.md with read_file. API verification reads the installed source (node_modules, site-packages) since the sandbox has no network; a new dependency is decided before the first command (install_dependencies runs once, first). Slash references name library skills; references to unvendored skills (deploy-on-aws, scaffolding-audit) are dropped. The report goes in the finish."
---

Decide the smallest correct way to build what your task asks.

Ladder concept adapted from [DietrichGebert/ponytail](https://github.com/DietrichGebert/ponytail)
and [addyosmani/agent-skills](https://github.com/addyosmani/agent-skills) (both MIT).

The `anti-slop` skill finds hand-rolled code and dead abstraction after it exists. This skill runs before, so the
code is never written. Cheaper by an order of magnitude.

## Step 0: Load Project Standards

If the repository has a STANDARDS.md (or INFRA.md), read it with `read_file`: its package managers, dependency
policy and size limits, and INFRA.md's approved services and SDKs. Else the defaults below. Cite those files rather
than restating them.

## Step 1: Understand Before Climbing

The ladder shortens the solution. It never shortens the reading.

- [ ] Read the code the change touches, end to end, including callers
- [ ] Find the existing pattern for this concern in this repo
- [ ] Confirm the requirement, not your reconstruction of it

A minimal change in the wrong place is a second bug, not a small diff.

## Step 2: The Ladder

Stop at the first rung that holds. Record which rung you stopped on.

| # | Rung | Test |
|---|---|---|
| 1 | Does it need to exist? | Is this speculative, or required by the current request? |
| 2 | Already in this repo? | Search for the helper, type, or pattern before writing one (`run` `grep -rn <name> <dir>`, or `list_files` and `read_file`) |
| 3 | Standard library? | `itertools`, `dataclasses`, `pathlib`, `functools`, `Intl`, `URL`, `crypto` |
| 4 | Platform or framework native? | DB constraint over app check, CSS over JS, framework middleware over custom |
| 5 | Already-installed dependency? | Read the lockfile before adding anything |
| 6 | Official vendor SDK? | boto3, aws-cdk-lib L2, Powertools, Stripe SDK, Linear SDK |
| 7 | Minimum custom code | Only now. Smallest thing that satisfies the request |

Two rungs both work? Take the higher number only when it is more correct on edge cases,
not because it is more interesting.

## Step 3: Never Hand-Roll These

Custom implementations here are MUST findings. Use the named alternative.

| Concern | Use |
|---|---|
| Crypto, hashing, signing, JWT verify | Platform crypto library, vendor SDK verifier |
| Auth flows, token refresh, session rotation | Identity provider SDK (Cognito, Auth0, OIDC client) |
| Retry, backoff, jitter, circuit breaking | SDK built-in retry config, `tenacity`, Powertools |
| Date, time, timezone, duration arithmetic | `datetime` + `zoneinfo`; `date-fns` or `Intl.DateTimeFormat` in Node (TC39 `Temporal` ships behind `--harmony-temporal` as of Node 25, not yet stable; check `typeof Temporal` before relying on it unflagged) |
| CSV, YAML, TOML, INI, XML parsing | `csv`, `defusedcsv` for output, `PyYAML.safe_load`, `tomllib` |
| Schema validation and coercion | Pydantic, Zod. Never a hand-written `is_valid()` |
| Pagination, waiters, presigned URLs | SDK paginators, waiters, presigner |
| Connection pooling, rate limiting | Driver pool config, API Gateway throttling, SDK client reuse |
| ID generation | `uuid`, `secrets`, `ulid`, database identity column |
| Structured logging and tracing | `structlog`, Powertools Logger, OpenTelemetry SDK |
| Concurrency primitives | `asyncio`, `concurrent.futures`, framework task queue |
| Diffing, templating, path handling | `difflib`, Jinja2, `pathlib`, `path` |

For AWS specifically: prefer a managed service over code that emulates it. Infrastructure as code has its own
ladder, so use it rather than improvising: the `cdk-engineer` skill for CDK, the `terraform-engineer` skill for
Terraform. See also the `aws-serverless` skill.

## Step 4: Verify the API Before Calling It

Rung 6 fails badly when the method does not exist. Before first use of any SDK surface:

- [ ] Import resolves in this environment
- [ ] Method name and signature confirmed against the installed source (`node_modules/`, the virtual environment's
      `site-packages/`, the type stubs), since the sandbox has no network to fetch docs
- [ ] Return shape confirmed, not assumed
- [ ] Version in the lockfile matches the docs you read

Full protocol: the `code-review` skill's api-verification reference. Guessing a plausible method name is the most
common failure at this rung.

## Step 5: Dependency Admission

Adding a package is a supply-chain decision. All of these MUST hold:

- [ ] Nothing at rungs 1 to 5 covers it
- [ ] Saves more than roughly 50 lines of code you would otherwise own
- [ ] Actively maintained, release within the last 12 months
- [ ] Licence compatible with this project (check copyleft against distribution plans)
- [ ] Name checked against typosquat variants of the package you intended
- [ ] Pinned to an exact version, the lockfile updated in your change
- [ ] Transitive footprint reviewed for a small utility

Decide a new dependency before your first command: `install_dependencies` is the one command with the package
registries, and it runs once, before any other. A dependency you find you need later is a reason to `finish` and say
so, not to work around the sandbox.

Reject a dependency that wraps something the stdlib already does. See the `security-audit` skill for CVE and
supply-chain checks on the resulting tree.

## Step 6: Refuse These Abstractions

Do not create, unless the second consumer exists today:

| Pattern | Rule |
|---|---|
| Interface, Protocol, or ABC | Needs two implementations, or one real test double at a layer boundary |
| Factory | Needs more than one product |
| Config option | Needs a caller that sets a non-default value |
| Feature flag | Needs a plan to toggle it |
| Wrapper or adapter | Needs to add behaviour, not only forward arguments |
| Base class | Composition first. Inheritance only for a genuine substitutable type |
| New package or module | Fewest files that hold the change. Extract on the third use, not the first |

A single-implementation port is legitimate when it enforces the dependency rule and has a fake in tests. Detail:
the `python-engineer` skill's architecture-patterns reference.

## Step 7: Performance Decisions Made at Write Time

Cheap to get right now, expensive to retrofit. Not premature optimisation.

- [ ] No query inside a loop. Batch, join, or `IN` clause instead
- [ ] Bulk SDK call over per-item calls (`batch_write_item`, `send_message_batch`)
- [ ] Right container: set or dict for membership, not list scan
- [ ] Stream large payloads. No `read()` of an unbounded file or response
- [ ] No blocking I/O inside an async path
- [ ] Client, connection, and session objects created once, reused
- [ ] Pagination bounded. No unbounded `scan` or `SELECT *`
- [ ] Known quadratic loops flagged with the input size that breaks them

Measure before optimising anything beyond this list. Profiling: the `perf-debug` skill.

## Step 8: Import and Scaffolding Hygiene

- [ ] Absolute imports only. No relative parent traversal (ruff `TID252`)
- [ ] All imports at module top, except a documented cycle or cost break (ruff `E402`)
- [ ] Same package imported one way per file, not top-level and deferred
- [ ] No unused imports or re-exports with no consumer (`F401`, knip, vulture)
- [ ] No barrel file that re-exports a whole package for one symbol
- [ ] No empty placeholder file, directory, or `TODO` stub submitted

## Step 9: When Not to Be Minimal

Never remove or defer, whatever the diff size:

- Validation at trust boundaries
- Error handling that prevents data loss or silent corruption
- Authentication, authorisation, encryption, secret handling
- Accessibility basics
- Anything the task explicitly requested

A deliberate shortcut with a known ceiling gets a comment naming the ceiling and the
upgrade path: `# ceiling: single-process lock, move to Redis if multi-instance`.

## Step 10: Report

Put this in your `finish` summary:

```
## Build decision: [what was requested]

| Rung reached | Choice | Rejected |
|---|---|---|
| 3 (stdlib) | `functools.lru_cache` | custom TTL cache class (~80 lines to own) |

- Skipped: [abstraction or option], add when [trigger]
- Dependencies added: none / [name==version, why rungs 1-5 failed]
- API verified: [symbol, source read]
- Perf decisions: [batching, pooling, streaming choices]
- Ceilings accepted: [comment locations]
```

## Self-Check

- [ ] Read the touched code before choosing a rung
- [ ] Grepped this repo before writing a new helper
- [ ] Nothing on the never-hand-roll list was hand-rolled
- [ ] Every new SDK call verified against real source or docs
- [ ] New dependencies passed all admission checks
- [ ] No abstraction created for a consumer that does not exist
- [ ] Step 7 performance list checked
- [ ] Step 9 items intact
