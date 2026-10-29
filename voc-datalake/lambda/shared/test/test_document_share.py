"""Review links (shared/document_share.py, docs/document-review.md -> Share for review).

Against moto: create is a transaction, revoke and the rate counter are conditional
updates, and those conditions are the behaviour.
"""
from datetime import UTC, datetime

import pytest
from moto import mock_aws

from shared import document_share as ds
from shared.document_comments import comments_pk, email_digest
from shared.exceptions import ConflictError, NotFoundError, TooManyRequestsError, ValidationError
from shared.review_share_audience import is_share_id, share_key
from shared.test.moto_tables import create_pk_sk_table

NOW = 1_800_000_000
SERIES = {'series_id': 'ser_' + 'a' * 24, 'document_type': 'prfaq', 'base_title': 'Launch'}
CREATOR = {'sub': 'owner-sub', 'name': 'Olive Owner'}
REVIEWER = 'rev@partner.example'


@pytest.fixture(autouse=True)
def clock(monkeypatch):
    """The module's epoch clock, movable by the test: ``clock['now'] = …``."""
    state = {'now': NOW}
    monkeypatch.setattr(ds, '_now_epoch', lambda: state['now'])
    return state


@pytest.fixture
def table():
    with mock_aws():
        yield create_pk_sk_table('projects')


def _index_key(project_id='p1'):
    """The series' current-link pointer row."""
    return {'pk': comments_pk(project_id, SERIES['series_id']), 'sk': ds.SHARE_INDEX_SK}


def _rate_key(share_id, email, day):
    return {'pk': f'DCRATE#{share_id}#{email_digest(email)}', 'sk': day}


def _create(table, **values):
    return ds.create_share(table, project_id='p1', series=SERIES, document_id='d1', creator=CREATOR,
                           values=ds.validate_share_body(values))


# ── validate_share_body ─────────────────────────────────────────────────────

def test_an_empty_body_is_an_anyone_link_for_thirty_days():
    assert ds.validate_share_body({}) == {
        'audience': {'mode': 'anyone', 'domains': [], 'emails': []}, 'expires_in_days': ds.DEFAULT_EXPIRY_DAYS}
    assert ds.DEFAULT_EXPIRY_DAYS == 30


@pytest.mark.parametrize('days', [1, 7, 30, 90])
def test_an_expiry_from_one_to_ninety_days_is_accepted(days):
    assert ds.validate_share_body({'expires_in_days': days})['expires_in_days'] == days


@pytest.mark.parametrize('days', [0, 91, -1, True, 7.0, '30', None])
def test_an_expiry_outside_one_to_ninety_whole_days_is_refused(days):
    with pytest.raises(ValidationError, match='expires_in_days'):
        ds.validate_share_body({'expires_in_days': days})


def test_an_unknown_body_field_is_refused():
    with pytest.raises(ValidationError, match='body must be'):
        ds.validate_share_body({'audience': None, 'password': 'x'})


def test_a_list_audience_is_normalised_and_de_duplicated():
    values = ds.validate_share_body({'audience': {
        'mode': 'list', 'domains': ['@Partner.Example', 'partner.example'],
        'emails': ['Ann@Outside.Example', 'ann@outside.example']}})
    assert values['audience'] == {'mode': 'list', 'domains': ['partner.example'], 'emails': ['ann@outside.example']}


@pytest.mark.parametrize('audience', [
    {'mode': 'list'},
    {'mode': 'list', 'domains': [], 'emails': []},
    {'mode': 'everyone'},
    {'mode': 'anyone', 'groups': []},
    'anyone',
    {'mode': 'list', 'domains': ['not a domain']},
    {'mode': 'list', 'emails': ['not-an-email']},
    {'mode': 'list', 'emails': 'ann@outside.example'},
    {'mode': 'list', 'domains': [f'd{i}.example' for i in range(ds.MAX_AUDIENCE_DOMAINS + 1)]},
    {'mode': 'list', 'emails': [f'u{i}@x.example' for i in range(ds.MAX_AUDIENCE_EMAILS + 1)]},
])
def test_a_malformed_or_oversized_audience_is_refused(audience):
    with pytest.raises(ValidationError):
        ds.validate_share_body({'audience': audience})


def test_the_audience_bounds_are_the_documented_ones():
    assert (ds.MAX_AUDIENCE_DOMAINS, ds.MAX_AUDIENCE_EMAILS, ds.MAX_EXPIRY_DAYS) == (20, 200, 90)


