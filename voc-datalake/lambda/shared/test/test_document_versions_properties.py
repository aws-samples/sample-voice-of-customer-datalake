"""Property tests of the document version rules (shared/document_versions.py).

Written after the example tests, to check the rules over many realistic titles and series rather than
over the cases someone thought of: a version number survives the trip through the displayed title,
a title's own text is never stripped, a series hands every document a different version, and only a
document's own type label is dropped from its series key.
"""
from __future__ import annotations

import unicodedata
from dataclasses import dataclass

from hypothesis import assume, example, given
from hypothesis import strategies as st

from shared.document_versions import (
    VERSION_SUFFIX_RE,
    canonical_document_title,
    normalize_document_versions,
    series_base_title,
    split_versioned_title,
)
from shared.test.property_settings import PROPERTY

# Words a person really types into a title: product names, a bare "v2" (text, not a version), a label
# that looks like a type, accents and full-width letters (NFKC folds them), and dashes.
PLAIN_WORDS = [
    'Checkout', 'pricing', 'Onboarding', 'Q3', 'v2', 'draft', 'Plan', 'PRD', 'PR/FAQ',
    'café', '\uff46\uff55\uff4c\uff4c', '—', '-', 'mobile', 'app', 'Summary', '2026', 'x',
]
# A copied "(vN)" can sit inside a title's text too; the module reads only the terminal one.
WORDS = st.sampled_from([*PLAIN_WORDS, '(v2)'])
# Plain space, two spaces, a tab, a newline, and a no-break space (which split() also treats as a space).
SEPARATORS = st.sampled_from([' ', '  ', '\t', ' \n ', '\u00a0'])


@st.composite
def clean_titles(draw, words_of=WORDS) -> str:
    """A non-empty title of 1-5 words with ordinary and odd whitespace between them."""
    words = draw(st.lists(words_of, min_size=1, max_size=5))
    parts = [words[0]]
    for word in words[1:]:
        parts.append(draw(SEPARATORS))
        parts.append(word)
    return ''.join(parts)


def _clean(title: str) -> str:
    """The title as the module reads it: NFKC, whitespace collapsed."""
    return ' '.join(unicodedata.normalize('NFKC', title).split())


# The version a title really carries: 1 to 999, never zero, never a leading zero.
VERSIONS = st.integers(min_value=1, max_value=999)


class TestAVersionSurvivesItsDisplayTitle:
    """Invariant: a document's display title "<base> (v<n>)" reads back as the same base and the same n.

    The title the page shows is the one the series is found by, so a version lost on the way would
    file a document under the wrong number.
    """

    @PROPERTY
    @given(base=clean_titles(), version=VERSIONS)
    @example(base='(v2)', version=1)
    @example(base='Plan —', version=12)
    def test_canonical_then_split_gives_back_base_and_version(self, base: str, version: int) -> None:
        # A base is what split_versioned_title returned, so it never ends in its own "(vN)"; the
        # canonical title replaces such a suffix (the next test), it does not add a second one.
        assume(not VERSION_SUFFIX_RE.search(_clean(base)))
        assert split_versioned_title(canonical_document_title(base, version)) == (_clean(base), version)

    @PROPERTY
    @given(base=clean_titles())
    def test_a_title_without_a_terminal_version_keeps_all_its_text(self, base: str) -> None:
        assume(not VERSION_SUFFIX_RE.search(_clean(base)))  # a trailing "(vN)" is the version: see above
        assert split_versioned_title(base) == (_clean(base), None)

    @PROPERTY
    @given(base=clean_titles(), version=VERSIONS)
    def test_a_user_suffix_is_read_once_and_the_display_is_canonical(self, base: str, version: int) -> None:
        """A title copied from the page carries its old suffix; the display title replaces it, never adds one."""
        copied = f'{_clean(base)} (v{version})'
        assert canonical_document_title(*split_versioned_title(copied)) == canonical_document_title(
            _clean(base), version)


@dataclass(frozen=True)
class SeriesRow:
    document_id: str
    title: str
    version: int | None
    created_at: str


