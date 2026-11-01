# Plugin Architecture for Data Source Connectors

Every feedback source that the platform polls, receives by webhook or reads from an S3 upload is a
**plugin**: a folder under `voc-datalake/plugins/` with a `manifest.json` and the Python code of its
Lambda functions. The manifest drives both the infrastructure CDK deploys and the settings card the
web app shows. This document is the reference for plugin authors and operators: the manifest
schema, what CDK builds, the base classes, the message contract with the processing queue, secrets,
runtime controls and observability. For a step-by-step walkthrough, start with
[Getting Started with Data Source Plugins](getting-started-plugins.md).

Not every source is a plugin. Manual paste and CSV/JSON import, feedback forms, the email inbox and
Radar scans have their own handlers and write to the same processing queue.

## How it works

```
plugins/<id>/manifest.json ──► lib/plugin-loader.ts (Zod validation, cross-plugin checks)
                                   │
          ┌────────────────────────┼─────────────────────────────┐
          ▼                        ▼                             ▼
  VocIngestionStack           VocApiStack                 scripts/generate-manifests.ts
  ingestor Lambda,            webhook Lambda +            frontend/src/plugins/manifests.json
  schedule (disabled),        POST /webhooks/<id>         (UI fields + enabled flag)
  S3 trigger, shared secret
          │                        │
          └──────────┬─────────────┘
                     ▼
     raw/<id>/… in the raw bucket  +  voc-processing-queue  ──►  processor (docs/processing-pipeline.md)
```

1. **Synth time.** `loadPlugins()` reads every folder under `plugins/` that does not start with `_`,
   validates its manifest and fails the synth on any error. `pluginStatus` in `cdk.context.json`
   decides which plugins get AWS resources.
2. **Deploy time.** CDK creates the ingestor Lambda, its EventBridge schedule (created **disabled**),
   the webhook route and the S3 trigger that the manifest declares. Every plugin's declared secret
   keys seed one shared Secrets Manager secret.
3. **Build time.** `npm run generate:manifests` writes the UI-relevant part of each manifest, plus an
   `enabled` flag from `pluginStatus`, to `frontend/src/plugins/manifests.json`. The SPA's
   `prebuild` runs it.
4. **Run time.** An administrator saves credentials and turns the schedule on in
   **Administration → Sources → Source settings**. The ingestor fetches items, archives each raw
   item to S3 and sends normalized messages to the processing queue.

Adding a plugin, or changing which plugins are enabled, needs a deploy. Turning a deployed
plugin's schedule on or off does not.

## Folder layout

```
voc-datalake/plugins/
├── _shared/              # Code bundled into every plugin Lambda (base classes, secrets, archive, queue)
├── _template/            # Starter plugin: manifest.json, ingestor/handler.py, README.md
├── conftest.py           # pytest setup for plugin tests (paths, fake environment, no AWS calls)
└── <plugin_id>/
    ├── manifest.json     # Required
    ├── ingestor/         # Polling or S3-triggered Lambda: handler.py (+ any modules it imports)
    ├── webhook/          # Webhook Lambda: handler.py
    └── test/             # pytest tests (optional; pruned from the deployed bundle)
```

Folders starting with `_` are never loaded as plugins. A plugin folder without `manifest.json` is
skipped with a warning.

### Bundled plugins

| Plugin id | Kind | Default schedule | Extras | Guide |
|-----------|------|------------------|--------|-------|
| `webscraper` | Ingestor | `rate(15 minutes)` | | [scrapers.md](scrapers.md) |
| `app_reviews_ios` | Ingestor | `rate(30 minutes)` | Continues long runs in a new invocation of its own function | [mobile-app-reviews.md](mobile-app-reviews.md) |
| `app_reviews_android` | Ingestor | `rate(30 minutes)` | Same as iOS | [mobile-app-reviews.md](mobile-app-reviews.md) |
| `github_issues` | Ingestor + webhook | `rate(30 minutes)` | Signed webhook `POST /webhooks/github_issues` | [github-issues.md](github-issues.md) |
| `web_reviews` | Ingestor | `rate(15 minutes)` | `bedrock` + `browser` capabilities | [web-reviews.md](web-reviews.md) |
| `s3_import` | S3-triggered ingestor | none | `.csv`, `.json`, `.jsonl` uploads to the import bucket | [data-lake-structure.md](data-lake-structure.md) |
| `synthetic_reviews` | On-demand ingestor | none | `bedrock` capability; category `synthetic` | [README](../voc-datalake/plugins/synthetic_reviews/README.md) |

