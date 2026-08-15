"""Lockstep test: the configured category taxonomy is one DynamoDB key, one
field, and one fallback in two languages.

The aggregates item that holds the taxonomy is written in exactly one place —
the PUT /settings/categories handler in lambda/api/settings_handler.py, which
spells the key out as CATEGORIES_PK/CATEGORIES_SK. Python reads it back in
lambda/shared/api.py (`get_raw_categories_config`), maps each object to its
`name`, and falls back to DEFAULT_CATEGORIES when the item is absent. Streaming
chat needs the SAME names, because it uses them to build the daily counter
partitions `METRIC#daily_category#<name>` that the aggregator writes — and its
copy of the reader lives in lambda/stream/src/context/voc-context.ts.

The failure mode is silent and total, which is why this test exists. Streaming
chat used to query a `CONFIG#`-prefixed partition with the sort key `CURRENT` —
a key nothing in the repository has ever written, whose only occurrence anywhere
was that read, which is why it is not spelled out here either — and to map each
category object to `id` rather than to the taxonomy name. Either
defect alone empties the Top Categories section of every single chat turn: a
wrong key returns no item, and a wrong field names counter partitions that are
never written. The section still renders, just with nothing under it, so the
model answers "which categories dominate" from an empty list while the metrics
page for the same window shows counts. Nothing failed, nobody was told, and the
local mock server hid it by serving category payloads that carry BOTH `id` and
`name`.

Three things therefore have to agree across the boundary, and this file pins
each of them:

  * the item key (pk and sk),
  * the field read off each category object (`name`, because the counter
    partitions are named after the enrichment output),
  * the not-configured fallback (DEFAULT_CATEGORIES, so the two surfaces report
    the same categories for the same table rather than one reporting nothing) —
    at all THREE of its copies, including the pipe-delimited string in
    lambda/processor/handler.py, which is the copy that decides which names the
    enrichment model may emit and therefore the only reason falling back to that
    list is right rather than arbitrary.

The Zod schema at the top of voc-context.ts is part of the same contract: if it
requires `id` while the read takes `name`, a configured category that carries no
`id` is dropped by the parse instead of counted. So the schema's required
property is pinned to the field that is read.

Both sides are read as SOURCE TEXT with a regular expression rather than
imported, so the assertions need neither a bundler for the TypeScript nor the
AWS-shaped import graph for the Python.

Pattern follows test_visual_selection_bound_lockstep.py (same directory).
"""
import re
from pathlib import Path

PYTHON_READER_SOURCE = 'lambda/shared/api.py'
PYTHON_WRITER_SOURCE = 'lambda/api/settings_handler.py'
PROCESSOR_SOURCE = 'lambda/processor/handler.py'
STREAM_SOURCE = 'lambda/stream/src/context/voc-context.ts'

# Quoting is not part of the contract, so no pattern here insists on it: these
# three modules already use different conventions, and a reformat must not fail a
# pin whose subject is the key's VALUE.
_Q = r"""['"]"""

# The key as the streaming reader declares it, as two module constants.
STREAM_PK_PATTERN = rf'^const CATEGORY_SETTINGS_PK = {_Q}([^\'"]+){_Q};'
STREAM_SK_PATTERN = rf'^const CATEGORY_SETTINGS_SK = {_Q}([^\'"]+){_Q};'
# The key as the Python reader spends it, inline in the get_item call.
PYTHON_READER_KEY_PATTERN = (
    rf'get_item\(\s*Key=\{{\s*{_Q}pk{_Q}:\s*{_Q}([^\'"]+){_Q},'
    rf'\s*{_Q}sk{_Q}:\s*{_Q}([^\'"]+){_Q},?\s*\}}\s*\)'
)
# The key as the writer declares it, as two module constants.
PYTHON_WRITER_PK_PATTERN = rf'^CATEGORIES_PK = {_Q}([^\'"]+){_Q}'
PYTHON_WRITER_SK_PATTERN = rf'^CATEGORIES_SK = {_Q}([^\'"]+){_Q}'

# The never-written key streaming chat used to ask for, assembled rather than
# written out so that a repository-wide search for it keeps returning nothing
# outside build artifacts — which is itself part of the fix.
ABANDONED_PK = 'CONFIG' + '#categories'
ABANDONED_SK = 'CURR' + 'ENT'


def _read(relative: str) -> str:
    # lambda/api/test/ -> voc-datalake/
    path = Path(__file__).resolve().parents[3] / relative
    assert path.is_file(), (
        f'{relative} not found — did the file move? '
        f'If so, update the path constant in this test file.'
    )
    return path.read_text(encoding='utf-8')


