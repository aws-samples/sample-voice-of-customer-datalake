"""The Agents API's engineering routes: an engineering run's board, conversation and reports, read-only.

On only with the engineering agents' table and bucket in the environment; read by a viewer whose category scope hides
nothing; a narrower viewer, an unknown run and a malformed id all answer the same 404.
"""
from __future__ import annotations

from collections.abc import Iterator
from typing import Any
from unittest.mock import patch

import pytest
from agents_handler_fixtures import USER
from agents_handler_fixtures import api as _api
from agents_handler_fixtures import call as _call

from engineering.test.run_fixture import BUCKET, RUN, TABLE, EngineeringRun, engineering_run

BASE = f'/agents/engineering/{RUN}'


@pytest.fixture
def run(monkeypatch: pytest.MonkeyPatch) -> Iterator[tuple[Any, EngineeringRun]]:
    with _api() as env:
        engineering = engineering_run()
        monkeypatch.setenv('ENGINEERING_AGENTS', 'on')
        monkeypatch.setenv('ENGINEERING_TABLE', TABLE)
        monkeypatch.setenv('ENGINEERING_WORKSPACE_BUCKET', BUCKET)
        with patch('shared.aws.get_dynamodb_client', return_value=engineering.client), \
                patch('shared.aws.get_s3_client', return_value=engineering.s3):
            yield env, engineering


def test_the_board_conversation_and_reports_read_through_the_routes(lambda_context: Any,
                                                                    run: tuple[Any, EngineeringRun]) -> None:
    _, engineering = run
    status, board = _call(lambda_context, 'GET', f'{BASE}/board')
    assert status == 200
    assert board['tasks'][0]['task_id'] == engineering.task_id
    status, page = _call(lambda_context, 'GET', f'{BASE}/conversation', query={'after': '1', 'limit': '1'})
    assert (status, [item['seq'] for item in page['items']], page['next_after']) == (200, [2], 2)
    status, reports = _call(lambda_context, 'GET', f'{BASE}/reports')
    assert (status, reports['items'][0]['latest_version']) == (200, 1)
    status, report = _call(lambda_context, 'GET', f'{BASE}/reports/goal/{RUN}')
    assert (status, report['report']['version'], report['markdown']) == (200, 1, '## Goal report (v1)\n')
    assert _call(lambda_context, 'GET', f'{BASE}/reports/goal/{RUN}', query={'version': '1'})[0] == 200
    assert _call(lambda_context, 'GET', f'{BASE}/reports/goal/{RUN}', query={'version': '2'})[0] == 404


@pytest.mark.usefixtures('run')
def test_a_plain_user_who_sees_every_category_reads_too(lambda_context: Any) -> None:
    assert _call(lambda_context, 'GET', f'{BASE}/board', claims=USER)[0] == 200


def test_a_narrower_viewer_gets_the_404_an_unknown_run_gets(lambda_context: Any,
                                                             run: tuple[Any, EngineeringRun]) -> None:
    env, _ = run
    env.aggregates.put_item(Item={'pk': 'CATEGORY_ACCESS', 'sk': 'USER#user-sub', 'categories': ['shipping']})
    hidden = _call(lambda_context, 'GET', f'{BASE}/board', claims=USER)
    unknown = _call(lambda_context, 'GET', '/agents/engineering/01JD0000000000000000000009/board')
    assert hidden == unknown == (404, hidden[1])
    assert _call(lambda_context, 'GET', '/agents/engineering/no-run/conversation')[0] == 404
    assert _call(lambda_context, 'GET', '/agents/engineering/no-run/reports')[0] == 404


@pytest.mark.parametrize('path', [f'{BASE}/reports/weekly/{RUN}', f'{BASE}/reports/pr/42',
                                  '/agents/engineering/run%20x/board'])
@pytest.mark.usefixtures('run')
def test_a_report_or_run_that_is_not_there_is_404(lambda_context: Any, path: str) -> None:
    assert _call(lambda_context, 'GET', path)[0] == 404


@pytest.mark.usefixtures('run')
def test_numbers_out_of_bounds_are_clamped_like_every_agents_route(lambda_context: Any) -> None:
    status, page = _call(lambda_context, 'GET', f'{BASE}/conversation', query={'limit': '9999', 'after': '-4'})
    assert (status, [item['seq'] for item in page['items']]) == (200, [1, 2, 3])


@pytest.mark.usefixtures('run')
@pytest.mark.parametrize('version', ['abc', '0', '10000', '-1', '²'])
def test_a_version_off_its_range_is_400_like_the_tool(lambda_context: Any, version: str) -> None:
    assert _call(lambda_context, 'GET', f'{BASE}/reports/goal/{RUN}', query={'version': version})[0] == 400


@pytest.mark.usefixtures('run')
@pytest.mark.parametrize('missing', ['ENGINEERING_AGENTS', 'ENGINEERING_TABLE', 'ENGINEERING_WORKSPACE_BUCKET'])
def test_every_route_is_404_while_the_engineering_agents_are_off(lambda_context: Any, monkeypatch: pytest.MonkeyPatch,
                                                                 missing: str) -> None:
    monkeypatch.delenv(missing)
    for path in (f'{BASE}/board', f'{BASE}/conversation', f'{BASE}/reports', f'{BASE}/reports/goal/{RUN}'):
        assert _call(lambda_context, 'GET', path)[0] == 404
