# Lambda sizing policy and measurement

How every `voc-*` Lambda is sized, how to check the sizes against a running deployment, and how to run AWS Lambda
Power Tuning safely when the check flags a function. It is for operators who watch cost and latency, and for
contributors who add a function. The rule, the function classes and the pinned sizes live in one file,
`voc-datalake/lib/sizing/policy.ts`; `lib/lambda-memory.test.ts` fails on any drift from it.

## The rule: 60 % for memory and CPU

AWS publishes no utilisation target; 60 % is this project's trigger for a raise. A lower blanket target (50 %) would
cost more for little gain: most handlers wait on DynamoDB or Bedrock, so doubling memory mostly doubles cost.

| Resource | Measured as | Ceiling |
|---|---|---|
| Memory | **Peak** `max_memory_used` / MemorySize over the window (REPORT lines), not p95 | **60 %**, every class |
| CPU | Over the invocations that ran **≥ 100 ms only**: the worse of (a) the wall-weighted share and (b) the p95 share | **60 %** |

- **Share** = CPU time / (wall time × MemorySize / 1,769 MB). Lambda allocates one vCPU at 1,769 MB, so a
  single-threaded Python handler gains nothing above it.
- **One vCPU is the cap for Python.** Every Python handler runs on one core (the GIL; `shared/concurrency.py`
  threads only overlap network waits), so no Python function is sized above 1,769 MB. More memory there lowers the
  measured share without making a call faster. `lib/lambda-memory.test.ts` fails on a Python function above one
  vCPU. A function still over 60 % at 1,769 MB needs cheaper code, or Power Tuning.
- **Insufficient data:** fewer than **20** calls ≥ 100 ms in the window (`CPU_MIN_LONG_CALLS`). The report lists
  the function; it is not a breach.
- **Power Tuning pins** (`POWER_TUNED` in `policy.ts`, one record per run: date, method, duration per size, pick,
  pinned size) override the CPU rule at the pinned size. Peak memory is still judged there, and a pin only covers
  the size it pinned. A **superseded** pin (the function was later moved off that size) is kept as history and
  waives nothing.
- **Variable-payload** functions are the ones whose memory grows with what a caller sends or a batch holds:
  manual import (API and processor), the feedback processor, the aggregation processor, the memory extractor,
  the document/persona generators, the persona importer, the document merger, category reprocess, the S3-import
  ingestor and the product-doc extractor (`VARIABLE_PAYLOAD` in `policy.ts`, each with its reason). Watch their
  peak memory after large imports.
- **CPU not measured by design:** the deploy-time custom resources (`voc-cdn-signing-keys`, `voc-admin-bootstrap`,
  and `voc-fixture-provider` when it exists; `CPU_NOT_MEASURED`). Every other function logs the CPU line below.
- **One step** is one rung of `MEMORY_STEPS_MB` (128, 256, 512, 1024, 1536, 1769, 2048, 3008).

### Why short calls do not count

Warm API reads of 8–50 ms are CPU-busy for their whole wall time at any size. In a Power Tuning run, six API
functions showed a weighted CPU share of 87–95 % at 1,024 MB while their measured duration did not improve with more
memory (metrics: 21.9 ms at 1,024 MB, 21.8 ms at 1,536 MB; projects: 36.5 ms vs 35.1 ms). A rule that counted every
call would push every API Lambda up for no gain. Counting only calls of 100 ms or more keeps the rule about the calls
where more CPU can shorten the wait. A function that rarely makes such calls is reported as insufficient data rather
than sized from noise.

## The CPU line

Lambda's REPORT line carries memory and duration but no CPU, X-Ray is off and Lambda Insights is not
installed, so every function logs one structured line per invocation:

```json
{"message": "invocation_cost", "cpu_ms": 12.3, "wall_ms": 840.0, "function_memory_size": 1024, "cpu_pct_of_allocation": 2.5}
```

Numbers only, never a payload. Python: `lambda/shared/invocation_cost.py` (`@measure_invocation_cost`,
applied by `api_handler`, `instrumented_handler` (the shared entry stack of the worker and job
handlers), `batch_lambda_handler` and the agent `step_lambda_handler`; a test fails on any
`lambda_handler` that does not log it). The product-doc extractor, which cannot import `shared/`, carries a
lockstep-tested stdlib copy. TypeScript `voc-chat-stream`: `lambda/stream/src/lib/invocation-cost.ts`
(`process.cpuUsage()`), same fields.

## Run the check (read-only)

