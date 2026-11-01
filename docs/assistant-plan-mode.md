# AI assistant plan mode

Plan mode lets the AI assistant carry out a request with several steps, for example *"connect Example Air's iOS
and Android apps, import the reviews, tell me what Example Air does wrong, and make an ancillaries project with
personas, a PR/FAQ and a prototype"*. In ordinary chat the assistant only has the tools of the page it is on and
answers one turn at a time. In plan mode it proposes a plan that can use the tools of every page you are allowed
to use. You approve the plan once, and it then runs in the background in the autonomous-agent runtime
([autonomous-agents.md](autonomous-agents.md), state machine `voc-agent-run`). It keeps running when you close
the browser, and it can wait for imports and generation jobs before it continues.

Any signed-in user can approve a plan. Every existing permission check still applies to every step.

## Using plan mode

1. **Ask.** Ask for something with several steps on any page, or say "plan this". The assistant answers one-step
   requests normally.
2. **Planning.** The assistant looks up the facts the plan needs (does the project exist, which App Store id
   belongs to Example Air's iOS app, which categories exist) with read-only tools only. It writes nothing while
   planning.
3. **Plan card.** The assistant shows the plan as a checklist. Each write is a fixed field table built from its
   arguments, with no model prose. A value that comes from an earlier step reads "← output of step 2". The buttons
   are **Approve and run**, **Change** (you say what to change, the assistant proposes a revised plan, and you
   approve that one again) and **Decline**. A plan card that is not approved within 30 minutes expires.
4. **Run.** On approval the plan starts. The assistant bubble shows each step as pending, running, waiting, done,
   failed, skipped or needs approval, and notifies you when the plan finishes. The **Plans** section of the
   Autonomous agents page (`/agents`) lists your plans.
5. **Deviation.** If a step needs a write that is not in the plan, or with arguments that differ from what you
   approved, the step pauses as **needs approval** and the bubble shows an ordinary approval card for it. Approve
   it and the step continues. Decline it and the step fails.
6. **Finish.** The summary lists what ran, what was skipped and why, with links to the project, documents and
   prototype.

You can **cancel** a running plan from the bubble or the Plans list: no new step starts, a running write finishes
and waits stop. You can **delete** a finished plan from the Plans list. Deleting only removes it from your list;
its results stay in your projects. To run a plan again, ask again and approve the new plan.

### What a plan can and cannot do

- **Admin-only work needs an admin approver.** Creating a connector, running a source and the other `scrapers`
  writes are admin-only, as they are in chat. The `settings` pack is offered to administrators only.
- **Some writes always ask again.** `delete_document`, `forget_memory` and `merge_memories` can appear in a plan,
  but they always show an approval card when they run. The plan card marks them "will ask again".
- **Some writes are never part of a plan** (`CARD_ONLY_WRITE_TOOLS`): `save_brand_settings`, `create_user`,
  `create_users`, `update_user`, `set_user_access`, `import_reviews`, `save_radar_brands`, `run_radar_scan`,
  `create_participant_list` and `add_participants`. They stay ordinary chat writes with their own card, because
  their cards re-check what you saw, send several requests, carry rows from the conversation, or call an API the
  plan runner cannot reach.
- **PR/FAQ and PRD writing follows your way of working with AI.** A plan step that writes a PR/FAQ or PRD is
  autonomous AI writing: the Projects API refuses it unless you (and the project owner) work AI-driven, and the
  assistant does not propose such a step for anyone else ([ways-of-working.md](ways-of-working.md)).
- **Android package names need web search.** `find_app_store_app` finds iOS apps through Apple's public iTunes
  Search API. Google Play has no public search API, so Android package names come from `web_search`. When web
  search is off for the conversation, or deployed off (`-c enableWebSearch=false`), the tool returns no Android
  candidate and the assistant asks you for the package name (`com.example.air`).
- **Plans start only from the assistant.** The global MCP server has no plan tool, and an MCP token or an agent
  principal gets 403 on every plan route.
- **At most 3 active plans per user.** A fourth approval answers 409.

## Plan format (`voc-plan/1`)

The assistant proposes a plan with the `propose_plan` client tool. Its arguments are the plan:

```json
{
  "schema": "voc-plan/1",
  "goal": "Example Air: import iOS + Android reviews, find problems, ancillaries project with personas, PR/FAQ, prototype",
  "steps": [
    { "id": "s1", "pack": "scrapers", "kind": "write", "title": "Connect the Example Air iOS app",
      "write": { "tool": "create_app_connector",
                 "args": { "source": "app_reviews_ios", "app_id": "1234567890", "app_name": "ExampleAir iOS" } },
      "produces": ["app_config_id"] },
    { "id": "s2", "pack": "scrapers", "kind": "write", "after": ["s1"], "title": "Import the iOS reviews",
      "write": { "tool": "run_source", "args": { "source": "app_reviews_ios" } },
      "produces": ["execution_id"] },
    { "id": "s3", "pack": "scrapers", "kind": "wait", "after": ["s2"], "title": "Wait for the import",
      "wait": { "for": "source_run", "source": "app_reviews_ios", "execution_id": "{{s2.execution_id}}",
                "timeout_minutes": 60 } },
    { "id": "s4", "pack": "insights", "kind": "think", "after": ["s3"], "title": "What Example Air does wrong",
      "think": { "brief": "Summarise the main problems in the Example Air reviews, with counts and quotes." },
      "produces": ["summary"] },
    { "id": "s5", "pack": "core", "kind": "write", "title": "Create the ancillaries project",
      "write": { "tool": "create_project",
                 "args": { "name": "Example Air – Ancillaries", "description": "{{free}}" } },
      "produces": ["project_id"] },
    { "id": "s6", "pack": "project", "kind": "write", "after": ["s4", "s5"], "title": "Generate personas",
      "write": { "tool": "generate_personas", "args": { "project_id": "{{s5.project_id}}", "persona_count": 4,
                 "custom_instructions": "Example Air customers, from the ExampleAir iOS app reviews only",
                 "sources": ["ExampleAir iOS_iOS"] } },
      "produces": ["job_id"] },
    { "id": "s7", "pack": "project", "kind": "wait", "after": ["s6"], "title": "Wait for the personas",
      "wait": { "for": "project_job", "project_id": "{{s5.project_id}}", "job_id": "{{s6.job_id}}" } }
  ]
}
```

Step kinds:

| Kind | Runs | Model? | Notes |
|---|---|---|---|
| `write` | exactly one write tool with its declared arguments | no, unless it has `{{free}}` fields | most steps |
| `wait` | polls a background job until done, failed or timed out | no | `source_run` (`SOURCE_RUN#{source}` rows written by `POST /sources/{source}/run`), `project_job` (`voc-jobs`), `scraper_run` |
| `think` | a focused agent with read-only server tools and the step's brief | yes | produces text (summaries, findings) for later `{{free}}` fields |

Argument values in a `write`:

- **Literals** (`"1234567890"`, `4`, `"prfaq"`) are approved as shown and must match exactly.
- **References** `{{<step>.<output>}}` are filled only from that earlier step's recorded output (ids, execution
  ids). A reference to a step outside the step's `after` chain is invalid. A reference to a `think` step's output
  may only fill a free-text field, so text a model wrote never becomes an id or a target.
