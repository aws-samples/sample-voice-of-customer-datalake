"""What a Kiro credit costs here (7.58.00, ``-c engineeringKiroCreditPrice``): the Registry answers it beside the Bedrock
models the native harness may run (``kiro_credit_price_usd``), so the model picker says what a Kiro role's credits are
counted at in the cost caps."""
from __future__ import annotations

from collections.abc import Iterator
from typing import Any

import pytest
from agents_handler_fixtures import call as _call
from engineering_skills_fixtures import engineering_skills

REGISTRY = '/agents/engineering/registry'


@pytest.fixture(autouse=True)
def tables(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    with engineering_skills(monkeypatch):
        yield


@pytest.mark.parametrize(('setting', 'price'), [(None, 0.04), ('0.05', 0.05), ('0', 0.0), ('not a price', 0.04)])
def test_the_registry_answers_the_deployments_price_per_kiro_credit(
        lambda_context: Any, monkeypatch: pytest.MonkeyPatch, setting: str | None, price: float) -> None:
    if setting is None:
        monkeypatch.delenv('ENGINEERING_KIRO_CREDIT_PRICE', raising=False)
    else:
        monkeypatch.setenv('ENGINEERING_KIRO_CREDIT_PRICE', setting)
    status, listing = _call(lambda_context, 'GET', REGISTRY)
    assert (status, listing['kiro_credit_price_usd']) == (200, price)
    status, card = _call(lambda_context, 'GET', f'{REGISTRY}/fixer')
    assert (status, card['kiro_credit_price_usd']) == (200, price)
