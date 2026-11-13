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
| 6.07.00 | The workspace middleware `lambda/shared/workspace.py`: the `X-Workspace-Id` header (missing 400; malformed, unknown, `deleting` or not a member: one 404), the role from the `MEMBER#` row, a platform admin who is not a member admin entering as admin (decision 2) with an audit row `AUDIT#WS#{ws}` / `{iso}#{random}` (once per fill of the 30 s warm-container cache), `ws_key` and "my workspaces". The workspaces API `voc-workspaces-api` (`lambda/api/workspaces_handler.py`, `GET /me/{proxy+}`): `GET /me/workspaces` and `GET /me/workspaces/current`, with Query and GetItem on `voc-workspaces` and PutItem only where the partition key matches `AUDIT#WS#*`. The audit-row guard (`voc-datalake/lib/utils/audit-row-guard.ts`) covers `voc-workspaces`, with this role as its audit writer: no role can change or remove an entry row. Nothing creates workspaces or members yet, so every list is empty; the web app does not call these routes yet, and `X-Workspace-Id` is not yet in the CORS preflight (both since 6.12.00). This is the first reader of `platform-admins`: the platform-admin safeguards below (Control plane) land before anything can create a workspace |
| 6.08.00 | Platform-admin membership in the users API (`lambda/api/users_handler.py`, rules in `lambda/shared/user_admin_guard.py`). `PUT /users/{username}/platform-admin` with `{"platform_admin": true\|false}`: platform admins only (403 for everyone else, plain `admins` included; in the route-gate inventory as admin-only and platform-admin-only), a grant only to a member of `admins` (400 otherwise), a revoke refused (409) when it would leave no enabled platform admin, the caller's own included; asking for what already holds changes and records nothing. Demoting a user to `users` also removes them from `platform-admins`. Demoting, disabling, enabling, deleting or resetting the password of a platform admin answers 403 unless the caller is one too (the caller's membership is checked live in Cognito, not only in the token, with an enabled account, so a revoke or a disable takes effect in the users API at once; entering a workspace still reads the token, and the change that creates workspaces adds the live check there); demoting, disabling or deleting the last enabled one answers 409 (the last-`admins` guard is unchanged). Every grant and revoke (the route, a demotion, a delete) writes an `AUDIT#platform-admins` / `{iso}#{random}` row in `voc-aggregates` (kind, via, the target's and the actor's sub, the time) before the change, so it records the attempt (a change that then fails leaves the row; the group's live state is Cognito's): a row that cannot be written refuses the change; the audit-row guard names the users API's role that partition's only writer. `GET /users` reports `platform_admin` per user. The web app calls the new route since 6.13.00 (Administration → Privacy & access → Users, for platform admins). Like the last-admin check, these checks read before they write |
| 6.09.00 | Creating and listing workspaces, for platform admins only, in the workspaces API under `/platform/{proxy+}` (GET and POST, Cognito; logic in `lambda/shared/platform_workspaces.py`). Each route calls `require_admin` and `require_platform_admin`, then the live check, now shared by the users API and the workspaces API (`lambda/shared/platform_admin.py`: the token's group, the live Cognito membership and an enabled account; 403 otherwise). `POST /platform/workspaces` with `{name, slug}` (name 1 to 80 characters, trimmed; slug 3 to 40 of `a-z`, `0-9` and `-`, not starting or ending with `-`, not `admin`, `api`, `app`, `platform` or `www`; 400 otherwise) writes, in ONE transaction of conditional puts, `SLUG#{slug}` / `META` (409 when the slug is taken, nothing written), `WS#{ws}` / `META`, the creator's `MEMBER#` row (role `admin`), their `USER#` row, a `WORKSPACES` listing row and an `AUDIT#WS#{ws}` row (kind `workspace_created`); the id is `ws_` plus a new ULID. It answers 201 `{workspace: {id, name, slug, role: 'admin', secret_status}}`. The transaction's idempotency token covers the SDK's own retries; a client that retries after a lost answer gets 409 for the slug its first attempt took, and `GET /platform/workspaces` shows whether that workspace was made. Then it creates the workspace's credentials secret (Credentials, below); `secret_status` is `ready`, or `pending` when the secret could not be made (logged; the workspace stays). `GET /platform/workspaces` lists every workspace `{workspaces: [{id, name, slug, status, created_at, secret_status}], next_cursor}` by name (`?limit=` 1 to 100, default 25, `?cursor=`), one Query of the `WORKSPACES` partition. Entering a workspace as a platform admin (`GET /me/workspaces/current`, `lambda/shared/workspace.py`) now needs the live check too, on each fill of the 30 s cache that would elevate: a failed one enters with the member's own role, or answers the 404 for a non-member. The role's PutItem reaches `AUDIT#WS#*`, `SLUG#*`, `USER#*`, `WORKSPACES` and `WS#*`, its UpdateItem `WS#*` and `WORKSPACES` only (`secret_status` on `META` and the listing row, in one transaction); it reads the caller's groups and account in Cognito, and creates, describes and tags secrets under `voc/ws/*` only. The web app calls the `/platform` routes since 6.13.00 (the platform console); members are added since 6.10.00 |
| 6.10.00 | A workspace's members, in the workspaces API under `/me/workspaces/current/members` (GET, POST, PUT and DELETE on the existing `/me/{proxy+}`; logic in `lambda/shared/workspace_members.py`), each acting in the workspace `X-Workspace-Id` names as `resolve_workspace` decides (400 without the header, the one 404 for a non-member, the deployment's `admins` group included; a platform admin enters as admin, live-checked and audited). `GET` lists the members `{members: [{sub, role, email, name, invited_by, joined_at}], next_cursor}` for any member, by sub (`?limit=` 1 to 100, default 25, `?cursor=`; one Query of the `MEMBER#` rows; email and name are the row's, and for up to 5 rows a page that hold none, such as the creator's, Cognito's by sub). `POST {email, role}` (admin, editor or viewer): workspace admins only (`require_workspace_admin`: 403 for an editor or a viewer); an email with a Cognito account is a member at once, a new email first gets an account (`AdminCreateUser`, the temporary password emailed, as the users API does) when the caller is in the deployment's `admins` group (platform admins are; 403 for any other workspace admin: until the data path is keyed by workspace, phase 2, every account reads the whole deployment, so creating one stays with the users API's administrators), then 201 `{member: {sub, role, email, name, invited_by, joined_at, account: 'existing'\|'created'}}`; 409 for a member already there, for two accounts sharing the email, or for an email Cognito holds for another account. An existing account gets no notification email: the deployment has no mail path for account notices, so the add is logged. No `INVITE#` row is written: membership is immediate either way, so there is nothing to accept. `PUT /{sub}` `{role}`: workspace admins only (asking for the role a member has changes and records nothing). `DELETE /{sub}`: workspace admins, or the member themselves (leave). Demoting or removing the last member admin, the caller included, is refused (409). Each add, role change and removal writes an `AUDIT#WS#{ws}` / `{iso}#{random}` row (kind `member_added`, `member_role_changed`, `member_removed` or `member_left`; actor, target sub, role before and after, `platform_admin`, and on an add `account`) before the change, so it records the attempt (a row that cannot be written refuses the change); then ONE transaction changes the `MEMBER#` row and the `USER#` row together (an add: two conditional puts and a check that `META` is still `active`; a role change: two updates, each only of `role` and only on existing rows; a removal: two deletes), and a demotion or removal of an admin also checks that another member is still an admin, so two admins demoting each other at once cannot both succeed. Each write resolves the caller's role from the table, not the 30 s cache, so an admin demoted or removed a moment ago cannot undo it; the change drops the member's cached membership in the container that made it, and other warm containers serve the old role to reads for up to 30 s. The role's new grants: UpdateItem on `WS#*` and `USER#*` with the attribute `role` only; DeleteItem on `WS#*` and `USER#*` (`dynamodb:LeadingKeys`; IAM cannot pin a sort key, so `META` in `WS#*` is in reach of IAM and kept out by the code, while `SLUG#`, `WORKSPACES` and `AUDIT#` are not); ConditionCheckItem on `WS#*`; Cognito `ListUsers` and `AdminCreateUser` on the user pool (IAM cannot limit ListUsers to an email filter; the code sends only an email or a sub). The web app calls these routes since 6.13.00 (the members page) |
| 6.11.00 | A user's delete and an erasure by email reach the memberships. `DELETE /users/{username}` (the users API) removes every membership of the user BEFORE `AdminDeleteUser` (`plan_user_removal` and `remove_user_memberships` in `lambda/shared/workspace_members.py`): it reads their `USER#{sub}` rows, and per workspace the `MEMBER#` role and, for an admin, another admin; the last member admin of a workspace is refused (409, naming the workspace: make another member an admin there first) unless the caller is a platform admin (live-checked), in which case the workspace keeps no member admin until a platform admin enters it and names one (Invites). Every refusal comes before any write; then, per workspace, an `AUDIT#WS#{ws}` row (kind `member_removed`, `via: user_deleted`, actor, target, role before, `platform_admin`, `left_without_admin`) and ONE transaction deleting the `MEMBER#` and `USER#` rows (the `MEMBER#` delete conditional on the role read; for an admin a check that the other admin still is one: 409 when either changed meanwhile); only then the Cognito account. The users API's role gains, on `voc-workspaces`: Query on `USER#*` and `WS#*`, GetItem on `WS#*` and `AUDIT#WS#*` (an audit row read back after a retried put), ConditionCheckItem on `WS#*`, PutItem on `AUDIT#WS#*` and DeleteItem on `USER#*` and `WS#*` (`dynamodb:LeadingKeys`; the code deletes `MEMBER#` and `USER#` keys only); the audit-row guard names it a writer of `AUDIT#WS#*` there and of no other audit partition. An erasure by email without a source (`voc-retention`, docs/source-policies.md) removes the `email` and `name` of every `MEMBER#` row that holds the email, in any case, and keeps the row; each row first gets a tombstone `AUDIT#tombstone#workspace_members` / `{ws}#{sub}#{job}` (the workspace, the run, the legal basis; never the email), counted as `member_rows_deidentified`. It finds the rows with a paged Scan of `voc-workspaces` (no email index; Invites says why and how it is bounded); `voc-retention` gains Scan and UpdateItem pinned to `WS#*` and the attributes `email` and `name` there |
| 6.12.00 | The web app's side of Request flow steps 1 and 2. `X-Workspace-Id` is in the API's CORS: the gateway's preflight and error responses (`voc-datalake/lib/stacks/api-gateway.ts`) and the Lambdas' own CORS headers. After sign-in, the workspace gate (`frontend/src/workspace/WorkspaceGate.tsx`, inside `ProtectedRoute`, around the layout) reads `GET /me/workspaces`: an address `/w/{slug}/…` whose slug is one of the caller's enters it (the current workspace, `frontend/src/workspace/currentWorkspace.ts`, is set before any page renders, then `GET /me/workspaces/current` gives the role the server applies; its 404 shows the not-found page); a slug that is not theirs, or one the platform could not have made, shows "Workspace not found" with the caller's own workspaces as links (the same page whether it exists); no slug and one workspace moves into it with a full page load, keeping the path; no slug and two or more shows a picker (name, role; the slug last entered in the browser and confirmed by `/current`, `localStorage` `voc-last-workspace`, is highlighted, never chosen automatically). On an address without a slug, no workspace, or a list that cannot be read (logged as a warning), opens the app as before, with no header and no picker; on a `/w/…` address a list that cannot be read shows "Could not load your workspaces" with Try again and Sign out, never the app outside the workspace (a list read once keeps counting when a later refresh fails). Sign-out clears the current workspace and loads the plain `/login` (a full page load, out of the workspace's address), the gate clears it too when it unmounts, and the expired-session redirect keeps the `/w/{slug}` base path. After a 404 from `/current` (a workspace being deleted stays listed, as can a membership removed a moment ago) the gate leaves that workspace out of the list for the rest of the tab (`sessionStorage` `voc-refused-workspaces`, and the cached list): the not-found page does not offer it and says it is not available, and neither the one-workspace redirect nor a full page load of `/` moves back into it. The router takes `/w/{slug}` as its `basename` at load (`frontend/src/workspace/workspacePath.ts`, the slug rule of `lambda/shared/platform_workspaces.py`), so every route and link works unchanged inside a workspace; the SPA distribution's 404 fallback already serves `index.html` there. Inside one, every API call to a trusted origin carries `X-Workspace-Id` (`getAuthHeaders` in `frontend/src/api/baseUrl.ts`, which the REST client and the assistant's stream use, and the feedback boards' transport), and the header shows the workspace with, for two or more, a menu that switches with a full page load to `/w/{slug}/dashboard`. The data path still ignores the header (phase 2). The dev mock serves both routes, its caller in no workspace until its dev switch `PUT /__mock/workspaces` turns on two (`frontend/mock-workspaces.js`); `frontend/e2e/tests/workspaces.spec.ts` runs against it. The web app's browser-saved state was not keyed by workspace yet (since 6.15.00 it is: the row below) |
| 6.13.00 | The web app's members page and platform console, on the routes of 6.08.00 to 6.10.00 (no API change). Inside a workspace, `/w/{slug}/members` (`frontend/src/pages/Members/`), reached from Members in the header's workspace menu (a menu with one workspace too); outside one the address is the app's "Page not found". Every member reads the list (`GET /me/workspaces/current/members`, a page at a time: name or email, role, joined); the role the server applies there (`/current`) decides what the page offers: a workspace admin adds by email with a role, changes a role and removes a member (confirmed); any member who has a membership row leaves (confirmed, then a full page load to `/`). Each refusal is said in words by its status and the server's reason (`frontend/src/workspace/workspaceRefusals.ts`, held to the Python constants by `workspaceRefusals.lockstep.test.ts`): the last admin, a membership changed meanwhile, an admin demoted meanwhile, a person already a member, a new email from a workspace admin outside `admins`. The platform console is Administration → Privacy & access → Workspaces (`frontend/src/pages/Settings/PlatformWorkspacesSection.tsx`), shown when the session's token holds `platform-admins` (`useIsPlatformAdmin`, `frontend/src/store/authStore.ts`; the API's live check decides): every workspace by name (`GET /platform/workspaces`, a page at a time: name, slug, status, secret pending or ready), create with name and slug checked by the server's rules first (`POST /platform/workspaces`; 409 for a taken slug), and Enter, a full page load to `/w/{slug}/`. A platform admin entering a workspace they are not a member of: the console records the workspace (id and slug; the name comes from the server's answer) in the tab's `sessionStorage` (`voc-platform-entries`, `frontend/src/workspace/platformEntry.ts`) before the load, and on a `/w/{slug}` address outside the caller's list the gate asks `/current` with that id and opens nothing until it answers that workspace with that slug (decision 2: the server's live check and audited entry); its 404 shows the same not-found page as any other slug and drops the record, so the record lets no one else in and confirms nothing. Sign-out clears the records; an expired session keeps them (signing back in returns to the workspace's address). Under Administration → Privacy & access → Users, platform admins grant and revoke platform admin per user (`PUT /users/{username}/platform-admin`), with its refusals said (the last enabled platform admin, a grant to a non-administrator). The dev mock serves all of these routes on its switch's state (`frontend/mock-workspaces.js`, `mock-server.js`); `frontend/e2e/tests/workspace-admin.spec.ts` runs against it. Still not keyed by workspace: everything the data path holds (phase 2), so the pages say that workspaces do not separate data yet |
| 6.14.00 | Phase 1's guards and the repository layer phase 2 moves the data path onto (Request flow step 4; no route or stack change, and the data path is still not keyed by workspace). The layer, `lambda/shared/ws_repository.py`: `ws_table(ws, env_var)` opens one of the tables in its registry (`TABLES`: voc-feedback, voc-aggregates, voc-projects, voc-jobs, voc-conversations, voc-memory, voc-agents, voc-radar, voc-participants and voc-feature-requests, by their environment variables, each with its partition attribute `pk` and its indexes' partition attributes, held equal to each table's definition in `lib/stacks/core-stack.ts`, both ways, by a test; any other table is refused). Before an AWS call it refuses a key whose partition attribute is not `WS#{ws}#…` with a part after the workspace (so not the control-plane partition `WS#{ws}` itself), a put whose index partition attributes are not, and an update whose `UpdateExpression` names a key or index partition attribute, as a plain word or as a `#placeholder` it uses (a condition such as `attribute_exists(#pk)` passes; index keys are set with a put); a table handle's state cannot be changed once built; each call takes only the parameters listed for it, so the legacy `AttributeUpdates`, `Expected`, `KeyConditions`, `QueryFilter` and `AttributesToGet` are refused. It has no transactions and no batch reads or writes yet: phase 2 adds scoped ones before it moves a call site that needs them. `get_item`, `put_item`, `update_item` and `delete_item` take and answer boto3's own forms (`Key=`, `Item=`), so those call sites move by swapping the handle (their key values becoming `WS#{ws}#…`, phase 2's re-keying), unless one uses a legacy parameter or its update sets a key or index attribute (which becomes a put); `query` names its partition (and an index by name) and refuses a caller's `KeyConditionExpression`, so each query call site is rewritten when it moves; there is no Scan. `ws_s3_key(ws, …)` builds `ws/{ws}/…` keys from one path segment per part (no empty part, `.`, `..`, separator, C0 or C1 control character, DEL, U+2028 or U+2029); `ws_key` is `shared/workspace.py`'s. Nothing in the data path uses it yet. The raw-access static test, the gate step `audit: ws_raw_access` (`scripts/audit/ws_raw_access.py`): in the Lambdas' Python every raw table handle (`Table(…)`, `.client`/`.resource('dynamodb')` on any receiver, `get_dynamodb_resource()`, any `.meta.client`, any reference to a `shared/tables.py` getter through any import form, the layer's private handle by attribute or by name, and any private attribute, `vars()` or `__dict__` of a layer handle) and the S3 writes, copies and deletes it can see statically (client calls such as `put_object`, `upload_file`, `copy_object`, `copy`, `delete_object(s)`, `put_object_tagging`, a presigned PUT, POST or DELETE, `Object`/`Bucket` methods, and collection deletes such as `bucket.objects.filter(…).delete()`; its docstring lists what it misses, such as an object a collection yields), and in the stream and plan-step Lambdas the DynamoDB and S3 clients built, DynamoDB commands (PartiQL included) and S3 writes, copies and deletes, its SDK names followed through import and require aliases, outside the layer, counted per file against `scripts/audit/allowlists/ws_raw_access.json`, a ratchet: a new file or a count that grows fails, and a count that drops fails until its entry is lowered. That allowlist, grouped by the phase that moves each file (phase 2's data path, phase 3's settings, projects, assistant, MCP and boards, phase 4's retention) or the reason it stays raw (the control plane, the handle plumbing, a deploy-time custom resource), is the phase 2 to 4 work list. The cross-workspace suite, `test_cross_workspace.py` in `lambda/api/test/` (replaced in 6.18.00 by `lambda/api/test/test_cross_workspace_routes.py`, which keeps these checks: the row below): every route in its registry (today `/me/workspaces/current` and the members routes) called by a member of workspace A naming workspace B, and by callers who are in neither, answers the one 404 with the same body as an id that names no workspace, with no Cognito call and nothing written; a member of A naming B's member on `PUT` or `DELETE` inside A gets the members' 404, as for a sub that is no one's; and a route anywhere in `lambda/` (on any router) that resolves the workspace, directly or through helpers in any module, or is served under `/me/workspaces/current`, but is missing from the registry fails it. The two-workspace check on the dev mock, `frontend/e2e/tests/cross-workspace.spec.ts`, with the mock switch's `member: 'acme'` (the caller a member of acme only, and no platform admin to these routes): `/w/juniper/members` shows "Workspace not found" |
| 6.15.00 | The browser-saved state of the web app's three persisted stores, keyed by workspace (no API change; the data path is still not keyed). Inside a workspace the assistant's UI record (`voc-assistant-ui`: the conversation in view, the panel mode and toggles, and the per-tab open state in `sessionStorage`), the manual-import draft (`voc-manual-import`) and the config store (`voc-config`: the dashboard's time range, custom days and date basis, and the browser's config) are saved as `<name>:w/{slug}` (`frontend/src/workspace/workspaceStorage.ts`, the persist `name` of each store), so what one workspace saved never opens in another and is back on return; outside a workspace, and on a `/w/…` address no workspace can have (the gate's not-found, which opens no page), the names are unchanged, so a deployment without workspaces sees no change. The key is the address's slug, not the id: the stores hydrate when their modules load, before the gate has read the list, and a slug is unique and fixed (decision 15); a switch is a full page load, so a page load's stores belong to one workspace. The assistant's `pendingDraft` was never saved: it lives in memory, and a switch is a full page load. Nothing is migrated: the first visit to a workspace starts from the defaults, and the deployment-wide records stay for use outside workspaces. Sign-out and an expired session remove every workspace's record of the three stores from `localStorage` and `sessionStorage` (`forgetWorkspaceStores`), and the assistant's plain record with them; the plain draft and filters are kept, as before, and Account → "Reset local settings" clears the page's config and removes every other `voc-config` record, the plain one and each workspace's (`forgetOtherRecords`). The e2e contexts drop a workspace's own UI records with the plain ones (`frontend/e2e/lib/context.ts`). The header's workspace menu leaves out the workspaces refused in this tab (`refusedWorkspaces.ts` `withoutRefused`, the gate's own filter). The members page shows the loading state until `GET /me/workspaces/current` answers (one cache entry with the gate's, `useServerWorkspace`, not retried: both act on the first answer), then offers what the role the server applies allows, so a platform admin who is also an editor or a viewer is not shown the read-only page first; a failure of that read other than its 404 keeps the membership's role, as the gate does |
| 6.16.00 | Another tab's sign-out ends this tab's hold on the per-workspace records (no API change). The signal is an explicit one, written only where a session really ends: the sign-out (`useSignOut`) and an expired session (`endExpiredSession`) set `localStorage` `voc-session-ended` to a fresh value (`announceSessionEnded`), and the browser's `storage` event tells every other tab of the origin; no channel, polling or dependency (there was no cross-tab signal before: each tab learned of it at its next 401). Not the session's own record (`voc-auth`): `authStore.logout()` also writes it signed out when a refresh fails for a moment and the retry signs the tab back in, which must not end every other tab. On the signal (from `localStorage` only), a tab removes every workspace's record of the three stores and the assistant's plain record (`forgetWorkspaceStores`), its refused list and a platform admin's console entries (`forgetPlatformEntries`, as its own sign-out does; only its own expired session keeps them), and, when it is signed in, leaves with a full page load (`location.replace`) to the plain `/login`, as a sign-out does (since 6.17.00 a public page reloads where it is: the row below) (`frontend/src/services/crossTabSignOut.ts`, whose listener is installed when the module loads: `main.tsx` imports it, so every tab has it at startup (a test reads that import)). The full load, not an in-memory reset, is what stops its persisted stores from writing the last person's state back: it is how the app already ends a session, it drops every cache and in-flight request with them, and it needs no change to the stores. A tab already signed out stays on its page. It writes nothing to `voc-auth`, and forgets the records only while the stored session is still signed out, so a late event cannot sign out, or clear the records of, a person who signed in meanwhile in another tab |
| 6.17.00 | Two follow-ups to 6.16.00 (no API change). A tab showing a public page, one of the top-level routes outside `ProtectedRoute` (`/login`, `/vote/…`, `/board…`, `/review/…`, `/unsubscribe`), forgets the records on the signal as every tab does but, when signed in, reloads where it is (`location.reload()`) instead of going to `/login`: those pages open without a session of the app, and the reload still drops the page load's copy of the session, which `/board` and `/review` use when there is one. It decides from the address as the router sees it (`appPathname`, without the page load's `/w/{slug}`), against one list of the routes' first segments (`frontend/src/publicRoutes.ts`, held to `routes.tsx` both ways by `routes.publicBallot.test.tsx`). The order the signal depends on is pinned: the sign-out and an expired session write `voc-auth` signed out (`authService.signOut()`) before `announceSessionEnded()`, since a tab that hears the signal while the stored session still says signed in skips the wipe; `frontend/src/services/sessionEndOrder.test.ts` checks on both paths that the callers sign out (`authService.signOut()`, stood in for by the store's `logout()`) before they announce |
| 6.18.00 | The voc-multiplayer-c track merged (no data-path change: the data path is still not keyed by workspace). The cross-workspace suite, `lambda/api/test/test_cross_workspace_routes.py` (with `cross_workspace_worlds.py` and `cross_workspace_pending.py`; Phases below), replaces 6.14.00's `test_cross_workspace.py` and keeps its checks: every route of the API is named by file and route in exactly one table, workspace-scoped (today `GET /me/workspaces/current`, the four members routes, the two plugin routes, the two resolved-problems routes and the two brand routes), outside a workspace by design, or pending (phase 2 or 3); a route anywhere in `lambda/` (on any router) that reaches `resolve_workspace` through helpers in any module must be workspace-scoped. The scope of every settings row, per workspace or for the deployment, held to the code (`lambda/shared/test/test_settings_scopes.py`, Per-workspace configuration below). The assistant's reads carry the caller's `X-Workspace-Id` to the domain Lambdas, and plan steps carry the workspace their plan was approved in: `workspace_id` on the plan's META, `voc:workspace` in each step's claims, sent as the domain calls' `X-Workspace-Id` header (Request flow below). A workspace's plugins: `GET` and `PUT /me/workspaces/current/plugins[/{plugin_id}]` in the workspaces API, the `PLUGIN#{plugin_id}` / `WS#{ws}` rows the ingestors' fan-out reads, within the deployment's ceiling (Per-workspace configuration below); enabling is refused (409) and writes nothing until phase 2's data path is in. The first settings kinds under their workspace: a team's resolved problems (`GET` and `PUT /settings/resolved-problems` with `X-Workspace-Id` read and write `WS#{ws}#SETTINGS#resolved_problems`; a viewer reads, an editor or admin marks) and its brand (`GET` and `PUT /settings/brand`, `WS#{ws}#SETTINGS#brand`: any member reads, the workspace's admins change it, `require_settings_admin`; the deployment's `admins` group grants nothing there; the engagement API's emails and boards still read the deployment's brand name until they move); without the header, the deployment's rows and rules as before. In the web app the brand form (Administration → General, behind `AdminRoute`) is reachable only by the deployment's `admins` for now, and inside a workspace it is editable only by those who are also that workspace's admins (`frontend/src/pages/Settings/useBrandEditRight.ts`); opening it to every workspace admin was the next web-app slice (since 7.02.00 they edit it on the workspace's settings page: the row below). The deployment-wide brand is edited outside a workspace, so it is unreachable from the web app for anyone who has a workspace (the gate always enters one, `frontend/src/workspace/gateDecision.ts`); the platform console gained a "deployment default" editor in the next web-app slice (7.02.00, the row below). Both go through the domain APIs' shared resolution (`lambda/shared/request_workspace.py`) and the stack's one workspace-resolution managed policy, which the audit-row guard now guards like a role. The deployment-wide settings' writes need the deployment's `admins` and a live platform admin (`require_admin`, `require_platform_admin` and `lambda/shared/platform_admin_gate.py`'s live check): `PUT /settings/appearance` and the alert writes (Per-workspace configuration below; in the route-gate inventory as admin-only and platform-admin-only) |
| 7.00.00 | The voc-multiplayer-b track merged: phase 2 starts, the data path's repository layer, plugin ingestion in a workspace and the feedback processor in a workspace. Enabling a plugin still answers 409 and writes no `PLUGIN#` row, and no API sends a `workspace_id` to an ingestor, until the retention slice lands (Per-workspace configuration below): nothing in the app starts a workspace's run yet. **The layer** `lambda/shared/ws_repo.py` and its raw-access guard. Phase 2 starts: the data path's repository layer `lambda/shared/ws_repo.py` and its raw-access guard. `WorkspaceScope` is a verified workspace, made only from a resolved request (`scope_of`), an asynchronous message's `workspace_id` (`scope_from_message`) or a stored `WS#{ws}#…` key (`scope_from_key`). The key builders (over `ws_key`): the feedback item `WS#{ws}#SOURCE#{source}` / `FEEDBACK#{id}`, the index partitions `WS#{ws}#DATE#`, `#CATEGORY#` and `#URGENCY#` (gsi1 to gsi3), and `#FEEDBACK#` and `#CHANNEL#` for gsi4 and gsi5 (`gsi4pk` / `gsi5pk`, the indexes re-keyed by the processor's slice, below); the counters `WS#{ws}#METRIC#{name}` and their `metric_type` `WS#{ws}#{kind}`, `WS#{ws}#SOURCE_RUN#{source}`, the watermarks' `WS#{ws}#{plugin}#{key}`, objects `ws/{ws}/…` with no empty, `.` or `..` segment. `ws_table(scope, table)` refuses, before any call reaches DynamoDB, a key, an item, a query or a client's cursor outside the workspace, an update that sets a partition attribute (named or aliased) other than from one placeholder holding a key of the workspace (it also refused any write of `feedback_id` or `source_channel` until the processor's slice, below, re-keyed gsi4 and gsi5; a test holds every voc-feedback index partition to the attributes it checks, against `lib/stacks/core-stack.ts`); it builds every query's key condition itself. The guard (`lambda/shared/test/test_ws_raw_access.py`) counts, per production module and per kind, the raw table and bucket calls (`.Table(`, `.put_object(`, `.copy_object(`, `.upload_file(`, `.upload_fileobj(`, `.generate_presigned_url(`, `.generate_presigned_post(`, `.delete_object(`, `.delete_objects(`, `get_feedback_table()`, `get_aggregates_table()`, `cached_table(`, aliases included; ported from 6.14.00's audit: `.copy_from(`, `.put_object_tagging(`, `.create_multipart_upload(`, a managed `.copy(CopySource=…)`, a resource collection's batch `delete()`, `put` or `delete` on an `Object(…)` or `Bucket(…)` made in the same expression, any `.meta.client`, any reference to those getters, called or not, and the layer's private handle `_unscoped_table`) and the strings that start an unscoped data-path key (`SOURCE#`, `METRIC#`, `DATE#`, `CATEGORY#`, `URGENCY#`, `CHANNEL#`, `SOURCE_RUN#`, `raw/`, `silver/`); its allowlist names each module not moved yet with the phase that moves it (or phase 0: it stays raw by design, the control plane and the handle plumbing) and must match exactly: a new raw access fails unless its entry is raised in the same change, which review refuses. It also pins that only the layer builds a `WorkspaceScope` and that no request-facing module (the API, the public webhooks) takes one from a message or a key (the one asynchronous worker under `lambda/api/`, `manual_import_processor.py`, may). It does not see keys joined without a literal prefix, low-level clients built directly (`boto3.client(…)`, `get_dynamodb_resource()`), S3 reads or the stream and plan-step Lambdas' TypeScript (6.14.00's audit did; not ported, below). Each `ws_table` call takes only the boto3 parameters listed for it (`ALLOWED_OPTIONS`, ported from 6.14.00's layer): a `TableName` (which boto3 lets override the table) and the legacy `AttributeUpdates`, `Expected`, `KeyConditions`, `QueryFilter`, `ConditionalOperator` and `AttributesToGet` are refused before DynamoDB; and a table's scope, key and handle cannot be changed once built (`__slots__`, read-only properties). **Plugin ingestion.** Phase 2's plugin ingestion gains a workspace path beside the deployment-wide one (the scheduled ingestors and S3 import, `plugins/*/ingestor`; the webhooks are not moved). `plugins/_shared/base_ingestor.py` `run_in_workspace` routes each event: one that names a workspace in `workspace_id` runs in it (the scope from `scope_from_message`); one whose `workspace_id` is present but not a workspace id is refused (`{"status": "refused", "reason": "invalid_workspace"}`, logged and metered `IngestorEventRefused`, nothing read or written, never run deployment-wide instead); one that names none (the integrations API's Run now, the scrapers API's run, the S3 import API's reprocess, a plain S3 upload's trigger) runs deployment-wide exactly as before: the watermarks `{plugin}#{key}`, the `SOURCE_RUN#`, `SCRAPER_RUN#` and `IMPORT_RUN` rows, the breaker's `FAILURES#`/`CIRCUIT#` rows and its schedule-rule disable on a trip, the shared `SECRETS_ARN` secret, raw objects under `raw/…`, no `workspace_id` on the message. The deployment-wide path stays until phase 2's last slice moves the API, the S3 trigger and the processor onto workspaces, and is then removed. The scheduled tick (an EventBridge `Scheduled Event`) first fans out, at most once per tick (`fan_out_once`), then runs the deployment-wide run as before (fanning out first means a deployment-wide run that raises or times out never keeps the workspaces from their tick). The fan-out claims the tick in `voc-idempotency`, `ingestor#fanout#{plugin}#{EventBridge event id}` (`lambda/shared/idempotency.py` `dedupe_claim_item`, the same conditional put and two-day TTL the aggregator uses), so Lambda's asynchronous retries of a tick whose deployment-wide run raised find the claim and fan out no second time; it then reads the workspaces that enabled the plugin, `workspaces_with_plugin(table, plugin_id)` in `lambda/shared/workspace_plugins.py` (one paged, consistent Query of `voc-workspaces` partition `PLUGIN#{plugin_id}`, sort keys `WS#{ws}`, well-formed ids only), and invokes its own function asynchronously once per workspace with `{"workspace_id": ws}` only (`plugins/_shared/self_invoke.py`, shared with the app-review continuation parts). A claim that cannot be made (no table, no event id, a DynamoDB error) or a list read that fails is logged and counted (`IngestFanOutFailures`) and no workspace runs on that tick; a failed invoke is counted the same way and the other workspaces still run; the next tick tries again, each workspace catching up from its own watermarks. None of it changes the deployment-wide run's outcome or Lambda's retries of it. Nothing writes `PLUGIN#` rows yet (the per-workspace plugin settings will), so every tick fans out to no workspace. A continuation part of a run in a workspace carries its `workspace_id`. What a run in a workspace keeps is the workspace's: watermarks `WS#{ws}#{plugin}#{key}`, run rows `WS#{ws}#SOURCE_RUN#{plugin}` (and the web scraper's `WS#{ws}#SCRAPER_RUN#{id}`), the S3 import's history rows `WS#{ws}#IMPORT_RUN` and `WS#{ws}#IMPORT_RUN#{run_id}`, the circuit breaker's `WS#{ws}#FAILURES#{plugin}` and `WS#{ws}#CIRCUIT#{plugin}` (its trip stops that workspace's runs and disables no rule, which serves every workspace; a deployment-wide trip still disables the plugin's one rule, as `PUT /sources/{source}/disable` does, and so stops every workspace's scheduled runs too until the source is enabled again), raw objects `ws/{ws}/raw/{source}/{yyyy}/{mm}/{dd}/{stem}/{sha16}.json` and the S3 import's original file there too (`lambda/shared/raw_versions.py` `item_folder` with a scope; `parse_item_key` reads both roots), every table opened through the layer (`lambda/shared/ingest_tables.py`: `ws_table` in a workspace, the table itself deployment-wide). The layer's table view now knows its key (`ws_table(scope, table, key='pk'|'source')`): `source` is plain data only on a `pk` table, and on voc-watermarks every partition attribute an item carries must be in the scope. Its credentials come from the workspace's own secret, `{prefix}/{ws}/credentials`, named from the scope only (`credentials_secret_name` in `lambda/shared/workspace_ids.py`, which the workspaces API uses too), still filtered by plugin namespace, and its queued messages carry `workspace_id`, set from the scope after every field of the item; `IngestMessage` accepts it as an optional, well-formed id (the processor reads it since the processor's slice, below). IAM: each ingestor role keeps the deployment-wide grants (the shared secret, `raw/*` puts, `CIRCUIT#*` deletes, `events:DisableRule` on its own rule) and gains `GetSecretValue` on `voc/ws/*` (every workspace's secret: only the code, which names the secret from the verified scope, keeps a run to its own workspace's credentials, decision 1's soft isolation), puts under `ws/ws_??????????????????????????/raw/*` and deletes of `WS#ws_??????????????????????????#CIRCUIT#*` (the workspace segment is one id, `ws_` and 26 `?`: IAM's `*` also matches `/` and `#`); each scheduled role may put only its own claim keys (`ingestor#fanout#{plugin}#*`) in `voc-idempotency`, Query `voc-workspaces` for its own `PLUGIN#{plugin}` partition only and invoke only its own function (the manifest's `selfInvoke` is gone: every scheduled role has that grant, and a manifest still naming it fails its load). The raw bucket's write-once policy covers `ws/ws_??????????????????????????/raw/*` and `ws/ws_??????????????????????????/silver/*`, and no lifecycle rule reaches `ws/`. Not yet: the APIs send no `workspace_id` and read only the deployment-wide run, history and breaker rows (`lambda/shared/plugin_circuit.py`: its status and reset do not reach a workspace's breaker; an operator resets one by deleting its `WS#{ws}#CIRCUIT#{plugin}` / `TRIPPED` row); the import bucket is not keyed by workspace; the API still saves plugin credentials in the shared secret, so a workspace's secret holds none until the per-workspace plugin settings write them; voc-retention's erasure and the category reprocess's raw mode do not reach `ws/{ws}/raw/` (due before workspaces ingest; nothing in the app starts a workspace's run yet, so nothing is written there); the webhooks keep the shared secret and `raw/`. **The processor.** Phase 2's feedback processor (`lambda/processor/handler.py`, the processing queue's consumer) gains the same two paths, chosen per message by `workspace_id` (`message_scope` in `lambda/shared/ws_repo.py`, which the ingestors' `run_in_workspace` uses too). A message that names a workspace is stored in it: the item `WS#{ws}#SOURCE#{brand_name or source}` / `FEEDBACK#{id}` with `gsi1pk` to `gsi5pk` all `WS#{ws}#…` (`lambda/shared/feedback_partitions.py` over the layer's builders), written (`attribute_not_exists(pk)`), checked for a duplicate, read back and refreshed in place (issue refreshes, CSV corrections, their re-enriched `gsi2pk` / `gsi3pk`) through `ws_table`, which refuses any key, item or update partition outside the workspace before DynamoDB; its `LOGS#` rows under `WS#{ws}#LOGS#validation#{source}` and `WS#{ws}#LOGS#processing#{source}`; its idempotency key `WS#{ws}#{source}:{id}[…]`, so the same source item queued in two workspaces (one `feedback_id`, two partitions) is processed in each; its kept Silver versions under `ws/{ws}/silver/{source}/{id}/` (`keep_silver_version(…, scope=)`, which keeps nothing, counted in `SilverVersionFailures`, for an item whose `pk` is not in the scope it is kept in) and its inline `raw_data` fallback under `ws/{ws}/raw/`. A message that names none is stored deployment-wide exactly as before. A message whose `workspace_id` is there but is not a workspace id (an explicit `null` included, which the schema alone would read as "none") is rejected like any invalid message (`MessageRejectedError`: retried, then the processing DLQ), logged deployment-wide without content (`LOGS#validation#{source}`, error `workspace_id: invalid_workspace`) and counted (`ValidationFailures`, `WorkspaceMessagesRefused`), never processed deployment-wide. gsi4 (`gsi4-by-feedback-id`) and gsi5 (`gsi5-by-channel`) were keyed on the raw `feedback_id` and `source_channel`, the same in every workspace, so a deployment-wide read by id or channel would have found a workspace's item: `lib/stacks/core-stack.ts` re-keys them onto `gsi4pk` and `gsi5pk` (same names, so `lambda/shared/indexes.py` stays; gsi4 still projects every attribute, gsi5 also projects `source_channel`, no longer its key), and the processor writes both on every new item: deployment-wide `FEEDBACK#{id}` and `CHANNEL#{channel}` (a missing, null or empty channel is `unknown`, as a CSV correction sets it), in a workspace `WS#{ws}#FEEDBACK#{id}` and `WS#{ws}#CHANNEL#{channel}`. Every reader of the two indexes queries the deployment-wide partition (`metrics_handler.py`, `data_explorer_handler.py`, `feedback_edit_handler.py`, `shared/channel_index.py`, the stream Lambda's `queryFeedbackById`; the persona preview's sampling Scan of gsi4 leaves workspace items out of its count); the layer no longer refuses `feedback_id` and `source_channel` (`UNSCOPED_INDEX_ATTRIBUTES` is gone, and its lockstep test now holds every voc-feedback index partition to `PARTITION_ATTRIBUTES`). Decision 12: items stored before carry neither attribute and are not migrated, and DynamoDB changes one index per table update, so an existing deployment does not take 7.00.00 as is ([Upgrading](#upgrading)). A CSV correction that changes the channel moves `gsi5pk` with it (in the item's workspace for an item of one); no other in-place change sets `source_channel` or `feedback_id`. Only a plugin ingestor's run in a workspace names one on a message: the source policy every producer applies (`apply_source_policy`, `lambda/shared/source_policy.py`) drops a `workspace_id` from what it returns, so a request body (`PUT /data-explorer/s3` with `sync_to_dynamo`, a form, an import) or a source payload never chooses the workspace its feedback lands in, and `lambda/shared/test/test_ws_raw_access.py` pins that no request-facing module writes the field into a mapping. The deployment-wide whole-table readers leave workspace items out (`WS#` partitions): the aggregator skips every stream record of one and counts it (`AggregatorWorkspaceRecordsSkipped`), so workspace items are not aggregated yet (no `WS#{ws}#METRIC#` rows; the aggregator's slice); `scripts/retention/rebuild_aggregates.py` skips them too, and so does `scripts/retention/remove_ttl.py` (a workspace's item never lowers the deployment's earliest-date watermark); `voc-retention`'s retention and erasure Scans and the category reprocess's Scan do not reach them (their raw objects and Silver versions under `ws/{ws}/` are out of those jobs' reach, and a deployment-wide `silver/{source}/{id}/` could be a deployment item's with the same id): an erasure does not reach a workspace's feedback items yet, due before workspaces ingest. Settings stay the deployment's: a workspace's message is enriched with the deployment's categories, dimensions and source profiles (PII policy, retention, raw-copy policy) until the per-workspace settings land (phase 3). Radar is not keyed by workspace (phase 3): a workspace's message that Radar would claim (a `radar_brand_key`, or a source profile that names a Radar brand) is refused (`WorkspaceRadarRefusedError`, counted `WorkspaceRadarRefused`: retried, then the DLQ), never written to the deployment's `voc-radar` nor as the workspace's own feedback. IAM: the processor's role gains write-once puts under `ws/ws_??????????????????????????/raw/*` and `ws/ws_??????????????????????????/silver/*` (one workspace id, as the bucket policy pins). Not yet: no producer queues a workspace message but the plugin ingestors' runs in a workspace, which nothing in the app starts; the read APIs, `GET /logs/*` and the feedback edits read deployment-wide partitions only (a workspace's items, logs and history are not readable through them); the aggregator's workspace counters; the webhooks, forms, email intake, manual and S3 imports send no `workspace_id`. **Retired:** 6.14.00's layer `lambda/shared/ws_repository.py` (its `TABLES` registry of ten tables held to `lib/stacks/core-stack.ts` both ways, `ws_s3_key`) and its audit step `audit: ws_raw_access` (`scripts/audit/ws_raw_access.py`, `scripts/audit/allowlists/ws_raw_access.json`): `ws_repo.py` and `test_ws_raw_access.py` replace them, and gsi1-by-status (voc-jobs) is again an index no Lambda names. Not ported: the stream and plan-step TypeScript scan (`lambda/stream/src`: clients, commands, PartiQL, import and require aliases; regex over source text, left to phase 3, which moves that code), the low-level clients built directly, an `Object` held in a name, a presigned URL told apart by its method (the guard counts every `generate_presigned_url`), and the ten-table registry (the layer wraps the table it is given; its lockstep tests hold voc-feedback's, voc-aggregates' and voc-watermarks' partitions to core-stack.ts, the only tables it serves until phase 3). Its update guard was not ported: `ws_repo.py`'s already resolves every `#placeholder`, `#0` included, and checks the value it sets |
| 7.01.00 | The voc-multiplayer-c track's model slice merged (the brand per workspace, its other slice, came with 6.18.00, the row above; the web app's brand form already follows its gate, `useBrandEditRight`). The model pinned at deploy has a deployment row of its own, `SETTINGS#model_default` (`model_id`), read below every pick by every resolver (`lambda/shared/model_config.py`, the stream Lambda's `bedrock/model-override.ts`, the product-doc extractor); `GET /settings/model` names it (`deployment_default`), which Administration → AI models shows as what Automatic uses when no model is picked for all surfaces; the pin's custom resource may update only that row. The first step of the model picker per workspace: the picks (`SETTINGS#model`) can now move without the default. A deployment from before keeps its earlier pin in `model_id`, which still applies (Per-workspace configuration below) |
| 7.02.00 | The web app's side of a workspace's brand and plugins, and the deployment's default brand (no API change; the data path's state is 7.00.00's). Inside a workspace, `/w/{slug}/workspace-settings` (`frontend/src/pages/WorkspaceSettings/`), reached from Workspace settings in the header's workspace menu beside Members (outside one the address is the app's "Page not found"). It waits for the role the server applies (`/current`, `useServerRole` in `frontend/src/workspace/useMyWorkspaces.ts`, which the members page and the brand form's `useBrandEditRight` now share). The brand: `GET` and `PUT /settings/brand` with the workspace's `X-Workspace-Id`; its admins save it, whether or not they are in the deployment's `admins`; editors and viewers see it read-only; a 403 says "Only this workspace's admins can change its brand". Administration → General stays behind `AdminRoute`, and inside a workspace its read-only notice names the workspace's admins. The plugins: `GET /me/workspaces/current/plugins`, every plugin the deployment offers with whether the workspace enabled it, for every member; a workspace admin gets Enable or Disable (`PUT …/plugins/{plugin_id}`). The list does not say that enabling is held, so the page learns it from the 409 (`INGESTION_NOT_YET`, matched by the server's text and held to the Python constant by `frontend/src/workspace/workspaceRefusals.lockstep.test.ts`): it says "Per-workspace ingestion arrives with a later release: a workspace cannot enable a plugin yet" and offers Enable no more on that page; a disable answers as the server allows (no `PLUGIN#` row exists yet). The page says every plugin still collects feedback for the whole deployment. The deployment's default brand: Administration → Privacy & access → Workspaces (platform admins) gains a Deployment default brand editor below the workspaces, `GET` and `PUT /settings/brand` with NO `X-Workspace-Id` from any address, a workspace's included: the API client's request scope (`fetchApi(…, 'deployment')`, `RequestScope` in `frontend/src/api/baseUrl.ts`, on the first try and the 401 retry) is the only way to leave the header off inside a workspace. Its Save follows the server's gate for a request without the header, the deployment's `admins` (`require_settings_admin` → `require_admin`; not the live platform-admin check), and a 403 says so. The dev mock serves the plugins routes and the brand per workspace (`frontend/mock-workspace-settings.js`: every enable 409 with the server's reason, a disable answered, a brand per mock workspace for its admins) beside the deployment's brand without the header, and `GET /settings/model` names `deployment_default` (null); `frontend/e2e/tests/workspace-admin.spec.ts` runs both flows against it. Still not keyed by workspace: everything phase 2 and 3 have not moved; enabling a plugin still answers 409 |
| 7.03.00 | The voc-multiplayer-b track's retention slice merged. An erasure and a retention window reach a workspace's data (TENETS.md D5; docs/source-policies.md, "Workspace items"). The scope rule: an erasure job stays the deployment's (`POST /settings/erasure`, a deployment admin, `voc-retention`), and an erasure by `email` (with or without a source) reaches every workspace's matching items (`WS#{ws}#SOURCE#…` / `FEEDBACK#…`) in the same item Scan as the deployment's (`lambda/shared/retention.py` `reaches_workspaces`): a person's data is erased wherever it is, and Administration's erasure form and confirm dialog say so. An erasure by `author`, `source_id` or `csv_row_id` stays the deployment's: an author is a display name, not unique even within one source, and an id is unique only within one source account or upload while each workspace has its own (the deployment's ticket 12345 is not a workspace's); they reach workspaces when a job can name its workspace (until then an author erasure does not reach a workspace's copies: erase by email). A retention window reaches them too: a workspace's messages are processed under the deployment's source profiles (PII and raw-copy policy; `plugins/_shared/raw_original.py` keeps no whole-file original for a source with a window, because the window deletes item by item), so the profile's window binds their items until per-workspace profiles replace the deployment's for workspaces (phase 3). A whole-source erasure (`field: source`) does not: it is a request about the deployment's own source. Each workspace item is tombstoned before it is deleted, in the same partition as the deployment's, `AUDIT#tombstone#<source>`, with `sk` `{ws}#{feedback_id}` and `workspace_id` on the row (`lambda/jobs/retention/copies.py` `tombstone_key`): the audit-row guard (`lib/utils/audit-row-guard.ts`) pins `AUDIT#*` leading keys, so a `WS#{ws}#AUDIT#…` partition would be outside it, and the workspace in the sort key keeps two workspaces' copies of one source item (one `feedback_id`) and the deployment's apart. Then the item goes with every copy under its own workspace (`retention.delete_item`, the scope from its `pk`, `ws_repo.partition_scope`): every Silver version under `ws/{ws}/silver/{source}/{feedback_id}/` and every version of its raw objects under `ws/{ws}/raw/` (its `s3_raw_uri` is followed only under its own workspace's bronze root, `raw_versions.raw_root`, as a deployment item's only under `raw/`), then the item through `ws_table`. A row whose partition starts `WS#` but names no workspace is never handled as the deployment's: an erasure fails before that row, or anything after it on its page, is deleted, and stops there; the daily retention run skips and counts it (`unscoped_rows_skipped`, `RetentionUnscopedRowsSkipped`), so the deployment's windows keep running (the runbook is in docs/source-policies.md). The job and audit rows count them (`deleted_workspace_items`, part of `deleted_items`, written once above 0; the erasure API's job view and Administration's erasure job details show it); a run that deleted only workspace items does not run the lineage pass (no artifact cites a workspace item until projects move, phase 3; its tombstone key `{ws}#{feedback_id}` never matches the pass's lookup). The time budget and cursor are the item Scan's, unchanged: a hand-over mid-page resumes after the last erased item, a workspace's or not. An S3 import's original (`ws/{ws}/raw/s3_import/…`, as the deployment's `raw/s3_import/…`) is linked from no row, so an erasure that deletes an import's item keeps it (IAM denies voc-retention any delete under `ws/ws_??????????????????????????/raw/s3_import/*`) and lists that folder on `files_needing_review` when it holds a file (`retention.import_originals_prefix`; Administration lists it as a folder). The category reprocess stays deployment-wide (it skips `WS#` items and writes unprefixed `CATEGORY#` / `URGENCY#` partitions); a workspace's reprocess comes with the workspace's settings (phase 3). D3's replay of a workspace's bronze is ready at the unit level: `raw_versions.parse_item_key` reads `ws/{ws}/raw/` keys and the raw mode's reader follows a review's link only under its own scope's root (`_raw_key`); its role still reads `raw/*` only, and gains `ws/{ws}/raw/*` with the route that starts a workspace's reprocess. IAM: `voc-retention` deletes (DeleteObject, DeleteObjectVersion) and lists versions under `ws/ws_??????????????????????????/raw/*` and `ws/ws_??????????????????????????/silver/*` too (one workspace id per pattern), pinned by `lib/stacks/processing-stack-retention.test.ts` and, with its reason (D5, legal obligations), `lib/customer-data-deletes.test.ts` |

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

