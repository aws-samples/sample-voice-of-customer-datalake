"""``scripts/projects/backfill_review_registries.py``: list the deployment's review links, commented series and
projects made before 7.48.00 (projects 3g-d).

Against moto, with rows as the stores wrote them before 7.48.00 (no registry row): a dry run writes nothing; ``--apply``
lists every deployment link once (a revoked one too, naming its project and series), never a workspace link's routing
row, every comment partition once (a deleted project's too, a series that runs over a page's end once) and every
project's ``META`` once (a deleted one too, never the persona library's), then the marker, which names the release it
was taken under; a second run lists nothing (idempotent) and keeps a row the stores wrote meanwhile. Progress is kept
in a row of its own (``MIGRATION#review-registries#progress``), so a run stopped after any page and resumed
(``--resume``, from that row only, under a new run id) ends as one that never stopped, with the summed counts; a run
that another run took over stops, and its marker and its void are refused. The walk is refused unless there is
exactly one function of each writer, on 7.48.0, its last update Successful and older than the longest Timeout plus 5
minutes; ``--unmark`` deletes the marker. Lives under ``lambda/`` so the default ``testpaths`` runs it; the script is
loaded by path.
"""
from __future__ import annotations

import sys
from datetime import UTC, datetime, timedelta
from typing import Any
from unittest.mock import MagicMock

import pytest
from boto3.dynamodb.conditions import Key
from moto import mock_aws

from shared import project_scope
from shared.project_keys import REVIEW_REGISTRIES_MARKER_SK
from shared.test.moto_tables import create_projects_table_with_type_index
from shared.test.repo_paths import load_module_from_path, repo_root

_SCRIPT = repo_root() / 'scripts' / 'projects' / 'backfill_review_registries.py'
WS: str = 'ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D8'
NOW = '2026-11-16T12:00:00+00:00'
CLOCK = datetime(2026, 11, 16, 12, 0, tzinfo=UTC)
LIVE, REVOKED, ROUTED = 'shr_' + '1' * 32, 'shr_' + '2' * 32, 'shr_' + '3' * 32
SERIES_A, SERIES_B = 'ser_' + 'a' * 24, 'ser_' + 'b' * 24
PROGRESS_SK = f'{REVIEW_REGISTRIES_MARKER_SK}#progress'


@pytest.fixture(scope='module')
def backfill():
    module = load_module_from_path('backfill_review_registries', _SCRIPT)
    try:
        yield module
    finally:
        sys.modules.pop(module.__name__, None)


@pytest.fixture
def table():
    with mock_aws():
        yield create_projects_table_with_type_index('projects')


def _writer(base: str, version: str | None = '7.48.0', minutes: int = 30, status: str = 'Successful',
            timeout: int = 900) -> dict[str, Any]:
    return {'name': f'{base}-1-r', 'base': base, 'version': version, 'status': status, 'timeout': timeout,
            'last_modified': CLOCK - timedelta(minutes=minutes)}


def _deployed(version: str = '7.48.0', minutes: int = 30) -> Any:
    """The functions that write links or threads, as the operator's read of them answers (the longest Timeout 15
    minutes, so a drain of 20)."""
    return lambda: [_writer(base, version, minutes) for base in ('voc-projects-api', 'voc-projects-assist')]


def _run(backfill, table, **options: Any) -> Any:
    options.setdefault('deployed', _deployed())
    options.setdefault('now', lambda: NOW)
    return backfill.run(table, clock=lambda: CLOCK, **options)


