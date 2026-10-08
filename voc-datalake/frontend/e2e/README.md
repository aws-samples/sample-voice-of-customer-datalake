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

| Env var | Meaning |
|---|---|
| `E2E_SITE` | CloudFront URL of the SPA |
| `E2E_API` | API Gateway stage URL (`…/v1`) |
| `E2E_ADMIN_USER` / `E2E_ADMIN_PASSWORD` | A user in the `admins` group |
| `E2E_USER_USER` / `E2E_USER_PASSWORD` | A user in the `users` group |
| `E2E_OUT` (optional) | Evidence directory (default `e2e/e2e-output`) |
| `E2E_SCREENS` (optional) | Screenshot directory (default `$E2E_OUT/screens`) |
| `E2E_TRACK` (optional) | QA track tag (`s1`…). Run ids become `<track>-<epoch ms>`; the opt-in leftover sweep then reaches only `e2e-<track>-…` names |
| `E2E_SWEEP_LEFTOVERS` (optional) | `1`: cleanup also deletes leftovers of earlier aborted runs (default: only this run's ledger entries) |

Credentials are read from the environment only. Sessions are saved to `e2e/.auth/` with mode 600 and are gitignored, because they hold tokens. Nothing prints a password or a token.

## Projects (in order)

1. `setup`: real login through `/login` for both roles.
2. `admin` and `user`, each running these specs:
   - `screens.spec.ts`: every route and tab from `lib/inventory.ts`, in dark and light for admin and in dark for user. Admin-only routes must redirect the user.
   - `modals.spec.ts`: opens each modal, audits it, closes it the designed way, and proves it closed.
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
     - Admin: Escape and Cancel close the Edit dialog without a PUT; an edit of name, description and visibility shows on the card, in `GET /projects/{id}` and on the detail page.
     - User, invited as a viewer: no Edit on the card, an unshared private project is not listed, and a forced `PUT` gets a 403.
   - `sharing.spec.ts`: admin only, driving e2e-user in a second context, on two private `e2e-<run id>-share-*` projects. The Share dialog sets one Public (e2e-user lists it); invites e2e-user as a viewer (view-only banner, no Edit / Import / Generate / New Document, a forced `PUT` is a 403); then removes them (their `GET` is a 404).
   - `memory.spec.ts`: the caller's OWN personal memory: add (`e2e-<run id>-memory-<role>…`), +1, Forget (with its confirm), Restore from the Archived filter. An injected 500 on `GET /memory/review` shows the alert with Retry; a 403 is silent.
   - `connect.spec.ts`: a read global MCP token minted on /connect (shortest expiry offered), `POST /mcp/global` `tools/list` → 200, revoked in the UI → 401 with a Bearer challenge; and a 1-day token (`expires_in_days: 1`, API) the same way. The secret is never logged or written.
   - `error-states.spec.ts`: Dashboard, Categories, Projects, Admin › General and Memory with their load injected to fail (500, 403, timeout; `lib/inject.ts`): the screen's own error state where it has one, never a blank page or the route error boundary. Screens with no error state get a `finding` annotation.
   - `request-counts.spec.ts`: one `GET /sources/status` on `/admin?tab=plugins`, one `GET /feedback-forms?include=stats` and no per-card stats on `/feedback-forms`, one `GET /feedback/entities` on `/categories` (`/prioritization`'s batched project reads are `prioritization-requests.spec.ts`).
   - `prioritization-requests.spec.ts`: both roles, read-only. Loading `/prioritization` sends one `GET /projects?ids=…` per 200 listed projects (naming each once) and no per-project `GET /projects/{id}`. Also runs against the dev mock (`E2E_MOCK=1`).
   - `dashboard-data.spec.ts`: also holds the dashboard UI to the data on a 30-day window (never the "workspace is empty" welcome when there is feedback), and shows the welcome for an injected all-zero summary.
   - `modals.spec.ts` also checks that Add Data Source offers only the plugins the deployment enables (`GET /sources/status` keys), each tile opening with no API 4xx; `writes.spec.ts` also parses one undated review in Manual Import, sees the date gate disable Import, and cancels at the preview (no confirm call).
3. `cleanup` (teardown of `setup`): deletes only the entities THIS run recorded in `created.json` (entries carry the run id), then lists each collection again. Kinds without a delete route are retired the product's way, from the ledger only: agents then workflows archived, global MCP tokens revoked and memories forgotten, each as its owner. Proof goes to `cleanup-proof.json`. `E2E_SWEEP_LEFTOVERS=1` also sweeps leftovers of earlier aborted runs (`e2e-<digits>-*`, or with `E2E_TRACK` only `e2e-<track>-<digits>-*`). It never touches a name that does not match.

## Local dev mock (`E2E_MOCK=1`)

`E2E_MOCK=1` (`MOCK` in `lib/env.ts`) is the suite's one mock switch, and `playwright.config.ts` its one runner: under it the config runs only the specs listed in `MOCK_SPEC_NAMES` (`lib/env.ts`), as the admin, with no login (a DEV build without Cognito is an admin session), no saved session, no setup / cleanup and API calls without a token (`apiCall`); e2e-user steps skip. That list holds the P2 specs above that need one user, `s2-workflow-rebuild.spec.ts` and the P3 specs below; `unit/helpers.spec.ts` fails when a spec branches on `MOCK` without being listed, or when anything else reads `E2E_MOCK`. Use private ports and kill only the PIDs you started:

```bash
cd voc-datalake/frontend
PORT=3417 node mock-server.js &   VITE_API_ENDPOINT=http://localhost:3417 npx vite --port 5417 --strictPort &
cd e2e && E2E_MOCK=1 E2E_SITE=http://localhost:5417 E2E_API=http://localhost:3417 E2E_OUT=/tmp/e2e-mock \
  npx playwright test -c playwright.config.ts            # or name spec files to run only those
```

`sharing.spec.ts` skips there (it needs two real users), as does the `/mcp/global` call of `connect.spec.ts` (the mock does not serve it).

## QA track s1 (`E2E_TRACK=s1` only)

`tests/s1-a-data.spec.ts` and `tests/s1-b-assistant.spec.ts` skip unless `E2E_TRACK=s1`, because they write feedback that cannot be deleted:

- S1-T1/T2: a web scraper via Analyze URL, saved Manual only; every Add Data Source tile opened and closed with no write.
- S1-T3: exactly ten `[e2e-qa]` comments through Manual Import (paste, AI parse, preview, confirm), source channel `e2e-qa`. Guarded by `importAttemptedAt` in `$E2E_OUT/s1-state.json` (set before the click) and by a search for existing `[e2e-qa]` items: it never imports twice.
- S1-T4: polls until all ten are enriched, then finds them on the feedback detail page, Categories and Data Explorer.
- S1-T5…T8: the assistant (floating and /chat) judged by the tool calls and results in its SSE stream (`lib/sse.ts` taps `fetch`), a project created through an approval card, a project and settings read back, reload mid-stream and after completion, history in a fresh context, and the `e2e-user` write-tool permissions.
- S1-T9: Lambda `REPORT` lines for every step window (`lib/cloudwatch.ts`, read-only `aws logs filter-log-events` with the operator's own credentials) go to `lambda-reports.json`.

## QA track s2 (autonomous agents)

`tests/s2-agents.spec.ts` (QA track s2, autonomous agents) runs ALONE, without the shared setup/teardown: `npx playwright test -c playwright.config.ts --project=admin --no-deps tests/s2-agents.spec.ts`. It signs both roles in itself; it covers the assistant creating and editing an agent, the drag-and-drop workflow editor (native HTML5 drag, handle-to-handle connects, round-trip), Run now / Cancel with Step Functions history and Lambda `REPORT` lines (`lib/aws.ts`, read-only AWS CLI calls), duplicate/export/import, enable/disable, and e2e-user refusals. Its own `s2-99` cleanup archives the agent. It deletes this run's conversations and any project a run created (each run's journal is read again: `lib/agentRuns.ts`), then archives this run's workflows from the Workflow library on /agents (`lib/workflows.ts`: Archive → "Archive this workflow?" → `DELETE /workflows/{id}`), and checks the built-in has no Archive and answers 409; runs have no delete route and stay (named `e2e-<run id>-*`).

`tests/s2-workflow-rebuild.spec.ts` (F4, same gating: `--project=admin --no-deps`, signs both roles itself) rebuilds the
built-in workflow from a cleared canvas using only the palette and the side panel (steps, arrows with conditions,
loops opened by clicking their frame), saves it as an e2e-named workflow, diffs `GET /workflows/{new}` with
`GET /workflows/wf_default` (ids and positions aside), checks e2e-user's read-only view, and in `s2wr-99` archives
the agent, then its workflows from the Workflow library (`lib/workflows.ts`; the built-in has no Archive and `wf_default` answers 409). It also runs against the local dev
mock (`E2E_MOCK=1`, no login, user step skipped); the header comment has the commands.

## QA track s3 (personas and documents)

`tests/s3-personas-documents.spec.ts` (QA track s3) is a long, admin-only scenario. It generates personas and checks each avatar `<img>`, the signed CDN URL and the S3 object. It imports a persona and regenerates its avatar, creates a persona of its own (03c), edits it (Edit Persona → Save Changes) and deletes it through "Delete Persona?" (Cancel first keeps it), consults personas and asks the assistant about a document. It generates a PRD and PR-FAQ (wizard and assistant), edits them (editor and assistant approval), then runs remix, Markdown/TXT/PDF export, research and a prototype smoke test. Finally it deletes the project and proves the avatars were swept: every object under `avatars/{persona_id}/` (plus the legacy flat keys) is listed before and after, and the "before" listing must contain every key a persona's `avatar_url` names. It also deletes every conversation the run started (from the ledger, by kind). Run it with `--project=admin --no-deps`; the spec deletes and proves its own project. Its helpers are:
- `lib/jobs.ts`: follows a job and records each poll, queue-to-start and total.
- `lib/cloudwatch.ts` and `lib/assistant.ts` (shared with s1 and s2, see below).

## QA track design (read-only audit)

`playwright.design.config.ts` runs `tests/design-*.spec.ts`: every screen and overlay as both roles at 1440 and 390 widths, in both themes, with the deep audit (`lib/deepAudit.ts`, `lib/designRun.ts`). It creates nothing, so it has no cleanup teardown. `E2E_MOCK=1` runs it against the local dev mock (admin projects only). Both runners share `lib/runConfig.ts`.

## Shared helpers (all tracks)

- `lib/test.ts`: every spec imports `test` from here. Its contexts strip persisted UI state (`voc-assistant-ui`, `voc-manual-import`) from both saved sessions once per spec file, and record every conversation a run starts (the `threadId` of each `POST /chat/stream`) in the ledger as the context's role, so cleanup never misses one whose save was refused. They also record every entity a browser create call makes (`POST /projects`, `/feedback-forms`, `/agents` with its workflow copy, `/workflows`, `/workflows/import`, `…/duplicate`; `lib/context.ts` `browserCreated`): the assistant's approved writes run in the SPA, so an entity the model named reaches the ledger too. Such an entry is labelled under the run prefix when its own name is not an e2e name. A spec that calls `browser.newContext` itself wraps it, in the same statement, in `prepareContext(context, role)` (`unit/helpers.spec.ts` fails otherwise); one that writes its session back uses `saveSession` (`lib/context.ts`), which drops the UI state too.
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
- `POST /scrapers/analyze-url` refuses the metadata IP, localhost, loopback and `file://` (400), and refuses a public URL that redirects to the metadata IP (override the redirector with `E2E_SSRF_REDIRECT_URL`). A malformed body (invalid JSON, or JSON that is not an object) must get a 400. Production currently answers 502 there, so this probe stays red until the handler is fixed;
- a junk `days` falls back to the route's default window instead of failing (`validate_days` never raises, so this is a 200, not a 400);
- e2e-user `DELETE /logs/validation/{source}` is a 403 (the admin is never sent it);
- error bodies are short and carry no exception text, traceback or path.

Its only write is an e2e-named feedback form, created only when no form exists. That form goes in the ledger and is deleted in `afterAll`. Run it alone with `npx playwright test -c playwright.config.ts tests/security-probes.spec.ts`.

## P3 specs (production and the local dev mock)

These run in the default production run (both roles; writes are admin-only and e2e-named) AND against the local dev mock (`E2E_MOCK=1`, see [Local dev mock](#local-dev-mock-e2e_mock1): no login, the mock API without auth; steps the mock cannot model skip and say why).

- `prioritization.spec.ts`: the board, and the public `/vote/:sessionId` in a fresh context with no session (an unknown id says so; its submit is a 404). The room vote end to end (open on the board, a phone ballot within the cap, a capped session refusing the next device with a 429, close, then refusal with a 409) runs on the mock only, because ballots have no TTL and no delete route.
- `account.spec.ts`: the caller's own "My objectives & KPIs" (`/settings/my-context`) saved through the UI, then the original objectives put back (also in `afterAll`) and proven equal. Also checks that `/company?tab=mine` lands on that same section.
- `in-page-tabs.spec.ts`: the 4 FormEditor tabs (Cancel at the end, nothing is written) and the 3 Admin logs sub-tabs, which must show no text block longer than 200 characters (2.12, no customer data).
- `i18n-smoke.spec.ts`: 8 locales × 5 screens, with the language set through `voc-language`. Checks `<html lang>`, that no raw key is on screen (it matches exact English key paths and `ns:key` references), and that nothing overflows horizontally.
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
- `prototype-enlarge.spec.ts`: Escape inside a prototype frame rewritten with `document.open()` closes the Enlarge overlay and returns focus to the button (#386). It also opens the tester pins panel. Production is read-only here: it uses an existing prototype or skips.
- `design-screens.spec.ts` "F7": no app-coloured solid background off the Kiro palette, and no `rgb(59, 130, 246)`, on 5 screens in both themes (`offPaletteFills` in `lib/design.ts`). Inline user colours, such as a customer's form theme, are only annotated.

## Evidence (`$E2E_OUT`)

- `steps/<role>-<theme>-<step>.json`: each step's network calls (method, path, status, duration), console errors and warnings, page errors, navigation timing, axe violations by impact, the design audit (off-palette colours, fonts, emojis, focus indicator), notes, and the screenshot path.
- `api-sweep-admin.json`, `api-sweep-user.json`, `created.json`, `cleanup-proof.json`, `playwright-results.json`.
- `node e2e/summarize.mjs "$E2E_OUT"` prints per-step pass/fail, API latency p50/p95 per endpoint, and axe totals.
