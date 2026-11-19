# Sources

Non-obvious claims verified against AWS documentation and the official AWS `aurora-dsql`
agent skill (via `aws___retrieve_skill`). Checked 2026-10-28.

| Claim | Source | Checked |
|---|---|---|
| Aurora DSQL limits: 3,000 rows/transaction, 10 MiB/transaction, 24 indexes/table, 8 columns/index, 10,000 connections/cluster | https://docs.aws.amazon.com/aurora-dsql/latest/userguide/CHAP_quotas.html | 2026-10-28 |
| Aurora DSQL max connection duration 60 min, IAM auth token expiry 15 min | official `aurora-dsql` AWS agent skill (`aws___retrieve_skill`) | 2026-10-28 |
| Bare Postgres drivers (no DSQL Connector) fail auth on every new connection after the first 15-minute token expiry | official `aurora-dsql` AWS agent skill (`aws___retrieve_skill`) | 2026-10-28 |
| `boto3.client('dsql').generate_db_connect_auth_token(...)` is a real, current API | https://docs.aws.amazon.com/boto3/latest/reference/services/dsql/client/generate_db_connect_admin_auth_token.html | 2026-10-28 |
| QLDB reached end of support; no new ledger workloads should target it | https://docs.aws.amazon.com/cdk/api/v1/java/software/amazon/awscdk/services/qldb/package-summary.html (deprecated), cross-checked against the AWS QLDB migration guidance | 2026-10-28 |
| Aurora Serverless v2 ACU range, DynamoDB transaction/batch limits (100 items/4MB transact, 25/16MB batch write, 100/16MB batch get) | existing AWS SDK/API docs, unchanged since last review | 2026-10-28 |
