# Mermaid Diagram Cookbook (L100 -> L400)

Copy-ready skeletons per diagram type. These are SYNTAX TEMPLATES. Fill every node and edge from `model.json` elements/edges/flows. Never ship a skeleton verbatim as if it were the project.

Mermaid baseline: v12.x (check `npm view mermaid version` for the exact pin). C4 types are
still flagged experimental in the Mermaid docs but render in docs (GitHub/VS Code/Obsidian);
acceptable here since output is docs-only.

## Level -> diagram type

| Level | Doc | Diagram type | Notes |
|---|---|---|---|
| L100 | 00-overview | `C4Context` | <=8 elements |
| L200 | 01-containers | `C4Container` | stacks + AWS service boxes |
| L200 | 04-solution-strategy / module map | `mindmap` | IaC stack/module overview |
| L300 | 02-components | `C4Component` | one per non-trivial container |
| L300 | 09-dynamic (inference) | `sequenceDiagram` | request/response path |
| L300 | 09-dynamic (training) | `flowchart LR` + subgraph | pipeline stages |
| L300 | lifecycle | `stateDiagram-v2` | job/model states |
| L400 | 03-deployment | `C4Deployment` or nested `flowchart TB` | per environment |
| L400 | 03-deployment (VPC) | `flowchart TB` + nested subgraph | account/region/VPC/subnet |
| L400 | data model | `erDiagram` | DynamoDB/RDS/feature store |
| L400 | component hierarchy | `classDiagram` | Pulumi ComponentResource / CDK Construct (optional) |

## Universal accuracy rules

- Quote any label containing `(` `)` `:` `#` `<` `>`: `A["S3 (us-east-1)"]`.
- `classDef` accepts hex only: `fill:#FF9900,stroke:#232F3E,color:#000`. Named colors are silently ignored.
- Declare direction (`TB`/`LR`). Subgraph id must differ from any node id.
- Assume `strict` security (GitHub default): no HTML labels beyond `<br/>`, no click handlers.
- Keep labels < 40 chars. Use `<br/>` for line breaks inside quoted labels.
- Limits: ~25 nodes flowchart, ~8 participants sequence, ~8 elements C4. Over limit -> split by boundary.
- C4 has no auto-layout: order statements deliberately and set `UpdateLayoutConfig($c4ShapeInRow="3", $c4BoundaryInRow="1")`.

## AWS color palette (classDef)

```
classDef compute  fill:#FF9900,stroke:#232F3E,color:#000,stroke-width:1px
classDef storage  fill:#3F8624,stroke:#232F3E,color:#fff,stroke-width:1px
classDef network  fill:#8C4FFF,stroke:#232F3E,color:#fff,stroke-width:1px
classDef ai       fill:#01A88D,stroke:#232F3E,color:#fff,stroke-width:1px
classDef boundary fill:#e8f4f8,stroke:#3B82F6,color:#1e40af,stroke-width:2px
```

## L100: C4Context

```mermaid
C4Context
  title System Context: <SYSTEM NAME>
  Person(user, "<Role>", "<what they do>")
  Person(admin, "<Role>", "<what they do>")
  System_Boundary(b, "<Account / System>") {
    System(sys, "<System>", "<one-line purpose>")
  }
  System_Ext(idp, "<External system>", "<role>")
  Rel(user, sys, "<action>", "<protocol>")
  Rel(sys, idp, "<action>", "<protocol>")
  UpdateLayoutConfig($c4ShapeInRow="3", $c4BoundaryInRow="1")
```

## L200: C4Container

```mermaid
C4Container
  title Container Diagram: <SYSTEM NAME>
  Person(user, "<Role>")
  System_Boundary(aws, "AWS") {
    Container(apigw, "API Gateway", "REST/HTTP", "<responsibility>")
    Container(lambda, "<Fn name>", "Python 3.12", "<responsibility>")
    ContainerDb(ddb, "DynamoDB", "NoSQL", "<what it stores>")
    ContainerDb(s3, "S3", "Object store", "<what it stores>")
    Container(bedrock, "Amazon Bedrock", "Managed LLM", "<model family>")
  }
  Rel(user, apigw, "HTTPS", "POST /invoke")
  Rel(apigw, lambda, "Invoke", "proxy")
  Rel(lambda, bedrock, "InvokeModel", "SDK")
  Rel(lambda, ddb, "GetItem/PutItem", "SDK")
  Rel(lambda, s3, "GetObject", "SDK")
  UpdateLayoutConfig($c4ShapeInRow="3", $c4BoundaryInRow="1")
```

## L200: mindmap (IaC stack/module map)

```mermaid
mindmap
  root((<Project> IaC))
    Networking
      VPC
      Subnets
    Compute
      Lambda
      SageMaker
    AI/ML
      Bedrock
      Vector store
    Storage
      S3
      DynamoDB
    Security
      IAM
      KMS
    Observability
      CloudWatch
```

## L300: C4Component (inside one container)

```mermaid
C4Component
  title Component Diagram: <Container name>
  Container_Boundary(c, "<Container>") {
    Component(router, "<Module>", "<lang>", "<responsibility>")
    Component(rag, "<Module>", "<lang>", "<responsibility>")
    Component(llm, "<Module>", "<lang>", "<responsibility>")
  }
  Rel(router, rag, "<call>")
  Rel(router, llm, "<call>")
```

## L300: sequenceDiagram (inference / request flow)