## Upgrading

Multi-workspace starts on a fresh deployment (decision 12): an existing deployment does not take the release that
re-keys gsi4 and gsi5 (7.00.00, the processor's slice above) in place, and nothing is migrated.

- Why: `gsi4-by-feedback-id` and `gsi5-by-channel` move from the raw `feedback_id` and `source_channel` to
  `gsi4pk` and `gsi5pk`. Changing an index's key is a delete and a create, and DynamoDB allows one index change per
  table update, so CloudFormation refuses the update. And items stored before carry no `gsi4pk` / `gsi5pk`: they
  would be in neither index, so every lookup by id (`GET /feedback/{id}`, the feedback edits, the Data Explorer, the
  assistant) and every channel filter would miss them.
- An operator who must upgrade an existing deployment re-keys in steps, one deploy each: remove gsi4; add gsi4 on
  `gsi4pk`; remove gsi5; add gsi5 on `gsi5pk` (pinning `lib/stacks/core-stack.ts` to each intermediate shape), and
  backfills every `FEEDBACK#` item with `gsi4pk = FEEDBACK#{feedback_id}` and, where `source_channel` is not empty,
  `gsi5pk = CHANNEL#{source_channel}` (a paged Scan and conditional updates) before relying on either index. Until
  the backfill ends, reads by id and by channel miss the items not yet updated.

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
| `PLUGIN#{plugin_id}` | `WS#{ws}` | a plugin of the deployment the workspace enabled (enabled_by, enabled_at; since 6.18.00, Per-workspace configuration): one partition per plugin, which its scheduled ingestor reads to fan out over the workspaces that enabled it; deleted when it is disabled. None is written until the hold lifts (enabling answers 409; Per-workspace configuration below) |
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
    `AUDIT#platform-admins`, in the route-gate inventory). Since 6.13.00 Administration → Privacy & access → Users
    shows it to platform admins, with a box per user;
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
   the picker is skipped; with none, it says so and names who can invite them. Since 6.12.00 (the table above) the
   picker and the one-workspace skip are built; a person with no workspace still gets the app as before workspaces,
   because the data path is not keyed by workspace yet. The "no workspace, ask who can invite you" screen comes with
   phase 2, when the data path requires a workspace.
