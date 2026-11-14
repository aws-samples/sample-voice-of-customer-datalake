"""Property tests of the document version rules that cost most when wrong (shared/document_versions.py).

The first property file (`test_document_versions_properties.py`) checks titles and one series at a time. These
check what a person relies on when several series and legacy rows meet:

* a series key and a counter key do not depend on how the title was spelled (case, spacing, a copied "(vN)",
  the document's own type label), and never join two types;
* reading a project's documents gives every document the same version whatever order the rows came back in,
  reading the result again changes nothing, and each series is versioned as if it were alone;
* a document with no version takes the lowest numbers nobody claimed, in creation order;
* a legacy migration keeps every version already written down (assignment rows, then versions on the
  documents), never reuses one, and numbers the rest above the counter's floor;
* a generated document's id and keys are a pure function of its project, type and allocation.
"""
from __future__ import annotations

import copy
import re
import unicodedata
from decimal import Decimal
from typing import Any
from unittest.mock import MagicMock, patch

import pytest
from hypothesis import assume, example, given
from hypothesis import strategies as st

import shared.document_versions as dv
from shared.document_versions import (
    VERSION_SUFFIX_RE,
    VERSIONED_DOCUMENT_TYPES,
    _allocation_key,
    _counter_key,
    _document_key,
    _legacy_document_update,
    _plan_legacy_series,
    _positive_int,
    _requires_legacy_persistence,
    canonical_document_title,
    normalize_document_versions,
    normalized_base_title,
    series_base_title,
    split_versioned_title,
    versioned_document_id,
)
from shared.exceptions import ServiceError
from shared.test.property_settings import PROPERTY
from shared.test.test_document_versions_properties import PLAIN_WORDS, SEPARATORS, VERSIONS, clean_titles

TYPES = sorted(VERSIONED_DOCUMENT_TYPES)
SK_PREFIX = {'prd': 'PRD#', 'prfaq': 'PRFAQ#', 'prototype': 'PROTOTYPE#'}
OWN_LABEL = {'prd': ' — PRD', 'prfaq': ' — PR/FAQ', 'prototype': ''}
# A stored version as DynamoDB and old writers left it: missing, zero, a bool, a Decimal, a digit string, an int.
STORED_VERSIONS = st.one_of(
    st.none(), st.just(0), st.just(True),
    st.integers(min_value=1, max_value=8),
    st.integers(min_value=1, max_value=8).map(Decimal),
    st.integers(min_value=1, max_value=8).map(str),
)
# Project and job ids the way the API mints them: hex ids, never a '|'.
IDS = st.text(alphabet='0123456789abcdef', min_size=8, max_size=32)


def _clean(title: str) -> str:
    """The title as the module reads it: NFKC, whitespace collapsed."""
    return ' '.join(unicodedata.normalize('NFKC', title).split())


def _plain_base(title: str, document_type: str) -> bool:
    """A base a series could be stored under: no terminal "(vN)" and no own type label of its own."""
    clean = _clean(title)
    return not VERSION_SUFFIX_RE.search(clean) and series_base_title(clean, document_type) == clean


@st.composite
def spellings(draw, base: str, document_type: str) -> str:
    """One way a user (or the page, or the wizard) writes the title of the series *base*."""
    label = OWN_LABEL[document_type]
    return draw(st.sampled_from([
        base, base.upper(), base.lower(), f'  {base}  ', f'{base} (v{draw(VERSIONS)})',
        f'{base}{label}', f'{base}{label} (V{draw(VERSIONS)})',
    ]))


