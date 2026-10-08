"""Test builders for BaseWebhook subclasses and the events they handle."""
from typing import override


def webhook_parsing(items=()):
    """Construct a minimal BaseWebhook whose parse_webhook_payload returns
    a fresh list of *items*.

    Construction reads the secret and builds the SQS client, so call it with
    the ``webhook_aws`` fixture (or equivalent patches) active.
    """
    from _shared.base_webhook import BaseWebhook

    class TestWebhook(BaseWebhook):
        @override
        def parse_webhook_payload(self, body, headers):
            return [dict(item) for item in items]

    return TestWebhook()


def webhook_event(
    body: str = '{}',
    headers: dict | None = None,
    is_base64: bool = False,
    source_ip: str = '1.2.3.4',
) -> dict:
    """API Gateway proxy event as BaseWebhook.handle receives it."""
    return {
        'body': body,
        'headers': {} if headers is None else headers,
        'isBase64Encoded': is_base64,
        'requestContext': {'identity': {'sourceIp': source_ip}},
    }
