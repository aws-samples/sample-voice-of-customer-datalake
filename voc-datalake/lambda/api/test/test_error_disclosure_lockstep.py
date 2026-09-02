"""A caught exception must never be interpolated into a client-facing API error.

THE RULE
--------
Inside `except ... as e:`, no `raise SomeApiError(...)` may mention `e`.

WHY IT IS A RULE AND NOT A PREFERENCE
-------------------------------------
`shared/api.py::_register_exception_handlers` returns `ApiError.message`
**verbatim** in the response body. So `raise ServiceError(f'Failed: {e}')` is not a
log line — it is a publication. A botocore `ClientError` carries the error code, the
operation name, the service text and whatever internal names the service echoes
back, which on the routes in this directory means the DynamoDB table name, the
`pk`/`sk` key structure, the raw-data bucket and the Cognito user pool id. All of it
was readable by anyone who could provoke a 500 (issue #263).

The fix at each site is the same and costs nothing: pass a fixed message, and put
the detail in `logger.exception`, which Powertools stamps with the request id so an
operator can still correlate it.

WHY A SCANNER RATHER THAN A COMMENT
-----------------------------------
The shape is mechanically detectable, and PR #403 fixed fourteen instances of it
across two files — a count that only reflects the two files someone happened to
read. Nothing stops the fifteenth from arriving in a third. This holds the whole
directory instead, and it holds it cheaply: the tree is already clean, so this test
is green on `development` and any new violation is caught by the author of it.

It also makes the `create_api_resolver` redesign #263 proposes (hoisting
`except ApiError: raise` into the shared resolver so a route cannot forget it) safer
to attempt later, because a regression introduced along the way fails here.

THE CEILING
-----------
Lexical and single-hop: it sees `ServiceError(f'{e}')` and `ServiceError(str(e))`,
but not `msg = str(e)` on one line and `ServiceError(msg)` on the next. That is a
deliberate stop — following assignments needs dataflow, and the direct form is the
one that actually keeps being written. `logger.exception(f'...{e}')` is out of scope
too: it does not reach the client (though it is redundant, since Powertools attaches
the exception itself).
"""
import ast
from pathlib import Path

import pytest


def _repo_root() -> Path:
    # lambda/api/test/ -> voc-datalake/
    return Path(__file__).resolve().parents[3]


def _api_error_names() -> frozenset[str]:
    """Every `ApiError` subclass, read from `shared/exceptions.py` itself.

    Derived rather than listed, because a hardcoded tuple is exactly how a scanner
    goes quietly partial: add an eighth exception class and a hardcoded list keeps
    passing while never looking at it. Read as SOURCE TEXT rather than imported so
    the scan does not depend on `shared` being importable from wherever it runs.
    """
    source = (_repo_root() / 'lambda/shared/exceptions.py').read_text(encoding='utf-8')
    tree = ast.parse(source)
    names = {'ApiError'}
    # Repeated to a fixed point: `SecretUnreadableError` extends
    # `ConfigurationError`, not `ApiError` directly, so one pass would miss it.
    for _ in range(len(tree.body)):
        for node in tree.body:
            if isinstance(node, ast.ClassDef) and any(
                isinstance(b, ast.Name) and b.id in names for b in node.bases
            ):
                names.add(node.name)
    return frozenset(names)


API_ERROR_NAMES = _api_error_names()


def _scanned_sources() -> list[Path]:
    """Every non-test Lambda module.

    `lambda/layers` is vendored build output (ruff.toml excludes it for the same
    reason), and a test may legitimately construct one of these errors from a caught
    exception to assert on it.
    """
    root = _repo_root() / 'lambda'
    return [
        path for path in sorted(root.rglob('*.py'))
        if 'layers' not in path.parts
        and 'test' not in path.parts
        and not path.name.startswith('test_')
    ]


