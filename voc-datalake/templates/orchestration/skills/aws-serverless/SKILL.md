---
name: aws-serverless
description: "Build or review serverless applications on AWS Lambda, API Gateway, EventBridge, Step Functions, SQS and DynamoDB. Function design and limits, event source patterns, orchestration, IaC in SAM or CDK, observability, cold starts, cost and the anti-patterns to catch."
source: "ai-skill-factory 2.0.0 (Amit Deol), skills/aws-serverless"
license: MIT
adapted: "Discovery uses list_files and read_file. The deployment step became IaC the agents write and validate offline (sam validate, cdk synth, sam local without Docker where possible); sam deploy, cdk deploy and cdk diff are a person's, since the run never deploys and has no account. Account commands in the references are marked as a person's. Slash references name library skills; deploy-on-aws (not vendored) is dropped."
---

Build or review the serverless application your task names.

## Step 1: Detect Serverless Stack

Look for existing serverless infrastructure with `list_files` and `read_file`:

- SAM projects: `template.yaml`, `template.yml`, `samconfig.toml`
- CDK projects: `cdk.json`, `bin/`, `lib/*stack*`
- Lambda functions: the handler files the templates or stacks name

Determine: SAM vs CDK, runtime (Python/TypeScript/Java), event sources, existing patterns.

## Step 2: Lambda Function Design

### Runtime Selection

| Language | When to Use | Powertools |
|---|---|---|
| TypeScript (default) | APIs, web backends, most use cases | Yes |
| Python | Data processing, ML inference, scripting | Yes |
| Java | Enterprise, high-throughput, Spring Boot | Yes |
| Rust | Ultra-low latency, cost optimization | Community |

### Function Structure (TypeScript)

```typescript
import { Logger } from '@aws-lambda-powertools/logger';
import { Tracer } from '@aws-lambda-powertools/tracer';
import { Metrics } from '@aws-lambda-powertools/metrics';

const logger = new Logger();
const tracer = new Tracer();
const metrics = new Metrics();

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  const segment = tracer.getSegment();
  try {
    logger.info('Processing request', { path: event.rawPath });
    metrics.addMetric('RequestCount', 'Count', 1);

    // Business logic here

    return { statusCode: 200, body: JSON.stringify({ success: true }) };
  } catch (error) {
    logger.error('Request failed', { error });
    metrics.addMetric('ErrorCount', 'Count', 1);
    return { statusCode: 500, body: JSON.stringify({ error: 'Internal error' }) };
  }
};
```

### Function Configuration Checklist

- [ ] Explicit `timeout` set (not default 3s; max 900s)
- [ ] Explicit `memorySize` set (1 vCPU = 1769MB)
- [ ] Log group with retention policy (not infinite)
- [ ] X-Ray tracing enabled
- [ ] Dead letter queue for async invocations
- [ ] Reserved concurrency for production (prevent runaway scaling)
- [ ] Environment variables for config (never secrets)
- [ ] Secrets in SSM Parameter Store or Secrets Manager

### Lambda Limits Quick Reference

| Resource | Limit |
|---|---|
| Timeout | 900s (15 min) |
| Memory | 128MB – 10,240MB |
| Sync payload | 6MB request + 6MB response |
| Async payload | 1MB |
| Streamed response | 200MB |
| Package (uncompressed) | 250MB |
| Container image | 10GB |
| Layers | 5 per function |
| `/tmp` storage | 512MB – 10,240MB |
| Concurrent executions (default) | 1,000 |

## Step 3: Event Source Patterns

### API Gateway (REST/HTTP APIs)

| Feature | HTTP API (default) | REST API |
|---|---|---|
| Cost | $1.00/M requests | $3.50/M requests |
| Latency | Lower | Higher |
| Auth | JWT, IAM, Lambda | JWT, IAM, Lambda, Cognito, API keys |
| WebSocket | No | No (use WebSocket API) |
| Usage plans | No | Yes |

Default to HTTP API unless the task needs REST API features.

### Event Source Mapping (ESM) Patterns

