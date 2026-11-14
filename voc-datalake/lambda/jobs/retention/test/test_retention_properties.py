"""Properties of the erasure worker's own rules (lambda/jobs/retention: handler.py's paging and scoping, copies.py's
tombstones).

The worker is the one Lambda that deletes customer feedback. A delete with no tombstone written before it loses the
proof that an item was erased lawfully (TENETS.md D4, D5); a hand-over that resumes past an item it never erased
leaves personal data behind; a job naming one workspace that deletes another's row, or a run that deletes a row whose
``WS#`` key names no workspace as if it were the deployment's, erases the wrong team's data. Tables, clients and the
clock are doubles: the properties check the order of the calls.
"""
from __future__ import annotations

from typing import Any
from unittest.mock import MagicMock, patch

import pytest
from hypothesis import given
from hypothesis import strategies as st

from jobs.retention import handler
from jobs.retention.boards import BOARDS_SOURCE, STORE_BOARDS
from jobs.retention.copies import tombstone_key, tombstone_record
from jobs.retention.members import STORE_MEMBERS
from jobs.retention.runs import MODE_ERASE, MODE_RETENTION
from shared.retention import STORE_RADAR, UNSCOPED_ROW_COUNTER, WORKSPACE_ERASE_FIELDS
from shared.test.ws_properties import PROPERTY, exactly, two_workspace_ids
from shared.ws_repo import WorkspaceScope

SOURCES = st.sampled_from(['webscraper', 'app_store', 'csv_upload', BOARDS_SOURCE])
FIELDS = st.sampled_from([*WORKSPACE_ERASE_FIELDS, 'source'])


@st.composite
def pages(draw: st.DrawFn) -> list[list[dict[str, str]]]:
    """1 to 4 scanned pages of 0 to 4 matched items each, every item its own key."""
    shape = draw(st.lists(st.integers(min_value=0, max_value=4), min_size=1, max_size=4))
    return [[{'pk': 'SOURCE#web', 'sk': f'FEEDBACK#{n}-{m}'} for m in range(size)] for n, size in enumerate(shape)]


def _walk(run: dict[str, Any]) -> handler.Walk:
    context = MagicMock()
    return handler.Walk(tables={'aggregates': MagicMock()}, context=context, event={}, run=run,
                        filters=MagicMock(), s3=MagicMock(), time_left=handler._lambda_clock(context))


# Per page, every match's tombstone is written before any match of that page is erased; the time is checked before
# each erase; when it runs out, the hand-over resumes right after the last item erased (the page's own start when
# none of it was), so no item is skipped; with time enough every item is erased once and every page counted.
@PROPERTY
@given(pages(), st.integers(min_value=0, max_value=30))
def test_a_tombstone_comes_before_its_delete_and_a_hand_over_skips_nothing(scanned, budget):
    log: list[tuple[str, Any]] = []
    checks = iter([True] * budget + [False] * 100)

    def scan(cursor: dict | None) -> dict:
        index = 0 if cursor is None else cursor['page']
        log.append(('scan', index))
        following = {'LastEvaluatedKey': {'page': index + 1}} if index + 1 < len(scanned) else {}
        return {'Items': scanned[index], 'ScannedCount': len(scanned[index]) + 1, **following}

    run: dict[str, Any] = {'scanned': 0, 'run_id': 'r1', 'mode': MODE_ERASE}
    with patch.object(handler, 'has_time_left', side_effect=lambda *_: next(checks)), \
            patch.object(handler, 'record_progress'), \
            patch.object(handler, '_hand_over', side_effect=lambda _walk, phase, cursor: {'handed': (phase, cursor)}):
        result = handler._erase_pages(_walk(run), 'items', None, scan,
                                      lambda items: log.append(('tombstones', [i['sk'] for i in items])),
                                      lambda item: log.append(('erase', item['sk'])))
    written: set[str] = set()
    erased: list[str] = []
    page_index = -1
    for kind, value in log:
        if kind == 'scan':
            page_index = value
        elif kind == 'tombstones':
            # One write of the whole page's tombstones, right after the page is read, before any of it is erased.
            assert value == [item['sk'] for item in scanned[page_index]]
            written.update(value)
        else:
            assert value in written
            erased.append(value)
    scans = [index for index, (kind, _value) in enumerate(log) if kind == 'scan']
    assert all(log[at + 1][0] == 'tombstones' for at in scans)
    every = [item['sk'] for page in scanned for item in page]
    assert erased == every[:len(erased)]
    if result is None:
        assert erased == every
        assert run['scanned'] == sum(len(page) + 1 for page in scanned)
        return
    _phase, cursor = result['handed']
    last_page = max(index for kind, index in log if kind == 'scan')
    erased_on_last = [sk for sk in erased if sk.startswith(f'FEEDBACK#{last_page}-')]
    if len(erased_on_last) == len(scanned[last_page]):
        # The page was done and the time ran out before the next one: resume at the next page.
        assert cursor == {'page': last_page + 1}
    elif erased_on_last:
        assert cursor == {'pk': 'SOURCE#web', 'sk': erased_on_last[-1]}
    else:
        # Out of time before the page's first item: resume at the page's own start.
        assert cursor == (None if last_page == 0 else {'page': last_page})


