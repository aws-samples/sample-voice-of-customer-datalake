# Artifact Builder

An agentic PoC builder that turns a single prompt into a working web prototype using **Kiro CLI in autonomous mode**, publishes a live preview, and stores everything in CodeCommit.

## Architecture

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│   Frontend UI   │────▶│  API Gateway    │────▶│  Orchestrator   │
│   (React/Vite)  │     │                 │     │    Lambda       │
└─────────────────┘     └─────────────────┘     └────────┬────────┘
                                                         │
                                                         ▼
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│   CloudFront    │◀────│   S3 Bucket     │◀────│   SQS Queue     │
│   (Previews)    │     │   (Artifacts)   │     │                 │
└─────────────────┘     └────────┬────────┘     └────────┬────────┘
                                 │                       │
                                 │                       ▼
                                 │              ┌─────────────────┐
                                 │              │  Trigger Lambda │
                                 │              └────────┬────────┘
                                 │                       │
                                 │                       ▼
┌─────────────────┐              │              ┌─────────────────┐
│   CodeCommit    │◀─────────────┴──────────────│  ECS Fargate    │
│  (Template +    │                             │  (Executor)     │
│   Output Repos) │                             │  + Kiro CLI     │
└─────────────────┘                             └─────────────────┘
                                                         │
                                                         ▼
                                                ┌─────────────────┐
                                                │  SSM Parameter  │
                                                │  Store (Creds)  │
                                                └─────────────────┘
```

## Flow

1. User submits prompt via frontend
2. API Lambda creates job in DynamoDB, uploads request to S3, sends SQS message
3. Trigger Lambda receives SQS message and starts ECS Fargate task
4. ECS Executor:
   - Clones **read-only template** from CodeCommit (`artifact-builder-template`)
   - Runs **Kiro CLI in autonomous mode** with `--allow-all-tools`
   - Kiro generates/modifies code based on user prompt
   - Runs `npm install` and `npm run build`
   - If build fails, Kiro is invoked again to fix errors
   - Creates **new CodeCommit repo** (`artifact-{job_id}`) with the result
   - Uploads source.zip, build/, logs.txt to S3
   - Updates job status to 'done'
5. User views preview via CloudFront, downloads source, or clones CodeCommit repo

## Components

### CodeCommit Repositories

| Repository | Purpose |
|------------|---------|
| `artifact-builder-template` | Read-only starter template (React + Vite + shadcn/ui) |
| `artifact-{job_id}` | Generated output for each job |

### SSM Parameter Store

| Parameter | Description |
|-----------|-------------|
| `/artifact-builder/kiro-api-key` | API key for Kiro CLI (required) |

### Template (`template/`)

The template is included in this folder and must be uploaded to CodeCommit:
- React 19 + TypeScript
- Vite 7
- Tailwind CSS 4
- shadcn/ui components (full set)
- React Router, TanStack Query, Recharts

## Deployment

### 1. Deploy the Stack

```bash
cd voc-datalake
npm run build
npx cdk deploy ArtifactBuilderStack
```

### 2. Upload Template to CodeCommit

After deployment, upload the template to the CodeCommit repository:

```bash
# Get the repo URL from stack outputs
TEMPLATE_REPO_URL=$(aws cloudformation describe-stacks \
  --stack-name ArtifactBuilderStack \
  --query 'Stacks[0].Outputs[?OutputKey==`TemplateRepoCloneUrl`].OutputValue' \
  --output text)

# Push template to CodeCommit
cd voc-datalake/artifact-builder/template
git init
git add -A
git commit -m "Initial template"
git remote add origin $TEMPLATE_REPO_URL
git push -u origin main
```

### 3. Set Kiro API Key (Required)

```bash
aws ssm put-parameter \
  --name "/artifact-builder/kiro-api-key" \
  --value "your-kiro-api-key" \
  --type SecureString \
  --overwrite
```

### 4. Build and Deploy Frontend (Optional)

```bash
cd voc-datalake/artifact-builder/frontend
npm install
VITE_API_ENDPOINT=https://your-api.execute-api.region.amazonaws.com/v1 npm run build
# Deploy dist/ to S3 or Amplify
```

## Local Development

```bash
# Frontend
cd voc-datalake/artifact-builder/frontend
npm install
npm run dev  # http://localhost:5174

# Set API endpoint
export VITE_API_ENDPOINT=https://your-api.execute-api.region.amazonaws.com/v1
```

## Job Status Flow

```
queued → cloning → generating → building → publishing → done
                        ↓
                     failed
```

## S3 Structure

```
artifact-builder-{account}-{region}/
└── jobs/
    └── {job_id}/
        ├── request.json      # Original request payload
        ├── source.zip        # Source code bundle
        ├── build/            # Built static files
        │   ├── index.html
        │   └── assets/
        ├── logs.txt          # Build logs
        └── summary.json      # Build summary with repo URL
```

## DynamoDB Schema

**Table: artifact-builder-jobs**

| PK | SK | Attributes |
|----|----|----|
| `JOB#{job_id}` | `META` | job_id, status, prompt, project_type, style, timeline, preview_url, repo_url, error, ttl |

## Security

- ECS tasks run in private subnets with NAT gateway
- CodeCommit repos created per-job with IAM authentication
- SSM Parameter Store for Kiro API key (SecureString)
- S3 bucket blocks public access (served via CloudFront)
- 30-day TTL on job records and artifacts

## Requirements

- **Kiro CLI must be installed** in the executor container
- **Kiro API key must be set** in SSM before running jobs
- No fallback - jobs will fail if Kiro CLI is unavailable
