# Memory: company and personal

The platform remembers what it learns from assistant chats, project chats, agent runs and pages a curator imports,
and recalls it in the AI surfaces listed under [Who recalls what](#who-recalls-what). A memory is one short
statement, such as "Our customers compare prices before checkout" or "I like short answers". There are two scopes:

| Scope | Who sees it | Who can change it |
|---|---|---|
| **Company** | every signed-in user, except that a user restricted to some categories never sees a memory about, or naming, a category outside their access ([Category access](#category-access)) | curators: admins and users with the **memory reviewer** flag. Anyone else's company add is stored as `proposed` |
| **Personal** | its owner only (admins never see its content) | its owner |

The extractor files generic knowledge about the product, customers or projects as **company** and anything
specific to one user as **personal**. "I like you to reply in short" is personal; "Our customers demonstrated
they compare prices before checkout" is company.

## Using the Memory page

Open **Memory** in the sidebar (`/memory`). It has these tabs (`?tab=` deep-links one):

| Tab | Who | What |
|---|---|---|
| Company | everyone | shared memories. Anyone can **+1** a memory (one supporter per person). Curators also edit, forget, restore and merge |
| Personal | everyone | your own memories. **Still true** refreshes one against the 90-day decay without counting you as a supporter |
| Needs review | curators | proposed company memories and conflicts side by side, with supporter counts and a suggested resolution: keep this one, keep both, merge into one, or keep the existing one |
| Imports | curators | **Import a page**: paste a document or web page (up to 200,000 characters, optional source link); what it teaches is published under the usual confidence rules |

**Add memory** stores a statement for the whole company or for you, with a retention: **Fades when unused**,
**Long-term** or **Until a date**. A
non-curator's company memory goes to review first. Before saving, the dialog shows which personal details will be
hidden for privacy. Whoever can change a memory edits its statement inline (pencil, then Save or Cancel;
`PUT /memory/{id}`). **Forget** archives a memory and stops automation from learning it again; **Restore** brings it
back. **Merge selected** replaces several memories with one statement; the originals are archived and their
supporters carry over.

**Names, not ids.** A statement names categories, subcategories and sources the way the dashboard does, never by
their ids. The extractor's prompt lists the configured categories as `Label (id: …)` lines (`shared/memory_categories.py`).
A memory's `categories` stay **ids**, because category access is checked against them: the model's answer is
mapped back to ids, whether it gave an id or a label, and anything else is dropped. Without a category config,
the names the model saw in the text are kept.

## Category tags

A memory's `categories` are the configured category ids it is ABOUT; category access is checked against them
(see "Category access" below). They are set on every write (`shared/memory_categories.py`), always from the
same closed list — the configured categories, given to the model as `Label (id: …; subcategories: …)` lines:

- **Extracted** memories (sessions, project chats, agent runs, imports): the extraction call answers
  `categories` per memory. An id, a label or a subcategory label maps to its category id; anything else is dropped.
- **Added by hand** (`POST /memory`), **edited** (`PUT /memory/{id}` or a review "replace" with a new
  statement) and **merged** (`POST /memory/merge`, review "merge"): one extra model call on the `memory`
  surface (`classify_statement`) tags the statement. A person's own `categories` are kept when configured.
  An edit only adds tags; it never removes one. A merge keeps every side's tags.
- **Every path** also adds each configured category the statement names (`shared/scope_names.py`). A write
  that lands on an existing memory (a duplicate +1) adds its tags to that memory.
- A memory about the company in general (strategy, working style, customers as a whole) gets no tags.
- A model failure never blocks a write: the name match is used alone. Without a category config, tags are kept as given.

**Backfill** (memories written by releases before 5.19.00 have no tags): `voc-datalake/scripts/memory/backfill_categories.py`
scans every memory without tags (company and personal, every status) and classifies it with the same
function. Its default is a dry run: it prints id, scope/status, the first 80 characters and the proposed
tags, then a summary (scanned, would be tagged, left untagged, model failures). `--apply` writes ONLY
`categories`, with a condition that the memory still exists and still has no tags. It never overwrites a
tag and touches nothing else. It is idempotent and resumable: a re-run revisits only what is still untagged.
Each memory costs one Haiku call. The model answers can differ a little between runs.

```bash
cd voc-datalake
.venv/bin/python scripts/memory/backfill_categories.py --region <region>            # dry run
.venv/bin/python scripts/memory/backfill_categories.py --region <region> --apply    # write
# table names: --memory-table / --aggregates-table, else $MEMORY_TABLE / $AGGREGATES_TABLE,
# else the outputs of --stack (default VocCoreStack: MemoryTableName, AggregatesTableName)
```

It needs read access to both tables and Bedrock `InvokeModel` (plus `UpdateItem` on `voc-memory` with
`--apply`). The model is the one the admin picked for the `memory` surface.

## Category access

A user restricted to some categories ([categories.md](categories.md#category-access-who-sees-which-reviews))
never receives another category's name through memory — not in `GET /memory` (company and personal), `POST
/memory/retrieve` (the assistant's recall, `search_memory`, `/mcp/global` as the minter, plan steps as the
approver, agent steps as the agent's owner), `GET /memory/conflict-check`, `GET /memory/review` (a restricted
memory reviewer curates only what they can read; the brief's review count follows) or prompt grounding. Two
checks, in order (`shared/memory_store.visible_to`, `shared/scope_names.py`):

1. **Provenance.** A memory tagged with categories is shown only when the reader can see every one of them.
   The tags are set on every write (see "Category tags" above).
2. **Names (fallback, for untagged and older memories).** A statement that names a category outside the
   reader's access is withheld: its id and display label, and its subcategories' ids and labels, matched
   case-insensitively on word boundaries, with any separators between words (`software_firmware`,
   "Software & Firmware" and "software/firmware" are one name). Not matched: `other`, a name a visible
   category also uses, names under 3 letters. A one-word name ("Pricing") matches that word anywhere — the
   rule errs towards hiding.

The same rule applies to the company context (vision paragraphs and company objectives) for restricted
readers. Admins and unrestricted users see everything. If the categories configuration cannot be
read, `GET /memory` answers 500 and prompt grounding includes no memory or company context for a restricted
reader (fail closed).

## Lifecycle

```
assistant session idle 30 min ─┐
project chat / agent run ──────┼─▶ SQS voc-memory-extract (+DLQ) ─▶ memory-extractor ─▶ voc-memory
POST /memory/imports ──────────┘        (Haiku 5.5, Titan Embed V2)
EventBridge every 15 min ─▶ memory-scanner (finds idle sessions past their cursor)
EventBridge daily 03:15 UTC ─▶ memory-retention (decay / dated → archived; long_term never)
```

Write rules (following KiroCrew): an automated write needs confidence ≥ 0.8 (else dropped, or `proposed` when
company-relevant); user-explicit beats automated; an automated statement that contradicts an active
user-explicit or confirmed memory becomes a `conflict` (both kept and linked); a forgotten (tombstoned) memory is
never re-created by automation — a match goes to review; cosine ≥ 0.86 within a scope is a duplicate (+1
supporter, once per person). Every write is screened for prompt injection, and memories reach prompts only as
`<memory>` DATA blocks, never as system prompt. Profanity, judgments about people and personal data are stripped.

**Nothing is hard-deleted.** Forget = tombstone + archive (restorable); retention archives; no role holds
`dynamodb:DeleteItem` on `voc-memory` (pinned by `lib/stacks/memory-agents-stack.test.ts`).

Retrieval: `cosine × (1 + ln(1+supporters)) × exp(-0.01 × days since reinforced/used) × 1.2 if aligned with a
company objective`, top 8 (company + the caller's personal), updating `last_used_at`.

## Storage — `voc-memory` (Core stack, on-demand, KMS, PITR, deleted with the stack)

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
and two internal routes: `POST /memory/retrieve` (called by the assistant stream Lambda,
`/mcp/global` and the agent nodes Lambda `voc-agent-nodes` — not the conductor) and `GET /memory/conflict-check`.

## Who recalls what

Two policies, one helper each side (`lambda/shared/grounding.py`; the generators use it through
`lambda/shared/job_knowledge.py`):

- **SHARED** — outputs other people read. Company context (vision + company objectives, never anyone's own) and
  **company** memories only, limited to the job starter's category scope (tags and names, see "Category access"). Personal memories and "My objectives &
  KPIs" never reach these.
- **PRIVATE** — what one person reads. Adds that person's own objectives and their **personal** memories.

| Surface | Policy | Memory | Company context | How |
|---|---|---|---|---|
| Research (Step Functions) | SHARED | company | yes | `voc-research-step` reads voc-memory directly (query = the research question); the text rides the scratch claim-check `scratch/research_jobs/<job_id>/grounding.txt`, only `grounding_included` rides the state |
| PR/FAQ, PRD, prototypes (document generator) | SHARED | company | yes (+ design system for prototypes only) | direct read (query = feature idea / title) |
| Persona generation | SHARED | company, kinds `product` and `customer` only | yes | direct read, on the analysis step only |
| Agent steps (`voc-agent-nodes`) | SHARED (agent principal) | company | yes | `POST /memory/retrieve` as the `agent:` principal (company scope only) |
| Assistant (`/chat/stream`) | PRIVATE | company + the caller's personal | yes, + the caller's own objectives (auto-injected, ≤ 2 KB) | `POST /memory/retrieve` as the caller |
| MCP (`/mcp/global`) | PRIVATE | company + the minter's personal | via tools | `search_memory` |

**No memory at all:** the persona panel (agent `persona_review`) and persona chat — they role-play customers, and
internal facts would turn a customer critique into an insider's; feedback enrichment (processor, category
reprocess) — cost per item, and a loop where memories would re-colour how new feedback is categorised; the memory
extractor — it would loop on its own output.

The generators read voc-memory directly (Query + GetItem, UpdateItem for `last_used_at`, KMS decrypt, Titan V2
`InvokeModel`; `lib/utils/memory-recall-grant.ts`, env `MEMORY_TABLE`) rather than through the memory Lambda: a
delegated call without a human subject resolves to the NOTHING scope and would recall nothing.

Every SHARED generator records what reached the prompt in the document's `derivation` (`memory_ids` — company ids
only —, `web_search_count`, `company_context_included`; omitted when empty), shown in the Documents tab as
"Built from: … company memories · … web searches · Company context". Feedback stays the evidence: the system
prompt says memory and company context are background, and a disagreement with the feedback is stated, never
silently resolved.

### Web search defaults

| Surface | Default |
|---|---|
| Research | ON (wizard box pre-ticked; `POST /projects/{id}/research` treats an omitted `use_web_search` as true; an explicit `false` turns it off). Skipped, and not disclosed, when the gateway is not deployed |
| PR/FAQ, PRD | OFF — they reuse the research findings already in the project |
| Personas | always OFF |
| Agent steps `deep_research`, `custom_llm` | ON, per-step switch in the workflow editor (`params.use_web_search: false`), at most **10 searches per run** across all steps (`MAX_WEB_QUERIES_PER_RUN`, counted on the RUN row as `web_queries`) |

**Privacy guard:** web queries are planned from the question and the feedback statistics only — never from memory
or company context text, so internal facts (codenames, targets) never become web queries.

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
