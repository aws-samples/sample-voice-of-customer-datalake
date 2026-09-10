"""
Shared idempotency utilities for VoC Lambda functions.
Uses AWS Lambda Powertools Idempotency to prevent duplicate processing.

Idempotency ensures that processing the same event multiple times produces
the same result and side effects only happen once - critical for:
- SQS message retries
- Lambda retries on failure
- Concurrent executions of the same event

Two shapes, one table
---------------------
Powertools' `idempotent_function` (used by `processor/handler.py`) is the shape for
work whose RESULT is worth remembering: it writes an INPROGRESS record, runs the
function, then stores the response so a replay can return it without re-running.

`dedupe_claim_item` is the shape for work whose result is a set of DynamoDB writes
that must happen exactly once — the aggregator's counter updates. It is a single
conditional `Put` built for `TransactWriteItems`, so the claim and the writes it
guards commit TOGETHER or not at all. Powertools' two-phase form cannot give that:
between its INPROGRESS write and its COMPLETED write the counters are applied
non-atomically, so a record that dies halfway leaves the aggregates internally
inconsistent and the retry re-applies whatever already landed.

Both write to the same table with the same attribute names, which is why those
names are declared here once (`IDEMPOTENCY_KEY_ATTRIBUTE`,
`IDEMPOTENCY_EXPIRY_ATTRIBUTE`) rather than spelled again at either call site. The
expiry attribute in particular has to agree with the table's
`timeToLiveAttribute: 'expiration'` (`lib/stacks/core-stack.ts`) or markers
accumulate forever — which no error and no runtime behaviour reports, so
`test/test_idempotency_table_schema_lockstep.py` compares the constants below
against that construct. It is a lockstep rather than a test of either side because
every test that reads these names reads them THROUGH the constants: renaming one
here moves the production write and its expectation together and stays green, while
the table keeps expiring an attribute nothing writes.
"""

import os
from aws_lambda_powertools.utilities.idempotency import (
    DynamoDBPersistenceLayer,
    IdempotencyConfig,
    idempotent,
    idempotent_function,
)
from aws_lambda_powertools.utilities.idempotency.exceptions import (
    IdempotencyAlreadyInProgressError,
    IdempotencyItemAlreadyExistsError,
)

# Re-export for convenience
__all__ = [
    "dedupe_claim_item",
    "DEDUPE_CLAIM_TTL_SECONDS",
    "get_idempotency_config",
    "get_persistence_layer",
    "idempotent",
    "idempotent_function",
    "IDEMPOTENCY_EXPIRY_ATTRIBUTE",
    "IDEMPOTENCY_KEY_ATTRIBUTE",
    "IdempotencyAlreadyInProgressError",
    "IdempotencyItemAlreadyExistsError",
]

# The idempotency table's schema, as BOTH writers spend it. `id` is the partition
# key declared in `lib/stacks/core-stack.ts`, and it is also Powertools'
# `key_attr` default — so the two writers cannot collide on a key while disagreeing
# about which attribute holds it. `expiration` is that table's
# `timeToLiveAttribute`, which is what makes a marker self-deleting; spelled
# differently, every marker would live forever and nothing would say so.
IDEMPOTENCY_KEY_ATTRIBUTE = "id"
IDEMPOTENCY_EXPIRY_ATTRIBUTE = "expiration"

# Module-level cache for persistence layer
_persistence_layer = None


def get_persistence_layer(table_name: str = None) -> DynamoDBPersistenceLayer:
    """
    Get or create DynamoDB persistence layer for idempotency.
    
    Args:
        table_name: DynamoDB table name. Defaults to IDEMPOTENCY_TABLE env var.
        
    Returns:
        DynamoDBPersistenceLayer instance (cached for connection reuse)
    """
    global _persistence_layer
    
    if _persistence_layer is None:
        table = table_name or os.environ.get("IDEMPOTENCY_TABLE", "")
        if not table:
            raise ValueError(
                "Idempotency table not configured. "
                "Set IDEMPOTENCY_TABLE environment variable."
            )
        _persistence_layer = DynamoDBPersistenceLayer(table_name=table)
    
    return _persistence_layer