class TestASeriesKeyIgnoresHowItsTitleIsSpelled:
    """Invariant: every spelling of one title (case, spacing, a copied "(vN)", its own type label) is one series
    key and one version counter; the same title under another type is another counter.

    A key that moved with the spelling would restart the series at v1 and show two "v1" documents side by side.
    """

    @PROPERTY
    @given(base=clean_titles(words_of=st.sampled_from(PLAIN_WORDS)), document_type=st.sampled_from(TYPES),
           data=st.data())
    def test_every_spelling_shares_the_key_and_the_counter(self, base, document_type, data) -> None:
        assume(_plain_base(base, document_type))
        spelled = data.draw(spellings(_clean(base), document_type))
        key = normalized_base_title(spelled, document_type)
        assert key == normalized_base_title(base, document_type) == _clean(base).casefold()
        assert _counter_key('p1', document_type, key) == _counter_key(
            'p1', document_type, normalized_base_title(base, document_type))

    @PROPERTY
    @given(base=clean_titles(words_of=st.sampled_from(PLAIN_WORDS)),
           types=st.lists(st.sampled_from(TYPES), min_size=2, max_size=2, unique=True), project=IDS)
    def test_another_type_or_project_is_another_counter(self, base, types, project) -> None:
        first, second = types
        key = normalized_base_title(base, first)
        assert _counter_key(project, first, key) != _counter_key(project, second, key)
        assert _counter_key(project, first, key) != _counter_key(f'{project}0', first, key)
        assert _counter_key(project, first, key)['pk'] == f'DOCUMENT_VERSIONS#PROJECT#{project}'


@st.composite
def projects(draw) -> list[dict[str, Any]]:
    """A project's rows: 1-3 series of distinct keys (any managed type), 1-8 documents spelled freely, with stored
    versions as old writers left them, some typed only by their sort key, plus an unmanaged custom document."""
    series = []
    for _ in range(draw(st.integers(min_value=1, max_value=3))):
        document_type = draw(st.sampled_from(TYPES))
        base = _clean(draw(clean_titles(words_of=st.sampled_from(PLAIN_WORDS))))
        assume(_plain_base(base, document_type))
        series.append((document_type, base))
    keys = [(t, normalized_base_title(b, t)) for t, b in series]
    assume(len(set(keys)) == len(keys))
    rows: list[dict[str, Any]] = []
    for index in range(draw(st.integers(min_value=1, max_value=8))):
        document_type, base = draw(st.sampled_from(series))
        row: dict[str, Any] = {
            'pk': 'PROJECT#p1', 'sk': f'{SK_PREFIX[document_type]}d{index}', 'document_id': f'd{index}',
            'title': draw(spellings(base, document_type)),
            'created_at': f'2026-11-{draw(st.integers(min_value=1, max_value=9)):02d}T10:00:00Z',
        }
        if draw(st.booleans()):
            row['document_type'] = document_type  # else a legacy row, typed by its sort key
        version = draw(STORED_VERSIONS)
        if version is not None:
            row['version'] = version
        rows.append(row)
    if draw(st.booleans()):
        rows.insert(draw(st.integers(min_value=0, max_value=len(rows))),
                    {'pk': 'PROJECT#p1', 'sk': 'DOC#c1', 'document_id': 'c1', 'title': 'Notes (v2)'})
    return rows


def _identity(documents: list[dict[str, Any]]) -> dict[str, tuple]:
    return {d['document_id']: (d.get('base_title'), d.get('version'), d.get('title')) for d in documents}


def _series_of(document: dict[str, Any]) -> tuple[str, str] | None:
    sk = document['sk']
    document_type = next((t for t, prefix in SK_PREFIX.items() if sk.startswith(prefix)), None)
    return None if document_type is None else (document_type, normalized_base_title(document['title'], document_type))


class TestReadingAProjectIsDeterministic:
    """Invariant: the versions a read shows depend only on the rows, not on the order the query returned them;
    reading the shown rows again shows the same thing; each series is numbered as if it were the only one; an
    unmanaged document passes through as it was.

    Two readers that disagreed would show one document as v2 on one page and v3 on another.
    """

    @PROPERTY
    @given(rows=projects(), data=st.data())
    def test_the_order_of_the_rows_does_not_matter(self, rows, data) -> None:
        shuffled = data.draw(st.permutations(rows))
        assert _identity(normalize_document_versions(shuffled)) == _identity(normalize_document_versions(rows))

    @PROPERTY
    @given(rows=projects())
    def test_reading_the_result_again_changes_nothing(self, rows) -> None:
        once = normalize_document_versions(rows)
        assert normalize_document_versions(once) == once
        assert not any(_requires_legacy_persistence(d) for d in once if _series_of(d) is not None)

    @PROPERTY
    @given(rows=projects())
    def test_each_series_is_numbered_alone_and_other_rows_are_untouched(self, rows) -> None:
        together = _identity(normalize_document_versions(rows))
        for key in {_series_of(row) for row in rows} - {None}:
            alone = [row for row in rows if _series_of(row) == key]
            assert {k: together[k] for k in _identity(alone)} == _identity(normalize_document_versions(alone))
        for row, out in zip(rows, normalize_document_versions(rows), strict=True):
            if _series_of(row) is None:
                assert out == row


