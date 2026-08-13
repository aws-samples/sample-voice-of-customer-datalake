"""The extractor's logs are JSON, and they carry the document they are about.

This Lambda cannot import aws-lambda-powertools (that would need a layer, and
building one would force container bundling into VocCoreStack — see the handler's
module docstring), so it emits structured logs from a stdlib
`logging.Formatter` subclass instead. Same output shape, no dependency.

WHY IT MATTERS HERE MORE THAN ELSEWHERE: this is the one component whose failure
reaches the user as a single short sentence, so every diagnosis happens in
CloudWatch. `doc_id` appears in 18 log lines; as an f-string substring it is a
text search, as a field it is a filter.

FORMATTED OUTPUT IS CAPTURED AT EMIT TIME, not by formatting `caplog.records`
afterwards. The context fields are merged by the formatter from a module-level
dict that is cleared when the record finishes, so a record formatted after the
fact would have lost exactly the thing under test — and a test that passed
anyway would be proving nothing.
"""
import importlib
import io
import json
import logging

import pytest

from .conftest import TEST_BUCKET, png_header

TEXT_KEY = 'projects/proj_1/product_docs/raw/abc123.md'
IMAGE_KEY = 'projects/proj_1/product_docs/raw/abc123.png'

#: A configured model that is NOT allowlisted, so `_allowlisted` logs its warning
#: — a line emitted three frames below where the log context is set, by a function
#: that is handed no identifiers at all.
STALE_MODEL_ID = 'someone.stale.model-id'


def _record(key: str, size: int = 7) -> dict:
    """One S3 notification record. Separate from the `s3_event` fixture because
    the context-clearing test needs TWO in a single batch."""
    return {
        'eventName': 'ObjectCreated:Put',
        's3': {'bucket': {'name': TEST_BUCKET}, 'object': {'key': key, 'size': size}},
    }


@pytest.fixture
def reload_extractor(extractor):
    """Re-run the module's import-time side effects, then undo them.

    Those side effects ARE what TestImportingTheModuleLeavesTheHostAlone is about,
    and they happen once per process — so running them again is the only way to
    observe them. Everything a reload can reach outside the module is snapshotted
    and restored, because the loggers it configures outlive the test.
    """
    root = logging.getLogger()
    # The same object across reloads: logging caches loggers by name, so only the
    # module's classes are rebound, never its logger.
    ours = extractor.logger
    saved = {
        'ours_handlers': list(ours.handlers),
        'ours_level': ours.level,
        'ours_propagate': ours.propagate,
        'root_handlers': list(root.handlers),
        'root_level': root.level,
        # Restored too: a test that redirects the module's own handler to measure
        # what it emitted would otherwise leave every later line going there.
        'streams': [(h, h.stream) for h in ours.handlers
                    if isinstance(h, logging.StreamHandler)],
    }

    def _reload(times: int = 1):
        module = extractor
        for _ in range(times):
            module = importlib.reload(module)
        return module

    try:
        yield _reload
    finally:
        ours.handlers[:] = saved['ours_handlers']
        ours.setLevel(saved['ours_level'])
        ours.propagate = saved['ours_propagate']
        root.handlers[:] = saved['root_handlers']
        root.setLevel(saved['root_level'])
        for handler, stream in saved['streams']:
            handler.setStream(stream)


@pytest.fixture
def json_logs(extractor):
    """Capture what the handler's OWN formatter writes, one dict per line.

    Attached to the same logger the handler uses, with the module's formatter, so
    this exercises the real thing rather than a re-implementation of it. The level
    is forced to INFO belt-and-braces: the module sets it at import, but a reload
    under a monkeypatched LOG_LEVEL could leave it somewhere else.
    """
    stream = io.StringIO()
    handler = logging.StreamHandler(stream)
    handler.setFormatter(extractor.JsonFormatter())
    logger = extractor.logger
    previous_level = logger.level
    logger.addHandler(handler)
    logger.setLevel(logging.INFO)

    def _lines() -> list[dict]:
        handler.flush()
        return [json.loads(line) for line in stream.getvalue().splitlines() if line.strip()]

    try:
        yield _lines
    finally:
        logger.removeHandler(handler)
        logger.setLevel(previous_level)
        # The handler clears this itself; belt and braces, so one failing test
        # cannot leak a doc_id into the next.
        extractor._log_context.clear()


