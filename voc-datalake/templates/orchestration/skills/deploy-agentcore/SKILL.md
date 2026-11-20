---
name: deploy-agentcore
description: "Writes the infrastructure and code for an agent on Amazon Bedrock AgentCore Runtime: the stable CDK L2, ARM64 image builds, least-privilege IAM. Read it when writing AgentCore IaC, its build pipeline or its smoke test; the deploy itself is a person's."
source: "ai-skill-factory 2.0.0 (Amit Deol), skills/deploy-agentcore"
license: MIT
adapted: "The run never builds, pushes or deploys: the image build, the dependency-ordered deploy and the live smoke test became code the agent writes (the build pipeline, the stack, the smoke-test script) and steps its finish hands to a person, in order. Validation is offline (cdk synth and tests). Discovery uses run's grep and read_file. The report is the finish summary; description and emphasis reworded for Claude 5.5 skill discovery"
---

Write the infrastructure and code that put the agent your task names on Amazon Bedrock AgentCore Runtime.

If your task names no path, find the agent entrypoint (`agent.py` / `app.py` with `BedrockAgentCoreApp`) and the
CDK stack directory with `list_files` and `read_file`.

The run never builds an image, pushes one or deploys: the sandbox has no Docker, no network and no AWS account.
You write the stack, the build pipeline's code and the smoke test, validate them offline (`cdk synth`, the tests),
and your finish lists what a person runs, in order (Steps 6 and 7).

## Step 1: Confirm Construct and Tooling Choice

AgentCore has three deployment surfaces. Pick one and do not mix them.

| Surface | Module / Tool | Status | Use when |
|---|---|---|---|
| Stable CDK L2 | `aws_cdk.aws_bedrockagentcore` (ships **inside** `aws-cdk-lib`) | **Current - use this** | You own a CDK app and want IaC review/diff/rollback |
| Alpha CDK L2 | `aws_cdk.aws_bedrock_agentcore_alpha` (separate pip pkg) | **DEPRECATED** | Never for new code - migrate off it |
| AgentCore CLI | `@aws/agentcore` (npm, CDK-backed) | Current | Quickstart / no existing CDK app |
| Starter toolkit | `bedrock-agentcore-starter-toolkit` (pip) | **DEPRECATED** | Never for new projects |

**Default: stable CDK L2.** The alpha module and the stable in-library module share an identical API surface, so migration is a one-line import swap. See `references/cdk-constructs.md` for the verified API and the migration diff.

