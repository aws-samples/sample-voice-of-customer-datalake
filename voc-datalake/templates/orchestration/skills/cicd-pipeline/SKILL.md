---
name: cicd-pipeline
description: "Audit a pull request's changes to GitHub Actions workflows for security hardening (permissions, SHA pinning, OIDC, secrets), reliability and cost, with good workflow templates for comparison. For a reviewer judging a workflow change; never for editing one."
source: "ai-skill-factory 2.0.0 (Amit Deol), skills/cicd-pipeline"
license: MIT
adapted: "Turned from setting up a pipeline into auditing a pull request's workflow changes: the agents never edit CI definitions, so the templates are what good looks like, and each issue is a finding. The pin-refresh curl call is dropped (no network): a reviewer checks that a pin is a full SHA with a version comment and that Dependabot covers it. Slash references name library skills."
---

Audit the workflow changes in the pull request or patch your task names.

You review; you never edit a workflow. The agents' rules keep CI definitions out of every change they make, so this
skill is for judging a change a person (or another tool) proposes to `.github/workflows/`, `.github/dependabot.yml`
or a reusable action, and for recognising a CI change in an agent's patch, which is blocking by the reviewers'
rules whatever its quality.

## Step 1: Find the Workflow Changes

Read the patch with `read_patch` (every page). List each changed file under `.github/workflows/`,
`.github/actions/`, `.github/dependabot.yml`, and any script a workflow runs. Read the whole changed workflow with
`read_file` on your checkout (the patch is applied to it): a hunk's context is not the job.

From the repository's manifests (`pyproject.toml`, `package.json`, `Dockerfile`, `cdk.json`) note what the workflows
build: language, deployment (CDK, Docker, serverless, static site) and registry (ECR, GHCR, npm).

## Step 2: Security Hardening

Check every changed workflow against these. Each miss is a finding.

```yaml
permissions:
  contents: read  # Minimum needed
```

- [ ] A `permissions` block on every workflow (the default token is too permissive), each scope the least the job
      needs (`id-token: write` only on the job that assumes a role)
- [ ] Actions pinned to a full SHA, not a tag, with the version as a comment: `actions/checkout@<40-hex sha> # v4`.
      A tag (`@v4`) or a branch (`@main`) is a supply-chain finding
- [ ] Dependabot or Renovate configured for the `github-actions` ecosystem, so SHA pins get version-bump PRs
      instead of going stale (a manual pin is only correct the day it is set)
- [ ] OIDC for AWS access, never stored access keys (`AWS_ACCESS_KEY_ID` in secrets is a finding)
- [ ] No secrets logged: dynamic values masked with `::add-mask::`, no `echo` of a secret, no `set -x` around one
- [ ] Deployment credentials in environment secrets, behind an environment with required reviewers
- [ ] No `pull_request_target` that checks out and runs the pull request's own code
- [ ] No untrusted input (`github.event.*.title`, `body`, `head_ref`) interpolated into a `run:` script: pass it
      through an environment variable
- [ ] A concurrency group, so duplicate runs do not pile up

The OIDC shape to expect:

```yaml
permissions:
  id-token: write
  contents: read

steps:
  - uses: aws-actions/configure-aws-credentials@<sha> # v4
    with:
      role-to-assume: arn:aws:iam::${{ secrets.AWS_ACCOUNT_ID }}:role/GitHubActionsRole
      aws-region: us-east-1
```

You cannot reach GitHub from the sandbox, so you cannot check that a SHA is the tag it claims: say so in your
review when it matters, and check that the pin is a full 40-character SHA with a comment and that Dependabot will
keep it current.

## Step 3: Compare With the Templates

`references/ci-templates.md` holds complete workflows that pass Step 2:

- Python CI (uv + ruff + pyright + pytest with matrix)
- TypeScript CI (pnpm + biome + tsc + vitest)
- Docker Build (BuildKit + Trivy scan)
- CDK Deployment (staging diff + production deploy with approval)
- PR Validation (commit messages + large file check)
- Caching Strategy (uv, pnpm, Docker BuildKit)

Compare the changed workflow with the template for its stack: a missing frozen-lockfile install, cache key,
approval gate before production or `if: always()` on teardown is a finding.

## Step 4: Anti-Patterns

`references/anti-patterns.md` has the full checklist. The key issues to look for in the changed lines:

| # | Anti-Pattern | Look For | Fix |
|---|---|---|---|
| 1 | No `permissions` block | Missing `permissions:` | Add explicit permissions |
| 2 | Actions pinned to tag | `uses:` ending in `@v<n>` or a branch | Pin to full SHA |
| 3 | Stored AWS access keys | `AWS_ACCESS_KEY` | Use OIDC |
| 4 | No `concurrency` group | Missing `concurrency:` | Add with cancel |
| 5 | No path filters | Missing `paths:` | Add path filters |

## Step 5: Write the Findings

Write each issue with `write_findings`: the workflow file and line, a severity (an over-broad permission, a tag
pin on a third-party action, stored keys or untrusted input in a script are blocking), the rule, and the evidence
(the line). Your review's summary (`write_review`, and the comment a PR reviewer posts) groups them:

```
## CI/CD Change Audit

### Summary
- Workflows changed: X files under .github/workflows/
- Security: X issues (SHA pinning, permissions, OIDC, untrusted input)
- Reliability and cost: X issues (caching, path filters, concurrency, frozen installs)

### Findings
| # | Category | Issue | File:Line | Fix |
```

For a repository's local pre-commit and pre-push gates, see the `quality-gates` skill. For AWS infrastructure
security, see the `aws-security` skill. For Docker practice, see the `docker-ops` skill.