class TestAMigrationWritesTheSeriesAReadShows:
    """Invariant: the legacy migration persists exactly the series a read groups (same type, same key, same
    documents in the same order), each once, and only those holding a row that is not yet canonical.

    A migration that split or merged series differently from the read would write versions under one counter
    while the page numbers them under another.
    """

    @PROPERTY
    @given(rows=projects())
    def test_one_write_per_unsettled_series_of_the_read(self, rows) -> None:
        expected: dict[tuple[str, str], list[str]] = {}
        for row in rows:
            key = _series_of(row)
            if key is not None:
                expected.setdefault(key, []).append(row['sk'])
        unsettled = {key: sks for key, sks in expected.items()
                     if any(_requires_legacy_persistence(r) for r in rows if r['sk'] in sks)}
        with patch.object(dv, '_persist_legacy_series') as series:
            series.side_effect = lambda _t, _p, _type, _n, docs: docs
            dv.persist_legacy_document_versions(MagicMock(), 'p1', rows)
        written = {(c.args[2], c.args[3]): [d['sk'] for d in c.args[4]] for c in series.call_args_list}
        assert series.call_count == len(written)
        assert written == unsettled


class TestASaveContinuesPastEveryVersionTheReadShows:
    """Invariant: for any spelling of a series' title, the state a save starts from is the series' displayed base
    and the highest version the read shows in it; a title with no documents starts from its own base at 0.

    A save that missed a shown version would hand out that number a second time.
    """

    @PROPERTY
    @given(rows=projects(), data=st.data())
    def test_the_head_is_the_highest_shown_version_of_the_series(self, rows, data) -> None:
        shown = normalize_document_versions(rows)
        for document_type, key in {series for row in rows if (series := _series_of(row)) is not None}:
            pairs = [(d, row) for d, row in zip(shown, rows, strict=True) if _series_of(row) == (document_type, key)]
            members = [d for d, _ in pairs]
            # The save asks with any title a member was written under.
            requested = data.draw(st.sampled_from([row['title'] for _, row in pairs]))
            normalized = normalized_base_title(requested, document_type)
            assert dv._series_state(rows, document_type, normalized, 'Fallback') == (
                members[0]['base_title'], max(d['version'] for d in members))
        assert dv._series_state(rows, 'prd', 'no such title', 'Fallback') == ('Fallback', 0)


class TestUnclaimedDocumentsTakeTheLowestFreeVersions:
    """Invariant: in a series, the documents that claim no version that is still free (persisted, or a copied
    "(vN)") get the lowest positive numbers nobody claimed, the earliest document the lowest.

    A gap left open or a number handed out of creation order would renumber what people already saw.
    """

    @PROPERTY
    @given(rows=projects())
    @example(rows=[
        {'pk': 'PROJECT#p1', 'sk': 'PRD#d0', 'document_id': 'd0', 'title': 'Plan (v2)', 'created_at': '2'},
        {'pk': 'PROJECT#p1', 'sk': 'PRD#d1', 'document_id': 'd1', 'title': 'Plan', 'created_at': '1'},
        {'pk': 'PROJECT#p1', 'sk': 'PRD#d2', 'document_id': 'd2', 'title': 'Plan', 'created_at': '3'},
    ])
    def test_fills_are_the_lowest_unclaimed_numbers_in_creation_order(self, rows) -> None:
        out = {d['document_id']: d for d in normalize_document_versions(rows)}
        for key in {_series_of(row) for row in rows} - {None}:
            ranked = sorted((r for r in rows if _series_of(r) == key),
                            key=lambda r: (r['created_at'], r['document_id'], r['sk']))
            claimed: set[int] = set()
            unclaimed = []
            for row in ranked:
                claim = _positive_int(row.get('version')) or split_versioned_title(row['title'])[1]
                if claim is not None and claim not in claimed:
                    claimed.add(claim)
                else:
                    unclaimed.append(row['document_id'])
            free = [n for n in range(1, len(ranked) + len(claimed) + 1) if n not in claimed][:len(unclaimed)]
            assert [out[i]['version'] for i in unclaimed] == free
            # The series shows the earliest document's own base spelling.
            first = split_versioned_title(ranked[0]['title'])[0]
            assert {out[r['document_id']]['base_title'] for r in ranked} == {first}


