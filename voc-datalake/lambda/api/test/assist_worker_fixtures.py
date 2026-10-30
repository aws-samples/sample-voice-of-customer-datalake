"""Run an API handler's assist jobs end to end in a test: start (202) → worker → poll.

``inline_assist_worker`` gives ``shared/assist_jobs`` a moto jobs table and turns the
async worker invoke into a direct ``lambda_handler`` call on the same module — the
twin runs the same code — so the job is finished by the time the start answers.
With ``run_worker=False`` the invoke is only recorded and the row stays ``pending``.

``start_and_poll`` drives a start route and its ``GET …/jobs/{job_id}`` poll through
``lambda_handler`` and returns ``(start status, start body, poll body)``.
"""
from __future__ import annotations

import json
import os
from collections.abc import Callable, Generator
from contextlib import contextmanager
from types import ModuleType, SimpleNamespace
from typing import Any
from unittest.mock import patch

from moto import mock_aws

from shared import assist_jobs
from shared.test.moto_tables import create_pk_sk_table

WORKER_FUNCTION = 'voc-test-assist'


@contextmanager
def inline_assist_worker(handler: ModuleType, lambda_context: Any, *, run_worker: bool = True) -> Generator[SimpleNamespace, None, None]:
    """A moto jobs table plus a worker invoke that runs ``handler.lambda_handler`` in-process."""
    def _invoke(function_name: str, payload: dict) -> None:
        # Only the configured twin runs the work; tests read `invoke.call_args` for the name.
        if run_worker and function_name == WORKER_FUNCTION:
            handler.lambda_handler(payload, lambda_context)

    with mock_aws():
        table = create_pk_sk_table('test-jobs')
        with (
            patch.object(assist_jobs, 'get_jobs_table', return_value=table),
            patch.object(assist_jobs, 'invoke_lambda_async', side_effect=_invoke) as invoke,
            patch.dict(os.environ, {'ASSIST_WORKER_FUNCTION': WORKER_FUNCTION}),
        ):
            yield SimpleNamespace(table=table, invoke=invoke)


def start_and_poll(
    handler: ModuleType, api_gateway_event: Callable[..., dict], lambda_context: Any, *,
    path: str, body: Any, poll_prefix: str, claims: dict | None = None, poll_claims: dict | None = None,
) -> tuple[int, dict, dict]:
    """POST ``path``; when it answers 202, GET ``{poll_prefix}/{job_id}`` (as ``poll_claims`` or the same caller).

    The poll body is ``{}`` when the start was refused (nothing to poll).
    """
    started = handler.lambda_handler(
        api_gateway_event(method='POST', path=path, body=body, claims=claims), lambda_context)
    start_body = json.loads(started['body'])
    if started['statusCode'] != 202:
        return started['statusCode'], start_body, {}
    poll_path = f"{poll_prefix}/{start_body['job_id']}"
    polled = handler.lambda_handler(
        api_gateway_event(method='GET', path=poll_path, claims=poll_claims if poll_claims is not None else claims),
        lambda_context)
    return 202, start_body, {'statusCode': polled['statusCode'], **json.loads(polled['body'])}
