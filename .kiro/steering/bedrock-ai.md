---
inclusion: auto
name: bedrock-ai
description: Bedrock AI model standards, Claude Sonnet usage patterns, LLM inference, prompt design, and Anthropic model invocation.
---

# Bedrock AI Model Standards

## Models

| Use Case | Model | Global Inference Profile ID |
|----------|-------|-----------------------------|
| Chat, API, Research (quality) | Claude Sonnet 4.6 | `global.anthropic.claude-sonnet-4-6` |
| Processor (cost-efficient, high volume) | Claude Haiku 4.5 | `global.anthropic.claude-haiku-4-5-20251001-v1:0` |

Use Sonnet 4.6 for all AI/LLM operations unless processing high-volume items where Haiku 4.5 is preferred for cost efficiency.

## Usage Pattern

```python
import boto3
import json

bedrock = boto3.client('bedrock-runtime')

response = bedrock.invoke_model(
    modelId='global.anthropic.claude-sonnet-4-6',
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

Lambdas using Bedrock need IAM permissions for the models they invoke:

```typescript
// Sonnet 4.6 (chat, API, research)
lambda.addToRolePolicy(new iam.PolicyStatement({
  actions: ['bedrock:InvokeModel'],
  resources: [
    `arn:aws:bedrock:*:${this.account}:inference-profile/global.anthropic.claude-sonnet-4-6`,
    'arn:aws:bedrock:*::foundation-model/anthropic.claude-sonnet-4-6',
  ],
}));

// Haiku 4.5 (processor - high volume)
lambda.addToRolePolicy(new iam.PolicyStatement({
  actions: ['bedrock:InvokeModel'],
  resources: [
    `arn:aws:bedrock:*:${this.account}:inference-profile/global.anthropic.claude-haiku-4-5-20251001-v1:0`,
    'arn:aws:bedrock:*::foundation-model/anthropic.claude-haiku-4-5-20251001-v1:0',
  ],
}));
```

## Why Global Inference Profile?

- Cross-region availability and failover
- Consistent model version across all regions
- Simplified IAM resource ARN management
