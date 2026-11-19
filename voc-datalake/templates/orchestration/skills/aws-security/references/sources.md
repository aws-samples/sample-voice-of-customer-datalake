# Sources

Non-obvious claims verified against these sources, with the date checked.

| Claim | Source | Checked |
|---|---|---|
| Global Bedrock inference profiles use an empty-region foundation-model ARN (`arn:aws:bedrock:::foundation-model/<id>`) scoped via `aws:RequestedRegion` + `bedrock:InferenceProfileArn`, not a wildcard resource | https://docs.aws.amazon.com/bedrock/latest/userguide/global-cross-region-inference.html | 2026-10-28 |
| Geographic cross-Region inference profiles require three resource grants (profile, source-Region model, destination-Region models) | https://docs.aws.amazon.com/bedrock/latest/userguide/geographic-cross-region-inference.html | 2026-10-28 |
| cdk-nag is licensed Apache-2.0, current major version 3.x | https://github.com/cdklabs/cdk-nag (LICENSE, package.json) | 2026-10-28 |
