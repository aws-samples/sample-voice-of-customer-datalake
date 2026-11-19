# Extraction Reference: Surveying a Pulumi or CDK / AI-on-AWS Project

How to extract an accurate, provenance-tagged model without deploying. On the platform the mapper and the
understander run no command: they take Tier 3 (source files) and any committed `cdk.out/` (Tier 2) with
`read_file` and `list_files`, and write the model as notes. The commands below are for a person's survey, or a role
that runs code; the `_model/` files are the source method's, which the notes replace. Static-first, optional state/synth export. Read-only against infrastructure. Works for two IaC tools: Pulumi (state export) and AWS CDK (CloudFormation synth). Detect the tool from marker files (`Pulumi.yaml` vs `cdk.json`), then follow the matching phase. A repo may use both.

## Safe vs unsafe commands (Pulumi)

| Command | Needs | Safe? | Use |
|---|---|---|---|
| `find . -name "Pulumi.yaml"` | nothing | YES | Project inventory |
| `grep -rn "new aws\."` | nothing | YES | Resource instantiation scan |
| `pulumi about` | backend login | YES (read) | Runtime, providers, backend |
| `pulumi stack ls` | backend login | YES (read) | Stack inventory |
| `pulumi stack --show-urns` | backend login | YES (read) | URN tree |
| `pulumi config` | backend login | YES (read) | Config keys (secrets stay ciphertext) |
| `pulumi stack export` | backend login | YES (read) | Full state JSON. NO AWS creds needed |
| `pulumi stack graph --file g.dot` | backend login | YES (read) | Dependency DOT graph |
| `pulumi preview --json` | AWS creds | read-only, OPTIONAL, a person's | Drift vs live cloud |
| `pulumi refresh` | AWS creds | NO during audit | Mutates state file |
| `pulumi up` / `pulumi destroy` | AWS creds | NEVER | Mutates / deletes infra |

State lives in the Pulumi backend (Pulumi Cloud, S3, local), not the cloud account. `pulumi stack export` reads state, not AWS, so it needs no cloud credentials and reveals no live secrets.

## Safe vs unsafe commands (CDK)

| Command | Needs | Safe? | Use |
|---|---|---|---|
| `find . -name "cdk.json"` | nothing | YES | App inventory |
| `grep -rn "new s3.Bucket\|extends Stack"` | nothing | YES | Construct/stack scan |
| `cdk ls` | nothing (offline) | YES (read) | Stack inventory in the app |
| `cdk synth` / `cdk synth --quiet` | nothing (offline) | YES (read) | Expand constructs to CloudFormation templates in `cdk.out/` |
| read `cdk.out/*.template.json` | nothing | YES | Synthesized resources, logical IDs, deps |
| read `cdk.out/manifest.json`, `tree.json` | nothing | YES | Stack list, construct tree, dependencies |
| `cdk diff` | AWS creds | read-only, OPTIONAL, a person's | Drift vs deployed stack |
| `aws cloudformation get-template` | AWS creds | read-only, OPTIONAL, a person's | Deployed template (Tier 1) |
| `cdk deploy` / `cdk destroy` | AWS creds | NEVER | Mutates / deletes infra |

`cdk synth` runs locally and needs no AWS credentials. It is the CDK equivalent of Pulumi state export for accuracy: it expands every L2/L3 construct (which hide many resources) into concrete CloudFormation. Prefer reading `cdk.out` templates over grepping construct calls. If `cdk synth` fails (missing deps, bootstrap context), fall back to reading any committed `cdk.out/` then to source grep, and record the lower tier.

## Phase 1 (Pulumi): Static read (zero credentials)

1. **Projects**: `find "$TARGET" -name "Pulumi.yaml" -not -path "*/node_modules/*" | sort`. Each = one project. Read `name`, `runtime`, `description`.
2. **Stacks**: `find "$TARGET" -name "Pulumi.*.yaml" | grep -v "/Pulumi.yaml" | sort`. Each = one stack (dev/staging/prod, regional splits).
3. **Config intent**: parse each `Pulumi.<stack>.yaml` `config:` block. Keys reveal region, instance types, model IDs, feature flags. `secure:` keys are encrypted; the KEY NAME documents intent (e.g., `dbPassword`). Never decrypt.
4. **Provider packages**: read `package.json` / `requirements.txt` / `go.mod`. Presence of `awsx`, `pulumi-eks` sets the component vocabulary to expect.
5. **Resource instantiations** (record `file:line` for each):
   ```bash
   grep -rn "new aws\.\|new awsx\.\|new eks\." --include="*.ts" "$TARGET"
   grep -rn "aws\.\w\+\.\w\+(" --include="*.py" "$TARGET"
   grep -rn "^[[:space:]]*type: aws" --include="*.yaml" "$TARGET"
   grep -rn "NewBucket\|NewFunction\|sagemaker\.\|bedrock\." --include="*.go" "$TARGET"
   ```
