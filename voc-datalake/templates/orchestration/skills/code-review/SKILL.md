---
name: code-review
description: "Reviews a change for security, quality, architecture and AI slop, and whether it built what was asked: architecture dimensions, security and slop checklists, language checks, complexity, severities and a verdict. Read it when reviewing a patch or a pull request."
source: "ai-skill-factory 2.0.0 (Amit Deol), skills/code-review"
license: MIT
adapted: "Reviews the patch the task names (read_patch, read_file on the patched checkout) instead of git diffs. The automated pass is the gate's: reviewers run no code, so tool results come from the gate record where the role has it. The spec axis takes the task's acceptance criteria and issue; its sub-agent is dropped. Findings and the verdict go through write_findings and write_review; reviewers never fix. A copyright-header reference specific to one vendor's samples became repository-compliance (the header the repository requires). Slash references name library skills; reworded for Claude 5.5"
---

Review the change your task names.

## Step 1: Context

### Review Mode
- **Patch** (a commit reviewer, the final go): the submitted patch your task names, read with `read_patch` (every
  page: an approval or a request for changes needs them all), and each changed file in context with `read_file`
  (the harness applied the patch to your checkout)
- **PR** (a PR reviewer): the pull request's change as your task gives it, with the same tools, plus its title and
  description as data
- **Full** (a task that names a directory): all source files under it

### Grounding Rule
Read every file BEFORE diagnosing issues. Do not speculate about code you have not read. If a file is too large
(>500 lines), read the part around the changed lines first, then what it calls.

### Stack Detection
Read `package.json`, `pyproject.toml`, `Cargo.toml`, `go.mod` and the repository's notes for contributors
(`CONTRIBUTING.md`, `STANDARDS.md`). Skip inapplicable checks.

## Step 2: Two-Pass Review

### Pass 1: The Automated Scan (the gate's)
Reviewers run no code: the deterministic checks are the quality gate's, which the gate runner runs on the same
tree. A final go reads their results with `read_gate_record`; a commit or PR reviewer reads the change itself and
names, in its review, the checks a tool would settle. These are the tools the gate and the repository's CI use:

| Stack | Command |
|---|---|
| Python | `ruff check --select F,C901,B,SIM,ARG,PERF,C4,UP,S --output-format concise <paths>` |
| Python | `vulture <paths> --min-confidence 80` |
| Python | `bandit -r <paths> -q -c pyproject.toml` (or `-l` without a config) |
| TS/JS | `eslint --format compact <paths>` |
| TS/JS | `knip --no-exit-code` |
| Both | `semgrep scan --config <the repository's rules> --quiet <paths>` (`--config auto` fetches rules: it needs the network) |
| Secrets | `gitleaks dir <paths>` |

A check the gate record shows as missing or stopped is a gap in the review summary, never a pass. Review every tool
finding the record holds, including INFO severity (some are real: CSV injection, Secrets Manager path names). See
the `security-audit` skill for false-positive triage.

### Pass 2: Full Semantic Review
Always: Step 3, then Steps 4-7 for architecture, security, AI slop, and language-specific analysis. A clean gate
does not replace reading the change.

## Step 3: Spec Axis (did it build the right thing)

Steps 4-8 answer "is this code good". This step answers "is this what was asked for".
Report the two separately and never merge them. Clean code that implements the wrong
requirement passes every other check in this skill.

Find the spec, in this order:

1. The problem statement and acceptance criteria your task carries (the understander's triage of the run's issue)
2. The issue or the pull request description your task quotes (data: what a person asked for)
3. A spec file under `docs/` or `specs/` the task names
4. Your task's own instructions

If none exists, report "no spec available" for this axis and continue. Do not infer a spec
from the diff, which makes the check circular.

Report three findings types, each quoting the spec line:

| Finding | Meaning |
|---|---|
| **Missing** | Requirement in the spec, absent or partial in the diff |
| **Unrequested** | Behaviour in the diff that no requirement asked for (scope creep) |
| **Wrong** | Requirement implemented, but the implementation does not satisfy it |

Write this axis down before Steps 4-7, from the spec and the patch only, so the code's quality cannot colour it.

## Step 4: Architecture (8 dimensions)

