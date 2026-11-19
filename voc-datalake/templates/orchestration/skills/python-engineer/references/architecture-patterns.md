# Python Architecture Patterns (2026)

Governance hub for structuring Python so business logic stays independent of infrastructure. Patterns from *Architecture Patterns with Python* (Percival and Gregory, cosmicpython.com), mapped to current idiomatic Python.

Read this file first: it decides *whether* to apply patterns and *how* to enforce them. The two detail files hold the code.

| Detail file | Covers |
|---|---|
| references/architecture-ports-di.md | Ports (Protocol vs ABC), dependency injection, composition root |
| references/architecture-repository-uow.md | Repository, Unit of Work, CQRS-lite, domain modeling primitives |

These patterns earn their cost only past a complexity threshold. Adding a Repository to a 200-line script is the same mistake as skipping one in a 50-module domain.

## When NOT to Apply (read first)

Patterns here trade indirection for decoupling. Below the threshold, indirection is pure cost.

| Signal | Verdict |
|---|---|
| Single-file script, CLI glue, one-shot ETL | Skip all. Use functions. |
| CRUD app with no business rules beyond validation | Skip domain model + Repository. Call the ORM directly. |
| One implementation of an interface, no test seam needed | Skip the port. `abc`/`Protocol` with 1 impl is YAGNI (anti-slop pattern 12e, #4). |
| No swappable infrastructure, no complex invariants | Skip Hexagonal. A service function is enough. |
| You cannot name the second implementation or the test double | You do not need the abstraction yet. |

Apply patterns when at least one holds: domain rules are complex and worth isolating from I/O; you must swap infrastructure (DB, queue, external API) or fake it in tests; multiple entrypoints (HTTP, CLI, worker) drive the same logic; the team is large enough that layer boundaries reduce merge conflicts.

Java-in-Python smell: `AbstractSingletonProxyFactoryBean`, one interface per class, getters/setters on dataclasses, DI framework for a 3-file app. Python favors modules, functions, and duck typing. Reach for a class or a port when it removes duplication or a real dependency, not by reflex.

## The Dependency Rule

Source-code dependencies point inward only. Inner layers know nothing of outer layers.

```
entrypoints/  (FastAPI routes, CLI, event handlers)   ── outermost
    │  depends on ▼
service_layer/  (use cases, orchestration, UoW)
    │  depends on ▼
domain/  (entities, value objects, domain services)   ── innermost, zero I/O imports
    ▲
adapters/  (Repository impls, ORM, API clients)  ── implement ports defined inward
```

The domain imports nothing from `adapters`, `service_layer`, or any framework. Adapters depend on domain (they implement ports the domain or service layer declares). This is Dependency Inversion (DIP): high-level policy does not depend on low-level detail; both depend on an abstraction owned by the inner layer.

Enforce the rule mechanically, not by convention:

```toml
# pyproject.toml: import-linter forbidden-import contract
[tool.importlinter]
root_package = "myapp"

[[tool.importlinter.contracts]]
name = "Domain is framework-free"
type = "forbidden"
source_modules = ["myapp.domain"]
forbidden_modules = ["myapp.adapters", "myapp.service_layer", "sqlalchemy", "fastapi", "boto3"]
```

Run `import-linter` (package `import-linter`, command `lint-imports`) in CI. It fails the build when a domain module imports infrastructure. Without an enforced check, the dependency rule rots within weeks.

## Directory Layout

```
src/myapp/
├── domain/           # model.py, ports.py, events.py, exceptions.py (zero I/O imports)
├── service_layer/    # services.py (use cases), unit_of_work.py, handlers.py
├── adapters/         # orm.py, repository.py, notifications.py, external API clients
└── entrypoints/      # fastapi_app.py, cli.py, bootstrap.py (composition root)
tests/
├── unit/             # domain + service layer with fakes, no I/O
├── integration/      # real DB, real Repository
└── e2e/              # through the entrypoint
```

`domain/` and `service_layer/` are unit-testable with fakes. `adapters/` gets integration tests against real infrastructure. This mirrors the test pyramid in references/testing-patterns.md.

## Enforcement Mapping

Wire these into the repository's checks (the `quality-gates` skill) so the architecture is checked, not just
documented.

| Rule | Tool | Check |
|---|---|---|
| Dependency rule (domain imports no infra) | `import-linter` (`lint-imports`) | forbidden-import contract in CI |
| No concrete instantiation in business logic (DIP) | `ruff` + semgrep custom rule | flag `= Concrete(` inside service/domain |
| Port conformance | `pyright` strict | adapter must structurally satisfy the Protocol |
| One-impl abstraction (YAGNI) | `vulture`, review | ABC/Protocol with a single implementer and no test double |
| Domain stays framework-free | `import-linter` | domain forbidden from importing sqlalchemy/fastapi/pydantic |

## Decision Checklist

Before adding a pattern, confirm:

- [ ] I can name the second implementation or the test double the abstraction enables.
- [ ] The domain logic is complex enough to isolate from I/O (not plain CRUD).
- [ ] The port lives with the code that uses it, not with the adapter that implements it.
- [ ] The domain layer imports no framework (verified by `import-linter`, not by hope).
- [ ] Reads that do not touch invariants bypass the Repository (query functions, CQRS-lite).
- [ ] Wiring lives in one composition root; business code receives dependencies as arguments.
- [ ] I am not writing Java in Python: no interface-per-class, no getters/setters on dataclasses, no DI framework for a small app.

## References

- references/architecture-ports-di.md: ports and dependency injection (this skill)
- references/architecture-repository-uow.md: Repository, Unit of Work, CQRS, domain modeling (this skill)
- Percival and Gregory, *Architecture Patterns with Python*, cosmicpython.com (free online)
- references/testing-patterns.md: fakes over mocks, test pyramid (this skill)
