# CDK App Structure and Determinism

Detail behind Step 3 of the `cdk-engineer` skill. Sourced from the official
[AWS CDK best practices](https://docs.aws.amazon.com/cdk/v2/guide/best-practices.html) and the
[CDK layer guide](https://docs.aws.amazon.com/prescriptive-guidance/latest/aws-cdk-layers/best-practices.html),
read 28 October 2026.

## Model With Constructs, Deploy With Stacks

A stack is the unit of deployment: everything in it deploys together. A logical unit of your
system is therefore a `Construct`, not a `Stack`.

```typescript
// The website is a construct: bucket, distribution, API, functions.
export class Website extends Construct { /* ... */ }

// Stacks only describe composition for a deployment scenario.
class ProdStack extends Stack {
  constructor(scope: Construct, id: string, props: StackProps) {
    super(scope, id, props);
    new Website(this, "Website", { domain: "example.com", minCapacity: 4 });
  }
}
```

Modelling a logical unit as a `Stack` forfeits reuse and forces deployment shape onto design.

## Configure With Props, Not Environment Variables

An env lookup inside a construct binds it to whichever machine runs synth, which is untracked
configuration. Accept a props object instead.

```typescript
// Wrong: the construct now depends on the shell that synthesised it.
const tableName = process.env.TABLE_NAME;

// Right: the caller decides, and the type system checks it.
interface ApiProps { readonly table: dynamodb.ITable; }
```

Confine env and context reads to the app entry point, and only for development-time values.

## Decide at Synthesis Time

CloudFormation `Parameters`, `Conditions`, and `Fn::If` push decisions to deploy time, where the
available types and operations are far narrower than a programming language. They also break
determinism: the same template can produce different infrastructure.

| Instead of | Use |
|---|---|
| `CfnParameter` for an environment name | A separate stack per stage, config in code |
| `CfnCondition` around a resource | An `if` in the construct, or a different stack |
| `Fn::If` to pick a size | A value from props, chosen by the calling stack |

Treat CloudFormation as an implementation detail, not a language target.

## Model Every Stage in Code

One stack per stage, each with its configuration in source. Sensitive values come from Secrets
Manager or Parameter Store by name or ARN, not from a checked-in literal. Synth then produces a
separate deterministic template per environment in `cdk.out`, which makes unit tests meaningful.

## Let CDK Generate Physical Names

A name can only be used once per account and region. Hardcoding `bucketName` or `tableName`:

- Blocks a second deployment of the same stack into one account.
- Blocks any change that requires replacement, because the replacement cannot take a name the
  original still holds. Immutable properties such as a DynamoDB `KeySchema` require replacement.

Pass the generated name where it is needed instead: an env var on a Lambda function, an SSM
parameter the application reads, or a construct reference between stacks in the same app. For
a resource in a different app, use a `from*` static method with the ARN.

## Stateful and Stateless Stacks

Keep databases, buckets, and VPCs in a separate stack from compute:

- Turn on termination protection for the stateful stack.
- Destroy and recreate the stateless stack freely, including per-developer copies.
- Stateful resources are the most sensitive to renaming, so keep them out of constructs that
  are likely to be moved or restructured.

## Logical IDs and Replacement

A logical ID derives from the construct id and its position in the tree. Renaming either
replaces the resource. For a database or bucket that means data loss or an orphaned resource.

- Assert stateful logical IDs in a unit test, so a refactor fails the build rather than the
  deployment.
- To restructure while keeping a resource, pin the old value with `overrideLogicalId`.
- Before anyone deploys a restructure, `cdk diff` must show zero replacements (a person reads it: the agents have
  no account).

## Removal Policy and Log Retention

CDK defaults protect data: resources holding data are orphaned rather than deleted, and logs
are retained forever. Both defaults cost money in production if left unexamined.

| Resource | Decide |
|---|---|
| Data stores | `removalPolicy`: retain for production, destroy for ephemeral dev stacks |
| Log groups | `retention`: a real period, not the default indefinite |
| Snapshots | Whether a final snapshot is taken on delete |

Validate these with an Aspect so the rule applies to every resource, not the ones you remembered.

## Determinism and cdk.context.json

Synth must produce the same template for the same commit. Two failure modes:

- A `fromLookup` or SDK call at synth time returns a different value later. The classic cases
  are the AZ count changing, which re-splits your CIDR space, and a new AMI being released,
  which replaces every instance.
- Synth mutates the account. Synth must have no side effects, so changes belong in the deploy
  phase where CloudFormation can roll them back. Use a custom resource for deploy-time work.

Context providers cache lookup results in `cdk.context.json`. Commit it. Refresh entries
deliberately with the CDK CLI context commands. For a value with no context provider, write a
separate script that records it to a file, and run that script only when you intend to refresh.

## Compliance Needs More Than Constructs

Wrapping an L2 to bake in encryption and IAM defaults is useful for surfacing guidance early.
It is not enforcement, and it has a cost.

| Layer | Mechanism |
|---|---|
| Prevention at the org level | Service control policies, permission boundaries |
| Assertion before deployment | Aspects, cdk-nag, cfn-guard |
| Guidance at authoring time | Wrapper constructs, shared construct library |

A private wrapper also blocks consumers from AWS Solutions Constructs, Construct Hub, and
third-party constructs, since those build on the standard L2s. Weigh that before mandating one.
