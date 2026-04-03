# Plugin Architecture for Data Source Connectors

## Overview

This document describes the plugin-based architecture for VoC data source connectors. The goal is to make connectors modular, self-contained, and easy to add or remove without modifying core platform code.

## Why a Plugin Architecture?

### Current Problems (Pre-Plugin)

1. **Tight coupling**: Data sources were hardcoded across multiple files (frontend UI, CDK stacks, context config).
2. **Difficult to contribute**: Adding a new connector required changes in 4+ files across frontend and backend.
3. **No single source of truth**: UI fields, infrastructure config, and secrets were defined separately.

### Benefits of Plugin Architecture

1. **Self-contained**: Each connector lives in its own folder with everything it needs.
2. **Single source of truth**: One `manifest.json` drives both infrastructure deployment and UI rendering.
3. **Easy to contribute**: Drop a folder, deploy, done.
4. **Open source friendly**: Community can contribute connectors without understanding the whole platform.
5. **Enable/disable without redeploy**: Runtime toggle via Settings UI.

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                         Plugin Folder                                │
│  plugins/{connector-id}/                                            │
│  ├── manifest.json      ← Single source of truth                    │
│  ├── ingestor/          ← Polling Lambda (optional)                 │
│  │   └── handler.py                                                 │
│  └── webhook/           ← Webhook Lambda (optional)                 │
│      └── handler.py                                                 │
└─────────────────────────────────────────────────────────────────────┘
                                   │
                                   ▼
┌─────────────────────────────────────────────────────────────────────┐
│                      CDK Plugin Loader                              │
│  - Scans plugins/ folder                                            │
│  - Validates manifests with Zod (security-hardened schemas)         │
│  - Verifies code integrity via SHA-256 hashes                       │
│  - Creates Lambda functions                                         │
│  - Creates EventBridge schedules                                    │
│  - Creates API Gateway webhook routes                               │
│  - Aggregates secrets template (prefixed per plugin)                │
└─────────────────────────────────────────────────────────────────────┘
                                   │
                                   ▼
┌─────────────────────────────────────────────────────────────────────┐
│                      Frontend Build                                  │
│  - Extracts UI-relevant fields from manifests                       │
│  - Reads pluginStatus from cdk.context.json for enabled flag        │
│  - Generates manifests.json bundle                                  │
│  - Settings page renders dynamically from manifests                 │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Folder Structure

```
voc-datalake/
├── plugins/
│   ├── _shared/                      # Shared code for all plugins
│   │   ├── __init__.py               # Exports BaseIngestor, BaseWebhook, etc.
│   │   ├── base_ingestor.py          # Base class for polling ingestors
│   │   ├── base_webhook.py           # Base class for webhook handlers
│   │   ├── circuit_breaker.py        # Auto-disable after repeated failures
│   │   ├── audit.py                  # Structured audit logging + EventBridge
│   │   ├── schemas.py                # Pydantic message validation schemas
│   │   └── test/                     # Tests for shared modules
│   │
│   ├── _template/                    # Starter template for new plugins
│   │   ├── manifest.json
│   │   ├── ingestor/
│   │   │   └── handler.py
│   │   └── README.md
│   │
│   └── webscraper/                   # Web scraper plugin
│       ├── manifest.json
│       └── ingestor/
│           └── handler.py
│
├── lib/
│   ├── plugin-loader.ts              # Discovers and validates plugins
│   └── stacks/
│       ├── ingestion-stack.ts        # Creates ingestor Lambdas from plugins
│       └── api-stack.ts              # Creates webhook routes from plugins
│
├── scripts/
│   ├── generate-manifests.ts         # Generates frontend manifests.json
│   ├── generate-integrity.ts         # Generates SHA-256 code hashes
│   ├── validate-plugins.ts           # Validates plugin configurations
│   └── test-plugin-loader.ts         # Tests plugin loading
│
└── frontend/src/
    ├── plugins/
    │   ├── index.ts                  # Plugin loader (getEnabledPlugins, etc.)
    │   ├── types.ts                  # Zod schemas + TypeScript types
    │   └── manifests.json            # Generated at build time
    └── pages/Settings/
        ├── Settings.tsx              # Reads from manifests.json
        └── SourceCard.tsx            # Renders based on manifest config
```

---

