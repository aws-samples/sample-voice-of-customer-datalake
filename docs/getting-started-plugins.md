# Getting Started with Data Source Plugins

This tutorial builds a polling data source plugin from the template, tests it locally and deploys
it. It is for developers who want to connect a new feedback source to the platform. The example
plugin, `my_reviews`, reads reviews from a fictional REST API every 30 minutes. For the full
manifest schema, the base classes, secrets, runtime controls and observability, see
[Plugin Architecture](plugin-architecture.md).

## Before you start

- A clone of the repository with dependencies installed (`npm install` in the root,
  `voc-datalake/` and `voc-datalake/frontend/`) and the Python virtual environment at
  `voc-datalake/.venv` ([deployment.md](deployment.md)).
- To deploy: AWS credentials for the target account and a deployment of the platform.

Run every command below from the repository root unless a step says otherwise.

## Step 1: Copy the template

```bash
cp -r voc-datalake/plugins/_template voc-datalake/plugins/my_reviews
rm voc-datalake/plugins/my_reviews/README.md
```

The folder name is the plugin id. It must start with a lowercase letter, use only lowercase
letters, digits and underscores, be at most 32 characters, and not be a prefix of another plugin's
id followed by `_`. Keep it short: the schedule rule name
`voc-ingest-<id>-schedule-<account>-<region>` must fit in 64 characters.

The new folder contains:

```
voc-datalake/plugins/my_reviews/
├── manifest.json
└── ingestor/
    └── handler.py
```

## Step 2: Edit the manifest

Replace `manifest.json` in the new `my_reviews` folder:

```json
{
  "id": "my_reviews",
  "name": "My Reviews",
  "icon": "Plugin",
  "description": "Reviews from the My Reviews API",
  "category": "reviews",
  "version": "1.0.0",

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
    { "key": "product_id", "label": "Product ID", "type": "text", "required": true, "placeholder": "example-air-app" }
  ],

  "setup": {
    "title": "My Reviews Setup",
    "color": "blue",
    "steps": [
      "Open the My Reviews developer portal",
      "Create a read-only API key",
      "Paste the key and your product ID above, then save"
    ]
  },

  "secrets": {
    "api_key": "",
    "product_id": ""
  }
}
```

Points to check:

- `id` equals the folder name.
- `config` describes the form on the plugin's settings card. A `secret: true` field is write-only
  once saved.
- `secrets` lists the keys your code reads, by their **bare** names. CDK stores them in the shared
  Secrets Manager secret as `my_reviews_api_key` and `my_reviews_product_id`, and the base class
  strips the prefix again. Declare at least one key: a plugin with no key under its prefix refuses
  to start, and `test_plugin_secret_isolation.py` fails on a manifest without `secrets`.
- The schedule is created disabled. An administrator turns it on after saving credentials.

Validate the manifest:

```bash
npm run validate:plugins
```

The output lists `My Reviews (my_reviews) - ingestor`. A schema error names the field.

## Step 3: Implement the ingestor

Replace `ingestor/handler.py` in the `my_reviews` folder:

```python
"""My Reviews ingestor: polls the My Reviews API for new reviews."""

import os
import sys
from collections.abc import Generator

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import requests

from _shared.base_ingestor import BaseIngestor, logger, metrics, tracer
from shared.invocation_cost import measure_invocation_cost

API_URL = "https://api.example.com/v1/reviews"
REQUEST_TIMEOUT_SECONDS = 30


class MyReviewsIngestor(BaseIngestor):
    """Ingestor for the My Reviews API."""

    def __init__(self, execution_id: str | None = None):
        super().__init__(execution_id=execution_id)
        self.api_key = self.secrets.get("api_key", "")
        self.product_id = self.secrets.get("product_id", "")

    def fetch_new_items(self) -> Generator[dict, None, None]:
        if not self.api_key or not self.product_id:
            logger.warning("My Reviews is not configured")
            return

        since_id = self.get_watermark("last_id")
        params = {"product": self.product_id, "order": "oldest_first"}
        if since_id:
            params["since_id"] = since_id

        response = requests.get(
            API_URL,
            headers={"Authorization": f"Bearer {self.api_key}"},
            params=params,
            timeout=REQUEST_TIMEOUT_SECONDS,
        )
        response.raise_for_status()

        for review in response.json().get("reviews", []):
            yield {
                "id": str(review["id"]),
                "text": review["body"],
                "created_at": review["created_at"],
                "rating": review.get("stars"),
                "url": review.get("permalink"),
                "channel": "review",
                "author": review.get("author"),
                "title": review.get("title"),
            }


@logger.inject_lambda_context
@tracer.capture_lambda_handler
@metrics.log_metrics(capture_cold_start_metric=True)
@measure_invocation_cost
def lambda_handler(event, context):
    """Lambda entry point."""
    execution_id = event.get("execution_id") if isinstance(event, dict) else None
    ingestor = MyReviewsIngestor(execution_id=execution_id)
    return ingestor.run()
```

