# Databases on AWS: Selection Guide

## Decision Flowchart

```
What's your primary access pattern?
│
├─ Key-value lookups (get by ID, simple queries)
│  └─ Need <10ms latency at any scale? → DynamoDB
│
├─ Complex SQL queries (joins, aggregations, transactions)
│  ├─ Need serverless + multi-region? → Aurora DSQL
│  ├─ Need PostgreSQL/MySQL compatibility? → Aurora Serverless v2
│  └─ Need specific engine (Oracle, SQL Server)? → RDS
│
├─ Document store (flexible schema, nested objects)
│  └─ MongoDB-compatible? → DocumentDB
│
├─ Caching / session store
│  └─ Sub-millisecond latency? → ElastiCache (Redis/Valkey)
│
├─ Full-text search / log analytics
│  └─ Search + dashboards? → OpenSearch
│
├─ Graph relationships (social, fraud, knowledge)
│  └─ Traversal queries? → Neptune
│
├─ Time-series (IoT, metrics, events)
│  └─ Time-based queries + retention? → Timestream
│
└─ Immutable ledger (audit, compliance)
   └─ QLDB support ended 31 July 2025. Use Aurora PostgreSQL, append-only
      with a cryptographic hash chain, instead
```

## Detailed Comparison

### DynamoDB vs Aurora

| Dimension | DynamoDB | Aurora Serverless v2 |
|---|---|---|
| Data model | Key-value / document | Relational (SQL) |
| Query flexibility | Limited (design for access patterns) | Full SQL (joins, subqueries) |
| Scaling | Automatic, unlimited | Auto-scaling ACUs (0.5–128) |
| Latency | Single-digit ms | Low ms (varies with query) |
| Transactions | 100 items, 4MB | Full ACID |
| Cost model | Per-request or provisioned | Per-ACU-hour |
| Schema changes | Flexible (schemaless) | Requires migrations |
| Best for | High-scale, simple access patterns | Complex queries, existing SQL apps |

### Aurora Serverless v2 vs Aurora DSQL

| Dimension | Aurora Serverless v2 | Aurora DSQL |
|---|---|---|
| Compatibility | PostgreSQL or MySQL | PostgreSQL (subset) |
| Distribution | Single-region, multi-AZ | Multi-region |
| Scaling | ACU-based (0.5–128) | Fully serverless |
| Foreign keys | Yes | No (application-layer) |
| ALTER COLUMN TYPE | Yes | No (table recreation) |
| Max transaction | Standard PostgreSQL | 3,000 rows / 10 MiB |
| Authentication | Password or IAM | IAM only |
| Best for | Standard relational workloads | Distributed, serverless SQL |

### DynamoDB vs ElastiCache

| Dimension | DynamoDB | ElastiCache |
|---|---|---|
| Latency | Single-digit ms | Sub-millisecond |
| Persistence | Durable (replicated) | Optional (snapshots) |
| Data model | Key-value / document | Key-value, sorted sets, streams |
| Scaling | Automatic | Manual (node types) |
| Cost | Per-request | Per-node-hour |
| Best for | Primary data store | Cache layer, session store, leaderboards |

## When NOT to Use Each Service

| Service | Don't Use When |
|---|---|
| DynamoDB | You need complex joins, ad-hoc queries, or full-text search |
| Aurora | You have simple key-value access and need unlimited scale |
| Aurora DSQL | You need foreign keys, complex DDL, or MySQL compatibility |
| DocumentDB | You need strong consistency or complex transactions |
| ElastiCache | You need durable primary storage |
| OpenSearch | You need ACID transactions or strong consistency |
| Neptune | Your relationships are simple (use DynamoDB GSIs instead) |
| Timestream | You need general-purpose queries beyond time-series |

## Multi-Database Architectures

### Common Combinations

| Primary | Secondary | Pattern |
|---|---|---|
| DynamoDB | ElastiCache | Cache hot items, reduce read costs |
| Aurora | ElastiCache | Cache query results, session store |
| DynamoDB | OpenSearch | DynamoDB for writes, OpenSearch for search |
| Aurora | DynamoDB | Aurora for transactions, DynamoDB for high-scale reads |

### Data Sync Patterns

| Source | Target | Mechanism |
|---|---|---|
| DynamoDB | OpenSearch | DynamoDB Streams → Lambda → OpenSearch |
| DynamoDB | ElastiCache | DynamoDB Streams → Lambda → ElastiCache |
| Aurora | ElastiCache | Application-level write-through or CDC |
| S3 | DynamoDB | S3 event → Lambda → DynamoDB |

## Sizing Guidelines (Dev)

| Service | Dev Config | Est. Monthly |
|---|---|---|
| DynamoDB | On-demand, <1GB | $1–5 |
| Aurora Serverless v2 | 0.5 min ACU, 10GB | $45–60 |
| Aurora DSQL | Serverless, light | $10–20 |
| ElastiCache | cache.t3.micro | $12 |
| DocumentDB | db.t3.medium | $55 |
| OpenSearch | t3.small.search, 1 node | $25 |
| Neptune | db.t3.medium | $55 |
| Timestream | On-demand, <1GB | $5–10 |
