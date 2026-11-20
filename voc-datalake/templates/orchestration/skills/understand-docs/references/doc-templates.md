# Doc Templates (arc42 + C4 + MADR)

Per-file prose structure. Each file leads with its level and audience, embeds its diagram, then adds the "why". Prose describes the diagram; it never restates structure the diagram already shows. Apply the single-source-of-truth ownership from the plan's `doc-plan.md`.

Every file starts with frontmatter:

```markdown
---
title: <File title>
level: L100 | L200 | L300 | L400
arc42: "§3 Context and Scope"
audience: <who reads this>
last-verified: <YYYY-MM-DD>
tier: <extraction tier from plan; note if static-only>
---
```

## 00-overview.md (L100, arc42 §1 + §3)

```markdown
# System Overview

## What this is
One paragraph: what the system does and the value it provides.

## Quality goals
Top 3-5 goals (e.g., low-latency inference, cost control, data isolation).

## Context
```mermaid
C4Context
...
```
Prose: who the actors are, which external systems matter and why. No internal detail.

## Boundaries
What is in scope vs explicitly out of scope.
```

## 01-containers.md (L200, arc42 §5-L1)

```markdown
# Container View

## At a glance
```mermaid
C4Container
...
```

## Stacks and services
For each container: name, technology, responsibility (one line). Link deployment detail to `03-deployment.md`.

## Cross-stack wiring
Cross-stack edges: Pulumi StackReference or CDK stack-to-stack refs / `Fn::ImportValue`. Which project consumes which output, and why.

## Module map
```mermaid
mindmap
...
```
```

## 02-components.md (L300, arc42 §5-L2)

```markdown
# Component View

Cover only containers whose internal complexity matters; name the trivial ones and move on.

## <Container name>
```mermaid
C4Component
...
```
Responsibilities and interfaces of each component. Cite source (`path:line`).
```

## 03-deployment.md (L400, arc42 §7)

```markdown
# Deployment View

State the extraction tier. If static-only: "Declared in code; not verified against live cloud state."

## <Environment: dev | staging | prod>
```mermaid
C4Deployment
...
```
VPC/subnet layout, instance config, regions. One diagram per significant environment.

## CI/CD runtime
How code reaches each environment (CodeBuild/CodePipeline/GitHub Actions). Link tooling rationale to ADRs.

## Environment differences
Table: what differs across envs (instance sizes, replica counts, feature flags).
```

## 04-solution-strategy.md (L200, arc42 §4)

```markdown
# Solution Strategy

## Fundamental decisions
Bullet the key technology choices. Each links to its ADR in `06-adrs/`. Do not restate ADR rationale here, so it lives in one place.

## Quality tradeoffs
How the architecture serves the §1 quality goals; the tensions accepted.
```

## 05-crosscutting.md (L400, arc42 §8)

```markdown
# Crosscutting Concepts

## Identity & access (IAM)
Role model: which principal gets what, scoped to which resources.

## Secrets
Parameter Store / Secrets Manager usage. Never print secret values.

## Encryption
KMS keys, encryption at rest/in transit.

## Model governance
Model Registry, versioning, approval gates, guardrails.

## Observability
CloudWatch logs/metrics, X-Ray, alarms, dashboards.

## Tagging
Cost allocation and environment tags.
```

## 06-adrs/NNNN-<decision>.md (arc42 §9, MADR format)

```markdown
# ADR-NNNN: <short noun phrase>

**Date:** YYYY-MM-DD
**Status:** proposed | accepted | deprecated | superseded by ADR-XXXX
**Decision-makers:** <roles>

## Context and Problem Statement
2-3 sentences: the situation requiring a decision.

## Decision Drivers
- <force: cost / compliance / team skill / latency>

## Considered Options
1. <Option A>
2. <Option B>
3. <Do nothing>

## Decision Outcome
**Chosen: <Option X>**: 1-2 sentences why.

### Consequences
**Positive:** ...
**Negative / trade-offs:** ...
**Follow-up:** <ADR link or TODO>

## Pros and Cons of Options
### Option A
- Pro / Con
### Option B
- Pro / Con

## More Information
Links to related ADRs and arc42 sections.
```

One decision per ADR. Append-only: supersede with a new ADR, never edit decided history. Status field required.

## 07-risks.md (arc42 §11)

```markdown
# Risks & Technical Debt

## Security / cost / reliability signals
From the model's `signals`. Table: severity (MUST/SHOULD/NIT), category, finding, location (provenance), suggested action.

## Open architectural questions
Unresolved decisions; link to a `proposed` ADR if one exists.

## Tooling limits hit
Note any diagram/doc limit encountered (e.g., a diagram split for size).
```

## 08-glossary.md (arc42 §12)

```markdown
# Glossary

Canonical definitions only. Domain terms + IaC/AWS terms. Other files link here; never redefine inline.

| Term | Definition |
|---|---|
| <term> | <definition> |
```

## 09-dynamic/<flow-name>.md (L300, arc42 §6)

```markdown
# Runtime Flow: <name>

When this flow runs and why it is worth documenting (complex or recurring only).

```mermaid
sequenceDiagram
...
```
Numbered narration of the interesting steps. Use `flowchart LR` instead for batch pipelines.
```

## INDEX.md (registry)

```markdown
# Understanding Docs Index

Read in order: start at `00-overview.md` (L100) and climb to L400 as needed.

**Extraction tier:** <tier> (<caveat from plan>)

| File | Level | Audience | Diagrams | Last verified |
|---|---|---|---|---|
| 00-overview.md | L100 | everyone | C4Context | <date> |
| 01-containers.md | L200 | architects | C4Container, mindmap | <date> |
| 02-components.md | L300 | developers | C4Component | <date> |
| 03-deployment.md | L400 | ops, security | C4Deployment, flowchart | <date> |
| 04-solution-strategy.md | L200 | architects | none | <date> |
| 05-crosscutting.md | L400 | ops, security | none | <date> |
| 06-adrs/ | n/a | architects | none | <date> |
| 07-risks.md | n/a | leads, security | none | <date> |
| 08-glossary.md | n/a | everyone | none | <date> |
| 09-dynamic/ | L300 | developers | sequence, flowchart | <date> |
```

## Prose rules (from VOICE.md / repo writing rules)

- Active voice, second person for instructions. Sentences <= 25 words. Paragraphs <= 4 sentences.
- Lead with the conclusion. No em dashes. No banned words (leverage, utilize, ensure, robust, comprehensive, seamless, etc.).
- Describe diagrams; do not duplicate their structure in prose.
- Cite provenance for non-obvious claims (`path:line` or URN).
