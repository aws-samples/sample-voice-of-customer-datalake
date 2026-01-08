# Plugin Architecture for Data Source Connectors

## Overview

This document describes the plugin-based architecture for VoC data source connectors. The goal is to make connectors modular, self-contained, and easy to add or remove without modifying core platform code.

## Why a Plugin Architecture?

### Current Problems

1. **Tight coupling**: Data sources are hardcoded across multiple files:
   - `sourceConfig.ts` (frontend UI configuration)
   - `ingestion-stack.ts` (CDK infrastructure)
   - `analytics-stack.ts` (webhook routes)
   - `cdk.context.json` (enabled sources list)

2. **Difficult to contribute**: Adding a new connector requires changes in 4+ files across frontend and backend.

3. **No single source of truth**: UI fields, infrastructure config, and secrets are defined separately.

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
│  - Validates manifests with Zod                                     │
│  - Creates Lambda functions                                         │
│  - Creates EventBridge schedules                                    │
│  - Creates API Gateway webhook routes                               │
│  - Aggregates secrets template                                      │
└─────────────────────────────────────────────────────────────────────┘
                                   │
                                   ▼
┌─────────────────────────────────────────────────────────────────────┐
│                      Frontend Build                                  │
│  - Extracts UI-relevant fields from manifests                       │
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
│   │   ├── base_ingestor.py          # Base class for polling ingestors
│   │   ├── base_webhook.py           # Base class for webhook handlers
│   │   └── __init__.py
│   │
│   ├── _template/                    # Starter template for new plugins
│   │   ├── manifest.json
│   │   ├── ingestor/
│   │   │   └── handler.py
│   │   └── README.md
│   │
│   ├── trustpilot/                   # Example: hybrid (polling + webhook)
│   │   ├── manifest.json
│   │   ├── ingestor/
│   │   │   └── handler.py
│   │   └── webhook/
│   │       └── handler.py
│   │
│   ├── twitter/                      # Example: polling only
│   │   ├── manifest.json
│   │   └── ingestor/
│   │       └── handler.py
│   │
│   ├── s3_import/                    # Example: S3 trigger (no schedule)
│   │   ├── manifest.json
│   │   └── ingestor/
│   │       └── handler.py
│   │
│   └── yelp/
│       ├── manifest.json
│       └── ingestor/
│           └── handler.py
│
├── lib/
│   ├── plugin-loader.ts              # Discovers and validates plugins
│   └── stacks/
│       ├── ingestion-stack.ts        # Uses plugin loader
│       └── analytics-stack.ts        # Uses plugin loader for webhooks
│
└── frontend/src/
    ├── plugins/
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

### Manifest Schema

```json
{
  "id": "trustpilot",
  "name": "Trustpilot",
  "icon": "⭐",
  "description": "Service reviews via webhook and API polling",
  "category": "reviews",
  
  "infrastructure": {
    "ingestor": {
      "enabled": true,
      "schedule": "rate(5 minutes)",
      "timeout": 120,
      "memory": 256
    },
    "webhook": {
      "enabled": true,
      "path": "/webhooks/trustpilot",
      "methods": ["POST"]
    },
    "s3Trigger": {
      "enabled": false,
      "suffixes": []
    }
  },
  
  "config": [
    {
      "key": "api_key",
      "label": "API Key",
      "type": "password",
      "required": true,
      "secret": true
    },
    {
      "key": "api_secret",
      "label": "API Secret",
      "type": "password",
      "required": true,
      "secret": true
    },
    {
      "key": "business_unit_id",
      "label": "Business Unit ID",
      "type": "text",
      "placeholder": "e.g., 5a7b8c9d0e1f2a3b4c5d6e7f",
      "required": false,
      "secret": false
    }
  ],
  
  "webhooks": [
    {
      "name": "Service Reviews",
      "events": ["service-review-created", "service-review-updated", "service-review-deleted"],
      "docUrl": "https://support.trustpilot.com/hc/en-us/articles/360001108568"
    }
  ],
  
  "setup": {
    "title": "Trustpilot Setup",
    "color": "blue",
    "steps": [
      "Log in to your Trustpilot Business Portal",
      "Go to Integrations → API to get your API Key and Secret",
      "Copy your Business Unit ID from the URL",
      "Go to Integrations → Webhooks and add the webhook URL",
      "Select events: service-review-created, updated, deleted"
    ]
  },
  
  "secrets": {
    "trustpilot_api_key": "",
    "trustpilot_api_secret": "",
    "trustpilot_business_unit_id": "",
    "trustpilot_webhook_secret": ""
  }
}
```

### Field Definitions

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | Yes | Unique identifier, used in folder name and AWS resource names |
| `name` | string | Yes | Display name in UI |
| `icon` | string | Yes | Emoji or path to SVG icon |
| `description` | string | No | Short description shown in UI |
| `category` | enum | No | One of: `reviews`, `social`, `appstore`, `import`, `search` |
| `infrastructure` | object | Yes | AWS resources to deploy |
| `config` | array | Yes | Configuration fields for UI |
| `webhooks` | array | No | Webhook endpoints to display in UI |
| `setup` | object | No | Setup instructions for UI |
| `secrets` | object | No | Secret keys to add to Secrets Manager template |

### Infrastructure Options

#### Ingestor (Polling Lambda)

```json
"ingestor": {
  "enabled": true,
  "schedule": "rate(5 minutes)",  // EventBridge schedule expression
  "timeout": 120,                  // Lambda timeout in seconds
  "memory": 256                    // Lambda memory in MB
}
```

- If `schedule` is omitted, no EventBridge rule is created (useful for S3-triggered lambdas)
- Schedule is created but **disabled by default** - user enables via Settings UI

#### Webhook (API Gateway Route)

```json
"webhook": {
  "enabled": true,
  "path": "/webhooks/trustpilot",  // API Gateway path
  "methods": ["POST"]               // HTTP methods to allow
}
```

- Creates a Lambda function and API Gateway integration
- No authentication (webhooks must be accessible by external services)
- Webhook URL is displayed in Settings UI for user to copy

#### S3 Trigger

```json
"s3Trigger": {
  "enabled": true,
  "suffixes": [".csv", ".json", ".jsonl"]
}
```

- Triggers Lambda when files with matching suffixes are uploaded to S3 import bucket
- No schedule needed - event-driven

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
  "key": "api_key",           // Key used in secrets/config storage
  "label": "API Key",         // Display label in UI
  "type": "password",         // Input type
  "required": true,           // Show as required in UI
  "placeholder": "Enter...",  // Placeholder text
  "secret": true              // Store in Secrets Manager (vs. config)
}
```

---

## Example Manifests

### Polling Only (Twitter)

Simple connector that polls an API on a schedule.

```json
{
  "id": "twitter",
  "name": "Twitter / X",
  "icon": "𝕏",
  "category": "social",
  
  "infrastructure": {
    "ingestor": {
      "enabled": true,
      "schedule": "rate(1 minute)",
      "timeout": 60,
      "memory": 256
    }
  },
  
  "config": [
    {
      "key": "bearer_token",
      "label": "Bearer Token",
      "type": "password",
      "required": true,
      "secret": true
    }
  ],
  
  "secrets": {
    "twitter_bearer_token": ""
  }
}
```

### Hybrid: Polling + Webhook (Trustpilot)

Connector that both polls for historical data and receives real-time webhooks.

```json
{
  "id": "trustpilot",
  "name": "Trustpilot",
  "icon": "⭐",
  "description": "Service reviews via webhook and API polling",
  "category": "reviews",
  
  "infrastructure": {
    "ingestor": {
      "enabled": true,
      "schedule": "rate(5 minutes)",
      "timeout": 120,
      "memory": 256
    },
    "webhook": {
      "enabled": true,
      "path": "/webhooks/trustpilot",
      "methods": ["POST"]
    }
  },
  
  "config": [
    { "key": "api_key", "label": "API Key", "type": "password", "required": true, "secret": true },
    { "key": "api_secret", "label": "API Secret", "type": "password", "required": true, "secret": true },
    { "key": "business_unit_id", "label": "Business Unit ID", "type": "text", "placeholder": "e.g., 5a7b8c9d0e1f2a3b4c5d6e7f" }
  ],
  
  "webhooks": [
    {
      "name": "Service Reviews",
      "events": ["service-review-created", "service-review-updated", "service-review-deleted"],
      "docUrl": "https://support.trustpilot.com/hc/en-us/articles/360001108568"
    }
  ],
  
  "setup": {
    "title": "Trustpilot Setup",
    "color": "blue",
    "steps": [
      "Log in to your Trustpilot Business Portal",
      "Go to Integrations → API to get your API Key and Secret",
      "Copy your Business Unit ID from the URL",
      "Go to Integrations → Webhooks and add the webhook URL",
      "Select events: service-review-created, updated, deleted"
    ]
  },
  
  "secrets": {
    "trustpilot_api_key": "",
    "trustpilot_api_secret": "",
    "trustpilot_business_unit_id": "",
    "trustpilot_webhook_secret": ""
  }
}
```

### S3 Trigger (Bulk Import)

Connector triggered by file uploads, no polling schedule.

```json
{
  "id": "s3_import",
  "name": "S3 Bulk Import",
  "icon": "📦",
  "description": "Import feedback from S3 bucket (CSV, JSON, JSONL)",
  "category": "import",
  
  "infrastructure": {
    "ingestor": {
      "enabled": true,
      "timeout": 300,
      "memory": 512
    },
    "s3Trigger": {
      "enabled": true,
      "suffixes": [".csv", ".json", ".jsonl"]
    }
  },
  
  "config": [
    { "key": "bucket_name", "label": "S3 Bucket Name", "type": "text", "placeholder": "my-feedback-bucket" },
    { "key": "import_prefix", "label": "Import Prefix", "type": "text", "placeholder": "imports/" },
    { "key": "processed_prefix", "label": "Processed Prefix", "type": "text", "placeholder": "processed/" }
  ],
  
  "setup": {
    "title": "S3 Import Setup",
    "color": "blue",
    "steps": [
      "Create an S3 bucket for feedback imports",
      "Grant the VoC Lambda role read/write access",
      "Upload CSV/JSON/JSONL files to the import prefix",
      "Files are moved to processed prefix after import",
      "CSV columns: id, text, rating, created_at, source, url"
    ]
  },
  
  "secrets": {
    "s3_import_bucket": "",
    "s3_import_prefix": "imports/",
    "s3_import_processed_prefix": "processed/"
  }
}
```

### Multiple Config Fields (Yelp)

Connector with credentials and a list of business IDs.

```json
{
  "id": "yelp",
  "name": "Yelp Fusion API",
  "icon": "🍽️",
  "description": "Business reviews via official Yelp API",
  "category": "reviews",
  
  "infrastructure": {
    "ingestor": {
      "enabled": true,
      "schedule": "rate(30 minutes)",
      "timeout": 120,
      "memory": 256
    }
  },
  
  "config": [
    { "key": "api_key", "label": "API Key", "type": "password", "required": true, "secret": true },
    { 
      "key": "business_ids", 
      "label": "Business IDs", 
      "type": "textarea", 
      "placeholder": "lufthansa-frankfurt-am-main-3, lufthansa-los-angeles-2",
      "required": true,
      "secret": false
    }
  ],
  
  "setup": {
    "title": "Yelp Setup",
    "color": "orange",
    "steps": [
      "Go to Yelp Fusion Developer Portal",
      "Create a new app or use an existing one",
      "Copy your API Key from the app settings",
      "Find business IDs from Yelp URLs (slug after /biz/)"
    ]
  },
  
  "secrets": {
    "yelp_api_key": "",
    "yelp_business_ids": ""
  }
}
```

---

## CDK Implementation

### Plugin Loader

The plugin loader scans the `plugins/` directory, validates manifests, and provides them to CDK stacks.

```typescript
// lib/plugin-loader.ts
import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';

// ============================================
// Zod Schema for Manifest Validation
// ============================================

const ConfigFieldSchema = z.object({
  key: z.string(),
  label: z.string(),
  type: z.enum(['text', 'password', 'textarea', 'select']),
  required: z.boolean().optional().default(false),
  placeholder: z.string().optional(),
  secret: z.boolean().optional().default(false),
  options: z.array(z.object({
    value: z.string(),
    label: z.string(),
  })).optional(),
});

const WebhookInfoSchema = z.object({
  name: z.string(),
  events: z.array(z.string()),
  docUrl: z.string().url().optional(),
});

const SetupSchema = z.object({
  title: z.string(),
  color: z.enum(['blue', 'orange', 'green', 'gray']).optional().default('blue'),
  steps: z.array(z.string()),
});

const IngestorInfraSchema = z.object({
  enabled: z.boolean(),
  schedule: z.string().optional(),
  timeout: z.number().min(1).max(900).default(120),
  memory: z.number().min(128).max(10240).default(256),
});

const WebhookInfraSchema = z.object({
  enabled: z.boolean(),
  path: z.string(),
  methods: z.array(z.string()).default(['POST']),
});

const S3TriggerSchema = z.object({
  enabled: z.boolean(),
  suffixes: z.array(z.string()),
});

const InfrastructureSchema = z.object({
  ingestor: IngestorInfraSchema.optional(),
  webhook: WebhookInfraSchema.optional(),
  s3Trigger: S3TriggerSchema.optional(),
});

const ManifestSchema = z.object({
  id: z.string().regex(/^[a-z0-9_]+$/, 'ID must be lowercase alphanumeric with underscores'),
  name: z.string(),
  icon: z.string(),
  description: z.string().optional(),
  category: z.enum(['reviews', 'social', 'appstore', 'import', 'search']).optional(),
  infrastructure: InfrastructureSchema,
  config: z.array(ConfigFieldSchema).default([]),
  webhooks: z.array(WebhookInfoSchema).optional(),
  setup: SetupSchema.optional(),
  secrets: z.record(z.string()).optional(),
});

export type PluginManifest = z.infer<typeof ManifestSchema>;
export type ConfigField = z.infer<typeof ConfigFieldSchema>;

// ============================================
// Plugin Discovery
// ============================================

