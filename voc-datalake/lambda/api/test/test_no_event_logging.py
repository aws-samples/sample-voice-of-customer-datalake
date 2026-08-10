"""Guard: no handler source may write the raw Lambda event to logs.

This test walks every non-test Python source under lambda/ and fails on any
of the five spellings of the defect identified in issue #245:

  1. ``json.dumps(event[, ...])`` on a line that also calls a logger method
        The whole event is serialised; the output contains the caller's
        ``Authorization`` header (Cognito bearer token) in plain text.
        Note: the guard requires both a ``logger.`` call and ``json.dumps(event...)``
        on the same line, so legitimate event-forwarding to downstream services
        (e.g. ``lambda_client.invoke(Payload=json.dumps(event))``) is not flagged.

  2. ``f"...{event}..."`` on a line that also calls a logger method — the
     str() of the whole event object is interpolated into the log message.
     Variants caught are the ones that stringify the *entire* event:
     ``{event}``, ``{event!r}``, ``{event!s}`` and ``{event:...}``.
     Logging a single named field (``{event['path']}``,
     ``{event.get('httpMethod')}``, ``{list(event.keys())}``) is *permitted by
     design* — that is the recommended remediation when this guard fires, so
     subscript and attribute access are deliberately not matched.

  3. ``logger.<level>(event)`` / ``logger.<level>(event, ...)``
        The event is passed directly as the log-message argument.

  4. ``logger.<level>("...%s", event)`` — printf-style lazy formatting, where
     the event is a non-first positional argument.  This is the spelling the
     stdlib ``logging`` docs recommend over f-strings, so it is a likely
     accidental reintroduction.

  5. ``logger.<level>("msg", extra={"event": event})`` and
     ``logger.append_keys(event=event)`` — Powertools structured fields.  The
     event is serialised into the JSON log record, so the leak is identical.
     ``extra=`` is the house idiom in ``projects_handler.py`` after this fix,
     which makes this spelling especially easy to reach for.  As with pattern 1,
     a ``logger.`` call must be present on the same line, so plain forwarding
     such as ``handler(event=event)`` is not flagged.

Spellings the guard does NOT catch (documented to set honest expectations):

  * Multi-line expressions where the logger call and the event embed are on
    different source lines — only single-line matching is performed.
  * ``print(event)`` — only ``logger.*`` calls are checked.
  * ``logging.getLogger().info(event)`` — only the ``logger`` name is matched.
  * ``json.dumps(event.copy())`` or ``json.dumps(dict(event))`` — the event
    wrapped by a further call is not matched.
  * Variables aliased to something other than ``event``
    (e.g. ``evt = event; logger.info(evt)``).
  * The *serialised* event aliased into a variable first, e.g.
    ``payload = json.dumps(event)`` on one line followed by
    ``logger.info(payload)`` on the next: pattern 1 needs the logger call and
    ``json.dumps(event...)`` on the same line, and pattern 3 only matches a
    literal ``event`` argument.
  * Custom serialisers other than ``json.dumps``.
  * Handler sources under ``plugins/`` (ingestor Lambda functions for S3/SQS
    events) — ``_SCAN_ROOTS`` covers ``lambda/`` subdirectories only; the
    ``plugins/`` tree is outside this guard's scope.

How this guard is executed
--------------------------

``.github/workflows/no-event-logging-guard.yml`` runs this file on every pull
request and on pushes to ``development``.  That workflow deliberately runs this
one file rather than the whole backend suite: the guard imports only ``re`` and
``pathlib``, so it needs no application dependencies and no Lambda layer build,
whereas the rest of the suite cannot yet run in a bare environment.

It is also picked up by the local backend gate, ``npm run test:backend``
(``pytest``; ``pytest.ini`` sets ``testpaths = lambda plugins``).

One caveat on "impossible to reintroduce": at the time of writing
``development`` is **not** a protected branch and has no required status checks,
so a red run of this workflow surfaces a failing check on the pull request but
does not by itself block a merge.  Making it blocking needs a branch-protection
rule, which is a repository-settings change and cannot live in this file.
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
    # 'stream' is omitted: lambda/stream/ contains only TypeScript source;
    # rglob('*.py') would find nothing there.
]

# Directory names that stop the descent when encountered.
_EXCLUDE_DIR_NAMES = frozenset({'test', 'layers', 'cdk.out', '__pycache__', '.venv', 'node_modules'})


def _lambda_root() -> Path:
    # This file lives at lambda/api/test/test_no_event_logging.py.
    # parents[0] = lambda/api/test, parents[1] = lambda/api, parents[2] = lambda/
    return Path(__file__).resolve().parents[2]


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

# Pattern 1 — json.dumps(event) or json.dumps(event, ...) on a logger line.
# Matches the opening of the call; does not require a closing paren so that
# multi-arg variants like json.dumps(event, cls=DecimalEncoder) are caught.
# The test pairs this with _PAT_LOGGER_CALL so that legitimate event-forwarding
# lines (e.g. Payload=json.dumps(event)) are not false-positived.
_PAT_JSON_DUMPS_EVENT = re.compile(r'\bjson\.dumps\(\s*event\s*[,)]')

# Pattern 2 — {event...} inside an f-string on a line that also contains a
# logger call.  The two sub-patterns are checked independently so a line
# with neither is not flagged.
# _PAT_FSTRING_EVENT matches only the forms that stringify the WHOLE event:
#   {event}                — bare embed (} after event)
#   {event!r}, {event!s}   — conversion flags (! after event)
#   {event:...}            — format spec (: after event)
# Deliberately NOT matched: {event["key"]} and {event.get("path")}.  Logging a
# single named field is the recommended remediation when this guard fires, so
# flagging it would reject the correct fix (and would fire on the existing
# f"keys={list(event.keys())}" lines in lambda/jobs/*, which log key names
# only, never values).
_PAT_LOGGER_CALL = re.compile(r'\blogger\.\w+\(')
_PAT_FSTRING_EVENT = re.compile(r'\{event[}!:]')

# Pattern 3 — logger.<level>(event) or logger.<level>(event, ...)
_PAT_LOGGER_EVENT_DIRECT = re.compile(r'\blogger\.\w+\(\s*event\s*[,)]')

# Pattern 4 — event passed as a non-first positional argument to a logger call,
# i.e. printf-style lazy formatting: logger.info("event: %s", event).
# Pattern 3 cannot see this because it requires `event` to be the first argument.
_PAT_LOGGER_EVENT_ARG = re.compile(r'\blogger\.\w+\([^)]*,\s*event\s*[,)]')

# Pattern 5 — event embedded in a Powertools structured field on a logger line:
#   logger.info("msg", extra={"event": event})   — value inside an extra= dict
#   logger.append_keys(event=event)              — sticky key
# Both serialise the event into the JSON log record.  The test pairs this with
# _PAT_LOGGER_CALL so that non-logging keyword forwarding (e.g.
# handler(event=event)) is not flagged.
_PAT_LOGGER_EVENT_STRUCTURED = re.compile(
    r'extra\s*=\s*\{[^}]*[:,]\s*event\s*[,}]'
    r'|\bevent\s*=\s*event\b'
)


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
        assert count > 5, (  # currently ~56 files; any credible lambda tree has well more than 5
            f'Only {count} source file(s) found — expected many more.\n'
            f'Lambda root: {_lambda_root()}'
        )

    # ------------------------------------------------------------------ #
    # Pattern 1: json.dumps(event)                                        #
    # ------------------------------------------------------------------ #

    def test_no_json_dumps_event(self):
        """logger.<level>(...json.dumps(event[, ...])...) must not appear in handler source.

        This is the canonical spelling of the defect.  The event dict
        contains the full API Gateway request including the Authorization
        header; serialising it writes the bearer token to CloudWatch.

        Both a logger call and json.dumps(event...) must appear on the same line
        for a violation to be reported.  Lines that forward the event to a
        downstream service (e.g. ``Payload=json.dumps(event)``) are not flagged
        because they do not also contain a logger call.
        """
        violations = []
        for path in _source_files():
            text = path.read_text(encoding='utf-8')
            for lineno, line in enumerate(text.splitlines(), 1):
                if _PAT_LOGGER_CALL.search(line) and _PAT_JSON_DUMPS_EVENT.search(line):
                    violations.append(f'{path.relative_to(_lambda_root())}:{lineno}: {line.strip()!r}')

        assert not violations, (
            'Found logger call with json.dumps(event) in handler source(s) — this writes the\n'
            'caller\'s Authorization header (bearer token) to CloudWatch logs:\n'
            + '\n'.join(f'  {v}' for v in violations)
        )

    # ------------------------------------------------------------------ #
    # Pattern 2: {event} in an f-string on a logger call line             #
    # ------------------------------------------------------------------ #

    def test_no_fstring_event_in_logger_calls(self):
        """`{event}` must not be embedded in an f-string passed to a logger method.

        Example of the banned pattern::

            logger.info(f"received {event}")

        Only the forms that stringify the whole event are flagged: ``{event}``,
        ``{event!r}``, ``{event!s}`` and ``{event:...}``.  Logging an individual
        field — ``logger.info(f"path={event['path']}")`` or
        ``f"keys={list(event.keys())}"`` — is permitted by design; it is the
        remediation a developer should apply when this guard fires.

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

    # ------------------------------------------------------------------ #
    # Pattern 4: logger.<level>("...%s", event)                           #
    # ------------------------------------------------------------------ #

    def test_no_logger_event_as_positional_arg(self):
        """The event must not be passed as a printf-style logger argument.

        Example of the banned pattern::

            logger.info("received event: %s", event)

        The stdlib logging docs recommend %s-style lazy formatting over
        f-strings, so this is the spelling a developer following general Python
        best practice would write — and the one pattern 3 cannot see, because
        it requires ``event`` to be the first argument.
        """
        violations = []
        for path in _source_files():
            text = path.read_text(encoding='utf-8')
            for lineno, line in enumerate(text.splitlines(), 1):
                if _PAT_LOGGER_EVENT_ARG.search(line):
                    violations.append(f'{path.relative_to(_lambda_root())}:{lineno}: {line.strip()!r}')

        assert not violations, (
            'Found the event passed as a printf-style logger argument — the\n'
            'full event dict (including the Authorization header) is interpolated\n'
            'into the log record:\n'
            + '\n'.join(f'  {v}' for v in violations)
        )

    # ------------------------------------------------------------------ #
    # Pattern 5: extra={"event": event} / append_keys(event=event)        #
    # ------------------------------------------------------------------ #

    def test_no_event_in_structured_logger_fields(self):
        """The event must not be attached as a Powertools structured field.

        Examples of the banned patterns::

            logger.info("handled", extra={"event": event})
            logger.append_keys(event=event)

        Powertools serialises ``extra=`` values and sticky keys into the JSON log
        record, so the Authorization header is leaked exactly as it would be by
        ``json.dumps(event)``.  ``extra=`` is the house idiom in
        ``projects_handler.py`` after this fix, which makes it an easy spelling
        to reach for by accident.
        """
        violations = []
        for path in _source_files():
            text = path.read_text(encoding='utf-8')
            for lineno, line in enumerate(text.splitlines(), 1):
                if _PAT_LOGGER_CALL.search(line) and _PAT_LOGGER_EVENT_STRUCTURED.search(line):
                    violations.append(f'{path.relative_to(_lambda_root())}:{lineno}: {line.strip()!r}')

        assert not violations, (
            'Found the event attached to a logger call as a structured field —\n'
            'Powertools serialises it into the JSON log record, including the\n'
            'caller\'s Authorization header:\n'
            + '\n'.join(f'  {v}' for v in violations)
        )


