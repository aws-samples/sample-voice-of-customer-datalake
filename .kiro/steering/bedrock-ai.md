---
inclusion: auto
name: bedrock-ai
description: Bedrock AI model standards, Claude model resolution, LLM inference, prompt design, and Anthropic model invocation.
---

# Bedrock AI Model Standards

## Model Resolution (per-surface picker, issue #96 / PR #166)

Model ids are NOT hardcoded at call sites. Every AI surface resolves its
model through `lambda/shared/model_config.py` (TS mirror for the streaming
Lambda: `lambda/stream/src/bedrock/model-override.ts`):

```
explicit arg > per-surface admin override > legacy global model_id
    > the deployment's default (SETTINGS#model_default, pinned at deploy by -c defaultModelId)
    > surface default > BEDROCK_MODEL_ID env
```

Admins pick models per surface in Settings → AI Models (`GET/PUT
/settings/model`, stored in aggregates under `SETTINGS#model`, PUT is
admin-gated server-side). Overrides are validated against the allowlist on
write and read back as Automatic if tampered.

### Surface defaults

| Surface | Default |
|---|---|
| AI assistant (surface key `chat`: floating assistant + `/chat` page, streamed over `/chat/stream`) | Claude Sonnet 5.5 |
| Document generation (PRD, PR/FAQ, personas, research) | Claude Sonnet 5.5 |
| Product extract (surface `product_extract`: the Product tab's description from its sources, 7.104.00) | Claude Sonnet 5.5, its own: the pick for all surfaces and the deployment's default never replace it (a model profile still does); capacity fallback Sonnet 5 only, a refusal asked again once on Sonnet 5 |
| Prototype builder | Claude Opus 5.5 |
| Feedback enrichment (processor) | Claude Haiku 5.5 |
| Utilities (category suggestions, selector detection) | Claude Sonnet 5.5 |
| Memory extraction (asks for Flex; sent as default — Haiku 5.5 has no Flex) | Claude Haiku 5.5 |
| Agent conductor / final reviewer | Claude Opus 5.5 |
| Agent workers / persona panel | Claude Sonnet 5.5 |

### Allowlist

Copied verbatim from `lambda/shared/model_config.py` (`ALLOWED_MODELS`) —
that file and `lib/utils/model-allowlist.ts` are the source of truth (a
lockstep test pins them to each other). Seven ids are genuinely unsuffixed;
only Haiku 4.5 carries a dated suffix:

```
global.anthropic.claude-opus-5-5
global.anthropic.claude-sonnet-5-5
global.anthropic.claude-sonnet-5
global.anthropic.claude-sonnet-4-6
global.anthropic.claude-opus-5
global.anthropic.claude-opus-4-8
global.anthropic.claude-haiku-5-5
global.anthropic.claude-haiku-4-5-20251001-v1:0
```

Opus 5 and Opus 4.8 serve double duty here: selectable picker options AND
safety-fallback targets — Opus 5.5 re-runs a request its classifiers decline
on Opus 5, and Opus 5 on Opus 4.8, so both must be granted or the fallback
becomes an AccessDenied.

> Note the different policy in `repo-review/`: there Opus 4.8 is granted for
> automated fallback ONLY, and its config schema rejects any attempt to set it
> as the primary review model. Don't copy this allowlist into that app.

## Capability-aware invocation

`shared/converse.py` and the streaming client drop unsupported fields per
resolved model automatically, driven by two per-model data flags in
`ALLOWED_MODELS` (`omit_temperature`, `adaptive_thinking`) rather than
hand-maintained sets. Sonnet 5 / 5.5, Haiku 5.5 and every Opus generation reject `temperature`
and reject an explicit thinking budget (adaptive thinking is always-on; a
manual `thinking.budget_tokens` is a 400 on Opus 4.7 and later). Never pass
those fields unconditionally — resolve the model first, then let the shared
helpers shape the request.

**Effort (7.104.00).** Each allowlist row's `effort_levels` lists the `output_config.effort` levels the model takes
(low…max on every 5.x model and Opus 4.8; no `xhigh` on Sonnet 4.6; none on Haiku 4.5, which refuses the field),
read through `supports_effort(model_id, level)`. Send an effort only where it allows that level, with adaptive
thinking (`thinking: {type: adaptive}`) beside it: Bedrock caps the effort at `high` without thinking. Both go in
Converse's `additionalModelRequestFields` (the engineering harness has sent `output_config.effort` that way since
7.58.01); `[BEDROCK] Effective params` names what went on the wire.

**Streaming from Python (7.104.00).** A call whose answer can outlive one 840 s read (a max-effort extract) streams
with ConverseStream (`shared/product_extract_model.py`): its role needs `grantClaudeModels(role, 'stream')`
(`bedrock:InvokeModelWithResponseStream`), a heartbeat thread keeps the job's progress fresh and closes the stream at
the job's own deadline, and the stream's `metadata.usage` is logged with `usage_meter.log_stream_usage` (operation
`ConverseStream`): the botocore usage hook meters Converse and InvokeModel only. A refusal is a `stopReason` of
`refusal` (Claude's own; botocore's enum does not list it) or `content_filtered`; ask for
`additionalModelResponseFieldPaths: ['/stop_details']` to read its category where Bedrock forwards it. Bedrock has no
server-side `fallbacks`: the caller asks again itself (`model_config.refusal_fallback`).

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