@st.composite
def legacy_series(draw) -> dict[str, Any]:
    """One legacy series being migrated: 1-7 documents with distinct sort keys; some already have an assignment
    row (distinct versions), some only a version on the row (distinct from every other claim), some a copied
    "(vN)" in the title; a counter floor of 0-6 and an optional counter base title."""
    count = draw(st.integers(min_value=1, max_value=7))
    claims = draw(st.lists(st.integers(min_value=1, max_value=14), min_size=count, max_size=count, unique=True))
    documents, assignments = [], []
    for index in range(count):
        kind = draw(st.sampled_from(['assigned', 'assigned+row', 'persisted', 'suffix', 'bare']))
        version = claims[index]
        document: dict[str, Any] = {
            'pk': 'PROJECT#p1', 'sk': f'PRD#d{index}', 'document_id': f'd{index}',
            'created_at': f'2026-11-{draw(st.integers(min_value=1, max_value=9)):02d}',
            'title': draw(st.sampled_from(['Plan', 'plan — PRD', 'PLAN'])),
        }
        if kind.startswith('assigned'):
            assignments.append({'source_document_sk': document['sk'], 'version': Decimal(version)})
            if kind == 'assigned+row':
                document['version'] = version
        elif kind == 'persisted':
            document['version'] = Decimal(version)
        elif kind == 'suffix':
            document['title'] = f"{document['title']} (v{draw(st.integers(min_value=1, max_value=14))})"
        documents.append(document)
    return {
        'documents': documents, 'assignments': assignments,
        'floor': draw(st.integers(min_value=0, max_value=6)),
        'counter_base': draw(st.sampled_from([None, '', 'Plan (v4)', 'Shared plan'])),
    }


def _plan(series: dict[str, Any], documents: list[dict[str, Any]] | None = None) -> dict[str, dict[str, Any]]:
    planned = _plan_legacy_series(
        series['documents'] if documents is None else documents,
        series['assignments'], series['counter_base'], series['floor'],
    )
    return {d['sk']: d for d in planned}


