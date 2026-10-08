"""Test builders for SQS ``send_message_batch`` responses.

Shared by the BaseIngestor and BaseWebhook suites, which both exercise
``send_to_queue`` against the same response shapes.
"""


def echo_batch_success(**kwargs) -> dict:
    """``send_message_batch`` side_effect that confirms every entry it is sent.

    Deriving Successful from the actual Entries keeps the mock correct for any
    batch size and any number of calls: an unexpected extra call (e.g. a retry
    round) fails informatively instead of raising StopIteration, and a short
    final batch is never over-claimed.
    """
    return {
        'Successful': [{'Id': e['Id']} for e in kwargs['Entries']],
        'Failed': [],
    }


def permanent_failure_response(
    failed_id: str,
    message: str,
    code: str = 'MessageTooLarge',
    success_ids: tuple[str, ...] = (),
) -> dict:
    """Response confirming *success_ids* and failing *failed_id* with
    SenderFault=true (never retried)."""
    return {
        'Successful': [{'Id': sid} for sid in success_ids],
        'Failed': [
            {
                'Id': failed_id,
                'SenderFault': True,
                'Code': code,
                'Message': message,
            }
        ],
    }