def _single(source: str, pattern: str, where: str, what: str) -> tuple[str, ...]:
    matches = re.findall(pattern, source, re.MULTILINE)
    assert len(matches) == 1, (
        f'Expected exactly one {what} in {where}; found {len(matches)}. A second '
        f'copy is the drift this test exists to prevent — if the declaration was '
        f'restructured, update the pattern in this file.'
    )
    match = matches[0]
    return match if isinstance(match, tuple) else (match,)


def _stream_key() -> tuple[str, str]:
    source = _read(STREAM_SOURCE)
    pk = _single(source, STREAM_PK_PATTERN, STREAM_SOURCE, 'CATEGORY_SETTINGS_PK')[0]
    sk = _single(source, STREAM_SK_PATTERN, STREAM_SOURCE, 'CATEGORY_SETTINGS_SK')[0]
    return pk, sk


def _stream_function_body(marker: str) -> str:
    """The body of one function in the streaming module.

    Scoped so another function cannot answer for this one — every field and
    fallback assertion in this file reads a body, never the whole file, because a
    comment or an unrelated helper elsewhere in the module must not be able to
    satisfy a pin whose whole purpose is to fail when this reader drifts. The
    body ends at the next top-level declaration, which in this module is always a
    `function`, `async function` or exported form at column 0.
    """
    source = _read(STREAM_SOURCE)
    start = source.find(marker)
    assert start != -1, (
        f'{marker} not found in {STREAM_SOURCE} — if the function was renamed, '
        f'update this helper.'
    )
    rest = source[start + len(marker):]
    next_decl = re.search(r'^(export )?(async )?function ', rest, re.MULTILINE)
    assert next_decl, (
        f'No declaration follows {marker} in {STREAM_SOURCE}, so this helper can '
        f'no longer tell where the body ends and would scope the assertion to the '
        f'rest of the file — which would let unrelated code satisfy it. If the '
        f'function is now the last declaration in the module, give this helper an '
        f'explicit end marker rather than letting it over-scope.'
    )
    return rest[:next_decl.start()]


def _stream_reader_body() -> str:
    """The body of getConfiguredCategories's read in the streaming module.

    The reader was split so the cache wraps it: `readConfiguredCategories` is
    the part that spends the key, maps the field and chooses the fallback, so
    that is the body these assertions scope to.
    """
    return _stream_function_body('async function readConfiguredCategories(')


def _stream_not_configured_path() -> str:
    """The reader's not-configured path only: everything before its `catch`.

    The distinction is load-bearing. A read that THREW and a table with nothing
    configured are different situations that happen to share an answer, and each
    has its own return. Pinning the fallback against the whole body would let the
    not-configured path return `[]` — the original bug, for the overwhelmingly
    common case — while the error path alone keeps returning the defaults and the
    assertion stays green.
    """
    body = _stream_reader_body()
    catch = re.search(r'\}\s*catch\b', body)
    assert catch, (
        f'{STREAM_SOURCE}::readConfiguredCategories no longer has a `catch`, so '
        f'this helper cannot separate its not-configured path from its error '
        f'path. The settings read must not be able to break a chat turn — if the '
        f'error handling moved, move this helper with it rather than widening it '
        f'to the whole body.'
    )
    return body[:catch.start()]


def _python_function_body(source: str, marker: str, where: str) -> str:
    """The body of one top-level function in a Python module.

    Scoped so another function in the same module cannot satisfy an assertion
    about this one. The body ends at the next top-level `def`.
    """
    start = source.find(marker)
    assert start != -1, (
        f'{marker} not found in {where} — if the function was renamed, update the '
        f'marker in this test file.'
    )
    rest = source[start + len(marker):]
    next_def = re.search(r'^def ', rest, re.MULTILINE)
    return rest[:next_def.start()] if next_def else rest


def _python_reader_key() -> tuple[str, str]:
    """The pk/sk of the categories get_item in shared/api.py.

    Scoped to `get_raw_categories_config` so another reader in the module cannot
    satisfy this test.
    """
    body = _python_function_body(
        _read(PYTHON_READER_SOURCE), 'def get_raw_categories_config(', PYTHON_READER_SOURCE,
    )
    pk, sk = _single(
        body, PYTHON_READER_KEY_PATTERN,
        f'{PYTHON_READER_SOURCE}::get_raw_categories_config', 'categories get_item Key',
    )
    return pk, sk


def _python_writer_key() -> tuple[str, str]:
    source = _read(PYTHON_WRITER_SOURCE)
    pk = _single(source, PYTHON_WRITER_PK_PATTERN, PYTHON_WRITER_SOURCE, 'CATEGORIES_PK')[0]
    sk = _single(source, PYTHON_WRITER_SK_PATTERN, PYTHON_WRITER_SOURCE, 'CATEGORIES_SK')[0]
    return pk, sk


