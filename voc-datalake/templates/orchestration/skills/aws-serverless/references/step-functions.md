# AWS Serverless: Step Functions Patterns

## Workflow Types

| Type | Duration | Execution Model | Price | Use Case |
|---|---|---|---|---|
| Standard | Up to 1 year | Exactly-once | $0.025/1K transitions | Long-running, auditable |
| Express | Up to 5 min | At-least-once | $1/1M requests + duration | High-volume, short |

## State Types

| State | Purpose | Example |
|---|---|---|
| Task | Invoke Lambda or AWS SDK | Call Lambda, write to DynamoDB |
| Choice | Branch on condition | Route by order type |
| Parallel | Run branches concurrently | Validate + enrich simultaneously |
| Map | Iterate over array | Process each order item |
| Map (Distributed) | Process large datasets | Process millions of S3 objects |
| Wait | Pause execution | Wait 24h for payment |
| Pass | Transform data | Reshape payload |
| Succeed/Fail | Terminal states | End workflow |

## Task State with Retry + Catch

```json
{
  "ProcessOrder": {
    "Type": "Task",
    "Resource": "arn:aws:lambda:us-east-1:123456789:function:ProcessOrder",
    "Retry": [
      {
        "ErrorEquals": ["Lambda.ServiceException", "Lambda.AWSLambdaException", "Lambda.SdkClientException"],
        "IntervalSeconds": 2,
        "MaxAttempts": 3,
        "BackoffRate": 2
      },
      {
        "ErrorEquals": ["States.TaskFailed"],
        "IntervalSeconds": 5,
        "MaxAttempts": 2,
        "BackoffRate": 2
      }
    ],
    "Catch": [
      {
        "ErrorEquals": ["States.ALL"],
        "Next": "HandleError",
        "ResultPath": "$.error"
      }
    ],
    "Next": "NotifyCustomer"
  }
}
```

**Rules:**
- Give every Task state a Retry for transient errors, because throttles and service exceptions clear on retry
- Give every Task state a Catch for business errors where you can, so a failure takes a defined path
- Always retry `Lambda.ServiceException` and `Lambda.AWSLambdaException`
- Use `BackoffRate: 2` for exponential backoff

## SDK Integrations (Skip Lambda)

Call AWS services directly without Lambda for simple operations:

```json
{
  "WriteToDynamoDB": {
    "Type": "Task",
    "Resource": "arn:aws:states:::dynamodb:putItem",
    "Parameters": {
      "TableName": "Orders",
      "Item": {
        "orderId": {"S.$": "$.orderId"},
        "status": {"S": "PROCESSING"},
        "timestamp": {"S.$": "$$.State.EnteredTime"}
      }
    },
    "Next": "SendNotification"
  },
  "SendNotification": {
    "Type": "Task",
    "Resource": "arn:aws:states:::sns:publish",
    "Parameters": {
      "TopicArn": "arn:aws:sns:us-east-1:123456789:OrderNotifications",
      "Message.$": "States.Format('Order {} is processing', $.orderId)"
    },
    "End": true
  }
}
```

**Common SDK integrations:**
- DynamoDB: GetItem, PutItem, UpdateItem, Query
- SQS: SendMessage
- SNS: Publish
- S3: GetObject, PutObject
- ECS: RunTask
- Bedrock: InvokeModel
- EventBridge: PutEvents

## Distributed Map (Large-Scale Processing)

```json
{
  "ProcessAllFiles": {
    "Type": "Map",
    "ItemProcessor": {
      "ProcessorConfig": {
        "Mode": "DISTRIBUTED",
        "ExecutionType": "STANDARD"
      },
      "StartAt": "ProcessFile",
      "States": {
        "ProcessFile": {
          "Type": "Task",
          "Resource": "arn:aws:lambda:...:ProcessFile",
          "End": true
        }
      }
    },
    "ItemReader": {
      "Resource": "arn:aws:states:::s3:listObjectsV2",
      "Parameters": {
        "Bucket": "my-data-bucket",
        "Prefix": "input/"
      }
    },
    "MaxConcurrency": 100,
    "End": true
  }
}
```

## Saga Pattern (Distributed Transactions)

```
BookFlight → BookHotel → ChargePayment
    ↓ fail      ↓ fail       ↓ fail
CancelFlight  CancelFlight  CancelFlight
              CancelHotel   CancelHotel
                            RefundPayment
```

Each step has a compensating action. On failure, execute compensations in reverse order.

## JSONata Transformations (Preferred over JSONPath)

```json
{
  "Transform": {
    "Type": "Pass",
    "QueryLanguage": "JSONata",
    "Arguments": {
      "fullName": "{% $states.input.firstName & ' ' & $states.input.lastName %}",
      "total": "{% $sum($states.input.items.price) %}",
      "itemCount": "{% $count($states.input.items) %}"
    },
    "Next": "ProcessOrder"
  }
}
```

## Testing

### TestState API (unit test individual states)

The TestState API runs in the account, so it is a person's check; offline, test the state machine with the mock
service integrations below.

```bash
aws stepfunctions test-state \
  --definition '{"Type":"Task","Resource":"arn:aws:lambda:..."}' \
  --role-arn arn:aws:iam::123456789:role/StepFunctionsRole \
  --input '{"orderId": "123"}'
```

### Mock Service Integrations

```json
{
  "StateMachines": {
    "OrderWorkflow": {
      "TestCases": {
        "HappyPath": {
          "ProcessOrder": "MockSuccess",
          "ChargePayment": "MockSuccess"
        },
        "PaymentFailure": {
          "ProcessOrder": "MockSuccess",
          "ChargePayment": "MockFailure"
        }
      }
    }
  },
  "MockedResponses": {
    "MockSuccess": {
      "0": {"Return": {"StatusCode": 200, "Body": {"status": "ok"}}}
    },
    "MockFailure": {
      "0": {"Throw": {"Error": "PaymentFailed", "Cause": "Insufficient funds"}}
    }
  }
}
```

## Anti-Patterns

| # | Anti-Pattern | Fix |
|---|---|---|
| 1 | No Retry on Task states | Add Retry for transient errors |
| 2 | Lambda for simple AWS calls | Use SDK integrations |
| 3 | Express for long workflows | Use Standard (Express max 5 min) |
| 4 | No Catch for business errors | Add Catch with error handling state |
| 5 | Inline Map for millions of items | Use Distributed Map |
| 6 | Hardcoded ARNs | Use CloudFormation/CDK references |
