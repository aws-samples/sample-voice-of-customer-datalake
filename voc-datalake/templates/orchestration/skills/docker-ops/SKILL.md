---
name: docker-ops
description: "Docker and container practice for Python and TypeScript projects. Multi-stage builds, base image choice and pinning, hardening, health checks, layer order, size targets and the anti-patterns to catch, when writing or reviewing a Dockerfile or compose file."
source: "ai-skill-factory 2.0.0 (Amit Deol), skills/docker-ops"
license: MIT
adapted: "The sandbox has no Docker and no network: Dockerfiles are written and reviewed by reading (hadolint where the repository installs it), and building, scanning, pushing and registry checks are a person's, named in the finish. The release schedule check reads the repository's pins instead of a web page. Slash references name library skills. The report is the finish summary or findings."
---

Apply Docker best practices to the Dockerfiles and compose files your task names.

The sandbox has no Docker daemon and no network: you write and review Dockerfiles by reading them (and with
`hadolint` when the repository installs it). `docker build`, an image scan and a push are a person's steps; name
them in your finish.

## Step 1: Detect Context

Read Dockerfile, docker-compose.yml, and project config files. Determine:
- Language: Python (pyproject.toml) or TypeScript (package.json) or both
- Purpose: development, production, or GPU workload
- Registry: ECR, GHCR, Docker Hub

## Step 2: Dockerfile Patterns

Read `references/dockerfile-templates.md` for complete multi-stage templates:
- Python (uv-based, 2-stage builder + runtime)
- TypeScript (pnpm, 3-stage deps + builder + runtime)
- .dockerignore template
- BuildKit secrets pattern

Select the template matching your detected stack.

## Step 3: Base Image Selection

| Goal | Python | TypeScript |
|---|---|---|
| Production (default) | `python:3.13-slim` (145MB) | `node:24-alpine` (Active LTS, 47MB) |
| Maximum security | `gcr.io/distroless/python3-debian13` | `gcr.io/distroless/nodejs24-debian13` |
| Development | `python:3.13` (full) | `node:24` (full) |
| GPU training | `nvidia/cuda:12.4.1-devel-ubuntu22.04` | N/A |
| GPU inference | `nvidia/cuda:12.4.1-runtime-ubuntu22.04` | N/A |

Mind the Node.js release schedule when pinning: Active LTS moves to a new major every October
(https://nodejs.org/en/about/previous-releases; you cannot fetch it from the sandbox, so take the version from the
repository's other pins, `.nvmrc` or `engines`, and name an unchecked choice in your finish). Node 20 left
Maintenance LTS in March 2026 and is unsupported; Node 22 is Maintenance LTS until April
2027. Pin base images to patch version: `python:3.13.1-slim`, not `python:3.13-slim`.
For critical production, pin to digest: `python:3.13.1-slim@sha256:abc123...`

## Step 4: Security Checklist

- [ ] Non-root USER with UID >= 1000
- [ ] No secrets in ARG or ENV (use BuildKit `--mount=type=secret`)
- [ ] .dockerignore excludes .git, .env, node_modules, .venv, __pycache__
- [ ] Base image pinned to specific version (not `latest`)
- [ ] HEALTHCHECK instruction present
- [ ] No unnecessary packages installed (curl only if needed for health check)
- [ ] Production image has no dev dependencies
- [ ] Image scan named for a person: `trivy image --severity HIGH,CRITICAL <image>` (it needs the built image)

## Step 5: Layer Optimization

Order from least to most frequently changing:
1. System packages (apt-get)
2. Package manifests (pyproject.toml, package.json)
3. Lock files (uv.lock, pnpm-lock.yaml)
4. Application source code
5. Configuration files

Combine related RUN commands:
```dockerfile
# GOOD: Single layer, atomic
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl ca-certificates && \
    rm -rf /var/lib/apt/lists/*
```

## Step 6: Compose and Registry

Read `references/compose-registry.md` for Docker Compose development setup, ECR registry patterns, and
multi-architecture build instructions.

Building the image that ships to AWS (a person's build, or a pipeline's): never run `docker build` on a local
machine for an image bound for ECR or production. Use AWS CodeBuild (S3 or CodeCommit source, a CodeBuild
project with the `aws/codebuild/amazonlinux-x86_64-standard` or ARM64 equivalent image,
`privileged_mode: true`, and `aws ecr get-login-password` + `docker push` in the `build`
phase) so the build runs in a consistent, auditable environment with scoped IAM instead of
a developer's Docker daemon. `docker build` and `docker-compose up` stay local-only for
inner-loop development against `Dockerfile.dev`.

## Step 7: Size Targets

| Stack | Target | Technique |
|---|---|---|
| Python API | 200-300MB | Multi-stage, slim base, no dev deps |
| TypeScript API | 100-200MB | Multi-stage, alpine base, prod-only node_modules |
| GPU inference | 2-3GB | Runtime (not devel) CUDA base |

## Step 8: Anti-Patterns to Detect

| # | Anti-Pattern | Search For | Fix |
|---|---|---|---|
| 1 | Running as root | No `USER` directive | Add `USER appuser` |
| 2 | Dev deps in prod | `pip install -r requirements-dev` | Separate prod/dev installs |
| 3 | No multi-stage | Single `FROM` | Split into builder + runtime |
| 4 | No .dockerignore | Missing file | Create with exclusions |
| 5 | Secrets in ARG | `ARG.*PASSWORD\|TOKEN\|KEY` | Use BuildKit secrets |
| 6 | Unpinned base | `FROM python:latest` | Pin to patch version |
| 7 | No HEALTHCHECK | Missing instruction | Add HTTP or TCP check |

## Step 9: Report

A reviewer writes each finding with `write_findings`; a builder puts the summary in its finish.

```
## Docker Audit: X issues found

### Image Profile
- Base: [image:tag]
- Stages: [count]
- Estimated size: [MB]
- Security: [PASS/FAIL]

### Findings
| # | Category | Issue | Severity | Fix |
```

For GPU container patterns, see the `cdk-doctor` skill (its AMI reference covers GPU instances).
For AWS security on ECR, see the `aws-security` skill.
