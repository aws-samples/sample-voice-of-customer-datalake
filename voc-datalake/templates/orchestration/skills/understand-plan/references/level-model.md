# Level Model: L100 -> L400 mapped to C4 + arc42

The doc set ramps from overview to expert depth using the AWS session-level convention (100/200/300/400). Each level maps to a C4 abstraction and arc42 sections, so a new reader climbs from "what is this" to "exact resources" without re-reading.

## The four levels

| Level | Depth | Reader question | C4 | arc42 | Time to read |
|---|---|---|---|---|---|
| **L100** | Overview | "What is this and who uses it?" | System Context | §1 Goals, §3 Context | 10 min |
| **L200** | Intermediate | "How is it structured?" | Container | §4 Strategy, §5 Building Block L1 | 20 min |
| **L300** | Deep | "How does it work inside and at runtime?" | Component + Dynamic | §5 Building Block L2, §6 Runtime | 30 min |
| **L400** | Expert | "What exactly runs, where, with what config?" | Deployment + resource detail | §7 Deployment, §8 Crosscutting | 45 min |

## What belongs at each level

### L100: Overview (System Context)
- The one system as a single box; the people/roles who use it; external systems it talks to (identity provider, third-party APIs, Bedrock as managed service if treated as external).
- No internal structure. No AWS service inventory. No protocols.
- Diagram: `C4Context`. Cap ~6-8 elements.
- Audience: everyone, including non-technical stakeholders.

### L200: Intermediate (Container)
- IaC stacks/apps as containers; major AWS services as named boxes (API Gateway, Lambda, SageMaker endpoint, S3, DynamoDB, vector store); cross-stack wiring via Pulumi StackReferences or CDK stack-to-stack refs / `Fn::ImportValue`.
- Each box: name + technology + one-line responsibility.
- Exclude deployment detail (replicas, load balancers, subnets); those are L400.
- Diagrams: `C4Container` for the architecture; `mindmap` for the stack/module map.
- Audience: architects, leads, new engineers building a mental model.

### L300: Deep (Component + Dynamic)
- Inside each non-trivial container: modules, Pulumi `ComponentResource` or CDK `Construct`/`Stack` classes, handlers, their responsibilities and interfaces.
- Runtime flows: the request/inference path and the training/data-pipeline path.
- Diagrams: `C4Component` per significant container; `sequenceDiagram` for request/inference flow; `flowchart LR` with subgraphs for ML training pipeline; `stateDiagram-v2` for job/model lifecycle.
- Audience: developers working in a specific area.

### L400: Expert (Deployment + resource detail)
- Real deployed resources with config (instance types, memory, runtimes), per environment (dev/staging/prod), VPC/subnet topology, CI/CD runtime.
- Crosscutting: IAM role model, tagging, secrets, encryption, model versioning/governance, observability.
- Data model at field level.
- Diagrams: `C4Deployment` (one per significant environment); `flowchart TB` with nested subgraphs for VPC/subnet/account; `erDiagram` for data model; `classDiagram` for the IaC component/construct hierarchy if it aids understanding.
- Audience: ops, infra engineers, security reviewers.

## Progressive disclosure rule

A fact appears at exactly one level (its home), and deeper levels add detail rather than restating. Example: S3 exists as a box at L200, its bucket policy and encryption at L400. The L200 prose links down to L400 rather than copying. This is the same single-source-of-truth rule enforced in `doc-plan.md`.

## Reading path for a new engineer

1. L100 `00-overview.md`: context (10 min)
2. L200 `01-containers.md` + `04-solution-strategy.md`: structure and why (35 min)
3. L300 `02-components.md` + `09-dynamic/`: internals and runtime (30 min, as needed per area)
4. L400 `03-deployment.md` + `05-crosscutting.md`: exact infra (45 min, for ops/security)

The plan should record, per generated doc, which level it sits at and which model element ids feed its diagrams.
