"""Guard: no handler source may write the raw Lambda event to logs.

This test walks every non-test Python source under lambda/ and fails on any
of the three spellings of the defect identified in issue #245:

  1. ``json.dumps(event[, ...])``
        The whole event is serialised; the output contains the caller's
        ``Authorization`` header (Cognito bearer token) in plain text.

  2. ``f"...{event}..."`` on a line that also calls a logger method
        The str() of the event object is interpolated into the log message.

  3. ``logger.<level>(event)`` / ``logger.<level>(event, ...)``
        The event is passed directly as the log-message argument.

Spellings the guard does NOT catch (documented to set honest expectations):

  * Multi-line expressions where the logger call and the event embed are on
    different source lines — only single-line matching is performed.
  * ``print(event)`` — only ``logger.*`` calls are checked.
  * ``logging.getLogger().info(event)`` — only the ``logger`` name is matched.
  * ``json.dumps(event.copy())`` or ``json.dumps(dict(event))`` — the event
    wrapped by a further call is not matched.
  * Variables aliased to something other than ``event``
    (e.g. ``evt = event; logger.info(evt)``).
  * Custom serialisers other than ``json.dumps``.
"""

import re
from pathlib import Path

# ---------------------------------------------------------------------------
# Scope
# ---------------------------------------------------------------------------

# Source trees to walk.  Only first-party handler code; not build outputs,
# vendored packages, or test helpers.
_SCAN_ROOTS = [
    'api',
    'aggregator',
    'custom_resources',
    'jobs',
    'processor',
    'research',
    'shared',
    'stream',
]

# Directory names that stop the descent when encountered.
_EXCLUDE_DIR_NAMES = frozenset({'test', 'layers', 'cdk.out', '__pycache__', '.venv', 'node_modules'})


def _lambda_root() -> Path:
    # This file lives at lambda/api/test/; resolve four levels up for lambda/.
    return Path(__file__).resolve().parents[3] / 'lambda'


def _source_files():
    """Yield every .py source file in the scan scope, excluding test directories."""
    root = _lambda_root()
    for rel in _SCAN_ROOTS:
        scan_root = root / rel
        if not scan_root.is_dir():
            continue
        for path in scan_root.rglob('*.py'):
            # Skip any path whose components include an excluded directory name.
            # Using parts[1:] because parts[0] is the drive/root on Windows;
            # on POSIX it is '/'.  The relevant names are the relative parts.
            relative_parts = path.relative_to(root).parts
            if any(part in _EXCLUDE_DIR_NAMES for part in relative_parts):
                continue
            yield path


# ---------------------------------------------------------------------------
# Patterns
# ---------------------------------------------------------------------------

# Pattern 1 — json.dumps(event) or json.dumps(event, ...)
# Matches the opening of the call; does not require a closing paren so that
# multi-arg variants like json.dumps(event, cls=DecimalEncoder) are caught.
_PAT_JSON_DUMPS_EVENT = re.compile(r'\bjson\.dumps\(\s*event\s*[,)]')

# Pattern 2 — {event} inside an f-string on a line that also contains a
# logger call.  The two sub-patterns are checked independently so a line
# with neither is not flagged.
_PAT_LOGGER_CALL = re.compile(r'\blogger\.\w+\(')
_PAT_FSTRING_EVENT = re.compile(r'\{event\}')

# Pattern 3 — logger.<level>(event) or logger.<level>(event, ...)
_PAT_LOGGER_EVENT_DIRECT = re.compile(r'\blogger\.\w+\(\s*event\s*[,)]')


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