All seven are enabled in the committed `cdk.context.json`. A plugin with no credentials or targets
configured runs and finds nothing.

## The manifest

`lib/plugin-loader.ts` defines the schema (`ManifestSchema`). The template's manifest is a
complete minimal example:

```json
{
  "id": "my_source",
  "name": "My Source",
  "icon": "Plugin",
  "description": "Template for creating new plugins",
  "category": "reviews",
  "version": "1.0.0",

  "infrastructure": {
    "ingestor": {
      "enabled": true,
      "schedule": "rate(15 minutes)",
      "timeout": 120,
      "memory": 256
    }
  },

  "config": [
    { "key": "api_key", "label": "API Key", "type": "password", "required": true, "secret": true }
  ],

  "setup": {
    "title": "My Source Setup",
    "color": "blue",
    "steps": ["Go to My Source developer portal", "Create an API key", "Paste the key above"]
  },

  "secrets": {
    "api_key": ""
  }
}
```

### Top-level fields

| Field | Required | Rules | Purpose |
|-------|----------|-------|---------|
| `id` | Yes | 1-32 chars, `^[a-z][a-z0-9_]*$`, equal to the folder name | Names the Lambda, schedule, log group, raw prefix, secret namespace and `source_platform` |
| `name` | Yes | Safe string (below) | English fallback for the card title |
| `icon` | Yes | ≤ 64 chars | Icon word (see [Icons](#icons-and-translations)) |
| `description` | No | Safe string | English fallback for the card description |
| `category` | No | `reviews`, `social`, `import`, `search`, `scraper`, `synthetic` | Grouping; `synthetic` plugins are offered as on-demand generators |
| `infrastructure` | Yes | Object, below | What CDK deploys |
| `config` | No (default `[]`) | ≤ 20 fields | Fields of the settings form |
| `webhooks` | No | ≤ 5 entries `{name, events (≤ 10), docUrl?}` | Webhook information shown on the card |
| `setup` | No | `{title, color?, steps (≤ 15)}`; color `blue`, `orange`, `green` or `gray` | Setup instructions on the card |
| `secrets` | Yes in practice | Keys match `^[a-z][a-z0-9_]*$` (≤ 64), values are strings | Keys and default values seeded into the shared secret ([Secrets](#secrets)) |
| `version` | No | `X.Y.Z` | Shown in the UI manifest |
| `minPlatformVersion` | No | `X.Y.Z` | Format-checked only; not compared with the platform version |
| `integrity` | No | `{ingestor?, webhook?}` as `sha256-<hex>` | Optional code hashes ([Tooling](#tooling)) |

A **safe string** is at most 256 characters, has no control characters and does not contain
`<script`, `javascript:` or `data:`. Labels, placeholders, setup steps and webhook names follow the
same rule.

### `infrastructure.ingestor`

| Field | Default | Rules | Effect |
|-------|---------|-------|--------|
| `enabled` | (required) | boolean | Creates the ingestor Lambda |
| `schedule` | none | `rate(<n> minute(s)\|hour(s)\|day(s))` or `cron(...)` | Creates an EventBridge rule, disabled at deploy |
| `timeout` | 120 | 1-900 seconds | Lambda timeout |
| `memory` | 256 | 128-1024 MB | Lambda memory |
| `bedrock` | false | boolean | Dedicated role with `bedrock:InvokeModel` on the curated model allowlist |
| `browser` | false | boolean | Dedicated role with sessions of the AgentCore managed browser `aws.browser.v1` |

The `cron(...)` pattern admits only digits, spaces and `, - * /`. EventBridge cron expressions need
`?` in one of the day fields, so in practice use `rate(...)`. Without `schedule` the ingestor runs
only when invoked: by **Run now**, by an S3 trigger, or by the API (`s3_import` reprocess,
`synthetic_reviews` generation).

### `infrastructure.webhook`

| Field | Default | Rules |
|-------|---------|-------|
| `enabled` | (required) | boolean |
| `path` | (required) | ≤ 128 chars, starts with `/`, lowercase letters, digits, `-`, `_`, `/`; no `..` or `//` |
| `methods` | `["POST"]` | Up to 4 of `GET`, `POST`, `PUT`, `DELETE` |
| `signatureHeader` | none | `[A-Za-z0-9-]+`, ≤ 64 chars |
| `signatureMethod` | none | `[a-z_]+`, ≤ 32 chars |

The route is always `/webhooks/<id>`, whatever `path` says. `signatureHeader` and
`signatureMethod` are validated but CDK does not act on them: the handler verifies the request
([Writing a webhook](#writing-a-webhook)). Set `path` to `/webhooks/<id>` so the manifest matches
the route.

### `infrastructure.s3Trigger`

| Field | Rules | Effect |
|-------|-------|--------|
| `enabled` | boolean | Invokes the plugin's ingestor on `ObjectCreated` in the S3 import bucket |
| `suffixes` | Up to 5, each `^\.[a-z0-9]+$` and ≤ 10 chars | One event notification per suffix |

The trigger needs an enabled ingestor. The ingestor gets read access to the import bucket and
`S3_IMPORT_BUCKET`, and must ignore records for any other bucket.

### `config` fields

| Property | Rules | Purpose |
|----------|-------|---------|
| `key` | `^[a-z][a-z0-9_]*$`, ≤ 64 | Stored as `<id>_<key>` in the shared secret |
| `label` | Safe string | Field label |
| `type` | `text`, `password`, `textarea`, `select` | Input type (`password` is masked with show/hide) |
| `required` | default false | Shown as required |
| `placeholder` | Safe string | Placeholder text |
| `secret` | default false | Write-only once saved: `GET /integrations/<source>/credentials` never returns its value |
| `options` | `[{value, label}]` | Choices of a `select` |

`PUT /integrations/<source>/credentials` saves every config value to the shared secret as
`<id>_<key>`, whether or not it is `secret`. Declare in `secrets` the keys your code reads, with
their defaults, so the namespace exists from the first deploy.

### Cross-plugin rules

- The folder name must equal `id`.
- No plugin id may be a prefix of another followed by `_` (`app_reviews` next to `app_reviews_ios`
  fails the synth). Secret keys are namespaced `<id>_<key>`, so the shorter id would also receive
  the longer one's keys.
- Keep scheduled plugin ids short. The schedule rule is named
  `[<prefix>-]voc-ingest-<id>-schedule-<account>-<region>` and EventBridge allows 64 characters.
  In us-east-1 that leaves 21 characters for the id with no deployment prefix. The synth reports
  the budget when a name does not fit ([deployment.md](deployment.md)).

## What CDK builds

Physical names go through the stack's `uniqueName()`: `[<deploymentPrefix>-]<base>-<account>-<region>`.
The bases are listed below.

### Ingestor (VocIngestionStack)

| Resource | Base name / value |
|----------|-------------------|
| Lambda | `voc-ingestor-<id>`, Python 3.14, arm64, handler `handler.lambda_handler`, manifest timeout and memory, the `ingestion-deps` layer (`requests`, `aws-lambda-powertools`, `beautifulsoup4`, app-review scrapers) |
| Bundle | `plugins/<id>/ingestor/*` at the root, plus `plugins/_shared/` as `_shared` and `lambda/shared/` as `shared`; tests and caches pruned |
| Log group | `/aws/lambda/voc-ingestor-<id>`, 14-day retention |
| Schedule | `voc-ingest-<id>-schedule`, created disabled; 2 delivery retries, events older than 1 hour dropped to `voc-ingest-schedule-dlq` |
| Environment | `WATERMARKS_TABLE`, `PROCESSING_QUEUE_URL`, `RAW_DATA_BUCKET`, `SECRETS_ARN`, `BRAND_NAME`, `SOURCE_PLATFORM` (= id), `AGGREGATES_TABLE`, `INGEST_SCHEDULE_RULE_NAME` (scheduled plugins only), PII-redaction settings |

The schedule retries cover delivery only (a throttled or unreachable function). A failure inside
the ingestor is handled by the [circuit breaker](#circuit-breaker).

**Roles** (`lib/stacks/ingestion-roles.ts`). Every ingestor role gets the same base grants:
read/write on the watermarks and aggregates tables, `sqs:SendMessage` on the processing queue,
`s3:PutObject` under `raw/*` of the raw bucket (no read, no delete), KMS encrypt/decrypt, read of
the shared secret and `comprehend:DetectPiiEntities`. Plugins that need nothing else share one
role. A plugin gets its own role when it has:

- a schedule: `events:DisableRule` on exactly its own rule, for the circuit breaker;
- `bedrock: true`: `bedrock:InvokeModel` on the allowlisted models (call them through
  `shared/converse.py`, which resolves the model per surface);
- `browser: true`: `bedrock-agentcore:StartBrowserSession` / `StopBrowserSession` on
  `aws.browser.v1`, and `ConnectBrowserAutomationStream` on `*` (that action has no resource type).

`app_reviews_ios` and `app_reviews_android` also get `lambda:InvokeFunction` on their own function,
to continue a long run.

A plugin cannot declare IAM policies, tables, buckets, VPC settings or raw CloudFormation. Anything
beyond the capabilities above needs a change to the stack code.

### Webhook (VocApiStack)

| Resource | Value |
|----------|-------|
| Lambda | `voc-webhook-<id>`, Python 3.14, arm64, 30-second timeout, 256 MB (512 MB for `github_issues`), the API layer |
| Bundle | `plugins/<id>/webhook/*` plus `_shared` and `shared`, like an ingestor |
| Route | `/webhooks/<id>` for each manifest method, no authorizer, no CORS preflight |
| Throttle | 10 requests per second, burst 20, per route |
| Environment | `PROCESSING_QUEUE_URL`, `SECRETS_ARN`, `BRAND_NAME`, `SOURCE_PLATFORM`, `RAW_DATA_BUCKET`, `AGGREGATES_TABLE`, PII-redaction settings |

All webhook Lambdas share one role: KMS, `sqs:SendMessage` on the processing queue,
`secretsmanager:GetSecretValue` on the shared secret, `dynamodb:GetItem` on the aggregates table
(the source profile), Comprehend PII detection and `s3:PutObject` on `raw/<id>/*` for each enabled
webhook plugin. Webhooks have no feedback-table access.

### S3 trigger and the shared secret

- **S3 trigger:** `ObjectCreated` notifications on the import bucket `voc-import` for each suffix.
  The bucket is versioned, KMS-encrypted and expires staged files after 90 days
  ([data-lake-structure.md](data-lake-structure.md)).
- **Shared secret:** `voc-datalake/api-credentials` (with the account/region suffix), seeded with
  every loaded plugin's `secrets` as `<id>_<key>`, plus `webscraper_configs: "[]"`. The ingestion
  stack outputs `ApiSecretsArn`, `LoadedPlugins` and `EnabledPlugins`.

## Writing an ingestor

An ingestor subclasses `BaseIngestor` (`plugins/_shared/base_ingestor.py`) and implements one
generator, `fetch_new_items()`:

```python
import os
import sys
from collections.abc import Generator

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from _shared.base_ingestor import BaseIngestor, logger, metrics, tracer
from shared.invocation_cost import measure_invocation_cost


class MySourceIngestor(BaseIngestor):
    def __init__(self, execution_id: str | None = None):
        super().__init__(execution_id=execution_id)
        self.api_key = self.secrets.get("api_key", "")  # bare key, prefix stripped

    def fetch_new_items(self) -> Generator[dict, None, None]:
        if not self.api_key:
            logger.warning("No API key configured for My Source")
            return
        last_id = self.get_watermark("last_id")
        ...  # call the source's API and yield one dict per item


@logger.inject_lambda_context
@tracer.capture_lambda_handler
@metrics.log_metrics(capture_cold_start_metric=True)
@measure_invocation_cost
def lambda_handler(event, context):
    execution_id = event.get("execution_id") if isinstance(event, dict) else None
    return MySourceIngestor(execution_id=execution_id).run()
```

Pass `execution_id` into the constructor. On a manual run the constructor clears the cached secret
before reading it, so credentials saved a moment earlier are used. Assigning `execution_id` after
construction skips that, and `plugins/test_manual_run_guard.py` fails on it.

### What `BaseIngestor` provides

| Member | Behaviour |
|--------|-----------|
| `self.secrets` | This plugin's keys from the shared secret, prefix stripped. Read in `__init__` |
| `self.source_platform` | The plugin id (`SOURCE_PLATFORM`) |
| `get_watermark(key, default=None)` / `set_watermark(key, value)` | String values in the watermarks table under `<id>#<key>`. A read or write error is logged, not raised |
| `normalize_item(item)` | Archives the raw item and builds the queue message (below) |
| `send_to_queue(items)` | Applies the source policy, sends in batches, retries failed entries and raises if any item could not be queued. Returns the confirmed count |
| `run()` | The whole run, below |

`run()` does the following:

1. Returns `{"status": "skipped", "reason": "circuit_breaker_open"}` when the breaker is open.
2. On a manual run, writes `status: running` to the `SOURCE_RUN#<id>` row.
3. Iterates `fetch_new_items()`, normalizes each item and sends a batch to SQS every 100 items.
4. Sets the `last_id` watermark to the id of the **last item yielded**. Order your items, or manage
   your own watermark keys, if "last" is not "newest" for your source.
5. On success: clears the circuit breaker, writes `completed` with `items_found`, returns
   `{"status": "success", "items_processed": n}`.
6. On an exception: emits `IngestionErrors`, writes `error` with the exception **type** only
   (the run row is visible to every signed-in user; the full message stays in the logs), records a
   circuit-breaker failure and re-raises.

A construction failure (for example, no secret key under the plugin's prefix) is reported the same
way before it propagates. See [Secrets](#secrets).

### Item fields

`fetch_new_items()` yields plain dicts:

| Field | Required | Notes |
|-------|----------|-------|
| `id` | Yes | Stable id from the source, ≤ 256 chars. The processor de-duplicates on `source_platform` + `id` |
| `text` | Yes | The feedback, ≤ 50,000 chars. A message without text is dropped |
| `created_at` | Recommended | ISO 8601. Missing or unparseable values fall back to the ingestion time. More than one day in the future is refused |
| `rating` | No | Number from 1 to 10 |
| `url` | No | `http://` or `https://`, ≤ 4,096 chars. Stored as the item's `source_url` |
| `channel` | No | Sub-channel such as `review` or `comment` (default `unknown`), ≤ 128 chars |
| `author` | No | Trimmed, cut at 256 chars |
| `title` | No | Trimmed, cut at 500 chars |
| `brand_handles_matched` | No | Up to 10 strings |
| `dimensions` / `tags` | No | Values the source already knows; the processor keeps only what the dimensions config admits ([dimensions.md](dimensions.md)) |
| `issue_attributes` | No | Issue-tracker fields (`github_issues`) |
| `source_platform_override` | No | Archive and send under a different source id |

A `url` that still contains a control character, an invisible format character or a Unicode
line/paragraph separator after trimming fails validation and dead-letters the item. Percent-encoded
characters such as `%0A` are fine.

### Normalization, archive and source policy

`normalize_item()` produces the message the processor validates: `id`, `source_platform`,
`source_channel`, `url`, `text`, `rating`, `created_at`, `ingested_at`, `brand_name`,
`brand_handles_matched`, the optional fields above, and `s3_raw_uri`. It first writes the raw item
to `raw/<id>/<yyyy>/<mm>/<dd>/<item id>.json`, partitioned by the item's own `created_at` date, so a
re-ingest overwrites the same object. If the S3 write fails, the item is sent inline in `raw_data`
instead, so the feedback is not lost.

Before archiving and before queueing, the source's profile applies its PII policy (`allow`, `redact`
or `summary_only`, [source-policies.md](source-policies.md)). A `redact` or `summary_only` source
keeps no raw copy. If the profiles cannot be read, the run fails and is retried rather than
archiving under the default.

## Writing a webhook

A webhook subclasses `BaseWebhook` (`plugins/_shared/base_webhook.py`) and implements
`parse_webhook_payload(body, headers) -> list[dict]`, returning items in the same shape as an
ingestor yields. `handle(event, context)` decodes the body, calls the parser, normalizes
(`source_channel` defaults to `webhook`, `is_webhook: true`) and queues the items.

`handle()` performs **no authentication**. The route is public, so the plugin's `lambda_handler`
must verify the request before calling it. `github_issues` is the reference implementation
(`plugins/github_issues/webhook/handler.py`):

- no `webhook_secret` configured: 503, every delivery refused;
- body over 1,000,000 bytes: 413;
- `X-Hub-Signature-256` missing or not equal, under `hmac.compare_digest`, to
  `sha256=` + HMAC-SHA256 of the exact body: 401.

Each refusal emits a `webhook.rejected` audit event and the `WebhookRejected` metric. A verified
delivery answers 200, an invalid JSON body 400, an unreadable source policy 503 and any other
failure 500. A webhook that wants a raw archive copy calls `archive_raw_item()`
(`_shared/raw_archive.py`) in its `normalize_item()`, as `github_issues` does.

A webhook has no manual run, and providers stop retrying after a while. While its secret is
missing or mis-prefixed, every delivery fails with a 5xx. Pair a webhook with a scheduled ingestor
that polls the same items, as `github_issues` does, so the processor's de-duplication fills any gap.

## The queue message contract

The processor validates every message against `IngestMessage` in `lambda/shared/ingest_schemas.py`
(Pydantic, unknown fields forbidden). A message that fails is logged to the `LOGS#validation#<source>`
rows read by `GET /logs/validation`, counted in `ValidationFailures` and goes to
`voc-processing-dlq` after three receives.

| Limit | Value |
|-------|-------|
| `id` | 1-256 chars, not blank after control characters are stripped |
| `source_platform` | 1-256 chars |
| `text` | 1-50,000 chars; control characters removed, 3+ newlines collapsed to 2 |
| `rating` | 1-10 |
| `url`, `source_url` | ≤ 4,096 chars, `http(s)://` only |
| `source_channel` / `channel` | ≤ 128 chars |
| `language` | `xx` or `xx-XX` |
| `brand_handles_matched` | ≤ 10 entries |
| `dimensions` | ≤ 10 entries; keys ≤ 32, values ≤ 64 chars |
| `metadata` | Fixed set of typed keys (`MessageMetadata`), not an arbitrary object |
| `s3_raw_uri` | ≤ 512 chars |

The base classes build conforming messages. Code that builds messages by hand must stay inside
these limits.

## Secrets

All plugins share one Secrets Manager secret. Every ingestor role and the webhook role can read the
whole secret, so the namespace is the boundary between plugins:

- CDK stores each manifest key as `<id>_<key>`. Declare keys by their **bare** name; a key written
  pre-prefixed in the manifest is stored twice-prefixed and never found.
- `filter_plugin_secrets()` (`_shared/plugin_secrets.py`) returns only the keys that start with
  `<id>_`, with the prefix removed. Both base classes call it from `__init__`.
- It **fails closed**. A missing or malformed plugin identity, a secret that is not a JSON object,
  or no key under the prefix raises `ConfigurationError`. The error names the plugin and the
  expected prefix, never a value or another plugin's keys. The log line starts with
  `Refusing to load plugin secrets`.

Consequences for plugin authors:

- **Declare at least one key in `secrets`.** A plugin with none cannot construct.
  `plugins/_shared/test/test_plugin_secret_isolation.py` fails on such a manifest. If a plugin
  needs no configuration, declare one key anyway, or override `_load_secrets()` to return `{}`.
  Not reading `self.secrets` does not help: the read happens in `__init__`.
- **An empty secret payload is treated as a read failure.** `get_secret` swallows client errors
  into `{}`, so the base classes evict the cached value and raise `SecretUnreadableError`. That
  error is reported (run row, `plugin.failed` audit event) but not counted by the circuit breaker,
  so a few Secrets Manager throttles cannot disable a healthy plugin's schedule. Misconfigurations
  are counted.
- **A scheduled run leaves no run row**, so for a scheduled plugin the only signals of a secret
  problem are the log line and the audit event. Create a CloudWatch metric filter and alarm on
  `Refusing to load plugin secrets` in the plugin's log group; no stack creates one.

Two guards stop one plugin from reading another's keys through a prefix collision. The loader
refuses a manifest id that is a prefix of another. The integrations API accepts only the
manifest-derived plugin ids as `<source>` on every route, so a request cannot store
`app_reviews_ios_app_id` by addressing an invented source `app_reviews`. Neither guard removes keys
stored before an upgrade; delete such keys by hand.

### Routes that touch plugin resources

`<source>` reaches a secret key, an ingestor function name and a schedule rule name. Writes are
admin-only because they change a shared secret, spend a third-party API's quota or stop ingestion.

| Route | Admin | Purpose |
|-------|-------|---------|
| `GET /integrations/status` | No | Which sources have credentials |
| `GET`/`PUT /integrations/<source>/credentials` | Yes | Read (secret fields omitted) and save config values |
| `GET /integrations/<source>/apps` | No | List app/page configs of a multi-target source (public ids and display names only) |
| `POST /integrations/<source>/apps`, `DELETE /integrations/<source>/apps/<app_id>` | Yes | Add or remove one target |
| `POST /sources/<source>/run` | Yes | **Run now**: async invoke with `{execution_id}` (and `app_id` when given) |
| `GET /sources/status` | No | Schedule state, latest run and `circuit` per source (`last_error` for admins only) |
| `PUT /sources/<source>/enable` | Yes | Close a tripped breaker, then enable the schedule |
| `PUT /sources/<source>/disable` | Yes | Disable the schedule |
| `POST /sources/<source>/reset` | Yes | Close a tripped breaker without enabling the schedule |

`POST /sources/<source>/run` writes the `SOURCE_RUN#<source>` row (`status: running`) before it
invokes the ingestor; the settings card polls it until `completed` or `error`. Scraper writes
(`POST`/`DELETE /scrapers`, `POST /scrapers/{id}/run`, `POST /scrapers/analyze-url`) are admin-only
for the same reasons ([scrapers.md](scrapers.md)).

## Circuit breaker

`plugins/_shared/circuit_breaker.py` stops a plugin that keeps failing.

- **Trip:** 5 counted failures within 15 minutes. State lives in the aggregates table: one
  `FAILURES#<id>` / `<iso timestamp>` row per failure (24-hour TTL) and, while tripped,
  `CIRCUIT#<id>` / `TRIPPED` with `tripped_at`, `failure_count` and `last_error` (≤ 500 chars).
- **On trip,** three independent steps run, each logged and metered on failure without skipping
  the others: write the `TRIPPED` row, call `events:DisableRule` on the plugin's own schedule
  (scheduled plugins only), emit a `plugin.disabled` audit event. Failure metrics:
  `CircuitBreakerTripRecordFailed`, `CircuitBreakerScheduleDisableFailed`.
- **While tripped,** every run returns `skipped` at once. A successful run deletes the row.
- **Recovery:** the source card in **Administration → Sources → Source settings** shows "Paused
  after repeated failures" with the time, count and reason. Turning the source back on
  (`PUT /sources/<source>/enable`) closes the breaker and enables the schedule; **Reset**
  (`POST /sources/<source>/reset`) only closes the breaker. Failure rows are kept, so a plugin that
  is still broken trips again on its next failure.

## Observability

**Logs.** Each Lambda logs JSON through Powertools to its own log group, including one
`invocation_cost` line per invocation from `measure_invocation_cost`.

**Audit events.** `_shared/audit.py` writes each event as one log line with the message `AUDIT` and
an `audit_event` object (`timestamp`, `action`, `plugin_id`, `success`, `details`). The base classes
emit `plugin.invoked`, `message.ingested` (per item), `plugin.completed`, `plugin.failed`,
`plugin.disabled` (circuit breaker), `webhook.received` and `webhook.rejected`. Example Logs
Insights queries:

```
# Failed runs of every plugin in the selected log groups
fields @timestamp, audit_event.plugin_id, audit_event.details.error_type
| filter message = "AUDIT" and audit_event.action = "plugin.failed"
| sort @timestamp desc

# Rejected webhook deliveries by reason
fields @timestamp, audit_event.details.reason
| filter message = "AUDIT" and audit_event.action = "webhook.rejected"
| stats count() by audit_event.details.reason
```

**Metrics** (CloudWatch namespace `VoC`): `ItemsIngested`, `IngestionErrors`,
`WebhookItemsIngested`, `WebhookErrors`, `WebhookRejected` and the two circuit-breaker metrics.

**Alarms.** No alarm is deployed by CDK. An administrator turns alerting on in
**Administration → System → Logs → Alerts**; the logs API then creates alarms on ingestor errors,
the processing DLQ and the schedule DLQ, among others, and sends them to one SNS topic
([deployment.md](deployment.md)). Per-request diagnosis is under
**Administration → System → Logs → System errors**.

## Frontend

`scripts/generate-manifests.ts` writes, for every loaded plugin: `id`, `name`, `icon`,
`description`, `category`, `config`, `webhooks`, `setup`, `version`, `hasIngestor`, `hasWebhook`,
`hasS3Trigger` and `enabled` (from `pluginStatus`). `frontend/src/plugins/index.ts` validates the
file with Zod at load and exposes `getPluginManifests()`, `getEnabledPlugins()` and
`getSyntheticPlugins()`.

The UI is driven by the manifest; a plugin cannot ship its own components. Enabled plugins appear
as cards in **Administration → Sources → Source settings** (`SourceCard`): the config form, the
webhook URL (`<api>/webhooks/<id>`) when `webhooks` is set, setup steps, the schedule toggle,
**Run now**, run history and the circuit-breaker notice. The **Data sources** page (`/scrapers`)
lists sources too, and offers `synthetic` plugins as generators.

### Icons and translations

`icon` is a word mapped to a lucide icon in `frontend/src/components/SourceIcon/sourceIcons.ts`:
`Web`, `iOS`, `Android`, `GitHub`, `Package`, `Synthetic` or `Plugin`. An unknown word falls back to
`Package` for `import` plugins and `Plug` otherwise. Emoji are not allowed
(`frontend/src/noEmoji.test.ts`).

The card shows the plugin's name and description from the locale files, not the manifest. Add
`pluginCopy.<camelCaseId>.name` and `.description` to `frontend/public/locales/<lang>/settings.json`
in all nine locales (`de`, `en`, `es`, `fr`, `ja`, `ko`, `pl`, `pt`, `zh`), and the id to
`PLUGIN_COPY_KEYS` in `frontend/src/plugins/pluginCopy.ts`. `pluginCopy.test.tsx` fails for a
manifest without them.

## Tooling

Run these from the repository root (they forward to `voc-datalake/`):

| Command | What it does |
|---------|--------------|
| `npm run validate:plugins` | Loads and validates every manifest, prints a summary; `--verify-integrity` (run in `voc-datalake/`: `npx ts-node scripts/validate-plugins.ts --verify-integrity`) also checks recorded hashes |
| `npm run generate:manifests` | Regenerates `frontend/src/plugins/manifests.json` |
| `npm run generate:config` | `generate:manifests` plus the menu config |
| `cd voc-datalake && npm run generate:integrity [-- <id>]` | Writes `integrity` hashes into manifests |

An integrity hash is the SHA-256 of every `.py` file under `ingestor/` or `webhook/` (sorted,
`__pycache__` excluded). The synth does not verify hashes, and no bundled manifest records one; use
them when you review third-party plugin code and want to detect later edits.

Plugin tests are pytest files under the plugin folder. `plugins/conftest.py` sets fake environment
variables and blocks real AWS calls. Run one plugin's tests with
`cd voc-datalake && .venv/bin/python -m pytest plugins/<id> -q`.

## Security model

| Layer | Control |
|-------|---------|
| Manifest | Zod schema with identifier, path and string allowlists; timeout ≤ 900 s, memory ≤ 1,024 MB; schedule not more often than once a minute; id prefix collisions refused |
| IAM | Base grants only; Bedrock, browser and `DisableRule` only on a dedicated role; raw bucket write-only under `raw/` |
| Secrets | `<id>_` namespace, fail-closed filter, admin-only writes, `secret` fields write-only |
| Webhooks | Public route with a 10 rps / 20 burst throttle; signature verified in the handler before parsing |
| Queue | Pydantic validation of every message; invalid messages logged and dead-lettered |
| Data | Source PII policy applied before archive and queue; only `voc-retention` deletes customer data |
| Runtime | Circuit breaker, audit log lines, runtime-created alarms |

Review a community plugin's code before you enable it. Every ingestor role can read the whole
shared secret, so the namespace filter protects against mistakes, not against code written to read
other plugins' keys.

## FAQ

**Do I need to redeploy to add a plugin?** Yes. A deploy creates its Lambda, schedule and secret
keys. Turning an existing schedule on or off does not need a deploy.

**Can a plugin have no Lambda?** A plugin needs an ingestor or a webhook to receive data. A
manifest without either loads, but nothing ingests for it.

**Where are credentials stored?** In the `voc-datalake/api-credentials-<account>-<region>` secret
(prefixed when you deploy with `deploymentPrefix`). The `ApiSecretsArn` output of the ingestion
stack names it.

**How do I disable a plugin completely?** Set it to `false` in `pluginStatus` and deploy. Its
Lambda and schedule are removed and its card is hidden; its secret keys stay.