def _seed(table) -> None:
    """Pre-7.48.00 rows: two deployment links (one revoked: its series' pointer gone), a workspace link's routing row
    and the workspace's own link, the threads of three series (one of a deleted project), a malformed link row and a
    malformed comment partition."""
    rows: list[dict[str, Any]] = [
        {'pk': f'DOCSHARE#{LIVE}', 'sk': 'META', 'share_id': LIVE, 'project_id': 'p1', 'series_id': SERIES_A,
         'created_at': '2026-10-01T00:00:00+00:00', 'audience': {'mode': 'list', 'emails': ['reviewer@partner.example']}},
        {'pk': f'DOCSHARE#{REVOKED}', 'sk': 'META', 'share_id': REVOKED, 'project_id': 'p1', 'series_id': SERIES_B,
         'created_at': '2026-10-02T00:00:00+00:00', 'revoked': True},
        {'pk': f'DOCSHARE#{ROUTED}', 'sk': 'META', 'workspace_id': WS, 'routed_at': NOW},
        {'pk': f'WS#{WS}#DOCSHARE#{ROUTED}', 'sk': 'META', 'share_id': ROUTED},
        {'pk': 'DOCSHARE#shr_bad', 'sk': 'META'},
        {'pk': f'DCOMMENTS#p1#{SERIES_A}', 'sk': 'SHARE', 'share_id': LIVE},
        *({'pk': f'DCOMMENTS#p1#{SERIES_A}', 'sk': f'C#dc_{n}'} for n in range(4)),
        {'pk': f'DCOMMENTS#p1#{SERIES_B}', 'sk': 'C#dc_9'},
        {'pk': f'DCOMMENTS#gone#{SERIES_A}', 'sk': 'C#dc_8'},
        {'pk': f'WS#{WS}#DCOMMENTS#p9#{SERIES_A}', 'sk': 'C#dc_7'},
        *({'pk': 'DCOMMENTS#odd', 'sk': f'C#x{n}'} for n in range(3)),
        {'pk': 'PROJECT#p1', 'sk': 'META', 'gsi1pk': 'TYPE#PROJECT', 'gsi1sk': NOW, 'created_at': '2026-09-01'},
        # A deleted project: its META tombstoned and off the index, its other rows gone.
        {'pk': 'PROJECT#gone', 'sk': 'META', 'status': 'deleted', 'created_at': '2026-08-01'},
        {'pk': 'PROJECT#p1', 'sk': 'PERSONA#a'},
        # The persona library's container, which no registry lists (the walks read it on their own).
        {'pk': 'PROJECT#company_personas', 'sk': 'META'},
    ]
    for row in rows:
        table.put_item(Item=row)


def _registry(table, pk: str) -> dict[str, dict[str, Any]]:
    return {row['sk']: row for row in table.query(KeyConditionExpression=Key('pk').eq(pk))['Items']}


def _written(table) -> dict[str, Any]:
    links = _registry(table, 'DOCSHARE_IDS')
    marker = links.pop(REVIEW_REGISTRIES_MARKER_SK, None)
    progress = links.pop(PROGRESS_SK, None)
    return {'links': links, 'series': _registry(table, 'COMMENT_SERIES_IDS'), 'marker': marker, 'progress': progress,
            'projects': _registry(table, 'PROJECT_IDS')}


SERIES_LISTED = sorted([f'p1#{SERIES_A}', f'p1#{SERIES_B}', f'gone#{SERIES_A}'])
NOTHING: dict[str, Any] = {'links': {}, 'series': {}, 'marker': None, 'progress': None, 'projects': {}}


def test_a_dry_run_writes_nothing(backfill, table):
    _seed(table)
    before = table.scan()['Items']
    report = _run(backfill, table, apply=False)
    assert table.scan()['Items'] == before
    assert (report.listed, report.marked) == ({'links': 2, 'series': 3, 'projects': 2}, False)