export function loadPlugins(pluginsDir: string): PluginManifest[] {
  const plugins: PluginManifest[] = [];
  const errors: string[] = [];
  
  if (!fs.existsSync(pluginsDir)) {
    console.warn(`Plugins directory not found: ${pluginsDir}`);
    return plugins;
  }
  
  const entries = fs.readdirSync(pluginsDir, { withFileTypes: true });
  
  for (const entry of entries) {
    // Skip non-directories and special folders
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('_')) continue;
    
    const manifestPath = path.join(pluginsDir, entry.name, 'manifest.json');
    
    if (!fs.existsSync(manifestPath)) {
      console.warn(`No manifest.json found in plugins/${entry.name}, skipping`);
      continue;
    }
    
    try {
      const raw = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
      const parsed = ManifestSchema.parse(raw);
      
      // Validate folder name matches manifest ID
      if (parsed.id !== entry.name) {
        errors.push(`Plugin folder '${entry.name}' does not match manifest id '${parsed.id}'`);
        continue;
      }
      
      plugins.push(parsed);
    } catch (err) {
      if (err instanceof z.ZodError) {
        errors.push(`Invalid manifest in plugins/${entry.name}: ${err.message}`);
      } else {
        errors.push(`Failed to load plugins/${entry.name}: ${err}`);
      }
    }
  }
  
  if (errors.length > 0) {
    console.error('Plugin loading errors:');
    errors.forEach(e => console.error(`  - ${e}`));
    throw new Error(`Failed to load ${errors.length} plugin(s)`);
  }
  
  console.log(`Loaded ${plugins.length} plugins: ${plugins.map(p => p.id).join(', ')}`);
  return plugins;
}

// ============================================
// Helper Functions
// ============================================

export function getEnabledPlugins(
  plugins: PluginManifest[], 
  enabledSources: string[]
): PluginManifest[] {
  return plugins.filter(p => enabledSources.includes(p.id));
}

export function aggregateSecrets(plugins: PluginManifest[]): Record<string, string> {
  const secrets: Record<string, string> = {};
  for (const plugin of plugins) {
    if (plugin.secrets) {
      Object.assign(secrets, plugin.secrets);
    }
  }
  return secrets;
}

export function getPluginsWithIngestor(plugins: PluginManifest[]): PluginManifest[] {
  return plugins.filter(p => p.infrastructure.ingestor?.enabled);
}

export function getPluginsWithWebhook(plugins: PluginManifest[]): PluginManifest[] {
  return plugins.filter(p => p.infrastructure.webhook?.enabled);
}

export function getPluginsWithS3Trigger(plugins: PluginManifest[]): PluginManifest[] {
  return plugins.filter(p => p.infrastructure.s3Trigger?.enabled);
}
```

---

### Ingestion Stack Changes

The ingestion stack uses the plugin loader to dynamically create resources.

```typescript
// lib/stacks/ingestion-stack.ts (key changes)
import * as path from 'path';
import { 
  loadPlugins, 
  getEnabledPlugins, 
  aggregateSecrets,
  PluginManifest 
} from '../plugin-loader';

export class VocIngestionStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: VocIngestionStackProps) {
    super(scope, id, props);
    
    // ============================================
    // Load Plugins
    // ============================================
    const pluginsDir = path.join(__dirname, '../../plugins');
    const allPlugins = loadPlugins(pluginsDir);
    const enabledPlugins = getEnabledPlugins(allPlugins, props.config.enabledSources);
    
    // ============================================
    // Secrets Manager - Aggregate from all plugins
    // ============================================
    const secretsTemplate = aggregateSecrets(allPlugins);
    
    const apiSecrets = new secretsmanager.Secret(this, 'VocApiSecrets', {
      secretName: 'voc-datalake/api-credentials',
      description: 'API credentials for VoC data sources',
      generateSecretString: {
        secretStringTemplate: JSON.stringify(secretsTemplate),
        generateStringKey: 'placeholder',
      },
    });
    
    // ============================================
    // Create Lambda for each enabled plugin
    // ============================================
    for (const plugin of enabledPlugins) {
      this.createPluginResources(plugin, {
        role: ingestionRole,
        commonEnv,
        dependenciesLayer,
        s3ImportBucket: this.s3ImportBucket,
      });
    }
  }
  
  private createPluginResources(
    plugin: PluginManifest,
    context: {
      role: iam.Role;
      commonEnv: Record<string, string>;
      dependenciesLayer: lambda.LayerVersion;
      s3ImportBucket: s3.Bucket;
    }
  ) {
    const { role, commonEnv, dependenciesLayer, s3ImportBucket } = context;
    const infra = plugin.infrastructure;
    
    // ============================================
    // Ingestor Lambda
    // ============================================
    if (infra.ingestor?.enabled) {
      // Bundle plugin code with shared modules
      const ingestorCode = lambda.Code.fromAsset('plugins', {
        exclude: ['**/__pycache__', '*.pyc'],
        bundling: {
          image: lambda.Runtime.PYTHON_3_12.bundlingImage,
          command: [
            'bash', '-c', [
              'mkdir -p /asset-output',
              `cp -r /asset-input/${plugin.id}/ingestor/* /asset-output/`,
              'cp -r /asset-input/_shared/* /asset-output/',
            ].join(' && '),
          ],
          platform: 'linux/arm64',
        },
      });
      
      const fn = new lambda.Function(this, `Ingestor${this.capitalize(plugin.id)}`, {
        functionName: `voc-ingestor-${plugin.id}`,
        runtime: lambda.Runtime.PYTHON_3_12,
        architecture: lambda.Architecture.ARM_64,
        handler: 'handler.lambda_handler',
        code: ingestorCode,
        role: role,
        timeout: cdk.Duration.seconds(infra.ingestor.timeout),
        memorySize: infra.ingestor.memory,
        environment: {
          ...commonEnv,
          SOURCE_PLATFORM: plugin.id,
        },
        layers: [dependenciesLayer],
      });
      
      this.ingestionLambdas.set(plugin.id, fn);
      
      // EventBridge schedule (if defined)
      if (infra.ingestor.schedule) {
        new events.Rule(this, `Schedule${this.capitalize(plugin.id)}`, {
          ruleName: `voc-ingest-${plugin.id}-schedule`,
          schedule: events.Schedule.expression(infra.ingestor.schedule),
          targets: [new targets.LambdaFunction(fn, { retryAttempts: 2 })],
          enabled: false,  // Disabled by default - enable via Settings UI
        });
      }
      
      // S3 trigger (if defined)
      if (infra.s3Trigger?.enabled) {
        s3ImportBucket.grantReadWrite(fn);
        for (const suffix of infra.s3Trigger.suffixes) {
          s3ImportBucket.addEventNotification(
            s3.EventType.OBJECT_CREATED,
            new s3n.LambdaDestination(fn),
            { suffix }
          );
        }
      }
    }
  }
  
  private capitalize(str: string): string {
    return str.charAt(0).toUpperCase() + str.slice(1).replace(/_([a-z])/g, (_, c) => c.toUpperCase());
  }
}
```

### Analytics Stack Changes (Webhooks)

```typescript
// lib/stacks/analytics-stack.ts (key changes)
import { loadPlugins, getEnabledPlugins, getPluginsWithWebhook } from '../plugin-loader';

export class VocAnalyticsStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: VocAnalyticsStackProps) {
    super(scope, id, props);
    
    // Load plugins
    const pluginsDir = path.join(__dirname, '../../plugins');
    const allPlugins = loadPlugins(pluginsDir);
    const enabledPlugins = getEnabledPlugins(allPlugins, props.config.enabledSources);
    const webhookPlugins = getPluginsWithWebhook(enabledPlugins);
    
    // Create webhook routes
    const webhooksResource = this.api.root.addResource('webhooks');
    
    for (const plugin of webhookPlugins) {
      this.createWebhookRoute(plugin, webhooksResource, webhookRole);
    }
  }
  
  private createWebhookRoute(
    plugin: PluginManifest,
    webhooksResource: apigateway.Resource,
    role: iam.Role
  ) {
    const webhookConfig = plugin.infrastructure.webhook!;
    
    // Bundle webhook handler
    const webhookCode = lambda.Code.fromAsset(`plugins/${plugin.id}/webhook`, {
      bundling: {
        image: lambda.Runtime.PYTHON_3_12.bundlingImage,
        command: [
          'bash', '-c', [
            'mkdir -p /asset-output',
            'cp -r /asset-input/* /asset-output/',
            'cp -r /asset-input/../../_shared/* /asset-output/',
          ].join(' && '),
        ],
      },
    });
    
    const webhookFn = new lambda.Function(this, `Webhook${this.capitalize(plugin.id)}`, {
      functionName: `voc-webhook-${plugin.id}`,
      runtime: lambda.Runtime.PYTHON_3_12,
      architecture: lambda.Architecture.ARM_64,
      handler: 'handler.lambda_handler',
      code: webhookCode,
      role: role,
      timeout: cdk.Duration.seconds(30),
      environment: {
        PROCESSING_QUEUE_URL: this.processingQueueUrl,
        FEEDBACK_TABLE: this.feedbackTable.tableName,
        BRAND_NAME: this.brandName,
      },
    });
    
    // Create API Gateway resource and method
    const pluginResource = webhooksResource.addResource(plugin.id);
    const integration = new apigateway.LambdaIntegration(webhookFn);
    
    for (const method of webhookConfig.methods) {
      pluginResource.addMethod(method, integration);  // No auth - external webhook
    }
    
    // Output webhook URL
    new cdk.CfnOutput(this, `${this.capitalize(plugin.id)}WebhookUrl`, {
      value: `${this.api.url}webhooks/${plugin.id}`,
    });
  }
}
```

---

## Frontend Implementation

### Build-Time Manifest Generation

At build time, extract UI-relevant fields from manifests and bundle for frontend.

```typescript
// scripts/generate-manifests.ts
import * as fs from 'fs';
import * as path from 'path';
import { loadPlugins } from '../lib/plugin-loader';

const pluginsDir = path.join(__dirname, '../plugins');
const outputPath = path.join(__dirname, '../frontend/src/plugins/manifests.json');

const plugins = loadPlugins(pluginsDir);

// Extract only UI-relevant fields
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
}));

// Ensure directory exists
fs.mkdirSync(path.dirname(outputPath), { recursive: true });

// Write manifests
fs.writeFileSync(outputPath, JSON.stringify(frontendManifests, null, 2));

console.log(`Generated ${frontendManifests.length} plugin manifests to ${outputPath}`);
```

Add to `package.json`:

```json
{
  "scripts": {
    "generate:manifests": "ts-node scripts/generate-manifests.ts",
    "prebuild": "npm run generate:manifests",
    "build": "vite build"
  }
}
```

### Frontend Manifest Types

```typescript
// frontend/src/plugins/types.ts
import { z } from 'zod';

export const ConfigFieldSchema = z.object({
  key: z.string(),
  label: z.string(),
  type: z.enum(['text', 'password', 'textarea', 'select']),
  required: z.boolean().optional(),
  placeholder: z.string().optional(),
  secret: z.boolean().optional(),
  options: z.array(z.object({
    value: z.string(),
    label: z.string(),
  })).optional(),
});

export const WebhookInfoSchema = z.object({
  name: z.string(),
  events: z.array(z.string()),
  docUrl: z.string().optional(),
});

export const SetupSchema = z.object({
  title: z.string(),
  color: z.enum(['blue', 'orange', 'green', 'gray']).optional(),
  steps: z.array(z.string()),
});

export const PluginManifestSchema = z.object({
  id: z.string(),
  name: z.string(),
  icon: z.string(),
  description: z.string().optional(),
  category: z.enum(['reviews', 'social', 'appstore', 'import', 'search']).optional(),
  config: z.array(ConfigFieldSchema),
  webhooks: z.array(WebhookInfoSchema).optional(),
  setup: SetupSchema.optional(),
  hasIngestor: z.boolean(),
  hasWebhook: z.boolean(),
  hasS3Trigger: z.boolean(),
});

export type PluginManifest = z.infer<typeof PluginManifestSchema>;
export type ConfigField = z.infer<typeof ConfigFieldSchema>;
export type WebhookInfo = z.infer<typeof WebhookInfoSchema>;
export type SetupInfo = z.infer<typeof SetupSchema>;

// Runtime validation
export function validateManifests(data: unknown): PluginManifest[] {
  const schema = z.array(PluginManifestSchema);
  return schema.parse(data);
}
```

### Loading Manifests

```typescript
// frontend/src/plugins/index.ts
import rawManifests from './manifests.json';
import { validateManifests, PluginManifest } from './types';

// Validate at runtime
let manifests: PluginManifest[];
try {
  manifests = validateManifests(rawManifests);
} catch (err) {
  console.error('Invalid plugin manifests:', err);
  manifests = [];
}

export function getPluginManifests(): PluginManifest[] {
  return manifests;
}

export function getPluginById(id: string): PluginManifest | undefined {
  return manifests.find(m => m.id === id);
}

export function getPluginsByCategory(category: string): PluginManifest[] {
  return manifests.filter(m => m.category === category);
}
```

### Updated Settings Page

```tsx
// frontend/src/pages/Settings/Settings.tsx
import { getPluginManifests } from '../../plugins';
import SourceCard from './SourceCard';

function DataSourcesSection({ apiEndpoint }: { apiEndpoint: string }) {
  const manifests = getPluginManifests();
  
  return (
    <div className="card">
      <h2 className="text-lg font-semibold mb-2">Data Sources & Integrations</h2>
      <p className="text-sm text-gray-500 mb-4">
        Configure API credentials, webhooks, and enable/disable data source schedules.
      </p>
      
      {!apiEndpoint && (
        <div className="flex items-start gap-2 text-sm text-amber-600 bg-amber-50 p-3 rounded-lg mb-4">
          <AlertCircle size={16} className="flex-shrink-0 mt-0.5" />
          <span>Configure the API endpoint above to manage data sources.</span>
        </div>
      )}
      
      <div className="space-y-3 sm:space-y-4">
        {manifests.map(manifest => (
          <SourceCard 
            key={manifest.id} 
            manifest={manifest} 
            apiEndpoint={apiEndpoint} 
          />
        ))}
      </div>
    </div>
  );
}
```

### Updated SourceCard Component

```tsx
// frontend/src/pages/Settings/SourceCard.tsx
import type { PluginManifest, ConfigField } from '../../plugins/types';