What the base class does for you when `run()` is called:

- skips the run while the plugin's circuit breaker is open;
- archives each item to `raw/my_reviews/<yyyy>/<mm>/<dd>/<id>.json` in the raw data bucket,
  applies the source's PII policy and sends the items to the processing queue in batches of 100;
- after the loop, saves the id of the **last** yielded item as the `last_id` watermark. That is
  why the example asks the API for the oldest reviews first;
- on a manual **Run now**, records the run's progress so the settings card can show it.

Pass `execution_id` into the constructor, as above. On a manual run the constructor clears the
cached secret before reading it, so credentials saved a moment earlier are used.
`plugins/test_manual_run_guard.py` fails if a handler assigns `execution_id` after construction.

`requests` is in the ingestion layer. A new third-party library has to be added to
`voc-datalake/lambda/layers/ingestion-deps/requirements.txt`, which every ingestor shares.

### Item fields

| Field | Required | Notes |
|-------|----------|-------|
| `id` | Yes | Stable id from the source, at most 256 characters. The processor de-duplicates on source and id |
| `text` | Yes | The feedback, at most 50,000 characters. An item without text is dropped |
| `created_at` | Recommended | ISO 8601. Missing or unparseable values become the ingestion time |
| `rating` | No | Number from 1 to 10 |
| `url` | No | `http://` or `https://` link to the original feedback, with no control characters |
| `channel` | No | Sub-channel such as `review`, `comment` or `mention` |
| `author` | No | Display name, cut at 256 characters |
| `title` | No | Title, cut at 500 characters |