def test_apply_lists_every_deployment_link_and_series_once_then_the_marker(backfill, table):
    _seed(table)
    report = _run(backfill, table, apply=True)
    written = _written(table)
    assert written['links'] == {
        LIVE: {'pk': 'DOCSHARE_IDS', 'sk': LIVE, 'created_at': '2026-10-01T00:00:00+00:00', 'project_id': 'p1',
               'series_id': SERIES_A},
        REVOKED: {'pk': 'DOCSHARE_IDS', 'sk': REVOKED, 'created_at': '2026-10-02T00:00:00+00:00', 'project_id': 'p1',
                  'series_id': SERIES_B}}
    assert sorted(written['series']) == SERIES_LISTED
    assert written['series'][f'gone#{SERIES_A}'] == {'pk': 'COMMENT_SERIES_IDS', 'sk': f'gone#{SERIES_A}',
                                                     'project_id': 'gone', 'series_id': SERIES_A, 'listed_at': NOW}
    # Every project's META, a deleted one too, never the persona library's container.
    assert written['projects'] == {
        'p1': {'pk': 'PROJECT_IDS', 'sk': 'p1', 'created_at': '2026-09-01'},
        'gone': {'pk': 'PROJECT_IDS', 'sk': 'gone', 'created_at': '2026-08-01'}}
    assert written['marker'] == {'pk': 'DOCSHARE_IDS', 'sk': REVIEW_REGISTRIES_MARKER_SK, 'completed_at': NOW,
                                 'links_found': 2, 'series_found': 3, 'projects_found': 2, 'release': '7.48.0'}
    assert written['progress'] is None
    # A malformed link row and one malformed comment partition (three rows, counted once); the routing row is the
    # workspace's, left uncounted.
    assert (report.malformed, report.marked) == (2, True)


def test_a_second_run_lists_nothing_and_keeps_what_the_stores_wrote(backfill, table):
    _seed(table)
    table.put_item(Item={'pk': 'DOCSHARE_IDS', 'sk': LIVE, 'created_at': 'by the store', 'project_id': 'p1',
                         'series_id': SERIES_A})
    first = _run(backfill, table, apply=True)
    assert (first.listed['links'], first.already_listed['links']) == (1, 1)
    once = _written(table)
    again = backfill.run(table, apply=True, now=lambda: '2026-11-17T00:00:00+00:00', clock=lambda: CLOCK,
                         deployed=_deployed())
    assert (again.listed, again.already_listed) == ({'links': 0, 'series': 0, 'projects': 0},
                                                    {'links': 2, 'series': 3, 'projects': 2})
    twice = _written(table)
    assert (twice['links'], twice['series']) == (once['links'], once['series'])
    assert twice['links'][LIVE]['created_at'] == 'by the store'
    assert twice['marker']['completed_at'] == '2026-11-17T00:00:00+00:00'


@pytest.mark.parametrize('pages', [1, 2, 3])
def test_a_run_stopped_and_resumed_ends_as_one_that_never_stopped(backfill, table, monkeypatch, pages):
    """One-row Scan pages, so the series of four threads runs over many pages' ends and is listed once; progress is
    kept in its own row between runs, each resume under a run id of its own, and the marker sums every run's
    counts."""
    _seed(table)
    monkeypatch.setattr(backfill, 'SCAN_PAGE', 1)
    report = _run(backfill, table, apply=True, max_pages=pages)
    runs, run_ids = 1, set()
    while report.stopped and runs < 300:
        assert _written(table)['marker'] is None
        progress = _written(table)['progress']
        assert progress is not None
        assert progress['applied'] is True
        run_ids.add(progress['run_id'])
        report = _run(backfill, table, apply=True, resume=True, max_pages=pages)
        runs += 1
    assert (report.marked, runs > 3, len(run_ids) == runs - 1) == (True, True, True)
    written = _written(table)
    assert (sorted(written['links']), sorted(written['series']), sorted(written['projects'])) == (
        sorted([LIVE, REVOKED]), SERIES_LISTED, ['gone', 'p1'])
    marker = written['marker']
    assert (marker['links_found'], marker['series_found'], marker['projects_found']) == (2, 3, 2)
    assert written['progress'] is None