@st.composite
def rows_of(draw: st.DrawFn, ws: str, other: str) -> tuple[list[dict[str, str]], list[str]]:
    """A scanned page's rows: this workspace's, another's, the deployment's, and ``WS#`` keys that name none."""
    kinds = draw(st.lists(st.sampled_from(['mine', 'theirs', 'deployment', 'unscoped']), max_size=6))
    shapes = {'mine': f'WS#{ws}#SOURCE#web', 'theirs': f'WS#{other}#SOURCE#web', 'deployment': 'SOURCE#web',
              'unscoped': draw(st.sampled_from(['WS#', 'WS#acme#SOURCE#web', f'WS#{ws}', f'WS#{ws.lower()}x#S']))}
    return [{'pk': shapes[kind], 'sk': f'FEEDBACK#{n}'} for n, kind in enumerate(kinds)], kinds


# A job that names a workspace deletes nothing unless every matched row of the page is that workspace's: one row of
# another workspace, of the deployment, or with a WS# key that names none fails the job before any tombstone.
@PROPERTY
@given(st.data(), two_workspace_ids())
def test_a_named_workspace_job_touches_its_own_rows_only(data, pair):
    ws, other = pair
    rows, kinds = data.draw(rows_of(ws, other))
    page = {'Items': rows}
    if all(kind == 'mine' for kind in kinds):
        handler._only_in_workspace(ws, page)
        return
    with pytest.raises(ValueError, match=r'^(A matched row is outside the named workspace|not a workspace (key|id))$'):
        handler._only_in_workspace(ws, page)


# The daily retention run never deletes a row whose WS# key names no workspace as the deployment's: such rows leave
# the page (counted, the rest kept in order), and a page without any is handed on as it came.
@PROPERTY
@given(st.data(), two_workspace_ids(), st.integers(min_value=0, max_value=5))
def test_retention_skips_and_counts_rows_that_name_no_workspace(data, pair, before):
    ws, other = pair
    rows, kinds = data.draw(rows_of(ws, other))
    run: dict[str, Any] = {UNSCOPED_ROW_COUNTER: before} if before else {}
    page = {'Items': rows, 'LastEvaluatedKey': {'pk': 'x'}}
    with patch.object(handler, 'metrics'), patch.object(handler, 'logger'):
        kept = handler._without_unscoped_rows(run, page)
    skipped = kinds.count('unscoped')
    if not skipped:
        assert kept is page
        assert run.get(UNSCOPED_ROW_COUNTER, 0) == before
        return
    assert kept == {'Items': [row for row, kind in zip(rows, kinds, strict=True) if kind != 'unscoped'],
                    'LastEvaluatedKey': {'pk': 'x'}}
    assert run[UNSCOPED_ROW_COUNTER] == before + skipped


# A run walks the documented phases in order: a job that names a workspace walks its items and (an erasure) that
# workspace's exports only; otherwise items, Radar when its table is there, the boards and memberships for an
# erasure by email (the boards also for their own source), the raw sweep for a whole-source erasure, the exports
# (an erasure), then lineage when the projects table is there.
@PROPERTY
@given(st.sampled_from([MODE_ERASE, MODE_RETENTION]), FIELDS, st.one_of(st.none(), SOURCES),
       st.one_of(st.none(), st.just('ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D8')),
       st.sets(st.sampled_from([STORE_RADAR, STORE_BOARDS, STORE_MEMBERS, 'projects'])))
