# Docker Compose and Registry Patterns

## Docker Compose (Development)

```yaml
services:
  api:
    build:
      context: .
      dockerfile: Dockerfile.dev
    ports:
      - "8000:8000"
    volumes:
      - .:/app
      - /app/.venv  # Exclude virtualenv from mount
    environment:
      DEBUG: "1"
    depends_on:
      db:
        condition: service_healthy
    command: uvicorn src.main:app --reload --host 0.0.0.0

  db:
    image: postgres:18-alpine
    environment:
      POSTGRES_USER: dev
      POSTGRES_PASSWORD: dev
      POSTGRES_DB: app
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U dev"]
      interval: 10s
      timeout: 5s
      retries: 5

volumes:
  pgdata:
```

## Registry Patterns (ECR)

A person's commands (they need Docker and the account; the agents have neither):

```bash
# Login
aws ecr get-login-password --region us-east-1 | docker login --username AWS --password-stdin <account>.dkr.ecr.us-east-1.amazonaws.com

# Build, tag, push
docker build -t myapp:latest .
docker tag myapp:latest <account>.dkr.ecr.us-east-1.amazonaws.com/myapp:$(git rev-parse --short HEAD)
docker push <account>.dkr.ecr.us-east-1.amazonaws.com/myapp:$(git rev-parse --short HEAD)
```

ECR best practices:
- Enable image tag immutability on create or after the fact:
  `aws ecr create-repository --repository-name myapp --image-tag-mutability IMMUTABLE`
  `aws ecr put-image-tag-mutability --repository-name myapp --image-tag-mutability IMMUTABLE`
- Enable scan on push (basic) or configure enhanced scanning at the registry level for
  continuous rescanning as new CVEs publish
- Set a lifecycle policy: keep last 10 tagged images
- Enable KMS encryption for production (set at repository creation; cannot change later)

Build the pushed image in AWS CodeBuild, not on a developer laptop (the skill's Step 6):
`aws ecr get-login-password` only grants a 12-hour token and should run in the CodeBuild
`pre_build` phase, never be stored.

## Multi-Architecture Builds

For ARM64 targets (AWS Graviton, Apple Silicon), a person's build:
```bash
docker buildx create --use
docker buildx build --platform linux/amd64,linux/arm64 -t image:tag --push .
```
Only needed when deploying to mixed architectures.
