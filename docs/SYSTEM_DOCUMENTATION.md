# VoC Data Lake - System Documentation

This file is an index of the maintained technical documentation. Keeping a second, concatenated copy of every guide caused deployment and security instructions to drift; update the canonical topic file instead.

## Core Guides

| Document | Scope |
|----------|-------|
| [Deployment](deployment.md) | Prerequisites, stacks, configuration, deployment, and troubleshooting |
| [Project Workspace](project-workspace.md) | Managed artifact versions, prioritization, room voting, and MCP access |
| [Data Lake Structure](data-lake-structure.md) | S3 layout, DynamoDB tables/indexes, retention, and Data Explorer |
| [Processing Pipeline](processing-pipeline.md) | Ingestion, enrichment, storage, aggregation, and aggregate repair |
| [Plugin Architecture](plugin-architecture.md) | Plugin manifests, infrastructure, secret isolation, and route boundaries |
| [Getting Started with Plugins](getting-started-plugins.md) | Build and validate a new source plugin |
| [Feedback Forms](feedback-forms.md) | Form configuration, public routes, throttling, embedding, and CORS |
| [Scrapers](scrapers.md) | Web-scraper configuration and execution |
| [Mobile App Reviews](mobile-app-reviews.md) | iOS and Android review plugins |

## Feedback Form Embed Contract

The canonical embed instructions live in [Feedback Forms](feedback-forms.md). The copy-pasteable route is repeated here because the infrastructure test verifies both public documentation entry points against the unauthenticated API methods:

```html
<iframe
  src="https://your-api.execute-api.region.amazonaws.com/v1/feedback-forms/{form_id}/iframe"
  width="100%"
  height="500"
  frameborder="0">
</iframe>
```

## Release Information

- [README](../README.md) — product overview and quick start
- [Changelog](../CHANGELOG.md) — release notes and upgrade guidance

The code and synthesized infrastructure remain the source of truth. Documentation that states a route, permission, limit, or generated artifact should be kept lockstep-tested where practical.
