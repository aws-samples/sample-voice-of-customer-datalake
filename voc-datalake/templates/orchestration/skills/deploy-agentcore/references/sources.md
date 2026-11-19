# Sources

Non-obvious claims verified against AWS documentation. Checked 2026-10-28 (re-verifying
claims previously dated 2026-06-05 in cdk-constructs.md and build-pipeline.md; no drift
found).

| Claim | Source | Checked |
|---|---|---|
| `aws_cdk.aws_bedrockagentcore` ships inside `aws-cdk-lib` as the stable L2 module; `aws_bedrock_agentcore_alpha` is the deprecated separate package | https://constructs.dev/packages/aws-cdk-lib/v/2.275.0?submodule=aws_bedrockagentcore | 2026-10-28 |
| Container image max 2 GB; direct-code (CodeZip) package max 250 MB compressed / 750 MB uncompressed; direct code supports Python 3.10-3.13 only | https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/bedrock-agentcore-limits.html, https://aws.amazon.com/blogs/machine-learning/iterate-faster-with-amazon-bedrock-agentcore-runtime-direct-code-deployment/ | 2026-10-28 |
| AgentCore Runtime requires ARM64 (Graviton) containers | https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/ (runtime container requirements) | 2026-06-05 (prior check), re-confirmed 2026-10-28 |
| Supported wire protocols: HTTP, MCP, A2A | https://github.com/aws-samples/serverless-patterns/tree/main/cloudfront-agentcore-runtime-cdk | 2026-10-28 |
