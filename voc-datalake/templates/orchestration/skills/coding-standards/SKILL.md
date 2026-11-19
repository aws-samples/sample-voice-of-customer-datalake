---
name: coding-standards
description: "Coding style, type hints, docstrings, naming and size limits for Python and TypeScript, checked with the repository's own linters (ruff, pyright, biome, eslint, tsc). Read it when writing or reviewing code, before you submit."
source: "ai-skill-factory 2.0.0 (Amit Deol), skills/coding-standards"
license: MIT
adapted: "The spec-loader and preset step reads the repository's STANDARDS.md with read_file. Linters run through run as argv on the paths the change touched, only tools the repository installs (no npx fetch: the sandbox has no network). Fixes stay within the task's change; a reviewer writes findings instead. The slash reference names the python-engineer skill."
---

Check the coding standards of the files your change touches (a reviewer: the files the patch changes).

## Step 0: Load Project Specs

If the repository has a STANDARDS.md (or INFRA.md), read it with `read_file` for its conventions; else the defaults
below.

Use STANDARDS.md as the canonical source for ruff select, pyright mode, biome config, tsc strictness, size limits, naming conventions, and commit format. The tables below are fallbacks only. Cite STANDARDS.md in findings.

## Step 1: Detect Stack and Run Linters

Read pyproject.toml, package.json, Cargo.toml, go.mod to determine language.

| Stack | Command (`run` argv, on the paths you changed) |
|---|---|
| Python | `ruff check --select F,C901,B,SIM,ARG,PERF,C4,UP,S <paths>` |
| Python | `ruff check --select I <paths>` (import sort, separate from the shared baseline) |
| Python | `pyright <paths>` |
| TS/JS | `node_modules/.bin/biome lint <paths>` |
| TS/JS | `node_modules/.bin/eslint <paths>` |
| TS/JS | `node_modules/.bin/tsc --noEmit` |

Use only the tools the repository installs (its dev dependencies, after `install_dependencies`): `npx` fetching a tool
needs the network, which the sandbox does not have. A tool the repository does not have is not run; say so.
Incorporate findings, don't duplicate what tools caught.

## Step 2: Check Standards

Apply the checklist for detected stack. Additional detail: `references/checklists.md`.

### Python

- [ ] Type hints on all public function signatures (parameters + return)
- [ ] Modern syntax: `dict[str, Any]` not `Dict`, `X | None` not `Optional[X]`, `list[str]` not `List[str]`
- [ ] No bare `except:`. Always catch specific exceptions
- [ ] No `except Exception: pass` without logging
- [ ] Context managers for resources (files, DB connections, locks)
- [ ] No mutable default arguments (`def fn(items=[])`)
- [ ] `logging` module, not `print()`. Logger per module: `logging.getLogger(__name__)`
- [ ] No sensitive data in log messages (tokens, keys, PII)
- [ ] Public classes and functions have docstrings (Google style: Args, Returns, Raises)
- [ ] snake_case functions/variables, PascalCase classes, UPPER_SNAKE_CASE constants
- [ ] Imports sorted: stdlib, third-party, local
- [ ] Layered projects: domain imports no framework (dependency rule). Structural patterns: the `python-engineer` skill

### TypeScript

- [ ] No `any` without explanation. Use `unknown` + narrowing
- [ ] `strict: true` in tsconfig.json
- [ ] Async errors handled (no unhandled promise rejections)

### AWS Projects

- [ ] Full official service names on first mention per file ("Amazon Bedrock AgentCore", "Amazon DynamoDB")
- [ ] Module docstrings document security posture for AWS-interacting modules
- [ ] `nosemgrep` comments use full rule ID with human-readable justification

## Step 3: Report

A reviewer writes each violation as a finding (`write_findings`); a fixer or builder puts the summary in its finish.

```
## Coding Standards Report

### Summary: X violations found

| # | Category | Rule | File:Line | Details |
```

## Step 4: Fix (a fixer or builder, within its change)

Fix only what your change touched: a style fix to lines the task does not need is noise in the patch (the fixer's
and builder's rules).

1. Fix type hint violations
2. Fix exception handling issues
3. Replace print() with logger
4. Verify fixes compile, and run the linters again
