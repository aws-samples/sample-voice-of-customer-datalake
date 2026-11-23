# The leadership view (7.70.00)

**Insights → Leadership** shows, on one page, how the teams use the method: projects started and how far they got
(ideas taken to prototype), validations and validated decisions, decisions by verdict, median cycle times, the
artifacts made with AI or by hand, assistant and agent use, and an **estimate** of the time saved, with its
assumptions beside it. By month or by quarter, over the last 6, 12 or 24 months or this year.

It holds **counts only**. There is no per-person view and no leaderboard (owner decision): no route, CSV column, MCP
answer or page element names a person, ranks people or counts one person's work.

## Who sees it

| Scope | Who reads the view | Who sets the baselines |
|---|---|---|
| A workspace (`X-Workspace-Id`) | its admins: a member admin, or a platform admin who entered (audited) | its admins, acting for themselves |
| The deployment (no header) | the deployment's `admins`, and platform admins (live-checked in Cognito) | the deployment's `admins`, acting for themselves |

The sidebar shows the entry to those people only (a hint: the server decides). In a workspace the deployment's
`admins` group grants nothing, as everywhere ([multi-workspace.md](multi-workspace.md), Roles). A platform admin
outside a workspace is pointed to the platform's model cost estimate per workspace, `GET /platform/costs`
([multi-workspace.md](multi-workspace.md), "Cost per workspace"); the view itself has no cost figure.

## What is counted

Everything comes from the scope's **live projects** (a deleted project counts nothing), by calendar month in UTC.