class TestEveryLineIsJson:
    def test_a_line_parses_and_carries_level_message_and_service(self, extractor, json_logs):
        extractor.logger.info('extraction started')

        line = json_logs()[0]

        assert line['level'] == 'INFO'
        assert line['message'] == 'extraction started'
        assert line['service'] == extractor.SERVICE_NAME
        assert line['timestamp']

    def test_the_service_name_is_configurable_and_defaults(self, extractor):
        """Read from SERVICE_NAME, not POWERTOOLS_SERVICE_NAME: naming it after a
        library this function deliberately does not have would promise the
        library. The emitted FIELD is still `service`, which is what an operator's
        query matches on."""
        assert extractor.SERVICE_NAME
        assert 'product-doc-extractor' in extractor.SERVICE_NAME

    def test_the_whole_pipeline_emits_only_json(self, extractor, wire, pending_doc, s3_event,
                                                json_logs):
        """Not just a hand-rolled call: a real invocation's lines, all of them."""
        wire(body=b'# Notes', doc=pending_doc('text/markdown'))

        extractor.lambda_handler(s3_event(TEXT_KEY, size=7))

        lines = json_logs()
        assert lines, 'expected at least one log line from a successful extraction'
        assert all('message' in line and 'level' in line for line in lines)


class TestTheLogLevelIsConfigurable:
    @pytest.mark.parametrize('configured, expected', [
        ('DEBUG', logging.DEBUG),
        ('debug', logging.DEBUG),
        ('WARNING', logging.WARNING),
        ('', logging.INFO),
        ('NOT_A_LEVEL', logging.INFO),
    ])
    def test_log_level_is_read_from_the_environment(self, extractor, monkeypatch,
                                                    configured, expected):
        """INFO is the default and the fallback — the app-wide convention, and the
        safe direction: an unreadable value must not silence the logs."""
        monkeypatch.setenv('LOG_LEVEL', configured)

        assert extractor._log_level() == expected