| Source | Batch Size | Parallelization | Error Handling |
|---|---|---|---|
| DynamoDB Streams | 1-10,000 (default 100) | Up to 10 per shard | Bisect on error, max retries, DLQ |
| SQS | 1-10,000 (default 10) | Up to 1,000 | Visibility timeout, DLQ, partial batch |
| Kinesis | 1-10,000 (default 100) | Up to 10 per shard | Bisect on error, max retries |
| Kafka (MSK/self-managed) | 1-10,000 (default 100) | 1 per partition | DLQ |

### EventBridge Patterns

```typescript
// CDK: EventBridge rule → Lambda
const rule = new events.Rule(this, 'OrderRule', {
  eventPattern: {
    source: ['com.myapp.orders'],
    detailType: ['OrderCreated'],
  },
});
rule.addTarget(new targets.LambdaFunction(orderHandler, {
  retryAttempts: 2,
  deadLetterQueue: dlq,
}));
```

### S3 Event Notifications

```typescript
bucket.addEventNotification(
  s3.EventType.OBJECT_CREATED,
  new s3n.LambdaDestination(processUpload),
  { prefix: 'uploads/', suffix: '.csv' }
);
```

## Step 4: Step Functions & Orchestration

### When to Use What

| Pattern | Use Case | Service |
|---|---|---|
| Simple sequence | A → B → C | Step Functions (Express) |
| Long-running workflow | Human approval, wait states | Step Functions (Standard) |
| Fan-out/fan-in | Process items in parallel | Step Functions Distributed Map |
| Event choreography | Loose coupling, multiple consumers | EventBridge |
| Durable functions | Checkpoint/resume within Lambda | Lambda Durable Functions |
| Saga pattern | Distributed transactions with compensation | Step Functions or Lambda Durable Functions |

Lambda Durable Functions (GA December 2025) checkpoint and resume Node.js/Python handlers
natively via `context.step()` and `context.wait()`, pausing up to one year without compute
charges. Available in US East (Ohio), Python 3.13/3.14 and Node.js 22/24 only; use Step
Functions outside that region/runtime set.

### Step Functions Best Practices

- Use JSONata for data transformation (preferred over JSONPath)
- Add `Retry` on every Task state: `Lambda.ServiceException`, `Lambda.AWSLambdaException`
- Add `Catch` for business errors with fallback states
- Use SDK integrations to call AWS services directly (skip Lambda for simple operations)
- Use Distributed Map for processing large datasets (S3 items, DynamoDB scans)
- Express workflows for high-volume, short-duration (<5 min) workflows
- Standard workflows for long-running, auditable workflows

## Step 5: Infrastructure as Code (written here, deployed by a person)

The run never deploys and has no AWS account: write the template or stack, validate it offline, and leave the
deploy to a person.

### SAM

```bash
# Validate the template (offline lint)
sam validate --lint

# Build (a build that needs a container image needs Docker, which the sandbox does not have)
sam build

# A person deploys
sam deploy --guided  # First time
sam deploy           # Subsequent
```

### CDK

```bash
# Synth (offline; the `cdk-engineer` skill has the gate)
cdk synth

# A person diffs and deploys (both need the account)
cdk diff
cdk deploy --all --require-approval broadening
```

### CDK Serverless Constructs

```typescript
// Lambda with Powertools
const handler = new NodejsFunction(this, 'Handler', {
  entry: 'src/handler.ts',
  runtime: Runtime.NODEJS_20_X,
  timeout: Duration.seconds(30),
  memorySize: 512,
  tracing: Tracing.ACTIVE,
  logGroup: new LogGroup(this, 'HandlerLogs', { retention: RetentionDays.TWO_WEEKS }),
  environment: {
    POWERTOOLS_SERVICE_NAME: 'my-service',
    LOG_LEVEL: 'INFO',
  },
  bundling: {
    minify: true,
    sourceMap: true,
  },
});

// API Gateway HTTP API
const api = new HttpApi(this, 'Api', {
  corsPreflight: {
    allowOrigins: ['https://myapp.com'],
    allowMethods: [CorsHttpMethod.GET, CorsHttpMethod.POST],
  },
});
api.addRoutes({
  path: '/orders',
  methods: [HttpMethod.GET, HttpMethod.POST],
  integration: new HttpLambdaIntegration('OrdersIntegration', handler),
});
```