```mermaid
sequenceDiagram
  actor User
  participant GW as API Gateway
  participant Auth as Cognito
  participant Fn as Lambda
  participant Store as S3/DynamoDB
  participant FM as Bedrock
  User->>GW: POST /invoke
  GW->>Auth: ValidateToken(jwt)
  Auth-->>GW: claims OK
  GW->>Fn: Invoke(payload)
  activate Fn
  Fn->>Store: GetContext(id)
  Store-->>Fn: context[]
  Fn->>FM: InvokeModel(prompt+context)
  note right of FM: model: <id><br/>max_tokens: <n>
  FM-->>Fn: completion
  deactivate Fn
  Fn-->>GW: 200 {response}
  GW-->>User: JSON
```

## L300: flowchart LR (ML training pipeline)

```mermaid
flowchart LR
  subgraph ingest["Data Ingestion"]
    Raw[("S3 Raw")] --> Job["Glue / Processing"]
    Job --> Proc[("S3 Processed")]
  end
  subgraph train["SageMaker Training"]
    Proc --> T["Training Job"]
    T --> Reg["Model Registry"]
  end
  subgraph eval["Evaluation"]
    Reg --> E["Eval Job"]
    E --> Gate{"Metric > threshold?"}
    Gate -- Yes --> Dep["Deploy Endpoint"]
    Gate -- No --> Rej["Reject + Alert"]
  end
  classDef ai fill:#01A88D,stroke:#232F3E,color:#fff
  class T,E,Dep ai
```

## L300: stateDiagram-v2 (job/model lifecycle)

```mermaid
stateDiagram-v2
  direction LR
  [*] --> Pending: submitted
  state Training {
    Preparing --> Running
    Running --> Evaluating
    Evaluating --> Running
  }
  Pending --> Training: resources ready
  Training --> Completed: epochs done
  Training --> Failed: OOM / error
  Completed --> Deployed: metrics pass
  Completed --> Archived: metrics fail
  Failed --> [*]
  Archived --> [*]
```

## L400: C4Deployment (per environment)

```mermaid
C4Deployment
  title Deployment: <env>
  Deployment_Node(aws, "AWS Cloud") {
    Deployment_Node(region, "<region>") {
      Deployment_Node(vpc, "VPC", "<cidr>") {
        Deployment_Node(pub, "Public Subnet") {
          Container(apigw, "API Gateway", "REST", "public endpoint")
        }
        Deployment_Node(priv, "Private Subnet") {
          Container(lambda, "Lambda", "<runtime>", "<role>")
          Container(sm, "SageMaker Endpoint", "<instance>", "<model>")
        }
      }
      ContainerDb(s3, "S3", "Object store", "<purpose>")
    }
  }
  Rel(apigw, lambda, "Invoke")
  Rel(lambda, sm, "InvokeEndpoint", "SDK")
```

## L400: flowchart TB (account/region/VPC/subnet nesting)

```mermaid
flowchart TB
  Client(["User"])
  subgraph account["AWS Account: <name>"]
    subgraph region["<region>"]
      APIGW["API Gateway<br/>(REST)"]
      Bedrock["Amazon Bedrock<br/><model>"]
      subgraph vpc["VPC: <cidr>"]
        subgraph pub["Public Subnet"]
          ALB["Load Balancer"]
        end
        subgraph priv["Private Subnet"]
          Lambda["Lambda<br/>Handler"]
        end
      end
      S3[("S3")]
      DDB[("DynamoDB")]
    end
  end
  Client --> APIGW --> Lambda --> Bedrock
  Lambda --> S3
  Lambda --> DDB
  classDef compute fill:#FF9900,stroke:#232F3E,color:#000
  classDef storage fill:#3F8624,stroke:#232F3E,color:#fff
  class Lambda,APIGW compute
  class S3,DDB storage
```

## L400: erDiagram (data model)

```mermaid
erDiagram
  USER {
    string user_id PK
    string email UK
    string role
  }
  SESSION {
    string session_id PK
    string user_id FK
    timestamp ttl
  }
  INFERENCE_LOG {
    string log_id PK
    string session_id FK
    string model_id
    int input_tokens
    float latency_ms
  }
  USER ||--o{ SESSION : has
  SESSION ||--o{ INFERENCE_LOG : generates
```

## L400: classDiagram (Pulumi component / CDK construct hierarchy, optional)

```mermaid
classDiagram
  class Platform {
    +VPC vpc
    +ApiLayer api
    +deploy() Output
  }
  class ApiLayer {
    +RestApi gateway
    +create_authorizer() Authorizer
  }
  Platform *-- ApiLayer
```

## Pre-commit diagram checklist

- [ ] Every node id maps to a `model.json` element id
- [ ] Every edge maps to a `model.json` edge (or labeled flow step)
- [ ] Labels with special chars are double-quoted
- [ ] `classDef` uses hex colors only
- [ ] Direction declared; subgraph ids unique vs node ids
- [ ] Within node/participant/element limits, else split
- [ ] C4 diagrams set `UpdateLayoutConfig`
- [ ] `stateDiagram-v2` (not `stateDiagram`); ER uses PK/FK
- [ ] No invented services/edges (verification pass)
- [ ] Checked against this list (a person may also validate in mermaid.live or with `mmdc`; the sandbox has neither)

## When Mermaid is not enough (document the limit, do not switch silently)

No official AWS icons, no cross-diagram links, no multi-view from one source, C4 breaks past ~10 elements. If a diagram needs more, split it or note the limit in prose. Alternatives (Structurizr DSL, D2, diagrams.py) are out of scope for docs-only Mermaid output; mention them in `07-risks.md` only if a real limit was hit.
