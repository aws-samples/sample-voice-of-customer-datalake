# Plugin Template

This is a template for creating new VoC data source plugins.

## Quick Start

1. Copy this folder to `plugins/{your_source_id}/`
2. Update `manifest.json` with your source details
3. Implement `fetch_new_items()` in `ingestor/handler.py`
4. Add your source ID to `enabledSources` in `cdk.context.json`
5. Deploy with `cdk deploy`

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
| `icon` | Yes | Emoji or SVG filename |
| `description` | No | Short description |
| `category` | No | One of: reviews, social, import, search, scraper |
| `infrastructure` | Yes | AWS resources to deploy |
| `config` | Yes | Configuration fields for UI |
| `webhooks` | No | Webhook endpoints to display |
| `setup` | No | Setup instructions |
| `secrets` | No | Secret keys template |
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
