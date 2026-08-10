"""Guard: no handler source may write the raw Lambda event to logs.

The rule
--------

**A violation is the *whole* ``event`` object reaching a log record.  Selecting
something out of the event first is not a violation.**

That is the single distinction every pattern below encodes, and it is the thing
to preserve when one of them is edited.  ``event`` is the API Gateway request:
it carries the caller's ``Authorization`` header (a Cognito bearer token) and
the full request body, so serialising it — by any spelling — writes the token to
CloudWatch (issue #245).  ``event['path']``, ``event.get('httpMethod')`` and
``list(event.keys())`` are *selections*: they name what they disclose, they are
the remediation a developer should apply when this guard fires, and flagging them
would train people to disable the guard instead of using it.

Two corollaries follow, and they explain shapes that look inconsistent at first
glance:

  * A bare ``event`` handed to something that is *not* a logger is not a
    violation — forwarding it to a downstream service
    (``lambda_client.invoke(Payload=json.dumps(event))``) discloses nothing to
    the log.  So every pattern except 3 requires a ``logger.`` call to be
    present as well.
  * A bare ``event`` passed to a *helper* inside a logger call
    (``logger.info("route=%s", route_for(method, event))``) is not a violation
    either: what reaches the record is the helper's return value.  Patterns 4
    and 5 therefore inspect only the arguments passed *directly* to the logger,
    with nested parenthesised groups elided (see ``_logger_call_arg_texts``).

The five spellings the rule is enforced against:

  1. ``json.dumps(event[, ...])`` on a line that also calls a logger method
        The whole event is serialised; the output contains the caller's
        ``Authorization`` header (Cognito bearer token) in plain text.
        Note: the guard requires both a ``logger.`` call and ``json.dumps(event...)``
        on the same line, so legitimate event-forwarding to downstream services
        (e.g. ``lambda_client.invoke(Payload=json.dumps(event))``) is not flagged.

  2. ``f"...{event}..."`` on a line that also calls a logger method — the
     str() of the whole event object is interpolated into the log message.
     Variants caught are the ones that stringify the *entire* event:
     ``{event}``, ``{event!r}``, ``{event!s}``, ``{event:...}`` and the
     self-documenting form ``{event=}`` / ``{event = }`` (which implies
     ``!r``).  Logging a single named field (``{event['path']}``,
     ``{event.get('httpMethod')}``, ``{list(event.keys())}``) is *permitted by
     design* — subscript and attribute access are deliberately not matched.

  3. ``logger.<level>(event)`` / ``logger.<level>(event, ...)``
        The event is passed directly as the log-message argument.

  4. ``logger.<level>("...%s", event)`` — printf-style lazy formatting, where
     the event is a non-first positional argument.  This is the spelling the
     stdlib ``logging`` docs recommend over f-strings, so it is a likely
     accidental reintroduction.  Matched against the logger call's *direct*
     arguments, so ``logger.info("%s %s", ctx.get_id(), event)`` is caught
     (a ``)`` in an earlier argument does not hide it) while
     ``logger.info("route=%s", route_for(method, event))`` is not.

  5. ``logger.<level>("msg", extra={"event": event})`` and
     ``logger.append_keys(event=event)`` — Powertools structured fields.  The
     event is serialised into the JSON log record, so the leak is identical.
     ``extra=`` is the house idiom in ``projects_handler.py`` after this fix,
     which makes this spelling especially easy to reach for.  Also matched
     against the direct arguments, so nesting inside ``extra=``
     (``extra={"meta": {"x": 1}, "event": event}``) is caught and plain
     forwarding such as ``handler(event=event)`` is not.  A list value
     (``extra={"a": [event]}``) is caught; a *subscript* keyed by the event
     (``extra={"a": foo[event]}``) is not, since only the looked-up value
     reaches the record.

Separately from the five event patterns, ``TestResponseBodyNotLogged`` pins the
*egress* side of the same handler: the response log in ``projects_handler.py``
must record the status code and not the body, which may contain user-generated
content.  Both of its checks read the line out of the handler rather than
restating it, so neither can drift from — or pass despite — the code it protects.

The same rule applies there, spelled against ``result`` rather than ``event``:
the whole response must not reach the record, by any of the spellings patterns
1-5 cover — serialised, interpolated, printf-style, or attached through
``extra=``.  That last one is the spelling this fix itself makes idiomatic on
that very line, so it is guarded rather than merely documented.  Because a
deny-list of spellings can always be outrun by the next serialisation idiom, a
second check *allow-lists* the record's ``extra=`` keys
(``_EGRESS_ALLOWED_EXTRA_KEYS``): whatever expression produces it, a field that
is not ``status_code`` fails.

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
  * ``@logger.inject_lambda_context(log_event=True)`` and the
    ``POWERTOOLS_LOGGER_LOG_EVENT=true`` environment variable, either of which
    makes Powertools log the event itself.  Neither appears in any Python or CDK
    source today; covering them means scanning TypeScript as well, which this
    Python-only walk cannot do.
  * ``event`` reaching the log via a *keyword* argument other than ``extra=`` or
    ``event=`` (e.g. a bespoke ``logger.structure(payload=event)`` helper).

Residual imprecisions in the patterns themselves — known and accepted:

  * Patterns 4 and 5 elide nested parenthesised groups before looking for a bare
    ``event`` argument, so a bare ``event`` appearing *inside* a nested call is
    invisible to them: ``logger.info("%s", wrap(event))`` is not flagged.  That
    is the intended reading (the helper's return value is what is logged), but it
    also means ``logger.info("%s", identity(event))`` — a helper that returns the
    event unchanged — slips through.
  * Pattern 5's bare ``event=event`` alternative is scoped to the logger call's
    own arguments, so ``logger.info("x", extra=f(event=event))`` is not flagged
    while ``logger.append_keys(event=event)`` is.
  * The egress deny-list inherits both of the above, since it reuses the same
    shapes against ``result``.  The ``extra=`` key allow-list does not — it reads
    the field names off the raw line, so it holds regardless of what expression
    the value is.  It does assume the keys are string literals: a computed key
    (``extra={key_name: result}``) is invisible to it, though the deny-list still
    catches the bare ``result`` in that example.

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

_PAT_LOGGER_CALL = re.compile(r'\blogger\.\w+\(')

# Pattern 1 — json.dumps(event) or json.dumps(event, ...) on a logger line.
# Matches the opening of the call; does not require a closing paren so that
# multi-arg variants like json.dumps(event, cls=DecimalEncoder) are caught.
# Paired with _PAT_LOGGER_CALL so that legitimate event-forwarding lines
# (e.g. Payload=json.dumps(event)) are not false-positived.
_PAT_JSON_DUMPS_EVENT = re.compile(r'\bjson\.dumps\(\s*event\s*[,)]')

# Pattern 2 — {event...} inside an f-string on a line that also contains a
# logger call.  The two sub-patterns are checked independently so a line
# with neither is not flagged.
# _PAT_FSTRING_EVENT matches only the forms that stringify the WHOLE event:
#   {event}                — bare embed (} after event)
#   {event!r}, {event!s}   — conversion flags (! after event)
#   {event:...}            — format spec (: after event)
#   {event=}, {event = }   — self-documenting form, which implies !r (= after
#                            event, with optional space as PEP 501 permits)
# Deliberately NOT matched: {event["key"]} and {event.get("path")}.  Logging a
# single named field is the recommended remediation when this guard fires, so
# flagging it would reject the correct fix (and would fire on the existing
# f"keys={list(event.keys())}" lines in lambda/jobs/*, which log key names
# only, never values).
_PAT_FSTRING_EVENT = re.compile(r'\{event\s*[}!:=]')

# Pattern 3 — logger.<level>(event) or logger.<level>(event, ...): the event is
# the log message itself, so str(event) — the full dict — becomes the record.
_PAT_EVENT_FIRST_ARG = re.compile(r'^\s*event\s*[,)]')

# Pattern 4 — event as a non-first positional argument, i.e. printf-style lazy
# formatting: logger.info("event: %s", event).  Pattern 3 cannot see this
# because it requires `event` to be the first argument.
_PAT_EVENT_LATER_ARG = re.compile(r',\s*event\s*[,)]')

# Pattern 5 — event embedded in a Powertools structured field:
#   logger.info("msg", extra={"event": event})   — value inside an extra= dict
#   logger.append_keys(event=event)              — sticky key
# Both serialise the event into the JSON log record.  The value position accepts
# a preceding ':' or ',' (the event is the dict value) or a '[' that *opens a
# collection* (the event is an element of a list value, extra={"a": [event]}).
# The `(?<![\w\]\)])` lookbehind is what distinguishes a list literal from a
# subscript: in `extra={"a": foo[event]}` the '[' follows an identifier, so only
# the looked-up value reaches the record and the line is not flagged.  Likewise
# `event[` is a selection, not a bare event, so selections stay unflagged.
_PAT_EVENT_STRUCTURED = re.compile(
    r'extra\s*=\s*\{[^}]*(?:[:,]|(?<![\w\]\)])\[)\s*event\s*[,}\]]'
    r'|\bevent\s*=\s*event\b'
)

# Patterns 3, 4 and 5 are matched against the arguments passed *directly* to a
# logger call, not against the raw line.  Scanning the raw line for a prefix
# (the previous `logger\.\w+\([^)]*,` shape) errs in both directions: a ')' in
# an earlier argument stops the scan and hides a real violation
# (`logger.info("%s %s", ctx.get_id(), event)`), while a bare `event` handed to
# a helper inside the call is flagged even though only the helper's return value
# is logged (`logger.info("route=%s", route_for(method, event))`).  Extracting
# the argument list once, with nested groups elided, removes both errors.


def _is_elided(stack) -> bool:
    """True while inside a group whose contents are not the logger's own argument.

    Any parenthesised group is elided: what it contains belongs to an inner call,
    and what reaches the log record is that call's return value.  A *single* set
    of braces is kept, because ``extra={...}`` is itself a direct argument and
    pattern 5 has to see inside it; braces nested within it are elided so that
    ``extra={"meta": {"x": 1}, "event": event}`` still exposes the ``event`` key.
    """
    return '(' in stack or stack.count('{') > 1


def _logger_call_arg_texts(line: str):
    """Yield the direct-argument text of each ``logger.<level>(...)`` call in `line`.

    Two normalisations make the argument text safe to match simple patterns
    against:

    * **Nested groups are elided** — a parenthesised group becomes ``(...)`` and a
      brace group nested inside another becomes ``...`` (see ``_is_elided``).
      Subscripts are preserved, so ``event['path']`` remains visible as a
      selection rather than a bare ``event``.
    * **String-literal contents are dropped**, keeping the quotes.  Prose in a
      log message must not be mistaken for code — a message that happens to read
      ``"..., event)"`` is not a violation.

    A ``)`` sentinel is appended so the final argument has a terminator whether
    or not the call closes on this line.
    """
    for match in _PAT_LOGGER_CALL.finditer(line):
        out = []
        stack = []
        quote = None
        i = match.end()
        while i < len(line):
            char = line[i]
            if quote is not None:
                if char == '\\':
                    i += 2
                    continue
                if char == quote:
                    quote = None
                    if not _is_elided(stack):
                        out.append(char)
                i += 1
                continue
            if char in '"\'':
                quote = char
                if not _is_elided(stack):
                    out.append(char)
            elif char in '({':
                was_elided = _is_elided(stack)
                stack.append(char)
                if _is_elided(stack):
                    if not was_elided:
                        # Placeholders must not contain a brace: pattern 5 scans
                        # the inside of extra={...} with a [^}]* run.
                        out.append('(...)' if char == '(' else '...')
                else:
                    out.append(char)
            elif char in ')}':
                if not stack:
                    if char == ')':
                        break  # the logger call's own closing paren
                    i += 1
                    continue
                was_elided = _is_elided(stack)
                stack.pop()
                if not was_elided and not _is_elided(stack):
                    out.append(char)
            elif not _is_elided(stack):
                out.append(char)
            i += 1
        yield ''.join(out) + ')'


# ---------------------------------------------------------------------------
# Egress side: the same rule, expressed against `result`
# ---------------------------------------------------------------------------
#
# The five patterns above are all keyed on the identifier ``event``, so they are
# structurally blind to whatever is done to the *response*.  The response log in
# projects_handler.py gets the same rule — the whole object must not reach the
# record — spelled against ``result``, because the response carries
# user-generated content.
#
# Deny-listing spellings alone loses a race it cannot win: whichever
# serialisation idiom the surrounding code makes fashionable next is by
# definition not on the list.  So the egress check pairs the deny-list with an
# allow-list on the ``extra=`` keys: that log record may carry ``status_code``
# and nothing else, whatever expression produces it.

_PAT_RESULT_FIRST_ARG = re.compile(r'^\s*result\s*[,)]')
_PAT_RESULT_LATER_ARG = re.compile(r',\s*result\s*[,)]')
_PAT_RESULT_STRUCTURED = re.compile(
    r'extra\s*=\s*\{[^}]*(?:[:,]|(?<![\w\]\)])\[)\s*result\s*[,}\]]'
    r'|\bresult\s*=\s*result\b'
)

# The extra= mapping of the egress log, read off the raw line (the argument
# extractor drops string contents, so key *names* are only visible here).
_PAT_EXTRA_MAPPING = re.compile(r'extra\s*=\s*\{([^}]*)\}')
_PAT_MAPPING_KEY = re.compile(r'''['"](\w+)['"]\s*:''')

# The only field the response log may attach.  The status code is not user
# content; anything else on that record has to be argued for by widening this
# set, which is a visible decision rather than an accidental one.
_EGRESS_ALLOWED_EXTRA_KEYS = frozenset({'status_code'})


def _flags_result_reaching_the_record(line: str) -> bool:
    """True if the whole ``result`` object reaches a log record on `line`.

    The ``result`` counterpart of patterns 3-5: the response as the log message,
    as a printf-style argument, or attached as a Powertools structured field.
    """
    return any(
        _PAT_RESULT_FIRST_ARG.search(args)
        or _PAT_RESULT_LATER_ARG.search(args)
        or _PAT_RESULT_STRUCTURED.search(args)
        for args in _logger_call_arg_texts(line)
    )


def _extra_keys(line: str) -> set:
    """Return the literal key names of every ``extra={...}`` mapping on `line`."""
    return {
        key
        for mapping in _PAT_EXTRA_MAPPING.findall(line)
        for key in _PAT_MAPPING_KEY.findall(mapping)
    }


def _unexpected_extra_keys(line: str) -> set:
    """Return the ``extra=`` field names on `line` that the egress log may not carry."""
    return _extra_keys(line) - _EGRESS_ALLOWED_EXTRA_KEYS


def _flags_json_dumps_event(line: str) -> bool:
    """Pattern 1: the event is serialised on a line that also logs."""
    return bool(_PAT_LOGGER_CALL.search(line) and _PAT_JSON_DUMPS_EVENT.search(line))


def _flags_fstring_event(line: str) -> bool:
    """Pattern 2: the whole event is interpolated into an f-string that is logged."""
    return bool(_PAT_LOGGER_CALL.search(line) and _PAT_FSTRING_EVENT.search(line))


def _flags_event_as_first_arg(line: str) -> bool:
    """Pattern 3: the event is the log message."""
    return any(_PAT_EVENT_FIRST_ARG.search(args) for args in _logger_call_arg_texts(line))


def _flags_event_as_later_arg(line: str) -> bool:
    """Pattern 4: the event is a printf-style argument to the log message."""
    return any(_PAT_EVENT_LATER_ARG.search(args) for args in _logger_call_arg_texts(line))


def _flags_event_in_structured_field(line: str) -> bool:
    """Pattern 5: the event is attached as a Powertools structured field."""
    return any(_PAT_EVENT_STRUCTURED.search(args) for args in _logger_call_arg_texts(line))


def _scan(predicate):
    """Return ``file:line: source`` for every scanned line satisfying `predicate`."""
    violations = []
    for path in _source_files():
        text = path.read_text(encoding='utf-8')
        for lineno, line in enumerate(text.splitlines(), 1):
            if predicate(line):
                violations.append(f'{path.relative_to(_lambda_root())}:{lineno}: {line.strip()!r}')
    return violations


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
        violations = _scan(_flags_json_dumps_event)
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
        ``{event!r}``, ``{event!s}``, ``{event:...}`` and ``{event=}``.  Logging
        an individual field — ``logger.info(f"path={event['path']}")`` or
        ``f"keys={list(event.keys())}"`` — is permitted by design; it is the
        remediation a developer should apply when this guard fires.

        The check is single-line: the logger call and {event} must appear on
        the same source line.  Multi-line log statements spanning several
        physical lines are outside this guard's scope (see module docstring).
        """
        violations = _scan(_flags_fstring_event)
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
        violations = _scan(_flags_event_as_first_arg)
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

        Matched against the logger call's direct arguments, so a ``)`` in an
        earlier argument cannot hide a violation, and a bare ``event`` handed to
        a helper inside the call is not one.
        """
        violations = _scan(_flags_event_as_later_arg)
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

        Matched against the logger call's direct arguments, so a nested dict
        inside ``extra=`` cannot hide a violation and non-logging keyword
        forwarding (``handler(event=event)``) is not one.
        """
        violations = _scan(_flags_event_in_structured_field)
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

    # Every predicate, so the "no safe line is flagged" cases below assert
    # against all five patterns rather than whichever ones were remembered.
    _ALL = (
        _flags_json_dumps_event,
        _flags_fstring_event,
        _flags_event_as_first_arg,
        _flags_event_as_later_arg,
        _flags_event_in_structured_field,
    )

    # --- must be flagged (whole event reaches the log record) ---------- #

    def test_flags_json_dumps_event_on_logger_line(self):
        assert _flags_json_dumps_event('logger.info(f"Received event: {json.dumps(event)}")')

    def test_flags_whole_event_fstring_variants(self):
        for line in (
            'logger.info(f"received {event}")',
            'logger.info(f"received {event!r}")',
            'logger.info(f"received {event!s}")',
            'logger.info(f"received {event:>10}")',
            # Self-documenting form (PEP 501); `=` implies !r, so the whole
            # event repr — Authorization header included — reaches the record.
            'logger.debug(f"{event=}")',
            'logger.info(f"dbg {event = }")',
        ):
            assert _flags_fstring_event(line), line

    def test_flags_event_as_message(self):
        for line in (
            'logger.info(event)',
            'logger.info(event, extra={"a": 1})',
        ):
            assert _flags_event_as_first_arg(line), line

    def test_flags_event_as_printf_argument(self):
        for line in (
            'logger.info("event: %s", event)',
            'logger.warning("e=%r", event)',
            'logger.info("a %s b %s", other, event)',
            # A ')' in an earlier argument must not hide the event.
            'logger.info("%s %s", ctx.get_id(), event)',
            'logger.warning("%s %s", event.get("path"), event)',
        ):
            assert _flags_event_as_later_arg(line), line

    def test_flags_event_in_structured_fields(self):
        for line in (
            'logger.info("msg", extra={"event": event})',
            "logger.info('msg', extra={'request': req, 'event': event})",
            'logger.append_keys(event=event)',
            # A nested dict inside extra= must not hide the event.
            'logger.info("m", extra={"meta": {"x": 1}, "event": event})',
            # Nor a list value.
            'logger.info("m", extra={"events": [event]})',
        ):
            assert _flags_event_in_structured_field(line), line

    # --- must NOT be flagged (no sensitive value reaches the log) ------ #

    def test_does_not_flag_selective_field_logging(self):
        """Logging one named field is the recommended fix, not a violation."""
        for line in (
            'logger.info(f"path={event[\'path\']}")',
            'logger.info(f"method={event.get(\'httpMethod\')}")',
            'logger.info(f"keys={event.keys()}")',
            'logger.info(f"Persona generator invoked with event keys: {list(event.keys())}")',
            'logger.info("path: %s", event["path"])',
            'logger.info("keys: %s", list(event.keys()))',
        ):
            for predicate in self._ALL:
                assert not predicate(line), f'{predicate.__name__}: {line}'

    def test_does_not_flag_event_passed_to_a_helper(self):
        """What reaches the record is the helper's return value, not the event."""
        for line in (
            'logger.info("route=%s", route_for(method, event))',
            'logger.info(f"route={route_for(method, event)}")',
            'logger.info("summary=%s", summarise(event))',
        ):
            for predicate in self._ALL:
                assert not predicate(line), f'{predicate.__name__}: {line}'

    def test_does_not_flag_event_forwarding(self):
        """Serialising the event for a downstream service is legitimate."""
        for line in (
            'lambda_client.invoke(FunctionName=name, Payload=json.dumps(event))',
            'sqs.send_message(QueueUrl=url, MessageBody=json.dumps(event))',
            'inner_handler(event=event, context=context)',
        ):
            for predicate in self._ALL:
                assert not predicate(line), f'{predicate.__name__}: {line}'

    def test_does_not_flag_prose_in_a_log_message(self):
        """A log message that merely reads like code is not a violation."""
        for line in (
            'logger.info("did not log the event) at all")',
            'logger.info("event: redacted")',
        ):
            for predicate in self._ALL:
                assert not predicate(line), f'{predicate.__name__}: {line}'

    def test_does_not_flag_a_subscript_keyed_by_the_event(self):
        """Only the looked-up value reaches the record, not the event.

        Pattern 5's value position accepts a leading '[' so a list value
        (``extra={"a": [event]}``) is caught; the lookbehind is what keeps that
        from also matching a subscript, where the '[' follows an identifier.
        """
        for line in (
            'logger.info("m", extra={"a": foo[event]})',
            'logger.info("m", extra={"k": d[event]})',
        ):
            for predicate in self._ALL:
                assert not predicate(line), f'{predicate.__name__}: {line}'


