# Terraform Style and Layout

Detail behind Step 1 of the `terraform-engineer` skill. Sourced from the
[HashiCorp style guide](https://developer.hashicorp.com/terraform/language/style),
[standard module structure](https://developer.hashicorp.com/terraform/language/modules/develop/structure),
and [module creation pattern](https://developer.hashicorp.com/terraform/tutorials/modules/pattern-module-creation),
read 28 October 2026.

## File Layout

| File | Contents |
|---|---|
| `terraform.tf` | One `terraform` block: `required_version` and `required_providers` |
| `providers.tf` | All provider blocks. Default provider first, then aliased ones |
| `backend.tf` | Backend configuration, kept separate from version config |
| `main.tf` | Resources and data sources |
| `variables.tf` | All variables, alphabetical |
| `outputs.tf` | All outputs, alphabetical |
| `locals.tf` | Locals used across more than one file |

Once `main.tf` is hard to navigate, split by logical group instead: `network.tf`, `storage.tf`,
`compute.tf`. Whatever the split, a maintainer must be able to guess which file holds a resource.

Child modules live at `./modules/<module_name>`. A module published to a registry needs the
three-part repository name `terraform-<PROVIDER>-<NAME>`, for example `terraform-aws-vpc`.

## Module Hierarchy

| Level | Scope |
|---|---|
| Resource module | One logical group of connected resources: VPC with subnets and routes |
| Infrastructure module | Several resource modules serving one purpose in a region or account |
| Composition | Complete infrastructure, potentially across regions or accounts |

Keep the module tree flat. Prefer composition, where the root module passes dependencies in,
over a module that creates its own dependencies. A module whose purpose is hard to state in one
sentence is too large.

Standard module contents: `README.md`, `main.tf`, `variables.tf`, `outputs.tf`, `versions.tf`,
`examples/minimal/`, `examples/complete/`, `tests/*.tftest.hcl`. The examples double as
documentation and as integration fixtures.

## Naming

- Use a descriptive noun, words separated by underscores: `aws_instance.web_api`.
- Never repeat the resource type in the name. The address already contains it.
- Reserve `this` for a genuine singleton in a module, not as a default for everything.
- Prefix variables with their context: `vpc_cidr_block`, not `cidr`.
- Wrap the type and name in double quotes: `resource "aws_instance" "web_api"`.

## Ordering

Resource block arguments:

1. `count` or `for_each` (meta-arguments first, then a blank line)
2. Resource-specific arguments
3. `tags`
4. Nested blocks
5. `lifecycle`
6. `depends_on`

Variable block: `description`, `type`, `default`, `validation`, `nullable`, `sensitive`.
Output block: `description`, `value`, `sensitive`.

Define a data source before the resource that references it, so the file builds on itself.
Terraform derives creation order from references, so ordering is purely for the reader.

## Formatting

Two-space indent per nesting level. Align the equals signs of consecutive single-line
arguments. Put arguments before nested blocks, separated by one blank line. Use `#` for
comments, not `//` or `/* */`. Run `terraform fmt -recursive` before every commit, ideally from
a pre-commit hook.

## Variables, Outputs, Locals

- Every variable gets a `type` and a `description`. Every output gets a `description`.
- Give optional variables a sensible default. Prefer `optional()` inside a typed object over an
  untyped `map(any)`.
- Add `validation` only where the values are genuinely restricted, not as decoration.
- `sensitive = true` hides a value from CLI output. It is still in state. For real protection
  use ephemeral values and write-only arguments.
- Do not expose a variable for a setting that will never differ between deployments.
- Use locals sparingly. Overuse turns a readable file into indirection.

## Version Control

Always commit: all `.tf` files, `.terraform.lock.hcl`, a `README.md` describing inputs and
outputs, and a `.gitignore`.

Never commit: `terraform.tfstate` and its backups, `.terraform.tfstate.lock.info`, the
`.terraform/` directory, saved plan artifacts from `-out`, and any `.tfvars` holding secrets.

## Environments

With HCP Terraform or Terraform Enterprise, use a workspace per environment, and split large
codebases across workspaces per component (`prod-networking`, `prod-compute`, `prod-database`).

Without it, use a directory per environment, each with its own backend and variables, calling
shared modules from `./modules`. That gives each environment a separate state file.

Split state when teams, cadences, or resource counts diverge. Combine when resources are tightly
coupled and share a lifecycle.
