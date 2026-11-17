"""The readiness checks' ports for the Agents API suites (engineering/readiness.py): every one ready, each settable."""
from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field
from decimal import Decimal
from typing import Any

import pytest

import agents_handler
from engineering.readiness import Settings
from engineering.skills.templates import bundled


@dataclass
class ReadyPorts:
    """A deployment where every check passes (the connection read from the suite's own table, if given)."""

    agents: Any = None
    modes: dict[str, str] = field(default_factory=dict)
    default_mode: str = 'ai_driven'
    attestation: bool = True
    #: The connections whose CI is attested (None: every connection, as ``attestation`` says).
    attested_connections: frozenset[str] | None = None
    access: str = 'available'

    def connection(self, connection_id: str) -> Mapping[str, Any] | None:
        if self.agents is None:
            return {'connection_id': connection_id, 'host': 'github', 'repository': 'example-org/shop'}
        from shared import engineering_agent_runs as eng_runs
        return eng_runs.connection_row(self.agents, connection_id)

    def installation_repositories(self, connection: Mapping[str, Any]) -> tuple[frozenset[str], bool] | None:
        return frozenset({str(connection.get('repository', ''))}), False

    def attested(self, connection_id: str, repository: str) -> bool:
        del repository
        attested = self.attested_connections
        return self.attestation and (attested is None or connection_id in attested)

    def ci_protection(self, connection: Mapping[str, Any]) -> bool | None:
        del connection
        return True

    def knowledge_approved(self, connection_id: str) -> int:
        del connection_id
        return 1

    def issues_source_reads(self, repository: str) -> bool:
        del repository
        return True

    def mode(self, person: str) -> str:
        return self.modes.get(person, self.default_mode)

    def hard_cap_on(self) -> bool:
        return True

    def month_spend_usd(self, workflow_id: str) -> Decimal:
        del workflow_id
        return Decimal(0)

    def models_access(self, model_ids: list[str]) -> Mapping[str, str]:
        return dict.fromkeys(model_ids, self.access)

    def session_quota(self) -> float:
        return 5000.0

    def probe_storage(self) -> bool:
        return True


SETTINGS = Settings(image_languages=frozenset({'python', 'node', 'java', 'rust'}), network=True, build_memory_mib=0,
                    region='us-east-1', max_sessions=5000, card_models=bundled().card_models())


def use(monkeypatch: pytest.MonkeyPatch, ports: Any, settings: Settings = SETTINGS) -> None:
    """The handler's readiness on ``ports`` and ``settings``."""
    monkeypatch.setattr(agents_handler, '_readiness_ports', lambda: ports)
    monkeypatch.setattr(agents_handler, '_readiness_settings', lambda: settings)
