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
# From project root
npm run lint         # ESLint code quality
npm run typecheck    # TypeScript type checking
npm run test         # Run test suite

# Or run all at once
npm run check        # lint + typecheck + test
```

### What Each Check Does

| Command | Description |
|---------|-------------|
| `npm run lint` | Runs ESLint to catch code quality issues |
| `npm run typecheck` | Runs TypeScript compiler to verify types |
| `npm run test` | Runs Vitest test suite |
| `npm run test:coverage` | Runs tests with coverage report |

## CDK Stacks

The platform consists of 6 CDK stacks (consolidated architecture):

| Stack | Description | Dependencies |
|-------|-------------|--------------|
| `VocCoreStack` | DynamoDB tables, KMS, S3 buckets, Cognito, CloudFront | None |
| `VocIngestionStack` | Plugin Lambdas, EventBridge schedules, SQS, Secrets | Core |
| `VocProcessingStackConsolidated` | Processor, Aggregator, Step Functions, Bedrock | Core, Ingestion |
| `VocApiStack` | API Gateway, 15 API Lambdas, Webhooks, WAF | Core, Ingestion, Processing |
| `VocBedrockAccessStack` | Bedrock model access configuration | None |
| `ArtifactBuilderStack` | ECS-based artifact generator | None (standalone) |

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

1. `VocCoreStack` + `VocBedrockAccessStack` (parallel, no dependencies)
2. `VocIngestionStack`
3. `VocProcessingStackConsolidated`
4. `VocApiStack`
5. `ArtifactBuilderStack` (independent, can deploy anytime)

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
    "trustpilot": true,
    "yelp": false,
    "twitter": true
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
    "artifact-builder": false
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
- `VITE_ARTIFACT_BUILDER_ENDPOINT` - Artifact Builder API URL
- `VITE_USER_POOL_ID` - Cognito User Pool ID
- `VITE_USER_POOL_CLIENT_ID` - Cognito Client ID
- `VITE_COGNITO_REGION` - AWS Region

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