## Step 6: Observability

### Structured Logging (Powertools)

```typescript
logger.info('Order processed', {
  orderId: order.id,
  customerId: order.customerId,
  amount: order.total,
  duration: Date.now() - startTime,
});
```

### Key Metrics to Monitor

| Metric | Alarm Threshold | Action |
|---|---|---|
| Errors | > 1% of invocations | Page on-call |
| Duration | > 80% of timeout | Optimize or increase timeout |
| Throttles | > 0 | Increase reserved concurrency |
| ConcurrentExecutions | > 80% of limit | Request quota increase |
| IteratorAge (streams) | > 60s | Increase parallelization |
| DeadLetterErrors | > 0 | Investigate DLQ messages |

### X-Ray Tracing

Enable on Lambda + API Gateway + DynamoDB for end-to-end request tracing.

## Step 7: Performance Optimization

### Cold Start Reduction

| Technique | Impact | Effort |
|---|---|---|
| Smaller package size | High | Low |
| Provisioned concurrency | Eliminates cold starts | $$$ |
| SnapStart (Java, Python 3.12+, .NET 8+) | Up to 90% reduction | Low |
| ARM64 (Graviton) | 20% cheaper, similar perf | Low |
| Lazy initialization | Medium | Low |
| Tree-shaking (esbuild) | Medium | Low |

### Cost Optimization

- Use ARM64 (Graviton2), 20% cheaper, same or better performance
- Right-size memory with AWS Lambda Power Tuning
- Use Savings Plans for predictable workloads
- Prefer EventBridge over polling (SQS long-poll costs add up)
- Use S3 Express One Zone for high-frequency access patterns

## Anti-Patterns to Detect

| # | Anti-Pattern | Fix |
|---|---|---|
| 1 | Lambda calling Lambda synchronously | Use Step Functions or SQS |
| 2 | No DLQ on async invocations | Add SQS DLQ |
| 3 | Secrets in environment variables | Use SSM/Secrets Manager |
| 4 | No timeout set | Set explicit timeout |
| 5 | Monolith Lambda (>250MB) | Split into focused functions |
| 6 | Polling DynamoDB for changes | Use DynamoDB Streams |
| 7 | No idempotency on writes | Use Powertools Idempotency |
| 8 | REST API when HTTP API suffices | Switch to HTTP API (cheaper) |
| 9 | Default 3s timeout | Set based on actual execution time + buffer |
| 10 | No retry/catch in Step Functions | Add Retry + Catch on every Task |

## Report

A reviewer writes each row as a finding (`write_findings`); a builder puts the summary in its finish.

```
## Serverless Review: [target]

### Stack: [SAM/CDK] + [Runtime] + [Event Sources]
### Summary: X MUST / Y SHOULD / Z NIT

| # | Category | Check | Status | File:Line | Details |
|---|----------|-------|--------|-----------|---------|
```

## Self-Check

- [ ] Every Lambda has explicit timeout and memory
- [ ] Every async invocation has a DLQ
- [ ] No secrets in environment variables
- [ ] Event source mappings have error handling (bisect, DLQ, max retries)
- [ ] Step Functions have Retry + Catch on Task states
- [ ] IAM policies are least-privilege (no wildcards)
- [ ] Structured logging with correlation IDs
- [ ] X-Ray tracing enabled

For CDK debugging, see the `cdk-doctor` skill.
For security hardening, see the `aws-security` skill.
For Lambda event source patterns, see `references/event-sources.md`.
For Step Functions patterns, see `references/step-functions.md`.
For optimization techniques, see `references/optimization.md`.
For verified sources on claims in this skill, see `references/sources.md`.

Gate before reporting done: `cdk synth` or `sam validate`, then the test command, reading each exit code (a person
reads `cdk diff` before they deploy). Then apply the `verification-before-completion` skill.
