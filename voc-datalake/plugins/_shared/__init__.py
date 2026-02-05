"""
Shared modules for VoC plugins.
"""

from .base_ingestor import BaseIngestor
from .base_webhook import BaseWebhook
from .audit import emit_audit_event, AuditAction
from .circuit_breaker import CircuitBreaker

__all__ = [
    "BaseIngestor",
    "BaseWebhook",
    "emit_audit_event",
    "AuditAction",
    "CircuitBreaker",
]
