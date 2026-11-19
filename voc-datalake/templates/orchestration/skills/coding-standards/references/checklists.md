# Coding Standards Checklists

## Python

### Style
- Line length matches pyproject.toml [tool.ruff] line-length (default 100)
- Target version matches pyproject.toml (default py312)
- No mixed tabs/spaces
- Imports sorted (stdlib, third-party, local)

### Type Hints
- Type hints on all public function signatures (parameters + return)
- Use `Any` from typing, not builtin `any`
- Use `dict[str, Any]` not `Dict[str, Any]` (Python 3.10+)
- Use `list[str]` not `List[str]` (Python 3.10+)
- Use `X | None` not `Optional[X]` (Python 3.10+)

### Docstrings
- Public classes and functions have docstrings
- Docstrings follow Google style (Args, Returns, Raises sections)
- Module-level docstring on every file
- No docstrings on private/internal functions unless complex

### Exception Handling
- No bare `except:` (always catch specific exceptions)
- No `except Exception: pass` without logging
- No redundant except clauses like `except (Exception, ValueError)`
- External HTTP calls wrapped in try/except with graceful error returns
- Context managers for resources (files, DB connections, locks)
- No mutable default arguments (`def fn(items=[])`)

### Logging
- Use `logging` module, not `print()` in production code
- Logger instance per module: `logger = logging.getLogger(__name__)`
- Appropriate log levels (DEBUG, INFO, WARNING, ERROR)
- No sensitive data in log messages (tokens, keys, PII)
- Use `%s` formatting in logger calls, not f-strings

### Naming
- snake_case for functions, variables, modules
- PascalCase for classes
- UPPER_SNAKE_CASE for constants
- Meaningful names (no single letters except loop vars)

### AWS Service Naming (for AWS projects)
- First mention in each file uses full official name ("Amazon Bedrock AgentCore", "Amazon DynamoDB", "AWS Lambda")
- Subsequent mentions may use short form
- CDK/infra comments use full names
- boto3 client identifiers are fine as-is with mapping comment
- Module docstrings document security posture for AWS-interacting modules

### Lint Suppression Comments
- `nosemgrep` comments use the full rule ID
- Every suppression has a human-readable justification
- No implicit string concatenation in Python lists

## TypeScript

- No `any` without explanation (use `unknown` + narrowing)
- Strict mode enabled in tsconfig.json
- Async errors handled (no unhandled promise rejections)
