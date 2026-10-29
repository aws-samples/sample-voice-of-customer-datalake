"""Who a document review link admits (shared/review_share_audience.py, docs/document-review.md).

Pure functions: no table. The PreSignUp trigger's use of the same rule is covered in
auth/test/test_board_triggers.py; these pin the rule itself.
"""
from decimal import Decimal

import pytest

from shared.review_share_audience import (
    MODE_ANYONE,
    MODE_LIST,
    audience_admits,
    is_active,
    is_share_id,
    share_admits,
    share_key,
)

NOW = 1_800_000_000
VALID_ID = 'shr_' + '0123456789abcdef' * 2
# Stored mixed-case on purpose: the rule compares lower-cased.
LIST_AUDIENCE = {'mode': MODE_LIST, 'domains': ['Partner.Example'], 'emails': ['Ann@Outside.Example']}


def _link(**overrides):
    return {'revoked': False, 'expires_at_epoch': NOW + 60, 'audience': {'mode': MODE_ANYONE}, **overrides}


@pytest.mark.parametrize('value', [VALID_ID, 'shr_' + 'f' * 32])
def test_a_well_formed_share_id_is_accepted(value):
    assert is_share_id(value)


@pytest.mark.parametrize('value', [
    'shr_' + 'A' * 32, 'shr_' + 'a' * 31, 'shr_' + 'a' * 33, 'SHR_' + 'a' * 32, 'shr_' + 'a' * 32 + '\n',
    'DOCSHARE#shr_x', '', None, 7, ['shr_' + 'a' * 32],
])
def test_a_malformed_share_id_is_refused(value):
    assert not is_share_id(value)


def test_the_share_key_is_the_docshare_meta_row():
    assert share_key(VALID_ID) == {'pk': f'DOCSHARE#{VALID_ID}', 'sk': 'META'}


def test_a_link_expiring_in_the_future_and_not_revoked_is_active():
    assert is_active(_link(), NOW)


def test_a_decimal_expiry_read_back_from_dynamodb_still_counts():
    assert is_active(_link(expires_at_epoch=Decimal(NOW + 1)), NOW)


@pytest.mark.parametrize('expires_at_epoch', [NOW, NOW - 1, 0])
def test_a_link_at_or_past_its_expiry_is_inactive(expires_at_epoch):
    assert not is_active(_link(expires_at_epoch=expires_at_epoch), NOW)


def test_a_revoked_link_is_inactive_even_before_expiry():
    assert not is_active(_link(revoked=True), NOW)


@pytest.mark.parametrize('expires_at_epoch', [True, str(NOW + 60), None, float(NOW + 60)])
def test_an_unreadable_expiry_makes_the_link_inactive(expires_at_epoch):
    assert not is_active(_link(expires_at_epoch=expires_at_epoch), NOW)


@pytest.mark.parametrize('item', [None, {}])
def test_no_link_is_inactive(item):
    assert not is_active(item, NOW)


@pytest.mark.parametrize('email', ['anyone@example.com', 'x@elsewhere.example'])
def test_an_anyone_audience_admits_any_single_address(email):
    assert audience_admits({'mode': MODE_ANYONE}, email)


@pytest.mark.parametrize('email', ['no-at-sign', 'two@@example.com', 'a@b@example.com', ''])
def test_an_address_without_exactly_one_at_sign_is_never_admitted(email):
    assert not audience_admits({'mode': MODE_ANYONE}, email)


@pytest.mark.parametrize(('email', 'admitted'), [
    ('bob@partner.example', True),
    ('ann@outside.example', True),
    ('carl@outside.example', False),
    ('bob@sub.partner.example', False),
    ('bob@partner.example.evil', False),
    ('partner.example@evil.example', False),
])
def test_a_list_audience_admits_its_domains_and_exact_addresses_only(email, admitted):
    assert audience_admits(LIST_AUDIENCE, email) is admitted


@pytest.mark.parametrize('audience', [
    None, 'anyone', {'mode': 'everyone'}, {'mode': MODE_LIST},
    {'mode': MODE_LIST, 'domains': 'partner.example'}, {'mode': MODE_LIST, 'emails': [7, None]},
])
def test_an_unreadable_or_empty_audience_admits_nobody(audience):
    assert not audience_admits(audience, 'bob@partner.example')


@pytest.mark.parametrize(('overrides', 'email', 'admitted'), [
    ({}, 'bob@partner.example', True),
    ({}, 'eve@evil.example', False),
    ({'revoked': True}, 'bob@partner.example', False),
    ({'expires_at_epoch': NOW}, 'bob@partner.example', False),
])
def test_share_admits_needs_an_active_link_and_an_admitted_address(overrides, email, admitted):
    assert share_admits(_link(audience=LIST_AUDIENCE, **overrides), email, NOW) is admitted


def test_share_admits_nobody_without_a_link():
    assert not share_admits(None, 'bob@partner.example', NOW)
