# Deployment Guide

This guide covers how to deploy the VoC (Voice of Customer) platform, including infrastructure (CDK stacks) and the frontend application.

## Prerequisites

- **AWS CLI** configured with appropriate credentials
- **Node.js** 18+ and npm
- **Python** 3.12+ (for Lambda functions)
- **Docker** (for building Lambda layers)

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
# Install all dependencies
npm run install:all

# Build Lambda layers (requires Docker)
npm run build:layers

# Bootstrap CDK (first time only)
npm run cdk:bootstrap

# Deploy everything
npm run deploy:all
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

## Anthropic Model Access (First-Time Setup)

Anthropic requires first-time customers to submit use case details before invoking Claude models on Amazon Bedrock. This is a **one-time requirement per AWS account** (or once at the organization's management account level).

### Automatic Setup via CDK

The `BedrockAccessStack` automates this process. To enable it:

1. Copy the example config:
   ```bash
   cd voc-datalake
   # If you don't have cdk.context.json yet:
   cp cdk.context.example.json cdk.context.json
   ```

2. Add the `anthropicUseCase` section to your `cdk.context.json`:
   ```json
   {
     "anthropicUseCase": {
       "companyName": "Your Company Name",
       "companyWebsite": "https://your-company.com",
       "intendedUsers": "Internal teams for customer feedback analysis",
       "industryOption": "Technology",
       "useCases": "Analyzing customer feedback to identify product improvement opportunities, sentiment analysis, and generating insights from voice of customer data."
     }
   }
   ```

3. Deploy the stack:
   ```bash
   npm run deploy:infra
   ```

### Configuration Fields

| Field | Required | Description |
|-------|----------|-------------|
| `companyName` | Yes | Your company or organization name |
| `companyWebsite` | Yes | Your company website URL |
| `intendedUsers` | Yes | Who will use the models (e.g., "Internal engineering teams") |
| `industryOption` | Yes | Your industry (e.g., "Technology", "Healthcare", "Finance") |
| `useCases` | Yes | Description of how you'll use the models |
| `otherIndustryOption` | No | Specify if industryOption is "Other" |

### Security Note

The `anthropicUseCase` config contains company information. For open source forks:
- Don't commit your actual company details to public repos
- Use the example file as a template
- Consider using environment variables in CI/CD pipelines

### Manual Alternative

You can also submit use case details via the AWS Console:
1. Open Amazon Bedrock console
2. Navigate to **Bedrock configurations** → **Model access**
3. Click **Modify model access**
4. Click **Submit use case details**
5. Fill out the form and submit

Access is granted immediately after successful submission.

## CDK Stacks

The platform consists of 5 CDK stacks (+ 1 optional):

| Stack | Description | Dependencies |
|-------|-------------|--------------|
| `BedrockAccessStack` | Anthropic use case submission (first-time only) | None |
| `VocCoreStack` | DynamoDB tables, KMS, S3, CloudFront, Cognito | None |
| `VocIngestionStack` | Lambda ingestors, EventBridge, SQS | Core |
| `VocProcessingStack` | Lambda processors, Bedrock, Step Functions | Core, Ingestion |
| `VocApiStack` | API Gateway, Lambda APIs, Frontend deployment | Core, Ingestion, Processing |
| `ArtifactBuilderStack` | ECS-based artifact generator (optional) | None (standalone) |

The `ArtifactBuilderStack` is controlled by `menuStatus.ArtifactBuilderStack` in `cdk.context.json`.

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
cdk deploy VocProcessingStack
cdk deploy VocApiStack

# Deploy multiple stacks
cdk deploy VocCoreStack VocIngestionStack

# Deploy with auto-approve (no confirmation prompts)
cdk deploy --all --require-approval never
```

### Stack Deployment Order

Due to dependencies, stacks should be deployed in this order:

1. `VocCoreStack`
2. `VocIngestionStack`
3. `VocProcessingStack`
4. `VocApiStack`
5. `ArtifactBuilderStack` (optional, independent)

The `cdk deploy --all` command handles this automatically.

## Frontend Deployment

### Option 1: Via CDK (Recommended)

The `VocApiStack` builds and deploys the frontend automatically:

```bash
cd voc-datalake
cdk deploy VocApiStack
```

### Option 2: Direct Deployment (Faster for Updates)

For frontend-only changes, use the direct deployment script:

```bash
npm run deploy:frontend
```

This script:
1. Fetches environment config from CloudFormation
2. Builds the frontend (`npm run build`)
3. Syncs to S3
4. Invalidates CloudFront cache

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

The frontend fetches configuration at runtime from a `config.json` file that is generated during deployment. The deploy script automatically:
1. Fetches values from CloudFormation outputs
2. Generates `config.json` with API endpoint, Cognito settings, etc.
3. Uploads it to S3 alongside the frontend build

## Deployment Workflow

### For Infrastructure Changes

```bash
# 1. Make changes to CDK stacks
# 2. Run checks
npm run check

# 3. Preview changes
npm run cdk:diff

# 4. Deploy
npm run deploy:infra
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
        run: npm run install:all
          
      - name: Build Lambda layers
        run: npm run build:layers
          
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
npm run cdk:bootstrap
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
| `npm run install:all` | Install all dependencies (root + CDK + frontend) |
| `npm run build:layers` | Build Lambda layers with Docker (ARM64) |
| `npm run cdk:bootstrap` | Bootstrap CDK in AWS account |
| `npm run check` | Run all quality checks (lint + typecheck + test) |
| `npm run deploy:all` | Deploy infrastructure + frontend |
| `npm run deploy:infra` | Deploy CDK stacks only |
| `npm run deploy:frontend` | Deploy frontend only |
| `npm run generate:config` | Regenerate plugin/menu config |
| `npm run dev` | Start frontend dev server |
| `npm run cdk:diff` | Preview infrastructure changes |
| `npm run cdk:synth` | Generate CloudFormation templates |
| `npm run destroy` | Destroy all stacks |