interface SourceCardProps {
  readonly manifest: PluginManifest;
  readonly apiEndpoint: string;
}

export default function SourceCard({ manifest, apiEndpoint }: SourceCardProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [credentials, setCredentials] = useState<Record<string, string>>({});
  // ... other state
  
  return (
    <div className="border border-gray-200 rounded-lg overflow-hidden">
      <SourceCardHeader
        manifest={manifest}
        isExpanded={isExpanded}
        onToggleExpand={() => setIsExpanded(!isExpanded)}
        // ... other props
      />
      
      {isExpanded && (
        <div className="p-3 sm:p-4 border-t border-gray-200 space-y-4">
          {/* Webhooks section - only if manifest has webhooks */}
          {manifest.webhooks && manifest.webhooks.length > 0 && (
            <WebhooksSection
              webhooks={manifest.webhooks}
              sourceKey={manifest.id}
              webhookBaseUrl={`${apiEndpoint}webhooks/`}
            />
          )}
          
          {/* Config fields - dynamically rendered from manifest */}
          {manifest.config.length > 0 && (
            <CredentialsSection
              fields={manifest.config}
              credentials={credentials}
              onCredentialsChange={setCredentials}
              // ... other props
            />
          )}
          
          {/* Setup instructions - only if manifest has setup */}
          {manifest.setup && (
            <SetupInstructionsSection setup={manifest.setup} />
          )}
        </div>
      )}
    </div>
  );
}

