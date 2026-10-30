# Production e2e suite (Playwright)

Drives a deployed VoC site as two real Cognito users and records evidence for each step. That covers every route and URL tab, each modal that can be opened without data, the safe write flows, a GET of every API endpoint, axe-core and design-system audits, and a cleanup that proves nothing was left behind.

It is a separate package (`e2e/package.json`: `@playwright/test` 1.63.0, `@axe-core/playwright` 4.13.0, pinned) so it never enters the app's dependency tree, vitest run, knip, or ESLint profile. ESLint ignores `e2e/**`. Type-check it with `npx tsc -p e2e/tsconfig.json`.

## Run

```bash
set -a; . /path/to/e2e-credentials.env; set +a   # never commit this file
cd voc-datalake/frontend
npm run e2e:prod                                  # npm ci in e2e/, then playwright test
# subsets: cd e2e && npx playwright test -c playwright.config.ts --project=admin tests/writes.spec.ts
```

Chromium revision 1243 must be present (`npx --prefix e2e playwright install chromium` if it is not).

### Sharded run (~30 min)

A serial run of the whole suite takes hours. `npm run e2e:prod:sharded -- 6` (or `bash e2e/scripts/run-sharded.sh 6 [playwright args]`) starts 6 Playwright shards in parallel, each with 2 workers for the writing specs (`E2E_SHARD_WRITE_WORKERS`) and 2 for the read-only ones (`E2E_SHARD_READ_WORKERS`; total `E2E_SHARD_WORKERS`, default their sum; see "Workers" below), which finishes the full production suite in about 30 minutes. Each shard has its own `E2E_OUT` (`<base>/shard<i>`, base `E2E_SHARD_OUT`, default `e2e/e2e-output/sharded-<epoch s>`), so its own saved sessions, run id, ledger and cleanup teardown: no shard reads or deletes another's data. When all shards end, their blob reports are merged (`playwright merge-reports`) into one list on the console, `<base>/results.json` and `<base>/html/`; the exit code is 1 when any shard failed. Logs per shard: `<base>/shard<i>/run.log`.