def test_a_resume_stops_the_run_it_resumes(backfill, table, monkeypatch):
    """The resume takes the walk over under a new run id, keeping when it began and where it was: the run it resumed,
    if still alive, stops at its next save."""
    _seed(table)
    monkeypatch.setattr(backfill, 'SCAN_PAGE', 1)
    _run(backfill, table, apply=True, max_pages=1)
    before = dict(_written(table)['progress'])
    _run(backfill, table, apply=True, resume=True, max_pages=0)
    after = _written(table)['progress']
    assert after['run_id'] != before['run_id']
    assert {key: after[key] for key in ('started_at', 'pass', 'start', 'links_found')} == {
        key: before[key] for key in ('started_at', 'pass', 'start', 'links_found')}
    with pytest.raises(SystemExit, match='another run'):
        backfill._save(table, {key: before[key] for key in backfill.STATE_FIELDS}, NOW)


def test_a_run_taken_over_by_another_stops(backfill, table, monkeypatch):
    """A second --apply started while the first runs takes the progress row over: the first stops at its next page,
    and never writes the marker."""
    _seed(table)
    monkeypatch.setattr(backfill, 'SCAN_PAGE', 1)
    real, pages = backfill.scan_page, []

    def a_second_run_starts(*args: Any, **kwargs: Any) -> Any:
        pages.append(1)
        if len(pages) == 2:
            progress = _written(table)['progress']
            table.put_item(Item={**progress, 'run_id': 'another-run'})
        return real(*args, **kwargs)

    monkeypatch.setattr(backfill, 'scan_page', a_second_run_starts)
    with pytest.raises(SystemExit, match='another run'):
        _run(backfill, table, apply=True)
    assert (_written(table)['marker'], _written(table)['progress']['run_id']) == (None, 'another-run')


@pytest.mark.parametrize('ready', [True, False])
def test_the_marker_and_the_void_are_refused_once_another_run_took_over(backfill, table, ready):
    """The marker's put and the progress row's delete are one transaction conditioned on the run id (the void's
    delete too): a run taken over between its last page and its end writes nothing and says so."""
    _seed(table)
    answers = iter([_deployed()(), _deployed()() if ready else _deployed(minutes=1)()])
    seen: list[int] = []

    def deployed() -> list[dict[str, Any]]:
        if seen:  # the end's check: another run took the walk over meanwhile
            table.update_item(Key={'pk': 'DOCSHARE_IDS', 'sk': PROGRESS_SK}, UpdateExpression='SET run_id = :r',
                              ExpressionAttributeValues={':r': 'another-run'})
        seen.append(1)
        return next(answers)

    with pytest.raises(SystemExit, match='another run'):
        _run(backfill, table, apply=True, deployed=deployed)
    assert (_written(table)['marker'], _written(table)['progress']['run_id']) == (None, 'another-run')


def test_resume_needs_an_applying_run_and_a_progress_row(backfill, table):
    _seed(table)
    with pytest.raises(SystemExit, match='--resume'):
        _run(backfill, table, apply=False, resume=True)
    with pytest.raises(SystemExit, match='no stopped run'):
        _run(backfill, table, apply=True, resume=True)


def test_a_walk_without_max_pages_stops_at_a_cap(backfill, table, monkeypatch):
    _seed(table)
    monkeypatch.setattr(backfill, 'SCAN_PAGE', 1)
    monkeypatch.setattr(backfill, 'MAX_PAGES', 3)
    # A dry run keeps no progress: it never offers --resume (round 3).
    with pytest.raises(RuntimeError, match='more than 3') as dry:
        _run(backfill, table, apply=False)
    assert ('--resume' not in str(dry.value), '--max-pages' in str(dry.value)) == (True, True)
    with pytest.raises(RuntimeError, match='--apply --resume'):
        _run(backfill, table, apply=True)


@pytest.mark.parametrize('pages', ['0', '-1', 'x'])
def test_max_pages_takes_a_whole_number_of_one_or_more(backfill, pages, capsys):
    with pytest.raises(SystemExit):
        backfill.parse_args(['--max-pages', pages])
    assert 'whole number of 1 or more' in capsys.readouterr().err
    assert backfill.parse_args(['--max-pages', '1']).max_pages == 1


