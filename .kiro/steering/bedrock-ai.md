# Bedrock AI Model Standards

## Default Model

Always use **Claude Sonnet 4.5** via the global cross-region inference profile for all AI/LLM operations:

```
global.anthropic.claude-sonnet-4-5-20250929-v1:0
```

## Usage Pattern

```python
import boto3
import json

bedrock = boto3.client('bedrock-runtime')

response = bedrock.invoke_model(
    modelId='global.anthropic.claude-sonnet-4-5-20250929-v1:0',
    contentType='application/json',
    accept='application/json',
    body=json.dumps({
        'anthropic_version': 'bedrock-2023-05-31',
        'max_tokens': 2048,
        'system': 'Your system prompt here',
        'messages': [
            {'role': 'user', 'content': 'User message'}
        ]
    })
)

result = json.loads(response['body'].read())
text = result['content'][0]['text']
```

## IAM Permissions

Lambdas using Bedrock need this IAM permission:

```typescript
lambda.addToRolePolicy(new iam.PolicyStatement({
  actions: ['bedrock:InvokeModel'],
  resources: [
    `arn:aws:bedrock:${this.region}:${this.account}:inference-profile/global.anthropic.claude-sonnet-4-5-20250929-v1:0`,
  ],
}));
```

## Why Global Inference Profile?

- Cross-region availability and failover
- Consistent model version across all regions
- Simplified IAM resource ARN management
