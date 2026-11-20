---
name: cdk-doctor
description: "Diagnoses failed AWS CDK or CloudFormation deployments and crashing ECS tasks from the error text, and validates infrastructure changes offline: failure patterns, Fargate sizes, AMI and image choice. Read it when a task quotes a deploy failure or before submitting an IaC change."
source: "ai-skill-factory 2.0.0 (Amit Deol), skills/cdk-doctor"
license: MIT
adapted: "The agents have no AWS account and never deploy: diagnosis starts from the error text the task or issue quotes (stopped reasons, stack events, target health), the AWS CLI commands became what to ask a person for, and the deploy-and-monitor and post-deployment steps (with the monitor sub-agent) are dropped. Validation is offline (synth, cfn-lint, nag, guard). Slash references name library skills; the GPU skill reference is dropped; description and emphasis reworded for Claude 5.5 skill discovery"
---

Diagnose the CDK deployment failure your task names, and fix it in code.

Debugging skill. For writing or restructuring CDK code, use the `cdk-engineer` skill, which owns the construct
ladder, version pinning, and escape hatches. Root-cause method: the `systematic-debugging` skill.

You have no AWS account and the run never deploys. The evidence is what your task and the run's issue quote: the
CloudFormation events, an ECS stopped reason, a target's health reason, a log line. Match it against the tables
below, fix the cause in the code, validate offline (Step 1), and say in your finish what a person should check
after they deploy. When the evidence is missing, `finish` naming the exact command output you need (the commands
are below), rather than guess.

## Step 1: Pre-Deployment Validation (offline)

Catches most failures before anyone deploys.

| Check | Command | Catches |
|---|---|---|
| Synthesize | `cdk synth` | Import errors, construct issues, asset bundling |
| Template lint | `cfn-lint` on each template under `cdk.out/` | Invalid properties, missing required fields |
| CDK-nag | Add `Aspects.of(app).add(new AwsSolutionsChecks());` and run `cdk synth` | IAM over-permissions, missing encryption, unencrypted logs at synthesis time |
| Policy guard | `cfn-guard validate --data template.json --rules policy.guard` | Compliance violations |

`cdk diff` needs the deployed account: a person runs it before they deploy, and your test of the stateful
resources' logical IDs (the `cdk-engineer` skill, Step 6) stands in for its replacement check.

### Fargate CPU/Memory Validation

Fargate rejects invalid combinations at registration time. Validate BEFORE deploying:

| CPU (units) | Valid Memory (MiB) | OS |
|---|---|---|
| 256 (.25 vCPU) | 512, 1024, 2048 | Linux |
| 512 (.5 vCPU) | 1024-4096 (1 GB increments) | Linux |
| 1024 (1 vCPU) | 2048-8192 (1 GB increments) | Linux, Windows |
| 2048 (2 vCPU) | 4096-16384 (1 GB increments) | Linux, Windows |
| 4096 (4 vCPU) | 8192-30720 (1 GB increments) | Linux, Windows |
| 8192 (8 vCPU) | 16384-61440 (4 GB increments) | Linux, platform 1.4.0+ |
| 16384 (16 vCPU) | 32768-122880 (8 GB increments) | Linux, platform 1.4.0+ |

Container memory sum must not exceed task-level memory. Full table:
[ECS task definition parameters for Fargate](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/task_definition_parameters.html).

### Pre-Deploy Checklist

- [ ] Stateful resources' logical IDs asserted unchanged (a person's `cdk diff` shows no replacement)
- [ ] ECS task def: CPU/memory combo is valid for Fargate
- [ ] Security groups allow traffic between ALB and containers
- [ ] VPC has NAT gateway or VPC endpoints for ECR access (private subnets)
- [ ] IAM task role has permissions for all AWS services the container calls
- [ ] Container health check endpoint returns 200
- [ ] Environment variables and secrets configured
- [ ] `env: { account, region }` set on stacks (prevents cross-region failures)

## Step 2: ECS Debugging

When ECS tasks fail, the stopped reason comes FIRST. These are the commands a person runs to get it (name them in
your finish when the issue does not quote their output):

```bash
# Find failed tasks
aws ecs list-tasks --cluster CLUSTER --desired-status STOPPED --query 'taskArns[0:5]'

# Get stopped reason
aws ecs describe-tasks --cluster CLUSTER --tasks TASK_ARN \
  --query 'tasks[0].[stoppedReason,stopCode,containers[0].reason]'
```

### ECS Failure Pattern → Fix

