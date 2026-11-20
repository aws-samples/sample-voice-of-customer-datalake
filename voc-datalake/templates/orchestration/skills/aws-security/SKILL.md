---
name: aws-security
description: "Sets AWS security policy for IaC (CDK, CloudFormation, Terraform, SAM, AWS SDK) touching IAM, S3, Lambda auth, Cognito, CORS, VPC, KMS or Bedrock inference profiles. Read it when writing or reviewing IaC; application-layer code is the security-audit skill's."
source: "ai-skill-factory 2.0.0 (Amit Deol), skills/aws-security"
license: MIT
adapted: "The spec-loader step reads SECURITY.md and INFRA.md with read_file. The policy simulation check is a person's (it needs the account). Fixes are the builder's, within its change; reviewers write findings. An internal scanner's name in the design notes is replaced by a generic security scanner. Slash references name library skills; description reworded for Claude 5.5 skill discovery"
---

Audit the infrastructure code your task names, or your own change, against AWS security practice.

Policy skill. For how to write the infrastructure in the first place, use the `cdk-engineer` or the
`terraform-engineer` skill, which prefer built-in grants and modules over hand-written policy.

With no path named, look for CDK (`cdk/`, `lib/`), CloudFormation (`*.template.json`, `*.yaml`), Terraform (`*.tf`),
or AWS SDK code with `list_files`; a reviewer starts from the files the patch changes.

## Step 0: Load Project Specs

If the repository has a SECURITY.md (or INFRA.md), read it with `read_file` for its rules; else the built-in rules
below.

SECURITY.md is the canonical source for: Lambda auth rules, S3 public access, IAM wildcard policy, Cognito flows, CORS, EC2 IMDSv2, secrets storage, and CodeBuild policy. Cite SECURITY.md in findings (e.g., *"Function URL with AuthType NONE forbidden per SECURITY.md:8"*).

## Step 1: Detect IaC Stack

Read config files to determine: CDK (Python/TypeScript), CloudFormation, Terraform, Pulumi, or raw SDK.

## Step 2: Security Policy Checks

### AWS Service Naming (in comments/docstrings)
- [ ] First mention per file uses full official name ("Amazon Bedrock AgentCore", "Amazon DynamoDB", "AWS Lambda", "Amazon API Gateway")
- [ ] CDK-nag suppression reasons use full service names
- [ ] boto3 client identifiers are fine as-is in code. Add a comment mapping to the full service name

### OpenAPI Specs
- [ ] OpenAPI specs include a global `security` block requiring authentication on all endpoints
- [ ] `components.securitySchemes` defines the auth method (e.g., `sigv4` for IAM, `bearerAuth` for JWT)
- [ ] Response schemas include `maxItems` on array properties to prevent unbounded responses

### Security Documentation
- [ ] `SECURITY.md` exists with threat model, data classification, shared responsibility model
- [ ] Module docstrings for infra code document security decisions (auth, encryption, network)
- [ ] CDK-nag suppressions all have documented justifications
- [ ] For CDK projects, integrate `cdk-nag` (Apache 2.0) to validate security policies at synthesis time. Suppress findings only with documented justification.

### IAM (Least Privilege)
- [ ] No Action: `*` in any policy
- [ ] No Resource: `*` except where AWS requires it (CloudWatch PutMetricData, CloudWatch Logs)
- [ ] Document every Resource: `*` with a comment explaining why
- [ ] Global Bedrock inference profiles use an empty region field in the foundation-model ARN (`arn:aws:bedrock:::foundation-model/<model-id>`), not a literal wildcard. Grant the inference-profile ARN, the in-region model ARN, and the global model ARN as three separate statements, each scoped with `aws:RequestedRegion` and `bedrock:InferenceProfileArn` conditions. Never substitute a bare `Resource: "*"` for this
- [ ] IAM policy simulation (`simulate-principal-policy`, a person's check: it needs the account) also evaluates SCPs: pass `aws:RequestedRegion` in `--context-entries` or a region-guard SCP reports `explicitDeny` on every regional action
- [ ] No inline policies on Lambda roles (use managed + grant methods)
- [ ] Only AWSLambdaBasicExecutionRole as managed policy (no AdministratorAccess, PowerUser)

### Secrets Management
- [ ] API keys, passwords, tokens in SSM Parameter Store (SecureString) or Secrets Manager
- [ ] Never in Lambda environment variables as plaintext
- [ ] Never in CDK code as string literals
- [ ] SSM parameters holding secrets use type `SecureString` with a CMK. Standard tier is encrypted; Advanced is only for values over 4 KB, over 10,000 parameters, or parameter policies, and it costs extra
- [ ] WithDecryption=True when reading secrets

### S3 Buckets
- [ ] block_public_access=BLOCK_ALL on every bucket
- [ ] enforce_ssl=True (deny non-HTTPS)
- [ ] encryption enabled (S3_MANAGED minimum, KMS preferred for prod)
- [ ] versioned=True for data buckets
- [ ] Lifecycle rules for cost management
- [ ] removal_policy gated on environment (DESTROY only for dev)
- [ ] auto_delete_objects only for dev

### DynamoDB
- [ ] Encryption enabled (AWS_MANAGED minimum, CUSTOMER_MANAGED for prod)
- [ ] Point-in-time recovery enabled
- [ ] Removal policy gated on environment
- [ ] PAY_PER_REQUEST billing for variable workloads

### Lambda
- [ ] Explicit timeout set (not default 3s or unbounded)
- [ ] Explicit memory_size set
- [ ] Log group with retention policy
- [ ] Log group has encryption comment (default AWS-managed; note CMK option for production)
- [ ] reserved_concurrent_executions for production (prevent runaway scaling)
- [ ] No environment variables containing secrets

### Key Management
- [ ] Key rotation policy documented in SECURITY.md or AWS_SECURITY_GUIDELINES.md
- [ ] Customer-managed KMS key examples provided for production (DynamoDB, CloudWatch Logs, Secrets Manager)
- [ ] Secrets Manager rotation schedule documented (30-90 day recommendation)
- [ ] `aws kms enable-key-rotation` command in hardening documentation

### API Gateway
- [ ] API key required on endpoints
- [ ] Usage plan with throttling (rate_limit + burst_limit)
- [ ] Quota configured (daily/monthly limits)
- [ ] CORS restricted to specific origins in production (not `*`)
- [ ] Access logging enabled
- [ ] WAF attached for production

### Networking
- [ ] VPC endpoints for S3/DynamoDB if Lambda runs in VPC
- [ ] Security groups follow least-privilege (no 0.0.0.0/0 ingress)
- [ ] Private subnets for compute, public only for load balancers

### Removal Policies
- [ ] Every DESTROY policy gated on environment check
- [ ] Pattern: `DESTROY if env == "dev" else RETAIN`
- [ ] No DESTROY in production (hard check)

## Step 3: Report

A reviewer writes each FAIL and WARN as a finding (`write_findings`); a builder puts the summary in its finish.

```
## AWS Security Policy Audit

### Summary: X FAIL / Y WARN / Z PASS

| # | Category | Check | Status | File:Line | Details |
```

## Step 4: Fix (the builder, within its change)

1. Fix all FAIL items in the code your change touches
2. Add environment gates on WARN items
3. Verify the fixes compile and synthesize (`cdk synth`, `terraform validate`, or the language's compile check)

A FAIL in code your task does not touch goes in your finish, not in your patch.

For design rationale behind each rule, see `references/design-decisions.md`.
For application-layer security (auth, input validation, dependencies), see the `security-audit` skill.
For CDK deployment validation, see the `cdk-doctor` skill.