def _python_default_categories() -> list[str]:
    source = _read(PYTHON_READER_SOURCE)
    match = re.search(r'^DEFAULT_CATEGORIES = \[(.*?)\]', source, re.MULTILINE | re.DOTALL)
    assert match, f'DEFAULT_CATEGORIES list literal not found in {PYTHON_READER_SOURCE}'
    return re.findall(r"'([^']+)'", match.group(1))


def _stream_default_categories() -> list[str]:
    source = _read(STREAM_SOURCE)
    match = re.search(
        r'^const DEFAULT_CATEGORIES = \[(.*?)\] as const;', source, re.MULTILINE | re.DOTALL,
    )
    assert match, (
        f'DEFAULT_CATEGORIES array literal not found in {STREAM_SOURCE}. Streaming '
        f'chat must fall back to the same list Python does, or an unconfigured '
        f'table gives the two surfaces different answers.'
    )
    return re.findall(r"'([^']+)'", match.group(1))


def _processor_default_categories() -> list[str]:
    """The default taxonomy as the ENRICHMENT PROMPT spells it: one pipe-delimited
    string, not a list.

    This is the third copy, and the one that decides which category names the
    model may emit — so it is the copy the other two's fallback depends on for
    being true rather than merely self-consistent.
    """
    source = _read(PROCESSOR_SOURCE)
    literal = _single(
        source, r'^DEFAULT_CATEGORIES = "([^"]+)"', PROCESSOR_SOURCE,
        'DEFAULT_CATEGORIES string literal',
    )[0]
    return literal.split('|')


class TestCategorySettingsKeyLockstep:
    def test_the_streaming_reader_asks_for_the_key_the_writer_writes(self):
        assert _stream_key() == _python_writer_key(), (
            f'{STREAM_SOURCE} queries {_stream_key()} but '
            f'{PYTHON_WRITER_SOURCE} writes the item at {_python_writer_key()}. A '
            f'streaming read of a key nobody writes returns no item, so the Top '
            f'Categories section is empty on every turn and nothing fails.'
        )

    def test_the_streaming_reader_asks_for_the_key_the_python_reader_asks_for(self):
        assert _stream_key() == _python_reader_key(), (
            f'{STREAM_SOURCE} queries {_stream_key()} but '
            f'{PYTHON_READER_SOURCE}::get_raw_categories_config reads '
            f'{_python_reader_key()}. The two surfaces must describe the same '
            f'configuration or they report different categories for one table.'
        )

    def test_the_abandoned_streaming_key_is_gone(self):
        source = _read(STREAM_SOURCE)
        assert ABANDONED_PK not in source, (
            f"{STREAM_SOURCE} still mentions '{ABANDONED_PK}', a partition key "
            f'nothing in this repository writes. Its only occurrence used to be '
            f'this module\'s own read.'
        )
        # Both halves, not just the partition: the sort key is equally
        # never-written, and a reader that got the partition right and this wrong
        # still reads no item and still empties the section.
        assert ABANDONED_SK not in source, (
            f"{STREAM_SOURCE} still mentions the sort key '{ABANDONED_SK}'. The "
            f'settings item is written under a different sort key, so this one '
            f'returns no item however right the partition is.'
        )


class TestCategoryNameFieldLockstep:
    """The field read must be the taxonomy NAME on both sides.

    `METRIC#daily_category#<category>` partitions are keyed by the enrichment
    output, which is the category name. Reading any other field yields
    partitions that are never written even once the item key is right — which is
    why fixing only the key is not a fix.
    """

    def test_the_python_reader_maps_categories_to_their_name(self):
        # Scoped to the mapping function: a `cat.get('name')` in some other
        # helper elsewhere in this module must not be able to satisfy a pin on
        # what THIS function maps to.
        body = _python_function_body(
            _read(PYTHON_READER_SOURCE), 'def get_configured_categories(', PYTHON_READER_SOURCE,
        )
        assert re.search(r"cat\.get\('name'\)", body), (
            f'{PYTHON_READER_SOURCE}::get_configured_categories no longer maps '
            f'each category to its `name`. If the owning side changed field, the '
            f'streaming mirror and the aggregator partitions must change with it.'
        )

    def test_the_streaming_reader_maps_categories_to_their_name(self):
        # Scoped to the mapping function for the same reason, and because the
        # negative assertion below would otherwise fire on a mere mention of the
        # field in a comment anywhere in the module.
        body = _stream_function_body('function namesFromStoredList(')
        assert 'parsed.data.name' in body, (
            f'{STREAM_SOURCE} no longer reads `name` off each parsed category. '
            f'The counter partitions are named after the category name, so any '
            f'other field sums partitions that do not exist.'
        )
        assert 'parsed.data.id' not in body, (
            f'{STREAM_SOURCE} reads an internal identifier instead of the '
            f'taxonomy name. That names counter partitions the aggregator never '
            f'writes, so the section is empty however right the item key is.'
        )

    def test_the_streaming_schema_requires_the_field_that_is_read(self):
        """The Zod object at the top of the module decides which configured
        categories survive the parse. Requiring `id` while reading `name` drops
        every category that carries no `id` — silently, because safeParse
        failures are filtered out."""
        source = _read(STREAM_SOURCE)
        match = re.search(
            r'^const categoryItemSchema = z\.object\(\{\s*(\w+):', source, re.MULTILINE,
        )
        assert match, (
            f'categoryItemSchema not found in {STREAM_SOURCE}, or its shape '
            f'changed. It must keep validating at this boundary — this repository '
            f'does not permit a type assertion here — so update this pattern '
            f'rather than removing the schema.'
        )
        assert match.group(1) == 'name', (
            f'categoryItemSchema requires `{match.group(1)}` but the read takes '
            f'`name`. The key, the field, and the schema must describe one '
            f'contract, or a configured category without an internal identifier '
            f'is dropped before it can be counted.'
        )


