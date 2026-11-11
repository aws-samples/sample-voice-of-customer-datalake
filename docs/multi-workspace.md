# Multi-workspace (design)

**Status: design, phase 1 being built.** This document describes how one deployment of the platform will serve
several separate teams or customers, each in its own **workspace**. Only what the table below lists exists in the code;
everything else is planned, and each release's CHANGELOG entry says what landed and updates the table. Routes, tables
and files named here are the planned ones unless the table lists them.

| Since | Built |
|---|---|
| 6.05.00 | The Cognito group `platform-admins`, with the bootstrapped `admin` in it (through a CloudFormation attachment, replaced in 6.06.02). Nothing reads it yet |
| 6.06.00 | The `voc-workspaces` table in `VocCoreStack` (keys below, TTL `ttl` for invites). Nothing reads or writes it yet |
| 6.06.02 | The bootstrap adds the first `admin` to `platform-admins` when it creates the user (no CloudFormation attachment); an older deployment adds one by hand (CHANGELOG 6.06.02, Upgrade notes) |

Today one deployment is one tenant ([TENETS.md](../TENETS.md), tenet 6 gap: "One deployment is one tenant"). Every
signed-in person sees the same feedback, settings, projects and agents, and the Cognito `admins` group administers
all of it. Multi-workspace keeps one deployment (one set of tables, buckets and Lambdas) and puts a workspace on
every row and object, so a team only ever sees its own data.

> **Words.** In this page a *workspace* is the tenant: a team's whole copy of the product (its feedback, settings,
> projects, personas, agents, Radar, boards, memory). The existing docs also say "workspace" for the shared content
> of a deployment (for example "workspace deletes" in TENETS.md D5, or the Prioritization "workspace scoring setup").
> With this design, all of that content belongs to exactly one workspace.

## Decisions

