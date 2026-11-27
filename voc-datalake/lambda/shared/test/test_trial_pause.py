"""shared/trial_pause.py (7.71.00): a trial's pause at its end (the plugins' existing audited disable, the live forms
turned off, all recorded) and its resume, which the hourly pause never undoes (7.71.01) while its mark is fresh, and
which a stale mark no longer holds off (7.71.02), nor a mark committed during its turn-offs, each of which checks the
trial in its own transaction (7.71.04); a paused trial refuses a plugin's enable; and NOTHING is deleted but the
plugins' own enable rows, which are the existing disable (moto-backed, every DynamoDB call recorded)."""
from collections.abc import Iterator
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from functools import partial
from typing import Any
from unittest.mock import patch

import boto3
import pytest
from moto import mock_aws

from shared import trial_pause, workspace_plugin_settings
from shared.exceptions import ConflictError
from shared.ingest_tables import ingest_table
from shared.platform_workspaces import NewWorkspace, create_workspace
from shared.prototype_pins import FORM_TYPE_PROTOTYPE_PIN
from shared.prototype_validation import FORMS_PARTITION, OPEN_FIELD
from shared.test.moto_tables import create_pk_sk_table
from shared.trial_pause import (
    ALREADY_PAUSED,
    CONVERTED,
    EXPIRY_ACTOR,
    NO_EXPIRY,
    NOT_A_TRIAL,
    NOT_ACTIVE,
    NOT_DUE,
    PAUSED_NOW,
    PauseTables,
    due_trials,
    pause,
    resume,
)
from shared.trial_state import TRIAL_PAUSED_CODE, NewTrial, new_trial, trial_summary
from shared.trials import convert_trial, extend_trial, read_meta, save_trial
from shared.workspace import WorkspaceContext
from shared.workspace_plugin_settings import set_plugin_enabled, workspace_plugins

WS = 'ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D8'
PAT = 'sub-pat'
START = datetime(2026, 11, 21, 9, 0, tzinfo=UTC)
AFTER_END = START + timedelta(days=31)
CEILING = ('webscraper', 'app_reviews_ios', 'github_issues', 's3_import')
FORMS = f'WS#{WS}#FEEDBACK_FORM'


@dataclass
class World:
    workspaces: Any
    aggregates: Any
    tables: PauseTables
    calls: list[tuple[str, dict]]


def _record(calls):
    def handler(params, model, **_kwargs):
        calls.append((model.name, params))
    return handler


@pytest.fixture
def world() -> Iterator[World]:
    with mock_aws():
        resource = boto3.resource('dynamodb', region_name='us-east-1')
        workspaces = create_pk_sk_table('workspaces', resource)
        aggregates = create_pk_sk_table('aggregates', resource)
        trial = new_trial(NewTrial(days=30, pack={'forms': [], 'categories': False, 'playbooks': False}), PAT, START)
        create_workspace(workspaces, NewWorkspace(name='Acme Trial', slug='acme-trial'), PAT,
                         ['webscraper', 'app_reviews_ios'], ws=WS, trial=trial)
        for item in (
            {'pk': FORMS, 'sk': 'FORM#live', 'enabled': True, 'write_count': 4, 'name': 'Workshop feedback'},
            {'pk': FORMS, 'sk': 'FORM#legacy', 'enabled': True, 'name': 'Saved before 7.58 (no counter)'},
            {'pk': FORMS, 'sk': 'FORM#off', 'enabled': False, 'write_count': 1},
            {'pk': FORMS, 'sk': 'FORM#imported', 'enabled': False, 'imported': {'source': 'csv'}},
            {'pk': FORMS, 'sk': 'FORMREV#live#1', 'enabled': True},
            {'pk': FORMS, 'sk': 'FORMFUNNEL#live#2026-11-21', 'opened': 3},
            {'pk': f'WS#{WS}#SOURCE#feedback_form', 'sk': 'item-1', 'text': 'A response: it must stay'},
            {'pk': f'WS#{WS}#FEEDBACK_FORM_TEST', 'sk': 'live#t1', 'answers': {}},
        ):
            aggregates.put_item(Item=item)
        calls: list[tuple[str, dict]] = []
        resource.meta.client.meta.events.register('provide-client-params.dynamodb', _record(calls))
        tables = PauseTables(workspaces=workspaces, forms=lambda scope: ingest_table(scope, resource, 'aggregates'),
                             ceiling=CEILING)
        yield World(workspaces, aggregates, tables, calls)