| Stopped Reason | Root Cause | Fix |
|---|---|---|
| `CannotPullContainerError` | ECR unreachable (no NAT/VPC endpoint) or image missing | Add NAT gateway or ECR VPC endpoint; verify image tag exists |
| `OutOfMemoryError` | Container exceeded task memory | Increase task memory or optimize container |
| `Task failed ELB health checks` | Health check endpoint not returning 200 | Fix health check path, increase deregistration delay |
| `ResourceNotFoundException` | Secrets Manager/SSM parameter missing | Create the secret/parameter before deploying |
| `unable to place task` | No instances with enough CPU/memory | Increase desired capacity or use larger instance type |
| `EssentialContainerExited` | Application crashed on startup | Check CloudWatch Logs for container stdout/stderr |

### CloudWatch Logs (a person's commands)

```bash
# Get log group from task definition
aws ecs describe-task-definition --task-definition TASK_DEF \
  --query 'taskDefinition.containerDefinitions[0].logConfiguration.options."awslogs-group"'

# Read recent logs
aws logs filter-log-events --log-group-name LOG_GROUP \
  --filter-pattern "ERROR" --limit 20 \
  --query 'events[*].[timestamp,message]'
```

### ALB Target Health (a person's commands)

```bash
aws elbv2 describe-target-health --target-group-arn TG_ARN \
  --query 'TargetHealthDescriptions[*].[Target.Id,TargetHealth.State,TargetHealth.Reason,TargetHealth.Description]'
```

| Health Reason | Meaning | Fix |
|---|---|---|
| `Target.ResponseCodeMismatch` | Container returns wrong status code | Fix health check path or expected codes |
| `Target.Timeout` | Container not responding in time | Increase timeout or fix slow startup |
| `Target.FailedHealthChecks` | Consecutive failures exceeded threshold | Check security groups, container port |
| `Elb.InternalError` | ALB issue | Check ALB logs, security groups |

## Step 3: AMI and Image Intelligence

### AMI Discovery via SSM

| AMI Type | SSM Parameter Path |
|---|---|
| Amazon Linux 2023 | `/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64` |
| ECS-optimized (AL2) | `/aws/service/ecs/optimized-ami/amazon-linux-2/recommended` |
| ECS-optimized (AL2023) | `/aws/service/ecs/optimized-ami/amazon-linux-2023/recommended` |
| ECS GPU-optimized | `/aws/service/ecs/optimized-ami/amazon-linux-2/gpu/recommended` |
| EKS-optimized | `/aws/service/eks/optimized-ami/{k8s-version}/amazon-linux-2/recommended` |

Resolving a parameter needs the account: in code, resolve it at synth with `cachedInContext` (below), whose value
`cdk.context.json` records.

### CDK AMI Patterns

```typescript
// Resolve via SSM. Without cachedInContext the parameter is re-read every deployment,
// which replaces your instances whenever a new AMI ships.
ec2.MachineImage.fromSsmParameter(
  '/aws/service/ecs/optimized-ami/amazon-linux-2/recommended',
  { cachedInContext: true },   // records the AMI ID in cdk.context.json
);

// Pin to specific AMI (for reproducibility)
ec2.MachineImage.genericLinux({ 'us-east-1': 'ami-0c55b159cbfafe1f0' });
```

### Version-First Principle

Before installing any software on an instance or container:
1. Check what the base AMI/image already includes
2. Only upgrade if the existing version is incompatible
3. Pin versions in Dockerfile/user data to prevent drift

Full AMI inspection, CUDA/GPU compatibility, container image patterns: `references/ami-intelligence.md`.

## Step 4: Common CloudFormation Failures

| Error Pattern | Cause | Fix |
|---|---|---|
| `Circular dependency` | Resources reference each other | Break cycle with explicit security group ingress rules |
| `Export EXPORT_NAME cannot be deleted` | Another stack imports this export | Update importing stack first |
| `Resource limit exceeded` | Hit account service quota | Request quota increase |
| `UPDATE_ROLLBACK_FAILED` | Rollback itself failed | A person runs `aws cloudformation continue-update-rollback --stack-name STACK`; no code change fixes it |
| `The security token included in the request is invalid` | Expired credentials | The deploying person's credentials; no code change fixes it |

## Step 5: What to Hand Back

Your `finish` says: the cause, matched to its evidence; the code change; the offline checks and their exit codes;
and what a person checks after they deploy (the ECS service's running count against its desired count, the
targets' health, the log group's errors in the minutes after).

For IAM and security policy validation, see the `aws-security` skill. For AMI and container image selection, see
`references/ami-intelligence.md`. For Docker build and image hardening, see the `docker-ops` skill.