@pytest.mark.parametrize(('deployed', 'reason'), [
    (_deployed(version='7.43.0'), 'older than 7.48.0'),
    (_deployed(minutes=17), 'drained'),  # 15 min of Timeout plus 5: 20
    (list, 'exactly one'),
    (lambda: [_writer('voc-projects-api', version=None), _writer('voc-projects-assist')], 'older than 7.48.0'),
    (lambda: [_writer('voc-projects-api')], 'exactly one'),
    (lambda: [_writer('voc-projects-api'), _writer('voc-projects-api'), _writer('voc-projects-assist')],
     'exactly one'),
    (lambda: [_writer('voc-projects-api', status='InProgress'), _writer('voc-projects-assist')], 'Successful'),
    (lambda: [_writer('voc-projects-api', minutes=25, timeout=1800), _writer('voc-projects-assist')], 'drained'),
])
def test_an_applied_walk_starts_only_once_every_writer_runs_the_new_release(backfill, table, deployed, reason):
    """Measured when the walk begins: exactly one function per writer, each on 7.48.0, its last update applied
    (``LastUpdateStatus`` Successful) and older than the longest writer's Timeout plus 5 minutes (any invocation of an
    older container has ended), else a link could land behind the Scans: no walk that could earn the marker starts."""
    _seed(table)
    report = _run(backfill, table, apply=True, deployed=deployed)
    assert (report.marked, reason in (report.unmarked or '')) == (False, True)
    assert _written(table) == NOTHING
    assert _run(backfill, table, apply=True).marked


def test_a_writer_updated_during_the_walk_voids_it(backfill, table):
    """A walk begun after the drain, during which a writer is updated again (a second deploy): the marker is refused,
    the walk's progress dropped, so a --resume cannot write it; a new walk can, once drained again."""
    _seed(table)
    answers = iter([_deployed(minutes=30)(), _deployed(minutes=2)()])
    report = _run(backfill, table, apply=True, deployed=lambda: next(answers))
    assert (report.marked, 'drained' in (report.unmarked or '')) == (False, True)
    assert (_written(table)['marker'], _written(table)['progress']) == (None, None)
    with pytest.raises(SystemExit, match='no stopped run'):
        _run(backfill, table, apply=True, resume=True)
    later = backfill.run(table, apply=True, now=lambda: NOW, clock=lambda: CLOCK + timedelta(minutes=30),
                         deployed=_deployed(minutes=2))
    assert later.marked


def test_a_walk_resumed_late_still_judges_the_writers_by_when_it_began(backfill, table, monkeypatch):
    """The walk is begun with writers ready, stopped, and resumed after a later deploy: the marker is judged against
    when the walk began, so it is refused."""
    _seed(table)
    monkeypatch.setattr(backfill, 'SCAN_PAGE', 1)
    first = _run(backfill, table, apply=True, max_pages=1)
    assert first.stopped
    resumed = backfill.run(table, apply=True, resume=True, now=lambda: NOW, clock=lambda: CLOCK + timedelta(hours=1),
                           deployed=_deployed(minutes=-1))
    assert (resumed.marked, _written(table)['marker'], _written(table)['progress']) == (False, None, None)


def test_unmark_deletes_the_marker_and_any_progress(backfill, table):
    _seed(table)
    _run(backfill, table, apply=True)
    table.put_item(Item={'pk': 'DOCSHARE_IDS', 'sk': PROGRESS_SK, 'run_id': 'r'})
    backfill.unmark(table)
    written = _written(table)
    assert (written['marker'], written['progress']) == (None, None)
    assert sorted(written['links']) == sorted([LIVE, REVOKED])


