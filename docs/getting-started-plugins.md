# Getting Started with Data Source Plugins

This guide explains how to create, configure, and deploy data source plugins for the VoC (Voice of Customer) platform.

> 📖 For in-depth technical details about the plugin system, including security hardening, infrastructure isolation, and observability, see the [Plugin Architecture](plugin-architecture.md) document.

## Overview

The VoC platform uses a plugin architecture for data source connectors. Each plugin is a self-contained folder that defines:

- **What data to collect** (API endpoints, webhooks, file imports)
- **How to display it** (UI configuration, setup instructions)
- **What infrastructure to deploy** (Lambda functions, EventBridge schedules)

## Plugin Structure

```
plugins/your_source/
├── manifest.json      # Plugin configuration (required)
├── ingestor/          # Polling Lambda (optional)
│   └── handler.py
├── webhook/           # Webhook Lambda (optional)
│   └── handler.py
└── README.md          # Documentation (optional)
```

## Creating a New Plugin

### Step 1: Copy the Template

```bash
cp -r plugins/_template plugins/your_source_id
```

Use lowercase with underscores for the folder name (e.g., `my_reviews`, `custom_source`).

### Step 2: Configure the Manifest

Edit `manifest.json` with your source details:

```json
{
  "id": "your_source_id",
  "name": "Your Source Name",
  "icon": "🔌",
  "description": "Brief description of what this plugin does",
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
    "title": "Setup Instructions",
    "color": "blue",
    "steps": [
      "Step 1: Go to the developer portal",
      "Step 2: Create an API key",
      "Step 3: Paste the key above"
    ]
  },

  "secrets": {
    "your_source_id_api_key": ""
  }
}
```

### Step 3: Implement the Ingestor

Edit `ingestor/handler.py` to fetch data from your source:

```python
from typing import Generator
from _shared.base_ingestor import BaseIngestor, logger

class YourSourceIngestor(BaseIngestor):
    def __init__(self):
        super().__init__()
        self.api_key = self.secrets.get("api_key", "")

    def fetch_new_items(self) -> Generator[dict, None, None]:
        if not self.api_key:
            logger.warning("No API key configured")
            return

        # Get watermark for incremental fetching
        last_id = self.get_watermark("last_id")
        
        # Fetch from your API
        response = requests.get(
            "https://api.yoursource.com/reviews",
            headers={"Authorization": f"Bearer {self.api_key}"},
            params={"since_id": last_id} if last_id else {}
        )
        
        for item in response.json().get("reviews", []):
            yield {
                "id": item["id"],
                "text": item["content"],
                "rating": item.get("score"),
                "created_at": item["created_at"],
                "url": item.get("url"),
                "channel": "review",
                "author": item.get("author_name"),
            }

@logger.inject_lambda_context
def lambda_handler(event, context):
    ingestor = YourSourceIngestor()
    return ingestor.run()
```

### Step 4: Enable the Plugin

Add your plugin to `cdk.context.json`:

```json
{
  "pluginStatus": {
    "your_source_id": true
  }
}
```

### Step 5: Deploy

```bash
npm run generate:manifests
cdk deploy
```

## Message Format

Your `fetch_new_items()` method must yield items with this structure:

| Field | Required | Type | Description |
|-------|----------|------|-------------|
| `id` | Yes | string | Unique identifier from the source |
| `text` | Yes | string | The feedback content |
| `created_at` | Yes | string | ISO 8601 timestamp |
| `rating` | No | float | Rating value (1-5 scale) |
| `url` | No | string | Link to the original feedback |
| `channel` | No | string | Type: review, comment, mention |
| `author` | No | string | Author name |
| `title` | No | string | Review title |

## Infrastructure Options

### Polling Ingestor

Runs on a schedule to fetch new data:

```json
"ingestor": {
  "enabled": true,
  "schedule": "rate(15 minutes)",
  "timeout": 120,
  "memory": 256
}
```

### Webhook Handler

Receives real-time events from external services:

```json
"webhook": {
  "enabled": true,
  "path": "/webhooks/your_source",
  "methods": ["POST"]
}
```

### S3 Trigger

Processes files uploaded to S3:

```json
"s3Trigger": {
  "enabled": true,
  "suffixes": [".csv", ".json", ".jsonl"]
}
```

## Using Watermarks

Watermarks track your progress to avoid re-fetching old data:

```python
# Get the last processed ID
last_id = self.get_watermark("last_id")

# After processing, save the new watermark
self.set_watermark("last_id", newest_id)
```

## Accessing Secrets

Secrets are stored in AWS Secrets Manager and automatically loaded:

```python
# In your ingestor
self.api_key = self.secrets.get("api_key", "")
self.api_secret = self.secrets.get("api_secret", "")
```

Secret keys in the manifest are prefixed with your plugin ID automatically.

## Categories

Available categories for your plugin:

- `reviews` - Product/service reviews
- `social` - Social media mentions
- `import` - File imports (S3, CSV, JSON)
- `search` - Web search results
- `scraper` - Web scraping sources

## Testing Locally

```bash
cd plugins/your_source/ingestor
python -c "
from handler import YourSourceIngestor
i = YourSourceIngestor()
for item in i.fetch_new_items():
    print(item)
"
```

## Security Notes

- Never hardcode secrets in your code
- Use `self.secrets.get("key")` to access credentials
- Each plugin has isolated access to its own secrets
- All data is validated before processing (see Message Validation)

For detailed security information including webhook signature verification, code integrity checks, and circuit breakers, see [Plugin Architecture - Security Hardening](plugin-architecture.md#security-hardening).