// Dynamic field rendering based on config type
function ConfigFieldInput({ 
  field, 
  value, 
  showSecrets, 
  onChange 
}: {
  field: ConfigField;
  value: string;
  showSecrets: boolean;
  onChange: (value: string) => void;
}) {
  const placeholder = field.placeholder ?? `Enter ${field.label.toLowerCase()}`;
  
  switch (field.type) {
    case 'textarea':
      return (
        <textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          className="input text-sm min-h-[80px]"
        />
      );
    
    case 'select':
      return (
        <select
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="input text-sm"
        >
          <option value="">Select...</option>
          {field.options?.map(opt => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </select>
      );
    
    case 'password':
      return (
        <input
          type={showSecrets ? 'text' : 'password'}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          className="input text-sm"
        />
      );
    
    default:
      return (
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          className="input text-sm"
        />
      );
  }
}
```

---

## Enable/Disable Flow

### How It Works

1. **Deploy time**: `enabledSources` in `cdk.context.json` controls which plugins get AWS resources
2. **Runtime**: Settings UI toggles EventBridge rules on/off via API
3. **No redeploy needed** to enable/disable a deployed plugin

### Configuration

```json
// cdk.context.json
{
  "brandName": "MyBrand",
  "brandHandles": ["@mybrand", "mybrand"],
  "primaryLanguage": "en",
  "enabledSources": [
    "trustpilot",
    "yelp",
    "twitter",
    "google_reviews",
    "s3_import"
  ]
}
```

### API Endpoints for Enable/Disable

```
POST /sources/{sourceId}/enable   → Enables EventBridge schedule
POST /sources/{sourceId}/disable  → Disables EventBridge schedule
GET  /sources/status              → Returns status of all sources
```

### Backend Implementation

```python
# lambda/api/sources_handler.py
import boto3

events = boto3.client('events')

def enable_source(source_id: str) -> dict:
    """Enable the EventBridge schedule for a source."""
    rule_name = f'voc-ingest-{source_id}-schedule'
    
    try:
        events.enable_rule(Name=rule_name)
        return {'enabled': True, 'source': source_id}
    except events.exceptions.ResourceNotFoundException:
        return {'error': f'Source {source_id} not found', 'enabled': False}

def disable_source(source_id: str) -> dict:
    """Disable the EventBridge schedule for a source."""
    rule_name = f'voc-ingest-{source_id}-schedule'
    
    try:
        events.disable_rule(Name=rule_name)
        return {'enabled': False, 'source': source_id}
    except events.exceptions.ResourceNotFoundException:
        return {'error': f'Source {source_id} not found', 'enabled': False}

def get_sources_status() -> dict:
    """Get enabled/disabled status of all sources."""
    # List all voc-ingest-* rules
    response = events.list_rules(NamePrefix='voc-ingest-')
    
    sources = {}
    for rule in response.get('Rules', []):
        # Extract source ID from rule name: voc-ingest-{source}-schedule
        parts = rule['Name'].split('-')
        if len(parts) >= 3:
            source_id = parts[2]
            sources[source_id] = {
                'enabled': rule['State'] == 'ENABLED',
                'schedule': rule.get('ScheduleExpression', ''),
            }
    
    return {'sources': sources}
```

---

## Creating a New Plugin

### Step-by-Step Guide

1. **Create the folder structure**

```bash
mkdir -p plugins/my_source/ingestor
```

2. **Create the manifest**

```json
// plugins/my_source/manifest.json
{
  "id": "my_source",
  "name": "My Source",
  "icon": "🔌",
  "description": "Fetches data from My Source API",
  "category": "reviews",
  
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
    "my_source_api_key": ""
  }
}
```

3. **Create the handler**

```python
# plugins/my_source/ingestor/handler.py
"""
My Source Ingestor - Fetches data from My Source API.
"""
from typing import Generator
from base_ingestor import BaseIngestor, logger, tracer, metrics


class MySourceIngestor(BaseIngestor):
    """Ingestor for My Source API."""
    
    def __init__(self):
        super().__init__()
        self.api_key = self.secrets.get('my_source_api_key', '')
    
    def fetch_new_items(self) -> Generator[dict, None, None]:
        """Fetch new items from My Source."""
        if not self.api_key:
            logger.warning("No My Source API key configured")
            return
        
        # Get watermark for incremental fetching
        last_id = self.get_watermark('last_id')
        
        # TODO: Implement your API fetching logic here
        # Example:
        # response = requests.get(
        #     'https://api.mysource.com/reviews',
        #     headers={'Authorization': f'Bearer {self.api_key}'},
        #     params={'since_id': last_id}
        # )
        # 
        # for item in response.json()['reviews']:
        #     yield {
        #         'id': item['id'],
        #         'text': item['content'],
        #         'rating': item['score'],
        #         'created_at': item['created_at'],
        #         'url': item['url'],
        #     }
        
        pass


@logger.inject_lambda_context
@tracer.capture_lambda_handler
@metrics.log_metrics(capture_cold_start_metric=True)
def lambda_handler(event, context):
    """Lambda entry point."""
    ingestor = MySourceIngestor()
    return ingestor.run()
```

4. **Add to enabled sources**

```json
// cdk.context.json
{
  "enabledSources": [
    "trustpilot",
    "my_source"  // Add your new source
  ]
}
```

5. **Deploy**

```bash
cdk deploy VocIngestionStack
```

---

## Message Schema (Output Contract)

All plugins must output messages in this format to the SQS processing queue.

### Required Fields

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Unique identifier from the source (used for deduplication) |
| `source_platform` | string | Plugin ID (e.g., `trustpilot`, `twitter`) |
| `text` | string | The feedback content |
| `created_at` | string | ISO 8601 timestamp |

### Optional Fields

| Field | Type | Description |
|-------|------|-------------|
| `rating` | number | Rating 1-5 (if applicable) |
| `url` | string | Source URL |
| `channel` | string | Sub-channel (e.g., `review`, `comment`, `mention`) |
| `author` | string | Author name/handle |
| `title` | string | Review title (if applicable) |
| `language` | string | ISO language code |
| `brand_handles_matched` | string[] | Which brand handles were matched |
| `metadata` | object | Plugin-specific additional data |

### Example Message

```json
{
  "id": "review_abc123",
  "source_platform": "trustpilot",
  "channel": "review",
  "text": "Great product! Fast shipping and excellent quality.",
  "rating": 5,
  "created_at": "2026-01-08T10:30:00Z",
  "url": "https://trustpilot.com/reviews/abc123",
  "author": "John D.",
  "title": "Excellent experience",
  "language": "en",
  "brand_handles_matched": ["MyBrand"],
  "metadata": {
    "is_verified": true,
    "location_id": "loc_123"
  }
}
```

### Validation

The processor Lambda validates incoming messages:

```python
def validate_message(msg: dict) -> tuple[bool, list[str]]:
    """Validate a message against the schema."""
    errors = []
    
    # Required fields
    if not msg.get('id'):
        errors.append('Missing required field: id')
    if not msg.get('source_platform'):
        errors.append('Missing required field: source_platform')
    if not msg.get('text'):
        errors.append('Missing required field: text')
    if not msg.get('created_at'):
        errors.append('Missing required field: created_at')
    
    # Validate created_at format
    if msg.get('created_at'):
        try:
            datetime.fromisoformat(msg['created_at'].replace('Z', '+00:00'))
        except ValueError:
            errors.append('Invalid created_at format (must be ISO 8601)')
    
    # Validate rating range
    if msg.get('rating') is not None:
        if not isinstance(msg['rating'], (int, float)) or not 1 <= msg['rating'] <= 5:
            errors.append('Rating must be a number between 1 and 5')
    
    return len(errors) == 0, errors
```

---

## Migration Plan

### Phase 1: Create Plugin Structure

1. Create `plugins/` folder
2. Create `plugins/_shared/` with base classes
3. Create `plugins/_template/` with starter template

### Phase 2: Migrate Existing Connectors

For each existing connector:

1. Create `plugins/{source}/manifest.json`
2. Move `lambda/ingestors/{source}/*` → `plugins/{source}/ingestor/`
3. Move `lambda/webhooks/{source}/*` → `plugins/{source}/webhook/` (if exists)
4. Update imports in handler files

### Phase 3: Update CDK

1. Create `lib/plugin-loader.ts`
2. Update `ingestion-stack.ts` to use plugin loader
3. Update `analytics-stack.ts` for dynamic webhook routes
4. Remove hardcoded source configs

### Phase 4: Update Frontend

1. Create `scripts/generate-manifests.ts`
2. Add prebuild script to `package.json`
3. Create `frontend/src/plugins/` with types and loader
4. Update Settings page to use manifests
5. Remove `sourceConfig.ts`

### Phase 5: Cleanup

1. Remove `lambda/ingestors/` (now in plugins)
2. Remove `lambda/webhooks/` (now in plugins)
3. Update documentation
4. Test all connectors

---

## File Changes Summary

### Files to Create

| File | Purpose |
|------|---------|
| `plugins/_shared/base_ingestor.py` | Base class for ingestors |
| `plugins/_shared/base_webhook.py` | Base class for webhooks |
| `plugins/_template/manifest.json` | Template manifest |
| `plugins/_template/ingestor/handler.py` | Template handler |
| `plugins/{source}/manifest.json` | Manifest for each source |
| `lib/plugin-loader.ts` | CDK plugin discovery |
| `scripts/generate-manifests.ts` | Frontend manifest generator |
| `frontend/src/plugins/types.ts` | TypeScript types |
| `frontend/src/plugins/index.ts` | Plugin loader |

### Files to Modify

| File | Changes |
|------|---------|
| `lib/stacks/ingestion-stack.ts` | Use plugin loader instead of hardcoded configs |
| `lib/stacks/analytics-stack.ts` | Dynamic webhook routes from plugins |
| `frontend/src/pages/Settings/Settings.tsx` | Import from plugins instead of sourceConfig |
| `frontend/src/pages/Settings/SourceCard.tsx` | Accept manifest prop instead of sourceInfo |
| `package.json` | Add generate:manifests script |

### Files to Delete

| File | Reason |
|------|--------|
| `frontend/src/pages/Settings/sourceConfig.ts` | Replaced by manifests.json |
| `lambda/ingestors/*` | Moved to plugins/ |
| `lambda/webhooks/*` | Moved to plugins/ |

---

## Testing

### Manifest Validation

```bash
# Validate all manifests at build time
npm run generate:manifests
```

### Plugin Handler Testing

```bash
# Test individual plugin
cd plugins/trustpilot/ingestor
python -m pytest test_handler.py
```

### Integration Testing

```bash
# Deploy to dev environment
cdk deploy --context enabledSources='["trustpilot"]'

# Test via Settings UI
# 1. Enable the source
# 2. Check CloudWatch logs for Lambda execution
# 3. Verify data appears in feedback table
```

---

## FAQ

### Q: Do I need to redeploy to add a new plugin?

**A:** Yes, adding a new plugin requires `cdk deploy` to create the Lambda and EventBridge resources. However, enabling/disabling an existing plugin does not require redeployment.

### Q: Can I have a plugin without a Lambda?

**A:** Not currently. Every plugin needs at least an ingestor Lambda. For webhook-only sources, the ingestor can be a no-op that just validates credentials.

### Q: How do I test a plugin locally?

**A:** You can run the handler directly:

```python
# In plugins/my_source/ingestor/
python -c "from handler import MySourceIngestor; i = MySourceIngestor(); print(list(i.fetch_new_items()))"
```

### Q: Where are credentials stored?

**A:** All credentials are stored in AWS Secrets Manager under `voc-datalake/api-credentials`. The secrets template is aggregated from all plugin manifests at deploy time.

### Q: Can plugins have custom UI components?

**A:** No, the UI is data-driven from the manifest. All plugins use the same SourceCard component with dynamic field rendering. This keeps the architecture simple and consistent.


---

## SQS Message Validation Layer

### Why Validation Matters

Since plugins can be contributed by the community, we cannot blindly trust the data they send. A validation layer acts as a gatekeeper between plugins and the core processing pipeline.

```
┌─────────────┐     ┌─────────────────┐     ┌─────────────────┐     ┌─────────────┐
│   Plugin    │ ──▶ │  SQS Queue      │ ──▶ │  Validator      │ ──▶ │  Processor  │
│  (any src)  │     │  (raw messages) │     │  (gatekeeper)   │     │  (trusted)  │
└─────────────┘     └─────────────────┘     └─────────────────┘     └─────────────┘
                                                    │
                                                    ▼ (invalid)
                                            ┌─────────────────┐
                                            │  DLQ + Metrics  │
                                            └─────────────────┘
```

### Validation Strategy

1. **Schema validation**: Required fields, types, formats
2. **Sanitization**: Strip dangerous content, limit sizes
3. **Rate limiting**: Prevent a single plugin from flooding the queue
4. **Source verification**: Validate source_platform matches known plugins

### Implementation

```python
# lambda/processor/validator.py
"""
Message Validator - Validates all incoming messages before processing.
This is the security boundary between untrusted plugin output and trusted processing.
"""
import re
from datetime import datetime
from typing import Any
from zod_python import z  # Or use pydantic/jsonschema

# ============================================
# Schema Definition
# ============================================

# Maximum sizes to prevent abuse
MAX_TEXT_LENGTH = 50_000  # 50KB max for feedback text
MAX_ID_LENGTH = 256
MAX_URL_LENGTH = 2048
MAX_METADATA_SIZE = 10_000  # 10KB max for metadata JSON

# Known plugin IDs (loaded from manifests at deploy time)
KNOWN_SOURCES = {
    'trustpilot', 'yelp', 'google_reviews', 'twitter', 'instagram',
    'facebook', 'reddit', 'tavily', 'appstore_apple', 'appstore_google',
    'appstore_huawei', 'webscraper', 'youtube', 'tiktok', 'linkedin',
    's3_import', 'manual_import'
}

class ValidationError(Exception):
    """Raised when message validation fails."""
    def __init__(self, errors: list[str]):
        self.errors = errors
        super().__init__(f"Validation failed: {', '.join(errors)}")


def validate_message(msg: dict) -> dict:
    """
    Validate and sanitize an incoming message.
    
    Returns the sanitized message if valid.
    Raises ValidationError if invalid.
    """
    errors: list[str] = []
    
    # ============================================
    # Required Fields
    # ============================================
    
    # id - required, string, max length
    msg_id = msg.get('id')
    if not msg_id:
        errors.append('Missing required field: id')
    elif not isinstance(msg_id, str):
        errors.append('Field id must be a string')
    elif len(msg_id) > MAX_ID_LENGTH:
        errors.append(f'Field id exceeds max length ({MAX_ID_LENGTH})')
    
    # source_platform - required, must be known
    source = msg.get('source_platform')
    if not source:
        errors.append('Missing required field: source_platform')
    elif not isinstance(source, str):
        errors.append('Field source_platform must be a string')
    elif source not in KNOWN_SOURCES:
        errors.append(f'Unknown source_platform: {source}')
    
    # text - required, string, max length
    text = msg.get('text')
    if not text:
        errors.append('Missing required field: text')
    elif not isinstance(text, str):
        errors.append('Field text must be a string')
    elif len(text) > MAX_TEXT_LENGTH:
        errors.append(f'Field text exceeds max length ({MAX_TEXT_LENGTH})')
    
    # created_at - required, valid ISO 8601
    created_at = msg.get('created_at')
    if not created_at:
        errors.append('Missing required field: created_at')
    elif not isinstance(created_at, str):
        errors.append('Field created_at must be a string')
    else:
        try:
            # Normalize and validate ISO format
            parsed = datetime.fromisoformat(created_at.replace('Z', '+00:00'))
            # Reject dates too far in the future (likely errors)
            if parsed.year > datetime.now().year + 1:
                errors.append('Field created_at is too far in the future')
        except ValueError:
            errors.append('Field created_at must be valid ISO 8601 format')
    
    # ============================================
    # Optional Fields
    # ============================================
    
    # rating - optional, number 1-5
    rating = msg.get('rating')
    if rating is not None:
        if not isinstance(rating, (int, float)):
            errors.append('Field rating must be a number')
        elif not 1 <= rating <= 5:
            errors.append('Field rating must be between 1 and 5')
    
    # url - optional, valid URL format, max length
    url = msg.get('url')
    if url is not None:
        if not isinstance(url, str):
            errors.append('Field url must be a string')
        elif len(url) > MAX_URL_LENGTH:
            errors.append(f'Field url exceeds max length ({MAX_URL_LENGTH})')
        elif url and not url.startswith(('http://', 'https://')):
            errors.append('Field url must be a valid HTTP(S) URL')
    
    # channel - optional, string
    channel = msg.get('channel')
    if channel is not None and not isinstance(channel, str):
        errors.append('Field channel must be a string')
    
    # metadata - optional, object, max size
    metadata = msg.get('metadata')
    if metadata is not None:
        if not isinstance(metadata, dict):
            errors.append('Field metadata must be an object')
        else:
            import json
            metadata_size = len(json.dumps(metadata))
            if metadata_size > MAX_METADATA_SIZE:
                errors.append(f'Field metadata exceeds max size ({MAX_METADATA_SIZE} bytes)')
    
    # ============================================
    # Fail if any errors
    # ============================================
    
    if errors:
        raise ValidationError(errors)
    
    # ============================================
    # Sanitize and return
    # ============================================
    
    return sanitize_message(msg)


def sanitize_message(msg: dict) -> dict:
    """
    Sanitize a validated message.
    - Strip control characters from text
    - Normalize whitespace
    - Remove any unexpected fields
    """
    # Allowed fields only (whitelist approach)
    allowed_fields = {
        'id', 'source_platform', 'source_channel', 'text', 'rating',
        'created_at', 'url', 'channel', 'author', 'title', 'language',
        'brand_handles_matched', 'metadata', 'is_update', 'ingested_at',
        's3_raw_uri', 'raw_data'
    }
    
    sanitized = {k: v for k, v in msg.items() if k in allowed_fields}
    
    # Sanitize text - remove control characters except newlines/tabs
    if 'text' in sanitized:
        text = sanitized['text']
        # Remove control chars except \n, \r, \t
        text = re.sub(r'[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]', '', text)
        # Normalize excessive whitespace
        text = re.sub(r'\n{3,}', '\n\n', text)
        sanitized['text'] = text.strip()
    
    # Sanitize title similarly
    if 'title' in sanitized and sanitized['title']:
        title = sanitized['title']
        title = re.sub(r'[\x00-\x1f\x7f]', '', title)
        sanitized['title'] = title.strip()
    
    return sanitized
```

### Integration with Processor

```python
# lambda/processor/handler.py
from validator import validate_message, ValidationError
from shared.logging import logger, metrics

def process_message(record: dict) -> dict:
    """Process a single SQS message."""
    body = json.loads(record['body'])
    
    # ============================================
    # Validation Gate
    # ============================================
    try:
        validated = validate_message(body)
    except ValidationError as e:
        logger.warning(f"Message validation failed: {e.errors}", extra={
            'source': body.get('source_platform', 'unknown'),
            'message_id': body.get('id', 'unknown'),
            'errors': e.errors,
        })
        metrics.add_metric(name="ValidationFailures", unit="Count", value=1)
        # Don't raise - message goes to DLQ after max retries
        # Or explicitly send to DLQ for invalid messages
        return {'status': 'invalid', 'errors': e.errors}
    
    # ============================================
    # Process validated message
    # ============================================
    # ... rest of processing logic with trusted data
```

### Metrics and Alerting

Track validation failures to detect misbehaving plugins:

```python
# CloudWatch metrics emitted by validator
metrics.add_metric(name="ValidationFailures", unit="Count", value=1, dimensions={
    'source_platform': source,
    'error_type': 'missing_field'  # or 'invalid_format', 'unknown_source', etc.
})
```

Create CloudWatch alarms:
- Alert if validation failure rate > 5% for any source
- Alert if unknown source_platform appears (potential security issue)
- Alert if message size limits are hit frequently

---

## Infrastructure Isolation

### The Problem

If plugins can define arbitrary infrastructure, they could:
- Accidentally break core platform resources
- Create security vulnerabilities
- Cause unexpected costs
- Conflict with other plugins

### Solution: Constrained Plugin Infrastructure

Plugins don't define raw CDK/CloudFormation. Instead, they declare **what they need** in the manifest, and the platform creates resources using **controlled templates**.

```
┌─────────────────────────────────────────────────────────────────────┐
│                     Plugin Manifest                                  │
│  "I need: polling Lambda, webhook endpoint, these secrets"          │
└─────────────────────────────────────────────────────────────────────┘
                                   │
                                   ▼
┌─────────────────────────────────────────────────────────────────────┐
│                     Platform CDK (Controlled)                        │
│  - Creates Lambda with fixed role, VPC, limits                      │
│  - Creates API Gateway route under /webhooks/{id}                   │
│  - Adds secrets to shared Secrets Manager                           │
│  - All resources tagged and named consistently                      │
└─────────────────────────────────────────────────────────────────────┘
                                   │
                                   ▼
┌─────────────────────────────────────────────────────────────────────┐
│                     Isolated Plugin Resources                        │
│  - Lambda: voc-ingestor-{plugin-id}                                 │
│  - Schedule: voc-ingest-{plugin-id}-schedule                        │
│  - Logs: /aws/lambda/voc-ingestor-{plugin-id}                       │
└─────────────────────────────────────────────────────────────────────┘
```

### What Plugins CAN Declare

| Resource | Manifest Field | Platform Creates |
|----------|---------------|------------------|
| Polling Lambda | `infrastructure.ingestor` | Lambda with shared role, fixed limits |
| Webhook Lambda | `infrastructure.webhook` | Lambda + API Gateway route |
| S3 Trigger | `infrastructure.s3Trigger` | S3 event notification |
| Secrets | `secrets` | Entries in shared Secrets Manager |
| Schedule | `infrastructure.ingestor.schedule` | EventBridge rule (disabled by default) |

### What Plugins CANNOT Do

- Create IAM roles or policies
- Create DynamoDB tables
- Create S3 buckets
- Create VPCs or security groups
- Access resources outside the plugin sandbox
- Define arbitrary CloudFormation

### Resource Boundaries

#### Shared Resources (Read/Write via Platform)

```
┌─────────────────────────────────────────────────────────────────────┐
│                     Shared Resources                                 │
│                                                                      │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐                 │
│  │ SQS Queue   │  │ Secrets Mgr │  │ Raw S3      │                 │
│  │ (write)     │  │ (read)      │  │ (write)     │                 │
│  └─────────────┘  └─────────────┘  └─────────────┘                 │
│         ▲               ▲               ▲                           │
│         │               │               │                           │
│  ┌──────┴───────────────┴───────────────┴──────┐                   │
│  │           Shared IAM Role                    │                   │
│  │  - sqs:SendMessage (processing queue only)   │                   │
│  │  - secretsmanager:GetSecretValue             │                   │
│  │  - s3:PutObject (raw bucket only)            │                   │
│  │  - dynamodb:* (watermarks table only)        │                   │
│  └──────────────────────────────────────────────┘                   │
│                          ▲                                          │
│         ┌────────────────┼────────────────┐                        │
│         │                │                │                        │
│  ┌──────┴─────┐  ┌───────┴──────┐  ┌─────┴──────┐                 │
│  │ Plugin A   │  │ Plugin B     │  │ Plugin C   │                 │
│  │ Lambda     │  │ Lambda       │  │ Lambda     │                 │
│  └────────────┘  └──────────────┘  └────────────┘                 │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

#### Per-Plugin Resources (Isolated)

Each plugin gets its own:
- Lambda function (isolated execution)
- CloudWatch Log Group (isolated logs)
- EventBridge Rule (isolated schedule)
- Webhook route (isolated endpoint)

### IAM Role Design

All plugin Lambdas share a single, tightly-scoped IAM role:

```typescript
// lib/stacks/ingestion-stack.ts
const pluginRole = new iam.Role(this, 'PluginLambdaRole', {
  assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
  managedPolicies: [
    iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
  ],
});

// Minimal permissions - only what plugins need
pluginRole.addToPolicy(new iam.PolicyStatement({
  sid: 'SendToProcessingQueue',
  effect: iam.Effect.ALLOW,
  actions: ['sqs:SendMessage', 'sqs:SendMessageBatch'],
  resources: [processingQueue.queueArn],
}));

pluginRole.addToPolicy(new iam.PolicyStatement({
  sid: 'ReadSecrets',
  effect: iam.Effect.ALLOW,
  actions: ['secretsmanager:GetSecretValue'],
  resources: [apiSecrets.secretArn],
}));

pluginRole.addToPolicy(new iam.PolicyStatement({
  sid: 'WriteRawData',
  effect: iam.Effect.ALLOW,
  actions: ['s3:PutObject'],
  resources: [`${rawDataBucket.bucketArn}/raw/*`],
}));

pluginRole.addToPolicy(new iam.PolicyStatement({
  sid: 'ManageWatermarks',
  effect: iam.Effect.ALLOW,
  actions: ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem'],
  resources: [watermarksTable.tableArn],
}));

// KMS for encryption
kmsKey.grantEncryptDecrypt(pluginRole);
```

### Lambda Constraints

All plugin Lambdas are created with fixed constraints:

```typescript
function createPluginLambda(plugin: PluginManifest, role: iam.Role): lambda.Function {
  const infra = plugin.infrastructure.ingestor!;
  
  return new lambda.Function(this, `Ingestor${plugin.id}`, {
    functionName: `voc-ingestor-${plugin.id}`,
    runtime: lambda.Runtime.PYTHON_3_12,
    architecture: lambda.Architecture.ARM_64,
    handler: 'handler.lambda_handler',
    role: role,  // Shared role - no custom permissions
    
    // Constrained limits
    timeout: cdk.Duration.seconds(Math.min(infra.timeout, 300)),  // Max 5 min
    memorySize: Math.min(infra.memory, 1024),  // Max 1GB
    
    // No VPC access (plugins don't need it)
    vpc: undefined,
    
    // Reserved concurrency to prevent runaway costs
    reservedConcurrentExecutions: 10,
    
    // Environment - only safe variables
    environment: {
      SOURCE_PLATFORM: plugin.id,
      PROCESSING_QUEUE_URL: processingQueue.queueUrl,
      WATERMARKS_TABLE: watermarksTable.tableName,
      RAW_DATA_BUCKET: rawDataBucket.bucketName,
      SECRETS_ARN: apiSecrets.secretArn,
      BRAND_NAME: config.brandName,
      // No sensitive values directly in env
    },
  });
}
```

### Webhook Isolation

Webhook endpoints are isolated under `/webhooks/{plugin-id}`:

```typescript
// All webhooks under /webhooks prefix
const webhooksResource = api.root.addResource('webhooks');

for (const plugin of webhookPlugins) {
  // Each plugin gets its own sub-resource
  const pluginResource = webhooksResource.addResource(plugin.id);
  
  // Only POST allowed (or as specified in manifest)
  for (const method of plugin.infrastructure.webhook!.methods) {
    pluginResource.addMethod(method, integration, {
      // No authorization (external webhooks)
      authorizationType: apigateway.AuthorizationType.NONE,
      // But we can add request validation
      requestValidator: requestValidator,
    });
  }
}
```

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
        return {
            k.replace(prefix, ''): v 
            for k, v in all_secrets.items() 
            if k.startswith(prefix)
        }
```

This means:
- `trustpilot` plugin sees: `api_key`, `api_secret`, `business_unit_id`
- `twitter` plugin sees: `bearer_token`
- Neither can see the other's secrets

### Cost Controls

#### Per-Plugin Limits

| Resource | Limit | Enforced By |
|----------|-------|-------------|
| Lambda timeout | 5 minutes max | CDK validation |
| Lambda memory | 1GB max | CDK validation |
| Lambda concurrency | 10 concurrent | Reserved concurrency |
| Schedule frequency | 1 minute min | CDK validation |
| Message size | 256KB | SQS limit |

#### Manifest Validation

```typescript
// lib/plugin-loader.ts
function validateManifestLimits(manifest: PluginManifest): void {
  const infra = manifest.infrastructure;
  
  if (infra.ingestor) {
    if (infra.ingestor.timeout > 300) {
      throw new Error(`Plugin ${manifest.id}: timeout cannot exceed 300 seconds`);
    }
    if (infra.ingestor.memory > 1024) {
      throw new Error(`Plugin ${manifest.id}: memory cannot exceed 1024 MB`);
    }
    if (infra.ingestor.schedule) {
      // Validate schedule isn't too frequent
      const schedule = infra.ingestor.schedule;
      if (schedule.includes('rate(') && schedule.includes('second')) {
        throw new Error(`Plugin ${manifest.id}: schedule cannot be more frequent than 1 minute`);
      }
    }
  }
}
```

### Monitoring and Alerts

Track plugin behavior to detect issues:

```typescript
// Per-plugin CloudWatch alarms
for (const plugin of enabledPlugins) {
  // Error rate alarm
  new cloudwatch.Alarm(this, `${plugin.id}ErrorAlarm`, {
    metric: fn.metricErrors(),
    threshold: 10,
    evaluationPeriods: 3,
    alarmDescription: `Plugin ${plugin.id} error rate too high`,
  });
  
  // Duration alarm (approaching timeout)
  new cloudwatch.Alarm(this, `${plugin.id}DurationAlarm`, {
    metric: fn.metricDuration(),
    threshold: infra.ingestor!.timeout * 1000 * 0.8,  // 80% of timeout
    evaluationPeriods: 3,
    alarmDescription: `Plugin ${plugin.id} approaching timeout`,
  });
  
  // Invocation spike alarm
  new cloudwatch.Alarm(this, `${plugin.id}InvocationAlarm`, {
    metric: fn.metricInvocations(),
    threshold: 1000,  // Per 5 minutes
    evaluationPeriods: 1,
    alarmDescription: `Plugin ${plugin.id} invocation spike`,
  });
}
```

### Plugin Review Process (for Open Source)

Before merging a community plugin:

1. **Manifest review**: Check for reasonable limits, valid schema
2. **Code review**: No malicious code, follows patterns
3. **Test execution**: Run in isolated test environment
4. **Security scan**: Check for hardcoded secrets, unsafe operations

```yaml
# .github/workflows/plugin-review.yml
name: Plugin Review
on:
  pull_request:
    paths:
      - 'plugins/**'

jobs:
  validate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      
      - name: Validate manifests
        run: npm run validate:manifests
      
      - name: Lint plugin code
        run: |
          for dir in plugins/*/; do
            if [ -f "$dir/ingestor/handler.py" ]; then
              pylint "$dir/ingestor/handler.py"
            fi
          done
      
      - name: Security scan
        run: |
          # Check for hardcoded secrets
          grep -r "api_key\s*=" plugins/ && exit 1 || true
          # Check for unsafe imports
          grep -r "import os\|import subprocess" plugins/ && echo "Review required" || true
      
      - name: Test plugin
        run: |
          for dir in plugins/*/; do
            if [ -f "$dir/ingestor/test_handler.py" ]; then
              pytest "$dir/ingestor/test_handler.py"
            fi
          done
```

---

## Summary: Security Model

| Layer | Protection |
|-------|------------|
| **Manifest** | Schema validation, limit enforcement |
| **IAM** | Shared role with minimal permissions |
| **Lambda** | Fixed runtime, memory, timeout limits |
| **SQS** | Message validation before processing |
| **Secrets** | Prefix-based isolation |
| **API Gateway** | Isolated webhook routes |
| **Monitoring** | Per-plugin alarms and metrics |
| **Review** | PR checks for community plugins |

This ensures plugins can only:
- Read their own secrets
- Write to the processing queue
- Store raw data in S3
- Manage their own watermarks

They cannot:
- Access other plugins' data
- Modify core infrastructure
- Create new AWS resources
- Exceed cost/performance limits


---

## Cost Allocation and Observability

### Cost Tagging Strategy

Every resource created for a plugin gets tagged for cost allocation and tracking.

#### Tag Schema

| Tag | Value | Purpose |
|-----|-------|---------|
| `Project` | `VoC-DataLake` | Top-level project identification |
| `Feature` | `Plugin` | Distinguishes plugin costs from core platform |
| `Plugin` | `{plugin-id}` | Identifies specific plugin (e.g., `trustpilot`) |
| `PluginCategory` | `{category}` | Groups plugins (e.g., `reviews`, `social`) |
| `Environment` | `dev`/`staging`/`prod` | Environment separation |
| `ManagedBy` | `CDK` | Infrastructure management |

#### Implementation

```typescript
// lib/stacks/ingestion-stack.ts
import { Tags } from 'aws-cdk-lib';

function tagPluginResources(
  construct: Construct, 
  plugin: PluginManifest,
  environment: string
): void {
  Tags.of(construct).add('Project', 'VoC-DataLake');
  Tags.of(construct).add('Feature', 'Plugin');
  Tags.of(construct).add('Plugin', plugin.id);
  Tags.of(construct).add('PluginCategory', plugin.category || 'uncategorized');
  Tags.of(construct).add('Environment', environment);
  Tags.of(construct).add('ManagedBy', 'CDK');
}

// Apply to all plugin resources
for (const plugin of enabledPlugins) {
  const fn = createPluginLambda(plugin, role);
  tagPluginResources(fn, plugin, environment);
  
  if (plugin.infrastructure.ingestor?.schedule) {
    const rule = createScheduleRule(plugin, fn);
    tagPluginResources(rule, plugin, environment);
  }
  
  // Log group
  const logGroup = new logs.LogGroup(this, `Logs${plugin.id}`, {
    logGroupName: `/aws/lambda/voc-ingestor-${plugin.id}`,
    retention: logs.RetentionDays.TWO_WEEKS,
  });
  tagPluginResources(logGroup, plugin, environment);
}
```

#### AWS Cost Explorer Setup

1. **Activate tags** in AWS Billing Console:
   - Go to Billing → Cost Allocation Tags
   - Activate: `Plugin`, `PluginCategory`, `Feature`

2. **Create Cost Reports**:
   - Group by `Plugin` tag to see per-plugin costs
   - Filter by `Feature=Plugin` to see total plugin costs vs core platform

3. **Set Budgets**:
   - Per-plugin budget alerts
   - Total plugins budget cap

```typescript
// Optional: Create budget alerts per plugin
import * as budgets from 'aws-cdk-lib/aws-budgets';

for (const plugin of enabledPlugins) {
  new budgets.CfnBudget(this, `Budget${plugin.id}`, {
    budget: {
      budgetName: `voc-plugin-${plugin.id}-monthly`,
      budgetType: 'COST',
      timeUnit: 'MONTHLY',
      budgetLimit: {
        amount: 50,  // $50/month per plugin default
        unit: 'USD',
      },
      costFilters: {
        TagKeyValue: [`user:Plugin$${plugin.id}`],
      },
    },
    notificationsWithSubscribers: [{
      notification: {
        notificationType: 'ACTUAL',
        comparisonOperator: 'GREATER_THAN',
        threshold: 80,  // Alert at 80%
      },
      subscribers: [{
        subscriptionType: 'EMAIL',
        address: 'alerts@example.com',
      }],
    }],
  });
}
```

---

## Monitoring and Alerting

### CloudWatch Dashboard

Create a dedicated dashboard for plugin observability:

```typescript
// lib/stacks/ingestion-stack.ts
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';

const dashboard = new cloudwatch.Dashboard(this, 'PluginDashboard', {
  dashboardName: 'VoC-Plugins-Overview',
});

// Add widgets for each plugin
for (const plugin of enabledPlugins) {
  const fn = this.ingestionLambdas.get(plugin.id)!;
  
  // Plugin section header
  dashboard.addWidgets(
    new cloudwatch.TextWidget({
      markdown: `# ${plugin.icon} ${plugin.name}`,
      width: 24,
      height: 1,
    })
  );
  
  // Metrics row
  dashboard.addWidgets(
    // Invocations
    new cloudwatch.GraphWidget({
      title: `${plugin.id} - Invocations`,
      left: [fn.metricInvocations()],
      width: 6,
    }),
    // Errors
    new cloudwatch.GraphWidget({
      title: `${plugin.id} - Errors`,
      left: [fn.metricErrors()],
      width: 6,
    }),
    // Duration
    new cloudwatch.GraphWidget({
      title: `${plugin.id} - Duration`,
      left: [fn.metricDuration()],
      width: 6,
    }),
    // Throttles
    new cloudwatch.GraphWidget({
      title: `${plugin.id} - Throttles`,
      left: [fn.metricThrottles()],
      width: 6,
    })
  );
}

// Summary widgets
dashboard.addWidgets(
  new cloudwatch.TextWidget({
    markdown: '# 📊 Summary',
    width: 24,
    height: 1,
  }),
  // Total messages processed
  new cloudwatch.SingleValueWidget({
    title: 'Total Messages Ingested (24h)',
    metrics: [new cloudwatch.Metric({
      namespace: 'VoC/Ingestion',
      metricName: 'ItemsIngested',
      statistic: 'Sum',
      period: cdk.Duration.hours(24),
    })],
    width: 8,
  }),
  // Validation failures
  new cloudwatch.SingleValueWidget({
    title: 'Validation Failures (24h)',
    metrics: [new cloudwatch.Metric({
      namespace: 'VoC/Processing',
      metricName: 'ValidationFailures',
      statistic: 'Sum',
      period: cdk.Duration.hours(24),
    })],
    width: 8,
  }),
  // Active plugins
  new cloudwatch.SingleValueWidget({
    title: 'Active Plugins',
    metrics: [new cloudwatch.Metric({
      namespace: 'VoC/Plugins',
      metricName: 'ActivePlugins',
      statistic: 'Maximum',
      period: cdk.Duration.hours(1),
    })],
    width: 8,
  })
);
```

### Per-Plugin Alarms

```typescript
// lib/plugin-alarms.ts
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as sns from 'aws-cdk-lib/aws-sns';

export function createPluginAlarms(
  scope: Construct,
  plugin: PluginManifest,
  fn: lambda.Function,
  alertTopic: sns.Topic
): void {
  const alarmNamePrefix = `VoC-Plugin-${plugin.id}`;
  
  // ============================================
  // Error Rate Alarm
  // ============================================
  const errorAlarm = new cloudwatch.Alarm(scope, `${plugin.id}ErrorAlarm`, {
    alarmName: `${alarmNamePrefix}-HighErrorRate`,
    alarmDescription: `Plugin ${plugin.name} error rate exceeds threshold`,
    metric: fn.metricErrors({
      period: cdk.Duration.minutes(5),
      statistic: 'Sum',
    }),
    threshold: 5,
    evaluationPeriods: 2,
    comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
    treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
  });
  errorAlarm.addAlarmAction(new cloudwatchActions.SnsAction(alertTopic));
  
  // ============================================
  // Duration Alarm (approaching timeout)
  // ============================================
  const timeoutMs = (plugin.infrastructure.ingestor?.timeout || 120) * 1000;
  const durationAlarm = new cloudwatch.Alarm(scope, `${plugin.id}DurationAlarm`, {
    alarmName: `${alarmNamePrefix}-HighDuration`,
    alarmDescription: `Plugin ${plugin.name} execution time approaching timeout`,
    metric: fn.metricDuration({
      period: cdk.Duration.minutes(5),
      statistic: 'p95',
    }),
    threshold: timeoutMs * 0.8,  // 80% of timeout
    evaluationPeriods: 3,
    comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
    treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
  });
  durationAlarm.addAlarmAction(new cloudwatchActions.SnsAction(alertTopic));
  
  // ============================================
  // Throttle Alarm
  // ============================================
  const throttleAlarm = new cloudwatch.Alarm(scope, `${plugin.id}ThrottleAlarm`, {
    alarmName: `${alarmNamePrefix}-Throttled`,
    alarmDescription: `Plugin ${plugin.name} is being throttled`,
    metric: fn.metricThrottles({
      period: cdk.Duration.minutes(5),
      statistic: 'Sum',
    }),
    threshold: 1,
    evaluationPeriods: 1,
    comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
    treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
  });
  throttleAlarm.addAlarmAction(new cloudwatchActions.SnsAction(alertTopic));
  
  // ============================================
  // No Invocations Alarm (plugin stopped working)
  // ============================================
  if (plugin.infrastructure.ingestor?.schedule) {
    const noInvocationsAlarm = new cloudwatch.Alarm(scope, `${plugin.id}NoInvocationsAlarm`, {
      alarmName: `${alarmNamePrefix}-NoInvocations`,
      alarmDescription: `Plugin ${plugin.name} has not run in expected timeframe`,
      metric: fn.metricInvocations({
        period: cdk.Duration.hours(1),
        statistic: 'Sum',
      }),
      threshold: 0,
      evaluationPeriods: 2,
      comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.BREACHING,
    });
    noInvocationsAlarm.addAlarmAction(new cloudwatchActions.SnsAction(alertTopic));
  }
  
  // ============================================
  // Validation Failures Alarm (plugin sending bad data)
  // ============================================
  const validationAlarm = new cloudwatch.Alarm(scope, `${plugin.id}ValidationAlarm`, {
    alarmName: `${alarmNamePrefix}-ValidationFailures`,
    alarmDescription: `Plugin ${plugin.name} sending invalid messages`,
    metric: new cloudwatch.Metric({
      namespace: 'VoC/Processing',
      metricName: 'ValidationFailures',
      dimensionsMap: { source_platform: plugin.id },
      period: cdk.Duration.minutes(15),
      statistic: 'Sum',
    }),
    threshold: 10,
    evaluationPeriods: 1,
    comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
    treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
  });
  validationAlarm.addAlarmAction(new cloudwatchActions.SnsAction(alertTopic));
}
```

### Custom Metrics from Plugins

Plugins emit standardized metrics via the shared `metrics` utility:

```python
# plugins/_shared/base_ingestor.py
from shared.logging import metrics

class BaseIngestor:
    def run(self) -> dict:
        """Main execution with metrics."""
        try:
            items = list(self.fetch_new_items())
            
            # Emit plugin-specific metrics
            metrics.add_metric(
                name="ItemsIngested",
                unit="Count",
                value=len(items),
                dimensions={'source_platform': self.source_platform}
            )
            
            if items:
                self.send_to_queue(items)
            
            return {"status": "success", "items_processed": len(items)}
            
        except Exception as e:
            metrics.add_metric(
                name="IngestionErrors",
                unit="Count",
                value=1,
                dimensions={'source_platform': self.source_platform}
            )
            raise
```

### Metric Namespace Structure

```
VoC/
├── Ingestion/
│   ├── ItemsIngested          (dimensions: source_platform)
│   ├── IngestionErrors        (dimensions: source_platform)
│   └── IngestionDuration      (dimensions: source_platform)
│
├── Processing/
│   ├── MessagesProcessed      (dimensions: source_platform)
│   ├── ValidationFailures     (dimensions: source_platform, error_type)
│   └── ProcessingDuration     (dimensions: source_platform)
│
├── Webhooks/
│   ├── WebhookReceived        (dimensions: source_platform)
│   ├── WebhookErrors          (dimensions: source_platform)
│   └── WebhookLatency         (dimensions: source_platform)
│
└── Plugins/
    ├── ActivePlugins          (count of enabled plugins)
    └── PluginHealth           (dimensions: source_platform, status)
```

### Log Insights Queries

Pre-built queries for troubleshooting:

```
# Errors by plugin (last 24h)
fields @timestamp, @message, source_platform
| filter @message like /ERROR/
| stats count() by source_platform
| sort count desc

# Slow executions by plugin
fields @timestamp, @duration, source_platform
| filter @duration > 10000
| stats avg(@duration), max(@duration), count() by source_platform

# Validation failures breakdown
fields @timestamp, @message, source_platform, errors
| filter @message like /Validation failed/
| stats count() by source_platform, errors

# Items ingested per plugin per hour
fields @timestamp, source_platform, items_processed
| filter @message like /items_processed/
| stats sum(items_processed) by bin(1h), source_platform
```

### Alert Routing

Route alerts based on severity and plugin:

```typescript
// lib/stacks/ingestion-stack.ts
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';

// Critical alerts (errors, throttles)
const criticalTopic = new sns.Topic(this, 'PluginCriticalAlerts', {
  topicName: 'voc-plugin-critical-alerts',
  displayName: 'VoC Plugin Critical Alerts',
});
criticalTopic.addSubscription(
  new subscriptions.EmailSubscription('oncall@example.com')
);

// Warning alerts (high duration, no invocations)
const warningTopic = new sns.Topic(this, 'PluginWarningAlerts', {
  topicName: 'voc-plugin-warning-alerts',
  displayName: 'VoC Plugin Warning Alerts',
});
warningTopic.addSubscription(
  new subscriptions.EmailSubscription('team@example.com')
);

// Per-plugin Slack channels (optional)
for (const plugin of enabledPlugins) {
  const pluginTopic = new sns.Topic(this, `PluginAlerts${plugin.id}`, {
    topicName: `voc-plugin-${plugin.id}-alerts`,
  });
  // Could route to plugin-specific Slack channel
}
```

### Health Check Endpoint

API endpoint to check plugin health:

```python
# lambda/api/plugin_health_handler.py
def get_plugin_health() -> dict:
    """Get health status of all plugins."""
    events = boto3.client('events')
    cloudwatch = boto3.client('cloudwatch')
    
    plugins = {}
    
    # Get all plugin schedules
    rules = events.list_rules(NamePrefix='voc-ingest-')
    
    for rule in rules.get('Rules', []):
        plugin_id = rule['Name'].replace('voc-ingest-', '').replace('-schedule', '')
        
        # Get recent metrics
        errors = cloudwatch.get_metric_statistics(
            Namespace='AWS/Lambda',
            MetricName='Errors',
            Dimensions=[{'Name': 'FunctionName', 'Value': f'voc-ingestor-{plugin_id}'}],
            StartTime=datetime.utcnow() - timedelta(hours=1),
            EndTime=datetime.utcnow(),
            Period=3600,
            Statistics=['Sum']
        )
        
        invocations = cloudwatch.get_metric_statistics(
            Namespace='AWS/Lambda',
            MetricName='Invocations',
            Dimensions=[{'Name': 'FunctionName', 'Value': f'voc-ingestor-{plugin_id}'}],
            StartTime=datetime.utcnow() - timedelta(hours=1),
            EndTime=datetime.utcnow(),
            Period=3600,
            Statistics=['Sum']
        )
        
        error_count = errors['Datapoints'][0]['Sum'] if errors['Datapoints'] else 0
        invocation_count = invocations['Datapoints'][0]['Sum'] if invocations['Datapoints'] else 0
        
        # Determine health status
        if rule['State'] != 'ENABLED':
            status = 'disabled'
        elif error_count > 0 and invocation_count > 0 and error_count / invocation_count > 0.1:
            status = 'unhealthy'
        elif invocation_count == 0:
            status = 'inactive'
        else:
            status = 'healthy'
        
        plugins[plugin_id] = {
            'status': status,
            'enabled': rule['State'] == 'ENABLED',
            'schedule': rule.get('ScheduleExpression', ''),
            'last_hour': {
                'invocations': int(invocation_count),
                'errors': int(error_count),
            }
        }
    
    return {
        'plugins': plugins,
        'summary': {
            'total': len(plugins),
            'healthy': sum(1 for p in plugins.values() if p['status'] == 'healthy'),
            'unhealthy': sum(1 for p in plugins.values() if p['status'] == 'unhealthy'),
            'disabled': sum(1 for p in plugins.values() if p['status'] == 'disabled'),
        }
    }
```

### Frontend Health Display

Show plugin health in Settings UI:

```tsx
// frontend/src/pages/Settings/PluginHealthBadge.tsx
type HealthStatus = 'healthy' | 'unhealthy' | 'inactive' | 'disabled';

const statusConfig: Record<HealthStatus, { color: string; icon: ReactNode; label: string }> = {
  healthy: { color: 'green', icon: <CheckCircle2 size={14} />, label: 'Healthy' },
  unhealthy: { color: 'red', icon: <AlertCircle size={14} />, label: 'Unhealthy' },
  inactive: { color: 'yellow', icon: <Clock size={14} />, label: 'Inactive' },
  disabled: { color: 'gray', icon: <Pause size={14} />, label: 'Disabled' },
};

function PluginHealthBadge({ status }: { status: HealthStatus }) {
  const config = statusConfig[status];
  return (
    <span className={`flex items-center gap-1 text-xs text-${config.color}-600`}>
      {config.icon}
      {config.label}
    </span>
  );
}
```

---

## Summary: Observability Stack

| Component | Purpose |
|-----------|---------|
| **Cost Tags** | Track spend per plugin via AWS Cost Explorer |
| **Budgets** | Alert when plugin costs exceed threshold |
| **Dashboard** | Visual overview of all plugin metrics |
| **Alarms** | Automated alerts for errors, throttles, timeouts |
| **Custom Metrics** | Plugin-specific metrics (items ingested, etc.) |
| **Log Insights** | Pre-built queries for troubleshooting |
| **Health API** | Programmatic health check endpoint |
| **Health UI** | Visual health status in Settings page |

This gives you full visibility into:
- How much each plugin costs
- Whether plugins are working correctly
- When plugins need attention
- Historical trends and patterns


---

## Security Hardening

### Issue Tracker

| Priority | Issue | Status |
|----------|-------|--------|
| 🔴 Critical | Secrets not isolated at IAM level | Addressed below |
| 🔴 Critical | No webhook authentication | Addressed below |
| 🔴 Critical | Manifest injection risks | Addressed below |
| 🟠 High | No code integrity verification | Addressed below |
| 🟠 High | Metadata allows arbitrary objects | Addressed below |
| 🟠 High | No audit logging | Addressed below |
| 🟡 Medium | No versioning | Addressed below |
| 🟡 Medium | No circuit breaker | Addressed below |
| 🟡 Medium | No resource tagging | Already addressed in Cost Allocation section |
| 🟢 Low | Manual Python validation | Addressed below |

---

### 🔴 Critical: Per-Plugin Secrets Isolation

**Problem**: All plugins share one Secrets Manager secret. A compromised plugin could read other plugins' credentials.

**Solution**: One secret per plugin with IAM conditions.

```typescript
// lib/stacks/ingestion-stack.ts
for (const plugin of enabledPlugins) {
  // Create dedicated secret for each plugin
  const pluginSecret = new secretsmanager.Secret(this, `Secret${plugin.id}`, {
    secretName: `voc-datalake/plugins/${plugin.id}`,
    description: `Credentials for ${plugin.name} plugin`,
    generateSecretString: {
      secretStringTemplate: JSON.stringify(plugin.secrets || {}),
      generateStringKey: 'placeholder',
    },
  });
  
  // Tag for cost allocation
  Tags.of(pluginSecret).add('Plugin', plugin.id);
  
  // Create plugin-specific role with access only to its secret
  const pluginRole = new iam.Role(this, `Role${plugin.id}`, {
    assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
    roleName: `voc-plugin-${plugin.id}-role`,
    managedPolicies: [
      iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
    ],
  });
  
  // Grant access ONLY to this plugin's secret
  pluginSecret.grantRead(pluginRole);
  
  // Shared resources with scoped access
  pluginRole.addToPolicy(new iam.PolicyStatement({
    sid: 'SendToProcessingQueue',
    actions: ['sqs:SendMessage', 'sqs:SendMessageBatch'],
    resources: [processingQueue.queueArn],
  }));
  
  pluginRole.addToPolicy(new iam.PolicyStatement({
    sid: 'WriteRawData',
    actions: ['s3:PutObject'],
    resources: [`${rawDataBucket.bucketArn}/raw/${plugin.id}/*`],  // Scoped to plugin prefix
  }));
  
  pluginRole.addToPolicy(new iam.PolicyStatement({
    sid: 'ManageWatermarks',
    actions: ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem'],
    resources: [watermarksTable.tableArn],
    conditions: {
      'ForAllValues:StringLike': {
        'dynamodb:LeadingKeys': [`${plugin.id}#*`],  // Scoped to plugin prefix
      },
    },
  }));
  
  // Create Lambda with plugin-specific role
  const fn = new lambda.Function(this, `Ingestor${plugin.id}`, {
    role: pluginRole,  // Dedicated role, not shared
    environment: {
      SECRETS_ARN: pluginSecret.secretArn,  // Only this plugin's secret
      // ...
    },
    // ...
  });
}
```

---

### 🔴 Critical: Webhook Signature Verification

**Problem**: Webhook endpoints have no authentication. Anyone can send fake events.

**Solution**: Verify webhook signatures using provider-specific methods.

```python
# plugins/_shared/webhook_auth.py
"""
Webhook signature verification for different providers.
Each provider has its own signing method.
"""
import hmac
import hashlib
import base64
from typing import Callable
from functools import wraps

class WebhookAuthError(Exception):
    """Raised when webhook signature verification fails."""
    pass


def verify_trustpilot_signature(payload: bytes, signature: str, secret: str) -> bool:
    """Verify Trustpilot webhook signature (HMAC-SHA256)."""
    expected = hmac.new(
        secret.encode('utf-8'),
        payload,
        hashlib.sha256
    ).hexdigest()
    return hmac.compare_digest(expected, signature)


def verify_github_signature(payload: bytes, signature: str, secret: str) -> bool:
    """Verify GitHub webhook signature (HMAC-SHA256 with sha256= prefix)."""
    if not signature.startswith('sha256='):
        return False
    expected = 'sha256=' + hmac.new(
        secret.encode('utf-8'),
        payload,
        hashlib.sha256
    ).hexdigest()
    return hmac.compare_digest(expected, signature)


def verify_stripe_signature(payload: bytes, signature: str, secret: str) -> bool:
    """Verify Stripe webhook signature (timestamp + HMAC-SHA256)."""
    # Stripe uses t=timestamp,v1=signature format
    try:
        parts = dict(item.split('=') for item in signature.split(','))
        timestamp = parts.get('t')
        sig = parts.get('v1')
        if not timestamp or not sig:
            return False
        
        signed_payload = f"{timestamp}.{payload.decode('utf-8')}"
        expected = hmac.new(
            secret.encode('utf-8'),
            signed_payload.encode('utf-8'),
            hashlib.sha256
        ).hexdigest()
        return hmac.compare_digest(expected, sig)
    except Exception:
        return False


# Registry of verification methods per provider
SIGNATURE_VERIFIERS: dict[str, Callable[[bytes, str, str], bool]] = {
    'trustpilot': verify_trustpilot_signature,
    'github': verify_github_signature,
    'stripe': verify_stripe_signature,
    # Add more as needed
}


def require_webhook_signature(provider: str, header_name: str = 'X-Signature'):
    """
    Decorator to require webhook signature verification.
    
    Usage:
        @require_webhook_signature('trustpilot', 'X-Trustpilot-Signature')
        def lambda_handler(event, context):
            ...
    """
    def decorator(handler: Callable):
        @wraps(handler)
        def wrapper(event: dict, context):
            # Get signature from headers
            headers = event.get('headers', {})
            # Headers can be case-insensitive
            signature = None
            for key, value in headers.items():
                if key.lower() == header_name.lower():
                    signature = value
                    break
            
            if not signature:
                return {
                    'statusCode': 401,
                    'body': '{"error": "Missing signature header"}'
                }
            
            # Get webhook secret from environment
            import os
            secret = os.environ.get('WEBHOOK_SECRET', '')
            if not secret:
                # Log error but don't expose to caller
                print("ERROR: WEBHOOK_SECRET not configured")
                return {
                    'statusCode': 500,
                    'body': '{"error": "Server configuration error"}'
                }
            
            # Get raw body
            body = event.get('body', '')
            if event.get('isBase64Encoded'):
                body = base64.b64decode(body)
            elif isinstance(body, str):
                body = body.encode('utf-8')
            
            # Verify signature
            verifier = SIGNATURE_VERIFIERS.get(provider)
            if not verifier:
                print(f"ERROR: No signature verifier for provider: {provider}")
                return {
                    'statusCode': 500,
                    'body': '{"error": "Server configuration error"}'
                }
            
            if not verifier(body, signature, secret):
                return {
                    'statusCode': 401,
                    'body': '{"error": "Invalid signature"}'
                }
            
            # Signature valid, proceed with handler
            return handler(event, context)
        
        return wrapper
    return decorator
```

**Webhook handler with signature verification:**

```python
# plugins/trustpilot/webhook/handler.py
from webhook_auth import require_webhook_signature

@require_webhook_signature('trustpilot', 'X-Trustpilot-Signature')
@logger.inject_lambda_context
@tracer.capture_lambda_handler
def lambda_handler(event: dict, context) -> dict:
    """Trustpilot webhook handler with signature verification."""
    # At this point, signature is verified
    body = json.loads(event.get('body', '{}'))
    # ... process webhook
```

**Manifest update for webhook secrets:**

```json
{
  "infrastructure": {
    "webhook": {
      "enabled": true,
      "path": "/webhooks/trustpilot",
      "methods": ["POST"],
      "signatureHeader": "X-Trustpilot-Signature",
      "signatureMethod": "trustpilot"
    }
  },
  "secrets": {
    "trustpilot_webhook_secret": ""
  }
}
```

---

### 🔴 Critical: Manifest Input Sanitization

**Problem**: Manifest values could contain injection attacks (path traversal, command injection).

**Solution**: Strict validation with allowlists and sanitization.

```typescript
// lib/plugin-loader.ts
import { z } from 'zod';

// Strict ID pattern - only lowercase alphanumeric and underscores
const PluginIdSchema = z.string()
  .min(1)
  .max(32)
  .regex(/^[a-z][a-z0-9_]*$/, 'ID must start with letter, contain only lowercase alphanumeric and underscores');

// Safe path pattern - no traversal
const SafePathSchema = z.string()
  .max(128)
  .regex(/^\/[a-z0-9\-_\/]*$/, 'Path must start with / and contain only safe characters')
  .refine(path => !path.includes('..'), 'Path traversal not allowed')
  .refine(path => !path.includes('//'), 'Double slashes not allowed');

// Safe string - no control characters or dangerous patterns
const SafeStringSchema = z.string()
  .max(256)
  .refine(s => !/[\x00-\x1f\x7f]/.test(s), 'Control characters not allowed')
  .refine(s => !/<script|javascript:|data:/i.test(s), 'Potentially dangerous content');

// Icon - only emoji or safe SVG path
const IconSchema = z.string()
  .max(64)
  .refine(s => {
    // Allow emoji (most are in these ranges)
    const isEmoji = /^[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]+$/u.test(s);
    // Or safe relative path to SVG
    const isSafePath = /^[a-z0-9\-_]+\.svg$/.test(s);
    return isEmoji || isSafePath;
  }, 'Icon must be emoji or safe SVG filename');

// Schedule expression - only safe EventBridge patterns
const ScheduleSchema = z.string()
  .regex(/^rate\(\d+\s+(minute|minutes|hour|hours|day|days)\)$|^cron\([0-9,\-\*\/\s]+\)$/, 
    'Invalid schedule expression');

// Config key - safe identifier
const ConfigKeySchema = z.string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9_]*$/, 'Config key must be safe identifier');

// Full manifest schema with strict validation
const StrictManifestSchema = z.object({
  id: PluginIdSchema,
  name: SafeStringSchema,
  icon: IconSchema,
  description: SafeStringSchema.optional(),
  category: z.enum(['reviews', 'social', 'appstore', 'import', 'search']).optional(),
  
  infrastructure: z.object({
    ingestor: z.object({
      enabled: z.boolean(),
      schedule: ScheduleSchema.optional(),
      timeout: z.number().int().min(1).max(300),
      memory: z.number().int().min(128).max(1024),
    }).optional(),
    webhook: z.object({
      enabled: z.boolean(),
      path: SafePathSchema,
      methods: z.array(z.enum(['GET', 'POST', 'PUT', 'DELETE'])).max(4),
      signatureHeader: z.string().max(64).regex(/^[A-Za-z0-9\-]+$/).optional(),
      signatureMethod: z.string().max(32).regex(/^[a-z_]+$/).optional(),
    }).optional(),
    s3Trigger: z.object({
      enabled: z.boolean(),
      suffixes: z.array(z.string().regex(/^\.[a-z0-9]+$/).max(10)).max(5),
    }).optional(),
  }),
  
  config: z.array(z.object({
    key: ConfigKeySchema,
    label: SafeStringSchema,
    type: z.enum(['text', 'password', 'textarea', 'select']),
    required: z.boolean().optional(),
    placeholder: SafeStringSchema.optional(),
    secret: z.boolean().optional(),
  })).max(20),
  
  webhooks: z.array(z.object({
    name: SafeStringSchema,
    events: z.array(SafeStringSchema).max(10),
    docUrl: z.string().url().max(256).optional(),
  })).max(5).optional(),
  
  setup: z.object({
    title: SafeStringSchema,
    color: z.enum(['blue', 'orange', 'green', 'gray']).optional(),
    steps: z.array(SafeStringSchema).max(10),
  }).optional(),
  
  secrets: z.record(ConfigKeySchema, z.string().max(0)).max(10).optional(),  // Values must be empty in manifest
  
  version: z.string().regex(/^\d+\.\d+\.\d+$/, 'Version must be semver').optional(),
});

export function loadAndValidateManifest(manifestPath: string): PluginManifest {
  const raw = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
  
  // Strict validation
  const result = StrictManifestSchema.safeParse(raw);
  
  if (!result.success) {
    const errors = result.error.errors.map(e => `${e.path.join('.')}: ${e.message}`);
    throw new Error(`Invalid manifest: ${errors.join(', ')}`);
  }
  
  return result.data;
}
```

---

### 🟠 High: Code Integrity Verification

**Problem**: No way to verify plugin code hasn't been tampered with.

**Solution**: SHA256 hash of plugin code stored in manifest and verified at deploy time.

```json
// manifest.json with integrity hash
{
  "id": "trustpilot",
  "version": "1.2.0",
  "integrity": {
    "ingestor": "sha256-a1b2c3d4e5f6...",
    "webhook": "sha256-f6e5d4c3b2a1..."
  }
}
```

```typescript
// lib/plugin-loader.ts
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

function computeDirectoryHash(dirPath: string): string {
  /**
   * Compute SHA256 hash of all Python files in a directory.
   * Files are sorted for deterministic hashing.
   */
  const files: string[] = [];
  
  function collectFiles(dir: string) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory() && !entry.name.startsWith('__')) {
        collectFiles(fullPath);
      } else if (entry.isFile() && entry.name.endsWith('.py')) {
        files.push(fullPath);
      }
    }
  }
  
  collectFiles(dirPath);
  files.sort();
  
  const hash = crypto.createHash('sha256');
  for (const file of files) {
    const content = fs.readFileSync(file);
    hash.update(content);
  }
  
  return 'sha256-' + hash.digest('hex');
}