def _keys(table):
    return sorted((row['pk'], row['sk']) for row in table.scan()['Items'])


def _form(world, form_id):
    return world.aggregates.get_item(Key={'pk': FORMS, 'sk': f'FORM#{form_id}'})['Item']


def _enabled(world):
    return [entry['id'] for entry in workspace_plugins(world.workspaces, WS, CEILING) if entry['enabled']]


def _audit_kinds(world):
    rows = world.workspaces.query(KeyConditionExpression='pk = :pk', ExpressionAttributeValues={':pk': f'AUDIT#WS#{WS}'})
    return [(row['kind'], row.get('plugin'), row.get('reason')) for row in rows['Items']]


def test_before_its_end_nothing_is_paused(world):
    before = (_keys(world.workspaces), _keys(world.aggregates))
    assert pause(world.tables, WS, START + timedelta(days=29)) == {'outcome': NOT_DUE}
    assert (_keys(world.workspaces), _keys(world.aggregates)) == before


def test_at_its_end_the_plugins_and_live_forms_are_turned_off_and_recorded(world):
    assert pause(world.tables, WS, AFTER_END) == {'outcome': PAUSED_NOW, 'plugins': 2, 'forms': 2}
    trial = read_meta(world.workspaces, WS)['trial']
    assert trial['paused_at'] == AFTER_END.isoformat()
    assert trial['paused'] == {'plugins': ['webscraper', 'app_reviews_ios'], 'forms': ['legacy', 'live']}
    assert _enabled(world) == []
    live, legacy = _form(world, 'live'), _form(world, 'legacy')
    assert (live['enabled'], live['write_count'], live['updated_by']) == (False, 5, EXPIRY_ACTOR)
    # A form saved before the save counter existed gets one, so an editor's stale copy cannot turn it on again.
    assert (legacy['enabled'], legacy['write_count']) == (False, 1)
    # The forms that were off, imported included, are not touched.
    assert 'updated_by' not in _form(world, 'off')
    assert 'updated_by' not in _form(world, 'imported')
    kinds = _audit_kinds(world)
    assert ('trial_paused', None, None) in kinds
    assert {('plugin_disabled', plugin, 'trial_paused') for plugin in ('webscraper', 'app_reviews_ios')} <= set(kinds)


def test_nothing_is_deleted_but_the_plugins_own_enable_rows(world):
    """The pin of 7.71.00: the expiry deletes no workspace, form, response, feedback item or audit row. The only delete
    it sends is the existing plugin disable's, of a ``PLUGIN#{plugin}`` / ``WS#{ws}`` row."""
    workspaces, aggregates = _keys(world.workspaces), _keys(world.aggregates)
    world.calls.clear()
    pause(world.tables, WS, AFTER_END)
    calls = list(world.calls)
    assert _keys(world.aggregates) == aggregates
    gone = set(workspaces) - set(_keys(world.workspaces))
    assert gone == {('PLUGIN#webscraper', f'WS#{WS}'), ('PLUGIN#app_reviews_ios', f'WS#{WS}')}
    operations = {name for name, _params in calls}
    assert operations <= {'GetItem', 'Query', 'PutItem', 'UpdateItem', 'TransactWriteItems'}
    deletes = [entry['Delete']['Key'] for name, params in calls if name == 'TransactWriteItems'
               for entry in params['TransactItems'] if 'Delete' in entry]
    assert deletes
    assert all(key['pk'].startswith('PLUGIN#') and key['sk'] == f'WS#{WS}' for key in deletes)


def test_a_second_run_changes_nothing(world):
    pause(world.tables, WS, AFTER_END)
    after = (_keys(world.workspaces), _keys(world.aggregates), read_meta(world.workspaces, WS)['trial'])
    assert pause(world.tables, WS, AFTER_END + timedelta(minutes=5)) == {'outcome': ALREADY_PAUSED}
    # No audit row, no plugin row, form or trial change.
    assert (_keys(world.workspaces), _keys(world.aggregates), read_meta(world.workspaces, WS)['trial']) == after


