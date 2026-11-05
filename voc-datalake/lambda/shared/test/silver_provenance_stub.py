"""A thin test-only stand-in for ``shared/silver_provenance.py`` (E-C1), used ONLY while that module is absent.

Once the real module exists, ``install()`` does nothing and the suites run against it: they only
assert what the contract guarantees (the provenance keys, and the ``keep_silver_version`` call,
which the suites replace with a mock anyway).
"""
import importlib
import sys
import types
from collections.abc import Mapping
from datetime import UTC, datetime
from typing import Any


def _provenance(mode: str, *, llm_metadata: Mapping[str, Any] | None = None, at: str | None = None) -> dict:
    stamped: dict[str, Any] = {
        'pipeline_version': 'unknown',
        'enrichment_mode': mode,
        'enriched_at': at or datetime.now(UTC).isoformat(),
    }
    if llm_metadata is not None:
        stamped['llm_metadata'] = dict(llm_metadata)
    return stamped


def _keep_silver_version(item: Mapping[str, Any], *, actor: Mapping[str, str], reason: str,
                         changed_fields: Any) -> str | None:
    del item, actor, reason, changed_fields
    return None


def install() -> None:
    """Register the stand-in as ``shared.silver_provenance`` when the real module cannot be imported."""
    try:
        importlib.import_module('shared.silver_provenance')
    except ModuleNotFoundError:
        stub = types.ModuleType('shared.silver_provenance')
        for name, value in (('PIPELINE_VERSION', 'unknown'), ('provenance', _provenance),
                            ('keep_silver_version', _keep_silver_version)):
            setattr(stub, name, value)
        sys.modules['shared.silver_provenance'] = stub
