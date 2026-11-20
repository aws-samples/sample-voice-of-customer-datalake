# Doc Plan: Canonical Understanding-Doc Set

The file set the planner schedules and the `understand-docs` skill describes how to write. On the platform it is the
shape the understander's draft takes; the files below are what a person's docs pull request would hold. Based on C4 + arc42 (the c4model.com FAQ documents this pairing). Single source of truth: each fact lives in one file; others link.

## File tree

```
project-review-understanding-document/
  REVIEW-PLAN.md            # the plan (the understand-plan skill, Step 5); the generation contract
  _model/                   # the extracted model (on the platform: the mapper's notes)
  docs/
    INDEX.md                # master registry: what exists, audience, level, last-verified
    00-overview.md          # L100  C4 System Context  / arc42 §1, §3
    01-containers.md        # L200  C4 Container        / arc42 §5-L1
    02-components.md        # L300  C4 Component        / arc42 §5-L2
    03-deployment.md        # L400  C4 Deployment       / arc42 §7
    04-solution-strategy.md # L200  (prose)             / arc42 §4 (+ §1 goals)
    05-crosscutting.md      # L400  (prose)             / arc42 §8
    06-adrs/                # MADR records              / arc42 §9
      0001-<decision>.md
    07-risks.md             # signals + tech debt       / arc42 §11
    08-glossary.md          # term definitions          / arc42 §12
    09-dynamic/             # L300 runtime flows         / arc42 §6 (only if complex)
      <flow-name>.md
```

## File responsibilities: single source of truth

| File | Owns (lives only here) | Must not repeat |
|---|---|---|
| `00-overview.md` | External actors, system boundary, external systems | Internal containers |
| `01-containers.md` | Stacks/apps-as-containers, AWS service boxes, cross-stack wiring | How they deploy (-> 03) |
| `02-components.md` | Internal modules, Pulumi ComponentResource / CDK Construct classes, interfaces | Cross-stack wiring (-> 01) |
| `03-deployment.md` | Environments, VPC/subnet layout, instance config, CI/CD runtime | Static responsibilities (-> 01) |
| `04-solution-strategy.md` | Why Pulumi/CDK + language, why SageMaker/Bedrock, quality tradeoffs | ADR rationale (link -> 06) |
| `05-crosscutting.md` | IAM model, tagging, secrets, encryption, model governance, observability | Per-component logic (-> 02) |
| `06-adrs/` | Decision rationale, options, consequences | Restating what (link from 04) |
| `07-risks.md` | Unresolved risks, tech debt, security/cost/reliability signals | Resolved decisions (-> 06) |
| `08-glossary.md` | Canonical term definitions | Usage examples (link) |
| `INDEX.md` | The registry mapping the whole set | File-local scope (each file states its own) |

## Anti-duplication rules

1. Each fact in exactly one file; others link with a relative path.
2. Diagrams are authoritative; prose describes the diagram, never restates its structure.
3. `04-solution-strategy.md` links to ADRs; it does not restate their rationale.
4. Container diagram (L200) excludes load balancers and replica counts; those belong in deployment (L400).
5. Glossary owns definitions; elsewhere use the term + link, never redefine inline.
6. `INDEX.md` owns the registry; each doc states only its own scope.

## arc42 priority for IaC/AI projects

| arc42 § | Priority | Maps to file |
|---|---|---|
| §3 Context & Scope | HIGH | 00-overview |
| §4 Solution Strategy | HIGH | 04-solution-strategy |
| §5 Building Block | HIGH | 01-containers (L1), 02-components (L2) |
| §6 Runtime | MEDIUM (key flows only) | 09-dynamic |
| §7 Deployment | CRITICAL | 03-deployment |
| §8 Crosscutting | HIGH | 05-crosscutting |
| §9 Decisions | HIGH | 06-adrs |
| §11 Risks | MEDIUM | 07-risks |
| §12 Glossary | MEDIUM | 08-glossary |
| §1 Goals, §2 Constraints | MEDIUM | folded into 00 / 04 |
| §10 Quality | LOW | brief list in 04; skip full quality tree |

C4 Level 4 (code diagrams) is skipped: IaC is declarative; class-level diagrams add no value beyond the optional Pulumi-component / CDK-construct `classDiagram` at L400.

## ADR detection (MADR format)

Capture significant, alternatives-bearing decisions. Common candidates in Pulumi/CDK/AI-on-AWS repos:
- IaC tool (Pulumi vs CDK vs Terraform) and language (TS vs Python vs Go vs Java)
- Training platform (SageMaker vs Batch vs EC2) and serving (Bedrock vs SageMaker endpoint vs ECS)
- Vector store (OpenSearch Serverless vs Aurora pgvector vs external)
- Agent approach (Bedrock Agents vs AgentCore vs custom framework)
- State/synth model (Pulumi backend: Cloud vs S3; CDK: bootstrap + CloudFormation), secrets provider, multi-stack decomposition

One decision per ADR. Status field required. Append-only (supersede, never edit history).

## Markers the planner records per doc

For each file, the REVIEW-PLAN records: applicable (yes/skip + reason), level, the Mermaid diagram type(s), the model element ids feeding each diagram, and any open question blocking generation.