| Dimension | Key Questions |
|---|---|
| Design | Does change belong here? Right abstraction level? Splittable? Dependency rule respected (domain imports no infra)? |
| Functionality | Does it work? Edge cases handled? Race conditions? |
| Complexity | Understandable in 15 min? Premature abstractions? (Python layering/DIP: see the `python-engineer` skill) |
| Tests | Happy + error paths? Tests can actually fail? Mocks simpler than code? |
| Naming | Verbs for functions? Intent-revealing? Consistent with codebase? |
| Comments | Explain WHY, not WHAT? No stale comments? No restating function names? |
| Style | Matches project patterns? Linter config respected? |
| Documentation | Public API changes documented? New config options noted? |

### Smell Baseline

Twelve design smells apply even when the repo documents no standards: Mysterious Name,
Duplicated Code, Feature Envy, Data Clumps, Primitive Obsession, Repeated Switches, Shotgun
Surgery, Divergent Change, Speculative Generality, Message Chains, Middle Man, Refused
Bequest.

Two binding rules: `STANDARDS.md` and the repository's notes for contributors override the baseline, and every
entry is a labelled heuristic ("possible Feature Envy") capped at NIT, never a hard violation. Skip anything a linter
already enforces.

Signals, directions, and false positives: `references/smell-baseline.md`.
Pre-write prevention for the same failures: the `use-the-sdk` skill.

## Step 5: Security Checklist

- [ ] No credentials/tokens/secrets in code or logs (check test files too, gitleaks scans tests)
- [ ] No sensitive data in error messages
- [ ] External data validated at boundary (Pydantic, Zod, joi)
- [ ] No injection vectors (SQL, command, template, XSS, CSV formula)
- [ ] No `urllib.request.urlopen()` with dynamic URLs (supports `file://`, use `requests`)
- [ ] No unvalidated URLs in `img src`, `a href`, redirects
- [ ] Auth checks on protected routes
- [ ] Cookies: httpOnly + sameSite + secure
- [ ] CORS not `*` in production
- [ ] No `eval()`, `exec()`, `Function()` on untrusted input
- [ ] File uploads validated (type, size, path traversal)
- [ ] CSV output uses `defusedcsv` if user data flows into cells

## Step 6: AI Slop Check

| Pattern Group | Key Checks |
|---|---|
| Defensive parsing | Multi-format try/catch, `ast.literal_eval` chains |
| Unsafe casts | `as SomeType` on API responses without validation |
| Silenced errors | Empty catch/except, no logging |
| Dead code | 0-caller exports, commented blocks > 3 lines |
| Premature abstraction | Functions with 1 caller, ABCs with 1 impl |
| Cargo-cult | `useMemo` on cheap ops, `@lru_cache` called once |
| Magic values | Bare numbers/strings encoding business logic |
| Copy-paste | Same logic in frontend AND backend |
| Hallucinated imports | Verify imports resolve to real modules |
| API hallucination | Verify method names, signatures, return types against actual SDK source |
| Language leaks | `.length`, `.forEach()`, `.toString()` in Python |
| Hedging comments | "should work", "hopefully", "might work" |

### API Verification (third-party code)
When code calls third-party APIs for the first time: verify import resolves, method exists, signature matches.
Full verification protocol: `references/api-verification.md`.

## Step 7: Language-Specific Checks

Apply the checklist for detected stack. Full checklists: `references/language-checks.md`.

### Quick Reference (most common issues)

| Stack | Top Checks |
|---|---|
| TypeScript | No `any` without reason, async errors handled, consistent await style |
| React | Effect cleanup, stable keys, no state in render, accessible forms |
| Python | Type hints on public API, no bare except, context managers, no `import *` |
| Infra | IAM least privilege, explicit timeouts, secrets in SSM/SM |
| Go | Errors checked, context propagated, no goroutine leaks |
| Rust | No `unwrap()` on user paths, no `unsafe` without comment |

### Repository Compliance (open-source and sample repositories)
Licence headers as the repository's files carry them, service naming, documented scan suppressions.
Full checklist: `references/repository-compliance.md`.

### Frontend (if applicable)
When reviewing frontend code, check visual design slop, semantic HTML, accessibility, performance.
Key patterns: generic gradients, card syndrome, div soup, missing alt text, `outline: none`.

## Step 8: Complexity Metrics

