# Plugin Template

This is a template for creating new VoC data source plugins.

## Quick Start

The full walkthrough is [docs/getting-started-plugins.md](../../../docs/getting-started-plugins.md).

1. Copy this folder to `plugins/{your_source_id}/` (the folder name is the manifest `id`)
2. Update `manifest.json` with your source details, `secrets` and any capability (below)
3. Implement `fetch_new_items()` in `ingestor/handler.py`, then run `npm run validate:plugins`
4. Set `"pluginStatus": {"your_source_id": true}` in `voc-datalake/cdk.context.json`
5. Add the plugin's translated name and description (`pluginCopy.*` in all nine
   `frontend/public/locales/*/settings.json`, and `PLUGIN_COPY_KEYS` in
   `frontend/src/plugins/pluginCopy.ts`) and its Lambda memory in `lib/sizing/policy.ts`
6. Run `npm run generate:config`, then deploy with `npm run deploy:infra` and `npm run deploy:frontend`

## Folder Structure

```
plugins/your_source/
├── manifest.json      # Plugin configuration (required)
├── ingestor/          # Polling Lambda (optional)
│   └── handler.py
├── webhook/           # Webhook Lambda (optional)
│   └── handler.py
└── README.md          # Documentation (optional)
```

## Manifest Fields

| Field | Required | Description |
|-------|----------|-------------|
| `id` | Yes | Unique identifier (lowercase, underscores) |
| `name` | Yes | Display name in UI |
| `icon` | Yes | Icon word mapped to a lucide icon (`Web`, `iOS`, `Android`, `GitHub`, `Package`, `Synthetic`, `Plugin`); never an emoji |
| `description` | No | Short description |
| `category` | No | One of: reviews, social, import, search, scraper |
| `infrastructure` | Yes | AWS resources to deploy |
| `config` | Yes | Configuration fields for UI |
| `webhooks` | No | Webhook endpoints to display |
| `setup` | No | Setup instructions |
| `secrets` | No | Secret keys template |
| `capabilities` | No | What the platform does differently for this source (below) |
| `version` | No | Semver version |

## Infrastructure Options

### Ingestor (Polling)

```json
"ingestor": {
  "enabled": true,
  "schedule": "rate(15 minutes)",
  "timeout": 120,
  "memory": 256
}
```

### Webhook

```json
"webhook": {
  "enabled": true,
  "path": "/webhooks/your_source",
  "methods": ["POST"],
  "signatureHeader": "X-Signature",
  "signatureMethod": "hmac_sha256"
}
```

### S3 Trigger

```json
"s3Trigger": {
  "enabled": true,
  "suffixes": [".csv", ".json"]
}
```

## Capabilities

The platform never branches on a plugin id: a source that needs different handling declares it.
Every flag defaults to off, and a misspelt `capabilities` key fails `npm run validate:plugins`.

| Where | Flag | Effect |
|-------|------|--------|
| `capabilities` | `updatesItems` | The source re-sends an item when it changes; the processor refreshes the stored item in place (records must carry `issue_attributes`) instead of skipping it as a duplicate |
| `infrastructure.ingestor` | `selfInvoke` | A run that reaches its time budget continues in a new invocation of its own function (an invoke grant on exactly that function) |
| `infrastructure.ingestor` | `bedrock` / `browser` | A dedicated role with a Claude-only Bedrock grant / the AgentCore managed browser |
| `infrastructure.webhook` | `memory` | The webhook receiver's MemorySize (128–1024, default 256) |

## Message Format

Your `fetch_new_items()` should yield items with these fields:

```python
{
    "id": "unique_id",           # Required
    "text": "Feedback content",  # Required
    "created_at": "ISO8601",     # Required
    "rating": 4.5,               # Optional (1-5)
    "url": "https://...",        # Optional
    "channel": "review",         # Optional
    "author": "Name",            # Optional
    "title": "Title",            # Optional
}
```

`url` must be an `http://` or `https://` link. The processing queue's schema
(`lambda/shared/ingest_schemas.py`) trims surrounding whitespace, but refuses a
link that still contains a control character (CR, LF, tab, NUL, DEL, C1 such as
NEL), an invisible format character (zero-width space, bidi override) or a Unicode
line/paragraph separator, and so
dead-letters the whole item: emit clean links rather than relying on cleanup.
Percent-encoded characters such as `%0A` are fine. The processor reads `url`
(stored as the item's `source_url`), so put the review's link there.

## Testing Locally

```bash
cd plugins/your_source/ingestor
python -c "from handler import YourSourceIngestor; i = YourSourceIngestor(); print(list(i.fetch_new_items()))"
```

## Security Notes

- Never hardcode secrets in your code
- Use `self.secrets.get("key")` to access credentials
- Secrets are stored in AWS Secrets Manager
- Each plugin has isolated access to its own secrets
