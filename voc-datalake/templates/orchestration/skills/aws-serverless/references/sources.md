# Sources

Non-obvious claims verified against AWS documentation. Checked 2026-10-28.

| Claim | Source | Checked |
|---|---|---|
| Lambda Durable Functions GA, checkpoint/resume via `context.step()`/`context.wait()`, pause up to 1 year, US East (Ohio) only, Python 3.13/3.14 + Node.js 22/24 | https://docs.aws.amazon.com/lambda/latest/dg/durable-functions.html, https://aws.amazon.com/about-aws/whats-new/2025/12/lambda-durable-multi-step-applications-ai-workflows/ | 2026-10-28 |
| SnapStart supports Java 11+, Python 3.12+, .NET 8+ (not Java-only) | https://docs.aws.amazon.com/lambda/latest/dg/snapstart.html, https://aws.amazon.com/blogs/aws/aws-lambda-snapstart-for-python-and-net-functions-is-now-generally-available/ | 2026-10-28 |
| `NodejsFunction.logRetention` is deprecated in favor of `logGroup` | https://constructs.dev/packages/aws-cdk-lib/v/2.275.0/api/NodejsFunction | 2026-10-28 |
| HTTP API $1.00/M (first 300M)/mo vs REST API $3.50/M (first 333M)/mo | https://docs.aws.amazon.com/whitepapers/latest/best-practices-api-gateway-private-apis-integration/cost-optimization.html | 2026-10-28 |
