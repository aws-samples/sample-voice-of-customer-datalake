---
name: python-engineer
description: "Sets the protocol for Python code, tests and dependencies: package managers, ruff, pyright strict, pytest patterns, Pydantic at boundaries, 50-line functions, and when hexagonal ports, repositories and units of work earn their place. Read it when writing, refactoring or reviewing Python."
source: "ai-skill-factory 2.0.0 (Amit Deol), skills/python-engineer"
license: MIT
adapted: "The spec-loader step reads the repository's STANDARDS.md with read_file. Package commands that reach the registry (uv add, uv lock, uv sync) belong to the one install step; commands are run's argv. Slash references name library skills (tdd, anti-slop, code-review). A reference to a file of the source repository (docs/engineering-principles.md) is dropped; description and emphasis reworded for Claude 5.5 skill discovery"
---

Apply staff engineer Python development practices to your task.

## Step 0: Load Project Specs

If the repository has a STANDARDS.md, read it with `read_file` for its conventions; else the defaults in this
skill.

STANDARDS.md overrides: `python.version`, `python.ruff_select`, `python.type_checker`, `python.test_framework`, `python.package_manager`, `python.doc_style`, `size_limits.*`, `naming.*`, `architecture.*`, `commit.*`. Cite STANDARDS.md in findings rather than repeating rule text.

## Package Management (uv)

Use the package manager the repository's lockfile shows; prefer `uv` over pip where the repository has a choice:
- Install: `uv add <package>`
- Dev install: `uv add --dev <package>`
- Sync: `uv sync`
- Run: `uv run python script.py`
- Lock: `uv lock` (auto-generated, kept in the change)

Every command that reaches the package registry (`uv add`, `uv lock`, `uv sync`, `pip install`) is the dependency
step: `install_dependencies`, once, before any other command; the sandbox has no network after it. Decide new
packages before you run anything. Use pip if uv is unavailable, and note it in your finish.

## Testing Protocol

Detailed patterns: `references/testing-patterns.md`.
New behaviour and bug fixes go test-first: the `tdd` skill owns the red-green cycle and the undo-the-fix proof. This
section covers the Python-specific mechanics only.

### Before writing code:
1. Read existing tests to identify patterns
2. Identify test framework (pytest preferred)
3. Check conftest.py for shared fixtures

### After writing code:
1. Run tests: `uv run pytest -v` or `python -m pytest -v`
2. Check coverage: `uv run pytest --cov=<module> --cov-report=term-missing`
3. Fix any failures before you submit

### Test quality:
- Every new function gets at least one happy-path test
- Error paths tested for functions that handle external input
- Use fixtures for shared test data
- Mock external services (AWS, APIs) in unit tests
- No sleep() in tests (use mocks/patches for timing)
- Regression tests proven by undoing the fix and seeing red (the `tdd` skill, Step 5)

## Code Quality Protocol

### Before editing:
1. Read the file completely
2. Understand the existing patterns
3. Check for related code that might be affected

### During editing:
1. Follow existing code conventions (don't reformat files you're not changing)
2. Specific exception types (no bare except)
3. Type hints on public functions
4. Docstrings on public classes/functions
5. No mutable default arguments
6. No hallucinated imports (verify module actually exports what you're importing)
7. No cross-language idioms (.length, .forEach, .toString). These are JS, not Python

### After editing:
1. Verify syntax: `python3 -m py_compile <file.py>`
2. Run linter: `uv run ruff check --select F,C901,B,SIM,ARG,PERF,C4,UP,S .`
3. Run formatter: `uv run ruff format --check .`
4. Run type checker in strict mode: `uv run pyright .`. Strict mode comes from
   `pyrightconfig.json` (`{"typeCheckingMode": "strict"}`) or `[tool.pyright]
   typeCheckingMode = "strict"` in pyproject.toml, not from a CLI flag. `uv run
   pyright .` with no strict config only runs basic mode and under-reports
   `reportUnknownMemberType`, `reportMissingTypeArgument`, and untyped-decorator
   issues. Confirm the config exists before trusting a clean pyright run
5. Run tests
6. Check for dead code: `uv run vulture . --min-confidence 80` (if available)
7. Check for AI slop: apply the `anti-slop` skill to the changed files.
8. Apply the `code-review` skill for full scope validation on multi-file changes

## Runtime Validation

Use Pydantic for runtime validation at system boundaries (API inputs, config parsing, external data).

## Dependency Management

- Pin minimum versions in pyproject.toml: `boto3>=1.42.0`
- Never pin exact versions unless breaking changes known
- Separate dev dependencies from production
- Check for CVEs before adding new packages (the `security-audit` skill); what cannot be checked offline is named in
  your finish
- Keep uv.lock in the change

## Architecture Decisions

### Tactical (always)

- Keep functions under 50 lines
- Keep files under 500 lines
- Extract shared logic only when used 3+ times
- Prefer composition over inheritance
- Use dataclasses for data containers, enums for fixed choice sets

### Structural (past a complexity threshold)

Full patterns, code, and enforcement: `references/architecture-patterns.md` (hub → `references/architecture-ports-di.md`,
`references/architecture-repository-uow.md`)

Apply architectural patterns only when at least one holds: domain rules are complex enough to isolate from I/O; you must swap or fake infrastructure (DB, queue, external API) in tests; multiple entrypoints (HTTP, CLI, worker) drive the same logic. Below that threshold, a function is the right abstraction. One-implementation interfaces are YAGNI (see the `anti-slop` skill).

| Need | Pattern | Python form |
|---|---|---|
| Isolate business logic from frameworks | Hexagonal (Ports and Adapters) | `typing.Protocol` port, adapter implements it |
| Depend on abstractions, not concretes (DIP) | Constructor injection + composition root | pass ports in; wire concretes in one `bootstrap.py` |
| Decouple domain from the ORM | Repository | one repo per aggregate; in-memory fake for tests |
| Atomic transaction boundary | Unit of Work | context manager, `__exit__` rolls back by default |
| Add behavior without editing stable code (OCP) | Polymorphism over type-switch | subclass/Protocol dispatch, not `if x.type ==` |
| Reads diverge from writes | CQRS-lite | query functions returning DTOs, bypass the domain |

Dependency rule: source dependencies point inward (entrypoints → service_layer → domain). The domain imports no framework. Enforce with `import-linter` in the repository's checks, not by convention. Default ports to `Protocol` (structural, adapters stay decoupled); use `abc.ABC` only for shared implementation or nominal `isinstance` checks. Model entities and value objects with `dataclasses` (framework-free domain); use Pydantic v2 for validation at boundaries only.
