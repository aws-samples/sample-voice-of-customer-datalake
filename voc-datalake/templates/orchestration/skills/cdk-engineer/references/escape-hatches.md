# CDK Escape Hatches

Rung 4 of the construct ladder in the `cdk-engineer` skill. Reach for these when an L2 construct lacks a
property, so you keep its grants, metrics, and defaults instead of dropping to L1.

Verified against `aws-cdk-lib` 2.275.0, 28 October 2026.

## Getting the L1 Behind an L2

```typescript
const cfnBucket = bucket.node.defaultChild as s3.CfnBucket;
```

```python
cfn_bucket = bucket.node.default_child  # type: s3.CfnBucket
```

For a construct whose L1 is nested deeper, walk the tree rather than guessing:

```typescript
stack.node.findAll().forEach((c) => console.log(c.node.path, c.constructor.name));
```

## The Four Override Methods

| Method | Use for | Note |
|---|---|---|
| `addPropertyOverride(path, value)` | A property CloudFormation supports and the L2 does not expose | Path uses CloudFormation property names, dot separated |
| `addOverride(path, value)` | Anything outside `Properties`, such as `UpdatePolicy` or `Metadata` | Prefix a resource-level path with no `Properties.` |
| `addDeletionOverride(path)` | Removing a property the L2 sets that you do not want | Safer than setting it to undefined |
| `addPropertyDeletionOverride(path)` | Removing one generated property | Scoped to `Properties` |

```typescript
cfnBucket.addPropertyOverride("AccelerateConfiguration.AccelerationStatus", "Enabled");
cfnBucket.addOverride("UpdateReplacePolicy", "Retain");
cfnBucket.addDeletionOverride("Properties.LoggingConfiguration");
```

Escaped hatch values bypass CDK validation. Confirm the property name and casing against the
CloudFormation resource reference for that resource type before using it.

## Path Casing: Match the CloudFormation Schema, Not the L2 Prop

`addPropertyOverride` and `addOverride` take a dot-separated path into the rendered
CloudFormation template, not the L2's TypeScript/Python prop name. The path must use the exact
CloudFormation property names (PascalCase), including list indices:

```typescript
cfnBucket.addPropertyOverride("Tags.0.Value", "NewValue");         // CFN property name, not `tags`
cfnBucket.addPropertyOverride("VersioningConfiguration.Status", "Enabled");
```

There is no `addRawOverride` method on `CfnResource`; it does not exist in `aws-cdk-lib`. If a
path write does not take effect, the cause is almost always a mismatched CloudFormation property
name or an index into the wrong list depth. Check the
[CloudFormation resource reference](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-template-resource-type-ref.html)
for the exact property name before adjusting the path.

## Escaping Upward: Wrapping an L1 as an L2

When no L2 exists at all, write a small construct that owns the L1 and exposes typed
attributes and `grant*` methods. This is a legitimate custom construct, not hand-rolling,
because it concentrates the raw resource behind one reviewed boundary.

```typescript
export class Thing extends Construct {
  public readonly arn: string;
  constructor(scope: Construct, id: string, props: ThingProps) {
    super(scope, id);
    const resource = new svc.CfnThing(this, "Resource", { ... });
    this.arn = resource.attrArn;
  }
  public grantRead(grantee: iam.IGrantable) {
    return iam.Grant.addToPrincipal({ grantee, actions: ["svc:GetThing"], resourceArns: [this.arn] });
  }
}
```

Do not scatter `Cfn*` resources across stacks. One wrapper, reviewed once.

## Removing a Generated Resource

Occasionally an L2 creates a resource you must not have, such as an auto-generated log group
already managed elsewhere:

```typescript
const child = construct.node.tryFindChild("LogRetention") as cdk.CfnResource | undefined;
child?.node.scope?.node.tryRemoveChild("LogRetention");
```

Prefer configuring the L2 to not create it. Removal is a last resort, and `cdk diff` must be
read carefully afterwards, since removing a resource from the template can delete it.

## Logical ID Stability

Escape hatches do not change logical IDs. Renaming or re-parenting a construct does, which
replaces the resource. To keep an existing resource while restructuring:

```typescript
cfnBucket.overrideLogicalId("MyOriginalBucketLogicalId1234ABCD");
```

Before anyone deploys a restructure, `cdk diff` must show zero replacements. The diff needs the deployed
account, which the agents never have: assert the stateful logical IDs in a test, and say in your finish that the
diff is the deploying person's to read. A replacement on a stateful resource (bucket, table, database) is a MUST
finding unless intended and backed up.

## When an Escape Hatch Is the Wrong Answer

| Situation | Do this instead |
|---|---|
| The property exists on the L2 under a different name | Use the real prop. Verify against installed source |
| You need behaviour, not configuration | Custom resource provider framework |
| The resource type has no L2 and you need it in several places | Wrap the L1 in a construct, as above |
| A newer `aws-cdk-lib` exposes the property | Upgrade deliberately, and say so |
| The requirement is a security control | Model it properly, then let cdk-nag check it (the `aws-security` skill) |
