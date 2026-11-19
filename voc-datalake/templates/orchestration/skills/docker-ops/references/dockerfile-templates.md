# Dockerfile Templates

## Python (uv-based, multi-stage)

```dockerfile
# Stage 1: Builder
FROM python:3.13-slim AS builder
WORKDIR /build
# Pin uv to the version the repository uses (never :latest)
COPY --from=ghcr.io/astral-sh/uv:0.13.6 /uv /usr/local/bin/uv
COPY pyproject.toml uv.lock ./
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-dev --no-editable

# Stage 2: Runtime
FROM python:3.13-slim
WORKDIR /app
RUN groupadd -r appuser && useradd -r -g appuser -u 1000 appuser
COPY --from=builder /build/.venv /app/.venv
COPY --chown=appuser:appuser src/ ./src/
ENV PATH="/app/.venv/bin:$PATH" \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1
USER appuser
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8000/health')"
EXPOSE 8000
CMD ["python", "-m", "uvicorn", "src.main:app", "--host", "0.0.0.0"]
```

## TypeScript (pnpm, multi-stage)

```dockerfile
# Stage 1: Dependencies
FROM node:24-alpine AS deps
WORKDIR /build
RUN corepack enable pnpm
COPY pnpm-lock.yaml package.json ./
RUN --mount=type=cache,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --prod

# Stage 2: Builder
FROM node:24-alpine AS builder
WORKDIR /build
RUN corepack enable pnpm
COPY pnpm-lock.yaml package.json ./
RUN --mount=type=cache,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile
COPY . .
RUN pnpm run build

# Stage 3: Runtime
FROM node:24-alpine
WORKDIR /app
RUN addgroup -g 1001 -S nodejs && adduser -S appuser -u 1001
COPY --from=deps /build/node_modules ./node_modules
COPY --from=builder --chown=appuser:nodejs /build/dist ./dist
ENV NODE_ENV=production
USER appuser
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
    CMD node -e "require('http').get('http://localhost:3000/health',(r)=>{process.exit(r.statusCode===200?0:1)})"
EXPOSE 3000
CMD ["node", "dist/server.js"]
```

## .dockerignore

```
.git
.github
.gitignore
*.md
README.md
node_modules/
.venv/
__pycache__/
*.pyc
.pytest_cache/
.env
.env.*
.DS_Store
coverage/
dist/
build/
.next/
.turbo/
```

## BuildKit Secrets (not ARG)

```dockerfile
# CORRECT: Secret not stored in image layers
RUN --mount=type=secret,id=npm_token \
    echo "//registry.npmjs.org/:_authToken=$(cat /run/secrets/npm_token)" > .npmrc && \
    pnpm install --frozen-lockfile && \
    rm .npmrc
```

Build: `docker build --secret id=npm_token,env=NPM_TOKEN .`