| Figure | Definition |
|---|---|
| Projects started | projects created in the period |
| With personas, research, PR/FAQ, PRD, prototype, validation | of the projects started in the period, those that have reached the step **today** (a cohort: a project started in March that reached its prototype in May counts in March's "with prototype") |
| Ideas taken to prototype | with prototype ÷ projects started |
| Validations run | validation reports written in the period (7.68.00's `validation_report` documents); synthetic runs (`validation_run`, `synthetic: true`) are counted apart and never count as met |
| Decisions by verdict | decision records (`pursue`, `park`, `reject`) by the day they were decided |
| Validated decisions | decisions that cite, among their evidence document ids, a validation report of the same project with at least one success criterion **met by real results** |
| Cycle times | the median, in whole days, from a project's evidence (its first personas or research, else its start) to its first PRD; from the first PRD to the first prototype; from the first prototype to the first decision after it. Each counts in the period its step ended; a step out of order is left out. Medians merge exactly across months and quarters |
| Artifacts by way of working | personas, research, PR/FAQs, PRDs and prototypes made in the period, **with AI** (generated, revised by the AI, built by the prototype builder) or **by hand** (written from a blank template, imported personas). An edit or a restore that made a new version of a PR/FAQ, PRD or prototype, and a copied persona, are no new artifact; a persona or research document edited or restored in place is still counted once |
| Assistant conversations | assistant conversations last active in the period |
| Agent runs | autonomous agent runs started in the period: the agents are the deployment's, so a workspace's view counts none (it says so) |

"With AI" counts AI-assisted and AI-driven together: a document does not record which of the two ways its requester
worked in, so the view cannot split them.

## Time saved: an estimate

Time saved = for each artifact type, the artifacts **made with AI** in the period × the type's **baseline**: the hours
a person takes to make one by hand. Every answer that carries hours says it is an estimate, with the baselines and
the assumptions:

- only artifacts the AI made count; hand-written artifacts, edits and restores save nothing;
- each AI-made artifact saves its baseline, as an admin set it, else the default;
- the time people spend reviewing and editing an AI draft is not subtracted;
- decisions, validations, assistant conversations and agent runs add no hours;
- deleted projects are not counted; figures are as of the last daily rollup.

The defaults are a starting point, never a measurement: personas 1.5 h each, research 6 h, a PR/FAQ 4 h, a PRD 8 h, a
prototype 16 h. An admin of the scope replaces any of them (0 to 200 hours) and may add a note on where the numbers
come from (at most 500 characters), shown with the estimate, in **Assumptions** on the page. The hours are worked
out when the view is read, so a new baseline applies at once.

## Routes

No new API Gateway resource: both ride existing proxies.

| Method | Path | Lambda | What |
|---|---|---|---|
| GET | `/metrics/adoption?from=YYYY-MM&to=YYYY-MM&grain=month\|quarter` | metrics (`shared/adoption_metrics_routes.py`) | the view: `{scope, grain, from, to, as_of, complete, covered_from, agent_runs_counted, periods, totals, time_saved}`. A day (`YYYY-MM-DD`) reads as its month; the default is the last six months; at most 24 months; `quarter` widens the range to whole quarters, dropping its first quarter when the widened range would pass 24 months. 400 for a bad range, 403 for anyone but the scope's admins |
| GET | `/settings/adoption` | settings (`shared/adoption_routes.py`) | the baselines `{baselines: {type: {hours, saved}}, defaults, note, updated_at, max_hours, max_note_chars}` |
| PUT | `/settings/adoption` | settings | `{baselines?: {type: hours \| null}, note?}`: null puts a type back to its default. The scope's admins, never a delegated caller |

The page's **Download CSV** holds the same rows (one per period and one for the total), then the estimate's label,
its baselines, the note and the assumptions, so the hours never travel without them. UTF-8 with a BOM; every field is
guarded against spreadsheet formulas.

**MCP.** `insights_get_adoption` (`from`/`to` as `YYYY-MM`, by month) calls `GET /metrics/adoption` as the token's
minter. It is `admin_only`, like `agents_run`: offered only to a token an administrator minted (never a project-pinned
one) and checked live on every call, after which the MCP Lambda adds the claim naming `insights_get_adoption`, which
the route admits for its read alone (`project_access.delegated_op_allowed`: the one claim, `voc:mcp_op`, names one
operation, so a call cleared for `agents_run` or an engineering operation never reads the view). It reads the deployment's view: inside a workspace a credential is
never an admin, so the route refuses it ([mcp.md](mcp.md)).

## Data

Both rows are in voc-aggregates, per scope.

| Row | Key | Holds |
|---|---|---|
| The rollup (gold, rebuildable) | `ADOPTION#ROLLUP` / `latest`; `WS#{ws}#ADOPTION#ROLLUP` / `latest` in a workspace | ONE whole item per scope, overwritten by each run (no `ttl`): `months` (each month's counts and day histograms, zeros left out), `first_month`, `last_month`, `projects`, `projects_read`, `complete`, `agent_runs_counted`, `rolled_up_at`, `schema` 1. The route reads it with one GetItem |
| The baselines | `SETTINGS#adoption` / `config`; `WS#{ws}#SETTINGS#adoption` / `config` | `{baselines, note, updated_by: {sub, kind}, updated_at, reason: adoption_baselines}` (who, when, why: TENETS D4). No row: every default |

A workspace's hard delete sweeps both with its settings (`jobs/workspace_delete/sweeps.py`); the workspace export
leaves the rollup out (derived: rebuilt from the projects) and carries no settings rows yet.

## The daily rollup, voc-adoption-rollup

VocProcessingStack, `lambda/jobs/adoption_rollup/handler.py`, 512 MB, at most 15 minutes, no reserved concurrency,
no async retry. An EventBridge rule runs it at **03:05 UTC** (pay per use: no fixed cost); an operator's async invoke
does the same. Each run rebuilds the last 24 months for the deployment and every active workspace and overwrites the
scope's one item: the rebuild is idempotent. A scope whose reads AWS refuses is not written (the others are) and the
run fails after them; the next day rebuilds it. The run has one deadline (its 15 minutes less a minute for the writes):
the deployment comes first, as it is the only scope with projects until projects move into workspaces
([multi-workspace.md → Phases](multi-workspace.md#phases), phase 3), and may take all of it but the last 60 seconds,
which are kept for the workspace scopes when there are any (7.71.02): until then their reads are only counts (an empty
registry, a conversation count per month), so a deployment walk that runs long can no longer leave every workspace
cut short. A scope cut short is written with `complete: false` only where no complete item is stored; otherwise the
last complete figures stay, and the page shows their `as_of`.

**It never Scans**, reads no feedback and calls no model. Every read is a Query (`lib/stacks/adoption-rollup-worker.ts`
holds the role to them, and `adoption-rollup-worker.test.ts` pins every statement and what is refused):

- voc-workspaces: the listing partition `WORKSPACES` (an id and a status), for the active workspaces;
- voc-projects: each scope's registry of project ids (`PROJECT_IDS`, `WS#{ws}#PROJECT_IDS`), then each live project's
  partition, of these attributes only (`dynamodb:Attributes`, `dynamodb:Select` `SPECIFIC_ATTRIBUTES`): keys, type,
  id, dates, how an artifact was made (`origin`, `edit_kind`, `imported_from`, `copied_from`), `synthetic`, a
  decision's verdict, date and evidence document ids, the `META`'s validation report id, and a report's
  per-criterion outcomes. Never a document's text, a title, a name, a quote or a person;
- voc-conversations: a **count** of the assistant conversations per scope and month (`gsi1-by-kind-updated-at`,
  `dynamodb:Select` `COUNT`): the role cannot read a conversation;
- voc-agents: the agents' listing (keys) and each agent's runs' `started_at`.

It writes only `ADOPTION#ROLLUP` and `WS#{ws}#ADOPTION#ROLLUP` (PutItem, by `dynamodb:LeadingKeys`).

The deployment's registry `PROJECT_IDS` lists every project made since 7.48.00 and, once the review registries'
backfill ran (`scripts/projects/backfill_review_registries.py`), every older one; a deployment that did not run it
counts only its newer projects. Projects reach workspaces only after the projects switch (multi-workspace 3h): until
then a workspace's view counts what its own registry lists.

## The Validate phase's names (7.68.00)

The view reads 7.68.00's data as its spec defines it, tolerantly (a project without any of it counts as not
validated), and every name is in one module, `lambda/shared/adoption_validation.py`: the `META`'s `validation`
map, the document types `validation_plan`, `validation_report` and `validation_run`, `synthetic`, and a report's
per-criterion `results[].outcome` = `met`.