| # | Topic | Decision |
|---|---|---|
| 1 | Isolation | Soft isolation: enforced in code, not by per-workspace IAM roles |
| 2 | Platform admin | A top-level role. Sees every workspace and can enter one with full admin rights; every entry is audited |
| 3 | Membership | One Cognito user, many workspaces, a different role in each |
| 4 | Invites | Only workspace admins and platform admins invite. An invitee may already have an account |
| 5 | Creating workspaces | Only platform admins |
| 6 | Configuration | Everything per workspace: brand config, categories, dimensions, sources, models, plugins, menu, Radar |
| 7 | Branding | One logo and colour scheme for the whole deployment; no per-workspace chrome |
| 8 | Credentials | One Secrets Manager secret per workspace, encrypted with the customer-managed KMS key |
| 9 | Cost | Cost reported per workspace |
| 10 | Quotas | None for now; workspaces share Bedrock capacity (a busy workspace can slow the others) |
| 11 | Delete | Hard delete of a whole workspace, after offering an export (how it meets D5 is an [open tenet question](#open-tenet-questions-to-settle-before-the-phase-that-builds-them)) |
| 12 | Existing deployments | Not migrated: multi-workspace starts on a fresh deployment |
| 13 | Radar | Per workspace |
| 14 | Sharing (later) | Workspaces stay separate. Workspace B imports from A through a plugin that A approved |
| 15 | URL | `/w/{slug}/…`; the slug is fixed when the workspace is created |

## Model

The pool model: one deployment, and every row and object carries its workspace.

- **Workspace id**: `ws_<ulid>`, plus a unique, immutable `slug` for URLs.
- **DynamoDB**: every partition key is prefixed `WS#{ws}#…` (for example `WS#{ws}#SOURCE#webscraper`), and so is
  every GSI partition key (`WS#{ws}#DATE#2026-01-15`). No GSI is ever queried without the prefix.
- **S3**: `ws/{ws}/raw/{source}/{yyyy}/{mm}/{dd}/…`, `ws/{ws}/avatars/…`, `ws/{ws}/exports/…`, and so on for every
  prefix described in [Data Lake Structure](data-lake-structure.md). The raw tier keeps its contract (write-once,
  `If-None-Match`, nothing expires) under each workspace's prefix.
- **KMS**: the one customer-managed key stays (tenet 7); where the platform encrypts data itself it passes
  `workspace_id` as encryption context.

### Control plane

The `voc-workspaces` table lives in `VocCoreStack` and the Lambdas for workspaces, members and the platform console
in `VocApiStack`: the sample keeps to five stacks ([Deployment Guide](deployment.md#cdk-stacks)), so the control plane
gets no stack of its own.

| PK | SK | Holds |
|---|---|---|
| `WS#{ws}` | `META` | name, slug, status (`active` or `deleting`), created_by, created_at |
| `WS#{ws}` | `MEMBER#{sub}` | role (`admin`, `editor` or `viewer`), invited_by, joined_at |
| `USER#{sub}` | `WS#{ws}` | the inverse row behind "my workspaces", written in the same transaction as `MEMBER#` |
| `WS#{ws}` | `INVITE#{id}` | email, role, invited_by, expires_at, and `ttl` (the table's TTL attribute) |
| `SLUG#{slug}` | `META` | slug → workspace id; uniqueness by a conditional put |
| `WS#{ws}` | `AUDIT#{iso}#{n}` | membership changes, platform-admin entries, export and delete, share grants |

- **Platform admins** are the Cognito group `platform-admins`, bootstrapped at deploy time the way the first admin
  user is today ([README](../README.md#-initial-login)). Only they create workspaces and see the platform console
  (every workspace, its members and its cost).
- Platform-admin membership is managed on its own, before anything reads the group. Today's users API changes only
  `admins`/`users` and counts only `admins` for its last-admin guard, so a demoted user would stay a platform admin
  and an admin could disable or delete the only one. The phase that first reads the group therefore adds:
  - a platform-admin route to grant and revoke the membership (platform admins only, audited, in the route-gate
    inventory), shown in the platform console;
  - in the users API: demoting a user also revokes it; disabling, enabling, deleting or resetting the password of a
    platform admin is for platform admins only; and no route may leave the deployment without a platform admin.
  (Cognito drops a deleted user's group memberships itself.)
- Today's `admins` group no longer grants anything inside a workspace: a person's role in a workspace comes only from
  its `MEMBER#` row.

## Request flow

1. A person signs in (one Cognito user pool) and the web app calls `GET /me/workspaces`. With exactly one workspace
   the picker is skipped; with none, it says so and names who can invite them.
2. The web app keeps the current workspace in the URL (`/w/{slug}/…`) and sends `X-Workspace-Id` on every API call.
3. Shared middleware (a new `workspace` module in the Lambdas' shared package, and its TypeScript twin in the stream
   and plan-step Lambdas)
   resolves the caller's membership (cached in the warm container for a short time), answers **404** when the caller
   is not a member (a 404, not a 403, so ids of other workspaces are not confirmed), and puts `{ws, role}` on the
   request context. A platform admin passes as a workspace admin, and the entry writes an `AUDIT#` row that the
   workspace's own admins can see.
4. All data access goes through a workspace-scoped repository layer (`ws_table(ws)`, `ws_key(ws, …)`,
   `ws_s3_key(ws, …)`). A static test fails on any raw `Table(...)` or `put_object` call outside that layer.
5. `require_admin` becomes `require_role('admin')`: a workspace admin, or a platform admin. The route-gate inventory
   (`lambda/api/test/test_route_admin_gates.py`) gains the workspace dimension: every route is classified as
   workspace-scoped, platform-only or public, as well as admin-only or open.

Asynchronous paths carry the workspace explicitly and never infer it from the caller: SQS messages, Step Functions
inputs, Lambda async payloads, DynamoDB Stream records (the workspace comes from the key prefix), memory extraction,
agent runs, plan steps and assist jobs.

## Roles

| Role | Can |
|---|---|
| Viewer | Read the workspace's feedback, dashboards, projects and documents |
| Editor | Everything a viewer can, plus write: projects, documents, personas, agents, imports a non-admin may run today |
| Admin | Everything an editor can, plus the Administration tabs, members and invites, export and delete of the workspace |
| Platform admin | Create workspaces, see the platform console, enter any workspace as an admin (audited) |

What an editor may write follows today's split between admin-only and open routes; the route-gate inventory pins it.

## Invites

- Workspace admins and platform admins invite, with any workspace role. Editors and viewers cannot.
- An email that already has an account gets its membership row at once, and a notification email.
- A new email gets a Cognito account (`AdminCreateUser`, which sends the temporary password) and the membership row.
- Removing a workspace's last admin is refused. A person with no workspace left sees an empty picker.

## Public and non-user entry points

| Entry | Today | With workspaces |
|---|---|---|
| Feedback form `/feedback-forms/{id}/config\|submit\|iframe` | form id | a globally unique form id; a `FORM#{id}` lookup row gives the workspace |
| Voting sessions | session id | the same pattern: `VOTE#{id}` gives the workspace |
| Webhooks `/webhooks/{plugin}` | one per plugin | `/webhooks/{plugin}/{ws}`; the webhook secret lives in the workspace's secret |
| Email inbox (SES) | one set of addresses | `{slug}@<inbound domain>`, routed to the workspace by the receipt rule |
| MCP `/mcp/global` | token → user | the token row also pins one workspace (a token is minted inside a workspace) |
| Scheduled ingestion | one rule per plugin | one tick per plugin fans out over the workspaces that enabled it |

## Per-workspace configuration

- Everything stored today under `SETTINGS#…` and `METRIC#…` in `voc-aggregates` moves under `WS#{ws}#…`.
- Plugins and menu items stop being chosen at deploy time: every plugin Lambda is deployed, `cdk.context.json` becomes
  the ceiling (what this deployment offers), and each workspace's settings pick a subset of it at run time.
- The model picker is per workspace; the model allowlist stays deployment-wide.
- Brand configuration (name, products, the tone the AI uses) is per workspace; the logo and colours stay global.

## Credentials

- One Secrets Manager secret per workspace, `voc/ws/{ws}/credentials`, encrypted with the customer-managed key. It
  holds every plugin credential, scraper API credential and webhook secret of that workspace.
- The create-workspace flow creates it (not CDK); the workspace delete job deletes it, with no recovery window.
- IAM: the plugin and integrations roles get `secretsmanager:GetSecretValue` and `PutSecretValue` on `voc/ws/*`. The
  code always builds the name from the request's verified workspace, never from user input, and a test pins that.
- **Cost**: about $0.40 per workspace per month. This is the one fixed cost the design adds, accepted by decision 8
  as the price of per-workspace credential isolation. The fixed-cost guard
  (`voc-datalake/lib/fixed-cost-guard.test.ts`) counts only CDK-created secrets today; the phase that creates these
  extends it to count one per workspace, and the cost is reported per workspace (below).

## Cost per workspace

- Every Bedrock call logs `workspace_id`, the model and its input and output tokens (`shared/converse.py` and the
  stream Lambda's model client already centralise those calls). A daily rollup writes `WS#{ws}#COST` rows by date,
  and the platform console shows cost per workspace per day and month (tokens × list price, labelled an estimate).
- Also counted: reviews ingested, scraper and browser sessions, Comprehend and Translate characters, the secret.

## Export and delete

The proposal below waits on the first [open tenet question](#open-tenet-questions-to-settle-before-the-phase-that-builds-them)
(D5): its legal basis, and the tombstones it would leave.

1. A workspace admin or a platform admin asks to delete the workspace; the web app offers **Export first** (on by
   default).
2. The export job writes JSONL per entity (feedback, projects and documents, personas, memory, agents and workflows,
   conversations, settings) plus the raw objects into one zip under `ws/{ws}/exports/`, with a presigned link
   (7 days) emailed to the requester. Export objects expire by object tag.
3. The admin confirms by typing the slug. The workspace's status becomes `deleting`: every request is refused and its
   schedules stop.
4. The delete job (self re-invoking and checkpointed, like `voc-retention`) deletes every `WS#{ws}#` partition of
   every table, every `ws/{ws}/` object with all its versions, the workspace secret, its MCP tokens, memberships, slug
   and the share grants it gave or used. Whether copies other workspaces already imported stay theirs is the second
   open question. One audit row stays in a platform partition (name, who, when, counts), with no customer data.
5. With `protectData` the tables stay protected; this is item-level deletion, so it still works.

## Open tenet questions (to settle before the phase that builds them)

D5 (customer data is never removed but for a legal obligation) is non-negotiable and ranks with tenet 1, so neither
point below can be settled in this document; each needs the owner's decision and, where it changes a tenet, a change
to TENETS.md of its own:

- **Workspace delete (phase 4).** A workspace leaving is not, as such, one of D5's legal bases. The proposal to
  decide: treat the delete as the data controller's own request under its agreement with the deployment (a retention
  limit the deployment is bound to), with its stated basis, an approval (the slug typed), an audit row, a tombstone
  per deleted item like `voc-retention`'s, and the export offered first.
- **Imports and erasure (phase 5).** As planned, A's erasures would not reach B's imported copies, while D5 says an
  erasure reaches every derived copy. `imported_from` gives the lineage to follow them; the decision is whether an
  erasure in A also reaches B's copies.

Also held to the tenets when built: the per-workspace secret is a fixed cost per workspace (decision 8 accepts it;
tenet 7's gap names a move of secrets to SSM Parameter Store), so its phase extends the fixed-cost guard to count it
per workspace; and `voc-workspaces` holds primary data (members, audit) beside invites, so the phase that writes it
pins that only `INVITE#` rows carry `ttl` and protects the audit rows. The `AUDIT#` row guard
(`voc-datalake/lib/utils/audit-row-guard.ts`) matches partition keys, and these rows are keyed `WS#{ws}` /
`AUDIT#…`, so that phase either gives them an `AUDIT#`-prefixed partition key or adds a sort-key guard.

## Phases

1. **Control plane**: the `voc-workspaces` table, the `platform-admins` group, `/me/workspaces`, the picker, `/w/{slug}`
   routing, the workspace middleware and repository layer, invites, the platform console (list and create
   workspaces, enter one, members), per-workspace secret creation.
2. **Data path**: ingestion → S3 → SQS → processor → feedback → aggregator → metrics and feedback read APIs, all keyed
   by workspace; the scheduled tick's fan-out; per-workspace credentials; the public routes (forms, webhooks, email,
   voting).
3. **Everything else**: settings, categories, dimensions, sources, Radar, projects and their Step Functions, the
   assistant and its stream Lambda, memory, agents, workflows and plans, MCP tokens, the read-caching version
   counters ([Read Caching](caching.md)) per workspace, logs and alerts.
4. **Lifecycle and cost**: export, delete, cost metering and the platform cost page.
5. **Later: the workspace import plugin** (below).

Guards added in phase 1 and kept green from then on: the raw-access static test, a cross-workspace test suite (a
member of workspace A gets 404 on every id of workspace B, route by route), and an end-to-end check with two
workspaces against the local mock.

## Workspace import plugin (later)

Workspaces stay fully separate; sharing is an import, like any other source.

- **Approval**: A's admin approves B for one of A's sources (`WS#{A}` / `SHARE#{source}#{B}`, audited). B's admin then
  adds a `workspace_import` connector pointing at it.
- **Modes**, per connector: `raw` copies A's raw objects into B's raw prefix and runs them through B's own pipeline
  (B's categories, models and settings; B pays the enrichment); `categorised` copies A's processed items as they are
  into B's partition, and nothing is re-run.
- **Fetch**: a pull with a watermark per connector over A's date index for that source, plus a backfill window on the
  first run. This plugin is the one sanctioned reader of another workspace's data, through a dedicated repository
  call that re-checks the approval on every run.
- **After the copy the data is B's**: stored as B's own items (`source = ws_<A-slug>_<source>`,
  `imported_from: {ws, source, id}`) and raw objects. Revoking the approval only stops future imports. As planned,
  A's erasures, retention deletes and workspace deletion would not reach B's copies (each workspace the data
  controller of what it imported, said in the approval dialog A's admin sees); that waits on the second
  [open tenet question](#open-tenet-questions-to-settle-before-the-phase-that-builds-them), since D5 says an erasure
  reaches every derived copy. Copied items are read-only in B (no category or dimension edits); B can delete them and
  disconnect the connector.