def _violations(source: str, where: str) -> list[str]:
    """Sites where a caught exception is interpolated into an API error's message."""
    found = []
    for handler in ast.walk(ast.parse(source)):
        if not isinstance(handler, ast.ExceptHandler) or not handler.name:
            continue
        for node in ast.walk(handler):
            if not (isinstance(node, ast.Raise) and isinstance(node.exc, ast.Call)):
                continue
            func = node.exc.func
            # Both `ServiceError(...)` and `exceptions.ServiceError(...)`.
            raised = func.id if isinstance(func, ast.Name) else getattr(func, 'attr', None)
            if raised not in API_ERROR_NAMES:
                continue
            # `raise X(...) from e` is FINE and is the recommended form: `from`
            # chains the cause for the traceback without touching `.message`. Only
            # the call's own arguments are inspected, never `node.cause`.
            arguments = list(node.exc.args) + [kw.value for kw in node.exc.keywords]
            mentions = any(
                isinstance(inner, ast.Name) and inner.id == handler.name
                for argument in arguments
                for inner in ast.walk(argument)
            )
            if mentions:
                found.append(f'{where}:{node.lineno}: {ast.unparse(node.exc)}')
    return found


class TestNoCaughtExceptionReachesAClientErrorMessage:
    def test_the_detector_fires_on_a_known_violation(self):
        """Control: the scan below finds nothing, so prove it CAN find something.

        Without this, a traversal broken by any future refactor — an `ast` API
        change, a wrong node type, an over-eager filter — would report a clean tree
        and read as a pass. That failure mode is silent and permanent, because the
        thing this test asserts is an absence.
        """
        violation = _violations(
            'try:\n'
            '    pass\n'
            'except Exception as e:\n'
            "    raise ServiceError(f'Failed to read: {e}') from e\n",
            'inline',
        )

        assert len(violation) == 1, (
            f'the detector no longer recognises the #263 shape it exists to find: '
            f'{violation}'
        )

    def test_raise_from_alone_is_not_a_violation(self):
        """The recommended form must stay green, or the rule reads as "never chain".

        `from e` is what preserves the cause in the traceback; it never touches
        `.message`, so it publishes nothing. A detector that flagged it would push
        authors to drop the chaining and lose the traceback for no gain.
        """
        assert _violations(
            'try:\n'
            '    pass\n'
            'except Exception as e:\n'
            "    raise ServiceError('Failed to read') from e\n",
            'inline',
        ) == []

    def test_subclasses_declared_after_apierror_are_all_covered(self):
        """The derived name set must include the indirect subclass, not just direct
        ones — `SecretUnreadableError` extends `ConfigurationError`, and a
        single-pass derivation would silently skip it."""
        assert {'ApiError', 'ServiceError', 'ValidationError', 'NotFoundError',
                'ConfigurationError', 'SecretUnreadableError', 'AuthorizationError',
                'ConflictError'} <= API_ERROR_NAMES

    def test_the_scan_covers_the_handlers_the_rule_is_about(self):
        """A path constant gone stale would make the sweep below vacuous."""
        scanned = {path.name for path in _scanned_sources()}

        assert {'data_explorer_handler.py', 'users_handler.py'} <= scanned, (
            f'the scan no longer reaches the API handlers; it found: {sorted(scanned)}'
        )

    @pytest.mark.parametrize(
        'path', _scanned_sources(), ids=lambda p: p.name,
    )
    def test_no_module_interpolates_a_caught_exception(self, path: Path):
        relative = path.relative_to(_repo_root())
        found = _violations(path.read_text(encoding='utf-8'), str(relative))

        assert found == [], (
            'A caught exception is interpolated into a client-facing error '
            'message:\n  ' + '\n  '.join(found) + '\n\n'
            "shared/api.py returns ApiError.message VERBATIM, so this publishes the "
            'exception text — AWS error code, operation name, table/bucket/pool names '
            '— to anyone who can provoke the error (issue #263). Pass a fixed '
            'message instead and log the detail:\n'
            "    logger.exception('Failed to read the thing')\n"
            '    raise ServiceError(FAILED_READ_THING) from e'
        )
