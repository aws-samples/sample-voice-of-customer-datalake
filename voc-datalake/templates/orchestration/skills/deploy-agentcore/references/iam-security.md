# AgentCore IAM and Security

Least-privilege two-role model plus the pre-deploy security gate. Source: AgentCore runtime permissions guide and a validated project's CDK stack.

## Two-role split

Never let one role both build and run. Separate by trust principal.

| Role | Trusted principal | Job |
|---|---|---|
| Runtime execution role | `bedrock-agentcore.amazonaws.com` | What the running agent can do (invoke models, read data, log). |
| CodeBuild service role | `codebuild.amazonaws.com` | Build the ARM64 image, push to ECR, read S3 source. |
| Deployer/caller role (CI) | your CI OIDC / human | Run CDK + CodeBuild; `iam:PassRole` to the two roles above. |

## Execution role trust - confused-deputy guards (mandatory)

Pre-create the role; do not let the construct auto-generate it without these conditions.

```python
execution_role = iam.Role(
    self, "AgentRuntimeRole",
    role_name=f"agent-eval-runtime-role-{env_name}",
    assumed_by=iam.ServicePrincipal(
        "bedrock-agentcore.amazonaws.com",
        conditions={
            "StringEquals": {"aws:SourceAccount": self.account},
            "ArnLike": {"aws:SourceArn":
                f"arn:aws:bedrock-agentcore:{self.region}:{self.account}:runtime/*"},
        },
    ),
)
```

`aws:SourceAccount` + `aws:SourceArn` together stop a cross-account caller from tricking the service into using your role.

## Execution role permissions (least-privilege)

| Need | Actions | Resource scope |
|---|---|---|
| Pull image | `ecr:BatchGetImage`, `ecr:GetDownloadUrlForLayer`, `ecr:GetAuthorizationToken` | the exact repo (use `ecr_repo.grant_pull(role)`) |
| Invoke model | `bedrock:InvokeModel`, `...WithResponseStream`, `bedrock:Converse`, `...Stream` | specific model + inference-profile ARNs - **never `*`** |
| Logs | `logs:CreateLogGroup/Stream`, `logs:PutLogEvents` | `arn:aws:logs:*:*:log-group:/aws/bedrock-agentcore/runtimes/*` |
| Tracing | `xray:PutTraceSegments`, `xray:PutTelemetryRecords`, `xray:GetSampling*` | `*` (X-Ray API has no resource-level scoping) |
| Metrics | `cloudwatch:PutMetricData` | `*` **with** condition `StringEquals cloudwatch:namespace = "bedrock-agentcore"` |
| App data | `s3:GetObject` / `dynamodb:GetItem`,`Query` | named bucket prefix / named table ARN only |

Bedrock model ARN shape (cross-region inference profile + foundation model):

```python
resources=[
    f"arn:aws:bedrock:{self.region}:{self.account}:inference-profile/eu.anthropic.claude-sonnet-4-6",
    "arn:aws:bedrock:*::foundation-model/anthropic.claude-sonnet-4-6",
    "arn:aws:bedrock:*::foundation-model/amazon.titan-embed-text-v2:0",
]
```

## CodeBuild service role permissions

- ECR push scoped to the agent repo(s).
- `logs:*` scoped to `/aws/codebuild/<project>-*`.
- `s3:GetObject` scoped to the source bucket `*-codebuild-src-*/*`.

## Deployer/caller role (CI)

- IAM role management scoped to the `*AgentCore*` / project role names.
- CodeBuild project CRUD scoped to the agent build projects.
- ECR + S3 scoped to the agent repo/bucket.
- `iam:PassRole` only to the execution + CodeBuild roles.
- Prefer GitHub OIDC over long-lived keys. (OIDC trust example not in AWS docs as of 2026-06-05 - wire the standard `token.actions.githubusercontent.com` provider with `sub` condition.)

## Pre-deploy security gate (block deploy on any NO)

- [ ] Authorizer configured (IAM / Cognito / JWT) - no unauthenticated runtime
- [ ] Trust policy has `aws:SourceAccount` + `aws:SourceArn` guards
- [ ] `bedrock:InvokeModel*` scoped to specific ARNs, not `*`
- [ ] ECR pull granted to exec role for the exact repo
- [ ] S3/DynamoDB grants scoped to named ARNs
- [ ] Logs scoped to `/aws/bedrock-agentcore/runtimes/*`; metrics gated by namespace condition
- [ ] Build role ≠ run role
- [ ] No `Action: "*"` or `Resource: "*"` except where the service forces it (X-Ray), and document why

## Common findings

- Auto-created exec role missing source-arn guard → confused-deputy exposure.
- `bedrock:InvokeModel` on `*` → flagged by security scanners; scope it.
- One mega-role doing build + run → privilege bleed; split it.