2. The web app keeps the current workspace in the URL (`/w/{slug}/…`) and sends `X-Workspace-Id` on every API call.
3. Shared middleware (a new `workspace` module in the Lambdas' shared package, and its TypeScript twin in the stream
   and plan-step Lambdas)
   resolves the caller's membership (cached in the warm container for a short time), answers **404** when the caller
   is not a member (a 404, not a 403, so ids of other workspaces are not confirmed), and puts `{ws, role}` on the
   request context. A platform admin passes as a workspace admin once the live check confirms them (Control plane),
   and the entry writes an `AUDIT#` row that the workspace's own admins can see.
4. All data access goes through a workspace-scoped repository layer (`lambda/shared/ws_repo.py`: a verified
   `WorkspaceScope`, the key builders over `ws_key(ws, …)`, `s3_key(scope, …)` for objects and `ws_table(scope,
   table)`). A static test (`lambda/shared/test/test_ws_raw_access.py`) counts the raw table and bucket calls it
   knows and the strings that start an unscoped data-path key outside that layer (the 7.00.00 row above lists them
   and what it does not see yet), kind by kind, against an allowlist of the modules not moved yet
   that must match exactly, so a new raw access fails unless its entry is raised in the same change (which review
   refuses) and a removed one must lower it.
5. `require_admin` becomes `require_role('admin')`: a workspace admin, or a platform admin. The route-gate inventory
   (`lambda/api/test/test_route_admin_gates.py`) gains the workspace dimension: every route is classified as
   workspace-scoped, platform-only or public, as well as admin-only or open.

