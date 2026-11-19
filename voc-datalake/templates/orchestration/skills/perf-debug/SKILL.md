---
name: perf-debug
description: "Application performance diagnosis for slow code, latency, CPU or memory growth, event-loop blocking and slow queries. Profiling in Python and Node, tracing, load testing on loopback, connection pools, caches and observability code."
source: "ai-skill-factory 2.0.0 (Amit Deol), skills/perf-debug"
license: MIT
adapted: "Profiling runs in the sandbox: commands are run's argv (no shell pipes or pgrep), profilers come from the repository's dev dependencies (installing one is the install step), attaching to a running process may be refused, and load tests target loopback only. Production measurements and monitoring are a person's or code the agent writes. GPU references (an unvendored skill) are dropped; slash references name library skills."
---

Diagnose the performance problem your task names.

Default: detect stack from config files, profile entry points. You work in a sandbox with no network: what you
measure is the code on your checkout under a local load; production numbers come from the task or the issue, or
are a person's to measure.

## Step 1: Triage

Before profiling, classify the symptom.

| Symptom | Likely Layer | Start Here |
|---|---|---|
| Slow API response (> 500ms) | Application | Step 2 (profiling) |
| High CPU, normal latency | Compute-bound | Step 3 (CPU profiling) |
| Growing memory, eventual OOM | Memory leak | Step 4 (memory profiling) |
| Intermittent spikes | External dependency | Step 5 (tracing) |
| Slow under load, fine alone | Concurrency | Step 6 (load testing) |
| Slow database queries | Data layer | Step 7 (query analysis) |
| Event loop blocked (async) | Blocking call in async code | Step 3 (async debug mode) |
| Infrastructure timeout | Deployment | Use the `cdk-doctor` skill |

## Step 2: Latency Breakdown

Measure before optimizing. Identify WHERE time is spent.

### Python

Each line is one `run` (argv, no shell: no pipes, no `$(...)`); a profiler the repository does not have is a
dependency decided before your first command (`install_dependencies`).

```bash
# Quick: function-level timing (no instrumentation); read the top of the sorted output
python3 -m cProfile -s cumulative app.py

# Detailed: line-level profiling (line-profiler installed)
kernprof -l -v app.py

# Statistical sampling of a command it starts (py-spy installed; it may need ptrace, which the sandbox can refuse:
# then fall back to cProfile)
py-spy record -o flame.svg -- python app.py
```

### TypeScript/Node

```bash
# Built-in profiler: run, then process the isolate log it wrote (two runs)
node --prof app.js
node --prof-process <isolate-....log>

# Flame graph (0x installed in the repository)
node_modules/.bin/0x app.js

# Clinic.js auto-diagnosis (installed in the repository)
node_modules/.bin/clinic doctor -- node app.js
```

### Latency Attribution Template

After profiling, fill this table:

```
| Phase | Time (ms) | % Total | Bottleneck? |
|---|---|---|---|
| Request parsing | 2 | 1% | No |
| Auth/middleware | 15 | 5% | No |
| Database query | 180 | 60% | YES |
| Business logic | 20 | 7% | No |
| Serialization | 8 | 3% | No |
| Network/I/O | 75 | 25% | Maybe |
| Total | 300 | 100% | |
```

## Step 3: CPU Profiling

Detailed tool reference: `references/profiling-tools.md`.

### Python

| Tool | Overhead | Best For |
|---|---|---|
| py-spy | < 1% | Production sampling, flame graphs |
| scalene | 10-20% | CPU + memory + GPU combined |
| cProfile | ~30% | Development, function-level |
| line_profiler | ~50% | Hot function line-by-line |

### TypeScript/Node

| Tool | Overhead | Best For |
|---|---|---|
| clinic doctor | Low | Auto-diagnosis |
| 0x | Low | Flame graphs |
| node --prof | Low | V8 internal profiling |
| clinic flame | Low | Flame graph with source |

### Bottleneck Decision Tree

```
CPU > 80%?
  → Yes: Profile with py-spy/clinic → find hot function → optimize or cache
  → No: Not CPU-bound. Check I/O (Step 5) or memory (Step 4)

Hot function identified?
  → Algorithm issue: Reduce complexity (O(n^2) → O(n log n))
  → Repeated work: Add memoization or caching
  → Serialization: Switch format (JSON → msgpack/protobuf)
  → Regex in loop: Compile once outside loop
```