# ── create / current / revoke ───────────────────────────────────────────────

def test_creating_a_link_stores_it_with_its_expiry_and_points_the_series_at_it(table):
    share, created = _create(table, expires_in_days=7)
    assert created is True
    assert is_share_id(share['share_id'])
    stored = table.get_item(Key=share_key(share['share_id']))['Item']
    assert stored['expires_at_epoch'] == NOW + 7 * 86_400
    assert stored['ttl'] == NOW + 7 * 86_400 + ds.KEPT_AFTER_EXPIRY_SECONDS
    assert stored['revoked'] is False
    assert (stored['project_id'], stored['series_id'], stored['document_id']) == ('p1', SERIES['series_id'], 'd1')
    assert (stored['created_by_sub'], stored['created_by_name']) == ('owner-sub', 'Olive Owner')
    index = table.get_item(Key=_index_key())['Item']
    assert index['share_id'] == share['share_id']


def test_the_default_link_expires_thirty_days_out(table):
    share, _ = _create(table)
    assert share['expires_at_epoch'] == NOW + 30 * 86_400
    assert share['expires_at'] == datetime.fromtimestamp(NOW + 30 * 86_400, UTC).isoformat()


def test_a_second_create_returns_the_active_link_unchanged(table):
    first, _ = _create(table, expires_in_days=7)
    second, created = _create(table, expires_in_days=90, audience={'mode': 'list', 'domains': ['x.example']})
    assert created is False
    assert second['share_id'] == first['share_id']
    assert second['audience']['mode'] == 'anyone'
    assert len([row for row in table.scan()['Items'] if row['pk'].startswith('DOCSHARE#')]) == 1


def test_current_share_is_the_active_link_and_none_without_one(table):
    assert ds.current_share(table, 'p1', SERIES['series_id']) is None
    share, _ = _create(table)
    current = ds.current_share(table, 'p1', SERIES['series_id'])
    assert current is not None
    assert current['share_id'] == share['share_id']
    assert ds.current_share(table, 'p2', SERIES['series_id']) is None


def test_an_expired_link_is_no_longer_current_and_a_new_one_can_be_made(table, clock):
    old, _ = _create(table, expires_in_days=1)
    clock['now'] = NOW + 86_400
    assert ds.current_share(table, 'p1', SERIES['series_id']) is None
    new, created = _create(table)
    assert created is True
    assert new['share_id'] != old['share_id']


def test_a_stale_index_pointing_at_a_malformed_id_reads_as_no_link(table):
    table.put_item(Item={**_index_key(), 'share_id': 'DOCSHARE#x'})
    assert ds.current_share(table, 'p1', SERIES['series_id']) is None


def test_revoking_keeps_the_link_as_revoked_and_clears_the_series_pointer(table):
    share, _ = _create(table)
    assert ds.revoke_share(table, 'p1', SERIES['series_id'], 'Olive Owner') is True
    stored = table.get_item(Key=share_key(share['share_id']))['Item']
    assert stored['revoked'] is True
    assert stored['revoked_by'] == 'Olive Owner'
    assert 'Item' not in table.get_item(Key=_index_key())
    assert ds.current_share(table, 'p1', SERIES['series_id']) is None


def test_revoking_without_a_link_reports_false(table):
    assert ds.revoke_share(table, 'p1', SERIES['series_id'], 'Olive Owner') is False


def test_revoking_a_pointer_whose_link_row_is_gone_still_clears_the_pointer(table):
    table.put_item(Item={**_index_key(), 'share_id': 'shr_' + 'c' * 32})
    assert ds.revoke_share(table, 'p1', SERIES['series_id'], 'Olive Owner') is True
    assert 'Item' not in table.get_item(Key=_index_key())
    assert 'Item' not in table.get_item(Key=share_key('shr_' + 'c' * 32)), 'revoke must not create a link row'


def test_a_share_id_collision_is_a_conflict(table, monkeypatch):
    first, _ = _create(table)
    ds.revoke_share(table, 'p1', SERIES['series_id'], 'Olive Owner')
    monkeypatch.setattr(ds, 'new_share_id', lambda: first['share_id'])
    with pytest.raises(ConflictError):
        _create(table)


