# Lambda sizing policy and measurement

How every `voc-*` Lambda is sized, how to check it against production, and how to run AWS Lambda Power
Tuning safely when the check flags a function. The rule, the function classes and the pinned sizes live in
one file, `voc-datalake/lib/sizing/policy.ts`; `lib/lambda-memory.test.ts` fails on any drift from it.

## The rule (owner-approved 2026-10-18: 60 % for memory and CPU)

AWS publishes no utilisation target; 60 % is our trigger for a raise. A blanket 50 % was rejected: most handlers
wait on DynamoDB or Bedrock, so doubling memory mostly doubles cost.

| Resource | Measured as | Ceiling |
|---|---|---|
| Memory | **Peak** `max_memory_used` / MemorySize over the window (REPORT lines), not p95 | **60 %**, every class |
| CPU | Over the invocations that ran **≥ 100 ms only**: the worse of (a) the wall-weighted share and (b) the p95 share | **60 %** |

- **History.** 2026-10-05: 70 % for memory and CPU, 60 % for variable-payload peak memory. 2026-10-07: the CPU
  half counts only calls ≥ 100 ms (below). 2026-10-18: both ceilings 60 % for every class (`SIZING_CEILING_PCT`).
- **Share** = CPU time / (wall time × MemorySize / 1,769 MB). Lambda allocates one vCPU at 1,769 MB, so a
  single-threaded Python handler gains nothing above it.
- **Insufficient data:** fewer than **20** calls ≥ 100 ms in the window (`CPU_MIN_LONG_CALLS`). The report lists
  the function; it is not a breach.
- **Power Tuning pins** (`POWER_TUNED` in `policy.ts`, one record per run: date, method, duration per size, pick,
  pinned size) override the CPU rule at the pinned size. Peak memory is still judged there, and a pin only covers
  the size it pinned. A **superseded** pin (the owner later moved the function off it) is kept as history and
  waives nothing: all six 2026-10-06 pins were superseded on 2026-10-18 (below).
- **Variable-payload** functions are the ones whose memory grows with what a caller sends or a batch holds
  (they had the stricter 60 % memory ceiling before every class moved to 60 %; still listed for the reason):
  manual import (API and processor), the feedback processor, the aggregation processor, the memory extractor,
  the document/persona generators, the persona importer, the document merger, category reprocess, the S3-import
  ingestor and the product-doc extractor (`VARIABLE_PAYLOAD` in `policy.ts`, each with its reason).
- **CPU not measured by design:** the inline MCP token authorizer and the two deploy-time custom resources
  (`CPU_NOT_MEASURED`). Every other function logs the CPU line below.
- **One step** is one rung of `MEMORY_STEPS_MB` (128, 256, 512, 1024, 1536, 1769, 2048, 3008).

### Why short calls no longer count (2026-10-07)

Until 2026-10-07 the weighted figure (a) covered every invocation. The Power Tuning run of 2026-10-06 (below)
showed what that measures. On six API functions the `invocation_cost` lines put the weighted share at
**87–95 % at 1,024 MB** (101–162 % at 512 MB), while the measured duration did not improve with more memory:

- metrics: 21.9 ms at 1,024 MB, 21.8 ms at 1,536 MB;
- projects: 36.5 ms vs 35.1 ms;
- agents: 8.2 ms vs 8.3 ms;
- settings: 7.6 ms vs 7.8 ms.

Those calls are 8–50 ms warm reads, CPU-busy for their whole wall time at any size. A high share there is not a
constraint, so the old rule would have pushed every API Lambda to 1,536 MB for no measured gain. Counting only
calls of 100 ms or more keeps the rule about the calls where more CPU can shorten the wait. A function that rarely
makes such calls is reported as insufficient data rather than sized from noise. Where a Power Tuning curve exists,
it measured directly what the share only estimates, so its pin wins.

## The CPU line

Lambda's REPORT line carries memory and duration but no CPU, X-Ray is off and Lambda Insights is not
installed, so every function logs one structured line per invocation:

```json
{"message": "invocation_cost", "cpu_ms": 12.3, "wall_ms": 840.0, "function_memory_size": 1024, "cpu_pct_of_allocation": 2.5}
```

Numbers only, never a payload. Python: `lambda/shared/invocation_cost.py` (`@measure_invocation_cost`,
applied by `api_handler`, `instrumented_handler` — the shared four-decorator entry stack the worker and job
handlers use — `batch_lambda_handler` and the agent `step_lambda_handler`; a test fails on any
`lambda_handler` that does not log it). The product-doc extractor, which cannot import `shared/`, carries a
lockstep-pinned stdlib mirror. TypeScript `voc-chat-stream`: `lambda/stream/src/lib/invocation-cost.ts`
(`process.cpuUsage()`), same fields.

## Run the check (read-only)

```bash
cd voc-datalake
scripts/capacity/capacity-query.sh --hours 168                 # judged at the deployed sizes
scripts/capacity/capacity-query.sh --hours 168 --repo-sizes    # judged at this checkout's sizes (before a resize deploys)
scripts/capacity/capacity-query.sh --hours 24 --json /tmp/capacity.json
```