# ---------------------------------------------------------------------------
# Egress side of the same handler
# ---------------------------------------------------------------------------

class TestEgressCalibration:
    """The result-side predicates, pinned the same way as the event patterns.

    ``test_response_log_does_not_include_the_body`` reads one line out of one
    file, so it passes whenever that line happens to be clean — it cannot tell a
    working predicate from a no-op one.  These cases pin the boundary directly.
    """

    def test_flags_the_whole_response_reaching_the_record(self):
        for line in (
            # The spelling this PR makes idiomatic on that very line.
            'logger.info("Returning response", extra={"response": result})',
            'logger.info("Returning response", extra={"status_code": code, "body": result})',
            'logger.info("Returning response", extra={"responses": [result]})',
            'logger.append_keys(result=result)',
            'logger.info("Returning %s", result)',
            'logger.info(result)',
        ):
            assert _flags_result_reaching_the_record(line), line

    def test_does_not_flag_selecting_a_field_of_the_response(self):
        for line in (
            'logger.info("Returning response", extra={"status_code": result.get("statusCode")})',
            'logger.info("Returning response", extra={"status_code": result["statusCode"]})',
            'logger.info("Returning %s", result["statusCode"])',
            # A subscript keyed by the result is a lookup, not a disclosure.
            'logger.info("m", extra={"a": codes[result]})',
        ):
            assert not _flags_result_reaching_the_record(line), line

    def test_extra_keys_reads_the_field_names(self):
        line = 'logger.info("Returning response", extra={"status_code": result.get("statusCode")})'
        assert _extra_keys(line) == {'status_code'}
        assert _extra_keys('logger.info("m", extra={"a": 1, "b": 2})') == {'a', 'b'}
        # No extra= mapping at all means nothing to allow-list.
        assert _extra_keys('logger.info("plain message")') == set()

    def test_allow_list_rejects_any_field_but_the_status_code(self):
        """The allow-list half, pinned independently of the handler's current line.

        Without this, emptying ``_EGRESS_ALLOWED_EXTRA_KEYS`` of its meaning — or
        adding ``response`` to it — leaves the suite green, because
        ``test_response_log_attaches_only_the_status_code`` only ever reads the
        one line that is already clean.
        """
        assert _unexpected_extra_keys(
            'logger.info("Returning response", extra={"status_code": result.get("statusCode")})'
        ) == set()

        for line, expected in (
            ('logger.info("Returning response", extra={"response": result})', {'response'}),
            ('logger.info("Returning response", extra={"status_code": c, "body": b})', {'body'}),
            ('logger.info("Returning response", extra={"headers": h})', {'headers'}),
        ):
            assert _unexpected_extra_keys(line) == expected, line