def test_a_run_walks_the_documented_phases(mode, field, source, workspace, stores):
    run = {'mode': mode, 'field': field, 'source': source, **({'workspace_id': workspace} if workspace else {})}
    tables = {'aggregates': MagicMock(), **{name: MagicMock() for name in stores}}
    walk = handler.Walk(tables=tables, context=MagicMock(), event={}, run=run, filters=MagicMock(), s3=MagicMock(),
                        time_left=MagicMock())
    erase = mode == MODE_ERASE
    by_email = erase and field == 'email'
    if workspace:
        expected = ['items', *(['exports'] if erase else [])]
    else:
        expected = ['items', *(['radar'] if STORE_RADAR in stores else []),
                    *(['boards'] if STORE_BOARDS in stores and by_email and source in (None, BOARDS_SOURCE)
                      else []),
                    *(['members'] if STORE_MEMBERS in stores and by_email and not source else []),
                    *(['raw'] if field == 'source' else []), *(['exports'] if erase else []),
                    *(['lineage'] if 'projects' in stores else [])]
    assert handler._phases(walk) == expected


# A job row names a workspace only for an erasure that may run in one: no workspace field runs deployment-wide; a
# field that is no workspace id, or a whole-source job that names one, fails the job, never running deployment-wide.
@PROPERTY
@given(FIELDS, st.one_of(st.none(), st.sampled_from(['ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D8', 'acme', '', 7])))
def test_a_job_row_names_a_workspace_only_where_one_may_run(field, workspace):
    job: dict[str, Any] = {'field': field, **({'workspace_id': workspace} if workspace is not None else {})}
    if workspace is None:
        assert handler._named_workspace(job) is None
    elif workspace != 'ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D8':
        with pytest.raises(ValueError, match=r'^(not a workspace id|the message names no workspace)$'):
            handler._named_workspace(job)
    elif field not in WORKSPACE_ERASE_FIELDS:
        with pytest.raises(ValueError, match=exactly('This erasure cannot name a workspace')):
            handler._named_workspace(job)
    else:
        assert handler._named_workspace(job) == WorkspaceScope(workspace)


# Tombstones never meet: the deployment's and every workspace's copy of one source item get different keys in the
# one audit partition of the source (under the audit-row guard), and a tombstone carries the run, the legal basis,
# the time and a workspace item's workspace, never any of the item's content.
@PROPERTY
@given(two_workspace_ids(), SOURCES, st.text(alphabet='abc012-_', min_size=1, max_size=12),
       st.one_of(st.none(), st.just('er_0123456789ab')))
def test_tombstones_never_meet_and_carry_no_content(pair, source, feedback_id, job_id):
    mine, theirs = WorkspaceScope(pair[0]), WorkspaceScope(pair[1])
    keys = [tombstone_key(source, feedback_id), tombstone_key(source, feedback_id, mine),
            tombstone_key(source, feedback_id, theirs)]
    assert len({(key['pk'], key['sk']) for key in keys}) == 3
    assert {key['pk'] for key in keys} == {f'AUDIT#tombstone#{source}'}
    assert keys[1]['sk'] == f'{mine.ws}#{feedback_id}'
    run = {'mode': MODE_ERASE, 'run_id': 'r1', 'legal_basis': 'gdpr_art17', **({'job_id': job_id} if job_id else {})}
    for scope in (None, mine):
        record = tombstone_record(run, source, feedback_id, 'feedback', '2026-11-14T08:00:00+00:00', scope)
        assert record == {**tombstone_key(source, feedback_id, scope), 'source': source, 'store': 'feedback',
                          'mode': MODE_ERASE, 'run_id': 'r1', 'legal_basis': record['legal_basis'],
                          'deleted_at': '2026-11-14T08:00:00+00:00', **({'job_id': job_id} if job_id else {}),
                          **({'workspace_id': scope.ws} if scope else {})}
        assert record['legal_basis']
