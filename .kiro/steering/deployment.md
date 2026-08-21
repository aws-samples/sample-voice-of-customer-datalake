# Deployment Guide

This guide covers how to deploy the VoC (Voice of Customer) platform, including infrastructure (CDK stacks) and the frontend application.

## Prerequisites

- **AWS CLI** configured with appropriate credentials
- **Node.js** 18+ and npm
- **Python** 3.12+ (for Lambda functions)
- **AWS CDK** CLI installed (`npm install -g aws-cdk`)

## Project Structure

```
voice-of-customer-datalake/
├── package.json              # Root scripts (shortcuts)
├── voc-datalake/
│   ├── package.json          # CDK infrastructure
│   ├── bin/voc-datalake.ts   # CDK app entry point
│   ├── lib/stacks/           # CDK stack definitions
│   ├── plugins/              # Data source plugins
│   └── frontend/
│       ├── package.json      # React frontend
│       └── scripts/deploy.sh # Frontend deployment script
```

## Quick Start

From the project root:

```bash
# Install dependencies
npm install
cd voc-datalake && npm install
cd frontend && npm install

# Run quality checks
npm run check        # Runs lint, typecheck, and tests

# Deploy everything
npm run deploy:all   # Deploys all CDK stacks + frontend
```

## Quality Checks

Always run quality checks before deploying:

```bash
# From project root ONLY — voc-datalake/package.json has no `lint` script
npm run lint         # frontend + stream ESLint, and ruff over lambda/ + plugins/
npm run typecheck    # frontend ONLY (use typecheck:all for frontend + CDK + stream)
npm run test         # frontend ONLY

npm run check        # lint · typecheck:all · test · test:cdk · test:stream · test:backend (every leg runs)
```

### What Each Check Does

| Command | Covers |
|---------|--------|
| `npm run lint` | `lint:frontend` + `lint:stream` (ESLint) + `lint:python` (ruff over `lambda/`, `plugins/`) |
| `npm run typecheck` | Frontend only |
| `npm run typecheck:all` | Frontend + CDK (`typecheck:cdk`) + stream |
| `npm run test` | Frontend Vitest |
| `npm run test:cdk` / `test:stream` / `test:backend` | CDK Vitest / stream Vitest / pytest via `.venv/bin/python` |
| `npm run check` | All of the above — every leg runs, failures listed together |

**One trap when using `check` as a gate, and one thing it now does for you:**

- ✅ **Every leg runs, so one failure no longer hides the rest.** `check` reports
  each leg as it finishes and ends with `Failed legs: …` on stderr, exiting with
  the first failing leg's own status. You no longer have to re-run the individual
  scripts to find out what else is broken. (It used to be an `&&` chain that
  stopped at the first failure.)
- **There is no ESLint leg for the CDK TypeScript.** `bin/` and `lib/` are covered
  only by `typecheck:cdk` — "lint is clean" says nothing about the CDK app.

## CDK Stacks

The platform consists of 4 core stacks plus 1 AI-enablement stack.

> ### ⚠️ The stack count is capped at 5 — adding a stack is not a free action
>
> A downstream packaging consumer of this repo accepts at most **five**
> CloudFormation templates, and the app is at exactly five. A sixth breaks
> packaging, and the failure appears only there — never at `cdk synth`. Fold new
> infrastructure into an existing stack, or drop one first.
>
> This is why the web-search gateway and Bedrock model access share
> `VocWebSearchStack`. Nested stacks are not an escape hatch: `NestedStackProps`
> has no `env`, so a nested stack inherits the parent region, and that stack must
> be pinned to us-east-1.

| Stack | Description | Dependencies |
|-------|-------------|--------------|
| `VocCoreStack` | DynamoDB tables, KMS, S3 buckets, Cognito, CloudFront | None |
| `VocIngestionStack` | Plugin Lambdas, EventBridge schedules, SQS, Secrets | Core |
| `VocProcessingStack` | Processor, Aggregator, Step Functions, Bedrock | Core, Ingestion |
| `VocApiStack` | API Gateway, API Lambdas, Webhooks, WAF | Core, Ingestion, Processing |
| `VocWebSearchStack` (AI enablement, always us-east-1) | Two independently switchable halves: AgentCore web-search gateway (default-on, `-c enableWebSearch=false` opts out) + Bedrock model access / Anthropic use case (only when `anthropicUseCase` is set). Not created when both are off | None |

### Deploy All Stacks

```bash
npm run deploy:infra    # Deploy all CDK stacks
```

### Deploy Individual Stacks

```bash
cd voc-datalake

# Deploy specific stack
cdk deploy VocCoreStack
cdk deploy VocIngestionStack
cdk deploy VocApiStack

# Deploy multiple stacks
cdk deploy VocCoreStack VocIngestionStack

# Deploy with auto-approve (no confirmation prompts)
cdk deploy --all --require-approval never
```

### Stack Deployment Order

Due to dependencies, stacks should be deployed in this order:

1. `VocWebSearchStack` (no dependencies, but must precede Processing/Api, which
   import its gateway exports when web search is enabled)
