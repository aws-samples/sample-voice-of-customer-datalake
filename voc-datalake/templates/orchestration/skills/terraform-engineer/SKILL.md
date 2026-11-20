---
name: terraform-engineer
description: "Writes Terraform with registry modules, the repository's pinned providers and built-ins; blocks provisioners, IAM JSON strings, string-built ARNs, count where for_each belongs and destroy-recreate refactors, with an offline gate. Read it when writing or editing Terraform."
source: "ai-skill-factory 2.0.0 (Amit Deol), skills/terraform-engineer"
license: MIT
adapted: "The spec-loader step reads INFRA.md with read_file. Versions come from versions.tf and .terraform.lock.hcl, not a registry query (no network); terraform init is the dependency step. Plan, apply and destroy need state and an account the agents never have: they are a person's, and the destroy protocol is what the finish hands them. Argument checks read the installed provider schema. Slash references name library skills; description reworded for Claude 5.5 skill discovery"
---

Model the infrastructure your task asks for in Terraform, at the highest level that fits.

For IAM and encryption policy, use the `aws-security` skill. For the general no-hand-rolling ladder, the
`use-the-sdk` skill. For CDK instead of Terraform, the `cdk-engineer` skill.

The run never plans against real state, applies or destroys: you write and check the HCL offline, and a person
plans and applies it.