| Env var | Meaning |
|---|---|
| `E2E_SITE` | CloudFront URL of the SPA |
| `E2E_API` | API Gateway stage URL (`…/v1`) |
| `E2E_ADMIN_USER` / `E2E_ADMIN_PASSWORD` | A user in the `admins` group **and** the `e2e` group (see "Models: the `e2e` group") |
| `E2E_USER_USER` / `E2E_USER_PASSWORD` | A user in the `users` group **and** the `e2e` group |
| `E2E_ALLOW_FULL_MODELS=1` (optional) | Run even when a test user is not in `e2e` (setup then only warns; its model calls use the admin's models) |
| `E2E_READ_WORKERS` / `E2E_WRITE_WORKERS` (optional) | Workers for the read-only projects (default 4) and for the writing ones (default 1); see "Workers" |
| `E2E_OUT` (optional) | Evidence directory (default `e2e/e2e-output`) |
| `E2E_AUTH_DIR` (optional) | Saved sessions (default `$E2E_OUT/.auth`, or `e2e/.auth` without `E2E_OUT`) |
| `E2E_KEEP_AUTH=1` (optional) | Keep the saved sessions after the run (default: the cleanup deletes the run's own `.auth` folder) |
| `E2E_SCREENS` (optional) | Screenshot directory (default `$E2E_OUT/screens`) |
| `E2E_TRACK` (optional) | QA track tag (`s1`…). Run ids become `<track>-<epoch ms>`; the opt-in leftover sweep then reaches only `e2e-<track>-…` names |
| `E2E_RAW_BUCKET` (optional) | The raw-data bucket for the s3 avatar sweep proof; default: the `RawDataBucketName` output of `E2E_CORE_STACK` (default `VocCoreStack`), read with a read-only `describe-stacks`. Without either, s3 step 12 still deletes the project but skips the S3 proof and says why |
| `E2E_CORE_STACK` (optional) | The core stack name for that lookup (`<prefix>-VocCoreStack` for a prefixed deployment) |
| `E2E_SWEEP_LEFTOVERS` (optional) | `1`: cleanup also deletes leftovers of earlier aborted runs (default: only this run's ledger entries) |

Credentials are read from the environment only. Sessions are saved to `$E2E_OUT/.auth/` (`e2e/.auth/` without `E2E_OUT`; `E2E_AUTH_DIR` overrides) in a mode-700 directory, each file mode 600, and are gitignored, because they hold tokens. Following `E2E_OUT` keeps parallel runs from overwriting each other's sessions. When the run's cleanup ends (pass or fail) it deletes that `.auth` folder, unless `E2E_AUTH_DIR` named it or `E2E_KEEP_AUTH=1` is set, so no token stays on disk after a run; the working-tree secret scan (`scripts/gitleaks-tree.sh`) skips `.auth/` like the other gitignored folders. Nothing prints a password or a token.

### Test traffic tag (5.38)

Every request the suite sends carries the User-Agent token `voc-e2e/<run tag>` (`lib/trafficTag.ts`): browser contexts send Desktop Chrome's User-Agent plus the token (`use.userAgent`, set in `lib/runConfig.ts` and in each config that does not use it), and every Node-side call goes through `e2eFetch` (`apiCall`, `mcpToolsList`; `unit/trafficTag.spec.ts` fails on a bare `fetch(`). A User-Agent needs no CORS change. The run tag is `E2E_TAG_RUN_ID` (`[A-Za-z0-9._-]{1,64}`), pinned once in the config process and inherited by every worker; unset it is the run id (`E2E_RUN_ID`), else `<epoch ms>`. `run-sharded.sh` sets ONE tag for all its shards (`e2e-[<track>-]<UTC yyyymmddThhmmssZ>`, printed at start) while each shard keeps its own run id for entity names. The API Gateway access log has a `userAgent` field and the Lambda logs a `test_run` key on every line of a tagged request (`lambda/shared/e2e_tag.py`), so a sweep can exclude the ~1,000 deliberate 4xx calls of a run (lines from before 5.38 cannot be told apart):

```
# API access log (/aws/apigateway/…): real traffic only, or one run only
filter userAgent not like /voc-e2e\//
filter userAgent like /voc-e2e\/e2e-20261010T080000Z/
# Lambda logs (/aws/lambda/voc-*)
filter ispresent(test_run) = 0
filter test_run = 'e2e-20261010T080000Z'
```

The access log also carries `path` (the real path, ids included), `integrationStatus` and `errorMessage`. The TypeScript `voc-chat-stream` Lambda does not add `test_run` (filter its requests by the access log's `userAgent`).

### Models: the `e2e` group (5.58)

Both test users must be members of the Cognito group `e2e` (VocCoreStack creates it). For a member, every model call the app makes for that user, on every AI surface (the assistant and its plan steps, every API route, the research, persona, document, prototype, merge and manual-import jobs the user starts, and agent runs the user starts), resolves to Claude Haiku 5.5 (`global.anthropic.claude-haiku-5-5`; `eu.` with `-c inferenceScope=eu`), whatever an admin picked; the capacity fallback stays on Haiku. Real users keep their models, and the admin model picker is untouched. The profile comes only from the verified token's `cognito:groups` (or a job record a verified request wrote); nothing in a request body can turn it on. The image model (persona avatars) is not changed. Not covered (they have no verified caller to read the group from): the background memory extraction of finished sessions (Haiku 5.5 by default anyway), the product-document extraction that runs on an upload, scheduled agent runs, and calls made with a global MCP token (its synthetic claims carry no groups). API Lambda log lines of a profiled model call show `model_profile=e2e`; the stream Lambdas log one `model profile applied` line per run.

Membership is admin-only and set once, outside CI (the suite never needs AWS write access):

```bash
aws cognito-idp admin-add-user-to-group --user-pool-id <UserPoolId> --username '<e2e user>' --group-name e2e
```

`setup` reads each user's `cognito:groups` from the ID token after login and **fails** when `e2e` is missing, printing that command (`lib/modelProfile.ts`). `E2E_ALLOW_FULL_MODELS=1` turns the failure into a loud warning. A token minted before the user joined the group lacks it: sign in again.

### Workers (5.58)

The specs that only read (`lib/parallel.ts`: `screens`, `api-sweep`, `prioritization-requests`, `request-counts`, `dashboard-data`, `error-states`, `workflow-custom-arrows`) run in the projects `admin-read` and `user-read`, fully parallel, with up to `E2E_READ_WORKERS` workers (default 4). Every spec that writes (creates entities, changes the caller's own settings or memory, or runs the assistant) stays in `admin` / `user`, `E2E_WRITE_WORKERS` workers (default 1, so they run one at a time as before). `unit/parallel.spec.ts` fails when a listed spec gains a write call.

### One conversation per spec

Each model call sees the whole conversation, so the assistant specs never continue one across specs: lib/context.ts strips the persisted assistant state (the active thread) once per spec file, and every test page is a fresh context. Inside a spec, `lib/assistant.ts` counts the runs (sends, approvals, declines) of the page's conversation and throws past `MAX_RUNS_PER_CONVERSATION` (8) unless `newChat(page)` started a new one, which keeps each call's context far below 100k tokens. `unit/conversation-cap.spec.ts` pins both, and that every spec driving the assistant uses those helpers.

## Projects (in order)

1. `setup`: real login through `/login` for both roles; fails when a user is not in the `e2e` group (above).
   `admin-read` / `user-read` run the read-only specs listed under "Workers" beside step 2.
2. `admin` and `user`, each running these specs:
   - `screens.spec.ts`: every route and tab from `lib/inventory.ts`, in dark and light for admin and in dark for user. Admin-only routes must redirect the user.
   - `modals.spec.ts`: opens each modal, audits it, closes it the designed way, and proves it closed. The scraper and import dialogs are admin-only: as e2e-user their tiles must be disabled with "Admin access required".
   - `api-sweep.spec.ts`: GETs every endpoint and writes `api-sweep-<role>.json` (status, ms, bytes; bodies are never written).
   - `home-onboarding.spec.ts`: the Home onboarding buddy. Each step is checked iff the APIs say so; Ready / Skip; Skip
     or Don't show again survives a new browser with the local cache removed; Account brings it back; Hide is a
     server-side snooze. It writes only the caller's own `/settings/my-onboarding` and restores the state it found.
   - `writes.spec.ts`: admin only, and only on `e2e-<run id>-*` data.
     - Create a project, open its modals, send one assistant message, then delete it in the UI.
     - Create a feedback form, check the public `config` and `iframe` routes, then delete it. It does **not** submit, because the feedback table has no delete route.
     - Run scraper `analyze-url` on https://example.com, save it as "Manual only" so it is never scheduled or run, then delete it.
   - `projects-mcp-removed.spec.ts`: both roles, on one public `e2e-<run id>-mcp-removed` project (made through the admin API, ledger-recorded). Checks that there is no Export / MCP tab, that `?tab=mcp` is rewritten to Overview, and that the header's **Connect via MCP** opens `/connect?project=<id>` showing `/mcp/global`. As admin it also checks that the per-project token routes and `GET /projects/{id}/autoseed`, retired in 3.00.00, answer 404.
   - `workflow-custom-arrows.spec.ts`: both roles, read-only (`POST /workflows/validate` stores nothing). A `pass` / `fail` arrow out of a custom step is refused with the error pinned to that step; the plain arrow validates.
   - `projects-edit.spec.ts`: on three private `e2e-<run id>-edit*` projects (`lib/projects.ts`: admin API create, `inviteMember`).
     - Admin: Edit is in the card's "Actions for <name>" menu. Escape and Cancel close the Edit dialog without a PUT; an edit of name, description and visibility shows on the card, in `GET /projects/{id}` and on the detail page.
     - User, invited as a viewer: no actions menu on the card, an unshared private project is not listed, and a forced `PUT` gets a 403.
   - `sharing.spec.ts`: admin only, driving e2e-user in a second context, on two private `e2e-<run id>-share-*` projects. The Share dialog sets one Public (e2e-user lists it); invites e2e-user as a viewer (view-only banner, no Edit / Import / Generate / New Document, a forced `PUT` is a 403); then removes them (their `GET` is a 404).
   - `memory.spec.ts`: the caller's OWN personal memory: add (`e2e-<run id>-memory-<role>…`), +1, Forget (with its confirm), Restore from the Archived filter. An injected 500 on `GET /memory/review` shows the alert with Retry; a 403 is silent.
   - `connect.spec.ts`: a read global MCP token minted on /connect (shortest expiry offered), `POST /mcp/global` `tools/list` → 200, revoked in the UI → 401 with a Bearer challenge; and a 1-day token (`expires_in_days: 1`, API) the same way. The secret is never logged or written.
   - `error-states.spec.ts`: Dashboard, Categories, Projects, Admin › General and Memory with their load injected to fail (500, 403, timeout; `lib/inject.ts`): the screen's own error state where it has one, never a blank page or the route error boundary. Screens with no error state get a `finding` annotation.
   - `request-counts.spec.ts`: one `GET /sources/status` on `/admin?tab=sources&section=plugins`, one `GET /feedback-forms?include=stats` and no per-card stats on `/feedback-forms`, one `GET /feedback/entities` on `/categories` (`/prioritization`'s batched project reads are `prioritization-requests.spec.ts`).
   - `prioritization-requests.spec.ts`: both roles, read-only. Loading `/prioritization` sends one `GET /projects?ids=…` per 200 listed projects (naming each once) and no per-project `GET /projects/{id}`. Also runs against the dev mock (`E2E_MOCK=1`).
   - `dashboard-data.spec.ts`: also holds the dashboard UI to the data on a 30-day window (never the "workspace is empty" welcome when there is feedback), and shows the welcome for an injected all-zero summary.
   - `modals.spec.ts` also checks that Add Data Source offers only the plugins the deployment enables (`GET /sources/status` keys), each tile opening with no API 4xx; `writes.spec.ts` also parses one undated review in Manual Import, sees the date gate disable Import, and cancels at the preview (no confirm call).
3. `cleanup` (teardown of `setup`): deletes only the entities THIS run recorded in `created.json` (entries carry the run id), then lists each collection again. Kinds without a delete route are retired the product's way, from the ledger only: agents then workflows archived, global MCP tokens revoked and memories forgotten, each as its owner. Proof goes to `cleanup-proof.json`. `E2E_SWEEP_LEFTOVERS=1` also sweeps leftovers of earlier aborted runs (`e2e-<digits>-*`, or with `E2E_TRACK` only `e2e-<track>-<digits>-*`). It never touches a name that does not match.

## Local dev mock (`E2E_MOCK=1`)

`E2E_MOCK=1` (`MOCK` in `lib/env.ts`) is the suite's one mock switch, and `playwright.config.ts` its one runner: under it the config runs only the specs listed in `MOCK_SPEC_NAMES` (`lib/env.ts`), as the admin, with no login (a DEV build without Cognito is an admin session), no saved session, no setup / cleanup and API calls without a token (`apiCall`); e2e-user steps skip. That list holds the P2 specs above that need one user, `s2-workflow-rebuild.spec.ts`, the P3 specs and the 5.35 coverage specs below; `unit/helpers.spec.ts` fails when a spec branches on `MOCK` without being listed, or when anything else reads `E2E_MOCK`. Use private ports and kill only the PIDs you started:

```bash
cd voc-datalake/frontend
PORT=3417 node mock-server.js &   VITE_API_ENDPOINT=http://localhost:3417 npx vite --port 5417 --strictPort &
cd e2e && E2E_MOCK=1 E2E_SITE=http://localhost:5417 E2E_API=http://localhost:3417 E2E_OUT=/tmp/e2e-mock \
  npx playwright test -c playwright.config.ts            # or name spec files to run only those
```

`sharing.spec.ts` skips there (it needs two real users), as does the `/mcp/global` call of `connect.spec.ts` (the mock does not serve it).

`csv-dataset-update.spec.ts` (issue #411, [docs/csv-import.md](../../../docs/csv-import.md)) runs ONLY there: a CSV upload under a dataset name is previewed and imported, then the corrected file is previewed (one row to update, its before / after text) and confirmed with `apply_updates`; the API refuses an unconfirmed change (409) and `GET /feedback` holds the corrected text once. On a deployment it would write feedback, which has no delete route.

## QA track s1 (`E2E_TRACK=s1` only)

`tests/s1-a-data.spec.ts` and `tests/s1-b-assistant.spec.ts` skip unless `E2E_TRACK=s1`, because they write feedback that cannot be deleted:

- S1-T1/T2: a web scraper via Analyze URL, saved Manual only; every Add Data Source tile opened and closed with no write.
- S1-T3: exactly ten `[e2e-qa]` comments through Manual Import (paste, AI parse, preview, confirm), source channel `e2e-qa`. Guarded by `importAttemptedAt` in `$E2E_OUT/s1-state.json` (set before the click) and by a search for existing `[e2e-qa]` items: it never imports twice.
- S1-T4: polls until all ten are enriched, then finds them on the feedback detail page, Categories and Data Explorer.
- S1-T5…T8: the assistant (floating and /chat) judged by the tool calls and results in its SSE stream (`lib/sse.ts` taps `fetch`), a project created through an approval card, a project and settings read back, reload mid-stream and after completion, history in a fresh context, and the `e2e-user` write-tool permissions.
- S1-T9: Lambda `REPORT` lines for every step window (`lib/cloudwatch.ts`, read-only `aws logs filter-log-events` with the operator's own credentials) go to `lambda-reports.json`.

## QA track s2 (autonomous agents)

`tests/s2-agents.spec.ts` (QA track s2, autonomous agents) runs ALONE, without the shared setup/teardown: `npx playwright test -c playwright.config.ts --project=admin --no-deps tests/s2-agents.spec.ts`. It signs both roles in itself; it covers the assistant creating and editing an agent, the drag-and-drop workflow editor (native HTML5 drag, handle-to-handle connects, round-trip), Run now / Cancel with Step Functions history and Lambda `REPORT` lines (`lib/aws.ts`, read-only AWS CLI calls), duplicate/export, enable/disable, and e2e-user refusals. Its own `s2-99` cleanup archives the agent. It deletes the conversations it started and any project its runs created (each run's journal is read again: `lib/agentRuns.ts`), then archives this run's workflows from the Workflow library on /agents (`lib/workflows.ts`: Archive → "Archive this workflow?" → `DELETE /workflows/{id}`), and checks the built-in has no Archive and answers 409; runs have no delete route and stay (named `e2e-<run id>-*`). Like every spec that cleans up after itself, it takes only the ledger entries its own tests recorded (`specLedger()` in `lib/ledger.ts`: each entry carries the `spec` file that recorded it): in a sharded run other specs share the shard's ledger and their entities are still in use (5.35.01: s2-99 deleted s3's project mid-generation). Only the shared teardown (`tests/cleanup.spec.ts`) takes the whole run (`runLedger()`).

`tests/s2-workflow-rebuild.spec.ts` (F4, same gating: `--project=admin --no-deps`, signs both roles itself) rebuilds the
built-in workflow from a cleared canvas using only the palette and the side panel (steps, arrows with conditions,
loops opened by clicking their frame), saves it as an e2e-named workflow, diffs `GET /workflows/{new}` with
`GET /workflows/wf_default` (ids and positions aside), checks e2e-user's read-only view, and in `s2wr-99` archives
the agent, then its workflows from the Workflow library (`lib/workflows.ts`; the built-in has no Archive and `wf_default` answers 409). It also runs against the local dev
mock (`E2E_MOCK=1`, no login, user step skipped); the header comment has the commands.

## QA track s3 (personas and documents)

`tests/s3-personas-documents.spec.ts` (QA track s3) is a long, admin-only scenario. It generates personas and checks each avatar `<img>`, the signed CDN URL and the S3 object. It imports a persona and regenerates an avatar, then edits the imported persona (03c, Edit Persona → Save Changes) and deletes it through "Delete Persona?" (Cancel first keeps it), consults personas and asks the assistant about a document. It generates a PRD and PR-FAQ (wizard and assistant), edits them (editor and assistant approval), then runs remix, Markdown/TXT/PDF export, research and a prototype smoke test. Finally it deletes the project and proves the avatars were swept: every object under `avatars/{persona_id}/` (plus the legacy flat keys) is listed before and after, and the "before" listing must contain every key a persona's `avatar_url` names. It also deletes every conversation the run started (from the ledger, by kind). Run it with `--project=admin --no-deps`; the spec deletes and proves its own project. Its helpers are:
- `lib/jobs.ts`: follows a job and records each poll, queue-to-start and total.
- `lib/cloudwatch.ts` and `lib/assistant.ts` (shared with s1 and s2, see below).

## QA track design (read-only audit)

`playwright.design.config.ts` runs `tests/design-*.spec.ts`: every screen and overlay as both roles at 1440 and 390 widths, in both themes, with the deep audit (`lib/deepAudit.ts`, `lib/designRun.ts`). It creates nothing, so it has no cleanup teardown. `E2E_MOCK=1` runs it against the local dev mock (admin projects only). Both runners share `lib/runConfig.ts`.

## Shared helpers (all tracks)

- App selector hooks (5.35): accessible names first — the sidebar's `<nav aria-label="Main">`, Personas-tab cards named by the persona, Home's agent-decision `article` named "<agent> needs your decision", the empty assistant's region "How can I help?". Where no natural name exists, a `data-testid`: `fr-card-<id>`, `fr-status-badge`, `persona-avatar` (the image only; the initials fallback has none), `platform-version`, `prioritization-row-toggle`, `memory-card`, `room-vote-panel`, `radar-release`, and `data-revision="<n>"` on workflow History rows. Prefer these over CSS classes or DOM shape.
- `lib/test.ts`: every spec imports `test` from here. Its contexts strip persisted UI state (`voc-assistant-ui`, `voc-manual-import`) from both saved sessions once per spec file, and record every conversation a run starts (the `threadId` of each `POST /chat/stream`) in the ledger as the context's role, so cleanup never misses one whose save was refused. They also record every entity a browser create call makes (`POST /projects`, `/feedback-forms`, `/agents` with its workflow copy, `/workflows`, `…/duplicate`; `lib/context.ts` `browserCreated`): the assistant's approved writes run in the SPA, so an entity the model named reaches the ledger too. Such an entry is labelled under the run prefix when its own name is not an e2e name. A spec that calls `browser.newContext` itself wraps it, in the same statement, in `prepareContext(context, role)` (`unit/helpers.spec.ts` fails otherwise); one that writes its session back uses `saveSession` (`lib/context.ts`), which drops the UI state too.
- `lib/agentRuns.ts`: `runTargetProblems` (before any Run now: the agent runs this run's e2e workflow, and the workflow has only `start` / `aggregate_reviews` / `custom_llm` / `end` steps) and `recordRunProjects` (projects a run created, read from its journal: `node_finished` "Created project {id}" with the same `ref.project_id`, recorded in the ledger; a reused project is returned, never recorded). `lib/runCleanup.ts`: ledger-driven conversation and project deletes with proof, by kind and run (never by label). `lib/avatars.ts`: avatar keys in both layouts (`avatars/{persona_id}/{hash}.{ext}`, legacy `avatars/{persona_id}.{ext}`).
- `lib/dialogs.ts`: `dialogNamed(page, name)`. Find dialogs by accessible name, never `getByRole('dialog').last()`: the floating assistant panel is a dialog as well.
- Offline checks of these helpers: `npx playwright test -c playwright.unit.config.ts` (no deployment, no credentials).
- `lib/assistant.ts`: one assistant driver. `ask` / `approve` / `decline` judge a run from the SSE tap (`lib/sse.ts`, s1); `askAssistant` drives the UI without the tap, approves up to `approveMax` cards and measures `/chat/stream` headers, TTFB and total (s3). `openFloating` opens the panel from the bubble or a project's "Ask the assistant" (s2 uses it).
- `lib/cloudwatch.ts`: Lambda `REPORT` lines, `statsOf`, log lines (scrubbed) and step windows, by Lambda base name (`voc-chat-stream`). Pad a window's end with `LOG_LAG_PAD_MS` when reading right after a step.
- `lib/aws.ts`: the one AWS CLI runner (read-only), account/region, physical names, Step Functions execution timings.
- `lib/recorder.ts` stores `durationMs` and `ttfbMs` per call.
- `lib/inject.ts`: `injectFailure(page, { method, path, query?, failure })` answers matching API calls in the browser (a status with the API's JSON error body and CORS headers, any status and body, or a timeout); `withoutInjected(problems, …specs)` drops exactly the problems it caused from a `runStep` verdict.
- `lib/mcp.ts`: `mcpToolsList(token)` calls `/mcp/global` as an assistant does. `lib/workflows.ts`: archive from the Workflow library (the API instead when a name is not unique).

## Ops checks (read-only, `E2E_OPS=1` only)

`playwright.ops.config.ts` runs `tests/ops-capacity.spec.ts` and `tests/ops-postdeploy.spec.ts` with the operator's ambient AWS credentials (no browser login, no writes, nothing to clean up): list/describe/get calls and Logs Insights queries only, through `lib/aws.ts` and `lib/ops.ts`. Window: `E2E_OPS_SINCE=<ISO time>` (e.g. the deploy) to now, else the last `E2E_OPS_HOURS` hours (default 24).

```bash
E2E_OPS=1 E2E_OPS_SINCE=2026-10-07T08:00:00Z npx playwright test -c playwright.ops.config.ts
```

- `ops-capacity`: every `voc-*` Lambda within the sizing policy (peak memory ≤ 70 %, ≤ 60 % for variable-payload functions; CPU worse-of ≤ 70 %), using the same evaluator as `scripts/capacity/capacity-query.sh` (`lib/sizing/capacity.ts`). Unmeasured functions are printed and attached as an annotation. Evidence: `ops-capacity.json`.
- `ops-postdeploy`: failure queues empty, `voc-*` alarms OK, the feedback processor's event-source mapping at 10 records / 5 s, 0 ERROR lines from the memory workers, and `VoC/FlexFallback`, `ModelFallback`, `AssistantSessionWriteFailed` at 0. One test per check. Evidence: `ops-postdeploy-*.json`.

See docs/lambda-sizing.md for the policy.

## Latency budgets

`lib/budgets.ts` holds a p95 budget per screen and per API endpoint, each with a comment naming the production measurement it came from (`voc-e2e/verify/` sweep and step records, `voc-e2e/qa/perf/` Lambda reports). Two specs assert them:

- `screens.spec.ts`: each screen's navigation DOMContentLoaded (default 1.5 s, `login` 3.5 s) and the slowest API call it makes while loading, excluding the `/chat/stream` SSE (default 4.5 s).
- `api-sweep.spec.ts`: each direct GET (default 3 s; slower routes such as `/sources/status`, `/logs/*`, `/projects/{id}` have their own number).

`E2E_BUDGETS` picks the mode. `hard` (the default) fails the test on a breach. `soft` records each breach as a `budget` annotation and lets the run continue, which is how to measure a new deployment. `off` skips the check. The functional assertions run first, so a budget never hides a real failure. Change a number only with new evidence, and update its source comment in the same change.

## Security probes

`tests/security-probes.spec.ts` checks the API directly, with no browser:

- a bad or missing form id on the public `iframe` route answers a JSON 404 that reflects nothing, and a real form's page carries CSP, `nosniff` and `no-referrer`;
- a gateway 401 names the site's CORS origin, varies on Origin and Authorization, and challenges with `Bearer`;
- `POST /scrapers/analyze-url` refuses the metadata IP, localhost, loopback and `file://` (400), and refuses a public URL that redirects to the metadata IP (override the redirector with `E2E_SSRF_REDIRECT_URL`): analyze-url is an assist job, so the 202's job is polled (`GET /scrapers/jobs/{id}`) until it ends `failed` with "Redirect refused". A malformed body (invalid JSON, or JSON that is not an object) must get a 400. Production currently answers 502 there, so this probe stays red until the handler is fixed;
- a junk `days` falls back to the route's default window instead of failing (`validate_days` never raises, so this is a 200, not a 400);
- e2e-user `DELETE /logs/validation/{source}` is a 403 (the admin is never sent it);
- error bodies are short and carry no exception text, traceback or path.

Its only write is an e2e-named feedback form, created only when no form exists. That form goes in the ledger and is deleted in `afterAll`. Run it alone with `npx playwright test -c playwright.config.ts tests/security-probes.spec.ts`.

## P3 specs (production and the local dev mock)

These run in the default production run (both roles; writes are admin-only and e2e-named) AND against the local dev mock (`E2E_MOCK=1`, see [Local dev mock](#local-dev-mock-e2e_mock1): no login, the mock API without auth; steps the mock cannot model skip and say why).

- `prioritization.spec.ts`: the board, and the public `/vote/:sessionId` in a fresh context with no session (an unknown id says so; its submit is a 404). The room vote end to end (any open vote of the row closed first, open on the board after its confirm, a phone ballot, close, refusal with a 409, then a capped session refusing the next device with a 429) runs on the mock only, because ballots have no TTL and no delete route.
- `account.spec.ts`: the caller's own "My objectives & KPIs" (`/settings/my-context`) saved through the UI, then the original objectives put back (also in `afterAll`) and proven equal. Also checks that `/company?tab=mine` lands on that same section.
- `in-page-tabs.spec.ts`: the 4 FormEditor tabs (Cancel at the end, nothing is written) and the 3 Admin logs sub-tabs, which must show no text block longer than 200 characters (2.12, no customer data).
- `i18n-smoke.spec.ts`: 9 locales × 5 screens, with the language set through `voc-language`. Checks `<html lang>`, that no raw key is on screen (it matches exact English key paths and `ns:key` references), and that nothing overflows horizontally.
- `network.spec.ts`: slow 3G (CDP), a dropped list request (`route.abort`) and `context.setOffline` on /projects, /feedback-forms and /agents, followed by recovery. It also cuts `/chat/stream` after the first answer bytes (`lib/network.ts`), then reloads: the page shows "Still generating…" and then the server's answer.
- `concurrency.spec.ts`: two tabs on one user.
  - Workflow: the stale save gets the 409 conflict UI and the server keeps the first save. In production it uses an e2e agent and an e2e workflow, archived and deleted in `afterAll`.
  - Document: the stale save carries the revision it loaded and gets the 409 conflict UI ("Load the latest" / "Save mine anyway"). The server keeps the first save, and the stale one makes no version.
  - Assistant: two conversations answer at once.
- `auth-session.spec.ts`: production only, each case in its own context; it never writes the saved session back.
  - Expired tokens in storage: a silent refresh on boot.
  - Expired tokens with no refresh token: `/login?expired=1` with "Session expired".
  - One 401: a refresh and a retry.
- `assistant-notifications.spec.ts`: `Notification` is replaced by a recorder and the tab is made to look hidden. A reply notifies only while the tab is hidden, and the notification uses generic words.
- `flows-matrix.spec.ts`: the main flows in dark and light, and the project flow at 390 px with no horizontal overflow.
- `prototype-enlarge.spec.ts`: Escape inside a prototype frame rewritten with `document.open()` closes the Enlarge overlay and returns focus to the button (#386: since 5.35 the prototype's pin widget forwards Escape out of the opaque-origin frame; the mock prototype carries the real widget, and production skips a prototype built earlier). It also opens the tester pins panel. Production is read-only here: it uses an existing prototype or skips.
- `design-screens.spec.ts` "F7": no app-coloured solid background off the Kiro palette, and no `rgb(59, 130, 246)`, on 5 screens in both themes (`offPaletteFills` in `lib/design.ts`). Inline user colours, such as a customer's form theme, are only annotated.

## 5.35 coverage specs (production and the local dev mock)

`COVERAGE.md` maps every page, tab, dialog and flow to its spec. These specs cover the 5.00–5.34 features; all run in the default production run and against the dev mock, and keep the safety model (e2e names, own cleanup with a 404 proof for kinds the ledger does not hold, no email, no third-party fetch, no feedback written):

- `participants.spec.ts`: lists create / rename / delete, a person added to an e2e list (`e2e-<run id>-…@example.com`), found, opened and erased; a project's Participants tab links and unlinks a list with its reach; the ask composer's validation and Send disabled while email is off (`POST /participants/asks` is intercepted, 0 hits). A real ask goes only to the mock's fixture list. e2e-user: no delete controls, forced deletes 403.
- `unsubscribe.spec.ts`: the public page with no token and with a garbage token: no POST on load, one POST on confirm, the generic answer, nothing leaked.
- `feedback-boards.spec.ts` (5.36): the "Feedback boards" nav item, the board list `/feature-requests` and its seeded Sales card opening `/feature-requests/sales-feature-requests`; for the admin the Edit link and the gear to `/admin?tab=access&section=boards[&board=<id>]`, that section (company domains, the boards, one board's editor and back); e2e-user sees no board admin controls. Read-only.
- `feature-requests.spec.ts`: the Sales board `/feature-requests/sales-feature-requests`: create, +1 with a customer in USD, search / status filter / sort, `?request=` deep link, status Planned, delete (404 proof); e2e-user sees no admin controls and a forced status PUT is a 403.
- `board.spec.ts`: `/board` and `/board/sales-feature-requests` with the app session; `/board/login` renders and refuses an `example.org` address server-side (only `SignUp` reaches Cognito, every other call is aborted, so no code is emailed). Production runs the sign-in steps only when `/config.json` has a `board` pool and `example.org` is not an allowed domain.
- `product-interview.spec.ts`: "Fill with AI assistant" opens the assistant with the interview draft and sends nothing; the send runs in production only with `E2E_ASSISTANT_SEND=1` (`lib/optIn.ts`).
- `workflow-history.spec.ts`: History on the built-in (read-only) and on an e2e workflow with two revisions; an old revision opens read-only, closing keeps the current one.
- `radar.spec.ts`: brands, compare, releases, the reviews dialog and a review's details; any `POST /radar/scan` fails the test.
- `decisions.spec.ts`: a decision created, edited (the card updates without a reload, also on a second edit) and deleted on an e2e project (verdict Park, no Bedrock). The project delete sweeps the decision.
- `persona-avatars.spec.ts` (`lib/personaAvatars.ts`): every persona has an `avatar_url` and its card's image answers 200 with `naturalWidth > 0` (the initials fallback fails). Generating personas in production needs `E2E_PERSONA_GENERATE=1`; agent-made personas are checked when this run's ledger has an agent-run project (agent-made personas get portraits by default since 5.35). s3 step 02 and s2 (soft) call the same helper.
- `surfaces.spec.ts`: the five Account tabs and the legacy `?section=`, every Administration tab and section, Company tabs, the Agents views, the Home brief, the review window deep link (Escape, no prev / next), and German on Participants and Feature requests.

## Evidence (`$E2E_OUT`)

- `steps/<role>-<theme>-<step>.json`: each step's network calls (method, path, status, duration), console errors and warnings, page errors, navigation timing, axe violations by impact, the design audit (off-palette colours, fonts, emojis, focus indicator), notes, and the screenshot path.
- `api-sweep-admin.json`, `api-sweep-user.json`, `created.json`, `cleanup-proof.json`, `playwright-results.json`.
- `node e2e/summarize.mjs "$E2E_OUT"` prints per-step pass/fail, API latency p50/p95 per endpoint, and axe totals.
- `node e2e/summarize-design.mjs "$E2E_OUT"` scores each screen of a design run (`tests/design-*.spec.ts`) from 0 to 100 and writes `design-summary.json` and `design-summary.md` next to the input.
- `playwright.ops-mock.config.ts` runs only `tests/ops-visual-check.spec.ts` against the local dev mock, without production auth (usage in the file header).