class TestNoDuplicatePlainTextLine:
    """The Lambda runtime pre-installs a plain-text handler on the ROOT logger, so
    a record that reaches root is emitted twice: once as JSON by ours, once as
    text by the runtime's. A doubled line reads like a retry rather than like a
    formatting mistake, so it misleads exactly the person reading the log during a
    diagnosis.

    `propagate = False` on a named logger is the whole mechanism — it replaced
    detaching the runtime's handler, which fixed the duplicate by taking the
    plain-text destination away from every other library logging through root.
    """

    def test_the_logger_does_not_propagate(self, extractor):
        assert extractor.logger.propagate is False

    def test_the_logger_is_not_the_root_logger(self, extractor):
        """Root belongs to whatever process imported this module; a handler and a
        level set on it are that process's, not ours."""
        assert extractor.logger is not logging.getLogger()
        assert extractor.logger.name

    def test_a_handler_on_root_receives_nothing(self, extractor):
        """The mechanism measured rather than inferred: a spy standing in for the
        runtime's plain-text handler must see no copy of our line."""
        stream = io.StringIO()
        spy = logging.StreamHandler(stream)
        root = logging.getLogger()
        root.addHandler(spy)
        try:
            extractor.logger.info('not for root')
        finally:
            root.removeHandler(spy)

        assert stream.getvalue() == '', 'a line reached root and would be emitted twice'

    def test_configuring_the_same_logger_twice_adds_one_handler(self, extractor):
        """Idempotent by name, because a second handler is a second copy of every
        line — and nothing about the JSON would look wrong while it happened."""
        logger = logging.getLogger('test-configured-twice')
        logger.handlers = []

        extractor._configure_logging(logger)
        extractor._configure_logging(logger)

        ours = [h for h in logger.handlers if h.name == extractor.HANDLER_NAME]
        assert len(ours) == 1, f'{len(ours)} handlers means every line {len(ours)} times'

    def test_a_handler_the_target_already_had_is_neither_dropped_nor_reformatted(
        self, extractor,
    ):
        """It ADDS; it does not take over. Setting this formatter on a handler we
        did not create was tried, and outside Lambda the host is pytest — whose
        capture handler populates `record.message` as a side effect of its own
        formatter, so six unrelated tests failed with AttributeError, and only when
        the suites shared a process."""
        existing = logging.StreamHandler(io.StringIO())
        original_formatter = existing.formatter
        logger = logging.getLogger('test-existing-handler-untouched')
        logger.handlers = [existing]

        extractor._configure_logging(logger)

        assert existing in logger.handlers
        assert existing.formatter is original_formatter
        assert any(h.name == extractor.HANDLER_NAME for h in logger.handlers)

    def test_a_formatted_record_still_carries_message_for_other_handlers(self, extractor):
        """`logging.Formatter.format` sets `record.message`, and other handlers on
        the same record read it. Skipping it leaves them with an AttributeError on
        a record this formatter has already been through."""
        record = logging.LogRecord('x', logging.INFO, __file__, 1, 'hello %s', ('world',), None)

        extractor.JsonFormatter().format(record)

        assert record.message == 'hello world'


class TestImportingTheModuleLeavesTheHostAlone:
    """Importing a handler module must not reconfigure the process that imported it.

    This module used to configure the ROOT logger at import: outside Lambda that
    attached a JSON handler to the host's own logger and re-levelled it, so in the
    backend pytest run one import reformatted every other suite's logging. No test
    noticed, because the fixtures above read only their own stream — which is the
    shape of defect worth a class of its own.
    """

    def test_a_reload_adds_no_handler_to_the_root_logger(self, extractor, reload_extractor):
        root = logging.getLogger()
        before = list(root.handlers)

        reload_extractor(times=2)

        assert list(root.handlers) == before, 'the import attached a handler to root'

    def test_no_json_handler_of_ours_is_on_root_at_all(self, extractor, reload_extractor):
        """Stronger than "unchanged", and deliberately: the FIRST import happens
        before any test runs, so a handler it left on root is already inside every
        snapshot. This asks whether one of ours is on root at all.

        Matched by formatter class NAME, not `isinstance`: a reload rebinds
        JsonFormatter, so isinstance against the current class would miss the
        handler an earlier generation installed.
        """
        reload_extractor(times=2)

        on_root = [h for h in logging.getLogger().handlers
                   if type(h.formatter).__name__ == extractor.JsonFormatter.__name__]
        assert on_root == [], f'{len(on_root)} JSON handler(s) left on the host root logger'

    def test_the_root_level_is_not_touched(self, extractor, reload_extractor):
        """A sentinel level, for the same reason: root was already re-levelled to
        INFO before this test existed, so "unchanged since the snapshot" would pass
        while the write still happened. WARNING is a value nothing else here
        chooses, so the write becomes visible."""
        root = logging.getLogger()
        root.setLevel(logging.WARNING)

        reload_extractor(times=2)

        assert root.level == logging.WARNING, 'the import re-levelled the host root logger'