- **`{{free}}`** marks a text field the model writes at run time, such as a project description, a document body
  or a persona note. It is allowed only on the fields listed per tool in `FREE_TEXT_FIELDS`: project content only
  (project description, document title and body, persona and product-context prose, research questions, document
  and persona briefs, prototype title and feedback). Memory, company and design context, agent and workflow
  instructions and feedback-form copy are excluded because they feed later prompts or are published on customer
  sites. Ids, targets, roles, sources, scopes and flags are never free.
- Any other string containing `{{` or `}}` is invalid. A `wait` takes literal ids or references, never `{{free}}`.

Limits, checked when the assistant proposes the plan and again at approval:

| Limit | Value |
|---|---|
| Steps | 20 |
| Writes | 12 |
| Waits | 6 |
| Think steps | 4 |
| Model calls per plan (planning excluded) | 60 |
| Background jobs a plan may start | 6 |
| Steps running in parallel | 3 |
| Run time | 24 h (the state machine timeout) |
| Approved plan not started | expires after 24 h |
| Active plans per user | 3 |

The plan must also have a dependency graph without cycles, use only packs the caller may use (every pack except
`settings` for non-admins), put each write tool in its step's pack, and give every literal a value its tool's zod
schema accepts.

### Scoping a job

`generate_personas.custom_instructions`, `generate_document.feature_idea` and `merge_documents.instructions` decide
what a job writes about, so they are always **literals** you approve on the plan card. Neither `{{free}}` nor a
think step's output can fill them. The assistant is told to name the plan's subject in them, for example
`custom_instructions: "Example Air customers, from the ExampleAir iOS app reviews only"`.