# ---------------------------------------------------------------------------
# Pattern calibration
# ---------------------------------------------------------------------------

class TestPatternCalibration:
    """The regexes must fire on real leaks and stay quiet on safe logging.

    The source-scan tests above pass whenever the tree happens to be clean, so
    they cannot tell a correct pattern from one that matches nothing.  These
    cases pin the intended boundary in both directions: every widening or
    narrowing of a pattern has a test here that fails if it is reverted.
    """

    # --- must be flagged (whole event reaches the log record) ---------- #

    def test_flags_json_dumps_event_on_logger_line(self):
        line = 'logger.info(f"Received event: {json.dumps(event)}")'
        assert _PAT_LOGGER_CALL.search(line) and _PAT_JSON_DUMPS_EVENT.search(line)

    def test_flags_whole_event_fstring_variants(self):
        for line in (
            'logger.info(f"received {event}")',
            'logger.info(f"received {event!r}")',
            'logger.info(f"received {event!s}")',
            'logger.info(f"received {event:>10}")',
        ):
            assert _PAT_FSTRING_EVENT.search(line), line

    def test_flags_event_as_printf_argument(self):
        for line in (
            'logger.info("event: %s", event)',
            'logger.warning("e=%r", event)',
            'logger.info("a %s b %s", other, event)',
        ):
            assert _PAT_LOGGER_EVENT_ARG.search(line), line

    def test_flags_event_in_structured_fields(self):
        for line in (
            'logger.info("msg", extra={"event": event})',
            "logger.info('msg', extra={'request': req, 'event': event})",
            'logger.append_keys(event=event)',
        ):
            assert _PAT_LOGGER_CALL.search(line) and _PAT_LOGGER_EVENT_STRUCTURED.search(line), line

    # --- must NOT be flagged (no sensitive value reaches the log) ------ #

    def test_does_not_flag_selective_field_logging(self):
        """Logging one named field is the recommended fix, not a violation."""
        for line in (
            'logger.info(f"path={event[\'path\']}")',
            'logger.info(f"method={event.get(\'httpMethod\')}")',
            'logger.info(f"keys={event.keys()}")',
            'logger.info(f"Persona generator invoked with event keys: {list(event.keys())}")',
            'logger.info("path: %s", event["path"])',
        ):
            assert not _PAT_FSTRING_EVENT.search(line), line
            assert not _PAT_LOGGER_EVENT_ARG.search(line), line
            assert not _PAT_LOGGER_EVENT_DIRECT.search(line), line

    def test_does_not_flag_event_forwarding(self):
        """Serialising the event for a downstream service is legitimate."""
        for line in (
            'lambda_client.invoke(FunctionName=name, Payload=json.dumps(event))',
            'sqs.send_message(QueueUrl=url, MessageBody=json.dumps(event))',
            'inner_handler(event=event, context=context)',
        ):
            assert not _PAT_LOGGER_CALL.search(line), line

    def test_does_not_flag_status_code_only_response_log(self):
        """The replacement log in projects_handler.py must stay clean."""
        line = 'logger.debug("Returning response", extra={"status_code": result.get("statusCode")})'
        assert not _PAT_JSON_DUMPS_EVENT.search(line)
        assert not _PAT_FSTRING_EVENT.search(line)
        assert not _PAT_LOGGER_EVENT_DIRECT.search(line)
        assert not _PAT_LOGGER_EVENT_ARG.search(line)
        assert not _PAT_LOGGER_EVENT_STRUCTURED.search(line)
