"""
What a category-reprocess job records about HOW it re-derived a review (TENETS.md D2, D4).

* ``AnswerRecorder`` — a ``converse_fn`` for ``classify_category`` /
  ``classify_dimensions`` that remembers the model that ANSWERED (after a capacity
  fallback it differs from the requested one) and the call's latency, so the
  processed and dimensions modes write a true ``llm_metadata`` (audit S6).
* ``job_config`` — the configuration a job derived with (R4): ``config_version``,
  a 16-hex digest of the categories config, the enrichment model id.
* ``change_stamps`` — ``updated_by`` / ``updated_at`` / ``change_reason`` for an
  in-place Silver write (E-C1).

Data-layer only, so the reprocess worker (which bundles ``shared/`` beside its
handler) can import it.
"""
from __future__ import annotations

import hashlib
import json
import time
from collections.abc import Mapping
from typing import Any, Final

from botocore.exceptions import BotoCoreError, ClientError

from shared.categorization import ENRICHMENT_SURFACE, PROMPT_VERSION
from shared.converse import converse_detailed
from shared.data_version import CONFIG_VERSION_KEY, VERSION_ATTRIBUTE
from shared.model_config import get_active_model_id
from shared.timestamps import now_iso

REPROCESS_REASON: Final = 'reprocess'
ACTOR_KIND_ADMIN: Final = 'admin'
DIGEST_CHARS: Final = 16


class AnswerRecorder:
    """A ``converse_fn``: calls ``converse_detailed`` and keeps what the LAST call ran on."""

    def __init__(self) -> None:
        self.model_name: str | None = None
        self.requested_model: str | None = None
        self.latency_ms: int = 0

    def __call__(self, **kwargs: Any) -> str:
        started = time.monotonic()
        result = converse_detailed(**kwargs)
        self.latency_ms = int((time.monotonic() - started) * 1000)
        self.requested_model = result.requested_model_id or kwargs.get('model_id')
        self.model_name = result.model_id or self.requested_model
        return result.text

    def metadata(self) -> dict[str, Any] | None:
        """``llm_metadata`` for the call, or None when no call was made."""
        if self.model_name is None and self.requested_model is None:
            return None
        return {
            'model_name': self.model_name,
            'requested_model': self.requested_model,
            'prompt_version': PROMPT_VERSION,
            'latency_ms': self.latency_ms,
        }


def categories_digest(categories_config: object) -> str:
    """The first 16 hex of sha256 over the categories config as canonical JSON."""
    canonical = json.dumps(categories_config, sort_keys=True, separators=(',', ':'), default=str)
    return hashlib.sha256(canonical.encode('utf-8')).hexdigest()[:DIGEST_CHARS]


def _config_version(aggregates_table: Any) -> int | None:
    """``METRIC#meta / config_version`` ``v`` (0 = never bumped); None when unreadable."""
    try:
        item = aggregates_table.get_item(Key=dict(CONFIG_VERSION_KEY)).get('Item')
    except (ClientError, BotoCoreError):
        # A lineage read never fails the job; None records "unknown".
        return None
    if item is None:
        return 0
    value = item.get(VERSION_ATTRIBUTE) if isinstance(item, Mapping) else None
    if isinstance(value, bool) or value is None:
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def job_config(aggregates_table: Any, categories_config: object) -> dict[str, Any]:
    """The configuration this invocation derives with, as recorded on the job row."""
    return {
        'config_version': _config_version(aggregates_table),
        'categories_sha16': categories_digest(categories_config),
        'model_id': get_active_model_id(ENRICHMENT_SURFACE),
        'prompt_version': PROMPT_VERSION,
    }


def job_actor(job: Mapping[str, Any]) -> dict[str, str]:
    """The admin who started the job: ``{sub, kind: 'admin'}`` (a pre-6.03 job: its label)."""
    sub = job.get('started_by_sub') or job.get('started_by') or 'unknown'
    return {'sub': str(sub), 'kind': ACTOR_KIND_ADMIN}


def change_stamps(actor: Mapping[str, str], now: str | None = None) -> dict[str, Any]:
    """The who / when / why of an in-place reprocess write."""
    return {'updated_by': dict(actor), 'updated_at': now or now_iso(), 'change_reason': REPROCESS_REASON}