It uses the operator's ambient AWS credentials (`AWS_REGION`, default us-west-2) for `lambda list-functions`,
`logs describe-log-groups` and three Logs Insights queries — nothing is written. It prints one row per
function, then the unmeasured functions, the CPU-insufficient-data list, the Power-Tuning-pinned list and the
by-design exceptions, and exits 1 on a breach (2 on an error).
Results are grouped by MemorySize, so a window that spans a resize never mixes sizes; a function measured only
at an older size is projected (`… (from 512 MB)`). The same check runs as an e2e spec:
`E2E_OPS=1 npx playwright test -c playwright.ops.config.ts` from `frontend/e2e` (with the post-deploy health
checks, see `frontend/e2e/README.md`).

The queries, if you want them in the console:

```
filter @type = "REPORT"
| stats count() as n, max(@maxMemoryUsed / @memorySize * 100) as peakPct by @log, @memorySize

filter message = "invocation_cost"
| stats count() as n by @log, function_memory_size

filter message = "invocation_cost" and wall_ms >= 100
| stats count() as n, sum(cpu_pct_of_allocation * wall_ms) / sum(wall_ms) as weightedPct,
  pct(cpu_pct_of_allocation, 95) as p95 by @log, function_memory_size
```

**Unmeasured is not OK.** A function with no REPORT or `invocation_cost` line in the window has not been
judged. Re-measure after a run that exercises it (the e2e tracks s1–s3 cover ingestion, research, merge and
persona panels).

## When a function breaches

1. Raise it one step in its CDK builder, update its pin in `policy.ts` (`RAISED_FOR_CPU` or
   `RAISED_FOR_PEAK_MEMORY`), and add a CHANGELOG **Changed** bullet naming it.
2. When the cost matters (a frequently invoked function), size it from Power Tuning instead (below).

## AWS Lambda Power Tuning (policy step 2 — owner approval required)

