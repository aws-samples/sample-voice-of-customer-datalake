"""`shared/image_model_quota.py`: the image model's requests-per-minute quota and how current it is.

Service Quotas is a MagicMock patched at ``boto3.client`` in the module (moto does not
cover it); the aggregates row is a real moto table so the refresh claim's condition is
really evaluated.
"""
import time
from collections.abc import Iterator
from decimal import Decimal
from unittest.mock import MagicMock, patch

import boto3
import pytest
from botocore.exceptions import ClientError, EndpointConnectionError
from moto import mock_aws

from shared import image_model_quota as iq
from shared.test.moto_tables import create_pk_sk_table

MODEL = 'stability.stable-image-core-v1:1'
REGION = 'us-west-2'
LABEL = 'Stable Image Core 1.0'
CORE_NAME = f'{iq.QUOTA_PREFIX}Stable Image Core'
WORKER = 'voc-settings-assist'
REFRESH_EVENT = {'action': iq.REFRESH_ACTION, 'model_id': MODEL, 'region': REGION, 'label': LABEL}


def _quota(name: str, value: object = 30.0) -> dict:
    return {'ServiceCode': 'bedrock', 'QuotaCode': 'L-TEST', 'QuotaName': name, 'Value': value}


@pytest.fixture(autouse=True)
def _clean(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    """No memory copy, no table and no worker unless a test sets them."""
    iq._memory.clear()
    monkeypatch.delenv('AGGREGATES_TABLE', raising=False)
    monkeypatch.delenv('ASSIST_WORKER_FUNCTION', raising=False)
    yield
    iq._memory.clear()


@pytest.fixture
def quotas() -> Iterator[MagicMock]:
    """The Service Quotas client; ``quotas.pages`` is the paginator's answer."""
    client = MagicMock()
    client.pages = [{'Quotas': [_quota(CORE_NAME, 25.0)]}]
    client.get_paginator.return_value.paginate.side_effect = lambda **_: iter(client.pages)
    iq._quotas_client.cache_clear()
    with patch.object(iq.boto3, 'client', return_value=client) as factory:
        client.factory = factory
        yield client
    iq._quotas_client.cache_clear()


@pytest.fixture
def table(monkeypatch: pytest.MonkeyPatch) -> Iterator:
    with mock_aws():
        resource = boto3.resource('dynamodb', region_name='us-east-1')
        moto_table = create_pk_sk_table('test-aggregates-image-quota', resource)
        monkeypatch.setenv('AGGREGATES_TABLE', 'test-aggregates-image-quota')
        with patch.object(iq, 'get_aggregates_table', return_value=moto_table):
            yield moto_table


@pytest.fixture
def invoke() -> Iterator[MagicMock]:
    with patch.object(iq, 'invoke_lambda_async') as recorded:
        yield recorded


def _store(table, *, age: float, value: int | None = 40, model_id: str = MODEL, **extra) -> None:
    item = {**iq.ROW_KEY, 'model_id': model_id, 'fetched_at': Decimal(str(round(time.time() - age, 3))), **extra}
    if value is not None:
        item.update({'name': CORE_NAME, 'value': value})
    table.put_item(Item=item)


class TestMatchQuota:
    @pytest.mark.parametrize(('label', 'name'), [
        ('Stable Image Core 1.0', 'Stable Image Core'),
        ('Stable Image Ultra 1.0', 'Stable Image Ultra'),
        ('Stable Diffusion 3.5 Large', 'Stable Diffusion 3.5 Large'),
        ('Stable Image Core', 'stable image core'),
        ('Stable Image Core 1.0', 'Stable Image Core v1'),
    ])
    def test_the_model_quota_is_found_by_its_words(self, label, name):
        found = iq.match_quota([_quota(iq.QUOTA_PREFIX + name, 12.0)], label)
        assert found == {'name': iq.QUOTA_PREFIX + name, 'value': 12, 'unit': 'requests_per_minute'}

    def test_another_stability_model_does_not_match(self):
        assert iq.match_quota([_quota(f'{iq.QUOTA_PREFIX}Stable Image Ultra')], LABEL) is None

    def test_a_longer_model_name_sharing_the_prefix_does_not_match(self):
        assert iq.match_quota([_quota(f'{iq.QUOTA_PREFIX}Stable Image Corezilla')], LABEL) is None

    @pytest.mark.parametrize('name', [
        'Cross-region model inference requests per minute for Stability.ai Stable Image Core',
        'On-demand model inference tokens per minute for Stability.ai Stable Image Core',
        'On-demand model inference requests per minute for Anthropic Stable Image Core',
    ])
    def test_a_quota_without_the_on_demand_stability_prefix_does_not_match(self, name):
        assert iq.match_quota([_quota(name)], LABEL) is None

    @pytest.mark.parametrize('value', [None, True, '30', {}])
    def test_a_non_numeric_value_is_skipped(self, value):
        assert iq.match_quota([_quota(CORE_NAME, value)], LABEL) is None

    def test_the_first_match_wins_and_the_value_is_truncated_to_int(self):
        found = iq.match_quota([_quota('noise'), _quota(CORE_NAME, 7.9), _quota(CORE_NAME, 99)], LABEL)
        assert found == {'name': CORE_NAME, 'value': 7, 'unit': iq.UNIT}

    def test_the_prefix_and_unit_are_pinned(self):
        assert iq.QUOTA_PREFIX == 'On-demand model inference requests per minute for Stability.ai '
        assert iq.UNIT == 'requests_per_minute'


class TestListQuota:
    def test_it_lists_bedrock_quotas_in_the_image_region(self, quotas):
        assert iq.list_quota(REGION, LABEL) == {'name': CORE_NAME, 'value': 25, 'unit': iq.UNIT}
        args, kwargs = quotas.factory.call_args
        assert (args, kwargs['region_name']) == (('service-quotas',), REGION)
        quotas.get_paginator.assert_called_once_with('list_service_quotas')
        quotas.get_paginator.return_value.paginate.assert_called_once_with(
            ServiceCode='bedrock', PaginationConfig={'PageSize': 100})

    def test_every_page_is_read(self, quotas):
        quotas.pages = [{'Quotas': [_quota('a')]}, {'Quotas': []}, {'Quotas': [_quota(CORE_NAME, 5.0)]}]
        assert iq.list_quota(REGION, LABEL) == {'name': CORE_NAME, 'value': 5, 'unit': iq.UNIT}

    def test_no_matching_quota_is_none(self, quotas):
        quotas.pages = [{'Quotas': [_quota('Something else')]}, {}]
        assert iq.list_quota(REGION, LABEL) is None

    def test_an_aws_error_propagates(self, quotas):
        quotas.get_paginator.return_value.paginate.side_effect = ClientError(
            {'Error': {'Code': 'AccessDeniedException', 'Message': 'no'}}, 'ListServiceQuotas')
        with pytest.raises(ClientError):
            iq.list_quota(REGION, LABEL)


class TestInlineWithoutWorker:
    @pytest.mark.usefixtures('quotas')
    def test_no_table_no_worker_lists_inline_and_is_fresh(self):
        reading = iq.image_quota(MODEL, REGION, LABEL)
        assert reading == {'quota': {'name': CORE_NAME, 'value': 25, 'unit': iq.UNIT}, 'state': 'fresh'}

    def test_a_fresh_reading_is_kept_in_memory(self, quotas):
        iq.image_quota(MODEL, REGION, LABEL)
        iq.image_quota(MODEL, REGION, LABEL)
        assert quotas.get_paginator.call_count == 1

    def test_an_expired_memory_copy_is_read_again(self, quotas):
        with patch.object(iq.time, 'time', return_value=1000.0):
            iq.image_quota(MODEL, REGION, LABEL)
        with patch.object(iq.time, 'time', return_value=1000.0 + iq.MEMORY_SECONDS + 1):
            iq.image_quota(MODEL, REGION, LABEL)
        assert quotas.get_paginator.call_count == 2

    @pytest.mark.parametrize('error', [
        ClientError({'Error': {'Code': 'ThrottlingException', 'Message': 'slow'}}, 'ListServiceQuotas'),
        EndpointConnectionError(endpoint_url='https://servicequotas.us-west-2.amazonaws.com'),
    ])
    def test_a_listing_failure_is_unknown_and_not_kept(self, quotas, error):
        quotas.get_paginator.return_value.paginate.side_effect = error
        assert iq.image_quota(MODEL, REGION, LABEL) == {'quota': None, 'state': 'unknown'}
        assert MODEL not in iq._memory

    def test_an_unexpected_failure_is_unknown_never_raised(self, quotas):
        quotas.get_paginator.side_effect = RuntimeError('bug')
        assert iq.image_quota(MODEL, REGION, LABEL) == {'quota': None, 'state': 'unknown'}

    def test_no_matching_quota_is_fresh_with_no_quota(self, quotas):
        quotas.pages = [{'Quotas': []}]
        assert iq.image_quota(MODEL, REGION, LABEL) == {'quota': None, 'state': 'fresh'}


class TestStoredRow:
    def test_a_fresh_row_answers_without_listing(self, table, quotas, invoke):
        _store(table, age=60)
        reading = iq.image_quota(MODEL, REGION, LABEL)
        assert reading == {'quota': {'name': CORE_NAME, 'value': 40, 'unit': iq.UNIT}, 'state': 'fresh'}
        quotas.get_paginator.assert_not_called()
        invoke.assert_not_called()

    @pytest.mark.usefixtures('quotas')
    def test_a_row_for_another_model_is_ignored(self, table):
        _store(table, age=60, model_id='stability.sd3-5-large-v1:0')
        assert iq.image_quota(MODEL, REGION, LABEL)['quota'] == {'name': CORE_NAME, 'value': 25, 'unit': iq.UNIT}

    @pytest.mark.usefixtures('quotas')
    def test_inline_listing_writes_the_row(self, table):
        iq.image_quota(MODEL, REGION, LABEL)
        item = table.get_item(Key=iq.ROW_KEY)['Item']
        assert (item['model_id'], item['name'], item['value']) == (MODEL, CORE_NAME, 25)
        assert abs(float(item['fetched_at']) - time.time()) < 60

    def test_a_listing_with_no_match_stores_the_row_without_a_quota(self, table, quotas):
        quotas.pages = [{'Quotas': []}]
        iq.image_quota(MODEL, REGION, LABEL)
        item = table.get_item(Key=iq.ROW_KEY)['Item']
        assert item['model_id'] == MODEL
        assert 'name' not in item
        assert 'value' not in item

    @pytest.mark.usefixtures('quotas')
    def test_an_unreadable_row_falls_back_to_listing(self):
        broken = MagicMock()
        broken.get_item.side_effect = ClientError({'Error': {'Code': 'ResourceNotFoundException'}}, 'GetItem')
        with patch.dict('os.environ', {'AGGREGATES_TABLE': 'x'}), \
             patch.object(iq, 'get_aggregates_table', return_value=broken):
            assert iq.image_quota(MODEL, REGION, LABEL)['state'] == 'fresh'


@pytest.mark.usefixtures('quotas')
class TestAsyncRefresh:
    @pytest.fixture(autouse=True)
    def _worker(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv('ASSIST_WORKER_FUNCTION', WORKER)

    def test_a_stale_row_answers_stale_and_starts_the_worker(self, table, invoke, quotas):
        _store(table, age=iq.FRESH_SECONDS + 10)
        reading = iq.image_quota(MODEL, REGION, LABEL)
        assert reading == {'quota': {'name': CORE_NAME, 'value': 40, 'unit': iq.UNIT}, 'state': 'stale'}
        invoke.assert_called_once_with(WORKER, {'action': iq.REFRESH_ACTION, 'model_id': MODEL,
                                                'region': REGION, 'label': LABEL})
        quotas.get_paginator.assert_not_called()

    def test_no_row_answers_pending_and_starts_the_worker(self, table, invoke):
        assert iq.image_quota(MODEL, REGION, LABEL) == {'quota': None, 'state': 'pending'}
        assert invoke.call_count == 1
        assert 'refresh_requested_at' in table.get_item(Key=iq.ROW_KEY)['Item']

    @pytest.mark.usefixtures('table', 'invoke')
    def test_a_stale_reading_is_not_kept_in_memory(self):
        iq.image_quota(MODEL, REGION, LABEL)
        assert MODEL not in iq._memory

    @pytest.mark.usefixtures('table')
    def test_a_second_request_within_the_claim_window_does_not_start_another(self, invoke):
        iq.image_quota(MODEL, REGION, LABEL)
        assert iq.image_quota(MODEL, REGION, LABEL)['state'] == 'pending'
        assert invoke.call_count == 1

    def test_an_old_claim_is_taken_again(self, table, invoke):
        _store(table, age=iq.FRESH_SECONDS + 10,
               refresh_requested_at=Decimal(str(round(time.time() - iq.REFRESH_CLAIM_SECONDS - 5, 3))))
        iq.image_quota(MODEL, REGION, LABEL)
        assert invoke.call_count == 1

    @pytest.mark.usefixtures('table')
    def test_a_failed_invoke_still_answers(self, invoke):
        invoke.side_effect = ClientError({'Error': {'Code': 'TooManyRequestsException'}}, 'Invoke')
        assert iq.image_quota(MODEL, REGION, LABEL) == {'quota': None, 'state': 'pending'}

    def test_without_a_table_the_worker_is_started_every_time(self, invoke):
        iq.image_quota(MODEL, REGION, LABEL)
        iq.image_quota(MODEL, REGION, LABEL)
        assert invoke.call_count == 2

    def test_the_refresh_action_name_is_pinned(self):
        assert iq.REFRESH_ACTION == 'image_model_quota_refresh'


class TestRunRefreshEvent:
    def test_it_lists_into_the_row(self, table, quotas):
        assert iq.run_refresh_event(REFRESH_EVENT) == {'refreshed': True}
        assert table.get_item(Key=iq.ROW_KEY)['Item']['value'] == 25
        assert quotas.factory.call_args.kwargs['region_name'] == REGION

    @pytest.mark.parametrize('event', [{'model_id': MODEL}, {'region': REGION}, {}])
    def test_a_missing_model_or_region_does_nothing(self, quotas, event):
        assert iq.run_refresh_event(event) == {'refreshed': False}
        quotas.get_paginator.assert_not_called()

    def test_a_listing_failure_is_not_refreshed(self, quotas):
        quotas.get_paginator.return_value.paginate.side_effect = ClientError(
            {'Error': {'Code': 'AccessDeniedException'}}, 'ListServiceQuotas')
        assert iq.run_refresh_event(REFRESH_EVENT) == {'refreshed': False}

    @pytest.mark.usefixtures('table')
    def test_a_refreshed_row_is_then_fresh_for_requests(self, quotas, monkeypatch, invoke):
        monkeypatch.setenv('ASSIST_WORKER_FUNCTION', WORKER)
        iq.run_refresh_event(REFRESH_EVENT)
        quotas.get_paginator.reset_mock()
        assert iq.image_quota(MODEL, REGION, LABEL)['state'] == 'fresh'
        invoke.assert_not_called()
        quotas.get_paginator.assert_not_called()