The feedback a job reads is pinned with `sources` (optional on `generate_personas`, body `sources`, and on
`generate_document`, body `feedback_sources`; at most 20 ids; omitted means every source you can see). Values are
`source_platform`s:

- An app connector's reviews carry `"<app_name>_iOS"` / `"<app_name>_Android"` (`source_platform_override` in
  `plugins/app_reviews_*/ingestor/handler.py`; `app_name` exactly as given to `create_app_connector`, trimmed and
  NFKC-normalised by `ingest_schemas.py`). The connector `app_name: "ExampleAir iOS"` is
  `sources: ["ExampleAir iOS_iOS"]`.
- A `web_reviews` connector's reviews carry `"web_<site>_<app_name>"`, minted once when the connector is created and
  stored on it as `source_id` (app name "Example Air" on a `www.trustpilot.com` page is `web_trustpilot_example_air`;
  [web-reviews.md](web-reviews.md)). To import reviews from the web, the assistant finds review pages with
  `web_search` (through `plan_lookup`), lists each chosen URL as a literal
  `create_app_connector {source: "web_reviews", url, app_name}` write, then adds `run_source web_reviews` and a
  `source_run` wait.

Without `sources`, personas and PR/FAQs mix in every other source's feedback. With it, the plan card shows exactly
which reviews the job reads. The same argument works on an ordinary chat card. `merge_documents` has no feedback
scope (it merges documents; `use_feedback` stays false).

## How a write is checked

The runner enforces the approved plan in code, not the model. When a step's write is about to run, the runner:

1. resolves references from the stored outputs of earlier steps (a missing or failed output fails the step);
2. if the step has `{{free}}` fields, asks the step agent for those values only, in one model call, and validates
   them against the tool's schema (length caps, no control characters);
3. builds the final arguments and checks them: same tool, every literal identical, every reference equal to its
   resolved value, every other field one of the step's declared `{{free}}` fields;
4. computes the request fingerprint (sha256 of the canonical JSON of tool and arguments) and records it on the step;
5. sends the write through the same REST route the SPA uses for an approval card, as the approver.

Any mismatch, any extra write the step agent tries, and any always-ask tool pauses the step as `needs_approval`. A
think step has no write tools. Text the agent read (reviews, web pages, documents) can therefore change at most the
content of a declared free-text field, never what is written or where.

**Approving a paused step** binds to what you saw. The step view carries `pending.fingerprint`, the card sends it
back (`POST …/steps/{step_id}/approve {fingerprint}`), and the update is conditional on the stored fingerprint. A
stale card (the step was re-run and paused on a different write) gets 409 "This step changed; review it again" and
the SPA reloads the plan. The runner executes an approved write only when its schema parse leaves the approved
arguments unchanged, and the conductor fails a step whose result reports another fingerprint.

Writes keep their REST validations. A precondition that no longer holds (the app connector already exists, you can
no longer edit the project) fails the step with the domain API's reason.

## Identity and permissions

A plan runs as `plan:{plan_id}` acting as the approver (claim `voc:acting_subject`), the same delegation the agent
runtime and MCP tokens use.

- Before each write, the conductor re-checks the approver in Cognito: the user exists and is enabled. For an
  admin-only step it re-checks membership of `admins` and forwards `admins` in the claims for that step only. A user
  who is demoted or disabled mid-run stops the plan at the next write.
- Project writes go through the Projects API, which applies per-project access (`shared/project_access.py`).
- Every read uses the approver's category and source scope (`shared/category_access.py`).
- Think steps get the read-only server tools of their pack plus `core`. They never get web search, the plan tools
  or the user directory (`list_users`, `get_user_access`), so `voc-plan-step` has no Users API grant. In `scrapers`
  and `settings` a think step reads as an admin only while the approver still is one.
- `run_agent` and `cancel_agent_run` are admin-only tools, matching their routes.

## Failure, cancel and delete

- A failed or declined step marks every step that depends on it `skipped`. Independent branches continue. The plan
  ends `completed_with_errors` and the summary names each failed and skipped step and why.
- A plan never finishes while a step is still `pending`: a wait or skip that lost a race is retried by the next
  decision instead of ending the plan around an unstarted step.