class TestALegacyMigrationKeepsEveryWrittenVersion:
    """Invariant: migrating a legacy series keeps every version already written down (its assignment row first,
    else the version on the document), takes a copied "(vN)" only when it is above the counter's floor and free,
    and numbers every other document with the lowest free versions above the floor, in creation order; no two
    documents share a version, and every title is the canonical title of the series' base.

    A migration that moved a written version would change a document people already cited; one that reused a
    number at or below the floor would hand out a version a deleted document once had.
    """

    @PROPERTY
    @given(series=legacy_series())
    def test_written_versions_stay_and_the_rest_fill_above_the_floor(self, series) -> None:
        planned = _plan(series)
        documents = series['documents']
        assigned = {a['source_document_sk']: int(a['version']) for a in series['assignments']}
        written = {d['sk']: _positive_int(d.get('version')) for d in documents}
        kept = {sk: assigned.get(sk) or written[sk] for sk in written if assigned.get(sk) or written[sk]}
        assert {sk: planned[sk]['version'] for sk in kept} == kept

        used = set(kept.values())
        fills = []
        for document in sorted(documents, key=lambda d: (d['created_at'], d['document_id'], d['sk'])):
            if document['sk'] in kept:
                continue
            suffix = split_versioned_title(document['title'])[1]
            if suffix is not None and suffix > series['floor'] and suffix not in used:
                assert planned[document['sk']]['version'] == suffix
                used.add(suffix)
            else:
                fills.append(document['sk'])
        free = (n for n in range(series['floor'] + 1, series['floor'] + 30) if n not in used)
        assert [planned[sk]['version'] for sk in fills] == [next(free) for _ in fills]

        versions = [d['version'] for d in planned.values()]
        assert len(set(versions)) == len(versions)
        bases = {d['base_title'] for d in planned.values()}
        assert len(bases) == 1
        assert all(d['title'] == canonical_document_title(d['base_title'], d['version']) for d in planned.values())

    @PROPERTY
    @given(series=legacy_series(), data=st.data())
    def test_the_plan_ignores_row_order_and_planning_it_again_changes_nothing(self, series, data) -> None:
        planned = _plan(series)
        shuffled = data.draw(st.permutations(series['documents']))
        assert _plan(series, shuffled) == planned
        assert [d['sk'] for d in _plan_legacy_series(shuffled, series['assignments'], series['counter_base'],
                                                     series['floor'])] == [d['sk'] for d in shuffled]
        assert _plan(series, list(planned.values())) == planned

    @PROPERTY
    @given(series=legacy_series())
    def test_the_base_is_the_counters_else_the_earliest_documents(self, series) -> None:
        earliest = min(series['documents'], key=lambda d: (d['created_at'], d['document_id'], d['sk']))
        expected = split_versioned_title(series['counter_base'] or earliest['title'])[0]
        assert {d['base_title'] for d in _plan(series).values()} == {expected}

    @PROPERTY
    @given(series=legacy_series(), data=st.data())
    def test_a_version_on_a_row_that_contradicts_a_claim_is_refused(self, series, data) -> None:
        assume(series['assignments'])
        series = copy.deepcopy(series)
        claim = data.draw(st.sampled_from(series['assignments']))
        by_sk = {d['sk']: d for d in series['documents']}
        other = [d for d in series['documents'] if d['sk'] != claim['source_document_sk']]
        if other and data.draw(st.booleans()):
            # Another document says it holds a version the assignment rows gave to someone else.
            victim = data.draw(st.sampled_from(other))
            assume(victim['sk'] not in {a['source_document_sk'] for a in series['assignments']})
            victim['version'] = int(claim['version'])
            message = 'Duplicate persisted document versions detected'
        else:
            # The document itself carries another version than its assignment row.
            by_sk[claim['source_document_sk']]['version'] = int(claim['version']) + 100
            message = 'Legacy document version conflicts with its assignment'
        with pytest.raises(ServiceError, match=message):
            _plan(series)


class TestAGeneratedDocumentsKeysArePure:
    """Invariant: a generated document's id, its row key and its allocation key are a function of (project, type,
    allocation) alone: equal inputs give equal keys, any change gives another key, and the id names its type.

    Retries of one job must land on one row; two jobs must never share one.
    """

    @PROPERTY
    @given(project=IDS, document_type=st.sampled_from(TYPES), allocation=IDS,
           other=st.tuples(IDS, st.sampled_from(TYPES), IDS))
    def test_one_allocation_one_document(self, project, document_type, allocation, other) -> None:
        document_id = versioned_document_id(project, document_type, allocation)
        assert re.fullmatch(rf'{document_type}_[0-9a-f]{{20}}', document_id)
        assert versioned_document_id(project, document_type, allocation) == document_id
        assert _document_key(project, document_type, allocation) == {
            'pk': f'PROJECT#{project}', 'sk': f'{document_type.upper()}#{document_id}'}
        assume(other != (project, document_type, allocation))
        assert versioned_document_id(*other) != document_id
        assert _allocation_key(*other) != _allocation_key(project, document_type, allocation)


