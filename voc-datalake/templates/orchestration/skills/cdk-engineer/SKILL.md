---
name: cdk-engineer
description: "Writes AWS CDK in TypeScript or Python at the highest construct level and the repository's library version; blocks raw L1 resources, hand-rolled IAM JSON, string-built ARNs and redundant custom resources. Read it when writing or editing CDK apps, stacks or constructs."
source: "ai-skill-factory 2.0.0 (Amit Deol), skills/cdk-engineer"
license: MIT
adapted: "The spec-loader step reads INFRA.md and STANDARDS.md with read_file. Versions come from the repository's lockfile, not a registry query (no network). The gate is offline: synth, nag, cfn-lint and tests; cdk diff and deploy need an account the agents never have, and a person deploys. Commands are run's argv. Slash references name library skills; description reworded for Claude 5.5 skill discovery"
---

Model the infrastructure your task asks for in CDK, at the highest construct level that fits.

Authoring skill. For a failed `cdk deploy`, use the `cdk-doctor` skill. For IAM and encryption policy, the
`aws-security` skill. For the general no-hand-rolling ladder, the `use-the-sdk` skill.

The run never deploys: you write and test the CDK code, offline, and a person deploys it.

## Step 0: Load Project Standards

If the repository has an INFRA.md, read it with `read_file` for approved services, regions and account layout,
and a STANDARDS.md for language, package manager and size limits; else the defaults below. Read `cdk.json` for
context, feature flags, and the app entry point.

## Step 1: Take Versions From the Repository

Never recall a version from memory. Read what the repository pins: `package.json` and its lockfile (or
`requirements.txt`, `pyproject.toml` and its lock) for `aws-cdk-lib`, `constructs`, `aws-cdk` and `cdk-nag`, and the
installed copy under `node_modules/` (or the virtual environment). The sandbox has no network, so a registry query
(`npm view`, PyPI) is not possible: a newer version you believe exists is named in your finish as unchecked, never
written into a pin.