class TestTheHandlerIsAttachedExactlyOnce:
    """A second import must not mean a second copy of every line.

    A warm container imports once, but a reload does not (and the test suite is a
    reloading host): each pass through _configure_logging that appends
    unconditionally adds a handler, and every line is then emitted once per
    handler — growing across the process, with nothing in the JSON itself looking
    wrong.
    """

    def test_two_reloads_leave_one_json_handler(self, extractor, reload_extractor):
        module = reload_extractor(times=2)

        ours = [h for h in module.logger.handlers if h.name == module.HANDLER_NAME]
        assert len(ours) == 1, f'{len(ours)} handlers means every line {len(ours)} times'

    def test_a_reload_does_not_multiply_the_lines_emitted(self, extractor, reload_extractor):
        """The consequence, counted rather than inferred: every handler the module
        installed is pointed at ONE stream, so a duplicate handler shows up as a
        duplicate line.

        Also the vacuity guard for the class above — "nothing on root" is satisfied
        just as well by logging nowhere at all, and this fails in that case.
        """
        module = reload_extractor(times=2)
        stream = io.StringIO()
        installed = [h for h in module.logger.handlers if h.name == module.HANDLER_NAME]
        assert installed, 'the module installed no handler of its own'
        for handler in installed:
            handler.setStream(stream)

        module.logger.info('one call')

        lines = [json.loads(line) for line in stream.getvalue().splitlines() if line.strip()]
        assert len(lines) == 1, f'one log call produced {len(lines)} lines'
        assert lines[0]['message'] == 'one call'
        assert lines[0]['service'] == module.SERVICE_NAME


class TestContextualFieldsReachEveryLine:
    def test_a_line_logged_deep_in_the_call_carries_the_document_fields(
        self, extractor, wire, pending_doc, s3_event, json_logs,
    ):
        """The proof that the mechanism is a context dict and not an `extra=` on
        each call site.

        The line asserted on comes from `_allowlisted`, reached via
        `_resolve_model_id` from inside the image branch — three frames below
        where the context was set, and a function that is handed no identifiers at
        all. It could not name this document if it tried.
        """
        wire(
            body=png_header(100, 100),
            doc=pending_doc('image/png'),
            settings={'surfaces': {'documents': STALE_MODEL_ID}},
        )

        extractor.lambda_handler(s3_event(IMAGE_KEY, size=1024))

        allowlist_lines = [line for line in json_logs() if 'not in allowlist' in line['message']]
        assert allowlist_lines, 'expected the model-resolution warning'
        assert allowlist_lines[0]['doc_id'] == 'abc123'
        assert allowlist_lines[0]['project_id'] == 'proj_1'
        assert allowlist_lines[0]['s3_key'] == IMAGE_KEY

    def test_the_s3_key_is_attached_too(self, extractor, wire, pending_doc, s3_event, json_logs):
        """Which object this was about, without parsing it back out of a message."""
        wire(body=b'# Notes', doc=pending_doc('text/markdown'))

        extractor.lambda_handler(s3_event(TEXT_KEY, size=7))

        ready = [line for line in json_logs() if 'ready' in line['message']]
        assert ready and ready[0]['s3_key'] == TEXT_KEY

    def test_an_ignored_key_carries_no_document_fields(self, extractor, s3_event, json_logs):
        """The context is set only after the key is recognised, so a notification
        for something else cannot invent a doc_id."""
        extractor.lambda_handler(s3_event('projects/proj_1/product_docs/extracted/abc123.txt'))

        line = json_logs()[0]
        assert 'not a product-doc upload' in line['message']
        assert 'doc_id' not in line