## The Manifest File

The `manifest.json` is the single source of truth for each plugin. It defines:

- **Identity**: Name, icon, description
- **Infrastructure**: What AWS resources to deploy
- **Configuration**: What fields the user needs to fill in
- **Secrets**: What credentials to store in Secrets Manager
- **Setup instructions**: How to configure the external service
- **Version**: Semver version string
- **Integrity**: SHA-256 hashes for code verification

### Manifest Schema

```json
{
  "id": "webscraper",
  "name": "Web Scraper",
  "icon": "🕷️",
  "description": "Configurable scraper for extracting feedback from websites",
  "category": "import",
  "version": "1.0.0",

  "infrastructure": {
    "ingestor": {
      "enabled": true,
      "schedule": "rate(15 minutes)",
      "timeout": 300,
      "memory": 512
    }
  },

  "config": [
    {
      "key": "configs",
      "label": "Scraper Configurations (JSON)",
      "type": "textarea",
      "placeholder": "[{\"id\": \"example\", ...}]",
      "required": false,
      "secret": false
    }
  ],

  "setup": {
    "title": "Web Scraper Setup",
    "color": "gray",
    "steps": [
      "Configure scrapers via the Scrapers page in the dashboard",
      "Each scraper can use CSS selectors or JSON-LD extraction",
      "Supports pagination and custom frequencies",
      "Test scrapers before enabling them",
      "Scrapers run automatically based on their configured frequency"
    ]
  },

  "secrets": {
    "configs": "[]"
  }
}
```

### Field Definitions

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | Yes | Unique identifier (lowercase, underscores, max 32 chars) |
| `name` | string | Yes | Display name in UI (max 256 chars, no control chars) |
| `icon` | string | Yes | Emoji or path to SVG icon (max 64 chars) |
| `description` | string | No | Short description shown in UI |
| `category` | enum | No | One of: `reviews`, `social`, `import`, `search`, `scraper` |
| `infrastructure` | object | Yes | AWS resources to deploy |
| `config` | array | Yes | Configuration fields for UI (max 20 fields) |
| `webhooks` | array | No | Webhook endpoints to display in UI (max 5) |
| `setup` | object | No | Setup instructions for UI (max 15 steps) |
| `secrets` | object | No | Secret keys to add to Secrets Manager template |
| `version` | string | No | Semver version (e.g., `1.0.0`) |
| `minPlatformVersion` | string | No | Minimum platform version required |
| `integrity` | object | No | SHA-256 hashes for code verification |

### Infrastructure Options

#### Ingestor (Polling Lambda)

```json
"ingestor": {
  "enabled": true,
  "schedule": "rate(15 minutes)",
  "timeout": 120,
  "memory": 256
}
```

- Schedule uses EventBridge rate or cron expressions
- Schedule is created but **disabled by default** — user enables via Settings UI
- If `schedule` is omitted, no EventBridge rule is created (useful for S3-triggered lambdas)
- Timeout max: 300 seconds (enforced by plugin loader)
- Memory max: 1024 MB (enforced by plugin loader)

#### Webhook (API Gateway Route)

```json
"webhook": {
  "enabled": true,
  "path": "/webhooks/my_source",
  "methods": ["POST"],
  "signatureHeader": "X-Signature",
  "signatureMethod": "hmac_sha256"
}
```

- Creates a Lambda function and API Gateway integration in `api-stack.ts`
- No authentication (webhooks must be accessible by external services)
- Webhook URL is displayed in Settings UI for user to copy
- Methods restricted to: `GET`, `POST`, `PUT`, `DELETE` (max 4)
- Path must start with `/` and contain only safe characters (no traversal)

#### S3 Trigger

```json
"s3Trigger": {
  "enabled": true,
  "suffixes": [".csv", ".json", ".jsonl"]
}
```

- Triggers Lambda when files with matching suffixes are uploaded to S3 import bucket
- No schedule needed — event-driven
- Max 5 suffixes allowed

### Config Field Types

| Type | Renders As | Use Case |
|------|-----------|----------|
| `text` | Single line input | IDs, names, non-sensitive values |
| `password` | Masked input with show/hide | API keys, tokens, secrets |
| `textarea` | Multi-line input | Lists of IDs, JSON configs |
| `select` | Dropdown | Predefined options |