- Cancel (`POST /agents/plans/{plan_id}/cancel`) starts no new step; a running write finishes; waits stop.
- Delete (`DELETE /agents/plans/{plan_id}`, finished plans only) hides the plan from its approver's list. Nothing is
  deleted: the plan, its steps and its journal are kept with `hidden_at` / `hidden_by`, and the plan still answers by
  id. A plan that is still active answers 409; cancel it first.

## Runtime

Plans reuse `voc-agent-run` and its conductor rather than a second orchestrator:

- A plan is stored in `voc-agents` (encrypted with the customer-managed KMS key): `PLAN#{plan_id}` / `META` (the
  approved plan, approver, fingerprint of the approved JSON, status) and `PLAN#{plan_id}` / `STEP#{nn}` (status,
  outputs, fingerprint of the executed write, error), plus the `EVT#` journal. The active-plan cap is an atomic
  counter (`PLANCAP#{sub}`), taken in the create transaction and given back with the terminal status. Nothing is
  stored before approval.
- The conductor's `plan_decide` picks the next ready steps (all `after` steps done), `plan_prepare` re-checks the
  approver, and `plan_record` stores each result. The state machine invokes `voc-plan-step` for `write` and `think`
  steps inside a `Map` (at most 3 at once). The conductor never runs a write itself. The `Map` retries only
  throttles: any other Lambda error might have written, so it is recorded as the step's failure.
- `wait` steps use the state machine's wait/poll loop: every 30 s for the first hour or while a step waits for its
  approver, then every 120 s.
- **`voc-plan-step`** (Processing stack, Node.js, built from `lambda/stream/src/plan-step/handler.ts` so tool
  definitions exist once) loads the step's read-only server tools and builds each write with
  `lambda/stream/src/assistant/plan/write-requests.ts` (`buildWriteRequest`, with `write-preconditions.ts` for the
  reads a write needs first). The SPA's approval-card executors build the same requests, pinned by
  `frontend/src/assistant/plan/writeRequests.lockstep.test.ts`. Its answers carry `model_calls` (counted against the
  per-plan cap) and, for an executed write, its `fingerprint`.
- The conductor sends no `env` in the plan-step event, so plan writes use the runner's defaults: a 30-day feedback
  window, the route's default response language and the imported-date basis.

## Tools used by plans

The assistant plans with three `core` tools that ordinary chat also has: `plan_catalogue` lists every tool of every
pack you may use, one line each; `plan_lookup {tool, args}` runs any of those packs' read-only server tools,
validated by the tool's schema and admin rule; `propose_plan` shows the plan card. Ordinary chat still loads only its
page's packs. `propose_plan` and `cancel_plan` (`PLAN_CONTROL_TOOLS`) are never a step of a plan.

These tools are also usable in ordinary chat:

| Tool | Pack | Kind | Calls | Notes |
|---|---|---|---|---|
| `run_source` | `scrapers` | client (admin) | `POST /sources/{source}/run` | returns `execution_id` |
| `set_source_enabled` | `scrapers` | client (admin) | `PUT /sources/{source}/enable` or `/disable` | turns a scheduled plugin's schedule on or off (`app_reviews_ios`, `app_reviews_android`, `github_issues`, `web_reviews`, `webscraper`); enabling also closes a tripped circuit breaker |
| `import_reviews` | `scrapers` | client (admin), card only | `POST /scrapers/manual/json-upload` | reviews the model extracted verbatim from pasted text or an attached file: `{source_name, source_id?, items: [{text, rating?, author?, created_at?, url?, title?}]}`, at most 500 per card (text up to 10,000 characters each, 200,000 in total). The card shows the count, how many rows carry a rating or a date, and the first 10 rows. The SPA derives each row's de-duplication id from its source name, text, author and date, so re-importing stores a review once |
| `create_users` | `settings` | client (admin), card only | `POST /users`, once per person | up to 25 people in one approval; every email is checked first, then they are created in order and the first failure stops the rest (the result names who was created) |
| `get_source_run` | `scrapers` | server (admin) | `SOURCE_RUN#{source}` / `{execution_id}` | status, items, errors (redacted) |
| `build_prototype` | `project` | client | `POST /projects/{id}/build-prototype` | the route's body names: `project_id`, `title?`, `feedback?`, `base_prototype_id?`, `source_prd_id?`, `source_prfaq_id?`; returns a job id |
| `find_app_store_app` | `scrapers` | server | Apple's iTunes Search API; Google Play via `web_search` | returns candidate ids for `create_app_connector`. Apple's answer is read under a 512 KB cap, with no redirects, keeping only `https://apps.apple.com/` links |
| `get_plan` / `cancel_plan` | `core` | server / client | plan routes below | progress for the bubble |

