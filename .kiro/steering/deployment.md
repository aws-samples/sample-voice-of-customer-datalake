# Deployment Guide

## Prerequisites

- AWS CLI configured with credentials
- Node.js 18+ and npm
- Python 3.12+ (for Lambda functions)
- Docker (for building Lambda layers)
- AWS CDK CLI (`npm install -g aws-cdk`)

## How `deploy:all` Works

`npm run deploy:all` is the standard deployment command. It runs three steps in sequence:

1. `npm run check` — lint + typecheck (frontend, CDK, stream) + frontend tests + backend tests
2. `npm run deploy:infra` — deploys all CDK stacks (auto-ordered by dependencies)
3. `npm run deploy:frontend` — builds frontend, syncs to S3, invalidates CloudFront

Since `deploy:all` already includes quality checks, you do NOT need to run `npm run check` separately before it.

## Deployment Steps

### Full Deployment (the standard flow)

```bash
# 1. Install dependencies (first time or after changes)
npm run install:all

# 2. Build Lambda layers (first time or after dependency changes)
npm run build:layers

# 3. Validate i18n translations (REQUIRED before any frontend deploy)
cd voc-datalake/frontend && npm run i18n:validate && cd ../..

# 4. Deploy everything (runs check → infra → frontend)
npm run deploy:all
```

The i18n validation step is not included in `deploy:all`, so it must be run manually before deploying. It extracts translation keys from source code and verifies all locales (en, de, es, fr) have complete translations. Fix any missing keys before proceeding.

### Infrastructure Only (no frontend changes)

```bash
npm run deploy:infra
```

No i18n validation needed. No quality checks are run automatically — run `npm run check` first if desired.

### Frontend Only

```bash
cd voc-datalake/frontend && npm run i18n:validate && cd ../..
npm run deploy:frontend
```

### Preview Changes Before Deploying

```bash
npm run cdk:diff
```

## First-Time Setup

### CDK Bootstrap

```bash
npm run cdk:bootstrap
```

### Anthropic Model Access

Add to `voc-datalake/cdk.context.json`:

```json
{
  "anthropicUseCase": {
    "companyName": "Your Company Name",
    "companyWebsite": "https://your-company.com",
    "intendedUsers": "Internal teams for customer feedback analysis",
    "industryOption": "Technology",
    "useCases": "Analyzing customer feedback to identify product improvement opportunities."
  }
}
```

Then run `npm run deploy:infra`.

## CDK Stacks

| Stack | Description | Dependencies |
|-------|-------------|--------------|
| `VocCoreStack` | DynamoDB, KMS, S3, Cognito, CloudFront | None |
| `VocBedrockAccessStack` | Bedrock model access | None |
| `VocIngestionStack` | Plugin Lambdas, EventBridge, SQS, Secrets | Core |
| `VocProcessingStackConsolidated` | Processor, Aggregator, Step Functions, Bedrock | Core, Ingestion |
| `VocApiStack` | API Gateway, API Lambdas, WAF | Core, Ingestion, Processing |

`cdk deploy --all` handles dependency ordering automatically.

## Configuration Changes

After changing `pluginStatus` or `menuStatus` in `cdk.context.json`:

```bash
npm run generate:config
cd voc-datalake/frontend && npm run i18n:validate && cd ../..
npm run deploy:all
```

## CI/CD Example

```yaml
name: Deploy
on:
  push:
    branches: [main]

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
      - name: Install dependencies
        run: npm run install:all
      - name: Validate i18n translations
        run: cd voc-datalake/frontend && npm run i18n:validate
      - name: Deploy all (check + infra + frontend)
        run: npm run deploy:all
        env:
          AWS_ACCESS_KEY_ID: ${{ secrets.AWS_ACCESS_KEY_ID }}
          AWS_SECRET_ACCESS_KEY: ${{ secrets.AWS_SECRET_ACCESS_KEY }}
          AWS_REGION: us-east-1
```

## Troubleshooting

| Issue | Solution |
|-------|----------|
| First deploy to new account/region | `npm run cdk:bootstrap` |
| Stack stuck in UPDATE_ROLLBACK | `aws cloudformation continue-update-rollback --stack-name STACK_NAME` |
| Frontend changes not visible | `aws cloudfront create-invalidation --distribution-id ID --paths '/*'` |
| View stack outputs | `aws cloudformation describe-stacks --stack-name VocApiStack --query 'Stacks[0].Outputs'` |

## Quick Reference

| Command | What it does |
|---------|-------------|
| `npm run deploy:all` | check → deploy infra → deploy frontend |
| `npm run deploy:infra` | Deploy CDK stacks only |
| `npm run deploy:frontend` | Build + S3 sync + CloudFront invalidation |
| `npm run check` | lint + typecheck:all + test + test:backend |
| `npm run i18n:validate` | Extract + validate translation keys (run from `voc-datalake/frontend`) |
| `npm run generate:config` | Regenerate plugin manifests + menu config |
| `npm run cdk:diff` | Preview infrastructure changes |
| `npm run destroy` | Destroy all stacks |
