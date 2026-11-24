"""shared/trials.py and shared/trial_state.py (7.71.00): a trial's shape, its creation with the workspace, its extension
and its conversion (moto-backed). Nothing here deletes anything: every row stays."""
from collections.abc import Iterator
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from unittest.mock import MagicMock

import pytest
from moto import mock_aws

from shared.exceptions import ConflictError, NotFoundError, ValidationError
from shared.platform_workspaces import LISTING_PK, NewWorkspace, create_workspace, listing_sort_key
from shared.test.moto_tables import create_pk_sk_table
from shared.trial_state import (
    DEFAULT_TRIAL_DAYS,
    NewTrial,
    is_paused,
    new_trial,
    parse_extension,
    parse_trial,
    trial_summary,
)
from shared.trials import (
    MAX_EXTENSIONS,
    TRIAL_CHANGED,
    TRIAL_NOT_FOUND,
    convert_trial,
    extend_trial,
    read_meta,
    save_trial,
    trial_view,
)

WS = 'ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D8'
OTHER = 'ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D9'
PAT = 'sub-pat'
START = datetime(2026, 11, 21, 9, 0, 0, 123456, tzinfo=UTC)
PACK = {'forms': ['workshop', 'micro_feedback'], 'categories': True, 'playbooks': True}


@pytest.fixture
def table() -> Iterator:
    with mock_aws():
        yield create_pk_sk_table('workspaces')


def _create(table, *, days=30, ws=WS, name='Acme Trial', slug='acme-trial'):
    trial = new_trial(NewTrial(days=days, pack=PACK), PAT, START)
    create_workspace(table, NewWorkspace(name=name, slug=slug, trial=NewTrial(days, PACK)), PAT, ws=ws, trial=trial)
    return trial


def _all_rows(table):
    return sorted((row['pk'], row['sk']) for row in table.scan()['Items'])


def _listing_trial(table, name='Acme Trial', ws=WS):
    return table.get_item(Key={'pk': LISTING_PK, 'sk': listing_sort_key(name, ws)})['Item']['trial']


def _audits(table, ws=WS):
    return list(table.query(KeyConditionExpression='pk = :pk',
                                       ExpressionAttributeValues={':pk': f'AUDIT#WS#{ws}'})['Items'])


def _no_resume(*_args):
    raise AssertionError('a trial that is not paused has nothing to resume')


# ── the create's trial ───────────────────────────────────────────────────────

def test_no_trial_is_none_and_an_empty_one_runs_30_days_with_no_pack():
    assert parse_trial(None) is None
    assert parse_trial({}) == NewTrial(days=DEFAULT_TRIAL_DAYS, pack={'forms': [], 'categories': False,
                                                                      'playbooks': False})
    assert DEFAULT_TRIAL_DAYS == 30


@pytest.mark.parametrize('days', [14, 30, 60])
def test_a_trial_runs_14_30_or_60_days(days):
    assert parse_trial({'days': days, 'pack': PACK}) == NewTrial(days=days, pack=PACK)


@pytest.mark.parametrize('trial', [
    [], 'yes', {'days': 7}, {'days': '30'}, {'days': True}, {'days': 30.0}, {'expires_at': '2027-01-01'},
    {'pack': []}, {'pack': {'forms': 'workshop'}}, {'pack': {'forms': ['Not An Id']}},
    {'pack': {'forms': ['workshop', 'workshop']}}, {'pack': {'forms': [f'form-{n}' for n in range(11)]}},
    {'pack': {'categories': 'yes'}}, {'pack': {'members': ['a@example.com']}},
], ids=repr)
def test_anything_else_is_a_400(trial):
    with pytest.raises(ValidationError):
        parse_trial(trial)


def test_an_extension_names_its_days():
    assert parse_extension({'days': 14}) == 14
    for body in ({}, {'days': 45}, {'days': 30, 'until': 'never'}):
        with pytest.raises(ValidationError):
            parse_extension(body)


def test_a_new_trial_ends_its_days_later_to_the_second():
    trial = new_trial(NewTrial(days=14, pack=PACK), PAT, START)
    assert trial == {'rev': 1, 'days': 14, 'created_at': '2026-11-21T09:00:00+00:00', 'created_by': PAT,
                     'expires_at': '2026-12-05T09:00:00+00:00', 'pack': PACK, 'extended': []}


def test_the_create_writes_the_same_trial_on_meta_and_the_listing_row_and_audits_it(table):
    trial = _create(table)
    assert read_meta(table, WS)['trial'] == trial
    assert _listing_trial(table) == trial
    [created] = [row for row in _audits(table) if row['kind'] == 'trial_created']
    assert {key: created[key] for key in ('actor', 'days', 'expires_at', 'pack')} == {
        'actor': PAT, 'days': Decimal(30), 'expires_at': trial['expires_at'], 'pack': PACK}


