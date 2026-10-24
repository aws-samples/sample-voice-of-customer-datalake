# Autonomous agents — crews that go from reviews to a prototype

An **agent** watches the reviews in its scope (all, or some categories/subcategories) and, when a trigger fires,
runs a **workflow**: aggregate the problems, pick or create a project, choose or generate personas, research,
write a PR/FAQ and PRD, have the personas review them until they agree, build a prototype with the company design
system, review that, and hand the result to the right owner. Admins create and enable agents (up to ~10); anyone
can read the agents whose scope they can see. Notifications are in-app only.

The crew model is KiroCrew's: a **conductor** decides and verifies but never does the work; **crewmates**
(worker, reviewer, persona) are Bedrock tool loops with their own transcript, and they talk only through the
conductor (`[sent by conductor]` envelopes). Default models: conductor and final reviewer Opus 5.5, workers and
personas Sonnet 5.5 — all overridable per surface (`agent_orchestrator`, `agent_worker`, `agent_reviewer`,
`agent_persona`) in Administration → AI models (`/admin?tab=ai`), and per agent.

## Default agent

Every deployment starts with one agent, **Autonomous Product** ("Turns recurring review problems into a PR/FAQ,
PRD and prototype"). It is created the first time an admin opens the agents list (`GET /agents`; a non-admin
listing never writes), owned by that admin, with its own editable copy of the built-in workflow (as
`POST /agents` without a `workflow_id` does). Settings: one `threshold` trigger (10 reviews per category within
7 days), scope all, the default budget (150 model calls per run, 2 scheduled runs per day, 5,000 calls per
month), default models, persona generation allowed, private output, no instructions. It is created
**disabled**: it never runs, and costs nothing, until an admin enables it.

The decision is made once per deployment and recorded in a marker row (`AGENTSEED` / `META`, `state`
`seeding` → `done` with the `agent_id`, or `skipped`). A deployment that already has any agent, archived
included, is `skipped` and gets nothing. Archiving the default agent never brings it back. A failed seed sets
`state: failed`, so the next admin listing tries again; the listing itself still answers. A `seeding` claim
older than 15 minutes counts as abandoned and is taken over. Code: `lambda/shared/agent_seed.py`.

## Triggers and budgets

| Trigger | Fires when |
|---|---|
| `new_reviews` | ≥ `min_new` in-scope reviews since the agent's cursor, and `cooldown_hours` have passed |
| `schedule` | every 12 h / 24 h / cron, in the agent's timezone |
| `threshold` | `count` reviews per category or subcategory within `window_days` (`METRIC#daily_subcategory#{cat}#{sub}` rows written by the aggregator) |

The heartbeat (EventBridge every 15 minutes) evaluates triggers. Limits: one active run per agent, at most 2
**scheduled** runs per agent per day, a per-run model-call cap (150 by default) and a monthly cap. **Run now** is
unlimited and does not count against the daily limit.

## Workflows

A workflow is a versioned JSON definition (`schema: 'voc-workflow/1'`): nodes, edges and declared loops, edited on
a free-form canvas (React Flow) with save / save-as / import / export, KiroCrew-style revisions and `derived_from`
lineage. Validation: one start, a reachable end, no orphan nodes, cycles only inside declared loops, `max_rounds`
1–5, ≤ 60 nodes. Built-in template `wf_default` "Reviews → Prototype". Persona agreement = mean score ≥ 4 and no
blocking objection; after max rounds the run ends `needs_human`.

Building a workflow by hand (the built-in can be rebuilt from an empty canvas, pinned by
`WorkflowEditor/rebuildBuiltin.test.ts` and `e2e/tests/s2-workflow-rebuild.spec.ts`):

