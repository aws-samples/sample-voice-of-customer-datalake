# AI assistant plan mode — design

Status: **built in 3.17.00** (designed with the owner 2026-10-14; what the build changed is listed under
[Deviations](#deviations-in-the-317-build) at the end). Builds on the unified assistant
(`lambda/stream`, AG-UI over `POST /chat/stream`) and the autonomous-agent runtime
([docs/autonomous-agents.md](autonomous-agents.md), state machine `voc-agent-run`).

## Why

A request like *"create a connector for Example Air's iOS and Android apps, import the reviews, tell me what
Example Air does wrong, and make a project for ancillaries (hotels, cars, eSIM) with personas, a PR/FAQ and a
prototype"* failed on 2026-10-14 (conversation `a2df5b78…`). The assistant answered one turn at a time with only
the tools of the page it was on (Home: `core` + `insights`). It created a project, said it had no tools for the
rest, and only found the persona and PR/FAQ tools after the user navigated to the project page. It never had a
way to:

- see the tools of other pages;
- turn a multi-step request into a plan and work through it;
- wait for background work (an import, a persona job) and continue;
- run an app connector, build a prototype, or find an app's store id (no such tools exist).

## Principles

1. **Tools stay per page** for normal chat. Plan mode does not widen what an ordinary turn can do.
2. **The planner sees every page's tools as a catalog; each step runs with exactly one page's tools.**
3. **The user approves the plan once, and the plan defines every write.** An approved write runs without a card
   only when it matches its definition; anything else falls back to an approval card. The runner enforces this in
   code, never the model.
4. **Approved plans run in the agent runtime** (Step Functions, up to 24 h), so they survive a closed browser and
   can wait on background jobs. The bubble shows progress.
5. **Every existing permission check still applies** on every write: admin-only tools need an admin, project
   writes need edit access, and the domain APIs re-check both.

## User flow

1. The user asks for something with several steps on any page. The assistant answers normally for one-step
   requests; for a multi-step request it switches to planning (it may also be asked: "plan this").
2. **Planning** (in the bubble, `POST /chat/stream`): the planner may call every **read-only** server tool of every
   pack the user is allowed to use, to resolve facts the plan needs before approval (does a project exist, which
   app id is Example Air's iOS app, which categories exist). It cannot call write tools. Its only output is a plan.
3. **Plan card**: the bubble shows the plan as a checklist. Each write is shown as a fixed field table built from
   its definition (like today's approval cards, no model prose), with placeholders shown as
   "← output of step 2". Buttons: **Approve and run**, **Change** (asks the planner to revise; a revised plan is
   approved again), **Decline**.
4. **Run**: on approval the SPA calls `POST /agents/plans` (below); the plan runs in `voc-agent-run`. The bubble
   and the project's Jobs show progress per step (pending, running, waiting, done, failed, skipped, needs approval).
5. **Deviation**: if a step needs a write that is not in the plan, or whose arguments differ from the definition,
   the step pauses as `needs_approval` and the bubble shows an ordinary approval card for it. Approve → the step
   resumes; decline → the step fails and the plan stops (see "Failure").
6. **Finish**: a summary of what ran, what was skipped and why, and links (project, documents, prototype).

## Plan format (`voc-plan/1`)

```json
{
  "schema": "voc-plan/1",
  "goal": "Example Air: import iOS + Android reviews, find problems, ancillaries project with personas, PR/FAQ, prototype",
  "steps": [
    { "id": "s1", "pack": "scrapers", "kind": "write", "title": "Connect the ExampleAir iOS app",
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
| `write` | exactly one write tool with its declared arguments | no, unless it has `{{free}}` fields | most steps; deterministic |
| `wait` | polls a background job until done, failed or timed out | no | `source_run` (`SOURCE_RUN#{source}` rows written by `POST /sources/{source}/run`), `project_job` (`voc-jobs`), `scraper_run` |
| `think` | a focused agent with the step's pack **read-only** tools and the brief | yes | produces text outputs (summaries, findings) for later `{{free}}` fields |

Argument values in a `write`:

- **Literals** (`"1234567890"`, `4`, `"prfaq"`) are approved as shown and must match exactly.
- **References** `{{<step>.<output>}}` are filled only from that earlier step's recorded output (ids, execution
  ids). A reference to a step that is not in the step's `after` chain is invalid.
- **`{{free}}`** marks a text field the runner lets the model write at run time, for example a project description,
  a document body or a persona note. Allowed only on fields each tool declares as free text
  (`FREE_TEXT_FIELDS` per tool, in the contract); never on ids, targets, roles, sources, scopes or flags, and
  never on a job's generation instructions (see "Scoping a job").

Limits (validated when the plan is created and again at approval): ≤ 20 steps, ≤ 12 writes, ≤ 6 waits, ≤ 4 `think`
steps, a dependency graph without cycles, each `pack` allowed for the caller (`packsForPage` rules: `settings` and
admin-only tools only for admins), every write tool in its step's pack, every literal valid against the tool's
existing zod schema.

**Never pre-approvable** (always an approval card at run time, even when listed): `delete_document`,
`forget_memory`, `merge_memories`, every user-administration tool (`create_user`, `update_user`, `set_user_access`),
and `save_brand_settings`. The plan card marks them "will ask again". (3.17.00 narrowed this list; see [Deviations](#deviations-in-the-317-build).)

## Scoping a job

`generate_personas.custom_instructions`, `generate_document.feature_idea` and `merge_documents.instructions` decide
what a job writes about, so they are **literals** the user approves on the plan card (3.17.00 removed them from
`FREE_TEXT_FIELDS`; a think step's text can no longer reach them either). The planner is told
(`plan_catalogue` rules) to write them out naming the plan's subject, e.g. `custom_instructions: "Example Air
customers, from the ExampleAir iOS app reviews only"`.

The feedback a job reads is pinned with `sources` (optional on `generate_personas` → body `sources`, and
`generate_document` → body `feedback_sources`; at most 20 ids; omitted = every source the user can see, as
before). Values are `source_platform`s. An app connector's reviews carry `source_platform =
"<app_name>_iOS"` / `"<app_name>_Android"` (`source_platform_override` in `plugins/app_reviews_*/ingestor/handler.py`,
`app_name` exactly as given to `create_app_connector`, trimmed and NFKC-normalised by `ingest_schemas.py`), so the
Example Air connector `app_name: "ExampleAir iOS"` is `sources: ["ExampleAir iOS_iOS"]`. Without `sources`, personas and PR/FAQs
would mix in every other source's feedback; with it, the plan card shows exactly which reviews the job reads.
A `web_reviews` connector's reviews carry `source_platform = "web_<site>_<app_name>"`, minted once when it is
created and stored on it as `source_id` (app_name "Example Air" on a www.trustpilot.com page is
`web_trustpilot_example_air`; [web-reviews.md](web-reviews.md)). To import a subject's reviews from the web the planner finds review pages with
`web_search` (through `plan_lookup`), lists each chosen URL as a literal `create_app_connector {source:
"web_reviews", url, app_name}` write the user approves, then `run_source web_reviews` and a `source_run` wait.
The same `sources` argument works on an ordinary chat card. `merge_documents` has no feedback scope in the tool
(it merges documents; `use_feedback` stays false).

## Matching (the security core)

When a step's write is about to run, the runner:

1. resolves references from the stored outputs of earlier steps (missing or failed → the step fails);
2. if the step has `{{free}}` fields, asks the step agent for those values only, then validates them against the
   tool's schema (length caps, no control characters);
3. builds the final arguments and checks: same tool, every literal identical, every reference equal to its
   resolved value, every other field one of the step's declared `{{free}}` fields;
4. computes the request fingerprint (canonical JSON of tool + arguments) and records it on the step before calling;
5. executes the write through the same REST route the SPA executor uses today, as the approver (see "Identity").

Any mismatch, any extra write the step agent tries, and any never-pre-approvable tool → `needs_approval` with an
ordinary card. The step agent of a `think` step has no write tools at all. Text the agent read (reviews, web
pages, documents) can therefore change at most the content of a declared free-text field, never what is written
or where.

**Approving a paused step** binds to what the approver saw: the step view carries `pending.fingerprint`, the
inline card sends it back (`POST …/steps/{step_id}/approve {fingerprint}`), and the store's update is conditional
on the stored `pending_fingerprint`. A stale card (the step was re-run and paused on a different write) gets 409
"This step changed; review it again" and the SPA reloads the plan. The runner executes an approved write only
when its schema parse leaves the approved arguments byte for byte unchanged, and the conductor fails a resolved
step whose `done` reports another fingerprint.

Writes keep today's REST validations: `StaleApprovalError`-style precondition checks (an app connector that already
exists, a project the approver can no longer edit) fail the step with the domain API's reason.

## Identity and permissions

A plan runs as `plan:{plan_id}` **acting as the approver** (claim `voc:acting_subject`), the same synthetic-event
delegation the agent runtime and MCP tokens use.

- Before each write the runner re-checks the approver in Cognito: the user exists and is enabled. For admin-only
  tools it re-checks membership of `admins` (as `run_agent` does for an MCP minter) and forwards `admins` in the
  synthetic claims only for that write.
- Project writes go through the Projects API, which applies per-project access (`shared/project_access.py`).
- A plan step that writes a PR/FAQ or PRD (generate, merge into one, edit one) is autonomous AI writing: the
  Projects API refuses it unless the approver (and the project owner) work AI-driven, and the assistant does not
  propose such a step for anyone else ([ways-of-working.md](ways-of-working.md)).
- Category and source scope for every read is the approver's (`shared/category_access.py`).
- A user who is demoted or disabled mid-run stops the plan at the next write.

## Runtime

Plans reuse `voc-agent-run` and the conductor rather than adding a second orchestrator:

- A plan is stored as a run of kind `plan` in `voc-agents`: `PLAN#{plan_id}` / `META` (the approved plan,
  approver, fingerprint of the approved JSON, status) and `PLAN#{plan_id}` / `STEP#{nn}` (status, outputs,
  fingerprint of the executed write, error), plus the existing `EVT#` journal.
- The conductor's `decide` picks the next ready step (all `after` steps done). `write` and `think` steps run in a
  new **plan-step Lambda**; `wait` steps use the state machine's existing `wait → poll` loop.
- **Plan-step Lambda** (`voc-plan-step`, Processing stack, TypeScript, built from `lambda/stream` so tool
  definitions exist once): loads the step's pack server tools (read-only, same delegates and claims forwarding as
  the stream Lambda) and the write executors. Today the write executors live in the SPA
  (`frontend/src/assistant/approvals/*Executors.ts`); their tool → REST-request mapping moves to a shared module
  in `lambda/stream` and the SPA imports a lockstep mirror (same pattern as `contract.ts`), so a write is built
  identically by a card and by a plan.
- Independent ready steps may run in parallel (at most 3, the existing `Map` concurrency); most plans are a chain.
- Per-plan caps: model calls (default 60), wall clock 24 h (the state machine timeout), background jobs 6.

## Failure, cancel, expiry

- A failed or declined step marks every step that depends on it `skipped`; independent branches continue; the
  plan ends `completed_with_errors` and the summary names each failed and skipped step and why. Never "done".
- A plan never finishes while a step is still `pending`: a wait whose start lost a race, or a skip that did, is
  retried by the next decide (30 s later) instead of ending the plan around an unstarted step.
- **Cancel** (bubble or Agents page): no new step starts; a running write finishes; waits stop.
- **Delete** (Agents page, finished plans only, after a confirmation): the plan leaves its approver's list
  (`DELETE /agents/plans/{id}`). Never a delete: the META, steps and journal are kept with `hidden_at` /
  `hidden_by`, the plan still answers by id, and its slot was already given back when it finished. A plan that is
  still active answers 409: cancel it first.
- An unapproved plan expires after 30 minutes; an approved plan that has not started expires after 24 h.
- Re-running a plan creates a new plan from the old definition and needs a new approval.

## New tools (needed by plans and useful on their own)

| Tool | Pack | Kind | Calls | Notes |
|---|---|---|---|---|
| `run_source` | `scrapers` | client (admin) | `POST /sources/{source}/run` | returns `execution_id`; the route exists and is admin-only |
| `set_source_enabled` | `scrapers` | client (admin) | `PUT /sources/{source}/enable` or `/disable` | turns a scheduled plugin's schedule on or off (`app_reviews_ios`, `app_reviews_android`, `github_issues`, `web_reviews`, `webscraper`); enabling also closes a tripped circuit breaker. A plan may name it |
| `import_reviews` | `scrapers` | client (admin) | `POST /scrapers/manual/json-upload` | reviews the model extracted verbatim from pasted text or an attached file: `{source_name, source_id?, items: [{text, rating?, author?, created_at?, url?, title?}]}`, at most 500 per card (text up to 10,000 characters each, 200,000 in total). The card shows the count, how many carry a rating or a date, and the first 10 rows; the SPA derives each row's de-duplication id from its source name, text, author and date, so re-importing stores a review once. Card-only |
| `create_users` | `settings` | client (admin) | `POST /users`, once per person | up to 25 `create_user` rows in one approval; every email is checked first, then they are created in order and the first failure stops the rest (the result names who was created). Card-only |
| `get_source_run` | `scrapers` | server | `SOURCE_RUN#{source}` / `{execution_id}` | status, items, errors (redacted) |
| `build_prototype` | `project` | client | `POST /projects/{id}/build-prototype` | route exists; returns a job id |
| `find_app_store_app` | `scrapers` | server | Apple's public iTunes Search API; Google Play via `web_search` | returns candidate ids for `create_app_connector`; the planner shows the chosen id literally on the plan card |
| `get_plan` / `cancel_plan` | `core` | server / client | plan routes below | progress for the bubble |

The `generate_document` tool keeps `prd` / `prfaq`; prototypes get their own tool because they are a separate job.

## API (no new API Gateway resources)

Under the existing `/agents/{proxy+}` route (Agents API). Plan ids are `pl_<12 hex>` and cannot collide with agent
ids (`ag_<12 hex>`).

| Method | Path | Who | Description |
|---|---|---|---|
| POST | `/agents/plans` | any signed-in user | Validate and approve a plan (body: the plan JSON + the conversation id); 202 `{plan_id}`. Validation errors are 400 with the step and field. |
| GET | `/agents/plans/{plan_id}` | the approver, admins | Plan, step statuses, outputs (ids only), pending approval |
| POST | `/agents/plans/{plan_id}/cancel` | the approver, admins | Cancel |
| DELETE | `/agents/plans/{plan_id}` | the approver, admins | Remove a finished plan from the list (kept; 409 while active) |
| POST | `/agents/plans/{plan_id}/steps/{step_id}/approve` / `decline` | the approver | Resolve a `needs_approval` step |

The Agents API's admin-only writes stay admin-only; these routes are classified in
`lambda/api/test/test_route_admin_gates.py` as open with an owner check ("the approver's own plan").

## Models

New picker surface `assistant_planner` (default Opus 5.5) for planning; step agents use `agent_worker` (Sonnet 5.5).
Both are overridable in Administration → AI models (`/admin?tab=ai`).

## UI

- **Plan card** in the bubble: goal, steps as a checklist with pack labels, each write as a field table, "will ask
  again" markers, limits summary, Approve / Change / Decline.
- **Plan progress** in the bubble (polls `GET /agents/plans/{id}` while open; notification on finish, reusing
  `runNotifications`) and on the Agents page as a run of kind "Plan".
- Deviations show the existing approval cards, labelled with the plan step.

## Build order

1. **Tools**: `run_source`, `get_source_run`, `build_prototype`, `find_app_store_app` (usable in normal chat).
2. **Shared write executors**: move the tool → REST mapping from the SPA into `lambda/stream` with an SPA lockstep
   mirror; no behaviour change.
3. **Planner + plan card**: tool catalog, `voc-plan/1` schema (zod, mirrored), validation, `POST /agents/plans`.
4. **Runner**: plan runs in `voc-agent-run`, `voc-plan-step` Lambda, matching, waits, identity re-checks, cancel.
5. **Progress UI**, notifications, docs, e2e test with the Example Air request against the mock and a dev stack.

## Open questions

- Should a plan be allowed to create a connector and import without an admin, for a non-restricted source? Today
  connectors and imports are admin-only (3.10.00–3.12.00); the design keeps that.
- Google Play has no public search API; `find_app_store_app` relies on `web_search` for Android ids, which may be
  off (`-c enableWebSearch=false`, EU deployments). Then the planner asks the user for the package name.
- Plans started from MCP (`run_plan` tool) are out of scope for the first version.

## Contract

The shared contract the stream Lambda, the SPA and the Python runtime code against (built first, before any
plan feature). The stream Lambda's TypeScript is the source; the other two are pinned to it by tests.

| File | What it is |
|---|---|
| `voc-datalake/lambda/stream/src/assistant/plan/schema.ts` | `voc-plan/1`: zod shape (`planSchema`), `PLAN_LIMITS`, `PLAN_FIELD_LIMITS`, id/reference patterns, `PLAN_STEP_STATUSES`, `PLAN_STATUSES`, `NEVER_PREAPPROVABLE_TOOLS`, `FREE_TEXT_FIELDS`, `planWriteTools(pack)` |
| `…/plan/validate.ts` | `validatePlan(plan, {isAdmin, packsAllowed, argsSchemaFor?})` → `{ok: true, plan}` or `{ok: false, errors: [{step?, field?, message}]}` |
| `…/plan/canonical.ts`, `…/plan/fingerprint.ts` | canonical JSON and `canonicalWriteFingerprint(tool, args)` (sha256 hex) |
| `…/plan/catalogue-args.ts` | `catalogueArgsSchemaFor(catalogue)`: the tools' own zod schemas for the literal check |
| `…/plan/contract-json.ts` + `lambda/stream/scripts/write-plan-contract.mjs` | generate `lambda/shared/plan_contract.json` |
| `voc-datalake/lambda/stream/src/assistant/contract.ts` | `PLAN_TOOL_NAMES` (the new tools, named before they exist), `INTERRUPT_REASON_PLAN_APPROVAL` (`plan_approval`), `PLAN_INTERRUPT_ID_PREFIX` (`plan:`), `CUSTOM_EVENTS.plan` (`assistant.plan`) |
| `voc-datalake/frontend/src/assistant/plan/{schema,validate,placeholders,graph,canonical}.ts` | SPA mirror; `canonicalWriteFingerprint` is async there (Web Crypto). `plan.lockstep.test.ts` compares every export and runs the fixtures through both |
| `voc-datalake/lambda/shared/plan_schema.py`, `plan_canonical.py` | Python: `validate_plan(plan, *, is_admin, packs_allowed)` → `(plan, [])` or `(None, errors)`, `canonical_write_fingerprint`, tables read from `plan_contract.json` |
| `voc-datalake/lambda/shared/test/fixtures/plans/*.json`, `plan-fingerprints.json` | the fixtures all three validators must agree on |

Rules the contract adds to the design above:

- **Literal check.** Placeholders are replaced by the dummy `"x"`, the arguments are parsed with the tool's own
  schema, and only issues at or under a placeholder are ignored (those values are checked at run time). Tools
  without a schema yet (the plan-mode tools) and the Python validator skip this check; the REST route still
  validates every write when it runs.
- **Think outputs.** A `{{sN.output}}` reference to a `think` step may only fill a `FREE_TEXT_FIELDS` field:
  text a model wrote never becomes an id or a target.
- **Free-text fields** are project content only (project description, document title/body, persona and
  product-context prose, research questions, document and persona briefs, prototype title/feedback). Memory,
  company and design context, agent and workflow instructions and feedback-form copy are deliberately excluded:
  they feed later prompts or are published on customers' sites.
- Any other string containing `{{` or `}}` is invalid; a `wait` takes literal ids or references, never `{{free}}`.
- A plan-mode tool is first named in `PLAN_TOOL_NAMES`, not in `SERVER_TOOLS` / `CLIENT_TOOLS` (the catalogue
  and the SPA write registry require an implementation for every listed name); the change that builds it moves
  the name into those lists in both contract mirrors and regenerates `plan_contract.json`. In 3.17.00 every
  plan-mode tool is built, so `PLAN_TOOL_NAMES` is empty.
- **Write requests.** `lambda/stream/src/assistant/plan/write-requests.ts` (`buildWriteRequest(tool, args, env)`,
  with `write-preconditions.ts` for the reads a write needs first) is the tool → REST mapping `voc-plan-step` uses.
  `frontend/src/assistant/plan/writeRequests.lockstep.test.ts` runs the stream's cases
  (`write-request-fixtures.ts`) through the SPA executors and requires the same request for every tool a plan
  step may name, given the same stored state (a sparse stored scraper is normalised the way the SPA reads it).

## Deviations in the 3.17 build

What 3.17.00 does differently from the design above, decided while building it:

- **Planning runs in the normal chat run**, on the chat surface's model. There is no `assistant_planner` picker
  surface; step agents use `agent_worker`.
- **The proposal is a client tool, `propose_plan`** (core pack): its arguments are the `voc-plan/1` plan. The
  stream validates it (`validatePlan` with the tools' own schemas); an invalid plan goes back to the model as the
  error list (no card), a valid one ends the run with the ordinary approval interrupt and the SPA shows the plan
  card. Approving calls `POST /agents/plans` and resumes the chat with the plan id. `propose_plan` and
  `cancel_plan` are `PLAN_CONTROL_TOOLS`: never a step of a plan.
- **Lookups: `plan_lookup` and `plan_catalogue`** (core server tools) instead of loading every pack. The catalogue
  lists every tool of every pack the caller may use, one line each; `plan_lookup {tool, args}` runs any of those
  packs' read-only server tools, validated by that tool's schema and its admin rule. Normal chat still loads only
  its page's packs. `packs_allowed` = every pack except `ADMIN_ONLY_PACKS` for non-admins.
- **`CARD_ONLY_WRITE_TOOLS`** (`save_brand_settings`, `create_user`, `create_users`, `update_user`,
  `set_user_access`, `import_reviews`): a plan may not name them at all (their SPA executors re-check state the
  card showed; `update_user` and `create_users` are several requests; `import_reviews` carries rows from the
  conversation itself). They stay ordinary chat writes. **`NEVER_PREAPPROVABLE_TOOLS` is reduced** to `delete_document`,
  `forget_memory` and `merge_memories`. The conductor fails either kind reported done without its approval
  (lists read from `plan_contract.json`).
- **Think steps** get the read-only server tools of their pack plus `core`, never web search, the plan tools or
  the user directory.
- **The state machine invokes `voc-plan-step`** directly inside the plan `Map` (between the conductor's
  `plan_prepare` and `plan_record`); the conductor never runs a write. The `Map` retries only throttles — any
  other Lambda error might have written, so it is recorded as the step's failure.
- **Polling** is every 30 s for the first hour or while a step waits for its approver, then every 120 s.
- **Expiry of a proposal is client-side**: the 30-minute approval window is the plan card's; nothing is stored
  before approval. An approved plan not started within 24 h expires server-side.
- **At most 3 active plans per user** (`POST /agents/plans` answers 409 beyond that). The cap is an atomic counter
  (`PLANCAP#{sub}`, taken in the create transaction, given back with the terminal status).
- **Delegated credentials cannot approve, read, list, cancel or resolve plans**: an MCP token or an agent
  principal gets 403 on every plan route; the approver is always a signed-in user.
- **`run_agent` / `cancel_agent_run` are admin-only tools** (`ADMIN_ONLY_CLIENT_TOOLS`, both mirrors), matching
  their routes; in normal chat a non-admin no longer gets them.
- **Think steps**: never the user directory (`list_users`, `get_user_access`), so `voc-plan-step` has no Users API
  grant; in `scrapers` / `settings` (`admin_read_packs` in the contract) a think step reads as an admin only while
  the approver still is one (`get_source_run`, `analyze_scraper_url`).
- **`find_app_store_app`** streams Apple's answer under a 512 KB cap, follows no redirect, and keeps only
  `https://apps.apple.com/` links.
- `voc-agents` (with the plan rows) is encrypted with the customer-managed KMS key (`createEncryptedTable`).
- **Run environment.** The conductor sends no `env` in the plan-step event, so plan writes use the runner's
  defaults: a 30-day feedback window, the route's default response language and the imported-date basis.
- **Plan-step answers** also carry `model_calls` (counted against the per-plan cap) and, for an executed write,
  its `fingerprint`.
- `build_prototype` keeps the route's body names: `project_id`, `title?`, `feedback?`, `base_prototype_id?`,
  `source_prd_id?`, `source_prfaq_id?`.