If the project has no CDK app and the task asks for the fastest path, the `@aws/agentcore` npm CLI is the
alternative (`agentcore create` then `agentcore deploy`, a person's commands); it is CDK-backed under the hood.

## Step 2: Validate the Agent Entrypoint

The container must expose the AgentCore contract or deployment fails at runtime.

- [ ] Entrypoint uses `BedrockAgentCoreApp` with an `@app.entrypoint` handler
- [ ] Handler signature is `def handler(payload: dict) -> dict | str` (or async)
- [ ] `app.run()` is the module's `__main__` (binds `0.0.0.0:8080`, serves `/invocations` + `/ping`)
- [ ] No reliance on local files written at request time - sessions run in ephemeral microVMs
- [ ] Long work tolerates the per-request timeout; stream when the protocol is HTTP

Find them with `run` `["grep", "-rn", "-e", "BedrockAgentCoreApp", "-e", "@app.entrypoint", "-e", "app.run()", "<agent dir>"]`.

## Step 3: The ARM64 Image Build (code you write, a build a person runs)

AgentCore Runtime runs **ARM64 (Graviton)** containers. A non-ARM64 image fails with `exec format error`. Prefer AWS CodeBuild: it removes the cross-architecture question entirely. Building locally is acceptable only on an arm64 host that can push to ECR, and emulated `--platform linux/arm64` builds on x86 are slow and a common source of silent failures.

Build flow (S3 source upload → CodeBuild ARM64 → ECR push):
1. Zip the agent source dir.
2. Upload to the CodeBuild source bucket.
3. Run the CodeBuild project (buildspec does `docker build --platform linux/arm64`, pushes `:$GIT_SHA` and `:latest`).
4. Capture the immutable `:$GIT_SHA` image URI - pass that to CDK, not `:latest`.

The build is driven from the project's own deploy script (illustrated as `scripts/deploy_codebuild.py`); when the
task asks for one, write it. `references/build-pipeline.md` gives the full buildspec and boto3 calls. A person runs
it (`python scripts/deploy_codebuild.py --skip-deploy` builds the image only and prints its URI).

`CodeZip` (S3 zip, no Docker anywhere) is AWS's default/recommended build type for simple agents. Use a `Container` build when you need system packages, large binaries, or a custom runtime. See `references/build-pipeline.md`.

## Step 4: Wire the Stable CDK Runtime Construct

Minimum viable runtime, IAM auth, public network, ECR image built in Step 3:

```python
from aws_cdk.aws_bedrockagentcore import (
    AgentRuntimeArtifact, ProtocolType, Runtime,
    RuntimeAuthorizerConfiguration, RuntimeNetworkConfiguration,
)

runtime = Runtime(
    self, "AgentRuntime",
    runtime_name=f"agent_eval_runtime_{env_name}",
    agent_runtime_artifact=AgentRuntimeArtifact.from_image_uri(image_uri),
    execution_role=execution_role,                     # pre-created, Step 5
    authorizer_configuration=RuntimeAuthorizerConfiguration.using_iam(),
    network_configuration=RuntimeNetworkConfiguration.using_public_network(),
    protocol_configuration=ProtocolType.HTTP,
)
endpoint = runtime.add_endpoint(f"agent_eval_endpoint_{env_name}")
```

- `from_image_uri` does **not** auto-grant ECR pull - grant it explicitly (Step 5).
- Authorizer options: `using_iam()`, `using_cognito(pool, [client])`, `using_jwt(...)`, `using_o_auth(...)`. Never leave a runtime unauthenticated.
- The `DEFAULT` endpoint auto-tracks the latest version. For blue/green, add a named endpoint pinned to a version. See `references/cdk-constructs.md`.

## Step 5: Apply the Security Gate (mandatory, in the code you submit)

AgentCore Runtime is internet-reachable, so the auth gate applies to the stack before anyone deploys it. All must
be YES:

- [ ] Authorizer set (IAM / Cognito / JWT) - no unauthenticated runtime endpoint
- [ ] Execution role trust policy carries confused-deputy guards: `aws:SourceAccount == this.account` **and** `aws:SourceArn` ArnLike `arn:aws:bedrock-agentcore:{region}:{account}:runtime/*`
- [ ] `bedrock:InvokeModel*` scoped to specific model / inference-profile ARNs - never `Resource: "*"`
- [ ] ECR pull granted to the exec role for the exact repo (`ecr_repo.grant_pull(execution_role)`)
- [ ] Data-store grants (S3 / DynamoDB) scoped to named resource ARNs, least-privilege
- [ ] Logs scoped to `/aws/bedrock-agentcore/runtimes/*`; X-Ray + `cloudwatch:PutMetricData` gated by namespace condition
- [ ] Two-role split: a CodeBuild service role (build) distinct from the runtime execution role (run)

If any answer is NO, **fix it before you submit.** Full role policies in `references/iam-security.md`. Sources for the AWS-specific facts in this skill: `references/sources.md`.

## Step 6: The Deploy Order (a person's, listed in your finish)

A person deploys, in dependency order:

```bash
GIT_SHA=$(git rev-parse --short HEAD)
IMAGE_URI="$ACCOUNT.dkr.ecr.$REGION.amazonaws.com/agent-eval-runtime:$GIT_SHA"
JSII_SILENCE_WARNING_UNTESTED_NODE_VERSION=1 \
  npx aws-cdk deploy <stacks> --require-approval never \
  -c environment=$ENV -c agent_image_uri=$IMAGE_URI
```

**CloudFormation export-ordering trap:** when you remove a cross-stack export that a deployed consumer still imports, `--all` ordering fails with *"Cannot delete export ... as it is in use."* Deploy the **consumer stack first** (`cdk deploy <consumer> --exclusively`) to drop the import, then deploy the producer. See `references/build-pipeline.md`.

Versioning recap: `CreateAgentRuntime` → v1 + DEFAULT endpoint; every `UpdateAgentRuntime` mints a new immutable version; DEFAULT auto-advances, named endpoints pin. Always tag images by commit SHA so old versions keep their images.

## Step 7: The Smoke Test (written by you, run by a person)

The live runtime is invoked end-to-end after the deploy, by the project's smoke-test script (shown as
`scripts/post_deploy_eval.py`; `references/build-pipeline.md` gives the `bedrock-agentcore` invoke call). When the
task asks for one, write it and unit-test its parsing offline; a person runs it:

```bash
python scripts/post_deploy_eval.py --runtime-arn "$RUNTIME_ARN" --region "$REGION"
```

- `runtimeSessionId` must be 33 to 256 chars.
- Use backend-independent smoke cases (e.g. a greeting + a safety check) so the test isn't gated on data fixtures.
- Confirm CloudWatch alarms/dashboard exist and the runtime reached `READY`/`ACTIVE`.
- Gate on the result: `all_passed: true` before promoting a named endpoint.

## Step 8: Report

Put this in your `finish` summary (the live fields are a person's to fill after their deploy):

```
## AgentCore Deployment Report

Runtime ARN:   <arn>
Image:         <repo>:<git-sha>   (ARM64, CodeBuild)
Construct:     aws_cdk.aws_bedrockagentcore (stable L2)
Auth:          IAM | Cognito | JWT
Security gate: PASS (8/8)
Smoke test:    all_passed=<bool>  (<n> cases)
Stacks:        <list> - all *_COMPLETE
Endpoints:     DEFAULT -> v<n>; <named> -> v<n>
```

Flag any UNVERIFIED assumption and any security-gate item that was waived. Gates you ran: `cdk synth` and the
tests, with their exit codes; the deploy, the smoke test and the endpoint promotion are a person's.
