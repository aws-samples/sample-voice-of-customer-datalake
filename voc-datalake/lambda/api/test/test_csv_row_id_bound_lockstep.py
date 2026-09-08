"""Lockstep test: the bound on a CSV row's carried identifier is one number in
two files.

`MAX_CSV_ROW_ID_LENGTH` in lambda/api/manual_import_handler.py is the DROPPING
copy — a longer `id` column value is left off the message there, with a warning,
and the row still imports. `MAX_ID_LENGTH` in plugins/_shared/schemas.py is the
REJECTING copy: it caps `IngestMessage.csv_row_id`, and a message past it fails
validation whole.

The API Lambda cannot import the plugin schema — the bundle copies `api/` and
`shared/` but not `plugins/_shared/` — so the number is restated rather than
shared, and nothing but this test holds the two together.

The failure mode is one-sided and quiet. Raise the handler's copy above the
schema's and an over-long identifier reaches the queue, where validation would
refuse the entire message over a field that is purely informational: the row is
lost to preserve a lookup value. Lower it and identifiers are dropped that the
schema would have accepted, so records silently lose their traceability back to
the exported row. Neither shows up in either file's own tests, because each file
is self-consistent.

Today the two are deliberately EQUAL: the handler drops exactly what the schema
would refuse, no more. The assertion is `<=` rather than `==` so the handler may
be made stricter (dropping earlier is safe — it costs traceability, not rows)
without failing, while the unsafe direction stays pinned.

Both literals are read as SOURCE TEXT rather than imported, so the assertion
cannot be satisfied by whatever either module resolves at import time, and it
needs neither the AWS-shaped Python import graph nor the plugin package's own
imports (which pull `shared.logging` and are unavailable here).

Pattern follows test_visual_selection_bound_lockstep.py (same directory).
"""
import re
from pathlib import Path

HANDLER_SOURCE = 'lambda/api/manual_import_handler.py'
SCHEMA_SOURCE = 'plugins/_shared/schemas.py'
HANDLER_PATTERN = r'^MAX_CSV_ROW_ID_LENGTH\s*=\s*(\d+)'
SCHEMA_PATTERN = r'^MAX_ID_LENGTH\s*=\s*(\d+)'
# Which constant the schema field actually points at. Comparing the two numbers
# is not enough on its own: `csv_row_id` could be re-declared against a
# different bound (MAX_URL_LENGTH, a literal) while MAX_ID_LENGTH stays 256, and
# the numeric assertion below would still pass while the field it describes had
# moved out from under it.
# The bound must be the constant ITSELF, not an expression over it: `[,)]` is the
# complete set of things that may legally follow a keyword argument's value, so
# this accepts a later `description=...` or a trailing comma while rejecting
# `MAX_ID_LENGTH // 2`, which would move the real bound while leaving every
# number in both files untouched.
SCHEMA_FIELD_PATTERN = (
    r'^\s*csv_row_id:\s*Optional\[str\]\s*=\s*Field\(\s*None\s*,\s*'
    r'max_length\s*=\s*MAX_ID_LENGTH\s*[,)]'
)


def _read(relative: str) -> str:
    # lambda/api/test/ -> voc-datalake/
    path = Path(__file__).resolve().parents[3] / relative
    assert path.is_file(), (
        f'{relative} not found — did the file move? '
        f'If so, update the path constant in this test file.'
    )
    return path.read_text(encoding='utf-8')


def _single_int(source: str, pattern: str, where: str) -> int:
    matches = re.findall(pattern, source, re.MULTILINE)
    assert len(matches) == 1, (
        f'Expected exactly one matching assignment in {where}; found '
        f'{len(matches)}. A second copy is the drift this test exists to '
        f'prevent — if the declaration was restructured, update this helper.'
    )
    return int(matches[0])


def test_the_handler_never_carries_an_identifier_the_schema_would_reject():
    handler_value = _single_int(_read(HANDLER_SOURCE), HANDLER_PATTERN, HANDLER_SOURCE)
    schema_value = _single_int(_read(SCHEMA_SOURCE), SCHEMA_PATTERN, SCHEMA_SOURCE)

    assert handler_value <= schema_value, (
        f'{HANDLER_SOURCE} carries csv_row_id values up to {handler_value} '
        f'characters, but {SCHEMA_SOURCE} rejects anything over {schema_value}. '
        f'The schema is the enforcing side, and it refuses the whole message: an '
        f'over-long identifier would cost the row itself, for a field that only '
        f'exists to make the row findable.'
    )


def test_the_schema_field_is_still_bounded_by_the_constant_compared_above():
    """Closes the gap the numeric assertion alone leaves: `csv_row_id` could be
    re-declared against some other bound while `MAX_ID_LENGTH` keeps its value,
    and the comparison would go on passing about a number nothing reads."""
    source = _read(SCHEMA_SOURCE)

    assert re.search(SCHEMA_FIELD_PATTERN, source, re.MULTILINE), (
        f'csv_row_id in {SCHEMA_SOURCE} is no longer declared as '
        f'`Optional[str] = Field(None, max_length=MAX_ID_LENGTH)`. The numeric '
        f'lockstep above compares MAX_ID_LENGTH, so if this field now takes its '
        f'bound from somewhere else that comparison is measuring the wrong '
        f'thing — point the field back at MAX_ID_LENGTH, or update both this '
        f'pattern and SCHEMA_PATTERN together.'
    )


def test_the_bound_is_a_plausible_identifier_length():
    """A bound of 0 would drop every identifier while keeping the lockstep green,
    silently removing the traceability this field exists to provide. An enormous
    one would defeat the point of bounding a free-text column at all."""
    handler_value = _single_int(_read(HANDLER_SOURCE), HANDLER_PATTERN, HANDLER_SOURCE)

    assert 32 <= handler_value <= 1024


def test_the_handler_declaration_keeps_the_shape_this_test_reads():
    """The regex above matches a bare integer at column 0. Folding the constant
    into an expression, an f-string or a class body would make the lockstep
    silently unenforced rather than failing, so assert the shape directly."""
    source = _read(HANDLER_SOURCE)

    assert re.search(HANDLER_PATTERN, source, re.MULTILINE), (
        f'MAX_CSV_ROW_ID_LENGTH is no longer a module-level bare integer in '
        f'{HANDLER_SOURCE}. This test reads it as source text; restore the shape '
        f'or update HANDLER_PATTERN.'
    )