@st.composite
def series_rows(draw) -> list[SeriesRow]:
    """One series: 1-6 documents of one base title, spelled as a user would (plain, upper case, with a
    copied "(vN)", with a PRD label), each with an optional persisted version (none, 0, 1-6 or a bool).

    The base itself never ends in its own type label ("Plan — PRD"): only one trailing label is dropped, so
    "Plan — PRD" and "Plan — PRD — PRD" are two series by design (see the notes' Findings)."""
    base = draw(clean_titles(words_of=st.sampled_from(PLAIN_WORDS)))
    assume(series_base_title(_clean(base), 'prd') == _clean(base))
    count = draw(st.integers(min_value=1, max_value=6))
    rows = []
    for index in range(count):
        spelling = draw(st.sampled_from([base, base.upper(), f'{base} (v{draw(VERSIONS)})', f'{base} — PRD']))
        version = draw(st.one_of(st.none(), st.integers(min_value=0, max_value=6), st.just(True)))
        day = draw(st.integers(min_value=1, max_value=28))
        rows.append(SeriesRow(document_id=f'doc-{index}', title=spelling, version=version,
                              created_at=f'2026-11-{day:02d}T10:00:00Z'))
    return rows


def _as_documents(rows: list[SeriesRow]) -> list[dict]:
    return [
        {'document_id': row.document_id, 'title': row.title, 'version': row.version,
         'created_at': row.created_at, 'document_type': 'prd', 'sk': f'PRD#{row.document_id}'}
        for row in rows
    ]


class TestASeriesGivesEachDocumentItsOwnVersion:
    """Invariant: inside one series every document has a positive, different version, and every title
    is the canonical title of its base and version. A persisted version that no earlier document claims
    is kept as it is."""

    @PROPERTY
    @given(rows=series_rows())
    def test_every_document_gets_a_distinct_positive_version_and_its_canonical_title(self, rows) -> None:
        documents = _as_documents(rows)
        out = normalize_document_versions(documents)

        assert [d['document_id'] for d in out] == [d['document_id'] for d in documents]
        versions = [d['version'] for d in out]
        assert all(isinstance(v, int) and v >= 1 for v in versions), versions
        assert len(set(versions)) == len(versions), versions
        bases = {d['base_title'] for d in out}
        assert len(bases) == 1, bases
        for d in out:
            assert d['title'] == canonical_document_title(d['base_title'], d['version'])

    @PROPERTY
    @given(rows=series_rows())
    def test_a_persisted_version_that_no_earlier_document_claims_is_kept(self, rows) -> None:
        out = normalize_document_versions(_as_documents(rows))
        ranked = sorted(range(len(rows)), key=lambda i: (rows[i].created_at, rows[i].document_id))
        claimed: set[int] = set()
        for index in ranked:
            wanted = rows[index].version
            is_positive_int = isinstance(wanted, int) and not isinstance(wanted, bool) and wanted > 0
            # A row claims its persisted version, or else the "(vN)" its title carries (legacy evidence).
            claim = wanted if is_positive_int else split_versioned_title(rows[index].title)[1]
            if claim is not None and claim not in claimed:
                assert out[index]['version'] == claim, (rows[index], out[index])
                claimed.add(claim)


class TestOnlyADocumentsOwnTypeLabelLeavesItsSeries:
    """Invariant: the series key drops a trailing " — <label>" only when the label names this document's
    own type. A PR/FAQ labelled title stays whole for a PRD, so the two are not merged by accident."""

    @PROPERTY
    @given(base=clean_titles())
    @example(base='Checkout')
    def test_the_own_label_is_dropped_and_the_other_types_label_is_kept(self, base: str) -> None:
        clean = _clean(base)
        assert series_base_title(f'{clean} — PRD', 'prd') == clean
        assert series_base_title(f'{clean} — PR/FAQ', 'prfaq') == clean
        assert series_base_title(f'{clean} — PR/FAQ', 'prd') == f'{clean} — PR/FAQ'
        assert series_base_title(f'{clean} — PRD', 'prfaq') == f'{clean} — PRD'

