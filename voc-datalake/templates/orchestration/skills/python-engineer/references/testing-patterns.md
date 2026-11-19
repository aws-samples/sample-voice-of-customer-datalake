# Python Testing Patterns (2026)

## Test Architecture

| Level | Ratio | Speed | What to Mock | When |
|---|---|---|---|---|
| Unit | 70% | <1ms each | External I/O (APIs, DB, filesystem) | Every function with logic |
| Integration | 20% | <1s each | Nothing (real services, test DB) | API endpoints, DB queries |
| E2E | 10% | <10s each | Nothing (full stack) | Critical user flows only |

## pytest Configuration (pyproject.toml)

```toml
[tool.pytest.ini_options]
testpaths = ["tests"]
addopts = "-v --tb=short --strict-markers"
markers = [
    "slow: marks tests as slow (deselect with '-m \"not slow\"')",
    "integration: marks integration tests",
]
asyncio_mode = "auto"

[tool.coverage.run]
branch = true
source = ["src"]

[tool.coverage.report]
fail_under = 80
show_missing = true
exclude_lines = [
    "pragma: no cover",
    "if TYPE_CHECKING:",
    "if __name__ == .__main__.",
]
```

## Fixture Patterns

### Scoping
```python
@pytest.fixture(scope="session")
def db_engine():
    """One engine for entire test session."""
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    yield engine
    engine.dispose()

@pytest.fixture
def db_session(db_engine):
    """Fresh session per test, rolled back after."""
    connection = db_engine.connect()
    transaction = connection.begin()
    session = Session(bind=connection)
    yield session
    session.close()
    transaction.rollback()
    connection.close()
```

### Factories (factory_boy)
```python
import factory

class UserFactory(factory.Factory):
    class Meta:
        model = User

    name = factory.Faker("name")
    email = factory.Faker("email")
    role = "user"

# Usage
user = UserFactory(role="admin")
users = UserFactory.create_batch(5)
```

## Parametrize Patterns

```python
@pytest.mark.parametrize("input_val,expected", [
    ("hello", "HELLO"),
    ("", ""),
    ("123", "123"),
    ("Hello World", "HELLO WORLD"),
])
def test_uppercase(input_val, expected):
    assert to_upper(input_val) == expected

# Multiple parameters with IDs
@pytest.mark.parametrize("status,should_retry", [
    (429, True),
    (500, True),
    (503, True),
    (400, False),
    (404, False),
], ids=["rate-limit", "server-error", "unavailable", "bad-request", "not-found"])
def test_retry_logic(status, should_retry):
    assert is_retryable(status) == should_retry
```

## Async Testing

```python
import pytest
from unittest.mock import AsyncMock

@pytest.mark.asyncio
async def test_async_fetch():
    result = await fetch_data("https://api.example.com/data")
    assert result is not None

@pytest.mark.asyncio
async def test_async_with_mock(mocker):
    mock_client = AsyncMock()
    mock_client.get.return_value = {"id": 1, "name": "test"}

    service = UserService(client=mock_client)
    user = await service.get_user(1)

    assert user["name"] == "test"
    mock_client.get.assert_awaited_once_with("/users/1")
```

## Mocking Patterns

### Mock at boundaries, not internals
```python
# BAD: Mocking internal implementation
def test_process_order(mocker):
    mocker.patch.object(order, "_calculate_tax")  # Internal detail
    mocker.patch.object(order, "_apply_discount")  # Internal detail

# GOOD: Mock external services
def test_process_order(mocker):
    mocker.patch("app.services.payment_gateway.charge")  # External boundary
    mocker.patch("app.services.email.send_confirmation")  # External boundary
```

### pytest-mock (prefer over unittest.mock)
```python
def test_api_call(mocker):
    mock_response = mocker.Mock()
    mock_response.status_code = 200
    mock_response.json.return_value = {"users": []}

    mocker.patch("httpx.get", return_value=mock_response)

    result = fetch_users()
    assert result == []
```

## Property-Based Testing (Hypothesis)

```python
from hypothesis import given, strategies as st

@given(st.lists(st.integers()))
def test_sort_preserves_length(xs):
    assert len(sorted(xs)) == len(xs)

@given(st.text(min_size=1))
def test_round_trip_encode_decode(s):
    assert decode(encode(s)) == s

# Constrained strategies
@given(
    email=st.emails(),
    age=st.integers(min_value=0, max_value=120),
)
def test_user_creation(email, age):
    user = create_user(email=email, age=age)
    assert user.email == email
```

## Coverage Commands

```bash
# Run with coverage
uv run pytest --cov=src --cov-report=term-missing --cov-fail-under=80

# HTML report
uv run pytest --cov=src --cov-report=html
open htmlcov/index.html

# Branch coverage
uv run pytest --cov=src --cov-branch

# Parallel execution
uv run pytest -n auto --cov=src
```

## Anti-Patterns to Avoid

| Anti-Pattern | Signal | Fix |
|---|---|---|
| Over-mocking | Mock count > code under test | Mock only I/O boundaries |
| Implementation testing | Test checks private methods | Test public behavior |
| `time.sleep()` in tests | Race condition workaround | Use mocks or async patterns |
| `assert True` | Always passes | Assert specific values |
| Snapshot abuse | `.snap` files everywhere | Use assertions for structure |
| Test pollution | Tests pass alone, fail together | Use fixtures with cleanup |
| No parametrize | Copy-paste tests with different inputs | Use `@pytest.mark.parametrize` |
| Mocking what you own | Mocking your own classes | Inject real implementations |

## Test Naming Convention

```python
# Pattern: test_when_[condition]_then_[expected_behavior]
def test_when_valid_email_then_user_created():
    ...

def test_when_duplicate_email_then_raises_conflict():
    ...

# Short form for simple cases
def test_valid_login_succeeds():
    ...

def test_empty_cart_returns_zero_total():
    ...
```
