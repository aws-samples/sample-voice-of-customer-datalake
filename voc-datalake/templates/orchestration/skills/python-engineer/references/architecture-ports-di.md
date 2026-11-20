# Ports and Dependency Injection (Python 2026)

Detail for the Hexagonal / DIP half of references/architecture-patterns.md. Read the hub first for the "when NOT to apply" gate and the dependency rule.

## Ports: Protocol vs ABC

A "port" is the interface an inner layer declares and an outer adapter implements. Modern Python offers two ways to define one.

| Use `typing.Protocol` (default) | Use `abc.ABC` |
|---|---|
| Structural typing: any class with matching methods conforms, no inheritance needed | Nominal typing: implementers must subclass explicitly |
| Zero coupling: adapters do not import the port | You want to share concrete helper methods across implementations |
| Idiomatic for ports in hexagonal Python (2025-2026 consensus) | You want `__init_subclass__` enforcement at class-definition time |
| Add `@runtime_checkable` only if you need `isinstance` (structural check is method-name-only) | `isinstance` works and checks the full contract |

Default to `Protocol`. It keeps adapters ignorant of the abstraction, which is the point of DIP. `@runtime_checkable` only verifies method *names* exist, not signatures, so keep it for coarse `isinstance` gates and rely on pyright for the real contract check.

On Python 3.12+, decorate adapter methods that implement an `abc.ABC` port with `typing.override`: the type checker then errors if the base drops or renames the method, catching drift between port and adapter.

```python
# domain/ports.py: the port lives with the code that USES it, not the adapter
from typing import Protocol
from myapp.domain.model import Batch

class BatchRepository(Protocol):
    def add(self, batch: Batch) -> None: ...
    def get(self, reference: str) -> Batch | None: ...
```

```python
# adapters/repository.py: implements the port WITHOUT importing it
from sqlalchemy.orm import Session
from myapp.domain.model import Batch

class SqlAlchemyBatchRepository:  # structurally satisfies BatchRepository
    def __init__(self, session: Session) -> None:
        self._session = session

    def add(self, batch: Batch) -> None:
        self._session.add(batch)

    def get(self, reference: str) -> Batch | None:
        return self._session.get(Batch, reference)
```

The service layer type-hints the port; pyright verifies the adapter conforms at check time. No runtime registration, no framework.

## Open/Closed: Polymorphism over Type-Switch

Adding a case by editing a stable `if x.type == ...` chain violates OCP and is an anti-slop finding (OCP row). Dispatch through a port instead so new behavior is a new class, not an edit.

```python
# BAD: every new method edits this function (closed for extension)
def notify(channel: str, msg: str) -> None:
    if channel == "email":
        ...
    elif channel == "sms":
        ...

# GOOD: new channel = new class, no edit to existing code
class Notifier(Protocol):
    def send(self, msg: str) -> None: ...

class EmailNotifier:
    def send(self, msg: str) -> None: ...

class SmsNotifier:
    def send(self, msg: str) -> None: ...
```

## Dependency Injection: Composition Root

Python does not need a DI framework. Constructor injection plus a single composition root covers most apps.

- **Composition root**: one place (`bootstrap.py`, `main.py`, or FastAPI startup) wires concrete adapters into services. Everything below receives dependencies as arguments.
- **Constructor / parameter injection**: pass the port instance in; never `new ConcreteClass()` inside business logic (DIP violation, anti-slop OCP/DIP checks).

```python
# entrypoints/bootstrap.py: the only place that names concrete infrastructure
from sqlalchemy.orm import sessionmaker
from myapp.adapters.orm import engine
from myapp.service_layer.unit_of_work import SqlAlchemyUnitOfWork

def make_uow() -> SqlAlchemyUnitOfWork:
    return SqlAlchemyUnitOfWork(sessionmaker(bind=engine))
```

When manual wiring gets heavy, reach for a library. Current landscape (verify freshness on PyPI before adopting; it moves):

| Tool | Fit |
|---|---|
| FastAPI `Depends` | Built-in DI for FastAPI request scope. Default for FastAPI apps. Do not add a second container. |
| `svcs` | Lightweight service registry, framework-agnostic, actively maintained. Good when manual wiring sprawls. |
| `dishka` | Newer async-first container with explicit scopes, no magic. Watch in 2025-2026 for async apps. |
| `dependency-injector` | Full container with providers/config. Heavier; fits large apps that want declarative wiring. Spot-check maintenance activity before adopting; signals slowed in 2024. |
| `punq` / `wireup` / `that-depends` | Smaller containers. Evaluate maintenance status before adopting. |

Prefer the composition root until wiring is genuinely painful. A container is infrastructure; it earns its place only when hand-wiring repeats across many entrypoints. Cosmic Python ships zero DI-framework dependencies: it wires everything through constructor injection and one bootstrap module.

## FastAPI Boundary Pattern

FastAPI's `Depends` is the composition root for request-scoped dependencies. Keep it in the entrypoint layer; the service layer and domain never import `fastapi`.

```python
# entrypoints/fastapi_app.py
from fastapi import Depends, FastAPI
from myapp.service_layer import services
from myapp.service_layer.unit_of_work import SqlAlchemyUnitOfWork, UnitOfWork
from myapp.entrypoints.bootstrap import make_uow

app = FastAPI()

def get_uow() -> UnitOfWork:
    return make_uow()  # wiring stays at the edge

@app.post("/allocate")
def allocate(cmd: AllocateCommand, uow: UnitOfWork = Depends(get_uow)) -> dict[str, str]:
    ref = services.allocate(cmd.order_ref, cmd.sku, cmd.qty, uow)
    return {"ref": ref}
```

`AllocateCommand` is a Pydantic model (boundary validation). `services.allocate` takes the port, not a FastAPI type, so it is testable without the web framework.
