# Build Pipeline and CI/CD

ARM64 image build via CodeBuild, build-type choice, deploy ordering, and CI shape. Source: AgentCore runtime/quickstart docs and a validated project's scripts. The agents write this code; a person runs the build and the deploy.

## Why CodeBuild, not local Docker

- AgentCore Runtime runs **ARM64 (Graviton)** only. A non-ARM64 image fails at start with `exec format error`.
- The agents' sandbox has no Docker, and many projects forbid a local `docker build`. CodeBuild gives a consistent ARM64 environment, proper ECR-push IAM, and no local Docker dependency.

Flow: zip agent source → upload to CodeBuild source bucket → run CodeBuild project (`docker build --platform linux/arm64`, push `:$GIT_SHA` + `:latest`) → CDK consumes the immutable `:$GIT_SHA` URI.

```yaml
# buildspec.yml (essentials)
phases:
  pre_build:
    commands:
      - aws ecr get-login-password --region $AWS_REGION | docker login --username AWS --password-stdin $ECR_URI
  build:
    commands:
      - docker build --platform linux/arm64 -t $ECR_URI:$IMAGE_TAG -t $ECR_URI:latest .
  post_build:
    commands:
      - docker push $ECR_URI:$IMAGE_TAG
      - docker push $ECR_URI:latest
```

## Build type: CodeZip vs Container

| Build | What | Max size | Pick when |
|---|---|---|---|
| **CodeZip** (AWS default/recommended) | Python zipped to S3, AWS supplies the ARM64 runtime | 250 MB zipped / 750 MB unzipped | Pure-Python agent on 3.10-3.13, no system deps. No Docker anywhere. |
| **Container** (ARM64 → ECR) | You build the image | 2 GB | System packages, large binaries, custom runtime, or any non-Python language. |

Start with CodeZip; move to Container only when a dependency forces it.

## Deploy ordering - the export-in-use trap

`cdk deploy --all` orders producers before consumers. That ordering is **backwards when you are removing a shared export**: CFN refuses to delete an export a deployed consumer still imports.

```
Cannot delete export <Name> as it is in use by <consumer-stack>.
```

Fix: deploy the **consumer first** to drop the import, then the producer.

```bash
cdk deploy <consumer-stack> --exclusively   # drops the stale import
cdk deploy <producer-stack> <others>        # now safe to remove the export
```

For example, when a runtime stops importing a value another stack exports (it now reads it directly): deploying the runtime first clears the import, then the exporting stack can drop the export.

## Versioning / promotion

- `CreateAgentRuntime` → v1 + DEFAULT endpoint.
- Each artifact change on redeploy → new immutable version; DEFAULT auto-advances.
- Named endpoints pin to a version → blue/green lever.
- Always tag images by commit SHA (`git rev-parse --short HEAD`), never deploy IaC pointing at `:latest`, so each version keeps a reproducible image.

## CI/CD stage shape

No official GitHub Actions / CodePipeline template exists in AWS docs (as of 2026-06-05). Assemble from verified pieces:

1. **Build** - CodeBuild builds ARM64 image, pushes `:$GIT_SHA` to ECR.
2. **Deploy** - `cdk deploy -c agent_image_uri=<repo>:$GIT_SHA` (consumer-first if removing an export).
3. **Smoke test** - invoke the deployed runtime (`post_deploy_eval.py`) and gate on `all_passed: true`.
4. **Promote** - move the named/production endpoint to the new version only after the smoke test passes.

Auth for the CI role: prefer GitHub OIDC over static keys; scope the deployer policy per `references/iam-security.md`.

## Quick commands (a person's, except the synth)

```bash
# Build image only (no deploy), prints the :$GIT_SHA URI
python scripts/deploy_codebuild.py --skip-deploy

# Synth all stacks with the repository's installed CLI, expect zero deprecation warnings (offline: the agents run this)
JSII_SILENCE_WARNING_UNTESTED_NODE_VERSION=1 node_modules/.bin/cdk synth -c environment=dev

# Smoke-test the live runtime
python scripts/post_deploy_eval.py --runtime-arn "$RUNTIME_ARN" --region "$REGION"
```

`JSII_SILENCE_WARNING_UNTESTED_NODE_VERSION=1` suppresses the cosmetic "untested Node version" jsii warning on newer Node.
