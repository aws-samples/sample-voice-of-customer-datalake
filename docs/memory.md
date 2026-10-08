# Memory — company and personal

The platform remembers what it learns — from assistant chats, project chats, agent runs and pages an admin
imports — and recalls it in every AI surface. Two scopes:

| Scope | Who sees it | Who can change it |
|---|---|---|
| **Company** | every signed-in user (even when it came from a category they cannot see — such statements are kept general, never quote a review) | admins and users with the **memory reviewer** flag; anyone else's company add is stored as `proposed` |
| **Personal** | its owner only (admins see counts, never content: `GET /memory/stats`) | its owner |

Rule for the extractor (owner's examples, verbatim in the prompt): generic and valuable for the company — any
product, customer or project knowledge — is **company**; specific to one user is **personal**.
"I like you to reply in short" → personal. "Our customer demonstrated they xx and xx" → company.

## Lifecycle

```
assistant session idle 30 min ─┐
project chat / agent run ──────┼─▶ SQS voc-memory-extract (+DLQ) ─▶ memory-extractor ─▶ voc-memory
POST /memory/imports ──────────┘        (Haiku 5.5, Titan Embed V2)
EventBridge every 15 min ─▶ memory-scanner (finds idle sessions past their cursor)
EventBridge daily 03:15 UTC ─▶ memory-retention (decay / dated → archived; long_term never)
```

Write rules (KiroCrew's): an automated write needs confidence ≥ 0.8 (else dropped, or `proposed` when
company-relevant); user-explicit beats automated; an automated statement that contradicts an active
user-explicit or confirmed memory becomes a `conflict` (both kept and linked); a forgotten (tombstoned) memory is
never re-created by automation — a match goes to review; cosine ≥ 0.86 within a scope is a duplicate (+1
supporter, once per person). Every write is screened for prompt injection, and memories reach prompts only as
`<memory>` DATA blocks, never as system prompt. Profanity, judgments about people and personal data are stripped.

**Nothing is hard-deleted.** Forget = tombstone + archive (restorable); retention archives; no role holds
`dynamodb:DeleteItem` on `voc-memory` (pinned by `lib/stacks/memory-agents-stack.test.ts`).

Retrieval: `cosine × (1 + ln(1+supporters)) × exp(-0.01 × days since reinforced/used) × 1.2 if aligned with a
company objective`, top 8 (company + the caller's personal), updating `last_used_at`.

## Storage — `voc-memory` (Core stack, on-demand, KMS, PITR, RETAIN)

| pk | sk | Row |
|---|---|---|
| `MEM#company` \| `MEM#user#{sub}` | `MEM#{memory_id}` | memory item (`gsi1pk=MEMSTATUS#{scope}#{status}`, `gsi1sk={rank_key}`) |
| `MEMEVT#{memory_id}` | `{iso}#{n}` | audit event |
| `MEMCURSOR` | `SESSION#{session_id}` | extraction cursor `{owner_sub, extracted_count, updated_at}` |
| `MEMIMPORT` | `{import_id}` | page import record (original text in the raw bucket under `memory-imports/`) |

Index: `gsi1-by-memory-status` (`gsi1pk`/`gsi1sk`). Embeddings are Titan Text Embeddings V2 (1024 floats,
compressed binary); the model is fixed (`EMBEDDING_MODEL_ID` in `lib/utils/model-allowlist.ts`), not a picker
choice, because vectors from two models are not comparable. No vector database: brute-force cosine per scope.

## API — `voc-memory-api` (`memory_handler.py`, all routes Cognito)

`GET /memory?scope=&status=&kind=&q=&cursor=`, `POST /memory`, `POST /memory/{id}/confirm`, `PUT /memory/{id}`,
`POST /memory/{id}/forget`, `POST /memory/{id}/restore`, `POST /memory/merge`, `GET /memory/review`,
`POST /memory/review/{id}/resolve`, `POST /memory/imports` (≤ 200k chars → 202), `GET /memory/imports/{id}`,
`GET /memory/stats`, and two internal routes the assistant and the agent conductor call: `POST /memory/retrieve`,
`GET /memory/conflict-check`.

## Infrastructure and IAM

| Lambda | Stack | Trigger | Grants (exact) |
|---|---|---|---|
| `voc-memory-api` | Api | API Gateway `/memory`, `/memory/{proxy+}` | memory Get/BatchGet/Put/Update/Query; aggregates Get/Query; raw `memory-imports/*` read+put; SendMessage memory-extract; Bedrock allowlist + Titan V2 |
| `voc-memory-extractor` | Processing | SQS `voc-memory-extract` (batch 5, partial failures) | memory Get/Put/Update/Query; conversations Get; agents Get/Query; aggregates Get; raw `memory-imports/*` read; Bedrock allowlist + Titan V2 |
| `voc-memory-scanner` | Processing | EventBridge `rate(15 minutes)` | conversations Scan; memory Get/Put/Update (cursors); SendMessage memory-extract |
| `voc-memory-retention` | Processing | EventBridge `cron(15 3 * * ? *)` | memory Query/Get/Update/Put |

The queue's visibility timeout is 6× the extractor timeout (30 min); 3 receives then the DLQ (14 days).
Workers bundle `lambda/memory/` + `lambda/shared/` (path-style handlers, e.g. `memory/extractor/handler.lambda_handler`);
no other Lambda's asset hashes the `memory/` or `agents/` tree (`WORKER_TREE_ASSET_EXCLUDES`).

The `memory` model surface defaults to Claude Haiku 5.5 and asks for the Flex service tier. Flex is sent only to a
model whose `supports_flex` flag is set; Haiku 5.5 (like every allowlisted Claude model) does not support it, so
the call goes out on the default tier in one round trip. If Bedrock still refuses Flex for a model flagged as
supporting it, the call is retried once on the default tier and a `FlexFallback` metric (dimension `surface`) is
emitted — never silent.