class TestOnlyACanonicalRowIsSettled:
    """Invariant: a managed row needs no migration exactly when it has a positive version, a base title and the
    canonical title of the two; and the migration's update is skipped exactly then, and otherwise guards every
    attribute it read.

    A row wrongly called settled keeps a stale title forever; one wrongly rewritten races its own editor.
    """

    @PROPERTY
    @given(base=clean_titles(words_of=st.sampled_from(PLAIN_WORDS)), version=VERSIONS,
           title_change=st.sampled_from([None, 'drop', 'other-version', 'case']),
           stored=st.sampled_from(['int', 'decimal']))
    def test_settled_iff_canonical(self, base, version, title_change, stored) -> None:
        assume(_plain_base(base, 'prd'))
        canonical = canonical_document_title(base, version)
        title = {None: canonical, 'drop': None, 'other-version': canonical_document_title(base, version + 1),
                 'case': canonical.swapcase()}[title_change]
        assume(title != canonical or title_change is None)
        row: dict[str, Any] = {'pk': 'PROJECT#p1', 'sk': 'PRD#d0', 'base_title': base,
                               'version': Decimal(version) if stored == 'decimal' else version}
        if title is not None:
            row['title'] = title
        target = {'base_title': _clean(base), 'version': version, 'title': canonical}
        assert _requires_legacy_persistence(row) is (title != canonical)
        update = _legacy_document_update('projects', row, target)
        if all(row.get(k) == v for k, v in target.items()):
            assert update is None
        else:
            assert update is not None
            condition = update['Update']['ConditionExpression']
            values = update['Update']['ExpressionAttributeValues']
            for alias, attribute in (('#base', 'base_title'), ('#version', 'version'), ('#title', 'title')):
                if attribute in row:
                    assert f'{alias} = :observed_{attribute}' in condition
                    assert values[f':observed_{attribute}'] == row[attribute]
                else:
                    assert f'attribute_not_exists({alias})' in condition


class TestAStoredVersionIsReadOnlyWhenWhole:
    """Invariant: a stored version counts only when it is a whole number above zero, whatever type DynamoDB or an
    old writer gave it (int, Decimal, digit string); a bool, a fraction, zero, a sign or text never counts."""

    @PROPERTY
    @given(value=st.one_of(
        st.integers(min_value=-5, max_value=10**6),
        st.integers(min_value=-5, max_value=10**6).map(Decimal),
        st.decimals(min_value=-5, max_value=50, places=2, allow_nan=False),
        st.integers(min_value=-5, max_value=10**6).map(str),
        st.booleans(), st.floats(allow_nan=False), st.text(alphabet='0123456789abc -.+', max_size=4), st.none(),
    ))
    def test_only_positive_whole_numbers_count(self, value) -> None:
        if isinstance(value, (bool, float)) or value is None:
            expected = None
        elif isinstance(value, (int, Decimal)):
            expected = int(value) if value == int(value) and value > 0 else None
        else:
            expected = int(value) if value.isdigit() and int(value) > 0 else None
        assert _positive_int(value) == expected


class TestATitleThatEndsInTwoVersionsKeepsOneSeries:
    """Invariant: the base a title is filed under is a fixed point: reading it back as a title gives itself, so a
    document stays in the series it was written to and its stored base agrees with its displayed title.

    Fails today on a title ending in two "(vN)" suffixes (docs/mutation-notes-mut-voc-wiki.md, Findings): xfail until
    split_versioned_title strips every terminal suffix.
    """

    @pytest.mark.xfail(strict=True, reason='split_versioned_title strips one terminal (vN) of several')
    @PROPERTY
    @given(base=clean_titles(words_of=st.sampled_from(PLAIN_WORDS)), versions=st.lists(VERSIONS, min_size=1,
                                                                                      max_size=3),
           separator=SEPARATORS)
    @example(base='Plan', versions=[2, 3], separator=' ')
    def test_the_base_of_a_base_is_itself(self, base, versions, separator) -> None:
        title = separator.join([base, *(f'(v{n})' for n in versions)])
        filed = split_versioned_title(title)[0]
        assert split_versioned_title(filed)[0] == filed
        stored = normalize_document_versions([{'sk': 'PRD#d0', 'title': title, 'created_at': '1'}])[0]
        assert split_versioned_title(stored['title'])[0] == stored['base_title']