def test_a_retry_after_a_partial_pause_still_records_everything_it_turned_off(world):
    with patch.object(trial_pause, 'set_form_live', side_effect=RuntimeError('throttled')), \
            pytest.raises(RuntimeError):
        pause(world.tables, WS, AFTER_END)
    # The plugins went off before the failure; the retry finds them off already, and still records them.
    assert pause(world.tables, WS, AFTER_END)['outcome'] == PAUSED_NOW
    trial = read_meta(world.workspaces, WS)['trial']
    assert trial['paused'] == {'plugins': ['webscraper', 'app_reviews_ios'], 'forms': ['legacy', 'live']}
    assert _form(world, 'live')['enabled'] is False


def test_a_converted_trial_a_deleting_workspace_and_a_workspace_with_no_trial_are_left_alone(world):
    meta = read_meta(world.workspaces, WS)
    save_trial(world.workspaces, WS, meta, {**meta['trial'], 'converted_at': START.isoformat()})
    assert pause(world.tables, WS, AFTER_END) == {'outcome': CONVERTED}
    world.workspaces.update_item(Key={'pk': f'WS#{WS}', 'sk': 'META'}, UpdateExpression='SET #s = :d',
                                 ExpressionAttributeNames={'#s': 'status'}, ExpressionAttributeValues={':d': 'deleting'})
    assert pause(world.tables, WS, AFTER_END) == {'outcome': NOT_ACTIVE}
    other = 'ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D9'
    create_workspace(world.workspaces, NewWorkspace(name='Plain', slug='plain'), PAT, ['webscraper'], ws=other)
    assert pause(world.tables, other, AFTER_END) == {'outcome': NOT_A_TRIAL}
    assert _enabled(world) == ['webscraper', 'app_reviews_ios']


def _admin(platform_admin=False):
    return WorkspaceContext(ws=WS, role='admin', name='Acme Trial', slug='acme-trial', platform_admin=platform_admin)


def test_a_paused_trial_refuses_a_plugins_enable_and_still_takes_a_disable(world):
    pause(world.tables, WS, AFTER_END)
    with pytest.raises(ConflictError) as raised:
        set_plugin_enabled(world.workspaces, _admin(), 'webscraper', True, PAT)
    assert raised.value.code == TRIAL_PAUSED_CODE
    with pytest.raises(ConflictError):
        set_plugin_enabled(world.workspaces, _admin(platform_admin=True), 'github_issues', True, 'sub-platform')
    assert _enabled(world) == []


def test_a_pause_landing_between_the_enables_read_and_its_commit_still_wins(world):
    """The enable's transaction checks that ``trial.paused_at`` is absent: a pause that lands after its read is not
    undone by it."""
    meta = read_meta(world.workspaces, WS)
    save_trial(world.workspaces, WS, meta, {**meta['trial'], 'paused_at': AFTER_END.isoformat()})
    reads = iter([None, {'paused_at': AFTER_END.isoformat()}])
    with patch('shared.workspace_plugin_settings.stored_trial', side_effect=lambda *_: next(reads)), \
            pytest.raises(ConflictError) as raised:
        set_plugin_enabled(world.workspaces, _admin(), 'github_issues', True, PAT)
    assert raised.value.code == TRIAL_PAUSED_CODE
    assert 'github_issues' not in _enabled(world)


def test_the_resume_turns_back_on_exactly_what_the_pause_turned_off(world):
    pause(world.tables, WS, AFTER_END)
    # Meanwhile a form was deleted by its owner: it stays deleted.
    world.aggregates.delete_item(Key={'pk': FORMS, 'sk': 'FORM#legacy'})
    trial = read_meta(world.workspaces, WS)['trial']
    assert resume(world.tables, WS, trial, 'sub-platform', 'trial_extended') == {'plugins': 2, 'forms': 1,
                                                                                 'skipped': []}
    assert _enabled(world) == ['webscraper', 'app_reviews_ios']
    assert (_form(world, 'live')['enabled'], _form(world, 'live')['updated_by']) == (True, 'sub-platform')
    assert _form(world, 'off')['enabled'] is False
    assert 'Item' not in world.aggregates.get_item(Key={'pk': FORMS, 'sk': 'FORM#legacy'})
    assert ('plugin_enabled', 'webscraper', 'trial_extended') in _audit_kinds(world)