2. `VocCoreStack`
3. `VocIngestionStack`
4. `VocProcessingStack`
5. `VocApiStack`

The `cdk deploy --all` command handles this automatically.

## Frontend Deployment

### Option 1: Direct Deployment (Recommended)

For frontend changes, use the direct deployment script:

```bash
npm run deploy:frontend
```

This script:
1. Fetches environment config from CloudFormation
2. Builds the frontend (`npm run build`)
3. Syncs to S3
4. Invalidates CloudFront cache

### Option 2: Via CDK

Deploy all stacks including frontend infrastructure:

```bash
cd voc-datalake
cdk deploy --all
```

### Frontend Build Process

```bash
cd voc-datalake/frontend

# Generate plugin manifests and menu config
npm run prebuild

# Build for production
npm run build

# Output in dist/ folder
```

## Configuration

### Plugin Status

Enable/disable plugins in `voc-datalake/cdk.context.json`:

```json
{
  "pluginStatus": {
    "webscraper": true
  }
}
```

### Menu Configuration

Enable/disable menu items in `voc-datalake/cdk.context.json`:

```json
{
  "menuStatus": {
    "dashboard": true,
    "feedback": true,
    "scrapers": false
  }
}
```

After changing configuration:

```bash
npm run generate:config   # Regenerate manifests and menu
npm run deploy:frontend   # Deploy updated frontend
```

## Environment Variables

The frontend fetches configuration from CloudFormation outputs:

- `VITE_API_ENDPOINT` - API Gateway URL
- `VITE_COGNITO_USER_POOL_ID` - Cognito User Pool ID
- `VITE_COGNITO_CLIENT_ID` - Cognito Client ID
- `VITE_COGNITO_REGION` - AWS Region
- `VITE_IDENTITY_POOL_ID` - Cognito Identity Pool ID

> These names must match `frontend/src/runtimeConfig.ts` exactly. All five are
> **required**: `RuntimeConfigSchema` rejects an empty `identityPoolId`, and the
> fallback then blanks every Cognito value — the login screen shows
> "Cognito not configured" even when the user pool and client id resolved fine.

**Local dev cannot use the deployed API.** `ALLOWED_ORIGIN` on the deployed API
Lambdas is `https://<frontendDomain>` (`allowedOrigin = isDev ? '*' : ...` in
api-stack.ts), so a dev server on `localhost:5173` is refused by CORS. For local
work run `npm run mock` (localhost:3001) and accept that it exercises the UI
only; real UI-plus-API integration is testable only against the deployed site.

These are automatically set by `scripts/update-env.sh`.

## Deployment Workflow

### For Infrastructure Changes

```bash
# 1. Make changes to CDK stacks
# 2. Run checks
npm run check

# 3. Preview changes
cd voc-datalake
cdk diff

# 4. Deploy
cdk deploy --all
```

### For Frontend Changes

```bash
# 1. Make changes to frontend code
# 2. Run checks
npm run check

# 3. Deploy frontend only
npm run deploy:frontend
```

### For Plugin Changes

```bash
# 1. Create/modify plugin in plugins/
# 2. Update pluginStatus in cdk.context.json
# 3. Regenerate manifests
npm run generate:config

# 4. Deploy infrastructure (for new Lambda) + frontend
npm run deploy:all
```

## CI/CD Integration

Example GitHub Actions workflow:

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
        run: |
          npm install
          cd voc-datalake && npm install
          cd frontend && npm install
          
      - name: Quality checks
        run: npm run check
        
      - name: Deploy infrastructure
        run: npm run deploy:infra
        env:
          AWS_ACCESS_KEY_ID: ${{ secrets.AWS_ACCESS_KEY_ID }}
          AWS_SECRET_ACCESS_KEY: ${{ secrets.AWS_SECRET_ACCESS_KEY }}
          AWS_REGION: us-east-1
          
      - name: Deploy frontend
        run: npm run deploy:frontend
```

## Troubleshooting

### CDK Bootstrap

If deploying to a new AWS account/region:

```bash
cdk bootstrap aws://ACCOUNT_ID/REGION
```

### Stack Stuck in UPDATE_ROLLBACK

```bash
aws cloudformation continue-update-rollback --stack-name STACK_NAME
```

### CloudFront Cache

If changes don't appear after deployment:

```bash
aws cloudfront create-invalidation \
  --distribution-id DISTRIBUTION_ID \
  --paths '/*'
```

### View Stack Outputs

```bash
aws cloudformation describe-stacks \
  --stack-name VocApiStack \
  --query 'Stacks[0].Outputs'
```

## Useful Commands

| Command | Description |
|---------|-------------|
| `npm run check` | Run all quality checks |
| `npm run deploy:all` | Deploy infrastructure + frontend |
| `npm run deploy:infra` | Deploy CDK stacks only |
| `npm run deploy:frontend` | Deploy frontend only |
| `npm run generate:config` | Regenerate plugin/menu config |
| `npm run dev` | Start frontend dev server |
| `cdk diff` | Preview infrastructure changes |
| `cdk synth` | Generate CloudFormation templates |
