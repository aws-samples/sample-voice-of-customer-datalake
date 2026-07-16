# Deployment Guide

This guide covers how to deploy the VoC (Voice of Customer) platform, including infrastructure (CDK stacks) and the frontend application.

## Prerequisites

- **AWS CLI** configured with appropriate credentials
- **Node.js** 18+ and npm
- **Python** 3.12+ (for Lambda functions)
- **Docker or Finch** (for building Lambda layers and CDK asset bundling)

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

# Build Lambda layers (requires Docker; Finch users: CDK_DOCKER=finch npm run build:layers)
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
| `npm run test` | Runs Vitest test suite (frontend + CDK) |
| `npm run test:coverage` | Runs tests with coverage report |

### Python Lambda Tests

Lambda handlers have their own test suite using pytest:

```bash
cd voc-datalake

# Run all Lambda tests
pytest

# Run with coverage report
pytest --cov=lambda --cov-report=html:coverage_html

# Run specific handler tests
pytest lambda/processor/test/
pytest lambda/aggregator/test/
pytest lambda/api/test/
```

Test coverage reports are generated in `voc-datalake/coverage_html/`.

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

### Accounts That Already Have Model Access

If your account already has Anthropic model access (a previous submission,
organization-level access, or an AWS-internal account), the use case
submission is skipped gracefully: rejections such as
`Internal Accounts should not submit use case details` are treated as a
no-op instead of failing the deployment. Permission and throttling errors
still fail loudly.

You can also skip the submission entirely via `cdk.context.json`:

```json
{
  "skipUseCaseSubmission": true
}
```

or on the CLI: `cdk deploy --all --context skipUseCaseSubmission=true`.

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

The platform consists of 4 core stacks plus 2 optional ones:

| Stack | Description | Dependencies |
|-------|-------------|--------------|
| `VocCoreStack` | DynamoDB tables, KMS, S3 buckets, Cognito, CloudFront | None |
| `VocIngestionStack` | Plugin Lambdas, EventBridge schedules, SQS, Secrets | Core |
| `VocProcessingStack` | Processor, Aggregator, Step Functions, Bedrock | Core, Ingestion |
| `VocApiStack` | API Gateway, API Lambdas, Webhooks, WAF | Core, Ingestion, Processing |
| `BedrockAccessStack` (optional) | Bedrock model access / Anthropic use case submission — created only when `anthropicUseCase` is set in `cdk.context.json` (see the conditional in `bin/voc-datalake.ts`) | None |
| `VocWebSearchStack` (optional) | AgentCore Gateway for public web search — opt-in via `enableWebSearch: true`; always deploys to us-east-1 (the connector only exists there) | None |

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

A clean `cdk synth`/`cdk deploy` prints **zero warnings** — treat any new
warning as a regression to investigate rather than noise to ignore.

### Stack Deployment Order

Due to dependencies, stacks should be deployed in this order:

1. `VocCoreStack` (+ optional `BedrockAccessStack` / `VocWebSearchStack`, no dependencies)
2. `VocIngestionStack`
3. `VocProcessingStack`
4. `VocApiStack`

The `cdk deploy --all` command handles this automatically.

### Enabling Web Search (optional)

Public web search in AI Chat and Research is opt-in and off by default —
without it the UI hides the web-search toggle entirely (the deployment
reports `WebSearchAvailable=false` and `config.json` ships
`features.webSearch: false`).

To enable it:

```bash
# One-time: the gateway only exists in us-east-1, so that region must be
# bootstrapped even when the app lives elsewhere (cross-region references)
cdk bootstrap aws://ACCOUNT_ID/us-east-1

cdk deploy --all -c enableWebSearch=true
npm run deploy:frontend   # regenerates config.json with webSearch: true
```

Cost model (per `bin/voc-datalake.ts`): the gateway has no standing cost;
searches bill per query ($7/1k at the time of writing — check AgentCore
pricing) and only run for requests where the user turned the toggle on.

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

### Frontend Caching Model

Learned the hard way (issues #188/#191 — returning browsers rendered raw
i18n keys after a redeploy):

- **Hashed assets** (`dist/assets/*`) upload with
  `Cache-Control: public,max-age=31536000,immutable` — content-hashed
  names change on every code change, so they can cache forever.
- **Stable-name files** (`index.html`, `config.json`, `locales/**`,
  manifests) upload with `Cache-Control: no-cache` — browsers revalidate
  with ETags (cheap 304s) and can never serve a stale copy. Without this,
  browsers apply *heuristic* caching (~10% of object age) and can serve
  week-old locale JSONs for days, no matter how many CloudFront
  invalidations run — the staleness lives in the browser.
