---
name: databases-on-aws
description: "Guides database work on AWS (DynamoDB, Aurora and RDS, Aurora DSQL, caches): choosing a database, schema and index design, query optimisation, multi-tenant data layers, migration planning. Read it when writing or reviewing a data model, queries or a migration."
source: "ai-skill-factory 2.0.0 (Amit Deol), skills/databases-on-aws"
license: MIT
adapted: "Discovery uses read_file, list_files and run's grep on the manifests and config, never the .env files (they hold secrets). Migrations are planned and written in code; running one against a database is a person's step. Slash references name library skills; deploy-on-aws (not vendored) is dropped. The report goes in the finish or as findings; description and emphasis reworded for Claude 5.5 skill discovery"
---

Database guidance for your task.

## Step 1: Detect Database Context

Look at the project's database usage with `read_file`, `list_files`, and `run` with `grep`:

- ORM and database libraries in `package.json`, `pyproject.toml`, `Cargo.toml`, `go.mod` (prisma, typeorm,
  sequelize, sqlalchemy, diesel, gorm, knex)
- Connection settings in `config/` and the infrastructure code (`DATABASE_URL`, `DB_HOST`, `MONGO_URI`,
  `REDIS_URL`, dynamodb, dsql). Never read `.env` files: they hold secrets, not design.
- Schema files: `prisma/schema.prisma`, `alembic/`, `migrations/`

Determine: current database, ORM, access patterns, data model.

## Step 2: Database Selection

### Decision Matrix

| Requirement | Best Fit | Why |
|---|---|---|
| Key-value, <10ms latency | DynamoDB | Single-digit ms at any scale, serverless |
| Relational, complex joins | Aurora PostgreSQL/MySQL | Managed RDS, read replicas, auto-scaling |
| Relational, serverless + distributed | Aurora DSQL | PostgreSQL-compatible, serverless, multi-region |
| Document store, flexible schema | DocumentDB | MongoDB-compatible, managed |
| In-memory cache | ElastiCache (Redis/Valkey) | Sub-ms latency, session store, leaderboards |
| Full-text search | OpenSearch | Log analytics, search, dashboards |
| Graph relationships | Neptune | Social networks, fraud detection, knowledge graphs |
| Time-series data | Timestream | IoT metrics, DevOps monitoring |
| Ledger / immutable history | Aurora PostgreSQL, append-only with a hash chain | Audit trails, supply chain. QLDB support ended 31 July 2025 |
| Wide-column, Cassandra-compatible | Keyspaces | Managed Cassandra |

### Selection Rules

- Default to **DynamoDB** for new serverless apps (pairs naturally with Lambda)
- Use **Aurora Serverless v2** when you need SQL joins and transactions
- Use **Aurora DSQL** when you need serverless + distributed SQL + multi-region
- Use **ElastiCache** as a caching layer, not a primary database
- Don't pick a database based on familiarity alone, match the access pattern

### Cost Comparison (dev tier)

| Service | Config | Est. Monthly |
|---|---|---|
| DynamoDB | On-demand, 1M reads/writes | ~$1.25 |
| Aurora Serverless v2 | 0.5-1 ACU, 10GB | ~$45 |
| Aurora DSQL | Serverless, light usage | ~$10 |
| ElastiCache | cache.t3.micro | ~$12 |
| DocumentDB | db.t3.medium | ~$55 |

## Step 3: DynamoDB Patterns

### Single-Table Design

```
PK              | SK                  | Data
USER#123        | PROFILE             | { name, email, ... }
USER#123        | ORDER#2024-001      | { total, status, ... }
USER#123        | ORDER#2024-002      | { total, status, ... }
ORG#456         | METADATA            | { name, plan, ... }
ORG#456         | MEMBER#USER#123     | { role, joinedAt, ... }
```

### Access Pattern → Index Design

| Access Pattern | Key Condition | Index |
|---|---|---|
| Get user profile | PK=USER#id, SK=PROFILE | Table |
| List user orders | PK=USER#id, SK begins_with ORDER# | Table |
| Get order by ID | GSI1PK=ORDER#id | GSI1 |
| List org members | PK=ORG#id, SK begins_with MEMBER# | Table |
| Query by status | GSI2PK=STATUS#active | GSI2 |

### DynamoDB Best Practices

- [ ] Design for access patterns first, not entity relationships
- [ ] Use composite sort keys for hierarchical data
- [ ] Prefer `Query` over `Scan` (Scan reads entire table)
- [ ] Use sparse GSIs (only items with the GSI key are indexed)
- [ ] Enable point-in-time recovery
- [ ] Use on-demand billing for variable workloads, provisioned for predictable
- [ ] Set TTL for ephemeral data (sessions, caches, logs)
- [ ] Use DynamoDB Streams for change data capture (not polling)
- [ ] Batch writes with `BatchWriteItem` (max 25 items, 16MB)
- [ ] Use `TransactWriteItems` for multi-item atomic operations (max 100 items)

### DynamoDB Anti-Patterns

| # | Anti-Pattern | Fix |
|---|---|---|
| 1 | Hot partition (single PK gets all traffic) | Distribute with write sharding |
| 2 | Scan for queries | Add GSI matching the access pattern |
| 3 | Large items (>400KB) | Store large blobs in S3, reference in DynamoDB |
| 4 | No TTL on ephemeral data | Set TTL attribute |
| 5 | Relational modeling (many GSIs for joins) | Consider Aurora if you need joins |