def test_the_resume_skips_a_plugin_the_deployment_no_longer_offers(world):
    pause(world.tables, WS, AFTER_END)
    trial = read_meta(world.workspaces, WS)['trial']
    narrower = PauseTables(world.workspaces, world.tables.forms, ('webscraper',))
    assert resume(narrower, WS, trial, 'sub-platform', 'trial_converted')['plugins'] == 1
    assert _enabled(world) == ['webscraper']


def test_a_prototypes_pin_form_and_its_validation_card_are_left_working(world):
    """Pins and 7.68.00's "Tell us how it went" card are prototype review on a project, not a live public form of the
    workspace, and projects are still the deployment's (docs/multi-workspace.md, "Trial workspaces"): a pin form is in
    the deployment's forms partition, never a workspace's, so a pause neither turns it or its card off nor records it,
    and a resume never touches it."""
    pin = {'pk': FORMS_PARTITION, 'sk': 'FORM#pf_proto1', 'form_type': FORM_TYPE_PROTOTYPE_PIN, 'enabled': True,
           OPEN_FIELD: True, 'write_count': 2}
    world.aggregates.put_item(Item=pin)
    assert pause(world.tables, WS, AFTER_END)['outcome'] == PAUSED_NOW
    trial = read_meta(world.workspaces, WS)['trial']
    assert trial['paused']['forms'] == ['legacy', 'live']
    resume(world.tables, WS, trial, 'sub-platform', 'trial_extended')
    assert world.aggregates.get_item(Key={'pk': FORMS_PARTITION, 'sk': 'FORM#pf_proto1'})['Item'] == pin


def _set_trial(world, **fields):
    meta = read_meta(world.workspaces, WS)
    return save_trial(world.workspaces, WS, meta, {**meta['trial'], **fields})


def test_a_trial_with_no_readable_end_is_never_paused(world):
    """Review round 1: an ``expires_at`` that does not parse pauses nothing (logged); the hourly tick skips it too."""
    _set_trial(world, expires_at='the end of the workshop')
    before = (_keys(world.workspaces), _keys(world.aggregates))
    with patch.object(trial_pause.logger, 'warning') as warned:
        assert pause(world.tables, WS, AFTER_END) == {'outcome': NO_EXPIRY}
        assert due_trials(world.workspaces, AFTER_END) == []
    assert warned.call_count == 2
    assert (_keys(world.workspaces), _keys(world.aggregates)) == before


def test_the_hourly_tick_lists_a_trial_once_its_end_passed_and_for_a_day_after_its_pause(world):
    assert due_trials(world.workspaces, START + timedelta(days=29)) == []
    assert due_trials(world.workspaces, AFTER_END) == [WS]
    pause(world.tables, WS, AFTER_END)
    # Paused: visited again for a day (a pause cut short is finished), then left alone.
    assert due_trials(world.workspaces, AFTER_END + timedelta(hours=23)) == [WS]
    assert due_trials(world.workspaces, AFTER_END + timedelta(days=2)) == []
    _set_trial(world, converted_at=START.isoformat())
    assert due_trials(world.workspaces, AFTER_END) == []


def test_the_resume_leaves_off_a_form_no_longer_publishable_and_says_so(world):
    pause(world.tables, WS, AFTER_END)
    # Edited while paused: its text now under 3:1 on white.
    world.aggregates.update_item(Key={'pk': FORMS, 'sk': 'FORM#live'}, UpdateExpression='SET theme = :t',
                                 ExpressionAttributeValues={':t': {'text_color': '#9ca3af'}})
    trial = read_meta(world.workspaces, WS)['trial']
    answer = resume(world.tables, WS, trial, 'sub-platform', 'trial_extended')
    assert answer == {'plugins': 2, 'forms': 1, 'skipped': [
        {'form_id': 'live', 'name': 'Workshop feedback', 'code': 'theme_unreadable'}]}
    assert (_form(world, 'live')['enabled'], _form(world, 'legacy')['enabled']) == (False, True)


