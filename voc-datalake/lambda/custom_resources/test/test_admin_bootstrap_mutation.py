"""Mutation hardening for `custom_resources/admin_bootstrap.py`.

`test_admin_bootstrap.py` pins the decision table (create / repair / skip)
and that the returned password is the one Cognito was given, but a mutation
run found what it compares against the module itself and so cannot see:

* the LITERAL alphabets, password length and `UNCHANGED` sentinel. Operators
  retype the password from a stack output, so a stray character in a class,
  a 17-character password, or a `None` in a stack output are real defects —
  every one of them survived because the tests read the constant back from
  the module instead of spelling it out.
* the POOL the filler characters are drawn from: `''.join(classes)` versus
  `'XXXX'.join(classes)` yields a policy-compliant password either way, so
  only observing the argument handed to `secrets.choice` tells them apart.
* the exact `UserAttributes` list on `admin_create_user` (attribute names
  and the `Admin` display name) — only `email_verified` was pinned.
* that a caller-supplied `PhysicalResourceId` is echoed back: the earlier
  test passed the same id the fallback would have produced.
* that the module-level client is a real `cognito-idp` client, which every
  earlier test replaced with a mock before the handler ran.
"""
from types import SimpleNamespace

import admin_bootstrap
import pytest

from custom_resources.test.admin_bootstrap_fakes import UserNotFound, make_event

UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ'
LOWER = 'abcdefghjkmnpqrstuvwxyz'
DIGITS = '123456789'
SPECIAL = '!@#$%^&*'
ALL_CLASSES = UPPER + LOWER + DIGITS + SPECIAL
UNCHANGED = '(unchanged: admin already existed, password not touched)'


class TestConstantsAreSpelledOutForOperators:
    @pytest.mark.parametrize(('name', 'value'), [
        ('UPPER', UPPER),
        ('LOWER', LOWER),
        ('DIGITS', DIGITS),
        ('SPECIAL', SPECIAL),
        ('PASSWORD_LENGTH', 16),
        ('UNCHANGED', UNCHANGED),
    ])
    def test_literal_value(self, name, value):
        assert getattr(admin_bootstrap, name) == value

    def test_module_client_is_a_real_cognito_client(self):
        assert admin_bootstrap.cognito.meta.service_model.service_name == 'cognito-idp'


class TestGeneratedPassword:
    def test_one_char_per_class_then_twelve_from_the_unpadded_pool(self, monkeypatch):
        pools = []

        def first_of(pool):
            pools.append(pool)
            return pool[0]

        monkeypatch.setattr(admin_bootstrap.secrets, 'choice', first_of)
        monkeypatch.setattr(
            admin_bootstrap.secrets, 'SystemRandom',
            lambda: SimpleNamespace(shuffle=lambda _chars: None),
        )

        password = admin_bootstrap.generate_password()

        assert pools[:4] == [UPPER, LOWER, DIGITS, SPECIAL]
        assert pools[4:] == [ALL_CLASSES] * 12
        assert password == 'Aa1!' + 'A' * 12

    def test_real_password_is_sixteen_pool_characters(self):
        password = admin_bootstrap.generate_password()

        assert len(password) == 16
        assert set(password) <= set(ALL_CLASSES)


class TestCreateUserAttributes:
    def test_exact_create_call(self, cognito):
        cognito.admin_get_user.side_effect = UserNotFound()

        admin_bootstrap.handler(make_event(), None)

        cognito.admin_create_user.assert_called_once_with(
            UserPoolId='us-east-1_TEST',
            Username='admin',
            UserAttributes=[
                {'Name': 'email', 'Value': 'admin@local.host'},
                {'Name': 'email_verified', 'Value': 'true'},
                {'Name': 'name', 'Value': 'Admin'},
            ],
            MessageAction='SUPPRESS',
        )


class TestPhysicalResourceId:
    @pytest.mark.parametrize('request_type', ['Create', 'Update', 'Delete'])
    def test_caller_supplied_id_is_echoed_back(self, cognito, request_type):
        cognito.admin_get_user.return_value = {'UserStatus': 'CONFIRMED'}

        result = admin_bootstrap.handler(
            make_event(request_type, physical_id='kept-from-first-deploy'), None
        )

        assert result['PhysicalResourceId'] == 'kept-from-first-deploy'

    def test_missing_id_falls_back_to_pool_derived_id(self):
        # Update never reaches Cognito, so no client mock is needed here.
        result = admin_bootstrap.handler(make_event('Update'), None)

        assert result['PhysicalResourceId'] == 'admin-bootstrap-us-east-1_TEST'
        assert result['Data'] == {'Password': UNCHANGED, 'Bootstrap': 'skipped'}