def test_a_workspace_with_no_trial_carries_none(table):
    create_workspace(table, NewWorkspace(name='Plain', slug='plain'), PAT, ws=OTHER)
    assert 'trial' not in read_meta(table, OTHER)
    assert [row['kind'] for row in _audits(table, OTHER)] == ['workspace_created']


# ── the views ────────────────────────────────────────────────────────────────

def _present(view):
    assert view is not None
    return view


def test_the_views_read_dynamodbs_numbers_and_say_what_the_pause_turned_off(table):
    _create(table)
    stored = read_meta(table, WS)['trial']
    assert _present(trial_view(stored))['days'] == 30
    assert isinstance(_present(trial_view(stored))['days'], int)
    assert trial_summary(stored) == {'days': 30, 'expires_at': stored['expires_at'], 'paused_at': None,
                                     'converted_at': None, 'paused': None, 'resume_incomplete': False}
    paused = {**stored, 'paused_at': '2026-12-21T09:00:00+00:00', 'paused': {'plugins': ['webscraper'], 'forms': ['f1', 'f2']}}
    assert _present(trial_summary(paused))['paused'] == {'plugins': 1, 'forms': 2}
    assert _present(trial_view(paused))['paused'] == {'plugins': ['webscraper'], 'forms': ['f1', 'f2']}
    assert 'rev' not in _present(trial_view(paused))
    assert 'created_by' not in _present(trial_summary(paused))
    # A resume cut short (its mark left): the console says so from the listing (summary). A route's view never carries
    # the mark (F4, 7.71.03: it is answered once the route's own write removed it).
    marked = {**paused, 'resuming_at': '2026-12-22T09:00:00+00:00'}
    assert (_present(trial_summary(marked))['resume_incomplete'], _present(trial_summary(paused))['resume_incomplete'],
            {'resume_incomplete', 'resuming_at'} & set(_present(trial_view(marked)))) == (True, False, set())
    # A recorded list that is not one reads as none (7.71.02, F2: the pause and the resume read only these lists).
    assert _present(trial_summary({**paused, 'paused': {'plugins': 7, 'forms': ['f1', 3]}}))['paused'] == {
        'plugins': 0, 'forms': 1}
    assert trial_view(None) is None
    assert trial_summary('not a map') is None
    # A converted trial is never paused, whatever it once recorded.
    assert not is_paused({**paused, 'converted_at': '2026-12-22T09:00:00+00:00'})


# ── extend ───────────────────────────────────────────────────────────────────

def test_an_extension_counts_from_the_end_and_audits_first(table):
    trial = _create(table)
    now = START + timedelta(days=10)
    before = _all_rows(table)
    view = extend_trial(table, WS, 14, PAT, resume=_no_resume, now=now)
    assert view['expires_at'] == '2027-01-04T09:00:00+00:00'  # 30 + 14 days from the start
    [entry] = view['extended']
    assert {key: entry[key] for key in ('by', 'days', 'expires_at')} == {
        'by': PAT, 'days': 14, 'expires_at': '2027-01-04T09:00:00+00:00'}
    assert read_meta(table, WS)['trial']['rev'] == trial['rev'] + 1
    assert _listing_trial(table) == read_meta(table, WS)['trial']
    [audit] = [row for row in _audits(table) if row['kind'] == 'trial_extended']
    assert (audit['actor'], audit['days'], audit['was_paused'], audit['platform_admin']) == (PAT, 14, False, True)
    # One audit row more, nothing removed.
    assert set(before) < set(_all_rows(table))
    assert len(_all_rows(table)) == len(before) + 1


def test_an_ended_trial_is_extended_from_now(table):
    _create(table, days=14)
    now = START + timedelta(days=40)
    view = extend_trial(table, WS, 30, PAT, resume=_no_resume, now=now)
    assert view['expires_at'] == (now + timedelta(days=30)).replace(microsecond=0).isoformat()


def test_extending_a_paused_trial_turns_back_on_what_it_paused_and_clears_the_pause(table):
    _create(table)
    meta = read_meta(table, WS)
    paused = {**meta['trial'], 'paused_at': '2026-12-21T09:00:00+00:00',
              'paused': {'plugins': ['webscraper'], 'forms': ['f1']}}
    save_trial(table, WS, meta, paused)
    resume = MagicMock(return_value={'plugins': 1, 'forms': 1})
    view = extend_trial(table, WS, 30, PAT, resume=resume, now=START + timedelta(days=31))
    trial_arg = resume.call_args.args[1]
    assert resume.call_args.args[::2] == (WS, PAT)
    assert trial_arg['paused'] == paused['paused']
    # Q26 (7.71.01): marked resuming (stored) before the resume, so the hourly pause leaves it alone meanwhile; the
    # mark is the request's own time (7.71.02: the pause judges it fresh or stale by it).
    assert trial_arg['resuming_at'] == (START + timedelta(days=31)).replace(microsecond=0).isoformat()
    assert resume.call_args.args[3] == 'trial_extended'
    assert (view['paused_at'], view['paused']) == (None, None)
    assert view['extended'][-1]['resumed'] == view['resumed'] == {'plugins': 1, 'forms': 1}
    stored = read_meta(table, WS)['trial']
    assert not is_paused(stored)
    assert 'resuming_at' not in stored