def _egress_log_lines():
    """Return the egress log line(s) of projects_handler.py, read from source.

    A logger call mentioning "Returning".  Read rather than restated: asserting
    against a copy of the line can only ever verify the copy, which is how the
    first version of this check both drifted from the handler and passed while
    the body was reintroduced.
    """
    source = (_lambda_root() / 'api' / 'projects_handler.py').read_text(encoding='utf-8')
    return [
        line.strip()
        for line in source.splitlines()
        if 'Returning' in line and _PAT_LOGGER_CALL.search(line)
    ]


class TestResponseBodyNotLogged:
    """The response log in projects_handler.py must not carry the body.

    Separate from the five event patterns above, which all key on the identifier
    ``event`` and so cannot see anything done to ``result``.  The response may
    contain user-generated content (project text, verbatims, persona data), so
    the egress log records the status code only.

    Guarded from both sides, because a deny-list of spellings cannot anticipate
    the next serialisation idiom:

    * ``test_response_log_does_not_include_the_body`` rejects the whole
      ``result`` reaching the record by any of the spellings patterns 1-5 cover
      for ``event`` — serialised, interpolated, printf-style, or attached through
      ``extra=``.  The last of those is the one this PR itself makes idiomatic on
      that very line.
    * ``test_response_log_attaches_only_the_status_code`` allow-lists the
      ``extra=`` keys, so a new field cannot be added to that record without
      changing ``_EGRESS_ALLOWED_EXTRA_KEYS`` — a visible decision.
    """

    # Non-vacuity, shared by both tests below: without it either silently
    # becomes a no-op the moment the line is renamed — the same hole
    # test_scan_covers_projects_handler closes for the file walk.
    _NO_EGRESS = (
        'No egress log line found in projects_handler.py (a logger call '
        'mentioning "Returning").  If it was renamed, update this test; if it '
        'was deleted, delete this test.'
    )

    def test_response_log_does_not_include_the_body(self):
        """The whole response must not reach the egress log record."""
        egress = _egress_log_lines()
        assert egress, self._NO_EGRESS

        for line in egress:
            assert 'json.dumps(result' not in line, (
                f'The response body is serialised into the egress log: {line!r}\n'
                'It may contain user-generated content; log the status code only.'
            )
            assert '{result' not in line, (
                f'The response is interpolated into the egress log: {line!r}\n'
                'It may contain user-generated content; log the status code only.'
            )
            assert not _flags_result_reaching_the_record(line), (
                f'The whole response reaches the egress log record: {line!r}\n'
                'Powertools serialises extra= values and printf-style arguments '
                'into the JSON record, so this leaks the body exactly as '
                'json.dumps(result) did.  Log the status code only.'
            )

    def test_response_log_attaches_only_the_status_code(self):
        """The egress record's ``extra=`` may carry the status code and nothing else.

        The allow-list is the half of this guard that cannot be outrun by a new
        spelling: whatever expression is used, a field that is not
        ``status_code`` fails here.
        """
        egress = _egress_log_lines()
        assert egress, self._NO_EGRESS

        for line in egress:
            unexpected = _unexpected_extra_keys(line)
            assert not unexpected, (
                f'The egress log attaches unexpected field(s) {sorted(unexpected)}: {line!r}\n'
                'The response may contain user-generated content, so this record '
                f'carries only {sorted(_EGRESS_ALLOWED_EXTRA_KEYS)}.  If a new field is '
                'genuinely safe, add it to _EGRESS_ALLOWED_EXTRA_KEYS deliberately.'
            )
