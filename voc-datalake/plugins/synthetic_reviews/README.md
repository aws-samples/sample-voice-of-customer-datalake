# Synthetic Data Review Generator

Generates realistic **synthetic** customer reviews with Amazon Bedrock (Claude Sonnet) and
ingests them through the normal VoC processing pipeline, tagged as synthetic data.

Use it to seed demos, test dashboards/alerts, or model how feedback flows through the platform
without needing real customer data.

## What it does

1. You provide context about your company, product, target customer, the focus areas to cover,
   how many reviews to generate, the sentiment mix, and the language.
2. On **Generate**, the plugin Lambda calls Bedrock to produce that many distinct reviews
   (in batches), then sends each through the standard pipeline (S3 raw → SQS → processor).
3. The processor enriches them exactly like real feedback (sentiment, category, persona), so they
   appear in the dashboard — but clearly marked as synthetic.

## How items are tagged as synthetic

- `source_platform = "synthetic_reviews"` — a distinct, filterable source.
- `metadata.is_synthetic = true` plus `generator`, `generator_model`, and `focus_area`.

You can filter synthetic data in/out anywhere the source is selectable.

## Configuration

| Field | Required | Notes |
|-------|----------|-------|
| Company / Brand Name | yes | Makes generated reviews sound realistic |
| Product / Service Name | yes | |
| Product Description | no | Improves relevance |
| Target Customer / Persona | no | Shapes voice and concerns |
| Focus Areas | no | Comma-separated topics (e.g. `delivery, pricing, support`) |
| Number of Reviews | no | 1–50 per run (default 10) |
| Sentiment Mix | no | balanced / mostly positive / mostly negative / polarized |
| Review Language | no | en, de, es, fr |

Configuration is stored per-plugin in AWS Secrets Manager (isolated by the `synthetic_reviews_` prefix).

## How it runs

On-demand only — there is **no schedule**. Trigger it from the dashboard
("Synthetic Data" card in the Add Data Source modal) or via `POST /sources/synthetic_reviews/run`,
which async-invokes the ingestor Lambda.

## Bedrock access (least privilege)

This plugin declares `infrastructure.ingestor.bedrock: true` in its manifest. The platform grants
a **dedicated** IAM role with a scoped `bedrock:InvokeModel` permission (Claude Sonnet only) to
*this* Lambda — the shared plugin role is left unchanged, so no other plugin gains Bedrock access.

## Enable / disable

Set `pluginStatus.synthetic_reviews` in `cdk.context.json`, run `npm run generate:config`, and deploy.
