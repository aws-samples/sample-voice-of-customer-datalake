# Autonomous agents

An **agent** watches the reviews in its scope (all, or some categories and subcategories) and, when a trigger
fires, runs a **workflow**: aggregate the problems, pick or create a project, choose or generate personas,
research, write a PR/FAQ and PRD, have the personas review them until they agree, build a prototype with the
company design system, review that, and hand the result to the right owner. Administrators create, edit and enable
agents. Any signed-in user can read the agents whose whole scope their category access covers. Notifications are
in-app only.

The crew model follows KiroCrew: a **conductor** decides and verifies but never does the work. **Crewmates**
(worker, reviewer, persona) are Bedrock tool loops with their own transcript, and they talk only through the
conductor (`[sent by conductor]` envelopes). Default models: conductor and final reviewer Claude Opus 5.5, workers
and personas Claude Sonnet 5.5. Each is overridable per surface (`agent_orchestrator`, `agent_worker`,
`agent_reviewer`, `agent_persona`) in Administration → AI models (`/admin/ai`), and per agent.

## Using agents

Open the agents page from the sidebar (`/agents`, titled **Autonomous agents**). It lists the agents you can see,
each with its status and its spend (scheduled runs today, model calls this month); a run that waits for a person
shows **Needs your decision**. Administrators also get **New agent**, an **Agents** / **Workflows** switch for the
workflow library, and Rename and Delete on each row. The **Plans** section lists the multi-step requests you
approved in the AI assistant ([plan mode](assistant-plan-mode.md)).

An agent's page has an **Enabled** switch and these tabs:

| Tab | What you set or see |
|---|---|
| Settings | name, description, workflow, output visibility (private or public), scope (all reviews, or chosen categories and subcategories) |
| Triggers | up to 5 triggers (below) |
| Personas | up to 6 fixed personas picked from projects, and whether the agent may generate new personas when none fit |
| Instructions | free-text instructions (up to 8,000 characters) that reach every writing step |
| Models | a model per role (planner, worker, reviewer, persona), overriding the deployment default |
| Budget | scheduled runs per day (at most 2), model calls per run (10–500, default 150), monthly model-call cap (default 5,000, or none) |
| Workflow | the agent's workflow in the editor (below) |
| Runs | each run's journal, what it produced, and the decision a paused run needs ([below](#when-a-run-needs-a-human)) |

A new agent is created **disabled** with its own editable copy of the "Reviews → Prototype" workflow. It never runs,
and costs nothing, until an administrator enables it. **Run now** starts a run at once.

## Default agents

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

With the engineering agents module on (`-c engineeringAgents=true`; since 7.47.00) the same listing also seeds the
[engineering agents](#engineering-agents), each under a marker of its own (`AGENTSEED#bug-fixer`,
`AGENTSEED#feature-builder` and, since 7.50.00, `AGENTSEED#issue-triage` / `META`, the same claim, states and
stale-claim rule), so a deployment that has run for a while gets each once on upgrade. Since 7.50.00 they are built
from the orchestration templates' automations (`voc-datalake/templates/orchestration/automations/`). A marker is `skipped` when an active agent of that name already exists (one an admin
made is never doubled); archiving or deleting a seeded one never brings it back. Without the module they are not
seeded and the page does not mention them. Each is created **disabled**, with their own editable copy of their
engineering flow (visible and editable in the Workflows tab like any workflow) carrying a starting monthly budget of
$50 (the owner's; `SEEDED_MONTHLY_BUDGET_USD`, changed in Set up or in the flow):

| Agent | Works on | Workflow | Triggers |
|---|---|---|---|
| **Issue triage** (7.50.00) | any labelled issue | *Issue triage* (classify, locate): the issue's kind, severity, code involved and acceptance criteria, commented and labelled on the issue and kept as its trusted triage row | `github_issue` at its `triage` stage (label `voc-agent`, any kind, its own claim); no reviews trigger, no schedule |
| **Bug fixer** | `feedback_type` `bug` | *Bug hunt and fix*, to a pull request that says `Fixes #N` (7.50.00: ready for review unless the flow says `pr: draft`; a person approves and merges; a Bug fixer seeded before 7.50.00 keeps *Issue triage* then *Bug hunt and fix*) | `github_issue` (label `voc-agent`, `requires_triage: bug`: an issue triaged as a bug while Issue triage watches the connection, else one classified as a bug), `new_reviews` (5 bug reports, 24 h cooldown); no schedule |
| **Feature builder** | `feedback_type` `feature_request` | *Feature from an issue or a PRD*, to a pull request (ready for review unless the flow says `pr: draft`) | `github_issue` (label `voc-agent`, `requires_triage: feature`: an issue triaged as a feature while Issue triage watches the connection, else one classified as a feature request), `new_reviews` (10 feature requests, 24 h cooldown); and **Build from this PRD** on a project's PRD (a Run now with the PRD's ids) |

Each runs at most once a day by default, scopes all reviews, has no instructions, and needs a repository connection and
a language before it can be enabled (their card says so, on the Agents list for an administrator too since 7.49.00:
**Set up**, or **Connect a repository first**). The Agents list (`GET /agents`) shows the agents that are not
engineering agents by name, then the engineering ones: these three first, in the loop's order of this table and the
setup guide (7.50.01; each found by its seeded name), then any other by name.