6. **Stack references** (inter-project edges): `grep -rn "StackReference" "$TARGET"`. Parse `"org/project/stack"`.
7. **Components**: `grep -rn "ComponentResource" --include="*.ts" --include="*.py" "$TARGET"`. Read each constructor to enumerate child resources.
8. **Exports** (what a project exposes): `grep -rn "pulumi.export\|export const" "$TARGET"`.
9. **Module graph** (for L200): if tools present, use `madge --json` (TS), `grimp`/`pydeps` (Python), `go mod graph` (Go). Else derive from import statements.

## Phase 2 (Pulumi): State export (backend login, no AWS creds), Tier 1 only

```bash
pulumi stack select <stack>
pulumi stack export > _model/state-<stack>.json
jq '[.deployment.resources[].type] | unique | sort' _model/state-<stack>.json   # type inventory
jq '.deployment.resources[] | {urn,type,id,parent,deps:.dependencies}' _model/state-<stack>.json
```

State resource fields to extract: `urn` (parse `urn:pulumi:<stack>::<project>::<type>::<name>`), `type` (-> AWS service), `inputs` (real sizes/ARNs/env incl. model IDs), `parent` (component tree), `dependencies` (edges). State `urn` is the strongest provenance; prefer it over `file:line` when both exist.

## Phase 1 (CDK): Static read + synth (zero credentials)

1. **Apps**: `find "$TARGET" -name "cdk.json" -not -path "*/node_modules/*" | sort`. Each = one CDK app. Read `cdk.json` `app` (entrypoint + language), `context` (env, feature flags).
2. **Language + deps**: read `package.json` / `requirements.txt` / `pom.xml` / `go.mod`. CDK language sets the construct vocabulary (`aws-cdk-lib`, `constructs`, `@aws-cdk/aws-*` alpha modules).
3. **Synthesize** (preferred, offline): `cd "$TARGET" && cdk synth --quiet` writes `cdk.out/`. If it fails, use any committed `cdk.out/`, else fall back to source grep (record the tier).
4. **Stack inventory**: `cdk ls` or read `cdk.out/manifest.json` `artifacts` (type `aws:cloudformation:stack`). Each = one CloudFormation stack.
5. **Construct tree**: read `cdk.out/tree.json` for the construct hierarchy (app -> stacks -> L3/L2/L1 constructs). This is the CDK analog of the Pulumi component tree.
6. **Resource scan from source** (record `file:line` for each construct call):
   ```bash
   grep -rn "extends Stack\|extends Construct" --include="*.ts" "$TARGET"
   grep -rn "new \(s3\|lambda\|dynamodb\|apigateway\|sfn\|sns\|sqs\|ec2\|rds\|ecs\|iam\|kms\|cognito\|bedrock\|sagemaker\)\." --include="*.ts" "$TARGET"
   grep -rn "Stack)\|Construct)" --include="*.py" "$TARGET"        # Python: class X(Stack)
   grep -rn "aws_cdk\|from constructs" --include="*.py" "$TARGET"
   ```
7. **Cross-stack edges**: stack-to-stack property passes in app code (constructor args), plus synthesized `Fn::ImportValue` / `Export` pairs in templates. `grep -rn "Fn::ImportValue\|\"Export\"" cdk.out/`.
8. **CfnOutput** (what a stack exposes): `grep -rn "new CfnOutput\|CfnOutput(" "$TARGET"` and `Outputs` blocks in `cdk.out/*.template.json`.
9. **Module graph** (for L200): if tools present, `madge --json` (TS), `grimp`/`pydeps` (Python). Else derive from import statements.

## Phase 2 (CDK): Read synthesized templates, Tier 2 (offline, preferred)