function verifyPluginIntegrity(plugin: PluginManifest, pluginsDir: string): void {
  const pluginDir = path.join(pluginsDir, plugin.id);
  
  // Verify ingestor code
  if (plugin.infrastructure.ingestor?.enabled) {
    const ingestorDir = path.join(pluginDir, 'ingestor');
    const actualHash = computeDirectoryHash(ingestorDir);
    const expectedHash = plugin.integrity?.ingestor;
    
    if (!expectedHash) {
      throw new Error(`Plugin ${plugin.id}: missing integrity hash for ingestor`);
    }
    
    if (actualHash !== expectedHash) {
      throw new Error(
        `Plugin ${plugin.id}: ingestor code integrity check failed.\n` +
        `Expected: ${expectedHash}\n` +
        `Actual: ${actualHash}`
      );
    }
  }
  
  // Verify webhook code
  if (plugin.infrastructure.webhook?.enabled) {
    const webhookDir = path.join(pluginDir, 'webhook');
    const actualHash = computeDirectoryHash(webhookDir);
    const expectedHash = plugin.integrity?.webhook;
    
    if (!expectedHash) {
      throw new Error(`Plugin ${plugin.id}: missing integrity hash for webhook`);
    }
    
    if (actualHash !== expectedHash) {
      throw new Error(
        `Plugin ${plugin.id}: webhook code integrity check failed.\n` +
        `Expected: ${expectedHash}\n` +
        `Actual: ${actualHash}`
      );
    }
  }
  
  console.log(`✓ Plugin ${plugin.id} integrity verified`);
}

