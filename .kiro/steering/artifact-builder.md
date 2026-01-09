---
inclusion: fileMatch
fileMatchPattern: "**/artifact-builder/**"
---

# Artifact Builder - Technical Reference

The Artifact Builder generates web prototypes using Kiro CLI in ECS Fargate. This document captures all the technical details and lessons learned.


## Architecture Overview

```
API Gateway → Lambda → SQS → Lambda (trigger) → ECS Fargate Task
                                                      ↓
                                              Clone template from CodeCommit
                                                      ↓
                                              Kiro CLI generates code
                                                      ↓
                                              npm install && npm run build
                                                      ↓
                                              Push to new CodeCommit repo
                                                      ↓
                                              Upload to S3 → CloudFront serves preview
```

## Key Endpoints

Endpoints are deployment-specific. Get them from CloudFormation outputs:

```bash
# Get API endpoint
aws cloudformation describe-stacks --stack-name ArtifactBuilderStack \
  --query 'Stacks[0].Outputs[?OutputKey==`ApiEndpoint`].OutputValue' --output text

# Get Preview CDN
aws cloudformation describe-stacks --stack-name ArtifactBuilderStack \
  --query 'Stacks[0].Outputs[?OutputKey==`PreviewCdnUrl`].OutputValue' --output text

# Get ECR repository
aws cloudformation describe-stacks --stack-name ArtifactBuilderStack \
  --query 'Stacks[0].Outputs[?OutputKey==`ExecutorRepositoryUri`].OutputValue' --output text
```

- **API:** `https://<api-id>.execute-api.<region>.amazonaws.com/v1`
- **Preview CDN:** `https://<distribution-id>.cloudfront.net`
- **Template Repo:** `artifact-builder-template` (CodeCommit)
- **ECR Image:** `<account>.dkr.ecr.<region>.amazonaws.com/artifact-builder-executor:with-auth`

## Building and Deploying the Executor Image

### CRITICAL: Architecture Must Be AMD64

ECS Fargate runs X86_64. If you build on Mac M-series (ARM64), you MUST specify `--platform linux/amd64`:

```bash
# ❌ WRONG - builds ARM64 on Mac M-series
docker build -t artifact-builder-executor:latest executor/

# ✅ CORRECT - explicitly builds AMD64
docker build --platform linux/amd64 -t artifact-builder-executor:amd64 voc-datalake/artifact-builder/executor/
```

### CRITICAL: Kiro CLI Auth Must Be Baked Into Image

Kiro CLI uses OAuth device flow. Auth state must be baked into the Docker image because:
1. EFS mount was unreliable for auth persistence
2. The auth check can hang if not properly configured

### Full Image Build Process

```bash
# Get ECR repository URI from CloudFormation
ECR_REPO=$(aws cloudformation describe-stacks --stack-name ArtifactBuilderStack \
  --query 'Stacks[0].Outputs[?OutputKey==`ExecutorRepositoryUri`].OutputValue' --output text)
AWS_ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
AWS_REGION=$(aws configure get region)

# 1. Build fresh AMD64 image
docker build --platform linux/amd64 -t artifact-builder-executor:amd64 voc-datalake/artifact-builder/executor/

# 2. Start container for login (don't use --rm!)
docker run -it --platform linux/amd64 --name kiro-amd64-auth artifact-builder-executor:amd64 bash

# 3. Inside container: Login to Kiro CLI
kiro-cli login --use-device-flow
# Select "Use with Builder ID"
# Enter the following when prompted:
#   - Start URL: https://amzn.awsapps.com/start
#   - Region: us-east-1
# Complete browser auth
# Verify with: kiro-cli whoami
# Then: exit

# 4. CRITICAL: Commit WITH the correct CMD
# Without --change, the CMD becomes "bash" and the container won't run the executor!
docker commit --change='CMD ["/bin/bash", "/app/entrypoint.sh"]' kiro-amd64-auth artifact-builder-executor:with-auth

# 5. Clean up the container
docker rm kiro-amd64-auth

# 6. Verify auth works
docker run --rm --platform linux/amd64 artifact-builder-executor:with-auth bash -c "timeout 10 kiro-cli whoami"

# 7. Tag and push to ECR
aws ecr get-login-password --region $AWS_REGION | docker login --username AWS --password-stdin $ECR_REPO
docker tag artifact-builder-executor:with-auth $ECR_REPO:with-auth
docker push $ECR_REPO:with-auth
```

### After Pushing New Image

ECS will automatically pull the new image on next task run. To force a new task definition revision:

```bash
aws ecs describe-task-definition --task-definition artifact-builder-executor --query 'taskDefinition' | \
  jq 'del(.taskDefinitionArn, .revision, .status, .requiresAttributes, .compatibilities, .registeredAt, .registeredBy)' > /tmp/taskdef.json
aws ecs register-task-definition --cli-input-json file:///tmp/taskdef.json
```

## Template Repository

The template is stored in CodeCommit: `artifact-builder-template`

### Cloning the Template