```bash
for t in cdk.out/*.template.json; do
  jq '[.Resources[].Type] | group_by(.) | map({type:.[0], n:length})' "$t"   # resource type inventory
  jq '.Resources | to_entries[] | {logicalId:.key, type:.value.Type, deps:(.value.DependsOn // []), props:(.value.Properties|keys)}' "$t"
done
```

CloudFormation resource fields to extract: the map KEY is the logical ID (strongest CDK provenance), `Type` (`AWS::Lambda::Function` -> AWS service), `Properties` (real sizes/ARNs/env incl. model IDs), `DependsOn` plus `Ref`/`Fn::GetAtt` in properties (edges), CDK path from `Metadata."aws:cdk:path"` (maps a logical ID back to `file:line` construct). Prefer the synthesized logical ID + CDK path over a bare construct grep when both exist.

## Phase 3: Live drift (AWS creds, optional, a person's only)

Pulumi: `pulumi preview --json` computes diff vs live cloud. CDK: `cdk diff` compares synth vs the deployed stack; `aws cloudformation get-template --stack-name <name>` reads the deployed template (Tier 1). All read-only. Never by an agent: the platform's agents have no AWS credentials. A person runs them when they want
drift detection.

## Resource type -> AWS service -> C4 element

Pulumi naming: `aws:<module>/<resource>:<Class>` (classic), `aws-native:<service>:<Resource>` (Cloud Control), `awsx:<service>:<Component>` (Crosswalk, expands to many resources), `eks:index:Cluster`. CDK synthesizes to CloudFormation types: `AWS::<Service>::<Resource>`. Both map to the same AWS service and C4 role; match on the AWS service column.

| Pulumi type | CloudFormation type (CDK synth) | AWS service | C4 role | Level |
|---|---|---|---|---|
| `aws:s3/bucket:Bucket` | `AWS::S3::Bucket` | S3 | Data store | L200/L400 |
| `aws:lambda/function:Function` | `AWS::Lambda::Function` | Lambda | Serverless fn | L200/L300 |
| `aws:apigateway/restApi:RestApi`, `aws:apigatewayv2/api:Api` | `AWS::ApiGateway::RestApi`, `AWS::ApiGatewayV2::Api` | API Gateway | API container | L200 |
| `aws:sfn/stateMachine:StateMachine` | `AWS::StepFunctions::StateMachine` | Step Functions | Orchestrator | L200/L300 |
| `aws:sqs/queue:Queue`, `aws:sns/topic:Topic` | `AWS::SQS::Queue`, `AWS::SNS::Topic` | SQS / SNS | Messaging | L300 |
| `aws:events/rule:Rule` | `AWS::Events::Rule` | EventBridge | Event router | L300 |
| `aws:ec2/vpc:Vpc`, `awsx:ec2:Vpc` | `AWS::EC2::VPC` (+`Subnet`/`InternetGateway`/`NatGateway`) | VPC | Network boundary | L400 |
| `aws:dynamodb/table:Table` | `AWS::DynamoDB::Table` | DynamoDB | NoSQL store | L200/L400 |
| `aws:rds/cluster:Cluster`, `aws:rds/instance:Instance` | `AWS::RDS::DBCluster`, `AWS::RDS::DBInstance` | Aurora / RDS | Relational store | L200/L400 |
| `aws:opensearchserverless/collection:Collection` | `AWS::OpenSearchServerless::Collection` | AOSS (VECTORSEARCH) | Vector store | L200/L300 |
| `aws:ecs/service:Service`, `awsx:ecs:FargateService` | `AWS::ECS::Service` (+`TaskDefinition`) | ECS / Fargate | Container service | L200 |
| `eks:index:Cluster` | `AWS::EKS::Cluster` | EKS | K8s cluster | L200 |
| `aws:ecr/repository:Repository` | `AWS::ECR::Repository` | ECR | Container registry | L400 |
| `aws:iam/role:Role`, `aws:iam/policy:Policy` | `AWS::IAM::Role`, `AWS::IAM::Policy` | IAM | Identity / permission | L400 |
| `aws:kms/key:Key`, `aws:secretsmanager/secret:Secret` | `AWS::KMS::Key`, `AWS::SecretsManager::Secret` | KMS / Secrets Manager | Crosscutting (§8) | L400 |
| `aws:cloudwatch/logGroup:LogGroup`, `metricAlarm:MetricAlarm` | `AWS::Logs::LogGroup`, `AWS::CloudWatch::Alarm` | CloudWatch | Observability | L400 |
| `aws:cognito/userPool:UserPool` | `AWS::Cognito::UserPool` | Cognito | Auth | L200 |
| `aws:cloudfront/distribution:Distribution` | `AWS::CloudFront::Distribution` | CloudFront | CDN | L200 |
| `aws:codebuild/project:Project`, `aws:codepipeline/pipeline:Pipeline` | `AWS::CodeBuild::Project`, `AWS::CodePipeline::Pipeline` | CodeBuild / CodePipeline | CI/CD | L300 (deployment) |