```bash
cd voc-datalake
scripts/capacity/capacity-query.sh --hours 168                 # judged at the deployed sizes
scripts/capacity/capacity-query.sh --hours 168 --repo-sizes    # judged at this checkout's sizes (before a resize deploys)
scripts/capacity/capacity-query.sh --hours 24 --json /tmp/capacity.json
scripts/capacity/capacity-query.sh --hours 168 --region eu-central-1
```

It uses your AWS credentials for `lambda list-functions`, `logs describe-log-groups` and three Logs Insights
queries; nothing is written. It prints one row per function, then the unmeasured functions, the
CPU-insufficient-data list, the Power-Tuning-pinned list and the by-design exceptions, and exits 1 on a breach
(2 on an error). Results are grouped by MemorySize, so a window that spans a resize never mixes sizes; a function
measured only at an older size is projected (`… (from 512 MB)`). The same check runs as an end-to-end spec:
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
judged. Re-measure after a run that exercises it (ingestion, research, document merge, persona panels).

## When a function breaches

1. Raise it one step in its CDK builder (never past 1,769 MB for Python), update its pin in `policy.ts`
   (`RAISED_FOR_CPU` or `RAISED_FOR_PEAK_MEMORY`), and add a CHANGELOG **Changed** bullet naming it.
2. When the cost matters (a frequently invoked function), or the function is already at one vCPU, size it from
   Power Tuning instead (below), or make the code cheaper.

**Cost of a raise.** Lambda bills duration in GB-seconds, so doubling memory doubles the per-call charge when the
duration does not change, and costs less when the calls get faster: +100 % for a doubling, +50 % for 1,024 → 1,536,
+73 % for 1,024 → 1,769. For most functions here that is cents to a few dollars a month. A SnapStart function
(opt-in, below) also pays a cache charge proportional to its memory.

## AWS Lambda Power Tuning