Anchor, verified 28 October 2026 (for orientation only; the repository's pins win):

| Package | Version |
|---|---|
| `aws-cdk-lib` | 2.275.0 |
| `aws-cdk` (CLI) | 2.1146.1 |
| `constructs` | 10.8.1 |
| `cdk-nag` | 3.0.2 |

Rules: one `aws-cdk-lib` entry, never per-service v1 packages. `constructs` on `^10`.
Alpha modules carry their own `-alpha.N` version that must match the `aws-cdk-lib` minor.
If the repo is more than a few minors behind and the code needs a newer construct, say so
rather than reimplementing the construct by hand.

## Step 2: The Construct Ladder

Stop at the first rung that satisfies the requirement. Record the rung in the report.

| # | Rung | Example |
|---|---|---|
| 1 | Existing construct in this repo | Search `lib/` and `constructs/` before writing anything |
| 2 | L3 pattern | `ApplicationLoadBalancedFargateService`, `LambdaRestApi`, AWS Solutions Constructs, Construct Hub |
| 3 | L2 construct | `Bucket`, `Table`, `Function`, `StateMachine`, `Queue`, `Vpc` |
| 4 | L2 plus escape hatch | `addPropertyOverride` on the L2's `defaultChild` for a missing property |
| 5 | L1 `Cfn*` resource | Only when no L2 exists for that resource type |
| 6 | Custom resource | `AwsCustomResource`, or the provider framework for multi-step work |
| 7 | Hand-written code | Effectively never. Justify it in the report |

Rung 4 is the one that gets skipped. A missing property is not a reason to drop the whole
resource to L1, which forfeits every grant, metric, and sane default the L2 provides.

```typescript
const cfnBucket = bucket.node.defaultChild as s3.CfnBucket;
cfnBucket.addPropertyOverride("AccelerateConfiguration.AccelerationStatus", "Enabled");
```

Escape hatch techniques, including `addOverride`, `addDeletionOverride`, raw overrides, and
removing generated resources: `references/escape-hatches.md`.

## Step 3: Structural Rules

From the official [CDK best practices](https://docs.aws.amazon.com/cdk/v2/guide/best-practices.html).
These prevent rework that no amount of clean construct code recovers from.

| Rule | Why it matters |
|---|---|
| Model with constructs, deploy with stacks | A logical unit is a `Construct`. Stacks only describe how units compose for a deployment scenario |
| Configure with props and methods, not environment variables | Env lookups inside a construct bind it to the machine. Confine them to the app entry point |
| Decide at synthesis time | Use the language's `if` and loops. Avoid `CfnParameter`, `CfnCondition`, and `Fn::If` |
| Model every stage in code | A stack per stage with its config in source, not one parameterised template |
| Let CDK generate physical names | A hardcoded `bucketName` or `tableName` blocks a second deployment and blocks replacement |
| Split stateful from stateless stacks | Turn on termination protection for the stateful stack, then redeploy stateless freely |
| Never change the logical ID of a stateful resource | Renaming or re-parenting replaces it. Assert IDs in a test (Step 6) |
| Set removal policy and log retention deliberately | CDK defaults retain data and logs forever, which becomes a cost problem in production |
| No side effects or network lookups during synth | Synth must be deterministic. Commit `cdk.context.json` so `fromLookup` results are stable |

Constructs alone are not compliance. A `MyCompanyBucket` wrapper surfaces guidance early, but
enforcement belongs in service control policies, permission boundaries, Aspects, and
cfn-guard. A wrapper also blocks consumers from AWS Solutions Constructs and Construct Hub.

Detail and worked examples: `references/app-structure.md`.

## Step 4: Never Hand-Roll These in CDK

Each is a MUST finding. Use the named built-in.

| Hand-rolled | Use instead |
|---|---|
| IAM policy JSON or `PolicyStatement` for a common flow | `grantRead`, `grantWrite`, `grantInvoke`, `grantPutEvents` |
| ARN built by string concatenation or template literal | Resource attribute (`table.tableArn`), or `Arn.format` / `stack.formatArn` |
| Region, account, or partition hardcoded | `Stack.of(this).region`, `.account`, `.partition` |
| Custom log-retention Lambda | `logRetention` or `logGroup` on the L2 |
| CloudWatch alarm built from raw metric namespaces | `resource.metricXxx().createAlarm()` |
| Hand-written subnet CIDR maths | `Vpc` with `ipAddresses` and `subnetConfiguration` |
| Cross-stack value passed as a string export | Pass the construct or its typed attribute |
| Secret value read into a variable | `Secret.fromSecretNameV2`, `secret.grantRead`, `ecs.Secret.fromSecretsManager` |
| Bundling shelled out through `local-exec` style commands | `NodejsFunction`, `PythonFunction`, `Code.fromAssetImage`, `DockerImageAsset` |
| Environment variable read inside a construct or stack | A props object. Confine env and context reads to the app entry point |
| Physical resource name hardcoded to make a reference work | Pass `table.tableName` as an env var, or read it from SSM at runtime |
| Polling loop waiting for a resource | Custom resource provider framework `isComplete`, or a Step Functions wait |
| Tags applied per resource | `Tags.of(scope).add(...)` at stack or app scope |
| Hand-built Step Functions state JSON | `aws-cdk-lib/aws-stepfunctions-tasks` classes |
| Manual `DependsOn` string wiring | `resource.node.addDependency(other)` |
| String manipulation on a token | `Fn.select`, `Fn.split`, `Token.asString`, `Lazy.string` |

`grant*` methods are the single most-missed built-in. They write a least-privilege policy and
attach any needed KMS grant. A hand-written statement usually misses the KMS half.

## Step 5: Verify the API Before Using It

The most common CDK defect from an agent is a plausible property that does not exist. Before
first use of any construct, prop, or method:

- `list_files` on `node_modules/aws-cdk-lib/aws-lambda/lib/`, then `read_file` on its `.d.ts` files
- `run` `["grep", "-rn", "readonly memorySize", "node_modules/aws-cdk-lib/aws-lambda/lib/function-props.d.ts"]`
- Python apps: `run` `["python3", "-c", "import aws_cdk.aws_lambda as l; help(l.FunctionProps)"]`

Read the installed source, not your recollection. If a symbol is absent from the installed
version, either upgrade deliberately or use the escape hatch. Do not invent a prop name.
Protocol: the `code-review` skill's api-verification reference.

## Step 6: Tests Before Anyone Deploys

Fine-grained assertions catch what `synth` alone does not.

```typescript
const template = Template.fromStack(stack);
template.hasResourceProperties("AWS::S3::Bucket", {
  BucketEncryption: Match.objectLike({ ServerSideEncryptionConfiguration: Match.anyValue() }),
});
template.resourceCountIs("AWS::IAM::Role", 2);
```

- Assert on the properties that carry policy: encryption, retention, public access, removal.
- Assert that the logical IDs of stateful resources are unchanged, so a later refactor cannot
  silently replace a database or bucket. This is the cheapest test in the suite.
- Snapshot tests catch drift. Review the snapshot diff, do not accept it blindly (the `tdd` skill, Step 6).
- Test synth for both dev and prod context values when behaviour branches on context.

```typescript
expect(Object.keys(template.findResources("AWS::DynamoDB::Table"))).toEqual(["OrdersTableABC12345"]);
```

## Step 7: Gate Before Reporting Done

| Gate | Command | Blocks on |
|---|---|---|
| Synth | `cdk synth` (offline: a `fromLookup` the committed `cdk.context.json` does not answer fails here) | Construct and import errors |
| Nag | cdk-nag `AwsSolutionsChecks` as an Aspect | Security rule violations, unjustified suppressions |
| Lint | `cfn-lint` on each template under `cdk.out/` | Invalid property values |
| Tests | `npm test` / `python -m pytest` | Assertion failures |

`cdk diff` and `cdk deploy` need the deployed account, which an agent never has: the logical-ID assertions of
Step 6 stand in for the diff's replacement check, and your finish says the diff is a person's to read before they
deploy. Every cdk-nag suppression needs a reason string naming the compensating control. A blanket suppression is a
MUST finding. Deployment failures after this point: the `cdk-doctor` skill.

## Step 8: Report

Put this in your `finish` summary:

```
## CDK: [what was modelled]

| Resource | Rung | Construct | Rejected |
|---|---|---|---|
| Fargate service | 2 (L3) | ApplicationLoadBalancedFargateService | 40 lines of L1 + LB wiring |
| S3 accelerate | 4 (escape hatch) | Bucket + addPropertyOverride | full L1 CfnBucket |

- Versions: aws-cdk-lib X (from the lockfile), CLI Y
- Built-ins used: grantRead, metricErrors, logRetention
- API verified: [symbol, file read]
- Gates: synth exit 0, nag 0 unsuppressed, logical IDs asserted, tests X passed; cdk diff left to a person
- Suppressions: [rule, reason, compensating control]
```

## Self-Check

- [ ] Versions taken from the repository's pins, not recalled
- [ ] Highest workable rung chosen, and the rung recorded
- [ ] No L1 resource where an L2 exists, no L1 drop to reach one property
- [ ] No item from the Step 3 table hand-rolled
- [ ] Every prop and method confirmed against installed source
- [ ] `grant*` used instead of hand-written policy statements
- [ ] Step 3 structural rules held: constructs for modelling, props for config, synth-time decisions
- [ ] No physical names hardcoded, no logical ID change on a stateful resource
- [ ] Removal policy and log retention chosen deliberately for production resources
- [ ] `cdk.context.json` answers every `fromLookup` (a lookup needs the account; you have none)
- [ ] Logical IDs of stateful resources asserted, so a person's cdk diff shows no replacement
- [ ] Nag suppressions justified individually

Before you claim the stack works, apply the `verification-before-completion` skill.
