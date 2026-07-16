---
inclusion: auto
name: bedrock-ai
description: Bedrock AI model standards, Claude model resolution, LLM inference, prompt design, and Anthropic model invocation.
---

# Bedrock AI Model Standards

## Model Resolution (per-surface picker, issue #96 / PR #166)

Model ids are NOT hardcoded at call sites. Every AI surface resolves its
model through `lambda/shared/model_config.py` (TS mirror for the streaming
Lambda: `lambda/stream/src/lib/model-override.ts`):

```
explicit arg > per-surface admin override > legacy global model_id
    > surface default > BEDROCK_MODEL_ID env
```

Admins pick models per surface in Settings → AI Models (`GET/PUT
/settings/model`, stored in aggregates under `SETTINGS#model`, PUT is
admin-gated server-side). Overrides are validated against the allowlist on
write and read back as Automatic if tampered.

### Surface defaults

| Surface | Default |
|---|---|
| AI Chat / streaming / project chat | Claude Sonnet 5 |
| Document generation (PRD, PR/FAQ, personas, research) | Claude Sonnet 5 |
| Prototype builder | Claude Opus 4.8 |
| Feedback enrichment (processor) | Claude Haiku 4.5 |
| Utilities (category suggestions, selector detection) | Claude Sonnet 5 |

### Allowlist

Copied verbatim from `lambda/shared/model_config.py` (`ALLOWED_MODELS`,
lines ~56-86) — that file and `lib/utils/model-allowlist.ts` are the
source of truth (a lockstep test pins them to each other). Three ids are
genuinely unsuffixed; only Haiku carries a dated suffix:

```
global.anthropic.claude-sonnet-5
global.anthropic.claude-sonnet-4-6
global.anthropic.claude-opus-4-8
global.anthropic.claude-haiku-4-5-20251001-v1:0
```

## Capability-aware invocation

`shared/converse.py` and the streaming client drop unsupported fields per
resolved model automatically: Sonnet 5 and Opus 4.8 reject `temperature`,
and Sonnet 5 rejects an explicit thinking budget (adaptive thinking is
always-on). Never pass those fields unconditionally — resolve the model
first, then let the shared helpers shape the request.

## Usage Pattern

Prefer the shared helpers (`shared/converse.py`) over raw client calls.
When a raw call is unavoidable, resolve the model first:

```python
from shared.model_config import get_active_model_id

model_id = get_active_model_id(surface='utilities')
response = bedrock.converse(modelId=model_id, ...)
```

## IAM Permissions

Grants are built from the single source of truth
`lib/utils/model-allowlist.ts` (`allowlistedModelArns()`), which must stay
in lockstep with `model_config.py`'s allowlist (a Python test asserts
this). A model that is selectable but not invocable AccessDenies its
surface — never grant a single hardcoded model id:

```typescript
import { allowlistedModelArns } from '../utils/model-allowlist';

lambda.addToRolePolicy(new iam.PolicyStatement({
  actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
  resources: allowlistedModelArns(this.region, this.account),
}));
```

## Why Global Inference Profiles?

- Cross-region availability and failover
- Consistent model version across all regions
- Simplified IAM resource ARN management
