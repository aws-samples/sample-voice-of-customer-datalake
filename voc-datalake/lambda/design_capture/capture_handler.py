"""``voc-design-capture`` entry point (VocIngestionStack): ``{action: 'design_capture', ref_id}``, and
``{action: 'design_logo_render', …}`` (a GitHub reference's SVG logo, drawn to a PNG: logo_job.py).

Started by the settings API (``POST /settings/design-system/references`` and ``…/refresh`` for a
``website`` reference) with an async invoke; no retries (a retry would open another billed
browser session; the outcome is on the reference either way). See capture_worker.py and
docs/company-context.md.

The web_reviews browser modules ship flat beside this file in the bundle (lib/stacks/design-capture.ts)
and are imported by NAME at call time, as cdp_client imports its websocket library: nothing else in
this package, nor its tests, needs them.
"""
from __future__ import annotations

import importlib
import os
from typing import Any, Final

from capture_worker import BrowserKit, CaptureDeps, run_capture
from logo_job import run_logo_render

from shared.aws import get_dynamodb_resource, get_s3_client
from shared.design_logo_render import DESIGN_LOGO_RENDER_ACTION
from shared.design_references import DESIGN_CAPTURE_ACTION
from shared.invocation_cost import instrumented_handler

BROWSER_MODULE: Final = 'agentcore_browser'
CDP_MODULE: Final = 'cdp_client'
BLOCK_MODULE: Final = 'block_detection'


def browser_kit() -> BrowserKit:
    browser = importlib.import_module(BROWSER_MODULE)
    cdp = importlib.import_module(CDP_MODULE)
    blocks = importlib.import_module(BLOCK_MODULE)
    return BrowserKit(
        open_session=browser.browser_session, blocked_by=blocks.blocked_by, page_signals=blocks.PageSignals,
        browser_errors=(browser.BrowserUnavailableError, cdp.CdpError, OSError),
    )


@instrumented_handler
def lambda_handler(event: dict, context: Any) -> dict:
    action = event.get('action')
    if action not in (DESIGN_CAPTURE_ACTION, DESIGN_LOGO_RENDER_ACTION) or 'httpMethod' in event:
        return {'status': 'ignored'}
    table = get_dynamodb_resource().Table(os.environ['AGGREGATES_TABLE'])
    bucket = os.environ.get('RAW_DATA_BUCKET', '')
    s3 = get_s3_client() if bucket else None
    if action == DESIGN_LOGO_RENDER_ACTION:
        return run_logo_render(event, table, browser_kit(), s3, bucket)
    return run_capture(event, CaptureDeps(table=table, kit=browser_kit(), s3=s3, bucket=bucket))