## Step 4: Aurora / RDS Patterns

### Aurora Serverless v2

```typescript
// CDK: Aurora Serverless v2
const cluster = new rds.DatabaseCluster(this, 'Database', {
  engine: rds.DatabaseClusterEngine.auroraPostgres({
    version: rds.AuroraPostgresEngineVersion.VER_15_4,
  }),
  serverlessV2MinCapacity: 0.5,
  serverlessV2MaxCapacity: 4,
  writer: rds.ClusterInstance.serverlessV2('writer'),
  readers: [rds.ClusterInstance.serverlessV2('reader', { scaleWithWriter: true })],
  vpc,
  defaultDatabaseName: 'myapp',
  enableDataApi: true,  // For Lambda integration
  removalPolicy: RemovalPolicy.RETAIN,
});
```

### Connection Management

| Compute | Connection Method | Why |
|---|---|---|
| Lambda | RDS Data API or RDS Proxy | Avoid connection exhaustion |
| Fargate | Direct connection + pool | Long-lived connections OK |
| EC2 | Direct connection + pool | Long-lived connections OK |

### Schema Migration Best Practices

- [ ] Use a migration tool (Prisma Migrate, Alembic, Flyway, Knex)
- [ ] Never run DDL in application code
- [ ] Test migrations against a copy of production data
- [ ] Use blue-green deployments for breaking schema changes
- [ ] Add columns as nullable first, backfill, then add constraints
- [ ] Never drop columns in the same release that stops writing to them

## Step 5: Aurora DSQL Patterns

### Key Constraints

| Constraint | Limit |
|---|---|
| Max rows per transaction | 3,000 |
| Max data size per transaction | 10 MiB |
| Max transaction duration | 5 minutes |
| Max connections per cluster | 10,000 |
| Max indexes per table | 24 |
| Foreign keys | Not supported (use application-layer) |
| ALTER COLUMN TYPE / DROP COLUMN | Not supported (use table recreation) |

### DSQL Best Practices

- [ ] Use IAM authentication (not passwords)
- [ ] One DDL statement per transaction
- [ ] Use `CREATE INDEX ASYNC` (never synchronous)
- [ ] Store arrays/JSON as TEXT columns
- [ ] Implement referential integrity in application code
- [ ] Batch operations under 3,000 rows
- [ ] Use DSQL Connector library when available for your language

### Multi-Tenant Pattern (DSQL)

```sql
-- Schema-per-tenant for strong isolation
CREATE SCHEMA tenant_abc;
CREATE TABLE tenant_abc.orders (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  product TEXT NOT NULL,
  amount NUMERIC(10,2) NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX ASYNC ON tenant_abc.orders (tenant_id);
```

## Step 6: Caching Patterns

### Cache-Aside (Lazy Loading)

```
1. Check cache (ElastiCache)
2. If miss → query database
3. Write result to cache with TTL
4. Return result
```

### Write-Through

```
1. Write to database
2. Write to cache
3. Return result
```

### Cache Invalidation Strategy

| Pattern | When to Use | Complexity |
|---|---|---|
| TTL-based | Read-heavy, eventual consistency OK | Low |
| Write-through | Strong consistency needed | Medium |
| Event-driven (DynamoDB Streams → Lambda → cache) | Real-time invalidation | Medium |
| Cache-aside + short TTL | Balance of freshness and simplicity | Low |

## Step 7: Migration Planning

### Migration Checklist

- [ ] Inventory current schema, data volume, access patterns
- [ ] Map source types to target types
- [ ] Plan for downtime window or zero-downtime migration
- [ ] Test migration on copy of production data
- [ ] Validate row counts and data integrity post-migration
- [ ] Update connection strings and ORM configs
- [ ] Run application integration tests against new database
- [ ] Plan rollback procedure

### Common Migration Paths

| From | To | Tool |
|---|---|---|
| MySQL/PostgreSQL (self-hosted) | Aurora | AWS DMS |
| MongoDB | DocumentDB | AWS DMS |
| Cassandra | Keyspaces | AWS DMS |
| PostgreSQL | Aurora DSQL | Manual (schema + data) |
| DynamoDB → DynamoDB (cross-account) | DynamoDB | AWS Backup or export/import |

## Report

A reviewer writes each row as a finding (`write_findings`); a builder puts the summary in its finish.

```
## Database Review: [target]

### Current Stack: [database] + [ORM] + [compute]
### Summary: X MUST / Y SHOULD / Z NIT

| # | Category | Check | Status | Details |
|---|----------|-------|--------|---------|
```

## Self-Check

- [ ] Database choice matches access patterns (not just familiarity)
- [ ] Connection management appropriate for compute type
- [ ] Encryption enabled (at rest and in transit)
- [ ] Backup/recovery configured (PITR, snapshots)
- [ ] Multi-tenant isolation enforced
- [ ] No N+1 query patterns
- [ ] Indexes match query patterns
- [ ] Migration plan includes rollback

For security hardening, see the `aws-security` skill.
For performance profiling, see the `perf-debug` skill.
For database selection details, see `references/selection-guide.md`.
For DynamoDB advanced patterns, see `references/dynamodb-patterns.md`.
For Aurora DSQL specifics, see `references/dsql-guide.md`.
For verified sources on claims in this skill, see `references/sources.md`.

The run writes migrations and their rollback as code and tests them against what the sandbox can run (an in-memory
or local engine); applying one to a real database is a person's step after the merge.