// Script to generate integrity hashes
// Run: npx ts-node scripts/generate-integrity.ts
export function generateIntegrityHashes(pluginId: string, pluginsDir: string): void {
  const pluginDir = path.join(pluginsDir, pluginId);
  const manifestPath = path.join(pluginDir, 'manifest.json');
  
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
  
  manifest.integrity = {};
  
  const ingestorDir = path.join(pluginDir, 'ingestor');
  if (fs.existsSync(ingestorDir)) {
    manifest.integrity.ingestor = computeDirectoryHash(ingestorDir);
  }
  
  const webhookDir = path.join(pluginDir, 'webhook');
  if (fs.existsSync(webhookDir)) {
    manifest.integrity.webhook = computeDirectoryHash(webhookDir);
  }
  
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  console.log(`Updated integrity hashes for ${pluginId}`);
}
```

**CI/CD integration:**

```yaml
# .github/workflows/plugin-integrity.yml
name: Verify Plugin Integrity
on:
  pull_request:
    paths:
      - 'plugins/**'

jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      
      - name: Verify integrity hashes
        run: |
          npm run verify:integrity
          
      - name: Check for uncommitted hash changes
        run: |
          git diff --exit-code plugins/*/manifest.json || \
            (echo "ERROR: Integrity hashes out of date. Run 'npm run generate:integrity'" && exit 1)
```

---

### 🟠 High: Restrict Metadata to Primitives

**Problem**: `metadata` field allows arbitrary nested objects, potential for abuse.

**Solution**: Restrict to flat object with primitive values only.

```typescript
// Strict metadata schema - primitives only, no nesting
const MetadataValueSchema = z.union([
  z.string().max(1000),
  z.number(),
  z.boolean(),
  z.null(),
]);

const MetadataSchema = z.record(
  z.string().max(64).regex(/^[a-z_][a-z0-9_]*$/),  // Safe keys only
  MetadataValueSchema
).refine(
  obj => Object.keys(obj).length <= 20,
  'Metadata cannot have more than 20 keys'
);

// In message validation
const MessageSchema = z.object({
  // ... other fields
  metadata: MetadataSchema.optional(),
});
```

```python
# lambda/processor/validator.py
def validate_metadata(metadata: dict) -> tuple[bool, list[str]]:
    """Validate metadata is flat with primitive values only."""
    errors = []
    
    if not isinstance(metadata, dict):
        return False, ['metadata must be an object']
    
    if len(metadata) > 20:
        errors.append('metadata cannot have more than 20 keys')
    
    for key, value in metadata.items():
        # Validate key
        if not isinstance(key, str):
            errors.append(f'metadata key must be string, got {type(key)}')
            continue
        if len(key) > 64:
            errors.append(f'metadata key "{key[:20]}..." exceeds max length')
        if not re.match(r'^[a-z_][a-z0-9_]*$', key):
            errors.append(f'metadata key "{key}" contains invalid characters')
        
        # Validate value - primitives only
        if value is None:
            continue
        if isinstance(value, bool):
            continue
        if isinstance(value, (int, float)):
            continue
        if isinstance(value, str):
            if len(value) > 1000:
                errors.append(f'metadata value for "{key}" exceeds max length')
            continue
        
        # Reject nested objects, arrays, etc.
        errors.append(f'metadata value for "{key}" must be primitive (string, number, boolean, null)')
    
    return len(errors) == 0, errors
```

---

### 🟠 High: Audit Logging

**Problem**: No structured audit trail for plugin operations.

**Solution**: Emit structured audit events to CloudWatch Logs and optionally to S3/EventBridge.

```python
# plugins/_shared/audit.py
"""
Structured audit logging for plugin operations.
"""
import json
import os
from datetime import datetime, timezone
from typing import Literal
from dataclasses import dataclass, asdict

from shared.logging import logger
from shared.aws import get_eventbridge_client

AUDIT_EVENT_BUS = os.environ.get('AUDIT_EVENT_BUS', '')

AuditAction = Literal[
    'plugin.invoked',
    'plugin.completed',
    'plugin.failed',
    'plugin.enabled',
    'plugin.disabled',
    'webhook.received',
    'webhook.verified',
    'webhook.rejected',
    'message.ingested',
    'message.validated',
    'message.rejected',
    'secret.accessed',
    'config.updated',
]

@dataclass
class AuditEvent:
    """Structured audit event."""
    timestamp: str
    action: AuditAction
    plugin_id: str
    success: bool
    details: dict
    request_id: str = ''
    user_id: str = ''
    ip_address: str = ''
    
    def to_dict(self) -> dict:
        return asdict(self)


def emit_audit_event(
    action: AuditAction,
    plugin_id: str,
    success: bool,
    details: dict = None,
    request_id: str = '',
    user_id: str = '',
    ip_address: str = '',
) -> None:
    """
    Emit a structured audit event.
    
    Events are:
    1. Logged to CloudWatch (always)
    2. Sent to EventBridge (if configured)
    """
    event = AuditEvent(
        timestamp=datetime.now(timezone.utc).isoformat(),
        action=action,
        plugin_id=plugin_id,
        success=success,
        details=details or {},
        request_id=request_id,
        user_id=user_id,
        ip_address=ip_address,
    )
    
    # Always log to CloudWatch
    logger.info('AUDIT', extra={'audit_event': event.to_dict()})
    
    # Optionally send to EventBridge for downstream processing
    if AUDIT_EVENT_BUS:
        try:
            events = get_eventbridge_client()
            events.put_events(Entries=[{
                'Source': 'voc.plugins',
                'DetailType': f'Plugin Audit: {action}',
                'Detail': json.dumps(event.to_dict()),
                'EventBusName': AUDIT_EVENT_BUS,
            }])
        except Exception as e:
            logger.warning(f'Failed to send audit event to EventBridge: {e}')


# Usage in base_ingestor.py
class BaseIngestor:
    def run(self) -> dict:
        emit_audit_event('plugin.invoked', self.source_platform, True)
        
        try:
            items = list(self.fetch_new_items())
            
            for item in items:
                emit_audit_event('message.ingested', self.source_platform, True, {
                    'message_id': item.get('id'),
                })
            
            self.send_to_queue(items)
            
            emit_audit_event('plugin.completed', self.source_platform, True, {
                'items_processed': len(items),
            })
            
            return {"status": "success", "items_processed": len(items)}
            
        except Exception as e:
            emit_audit_event('plugin.failed', self.source_platform, False, {
                'error': str(e),
                'error_type': type(e).__name__,
            })
            raise
```

**Log Insights query for audit events:**

```
# All audit events for a plugin
fields @timestamp, audit_event.action, audit_event.success, audit_event.details
| filter audit_event.plugin_id = 'trustpilot'
| sort @timestamp desc
| limit 100

# Failed operations across all plugins
fields @timestamp, audit_event.plugin_id, audit_event.action, audit_event.details.error
| filter audit_event.success = false
| sort @timestamp desc

# Webhook rejections (potential attacks)
fields @timestamp, audit_event.plugin_id, audit_event.details.ip_address, audit_event.details.reason
| filter audit_event.action = 'webhook.rejected'
| stats count() by audit_event.details.ip_address
| sort count desc
```

---

### 🟡 Medium: Plugin Versioning

**Problem**: No way to track plugin versions or manage upgrades.

**Solution**: Require semver in manifest, track in DynamoDB.

```json
// manifest.json
{
  "id": "trustpilot",
  "version": "1.2.0",
  "minPlatformVersion": "2.0.0",
  // ...
}
```

```typescript
// lib/plugin-loader.ts
import * as semver from 'semver';

const PLATFORM_VERSION = '2.1.0';  // Current platform version

function validatePluginVersion(plugin: PluginManifest): void {
  // Version is required
  if (!plugin.version) {
    throw new Error(`Plugin ${plugin.id}: version is required`);
  }
  
  // Must be valid semver
  if (!semver.valid(plugin.version)) {
    throw new Error(`Plugin ${plugin.id}: invalid version "${plugin.version}"`);
  }
  
  // Check platform compatibility
  if (plugin.minPlatformVersion) {
    if (!semver.gte(PLATFORM_VERSION, plugin.minPlatformVersion)) {
      throw new Error(
        `Plugin ${plugin.id} requires platform version ${plugin.minPlatformVersion}, ` +
        `but current version is ${PLATFORM_VERSION}`
      );
    }
  }
}
```

**Version tracking in DynamoDB:**

```python
# Track deployed plugin versions
def record_plugin_deployment(plugin_id: str, version: str) -> None:
    """Record plugin deployment for version tracking."""
    table = dynamodb.Table(os.environ['PLUGINS_TABLE'])
    
    table.put_item(Item={
        'pk': f'PLUGIN#{plugin_id}',
        'sk': f'VERSION#{version}',
        'deployed_at': datetime.now(timezone.utc).isoformat(),
        'deployed_by': os.environ.get('DEPLOYED_BY', 'cdk'),
    })
    
    # Update current version pointer
    table.update_item(
        Key={'pk': f'PLUGIN#{plugin_id}', 'sk': 'CURRENT'},
        UpdateExpression='SET version = :v, updated_at = :t',
        ExpressionAttributeValues={
            ':v': version,
            ':t': datetime.now(timezone.utc).isoformat(),
        }
    )
```

---

### 🟡 Medium: Circuit Breaker

**Problem**: A failing plugin keeps running and wasting resources.

**Solution**: Auto-disable plugins after repeated failures.

```python
# plugins/_shared/circuit_breaker.py
"""
Circuit breaker pattern for plugins.
Auto-disables plugins after repeated failures.
"""
import os
from datetime import datetime, timezone, timedelta
from shared.aws import get_dynamodb_resource, get_eventbridge_client

FAILURE_THRESHOLD = int(os.environ.get('CIRCUIT_BREAKER_THRESHOLD', '5'))
WINDOW_MINUTES = int(os.environ.get('CIRCUIT_BREAKER_WINDOW', '15'))

dynamodb = get_dynamodb_resource()
events = get_eventbridge_client()


class CircuitBreaker:
    def __init__(self, plugin_id: str):
        self.plugin_id = plugin_id
        self.table = dynamodb.Table(os.environ['WATERMARKS_TABLE'])
    
    def record_failure(self, error: str) -> None:
        """Record a failure. May trigger circuit breaker."""
        now = datetime.now(timezone.utc)
        window_start = now - timedelta(minutes=WINDOW_MINUTES)
        
        # Get recent failures
        response = self.table.query(
            KeyConditionExpression='pk = :pk AND sk BETWEEN :start AND :end',
            ExpressionAttributeValues={
                ':pk': f'FAILURES#{self.plugin_id}',
                ':start': window_start.isoformat(),
                ':end': now.isoformat(),
            }
        )
        
        recent_failures = len(response.get('Items', []))
        
        # Record this failure
        self.table.put_item(Item={
            'pk': f'FAILURES#{self.plugin_id}',
            'sk': now.isoformat(),
            'error': error[:500],  # Truncate
            'ttl': int((now + timedelta(hours=24)).timestamp()),  # Auto-cleanup
        })
        
        # Check if threshold exceeded
        if recent_failures + 1 >= FAILURE_THRESHOLD:
            self._trip_breaker(recent_failures + 1, error)
    
    def _trip_breaker(self, failure_count: int, last_error: str) -> None:
        """Disable the plugin schedule."""
        rule_name = f'voc-ingest-{self.plugin_id}-schedule'
        
        try:
            events.disable_rule(Name=rule_name)
            
            # Record the trip
            self.table.put_item(Item={
                'pk': f'CIRCUIT#{self.plugin_id}',
                'sk': 'TRIPPED',
                'tripped_at': datetime.now(timezone.utc).isoformat(),
                'failure_count': failure_count,
                'last_error': last_error[:500],
            })
            
            # Emit audit event
            from audit import emit_audit_event
            emit_audit_event('plugin.disabled', self.plugin_id, True, {
                'reason': 'circuit_breaker',
                'failure_count': failure_count,
                'last_error': last_error,
            })
            
            print(f"CIRCUIT BREAKER: Disabled {self.plugin_id} after {failure_count} failures")
            
        except Exception as e:
            print(f"Failed to trip circuit breaker: {e}")
    
    def record_success(self) -> None:
        """Record a success. Resets failure count."""
        # Clear the circuit breaker state on success
        self.table.delete_item(
            Key={'pk': f'CIRCUIT#{self.plugin_id}', 'sk': 'TRIPPED'}
        )
    
    def is_open(self) -> bool:
        """Check if circuit breaker is open (plugin disabled)."""
        response = self.table.get_item(
            Key={'pk': f'CIRCUIT#{self.plugin_id}', 'sk': 'TRIPPED'}
        )
        return 'Item' in response


# Integration with base_ingestor.py
class BaseIngestor:
    def __init__(self):
        # ...
        self.circuit_breaker = CircuitBreaker(self.source_platform)
    
    def run(self) -> dict:
        # Check circuit breaker before running
        if self.circuit_breaker.is_open():
            logger.warning(f"Circuit breaker open for {self.source_platform}, skipping")
            return {"status": "skipped", "reason": "circuit_breaker_open"}
        
        try:
            items = list(self.fetch_new_items())
            self.send_to_queue(items)
            
            # Record success
            self.circuit_breaker.record_success()
            
            return {"status": "success", "items_processed": len(items)}
            
        except Exception as e:
            # Record failure
            self.circuit_breaker.record_failure(str(e))
            raise
```

**Manual reset via API:**

```python
# lambda/api/plugin_handler.py
def reset_circuit_breaker(plugin_id: str) -> dict:
    """Manually reset circuit breaker and re-enable plugin."""
    # Clear circuit breaker state
    table = dynamodb.Table(os.environ['WATERMARKS_TABLE'])
    table.delete_item(
        Key={'pk': f'CIRCUIT#{plugin_id}', 'sk': 'TRIPPED'}
    )
    
    # Re-enable the schedule
    events.enable_rule(Name=f'voc-ingest-{plugin_id}-schedule')
    
    emit_audit_event('plugin.enabled', plugin_id, True, {
        'reason': 'manual_reset',
    })
    
    return {'status': 'reset', 'plugin': plugin_id}
```

---

### 🟢 Low: Pydantic Validation

**Problem**: Manual Python validation is error-prone.

**Solution**: Use Pydantic for runtime validation with automatic error messages.

```python
# plugins/_shared/schemas.py
"""
Pydantic schemas for message validation.
"""
from datetime import datetime
from typing import Optional
from pydantic import BaseModel, Field, field_validator, model_validator
import re


class MessageMetadata(BaseModel):
    """Flat metadata with primitive values only."""
    model_config = {'extra': 'forbid'}  # No extra fields allowed
    
    # Define known metadata fields explicitly
    is_verified: Optional[bool] = None
    location_id: Optional[str] = Field(None, max_length=64)
    reference_id: Optional[str] = Field(None, max_length=64)
    reply_count: Optional[int] = Field(None, ge=0)
    like_count: Optional[int] = Field(None, ge=0)
    
    @field_validator('location_id', 'reference_id')
    @classmethod
    def validate_safe_string(cls, v: Optional[str]) -> Optional[str]:
        if v is None:
            return v
        if re.search(r'[\x00-\x1f\x7f]', v):
            raise ValueError('Control characters not allowed')
        return v


class IngestMessage(BaseModel):
    """Schema for messages sent to processing queue."""
    model_config = {'extra': 'forbid'}
    
    # Required fields
    id: str = Field(..., min_length=1, max_length=256)
    source_platform: str = Field(..., pattern=r'^[a-z][a-z0-9_]*$')
    text: str = Field(..., min_length=1, max_length=50_000)
    created_at: datetime
    
    # Optional fields
    rating: Optional[float] = Field(None, ge=1, le=5)
    url: Optional[str] = Field(None, max_length=2048)
    channel: Optional[str] = Field(None, max_length=64)
    author: Optional[str] = Field(None, max_length=256)
    title: Optional[str] = Field(None, max_length=500)
    language: Optional[str] = Field(None, pattern=r'^[a-z]{2}(-[A-Z]{2})?$')
    brand_handles_matched: Optional[list[str]] = Field(None, max_length=10)
    metadata: Optional[MessageMetadata] = None
    
    # Internal fields (set by platform)
    ingested_at: Optional[datetime] = None
    s3_raw_uri: Optional[str] = None
    
    @field_validator('id', 'source_platform', 'channel', 'author', 'title')
    @classmethod
    def sanitize_string(cls, v: Optional[str]) -> Optional[str]:
        if v is None:
            return v
        # Remove control characters
        v = re.sub(r'[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]', '', v)
        return v.strip()
    
    @field_validator('text')
    @classmethod
    def sanitize_text(cls, v: str) -> str:
        # Remove control characters except newlines/tabs
        v = re.sub(r'[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]', '', v)
        # Normalize excessive newlines
        v = re.sub(r'\n{3,}', '\n\n', v)
        return v.strip()
    
    @field_validator('url')
    @classmethod
    def validate_url(cls, v: Optional[str]) -> Optional[str]:
        if v is None:
            return v
        if not v.startswith(('http://', 'https://')):
            raise ValueError('URL must start with http:// or https://')
        return v
    
    @model_validator(mode='after')
    def validate_created_at_not_future(self) -> 'IngestMessage':
        if self.created_at > datetime.now(self.created_at.tzinfo) + timedelta(days=1):
            raise ValueError('created_at cannot be more than 1 day in the future')
        return self


# Usage in processor
from pydantic import ValidationError

def validate_message(raw: dict) -> IngestMessage:
    """Validate and parse a raw message."""
    try:
        return IngestMessage.model_validate(raw)
    except ValidationError as e:
        # Convert to our error format
        errors = [f"{err['loc']}: {err['msg']}" for err in e.errors()]
        raise MessageValidationError(errors)
```

**Benefits of Pydantic:**
- Automatic type coercion (string dates → datetime)
- Clear error messages with field paths
- JSON Schema generation for documentation
- Serialization/deserialization built-in
- IDE autocomplete support

---

## Security Checklist

Before deploying a plugin, verify:

- [ ] Manifest passes strict schema validation
- [ ] Code integrity hash matches
- [ ] No hardcoded secrets in code
- [ ] Webhook signature verification implemented (if webhook)
- [ ] All config keys use safe identifiers
- [ ] Version follows semver
- [ ] Tests pass
- [ ] Code review completed (for community plugins)

```bash
# Run all security checks
npm run security:check -- --plugin=trustpilot

# Output:
# ✓ Manifest schema valid
# ✓ Code integrity verified
# ✓ No hardcoded secrets found
# ✓ Webhook signature verification present
# ✓ Config keys valid
# ✓ Version valid (1.2.0)
# ✓ Tests pass (12/12)
# 
# Plugin trustpilot passed all security checks
```
