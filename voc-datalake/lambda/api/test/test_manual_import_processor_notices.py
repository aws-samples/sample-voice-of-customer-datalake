"""manual_import_processor → shared/job_notices.py: a parse job's end tells its starter, best effort."""
import json
from collections.abc import Iterator
from unittest.mock import MagicMock, patch

import pytest
from botocore.exceptions import ClientError

import manual_import_processor as mip

JOB_ID = 'job-1'
PARSED = {'body': MagicMock(read=lambda: json.dumps({
    'content': [{'type': 'text', 'text': '{"reviews": [], "unparsed_sections": []}'}]}).encode())}


@pytest.fixture
def table() -> Iterator[MagicMock]:
    mock = MagicMock()
    mock.get_item.return_value = {'Item': {'raw_text': 'pasted', 'source_origin': 'g2', 'started_by_sub': 'admin-sub'}}
    with patch.object(mip, 'aggregates_table', mock), patch.object(mip, 'get_active_model_id', return_value='m'):
        yield mock


@pytest.fixture
def bedrock() -> Iterator[MagicMock]:
    with patch.object(mip, 'bedrock') as mock:
        mock.invoke_model.return_value = PARSED
        yield mock


@pytest.fixture
def published() -> Iterator[MagicMock]:
    with patch.object(mip.job_notices.realtime, 'publish', return_value=True) as publish:
        yield publish


@pytest.mark.usefixtures('table', 'bedrock')
def test_a_parsed_job_tells_its_starter(published: MagicMock) -> None:
    mip.process_job(JOB_ID)
    published.assert_called_once_with('jobs', 'admin-sub', {
        'type': 'job', 'job_id': JOB_ID, 'status': 'completed', 'job_type': 'manual_import_parse'})


@pytest.mark.usefixtures('table')
def test_a_failed_parse_tells_its_starter(bedrock: MagicMock, published: MagicMock) -> None:
    bedrock.invoke_model.side_effect = RuntimeError('model down')
    mip.process_job(JOB_ID)
    assert published.call_args.args[2]['status'] == 'failed'


@pytest.mark.usefixtures('bedrock')
def test_an_empty_job_fails_and_tells(table: MagicMock, published: MagicMock) -> None:
    table.get_item.return_value = {'Item': {'raw_text': '', 'started_by_sub': 'admin-sub'}}
    mip.process_job(JOB_ID)
    assert published.call_args.args[2]['status'] == 'failed'


@pytest.mark.usefixtures('bedrock')
def test_a_missing_or_unmarked_job_sends_nothing(table: MagicMock, published: MagicMock) -> None:
    table.get_item.return_value = {}
    mip.process_job(JOB_ID)
    table.get_item.return_value = {'Item': {'raw_text': 'x'}}
    table.update_item.side_effect = ClientError({'Error': {'Code': 'Throttling', 'Message': 'x'}}, 'UpdateItem')
    mip.process_job(JOB_ID)
    published.assert_not_called()


@pytest.mark.usefixtures('table', 'bedrock')
def test_a_lost_notice_leaves_the_result(table: MagicMock, published: MagicMock) -> None:
    published.return_value = False
    mip.process_job(JOB_ID)
    assert table.update_item.call_args.kwargs['ExpressionAttributeValues'][':status'] == 'completed'
