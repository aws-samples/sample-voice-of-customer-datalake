"""What the workspace property tests share (``test_*_properties.py`` beside this file): one Hypothesis profile and
generators of the values the multi-workspace code really sees.

The profile: 256 generated cases a property, no deadline and no ``too_slow`` health check (the suite runs on every
core at once, and the moto-backed properties take milliseconds a case, which Hypothesis would otherwise report as a
slow generator), and no example database, so a run writes nothing into the tree. A case Hypothesis finds that breaks a property is printed
with its reproduction blob; it is then added to the property as an ``@example`` beside the fix, which is the
committed regression list: those cases run first, on every run.
"""
from __future__ import annotations

import re
import string
from typing import Final

from hypothesis import HealthCheck, settings
from hypothesis import strategies as st

PROPERTY: Final = settings(max_examples=256, deadline=None, database=None, print_blob=True,
                           suppress_health_check=[HealthCheck.too_slow])

def exactly(message: str) -> str:
    """A ``pytest.raises(match=…)`` pattern for exactly ``message`` (``match`` searches, so a bare message would also
    accept one with text around it)."""
    return f'^{re.escape(message)}$'


#: Crockford base32, the characters of a ULID (no I, L, O, U).
CROCKFORD: Final = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'


@st.composite
def workspace_ids(draw: st.DrawFn) -> str:
    """``ws_`` + a ULID: its first character 0-7 (a 128-bit value), then 25 Crockford characters."""
    first = draw(st.sampled_from(CROCKFORD[:8]))
    rest = draw(st.text(alphabet=CROCKFORD, min_size=25, max_size=25))
    return f'ws_{first}{rest}'


@st.composite
def two_workspace_ids(draw: st.DrawFn) -> tuple[str, str]:
    """Two different workspace ids, often differing in one character only (the closest a neighbour gets)."""
    first = draw(workspace_ids())
    if draw(st.booleans()):
        second = draw(workspace_ids().filter(lambda other: other != first))
    else:
        position = draw(st.integers(min_value=4, max_value=len(first) - 1))
        replacement = draw(st.sampled_from(CROCKFORD).filter(lambda char: char != first[position]))
        second = first[:position] + replacement + first[position + 1:]
    return first, second


#: Key parts as the code builds them: source and plugin names, categories, dates, ids, and any other non-empty text
#: (a ``#`` or ``/`` inside included: a part is the caller's, the prefix is the layer's).
KEY_PARTS: Final = st.one_of(
    st.sampled_from(['webscraper', 'app_store', 'github_issues', 'SOURCE', 'METRIC', 'daily_total', 'erasure',
                     'export', 'category_reprocess', 'company', 'personal', 'HISTORY']),
    st.dates().map(lambda day: day.isoformat()),
    st.uuids().map(str),
    st.text(alphabet=string.ascii_letters + string.digits + '_-#/.:', min_size=1, max_size=24),
    st.text(min_size=1, max_size=12),
)

#: Plugin ids by shared/plugin_identity.py's rule: lowercase letters, digits and ``_``, 1 to 64, no ``_`` at an end.
PLUGIN_IDS: Final = st.from_regex(r'[a-z0-9](?:[a-z0-9_]{0,62}[a-z0-9])?', fullmatch=True)

#: SSM parameter prefixes: ``/`` then segments of letters, digits, ``-`` and ``_`` (``/voc/ws``, ``/stg-voc/ws``).
PARAMETER_PREFIXES: Final = st.lists(st.text(alphabet=string.ascii_letters + string.digits + '-_', min_size=1,
                                             max_size=12), min_size=1, max_size=4).map(lambda parts: '/' + '/'.join(parts))