@pytest.mark.parametrize('route', ['extend', 'convert'])
def test_an_hourly_pause_landing_inside_the_resume_leaves_the_trial_resumed(world, route):
    """Q26 (7.71.01): the hourly tick can run between an extension's (or a conversion's) resume and its own write of
    the map. The trial is marked ``resuming_at`` before the resume, so that pause is not due and turns nothing off."""
    pause(world.tables, WS, AFTER_END)
    later = AFTER_END + timedelta(hours=1)
    ticks = []

    def resume_then_tick(ws, trial, actor, reason):
        done = resume(world.tables, ws, trial, actor, reason)
        ticks.append(pause(world.tables, ws, later))
        return done

    if route == 'extend':
        view = extend_trial(world.workspaces, WS, 30, 'sub-platform', resume=resume_then_tick, now=later)
    else:
        view = convert_trial(world.workspaces, WS, 'sub-platform', resume=resume_then_tick, now=later)
    assert ticks == [{'outcome': NOT_DUE}]
    assert _enabled(world) == ['webscraper', 'app_reviews_ios']
    assert (_form(world, 'live')['enabled'], _form(world, 'legacy')['enabled']) == (True, True)
    assert (view['paused_at'], view['resumed']['forms']) == (None, 2)
    assert 'resuming_at' not in read_meta(world.workspaces, WS)['trial']


def test_a_resume_cut_short_is_left_alone_by_the_tick_and_finished_by_the_same_extension(world):
    """Q26: a resume that fails half way leaves the trial marked and still paused; the hourly tick leaves what it
    turned on, and the same extension again finishes it."""
    pause(world.tables, WS, AFTER_END)
    later = AFTER_END + timedelta(hours=1)
    _resume_cut_short(world, later)
    stored = read_meta(world.workspaces, WS)['trial']
    assert (stored['paused_at'], stored['resuming_at'] is not None) == (AFTER_END.isoformat(), True)
    assert pause(world.tables, WS, later) == {'outcome': NOT_DUE}
    assert _enabled(world) == ['webscraper', 'app_reviews_ios']
    retry = partial(resume, world.tables)
    view = extend_trial(world.workspaces, WS, 30, 'sub-platform', resume=retry, now=later)
    # Counted from the same stored end (passed: from now), once.
    assert (view['paused_at'], view['expires_at'], len(view['extended'])) == (
        None, (later + timedelta(days=30)).isoformat(), 1)
    assert (_form(world, 'live')['enabled'], _form(world, 'legacy')['enabled']) == (True, True)
    assert 'resuming_at' not in read_meta(world.workspaces, WS)['trial']


def _resume_incomplete(trial) -> bool:
    """What the platform console reads of the trial's mark (its listing, shared/trial_state.py ``trial_summary``)."""
    summary = trial_summary(trial)
    assert summary is not None
    return summary['resume_incomplete']


def _resume_cut_short(world, when):
    """An extension at ``when`` whose resume turned the plugins back on and failed at the forms: the trial is left
    marked ``resuming_at`` and still paused."""
    def plugins_then_fail(ws, trial, actor, reason):
        with patch.object(trial_pause, 'set_form_live', side_effect=RuntimeError('throttled')):
            return resume(world.tables, ws, trial, actor, reason)

    with pytest.raises(RuntimeError):
        extend_trial(world.workspaces, WS, 30, 'sub-platform', resume=plugins_then_fail, now=when)