### Config Field Properties

```json
{
  "key": "api_key",
  "label": "API Key",
  "type": "password",
  "required": true,
  "placeholder": "Enter your API key",
  "secret": true
}
```

- `key`: Safe identifier (lowercase alphanumeric + underscores, max 64 chars)
- `label`: Display label in UI (max 256 chars, no control characters or XSS patterns)
- `secret`: If `true`, stored in Secrets Manager; otherwise stored in config

---

## Shared Plugin Modules (`_shared/`)

The `_shared/` directory contains base classes and utilities used by all plugins.

### `__init__.py`

Exports the public API:

```python
from .base_ingestor import BaseIngestor
from .base_webhook import BaseWebhook
from .audit import emit_audit_event, AuditAction
from .circuit_breaker import CircuitBreaker
```

### `base_ingestor.py`

Base class for all polling ingestors. Provides:

- **Secrets loading** with per-plugin prefix isolation
- **Watermark management** via DynamoDB (get/set per source+key)
- **S3 raw data storage** with partitioned keys (`raw/{source}/{year}/{month}/{day}/{id}.json`)
- **Deterministic S3 IDs** to prevent duplicates (source ID or SHA-256 content hash)
- **SQS batch sending** (batches of 10, with 100-item flush threshold)
- **Circuit breaker integration** (checks before run, records success/failure)
- **Audit event emission** at each lifecycle stage
- **Item normalization** with `source_platform_override` support

Key methods:

| Method | Description |
|--------|-------------|
| `fetch_new_items()` | Abstract — subclasses implement data fetching |
| `get_watermark(key)` | Read watermark from DynamoDB |
| `set_watermark(key, value)` | Write watermark to DynamoDB |
| `normalize_item(item)` | Normalize to common schema + store raw to S3 |
| `store_raw_to_s3(item)` | Store raw data with partitioned S3 key |
| `send_to_queue(items)` | Send batch to SQS processing queue |
| `run()` | Main execution: circuit breaker check → fetch → normalize → queue |

### `base_webhook.py`

Base class for webhook handlers. Provides:

- **Secrets loading** with prefix isolation (same as base_ingestor)
- **Body parsing** (JSON, base64-encoded)
- **Item normalization** (similar to base_ingestor but with `is_webhook: True`)
- **SQS batch sending**
- **Client IP extraction** from API Gateway event
- **Audit event emission**
- **Error handling** with structured responses (400 for bad JSON, 500 for errors)

### `circuit_breaker.py`

Auto-disables plugins after repeated failures:

- Tracks failures in DynamoDB with TTL (24h auto-cleanup)
- Configurable threshold (default: 5 failures) and window (default: 15 minutes)
- When tripped: disables the EventBridge schedule rule via `events.disable_rule()`
- Records trip state in DynamoDB (`CIRCUIT#{plugin_id}#TRIPPED`)
- Emits `plugin.disabled` audit event
- Resets on successful run (`record_success()` clears trip state)

### `audit.py`

Structured audit logging for all plugin operations:

- Always logs to CloudWatch via Powertools logger
- Optionally sends to EventBridge (if `AUDIT_EVENT_BUS` is configured)
- Typed actions: `plugin.invoked`, `plugin.completed`, `plugin.failed`, `plugin.disabled`, `webhook.received`, `webhook.rejected`, `message.ingested`, etc.

### `schemas.py`

Pydantic validation schemas for messages entering the processing pipeline:

- **`IngestMessage`**: Validates required fields (`id`, `source_platform`, `text`, `created_at`), optional fields (`rating`, `url`, `author`, `title`, `language`, etc.)
- **`MessageMetadata`**: Flat metadata with primitive values only (no nested objects for security)
- **Sanitization**: Strips control characters, normalizes whitespace, validates URLs
- **Constraints**: Max text 50KB, max ID 256 chars, max URL 2048 chars, rating 1-5, `created_at` not more than 1 day in the future
- **`validate_message()`** and **`safe_validate_message()`** functions for use by the processor

---

## CDK Implementation

### Plugin Loader (`lib/plugin-loader.ts`)

The plugin loader scans the `plugins/` directory, validates manifests with security-hardened Zod schemas, and provides them to CDK stacks.

#### Security Features

The Zod schemas enforce:

