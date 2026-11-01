"""shared.model_agreements: each Claude model's agreement on the AI models capacity rows.

The Bedrock control-plane client is a MagicMock patched at ``boto3.client`` in
shared.image_model_status (whose cached ``image_access`` read this module reuses).
"""
import threading
import time
from collections.abc import Iterator
from typing import cast
from unittest.mock import MagicMock, patch

import pytest
from botocore.exceptions import ClientError

from shared import image_model_status, model_agreements
from shared.model_capacity import ModelCapacity, Quota

OPUS55 = 'global.anthropic.claude-opus-5-5'
HAIKU45 = 'global.anthropic.claude-haiku-4-5-20251001-v1:0'
AVAILABLE = {
    'agreementAvailability': {'status': 'AVAILABLE'}, 'authorizationStatus': 'AUTHORIZED',
    'entitlementAvailability': 'AVAILABLE', 'regionAvailability': 'AVAILABLE',
}
NO_AGREEMENT = {**AVAILABLE, 'agreementAvailability': {'status': 'NOT_AVAILABLE'}}


def _row(model_id: str) -> ModelCapacity:
    return {'model_id': model_id, 'label': model_id, 'quota': None}


@pytest.fixture(autouse=True)
def _clean_caches() -> Iterator[None]:
    image_model_status._access_cache.clear()
    image_model_status._client.cache_clear()
    yield
    image_model_status._access_cache.clear()
    image_model_status._client.cache_clear()


@pytest.fixture
def bedrock(monkeypatch) -> Iterator[MagicMock]:
    monkeypatch.setenv('AWS_REGION', 'eu-central-1')
    monkeypatch.setenv('AWS_DEFAULT_REGION', 'eu-central-1')
    client = MagicMock()
    with patch.object(image_model_status.boto3, 'client', return_value=client) as factory:
        client.factory = factory
        yield client


class TestWithAccess:
    def test_a_model_without_an_agreement_reads_not_subscribed(self, bedrock):
        bedrock.get_foundation_model_availability.side_effect = (
            lambda modelId: NO_AGREEMENT if modelId == HAIKU45.removeprefix('global.') else AVAILABLE)

        rows = model_agreements.with_access([_row(OPUS55), _row(HAIKU45)])

        assert [(row['model_id'], row['access']['status']) for row in rows] == [
            (OPUS55, 'available'), (HAIKU45, 'not_subscribed')]
        assert rows[1]['access']['agreement'] == 'NOT_AVAILABLE'

    def test_it_asks_for_the_foundation_model_in_the_app_region(self, bedrock):
        bedrock.get_foundation_model_availability.return_value = AVAILABLE

        model_agreements.with_access([_row(OPUS55)])

        bedrock.get_foundation_model_availability.assert_called_once_with(modelId='anthropic.claude-opus-5-5')
        assert bedrock.factory.call_args.kwargs['region_name'] == 'eu-central-1'

    def test_the_row_keeps_its_label_and_quota(self, bedrock):
        bedrock.get_foundation_model_availability.return_value = AVAILABLE
        quota: Quota = {'name': 'q', 'tokens_per_minute': 5}

        [row] = model_agreements.with_access([{'model_id': OPUS55, 'label': 'Claude Opus 5.5', 'quota': quota}])

        assert (row['label'], row['quota']) == ('Claude Opus 5.5', quota)

    def test_an_unreadable_availability_is_unknown_not_an_error(self, bedrock):
        bedrock.get_foundation_model_availability.side_effect = ClientError(
            {'Error': {'Code': 'AccessDeniedException', 'Message': 'no'}}, 'GetFoundationModelAvailability')

        [row] = model_agreements.with_access([_row(OPUS55)])

        assert row['access']['status'] == 'unknown'

    @pytest.mark.timing  # bounds its own running time (docs/coverage-gate.md)
    def test_a_read_still_running_at_the_budget_answers_unknown_without_holding_the_answer(
        self, bedrock, monkeypatch,
    ):
        release = threading.Event()

        def availability(modelId):
            if modelId == HAIKU45.removeprefix('global.'):
                release.wait(timeout=5)  # hangs past the budget
            return AVAILABLE

        bedrock.get_foundation_model_availability.side_effect = availability
        monkeypatch.setattr(model_agreements, 'ACCESS_BUDGET_SECONDS', 0.2)
        started = time.monotonic()

        rows = model_agreements.with_access([_row(OPUS55), _row(HAIKU45)])

        elapsed = time.monotonic() - started
        release.set()
        # The abandoned read finishes on its own and fills the cache; wait for it so it cannot land
        # after the fixture's clear (deterministic, bounded).
        deadline = time.monotonic() + 5
        while HAIKU45.removeprefix('global.') not in image_model_status._access_cache and time.monotonic() < deadline:
            time.sleep(0.01)
        image_model_status._access_cache.clear()
        assert [row['access']['status'] for row in rows] == ['available', 'unknown']
        assert elapsed < 2

    def test_a_client_that_cannot_be_built_reads_every_row_unknown(self, bedrock):
        bedrock.factory.side_effect = ValueError('no endpoint for region')

        rows = model_agreements.with_access([_row(OPUS55), _row(HAIKU45)])

        assert [row['access']['status'] for row in rows] == ['unknown', 'unknown']
        # The new branch, not image_access's own handling (which catches only ClientError/BotoCoreError):
        # one build attempt, no read.
        assert bedrock.factory.call_count == 1
        bedrock.get_foundation_model_availability.assert_not_called()

    def test_no_rows_reads_nothing(self, bedrock):
        assert model_agreements.with_access([]) == []
        bedrock.get_foundation_model_availability.assert_not_called()

    def test_the_row_keeps_fields_this_module_does_not_name(self, bedrock):
        bedrock.get_foundation_model_availability.return_value = AVAILABLE
        row: dict[str, object] = {**_row(OPUS55), 'extra': 1}

        [enriched] = model_agreements.with_access([cast('ModelCapacity', row)])

        assert dict(enriched).get('extra') == 1


class TestHelpers:
    def test_foundation_id_strips_only_the_global_prefix(self):
        assert model_agreements.foundation_model_id(OPUS55) == 'anthropic.claude-opus-5-5'
        assert model_agreements.foundation_model_id('anthropic.claude-x') == 'anthropic.claude-x'

    def test_app_region_is_the_sessions_region(self, monkeypatch):
        monkeypatch.setenv('AWS_DEFAULT_REGION', 'ap-southeast-2')
        assert model_agreements.app_region() == 'ap-southeast-2'

    def test_app_region_without_a_configured_region_is_the_default(self, monkeypatch):
        monkeypatch.setattr(model_agreements.boto3.session, 'Session', lambda: MagicMock(region_name=None))
        assert model_agreements.app_region() == model_agreements.DEFAULT_REGION