def test_a_fresh_resuming_mark_holds_the_pause_off_and_a_stale_one_no_longer_does(world):
    """C1/Q2 (7.71.02): a mark a failed resume left holds the pause off for 15 minutes, and the console says the resume
    is unfinished; then the trial is due again (even a day after its pause), its pause turns off what that resume
    turned on and removes the mark, and the tick passes it by from then on."""
    pause(world.tables, WS, AFTER_END)
    marked_at = AFTER_END + timedelta(days=3)
    _resume_cut_short(world, marked_at)
    assert _resume_incomplete(read_meta(world.workspaces, WS)['trial']) is True
    fresh = marked_at + timedelta(minutes=14)
    assert due_trials(world.workspaces, fresh) == []
    assert pause(world.tables, WS, fresh) == {'outcome': NOT_DUE}
    assert _enabled(world) == ['webscraper', 'app_reviews_ios']
    stale = marked_at + timedelta(minutes=16)
    assert due_trials(world.workspaces, stale) == [WS]
    assert pause(world.tables, WS, stale) == {'outcome': PAUSED_NOW, 'plugins': 2, 'forms': 0}
    stored = read_meta(world.workspaces, WS)['trial']
    assert ('resuming_at' in stored, stored['paused_at'], _resume_incomplete(stored)) == (
        False, AFTER_END.isoformat(), False)
    assert stored['paused'] == {'plugins': ['webscraper', 'app_reviews_ios'], 'forms': ['legacy', 'live']}
    assert _enabled(world) == []
    assert due_trials(world.workspaces, stale + timedelta(hours=1)) == []


def test_a_mark_committed_after_the_revisits_read_fails_its_pause_before_anything_is_turned_off(world):
    """Q1 (7.71.02): the hourly revisit read the paused trial, then an extension marked and resumed it before the
    revisit read what is on. The revisit's write of the lists, conditional on the rev it read, fails (409, counted
    failed by the tick) before its audit row and its turn-offs, so nothing the extension turned on goes off."""
    pause(world.tables, WS, AFTER_END)
    before_the_mark = read_meta(world.workspaces, WS)
    later = AFTER_END + timedelta(hours=1)
    enabled_plugins = trial_pause._enabled_plugins

    def resumed_first(tables, ws):
        extend_trial(world.workspaces, WS, 30, 'sub-platform', resume=partial(resume, world.tables), now=later)
        return enabled_plugins(tables, ws)

    with patch.object(trial_pause, 'read_meta', return_value=before_the_mark), \
            patch.object(trial_pause, '_enabled_plugins', side_effect=resumed_first), \
            pytest.raises(ConflictError) as raised:
        pause(world.tables, WS, later)
    assert raised.value.code == 'trial_changed'
    assert _enabled(world) == ['webscraper', 'app_reviews_ios']
    assert (_form(world, 'live')['enabled'], _form(world, 'legacy')['enabled']) == (True, True)
    assert [kind for kind, _plugin, _reason in _audit_kinds(world)].count('trial_paused') == 1


@pytest.mark.parametrize(('turn_offs', 'resumed'), [(1, 1), (2, 2)], ids=['a-plugin-next', 'a-form-next'])
def test_a_mark_committed_during_the_turn_offs_stops_the_rest(world, turn_offs, resumed):
    """Q3 (7.71.03): an extension that marks and resumes the trial after the pause wrote its lists, between two of its
    turn-offs, moves the trial's rev; the next turn-off's own transaction checks it (7.71.04), a plugin's or, once the
    plugins are off, a form's, so the pause stops there (409, counted failed by the tick) and turns off nothing the
    extension turned back on."""
    later = AFTER_END + timedelta(hours=1)
    turn_off = trial_pause.set_trial_plugin
    extended: list[dict] = []
    done: list[str] = []

    def then_extended(*args, **kwargs):
        changed = turn_off(*args, **kwargs)
        done.append(args[2])
        if len(done) == turn_offs and not extended:
            # That many turn-offs done: the extension (whose own resume goes through this patch too) runs once.
            extended.append({})
            extended[0] = extend_trial(world.workspaces, WS, 30, 'sub-platform', resume=partial(resume, world.tables),
                                       now=later)
        return changed

    with patch.object(trial_pause, 'set_trial_plugin', side_effect=then_extended), \
            pytest.raises(ConflictError) as raised:
        pause(world.tables, WS, AFTER_END)
    assert raised.value.code == 'trial_changed'
    assert (extended[0]['paused_at'], extended[0]['resumed']) == (None, {'plugins': resumed, 'forms': 0, 'skipped': []})
    assert _enabled(world) == ['webscraper', 'app_reviews_ios']
    assert (_form(world, 'live')['enabled'], _form(world, 'legacy')['enabled']) == (True, True)
    assert due_trials(world.workspaces, later) == []


