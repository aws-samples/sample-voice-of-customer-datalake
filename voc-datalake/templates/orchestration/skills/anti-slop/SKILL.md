---
name: anti-slop
description: "Detect AI-generated code and content slop in a change: hallucinated imports, defensive parsing, unsafe casts, silenced errors, dead code, language leaks, speculative abstraction, weasel words and marketing speak, across 54+ patterns. For reviewing a change, or checking your own before you submit."
source: "ai-skill-factory 2.0.0 (Amit Deol), skills/anti-slop"
license: MIT
adapted: "The spec-loader step reads VOICE.md and STANDARDS.md with read_file. A reviewer reads the patch against the patterns (reviewers run no code); a fixer or builder runs the repository's installed tools on its changed files with run's argv. Fixes stay within the author's own change; a reviewer writes findings. Slash references name library skills."
---

Scan the change your task names (a reviewer: the patch; a fixer or builder: your own change before you submit) for
AI-generated code and content slop.

Default: the files the change touches (exclude node_modules, .venv, dist, build, __pycache__).

## Step 0: Load Project Specs

Read with `read_file` the files the repository has:

1. `VOICE.md` (banned words/phrases for patterns 12g-12l content slop)
2. `STANDARDS.md` (ruff select list, type checker, test framework for code-slop scans)

Without them, the built-in defaults below. Use VOICE.md `banned_words` and `banned_phrases` as the authoritative
list; they override the hardcoded patterns in this skill.

## Step 1: Context and Tools

Read the repository's notes for contributors (`CONTRIBUTING.md` and the like) for project-specific rules. Detect
stack from config files.

A fixer or builder runs the tools the repository installs on its changed files (`run`, one argv each); a reviewer,
which runs no code, applies the patterns by reading:

| Tool | Command |
|---|---|
| ruff | `ruff check --select F,C901,B,SIM,ARG,PERF,C4,UP,S --output-format json <paths>` |
| vulture | `vulture <paths> --min-confidence 80` |
| radon | `radon cc <paths> -n C -s` |
| biome | `node_modules/.bin/biome lint --reporter json <paths>` |
| eslint | `node_modules/.bin/eslint --format json <paths>` |
| knip | `node_modules/.bin/knip --no-exit-code` |

A tool the repository does not install is not run (`npx` would fetch it over the network the sandbox does not
have). Tool config details: `references/tools.md`.

Note: sloppylint is not publicly available. Use semgrep with custom rules or manual review of patterns 12a-12f as alternatives.

For large codebases, run fast linters first (ruff, biome ~2s) then slow scanners (bandit, semgrep ~10+s).

## Step 2: Scan Patterns

For each pattern: search codebase, evaluate each hit, distinguish real slop from intentional code.

Full pattern explanations with code examples: `references/patterns.md`.

### Code Slop (19 patterns)

| # | Pattern | Look For | Severity |
|---|---------|----------|----------|
| 1 | Defensive multi-format parsing | `ast.literal_eval`, nested try/except JSON | MUST |
| 2 | Unsafe type assertions | `as SomeType` on `JSON.parse`, API responses | MUST |
| 3 | Silenced errors | Empty `catch {}`, `except: pass` | MUST |
| 4 | Premature abstraction | Helpers/utils with 1 caller | SHOULD |
| 5 | Cargo-cult patterns | `useMemo` on cheap ops, `@lru_cache` called once | NIT |
| 6 | Inconsistent async | Mixed `.then()`/`await` in same file | SHOULD |
| 7 | Unnecessary type complexity | `Record<string, unknown>` replacing a simple interface | SHOULD |
| 8 | Dead code | Exports with 0 importers, commented blocks > 3 lines | MUST |
| 9 | Magic values | Bare numbers encoding business logic | SHOULD |
| 10 | Over-engineering | Feature flags that never toggle, config that never changes | SHOULD |
| 11 | Copy-paste normalization | Same logic in frontend AND backend | SHOULD |
| 12 | Defensive null chains | 3+ `?.` chains masking missing boundary validation | SHOULD |
| 48 | Write-only fields | Fields set/incremented but never read; attrs duplicating container keys | MUST |
| 49 | Impossible condition guards | Null/error check after code path that already guarantees the condition | MUST |
| 50 | Silent data fallbacks | `.get(key, dangerous_default)` masking malformed input silently | MUST |
| 51 | Deprecated API usage | `get_event_loop`, `utcnow`, deprecated stdlib/framework calls | SHOULD |
| 52 | Duplicated constants | Same literal value defined in 2+ files without shared constant | SHOULD |
| 53 | Framework anti-patterns | Mutating Pydantic/dataclass post-init, `read_bytes()` before size check | SHOULD |
| 54 | Inconsistent import style | Same package imported top-level AND deferred in one file | NIT |

### AI Hallucination (6 patterns)

