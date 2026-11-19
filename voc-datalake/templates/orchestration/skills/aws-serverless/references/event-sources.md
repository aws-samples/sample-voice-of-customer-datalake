# AWS Serverless: Event Source Patterns

## Event Source Mapping (ESM) Configuration

### DynamoDB Streams

```yaml
# SAM template
Events:
  DynamoDBStream:
    Type: DynamoDB
    Properties:
      Stream: !GetAtt Table.StreamArn
      StartingPosition: TRIM_HORIZON
      BatchSize: 100
      MaximumBatchingWindowInSeconds: 5
      ParallelizationFactor: 10
      MaximumRetryAttempts: 3
      BisectBatchOnFunctionError: true
      DestinationConfig:
        OnFailure:
          Destination: !GetAtt DLQ.Arn
      FilterCriteria:
        Filters:
          - Pattern: '{"eventName": ["INSERT", "MODIFY"]}'
```

**Key settings:**
- `ParallelizationFactor`: 1–10 concurrent Lambda per shard (default 1)
- `BisectBatchOnFunctionError`: splits failed batch in half to isolate poison pill
- `FilterCriteria`: process only matching events (saves Lambda invocations)
- `StartingPosition`: TRIM_HORIZON (all) or LATEST (new only)

**IAM permissions needed:**
```json
{
  "Effect": "Allow",
  "Action": [
    "dynamodb:DescribeStream",
    "dynamodb:GetRecords",
    "dynamodb:GetShardIterator",
    "dynamodb:ListStreams"
  ],
  "Resource": "arn:aws:dynamodb:*:*:table/MyTable/stream/*"
}
```

### SQS

```yaml
Events:
  SQSEvent:
    Type: SQS
    Properties:
      Queue: !GetAtt Queue.Arn
      BatchSize: 10
      MaximumBatchingWindowInSeconds: 5
      FunctionResponseTypes:
        - ReportBatchItemFailures
```

**Key settings:**
- `FunctionResponseTypes: ReportBatchItemFailures`: return partial failures instead of retrying entire batch
- Visibility timeout should be 6x Lambda timeout
- Use DLQ on the SQS queue (not Lambda) with `maxReceiveCount: 3`

**Partial batch failure response:**
```typescript
export const handler = async (event: SQSEvent): Promise<SQSBatchResponse> => {
  const failures: SQSBatchItemFailure[] = [];
  for (const record of event.Records) {
    try {
      await processRecord(record);
    } catch (error) {
      failures.push({ itemIdentifier: record.messageId });
    }
  }
  return { batchItemFailures: failures };
};
```

### Kinesis Data Streams

```yaml
Events:
  KinesisStream:
    Type: Kinesis
    Properties:
      Stream: !GetAtt Stream.Arn
      StartingPosition: TRIM_HORIZON
      BatchSize: 100
      MaximumBatchingWindowInSeconds: 5
      ParallelizationFactor: 10
      MaximumRetryAttempts: 3
      BisectBatchOnFunctionError: true
      DestinationConfig:
        OnFailure:
          Destination: !GetAtt DLQ.Arn
```

**Key settings:**
- Same retry/bisect pattern as DynamoDB Streams
- Monitor `IteratorAge` metric, if increasing, consumer is falling behind
- Enhanced fan-out for dedicated throughput per consumer

### S3 Event Notifications

```typescript
// CDK
bucket.addEventNotification(
  s3.EventType.OBJECT_CREATED,
  new s3n.LambdaDestination(handler),
  { prefix: 'uploads/', suffix: '.csv' }
);
```

**Gotchas:**
- S3 notifications are at-least-once delivery, make handler idempotent
- Only one notification config per prefix/suffix combo per bucket
- For fan-out, use S3 → EventBridge → multiple targets

### Kafka (MSK / Self-Managed)

```yaml
Events:
  KafkaEvent:
    Type: MSK
    Properties:
      Stream: !Ref MSKCluster
      Topics:
        - my-topic
      StartingPosition: TRIM_HORIZON
      BatchSize: 100
```

**Key settings:**
- One Lambda invocation per partition
- Use VPC config for MSK (Lambda needs network access)
- Self-managed Kafka needs `SourceAccessConfigurations` for auth

## Event Filtering

Event filtering reduces Lambda invocations by filtering at the ESM level:

```yaml
FilterCriteria:
  Filters:
    # DynamoDB: only INSERT events for orders > $100
    - Pattern: '{"eventName": ["INSERT"], "dynamodb": {"NewImage": {"amount": {"N": [{"numeric": [">", 100]}]}}}}'

    # SQS: only messages with specific attribute
    - Pattern: '{"body": {"type": ["order.created"]}}'

    # Kinesis: filter on decoded data
    - Pattern: '{"data": {"status": ["ACTIVE"]}}'
```

**Rules:**
- Up to 5 filters per ESM (OR logic between filters)
- Filters use EventBridge pattern syntax
- Filtered-out events are discarded (not sent to DLQ)
- Saves cost by avoiding Lambda invocations for irrelevant events

## Error Handling Decision Tree

| Scenario | Strategy |
|---|---|
| Transient error (throttle, timeout) | Retry with backoff (ESM handles this) |
| Poison pill (bad data) | BisectBatchOnFunctionError isolates it |
| Persistent failure | Send to DLQ after max retries |
| Partial batch failure (SQS) | ReportBatchItemFailures |
| Order matters (streams) | MaxRetryAttempts + DLQ (don't skip) |
| Order doesn't matter (SQS) | Partial batch + DLQ |
