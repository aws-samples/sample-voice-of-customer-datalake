# Artifact Builder

An agentic PoC builder that turns a single prompt into a working web mock or prototype, publishes a live preview, and stores everything for review.

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
                                 │              ┌─────────────────┐
                                 └──────────────│  ECS Fargate    │
                                                │  (Executor)     │
                                                │  + Bedrock      │
                                                └─────────────────┘
```

## Components

### Frontend (`frontend/`)
- React + Vite + Tailwind CSS
- Simple form to submit prompts
- Job status tracking with timeline
- Preview and download links

### API Lambda (`lambda/api/artifact_builder_handler.py`)
- Creates jobs in DynamoDB
- Uploads request payload to S3
- Sends message to SQS
- Returns job status and artifacts

### Trigger Lambda (`lambda/api/artifact_trigger_handler.py`)
- Consumes SQS messages
- Starts ECS Fargate tasks
- Updates job status

### Executor (`executor/`)
- Docker container running on ECS Fargate
- Pulls job request from S3
- Invokes Bedrock Claude Sonnet 4.5 to generate code
- Builds the project with npm
- Uploads artifacts to S3
- Updates job status in DynamoDB

## Data Flow

1. User submits prompt via frontend
2. API Lambda creates job record in DynamoDB
3. API Lambda uploads request to S3 and sends SQS message
4. Trigger Lambda receives SQS message and starts ECS task
5. ECS Executor:
   - Downloads request from S3
   - Copies starter template
   - Invokes Bedrock to generate code
   - Runs `npm install` and `npm run build`
   - Retries with Bedrock if build fails
   - Uploads source.zip, build/, logs.txt, summary.json to S3
   - Updates job status to 'done'
6. User views preview via CloudFront URL

## S3 Structure

```
artifact-builder-{account}-{region}/
└── jobs/
    └── {job_id}/
        ├── request.json      # Original request payload
        ├── source.zip        # Source code bundle
        ├── build/            # Built static files
        │   ├── index.html
        │   ├── assets/
        │   └── ...
        ├── logs.txt          # Build logs
        └── summary.json      # Build summary
```

## DynamoDB Schema

**Table: artifact-builder-jobs**

| PK | SK | Attributes |
|----|----|----|
| `JOB#{job_id}` | `META` | job_id, status, prompt, project_type, style, timeline, preview_url, error, ttl |

**GSI1: gsi1-by-status**
- PK: status
- SK: created_at

## Job Status Flow

```
queued → generating → building → publishing → done
                 ↓
              failed
```

## Deployment

```bash
# Deploy the stack
cd voc-datalake
npx cdk deploy ArtifactBuilderStack

# Build and deploy frontend (after stack deployment)
cd artifact-builder/frontend
npm install
npm run build
# Upload dist/ to S3 or use Amplify
```

## Local Development

```bash
# Frontend
cd artifact-builder/frontend
npm install
npm run dev  # http://localhost:5174

# Set API endpoint
export VITE_API_ENDPOINT=https://your-api.execute-api.region.amazonaws.com/v1
```

## Configuration

### Environment Variables (Executor)

| Variable | Description |
|----------|-------------|
| `JOB_ID` | Job ID to process |
| `ARTIFACTS_BUCKET` | S3 bucket for artifacts |
| `JOBS_TABLE` | DynamoDB table name |
| `AWS_REGION` | AWS region |

### Templates

Available project templates in `executor/templates/`:
- `react-vite` - React + Vite + Tailwind CSS (default)
- `nextjs-static` - Next.js with static export
- `docs-site` - VitePress documentation site

### Style Presets

- `minimal` - Clean, simple design
- `corporate` - Professional business style
- `playful` - Fun, colorful design
- `dark` - Dark theme by default

## Security

- ECS tasks run in private subnets with NAT gateway
- S3 bucket blocks public access (served via CloudFront)
- DynamoDB encryption at rest
- IAM least-privilege for all roles
- 30-day TTL on job records and artifacts

## Cost Optimization

- ECS Fargate with ARM64 (Graviton) for better price/performance
- S3 lifecycle rules to expire old artifacts
- DynamoDB on-demand billing
- CloudFront caching for previews
