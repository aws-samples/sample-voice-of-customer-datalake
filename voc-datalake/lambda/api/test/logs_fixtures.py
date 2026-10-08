"""The `api/logs_handler.py` list routes shared by its two route suites.

`test_logs_handler_mutation.py` and `test_logs_params_and_paging.py` both run
every case once per list route; the four routes and their path parameters are
spelled once here so the two suites cannot drift apart.
"""
from __future__ import annotations

import pytest

# (path, path parameters) for each GET list route, with a readable test id.
LIST_ROUTES = [
    pytest.param('/logs/validation', {}, id='validation'),
    pytest.param('/logs/processing', {}, id='processing'),
    pytest.param('/logs/summary', {}, id='summary'),
    pytest.param('/logs/scraper/s-1', {'scraper_id': 's-1'}, id='scraper'),
]