- **`PluginIdSchema`**: Lowercase alphanumeric + underscores, max 32 chars, must start with letter
- **`SafeStringSchema`**: No control characters, no `<script>`, `javascript:`, or `data:` patterns
- **`SafePathSchema`**: Must start with `/`, no `..` traversal, no `//`
- **`ScheduleSchema`**: Only valid EventBridge rate/cron expressions
- **`ConfigKeySchema`**: Safe identifier pattern
- **`IntegritySchema`**: SHA-256 hash format validation

#### Manifest Limits

Enforced at load time:

- Timeout: max 300 seconds
- Memory: max 1024 MB
- Schedule: cannot be more frequent than 1 minute
- Config fields: max 20
- Setup steps: max 15
- Webhook info: max 5
- S3 trigger suffixes: max 5

#### Code Integrity Verification

Optional SHA-256 verification of plugin code:

```typescript
loadPlugins(pluginsDir, { verifyIntegrity: true });
```

Computes SHA-256 hash of all `.py` files in `ingestor/` and `webhook/` directories and compares against `integrity` field in manifest.

Generate hashes with:

```bash
npx ts-node scripts/generate-integrity.ts
```

#### Secret Aggregation

Secrets are prefixed with the plugin ID for isolation:

```typescript
export function aggregateSecrets(plugins: PluginManifest[]): Record<string, string> {
  const secrets: Record<string, string> = {};
  for (const plugin of plugins) {
    if (plugin.secrets) {
      for (const [key, value] of Object.entries(plugin.secrets)) {
        secrets[`${plugin.id}_${key}`] = value;  // e.g., "webscraper_configs"
      }
    }
  }
  return secrets;
}
```

At runtime, `BaseIngestor._load_secrets()` strips the prefix so plugins access secrets by their clean key name (e.g., `self.secrets.get("configs")`).

### Ingestion Stack (`lib/stacks/ingestion-stack.ts`)

The ingestion stack uses the plugin loader to dynamically create resources for each enabled plugin.

```typescript
// Load plugins from manifests
const pluginsDir = path.join(__dirname, '../../plugins');
const allPlugins = loadPlugins(pluginsDir);
const enabledPlugins = getEnabledPlugins(allPlugins, config.enabledSources);

// Secrets Manager - aggregated from all plugins (prefixed)
const apiSecrets = this.createApiSecrets(allPlugins);

// Create Lambda for each enabled plugin with ingestor
const ingestorPlugins = getPluginsWithIngestor(enabledPlugins);
for (const plugin of ingestorPlugins) {
  this.createIngestorLambda(plugin, ingestionRole, commonEnv, dependenciesLayer, aggregatesTable);
}
```

#### Lambda Bundling

Each plugin Lambda bundles three code sources:

