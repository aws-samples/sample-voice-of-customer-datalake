# Stable AgentCore CDK Constructs

Verified API surface of `aws_cdk.aws_bedrockagentcore` (ships inside `aws-cdk-lib`, no separate install). Confirmed against `aws-cdk-lib>=2.241.0` on 2026-06-05.

## Stable vs Alpha

| | Stable | Alpha |
|---|---|---|
| Import | `from aws_cdk.aws_bedrockagentcore import ...` | `from aws_cdk.aws_bedrock_agentcore_alpha import ...` |
| Install | bundled in `aws-cdk-lib` | separate `aws-cdk-aws-bedrock-agentcore-alpha` pip pkg |
| Status | current | **DEPRECATED** |
| API surface | identical to alpha | identical to stable |

**Migration is a one-line import swap.** No constructor or method signatures change. After swapping, remove the alpha dependency from every `pyproject.toml` (root + cdk) and run `cdk synth` - expect zero deprecation warnings and unchanged `AWS::BedrockAgentCore::Runtime` + `AWS::BedrockAgentCore::RuntimeEndpoint` output.

```diff
-from aws_cdk.aws_bedrock_agentcore_alpha import (
+from aws_cdk.aws_bedrockagentcore import (
     AgentRuntimeArtifact, ProtocolType, Runtime,
     RuntimeAuthorizerConfiguration, RuntimeNetworkConfiguration,
 )
```

## Core classes

| Class | Purpose |
|---|---|
| `Runtime` | L2 runtime construct. Renders `CfnRuntime`. |
| `RuntimeEndpoint` | Named endpoint; or use `runtime.add_endpoint(...)`. |
| `AgentRuntimeArtifact` | The deployable artifact (image / code / s3). |
| `RuntimeAuthorizerConfiguration` | Inbound auth on the runtime. |
| `RuntimeNetworkConfiguration` | Public vs VPC networking. |
| `ProtocolType` | Wire protocol the agent speaks. |
| `CfnRuntime`, `CfnRuntimeEndpoint` | L1 escape hatch when L2 lacks a prop. |

## `AgentRuntimeArtifact` factories

| Factory | Use when |
|---|---|
| `from_image_uri(uri)` | Image already in ECR (built by CodeBuild). **Does NOT grant ECR pull** - call `ecr_repo.grant_pull(execution_role)` yourself. |
| `from_ecr_repository(repo, tag)` | CDK-managed ECR repo object. |
| `from_asset(path)` | Local Docker bundling at synth - avoid: the synth then needs Docker, which the agents' sandbox does not have. |
| `from_code_asset(...)` / `from_s3(...)` | CodeZip path - Python zipped to S3, no container. |

## `RuntimeAuthorizerConfiguration` factories

| Factory | Auth |
|---|---|
| `using_iam()` | SigV4 / IAM - service-to-service default. |
| `using_cognito(user_pool, [client])` | Cognito JWT. |
| `using_jwt(...)` | Generic JWT (custom issuer + audience). |
| `using_o_auth(...)` | OAuth2 provider. |

Never deploy a runtime without one of these. There is no "no auth" production posture.

## `RuntimeNetworkConfiguration`

| Factory | Networking |
|---|---|
| `using_public_network()` | AWS-managed egress; simplest. |
| `using_vpc(vpc, subnets=...)` | Private VPC egress - use when the agent calls VPC-only data stores. |

## `ProtocolType`

`HTTP` (request/response + streaming), `MCP`, `A2_A` (A2A), `AGUI`. Match the protocol your `BedrockAgentCoreApp` serves; HTTP is the common case.

## Versioning and blue/green

- `CreateAgentRuntime` → **Version 1 + DEFAULT endpoint** automatically.
- Each `UpdateAgentRuntime` (a CDK redeploy that changes the artifact) → a new **immutable version**.
- The `DEFAULT` endpoint **auto-advances to the latest version**.
- A **named endpoint pins** to a chosen version until you explicitly move it - this is the blue/green lever.

```python
prod = runtime.add_endpoint("production")   # pin to a known-good version
# DEFAULT keeps tracking latest for canary/testing; promote prod after smoke test
```

State machine: `CREATING → READY` (or `CREATE_FAILED`) `→ UPDATING → READY`.

## Pitfalls

- `from_image_uri` not granting ECR pull is the most common silent failure - the runtime can't pull and never reaches READY.
- Don't tag the artifact `:latest` in IaC; pin the commit SHA so each version retains a reproducible image.
- The L2 covers Runtime/Endpoint well. For props it doesn't expose, drop to `CfnRuntime` rather than reverting to the alpha module.