def get_idempotency_config(
    expires_after_seconds: int = 3600,
    event_key_jmespath: str = None,
    use_local_cache: bool = True,
    local_cache_max_items: int = 256,
    raise_on_no_idempotency_key: bool = False,
) -> IdempotencyConfig:
    """
    Create idempotency configuration with sensible defaults.
    
    Args:
        expires_after_seconds: How long to remember processed events (default: 1 hour)
        event_key_jmespath: JMESPath to extract idempotency key from event
        use_local_cache: Use in-memory cache to reduce DynamoDB reads (default: True)
        local_cache_max_items: Max items in local cache (default: 256)
        raise_on_no_idempotency_key: Raise error if key extraction fails (default: False)
        
    Returns:
        IdempotencyConfig instance
        
    Example JMESPath expressions:
        - SQS batch: "Records[*].messageId" 
        - Single record: "body.id"
        - API Gateway: "requestContext.requestId"
        - Custom: "powertools_json(body).source_platform"
    """
    return IdempotencyConfig(
        expires_after_seconds=expires_after_seconds,
        event_key_jmespath=event_key_jmespath,
        use_local_cache=use_local_cache,
        local_cache_max_items=local_cache_max_items,
        raise_on_no_idempotency_key=raise_on_no_idempotency_key,
    )


# How long a dedupe claim is kept. DynamoDB Streams retain a record for 24 hours, so
# that is the longest a redelivery of one can arrive after the first — and the marker
# has to OUTLIVE that window rather than match it: expiring at exactly the horizon
# leaves the last possible redelivery racing the TTL that deletes its own marker, and
# TTL deletion is best-effort besides (DynamoDB documents up to 48 hours of lag), so
# the boundary is not even sharp. Double the window is the smallest horizon with
# headroom on both sides; the only cost is storage for markers that can no longer be
# claimed, and the table's TTL still collects them.
DEDUPE_CLAIM_TTL_SECONDS = 2 * 24 * 60 * 60


def dedupe_claim_item(
    table_name: str, key: str, now: int,
    expires_after_seconds: int = DEDUPE_CLAIM_TTL_SECONDS,
) -> dict:
    """One `TransactWriteItems` entry that claims `key`, or fails the transaction.

    The dedupe primitive for work whose "result" is a set of DynamoDB writes rather
    than a value: a conditional `Put` of a marker that can be handed to
    `transact_write_items` ALONGSIDE those writes, so the claim and the work commit
    together. The condition is `attribute_not_exists(<key attr>)`, so the SECOND
    delivery of the same key cancels the whole transaction and not one item of it —
    which is what makes a redelivery leave every guarded counter untouched.

    🔑 WHY NOT `idempotent_function`. That decorator is two writes around a call: an
    INPROGRESS record, the function, then a COMPLETED record carrying its result.
    The function's own writes therefore land between the two, unprotected — so a
    record that dies partway through a set of counter updates has applied some of them,
    the marker is not COMPLETED, and the retry applies the whole set again on top.
    That partial-application case is the one that leaves aggregate rows disagreeing
    with each other (a daily total that does not equal the sum of its categories),
    and it is precisely what a transaction removes. The decorator also stores and
    replays a RESULT, which is the wrong thing to remember for a counter update, and
    it caches in memory across invocations — a cache hit would skip writes that a
    concurrent execution had rolled back.

    `now` is passed in rather than read here, so a caller that already has an
    invocation clock stamps its marker with the same instant it stamps everything
    else, and so a test can freeze one clock rather than two.

    The default horizon is `DEDUPE_CLAIM_TTL_SECONDS` — see that constant for why it
    is longer than the stream's own retention rather than equal to it. The table's TTL
    (`timeToLiveAttribute: 'expiration'`) is what collects the markers, which is why
    the attribute name is a shared constant and not a literal here.

    Returns the transaction item; issues nothing itself. Every AWS call this
    participates in belongs to the caller, whose client and whose error handling the
    transaction outcome has to reach.
    """
    return {
        'Put': {
            'TableName': table_name,
            'Item': {
                IDEMPOTENCY_KEY_ATTRIBUTE: key,
                IDEMPOTENCY_EXPIRY_ATTRIBUTE: now + expires_after_seconds,
            },
            'ConditionExpression': f'attribute_not_exists({IDEMPOTENCY_KEY_ATTRIBUTE})',
        },
    }
