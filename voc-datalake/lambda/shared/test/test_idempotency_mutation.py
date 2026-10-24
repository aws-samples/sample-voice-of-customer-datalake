"""The Powertools half of `shared/idempotency.py`: the layer and the config the processor
wraps `idempotent_function` with.

Neither had a test of its own. The processor builds both ONCE at import, from an env var
its own conftest sets, and then patches the config to `None` in every test that reaches
the decorator — so a mutation run found every statement in the two functions
unobserved: the cache could start non-empty, the env-var name could be anything, the
"not configured" guard could be inverted, and every default could drift, with the
whole suite green.

The layer is exercised against the module AS A COLD START SEES IT — reloaded, so the
module-level cache is whatever the source initialises it to, not whatever an earlier
test left there. A `monkeypatch.setattr(_persistence_layer, None)` would be simpler
and would also hide the one mutant that matters for a cache: a non-`None` initial
value, which makes every call return it without ever building a layer.
"""
import importlib

import pytest
from aws_lambda_powertools.utilities.idempotency import (
    DynamoDBPersistenceLayer,
    IdempotencyConfig,
)

import shared.idempotency as idempotency


@pytest.fixture
def cold_module(monkeypatch):
    """`shared.idempotency` as a fresh execution environment imports it, with no
    `IDEMPOTENCY_TABLE` in the environment unless the test sets one."""
    monkeypatch.delenv('IDEMPOTENCY_TABLE', raising=False)
    importlib.reload(idempotency)
    yield idempotency
    importlib.reload(idempotency)


class TestGetPersistenceLayer:
    def test_a_cold_start_builds_the_layer_once_for_the_named_table(self, cold_module):
        """One `DynamoDBPersistenceLayer`, on the table asked for, and the SAME one on
        the next call: the layer owns a boto3 client, which is what the cache is for.
        """
        first = cold_module.get_persistence_layer('some-idempotency-table')

        assert isinstance(first, DynamoDBPersistenceLayer)
        assert first.table_name == 'some-idempotency-table'
        assert cold_module.get_persistence_layer('some-idempotency-table') is first

    def test_the_table_falls_back_to_the_environment(self, cold_module, monkeypatch):
        monkeypatch.setenv('IDEMPOTENCY_TABLE', 'table-from-env')

        assert cold_module.get_persistence_layer().table_name == 'table-from-env'

    def test_an_explicit_table_wins_over_the_environment(self, cold_module, monkeypatch):
        monkeypatch.setenv('IDEMPOTENCY_TABLE', 'table-from-env')

        assert cold_module.get_persistence_layer('explicit-table').table_name == 'explicit-table'

    def test_refuses_to_build_a_layer_for_no_table(self, cold_module):
        """A `DynamoDBPersistenceLayer(table_name='')` constructs fine and fails on the
        first record, with DynamoDB's error rather than ours. The refusal has to come
        here, and it has to name the variable the operator forgot to set.
        """
        with pytest.raises(ValueError, match='Idempotency table not configured') as refused:
            cold_module.get_persistence_layer()

        assert str(refused.value) == (
            'Idempotency table not configured. Set IDEMPOTENCY_TABLE environment variable.'
        )

    def test_the_layer_keys_and_expires_on_the_attributes_the_claim_writes(self, cold_module):
        """🔑 Two writers, one table. Powertools' layer and `dedupe_claim_item` must
        agree on which attribute is the key and which the table's TTL reads — the
        module's docstring says they do because `IDEMPOTENCY_KEY_ATTRIBUTE` is also
        Powertools' `key_attr` default. Asserted against the layer rather than taken
        from the comment, and against literals rather than the module's constants, so
        a Powertools default changing under us fails here and not in production.
        """
        layer = cold_module.get_persistence_layer('some-idempotency-table')

        assert layer.key_attr == 'id' == cold_module.IDEMPOTENCY_KEY_ATTRIBUTE
        assert layer.expiry_attr == 'expiration' == cold_module.IDEMPOTENCY_EXPIRY_ATTRIBUTE


class TestGetIdempotencyConfig:
    def test_the_defaults_remember_an_hour_with_a_local_cache(self):
        """The processor passes exactly these three values; a default that drifted
        would be the next caller's surprise, not the processor's. `use_local_cache` is
        the one that differs from Powertools' own default (`False`).
        """
        config = idempotency.get_idempotency_config()

        assert isinstance(config, IdempotencyConfig)
        assert config.expires_after_seconds == 3600
        assert config.use_local_cache is True
        assert config.local_cache_max_items == 256

    def test_every_setting_reaches_the_config(self):
        config = idempotency.get_idempotency_config(
            expires_after_seconds=90, use_local_cache=False, local_cache_max_items=7,
        )

        assert (config.expires_after_seconds, config.use_local_cache, config.local_cache_max_items) == (
            90, False, 7,
        )