def test_unmark_after_the_switch_switches_the_projects_off(backfill, table):
    """7.100.00 (3h-S0): the switch reads the marker too (shared/project_scope.py), so an unmark turns it off and
    leaves the switch row as it was."""
    _run(backfill, table, apply=True)
    row = project_scope.switch_row(NOW, '7.99.0', 0, 1, NOW, 'arn:aws:iam::111122223333:role/Operator')
    table.put_item(Item=dict(row))
    assert project_scope.projects_switched(table) is True
    backfill.unmark(table)
    assert project_scope.projects_switched(table) is False
    assert table.get_item(Key=dict(project_scope.SWITCH_KEY))['Item'] == row
    # A new --apply writes a new marker, which the row does not name: the projects stay off, and the run says so.
    _run(backfill, table, apply=True, now=lambda: '2026-11-17T12:00:00+00:00')
    assert project_scope.projects_switched(table) is False
    assert 'switch_projects.py' in (backfill.switch_note(table) or '')


def test_switch_note_is_silent_without_a_switch_row(backfill, table):
    assert backfill.switch_note(table) is None


def test_the_oldest_release_is_the_lowest_writer_version(backfill):
    writers = [{'version': '7.100.0'}, {'version': '7.99.3'}, {'version': '7.99.12'}]
    assert backfill.oldest_release(writers) == '7.99.3'


def test_the_writers_are_read_from_the_stack_and_their_configuration(backfill):
    class _Stacks:
        def list_stack_resources(self, StackName: str, **_kw: Any) -> dict[str, Any]:
            assert StackName == 'VocApiStack'
            return {'StackResourceSummaries': [
                {'ResourceType': 'AWS::Lambda::Function', 'PhysicalResourceId': 'voc-projects-api-1-r'},
                {'ResourceType': 'AWS::Lambda::Function', 'PhysicalResourceId': 'voc-projects-assist-1-r'},
                {'ResourceType': 'AWS::Lambda::Function', 'PhysicalResourceId': 'voc-settings-api-1-r'},
                {'ResourceType': 'AWS::IAM::Role', 'PhysicalResourceId': 'voc-projects-api-role'}]}

    class _Lambda:
        def get_function_configuration(self, FunctionName: str) -> dict[str, Any]:
            return {'Environment': {'Variables': {'APP_VERSION': '7.48.0'}}, 'Timeout': 30,
                    'LastUpdateStatus': 'Successful', 'LastModified': '2026-11-16T11:00:00.000+0000',
                    'FunctionName': FunctionName}

    found = backfill.link_writers(_Stacks(), _Lambda(), 'VocApiStack')
    at = datetime(2026, 11, 16, 11, 0, tzinfo=UTC)
    assert found == [
        {'name': 'voc-projects-api-1-r', 'base': 'voc-projects-api', 'version': '7.48.0', 'last_modified': at,
         'status': 'Successful', 'timeout': 30},
        {'name': 'voc-projects-assist-1-r', 'base': 'voc-projects-assist', 'version': '7.48.0', 'last_modified': at,
         'status': 'Successful', 'timeout': 30}]


def test_the_summary_says_how_to_go_on(backfill, table):
    _seed(table)
    stopped = _run(backfill, table, apply=True, max_pages=1)
    assert '--resume' in backfill.summary(stopped, True)
    done = _run(backfill, table, apply=True)
    assert 'marker is written' in backfill.summary(done, True)
    assert 'dry run' in backfill.summary(_run(backfill, table, apply=False), False)
    # A dry run keeps no progress: it never offers --resume.
    dry_stopped = _run(backfill, table, apply=False, max_pages=1)
    assert dry_stopped.stopped
    assert '--resume' not in backfill.summary(dry_stopped, False)
    waiting = _run(backfill, table, apply=True, deployed=_deployed(minutes=1))
    assert 'not written' in backfill.summary(waiting, True)
    assert 'run --apply again' in backfill.summary(waiting, True)


def test_a_dry_run_says_whether_the_marker_is_there(backfill, table):
    """7.93.00 (3g-d2): an operator learns from a dry run whether the erasures can run (the marker is there and
    complete) before deciding to apply."""
    _seed(table)
    absent = _run(backfill, table, apply=False)
    assert 'the marker is absent' in backfill.summary(absent, False)
    _run(backfill, table, apply=True)
    present = _run(backfill, table, apply=False)
    assert 'the marker is there and complete' in backfill.summary(present, False)
    table.put_item(Item={'pk': 'DOCSHARE_IDS', 'sk': REVIEW_REGISTRIES_MARKER_SK, 'completed_at': NOW})
    assert 'the marker is there but incomplete' in backfill.summary(_run(backfill, table, apply=False), False)