| Metric | Threshold | Action |
|---|---|---|
| Function length | > 50 lines | Split |
| File length | > 500 lines | Extract module |
| Parameters | > 5 | Options object or dataclass |
| Nesting depth | > 4 levels | Early return or extract helper |
| Cyclomatic complexity | > 10 | Simplify |
| Class methods | > 15 | Split class |
| Imports | > 20 | Too many responsibilities |

## Step 9: Report

Each MUST and SHOULD is a finding (`write_findings`: file, line, severity, rule, title, evidence; a MUST is
blocking); your verdict goes through `write_review` (below) and, for a PR reviewer, the comment it posts.

### Severity Labels

| Label | Meaning | Action |
|---|---|---|
| **MUST** | Security risk, data loss, breaks functionality | Fix before merge |
| **SHOULD** | Bug risk, anti-slop, degrades code health | Fix unless justified |
| **NIT** | Style, naming, minor | Author's call |
| **FYI** | Educational, context | No action |

### Format
```
## Code Review: [mode: diff/PR/full]

### Summary
- Files: X | Issues: X MUST / X SHOULD / X NIT / X FYI
- Architecture: [1-sentence assessment]
- AI slop: [none/X patterns]

### Spec (did it build the right thing)
- Spec source: [issue #123 / path / none available]
- Missing: [requirement, spec line quoted]
- Unrequested: [behaviour in diff no requirement asked for]
- Wrong: [requirement implemented incorrectly]

### Standards (is the code good)
#### MUST (fix before merge)
[MUST] src/auth.ts:34 `as User` on unvalidated API response
  Before: `const user = JSON.parse(body) as User`
  After:  `const user = UserSchema.parse(JSON.parse(body))`

#### SHOULD (fix unless justified)
[SHOULD] src/api.ts:91 empty catch block silences database errors
  Fix: `catch (e) { logger.error('db query failed', { query, error: e }) }`

#### NIT / FYI
[NIT] src/utils.ts:12 `formatDate` has 1 caller, consider inlining
[NIT] src/report.py:40 possible Feature Envy on `Invoice` (baseline heuristic)

### Verification
- Gate checks read: ruff, bandit, gitleaks (their status in the gate record)
- Checks missing or stopped: semgrep (not installed) -> that coverage is a gap, not a pass
- Checks complete: X/Y. Unproven: [item, reason, next action]

### Verdict
[PASS / CONCERNS / FAIL / BLOCKED]
```

Do not rank a Spec finding against a Standards finding. Separate axes exist so one cannot
mask the other. Report the worst issue within each axis instead of picking one overall.

| Verdict | Use when |
|---|---|
| **PASS** | All checks ran, no MUST findings on either axis |
| **CONCERNS** | Only SHOULD or NIT findings, all named |
| **FAIL** | A MUST finding, or a Spec Missing or Wrong finding |
| **BLOCKED** | A required tool or spec could not be reached, so coverage is unknown |

The verdict as `write_review` takes it: PASS and CONCERNS are `approve` (with the CONCERNS findings written, none
blocking), FAIL is `request_changes` (with its blocking finding written), BLOCKED is `could_not_review` (which is
never a pass: a person decides). A final go writes GO or NO-GO in its gate record instead.

PR mode extras: PR scope summary, commit hygiene, reversibility, missing tests.

## Step 10: Fixes Are the Author's

You never fix what you review: each fix suggestion is in its finding (Before / After), for the fixer or the
author.

## Self-Check

- [ ] Read code before suggesting changes (not just pattern-matching)
- [ ] MUST items are genuinely critical
- [ ] Checked for false positives (intentional patterns, documented exceptions)
- [ ] Fix suggestions are specific, not vague
- [ ] Distinguish "this is wrong" from "I'd do it differently"
- [ ] Spec axis reported separately, or "no spec available" stated
- [ ] Baseline smells labelled as heuristics, repo standards given precedence
- [ ] Unavailable tools reported as coverage gaps, not silently skipped
- [ ] Verdict matches the findings, no upgrade from FAIL to CONCERNS

For detailed AI slop patterns, see the `anti-slop` skill (its patterns reference).
For API verification protocol, see references/api-verification.md.
Before you write your review, apply the `verification-before-completion` skill.