## API

The plan routes sit under the Agents API's existing `/agents/{proxy+}` resource. Plan ids are `pl_<12 hex>` and
cannot collide with agent ids (`ag_<12 hex>`). Delegated callers (MCP tokens, agent principals) get 403 on every
plan route.

| Method | Path | Who | Description |
|---|---|---|---|
| POST | `/agents/plans` | any signed-in user | Validate and approve `{plan, conversation_id?}`; 202 `{plan_id, status}`. 400 lists `errors` with step and field; 409 at 3 active plans |
| GET | `/agents/plans` | any signed-in user | The caller's newest plans (summaries), `?limit=` |
| GET | `/agents/plans/{plan_id}` | the approver, admins | Plan, step statuses, outputs (ids only), pending approval |
| POST | `/agents/plans/{plan_id}/cancel` | the approver, admins | Cancel |
| DELETE | `/agents/plans/{plan_id}` | the approver, admins | Remove a finished plan from the list (kept; 409 while active) |
| POST | `/agents/plans/{plan_id}/steps/{step_id}/approve` / `decline` | the approver | Resolve a `needs_approval` step (409 unless the step needs approval) |

The rest of the Agents API stays admin-only for writes. `lambda/api/test/test_route_admin_gates.py` classifies the
plan routes as open with an owner check (the approver's own plan).

## Models

Planning runs in the ordinary chat run, on the `chat` surface's model. Step agents (free-text fields and think
steps) use the `agent_worker` surface. Both default to Claude Sonnet 5.5 and can be changed in Administration → AI
models (`/admin?tab=ai`).

## Contract files

The stream Lambda's TypeScript is the source of the plan contract; the SPA and the Python runtime are pinned to it by
tests.

| File | What it is |
|---|---|
| `voc-datalake/lambda/stream/src/assistant/plan/schema.ts` | `voc-plan/1`: zod shape (`planSchema`), `PLAN_LIMITS`, `PLAN_FIELD_LIMITS`, id and reference patterns, `PLAN_STEP_STATUSES`, `PLAN_STATUSES`, `NEVER_PREAPPROVABLE_TOOLS`, `CARD_ONLY_WRITE_TOOLS`, `FREE_TEXT_FIELDS`, `planWriteTools(pack)` |
| `…/plan/validate.ts` | `validatePlan(plan, {isAdmin, packsAllowed, argsSchemaFor?})` → `{ok: true, plan}` or `{ok: false, errors: [{step?, field?, message}]}` |
| `…/plan/canonical.ts`, `…/plan/fingerprint.ts` | canonical JSON and `canonicalWriteFingerprint(tool, args)` (sha256 hex) |
| `…/plan/catalogue-args.ts` | `catalogueArgsSchemaFor(catalogue)`: the tools' own zod schemas for the literal check |
| `…/plan/contract-json.ts` + `lambda/stream/scripts/write-plan-contract.mjs` | generate `lambda/shared/plan_contract.json` |
| `voc-datalake/lambda/stream/src/assistant/contract.ts` | `PLAN_TOOL_NAMES` (empty: every plan tool is built), `INTERRUPT_REASON_PLAN_APPROVAL` (`plan_approval`), `PLAN_INTERRUPT_ID_PREFIX` (`plan:`), `CUSTOM_EVENTS.plan` (`assistant.plan`) |
| `voc-datalake/frontend/src/assistant/plan/{schema,validate,placeholders,graph,canonical}.ts` | SPA mirror; `canonicalWriteFingerprint` is async there (Web Crypto). `plan.lockstep.test.ts` compares every export and runs the fixtures through both |
| `voc-datalake/lambda/shared/plan_schema.py`, `plan_canonical.py` | Python: `validate_plan(plan, *, is_admin, packs_allowed)` → `(plan, [])` or `(None, errors)`, `canonical_write_fingerprint`, tables read from `plan_contract.json` |
| `voc-datalake/lambda/shared/test/fixtures/plans/*.json`, `plan-fingerprints.json` | the fixtures all three validators must agree on |

**Literal check.** Placeholders are replaced by the dummy `"x"`, the arguments are parsed with the tool's own schema,
and only issues at or under a placeholder are ignored (those values are checked at run time). The Python validator
skips this check; the REST route still validates every write when it runs.