class TestNoRawEventLogging:
    """No handler source may write the raw Lambda event to logs (issue #245)."""

    # ------------------------------------------------------------------ #
    # Sanity: verify the walk actually reaches the handler that had the   #
    # defect.  A wrong root path or overly-broad exclusion would make     #
    # subsequent tests pass vacuously — catching nothing and reporting    #
    # clean.                                                              #
    # ------------------------------------------------------------------ #

    def test_scan_covers_projects_handler(self):
        """The scanned file set must include projects_handler.py.

        If this assertion fails it means SCAN_ROOTS or EXCLUDE_DIR_NAMES is
        misconfigured and the subsequent pattern checks are unreliable.
        """
        file_names = {p.name for p in _source_files()}
        assert 'projects_handler.py' in file_names, (
            'projects_handler.py was not found in the scanned source set.\n'
            'Check _SCAN_ROOTS and _EXCLUDE_DIR_NAMES in this test file.\n'
            f'Lambda root resolved to: {_lambda_root()}'
        )

    def test_scan_covers_multiple_handler_files(self):
        """The scanned set must be non-trivial (more than one file).

        Complements test_scan_covers_projects_handler: ensures we are not
        accidentally scanning a single file or an empty subtree.
        """
        count = sum(1 for _ in _source_files())
        assert count > 5, (
            f'Only {count} source file(s) found — expected many more.\n'
            f'Lambda root: {_lambda_root()}'
        )

    # ------------------------------------------------------------------ #
    # Pattern 1: json.dumps(event)                                        #
    # ------------------------------------------------------------------ #

    def test_no_json_dumps_event(self):
        """json.dumps(event[, ...]) must not appear in any handler source.

        This is the canonical spelling of the defect.  The event dict
        contains the full API Gateway request including the Authorization
        header; serialising it writes the bearer token to CloudWatch.
        """
        violations = []
        for path in _source_files():
            text = path.read_text(encoding='utf-8')
            for lineno, line in enumerate(text.splitlines(), 1):
                if _PAT_JSON_DUMPS_EVENT.search(line):
                    violations.append(f'{path.relative_to(_lambda_root())}:{lineno}: {line.strip()!r}')

        assert not violations, (
            'Found json.dumps(event) in handler source(s) — this writes the\n'
            'caller\'s Authorization header (bearer token) to CloudWatch logs:\n'
            + '\n'.join(f'  {v}' for v in violations)
        )

    # ------------------------------------------------------------------ #
    # Pattern 2: {event} in an f-string on a logger call line             #
    # ------------------------------------------------------------------ #

    def test_no_fstring_event_in_logger_calls(self):
        """{{event}} must not be embedded in an f-string passed to a logger method.

        Example of the banned pattern::

            logger.info(f"received {event}")

        The check is single-line: the logger call and {event} must appear on
        the same source line.  Multi-line log statements spanning several
        physical lines are outside this guard's scope (see module docstring).
        """
        violations = []
        for path in _source_files():
            text = path.read_text(encoding='utf-8')
            for lineno, line in enumerate(text.splitlines(), 1):
                if _PAT_LOGGER_CALL.search(line) and _PAT_FSTRING_EVENT.search(line):
                    violations.append(f'{path.relative_to(_lambda_root())}:{lineno}: {line.strip()!r}')

        assert not violations, (
            'Found {event} inside a logger call — this stringifies the whole\n'
            'event (including headers) into the log message:\n'
            + '\n'.join(f'  {v}' for v in violations)
        )

    # ------------------------------------------------------------------ #
    # Pattern 3: logger.<level>(event)                                    #
    # ------------------------------------------------------------------ #

    def test_no_logger_event_direct(self):
        """logger.<level>(event) must not appear in any handler source.

        Passing the event object directly as the log message is equivalent
        to logging str(event) — the full dict including headers.
        """
        violations = []
        for path in _source_files():
            text = path.read_text(encoding='utf-8')
            for lineno, line in enumerate(text.splitlines(), 1):
                if _PAT_LOGGER_EVENT_DIRECT.search(line):
                    violations.append(f'{path.relative_to(_lambda_root())}:{lineno}: {line.strip()!r}')

        assert not violations, (
            'Found logger.<level>(event) in handler source(s) — this logs the\n'
            'full event dict (including the Authorization header) as a message:\n'
            + '\n'.join(f'  {v}' for v in violations)
        )