```bash
git clone codecommit::us-west-2://artifact-builder-template /tmp/artifact-template
```

### Key Template Configurations

#### vite.config.ts - MUST use relative paths

```typescript
export default defineConfig({
  base: './',  // CRITICAL: Use relative paths for S3/CloudFront hosting
  // ...
});
```

Without `base: './'`, the build outputs absolute paths like `/assets/index.js` which fail when served from `/jobs/{id}/build/`.

#### src/App.tsx - MUST use HashRouter

```typescript
import { HashRouter } from "react-router-dom";

// ❌ WRONG - BrowserRouter doesn't work with static hosting in subdirectories
<BrowserRouter>

// ✅ CORRECT - HashRouter works everywhere
<HashRouter>
```

### Pushing Template Changes

```bash
cd /tmp/artifact-template
git add .
git commit -m "Your change description"
git push origin main
```

## Debugging

### Check Job Status

```bash
# Get API endpoint from CloudFormation
API_URL=$(aws cloudformation describe-stacks --stack-name ArtifactBuilderStack \
  --query 'Stacks[0].Outputs[?OutputKey==`ApiEndpoint`].OutputValue' --output text)

curl -s "$API_URL/jobs/{job_id}" | jq .
```

### Check ECS Task Logs

```bash
# List recent log streams
aws logs describe-log-streams --log-group-name /ecs/artifact-builder-executor --order-by LastEventTime --descending --limit 5

# Tail logs
aws logs tail /ecs/artifact-builder-executor --since 5m

# Get logs for specific task
aws logs get-log-events --log-group-name /ecs/artifact-builder-executor --log-stream-name "executor/executor/{task_id}"
```

### Check Running Tasks

```bash
aws ecs list-tasks --cluster artifact-builder --desired-status RUNNING
aws ecs describe-tasks --cluster artifact-builder --tasks {task_arn}
```

### Get Job Logs from S3

```bash
# Get S3 bucket from CloudFormation
S3_BUCKET=$(aws cloudformation describe-stacks --stack-name ArtifactBuilderStack \
  --query 'Stacks[0].Outputs[?OutputKey==`ArtifactBucketName`].OutputValue' --output text)

aws s3 cp "s3://$S3_BUCKET/jobs/{job_id}/logs.txt" -
```

### Common Issues and Solutions

| Issue | Symptom | Solution |
|-------|---------|----------|
| `exec format error` | Task fails immediately | Image built for wrong architecture. Rebuild with `--platform linux/amd64` |
| No logs appearing | Task running but log stream empty | Container CMD is wrong. Rebuild with `docker commit --change='CMD [...]'` |
| `kiro-cli whoami` hangs | Entrypoint stuck | Add timeout: `timeout 15 kiro-cli whoami` |
| 403 on assets | Page loads but CSS/JS fail | Missing `base: './'` in vite.config.ts |
| 404 Page not found | React Router shows 404 | Using BrowserRouter instead of HashRouter |
| `Bad file descriptor (os error 9)` | Kiro CLI error in logs | This is a known issue but doesn't prevent code generation |

## Kiro CLI Usage

The executor runs Kiro CLI in headless mode:

```bash
kiro-cli chat --no-interactive --trust-all-tools "Your prompt here"
```

- `--no-interactive`: Headless mode, no TTY prompts
- `--trust-all-tools`: Auto-approve all tool executions

## Files Structure

```
voc-datalake/artifact-builder/
├── executor/
│   ├── Dockerfile           # Amazon Linux 2023 base, installs Kiro CLI
│   ├── entrypoint.sh        # Startup script with logging
│   ├── executor.py          # Main Python executor
│   └── kiro_prompt.txt      # Base prompt for Kiro CLI
├── update-executor-image.sh # Helper script (may need manual steps)
└── README.md
```

## CDK Stack

The infrastructure is defined in `lib/stacks/artifact-builder-stack.ts`:

- Uses pre-authenticated ECR image (not building from Dockerfile)
- EFS mount at `/home/kiro/.kiro-efs` (backup, not primary auth)
- Task definition uses X86_64 architecture
- 4 vCPU, 8GB memory for fast builds

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | `/jobs` | Create new job |
| GET | `/jobs` | List jobs |
| GET | `/jobs/{id}` | Get job status |
| DELETE | `/jobs/{id}` | Delete job |
| GET | `/jobs/{id}/logs` | Get job logs |
| GET | `/templates` | List available templates |

## Job Lifecycle

1. `queued` - Job created, waiting for ECS task
2. `cloning` - Cloning template from CodeCommit
3. `generating` - Kiro CLI generating code
4. `building` - Running npm install && npm run build
5. `publishing` - Pushing to CodeCommit and S3
6. `done` - Complete, preview_url available
7. `failed` - Error occurred, check error field

## Iteration Support

Jobs can iterate on previous jobs:

```bash
curl -X POST .../jobs -d '{
  "prompt": "Add a contact form",
  "parent_job_id": "previous_job_id"
}'
```

This clones from `artifact-{parent_job_id}` instead of the template.
