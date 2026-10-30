"""`POST /s3-import/reprocess` against moto S3 + DynamoDB (issue #144).

The duplicate-run check (`s3_import_runs.refuse_running_duplicate`) is a Query with a
key range and a filter; these runs prove the expression itself against DynamoDB
semantics, end to end through the route: the second start of a live file is a 409,
and a finished or timed-out run lets the file start again.
"""
from __future__ import annotations

from collections.abc import Iterator
from datetime import UTC, datetime, timedelta
from typing import Any
from unittest.mock import MagicMock, patch

import boto3
import pytest
from handler_events_fixtures import call_route
from moto import mock_aws
from moto_helpers import pk_sk_table

import s3_import_handler as h
from shared import s3_import_runs

BUCKET = 'voc-import-moto'
INGESTOR = 'voc-ingestor-s3_import-moto'
KEY = 'reviews/june.csv'


@pytest.fixture
def world() -> Iterator[dict[str, Any]]:
    """A real import bucket holding KEY, the aggregates table, and a recorded (not run) ingestor invoke."""
    with mock_aws():
        s3 = boto3.client('s3', region_name='us-east-1')
        s3.create_bucket(Bucket=BUCKET)
        s3.put_object(Bucket=BUCKET, Key=KEY, Body=b'text,rating\nGreat flight,5\n')
        s3.put_object(Bucket=BUCKET, Key='reviews/other.csv', Body=b'text\nLost my bag\n')
        table = pk_sk_table('aggregates-moto')
        invoke = MagicMock()
        with patch.object(h, 's3_client', s3), patch.object(h, 'S3_IMPORT_BUCKET', BUCKET), \
                patch.object(h, 'S3_IMPORT_INGESTOR_FUNCTION', INGESTOR), \
                patch.object(h, 'get_aggregates_table', return_value=table), \
                patch.object(s3_import_runs, 'invoke_lambda_async', invoke):
            yield {'table': table, 'invoke': invoke}


def _start(api_gateway_event, lambda_context, key: str = KEY) -> tuple[int, dict]:
    response, decoded = call_route(h.lambda_handler, api_gateway_event, lambda_context,
                                   method='POST', path='/s3-import/reprocess', body={'key': key})
    return response['statusCode'], decoded


def _set_row(table, run_id: str, **fields: str) -> None:
    names = {f'#{n}': n for n in fields}
    table.update_item(
        Key={'pk': s3_import_runs.SOURCE_RUN_PK, 'sk': run_id},
        UpdateExpression='SET ' + ', '.join(f'#{n} = :{n}' for n in fields),
        ExpressionAttributeNames=names,
        ExpressionAttributeValues={f':{n}': v for n, v in fields.items()},
    )


class TestOneLiveRunPerFileInDynamoDB:
    def test_a_second_start_of_a_running_file_is_a_409(self, world, api_gateway_event, lambda_context):
        first, body = _start(api_gateway_event, lambda_context)
        second, refused = _start(api_gateway_event, lambda_context)

        assert first == 202
        assert body['run']['status'] == 'running'
        assert second == 409
        assert s3_import_runs.ALREADY_RUNNING in str(refused)
        assert world['invoke'].call_count == 1

    @pytest.mark.usefixtures('world')
    def test_another_file_still_starts_while_one_runs(self, api_gateway_event, lambda_context):
        assert _start(api_gateway_event, lambda_context)[0] == 202
        assert _start(api_gateway_event, lambda_context, 'reviews/other.csv')[0] == 202

    def test_a_finished_run_lets_the_file_start_again(self, world, api_gateway_event, lambda_context):
        _, body = _start(api_gateway_event, lambda_context)
        # What the ingestor's record_run_finished writes.
        _set_row(world['table'], body['run']['run_id'], status='completed',
                 completed_at=datetime.now(UTC).isoformat())

        assert _start(api_gateway_event, lambda_context)[0] == 202

    def test_a_run_that_timed_out_without_closing_its_row_does_not_block(
            self, world, api_gateway_event, lambda_context):
        _, body = _start(api_gateway_event, lambda_context)
        stale = datetime.now(UTC) - timedelta(seconds=s3_import_runs.INGESTOR_TIMEOUT_SECONDS + 5)
        _set_row(world['table'], body['run']['run_id'], started_at=stale.isoformat())

        assert _start(api_gateway_event, lambda_context)[0] == 202

    def test_an_async_retry_of_an_older_run_id_still_blocks(self, world, api_gateway_event, lambda_context):
        # A retried attempt moves `started_at` to its own start; the run id keeps its creation time.
        old_id = s3_import_runs.timestamped_id(
            s3_import_runs.RUN_ID_PREFIX, datetime.now(UTC) - timedelta(minutes=8))
        world['table'].put_item(Item={
            'pk': s3_import_runs.SOURCE_RUN_PK, 'sk': old_id, 'status': 'running', 'items_found': 0,
            'started_at': datetime.now(UTC).isoformat(), 'file_key': KEY,
        })

        assert _start(api_gateway_event, lambda_context)[0] == 409
