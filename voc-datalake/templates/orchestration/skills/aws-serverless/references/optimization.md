# AWS Serverless: Optimization Patterns

## Cold Start Reduction

### What Causes Cold Starts

1. New execution environment provisioned (no warm container available)
2. Code downloaded and extracted
3. Runtime initialized
4. Handler module loaded (imports, global scope)

### Reduction Techniques

| Technique | Cold Start Impact | Cost Impact | Effort |
|---|---|---|---|
| ARM64 (Graviton2) | ~10% faster init | 20% cheaper | Minimal |
| Smaller package | Proportional to size reduction | None | Low |
| Tree-shaking (esbuild) | 30-60% smaller bundle | None | Low |
| Lazy imports | Defer unused modules | None | Low |
| Provisioned concurrency | Eliminates cold starts | $$$  | Low |
| SnapStart (Java, Python 3.12+, .NET 8+) | Up to ~90% reduction | None | Low |
| Keep-warm pings | Reduces frequency | Minimal | Low |

### Package Size Optimization

```typescript
// CDK: esbuild bundling with tree-shaking
new NodejsFunction(this, 'Handler', {
  entry: 'src/handler.ts',
  bundling: {
    minify: true,
    sourceMap: true,
    treeshaking: true,
    externalModules: ['@aws-sdk/*'],  // Use Lambda-provided SDK
  },
});
```

**Rules:**
- Exclude `@aws-sdk/*` from bundle (Lambda runtime includes it)
- Use `minify: true` for production
- Enable `sourceMap: true` for debugging (minimal size impact)
- Avoid importing entire libraries (`import { DynamoDB } from '@aws-sdk/client-dynamodb'` not `import AWS from 'aws-sdk'`)

### Lazy Initialization

```typescript
// BAD: loaded on every cold start even if not used
import { S3Client } from '@aws-sdk/client-s3';
const s3 = new S3Client({});

// GOOD: initialized only when needed
let s3: S3Client | undefined;
function getS3Client(): S3Client {
  if (!s3) s3 = new S3Client({});
  return s3;
}
```

## Memory Tuning

Lambda allocates CPU proportional to memory:
- 128MB = ~0.07 vCPU
- 1769MB = 1 vCPU
- 3538MB = 2 vCPU
- 10240MB = 6 vCPU

### Right-Sizing with Power Tuning

Use [AWS Lambda Power Tuning](https://github.com/alexcasalboni/aws-lambda-power-tuning) (a person runs it: it
deploys a state machine and invokes the function in the account):

```bash
# Deploy the state machine
sam deploy --template-file powertuning.yaml

# Run tuning
aws stepfunctions start-execution \
  --state-machine-arn arn:aws:states:...:powerTuningStateMachine \
  --input '{
    "lambdaARN": "arn:aws:lambda:...:MyFunction",
    "powerValues": [128, 256, 512, 1024, 1769, 3008],
    "num": 50,
    "payload": "{\"test\": true}"
  }'
```

**Rules:**
- More memory = more CPU = faster execution = potentially cheaper
- Sweet spot is usually where cost curve flattens
- CPU-bound functions benefit most from more memory
- I/O-bound functions (waiting on network) don't benefit much past 1 vCPU

## Cost Optimization

### Compute

| Strategy | Savings | Applies To |
|---|---|---|
| ARM64 (Graviton2) | 20% | All Lambda functions |
| Right-size memory | 10-50% | Over-provisioned functions |
| Savings Plans | Up to 17% | Predictable workloads |
| Shorter timeout | Prevents runaway costs | All functions |

### API Gateway

| Strategy | Savings |
|---|---|
| HTTP API instead of REST API | 71% ($1 vs $3.50 per 1M) |
| Caching (REST API only) | Reduces backend invocations |
| Request validation | Rejects bad requests before Lambda |

### DynamoDB

| Strategy | Savings |
|---|---|
| On-demand for variable traffic | No over-provisioning |
| Reserved capacity for steady traffic | Up to 77% |
| TTL for ephemeral data | Reduces storage costs |
| Sparse GSIs | Only index items that need it |

### Data Transfer

| Strategy | Savings |
|---|---|
| VPC endpoints (gateway) for S3/DynamoDB | Free (vs NAT Gateway $0.045/GB) |
| CloudFront for API caching | Reduces origin requests |
| Single-AZ for dev | Eliminates cross-AZ transfer |
| Compress responses | Reduces transfer volume |

## Concurrency Management

### Account-Level

A person's commands (they need the account):

```bash
# Check current limit
aws lambda get-account-settings --query 'AccountLimit.ConcurrentExecutions'

# Request increase via Service Quotas
aws service-quotas request-service-quota-increase \
  --service-code lambda \
  --quota-code L-B99A9384 \
  --desired-value 3000
```

### Function-Level

```typescript
// CDK: Reserved concurrency (hard limit)
handler.addAlias('live', {
  provisionedConcurrentExecutions: 10,  // Pre-warmed
});

// Reserved concurrency (max concurrent)
new CfnFunction(this, 'Config', {
  reservedConcurrentExecutions: 100,
});
```

**Rules:**
- Reserved concurrency = max concurrent executions for this function
- Provisioned concurrency = pre-warmed environments (eliminates cold starts)
- Sum of all reserved concurrency must be < account limit
- Unreserved functions share remaining pool

## Streaming Responses

```typescript
// Lambda response streaming (reduces TTFB)
export const handler = awslambda.streamifyResponse(
  async (event, responseStream, context) => {
    responseStream.write('Starting...\n');
    for (const item of items) {
      const result = await process(item);
      responseStream.write(JSON.stringify(result) + '\n');
    }
    responseStream.end();
  }
);
```

**When to use:**
- Large responses (>6MB sync limit, up to 200MB streamed)
- Time-to-first-byte matters (chat, real-time)
- Progressive rendering

## Performance Monitoring

### Key Metrics

| Metric | What It Tells You | Action Threshold |
|---|---|---|
| Duration (p50/p99) | Execution time distribution | p99 > 80% of timeout |
| ColdStartDuration | Init time | > 1s for user-facing |
| ConcurrentExecutions | Current usage | > 80% of limit |
| Throttles | Hitting concurrency limit | > 0 |
| IteratorAge | Stream consumer lag | > 60s |
| Errors | Function failures | > 1% |

### CloudWatch Insights Queries

```
# Top 10 slowest invocations
fields @timestamp, @duration, @requestId
| filter @type = "REPORT"
| sort @duration desc
| limit 10

# Cold start frequency
fields @timestamp, @initDuration
| filter ispresent(@initDuration)
| stats count() as coldStarts, avg(@initDuration) as avgInit by bin(1h)

# Error patterns
fields @timestamp, @message
| filter @message like /ERROR/
| stats count() by @message
| sort count desc
| limit 10
```
