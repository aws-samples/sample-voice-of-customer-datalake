# Terraform Built-In Features and Version Floors

Step 4 of the `terraform-engineer` skill. Each feature replaces a pattern people hand-roll. Floors for
`removed`, ephemeral, and write-only were read from the Terraform CHANGELOG at the matching
release tag on 28 October 2026. All are available in current Terraform 1.17.

| Feature | Floor | Replaces |
|---|---|---|
| `moved` block | 1.1 | Destroy and recreate when renaming or re-nesting |
| `nullable` on variables | 1.1 | Sentinel default values |
| `precondition` / `postcondition` | 1.2 | Guard checks written as `null_resource` |
| `optional()` in object types | 1.3 | Long flat variable lists |
| `import` block | 1.5 | Out-of-band `terraform import` commands |
| `check` block | 1.5 | Post-apply verification done by hand |
| `terraform test` with `.tftest.hcl` | 1.6 | Reading a plan as the only verification |
| `removed` block | 1.7 | Deleting code and orphaning or destroying state |
| Provider-defined functions | 1.8 | Shelling out for provider-specific transforms |
| Mock providers in tests | 1.7 | Paid cloud resources created for unit tests |
| Cross-variable validation | 1.9 | Consistency checks pushed into `locals` or apply-time failure |
| Ephemeral resources and ephemeral values | 1.10 | Secrets persisted into plan and state |
| S3 native state locking (`use_lockfile`) | 1.10, GA 1.11 | A DynamoDB table purely for locking |
| Write-only resource attributes | 1.11 | Passwords stored in state |

Set `required_version` to the lowest floor the configuration actually needs, expressed as a
pessimistic constraint (`~> 1.17`), not to whatever is newest.

## moved: Refactor Without Destroying

```hcl
moved {
  from = aws_instance.web
  to   = aws_instance.app
}
```

Works for resources, modules, and instance keys, including a `count` to `for_each` migration.
Keep the block until every state has been applied, then remove it. Plan must show zero
destroys. A destroy in the plan means the addresses do not match.

## import: Adopt Existing Infrastructure in Code

```hcl
import {
  to = aws_s3_bucket.logs
  id = "my-existing-logs-bucket"
}
```

Declarative and reviewable, unlike a `terraform import` run in someone's shell. Pair with
`terraform plan -generate-config-out=generated.tf` to draft the resource, then edit it down.
Delete the block after the import applies.

## removed: Retire Code Deliberately

```hcl
removed {
  from = aws_instance.legacy
  lifecycle {
    destroy = false    # forget from state, leave the real resource alone
  }
}
```

Deleting a resource block on its own destroys the resource. Use `removed` to state the intent.

## check and Conditions: Assert Instead of Hoping

```hcl
check "endpoint_healthy" {
  data "http" "app" {
    url = "https://${aws_lb.this.dns_name}/health"
  }
  assert {
    condition     = data.http.app.status_code == 200
    error_message = "health endpoint returned ${data.http.app.status_code}"
  }
}
```

`check` blocks warn without failing the apply, so use them for continuous verification.
Use `precondition` and `postcondition` inside a resource `lifecycle` when the apply must fail.

## Ephemeral and Write-Only: Keep Secrets Out of State

```hcl
variable "db_password" {
  type      = string
  sensitive = true
  ephemeral = true
}

resource "aws_db_instance" "this" {
  password_wo         = var.db_password    # write-only, never persisted
  password_wo_version = 1                  # bump to rotate
}
```

`sensitive` only hides the value in output. It still lands in state. `ephemeral` keeps it out
of plan and state files. Write-only arguments are the provider-side half. Check the pinned
provider version for which write-only arguments it supports.

## for_each Over count

```hcl
resource "aws_subnet" "this" {
  for_each          = var.subnets            # map keyed by name
  vpc_id            = aws_vpc.this.id
  cidr_block        = each.value.cidr
  availability_zone = each.value.az
}
```

`count` addresses resources by index, so removing the first element re-creates every later
one. `for_each` keys them by name, and identity survives edits. Convert existing `count`
resources with `moved` blocks, never by destroying them.

## terraform test: Real Tests for Modules

```hcl
# tests/defaults.tftest.hcl
run "name_prefix_is_applied" {
  command = plan                      # input-derived values only
  assert {
    condition     = aws_s3_bucket.this.bucket == "${var.name_prefix}-assets"
    error_message = "bucket name did not use the prefix"
  }
}

run "encryption_is_enabled" {
  command = apply                     # computed values need a real apply
  assert {
    condition = length([
      for rule in aws_s3_bucket_server_side_encryption_configuration.this.rule : rule
    ]) > 0
    error_message = "bucket created without encryption"
  }
}
```

Two gotchas that make plan-only assertions unreliable:

- **Computed values are unknown at plan.** ARNs, generated names, and IDs are only real after
  apply. Asserting on them under `command = plan` either fails or passes for the wrong reason.
- **Set-type nested blocks cannot be indexed.** `rule[0]` fails on a set. Use a `for`
  expression, or materialise the value with `command = apply`. Common set types include S3
  encryption rules, lifecycle transitions, and IAM policy statements.

Use mock providers (1.7+) so unit tests cost nothing, and keep real applies for final
integration. Note the distinction: tests validate the logic of your code, while `validation`,
preconditions, postconditions, and `check` blocks verify the infrastructure that got deployed.

## Functions That Remove Hand-Rolled String Work

| Instead of | Use |
|---|---|
| Manual CIDR arithmetic | `cidrsubnet`, `cidrhost`, `cidrnetmask` |
| `join` and `format` to build a file | `templatefile` |
| String building a policy | `data "aws_iam_policy_document"`, or `jsonencode` on a real object |
| Hand-parsing an ARN | `split(":", arn)` on the resource attribute, or the provider's own attributes |
| Repeated `lookup` with defaults | `try`, `coalesce`, `optional()` in the type |
| Sorting or deduplicating by hand | `sort`, `distinct`, `toset` |