- **Clear canvas** empties the draft; the palette adds a step (drag, or click / Enter) and selects it.
- **Arrows.** Drag handle to handle, or use **Add arrow** in the source step's settings (target + condition). An
  arrow's condition is what its source step reports: `agreed` / `not_agreed` out of a persona review, `pass` /
  `fail` out of a final review, otherwise none ("Always", the default path). A **custom step** (`custom_llm`)
  reports no verdict, so it offers no pass / fail arrows and cannot be the reviewer of a `review_pass` loop; a save
  or `POST /workflows/validate` with a `pass` / `fail` arrow out of one is refused (400, the error names the step).
  Workflows saved before 3.00.00 may still hold such arrows: they are read as what the runtime always did with
  them — the `pass` arrow becomes a plain arrow, a `fail` arrow (never taken) is dropped, and a `pass` arrow beside
  a plain one (also never taken) is dropped — so those workflows keep running unchanged and re-save cleanly. Edit
  a condition on the arrow or in the step's "Arrows out".
- **Loops.** A step joins a new or existing loop from its settings ("Add to loop"), or select several steps and
  "Group as a loop". Click a loop's frame label on the canvas (or Tab to the frame and press Enter) to set its
  exit condition (`persona_agreement` / `review_pass`), max rounds (1–5) and member steps.