def test_the_team_view_carries_the_review_path_and_whether_it_is_active(table, clock):
    share, _ = _create(table, expires_in_days=1)
    view = ds.share_view(share)
    assert view['path'] == f'/review/{share["share_id"]}'
    assert view['active'] is True
    assert 'created_by_sub' not in view
    assert 'ttl' not in view
    clock['now'] = NOW + 86_400
    assert ds.share_view(share)['active'] is False


# ── require_share_for ───────────────────────────────────────────────────────

def test_an_anyone_link_admits_a_verified_reviewer(table):
    share, _ = _create(table)
    assert ds.require_share_for(table, share['share_id'], REVIEWER)['share_id'] == share['share_id']


def test_a_list_link_admits_only_its_audience(table):
    share, _ = _create(table, audience={'mode': 'list', 'domains': ['partner.example'], 'emails': ['ann@x.example']})
    assert ds.require_share_for(table, share['share_id'], REVIEWER)
    assert ds.require_share_for(table, share['share_id'], 'ann@x.example')
    with pytest.raises(NotFoundError, match=ds.LINK_GONE):
        ds.require_share_for(table, share['share_id'], 'eve@evil.example')


def test_an_expired_link_admits_nobody(table, clock):
    share, _ = _create(table, expires_in_days=1)
    clock['now'] = NOW + 86_400 - 1
    assert ds.require_share_for(table, share['share_id'], REVIEWER)
    clock['now'] = NOW + 86_400
    with pytest.raises(NotFoundError, match=ds.LINK_GONE):
        ds.require_share_for(table, share['share_id'], REVIEWER)


def test_a_revoked_link_admits_nobody(table):
    share, _ = _create(table)
    ds.revoke_share(table, 'p1', SERIES['series_id'], 'Olive Owner')
    with pytest.raises(NotFoundError, match=ds.LINK_GONE):
        ds.require_share_for(table, share['share_id'], REVIEWER)


@pytest.mark.parametrize('share_id', ['shr_' + 'd' * 32, 'shr_short', 'DOCSHARE#x', ''])
def test_an_unknown_or_malformed_link_answers_the_same_gone_message(table, share_id):
    with pytest.raises(NotFoundError, match=ds.LINK_GONE):
        ds.require_share_for(table, share_id, REVIEWER)


# ── count_reviewer_write ────────────────────────────────────────────────────

class _FixedDay(datetime):
    """``datetime`` whose ``now`` is ``moment`` (the rate counter's UTC day)."""
    moment = datetime(2026, 10, 29, 23, 59, tzinfo=UTC)

    @classmethod
    def now(cls, tz=None) -> datetime:
        return cls.moment.astimezone(tz) if tz else cls.moment


def test_a_reviewer_may_write_the_daily_budget_and_no_more(table, monkeypatch):
    monkeypatch.setattr(ds, 'datetime', _FixedDay)
    share_id = 'shr_' + 'e' * 32
    for _ in range(ds.MAX_REVIEWER_WRITES_PER_DAY):
        ds.count_reviewer_write(table, share_id, REVIEWER)
    with pytest.raises(TooManyRequestsError, match='rate_limited'):
        ds.count_reviewer_write(table, share_id, REVIEWER)
    row = table.get_item(Key=_rate_key(share_id, REVIEWER, '2026-10-29'))['Item']
    assert row['n'] == ds.MAX_REVIEWER_WRITES_PER_DAY == 40
    assert row['ttl'] == NOW + ds.RATE_TTL_SECONDS


def test_the_budget_is_per_reviewer_per_link_and_resets_on_the_next_utc_day(table, monkeypatch):
    monkeypatch.setattr(ds, 'datetime', _FixedDay)
    share_id, other_link = 'shr_' + 'e' * 32, 'shr_' + 'f' * 32
    for _ in range(ds.MAX_REVIEWER_WRITES_PER_DAY):
        ds.count_reviewer_write(table, share_id, REVIEWER)
    ds.count_reviewer_write(table, share_id, 'other@partner.example')
    ds.count_reviewer_write(table, other_link, REVIEWER)
    monkeypatch.setattr(_FixedDay, 'moment', datetime(2026, 10, 30, 0, 0, tzinfo=UTC))
    ds.count_reviewer_write(table, share_id, REVIEWER)
    assert table.get_item(Key=_rate_key(share_id, REVIEWER, '2026-10-30'))['Item']['n'] == 1


def test_the_rate_row_never_carries_the_address(table):
    ds.count_reviewer_write(table, 'shr_' + 'e' * 32, REVIEWER)
    assert REVIEWER not in str(table.scan()['Items'])