Asynchronous paths carry the workspace explicitly and never infer it from the caller: SQS messages, Step Functions
inputs, Lambda async payloads, DynamoDB Stream records (the workspace comes from the key prefix), memory extraction,
agent runs, plan steps and assist jobs.

The assistant's reads (the stream Lambda calling the domain Lambdas as the signed-in person,
`lambda/stream/src/assistant/tools/internal-api.ts`) carry the caller's own `X-Workspace-Id` since 6.18.00: the
stream request's header (`assistant/runtime/event.ts`, as it came, not judged there; the web app sends it once it is
inside a workspace, Request flow step 2) goes on every domain call as its `X-Workspace-Id` header, never as a claim,
and each domain Lambda answers it exactly as it answers the caller's own request (membership, the 400 and the one
404). So a route that moves into its workspace keeps working for the assistant. Plan steps carry it too (since
6.18.00): the approval's `X-Workspace-Id` is kept on the plan (one that is not a workspace id is the one 404) and each step names it to the
domain Lambdas the same way ([Assistant plan mode](assistant-plan-mode.md#identity-and-permissions)). And the global
MCP tools (Unreleased): a token minted inside a workspace (`POST /connect/tokens` with `X-Workspace-Id`), and an
OAuth sign-in approved inside one (`POST /connect/oauth/consent`, the grant row), each resolved fresh by
`lambda/shared/mcp_workspace_pin.py` with the person's own membership (a platform admin who is not a member gets 403,
"add yourself as a member first", since the credential's calls carry no group), pins it on its row (`workspace`, `lambda/shared/mcp_global_tokens.py`
`token_workspace`), and every call the endpoint delegates sends it as `X-Workspace-Id` (`lambda/shared/mcp_delegate.py`
`build_proxy_event`), from the row, never from the MCP request; a token minted with no workspace sends none, as
before. A delegated credential has no membership of its own: `lambda/shared/workspace.py` resolves the person it
acts for (`member_subject`: the minter; an agent's owner too, once agent runs carry a workspace), so removing the minter from the workspace stops
the token there (the one 404), and it acts at most as an `editor` (an admin's credential administers nothing, as for
projects). The token and sign-in lists, detail and revoke stay the person's own, across the workspaces their
credentials name (each names its `workspace_id`).

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
  (remove themselves). A person with no workspace left gets the app without a workspace (until phase 2, Request
  flow step 1).
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
  Since 6.18.00 the workspaces API has the routes of a workspace's plugins (`lambda/shared/workspace_plugin_settings.py`),
  though a workspace cannot enable one yet (Not yet, below):
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
  on or off, and when) is the workspace's append-only `AUDIT#WS#` rows, as for a membership (D2). The web app lists them on the workspace's settings page (since 7.02.00: Workspace settings in the header's
  workspace menu, with Enable and Disable for its admins); its menu does not read them yet; today every plugin of
  the ceiling still deploys as before (the ceiling stays the one `cdk.context.json` sets).
  **Not yet (since 6.18.00; still held in 7.03.00, which brings the retention slice, until the change that lifts
  it, below):** enabling answers 409 "Per-workspace
  ingestion arrives with phase 2 of multi-workspace: a workspace cannot enable a plugin yet", to everyone, before the
  workspace is resolved, and writes nothing, not even an audit row (`PER_WORKSPACE_INGESTION` in
  `lambda/shared/workspace_plugin_settings.py`, off); the workspaces role holds no PutItem on `PLUGIN#*` meanwhile. A
  `PLUGIN#` row is what the ingestor's tick fans out over, into the workspace's `ws/{ws}/raw/`. Since 7.00.00 the
  processor keys those items by workspace, and since 7.03.00 an erasure by email and a retention window reach them
  (D5); a workspace's items are still not aggregated or readable through the read APIs (the aggregator's and the read
  APIs' slice), the category reprocess does not replay them (D3), and a workspace's credentials secret holds none until
  the plugin settings write it. Disabling still answers (with no row written, it changes nothing); the list shows
  every plugin as not enabled. No API sends a `workspace_id` to an ingestor meanwhile (Run now, the scrapers' run and
  the S3 import's reprocess run deployment-wide), so nothing in the app starts a workspace's run. Lifting the hold is
  two changes in one release: `PER_WORKSPACE_INGESTION = True`, and `'PLUGIN#*'` back in the workspaces role's
  `WORKSPACE_WRITE_PARTITIONS` (`lib/stacks/api-workspaces-lambda.ts`, with its pin in the stack test). The row stays `PLUGIN#{plugin_id}` /
  `WS#{ws}` (`enabled_by`, `enabled_at`), the shape the ingestors' fan-out reads (its workspace from the sort key).
- The model picker is per workspace; the model allowlist stays deployment-wide.
- Brand configuration (name, products, the tone the AI uses) is per workspace; the logo and colours stay global.

Every settings row and its scope (since 6.18.00; `voc-datalake/lambda/shared/test/test_settings_scopes.py` holds this
table and the files that spell each key to the code, so the files still to move only shrink). A workspace kind moves
to `WS#{ws}#SETTINGS#<kind>` in phase 3; a deployment kind keeps `SETTINGS#<kind>`. The first kind has moved
(6.18.00): `resolved_problems`. A request to `GET` or `PUT /settings/resolved-problems` that names a workspace
(`X-Workspace-Id`) acts in it (`lambda/shared/request_workspace.py`, the workspaces API's rules: the one 404 for a
malformed id, a missing workspace or a caller who is not a member; a platform admin enters as admin, checked live and
audited) and reads and writes `WS#{ws}#SETTINGS#resolved_problems` / `config` in `voc-aggregates` (the key from
`lambda/shared/workspace_settings.py`): any member reads (still only the problems under the categories they may see),
an editor or an admin marks one resolved or not (403 for a viewer). A request that names none (no header, or a blank
one) is the deployment as before: the deployment-wide row `SETTINGS#resolved_problems`, which every signed-in user
reads and marks, as today. That is what the web app sends with no workspace (since 6.12.00 the web app
opens "as before, with no header" on an address without a slug or for a person with no workspace), what a deployment from before workspaces
gets (decision 12: no migration), and what an MCP token minted with no workspace sends; it never reaches a
workspace's row. So nothing changes for those, and a workspace starts with no marks of its own: the deployment's
marks are not copied into it (a mark expires anyway, and setting it again is one click). This mode goes when every
deployment runs inside a workspace (a first workspace made at bootstrap, at the phase 2 cut-over; agreed with the
multi-workspace lead); a later kind that
moves before then decides it again, for its own readers. Upgrade note for the release: nothing to do; the deployment's marks stay where
they are and keep working without a workspace, and a workspace's members see only their workspace's marks. The
settings API reads `voc-workspaces`' `WS#*` rows and puts only a new entry audit row in `AUDIT#WS#*` there, through
the stack's one workspace-resolution managed policy (`voc-datalake/lib/utils/workspace-resolution-grants.ts`), which
every domain API that moves into its workspace attaches; the audit-row guard now guards a customer-managed policy in
itself, like a role, and names this one a writer of that partition only. The Lambda gets `WORKSPACES_TABLE` and
keeps the Cognito reads it already had. The brand follows (6.18.00), the same way: with
`X-Workspace-Id`, `GET /settings/brand` reads `WS#{ws}#SETTINGS#brand` for any member and `PUT` writes it for the
workspace's admins only (`require_settings_admin` in `lambda/shared/request_workspace.py`: an admin of the workspace;
the deployment's `admins` group grants nothing inside a workspace, decision 2); without it, the deployment's
`SETTINGS#brand` and its `admins`, as before. A new workspace starts with an empty brand (nothing is copied). In the web
app (since 7.02.00) a workspace's admins edit its brand on the workspace's settings page (`/w/{slug}/workspace-settings`,
Workspace settings in the header's workspace menu), whether or not they are in the deployment's `admins`; its other
members see it read-only there. The deployment-wide brand is edited in the platform console (Administration → Privacy &
access → Workspaces → Deployment default brand), whose calls send no `X-Workspace-Id` from any address
(`frontend/src/api/brandApi.ts`, the client's `'deployment'` request scope), for the deployment's `admins`, the gate
the server applies to a request without the header. Still on
the deployment's brand until they move: the engagement API's participant emails and feedback boards
(`lambda/shared/engagement_config.py` `brand_name`, phase 3 with the participants' settings). The categories, the dimensions and the source profiles
can be read per workspace (Unreleased): their readers accept a workspace scope, but no caller passes one yet, and the
settings routes still edit only the deployment's rows. Every read of the three goes through one module,
`lambda/shared/workspace_config.py` (`get_config_item`: a workspace's row
`WS#{ws}#SETTINGS#{categories,dimensions,sources}` through `lambda/shared/ws_repo.py` `ws_table`, else the deployment's
`SETTINGS#{kind}`), from each kind's owner, each with an optional workspace scope (`lambda/shared/ws_repo.py`
`WorkspaceScope`; the caches keep one entry per workspace): `read_categories_config` (`shared/category_gate.py`) and
the cached `get_raw_categories_config` (`shared/api.py`), the processor's `load_categories_config`
(`shared/categorization.py`), `load_dimensions_config` (`shared/dimension_config.py`), `load_source_profiles`,
`cached_source_profile_strict` and `source_profile_configured` (`shared/source_profiles.py`), and the access checks every feedback route runs,
`scope_for_caller` / `scope_for_event` and `read_restricted_sources` (`shared/category_gate.py`, their `workspace`).
`GET` and `PUT /settings/categories`, `/settings/dimensions` and `/settings/sources` stay the deployment's (any
`X-Workspace-Id` is not read; the deployment's administrators write) until the data path reads a workspace's: today
every review still flows through the deployment-wide path (a workspace's ingestion is held), so the categories that
classify it, the PII rule and retention of its source and the restricted sources that hide it must be the ones an
administrator edits. They move together, in the phase-2 cut-over: the processor and the ingestion paths pass the
scope of the feedback they handle, the feedback routes pass theirs to `scope_for_event`, and then the six routes
resolve the workspace (its admins write, `require_settings_admin`). A new workspace starts with none of the three
(nothing is copied, owner decision 18). Radar's configuration can be read per workspace the same way (Unreleased,
decision 13): `lambda/shared/radar_keys.py` keys a workspace's scan settings and brand list at
`WS#{ws}#SETTINGS#radar` (`config`, `brands`; the deployment's `SETTINGS#radar` without one), and `load_settings` (`shared/radar_settings.py`),
`load_brand_list` (`shared/radar_brands.py`), the brief's `effective_brands` (`briefing/radar_cards.py`, with that
workspace's source profiles) and the processor's brand labels (`shared/radar_routing.py` `BrandLabels`, cached per
workspace, a failed read forgetting only that workspace's copy) take an optional scope and read through `ws_table`.
Radar's views can too (`lambda/shared/radar_reads.py`): a workspace's reviews, markers, daily counters and
releases are the deployment's keys inside its partitions (`WS#{ws}#RADAR#{brand}#…`, `WS#{ws}#RADARID#{brand}`,
`WS#{ws}#RELEASE#{brand}`, `scoped_pk`), and so are the counters of its own feedback that the comparison reads
(`WS#{ws}#METRIC#…`, as `lambda/shared/ws_repo.py` `metric_pk` builds them); every reader of them
(`shared/radar_store.py` `daily_rows`, `sum_counter`, `recent_items`; `shared/radar_reviews.py`'s list,
cursor and detail; `shared/radar_counts.py`; `shared/radar_views.py`'s totals, trend, themes and comparison, both
sides; `shared/radar_releases.py` `list_releases`, `count_releases`; `shared/radar_all.py`) takes an optional
`workspace` and reads through `lambda/shared/ingest_tables.py` `table_view`: `ws_table` with one, which refuses a
partition or a cursor outside it before DynamoDB (a cursor of another partition is a 400; a marker pointing outside
the workspace reads as absent), the table itself without, both with one key condition (the same rows as before). No caller passes one: the Radar routes, the brief, the scan job (its last scan, `RADARSCAN`,
and its release writes) and the processor's routing, dedupe check and writes stay the deployment's and move together at the
cut-over; its data version (`SETTINGS#radar` / `version`) moves with the cached reads' version counters. The cross-workspace suite runs the resolved problems' and the brand's routes (its check 3 expects, for a route
whose case says why, the deployment's answer with no row of either workspace touched instead of the 400; for the
brand's `PUT`, 403 to a caller outside the deployment's `admins`). The
deployment kinds' writes need the deployment's `admins` and a live platform admin (since 6.18.00): `PUT /settings/appearance` and the three alert writes
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
| `brand`, `company_context`, `design_system` | workspace | the brand the AI writes for, the team's vision and objectives, its design tokens and references (decision 6; `brand` moved, a request with no workspace keeps the deployment's row, as before) |
| `categories`, `dimensions`, `sources` | workspace | the team's taxonomy and source profiles (decision 6; read per workspace through `lambda/shared/workspace_config.py`; edited as the deployment's until the phase-2 cut-over) |
| `resolved_problems` | workspace | the problems a team marked resolved (moved; a request with no workspace keeps the deployment's row, as before) |
| `email_intake` | workspace | the team's inbox caps (its address is `{slug}@`, [Public and non-user entry points](#public-and-non-user-entry-points)) |
| `fallback_owner` | workspace | the member an agent's new project falls back to |
| `radar` (voc-radar: config, brands, version) | workspace | decision 13; read per workspace through `lambda/shared/radar_keys.py`, edited as the deployment's until the cut-over |
| `model` | workspace, over a deployment default | the team's model picks (per surface, and the global pick); the default pinned at deploy is `model_default` (below) and the allowlist stays deployment-wide (decision 6) |
| `participants` (voc-participants, pk `SETTINGS`: engagement, board audience) | workspace | the team's engagement settings |
| `appearance` | deployment | one logo and colour scheme (decision 7): a platform admin's setting, not a workspace admin's |
| `model_default` | deployment | the model pinned at deploy (`-c defaultModelId`, `lambda/custom_resources/model_pin.py`), below every pick: split from `model` (7.01.00) so the picks can move into each workspace; a deployment from before the split keeps its pin in `model`'s `model_id`, which still outranks it |
| `model_quotas`, `image_model_quota` | deployment | the AWS account's Bedrock quotas, cached; every workspace shares them (decision 10) |
| `alerts` | deployment | alarms on the deployment's own Lambdas and their recipients: the deployment's operations |

## Credentials

- One Secrets Manager secret per workspace, `voc/ws/{ws}/credentials` (`<prefix>-voc/ws/{ws}/credentials` in a
  deployment with `-c deploymentPrefix`), encrypted with the customer-managed key. It will hold every plugin
  credential, scraper API credential and webhook secret of that workspace. The plugin ingestors read it (since 7.00.00:
  a run in a workspace reads that workspace's, keys still filtered by plugin namespace; a deployment-wide run still
  reads the shared secret); nothing writes it
  after its creation yet (the API still saves plugin credentials in the deployment's shared secret).
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
  (`voc-datalake/lambda/api/test/test_workspaces_platform_routes.py` pins that). The plugin ingestor roles
  (`voc-datalake/lib/stacks/ingestion-roles.ts`, since 7.00.00) hold `secretsmanager:GetSecretValue` on `voc/ws/*` (a
  run in a workspace, the name built from its verified workspace, `lambda/shared/workspace_ids.py`
  `credentials_secret_name`; IAM lets every ingestor role read every workspace's secret, so only that code keeps a run
  to its own workspace's credentials: decision 1's soft isolation) beside the shared secret their deployment-wide runs read until phase 2's last slice; later the integrations role gets `GetSecretValue` and `PutSecretValue` there, with the name
  built from the request's verified workspace.
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
   workspaces, enter one, members; built in 6.13.00 with the members page), per-workspace secret creation.
2. **Data path**: ingestion → S3 → SQS → processor → feedback → aggregator → metrics and feedback read APIs, all keyed
   by workspace; the scheduled tick's fan-out; per-workspace credentials; the public routes (forms, webhooks, email,
   voting). Browser-saved state still not keyed by workspace (the three persisted stores are since 6.15.00),
   each with its reason: the Memory page's list of the imports this browser started (`voc-memory-imports`), which follows the
   memory API when phase 3 keys it; the onboarding cache (`voc-onboarding:{sub}`), a cache of a per-person
   setting the server holds; and, deployment-wide by design, the session (`voc-auth`), the language and theme
   (decision 7), the assistant launcher's position (`voc-assistant-bubble`, per person), the passkey offer, the
   public boards' and voting pages' own keys, and the workspace records themselves (`voc-last-workspace`,
   `voc-refused-workspaces`, `voc-platform-entries`). When phase 4's delete frees a slug, a browser that saved
   state under it would show it to a later workspace with that slug: phase 4 keeps deleted slugs reserved, or
   moves these keys to the workspace id.
3. **Everything else**: settings, categories, dimensions, sources, Radar, projects and their Step Functions, the
   assistant and its stream Lambda, memory, agents, workflows and plans, MCP tokens, the read-caching version
   counters ([Read Caching](caching.md)) per workspace, logs and alerts.
4. **Lifecycle and cost**: export, delete, cost metering and the platform cost page.
5. **Later: the workspace import plugin** (below).

Guards added in phase 1 and kept green from then on: the raw-access static test, a cross-workspace test suite (a
member of workspace A is refused every id of workspace B exactly as an id that exists nowhere, route by route), and an
end-to-end check with two workspaces against the local mock. All three exist since 6.14.00 (the table above): `audit:
ws_raw_access`, the cross-workspace suite (since 6.18.00 `lambda/api/test/test_cross_workspace_routes.py`; phase 2
moves each data route out of its pending list) and `frontend/e2e/tests/cross-workspace.spec.ts`.

The cross-workspace suite (`voc-datalake/lambda/api/test/test_cross_workspace_routes.py`; its docstring has the
rules) names every route of the API, reads and writes, by file and route, in exactly one table: workspace-scoped (it
resolves `X-Workspace-Id` before it can return or write, found structurally, with a two-workspace case in
`cross_workspace_worlds.py`), outside a workspace by design (each with its reason), or pending
(`cross_workspace_pending.py`, by the phase that moves it, with `POST /mcp/global` too). For each workspace-scoped
route it generates the checks over two seeded workspaces: B's workspace in the header, and B's ids (path, body or
query) under A's header, are refused exactly as ones that exist nowhere, changing nothing, while the same request
works inside A. A new route, or a pending one that starts resolving the workspace, fails until it is classified, so
the pending lists only shrink. A platform admin entering B (decision 2, audited) is the one sanctioned way in
(`shared/test/test_workspace.py`). Beside the per-file detector, a scan of every module of `lambda/` follows
`resolve_workspace` through helpers in other modules, imports, aliases, module attributes and decorators: a route it
reaches must be workspace-scoped, so a helper in another module cannot hide a resolution from the tables. Naming B,
or a malformed id, answers the one 404 with no Cognito call at all, for A's viewer, a caller in no workspace and a
member of the deployment's `admins` only too.

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