- **Locale URLs are version-stamped** (`/locales/en/common.json?v=<git-sha>`
  via `import.meta.env.APP_VERSION`, injected at build): each new bundle
  requests URLs no old cache entry can match, which also retroactively
  bust caches created before the headers existed.
- The assets sync deliberately does **not** `--delete`: visitors holding a
  previously-cached `index.html` still reference the previous deploy's
  chunks; deleting them would turn a stale-but-working page into 404s.

### Frontend Build Process

```bash
cd voc-datalake/frontend

# Generate plugin manifests and menu config
npm run prebuild

# Build for production
npm run build

# Output in dist/ folder
```

### Frontend Build Freshness Guard

`VocApiStack` deploys the frontend by packaging `voc-datalake/frontend/dist`
as-is (`s3deploy.Source.asset('frontend/dist')`). **CDK does not rebuild the
frontend** — whatever is in `dist` at synth time is what ships.

To prevent shipping a stale UI (a common mistake after switching branches or
editing `src/` without rebuilding), a synth-time guard runs at the top of the
`VocApiStack` constructor. It fails `cdk synth`/`diff`/`deploy` if:

- `frontend/dist/index.html` is missing (frontend never built), or
- any source input (`src/`, `public/`, `index.html`, `vite.config.ts`,
  `tsconfig*.json`, `package.json`) is newer than the built `dist/index.html`.

The error names the offending file and tells you to rebuild:

```bash
cd voc-datalake/frontend && npm run build
```

Always run `npm run deploy:frontend` (which builds, syncs, and invalidates) or
rebuild `dist` before `cdk deploy`. The guard is a safety net, not a substitute
for building.

**Bypass** (rare, intentional cases only):

```bash
cdk deploy VocApiStack -c skipFrontendBuildCheck=true
# or
SKIP_FRONTEND_BUILD_CHECK=1 cdk deploy VocApiStack
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

### Web Search (Amazon Bedrock AgentCore)

AI Chat and Projects research can optionally ground answers with public web
results via the AWS-managed [Web Search Tool connector](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/gateway-target-connector-web-search-tool.html)
behind an AgentCore Gateway (`VocWebSearchStack`). Queries are served
entirely within AWS and are billed at $7 per 1,000 searches; the feature is
opt-in per request in both UIs (chat toggle, research wizard checkbox).

The connector only exists in **us-east-1**, so the stack always deploys
there. Deployment is **explicitly opt-in** while the connector integration
is new — enable it with `"enableWebSearch": true` in `cdk.context.json`:

- App deployed to us-east-1: the flag is all that's needed.
- App deployed to any other region: the flag plus a us-east-1 bootstrap
  (`cdk bootstrap aws://ACCOUNT_ID/us-east-1`); CDK cross-region references
  carry the gateway URL/ARN to the app region.

**Data residency note:** search queries are processed by the connector in
us-east-1 regardless of where the app is deployed. Queries are derived from
user input — the research question is sent as-is, and in chat the model
composes queries from the conversation — so deployments with regional
data-handling requirements should factor this in before enabling the flag.

The frontend discovers availability through the `features.webSearch` flag in
`config.json` (set by CDK and by `scripts/deploy.sh` from the
`WebSearchAvailable` stack output). For local development against the mock,
set `VITE_ENABLE_WEB_SEARCH=true`.

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

### Runtime Configuration

The frontend automatically fetches configuration from CloudFormation outputs including:
- API Gateway endpoint
- Cognito User Pool settings
- AWS Region

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

### VocCoreStack fails: "Updates are not allowed for property - UsernameConfiguration"

User pools created before #105 predate the `signInCaseSensitive: false`
setting, and Cognito treats `UsernameConfiguration` as create-only — any
stack update that introduces it on an existing pool is rejected and the
whole VocCoreStack update rolls back. (A secondary
`Invalid AttributeDataType` error on the same update is a symptom of the
same rejected pool update.)

Deploy with the compatibility flag to leave the existing pool untouched:

```bash
cdk deploy VocCoreStack -c omitUserPoolUsernameConfiguration=true
```

Add the flag to every subsequent deploy of that environment (or to a
local, uncommitted context override). New deployments should NOT set it —
fresh pools get case-insensitive sign-in by default.

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
| `npm run build:layers` | Build Lambda layers with Docker (ARM64); honors `CONTAINER_CMD`/`CDK_DOCKER` (e.g. `finch`) |
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