```typescript
private bundlePluginCode(pluginId: string): lambda.Code {
  return lambda.Code.fromAsset('.', {
    bundling: {
      image: lambda.Runtime.PYTHON_3_14.bundlingImage,
      command: ['bash', '-c', [
        'mkdir -p /asset-output',
        // 1. Plugin ingestor code
        `cp -r /asset-input/plugins/${pluginId}/ingestor/* /asset-output/`,
        // 2. Plugin shared modules (_shared/)
        'cp -r /asset-input/plugins/_shared /asset-output/',
        // 3. Lambda shared modules (logging, aws, http)
        'cp -r /asset-input/lambda/shared /asset-output/',
      ].join(' && ')],
      platform: 'linux/arm64',
    },
  });
}
```

This means each Lambda deployment package contains:
- The plugin's own `handler.py` (and any other files in `ingestor/`)
- The `_shared/` directory (base classes, circuit breaker, audit, schemas)
- The `lambda/shared/` directory (logging, AWS client helpers, HTTP utilities)

#### Lambda Configuration

```typescript
const fn = new lambda.Function(this, `Ingestor${capitalize(plugin.id)}`, {
  functionName: uniqueName(`voc-ingestor-${plugin.id}`),
  runtime: lambda.Runtime.PYTHON_3_14,
  architecture: lambda.Architecture.ARM_64,
  handler: 'handler.lambda_handler',
  code: ingestorCode,
  role: ingestionRole,  // Shared role for all plugins
  timeout: cdk.Duration.seconds(infra.timeout),
  memorySize: infra.memory,
  environment: {
    ...commonEnv,
    SOURCE_PLATFORM: plugin.id,
    PLUGIN_ID: plugin.id,
  },
  layers: [dependenciesLayer],
  logGroup: new logs.LogGroup(this, `IngestorLogs${capitalize(plugin.id)}`, {
    logGroupName: uniqueName(`/aws/lambda/voc-ingestor-${plugin.id}`),
    retention: logs.RetentionDays.TWO_WEEKS,
    removalPolicy: cdk.RemovalPolicy.DESTROY,
  }),
});
```

Key details:
- Runtime: Python 3.14 on ARM64 (Graviton)
- Each plugin gets its own CloudWatch Log Group with 2-week retention
- EventBridge schedule is disabled by default
- All plugins share a single IAM role with minimal permissions

### API Stack — Webhooks (`lib/stacks/api-stack.ts`)

Webhook routes are created in the API stack (not a separate analytics stack):

```typescript
const pluginsDir = path.join(__dirname, '../../plugins');
const allPlugins = loadPlugins(pluginsDir);
const enabledPlugins = getEnabledPlugins(allPlugins, props.enabledSources);
const webhookPlugins = getPluginsWithWebhook(enabledPlugins);

// Create webhook Lambdas
for (const plugin of webhookPlugins) {
  const webhookFn = this.createWebhookLambda(plugin, webhookRole, ...);
  webhookLambdas.set(plugin.id, webhookFn);
}

// Create API Gateway routes under /webhooks/{pluginId}
const webhooksResource = this.api.root.addResource('webhooks');
for (const plugin of webhookPlugins) {
  const pluginResource = webhooksResource.addResource(plugin.id);
  for (const method of plugin.infrastructure.webhook.methods) {
    pluginResource.addMethod(method, webhookIntegration);  // No auth
  }
}
```

Webhook Lambdas:
- Runtime: Python 3.14 on ARM64
- Timeout: 30 seconds (fixed)
- Memory: 256 MB (fixed)
- Bundling: copies `plugins/{id}/webhook/*` + `plugins/_shared/`
- No authentication (external webhooks must be publicly accessible)

---

## Frontend Implementation

### Build-Time Manifest Generation

The `scripts/generate-manifests.ts` script:

1. Loads all plugin manifests via `loadPlugins()`
2. Reads `pluginStatus` from `cdk.context.json` to determine enabled/disabled state
3. Extracts only UI-relevant fields
4. Writes `frontend/src/plugins/manifests.json`

```typescript
// scripts/generate-manifests.ts
const pluginStatus = loadPluginStatus();  // from cdk.context.json
const plugins = loadPlugins(pluginsDir);

const frontendManifests = plugins.map(plugin => ({
  id: plugin.id,
  name: plugin.name,
  icon: plugin.icon,
  description: plugin.description,
  category: plugin.category,
  config: plugin.config,
  webhooks: plugin.webhooks,
  setup: plugin.setup,
  hasIngestor: !!plugin.infrastructure.ingestor?.enabled,
  hasWebhook: !!plugin.infrastructure.webhook?.enabled,
  hasS3Trigger: !!plugin.infrastructure.s3Trigger?.enabled,
  version: plugin.version,
  enabled: pluginStatus[plugin.id] ?? false,  // from cdk.context.json
}));
```

Run via:

```bash
npm run generate:manifests
# or as part of the full config generation:
npm run generate:config
```

### Frontend Manifest Types (`frontend/src/plugins/types.ts`)

The frontend uses Zod for runtime validation of manifests:

```typescript
export const PluginManifestSchema = z.object({
  id: z.string(),
  name: z.string(),
  icon: z.string(),
  description: z.string().optional(),
  category: z.enum(['reviews', 'social', 'import', 'search', 'scraper']).optional(),
  config: z.array(ConfigFieldSchema),
  webhooks: z.array(WebhookInfoSchema).optional(),
  setup: SetupSchema.optional(),
  hasIngestor: z.boolean(),
  hasWebhook: z.boolean(),
  hasS3Trigger: z.boolean(),
  version: z.string().optional(),
  enabled: z.boolean(),
});
```

Includes type guards (`isPluginManifest`, `isPluginManifestArray`) and safe validation (`safeValidateManifests`).

### Loading Manifests (`frontend/src/plugins/index.ts`)

```typescript
import { safeValidateManifests, type PluginManifest } from './types';
import rawManifests from './manifests.json';

const validatedManifests = safeValidateManifests(rawManifests);
const manifests: PluginManifest[] = validatedManifests ?? [];

export function getPluginManifests(): PluginManifest[] { return manifests; }
export function getEnabledPlugins(): PluginManifest[] { return manifests.filter(m => m.enabled); }
export function getPluginById(id: string): PluginManifest | undefined { ... }
export function getPluginsByCategory(category: string): PluginManifest[] { ... }
export function getPluginsWithIngestor(): PluginManifest[] { ... }
export function getPluginsWithWebhook(): PluginManifest[] { ... }
export function getPluginsWithS3Trigger(): PluginManifest[] { ... }
```

### Settings Page

The Settings page renders plugin cards dynamically from manifests:

```tsx
import { getPluginManifests } from '../../plugins';

function DataSourcesSection({ apiEndpoint }) {
  const manifests = getPluginManifests();
  return (
    <div className="space-y-3">
      {manifests.map(manifest => (
        <SourceCard key={manifest.id} manifest={manifest} apiEndpoint={apiEndpoint} />
      ))}
    </div>
  );
}
```

Each `SourceCard` dynamically renders config fields based on the manifest's `config` array, supporting `text`, `password`, `textarea`, and `select` field types.

---

## Enable/Disable Flow

### How It Works

1. **Deploy time**: `pluginStatus` in `cdk.context.json` controls which plugins get AWS resources
2. **Runtime**: Settings UI toggles EventBridge rules on/off via API
3. **No redeploy needed** to enable/disable a deployed plugin

### Configuration

```json
// cdk.context.json
{
  "pluginStatus": {
    "webscraper": true
  }
}
```

The CDK entry point (`bin/voc-datalake.ts`) derives `enabledSources` from `pluginStatus`:

```typescript
const pluginStatus = app.node.tryGetContext('pluginStatus') || {};
const enabledSources = Object.entries(pluginStatus)
  .filter(([, enabled]) => enabled === true)
  .map(([pluginId]) => pluginId);
```

### API Endpoints for Enable/Disable

```
POST /sources/{sourceId}/enable   → Enables EventBridge schedule
POST /sources/{sourceId}/disable  → Disables EventBridge schedule
GET  /sources/status              → Returns status of all sources
```

---

## Creating a New Plugin

### Step-by-Step Guide

1. **Copy the template**

```bash
cp -r plugins/_template plugins/my_source
```

2. **Update the manifest** (`plugins/my_source/manifest.json`)

```json
{
  "id": "my_source",
  "name": "My Source",
  "icon": "🔌",
  "description": "Fetches data from My Source API",
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
    {
      "key": "api_key",
      "label": "API Key",
      "type": "password",
      "required": true,
      "secret": true
    }
  ],

  "setup": {
    "title": "My Source Setup",
    "color": "blue",
    "steps": [
      "Go to My Source developer portal",
      "Create an API key",
      "Paste the key above"
    ]
  },

  "secrets": {
    "api_key": ""
  }
}
```

3. **Implement the handler** (`plugins/my_source/ingestor/handler.py`)

```python
"""My Source Ingestor - Fetches data from My Source API."""
from typing import Generator

from _shared.base_ingestor import BaseIngestor, logger, tracer, metrics


class MySourceIngestor(BaseIngestor):
    """Ingestor for My Source API."""

    def __init__(self):
        super().__init__()
        # Secrets are prefix-stripped: "my_source_api_key" → "api_key"
        self.api_key = self.secrets.get("api_key", "")

    def fetch_new_items(self) -> Generator[dict, None, None]:
        """Fetch new items from My Source."""
        if not self.api_key:
            logger.warning("No My Source API key configured")
            return

        last_id = self.get_watermark("last_id")
        logger.info(f"Fetching items since last_id: {last_id}")

        # Implement your API fetching logic here
        # yield {
        #     "id": "unique_id",
        #     "text": "Feedback content",
        #     "rating": 4.5,
        #     "created_at": "2026-01-08T10:30:00Z",
        #     "url": "https://source.com/review/123",
        #     "channel": "review",
        #     "author": "John D.",
        #     "title": "Great product!",
        # }
        pass


@logger.inject_lambda_context
@tracer.capture_lambda_handler
@metrics.log_metrics(capture_cold_start_metric=True)
def lambda_handler(event, context):
    """Lambda entry point."""
    ingestor = MySourceIngestor()
    return ingestor.run()
```

4. **Enable the plugin** in `cdk.context.json`

```json
{
  "pluginStatus": {
    "webscraper": true,
    "my_source": true
  }
}
```

5. **Generate manifests and deploy**

```bash
npm run generate:config
cdk deploy VocIngestionStack
```

6. **Validate** (optional)

```bash
npm run validate:plugins
```

---

## Message Schema (Output Contract)

All plugins must output messages in this format to the SQS processing queue. Messages are validated by the Pydantic schemas in `_shared/schemas.py`.

### Required Fields

| Field | Type | Constraints | Description |
|-------|------|-------------|-------------|
| `id` | string | 1-256 chars | Unique identifier from the source |
| `source_platform` | string | `^[a-z][a-z0-9_]*$` | Plugin ID |
| `text` | string | 1-50,000 chars | The feedback content |
| `created_at` | datetime | Not >1 day in future | ISO 8601 timestamp |

### Optional Fields

| Field | Type | Constraints | Description |
|-------|------|-------------|-------------|
| `rating` | float | 1.0-5.0 | Rating (if applicable) |
| `url` | string | Max 2048 chars, http(s) | Source URL |
| `channel` | string | Max 64 chars | Sub-channel (review, comment, mention) |
| `author` | string | Max 256 chars | Author name/handle |
| `title` | string | Max 500 chars | Review title |
| `language` | string | `^[a-z]{2}(-[A-Z]{2})?$` | ISO language code |
| `brand_handles_matched` | string[] | Max 10 items | Which brand handles were matched |
| `metadata` | object | Flat primitives only | Plugin-specific additional data |
| `source_platform_override` | string | — | Override source for S3 partitioning |

### Validation

The `_shared/schemas.py` module provides Pydantic-based validation:

```python
from _shared.schemas import validate_message, safe_validate_message, MessageValidationError

# Raises MessageValidationError on failure
validated = validate_message(raw_dict)

# Returns (message, errors) tuple
message, errors = safe_validate_message(raw_dict)
```

Validation includes:
- Required field presence and type checking
- String sanitization (control character removal)
- URL format validation
- Future date rejection
- Metadata: flat primitives only (no nested objects)
- Extra fields rejected (`extra = "forbid"`)

---

## Infrastructure Isolation

### The Problem

If plugins can define arbitrary infrastructure, they could accidentally break core platform resources, create security vulnerabilities, cause unexpected costs, or conflict with other plugins.

### Solution: Constrained Plugin Infrastructure

Plugins don't define raw CDK/CloudFormation. Instead, they declare **what they need** in the manifest, and the platform creates resources using **controlled templates**.

### What Plugins CAN Declare

| Resource | Manifest Field | Platform Creates |
|----------|---------------|------------------|
| Polling Lambda | `infrastructure.ingestor` | Lambda with shared role, fixed limits |
| Webhook Lambda | `infrastructure.webhook` | Lambda + API Gateway route |
| S3 Trigger | `infrastructure.s3Trigger` | S3 event notification |
| Secrets | `secrets` | Entries in shared Secrets Manager (prefixed) |
| Schedule | `infrastructure.ingestor.schedule` | EventBridge rule (disabled by default) |

### What Plugins CANNOT Do

- Create IAM roles or policies
- Create DynamoDB tables
- Create S3 buckets
- Create VPCs or security groups
- Access resources outside the plugin sandbox
- Define arbitrary CloudFormation

### Shared IAM Role

All plugin Lambdas share a single, tightly-scoped IAM role:

```
┌──────────────────────────────────────────────────┐
│           Shared IAM Role                         │
│  - sqs:SendMessage (processing queue only)        │
│  - secretsmanager:GetSecretValue                  │
│  - s3:PutObject, s3:GetObject (raw bucket)        │
│  - dynamodb:GetItem/PutItem (watermarks table)    │
│  - dynamodb:ReadWrite (aggregates table)          │
│  - kms:Encrypt/Decrypt                            │
└──────────────────────────────────────────────────┘
                       ▲
      ┌────────────────┼────────────────┐
      │                │                │
┌─────┴─────┐  ┌──────┴─────┐  ┌──────┴─────┐
│ Plugin A  │  │ Plugin B   │  │ Plugin C   │
│ Lambda    │  │ Lambda     │  │ Lambda     │
└───────────┘  └────────────┘  └────────────┘
```

### Per-Plugin Resources (Isolated)

Each plugin gets its own:
- Lambda function (`voc-ingestor-{plugin-id}`)
- CloudWatch Log Group (`/aws/lambda/voc-ingestor-{plugin-id}`)
- EventBridge Rule (`voc-ingest-{plugin-id}-schedule`)
- Webhook route (`/webhooks/{plugin-id}`) if applicable

### Secrets Isolation

Plugins share a single Secrets Manager secret, but each plugin only accesses its own keys:

```python
# In base_ingestor.py
class BaseIngestor:
    def _load_secrets(self) -> dict:
        """Load only this plugin's secrets."""
        all_secrets = get_secret(SECRETS_ARN)

        # Filter to only keys prefixed with this plugin's ID
        prefix = f"{self.source_platform}_"
        filtered = {}
        for key, value in all_secrets.items():
            if key.startswith(prefix):
                clean_key = key[len(prefix):]
                filtered[clean_key] = value
            elif not any(key.startswith(f"{p}_") for p in self._get_known_prefixes()):
                filtered[key] = value  # Legacy/shared keys

        return filtered if filtered else all_secrets
```

This means:
- `webscraper` plugin sees: `configs` (from `webscraper_configs`)
- `my_source` plugin sees: `api_key` (from `my_source_api_key`)
- Plugins cannot read each other's secrets

---

## Testing

### Manifest Validation

```bash
# Validate all manifests at build time
npm run validate:plugins

# Generate frontend manifests (also validates)
npm run generate:manifests
```

### Plugin Handler Testing

Tests for shared modules live in `plugins/_shared/test/`:

```bash
cd voc-datalake
python -m pytest plugins/_shared/test/ -v
```

### Plugin Loader Tests

```bash
npx ts-node scripts/test-plugin-loader.ts
```

### Integration Testing

```bash
# Deploy to dev environment
cdk deploy --all

# Test via Settings UI:
# 1. Enable the source
# 2. Check CloudWatch logs for Lambda execution
# 3. Verify data appears in feedback table
```

---

## FAQ

### Q: Do I need to redeploy to add a new plugin?

**A:** Yes, adding a new plugin requires `cdk deploy` to create the Lambda and EventBridge resources. However, enabling/disabling an existing deployed plugin does not require redeployment — use the Settings UI toggle.

### Q: Can I have a plugin without a Lambda?

**A:** Not currently. Every plugin needs at least an ingestor or webhook Lambda.

### Q: How do I test a plugin locally?

**A:** You can run the handler directly (requires environment variables to be set):

```python
cd plugins/my_source/ingestor
python -c "from handler import MySourceIngestor; i = MySourceIngestor(); print(list(i.fetch_new_items()))"
```

### Q: Where are credentials stored?

**A:** All credentials are stored in AWS Secrets Manager under `voc-datalake/api-credentials-{hash}`. The secrets template is aggregated from all plugin manifests at deploy time, with each key prefixed by the plugin ID. You can find the exact secret name in the CloudFormation outputs of the VocIngestionStack.

### Q: Can plugins have custom UI components?

**A:** No, the UI is data-driven from the manifest. All plugins use the same SourceCard component with dynamic field rendering. This keeps the architecture simple and consistent.

### Q: What Python runtime do plugins use?

**A:** Python 3.14 on ARM64 (Graviton). All plugins share the same `ingestion-deps` Lambda layer which includes `requests`, `aws-lambda-powertools`, `beautifulsoup4`, `lxml`, and `tenacity`.

### Q: What happens when a plugin fails repeatedly?

**A:** The circuit breaker in `_shared/circuit_breaker.py` tracks failures in DynamoDB. After 5 failures within 15 minutes (configurable), it automatically disables the plugin's EventBridge schedule and emits an audit event. The plugin must be manually re-enabled via the Settings UI.
