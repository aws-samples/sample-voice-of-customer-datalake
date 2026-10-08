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
`agent_persona`) in Settings → AI models, and per agent.

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
- With nothing selected the panel shows the workflow's name, description and an outline that selects any step or
  loop, so every setting is reachable from the keyboard.

Archiving: `DELETE /workflows/{id}` (admin) archives a workflow the way `DELETE /agents/{id}` archives an agent —
a soft `status: archived` on its CURRENT row, never a delete. It leaves `GET /workflows` (admins may add
`?include_archived=true`), becomes read-only (save / duplicate answer 404) and can no longer back a new agent;
admins can still read and export it, and its revisions and past runs keep their meaning. Refused with 409 for
`wf_default` and while a non-archived agent still runs it. The Agents page lists the library for admins with an
Archive action.

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

Contract with the conductor (`agents/conductor/handler.lambda_handler`):

- input `{action: 'decide'|'execute'|'poll'|'collect_panel'|'fail', run_id, agent_id, node_id?, panel_results?, error?}`;
- `decide` returns **all four** of `{next, node_id, wait_seconds, panel}` (`node_id` may be null, `wait_seconds` ≥ 1,
  `panel` is `[]` unless `next = 'panel'`); the other actions' results are discarded — state lives in `voc-agents`;
- each `panel` item is passed unchanged to the persona panel (`agents/persona_panel/handler.lambda_handler`), which
  returns `{persona_id, score, objections, blocking, would_use}`.

The execution input is `{run_id, agent_id}`; start executions with `name = run_id` so a duplicate start is refused.
Timeout 24 h. Step Functions logs every transition but **never execution data** (documents and reviews).
Only transient Lambda-service errors are retried; a model error is the conductor's to handle, not a hidden re-run.

## Storage — `voc-agents` (Core stack, on-demand, KMS, PITR, RETAIN)

| pk | sk | Row |
|---|---|---|
| `AGENT#{agent_id}` | `META` | agent (`gsi1pk=AGENTS`, `gsi1sk={name}`) |
| `WORKFLOW#{workflow_id}` | `REV#{revision:06d}` / `CURRENT` | definition revision / current pointer (`gsi1pk=WORKFLOWS`) |
| `AGENT#{agent_id}` | `RUN#{run_id}` | run (`gsi1pk=RUNS_ACTIVE` while running) |
| `RUN#{run_id}` | `EVT#{seq:08d}` | run event (the Runs tab journal) |
| `RUN#{run_id}` | `MATE#{role}#{seq:06d}` | crewmate transcript |

Index: `gsi1-by-agents-listing`. Agents are archived, never deleted.

## Infrastructure and IAM

| Lambda | Stack | Trigger | Grants (exact) |
|---|---|---|---|
| `voc-agents-api` (`agents_handler.py`) | Api | `/agents`, `/agents/{proxy+}`, `/workflows`, `/workflows/{proxy+}` (Cognito) | agents Get/Put/Update/Query; aggregates Get/Query; StartExecution on voc-agent-run; Stop/DescribeExecution on its executions only |
| `voc-agent-heartbeat` | Processing | EventBridge `rate(15 minutes)` | agents Get/Put/Update/Query; feedback Query; aggregates Get/Query; StartExecution |
| `voc-agent-conductor` | Processing | voc-agent-run tasks | agents Get/Put/Update/Query; feedback Get/BatchGet/Query; aggregates Get/Query; raw `prototypes/*` read; SendMessage memory-extract; invoke `voc-projects-api` + `voc-memory-api` by unqualified name; Bedrock allowlist |
| `voc-agent-persona-panel` | Processing | voc-agent-run Map | agents Get/Put/Update/Query; aggregates Get; raw `prototypes/*` read; invoke `voc-projects-api`; Bedrock allowlist |

The Projects and Memory API names come from `lib/utils/function-names.ts`, which both stacks use: Processing deploys
before Api, so a construct reference would be a cycle.

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
