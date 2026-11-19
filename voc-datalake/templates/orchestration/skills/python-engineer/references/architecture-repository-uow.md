# Repository, Unit of Work, CQRS, Domain Modeling (Python 2026)

Detail for the persistence and domain half of references/architecture-patterns.md. Read the hub first for the "when NOT to apply" gate and the dependency rule.

## Repository Pattern

A Repository is an in-memory-collection illusion over persistent storage. It decouples the domain from the ORM and gives tests a trivial fake. It implements a port (see references/architecture-ports-di.md).

```python
# adapters/repository.py: a fake for tests, same port
from myapp.domain.model import Batch

class FakeBatchRepository:
    def __init__(self, batches: list[Batch] | None = None) -> None:
        self._batches = {b.reference: b for b in (batches or [])}

    def add(self, batch: Batch) -> None:
        self._batches[batch.reference] = batch

    def get(self, reference: str) -> Batch | None:
        return self._batches.get(reference)
```

Rules:
- Repository methods speak the domain language (`get`, `add`, `list_for_customer`), not SQL.
- One Repository per aggregate root, not per table.
- Return domain objects, never ORM rows or `dict`s, past the adapter boundary.
- Tests use the in-memory fake. No DB, no mocks of internal calls.

Do not build a Repository for a table you only ever `SELECT *` from. That is a read model (see CQRS below).

## Unit of Work

A Unit of Work (UoW) owns the atomic boundary. It groups Repository operations into one transaction and exposes commit/rollback. It also hides the session lifecycle from the service layer.

```python
# service_layer/unit_of_work.py
from __future__ import annotations
from types import TracebackType
from typing import Protocol
from sqlalchemy.orm import Session, sessionmaker
from myapp.adapters.repository import SqlAlchemyBatchRepository

class UnitOfWork(Protocol):
    batches: object  # a BatchRepository
    def __enter__(self) -> UnitOfWork: ...
    def __exit__(self, *args: object) -> None: ...
    def commit(self) -> None: ...
    def rollback(self) -> None: ...

class SqlAlchemyUnitOfWork:
    def __init__(self, session_factory: sessionmaker[Session]) -> None:
        self._session_factory = session_factory

    def __enter__(self) -> "SqlAlchemyUnitOfWork":
        self._session = self._session_factory()
        self.batches = SqlAlchemyBatchRepository(self._session)
        return self

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        tb: TracebackType | None,
    ) -> None:
        self.rollback()  # no-op if already committed; guarantees no dangling txn
        self._session.close()

    def commit(self) -> None:
        self._session.commit()

    def rollback(self) -> None:
        self._session.rollback()
```

`__exit__` rolls back by default. The service layer must commit explicitly. That makes "forgot to commit" a safe no-op instead of a partial write. Works with SQLAlchemy 2.0 `Session` and `select()` style (the legacy `Query` API is deprecated); 2.1 is the next stable target and keeps this API, so there is no 3.0 migration to plan for.

```python
# service_layer/services.py: a use case (one action, no I/O details)
def allocate(order_ref: str, sku: str, qty: int, uow: UnitOfWork) -> str:
    with uow:
        batch = uow.batches.get(sku)
        if batch is None:
            raise InvalidSku(sku)
        ref = batch.allocate(order_ref, qty)  # domain method holds the rule
        uow.commit()
    return ref
```

The use case reads as business steps. Persistence, sessions, and transactions live behind `uow`. Test it with `FakeUnitOfWork` wrapping the fake Repository. No database required for unit tests.

## CQRS: Lightweight Version

Command Query Responsibility Segregation splits writes (commands, through the domain) from reads (queries, bypassing it). In Python it rarely means two databases. It means: do not force reads through the domain model and Repository.

- **Writes** go through use cases, domain methods, and the UoW. They protect invariants.
- **Reads** are plain query functions returning DTOs or dicts. They may hit the DB directly with hand-tuned SQL or a `select()`. No aggregate hydration.

```python
# views.py: a read model, no domain objects
from sqlalchemy import text
from sqlalchemy.orm import Session

def allocations_for_order(order_ref: str, session: Session) -> list[dict[str, str]]:
    rows = session.execute(
        text("SELECT sku, batch_ref FROM allocations WHERE order_ref = :ref"),
        {"ref": order_ref},
    )
    return [{"sku": r.sku, "batch_ref": r.batch_ref} for r in rows]
```

Apply CQRS when read shapes diverge from the write model or read performance demands denormalized queries. Skip it (YAGNI) when the same model serves both cleanly. Full read/write DB split, event sourcing, and separate read stores are advanced; add them only under proven load.

## Domain Modeling Primitives

| Construct | Use for | Type |
|---|---|---|
| Value object | Immutable, equality by value (Money, SKU, DateRange) | `@dataclass(frozen=True)` |
| Entity | Identity-based, mutable state, holds invariants | plain `class` or `@dataclass` with methods |
| DTO / boundary input | Validate untrusted external data (API body, config, event) | Pydantic v2 model |

Keep the domain framework-free. Model entities and value objects with `dataclasses` (or `attrs`), not Pydantic, so the domain does not import a validation library. Use Pydantic v2 at the boundary (entrypoints) to validate input, then convert to domain objects. This keeps validation at the edge and invariants in the core.

Two concrete reasons, not just style: Pydantic coerces types by default (`"42"` becomes `42`), which a domain model must never do silently; and a Pydantic model injects `__pydantic_private__` onto instances, which conflicts with SQLAlchemy's classical (imperative) mapper. If you use FastAPI with an Active-Record ORM style and no classical mapper, `Pydantic(ConfigDict(frozen=True, strict=True))` throughout is a defensible pragmatic choice for smaller apps.

```python
# domain/model.py: no framework imports
from dataclasses import dataclass

@dataclass(frozen=True)
class Money:
    amount: int  # minor units, never float for money
    currency: str

    def __add__(self, other: "Money") -> "Money":
        if self.currency != other.currency:
            raise ValueError("currency mismatch")
        return Money(self.amount + other.amount, self.currency)
```

Put behavior on the domain object (`batch.allocate(...)`), not in a service that reaches into its fields. An anemic model (data-only classes plus a fat service) discards the benefit of a domain layer.