### Async Event Loop Blocking

```bash
# Python: enable asyncio debug mode
PYTHONASYNCIODEBUG=1 python3 app.py
# Logs warnings when callbacks take > 100ms

# Node: monitor event loop delay
node -e "const h = require('perf_hooks').monitorEventLoopDelay(); h.enable();
setInterval(() => { console.log('p99:', (h.percentile(99)/1e6).toFixed(1), 'ms'); h.reset(); }, 5000);"
```

Common blockers: synchronous file I/O, CPU-heavy computation, blocking DB drivers, `time.sleep()` in async context. Fix by offloading to thread pool (`asyncio.to_thread()`, `loop.run_in_executor()`).

## Step 4: Memory Profiling

### Python

```bash
# Trace allocations (development)
python3 -c "
import tracemalloc
tracemalloc.start()
# ... run code ...
snapshot = tracemalloc.take_snapshot()
for stat in snapshot.statistics('lineno')[:10]:
    print(stat)
"

# Low-overhead memory profiling (sampling mode; benchmark before enabling in prod)
pip install memray && memray run --follow-fork app.py && memray flamegraph memray-*.bin
```

### Leak Detection Checklist

- [ ] Growing RSS over time (`ps -o rss -p PID` every 60s)
- [ ] Unclosed file handles (`lsof -p PID | wc -l`)
- [ ] Accumulating objects (`objgraph.show_growth()` in Python)
- [ ] Event listener leaks (Node: `process._getActiveHandles().length`)
- [ ] Circular references preventing GC
- [ ] Global caches without size limits (unbounded dict/Map)
- [ ] Connection pool exhaustion (all connections checked out, none returned)


## Step 5: Distributed Tracing

### Setup (OpenTelemetry)

```python
# Python: auto-instrumentation
pip install opentelemetry-distro opentelemetry-exporter-otlp
opentelemetry-bootstrap -a install
opentelemetry-instrument --service_name my-service python3 app.py
```

```typescript
// Node: auto-instrumentation
// npm install @opentelemetry/auto-instrumentations-node
import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
const sdk = new NodeSDK({ instrumentations: [getNodeAutoInstrumentations()] });
sdk.start();
```

### AWS X-Ray (alternative)

```bash
# Python: pip install aws-xray-sdk
# Instrument: from aws_xray_sdk.core import xray_recorder
# Patch libraries: from aws_xray_sdk.core import patch_all; patch_all()
```

### What to Trace

| Span | Why |
|---|---|
| HTTP handler entry/exit | Total request time |
| Database queries | Query latency + connection wait |
| External API calls | Third-party latency |
| Cache get/set | Hit rate + overhead |
| Queue publish/consume | Async processing delay |
| File I/O | Disk latency |

## Step 6: Load Testing

### Tools

| Tool | Language | Best For |
|---|---|---|
| locust | Python | Scripted user flows, distributed |
| k6 | Go (JS scripts) | High-throughput HTTP, CI-friendly |
| vegeta | Go | Simple HTTP load, constant rate |
| autocannon | Node | HTTP benchmarking |

### Quick Load Test

On loopback only, against a server you started in the sandbox, short and bounded (the sandbox has no network and a
time limit per command). A load test of a deployed environment is a person's.

```bash
# k6: 50 virtual users for 30 seconds
k6 run --vus 50 --duration 30s script.js

# locust: headless mode
locust -f locustfile.py --headless -u 100 -r 10 --run-time 60s

# vegeta: constant 200 req/s for 30s (targets from a file: no pipe)
vegeta attack -targets=targets.txt -rate=200 -duration=30s -output=results.bin
vegeta report results.bin
```

### What to Measure

Adjust targets to your SLA. These are starting points, not universal truth.

| Metric | Typical Target | Red Flag |
|---|---|---|
| p50 latency | < 100ms (API), < 1s (batch) | > 2x your SLA |
| p95 latency | < 500ms | > 5x your SLA |
| p99 latency | < 1s | > 10x p50 |
| Error rate | < 0.1% | > 1% |
| Throughput | Stable under target load | Drops under load |
| CPU/memory | Linear growth | Exponential growth |

## Step 7: Query and Data Layer

### Slow Query Detection

