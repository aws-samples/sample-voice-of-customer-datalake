# Databases on AWS: DynamoDB Advanced Patterns

## Single-Table Design

### Why Single-Table

- One table = one connection, one set of capacity settings, one backup
- Reduces round trips (fetch related items in one Query)
- Simplifies IAM (one table ARN)
- Trade-off: harder to model, harder to evolve

### When NOT to Use Single-Table

- Team unfamiliar with DynamoDB modeling
- Access patterns not well-defined yet
- Need ad-hoc queries (use Aurora instead)
- Data relationships are complex and evolving

### Key Design Patterns

#### Composite Sort Key

```
PK: USER#123
SK: ORDER#2024-01-15#ORD-001

# Query: all orders for user in January 2024
KeyConditionExpression: PK = 'USER#123' AND begins_with(SK, 'ORDER#2024-01')
```

#### Overloaded GSI

```
GSI1PK          | GSI1SK              | Data
STATUS#PENDING  | 2024-01-15T10:00:00 | Order details
STATUS#SHIPPED  | 2024-01-16T14:30:00 | Order details
TYPE#PREMIUM    | USER#123            | User details

# Query: all pending orders sorted by date
KeyConditionExpression: GSI1PK = 'STATUS#PENDING'
```

#### Adjacency List (Graph-like Relationships)

```
PK          | SK          | Data
USER#123    | USER#123    | User profile (self-reference)
USER#123    | FRIEND#456  | Friendship metadata
USER#123    | FRIEND#789  | Friendship metadata
USER#456    | FRIEND#123  | Reverse friendship

# Query: all friends of user 123
KeyConditionExpression: PK = 'USER#123' AND begins_with(SK, 'FRIEND#')
```

#### Write Sharding (Hot Partition Prevention)

```python
import hashlib

def sharded_pk(base_key: str, shard_count: int = 10) -> str:
    shard = int(hashlib.md5(base_key.encode()).hexdigest(), 16) % shard_count
    return f"{base_key}#SHARD#{shard}"

# Write: distribute across shards
pk = sharded_pk("COUNTER#page-views")

# Read: scatter-gather across all shards
for shard in range(10):
    query(PK=f"COUNTER#page-views#SHARD#{shard}")
```

## Transaction Patterns

### TransactWriteItems (Atomic Multi-Item)

```typescript
await dynamodb.transactWriteItems({
  TransactItems: [
    {
      Put: {
        TableName: 'Orders',
        Item: { PK: { S: 'ORDER#001' }, status: { S: 'CREATED' } },
        ConditionExpression: 'attribute_not_exists(PK)',  // Prevent duplicates
      },
    },
    {
      Update: {
        TableName: 'Orders',
        Key: { PK: { S: 'USER#123' }, SK: { S: 'STATS' } },
        UpdateExpression: 'ADD orderCount :one',
        ExpressionAttributeValues: { ':one': { N: '1' } },
      },
    },
  ],
});
```

**Limits:**
- Max 100 items per transaction
- Max 4MB total
- All items must be in the same region
- Cannot target the same item twice

### Optimistic Locking

```typescript
// Read with version
const item = await dynamodb.getItem({ ... });
const version = item.Item.version.N;

// Write with condition
await dynamodb.updateItem({
  Key: { PK: { S: 'ORDER#001' } },
  UpdateExpression: 'SET status = :new, version = :newVer',
  ConditionExpression: 'version = :currentVer',
  ExpressionAttributeValues: {
    ':new': { S: 'SHIPPED' },
    ':newVer': { N: String(Number(version) + 1) },
    ':currentVer': { N: version },
  },
});
// Throws ConditionalCheckFailedException if version changed
```

## DynamoDB Streams + CDC

### Stream Processing Lambda

```typescript
export const handler = async (event: DynamoDBStreamEvent) => {
  for (const record of event.Records) {
    const eventName = record.eventName;  // INSERT, MODIFY, REMOVE
    const newImage = record.dynamodb?.NewImage;
    const oldImage = record.dynamodb?.OldImage;

    switch (eventName) {
      case 'INSERT':
        await handleNewItem(newImage);
        break;
      case 'MODIFY':
        await handleUpdate(oldImage, newImage);
        break;
      case 'REMOVE':
        await handleDelete(oldImage);
        break;
    }
  }
};
```

### Common CDC Targets

| Target | Pattern | Use Case |
|---|---|---|
| OpenSearch | Stream → Lambda → OpenSearch | Full-text search |
| ElastiCache | Stream → Lambda → Redis | Cache invalidation |
| S3 | Stream → Firehose → S3 | Analytics, archival |
| EventBridge | Stream → Lambda → EventBridge | Event-driven workflows |
| Another DynamoDB table | Stream → Lambda → DynamoDB | Materialized views |

## TTL Patterns

```typescript
// Set TTL on item creation
const ttl = Math.floor(Date.now() / 1000) + (7 * 24 * 60 * 60);  // 7 days
await dynamodb.putItem({
  Item: {
    PK: { S: 'SESSION#abc' },
    data: { S: '...' },
    expiresAt: { N: String(ttl) },  // TTL attribute (Unix epoch seconds)
  },
});
```

**Rules:**
- TTL attribute must be a Number type containing Unix epoch seconds
- DynamoDB deletes expired items within 48 hours (not instant)
- Expired items still appear in queries until deleted, filter them out
- TTL deletes generate Stream events (useful for cleanup workflows)
- TTL deletes are free (no write capacity consumed)

## Batch Operations

### BatchWriteItem

```typescript
// Max 25 items, max 16MB per batch
const chunks = chunkArray(items, 25);
for (const chunk of chunks) {
  const result = await dynamodb.batchWriteItem({
    RequestItems: {
      'MyTable': chunk.map(item => ({
        PutRequest: { Item: item },
      })),
    },
  });
  // Handle unprocessed items (throttling)
  if (result.UnprocessedItems?.MyTable?.length) {
    // Retry with exponential backoff
  }
}
```

### BatchGetItem

```typescript
// Max 100 items, max 16MB response
const result = await dynamodb.batchGetItem({
  RequestItems: {
    'MyTable': {
      Keys: ids.map(id => ({ PK: { S: id } })),
      ProjectionExpression: 'PK, #name, email',
      ExpressionAttributeNames: { '#name': 'name' },
    },
  },
});
```

## Cost Optimization

| Strategy | Impact | When |
|---|---|---|
| On-demand billing | No over-provisioning | Variable/unpredictable traffic |
| Provisioned + auto-scaling | Up to 77% cheaper | Predictable traffic patterns |
| Reserved capacity | Additional savings | Steady-state workloads |
| Sparse GSIs | Reduce write costs | Not all items need indexing |
| ProjectionExpression | Reduce read costs | Only fetch needed attributes |
| TTL | Reduce storage | Ephemeral data |
| Compression (gzip attributes) | Reduce storage + I/O | Large attribute values |