CDK note: L2/L3 constructs synthesize to several CloudFormation resources (e.g., `lambda.Function` adds an `AWS::IAM::Role` and `AWS::Logs::LogGroup`). Group child resources under their construct path (`aws:cdk:path`) so the model mirrors author intent, not raw template noise.

### AI-on-AWS components (recognize and document)

| Pulumi type | CloudFormation type (CDK synth) | AWS service | C4 role |
|---|---|---|---|
| `aws:bedrock/agentKnowledgeBase:AgentKnowledgeBase` | `AWS::Bedrock::KnowledgeBase` | Bedrock Knowledge Base | RAG KB |
| `aws:bedrock/agentDataSource:AgentDataSource` | `AWS::Bedrock::DataSource` | Bedrock KB data source | S3 ingest |
| `aws:bedrock/agentAgent:AgentAgent` (+`AgentAlias`, `AgentActionGroup`) | `AWS::Bedrock::Agent`, `AWS::Bedrock::AgentAlias` | Bedrock Agents | Autonomous agent + tools |
| `aws:bedrock/guardrail:Guardrail` (+`GuardrailVersion`) | `AWS::Bedrock::Guardrail` | Bedrock Guardrails | AI safety filter |
| `aws:bedrock/agentcoreAgentRuntime:*` (+`Endpoint`) | `AWS::BedrockAgentCore::Runtime` (+`RuntimeEndpoint`) | Bedrock AgentCore | Production agent runtime |
| `aws:bedrock/agentcoreMemory:*` | `AWS::BedrockAgentCore::Memory` | AgentCore Memory | Session memory |
| `aws:bedrock/agentcoreGateway:*` (+`GatewayTarget`) | `AWS::BedrockAgentCore::Gateway` (+`GatewayTarget`) | AgentCore Gateway | Tool/API gateway w/ auth |
| (resource-based policy, SDK or CDK `CfnResourcePolicy`) | `AWS::BedrockAgentCore::ResourcePolicy` | AgentCore Runtime/Gateway cross-account policy | Crosscutting (§8), IAM model |
| `aws:bedrock/agentcoreBrowser:*`, `agentcoreCodeInterpreter:*` | `AWS::BedrockAgentCore::*` | AgentCore tools | Browser / code sandbox |
| `aws:bedrock/provisionedModelThroughput:*`, `customModel:*`, `inferenceProfile:*` | `AWS::Bedrock::ApplicationInferenceProfile` (PTU + custom-model fine-tune are API-only, no public CFN type) | Bedrock | PTU / fine-tune / cross-region inference |
| `aws:sagemaker/endpoint:Endpoint` (+`EndpointConfiguration`) | `AWS::SageMaker::Endpoint` (+`EndpointConfig`) | SageMaker | Real-time inference |
| `aws:sagemaker/model:Model`, `trainingJob:TrainingJob` | `AWS::SageMaker::Model` | SageMaker | Model artifact / training |
| `aws:sagemaker/pipeline:Pipeline` | `AWS::SageMaker::Pipeline` | SageMaker Pipelines | ML workflow |
| `aws:sagemaker/featureGroup:FeatureGroup` | `AWS::SageMaker::FeatureGroup` | SageMaker Feature Store | Feature serving |
| `aws:sagemaker/modelPackageGroup:ModelPackageGroup` | `AWS::SageMaker::ModelPackageGroup` | SageMaker Model Registry | Model versions |
| `aws:sagemaker/domain:Domain` | `AWS::SageMaker::Domain` | SageMaker Studio | ML platform |

**Bedrock Runtime and SageMaker training jobs are often SDK-only** (no IaC resource). Signal: Lambda/ECS env var `MODEL_ID`/`BEDROCK_MODEL_ID` + IAM `bedrock:InvokeModel`; or a `sagemaker:CreateTrainingJob` permission. In CDK these appear as `grantInvoke`/`addToRolePolicy` calls in source, not as a synthesized resource. Record as a flow edge, not a resource.