The complete list, including dimensions and tags, is in
[Plugin Architecture → Item fields](plugin-architecture.md#item-fields).

## Step 4: Test it locally

Plugin tests are pytest files inside the plugin folder. `voc-datalake/plugins/conftest.py` puts
`plugins/` and `lambda/` on the path, sets fake environment variables and fails any test that
reaches real AWS, so tests patch the AWS accessors. Create a `test` folder inside `my_reviews`
with this file, `test_my_reviews.py`:

```python
"""Unit tests for the My Reviews ingestor (no AWS, no network)."""

from unittest.mock import MagicMock, patch

from _shared.test.scoped_secret import scoped_secret
from my_reviews.ingestor.handler import MyReviewsIngestor


def build_ingestor(**secrets):
    """An ingestor whose AWS clients are mocks and whose secret holds *secrets*."""
    with (
        patch("_shared.base_ingestor.get_dynamodb_resource"),
        patch("_shared.base_ingestor.get_s3_client"),
        patch("_shared.base_ingestor.get_sqs_client"),
        patch("_shared.base_ingestor.get_secret", return_value=scoped_secret(**secrets)),
    ):
        return MyReviewsIngestor()


def test_maps_one_review():
    ingestor = build_ingestor(api_key="k", product_id="example-air-app")
    response = MagicMock()
    response.json.return_value = {"reviews": [{
        "id": 7, "body": "Check-in was quick.", "created_at": "2026-01-08T10:30:00Z",
        "stars": 5, "permalink": "https://www.example-air.com/reviews/7",
    }]}
    with (
        patch.object(ingestor, "get_watermark", return_value=None),
        patch("my_reviews.ingestor.handler.requests.get", return_value=response),
    ):
        items = list(ingestor.fetch_new_items())

    assert items[0]["id"] == "7"
    assert items[0]["text"] == "Check-in was quick."
    assert items[0]["rating"] == 5


def test_unconfigured_plugin_fetches_nothing():
    ingestor = build_ingestor()
    with patch("my_reviews.ingestor.handler.requests.get") as get:
        assert list(ingestor.fetch_new_items()) == []
    get.assert_not_called()
```

`scoped_secret()` builds a secret payload under the prefix the base class expects in tests. Run
the tests and the linter:

```bash
cd voc-datalake
.venv/bin/python -m pytest plugins/my_reviews -q --no-cov
.venv/bin/python -m ruff check plugins/my_reviews
```

The `test/` folder is removed from the deployed bundle.

## Step 5: Register the plugin in the app

A new plugin touches three files outside its folder. The frontend and CDK test suites fail until
they are in place.

1. **Enable it** in `voc-datalake/cdk.context.json`:

   ```json
   {
     "pluginStatus": {
       "my_reviews": true
     }
   }
   ```

   Keep the existing entries. A plugin missing from `pluginStatus`, or set to `false`, gets no AWS
   resources and no settings card.

2. **Translate its name and description.** The settings card reads them from the locale files.
   Add `pluginCopy.myReviews.name` and `pluginCopy.myReviews.description` to
   `voc-datalake/frontend/public/locales/<lang>/settings.json` for all nine locales (`de`, `en`,
   `es`, `fr`, `ja`, `ko`, `pl`, `pt`, `zh`), and add the id to `PLUGIN_COPY_KEYS` in
   `voc-datalake/frontend/src/plugins/pluginCopy.ts`:

   ```ts
   my_reviews: { nameKey: 'settings:pluginCopy.myReviews.name', descriptionKey: 'settings:pluginCopy.myReviews.description' },
   ```

3. **Size its Lambda.** `voc-datalake/lib/lambda-memory.test.ts` pins the memory of every
   function the app synthesizes. Add `'voc-ingestor-my_reviews': 256` (the manifest's `memory`) to
   the `UNCHANGED` table in `voc-datalake/lib/sizing/policy.ts`, next to the other ingestors
   ([lambda-sizing.md](lambda-sizing.md)).

Then regenerate the frontend's copy of the manifests:

```bash
npm run generate:config
```

This rewrites `voc-datalake/frontend/src/plugins/manifests.json` and the menu config. The
frontend build runs it too.

## Step 6: Deploy

```bash
npm run deploy:infra
```

`deploy:infra` deploys every stack and then refreshes the API stage. To deploy only the ingestion
stack, run `cd voc-datalake && npx cdk deploy VocIngestionStack`, then deploy the frontend with
`npm run deploy:frontend` so the settings card appears.

The deploy creates the `voc-ingestor-my_reviews` Lambda, its log group, the disabled
`voc-ingest-my_reviews-schedule` rule and the two secret keys. Each name ends with the account and
region, and starts with the deployment prefix when you use one.

## Step 7: Configure and run it

1. Sign in as an administrator and open **Administration → Sources → Source settings**.
2. Open the **My Reviews** card, enter the API key and product ID, and save.
3. Click **Run now**. The card shows the run until it completes or fails.
4. Check the results: the new reviews appear on the Dashboard after processing, and the raw copies
   in **Data Explorer**, in the `my_reviews` folder of the `raw` prefix. The Lambda log group is
   `/aws/lambda/voc-ingestor-my_reviews-<account>-<region>`.
5. Turn the schedule on with the card's toggle.

If a run fails, the card shows the exception type and the log group has the details. After 5
failures within 15 minutes the circuit breaker pauses the plugin and disables its schedule; turn
the source back on, or use **Reset**, once the cause is fixed
([Plugin Architecture → Circuit breaker](plugin-architecture.md#circuit-breaker)).

## Other plugin shapes

The same manifest can declare other infrastructure. Each is described in
[Plugin Architecture → The manifest](plugin-architecture.md#the-manifest).

- **Webhook:** `infrastructure.webhook` creates `POST /webhooks/<id>` and a Lambda from
  `webhook/handler.py`. The route has no authorizer, so your handler must verify the provider's
  signature before it parses anything. Copy the pattern from `plugins/github_issues/webhook/`.
- **S3 trigger:** `infrastructure.s3Trigger` runs your ingestor when a file with one of the listed
  suffixes is uploaded to the S3 import bucket, as `s3_import` does.
- **Bedrock:** `"bedrock": true` on the ingestor allows model calls through `shared/converse.py`,
  as `synthetic_reviews` does.
- **Managed browser:** `"browser": true` allows sessions of the AgentCore browser for pages only a
  real browser can load, as `web_reviews` does ([web-reviews.md](web-reviews.md)).

## Security checklist

- Never put credentials in code. Read them from `self.secrets`.
- Declare every key your code reads in `secrets`, by its bare name.
- Set a timeout on every outbound request.
- For a webhook, verify the signature with a constant-time compare before parsing the body.
- Review a third-party plugin's code before you enable it: every ingestor role can read the whole
  shared secret, and the `<id>_` namespace only protects against mistakes
  ([Plugin Architecture → Secrets](plugin-architecture.md#secrets)).