```bash
# PostgreSQL: enable slow query log
# SET log_min_duration_statement = 100;  -- log queries > 100ms

# MySQL: slow query log
# SET GLOBAL slow_query_log = ON;
# SET GLOBAL long_query_time = 0.1;

# SQLAlchemy: log all queries
# engine = create_engine(url, echo=True)
```

### Common Fixes

| Pattern | Problem | Fix |
|---|---|---|
| N+1 queries | Loop with individual DB calls | Batch query or JOIN (cross-ref: code-review Step 6) |
| Missing index | Full table scan on WHERE clause | Add index on filtered columns |
| SELECT * | Fetching unused columns | Select only needed columns |
| No connection pool | New connection per request | Use pool (SQLAlchemy, pgBouncer, HikariCP) |
| Unbounded query | No LIMIT on list endpoints | Add pagination |
| No prepared statements | Query parsing on every call | Use parameterized queries |

## Step 8: Connection Pooling

### Pool Sizing (depends on workload type)

| Workload | Formula | Example (8 cores) |
|---|---|---|
| Blocking I/O (sync DB) | `cores * 2` | 16 connections |
| Async I/O (FastAPI, Node) | `cores / 2` to `cores` | 4-8 connections |
| Serverless (Lambda) | 1 per invocation | Use RDS Proxy or PgBouncer |

Async frameworks hold connections briefly. Oversized pools waste server resources and cause "too many connections" errors. Start small, measure `pool_waiting` metric, increase only if waiting > 0.

### Pool Health Checklist

- [ ] Pool size matches workload type (async vs blocking)
- [ ] Idle timeout configured (close stale connections)
- [ ] Max lifetime set (prevent stale server-side connections)
- [ ] Wait timeout set (fail fast, not hang, if pool exhausted)
- [ ] Monitoring: active, idle, waiting counts
- [ ] Exhaustion behavior: returns 503 (not infinite hang)
- [ ] Serverless: uses connection proxy (RDS Proxy, PgBouncer)

## Step 9: Observability Setup

### Metrics (Prometheus pattern)

```python
from prometheus_client import Histogram, Counter, Gauge

# RED metrics (Rate, Errors, Duration)
request_duration = Histogram("http_request_duration_seconds", "Request latency", ["method", "endpoint"])
request_errors = Counter("http_request_errors_total", "Request errors", ["method", "endpoint", "status"])
request_rate = Counter("http_requests_total", "Request count", ["method", "endpoint"])

# USE metrics (Utilization, Saturation, Errors) for resources
pool_utilization = Gauge("db_pool_active_connections", "Active DB connections")
pool_saturation = Gauge("db_pool_waiting_requests", "Requests waiting for connection")
```

### Alerting Thresholds

| Metric | Warning | Critical |
|---|---|---|
| p95 latency | > 2x baseline | > 5x baseline |
| Error rate | > 1% | > 5% |
| CPU utilization | > 70% sustained | > 90% sustained |
| Memory utilization | > 80% | > 95% |
| DB pool waiting | > 0 for 1 min | > 10 for 1 min |
| Disk I/O wait | > 20% | > 50% |


## Step 10: Report

Put this in your `finish` summary (a hunter: in the finding or the fix task it posts):

```
## Performance Debug: [target]

### Symptom: [description]
### Root Cause: [identified bottleneck]
### Severity: CRITICAL / HIGH / MEDIUM / LOW

### Latency Breakdown
| Phase | Time (ms) | % Total | Action |
|---|---|---|---|

### Findings
| # | Category | Issue | Fix | Impact |
|---|----------|-------|-----|--------|
| 1 | Query | N+1 in /api/users | Batch with IN clause | -200ms p50 |
| 2 | Pool | No connection pool | Add SQLAlchemy pool_size=16 | -50ms p95 |

### Metrics Before/After
| Metric | Before | After | Improvement |
|---|---|---|---|
| p50 latency | 300ms | 80ms | 73% |
```

## Self-Check

- [ ] Profiled before optimizing (measured, not guessed)
- [ ] Identified the actual bottleneck layer (not optimized wrong thing)
- [ ] Cross-referenced the `anti-slop` skill for code-level patterns (N+1, async consistency)
- [ ] Cross-referenced the `cdk-doctor` skill for infrastructure timeouts
- [ ] Load tested under realistic concurrency on loopback, or the load test named for a person
- [ ] Monitoring in place to detect regressions
