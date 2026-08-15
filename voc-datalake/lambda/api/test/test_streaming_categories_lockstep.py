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
    the same categories for the same table rather than one reporting nothing).

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
STREAM_SOURCE = 'lambda/stream/src/context/voc-context.ts'

# The key as the streaming reader declares it, as two module constants.
STREAM_PK_PATTERN = r"^const CATEGORY_SETTINGS_PK = '([^']+)';"
STREAM_SK_PATTERN = r"^const CATEGORY_SETTINGS_SK = '([^']+)';"
# The key as the Python reader spends it, inline in the get_item call.
PYTHON_READER_KEY_PATTERN = (
    r"get_item\(Key=\{'pk':\s*'([^']+)',\s*'sk':\s*'([^']+)'\}\)"
)
# The key as the writer declares it, as two module constants.
PYTHON_WRITER_PK_PATTERN = r'^CATEGORIES_PK = "([^"]+)"'
PYTHON_WRITER_SK_PATTERN = r'^CATEGORIES_SK = "([^"]+)"'

# The never-written partition streaming chat used to ask for, assembled rather
# than written out so that a repository-wide search for it keeps returning
# nothing outside build artifacts — which is itself part of the fix.
ABANDONED_PK = 'CONFIG' + '#categories'


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


def _stream_reader_body() -> str:
    """The body of getConfiguredCategories in the streaming module.

    Scoped so another function's return cannot answer for this one. The body ends
    at the next top-level declaration, which in this module is always a `function`
    or `async function` at column 0.
    """
    source = _read(STREAM_SOURCE)
    marker = 'async function getConfiguredCategories('
    start = source.find(marker)
    assert start != -1, (
        f'{marker} not found in {STREAM_SOURCE} — if the reader was renamed, '
        f'update this helper.'
    )
    rest = source[start + len(marker):]
    next_decl = re.search(r'^(async )?function ', rest, re.MULTILINE)
    return rest[:next_decl.start()] if next_decl else rest


def _python_reader_key() -> tuple[str, str]:
    """The pk/sk of the categories get_item in shared/api.py.

    Scoped to `get_raw_categories_config` so another reader in the module cannot
    satisfy this test. The function body ends at the next top-level `def`.
    """
    source = _read(PYTHON_READER_SOURCE)
    marker = 'def get_raw_categories_config('
    start = source.find(marker)
    assert start != -1, f'{marker} not found in {PYTHON_READER_SOURCE}'
    next_def = re.search(r'^def ', source[start + len(marker):], re.MULTILINE)
    end = start + len(marker) + (next_def.start() if next_def else len(source))
    pk, sk = _single(
        source[start:end], PYTHON_READER_KEY_PATTERN,
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


class TestCategoryNameFieldLockstep:
    """The field read must be the taxonomy NAME on both sides.

    `METRIC#daily_category#<category>` partitions are keyed by the enrichment
    output, which is the category name. Reading any other field yields
    partitions that are never written even once the item key is right — which is
    why fixing only the key is not a fix.
    """

    def test_the_python_reader_maps_categories_to_their_name(self):
        source = _read(PYTHON_READER_SOURCE)
        assert re.search(r"cat\.get\('name'\)", source), (
            f'{PYTHON_READER_SOURCE}::get_configured_categories no longer maps '
            f'each category to its `name`. If the owning side changed field, the '
            f'streaming mirror and the aggregator partitions must change with it.'
        )

    def test_the_streaming_reader_maps_categories_to_their_name(self):
        source = _read(STREAM_SOURCE)
        assert 'parsed.data.name' in source, (
            f'{STREAM_SOURCE} no longer reads `name` off each parsed category. '
            f'The counter partitions are named after the category name, so any '
            f'other field sums partitions that do not exist.'
        )
        assert 'parsed.data.id' not in source, (
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
        stays empty — the exact shape of the original bug."""
        reader = _stream_reader_body()
        assert 'DEFAULT_CATEGORIES' in reader, (
            f'{STREAM_SOURCE}::getConfiguredCategories no longer returns '
            f'DEFAULT_CATEGORIES from its not-configured path. Python returns the '
            f'default list there, so returning an empty array makes streaming chat '
            f'report no categories for a table the metrics surface reports counts '
            f'for.'
        )
        assert 'return [];' not in reader, (
            f'{STREAM_SOURCE}::getConfiguredCategories still returns an empty '
            f'array on some path. That is the fallback difference this contract '
            f'removed.'
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