class TestTheContextIsClearedBetweenRecords:
    """The `finally` in _process_record, which is the load-bearing half.

    A batch loops records, so a context left in place attributes the NEXT
    document's lines to the previous doc_id — a field naming the wrong record is
    worse than no field, because it sends the reader somewhere confidently wrong.
    """

    def test_a_failed_record_does_not_leak_its_doc_id_into_the_next(
        self, extractor, wire, pending_doc, json_logs,
    ):
        """The first record raises OUT of the extraction — a put_object failure,
        which is outside the handler's own try/except and so reaches
        lambda_handler's catch-all. That is the case a clear placed at the END of
        _process_record (rather than in a `finally`) would skip entirely.
        """
        fakes = wire(body=b'# Notes', doc=pending_doc('text/markdown'))
        real_put = fakes['s3'].put_object

        def put_object(**kwargs):
            if 'first' in kwargs['Key']:
                raise RuntimeError('s3 unavailable')
            return real_put(**kwargs)

        fakes['s3'].put_object = put_object

        extractor.lambda_handler({'Records': [
            _record('projects/proj_1/product_docs/raw/first.md'),
            _record('projects/proj_2/product_docs/raw/second.md'),
        ]})

        lines = json_logs()
        # The unhandled-error line belongs to the first record and is logged after
        # its context was cleared, so it must name no document at all rather than
        # the wrong one.
        unhandled = [line for line in lines if 'Unhandled error' in line['message']]
        assert unhandled, 'expected the first record to fail out of _process_record'
        assert 'doc_id' not in unhandled[0]
        # And nothing about the second record may be attributed to the first.
        second = [line for line in lines if line.get('doc_id') == 'second']
        assert second, 'expected the second record to be processed'
        assert all(line['project_id'] == 'proj_2' for line in second)
        # THE ASSERTION A MISSING `finally` FAILS: without the clear, every line
        # about the second document still carries doc_id `first`.
        assert all(line.get('doc_id') == 'second'
                   for line in lines if line.get('project_id') == 'proj_2')

    def test_the_context_is_empty_once_the_batch_is_done(self, extractor, wire, pending_doc,
                                                         s3_event):
        """A warm container reuses the module, so a surviving context would
        contaminate the NEXT invocation, not merely the next record."""
        wire(body=b'# Notes', doc=pending_doc('text/markdown'))

        extractor.lambda_handler(s3_event(TEXT_KEY, size=7))

        assert extractor._log_context == {}


class TestALogCallNeverBreaksTheHandler:
    def test_a_non_serialisable_extra_does_not_raise(self, extractor, json_logs):
        class Opaque:
            def __repr__(self):
                return '<opaque>'

        extractor.logger.info('with an extra', extra={'blob': Opaque()})

        line = json_logs()[0]
        assert line['blob'] == '<opaque>'

    def test_a_circular_structure_does_not_raise(self, extractor, json_logs):
        """`default=` is never consulted for a dict or a list, so a circular
        reference is the one shape that makes json.dumps itself fail."""
        loop: dict = {}
        loop['self'] = loop

        extractor.logger.info('circular', extra={'loop': loop})

        line = json_logs()[0]
        assert line['message'] == 'circular'
        assert 'loop' in line

    def test_a_repr_that_raises_does_not_raise_either(self, extractor, json_logs):
        class Hostile:
            def __repr__(self):
                raise RuntimeError('no repr for you')

        extractor.logger.info('hostile', extra={'thing': Hostile()})

        line = json_logs()[0]
        assert 'unrepresentable' in line['thing']


class TestExceptionsCarryTheirTraceback:
    def test_logger_exception_puts_the_traceback_in_the_json(self, extractor, json_logs):
        try:
            raise ValueError('deliberate')
        except ValueError:
            extractor.logger.exception('extraction blew up')

        line = json_logs()[0]

        assert line['level'] == 'ERROR'
        assert 'Traceback' in line['exception']
        assert 'ValueError: deliberate' in line['exception']

    def test_the_handlers_own_failure_path_carries_one(self, extractor, wire, pending_doc,
                                                      s3_event, json_logs):
        """Not a synthetic call: the extractor's catch-all is the only record of
        WHY a document failed, since the user-facing message deliberately carries
        no detail."""
        fakes = wire(doc=pending_doc('text/markdown'))

        def get_object(**_kwargs):
            raise RuntimeError('s3 exploded')

        fakes['s3'].get_object = get_object

        extractor.lambda_handler(s3_event(TEXT_KEY, size=7))

        failures = [line for line in json_logs() if 'Extraction failed' in line['message']]
        assert failures
        assert 'Traceback' in failures[0]['exception']
        assert failures[0]['doc_id'] == 'abc123'