70 % triggers an investigation; [Power Tuning](https://github.com/alexcasalboni/aws-lambda-power-tuning) gives the
cost-vs-duration curve that sets the final size. Candidates: ballots, settings, metrics, projects, memory-api,
agents. Compute Optimizer does not help: it supports x86_64 only and these functions are ARM64.

**It invokes the function for real** — every call can hit Bedrock and write to DynamoDB. So:

1. **Get owner approval first**, naming the functions, the payloads and the account.
2. **Prefer a non-production deployment** (a second stack prefix in a dev account, docs/deployment.md
   "Two Deployments in One Account and Region"). On production, use only e2e-safe payloads.
3. **Payloads:** a captured API Gateway event for a read route (`GET /metrics/summary?days=7`, `GET /settings/brand`,
   `GET /projects`), with the Cognito claims of the `e2e-admin` user. Never a write route, never a route that
   calls Bedrock unless that is the thing being sized.
4. Deploy the Power Tuning state machine from the Serverless Application Repository into the target account
   (it is NOT part of this app's five stacks — the stack count is capped).
5. Run it with:

   ```json
   {
     "lambdaARN": "arn:aws:lambda:us-west-2:<account>:function:voc-metrics-api-<account>-us-west-2",
     "powerValues": [512, 1024, 1536, 1769],
     "num": 50,
     "payload": { "...": "the captured read-route event" },
     "parallelInvocation": false,
     "strategy": "balanced"
   }
   ```

   `parallelInvocation: false` keeps it to one concurrent call (no throttling of real traffic). Power Tuning
   changes the function's memory while it runs and restores it at the end; do not run it during a deploy.
6. Read the curve, pick the size, then set it in the CDK builder and `policy.ts` — never leave a size that
   only exists in the console (the next deploy reverts it). Delete the Power Tuning stack afterwards.

### Run of 2026-10-06 (production, owner-approved)

SAR app 4.4.0 (the stack is named `serverlessrepo-voc-power-tuning`: SAR prefixes the name), `lambdaResource`
limited to `function:voc-*`, `num` 30, `parallelInvocation: false`, one function at a time. Payloads: GET
`/settings/categories` + `/settings/brand`; `/metrics/summary?days=30` + `/feedback?days=7`; `/projects`;
`/memory?scope=company` + `/memory/stats` (a route since removed); `/agents` + `/workflows`; ballots: the public
`/voting-sessions/{id}/config` with an unused well-formed id (a GetItem, no write — the facilitator GET needs a
real session, and creating one is a write).

| Function | 512 | 1,024 | 1,536 | 1,769 | 2,048 MB | Balanced pick | Decided |
|---|---|---|---|---|---|---|---|
| ballots | 7.0 ms | 5.8 | 6.1 | 6.0 | 6.1 | 512 | **1,024** (512 projects to 71.5 % CPU) |
| settings | 8.2 | 7.6 | 7.8 | 8.4 | 7.9 | 512 | 512 |
| metrics | 40.8 | 21.9 | 21.8 | 20.7 | 16.6 | 1,024 | 1,024 |
| projects | 54.0 | 36.5 | 35.1 | 36.7 | 34.1 | 1,024 | 1,024 |
| memory | 39.2 | 23.3 | 20.3 | 23.6 | 24.2 | 1,024 | 1,024 |
| agents | 10.9 | 8.2 | 8.3 | 7.7 | 7.9 | 1,024 | 1,024 |

Peak memory stayed ≤ 28 % at 512 MB for all six. Gains above 1,024 MB are within noise (metrics' 2,048 MB is
the only clear one, 22 → 17 ms, at +57 % cost), so nothing goes above one vCPU.

**Caveat for the CPU rule (resolved 2026-10-07).** The `invocation_cost` lines logged during the run put the
weighted CPU share at 87–95 % at 1,024 MB for all six (101–162 % at 512 MB), even where Power Tuning shows no
speed-up from more memory. That is why the rule now counts only calls of 100 ms or more, and why these six pins
override the CPU rule ("Why short calls no longer count" above). Ballots stays pinned at 1,024 MB: it was decided
under the old rule, and under the new one its ~6 ms calls give no CPU figure at all. Lowering it to the 512 MB
pick is open for the owner.

### Capacity under the refined rule (production, 7 days to 2026-10-07)

`scripts/capacity/capacity-query.sh --hours 168`, read-only, window 2026-09-30 05:08 → 2026-10-07 05:08 UTC.
Production runs the deployed (pre-release) sizes. Under the new rule:

- **Judged at the deployed sizes: 7 CPU breaches, no memory breach.** These are exactly the functions this release
  already raises:

  | Function | MB | CPU at ≥ 100 ms (weighted / p95) | Long calls |
  |---|---|---|---|
  | feedback-form | 256 | 84.4 / 89.8 % | 70 |
  | integrations | 256 | 85.0 / 101.5 % | 58 |
  | logs | 256 | 88.3 / 109.6 % | 21 |
  | settings | 256 | 79.7 / 98.7 % | 63 |
  | memory | 512 | 61.1 / 85.8 % | 59 |
  | metrics | 512 | 86.2 / 101.0 % | 254 |
  | projects | 512 | 61.2 / 100.5 % | 119 |

- **Judged at this release's sizes (`--repo-sizes`): no breach.**
  - Projected long-call CPU of the raised functions is 42–55 %.
  - The six Power Tuning pins are waived from the CPU rule. Their peak memory is ≤ 28 % at the pinned size, measured
    at those sizes in the run window.
- **Insufficient data (fewer than 20 calls ≥ 100 ms):** agents (18, deployed size), ballots (2), chat (3), data
  explorer (4), manual import (2), MCP tokens (7), research step (8), S3 import (4), scrapers (7). The old rule
  flagged most of these from their short calls alone.
- **Unmeasured:** 26 functions. Workers, jobs, ingestors and chat-stream logged no `invocation_cost` line in the
  window; the rest were never invoked. Same set as the 2026-10-06 run.
- **Peak memory:** highest 58.6 % standard (integrations, 256 MB) and 58.2 % variable-payload (manual import,
  256 MB); none over its ceiling.

### Upsize after the 3.00.00 production check (2026-10-07)

**Owner decision:** upsize only. Nothing is lowered now, including the Power Tuning picks below their pins (ballots
stays at 1,024 MB though the curve picked 512). Lowering is a later optimisation. No provisioned concurrency.

Evidence: `voc-e2e/verify/3.00.00/CAPACITY-REPORT.md` (read-only, production, since the 3.00.00 deploy
2026-10-07 09:19Z, plus the 7-day `capacity-query.sh --hours 168`). Integrations and feedback forms were already
raised to 1,024 MB from that report. The four below were "insufficient data" (11–13 calls ≥ 100 ms, under the
20-call floor), but both CPU figures were over 70 %, and the two scheduled workers will pass 20 calls within hours of
any window. So each goes up one rung now rather than after a confirming re-run.

| Function | Old → new MB | CPU at ≥ 100 ms, old size (weighted / p95, long calls) | Projected p95 at new size | Peak memory (old size) |
|---|---|---|---|---|
| voc-agent-heartbeat | 512 → 1,024 | 85.7 / 101.0 %, 13 | ≈ 50 % | 25.4 % |
| voc-logs-api | 512 → 1,024 | 86.0 / 105.1 %, 11 (256 MB: 88.3 / 109.6 %, 21) | ≈ 53 %, **but see below** | 27.3 % |
| voc-memory-scanner | 512 → 1,024 | 77.0 / 81.6 %, 13 | ≈ 41 % | 24.0 % |
| voc-mcp-tokens-api | 512 → 1,024 | 67.4 / 98.0 %, 11 (mostly first calls after a SnapStart restore) | ≈ 49 % | 24.6 % |

- **Projection** is old share × old MB / new MB. It assumes wall time stays the same and the CPU spreads thinner.
- **logs-api caveat.** Its share did not move from 256 to 512 MB, so wall time fell with the extra CPU. That means it
  is CPU-bound: more memory buys latency, and the share may stay over 70 % at 1,024 MB too (integrations behaved the
  same way). More rungs would not help much: past 1,769 MB a single-threaded handler gains nothing. Next step:
  re-measure at 1,024 MB. If it still breaches, Power Tune it (`GET /logs`, `GET /logs/errors`) and pin the result
  instead of climbing further.
- **One step was enough everywhere else** by projection, so none goes two rungs.

**Cost.** Every one of these is pay-per-use: a call's duration charge is GB × seconds, so doubling memory doubles
the per-call charge at the same duration. Where the function is CPU-bound, duration falls and the rise is smaller.
Arm duration price $0.0000133334 per GB-s (us-west-2), at the measured volume, worst case (duration unchanged):

| Function | Volume | Duration charge / month, old → new (worst case) |
|---|---|---|
| voc-agent-heartbeat | every 15 min, ≈ 2,900 runs, ≈ 0.7 s | ≈ $0.014 → $0.027 |
| voc-memory-scanner | every 15 min, ≈ 2,900 runs, ≈ 0.66 s | ≈ $0.013 → $0.026 |
| voc-logs-api | admin `/logs` page only, tens of calls a day, ≈ 0.4 s | < $0.01 → < $0.02 |
| voc-mcp-tokens-api | `/connect/tokens`, ≈ 40 calls in 3 h of e2e | < $0.01 → < $0.02 |

- **The one non-per-call cost: mcp-tokens' SnapStart cache.** The cache is billed per GB-s for as long as the
  published version is active, so it doubles with memory: $1.95 → $3.90 a month (+$1.95). Restores cost per GB
  restored and also double, but at about 10 a week that stays under $0.01/month.
- **Total:** about +$2/month, nearly all of it the SnapStart cache.

**Checked and not changed:**

| Function | Why not |
|---|---|
| voc-agent-conductor (1,024) | 72.8 / 83.0 % over only **4** long calls. Too few to size from; re-measure after more agent runs. |
| voc-mcp-global-api (256) | 70.8 / 79.7 % over only **5** long calls. A breach is plausible as MCP traffic grows; re-measure. |
| voc-manual-import-api (512) | 77.0 % on **1** long call. Re-measure after a manual import. |
| Power Tuning pins (metrics, projects, settings, agents, memory, ballots) | p95 73–95 % over their few long calls, but the pin waives the CPU rule (the curve measured duration directly). Peak memory ≤ 28 %. |
| voc-memory-extractor, voc-feedback-processor, voc-aggregation-processor | **No CPU measurement yet**: none logged `invocation_cost` in the 3.00.00 windows. Peak memory over 7 days is 12.5 / 14.7 / 28.9 % (ceiling 60 %). No evidence for a raise. |
| voc-ingestor-* (6) | Not invoked in 7 days (no REPORT line). No evidence. |
| Every other function | Under 70 % on both figures, or no long calls. |

## Upsize under the 60 % rule (owner, 2026-10-18)

**Owner decision:** the ceiling is 60 % for memory and CPU, every class. Raise every function over it, and every
API near it that the earlier rules excluded (Power-Tuning-pinned or insufficient data), one rung. The six
2026-10-06 Power Tuning pins stay in `POWER_TUNED` as history with `superseded` set; a superseded pin waives the CPU
rule at no size. Evidence: production, 2026-10-04 → 2026-10-18, `scripts/capacity/capacity-query.sh --hours 336`, CPU
p95 over calls ≥ 100 ms at the old size unless noted (each function's comment in `policy.ts`).

| Why | Function: old → new MB (figure) |
|---|---|
| Over 70 % | agent-conductor 1,024 → 1,536 (83.0), agent-heartbeat 1,024 → 1,769 (92.1), aggregation-processor 512 → 1,024 (88.7), briefing 1,024 → 1,769 (91.2), data-explorer-api 512 → 1,024 (91.7), email-intake 512 → 1,024 (87.0), feedback-processor 1,024 → 1,769 (90.9), integrations-api 1,024 → 1,536 (79.4), logs-api 1,024 → 1,769 (94.3), mcp-global-api 256 → 512 (80.7), memory-scanner 1,024 → 1,536 (84.9), radar-api 512 → 1,024 (93.9) |
| Over 60 % | research-step 1,536 → 1,769 (66.2), users-api 256 → 512 (63.2; peak memory 57.0 %) |
| Power Tuning pin superseded | metrics-api 1,024 → 1,536 (83.1), projects-api 1,024 → 1,536 (82.1), agents-api 1,024 → 1,769 (94.6), ballots-api 1,024 → 1,769 (90.9), memory-api 1,024 → 1,536 (73.7), settings-api 512 → 1,024 (96.4) |
| Insufficient data, over 60 % | manual-import-api 512 → 1,024 (77.0), s3-import-api 512 → 1,024 (72.0), scrapers-api 1,024 → 1,536 (78.2), webhook-github_issues 256 → 512 (84.8) |
| Peak memory near 60 % | mcp-token-authorizer 128 → 256 (57.8 % peak; inline Node authorizer, CPU not measured; since retired: the `/mcp/global` authorizer is now voc-mcp-global-api itself) |

- **Not changed:** the three assist twins (`voc-projects-assist`, `voc-settings-assist`, `voc-scrapers-assist`) keep
  their sizes. They were measured separately from the REST path and now pin their own `memorySize`
  (`createAssistWorker`). Email intake exists only with `-c inboundEmailDomain`, so its pin is
  `OPTIONAL_FUNCTION_SIZES` (with `--repo-sizes` the report reads `REPO_SIZES`).
- **SnapStart** (integrations, memory): the larger size publishes a new version, and the `live` alias follows it.
- **Two rungs to one vCPU (1,769 MB) where one rung was not enough:** at 1,536 MB, projected from the same window,
  agent-heartbeat (61.4), logs-api (62.9), briefing (60.8), feedback-processor (60.6), agents-api (63.1, from its
  production 1,024 MB p95) and ballots-api (60.6) would still be over 60 %, so the owner's "every function under
  60 %" took them to 1,769 MB, the last rung that adds CPU for a single-threaded handler. With `--repo-sizes` the
  report projects no breach. If one of them is still over 60 % at 1,769 MB, more memory cannot help: Power Tune it
  or make the code cheaper.
- **Cost (worst case, duration unchanged):** each function's duration charge rises with its size: +100 % for a
  doubling, +50 % for 1,024 → 1,536, +73 % for 1,024 → 1,769, +15 % for 1,536 → 1,769. At the measured volumes that is cents to a few dollars
  a month in total. The one fixed cost is the SnapStart cache on integrations and memory: 1.5 GB instead of 1 GB each,
  $3.90 → $5.85 a month each (+$3.90/month together). Restores scale the same way, still under $0.01/month.

## Doubled under the 60 % rule (owner, 2026-10-20)

**Owner decision:** double the memory of every function over the 60 % CPU ceiling in the 24 h window
2026-10-19T03:31Z → 2026-10-20T03:31Z (production, every invocation at the size it was doubled from). The figures are
the weighted / p95 share over calls ≥ 100 ms at the old size. `DOUBLED_2026_10_20` in `policy.ts` lists them; the sizes
are the owner's numbers, not rungs of `MEMORY_STEPS_MB`.

| Function | Old → new MB | CPU weighted / p95 % |
|---|---|---|
| voc-radar-api | 1,024 → 2,048 | 77.3 / 92.1 |
| voc-integrations-api | 1,536 → 3,072 | 49.7 / 75.8 |
| voc-projects-api | 1,536 → 3,072 | 56.0 / 75.4 |
| voc-metrics-api | 1,536 → 3,072 | 62.7 / 74.9 |
| voc-memory-scanner | 1,536 → 3,072 | 58.9 / 70.3 |
| voc-logs-api | 1,769 → 3,538 | 61.0 / 79.8 |
| voc-briefing | 1,769 → 3,538 | 63.8 / 72.6 |
| voc-agent-heartbeat | 1,769 → 3,538 | 61.0 / 69.5 |

- **What doubling buys.** Above 1,769 MB (one vCPU) single-threaded Python gets no more CPU. For logs, briefing and
  heartbeat (1,769 → 3,538), and for the part of the others above 1,769 MB, the doubling lowers the measured share
  (the allocation doubles) rather than speeding the code. With `--repo-sizes` the report projects every one under 60 %.
- **Next.** Re-measure in a few days with `scripts/capacity/capacity-query.sh --hours 168`. If a function still
  breaches at its new size, Power Tune it or make the code cheaper; do not keep doubling.
- **Cost.** All eight are pay-per-use, so the duration charge is roughly proportional to GB-seconds: about double per
  call where the duration does not change (the 1,769 → 3,538 trio, and most of the gain above one vCPU), less where
  the calls get faster. The fixed cost is the SnapStart cache on integrations: 3 GB instead of 1.5 GB, about
  $5.85 → $11.70 a month. No timeout, concurrency or other setting changed.

## Back to one vCPU (owner, 2026-10-23)

**Owner decision:** no single-threaded Python function sits above 1,769 MB (one vCPU). Every Python handler
runs on one core (the GIL; `shared/concurrency.py` threads only overlap network waits; the shared DynamoDB
client pools `MAX_IN_FLIGHT_READS` = 32 connections, every read one request's nested fan-out can have in flight,
since botocore's default 10 logged "Connection pool is full" on `/metrics/*`), so the 2026-10-20
doubling lowered the measured share without making a call faster. The CPU behind the breaches was made cheaper
instead, and the eight doubled functions went back to 1,769 MB (`CAPPED_AT_ONE_VCPU_2026_10_23` in `policy.ts`;
`lib/lambda-memory.test.ts` fails on any Python function above one vCPU).

What the CPU was (production `invocation_cost`, 7 days to 2026-10-23, profiled in a Lambda simulation: the
deployed bundle in the Lambda Python 3.14 arm64 image, CPU-capped to the function's share, against a local
DynamoDB):

| Where | What it was | Fix |
|---|---|---|
| First request of an environment (agents, radar, memory, integrations, logs, mcp-tokens APIs; heartbeat, memory scanner and briefing, which start cold on every tick) | Building the DynamoDB resource lazily: botocore walks its data directory (`list_available_services`, ~4,000 `stat` calls) and parses the models. Agents API: 133 ms CPU on a first request vs 8 ms warm | Built during INIT (`shared/warm_init.py`, on-demand and provisioned init only; SnapStart snapshots keep using `shared/snapstart.py`). Simulation: first-invoke CPU −75 to −85 %, warm unchanged |
| Every DynamoDB read of many items | botocore's model-driven parse of each `AttributeValue`, then boto3's second walk | One-pass decode of `Items` / `Responses` on the shared resource (`shared/dynamodb_fast_items.py`, values identical to boto3's) |
| `/feedback` and filtered metric walks | Full reviews read to count or filter | Projected walks, the page fetched by key: 0.1–0.6× the CPU |
| Aggregation processor on bulk deletes | One conditional write per record per counter | One per distinct counter per run of REMOVEs: about 1/7 of the CPU and duration; raised one step to 1,536 MB (68.8 % p95 at 1,024 MB) |
| `/logs/summary` | Up to 1,000 rows read and redacted per source to count them | `Select='COUNT'` |

| Function | 2026-10-20 → 2026-10-23 MB |
|---|---|
| voc-agent-heartbeat, voc-briefing, voc-logs-api | 3,538 → 1,769 |
| voc-metrics-api, voc-projects-api, voc-integrations-api, voc-memory-scanner | 3,072 → 1,769 |
| voc-radar-api | 2,048 → 1,769 |
| voc-aggregation-processor | 1,024 → 1,536 |

**Next.** Re-measure a week after the deploy (`scripts/capacity/capacity-query.sh --hours 168`). The window that
set these sizes held a bulk delete of ~58,850 aggregate rows and load tests. A function still over 60 % at one vCPU
needs cheaper code (or Power Tuning), never more memory. Closest to the line: `voc-logs-api` (16 concurrent counts
per summary; projected about 60 %).

## Cold starts

The slow first request on `/sources/status`, `/connect/tokens`, `/feedback-forms` and `/memory` (3–4 s at
the client, voc-e2e qa/perf) is Init plus a first invocation that builds its DynamoDB resource. Measured
read-only, 7 days to 2026-10-07, REPORT lines, deployed sizes:

| Function | MB | Cold starts | Init p50 / p95 / max (ms) | Cold invoke p50 / p95 (ms) | Warm invoke p50 / p95 (ms) | Init + invoke p95 (ms) |
|---|---|---|---|---|---|---|
| voc-integrations-api | 256 | 39 | 1409 / 2010 / 2195 | 200 / 628 | 48 / 370 | 2471 |
| voc-mcp-tokens-api | 256 | 20 | 1292 / 1383 / 1413 | 1040 / 1086 | 17 / 150 | 2460 |
| voc-feedback-form-api | 256 | 36 | 1424 / 1827 / 2265 | 180 / 768 | 113 / 691 | 2538 |
| voc-memory-api | 512 | 34 | 1330 / 1696 / 1724 | 608 / 825 | 30 / 208 | 2399 |
| voc-settings-api | 256 | 36 | 1455 / 1920 / 2192 | 156 / 219 | 16 / 69 | 2066 |
| voc-metrics-api | 512 | 97 | 1412 / 1816 / 2148 | 160 / 1460 | 37 / 1363 | 2878 |

Every Python API Lambda shows the same 1.3–1.5 s Init p50 at 256 and 512 MB alike, so this is a fixed import
cost, not memory. API Gateway and sandbox setup come on top of it.

### Where the import time goes

`python -X importtime` on each handler, imported the way its bundle lays it out (handler + `shared/` at
the root, layer libraries + boto3 on the path). Local Python 3.12 on Apple silicon, so read the numbers as
relative. Lambda runs 3.14 on Graviton.

| Handler | Before (ms) | After (ms) |
|---|---|---|
| integrations | 880 | 600 |
| mcp_tokens | 691 | 364 |
| feedback_form | 983 | 618 |
| memory | 766 | 329 |
| metrics | 943 | 616 |
| settings | 1019 | 682 |
| users | 877 | 536 |

1. **The X-Ray SDK, about 350 ms. Fixed.** Powertools' `Tracer()` imports `aws_xray_sdk.core` when it is
   constructed, even when disabled. That import builds the SDK's default sampler, which creates two
   botocore `xray` clients. In Lambda, `auto_patch` then wraps botocore, requests and httplib. No API request
   is ever sampled: the functions use the default `PassThrough` mode and the REST stage has tracing off.
   `shared/tracing.py` now gives every Tracer a provider that applies the SDK's own rule
   (`_X_AMZN_TRACE_ID` carries Root, Parent and `Sampled=1`) per call. An unsampled call gets a no-op
   subsegment. A sampled one imports the SDK once, applies the requested patches and delegates. Stored traces
   are unchanged. This covers every Python Lambda, since they all use `shared.logging`. Guard:
   `shared/test/test_tracing.py` (importing any guarded handler must not load `aws_xray_sdk.core`).
2. **botocore's model directory scans, 200–260 ms. Not changed.** The first client or resource per model
   type calls `Loader.list_available_services`, which runs `listdir` and `stat` over every service directory
   in botocore's data path, once each for `service-2`, `endpoint-rule-set-1` and `resources-1`. Patching the
   loader would mean changing private internals of the runtime-managed botocore, which AWS updates under us.
   SnapStart (below) absorbs the cost instead.
3. **boto3 itself (140–160 ms), Powertools' event handler, and pydantic for `enable_validation=True`
   (90–110 ms). Kept.** boto3 comes with the runtime. Validation is behaviour: typed parameters and 422s.
4. **Module-level clients (the handler's own "self" time, 180–300 ms). Kept.** Each slow route needs the
   client it builds. Since Init is billed like Duration (August 2025), making them lazy would only move the
   cost into the first request. Under SnapStart, work at import is free on restore.

The bundles already ship only `api/<handler>.py` + `shared/` + prompts and static (`createApiLambdaCode`).
No API bundle ships or imports `plugins/` or another handler.

### Dependency layers

Every function also unzips its layers into `/opt` on a cold start. Until 5.31, one 39 MB layer went to all 43
API and processing functions, and a 37 MB layer to all 9 ingestion functions. `scripts/audit/py_layers.py`
(docs/code-audit.md) compared each layer with what the live code of its functions imports. It found:

- cryptography + cffi + pycparser (17 MB), reached by 5 of the 29 API functions and none of the 14 processing
  ones;
- lxml (12 MB), reached only by the opt-in inbound-email intake;
- the layers' own urllib3, jmespath, python-dateutil and six, which shadowed the runtime's copies, so the
  runtime's botocore ran on them.

What ships now (`lib/utils/dependency-layers.ts`, Docker builds of 2026-10-24, arm64):

| Layer | Stack | Functions | Before: unzipped / zipped | After: unzipped / zipped |
|---|---|---|---|---|
| `ApiDepsLayer`, `ProcessingDepsLayer` (`processing-deps`) | Api, Processing | 29 + 14 | 39.4 / 13.7 MB | 20.5 / 7.3 MB |
| `IngestionDepsLayer` (`ingestion-deps`) | Ingestion | 9 | 37.2 / 14.1 MB | 22.2 / 7.9 MB |
| `SigningDepsLayer` (`signing-deps`, new) | Api | 5: projects API + its assist worker, the persona generator and importer, the document generator | — | 16.8 / 5.6 MB |
| `EmailIntakeDepsLayer` (`email-intake-deps`, new) | Ingestion, only with `-c inboundEmailDomain` | 1: the email intake | — | 12.4 / 5.2 MB |

- **Who gets the signing layer.** `SIGNING_LAYER_FUNCTION_IDS` lists them. `py_layers` fails the gate when a
  function's live code imports a library none of its layers ships (`missing-distribution`). It also fails when a
  function gets a layer it reaches nothing of (`unused-layer`). So the list follows the code: a function that
  starts signing, or stops, fails the gate until the list matches. `dependency-layers.test.ts` pins the
  templates to the list.
- **What the bundling strips.** `LAYER_STRIP` in `lib/utils/python-layer-bundling.ts`, in lockstep with
  `scripts/build-layers.sh`:
  - the SDK closure the Python 3.14 runtime already ships: boto3, botocore, s3transfer, jmespath,
    python-dateutil, six, urllib3. Every dependent's version range accepts the runtime's versions; `py_layers`
    reports a `runtime-conflict` the day one does not;
  - files that never run in Lambda: `bin/`, `*.pyi`, `*-stubs`, and the `tests/` some wheels ship.
  - `.pyc` (compiled for 3.14 by the same image) and `*.dist-info` stay.
- **What was kept.** websocket-client (0.4 MB, 2 of 9 ingestion functions) is under the 2 MB size where
  `py_layers` calls a library a split candidate. The requests stack (requests, charset-normalizer, idna, certifi:
  1.8 MB together) is reached by 2 of 29 API functions and 1 of 14 processing ones. Each library is under that
  size.

Checked, 2026-10-24: every one of the 52 functions with a changed layer imports its handler module in
`public.ecr.aws/lambda/python:3.14`. Each ran from its replayed bundle with the new layers mounted at `/opt`.
urllib3, jmespath and dateutil resolved to `/var/lang/lib/python3.14/site-packages`. The five signing
functions signed with RSA-SHA1 (cryptography 50.0.2). The email intake parsed HTML with lxml. The webscraper's
`html.parser` works without lxml.

### SnapStart: on for the four slow APIs

Checked against the AWS docs on 2026-10-07:

- **Support:** Python 3.12 and later, on x86_64 and arm64, in every commercial Region except Asia Pacific
  (New Zealand) and Asia Pacific (Taipei). us-west-2 is supported.
- **Not compatible with:** provisioned concurrency, EFS, or ephemeral storage over 512 MB. None apply here.

What was done:

- **Functions:** `IntegrationsApi`, `FeedbackFormApi`, `MemoryApi` and `McpTokensApi`
  (`lib/utils/snapstart.ts`, `SNAPSTART_FUNCTION_IDS`).
- **Resources:** each function gets `SnapStart: PublishedVersions`, a version that CloudFormation deletes
  when it is superseded (a retained one would keep paying the cache charge), and a `live` alias.
- **Routing:** API Gateway integrates the alias, and the invoke permissions name the alias. An unqualified
  invoke runs `$LATEST`, which is never snapshotted. Internal callers that invoke these functions by name
  (the AI assistant, MCP, agents) still run `$LATEST`, so their behaviour and IAM are unchanged and they
  still pay a normal cold start.
- **Resource budget:** +8 resources. VocApiStack has 472 with every plugin enabled (466 by default; the per-project MCP server is gone), and
  `api-stack-snapstart.test.ts` fails above 490. SnapStart for every API Lambda (about 40 more) does not fit.
- **Priming:** `shared/snapstart.py` runs, in a before-snapshot hook, the table or client factories the slow
  route would otherwise build on its first request: memory and aggregates tables (memory), projects and jobs
  tables (tokens), the plugin-defaults parse (integrations). Feedback forms already builds its clients at
  import. The factories make no network call. A failing factory is logged, never fatal.
- **Priming, 3.00.00 capacity follow-up.** The first call after a restore was still slow (p95 816 ms
  integrations, 819 ms feedback forms, at 83–93 % CPU). Profiling the first request offline with the HTTP
  layer stubbed found two lazy costs the snapshot did not hold, now primed in all four handlers:
  - `api_route_warmer(app)`: Powertools builds each route's request-validation model (pydantic) on that
    route's first request. Now built before the snapshot.
  - `botocore_model_warmer('dynamodb', 'lambda')` (integrations): the run-status and run routes build a
    DynamoDB `Table` and a Lambda client lazily. That cost ~250 ms of CPU locally, nearly all of it parsing
    botocore's JSON model files. The warmer only loads the files into the session's loader cache. It
    creates no client, so it resolves no credential and caches no token. Measured locally (CPU of the first
    `GET /sources/status?run_status=…`): 83 ms → 23 ms.
  - What priming cannot remove: after a restore, every connection is new (DNS, TCP, TLS handshake and CA
    bundle load per AWS endpoint), and the SDK fetches the role credentials on first use. Both are
    deliberate: the snapshot must not hold a socket or a credential.
  - `shared/test/test_snapstart.py` pins each handler's warmers. It also checks that every route's model is
    built after priming. For integrations and feedback forms, it checks that priming makes no AWS call and
    no credential lookup. Memory and tokens build their tables in the hook, which creates the DynamoDB
    client there (the AWS-documented pattern, unchanged).
- **Uniqueness audit (the four handlers and their `shared/` imports):** clean.
  - Nothing at import mints an id, secret, token or timestamp. The secret, signer and prompt caches are
    filled on first use, after restore.
  - `uuid4`, `secrets` and `SystemRandom` (Bedrock jitter) read the kernel CSPRNG, which Lambda reseeds
    on restore.
  - boto3 clients built at init resume, per the AWS docs, and the role credentials are refreshed by the SDK.
  - One gap: the stdlib `random` Mersenne Twister is seeded at import and feeds botocore's retry jitter, so
    restored environments would back off in step. A `register_after_restore` hook reseeds it.
  - Python's hash seed is shared across restores. That is accepted: it matters only for hash-flooding
    resistance on untrusted dict keys.

**Cost (owner information).** Published prices (us-east-1 example on the Lambda pricing page; us-west-2
Lambda prices match):

- **Cache:** $0.0000015046 per GB-s for as long as a version is active, with a 3-hour minimum per
  published version.
- **Restore:** $0.0001397998 per GB restored.
- **Monthly total at this branch's sizes:**
  - Cache: 3072 MB (integrations, since the 2026-10-20 doubling) ≈ $11.70, 1536 MB (memory, since the 2026-10-18
    raise) ≈ $5.85, plus 1024 MB × 2 (feedback forms since the 3.00.00 capacity raise; mcp-tokens since the 3.00.00
    upsize) ≈ $3.90 × 2, 30 days = **$25.35/month**.
  - Restores at the measured rate (about 129 cold starts a week across the four) ≈ **$0.05/month**.
  - Duration (Init, restore and hook time) is billed as before.
- **Deploys:** a code change publishes a new version, and CloudFormation waits for its snapshot, adding a
  few minutes per function.

**Verifying after a deploy (read-only).** A restored invocation's REPORT line has `Restore Duration` in
place of `Init Duration`:

```
filter @type = "REPORT" and @message like /Restore Duration/
| parse @message /Restore Duration: (?<restoreMs>[\d.]+) ms/
| stats count() as restores, pct(restoreMs, 50) as p50, pct(restoreMs, 95) as p95, pct(@duration, 95) as firstInvokeP95
```

Compare it with the table above. API Gateway requests should show restores. Calls by unqualified name will
still show Init.

**Rollback:** remove the id from `SNAPSTART_FUNCTION_IDS`, the matching `snapStartFunctionProps()` spread and
`snapStartAlias()` call. The integration falls back to the function.

### Provisioned concurrency: not added (owner decision)

PC keeps environments initialised (double-digit-ms start). It cannot be combined with SnapStart on the same
version. Arm price: $0.0000033334 per GB-s, 730 h a month, plus a lower duration rate while it serves. One
PC on each of the four:

| Function | Branch size | 1 PC / month | Deployed size | 1 PC / month |
|---|---|---|---|---|
| voc-integrations-api | 1024 MB | $8.76 | 256 MB | $2.19 |
| voc-feedback-form-api | 1024 MB | $8.76 | 256 MB | $2.19 |
| voc-memory-api | 1024 MB | $8.76 | 512 MB | $4.38 |
| voc-mcp-tokens-api | 1024 MB | $8.76 | 256 MB | $2.19 |
| **Total** | | **$35.04** | | **$10.95** |

One PC covers one concurrent request. A burst beyond it cold-starts, which SnapStart then no longer covers
for that version. Confirm prices in the AWS Pricing Calculator before deciding.
