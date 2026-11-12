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
| 6.07.00 | The workspace middleware `lambda/shared/workspace.py`: the `X-Workspace-Id` header (missing 400; malformed, unknown, `deleting` or not a member: one 404), the role from the `MEMBER#` row, a platform admin who is not a member admin entering as admin (decision 2) with an audit row `AUDIT#WS#{ws}` / `{iso}#{random}` (once per fill of the 30 s warm-container cache), `ws_key` and "my workspaces". The workspaces API `voc-workspaces-api` (`lambda/api/workspaces_handler.py`, `GET /me/{proxy+}`): `GET /me/workspaces` and `GET /me/workspaces/current`, with Query and GetItem on `voc-workspaces` and PutItem only where the partition key matches `AUDIT#WS#*`. The audit-row guard (`voc-datalake/lib/utils/audit-row-guard.ts`) covers `voc-workspaces`, with this role as its audit writer: no role can change or remove an entry row. Nothing creates workspaces or members yet, so every list is empty; the web app does not call these routes yet, and `X-Workspace-Id` is not yet in the CORS preflight. This is the first reader of `platform-admins`: the platform-admin safeguards below (Control plane) land before anything can create a workspace |
| 6.08.00 | Platform-admin membership in the users API (`lambda/api/users_handler.py`, rules in `lambda/shared/user_admin_guard.py`). `PUT /users/{username}/platform-admin` with `{"platform_admin": true\|false}`: platform admins only (403 for everyone else, plain `admins` included; in the route-gate inventory as admin-only and platform-admin-only), a grant only to a member of `admins` (400 otherwise), a revoke refused (409) when it would leave no enabled platform admin, the caller's own included; asking for what already holds changes and records nothing. Demoting a user to `users` also removes them from `platform-admins`. Demoting, disabling, enabling, deleting or resetting the password of a platform admin answers 403 unless the caller is one too (the caller's membership is checked live in Cognito, not only in the token, with an enabled account, so a revoke or a disable takes effect in the users API at once; entering a workspace still reads the token, and the change that creates workspaces adds the live check there); demoting, disabling or deleting the last enabled one answers 409 (the last-`admins` guard is unchanged). Every grant and revoke (the route, a demotion, a delete) writes an `AUDIT#platform-admins` / `{iso}#{random}` row in `voc-aggregates` (kind, via, the target's and the actor's sub, the time) before the change, so it records the attempt (a change that then fails leaves the row; the group's live state is Cognito's): a row that cannot be written refuses the change; the audit-row guard names the users API's role that partition's only writer. `GET /users` reports `platform_admin` per user. The web app does not call the new route yet (the platform console will). Like the last-admin check, these checks read before they write |
| 6.09.00 | Creating and listing workspaces, for platform admins only, in the workspaces API under `/platform/{proxy+}` (GET and POST, Cognito; logic in `lambda/shared/platform_workspaces.py`). Each route calls `require_admin` and `require_platform_admin`, then the live check, now shared by the users API and the workspaces API (`lambda/shared/platform_admin.py`: the token's group, the live Cognito membership and an enabled account; 403 otherwise). `POST /platform/workspaces` with `{name, slug}` (name 1 to 80 characters, trimmed; slug 3 to 40 of `a-z`, `0-9` and `-`, not starting or ending with `-`, not `admin`, `api`, `app`, `platform` or `www`; 400 otherwise) writes, in ONE transaction of conditional puts, `SLUG#{slug}` / `META` (409 when the slug is taken, nothing written), `WS#{ws}` / `META`, the creator's `MEMBER#` row (role `admin`), their `USER#` row, a `WORKSPACES` listing row and an `AUDIT#WS#{ws}` row (kind `workspace_created`); the id is `ws_` plus a new ULID. It answers 201 `{workspace: {id, name, slug, role: 'admin', secret_status}}`. The transaction's idempotency token covers the SDK's own retries; a client that retries after a lost answer gets 409 for the slug its first attempt took, and `GET /platform/workspaces` shows whether that workspace was made. Then it creates the workspace's credentials secret (Credentials, below); `secret_status` is `ready`, or `pending` when the secret could not be made (logged; the workspace stays). `GET /platform/workspaces` lists every workspace `{workspaces: [{id, name, slug, status, created_at, secret_status}], next_cursor}` by name (`?limit=` 1 to 100, default 25, `?cursor=`), one Query of the `WORKSPACES` partition. Entering a workspace as a platform admin (`GET /me/workspaces/current`, `lambda/shared/workspace.py`) now needs the live check too, on each fill of the 30 s cache that would elevate: a failed one enters with the member's own role, or answers the 404 for a non-member. The role's PutItem reaches `AUDIT#WS#*`, `SLUG#*`, `USER#*`, `WORKSPACES` and `WS#*`, its UpdateItem `WS#*` and `WORKSPACES` only (`secret_status` on `META` and the listing row, in one transaction); it reads the caller's groups and account in Cognito, and creates, describes and tags secrets under `voc/ws/*` only. The web app does not call the `/platform` routes yet (the platform console will); nothing adds members or invites yet |
| 6.10.00 | A workspace's members, in the workspaces API under `/me/workspaces/current/members` (GET, POST, PUT and DELETE on the existing `/me/{proxy+}`; logic in `lambda/shared/workspace_members.py`), each acting in the workspace `X-Workspace-Id` names as `resolve_workspace` decides (400 without the header, the one 404 for a non-member, the deployment's `admins` group included; a platform admin enters as admin, live-checked and audited). `GET` lists the members `{members: [{sub, role, email, name, invited_by, joined_at}], next_cursor}` for any member, by sub (`?limit=` 1 to 100, default 25, `?cursor=`; one Query of the `MEMBER#` rows; email and name are the row's, and for up to 5 rows a page that hold none, such as the creator's, Cognito's by sub). `POST {email, role}` (admin, editor or viewer): workspace admins only (`require_workspace_admin`: 403 for an editor or a viewer); an email with a Cognito account is a member at once, a new email first gets an account (`AdminCreateUser`, the temporary password emailed, as the users API does) when the caller is in the deployment's `admins` group (platform admins are; 403 for any other workspace admin: until the data path is keyed by workspace, phase 2, every account reads the whole deployment, so creating one stays with the users API's administrators), then 201 `{member: {sub, role, email, name, invited_by, joined_at, account: 'existing'\|'created'}}`; 409 for a member already there, for two accounts sharing the email, or for an email Cognito holds for another account. An existing account gets no notification email: the deployment has no mail path for account notices, so the add is logged. No `INVITE#` row is written: membership is immediate either way, so there is nothing to accept. `PUT /{sub}` `{role}`: workspace admins only (asking for the role a member has changes and records nothing). `DELETE /{sub}`: workspace admins, or the member themselves (leave). Demoting or removing the last member admin, the caller included, is refused (409). Each add, role change and removal writes an `AUDIT#WS#{ws}` / `{iso}#{random}` row (kind `member_added`, `member_role_changed`, `member_removed` or `member_left`; actor, target sub, role before and after, `platform_admin`, and on an add `account`) before the change, so it records the attempt (a row that cannot be written refuses the change); then ONE transaction changes the `MEMBER#` row and the `USER#` row together (an add: two conditional puts and a check that `META` is still `active`; a role change: two updates, each only of `role` and only on existing rows; a removal: two deletes), and a demotion or removal of an admin also checks that another member is still an admin, so two admins demoting each other at once cannot both succeed. Each write resolves the caller's role from the table, not the 30 s cache, so an admin demoted or removed a moment ago cannot undo it; the change drops the member's cached membership in the container that made it, and other warm containers serve the old role to reads for up to 30 s. The role's new grants: UpdateItem on `WS#*` and `USER#*` with the attribute `role` only; DeleteItem on `WS#*` and `USER#*` (`dynamodb:LeadingKeys`; IAM cannot pin a sort key, so `META` in `WS#*` is in reach of IAM and kept out by the code, while `SLUG#`, `WORKSPACES` and `AUDIT#` are not); ConditionCheckItem on `WS#*`; Cognito `ListUsers` and `AdminCreateUser` on the user pool (IAM cannot limit ListUsers to an email filter; the code sends only an email or a sub). The web app does not call these routes yet |
| 6.11.00 | A user's delete and an erasure by email reach the memberships. `DELETE /users/{username}` (the users API) removes every membership of the user BEFORE `AdminDeleteUser` (`plan_user_removal` and `remove_user_memberships` in `lambda/shared/workspace_members.py`): it reads their `USER#{sub}` rows, and per workspace the `MEMBER#` role and, for an admin, another admin; the last member admin of a workspace is refused (409, naming the workspace: make another member an admin there first) unless the caller is a platform admin (live-checked), in which case the workspace keeps no member admin until a platform admin enters it and names one (Invites). Every refusal comes before any write; then, per workspace, an `AUDIT#WS#{ws}` row (kind `member_removed`, `via: user_deleted`, actor, target, role before, `platform_admin`, `left_without_admin`) and ONE transaction deleting the `MEMBER#` and `USER#` rows (the `MEMBER#` delete conditional on the role read; for an admin a check that the other admin still is one: 409 when either changed meanwhile); only then the Cognito account. The users API's role gains, on `voc-workspaces`: Query on `USER#*` and `WS#*`, GetItem on `WS#*` and `AUDIT#WS#*` (an audit row read back after a retried put), ConditionCheckItem on `WS#*`, PutItem on `AUDIT#WS#*` and DeleteItem on `USER#*` and `WS#*` (`dynamodb:LeadingKeys`; the code deletes `MEMBER#` and `USER#` keys only); the audit-row guard names it a writer of `AUDIT#WS#*` there and of no other audit partition. An erasure by email without a source (`voc-retention`, docs/source-policies.md) removes the `email` and `name` of every `MEMBER#` row that holds the email, in any case, and keeps the row; each row first gets a tombstone `AUDIT#tombstone#workspace_members` / `{ws}#{sub}#{job}` (the workspace, the run, the legal basis; never the email), counted as `member_rows_deidentified`. It finds the rows with a paged Scan of `voc-workspaces` (no email index; Invites says why and how it is bounded); `voc-retention` gains Scan and UpdateItem pinned to `WS#*` and the attributes `email` and `name` there |
| Unreleased | The cross-workspace suite (`lambda/api/test/test_cross_workspace_routes.py`, Phases below). Workspace-scoped today: `GET /me/workspaces/current`, the four members routes and the two plugin routes; every other route is by design or pending (phase 2 or 3) |
| Unreleased | The scope of every settings row, per workspace or for the deployment, held to the code (`lambda/shared/test/test_settings_scopes.py`, Per-workspace configuration below). No key has moved yet |
| Unreleased | The assistant's reads carry the caller's `X-Workspace-Id` to the domain Lambdas (Request flow below); no domain route reads it yet but the workspaces API's |
| Unreleased | A workspace's plugins: `GET` and `PUT /me/workspaces/current/plugins[/{plugin_id}]` in the workspaces API, the `PLUGIN#{plugin_id}` / `WS#{ws}` rows the ingestors' fan-out reads, within the deployment's ceiling (Per-workspace configuration below) |
| Unreleased | Plan steps carry the workspace their plan was approved in: `workspace_id` on the plan's META, `voc:workspace` in each step's claims, sent as the domain calls' `X-Workspace-Id` header (Request flow below) |
| Unreleased | The deployment-wide settings' writes are platform admins', checked live: `PUT /settings/appearance` and the alert writes (Per-workspace configuration below; in the route-gate inventory as admin-only and platform-admin-only) |

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
| `WS#{ws}` | `META` | name, slug, status (`active` or `deleting`), created_by, created_at, secret_status (`pending` until the credentials secret exists, then `ready`) |
| `WS#{ws}` | `MEMBER#{sub}` | role (`admin`, `editor` or `viewer`), invited_by, joined_at; since 6.10.00 a member added through the members routes also carries the email and name Cognito had then (removed by an erasure by email since 6.11.00) |
| `USER#{sub}` | `WS#{ws}` | the inverse row behind "my workspaces" (name, slug, role), written, changed and deleted in the same transaction as `MEMBER#` |
| `WS#{ws}` | `INVITE#{id}` | planned, not written: email, role, invited_by, expires_at, and `ttl` (the table's TTL attribute). Since 6.10.00 an add is immediate for a new email too (Invites), so nothing has an invite to accept; the row stays reserved, the only one allowed `ttl`, for a later invite that waits for acceptance |
| `SLUG#{slug}` | `META` | slug → workspace id (`workspace_id`, created_at); uniqueness by a conditional put |
| `WORKSPACES` | `{name, case-folded}#{ws}` | the platform console's listing (workspace_id, name, slug, status, created_at): one partition, sorted by name, so the list is a paged Query, never a Scan. Written once per created workspace and read by platform admins only; a later rename or status change moves or updates it too |
| `PLUGIN#{plugin_id}` | `WS#{ws}` | a plugin of the deployment the workspace enabled (enabled_by, enabled_at; since Unreleased, Per-workspace configuration): one partition per plugin, which its scheduled ingestor reads to fan out over the workspaces that enabled it; deleted when it is disabled |
| `AUDIT#WS#{ws}` | `{iso}#{random}` | the workspace's creation (since 6.09.00), membership changes, platform-admin entries, export and delete, share grants: an `AUDIT#` partition, so the audit-row guard (`voc-datalake/lib/utils/audit-row-guard.ts`) lets no role change or remove one |

Creating a workspace (6.09.00, `POST /platform/workspaces`, `lambda/shared/platform_workspaces.py`) writes the
`SLUG#`, `META`, `MEMBER#`, `USER#`, `WORKSPACES` and `AUDIT#WS#` rows in one transaction, each put conditional on
a new key, so a taken slug (409) writes nothing and no workspace is ever half-written in the table.

- **Platform admins** are the Cognito group `platform-admins`, bootstrapped at deploy time the way the first admin
  user is today ([README](../README.md#-initial-login)). Only they create workspaces and see the platform console
  (every workspace, its members and its cost).
- Platform-admin membership is managed on its own, before the group could grant anything (6.07.00 read the group,
  but with no workspace in the table it granted nothing until 6.09.00 let platform admins create workspaces). Built
  in 6.08.00, before any route could create a workspace or a membership:
  - a platform-admin route to grant and revoke the membership, `PUT /users/{username}/platform-admin`
    (`{"platform_admin": true|false}`; platform admins only, granted only to an administrator, audited in
    `AUDIT#platform-admins`, in the route-gate inventory). The platform console that will show it is not built yet;
  - in the users API: demoting a user also revokes it; demoting, disabling, enabling, deleting or resetting the
    password of a platform admin is for platform admins only (403); and no request may leave the deployment without
    an enabled platform admin (409, also for a platform admin revoking themselves as the last one).
  (Cognito drops a deleted user's group memberships itself; the users API records that delete as a revoke.) As with
  the last-admin guard, these checks read before they write, so two concurrent requests can both pass them.
  Since 6.09.00, the change that creates workspaces, one live check (`lambda/shared/platform_admin.py`: the token's
  group, the live Cognito membership and an enabled account) serves the users API, the `/platform` routes and
  entering a workspace as a platform admin, which runs it on each fill of the 30 s membership cache that would
  elevate the caller: a revoke or a disable refuses new entries at once and ends a cached one within 30 s (a
  failed check enters with the member's own role, or answers the 404 for a non-member).
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
   request context. A platform admin passes as a workspace admin once the live check confirms them (Control plane),
   and the entry writes an `AUDIT#` row that the workspace's own admins can see.
4. All data access goes through a workspace-scoped repository layer (`ws_table(ws)`, `ws_key(ws, …)`,
   `ws_s3_key(ws, …)`). A static test fails on any raw `Table(...)` or `put_object` call outside that layer.
5. `require_admin` becomes `require_role('admin')`: a workspace admin, or a platform admin. The route-gate inventory
   (`lambda/api/test/test_route_admin_gates.py`) gains the workspace dimension: every route is classified as
   workspace-scoped, platform-only or public, as well as admin-only or open.

Asynchronous paths carry the workspace explicitly and never infer it from the caller: SQS messages, Step Functions
inputs, Lambda async payloads, DynamoDB Stream records (the workspace comes from the key prefix), memory extraction,
agent runs, plan steps and assist jobs.

The assistant's reads (the stream Lambda calling the domain Lambdas as the signed-in person,
`lambda/stream/src/assistant/tools/internal-api.ts`) carry the caller's own `X-Workspace-Id` since Unreleased: the
stream request's header (`assistant/runtime/event.ts`, as it came, not judged there; the web app sends it once it is
inside a workspace, Request flow step 2) goes on every domain call as its `X-Workspace-Id` header, never as a claim,
and each domain Lambda answers it exactly as it answers the caller's own request (membership, the 400 and the one
404). So a route that moves into its workspace keeps working for the assistant. Plan steps carry it too (since
Unreleased): the approval's `X-Workspace-Id` (when well formed) is kept on the plan and each step names it to the
domain Lambdas the same way ([Assistant plan mode](assistant-plan-mode.md#identity-and-permissions)). Not yet carried:
the global MCP tools (a token will pin its workspace).

## Roles

| Role | Can |
|---|---|
| Viewer | Read the workspace's feedback, dashboards, projects and documents |
| Editor | Everything a viewer can, plus write: projects, documents, personas, agents, imports a non-admin may run today |
| Admin | Everything an editor can, plus the Administration tabs, members and invites, export and delete of the workspace |
| Platform admin | Create workspaces, see the platform console, enter any workspace as an admin (audited) |

What an editor may write follows today's split between admin-only and open routes; the route-gate inventory pins it.
Since 6.10.00 the members routes check the role (`require_workspace_admin`, `lambda/shared/workspace.py`: a member
admin or an entered platform admin; the deployment's `admins` group grants nothing there), and the inventory
(`lambda/api/test/test_route_admin_gates.py`) has a workspace-admin table for them. Every member, a viewer
included, reads the member list; only admins add members, change roles or remove others; any member may leave.

## Invites

Built in 6.10.00 (`POST`, `PUT` and `DELETE /me/workspaces/current/members[/{sub}]`, `lambda/shared/workspace_members.py`).

- Workspace admins and platform admins invite, with any workspace role. Editors and viewers cannot (403).
- An email that already has an account gets its membership row at once. The notification email is not sent yet:
  the deployment has no mail path for account notices (the participant mailer serves participant asks only), so the
  add is logged and the answer says `account: 'existing'`.
- A new email gets a Cognito account (`AdminCreateUser`, which sends the temporary password) and the membership row
  at once (`account: 'created'`), when the caller is in the deployment's `admins` group (a platform admin is): any
  other workspace admin gets 403 for a new email until the data path is keyed by workspace (phase 2), because until
  then every account reads the whole deployment. The account joins no deployment group (neither `admins` nor `users`): inside a
  workspace only the `MEMBER#` role counts. The creation is recorded before the account exists: an `AUDIT#WS#{ws}`
  row of kind `account_created` (the actor and the email's sha256: no role can change or remove an audit row, so a
  raw address there could never be erased), written before `AdminCreateUser`, so a row that cannot be
  written creates no account. If the membership then fails (its audit row or its transaction), the account stays,
  recorded; adding the email again finds it.
- Membership is immediate in both cases, so no `INVITE#` row is written (Control plane).
- Removing or demoting a workspace's last admin is refused (409), the admin themselves included. Any member may leave
  (remove themselves). A person with no workspace left sees an empty picker.
- A change takes effect at once in the container that made it; other warm containers serve the member's cached
  role to reads for up to 30 s (`MembershipCache`, `lambda/shared/workspace.py`). The members writes never use the
  cache: they read the caller's role from the table, and each transaction also checks that the acting admin is still
  admin when it commits (403 when they were demoted in between).
- Trade-off, accepted with decision 4 (an invitee may already have an account): adding by email tells any workspace
  admin whether the email has an account in this deployment, and its name (201 for one with an account, 403 for a
  new email from an admin outside `admins`). It is one deployment's own directory, which only `admins` list in full
  (`GET /users`); a multi-company deployment would answer both cases alike.
- Deleting a user (`DELETE /users/{username}`, since 6.11.00) removes their memberships too, in this order: every
  refusal first (the users API's own: the caller's own account, the last administrator, a platform admin's rules;
  then the last member admin of any of their workspaces, 409, which names the workspace), then a platform admin's
  revoke audit row, then per workspace its `member_removed` audit row (`via: user_deleted`) and one transaction of
  the `MEMBER#` and `USER#` deletes, and only then the Cognito account (`AdminDeleteUser`). So a refusal, or a fault
  before the account goes, leaves the account as it was: a fault part-way leaves the memberships not yet removed (the
  ones removed stay removed, audited), and the delete can be asked again. A platform admin may delete a workspace's
  last admin: the workspace then has no member admin (the audit row says `left_without_admin`) until a platform admin
  enters it (decision 2) and makes a member admin, or adds one (`PUT` or `POST /me/workspaces/current/members`).
  Other warm containers serve the deleted user's cached membership to reads for up to 30 s.
- A member admin whose Cognito account is disabled still counts as an admin when another admin is demoted or
  removed: the check reads the table, not Cognito (one Cognito call per admin on every demotion and removal would be
  the alternative), and a disabled account may be enabled again. Their rows stay; deleting the account removes them.
  Known gap: a user deleted before 6.11.00 kept their rows, so they still count as another admin. To clean up, check
  each workspace's members against the users list and remove any member whose account is gone.
- Erasure (D5, since 6.11.00): an erasure by email without a source (`POST /settings/erasure`, `voc-retention`,
  docs/source-policies.md) removes the `email` and `name` of every `MEMBER#` row that holds that email (compared
  case-insensitively: a row keeps Cognito's spelling) and keeps the row, as the feedback boards keep a de-identified
  request: a membership is access configuration, and the account itself is the users API's to delete. Each row first
  gets a contentless tombstone in `voc-aggregates` (`AUDIT#tombstone#workspace_members` / `{ws}#{sub}#{job}`:
  the workspace, the run, the legal basis; one per job, so a later erasure never overwrites an earlier record), and the job and its audit row count `member_rows_deidentified`. While the
  account exists, the members list fills an emptied row's email from Cognito, as for a workspace's creator. The
  workspace's audit rows hold subs only (an `account_created` row the email's sha256), so they hold nothing to erase.
  The rows are found by a paged Scan of `voc-workspaces`: the table has no email index, and the email can be on a row
  whose account changed its email or was deleted before 6.11.00, which a look-up of the account by email (Cognito
  `ListUsers`, then the `USER#` rows) would miss. It runs once per erasure job, never on a request path, 100 items a
  page, projecting the key and the email only, within the job's time budget and hand-over cursor; the table holds
  the control plane (workspaces, members, their audit), far smaller than the feedback tables the same job scans.
- History (D2: access rules are primary data): a removal deletes the `MEMBER#` and `USER#` rows and a role change
  overwrites `role`, but each first writes its `AUDIT#WS#{ws}` row with the target, the role before and after, the
  actor and the time, append-only under the audit-row guard: the membership's whole history is kept there.

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

- Every workspace kind of settings in the table below moves under `WS#{ws}#…`; the deployment kinds keep their key.
  The `METRIC#…` rows in `voc-aggregates` move under `WS#{ws}#…` with the data path (phase 2).
- Plugins and menu items stop being chosen at deploy time: every plugin Lambda is deployed, `cdk.context.json` becomes
  the ceiling (what this deployment offers), and each workspace's settings pick a subset of it at run time.
  Since Unreleased a workspace picks its plugins (`lambda/shared/workspace_plugin_settings.py`, in the workspaces API):
  `GET /me/workspaces/current/plugins` answers every plugin the deployment offers (its `ENABLED_SOURCES`, rendered
  from `cdk.context.json`; the ceiling) with whether the workspace enabled it, for any member; `PUT
  /me/workspaces/current/plugins/{plugin_id}` `{enabled}` turns one on or off, for its admins only (403 for an editor
  or a viewer; 404 for a plugin the deployment does not offer). An enabled plugin is a row `PLUGIN#{plugin_id}` /
  `WS#{ws}` in `voc-workspaces` (`enabled_by`, `enabled_at`), the partition the plugin's scheduled
  ingestor reads to fan its tick out over the workspaces that enabled it (phase 2); disabling deletes the row (access
  configuration, not customer data). Each change writes its `AUDIT#WS#{ws}` row first (kind `plugin_enabled` or
  `plugin_disabled`), then one transaction that also checks the workspace is `active` and a member admin still admin
  (409 when the plugin changed meanwhile, 403 when the admin was demoted meanwhile); asking for what holds changes
  and records nothing. Disabling deletes the row and keeps no version of it: its history (who turned which plugin
  on or off, and when) is the workspace's append-only `AUDIT#WS#` rows, as for a membership (D2). The web app's menu does not read it yet; today every plugin of
  the ceiling still deploys as before (the ceiling stays the one `cdk.context.json` sets).
- The model picker is per workspace; the model allowlist stays deployment-wide.
- Brand configuration (name, products, the tone the AI uses) is per workspace; the logo and colours stay global.

Every settings row and its scope (Unreleased; `voc-datalake/lambda/shared/test/test_settings_scopes.py` holds this
table and the files that spell each key to the code, so the files still to move only shrink). A workspace kind moves
to `WS#{ws}#SETTINGS#<kind>` in phase 3; a deployment kind keeps `SETTINGS#<kind>`. Nothing has moved yet. The
deployment kinds' writes are platform admins' (since Unreleased): `PUT /settings/appearance` and the three alert writes
(`PUT /logs/alerts`, `POST /logs/alerts/recipients`, `POST /logs/alerts/recipients/remove`) call `require_admin`,
`require_platform_admin` and the live check (`lambda/shared/platform_admin_gate.py`: the live Cognito membership and an
enabled account of the same person), so no workspace admin or plain administrator changes what every workspace
shares (403); the reads stay as they were (the theme for everyone, the alerts' status for administrators). The settings
and logs APIs read the caller's groups and account in Cognito for it (`AdminListGroupsForUser`, `AdminGetUser`). The
web app shows the default theme read-only to everyone else (Administration → General) and the alerts read-only to
the other administrators (System → Logs → Alerts, which only administrators see), each with a notice naming platform
admins (`useIsPlatformAdmin` reads the token's group, only a hint: the server decides), and a 403 on either save (a
membership revoked since sign-in) says the same. The bootstrapped first admin is a
platform admin (Control plane); on an older deployment, add the people who manage the theme and the alerts to
`platform-admins` first.

| Kind (`SETTINGS#…`) | Scope | Why |
|---|---|---|
| `brand`, `company_context`, `design_system` | workspace | the brand the AI writes for, the team's vision and objectives, its design tokens and references (decision 6) |
| `categories`, `dimensions`, `sources` | workspace | the team's taxonomy and source profiles (decision 6) |
| `resolved_problems` | workspace | the problems a team marked resolved |
| `email_intake` | workspace | the team's inbox caps (its address is `{slug}@`, [Public and non-user entry points](#public-and-non-user-entry-points)) |
| `fallback_owner` | workspace | the member an agent's new project falls back to |
| `radar` (voc-radar: config, brands, version) | workspace | decision 13 |
| `model` | workspace, over a deployment default | the team's model pick; the default pinned at deploy and the allowlist stay deployment-wide (decision 6). Today the pin and the pick share one row and attribute, so the move first splits the default into a deployment row of its own |
| `participants` (voc-participants, pk `SETTINGS`: engagement, board audience) | workspace | the team's engagement settings |
| `appearance` | deployment | one logo and colour scheme (decision 7): a platform admin's setting, not a workspace admin's |
| `model_quotas`, `image_model_quota` | deployment | the AWS account's Bedrock quotas, cached; every workspace shares them (decision 10) |
| `alerts` | deployment | alarms on the deployment's own Lambdas and their recipients: the deployment's operations |

## Credentials

- One Secrets Manager secret per workspace, `voc/ws/{ws}/credentials` (`<prefix>-voc/ws/{ws}/credentials` in a
  deployment with `-c deploymentPrefix`), encrypted with the customer-managed key. It will hold every plugin
  credential, scraper API credential and webhook secret of that workspace; nothing reads or writes it yet.
- The create-workspace flow creates it, not CDK (since 6.09.00, `lambda/shared/platform_workspaces.py`): after the
  transaction that writes the workspace, with `{}` as its first value and the tag `workspace_id`. A secret already
  there under that name for this workspace is kept; one without this workspace's tag is not used. The workspace's
  `META` says `secret_status: pending` until the secret exists, then `ready`; when the secret cannot be made, it
  stays `pending`, the create answers `secret_status: 'pending'` and the failure is logged. The workspace is not
  rolled back: its audit row stays (D4) and deleting a workspace is an open tenet question (below). Nothing retries
  a pending secret yet. To recover one, an operator first checks whether `voc/ws/{ws}/credentials` exists (the
  secret may have been made and only the `ready` mark failed): if it does, with the `workspace_id` tag, they set
  `secret_status` to `ready` on BOTH rows that carry it, `WS#{ws}` / `META` and the listing row `WORKSPACES` /
  `{name, case-folded}#{ws}` (the platform list reads the second); if not, they create it under that name, under the
  deployment's key, with the tag and `{}`, and then set `ready` on both rows. The workspace delete job (phase 4) will delete it,
  with no recovery window.
- IAM: the workspaces API's role (`voc-datalake/lib/stacks/api-workspaces-lambda.ts`) may `CreateSecret` (only with
  the customer-managed key, `secretsmanager:KmsKeyArn`), `DescribeSecret` and `TagResource` on `voc/ws/*`, and no
  other secret. The name is built only from the workspace id the server generates, never from a request field
  (`voc-datalake/lambda/api/test/test_workspaces_platform_routes.py` pins that). Later, the plugin and integrations
  roles get `secretsmanager:GetSecretValue` and `PutSecretValue` on `voc/ws/*`, with the name built from the
  request's verified workspace.
- **Cost**: about $0.40 per workspace per month. This is the one fixed cost the design adds, accepted by decision 8
  as the price of per-workspace credential isolation. The fixed-cost guard
  (`voc-datalake/lib/fixed-cost-guard.test.ts`) counts the CDK-created secrets in the templates; these are made at
  run time, so its `RUNTIME_FIXED_COSTS` (`voc-datalake/lib/test-support/fixed-cost-rules.ts`) names them as a
  counted, accepted cost, one per workspace, and fails on any other grant of `secretsmanager:CreateSecret` or
  `kms:CreateKey` in the app. The cost is reported per workspace (below) when cost metering lands (phase 4).

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
   every table, every `ws/{ws}/` object with all its versions, the workspace secret, its MCP tokens, memberships, slug,
   its enabled plugins (the `PLUGIN#{plugin}` / `WS#{ws}` rows of `voc-workspaces`: keyed by the plugin, so a sweep
   of the `WS#{ws}#` partitions does not reach them) and the share grants it gave or used. Whether copies other workspaces already imported stay theirs is the second
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

Also held to the tenets as built: the per-workspace secret is a fixed cost per workspace (decision 8 accepts it;
tenet 7's gap names a move of secrets to SSM Parameter Store), and since 6.09.00 the fixed-cost guard names it
(`RUNTIME_FIXED_COSTS`, Credentials above); and `voc-workspaces` holds primary data (members, audit) beside
invites, so 6.09.00, the first change that writes workspaces and members, pins that only `INVITE#` rows carry `ttl`
(no writer of the table names the attribute, `lambda/shared/workspace_members.py` included since 6.10.00:
`voc-datalake/lambda/shared/test/test_platform_workspaces.py`). The
audit rows are protected: they are keyed `AUDIT#WS#{ws}` / `{iso}#{random}`, and the audit-row guard
(`voc-datalake/lib/utils/audit-row-guard.ts`) covers `voc-workspaces` (since 6.07.00), so no role can change or
remove one and only its named writers can put one: `voc-workspaces-api`, and since 6.11.00 the users API, limited to
`AUDIT#WS#*` (a deleted user's membership removals); every other role that comes to write the table
(`voc-retention`, since 6.11.00) is denied putting an `AUDIT#` row. That role's PutItem is scoped (`dynamodb:LeadingKeys`) to the partitions a
creation, an add and an audit write (`AUDIT#WS#*`, `SLUG#*`, `USER#*`, `WORKSPACES`, `WS#*`), every put conditional
on a new key, and its UpdateItem to `WS#*` and `WORKSPACES` for `secret_status` (of `META` and the listing row) and
to `WS#*` and `USER#*` for `role` (a member's role change, since 6.10.00). Its one DeleteItem (since 6.10.00) is a
member's removal, scoped to `WS#*` and `USER#*`: membership rows are access configuration, not customer data (D5
covers feedback and raw items), each removal is audited first, and `voc-datalake/lib/customer-data-deletes.test.ts`
names the grant with that reason. IAM pins the partition key only, so the grant also reaches a workspace's `META`;
the code deletes `MEMBER#` and `USER#` keys only (its tests pin the keys). The users API holds the same DeleteItem
since 6.11.00, for a deleted user's memberships, named in the same test with its reason. A phase that adds another
audit writer names it in the guard.

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
member of workspace A is refused every id of workspace B exactly as an id that exists nowhere, route by route), and an
end-to-end check with two workspaces against the local mock.

The cross-workspace suite (`voc-datalake/lambda/api/test/test_cross_workspace_routes.py`; its docstring has the
rules) names every route of the API, reads and writes, by file and route, in exactly one table: workspace-scoped (it
resolves `X-Workspace-Id` before it can return or write, found structurally, with a two-workspace case in
`cross_workspace_worlds.py`), outside a workspace by design (each with its reason), or pending
(`cross_workspace_pending.py`, by the phase that moves it, with `POST /mcp/global` too). For each workspace-scoped
route it generates the checks over two seeded workspaces: B's workspace in the header, and B's ids (path, body or
query) under A's header, are refused exactly as ones that exist nowhere, changing nothing, while the same request
works inside A. A new route, or a pending one that starts resolving the workspace, fails until it is classified, so
the pending lists only shrink. A platform admin entering B (decision 2, audited) is the one sanctioned way in
(`shared/test/test_workspace.py`).

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