def test_a_converted_trial_or_one_extended_too_often_is_not_extended(table):
    trial = _create(table)
    meta = read_meta(table, WS)
    entries = [{'at': 'x', 'by': PAT, 'days': 14, 'expires_at': trial['expires_at']}] * MAX_EXTENSIONS
    save_trial(table, WS, meta, {**meta['trial'], 'extended': entries})
    with pytest.raises(ConflictError) as raised:
        extend_trial(table, WS, 14, PAT, resume=_no_resume, now=START)
    assert raised.value.code == 'trial_extensions'
    convert_trial(table, WS, PAT, resume=_no_resume, now=START)
    with pytest.raises(ConflictError) as raised:
        extend_trial(table, WS, 14, PAT, resume=_no_resume, now=START)
    assert raised.value.code == 'trial_converted'


@pytest.mark.parametrize('ws', ['ws_bogus', OTHER, 7], ids=['malformed', 'unknown-or-no-trial', 'not-text'])
def test_a_workspace_that_is_no_trial_answers_one_404(table, ws):
    create_workspace(table, NewWorkspace(name='Plain', slug='plain'), PAT, ws=OTHER)
    with pytest.raises(NotFoundError, match=TRIAL_NOT_FOUND):
        extend_trial(table, ws, 14, PAT, resume=_no_resume, now=START)
    with pytest.raises(NotFoundError, match=TRIAL_NOT_FOUND):
        convert_trial(table, ws, PAT, resume=_no_resume, now=START)


def test_a_deleting_trial_is_not_found(table):
    _create(table)
    table.update_item(Key={'pk': f'WS#{WS}', 'sk': 'META'}, UpdateExpression='SET #s = :d',
                      ExpressionAttributeNames={'#s': 'status'}, ExpressionAttributeValues={':d': 'deleting'})
    with pytest.raises(NotFoundError):
        convert_trial(table, WS, PAT, resume=_no_resume, now=START)


# ── convert ──────────────────────────────────────────────────────────────────

def test_a_conversion_is_audited_first_and_ends_the_trial_for_good(table):
    _create(table)
    before = _all_rows(table)
    view = convert_trial(table, WS, PAT, resume=_no_resume, now=START)
    assert view['converted_by'] == PAT
    assert view['converted_at'] is not None
    assert [row['kind'] for row in _audits(table) if row['kind'] == 'trial_converted'] == ['trial_converted']
    assert _listing_trial(table)['converted_at'] == view['converted_at']
    # Converting again writes nothing (no second audit row) and answers the same.
    assert convert_trial(table, WS, PAT, resume=_no_resume, now=START) == view
    assert len(_all_rows(table)) == len(before) + 1
    assert set(before) < set(_all_rows(table))


def test_converting_a_paused_trial_resumes_it(table):
    _create(table)
    meta = read_meta(table, WS)
    save_trial(table, WS, meta, {**meta['trial'], 'paused_at': 'x', 'paused': {'plugins': [], 'forms': ['f1']}})
    resume = MagicMock(return_value={'plugins': 0, 'forms': 1})
    view = convert_trial(table, WS, PAT, resume=resume, now=START)
    assert resume.call_args.args[3] == 'trial_converted'
    assert 'resuming_at' in resume.call_args.args[1]
    assert view['paused'] is None
    # Q27 (7.71.01): the conversion's answer says what it resumed.
    assert read_meta(table, WS)['trial']['resumed'] == view['resumed'] == {'plugins': 0, 'forms': 1}
    assert 'resuming_at' not in read_meta(table, WS)['trial']


# ── save_trial ───────────────────────────────────────────────────────────────

def test_a_trial_changed_meanwhile_is_a_409_and_writes_nothing(table):
    _create(table)
    stale = read_meta(table, WS)
    save_trial(table, WS, stale, {**stale['trial'], 'days': 60})
    with pytest.raises(ConflictError, match=TRIAL_CHANGED):
        save_trial(table, WS, stale, {**stale['trial'], 'days': 14})
    assert read_meta(table, WS)['trial']['days'] == 60


def test_a_listing_row_that_moved_meanwhile_is_a_409(table):
    _create(table)
    meta = read_meta(table, WS)
    # A rename moved the listing row to its new sort key between the read and the write.
    with pytest.raises(ConflictError):
        save_trial(table, WS, {**meta, 'name': 'Renamed meanwhile'}, {**meta['trial'], 'days': 60})
    assert read_meta(table, WS)['trial']['days'] == 30