Grounded in the [HashiCorp style guide](https://developer.hashicorp.com/terraform/language/style)
and [module standards](https://developer.hashicorp.com/terraform/language/modules/develop/structure).
Where this skill is thinner than [antonbabenko/terraform-skill](https://github.com/antonbabenko/terraform-skill),
which is maintained by the author of `terraform-aws-modules`, its documentation goes deeper on state recovery, CI
templates, and Terratest.

## Step 0: Load Project Standards

If the repository has an INFRA.md, read it with `read_file` for approved services, regions, account layout, and
state backend. Read the existing root module: `versions.tf`, `providers.tf`, `backend` config, and any
`.terraform.lock.hcl`.

## Step 1: Take and Pin Versions

Never recall a version. Take it from the repository: `versions.tf`, the module blocks' `version`, and
`.terraform.lock.hcl` (the real provider pin); `terraform version` with `run` for the installed core. The sandbox has
no network, so a registry query is not possible: a newer version you believe exists is named in your finish as
unchecked, never written into a pin.

Anchor, verified 28 October 2026 (for orientation only; the repository's pins win):

| Component | Version |
|---|---|
| Terraform core | 1.17.0 |
| `hashicorp/aws` | 6.70.0 |
| `hashicorp/awscc` | 1.107.0 |
| `terraform-aws-modules/vpc/aws` | 6.7.3 |
| `terraform-aws-modules/eks/aws` | 21.29.0 |
| `terraform-aws-modules/lambda/aws` | 8.12.0 |

```hcl
terraform {
  required_version = "~> 1.17"
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 6.70" }
  }
}
```

Pinning strategy by component, since one rule for all three is wrong:

`~>` allows only the right-most component to increment, so `~> 1.16` permits 1.17 while
`~> 1.16.0` permits only 1.16.x. Two components float the minor, three pin the patch.

| Component | Intent | Constraint |
|---|---|---|
| Terraform runtime | Require a floor, block the next major | `required_version = "~> 1.17"` |
| Providers | Block the next major, lock file is the real pin | `version = "~> 6.70"` |
| Modules in production | Exact, no drift | `version = "6.7.2"` |
| Modules in development | Patch only | `version = "~> 6.7.0"` |

Never source a module from a git branch. Keep `.terraform.lock.hcl` in the change. Keep a provider or
runtime upgrade in its own change, separate from functional work. Use `awscc` only for resources
the `aws` provider does not yet cover.

Layout, naming, block ordering, and variable contracts follow the
[HashiCorp style guide](https://developer.hashicorp.com/terraform/language/style):
`references/style-and-layout.md`.

## Step 2: The Module Ladder

Stop at the first rung that satisfies the requirement. Record the rung in the report.

| # | Rung | Example |
|---|---|---|
| 1 | Existing module in this repo | Grep `modules/` before writing anything |
| 2 | Official registry module | `terraform-aws-modules/vpc`, `/eks`, `/rds`, `/lambda`, `/iam` |
| 3 | Provider resource with its built-in features | `aws_s3_bucket` plus the dedicated sub-resources |
| 4 | Data source for anything that already exists | `aws_ami`, `aws_ssm_parameter`, `aws_iam_policy_document` |
| 5 | Language feature | `for_each`, `dynamic`, `templatefile`, `cidrsubnet`, `optional()` |
| 6 | Local module you write | Only when the shape recurs and no registry module fits |
| 7 | `null_resource`, `local-exec`, `remote-exec` | Effectively never. Justify it in the report |

A registry module is not always right. Reject rung 2 when the module pulls in far more than
the requirement, and say why. Prefer rung 3 over a module that wraps one resource.

## Step 3: Never Hand-Roll These in Terraform

Each is a MUST finding. Use the named built-in.

| Hand-rolled | Use instead |
|---|---|
| IAM policy as a heredoc or `jsonencode` literal | `data "aws_iam_policy_document"` |
| ARN built by string interpolation | The resource attribute (`aws_s3_bucket.this.arn`) |
| Account ID, region, or partition hardcoded | `data "aws_caller_identity"`, `aws_region`, `aws_partition` |
| AMI ID as a literal | `data "aws_ami"` with owners and filters, or an SSM public parameter |
| Subnet CIDRs computed by hand | `cidrsubnet()`, or the VPC module |
| Tags repeated on every resource | `default_tags` in the provider block |
| `count` on a named or reorderable set | `for_each` over a map or set, so identity survives edits |
| Inline `ingress` and `egress` in `aws_security_group` | Separate `aws_vpc_security_group_{ingress,egress}_rule` resources |
| DynamoDB table for state locking on a new S3 backend | `use_lockfile = true`, native S3 locking |
| Config file built with `join()` and `format()` | `templatefile()` |
| `local-exec` calling the AWS CLI | The provider resource, or a data source |
| `local-exec` sleeping to wait for readiness | Resource `timeouts`, or a `wait_for` style provider argument |
| Password or key generated outside state | `random_password` plus Secrets Manager, or a data source |
| Secret value written into a variable or output | Ephemeral values and write-only arguments, `sensitive = true` |
| Destroy and recreate to rename or move a resource | `moved` block |
| Manual `terraform state rm` and re-add for imports | `import` block |
| Resource left in code and commented out | `removed` block |
| `depends_on` on everything | Implicit dependency through attribute references |

## Step 4: Built-In Features That Get Missed

All available in Terraform 1.17. Detail and version floors: `references/version-features.md`.

| Feature | Replaces |
|---|---|
| `moved` block | Destroy-recreate on refactor |
| `import` block | Out-of-band `terraform import` runs |
| `removed` block | Deleting code and orphaning state |
| `precondition` / `postcondition` | Defensive `null_resource` checks |
| `check` blocks | Post-apply verification done by hand |
| `optional()` in object types | Long variable lists with sentinel defaults |
| `validation` on variables | Runtime failure on bad input |
| `.tftest.hcl` test files | Manual plan reading as the only verification |
| Ephemeral values, write-only arguments | Secrets landing in state |
| `for_each` with `each.key` naming | Index-based addresses that shift |

## Step 5: count Against for_each

`for_each` is not always right. Both are legitimate, and overusing either hurts.

| Situation | Use | Why |
|---|---|---|
| Create or skip one resource | `count = var.enabled ? 1 : 0` | The idiomatic optional singleton |
| Near-identical instances, fixed number | `count` | Index carries no meaning that needs to survive |
| Items that may be reordered or removed | `for_each` over a set | Index identity would reshuffle every later address |
| Instances needing distinct values or named access | `for_each` over a map | `each.key` gives stable identity |

Never use a list index as long-lived identity. Migrate an existing `count` to `for_each` with
`moved` blocks, never by destroying. Use either meta-argument sparingly, and comment it when the
effect is not obvious.

## Step 6: State and Blast Radius

- [ ] Remote backend with locking, encryption, and versioning on. Never local state for a team
- [ ] New S3 backends use `use_lockfile = true` (Terraform 1.10, GA 1.11) over a DynamoDB table
- [ ] `prevent_destroy` on stateful resources (databases, buckets holding data)
- [ ] A person runs `terraform plan -out=tfplan`, then applies that exact artifact (never re-planned inside apply);
      your finish says which resources the change should replace, if any
- [ ] A replacement on a stateful resource is a MUST finding: `moved` blocks keep identity (Step 5)
- [ ] No `-target` in normal workflow. It hides drift and splits state
- [ ] No credentials or secret values in `.tf`, `.tfvars`, or outputs
- [ ] State files, `.terraform/`, plan artifacts, and secret `.tfvars` are gitignored
- [ ] Workspaces or separate roots per environment, decided deliberately, not mixed

### Destroy Protocol (a person's, handed over in your finish)

Destroy is the highest-consequence operation in Terraform, and a targeted destroy pulls in more than the named
address. You never run it. When your change removes resources, your finish tells the person who applies it to:

1. Run `terraform plan -destroy` (or read the plan's destroys) and read every resource listed, including implicit
   dependents reached through `locals` or `for_each`.
2. Never pass `-auto-approve` to a destroy.
3. Confirm backups or snapshots exist for anything stateful.

## Step 7: Verify the Resource and Argument Exist

An argument that sounds correct but does not exist is the most common Terraform defect from an
agent. Before first use of any resource or argument:

- After the dependency step's `terraform init`, `terraform providers schema -json` (with `run`) holds every
  resource and argument of the pinned providers: search it for the resource and argument.
- `terraform validate` catches unknown arguments after init.
- The registry's docs need the network: you cannot read them from the sandbox.

Match the schema to the pinned provider version, not the newest. An argument added in 6.60 does not exist in 5.x.
Protocol: the `code-review` skill's api-verification reference.

## Step 8: Gate Before Reporting Done

| Gate | Command | Blocks on |
|---|---|---|
| Format | `terraform fmt -check -recursive` | Unformatted HCL |
| Validate | `terraform init -backend=false` (the dependency step: it downloads providers), then `terraform validate` | Unknown arguments, type errors |
| Lint | `tflint --recursive` | Deprecated syntax, invalid instance types, provider rules |
| Policy | `checkov -d . --quiet` or `trivy config .` | Security misconfiguration |
| Test | `terraform test` with mocked providers (`mock_provider`) | Failing `.tftest.hcl` assertions |
| Plan | a person's `terraform plan -out=tfplan` (it needs state and credentials) | Unexpected replacement or deletion |

Tool versions anchored 28 October 2026: tflint v0.65.0, checkov 3.3.30, terraform-docs v0.24.0. Report a missing
tool, or an init the sandbox's registries could not serve, as a coverage gap, never as a pass.

## Step 9: Report

Put this in your `finish` summary:

```
## Terraform: [what was modelled]

| Resource | Rung | Choice | Rejected |
|---|---|---|---|
| VPC | 2 (registry module) | terraform-aws-modules/vpc 6.7.2 | 120 lines of subnets and routes |
| Bucket policy | 4 (data source) | aws_iam_policy_document | jsonencode heredoc |

- Versions: core ~> 1.17, aws ~> 6.70 (from the lock file), lock file in the change
- Built-ins used: default_tags, for_each, moved block for the rename
- Verified: [resource.argument, schema read]
- Gates: fmt clean, validate exit 0, tflint 0, checkov N passed, tests X passed; plan left to a person
- Coverage gaps: [tool not installed]
- For the person who applies: [expected replacements and destroys, the destroy protocol if any]
```

## Self-Check

- [ ] Versions taken from the repository's pins, lock file in the change
- [ ] Highest workable rung chosen, and the rung recorded
- [ ] No item from the Step 3 table hand-rolled
- [ ] No provisioner or `null_resource` without a written justification
- [ ] `for_each` used wherever resource identity must survive list edits, `count` where it fits
- [ ] Expected replacements and destroys named for the person who plans and applies
- [ ] No plan, apply or destroy run by you; any destroy handed over with its protocol
- [ ] Every argument confirmed against the pinned provider version
- [ ] No secret value in code, state output, or logs
- [ ] Layout, naming, and block ordering match `references/style-and-layout.md`
- [ ] Every variable has a type and description, every output a description

Before you claim the infrastructure works, apply the `verification-before-completion` skill.