**To enable Bug fixer** (Feature builder alike, with feature requests; the [setup guide](#setup-guide) walks
these steps, with Issue triage first):

1. **Connect the repository** with the deployment's GitHub App: Agents → Connections, make the App and install it on
   the repository ([A GitHub App in two clicks](autonomous-engineering.md#a-github-app-in-two-clicks-74500)). Each
   installed repository becomes a connection whose row carries `repository_private` as GitHub says, which decides the
   `github_issue` label rule below. A connection saved with a pasted token says nothing of it and is taken as public.
2. **Attest its CI** on the connection (the broker serves no push or pull request until then).
3. **Ingest its issues**: the [GitHub Issues source](github-issues.md#signing-in-with-a-github-app-74500),
   deployment-wide (Administration → Data sources, `/admin/data-sources`, for a platform admin from any address since
   7.50.00; outside any workspace, Administration → Sources → Source settings too), with the repository listed and
   **Sign in with** → GitHub App, that App, in place of a fine-grained token (each run then reads with installation
   tokens of `{issues: read, metadata: read}` alone). A pasted token still works.
4. **Set up** on Bug fixer's card (on the Agents list or its page): the connection, the language and the monthly budget ($50 prefilled), then
   **Enable**. It runs as you from then. Enable checks first what a run needs (7.50.00, the connection, the CI
   attestation, an image for the language, Bedrock access to every model its flow runs on, the budget and your stored
   way of working: AI-assisted or AI-driven for a flow that pushes), and answers 409 naming each that fails;
   `GET /agents/engineering/readiness?automation=<agent id>` lists every check, the advisory ones too
   ([autonomous-engineering.md](autonomous-engineering.md#readiness-75000)); the Set up dialog asks it of the
   connection and language you selected (`&connection=<id>&language=<language>`, 7.50.01), before anything is saved.
5. **Label an issue** `voc-agent`. Once the source has ingested it, the next heartbeat (every 15 minutes) starts one
   run on it. On a public repository the label is the only way in; on a private one (`repository_private`) the
   trigger may also take a trusted author's issue (`trusted_authors`, off as seeded) or, with its label cleared, any
   issue.

## Engineering agents

*Built* (7.47.00). An agent with `engineering` settings runs an engineering flow (`voc-workflow/2`) on a repository,
through voc-engineering-start (docs/autonomous-engineering.md, "How a flow starts"), instead of the agents' runtime.
Only where the module is on, and for administrators only: any other caller, a delegated credential included, never
lists or reads one (404).

- **Settings** (`engineering`, an editable field): `{connection, language, feedback_type}`. `connection` names a
  stored, not removed repository connection (Agents → Connections), `language` one of the runtime's toolchains
  (`python`, `node`, `rust`, `java`), `feedback_type` what the agent works on, `bug` (the default) or
  `feature_request`. The connection and language may be empty while the agent is disabled; refused with 400 when the
  module is off, the connection is not stored, or the language has no image. An engineering agent's workflow must be
  an engineering flow, and an agents workflow's agent has no `engineering` settings (400 either way): the two kinds
  of agent never mix their workflows.
- **Enabling** needs the connection, the language and the flow's monthly budget (`budget.monthly_usd`, 400 "set the
  agent up first" otherwise), and since 7.50.00 the readiness checks a run needs (409 `{error, checks}` otherwise:
  [Readiness before Enable](#readiness-before-enable)). The administrator who enables it is who it runs as from then (`owner_sub`,
  `owner_username`; `owner_sub` is never set by hand on an engineering agent): their way of working is the dial its
  pushes follow, and the heartbeat re-checks in Cognito before each start that they are still an enabled admin of the
  same account (else the agent skips with `owner_not_admin`).
- **Instructions** at most 300 characters: they become the trusted start of the run's goal, followed by one sentence
  the server writes from numbers and names only ("Fix the bug reported in issue #7 of owner/name.", "Hunt the defects
  behind 12 bug reports in all reviews.", "Build the feature the PRD … of project … describes."); never an issue's or a
  review's text (the run's agents read the issue's thread through the broker). A goal over 500 characters is refused,
  never cut.
- **Budget**: runs per day 0-5 (default 1); what a run may spend is its flow's monthly budget, the hard cap forced on
  every run of it (capped at what is left of the flow's month even with the administrators' hard cap off), and the
  per-run caps ($50, 10 million tokens, 100 tasks by default).
- **Runs**: one active run per agent, the lock held while the engineering run is live (active, or waiting for a person);
  the heartbeat reads the engineering run's `META` and ends the agent's run when it ends (done → completed, failed,
  stopped → cancelled), for a disabled agent too. The agent's run row has `kind: engineering`, its
  `engineering_run_id` (the run monitor's), and what it started from (`issue`, `prd`, `feedback_count`). Cancelling it
  from the agent's page answers 409; since 7.50.03 its Runs tab shows the run monitor's own **Stop** while the run is
  live (`POST /agents/engineering/{run_id}/stop`, below), which ends the engineering run, and the API then ends the
  agent's run at once (cancelled, its lock released: the agent may run again without waiting for the heartbeat). **Run now** (`POST /agents/{id}/run`, an
  administrator acting for themselves) takes `{issue}` (rerun an issue, the only way to), `{prd: {project_id,
  document_id}}` (a feature agent) or nothing (a bug agent's hunt); a feature agent needs one of the two. Its run's
  actor is the administrator who pressed it.
- **Only the deployment's feedback** starts a run (D8): the agents and their runs are the deployment's until agents move
  per workspace ([3g3](multi-workspace.md#the-project-plan-phase-3)); the page lists them inside a workspace too and
  says "Runs on the deployment's feedback".
- The assistant's agent tools have no engineering field, and every agent write is an administrator's acting for
  themselves, so no delegated credential sets or changes one.
- **Readiness** (7.50.00): before Enable, each check with its fix and doc link; Enable waits while a required one
  does not pass ([Readiness before Enable](#readiness-before-enable)).

## Setup guide

*Built* (7.50.00), for administrators where the engineering agents are on. **Agents → Setup guide**
(`/agents/setup`, a button beside **New agent**) walks the deployment through the autonomous bug loop, in the owner's
recommended order. Each step is a path, `/agents/setup/<step>`, so Back walks them; `/agents/setup` opens the step it
recommends (the first one neither done nor skipped).

| Step | What it sets up | Done when |
|---|---|---|
| 0. Prerequisites | GitHub connected with the deployment's GitHub App in two clicks (Agents → Connections), the repository's CI points attested on its connection, and its issues ingested: the GitHub Issues source for the whole deployment (Administration → Data sources, `/admin/data-sources`, for a platform admin; outside any workspace, Administration → Sources → Source settings) signed in with that App, with the `voc-agent` label on the issues the agents may take | a GitHub connection made through an App has its CI attested, the deployment's GitHub Issues source is not reported unconfigured (7.50.01), and no prerequisite check of an automation's readiness fails (the source's reads and the label are known only from those) |
| 1. Understand the repository | its flow arrives in 7.52 | never in 7.50 (skip it for now) |
| 2. Tenets | its flow arrives in 7.52 | never in 7.50 (skip it for now) |
| 3. Issue triage | the seeded Issue triage automation: its Set up and Enabled control, and its readiness | the automation is enabled |
| 4. Bug fixer | the same for Bug fixer | enabled |
| 5. Feature builder | the same for Feature builder | enabled |
| 6. Ready to go | where each step stands, **Run on an issue now** (a Run now of Issue triage when enabled, else Bug fixer, on one issue), and that every run learns: its proposals wait in Skills for an administrator | **Finish the guide** |

- **Never a lock.** Every step but the last offers **Skip for now**, and says plainly what skipping costs in the
  quality of the results (without triage, for example, Bug fixer decides from the issue's own label and words, guesses
  the severity and starts without acceptance criteria) and which steps before it are not done. A skipped step can be
  taken back. What gates Enable is the readiness a run needs (below), never the guide's order.
- **What is set up is read, not stored.** The guide reads only routes that already serve the deployment (the agents
  list, `GET /agents/engineering/connections`, `GET /agents/engineering/github-apps`, each automation's readiness, and
  since 7.50.01 `GET /integrations/status` in the deployment's scope, no workspace header) and its own progress. The
  prerequisites step shows the deployment's own facts (GitHub connected through an App, and which connections; the CI
  attested, and for which connections; the GitHub Issues source, **Not configured** while the deployment's integration
  status says so, with the link to Administration → Data sources) apart from each automation's prerequisite checks,
  "Readiness for <automation>, once set up". While an automation names no connection and the deployment has one it
  could use, its readiness is asked of that connection (the readiness preview), so the two never contradict each
  other. It finds each automation by its seeded name, then a renamed Bug fixer or Feature builder by what it works on;
  a renamed Issue triage is not found until the agents API names an agent's seed.
- **The progress** is the person's choices only: `GET /agents/engineering/setup` →
  `{steps: {<step>: pending | skipped | done}, intro: unseen | started | skipped, revision, updated_at, updated_by}`,
  and `PUT` `{revision, steps?, intro?}`, which changes only the steps it names, from the revision read (409 once
  another administrator saved since). One voc-agents row, `SETTINGS#engineering_setup` / `config`, written with a
  create-only `LOG#<at>#<n>` row (who, when, what changed) in the same transaction, as the hard cap's
  (D1, D4; `lambda/shared/agents_engineering_setup_routes.py`). Administrators acting for themselves only (403 for
  anyone else, a delegated credential included), 404 while the module is off. A detected step is done whatever was
  chosen; only the last step is marked done by hand.
- **The first visit.** While nothing is set up (no GitHub connection, no engineering automation enabled) and no
  choice was made, the Agents list offers **Help me set up** (the guide) or **Skip**. The choice is the deployment's,
  so another administrator is not asked again; **Setup guide** stays one click away.

### Readiness before Enable

An engineering automation's readiness (`GET /agents/engineering/readiness?automation=<agent id>`; every check, what it
reads and its fix: autonomous-engineering.md, "Readiness (7.50.00)") answers `{subject, ready,
checks: [{id, status, detail, fix, docs, required}]}`, `status` `pass`, `fail`, `warn` or `unknown` (a read the server
could not make, never taken for a pass). The **required** checks are what a run truly needs: the connection, the CI
attestation, an image for the language, Bedrock access to the flow's models, the budget and the enabling
administrator's stored way of working. The others are advice.

- **Where it shows.** The Set up dialog, the agents list's card (folded under its summary: a set-up, disabled agent
  keeps its card while a required check does not pass), the Enabled switch on an agent's page and the setup guide
  show each check passed, failing, with a warning or unknown, whether a run needs it, what the server found, its fix
  in the server's words and its doc link (a repository doc or an https address; anything else is not linked). The
  way-of-working check also links to Administration → Privacy & access → Users, where the administrator sets
  AI-driven: the agents fix, push and open the pull request, and a person approves and merges it on GitHub.
- **The Set up dialog reads the readiness of its selection** (7.50.01):
  `GET /agents/engineering/readiness?automation=<agent id>&connection=<id>&language=<language>` answers for the agent
  as if it were set up with the connection and language selected, read-only (nothing is saved; 400 for a connection that is not stored or was removed, or a
  language with no agent image), and the dialog reads it again whenever either changes. So on a first set-up the
  connection's App installation, CI attestation and branch rules, the Issues source and the language's image are
  those of the selection, never the stored agent's empty settings. The dialog fits the window: its checks scroll
  between the title and **Cancel** and **Save and enable**, which stay in view; the summary line (Failing · Unknown ·
  Warnings · Passed) heads them, the checks that do not pass come first (those a run needs first) and those that
  passed are folded under one line.
- **Enable waits** while a required check does not pass, an unknown one included; an advisory check never holds it.
  In the Set up dialog only the budget, which the dialog saves itself (and checks as you type), does not hold its
  **Save and enable**: it is checked again by the Enable after the save; every other required check, the way of
  working of the administrator enabling it included, holds it for the selection. An Enable the server refuses answers
  409 `{error, checks}`, and the dialog or the switch shows those checks. A readiness that cannot be read is said so,
  and Enable stays the server's to refuse.

### Template updated

A role's skill (Agents → Skills) is made from its bundled template (`voc-datalake/templates/orchestration/agents/
<role>/`). A role's history (`GET /agents/engineering/skills/<role>/versions`) names it, `template: {version, label,
newer}`, `newer` when the scope has versions and none was seeded from a template this recent; Skills then shows
**Template updated (vN)** on the role's panel.

- **Show what it changes** reads `GET /agents/engineering/skills/<role>/template?connection=` →
  `{template, current_version, record, diff}`: the template's record and its diff against the version the scope runs
  (its own current one, else the shared skill's), shown as a version's diff is (instruction lines and examples added
  and removed, tools, the model and the harness); 404 for a role with no template.
- **Adopt as a proposal** (`POST …/skills/<role>/template/adopt?connection=` `{expected_current, template_version}`,
  409 when either moved since the screen read them, or when that template is proposed or accepted already) makes the
  template a new version proposed by the administrator who pressed it, on the version the scope runs (provenance
  `template`, `engineering/skills/actions.py` `adopt_template`). It runs only once an administrator accepts it in the
  role's history, like any proposal; nothing is ever adopted or accepted by itself. Both routes are an administrator's
  acting for themselves (403 otherwise, an MCP credential included), 404 while the module is off.

## Triggers and budgets

| Trigger | Fires when |
|---|---|
| `new_reviews` | ≥ `min_new` in-scope reviews since the agent's cursor, and `cooldown_hours` have passed; an engineering agent counts only those of its kind (`dimensions.feedback_type`) |
| `schedule` | every 12 h / 24 h / cron, in the agent's timezone |
| `threshold` | `count` reviews per category or subcategory within `window_days` (`METRIC#daily_subcategory#{cat}#{sub}` rows written by the aggregator); refused with `scope.sources` (its counters have no source); an engineering agent with none of its kind in the window skips (`no_bug_reports`, `no_feature_requests`) and its baseline moves on |
| `github_issue` (7.47.00, engineering agents with a GitHub connection) | an open issue of the connection's repository, ingested by the [GitHub Issues connector](github-issues.md) within `lookback_days` (1-30, default 7), classified as the agent's kind (7.50.00: or triaged as it, `requires_triage`; any kind for a `triage` stage) and in scope, that may start a run (below); at most one such trigger per agent |

`scope.sources` (7.47.00, any agent): the `source_platform` ids its reviews must come from, at most 20 (none: every
source).

**`github_issue`** (`agents/heartbeat/issues.py`): `{label, trusted_authors, lookback_days}`, label `voc-agent` by
default. The heartbeat reads the deployment's `CHANNEL#issue` partition of the feedback table's channel index, items
first ingested within the look-back, newest first, at most 500 a tick. On a **public** repository (a connection that
does not say `repository_private`, 7.45.00) only an issue carrying the label starts a run: anyone may open an issue,
only a maintainer labels one; the label is then mandatory (400 when empty). On a private repository the label, else,
with `trusted_authors`, an issue by the repository's `OWNER`, a `MEMBER` or a `COLLABORATOR`, else (no label set) any
issue. **One run per issue, ever**: the run takes the issue's claim (`ISSUE_RUN#default` / `<owner/name>#<n>`, for every
agent) in its start's own transaction, so two ticks or two agents never start the same issue; a start refused later
keeps the claim (it is never retried), and only an administrator's Run now `{issue}` reruns one. The oldest unclaimed
issue starts first. A label added after the look-back has passed is missed: the item's time is its first ingest.

**Stages and the triage** (7.50.00): a `github_issue` trigger may also say `stage` (`act`, the default, or `triage`)
and, on an act trigger, `requires_triage` (`bug` for an agent of `feedback_type` `bug`, `feature` for one of
`feature_request`; 400 for any other pairing). A **triage** trigger (the seeded Issue triage automation's) takes any
kind of issue (its run decides the kind; the label rule and the scope hold as above) under a claim of its own,
`ISSUE_RUN#default` / `<owner/name>#<n>#triage`, beside the act claim, so triaging an issue never keeps the Bug fixer
or the Feature builder from it; its run's goal asks for the triage (kind, severity, priority, the code involved, the
acceptance criteria), and its understander records it (`write_triage`, `voc-triage/1`), comments it and labels the issue
(`voc-triage/<kind>`, `voc-severity/s<n>`: the broker's `label_issue`, those labels only). At that run's end
voc-engineering-runtime copies the record to the issue's **trusted row**, `ISSUE_TRIAGE#default` / `<owner/name>#<n>`,
create-only (a rerun's later triage is kept out). An **act** trigger with `requires_triage`, while an enabled agent with
a triage trigger watches the same connection, takes an issue only once that row says its kind (whatever the item's
`dimensions.feedback_type`); with no triage agent enabled there it keeps the rule above (the agent's kind). The GitHub
labels are informative only: a `voc-triage/*` label never stands in for the row. A Run now `{issue}` of a triage agent
triages the issue under the triage claim.

The heartbeat (EventBridge every 15 minutes) evaluates triggers. Limits: one active run per agent, at most 2
**scheduled** runs per agent per day (an engineering agent: 0-5, default 1), a per-run model-call cap (150 by default)
and a monthly cap. **Run now** is unlimited and does not count against the daily limit.

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
  Workflows saved by releases before 3.00.00 may still hold such arrows. They are read the way the runtime always
  treated them: the `pass` arrow becomes a plain arrow, and a `fail` arrow or a `pass` arrow beside a plain one (both
  never taken) is dropped, so those workflows keep running unchanged and re-save cleanly. Edit a condition on the
  arrow or in the step's "Arrows out".
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
    on every outcome, so the loop would go round until the 120-step limit);
  - an arrow from any other loop step to a step outside the loop — "only the loop's review can leave the loop"
    (it would run beside the loop as a fan-out).

  The runtime never re-validates a stored definition (`agents/graph.py` refuses only what it cannot walk), so a
  workflow saved before these rules keeps running exactly as before; it must satisfy them the next time it is
  saved. Duplicating one (`POST /workflows/{id}/duplicate`) validates the copy, so fix it first.
- With nothing selected the panel shows the workflow's name, description and an outline that selects any step or
  loop, so every setting is reachable from the keyboard.

### Engineering flows (`voc-workflow/2`)

The opt-in engineering agents' flows are workflows too, with `schema: 'voc-workflow/2'` (`shared/workflow_engineering.py`
holds their steps and rules; `shared/workflow_schema.py` validates both kinds). An engineering flow has `start`, `end`
(an end with `status: needs_human` is the human decision point) and the engineering steps: `agent` (`role`,
`skill_version`, `model`, `budget_share`), `map` (`shard_by`, `shard_cap`) and `reduce`, `board` (`posters`,
`claimers`, `until`), `quality_gate` (the gate's own settings: `max_rounds`, `packs`, `final_go_model`, `reviewers`),
`learning_loop`, `self_improvement`, `memory` (`mode`, `scope`, `limit`) and `stop_at_pr`. A save or
`POST /workflows/validate` refuses, pinned to the step: a setting off its range; a map that does not meet exactly one
reduce on every way out (a way to an end without one would leave its shards unreduced), or a reduce with no map; a quality gate without its `pass` (GO) and `fail` (NO-GO) arrows, or whose `fail`
arrow does not go to a human decision point; a label on any other arrow; a learning loop that is neither last nor
right after a board; self-improvement that is neither alone in its flow nor last; an arrow out of a stop at PR; agents'
budget shares above 1 in all; and a committer or PR author (an agent, or a board's claimers) whose work can end
anywhere but a stop at PR or a human decision point. There is no merge step. An engineering flow declares no loops (its
board does the repeating) and holds no agents step; an agents workflow holds no engineering step.

An engineering flow may carry `budget: {monthly_usd}`: what its runs may spend in a calendar month (UTC),
in dollars and cents from 0.01 to 100,000 (more decimals are refused, not rounded, so the amount approved is the
amount kept; else 400, and 400 on an agents workflow; the editor's Monthly budget field
under the flow's description, empty for none; leave `budget` out for none, never `null` in the assistant's draft). It
is recorded with the flow. A run started with it (`POST /agents/engineering/runs`, below, which reads it from the
stored flow, never from the request) says so in
its conversation as its flow's month passes 80%, 100% and every further 50% up to 1,000%
(docs/autonomous-engineering.md, Cost),
session time only until tokens are priced (a deployment that sets every AgentCore rate to 0 never alerts); it
stops nothing unless an administrator turns the hard cap on (`PUT /agents/engineering/settings`): then a run's first
start is capped at what is left of the month, or refused when nothing is. A flow saved without one reads and saves as before. Only a signed-in administrator saves a workflow
(a delegated credential, an MCP token or an agent, gets 403), so the assistant changes a budget only through its
`create_workflow` and `update_workflow` cards, which say it in dollars ("Monthly budget set to $80.00", "Monthly
budget: $50.00 → $80.00", or removed) for the person approving it; a duplicate keeps its source's budget.

The two kinds never mix in one run: an agents workflow's agent runs no engineering flow (`POST`/`PUT /agents` refuse
one), and since 7.47.00 an [engineering agent](#engineering-agents) (one with `engineering` settings) runs only an
engineering flow, through the engineering runtime, never the agents' one; a saved workflow keeps
its kind (a save of the other kind over it is refused: save it as a new workflow), and the agents' runtime refuses a
`voc-workflow/2` definition. `GET /workflows` lists both kinds, each with its `kind` (`agents` | `engineering`): the
editor opens either, and an agent's workflow picker offers the agent's own kind only. An engineering flow is a
definition, like any workflow: one already saved opens and saves in every deployment, a new one (`POST /workflows`: New, the
editor's Save as, an imported draft saved as new; and the assistant's `…/duplicate`) is created only where the opt-in engineering module is on (409 elsewhere,
on the server, whoever asks), and it runs only there. The library has **New workflow** (an agents workflow) and, only where the module is
on (`config.json` `features.engineering`), **New engineering flow**; an engineering flow's palette shows **Engineering** (with Start and
End), its settings panels set each step's settings (no step role and no loops: its board does the repeating), and its
graph rules are mirrored as you edit (`WorkflowEditor/engineeringRules.ts`, held to the
server by the shared fixture `frontend/src/test/engineeringFlows.json`). The AI assistant drafts one too, with its
workflow tools (`validate_workflow`, then `create_workflow` or `update_workflow` behind an approval card), and the
web app's card for a new one checks the module too, before the server does (one already saved is changed anywhere,
as in the editor).

**The default engineering flows.** Five templates are compiled from `voc-datalake/templates/orchestration/flows/`
into the orchestration bundle (7.50.00), which the server (its copy `lambda/shared/orchestration_bundle.json`,
`shared/engineering_templates.py`) and the web app both read, every one validated by
the server's own rules in `shared/test/test_engineering_templates.py`: Understand the repository, Issue triage, Bug
hunt and fix, Feature from an issue or a PRD and PR review ([docs/autonomous-engineering.md](autonomous-engineering.md#how-the-agents-work-together)).
`GET /workflows/templates` lists them, each with its `template_id`, `name`, `description` and `definition`, for an
administrator (403 for anyone else, a delegated credential included) where the module is on (404 elsewhere). A
template is never stored and there is no "create from template" route: a copy is created by `POST /workflows` with
its definition, so it gets that route's validation and its 409 where the module is off. In the library, beside
**New engineering flow**, **Start from a template** lists the six with their descriptions; choosing one opens the
editor on an unsaved copy of the server's definition (`/agents/workflows/templates/<template_id>`, read with
`GET /workflows/templates`, named and described in the person's language), with no Save as, Reset or History until **Save** creates it and opens it on its own page.

### An engineering run: monitor, board, conversation, reports

Where the engineering agents are on (`ENGINEERING_AGENTS=on`, with their table and workspace bucket), the Agents API
lets an administrator acting for themselves read a run and act on it (403 for anyone else, a delegated MCP or agent
credential included, like a run's decision; 404 for an unknown run, and for everyone while the module is off). There is
no MCP tool for engineering runs yet (docs/mcp.md). The web app's AI assistant answers "what is agent X doing" for an
administrator with `get_engineering_run {run_id?, agent?}` (read only, the run on screen by default: the run and each
agent's status, task, step, why it looks stuck and recent tool calls, live agents first, the agents' words passed to
the model as data), through these same routes and gate (in a plan, only a think step whose approver the conductor
re-checks as an administrator before the step, as with the assistant's other admin-only reads). "Refresh the knowledge pack" through the assistant is built (6.27.00):
`propose_knowledge_refresh {connection, commit?, language?}` (administrators) only proposes, as a card naming the action,
the repository connection, the commit (or the default branch's head, whose full id the administrator enters on the card),
the saved Understand flow and an estimate of the minutes and cost; only an administrator's Approve starts the flow, with
`POST /agents/engineering/runs` in that administrator's own session (the same gate: anyone else and a delegated credential
get 403; the run records who started it), never the model and never a plan step; with no Understand flow saved, the card's
Approve saves one from its template and starts nothing ([autonomous-engineering.md](autonomous-engineering.md#how-the-agents-work-together)). An administrator starts a run from a saved engineering flow's page (**Start a run**:
the repository connection, the commit, the language and the goal, checked as the server checks them) or with
`POST /agents/engineering/runs` (below); the run's workspace then opens on it ([The run workspace](#the-run-workspace), 7.51.00, which replaced the run monitor at the same address). The web app's page for a run is `/agents/engineering/<run_id>`:
its flow (the run's own copy, as its start wrote it, each step lit as the conductor reads it: done, under way, waiting at a
person, not run yet; for a run without a copy, the steps its agents are on: [autonomous-engineering.md](autonomous-engineering.md#the-flow-a-run-follows)),
its agents' sessions, and the inspector's Board and Reports (the reports by
level, goal first; the one chosen shows its latest version's Markdown, rendered as Markdown only, with a picker for
the earlier versions). On a run that has not ended, an administrator always has **Stop** (7.50.03: Stop has the agents
save a checkpoint, then ends the run, at once when no agent has a session to save; its menu holds "Stop now, without
saving", which asks first; "Stopping…" while the agents save), and acts from the page: Pause or Resume (one toggle by the
run's state), Save a checkpoint (⋯), each agent's Stop and ⋯, steering and answers, and on the Board
tab posts a task for a role, and on a task that has not ended (never the coordinator's) takes it, blocks it with a reason
(ending another person's hold, either way, asks first), sets its priority, and moves a task they hold (to needs a
person only by Block, which says why) or gives it back to the agents.
The reads work wherever the module is on. Since 7.51.02 each action reaches the run by its own path, and the page
shows each control from its own flag: steering and answers over the bus, which the stack names to the Agents API with
a grant held to those two types (`steer_available`); the signals and the Stop through the start function, which the
stack names and grants (`signals_available`, `stop_available`: [autonomous-engineering.md](autonomous-engineering.md#run-controls-reach-the-agents-75102));
board actions nowhere yet (`board_available: false`: their events would go out from the API's source, which the bus
takes only steering and answers from, so they answer 503 before the board is asked). All of it works in every
deployment with the module on, a page whose last read failed included (the page keeps its last good read and its
controls, says "Couldn't refresh" with a Retry, and polls on with a backoff; only a 404 stops it).

| Method | Path | Answers |
|---|---|---|
| POST | `/agents/engineering/runs` `{workflow_id, connection, commit, language, goal, issue?}` | an administrator acting for themselves starts a run of a saved engineering flow: each field checked (a saved `voc-workflow/2` flow, else 400; a connection's short id, 1 to 63 letters, digits or `-`; a full commit id of 40 hexadecimal characters, kept in lower case; a language with an agent runtime, `java`, `node`, `python` or `rust`; a goal on one line of 1 to 500 characters, credential-shaped text redacted; since 7.09.00 an optional `issue`, the number of the issue the run starts from, a whole number from 1 to 2,147,483,647, recorded on the run's META as given with its address on the stored connection's host, labelled unverified ([docs/autonomous-engineering.md](autonomous-engineering.md), "The run's issue and pull request"); any other field 400, so the request sets neither the budget, the caps, the repository nor the actor). The API mints the run's id (a ULID) and invokes the start function (`ENGINEERING_START_FUNCTION`, voc-engineering-start: the runtime's code, which takes `start_run` and refuses every other action; the API's role may invoke it and never the runtime itself) with the stored flow's monthly budget, a task cap of 100, the deployment's cost cap (`-c engineeringRunCapUsd`, 50 USD by default; with the hard cap on, the runtime keeps the smaller of it and what is left of the flow's month) and token cap (`-c engineeringRunTokenCap`, 10 million by default), the stored connection's repository (`owner/name`, or GitLab's project path) as the run's `repo` and its default branch as the run's `default_branch` (400 for a connection that is not stored), with an `issue` the connection's host too, and the person as the actor (`started_by` on the run and its `RUNLOG#` row: who and when, D4). The start function writes the run, switches the supervisor's rule on and hands the coordinator's launch on to voc-engineering-runtime (`launch_coordinator`, asynchronous; a launch that fails sends the run to a person), so the API answers 202 `{run: {run_id, status, workflow_id, started_by}}` as soon as the run is written. The runtime's refusals, all before anything is written, are 409 in its words (no image for the language in this deployment, the hard cap with nothing left of the flow's month); a read the start needed that failed (the hard cap's setting, the flow's month total) is 503 "start the run again" (nothing written); any start that wrote or may have written its run is 503 naming it, with `run_id` beside the message (a failure once the run is written: the rule, the hand-on, a launch under way; a failure whose read back of the run failed too; a failure of an unknown kind; no answer within 25 s; a dropped connection): open its monitor, never start another, and the dialog offers **Open the run** with Start kept off; only a start known to have written nothing (its write failed, the function never reached or refused by the service) is 503 "start it again". The web app's flow page has **Start a run** (administrators, with `features.engineering`), which opens the new run's monitor. No MCP tool |
| GET | `/agents/engineering/{run_id}` | the run monitor (`lambda/engineering/monitor.py`): the run (goal, repository, flow, status, times, messages numbered), and each agent as the supervisor last saw it (its session row in the run's partition of the engineering table, `WS#<ws>#RUN#<run>` / `AGENT#<agent>`: role, task, status, continuation, step, session state and age, heartbeat age, last progress, why it looks stuck, its recent tool calls, session-seconds, tokens in and out per model), with the totals per model and for the run, and the run's flow budget (`run.budget`: `{monthly_usd, alert_percent, alert_month}`: the highest level this run saw its flow's month pass, until it ended; null for no budget), and the flow it follows (`run.flow_definition`, the run's own copy, which the page draws; `run.flow_revision`, `run.flow_copied_at`, `run.flow_steps` `{<step>: <status>}` and `run.flow_outcome` `{outcome, at, reason}`, from the run's own copy and the conductor; all null for a run started without a flow), and, since 7.09.00, the issue it was started from (`run.issue` `{host, number, url, verified}`) and its draft pull request (`run.pull_request` `{host, number, url, head, base, superseded}`, `superseded` the earlier numbers on the same branch; GitLab's merge request), each null for none and read back only when its address is the run's repository's own on its host's own domain; the page links them in a new tab; and, since 7.10.00, `reactions`: the latest read of people's reactions on the host to that pull request (null for none; its state, the reviews and comments kept by the trust filter, each body plain text, the counts, each reviewer's latest state, a revert, people's commits after the merge (`edits_after_merge.people_commits`: no bot's, no agent's), what was dropped, when and who asked (`schedule` or `human:<subject>`): docs/autonomous-engineering.md, "People's reactions on the host"). Cost comes when the run control is wired |
| POST | `…/reactions` `{}` | since 7.10.00: an administrator acting for themselves asks for an ended run's reactions to be read now (the run monitor's "Read reactions now", behind a confirmation): 202 `{reactions: {status: 'asked'}}`, the read handed on and shown once recorded; 409 while the run has not ended; 429 `{error, retry_after}` when this run's read was asked for in the last 60 minutes (a hand-on that failed releases its ask); 503 when the read could not be handed on; 403 for anyone else, a delegated credential included; 404 while the module is off or for an unknown run |
| GET | `…/board`, `…/conversation?after=&limit=`, `…/reports`, `…/reports/{level}/{subject}?version=` | the task board with each task's history (and, in a run that follows its flow, the step it was posted for, `flow_step`, and the map's shard it works on, `shard`; null for none), a page of the conversation, the report index, one report (each conversation page reads the 20 below `after` again, then at most `limit` above it, and moves on to its last seq: keep each message once by `seq`) |
| POST | `…/stop` `{now?, confirm?}` | since 7.50.03: an administrator acting for themselves stops the whole run, through the start function's `stop_run` (`ENGINEERING_START_FUNCTION`; neither the runtime nor the bus is needed here), whatever its agents are doing, a run waiting for a person with no session included. A Stop has the agents with a session save a checkpoint and stop (the Shut down signal, handed on to voc-engineering-runtime), answered `status: stopping`, and the run ends once none has a session left, or 10 minutes after the request at the latest; with no agent that has a session it ends at once (`stopped`). `now: true` with `confirm: true` ends it at once without a checkpoint. Ending it writes META `stopped` with its `RUNLOG#` row (the person and how), closes every task that has not ended (`failed`, a `stop` history row naming the person: never an agent's failure for the coach), runs out its launch holds and ends its sessions; the issue's `ISSUE_RUN#` claim is kept (one run per issue, ever). While it stops the run launches no agent and takes no Resume. Answers `{stop: {status, mode, tasks_closed, saving, already, fell_back, agent_run}}`: `agent_run` is the engineering agent's run, ended at once once the run has (`{agent_id, run_id, ended}`; null for a run no agent started, or still stopping). Its record is the run's `RUNLOG#` row; nothing is said on the bus (7.51.02). 409 for a run that has ended; 503 when the start function cannot be reached or is not named (send it again: every step is idempotent); 403 for anyone else, a delegated credential included; 404 while the module is off or for an unknown run |
| POST | `…/signals` `{signal, task_id?, attempt?, note?, confirm?}` | `save`, `pause`, `resume`, `shutdown` or `stop_now` (no checkpoint: needs `confirm: true`), to the agent on a task at the attempt you saw, or (no `task_id`) Save, Pause or Resume to the whole run: 409 when the task has moved on since (another attempt, no holder, back to open, or ended), the run has ended or a Stop of it is under way. Since 7.51.02 it goes through the start function's `signal_run` (`ENGINEERING_START_FUNCTION`; never the runtime's own function), which checks the run, the agent and the state again (its refusals 409 in its words), records the request on a `RUNLOG#` row of the run (who asked what of whom, the note: D4; nothing in the conversation) and hands it on to the supervisor (`voc-engineering-runtime`, `{action: signal}` with the attempt for one agent; idempotent per agent), asynchronously. Answers `{signal: {signal, target, attempt, status: sent, agents: {}, applied: {}, at}}`: the overview shows what came of it (an agent another move holds, or on another attempt by then, is left as it was: send it again). An unreachable start function answers 503 "send the signal again"; a deployment that names none, 503. Since 7.50.03 a whole run's `shutdown` or `stop_now` is the run's Stop (`…/stop`, above, its answer in `signal.run`), where the start function is named. Since 7.51.00 `restart` `{from: 'checkpoint' \| 'fresh', task_id, attempt, confirm: true}` restarts one agent (sent to the runtime as `restart_from`), refused while a Stop of the run is under way |
| POST | `…/board/tasks` `{role, title, spec, priority?, parent_task?, flow_step?, shard?}` | since 7.51.02 503 before the board is asked, on every deployment (its `task.*` would go out from the API's source, which the bus takes only steering and answers from: the overview's `board_available` is false), like each action below that publishes; where the bus took them, a person posts a task for a role that claims tasks, within the run's caps (an equal task still under way is answered, `duplicate`); never the coordinate task. In a run that follows its flow, `flow_step` names a live step (for a role it takes; `shard`, one of a map's shards left for a step after the map), else it is their own task, off the flow, which the coordinator may still launch; 409 for a step that is not live |
| POST | `…/go` `{}` | a person's go on the run, which an AI-assisted run's push and pull request wait for (TENETS.md tenet 3; the broker reads it, docs/autonomous-engineering.md "Repository connectors"): the board's function writes one create-only `GO#person` row `{by: human:<subject>, at}` while the run is live, answered `{go: {by, at, created}}`; a go already there is answered as it stands (`created: false`), whoever asks, never replaced; 409 for an ended run. No event and no bus needed: the row is the record. REST only (no MCP tool, no button yet) |
| POST | `…/board/tasks/{task_id}/{action}`: `priority {priority}`, `block {reason, over?}`, `take {over?}`, `move {to}`, `release {}` | since 7.51.02 503 before the board is asked, as a post (above); where the bus took their events, a person re-prioritises a task that has not ended, blocks it (it needs a person, with their reason; its holder's lease cleared, so the agent on it can move it no more; the supervisor reads the ended task as ended and ends that agent's session, never continuing it), takes it (they hold it with no expiry, so its agent can move it no more, the supervisor leaves it alone, and a signal to it answers 409), or moves a task they took on (the board's moves, but never to `needs_human`: that is a block's, which says why; 400), or releases a task they took (open again at its next attempt, their hold cleared, published to its role as `task.posted` like a re-post; it stays open until the run coordinator, listing the board, launches an agent of its role for it, which starts from the task's spec with no checkpoint of the earlier attempt; 403 for a task they do not hold). A take or block ends another person's hold only with `over: true` (else 409), and holds the holder it read; a priority needs no `over`, even on a task another person holds, since it ends no hold. 409 for a task that has ended or moved on, 403 for the coordinate task. Each change is the board store's write with a history row naming `human:<subject>`, made by the board's own function (the API invokes it directly, `ENGINEERING_BOARD_FUNCTION`, and its role writes none of the table; without it, 503), then published as the board's `task.*` from the API's own source with `from.kind` human; a retry of it publishes the same event again while it is still the task's last change, and a no-op (a priority the task already has when its last change was something else) is answered and publishes nothing. A publish that fails after the write answers 503 "the board changed but its event was not published: retry", and a board function that fails after its write answers 503 "the board could not be reached: retry": either way, retry the same action before any other, or its event is not sent (the change and its history row stay). The API publishes only an event that is this person's action (one `task.*` of this run, and of this task, from `human:<subject>`); anything else the board hands back, an event that is not voc-msg/1 too (the board's fault, never the person's words: it refuses a title shaped like a credential before writing and cuts and redacts each summary), is a 503 and nothing is sent |
| POST | `…/messages` `{to: 'conductor' \| 'agent', agent?, text, thread_id?}` | a person's answer (`msg.answer`, at most 1 KB, refused if it holds something shaped like a credential) to the run's conductor or one of its agents, on the thread it answers (a new one if left out), published from the API's own source (one of the two detail types its grant allows, 7.51.02); the conversation records it. Since 7.51.00 an answer to an agent needs the `thread_id` its own `msg.question` opened (400 without one, 404 for a thread it did not open, D51-4): anything else for an agent is steering |
| POST | `…/steer` `{text, about?, thread_id?}` | since 7.51.00: an administrator's steering, sent to the run's orchestrator only (`msg.steer` from the person to the conductor, never to an agent; at most 1 KB with its "About <agent>: ", which `about` adds for an agent of the run; credential-shaped text refused): 202 `{message: {event_id, thread_id, at}}`; the conversation records it and the API logs who sent it. 409 for an ended run, 404 for an agent not in the run, 503 where the Agents API does not name the bus (`ENGINEERING_BUS_NAME`) |
| POST | `…/restart` `{mode: 'resume' \| 'restart', agents?, base: 'same' \| 'head', confirm: true}` | since 7.51.00: an administrator resumes or restarts an ended, stopped, spent or 30-day run as a new child run (voc-engineering-start's `restart_run`, docs/autonomous-engineering.md "Steering, Restart and the runs list"): 202 `{run: {run_id, parent_run_id, status}}`; 409 while the run is live (its signals resume and restart its agents) |
| GET | `/agents/engineering/runs?month=&flow=&status=&cursor=&limit=` | since 7.51.00: a month's runs, newest first, from the runs list rows (`WS#default#RUNLIST#<yyyy-mm>`): `{runs: [{run_id, flow, goal, status, started_at, ended_at, cost_usd, parent?}], next}` |
| GET | `…/agents/{agent}/thread?after=&limit=`, `…/agents/{agent}/thread/{ref}` | since 7.51.00: one agent's thread, its transcript and the conversation's messages about it in time order (`{items, next, done}`, at most 200 a page; `after` the overview's `transcript_cursor` opens it at its tail; refs `<attempt>.<chunk>.<byte offset>[.1]` or `c<seq>`), and one item whole (a tool call with its result, or the message) |
| GET | `…/agents/{agent}/changes?source=submitted\|checkpoint&attempt=&key=`, `…/changes/file?key=&path=` | since 7.51.00: an agent's changes from the exact S3 patches the gate judged (`{source, key, commit, attempt, files, truncated, patches, commit_url, pr_url}`), and one file's diff (`{path, key, patch, truncated}`, at most 1 MB) |
| GET | `…/agents/{agent}/files`, `…/agents/{agent}/gate`, `…/agents/{agent}/memory`, `…/assertions` | since 7.51.00: the files an agent read and wrote (from its tool events), its gate records with each check's output, the lessons it recalled and what Learn made of its task, and the run's assertion records (a bare list) |
| GET | `/agents/engineering/settings` | the administrators' hard cap on engineering runs (`engineering/settings.py`, its row in voc-agents): `{hard_cap, updated_at, updated_by}`, off by default (docs/autonomous-engineering.md, Cost). Administrators only (a delegated credential gets 403); 404 while the module is off; 503 when the read fails (retry) |
| PUT | `/agents/engineering/settings` | `{hard_cap: true \| false}`: an administrator turns the hard cap on or off, saved with its history row; the runtime reads it at a budgeted start. 400 for any other body, 403 for anyone but a signed-in administrator, 404 while the module is off, 503 when the write fails |
| GET | `/agents/engineering/readiness?automation=<agent id>` or `?flow=<template id>`, either `[&connection=&language=]` | whether an engineering agent, or a default flow, can run here (7.50.00, [autonomous-engineering.md](autonomous-engineering.md#readiness-75000)), on the connection and language named as if it were set up with them (read-only; 7.50.01 for an agent): `{subject, ready, checks: [{id, status, detail, fix, docs, required}]}`, `ready` when no required check fails; Enable runs the required ones and answers 409 `{error, checks}` with those that fail. 400 for neither or both of `automation` and `flow`, an agent without engineering settings, a connection that is not stored or was removed, a language with no agent image; 503 when the connection cannot be read; 404 for an unknown agent or template and while the module is off; 403 for anyone but an administrator acting for themselves |
| GET | `/agents/engineering/spend?month=YYYY-MM&by=&workflow=` | what the runs spent in a month (default this one, UTC), from the spend ledger (docs/autonomous-engineering.md, Cost): its totals (dollars priced, tokens in and out, session seconds as `microvm_seconds`) and the same per group, `by` workflow (default), repo, run, agent (as `<run>/<agent>`: each run numbers its own), model or day, biggest first, only one workflow's with `workflow`; one Query of the month, `truncated` past 20,000 rows. 400 for a bad month, grouping or workflow, 503 when the table refuses the read (retry) |

A failed call to the start function or the bus answers 503 (retry: the signal is idempotent), and so does a
deployment without the start function (`ENGINEERING_START_FUNCTION`, for signals and the Stop) or the bus
(`ENGINEERING_BUS_NAME`, for answers and steering). Since 7.51.02 the overview says which reach the run, each by its own
flag (`steer_available`, `signals_available`, `stop_available`, `board_available`), in place of `actions_available`.
Since 7.51.00 the overview (`GET …/{run_id}`) also carries `lanes` (each flow step's tasks and
their agents), `gates` (`{step: verdict}`), `children`, each agent's `cost_usd`, `attempt`, `commit`, `skill_label`,
`model` and `transcript_cursor`, and the run's `cost_usd`, `learn_cost_usd`, `cost_cap_usd`, `parent` and (ended)
`manifest`; the Agents API reads the runs' transcripts, patches, gate records and manifests for them, and lists only the
transcript and patch prefixes (`lib/stacks/api-engineering-run-reads.ts`).

### The run workspace

Since 7.51.00 a run's page is its **workspace**: one live screen, interactive like Slack rather than cards, at
`/agents/engineering/<run_id>` (the orchestrator's session) or `/agents/engineering/<run_id>/a/<agent>` (one agent's
session open in it); inside a workspace the address is `/workspace/<slug>/agents/engineering/…`. Where a person is lives
in the path: the agent open is a path segment, never a query. **Agents → Runs** (`/agents/runs`, administrators, with
the engineering agents on) lists the runs started in a month, newest first, a page at a time, with the month, the flow
and the status as filters in the query (`?month=&flow=&status=`); a flow's page links its runs there, and each row
opens its workspace and names the run it was resumed from. Everything on the screen is polled: the overview every 5 s
while the run is under way, an open thread by its cursor (D51-5; the push comes in 7.53).

- **Header:** the run's goal, repository, issue and pull request, the budget it used against its cap (its tokens at
  their prices, Learn's apart), an ended run's manifest, and the runs it was resumed or restarted from and as. At its
  foot, the **run controls**: the run's status in its tone (at work, waiting or paused, done, failed, stopped), and for
  an administrator on a run under way **Pause** or **Resume** (one toggle, by the run's state), **Stop** (a checkpoint,
  then the end) with "Stop now, without saving" in its menu (asked first), and Save a checkpoint under ⋯. Stop is the
  run's Stop (7.50.03, `POST …/stop` through the start function, never a signal), there on every run that has not ended
  wherever the deployment names the start function (`stop_available`), even where it does not connect the runtime and
  the bus (a line then says Pause, Resume and Save need them). While a Stop is under way the status reads Stopping…, Stop
  is inert, a status line gives each agent's part ("fixer-2 saving a checkpoint…") and no agent is signalled, restarted
  or steered; what the Stop did stays said ("Stopped. 1 open task was closed."). A read of the run that fails keeps the
  controls (its last good state), says so with Retry, and is tried again later and later. Once the run has ended,
  **Restart run**.
- **Canvas** (left): the run's own copy of its flow on the workflow editor's read-only canvas. Each step is a stage; the
  agents on a step are sibling **lanes** under it (one per task posted for the step, placed from its `flow_step`), with
  no edges between them, a spinner on an agent at work, dashed while planned and solid once it ran. A gate step shows
  the board's verdict as pass or fail, and "You are here" marks the step the run is on. The canvas is inert: a click
  opens a session, it never signals, restarts or spends anything. A toggle switches to the **timeline**: the steps in
  the flow's order, the agents on each with their attempts, newest first, and the agents on no step of the flow last.
- **Sessions** (centre; first on a narrow screen): the open agents' threads, as tabs (the app's tabs, which scroll;
  the close button beside the tablist, and one "Open another agent" menu) or a grid of 1, 2 or 4 panes whose dividers
  move; the layout is kept for the run in this browser tab (sessionStorage, per
  workspace, forgotten at sign-out). A thread is that agent's transcript and the conversation's messages about it, in
  time order, kept once by each item's ref (a tool's result on a later page replaces its call in place): the agent's
  words as Markdown, its thinking collapsed, each tool call on one line (tool, whether it worked, a one-line input)
  that opens on a click into its whole event and result, the harness's messages to the model folded, a person's
  steering, gate results, findings, signals, checkpoints, a crash and the end inline. An agent's own question carries
  **Reply**, an administrator's answer on the thread that question opened (`POST …/messages {to: agent, agent, text,
  thread_id}`, the one message a person sends an agent directly). Transcript text is rendered as Markdown with no raw
  HTML and no images, its links opened apart, and cut to 4 KB per item.
- **Composer:** an administrator's steering goes to the run's **orchestrator**, never to an agent
  (`POST …/steer {text, about?}`, at most 1 KB with its "About <agent>: "); on an agent's thread it is about that agent
  unless unticked, and its placeholder says so. The orchestrator decides what to relay. Send is the primary button only
  in the session in focus. Steering and Reply go over the engineering bus: where the deployment does not name it to
  the Agents API (`steer_available` false; every deployment with the module names it since 7.51.02), the composer is
  shown off with the reason, and no Reply is offered.
- **An agent's controls** (an administrator's, on a run under way, for an agent whose task is not over), in the run's
  words: **Stop** (a checkpoint, then the end), and under ⋯ Save a checkpoint, "Stop now, without saving" (asked first)
  and **Restart**, which asks whether it starts again from its newest checkpoint or its task afresh (`signal: restart,
  from`), all on the agent's task at the attempt it is on, shown where the signals reach the run (`signals_available`).
- **Inspector** (right; last on a narrow screen), for the agent open: **Changes** (its patches in S3, the submitted one or a checkpoint's: the
  files collapsed, each file's part of the patch read only when opened, unified or side by side, long unchanged runs
  folded, renames, binary files and a missing final newline shown; links to the change and the pull request on GitHub
  or GitLab, for a change too large to read here, offered only on the host's own domain under the run's repository),
  **Files** (a tree of the files its tool calls read, listed or wrote), **Gate** (its gate record's verdict and findings,
  and each deterministic check with its exit code, time and output tail; an agent that ran none offers the run's gate
  agents), **Cost** (its cost, model, skill and commit, and its session as the supervisor keeps it: step, MicroVM,
  heartbeat, last progress, start, MicroVM time and tokens per model; beside every agent's cost) and **Memory and
  Learn** (the lessons its brief recalled, and what Learn made of its task); and the run's own **Assertions** (by step:
  pass, fail, pending or unread, blocking or warning), **Board** (with a person's actions on its tasks) and **Reports**
  (each version's Markdown).
- **Restart run** (an ended, stopped, spent or 30-day run): a new **child** run of it (`POST …/restart`), resuming
  each agent from its newest checkpoint or restarting their tasks afresh, for the agents ticked (none: every unfinished
  task), on the run's own commit or the repository's head; the child opens once started. An answer that could not be
  read names the child to open rather than to start again.
- Below the three panes, people's reactions on the host. The run monitor's Agents and Conversation panels are gone:
  the sessions and the inspector hold what they showed.

The diff parser and renderer are the app's own (no diff library). The canvas's stage and lane model, the timeline,
the collapsed changes, the fold, the split toggle and the tabs and grid are adapted from kirodotdev/KiroCrew
(Apache-2.0, [THIRD-PARTY-LICENSES.md](../THIRD-PARTY-LICENSES.md)).

### Methodology warnings

A valid workflow can still skip the methodology (TENETS.md tenet 2): `start → write_prd → end` writes a PRD with no
personas, no PR/FAQ and no customer evidence. `POST /workflows/validate` therefore answers, next to `valid` and
`errors`, `warnings: [{code, message, node_id}]` for a valid definition (`lambda/shared/workflow_methodology.py`;
empty while the graph has errors). A step counts as upstream when a node of its kind reaches the writing node along
the arrows:

| Writing step | Code | Missing upstream |
|---|---|---|
| `write_prfaq`, `write_prd` | `no_upstream_evidence` | an `aggregate_reviews` or `deep_research` step |
| `write_prfaq`, `write_prd` | `no_upstream_personas` | a `select_personas` or `generate_personas` step |
| `write_prd` | `no_upstream_prfaq` | a `write_prfaq` step |
| `build_prototype` | `no_upstream_document` | a `write_prfaq` or `write_prd` step |

Warnings are advice, never errors: save and run are not refused, because a workflow may work on a project that
already holds those artifacts. The editor lists them above the canvas ("Methodology"), each naming its step; a
code it does not know shows the server's message. An older API answers no `warnings`: the editor shows none.

**At run time** the run journal says what each methodology step skipped (`lambda/agents/run_methodology.py`). A
research, PR/FAQ, PRD or prototype step whose route answered a `methodology` block (docs/project-workspace.md →
Methodology) journals one `message` event when it starts ("Methodology (PRD): skipped a PR/FAQ; 1 warning(s).")
carrying the block as `methodology: {step, skipped, warnings, evidence}`; its `node_finished` event carries the
finished job's final block (with the evidence count). `GET /agents/{id}/runs/{run_id}/events` answers the field
(bounded: at most 10 skipped steps and warnings, messages ≤ 300 characters). The run's technical log lists an
event's gaps under it ("Methodology gaps"). Persona generation answers no block, so it journals none.

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

Project rules: the agent may create a project, reuse one **it created itself** (the Projects API records
`created_by_agent` on create; no update can set it), matched on `description` + the agent-kept `purpose`, and
duplicate documents into another project — never merge, move or delete. A project the agent did not create (its
owner's own, or a private one it was shared into) is never offered for reuse, however similar its name: the run
creates a new project instead. An agent run never removes
personas: it sends `keep_existing_personas: true` to `POST /projects/{id}/personas/generate`, so new personas are
added beside the existing ones (and any edit a person made to them is kept; [persona generation](persona-generation.md)). Handoff owner = the first
owner of the dominant category (other owners as editors); none → the admin flagged **fallback owner**.

## What the steps read and send

- **Review window.** Every step reads the reviews of the last 30 days (`DEFAULT_REVIEW_DAYS`,
  `agents/nodes/base.py`) unless its `days` param says otherwise, the aggregate step included. The aggregate step reads
  `GET /feedback` page by page (100 per page, up to 20 pages per scoped category) until the route's `total`, and
  `review_count` counts them all; at most 60 of them reach the analysis prompt. The aggregate also keeps `quotes`:
  up to two short quotes (220 characters, cut on a whole word) from the reviews each problem cites.
- **Personas.** `generate_personas` creates portraits like the product does: on unless the step's
  `generate_avatars` param is `false` (the editor's "Create a portrait for each persona"); a deployment with
  `AVATARS_ENABLED=false` (EU) skips them in the persona generator. `max_new` (the editor's "Maximum new personas")
  sets the count.
- **PR/FAQ and PRD.** The writing steps send `feature_idea` (the aggregated problems, plain text, stored with the
  document), `writer_context` (the `<reviews>`, `<memory>` and `<conductor_message>` DATA blocks, prompt only;
  `<reviews>` opens with the scope's review count and window, "108 customer reviews in scope from the last 30 days",
  then the problems with their counts and the quotes; each block has its own budget — 5,000, 4,000 and 6,000
  characters — inside the 16,000 total, so a revision's brief is never cut off),
  `writer_instructions` (the agent's and the step's instructions, which reach every writing step of the chain) and,
  when set, `length_budget_words`: the step's `max_words` param (200–8,000, the editor's "Length budget"), or 1,200
  when the instructions ask for short documents ("short", "brief", "concise" and their equivalents in the nine
  languages). The budget is split over the steps that write the document (`shared/document_writer_brief.py`) and
  overrides the templates' own length guidance. The writer context reaches the first (analysis) step AND every step
  that writes the document (press release, both FAQs, the PRD document), so each section is grounded in the same
  reviews. The PR/FAQ
  templates ask for the document's own neutral voice (never "I") and for the evidence's counts and quotes, naming a
  figure the evidence lacks as one to measure. The PR/FAQ heading is the document title, never the feature idea.
  The document generator also strips any
  DATA block from what it stores, whatever echoed it.
- **Research title.** "Research: <run title>", the run title cut at 80 characters on a whole word with "…"
  (`shared/text_clip.py`), then the creation stamp.
- **What it produced.** Only writing steps announce an `artifact`; a review claims the document it read (to be
  verified) without announcing it. The Runs tab lists each document once, by its title and version ("PR/FAQ ready:
  Refunds take weeks (v2)", linked to the document) and its project by name: the run view reads its projects with
  one `GET /projects?ids=…` (`pages/Agents/useRunProjects.ts`), so a project the run created after the project list
  was cached is still named.
- **Status on the list.** The agent row's `last_run_status` follows the run from `queued` to `running` when the
  run starts (conditional on it still being the agent's last run), and the agents list polls every 15 s while a
  card shows a live run.

## Identity

Node executors call the existing Projects and Memory APIs with synthetic API Gateway events as the principal
`agent:{agent_id}`, acting as the agent's owner (claim `voc:acting_subject`), never admin, capped at editor — the
same delegation model as MCP tokens. So every project permission check stays in the Projects API, and the agent
runtime roles hold **no projects-table grant at all**.

A PR/FAQ or PRD step (`write_prfaq`, `write_prd`, `revise_document`) is autonomous AI writing: the Projects API
refuses it unless the agent's owner, and the project's owner when that is someone else, work **AI-driven**
([ways-of-working.md](ways-of-working.md)). The step then fails with a plain sentence saying so.

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

- The review analysis (`aggregate_reviews`) and the final review ask the model once more when an answer holds no readable JSON object (`NodeContext.ask_json` in `agents/nodes/base.py`): one more call from the run's budget, with a note to return only the JSON object. The retry logs the answer's length, never its text. Only a second unreadable answer fails the step.
- A failed step reads as a plain sentence (`agents/failure_reason.py`). For example: "The review analysis came back in an unexpected format, so the run stopped. It is safe to run it again." The technical reason (`the review analysis was not valid JSON`, an HTTP refusal, a verification mismatch) is kept in the event's `detail`, masked like the summary. `GET /agents/{id}/runs/{run_id}/events` returns it. The run summary reads `<step> failed. <plain reason>.`
- Projects are named by their name, never by their id ("Created the project "Faster checkout" for Billing"). The name is read once per run and cached in the run context (`project_names`, `agents/event_text.py`). A name that cannot be read shows as "the project".
- Categories and sources use their labels (`shared/display_labels.py`). Documents are spelled PR/FAQ, PRD, prototype and research report.
- The review analysis prompt gives each review as `Label [id]`. The model answers with ids, and the problem keeps the configured label (`category_label`) for later steps.
- A handoff writes `Agent "<name>" run of <day>: …` into the project purpose, never the run id.

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
  {username}: {note or 'no further action'}." Its pause reason (`error`) is removed — a completed run carries no
  error, and the run view answers `error: null` for one closed by an older release, while the journal keeps the pause.
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

## Storage — `voc-agents` (Core stack, on-demand, KMS, PITR, kept on stack deletion unless `-c protectData=false`)

| pk | sk | Row |
|---|---|---|
| `AGENT#{agent_id}` | `META` | agent (`gsi1pk=AGENTS`, `gsi1sk={name}`) |
| `WORKFLOW#{workflow_id}` | `REV#{revision:06d}` / `CURRENT` | definition revision / current pointer (`gsi1pk=WORKFLOWS`) |
| `AGENT#{agent_id}` | `RUN#{run_id}` | run (`gsi1pk=RUNS_ACTIVE` while running) |
| `RUN#{run_id}` | `EVT#{seq:08d}` | run event (the Runs tab journal): `summary` for people, `detail` (failed steps only) for the technical log |
| `RUN#{run_id}` | `MATE#{role}#{seq:06d}` | crewmate transcript |
| `PLAN#{plan_id}` | `META` / `STEP#{step_id}` / `EVT#{seq:08d}` | approved assistant plan, its steps, its journal (`gsi1pk=PLANS#{approver_sub}`) — see "Plans" |
| `PLANCAP#{approver_sub}` | `META` | `active`: the approver's plans holding one of the 3 active-plan slots — see "Plans" |
| `AGENTSEED` | `META` | the default-agent marker (`state`, `agent_id`) — see "Default agents" |
| `AGENTSEED#bug-fixer`, `AGENTSEED#feature-builder` | `META` | the engineering agents' markers (7.47.00, the same shape) |
| `ISSUE_RUN#default` | `<owner/name>#<n>` (lower case), `<owner/name>#<n>#triage` (7.50.00) | one GitHub issue's run of each stage, ever (7.47.00; the triage stage's beside the act one, 7.50.00): `agent_id`, `agent_run_id`, `engineering_run_id`, `feedback_id`, `claimed_at`, `stage`; create-only, written in the run's start transaction — see "Triggers and budgets" |
| `ISSUE_TRIAGE#default` | `<owner/name>#<n>` (lower case) | an issue's trusted triage (7.50.00): `kind`, `severity`, `priority`, `triage` (the `voc-triage/1` record as JSON), `run_id`, `task_id`, `agent_id`, `written_at`, `written_by`; create-only, written by voc-engineering-runtime alone at a triage run's end (every other voc-agents writer is denied it) — see "Triggers and budgets" |

Index: `gsi1-by-agents-listing`. Agents are archived, never deleted. The table (`createEncryptedTable` in
`core-stack.ts`) is encrypted with the stack's customer-managed KMS key, has point-in-time recovery and is
kept while the platform runs (no TTL), kept on stack deletion by default (`protectData`) and deleted with the stack only
under `-c protectData=false` (pinned by `lib/stacks/memory-agents-stack.test.ts`; back up first, [Deployment → Teardown](deployment.md#teardown-with--c-protectdatafalse-back-up-first)); plan rows inherit that.

## Plans — approved assistant plans on the same runtime

An approved AI-assistant plan (`voc-plan/1`, [docs/assistant-plan-mode.md](assistant-plan-mode.md)) runs on
`voc-agent-run` too. The execution input `{run_kind: 'plan', plan_id}` (execution name = plan id) takes the
`Start` choice to the plan branch; agent runs keep `{agent_id, run_id}` and `Init`. Before `Start`, the `RunScope`
choice sets `$.run_scope` (`{}` for every run and plan today, whose input names no `workspace_id`), which every Lambda
payload passes on beside its ids (7.29.00, [docs/multi-workspace.md](multi-workspace.md#the-project-plan-phase-3));
the agent rows stay the deployment's, so the conductor and the steps refuse a state that names a workspace, but for
the two failure states, which still mark the run's or the plan's own row failed when it is of the run's scope. A plan
approved in a workspace waits on its source and scraper runs in that workspace (its META's `workspace_id`); approving
it needs membership there, and the approver's membership is re-checked before every step and wait.

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
| `voc-agent-heartbeat` | Processing | EventBridge `rate(15 minutes)` | agents Get/Put/Update/Query (the hard cap's and the connections' partitions write-denied); feedback Query; aggregates Get/Query; StartExecution; with `-c engineeringAgents=true` (7.47.00, `lib/stacks/agent-heartbeat-engineering.ts`): invoke `voc-engineering-start` by unqualified name, voc-engineering GetItem on `WS#*#RUN#*` only, Cognito AdminGetUser + AdminListGroupsForUser on the user pool (the owner's re-check) |
| `voc-agent-conductor` | Processing | voc-agent-run tasks | agents Get/Put/Update/Query; feedback Get/BatchGet/Query; aggregates Get/Query; jobs GetItem (plan waits); Cognito AdminGetUser + AdminListGroupsForUser on the user pool (plan approver re-check); raw `prototypes/*` read; SendMessage memory-extract; invoke `voc-projects-api` + `voc-memory-api` by unqualified name; Bedrock allowlist |
| `voc-agent-persona-panel` | Processing | voc-agent-run Map | agents Get/Put/Update/Query; aggregates Get; raw `prototypes/*` read; invoke `voc-projects-api`; Bedrock allowlist |
| `voc-plan-step` (Node.js, `lambda/stream/src/plan-step/handler.ts`) | Processing | voc-agent-run plan Map (invoked by the state machine, never by the conductor) | aggregates GetItem + Query; feedback read (think steps' `search_feedback`); KMS decrypt; Bedrock allowlist (InvokeModel + stream); invoke by unqualified name exactly the projects, metrics, feedback-form, settings, scrapers, memory, agents, integrations and feedback-edit API Lambdas (`PLAN_STEP_DELEGATES`; never the users API — user writes are card-only and think steps never get the directory); no table writes |

The Projects and Memory API names come from `lib/utils/function-names.ts`, which both stacks use: Processing deploys
before Api, so a construct reference would be a cycle. `voc-plan-step`'s delegate names come from the same file.

## Prototype tester pins

When a run builds a prototype, testers can drop pins on it and leave threaded comments through the prototype's pin
form ([feedback-forms.md → Prototype pin forms](feedback-forms.md#prototype-pin-forms-form_type-prototype_pin)). Two
workflow steps use them:

- **`collect_prototype_feedback`** reads the open pins on the run's prototype through the Projects API, as the
  agent (`agents/pins.py`). Pins the injection screen flagged are left out for a person and counted. Nothing is
  written to the project; the pins reach the next revision only through the run context. When the pins cannot be
  read, the revision continues from the review alone.
- **`revise_prototype`** builds a new revision with the pins as DATA and marks the pins it addressed as
  `addressed`. The conductor resolves addressed pins only after a later review passes (the persona panel agreed on
  the prototype, or the final review passed). Until then a person sees them as addressed, not resolved.