class TestNotConfiguredFallbackLockstep:
    """Both surfaces answer the same way when nothing is configured.

    Python falls back to DEFAULT_CATEGORIES; streaming used to fall back to an
    empty array, and that silent difference is how these two copies drifted this
    far. The default list wins because the enrichment prompt labels feedback with
    those same names when no taxonomy is configured, so the counters exist under
    them — an empty fallback reports nothing where the metrics surface reports
    counts.
    """

    def test_both_sides_fall_back_to_the_same_default_list(self):
        python_defaults = _python_default_categories()
        stream_defaults = _stream_default_categories()
        assert stream_defaults == python_defaults, (
            f'{STREAM_SOURCE} falls back to {stream_defaults} but '
            f'{PYTHON_READER_SOURCE} falls back to {python_defaults}. An '
            f'unconfigured table must look the same to streaming chat as it does '
            f'to the metrics surface.'
        )

    def test_the_streaming_reader_actually_returns_its_default_list(self):
        """Declaring the list is not the same as spending it. A reader that keeps
        DEFAULT_CATEGORIES for documentation and still returns `[]` on the
        unconfigured path keeps the comparison above green while the section
        stays empty — the exact shape of the original bug.

        Pinned as a positive match on the RETURN, not as a ban on the text
        `return []`: Python really does answer `[]` for a configured-but-nameless
        list, so a reader that spells that outcome out explicitly is correct and
        must not fail here.

        Scoped to the not-configured path rather than the whole body, so that
        returning the defaults from the error path alone cannot answer for it."""
        reader = _stream_not_configured_path()
        assert re.search(r'\[\s*\.\.\.\s*DEFAULT_CATEGORIES\s*\]', reader), (
            f'{STREAM_SOURCE}::readConfiguredCategories no longer returns a copy '
            f'of DEFAULT_CATEGORIES from its not-configured path. Python returns '
            f'the default list there, so returning an empty array makes streaming '
            f'chat report no categories for a table the metrics surface reports '
            f'counts for. Declaring the list without returning it keeps the '
            f'sibling comparison green while the section stays empty.'
        )

    def test_the_enrichment_prompt_offers_the_same_default_list(self):
        """The third copy, and the one the other two depend on.

        lambda/processor/handler.py decides which category names the enrichment
        model may emit when no taxonomy is configured. That is the only reason
        falling back to the default list is right rather than arbitrary: the
        `METRIC#daily_category#<name>` counters exist under exactly those names.
        If this copy disagrees with the readers' fallback, the counters are
        written under names neither reader ever asks for — so the Top Categories
        section is empty again while both readers agree with each other, and
        every other assertion in this file stays green."""
        processor_defaults = _processor_default_categories()
        assert processor_defaults == _python_default_categories(), (
            f'{PROCESSOR_SOURCE} lets the enrichment model emit '
            f'{processor_defaults} but {PYTHON_READER_SOURCE} falls back to '
            f'{_python_default_categories()}. The counters are written under the '
            f'names the model emits, so the readers would ask for partitions that '
            f'are never written.'
        )
        assert processor_defaults == _stream_default_categories(), (
            f'{PROCESSOR_SOURCE} lets the enrichment model emit '
            f'{processor_defaults} but {STREAM_SOURCE} falls back to '
            f'{_stream_default_categories()}. Streaming chat would ask for '
            f'counter partitions the enrichment output never names.'
        )

    def test_the_default_list_is_not_empty(self):
        """An empty list on both sides would keep the comparison above green
        while restoring the very bug this file pins: no categories asked for,
        so no counts reported."""
        assert _python_default_categories(), (
            f'{PYTHON_READER_SOURCE}::DEFAULT_CATEGORIES is empty. If the default '
            f'taxonomy really was dropped, this whole fallback contract needs '
            f'rethinking on both sides rather than silently agreeing on nothing.'
        )
