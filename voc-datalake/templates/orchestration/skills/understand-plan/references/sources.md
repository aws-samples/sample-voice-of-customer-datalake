# Sources

Non-obvious claims in this skill, verified against primary sources. Checked 2026-10-28.

| Claim | Source | Checked |
|---|---|---|
| `AWS::BedrockAgentCore::Runtime` and `AWS::BedrockAgentCore::RuntimeEndpoint` are real CloudFormation resource types (added September 2025) | https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/AWS_BedrockAgentCore.md | 2026-10-28 |
| `AWS::BedrockAgentCore::ResourcePolicy` exists and currently applies only to AgentCore Runtime and Gateway (useful context for L400 IAM/resource-policy modeling, not yet in the skill's table) | https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-resource-bedrockagentcore-resourcepolicy.md | 2026-10-28 |

The resource-type -> AWS-service -> C4-role mapping table in `extraction.md` is a living
reference. Bedrock AgentCore and Bedrock Agents ship new CloudFormation resource types
often; re-check `AWS::BedrockAgentCore::*` and `AWS::Bedrock::*` against the CloudFormation
Template Reference before relying on a type that is not in this table.
