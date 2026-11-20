# Databases on AWS: Aurora DSQL Guide

## What is Aurora DSQL

Aurora DSQL is a serverless, PostgreSQL-compatible distributed SQL database. It provides:
- Serverless scaling (no capacity planning)
- Multi-region active-active
- PostgreSQL wire protocol compatibility
- IAM-based authentication
- Optimistic concurrency control (OCC)

## Key Constraints

| Constraint | Limit | Workaround |
|---|---|---|
| Max rows per transaction | 3,000 | Batch operations |
| Max data per transaction | 10 MiB | Split large writes |
| Max transaction duration | 5 min | Break into smaller transactions |
| Max connections | 10,000 | Connection pooling |
| Max connection duration | 60 min | Reconnect periodically |
| IAM auth token expiry | 15 min | Use the language connector for auto-refresh |
| Max indexes per table | 24 | Prioritize query patterns |
| Max columns per index | 8 | Composite indexes |
| Foreign keys | Not supported | Application-layer enforcement |
| ALTER COLUMN TYPE | Not supported | Table recreation pattern |
| DROP COLUMN | Not supported | Table recreation pattern |
| Synchronous CREATE INDEX | Not supported | Use CREATE INDEX ASYNC |
| IDENTITY/SEQUENCE CACHE | 1 or >= 65536 | Plan for gaps |

## DDL Rules

### One DDL Per Transaction

```sql
-- CORRECT: separate transactions
BEGIN; CREATE TABLE orders (...); COMMIT;
BEGIN; CREATE INDEX ASYNC idx_orders_status ON orders (status); COMMIT;

-- WRONG: multiple DDL in one transaction
BEGIN;
CREATE TABLE orders (...);
CREATE INDEX ASYNC idx_orders_status ON orders (status);  -- Will fail
COMMIT;
```

### CREATE INDEX ASYNC

Always use ASYNC for index creation:

```sql
-- CORRECT
CREATE INDEX ASYNC idx_orders_tenant ON orders (tenant_id);

-- WRONG (will fail or block)
CREATE INDEX idx_orders_tenant ON orders (tenant_id);
```

Check index status:
```sql
SELECT * FROM pg_stat_all_indexes WHERE indexrelname = 'idx_orders_tenant';
```

## Table Recreation Pattern

For operations DSQL doesn't support (ALTER COLUMN TYPE, DROP COLUMN, DROP CONSTRAINT):

```sql
-- Step 1: Create new table with desired schema
CREATE TABLE orders_new (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  amount NUMERIC(12,2) NOT NULL,  -- Changed from NUMERIC(10,2)
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Step 2: Copy data in batches (max 3,000 rows per transaction)
INSERT INTO orders_new (id, tenant_id, amount, created_at)
SELECT id, tenant_id, amount::NUMERIC(12,2), created_at
FROM orders
ORDER BY id
LIMIT 3000 OFFSET 0;
-- Repeat with increasing OFFSET until all rows copied

-- Step 3: Verify row counts match
SELECT COUNT(*) FROM orders;
SELECT COUNT(*) FROM orders_new;

-- Step 4: Swap tables
DROP TABLE orders;
ALTER TABLE orders_new RENAME TO orders;

-- Step 5: Recreate indexes (separate transactions)
CREATE INDEX ASYNC idx_orders_tenant ON orders (tenant_id);
```

## Connection Patterns

### IAM Authentication

```python
import boto3

def get_dsql_token(cluster_endpoint: str, region: str) -> str:
    client = boto3.client('dsql', region_name=region)
    return client.generate_db_connect_auth_token(
        Hostname=cluster_endpoint,
        Region=region,
        ExpiresIn=900  # 15 minutes max
    )
```

### Language-Specific Drivers

| Language | Recommended Driver | DSQL Connector |
|---|---|---|
| Python | psycopg2 / asyncpg | aurora-dsql-python |
| TypeScript/JS | pg (node-postgres) | aurora-dsql-js |
| Go | pgx | aurora-dsql-go |
| Java | JDBC PostgreSQL | aurora-dsql-java |
| Rust | tokio-postgres | aurora-dsql-rust |

Prefer the DSQL Connector when available, because it handles IAM token refresh and connection management.
Bare drivers (`pg`, `psycopg2`, `pgx`) work until the first 15-minute token expiry, then every new
connection fails auth. Use the Connector or implement token refresh yourself before shipping.

## Multi-Tenant Patterns

### Schema-Per-Tenant (Strong Isolation)

```sql
-- Create tenant schema
CREATE SCHEMA tenant_abc;

-- Create tables in tenant schema
CREATE TABLE tenant_abc.orders (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  product TEXT NOT NULL,
  amount NUMERIC(10,2) NOT NULL
);

-- Grant access to tenant role
GRANT USAGE ON SCHEMA tenant_abc TO role_tenant_abc;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA tenant_abc TO role_tenant_abc;
```

### Shared Table with Tenant Column (Cost-Efficient)

```sql
CREATE TABLE orders (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  product TEXT NOT NULL,
  amount NUMERIC(10,2) NOT NULL
);
CREATE INDEX ASYNC idx_orders_tenant ON orders (tenant_id);

-- Include tenant_id in every query (it scopes the row to one tenant)
SELECT * FROM orders WHERE tenant_id = 'abc' AND amount > 100;
```

**Rules:**
- Include `tenant_id` in every WHERE clause, because a query without it reads across tenants; build it with
  parameter binding (`$1`), never string interpolation
- Authorize the caller against that `tenant_id` before querying. Format validation (regex,
  allowlist) alone is not authorization: a well-formed `tenant_id` the caller doesn't own is
  still a cross-tenant leak
- When `psql -c` or any other raw-SQL path is unavoidable, validate every untrusted value with
  a dedicated check per kind: allowlist/regex for values, identifier-grammar check for
  table/column names, membership check for sort direction keywords (`ASC`/`DESC`)

## Application-Layer Referential Integrity

Since DSQL doesn't support foreign keys:

```python
async def create_order_item(order_id: str, item_data: dict):
    # Step 1: Verify parent exists
    result = await query("SELECT id FROM orders WHERE id = $1", order_id)
    if not result:
        raise ValueError(f"Order {order_id} not found")

    # Step 2: Insert child
    await execute(
        "INSERT INTO order_items (order_id, product, quantity) VALUES ($1, $2, $3)",
        order_id, item_data['product'], item_data['quantity']
    )

async def delete_order(order_id: str):
    # Step 1: Check for dependents
    count = await query("SELECT COUNT(*) FROM order_items WHERE order_id = $1", order_id)
    if count > 0:
        raise ValueError(f"Order {order_id} has {count} items, delete them first")

    # Step 2: Delete parent
    await execute("DELETE FROM orders WHERE id = $1", order_id)
```

## Troubleshooting

| Error | Cause | Fix |
|---|---|---|
| OCC serialization error | Concurrent writes to same row | Retry transaction; reduce contention |
| Transaction too large | >3,000 rows or >10 MiB | Split into smaller batches |
| Connection refused | Token expired or wrong endpoint | Refresh IAM token |
| Index creation stuck | ASYNC index still building | Check pg_stat_all_indexes; wait |
| ALTER COLUMN TYPE failed | Not supported in DSQL | Use table recreation pattern |
| Foreign key error | Not supported in DSQL | Implement in application code |
