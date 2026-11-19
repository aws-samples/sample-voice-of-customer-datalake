# CI/CD Anti-Patterns

| # | Anti-Pattern | Impact | Fix |
|---|---|---|---|
| 1 | No `permissions` block | Over-permissive token | Add explicit permissions |
| 2 | Actions pinned to tag | Supply chain risk | Pin to full SHA |
| 3 | Stored AWS access keys | Credential leak risk | Use OIDC |
| 4 | No `concurrency` group | Duplicate runs waste money | Add concurrency with cancel |
| 5 | No path filters | Every push triggers all workflows | Add `paths:` filter |
| 6 | Matrix combinatorial explosion | 20+ jobs from 3 variables | Limit with `exclude` or reduce axes |
| 7 | Secrets in logs | Credential exposure | Mask dynamic values |
| 8 | No `--frozen-lockfile` | Non-deterministic installs | Always use frozen/locked installs |
| 9 | Cancel in-progress deployments | Broken deployment state | `cancel-in-progress: false` for deploys |
| 10 | Missing `always()` on cleanup | Resources not cleaned up | Use `if: always()` for teardown |