[Power Tuning](https://github.com/alexcasalboni/aws-lambda-power-tuning) gives the cost-versus-duration curve
that sets a final size. Compute Optimizer does not help here: it supports x86_64 only and these functions are ARM64.

**It invokes the function for real**, and a call can reach Bedrock and write to DynamoDB. So:

1. **Get approval from whoever owns the account first**, naming the functions, the payloads and the account.
2. **Prefer a non-production deployment** (a second stack prefix in a test account, see
   [deployment.md → Two Deployments in One Account and Region](deployment.md#two-deployments-in-one-account-and-region)).
   On production, use only read payloads.
3. **Payloads:** a captured API Gateway event for a read route (`GET /metrics/summary?days=7`, `GET /settings/brand`,
   `GET /projects`), with the Cognito claims of a test admin user. Never a write route, never a route that
   calls Bedrock unless that is the thing being sized.
4. Deploy the Power Tuning state machine from the AWS Serverless Application Repository into the target account.
   It is not part of this app's five stacks.
5. Run it with:

   ```json
   {
     "lambdaARN": "arn:aws:lambda:<region>:<account>:function:voc-metrics-api-<account>-<region>",
     "powerValues": [512, 1024, 1536, 1769],
     "num": 50,
     "payload": { "...": "the captured read-route event" },
     "parallelInvocation": false,
     "strategy": "balanced"
   }
   ```

   `parallelInvocation: false` keeps it to one concurrent call (no throttling of real traffic). Power Tuning
   changes the function's memory while it runs and restores it at the end; do not run it during a deploy.
6. Read the curve, pick the size, then set it in the CDK builder and record the run in `POWER_TUNED` in
   `policy.ts`. Never leave a size that only exists in the console: the next deploy reverts it. Delete the Power
   Tuning stack afterwards.

Example of a curve (six API functions, read payloads, `num` 30, duration per invocation):

| Function | 512 | 1,024 | 1,536 | 1,769 | 2,048 MB | Balanced pick |
|---|---|---|---|---|---|---|
| ballots | 7.0 ms | 5.8 | 6.1 | 6.0 | 6.1 | 512 |
| settings | 8.2 | 7.6 | 7.8 | 8.4 | 7.9 | 512 |
| metrics | 40.8 | 21.9 | 21.8 | 20.7 | 16.6 | 1,024 |
| projects | 54.0 | 36.5 | 35.1 | 36.7 | 34.1 | 1,024 |
| memory | 39.2 | 23.3 | 20.3 | 23.6 | 24.2 | 1,024 |
| agents | 10.9 | 8.2 | 8.3 | 7.7 | 7.9 | 1,024 |

Gains above 1,024 MB were within noise for these read routes. Those pins have since been superseded by measured
CPU under the 60 % rule (see `policy.ts`).

## How the code keeps CPU low

Before raising memory, the code was made cheaper where the measurements pointed (profiled in the Lambda Python 3.14
arm64 image, CPU-capped to the function's share, against a local DynamoDB):

| Where | What it cost | What the code does |
|---|---|---|
| First request of an environment (and the scheduled workers, which start cold on every tick) | Building the DynamoDB resource lazily: botocore walks its data directory (about 4,000 `stat` calls) and parses the models. Agents API: 133 ms CPU on a first request vs 8 ms warm | Built during INIT (`shared/warm_init.py`; SnapStart functions use `shared/snapstart.py`). First-invoke CPU −75 to −85 %, warm unchanged |
| Every DynamoDB read of many items | botocore's model-driven parse of each `AttributeValue`, then boto3's second walk | One-pass decode of `Items` / `Responses` on the shared resource (`shared/dynamodb_fast_items.py`, values identical to boto3's) |
| `/feedback` and filtered metric walks | Full reviews read to count or filter | Projected walks, the page fetched by key: 0.1–0.6× the CPU |
| Aggregation processor on bulk deletes | One conditional write per record per counter | One write per distinct counter per run of deletes |
| `/logs/summary` | Rows read and redacted per source to count them | `Select='COUNT'` |

The shared DynamoDB client pools `MAX_IN_FLIGHT_READS` = 32 connections, as many reads as one request's nested
fan-out can have in flight (botocore's default of 10 logged "Connection pool is full" on `/metrics/*`).

## Cold starts

A Python API Lambda's Init takes about 1.3–1.5 s (p50) at 256 and 512 MB alike, so this is a fixed import cost,
not memory. API Gateway and sandbox setup come on top of it.

### Where the import time goes

`python -X importtime` on each handler, imported the way its bundle lays it out (handler + `shared/` at
the root, layer libraries + boto3 on the path). Measured on local Python 3.12 on Apple silicon, so read the numbers
as relative; Lambda runs 3.14 on Graviton.

| Handler | Import time with the X-Ray SDK loaded (ms) | Import time now (ms) |
|---|---|---|
| integrations | 880 | 600 |
| mcp_tokens | 691 | 364 |
| feedback_form | 983 | 618 |
| memory | 766 | 329 |
| metrics | 943 | 616 |
| settings | 1019 | 682 |
| users | 877 | 536 |

1. **The X-Ray SDK, about 350 ms, is not loaded on unsampled calls.** Powertools' `Tracer()` imports
   `aws_xray_sdk.core` when it is constructed, even when disabled, and that import builds the SDK's default sampler
   with two botocore `xray` clients. No API request is sampled: the functions use the default `PassThrough` mode
   and the REST stage has tracing off. `shared/tracing.py` gives every Tracer a provider that applies the SDK's own
   rule (`_X_AMZN_TRACE_ID` carries Root, Parent and `Sampled=1`) per call. An unsampled call gets a no-op
   subsegment; a sampled one imports the SDK once, applies the requested patches and delegates. Stored traces
   are unchanged. `shared/test/test_tracing.py` checks that importing a handler does not load
   `aws_xray_sdk.core`.
2. **botocore's model directory scans, 200–260 ms, are kept.** The first client or resource per model
   type calls `Loader.list_available_services`, which lists every service directory in botocore's data path.
   Patching the loader would mean changing private internals of the runtime-managed botocore. With SnapStart
   (opt-in, below) the snapshot absorbs the cost; without it, the first request pays it.
3. **boto3 itself (140–160 ms), Powertools' event handler, and pydantic for `enable_validation=True`
   (90–110 ms) are kept.** boto3 comes with the runtime, and validation is behaviour (typed parameters and 422s).
4. **Module-level clients (180–300 ms of the handler's own time) are kept.** Each slow route needs the
   client it builds. Init is billed like Duration, so making them lazy would only move the cost into the first
   request. Under SnapStart (opt-in), work at import is free on restore.

The API bundles ship only `api/<handler>.py` + `shared/` + prompts and static files (`createApiLambdaCode`).
No API bundle ships or imports `plugins/` or another handler.

### Dependency layers

Every function also unzips its layers into `/opt` on a cold start, so each layer carries only what its functions
import. `scripts/audit/py_layers.py` ([code-audit.md](code-audit.md)) compares each layer with what the live code of
its functions imports, and fails the gate on a library no function needs.

What ships (`lib/utils/dependency-layers.ts`, Docker builds, arm64):

| Layer | Stack | Functions | Unzipped / zipped |
|---|---|---|---|
| `ApiDepsLayer`, `ProcessingDepsLayer` (`processing-deps`) | Api, Processing | 29 + 14 | 20.5 / 7.3 MB |
| `IngestionDepsLayer` (`ingestion-deps`) | Ingestion | 9 | 22.2 / 7.9 MB |
| `SigningDepsLayer` (`signing-deps`) | Api | 5: projects API + its assist worker, the persona generator and importer, the document generator | 16.8 / 5.6 MB |
| `EmailIntakeDepsLayer` (`email-intake-deps`) | Ingestion, only with `-c inboundEmailDomain` | 1: the email intake | 12.4 / 5.2 MB |

Earlier releases shipped one 39 MB layer to every API and processing function; cryptography (17 MB with its
dependencies) and lxml (12 MB) now go only to the functions that use them.

- **Who gets the signing layer.** `SIGNING_LAYER_FUNCTION_IDS` lists them. `py_layers` fails the gate when a
  function's live code imports a library none of its layers ships (`missing-distribution`), and when a
  function gets a layer it reaches nothing of (`unused-layer`). So the list follows the code.
  `dependency-layers.test.ts` checks the templates against the list.
- **What the bundling strips.** `LAYER_STRIP` in `lib/utils/python-layer-bundling.ts`, in lockstep with
  `scripts/build-layers.sh`:
  - the SDK closure the Python 3.14 runtime already ships: boto3, botocore, s3transfer, jmespath,
    python-dateutil, six, urllib3. Every dependent's version range accepts the runtime's versions; `py_layers`
    reports a `runtime-conflict` the day one does not;
  - files that never run in Lambda: `bin/`, `*.pyi`, `*-stubs`, and the `tests/` some wheels ship.
  - `.pyc` (compiled for 3.14 by the same image) and `*.dist-info` stay.
- **What is kept everywhere.** websocket-client (0.4 MB) and the requests stack (requests, charset-normalizer, idna,
  certifi: 1.8 MB together) are each under the 2 MB size at which `py_layers` calls a library a split candidate.

<a id="snapstart-on-for-the-four-slow-apis"></a>
<a id="snapstart-off-by-default"></a>

### SnapStart: off by default, opt-in for four APIs

SnapStart is **off by default**. It is a fixed monthly cost (the snapshot cache below bills for as long as a version
is active, used or not), and this project runs fully serverless with no fixed cost by default
([TENETS.md](../TENETS.md), tenet 7). We would rather a first request wait a couple of seconds longer and make the
function start faster (the import trimming above, right-sized memory) than pay to hide a slow start. SnapStart, like
provisioned concurrency, can come later, once the functions are well architected. The opt-in flags are where that lands: a
deployment that chooses performance over the lowest bill turns them on, and the default stays the cost-optimised
sample.

**Opting in.** Deploy with `-c snapStart=true` (or `"snapStart": true` in `voc-datalake/cdk.context.json`); absent or
`false` = off, anything else fails the synth. `lib/utils/snapstart.ts` is the one place the flag is read. With it off,
the four functions below have no `SnapStart` property, no version and no alias, and API Gateway integrates the plain
function like every other API Lambda. The lib/fixed-cost-guard.test.ts gate fails the CDK suite if SnapStart (or
any other fixed-cost resource) appears in a default synth.

**Why someone might opt in.** SnapStart replaces a cold start with a restore from a snapshot taken at deploy time
(restore p50 about 460–500 ms, measured on these four APIs while it was on). It supports Python 3.12 and later on x86_64 and arm64 in most commercial Regions (check the AWS docs
for your Region), and is not compatible with provisioned concurrency, EFS, or ephemeral storage over 512 MB.

What `-c snapStart=true` deploys:

- **Functions:** `IntegrationsApi`, `FeedbackFormApi`, `MemoryApi` and `McpTokensApi`
  (`lib/utils/snapstart.ts`, `SNAPSTART_FUNCTION_IDS`), the APIs whose first request was slowest.
- **Resources:** each function gets `SnapStart: PublishedVersions`, a version that CloudFormation deletes
  when it is superseded (a retained one would keep paying the cache charge), and a `live` alias.
- **Routing:** API Gateway integrates the alias, and the invoke permissions name the alias. An unqualified
  invoke runs `$LATEST`, which is never snapshotted. Internal callers that invoke these functions by name
  (the AI assistant, MCP, agents) still run `$LATEST`, so their behaviour and IAM are unchanged and they
  pay a normal cold start.
- **Resource budget:** each function adds two resources to VocApiStack (+8 in all), which must stay at least 75
  resources under CloudFormation's 500 limit with the flag on (`api-stack-snapstart.test.ts` measures that shape).
  SnapStart for every API Lambda does not fit.
- **Priming:** `shared/snapstart.py` registers the hooks in all four handlers either way; Lambda calls them only when
  SnapStart takes a snapshot. It runs, in a before-snapshot hook, the table or client factories the slow
  route would otherwise build on its first request: memory and aggregates tables (memory), projects and jobs
  tables (tokens), the plugin-defaults parse (integrations). Feedback forms builds its clients at import. The
  factories make no network call, and a failing factory is logged, never fatal. Two more warmers run in all four
  handlers:
  - `api_route_warmer(app)`: Powertools builds each route's request-validation model (pydantic) on that
    route's first request; the warmer builds them before the snapshot.
  - `botocore_model_warmer('dynamodb', 'lambda')` (integrations): loads botocore's JSON model files into the
    session's loader cache. It creates no client, so it resolves no credential and caches no token. In local
    profiling this took the first `GET /sources/status?run_status=…` from 83 ms to 23 ms of CPU.
  - What priming cannot remove: after a restore, every connection is new (DNS, TCP, TLS handshake and CA
    bundle load per AWS endpoint), and the SDK fetches the role credentials on first use. Both are
    deliberate: the snapshot must not hold a socket or a credential.
  - `shared/test/test_snapstart.py` checks each handler's warmers, that every route's model is built after
    priming, and for integrations and feedback forms that priming makes no AWS call and no credential lookup.
- **Uniqueness (the four handlers and their `shared/` imports):**
  - Nothing at import mints an id, secret, token or timestamp. The secret, signer and prompt caches are
    filled on first use, after restore.
  - `uuid4`, `secrets` and `SystemRandom` (Bedrock jitter) read the kernel CSPRNG, which Lambda reseeds
    on restore.
  - boto3 clients built at init resume, per the AWS docs, and the SDK refreshes the role credentials.
  - The stdlib `random` Mersenne Twister is seeded at import and feeds botocore's retry jitter, so restored
    environments would back off in step. A `register_after_restore` hook reseeds it.
  - Python's hash seed is shared across restores. That is accepted: it matters only for hash-flooding
    resistance on untrusted dict keys.

**Cost with `-c snapStart=true`.** Published Lambda prices (check the pricing page for your Region):

- **Cache:** $0.0000015046 per GB-s for as long as a version is active, with a 3-hour minimum per
  published version. At the current sizes (integrations 1,769 MB, memory 1,536 MB, feedback forms and MCP tokens
  1,024 MB each) that is about **$20 a month** for the four together.
- **Restore:** $0.0001397998 per GB restored; at about 130 cold starts a week across the four, a few cents a month.
- Duration (Init, restore and hook time) is billed as usual.
- **Deploys:** a code change publishes a new version, and CloudFormation waits for its snapshot, adding a
  few minutes per function.

**Verifying after a deploy with the flag on (read-only).** A restored invocation's REPORT line has `Restore Duration` in
place of `Init Duration`:

```
filter @type = "REPORT" and @message like /Restore Duration/
| parse @message /Restore Duration: (?<restoreMs>[\d.]+) ms/
| stats count() as restores, pct(restoreMs, 50) as p50, pct(restoreMs, 95) as p95, pct(@duration, 95) as firstInvokeP95
```

API Gateway requests should show restores. Calls by unqualified name still show Init.

**Turning it off again:** deploy without the flag (or with `-c snapStart=false`). CloudFormation deletes the four
versions (their `DeletionPolicy` is `Delete`, so no snapshot keeps billing) and the `live` aliases, and API Gateway
integrates the functions again. To drop one function only, remove its id from `SNAPSTART_FUNCTION_IDS` and the
matching `snapStartFunctionProps()` spread and `snapStartInvokeTarget()` call.

### Provisioned concurrency: not used

Provisioned concurrency is a fixed cost too ([TENETS.md](../TENETS.md), tenet 7), and the fixed-cost gate fails a
synth that adds it. Reserved concurrency is different: it only caps a function's share of the account pool and
costs nothing (the MCP endpoint keeps its 20, `-c mcpReservedConcurrency`).

Provisioned concurrency (PC) keeps environments initialised (a start in tens of milliseconds), but it cannot be
combined with SnapStart on the same version and it bills for every hour it exists: $0.0000033334 per GB-s on Arm,
730 hours a month, plus a lower duration rate while it serves. One PC at 1,024 MB costs about $8.76 a month, so one
PC on each of the four SnapStart functions at their current sizes would be about $46 a month. One PC covers one
concurrent request; a burst beyond it cold-starts, which SnapStart then no longer covers for that version. The
sample therefore uses neither by default. Confirm prices in the AWS Pricing Calculator before adding PC yourself.