| # | Pattern | Look For | Severity |
|---|---------|----------|----------|
| 12a | Hallucinated imports | Imports from non-existent modules | MUST |
| 12b | Language leaks | `.length`, `.push()`, `.forEach()`, `.toString()` in Python | MUST |
| 12c | Hedging comments | "should work", "hopefully", "might work" | MUST |
| 12d | Placeholder implementations | `pass`, `...`, `NotImplementedError` in non-abstract methods | MUST |
| 12e | Single-method classes | Classes with 1 public method (should be function) | SHOULD |
| 12f | Overconfident/apologetic comments | "obviously", "simply", "hacky", "sorry" | NIT |

### SOLID/DRY Violations (5 patterns)

| Principle | Threshold | Tool |
|---|---|---|
| SRP | Files > 500 lines, classes > 15 methods, functions > 50 lines | `ruff C901`, `radon cc -n C` |
| OCP | Type-discriminator if-elif/switch chains | Grep: `if.*\.type\s*==` |
| DRY | Duplicated logic blocks | `pylint --enable=R0801`, `jscpd` |
| YAGNI | ABCs/Protocols with 1 impl, unused exports | `vulture`, `knip` |
| KISS | Cyclomatic complexity > 10, nesting > 4 | `radon cc -n C`, `eslint-plugin-sonarjs` |

pylint is GPL-2.0; use only in dev environment. Alternative: jscpd (MIT).

A single-implementation port is NOT YAGNI when it is a deliberate layer boundary with a real test double (a fake Repository, a swappable adapter). Flag one-impl abstractions with no second implementation and no test seam; keep ports that enforce the dependency rule. See the `python-engineer` skill's architecture-patterns reference for the distinction.

This skill removes hand-rolled and speculative code after it exists. The `use-the-sdk` skill stops it being
written: apply it before adding a function, dependency, or abstraction.

### AI Content Slop (prose, docs, comments, commit messages)

| # | Pattern | Look For | Severity |
|---|---------|----------|----------|
| 12g | Em dash overuse | `—` (U+2014) in prose, comments, docs | SHOULD |
| 12h | Weasel words | "leverage", "utilize", "ensure", "robust", "comprehensive", "streamline" | SHOULD |
| 12i | Filler and AI slop phrases | "it's worth noting", "let's dive in", "in today's", "in order to" | SHOULD |
| 12j | Minimizers | "simply", "easily", "just", "trivially" | SHOULD |
| 12k | Marketing speak | "cutting-edge", "industry-leading", "best-in-class", "next-generation", "seamless" | MUST |
| 12l | Vague quantifiers | "various", "numerous", "significant", "many" (without numbers) | NIT |

**Em dash alternatives**: use commas, periods, colons, or parentheses instead.
**Weasel word alternatives**: "use" not "leverage/utilize", "check" not "ensure", "fast" not "high-performance".

### Comment Slop (6), Test Slop (6), Performance Slop (5), Frontend Slop (14), Config Slop (4)

Scan these categories using the pattern tables in `references/patterns.md`.

Key targets:
- **Comment**: restating docstrings, `# TODO` without owner, `# This function` preambles
- **Test**: `time.sleep` in tests, mock setup > code under test, `assert True`
- **Performance**: N+1 queries (loop with individual DB calls), `requests.get` in `async`
- **Frontend**: `linear-gradient` with generic colors, `rounded-lg shadow` count, `outline: none`, `<div onClick`
- **Config**: unused env vars, `Action: "*"`, `Resource: "*"`

## Step 3: Report

A reviewer writes each issue as a finding (`write_findings`: MUST items blocking); a fixer or builder puts the
summary in its finish.

```
## AI Slop Audit: X issues (Y fixed, Z recommendations)

### Summary by Category
| Category | Issues |
|---|---|
| Code Slop | X |
| AI Hallucination | X |
| SOLID/DRY | X |
| Comment/Test/Perf/Frontend/Config | X |

### Findings
| # | Pattern | Category | File:Line | Action |
|---|---------|----------|-----------|--------|
| 1 | Empty catch | Code Slop #3 | src/api.ts:87 | FIXED: added error logging with context |
| 2 | Hallucinated import | AI #12a | src/utils.py:3 | FIXED: `from collections import OrderedDict` (module exists, but unused) |
| 3 | Em dash in docs | Content #12g | docs/README.md:45 | Recommend: replace with colon |
```

## Step 4: Fix (the author of the change: a fixer or builder, in its own change)

- **Fix** clear slop in the lines your change touches: dead code, empty catches, silenced errors, hallucinated
  imports (slop elsewhere goes in your finish, not your patch)
- **Recommend** borderline cases with reasoning
- **Skip** intentional patterns (documented, tested, justified)
- **Auto-fix** where tools support: `ruff check --fix`, `biome lint --write`
- **Verify** fixes compile and tests pass
- **Re-scan** after fixes