- **Loop rules** (`shared/workflow_loop_rules.py`, mirrored by the editor's `graphRules.ts`). A loop repeats until
  its **review** passes: every persona review in a `persona_agreement` loop, every final review in a `review_pass`
  loop (a persona review never counts a `review_pass` round, so it is not that loop's review). A save or
  `POST /workflows/validate` refuses, pinned to the step:
  - a loop without its review — "loop {n} repeats until persona agreement but contains no persona review" /
    "loop {n} repeats until a review passes but contains no final review";
  - a review with no passing arrow out of the loop — "this review needs an 'agreed' arrow that leaves the loop"
    (`pass` for a final review) — or no failing arrow back — "this review needs a 'not_agreed' arrow that stays
    inside the loop" (`fail`);
  - a passing arrow back inside — "an 'agreed' arrow must leave the loop" — or a failing arrow out — "a
    'not_agreed' arrow must stay inside the loop";
  - an unlabelled arrow out of the review — "label each arrow of this review 'agreed' or 'not_agreed'" (it is taken
    on every outcome without its own arrow, which is how a loop went round until the 120-step limit);
  - an arrow from any other loop step to a step outside the loop — "only the loop's review can leave the loop"
    (it would run beside the loop as a fan-out).

  The runtime never re-validates a stored definition (`agents/graph.py` refuses only what it cannot walk), so a
  workflow saved before these rules keeps running exactly as before; it must satisfy them the next time it is
  saved. Duplicating one (`POST /workflows/{id}/duplicate`) validates the copy, so fix it first.
- With nothing selected the panel shows the workflow's name, description and an outline that selects any step or
  loop, so every setting is reachable from the keyboard.

Archiving: `DELETE /workflows/{id}` (admin) archives a workflow the way `DELETE /agents/{id}` archives an agent —
a soft `status: archived` on its CURRENT row, never a delete. It leaves `GET /workflows` (admins may add
`?include_archived=true`), becomes read-only (save / duplicate answer 404) and can no longer back a new agent;
admins can still read and export it, and its revisions and past runs keep their meaning. Refused with 409 for
`wf_default` and while a non-archived agent still runs it. The Agents page lists the library for admins with Open,
Rename and Archive.

Renaming: `POST /workflows/{id}/rename` `{name}` (admin, 1–120 characters) saves a new revision of the CURRENT
definition with only the name changed. The graph is not re-validated, so a workflow saved before a newer rule can still
be renamed. 409 for `wf_default` and when someone saved meanwhile, 404 when archived; the same name is a no-op.

History: the editor's **History** button (every page that shows the editor: the workflow page and an agent's
Workflow tab) opens a dialog listing the saved revisions newest first — revision number, who saved it, when, and a
"Current" badge — from the `revisions` that `GET /workflows/{id}` already returns (the latest 50). Selecting one
loads `GET /workflows/{id}/revisions/{revision}` → `{workflow_id, revision, name, definition, saved_at,
saved_by_username}` (never `saved_by`, the saver's sub) and shows its step and arrow counts and what restoring it
would change compared with the current revision (the same diff as the assistant's `update_workflow` card). The read
rule is `GET /workflows/{id}`'s: any signed-in user; an archived workflow only for an admin; 404 for an unknown
workflow or a revision it does not have, 400 for a revision that is not a whole number from 1 to 999999. `wf_default`
has one revision, 1, the built-in template. **Restore into editor** (admins only) loads that definition into the
editor's draft — nothing is saved; Save then writes it as a new revision with the usual 409 stale check. Unsaved
edits are confirmed away first.

On the agent list each row has, for admins, **Rename** (`PUT /agents/{id}` `{name}`) and **Delete**, which asks first
and then archives the agent (`DELETE /agents/{id}`): it is disabled and leaves the list, a run in progress finishes,
and its runs, projects and documents are kept. Nothing about an agent is erased.

Project rules: the agent may create a project, add to an existing one (matched on `description` + the agent-kept
`purpose`) and duplicate documents into another project — never merge, move or delete. Handoff owner = the first
owner of the dominant category (other owners as editors); none → the admin flagged **fallback owner**.

## Identity

Node executors call the existing Projects and Memory APIs with synthetic API Gateway events as the principal
`agent:{agent_id}`, acting as the agent's owner (claim `voc:acting_subject`), never admin, capped at editor — the
same delegation model as MCP tokens. So every project permission check stays in the Projects API, and the agent
runtime roles hold **no projects-table grant at all**.

## Runtime — `voc-agent-run` (Processing stack)

```
Decide ─▶ Choice($.decision.next)
  execute      ─▶ ExecuteNode ─────────────────────────────┐
  panel        ─▶ Map(persona panel, ≤ 3 at once) ─▶ Collect┤
  wait         ─▶ Wait(wait_seconds) ─▶ Poll ───────────────┤
  complete | needs_human ─▶ Succeed                         │
  fail | anything else   ─▶ Fail                            │
◀──────────────────────────── back to Decide ───────────────┘
Any task error ─▶ RecordFailure (conductor, action 'fail') ─▶ Fail
```

**What the journal says.** People read the run log, so the journal uses plain words, names and labels:

- A failed step reads as a plain sentence (`agents/failure_reason.py`). For example: "The review analysis came back in an unexpected format, so the run stopped. It is safe to run it again." The technical reason (`the review analysis was not valid JSON`, an HTTP refusal, a verification mismatch) is kept in the event's `detail`, masked like the summary. `GET /agents/{id}/runs/{run_id}/events` returns it. The run summary reads `<step> failed. <plain reason>.`
- Projects are named by their name, never by their id ("Created the project "Faster checkout" for Billing"). The name is read once per run and cached in the run context (`project_names`, `agents/event_text.py`). A name that cannot be read shows as "the project".
- Categories and sources use their labels (`shared/display_labels.py`). Documents are spelled PR/FAQ, PRD, prototype and research report.
- The review analysis prompt gives each review as `Label [id]`. The model answers with ids, and the problem keeps the configured label (`category_label`) for later steps.
- A handoff writes `Agent "<name>" run of <day>: …` into the project purpose. It no longer writes the run id.

Contract with the conductor (`agents/conductor/handler.lambda_handler`):

- input `{action: 'decide'|'execute'|'poll'|'collect_panel'|'fail', run_id, agent_id, node_id?, panel_results?, error?}`;
- `decide` returns **all four** of `{next, node_id, wait_seconds, panel}` (`node_id` may be null, `wait_seconds` ≥ 1,
  `panel` is `[]` unless `next = 'panel'`); the other actions' results are discarded — state lives in `voc-agents`;
- each `panel` item is passed unchanged to the persona panel (`agents/persona_panel/handler.lambda_handler`), which
  returns `{persona_id, score, objections, blocking, would_use}`.

The execution input is `{run_id, agent_id}`; start executions with `name = run_id` so a duplicate start is refused.
Timeout 24 h. Step Functions logs every transition but **never execution data** (documents and reviews).
Only transient Lambda-service errors are retried; a model error is the conductor's to handle, not a hidden re-run.

## When a run needs a human

A run ends `needs_human` — and writes, in the same update as the status, a `needs_human` payload
`{reason, node_id, node_title, loop_index?, max_rounds?, verdicts?: [{name, score, blocking, objections}]}`
(≤ 5 objections of ≤ 400 characters per persona, as the panel keeps them) — for one of five reasons:

| `reason` | When | Decisions (`actions` on the run view) |
|---|---|---|
| `loop_exhausted` | a loop's review failed its last round (`loop_index`, `max_rounds`, the last verdicts) | `accept`, `another_round`, `stop` |
| `no_fail_path` | a review failed and the workflow has no failing arrow from it (no loop, so no `another_round`) | `accept`, `stop` |
| `end_node` | the run reached an end step whose status is `needs_human` | `stop` |
| `budget` | the run spent its model-call budget | `stop` |
| `verification` | a step's claimed result could not be verified | `stop` |

A run that ended `needs_human` before payloads existed shows `needs_human: null` and can only be closed.

On the Runs tab an admin answers "What should happen next?" with one of the choices `actions` allows: revise
once more fixing the persona objections they tick (blocking personas' pre-ticked) plus their own instructions
(`another_round`, the note lists the ticked objections then the instructions), accept as it is (`accept`), something
else with their own instructions only (`another_round`), or close the run (`stop`, confirmed), then "Make the
decision". The SPA sends it as `POST /agents/{agent_id}/runs/{run_id}/decision` `{decision, note?}` (note ≤ 6,000
characters, trimmed; a delegated/MCP credential is refused) → `{run}`. 400 for a bad body or a decision not in
`actions`, 404 for an unknown or invisible run, 409 when the run is not waiting (not `needs_human`, or already
decided) or the agent already has another active run. The run view carries `needs_human`, `decision`
(`{decision, note, by_username, at}`) and `actions`.

- **stop** — the run becomes `completed` (its `finished_at` kept, no execution started), journalled "Closed by
  {username}: {note or 'no further action'}."
- **accept** / **another_round** — one transaction takes the agent's run lock and moves the run back to `queued`
  (`resume = {decision, note}`, `resume_count + 1`), then a new execution `{run_id}-r{resume_count}` starts. The
  conductor continues from the stopped review instead of from start: `accept` takes the review's passing arrow
  (`agreed` / `pass`) without counting a round; `another_round` sets the loop counter to `max_rounds - 1` and takes
  the failing arrow, so exactly one more round runs and the next failure stops the run again (and the human may
  decide again). A note waits for the next revision step's brief ("Note from a human: …").
- **Budget on resume.** The resumed part gets its own budget: `call_ceiling = model calls so far +
  max_model_calls_per_run` and `step_ceiling = steps so far + 120`. The monthly cap still applies (the heartbeat
  checks it before scheduled runs); a resume does not count against the daily scheduled-run cap. The heartbeat
  judges a resumed run's staleness (24 h) from `resumed_at`. The memory extractor is queued again when the resumed
  run finishes; duplicates of what the first stop taught are merged (same supporter, no extra weight).

## Storage — `voc-agents` (Core stack, on-demand, KMS, PITR, deleted with the stack)

| pk | sk | Row |
|---|---|---|
| `AGENT#{agent_id}` | `META` | agent (`gsi1pk=AGENTS`, `gsi1sk={name}`) |
| `WORKFLOW#{workflow_id}` | `REV#{revision:06d}` / `CURRENT` | definition revision / current pointer (`gsi1pk=WORKFLOWS`) |
| `AGENT#{agent_id}` | `RUN#{run_id}` | run (`gsi1pk=RUNS_ACTIVE` while running) |
| `RUN#{run_id}` | `EVT#{seq:08d}` | run event (the Runs tab journal): `summary` for people, `detail` (failed steps only) for the technical log |
| `RUN#{run_id}` | `MATE#{role}#{seq:06d}` | crewmate transcript |
| `PLAN#{plan_id}` | `META` / `STEP#{step_id}` / `EVT#{seq:08d}` | approved assistant plan, its steps, its journal (`gsi1pk=PLANS#{approver_sub}`) — see "Plans" |
| `PLANCAP#{approver_sub}` | `META` | `active`: the approver's plans holding one of the 3 active-plan slots — see "Plans" |
| `AGENTSEED` | `META` | the default-agent marker (`state`, `agent_id`) — see "Default agent" |

Index: `gsi1-by-agents-listing`. Agents are archived, never deleted. The table (`createEncryptedTable` in
`core-stack.ts`) is encrypted with the stack's customer-managed KMS key, has point-in-time recovery and is
kept while the platform runs (no TTL) and deleted with the stack (pinned by
`lib/stacks/memory-agents-stack.test.ts`; back up first, [Deployment → Teardown](deployment.md#teardown-deletes-everything-back-up-first)); plan rows inherit that.

## Plans — approved assistant plans on the same runtime

An approved AI-assistant plan (`voc-plan/1`, [docs/assistant-plan-mode.md](assistant-plan-mode.md)) runs on
`voc-agent-run` too. The execution input `{run_kind: 'plan', plan_id}` (execution name = plan id) takes the
`Start` choice to the plan branch; agent runs keep `{agent_id, run_id}` and `Init`.

```
Start ─▶ (run_kind = plan) PlanDecide ─▶ PlanRoute
  execute ─▶ Map(≤ 3 steps): PlanPrepare(conductor) ─▶ voc-plan-step ─▶ PlanRecord(conductor) ─▶ PlanDecide
  wait    ─▶ PlanWait(wait_seconds) ─▶ PlanDecide
  finish  ─▶ Done
Any task error ─▶ PlanRecordFailure (conductor, action 'plan_fail') ─▶ Fail
```

- **`plan_decide`** (`agents/conductor/plan_decide.py`) starts an approved plan, ends a cancelled / expired /
  finished one, then settles: a step still `running` (its result was lost) fails; a paused step older than
  30 minutes fails; each `waiting` step is polled; a ready `wait` step starts waiting; a pending step after a
  failed, skipped or cancelled one is `skipped`. Then `execute` up to 3 ready write/think steps, else `wait`
  (30 s for the first hour or while a step waits for its approver, then 120 s — a 24 h plan stays far below the
  Step Functions history limit), else `finish`: `completed`, or `completed_with_errors` with a summary naming
  every failed and skipped step.
- **`plan_prepare`** (`plan_execution.py`) claims the step (`pending` → `running`), applies the caps (model
  calls 60, background jobs 6 per plan), re-checks the approver in Cognito (`agents/plan_identity.py`:
  `AdminGetUser` — exists, enabled, same `sub`; `AdminListGroupsForUser` for an admin-only tool or pack, and for
a think step in a pack with admin-only reads, `admin_read_packs` = scrapers, settings) and
  builds the plan-step event: `{plan_id, step, resolved, think_outputs, claims, approved_pending?}`. The claims
  are the approver's (`sub`, `cognito:username`, `voc:acting_subject` = sub, `voc:principal = plan:{plan_id}`);
  `cognito:groups` is `users`, and `admins,users` only for an admin-only step whose re-check confirmed it (or a
  scrapers/settings think step while the approver is still an admin — otherwise it reads as a user). A
  refused approver (disabled, deleted, demoted) fails the step and stops the plan (`failed`, open steps skipped);
  a directory fault fails just that step, closed.
- **`voc-plan-step`** (TypeScript, built from `lambda/stream`: `src/plan-step/handler.ts`) does the matching and
  the write, as the approver, through the same REST route the SPA approval card calls. The state machine invokes
  it directly, so the conductor never runs a write and never waits on one (its timeout is 5 min, the plan step's
  300 s). Only a throttle is retried there — any other Lambda error might have written, so it is recorded.
  Every answer carries `model_calls` (the Converse calls the step made: 0 for a pure write, the free-field fill
  or the think rounds otherwise) and a `done` write its `fingerprint` (canonical tool + arguments of the executed
  write, stored on the step). The event carries no `env`, so plan writes use the runner's defaults: a 30-day
  feedback window, the route's default response language and the imported-date basis. Think steps get the
  read-only server tools of their pack plus `core`, never web search, the plan tools or the user directory
  (`list_users`, `get_user_access`).
  `lambda/api/test/test_plan_cross_track.py` drives the Example Air plan through the route and this conductor on the
  runner's recorded answers (`lambda/shared/test/fixtures/plan-step-example.json`, regenerated by
  `lambda/stream/scripts/write-plan-step-fixtures.mjs`).
- **`plan_record`** keeps only the declared outputs (`produces`), verifies a paused write's fingerprint
  (`canonical_write_fingerprint(tool, args)`) before storing it for the approver (`pending_json` +
  `pending_fingerprint`), fails a step the approver resolved whose `done` reports any fingerprint but the approved
  write's (never stored as done), counts model calls, and fails a
  never-pre-approvable write reported done without an approval, and any card-only write (`CARD_ONLY_WRITE_TOOLS`
  in `plan_contract.json`) reported done at all (tripwires: the plan step must pause or refuse them).
- **Waits** (`agents/plan_waits.py`) read status rows by key — `SOURCE_RUN#{source}` / `SCRAPER_RUN#{id}`
  (aggregates) and `PROJECT#{id}` / `JOB#{id}` (jobs) — and learn a status and a count, never content. Default
  timeout 60 minutes (`timeout_minutes` up to 24 h).

Rows (`voc-agents`, `shared/plans_store.py`): `PLAN#{plan_id}` / `META` (approved plan as canonical JSON, its
sha256 `fingerprint`, approver sub + username — never in a view —, status, conversation id, timestamps,
`model_calls`, `summary`; `gsi1pk=PLANS#{approver_sub}`, `gsi1sk={created_at}#{plan_id}` on the existing
`gsi1-by-agents-listing`, so no new index), `PLAN#{plan_id}` / `STEP#{step_id}` (status, outputs, error, the
paused write, the approved write, fingerprint) and `PLAN#{plan_id}` / `EVT#{seq:08d}` (journal). Every transition
is conditional on the row's current status, so the API and the runtime never write over each other.
`PLANCAP#{approver_sub}` / `META` counts the approver's active plans: `create_plan` adds 1 in the same
transaction as the plan rows, on the condition `active < 3` (409 beyond it, so concurrent approvals cannot pass
the cap), and every terminal transition of a plan marked `holds_slot` (finish, cancel, expiry, a failed start)
subtracts 1 in the same transaction as that transition.

Routes (Agents API, under the existing `/agents/{proxy+}` — no new API Gateway resource; NOT admin-only, owner
checks in the handler, classified open in `test_route_admin_gates.py`):

| Method | Path | Who | Answer |
|---|---|---|---|
| POST | `/agents/plans` `{plan, conversation_id?}` | any signed-in user (never a delegated MCP/agent credential); the caller is the approver | 202 `{plan_id, status: 'approved'}`; 400 `{success: false, message, errors: [{step?, field?, message}]}` (`shared/plan_schema.validate_plan`; `settings` and admin-only tools only for admins); 409 with 3 plans already active (atomic counter, above) |
| GET | `/agents/plans?limit=` | the caller (403 for a delegated credential) | `{plans: [{plan_id, status, goal, created_at, updated_at}]}`, newest first |
| GET | `/agents/plans/{plan_id}` | the approver, admins (else 404; 403 for a delegated credential) | `{plan: PlanView}` (outputs ≤ 500 characters each, a paused step's `pending: {tool, args, reason, fingerprint}`) |
| POST | `/agents/plans/{plan_id}/cancel` | the approver, admins (403 for a delegated credential) | `{plan}`; 409 once finished. No new step starts, a running write finishes; open steps → `cancelled` |
| POST | `/agents/plans/{plan_id}/steps/{step_id}/approve` `{fingerprint}` \| `decline` | the approver only (an admin or a delegated credential gets 403) | `{plan}`; 409 unless the step is `needs_approval` and the plan running. Approve REQUIRES the `fingerprint` of the `pending` the card showed (400 without a 64-hex one) and is a conditional update on the stored `pending_fingerprint`: a different paused write is 409 "This step changed; review it again". It re-runs the step with exactly those arguments; decline fails it and skips its dependents |

Expiry: a proposal's 30-minute approval window is client-side (the plan card expires; nothing is stored before
approval). An approved plan that has not started within 24 h is `expired` — written by the next read or decide.

## Infrastructure and IAM

| Lambda | Stack | Trigger | Grants (exact) |
|---|---|---|---|
| `voc-agents-api` (`agents_handler.py`) | Api | `/agents`, `/agents/{proxy+}`, `/workflows`, `/workflows/{proxy+}` (Cognito) | agents Get/Put/Update/Query; aggregates Get/Query; StartExecution on voc-agent-run (agent runs and plans); Stop/DescribeExecution on its executions only |
| `voc-agent-heartbeat` | Processing | EventBridge `rate(15 minutes)` | agents Get/Put/Update/Query; feedback Query; aggregates Get/Query; StartExecution |
| `voc-agent-conductor` | Processing | voc-agent-run tasks | agents Get/Put/Update/Query; feedback Get/BatchGet/Query; aggregates Get/Query; jobs GetItem (plan waits); Cognito AdminGetUser + AdminListGroupsForUser on the user pool (plan approver re-check); raw `prototypes/*` read; SendMessage memory-extract; invoke `voc-projects-api` + `voc-memory-api` by unqualified name; Bedrock allowlist |
| `voc-agent-persona-panel` | Processing | voc-agent-run Map | agents Get/Put/Update/Query; aggregates Get; raw `prototypes/*` read; invoke `voc-projects-api`; Bedrock allowlist |
| `voc-plan-step` (Node.js, `lambda/stream/src/plan-step/handler.ts`) | Processing | voc-agent-run plan Map (invoked by the state machine, never by the conductor) | aggregates GetItem + Query; feedback read (think steps' `search_feedback`); KMS decrypt; Bedrock allowlist (InvokeModel + stream); invoke by unqualified name exactly the projects, metrics, feedback-form, settings, scrapers, memory, agents, integrations and feedback-edit API Lambdas (`PLAN_STEP_DELEGATES`; never the users API — user writes are card-only and think steps never get the directory); no table writes |

The Projects and Memory API names come from `lib/utils/function-names.ts`, which both stacks use: Processing deploys
before Api, so a construct reference would be a cycle. `voc-plan-step`'s delegate names come from the same file.

## Planned: in-prototype feedback loop (not built yet)

When a run builds a prototype, the agent should be able to collect feedback on it from real users and rework it:

- the agent creates a **feedback form** of a new type, `prototype_review`, linked to the project and prototype, and
  the prototype embeds it as a floating "Feedback" button (Qualtrics-style) instead of a static form;
- a reviewer can **drop a pin** on the page — a point or a DOM element/container — and leave a comment there,
  Figma/Google-Docs style; pins are threaded and resolvable;
- each submission captures the context the agent needs to find and fix the issue: page URL and route, the pinned
  element's CSS selector + bounding box + nearby text, viewport size, user agent, recent console errors and failed
  network requests, plus an optional screenshot of the pinned region;
- submissions flow into the agent's run (a new trigger, e.g. `{kind: 'prototype_feedback', min_new}`) so the
  conductor can schedule `revise_prototype` with the pinned comments as DATA blocks, then mark pins resolved.

Infra notes for whoever builds it: the submit route stays one of the throttled public widget routes (it is reached
from the prototype, not the app), console/network capture must be opt-in and size-capped, and screenshots go to
the raw bucket under the prototype's prefix (keep-all).