def test_the_table_comes_from_the_flag_or_the_stack(backfill, monkeypatch):
    monkeypatch.delenv('PROJECTS_TABLE', raising=False)

    class _Stacks:
        def describe_stacks(self, StackName: str) -> dict[str, Any]:
            return {'Stacks': [{'Outputs': [{'OutputKey': 'ProjectsTableName', 'OutputValue': f'{StackName}-t'}]}]}

    assert backfill.table_name(backfill.parse_args(['--projects-table', 'named']), _Stacks()) == 'named'
    assert backfill.table_name(backfill.parse_args(['--stack', 'Core']), _Stacks()) == 'Core-t'


# The Scans themselves (7.93.00, 3g-d2: they moved here from lambda/shared/review_registries.py, when the erasure's
# fallback to them went; these tests came with them from the erasure's).

def test_a_scan_page_is_consistent_and_projects_its_attributes_only(backfill):
    table = MagicMock()
    table.scan.return_value = {'Items': []}
    backfill.scan_page(table, backfill.LINKS, None)
    sent = table.scan.call_args.kwargs
    assert (sent['ConsistentRead'], sent['Select']) == (True, 'SPECIFIC_ATTRIBUTES')
    projected = [sent['ExpressionAttributeNames'][name.strip()] for name in sent['ProjectionExpression'].split(',')]
    assert sorted(projected) == sorted(backfill.SCAN_ATTRIBUTES)


def test_a_routing_row_and_the_link_on_different_pages(backfill, table, monkeypatch):
    link, routed = 'shr_' + '4' * 32, 'shr_' + '5' * 32
    table.put_item(Item={'pk': f'DOCSHARE#{routed}', 'sk': 'META', 'workspace_id': WS, 'routed_at': NOW})
    table.put_item(Item={'pk': f'DOCSHARE#{link}', 'sk': 'META', 'share_id': link, 'project_id': 'p1'})
    monkeypatch.setattr(backfill, 'SCAN_PAGE', 1)
    found, malformed, start, pages = [], 0, None, 0
    while pages < 10:
        pages += 1
        page = backfill.scan_page(table, backfill.LINKS, start)
        found += page.ids
        malformed += page.malformed
        start = page.following
        if start is None:
            break
    assert (found, malformed, pages >= 2) == ([link], 0, True)


def test_a_routing_row_naming_no_workspace_id_is_malformed(backfill, table):
    table.put_item(Item={'pk': 'DOCSHARE#shr_' + '6' * 32, 'sk': 'META', 'workspace_id': 'not-a-workspace'})
    table.put_item(Item={'pk': 'DOCSHARE#shr_' + '8' * 32, 'sk': 'META', 'workspace_id': WS})
    page = backfill.scan_page(table, backfill.LINKS, None)
    assert (page.ids, page.malformed) == ([], 1)


def test_a_malformed_series_is_counted_once_and_never_fails(backfill, table, monkeypatch):
    bad = 'DCOMMENTS#not!a!project#ser_' + 'c' * 24
    for n in range(3):
        table.put_item(Item={'pk': bad, 'sk': f'C#dc_{n}'})
    table.put_item(Item={'pk': 'DCOMMENTS#p1#ser_' + 'd' * 24, 'sk': 'C#dc_9'})
    monkeypatch.setattr(backfill, 'SCAN_PAGE', 1)
    found, malformed, start, after = [], 0, None, None
    for _page in range(50):
        page = backfill.scan_page(table, backfill.SERIES, start, after)
        found += page.ids
        malformed += page.malformed
        start, after = page.following, page.last_pk or after
        if start is None:
            break
    assert (found, malformed) == ([f"p1#ser_{'d' * 24}"], 1)