**Typical flows to capture as `flows` in the model:**
- Inference: User -> CloudFront? -> API Gateway -> Lambda/ECS -> Bedrock InvokeModel/InvokeAgent / SageMaker endpoint -> (KB retrieval via AOSS) -> response -> CloudWatch.
- Training: S3 data lake -> EventBridge -> Step Functions / SageMaker Pipeline -> Training Job -> S3 artifact -> Model Registry -> Endpoint -> CloudWatch drift -> retrain.
- RAG ingest: S3 docs -> Bedrock KB data source sync -> embedding model -> AOSS VECTORSEARCH.

## Security / cost / reliability signals (`_model/signals.json`)

Flag with severity + provenance. MUST aligns with the repository's own AWS rules (its SECURITY.md or INFRA.md, when it has one).

Property names below show the Pulumi form; the CloudFormation/CDK form is equivalent (e.g., `AuthType: NONE` on `AWS::Lambda::Url`, `BlockPublicAcls`/`PublicAccessBlockConfiguration` on `AWS::S3::Bucket`, `HttpTokens: optional` on the launch template). Match on intent, not exact key.

**Security (MUST):** Lambda Function URL `authorizationType`/`AuthType` `"NONE"`; IAM `Action`/`Resource` `"*"`; S3 missing `blockPublicAccess`/`PublicAccessBlockConfiguration`; Lambda permission `principal`/`Principal` `"*"`; Cognito `allowedOauthFlows` includes `"implicit"`; CORS `allow_origins ["*"]`; secrets in Lambda `environment.variables`/`Environment.Variables` (names like `PASSWORD`/`SECRET`/`KEY`); IMDSv1 (`httpTokens`/`HttpTokens` `"optional"`); SG `0.0.0.0/0` on 22/3389. **SHOULD:** missing encryption at rest; sensitive resource outside VPC; AOSS without KMS CMK.

**Cost (SHOULD):** SageMaker endpoint always-on without auto-scaling; Bedrock provisioned throughput vs utilization; Lambda `memorySize` > 3008 on light workloads; S3 without lifecycle rules; training on on-demand only (no Spot/savings plan).

**Reliability (SHOULD):** Lambda async without `deadLetterConfig`; Step Functions without `Retry`/`Catch`; SQS without `redrivePolicy`; SageMaker endpoint single `instanceCount: 1`; no CloudWatch alarms; Bedrock Agent without `guardrailConfiguration`.

## Model JSON schema (`_model/model.json`)

```json
{
  "meta": { "iac_tool": "pulumi|cdk", "tier": "1|2|3", "generated": "ISO8601", "projects": [], "stacks": [], "caveats": [] },
  "elements": [
    {
      "id": "stable-slug",
      "name": "inference-handler",
      "kind": "container|component|datastore|external|actor|ai",
      "iac_type": "aws:lambda/function:Function",
      "aws_service": "Lambda",
      "level": "L200",
      "project": "myproject",
      "stack": "prod",
      "provenance": { "urn": "urn:pulumi:prod::...", "logical_id": "InferenceFnXXXX", "cdk_path": "App/ProdStack/InferenceFn", "file": "src/api.ts", "line": 42 },
      "attrs": { "runtime": "python3.12", "model_id": "anthropic.claude-..." }
    }
  ],
  "edges": [
    { "from": "id-a", "to": "id-b", "kind": "invokes|reads|writes|depends|references", "label": "InvokeModel", "provenance": {} }
  ],
  "flows": [
    { "id": "inference", "level": "L300", "steps": [ {"from":"user","to":"apigw","label":"POST /invoke"} ] }
  ],
  "signals": [
    { "id": "sig-1", "category": "security|cost|reliability", "severity": "MUST|SHOULD|NIT", "title": "", "provenance": {} }
  ],
  "adr_candidates": [
    { "title": "Pulumi over CDK", "evidence_ids": [], "provenance": {} }
  ],
  "unverified": [ "note about anything inferred but not located" ]
}
```

**Provenance rule**: every element, edge, flow step, and signal carries `provenance` with the strongest anchor available: a Pulumi `urn`, a CloudFormation `logical_id` (+ `cdk_path`), or a `file:line`. Entries without provenance go in `unverified[]` and are excluded from generated diagrams.