@pytest.mark.parametrize(('turn_offs', 'off'), [(1, {'plugins': 1, 'forms': 0}), (2, {'plugins': 2, 'forms': 0})],
                         ids=['a-plugin-next', 'a-form-next'])
def test_a_workspace_deactivated_during_the_turn_offs_ends_the_pause_as_not_active(world, turn_offs, off):
    """Q6 (7.104.00): the turn-off's check of ``META`` refuses a workspace that stopped being active (its deletion
    began) as it refuses a trial that changed; 7.71.04 answered both 409 ``trial_changed``, so the tick counted a
    deleting workspace's pause as failed. One read of ``META`` tells them apart: nothing more to do, ``not_active``,
    with what was turned off until then."""
    turn_off = trial_pause.set_trial_plugin
    done: list[str] = []

    def then_deactivated(*args, **kwargs):
        changed = turn_off(*args, **kwargs)
        done.append(args[2])
        if len(done) == turn_offs:
            world.workspaces.update_item(Key={'pk': f'WS#{WS}', 'sk': 'META'}, UpdateExpression='SET #s = :d',
                                         ExpressionAttributeNames={'#s': 'status'},
                                         ExpressionAttributeValues={':d': 'deleting'})
        return changed

    with patch.object(trial_pause, 'set_trial_plugin', side_effect=then_deactivated):
        assert pause(world.tables, WS, AFTER_END) == {'outcome': NOT_ACTIVE, **off}
    assert len(_enabled(world)) == 2 - off['plugins']
    assert (_form(world, 'live')['enabled'], _form(world, 'legacy')['enabled']) == (True, True)


def test_a_mark_committed_just_before_a_turn_off_commits_refuses_it(world):
    """C4 (7.71.04): 7.71.03 read the rev before each turn-off, so a mark committed between that read and the turn-off
    was not seen, and that turn-off undid what the extension had just turned on. The check is in the turn-off's own
    transaction now: an extension that lands after the plugin's audit row, just before its delete commits, refuses that
    delete, and the pause stops with everything on."""
    later = AFTER_END + timedelta(hours=1)
    audit = workspace_plugin_settings.put_new_audit_row
    extended: list[dict] = []

    def extended_before_the_commit(table, row):
        audit(table, row)
        if not extended:
            extended.append(extend_trial(world.workspaces, WS, 30, 'sub-platform', resume=partial(resume, world.tables),
                                         now=later))

    with patch.object(workspace_plugin_settings, 'put_new_audit_row', side_effect=extended_before_the_commit), \
            pytest.raises(ConflictError) as raised:
        pause(world.tables, WS, AFTER_END)
    assert raised.value.code == 'trial_changed'
    # Nothing was off yet, so the extension had nothing to turn back on; the pause's delete was refused.
    assert (extended[0]['paused_at'], extended[0]['resumed']) == (None, {'plugins': 0, 'forms': 0, 'skipped': []})
    assert _enabled(world) == ['webscraper', 'app_reviews_ios']
    assert (_form(world, 'live')['enabled'], _form(world, 'legacy')['enabled']) == (True, True)


def test_the_pause_reads_the_trial_once_and_each_turn_off_checks_it_in_its_own_write(world):
    """C4 (7.71.04): one read of ``META`` (the pause's own), no GetItem per turn-off: each of the four turn-offs (two
    plugins, two forms) is one transaction whose last entry is the check of the trial at the rev its lists were saved
    with."""
    world.calls.clear()
    pause(world.tables, WS, AFTER_END)
    meta = {'pk': f'WS#{WS}', 'sk': 'META'}
    reads = [params for name, params in world.calls if name == 'GetItem' and params['Key'] == meta]
    last = [params['TransactItems'][-1] for name, params in world.calls if name == 'TransactWriteItems'
            and len(params['TransactItems']) == 2 and 'Update' not in params['TransactItems'][-1]]
    saved = read_meta(world.workspaces, WS)['trial']['rev']
    assert len(reads) == 1
    assert [(entry['ConditionCheck']['Key'], entry['ConditionCheck']['ExpressionAttributeValues'][':rev'])
            for entry in last] == [(meta, saved)] * 4
