# Sources

Non-obvious claims in this skill, with the source checked and the date checked.

| Claim | Source | Checked |
|---|---|---|
| `aws-cdk-lib` 2.275.0, `aws-cdk` CLI 2.1146.1, `constructs` 10.8.1, `cdk-nag` 3.0.2 | https://registry.npmjs.org/aws-cdk-lib/latest, /aws-cdk/latest, /constructs/latest, /cdk-nag/latest | 2026-10-28 |
| `CfnResource` has `addOverride`, `addPropertyOverride`, `addDeletionOverride`, `addPropertyDeletionOverride`; no `addRawOverride` method exists | https://docs.aws.amazon.com/cdk/v2/guide/cfn-layer.md | 2026-10-28 |
| Override paths use CloudFormation property names (PascalCase), not the L2 TypeScript/Python prop name | https://docs.aws.amazon.com/cdk/v2/guide/cfn-layer.md | 2026-10-28 |
| CDK structural best practices (constructs vs stacks, props over env vars, synth-time decisions, physical names, logical ID stability) | https://docs.aws.amazon.com/cdk/v2/guide/best-practices.html | 2026-10-28 |
