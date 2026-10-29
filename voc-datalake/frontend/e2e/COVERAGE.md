# e2e coverage map

Every user-facing page, tab, dialog and flow of the app (5.35), against the Playwright specs in `tests/`. Sources:
`src/routes.tsx`, each page's `?tab=` parser, the sidebar (`components/Layout/Layout.tsx`), `docs/*.md` and the
CHANGELOG from 5.00.00 to 5.34.00. Update this file in the same change as a new screen or a new spec.

- **Covered**: a spec drives the flow and asserts its outcome.
- **Partial**: the screen renders in `screens.spec.ts` (every `lib/inventory.ts` location, both roles, budgets, axe)
  or the design track, but no spec drives its flow; the gap is named.
- **Missing**: no spec yet; the reason is named.

`M` = also runs against the local dev mock (`MOCK_SPEC_NAMES` in `lib/env.ts`). Every location in the tables is in
`lib/inventory.ts`, so `screens.spec.ts` and the design track visit it whatever else covers it.

## Signed-in pages

| Feature | Location | Status | Spec |
|---|---|---|---|
| Home: greeting, morning brief, "Your brief", "Things to do", agent-decision card | `/` | Covered | surfaces M |
| Home: onboarding buddy (checklist, Skip, Hide, Don't show again) | `/` | Covered | home-onboarding |
| Home: brief subscribe / Brief settings save, card dismiss (5.23) | `/` | Missing | writes the caller's brief subscription; needs a restore like account.spec |
| Dashboard: tiles and charts vs the API, empty-workspace welcome | `/dashboard` | Covered | dashboard-data |
| Dashboard: custom time range popover | `/dashboard` | Covered | modals M |
| Dashboard: GitHub insights / release watch per release | `/dashboard` | Partial | screens only (needs GitHub Issues data) |
| Feedback detail, `/feedback` redirect | `/feedback/{id}` | Partial | screens; s1-a (s1 track only) |
| Review window (5.15): deep link, Escape, no prev/next | `?review=<id>` | Covered | surfaces M |
| Categories: breakdown, one entities request | `/categories` | Covered | request-counts M, error-states M |
| Categories: correct a review's category / dimensions (`PUT /feedback/{id}/…`) | review window | Missing | feedback has no delete: an edit cannot be reverted with proof outside the s1 track |
| Problem Analysis | `/problems` | Partial | screens, error-states |
| Radar: brands, compare, releases, reviews dialog (Scan now never pressed) | `/radar` | Covered | radar M |
| AI Chat page, floating assistant, sessions drawer | `/chat` | Covered | s1-b, assistant-bubble, modals M, network M, concurrency M |
| Assistant notifications (More actions → Notify me) | panel | Covered | assistant-notifications M (keyboard and pointer) |
| Assistant plan mode (propose_plan, plan card, `/agents/plans`) | panel | Missing | spends Bedrock and starts a Step Functions run; needs an opt-in like `E2E_ASSISTANT_SEND` |
| Projects list, create, edit, share, delete | `/projects` | Covered | writes, projects-edit, sharing M |
| Project Overview / Documents / remix / export / research / prototype | `?tab=overview\|documents` | Covered | s3-personas-documents, prototype-enlarge M, concurrency M |
| Project Personas: generate, import, edit, delete, avatar regenerate | `?tab=personas` | Covered | s3-personas-documents |
| Every persona has a loaded avatar (project page and agent runs) | `?tab=personas` | Covered | persona-avatars M (agent part: production, when the run made a project), s3 step 02, s2 (soft) |
| Project Product tab (5.32): "Fill with AI assistant" prefilled draft | `?tab=product` | Covered | product-interview M (send only with `E2E_ASSISTANT_SEND=1` in prod) |
| Project Decisions (5.04): create, edit, delete | `?tab=decisions` | Covered | decisions M |
| Decision release watch (`launched_at`) | `?tab=decisions` | Missing | needs a dated launch with feedback before and after it |
| Project Participants (5.33): link / unlink a list, reach | `?tab=participants` | Covered | participants M |
| `?tab=mcp` rewritten, Connect via MCP | project header | Covered | projects-mcp-removed |
| Prioritization board, batched project reads | `/prioritization` | Covered | prioritization M, prioritization-requests M |
| Room vote and the public ballot | `/vote/:id` | Covered | prioritization M (end to end on the mock only: ballots have no delete) |
| Data Explorer (admin) | `/data-explorer` | Partial | screens; s1-a (s1 track only) |
| Data sources: New source menu, every tile's dialog, enabled plugins only | `/scrapers` | Covered | modals M, s1-a |
| Data sources: scraper analyze-url, save Manual only, delete | `/scrapers` | Covered | writes |
| Manual import date gate (cancelled at preview) | `/scrapers` | Covered | writes |
| Feedback forms: create, public config / iframe, delete, editor tabs | `/feedback-forms` | Covered | writes, in-page-tabs M, request-counts M |
| Participants (5.33): lists CRUD, add person, search, person modal, erase | `/participants?tab=lists\|people` | Covered | participants M |
| Participants asks: composer validation, Send disabled when email is off | `?tab=asks` | Covered | participants M (a real send: mock only) |
| Feedback boards (5.36): nav rename, board list cards, Open, admin Edit / gear links, user without admin controls | `/feature-requests` | Covered | feedback-boards M |
| Board requests (Sales board): create, +1 in USD, search/filter/sort, `?request=`, status, delete, user refusals | `/feature-requests/{slug}` | Covered | feature-requests M |
| Board request → Promote to project | `/feature-requests/{slug}` | Missing | creates a project and may email supporters |
| Board templates' fields (Service, Beta): create with their fields, totals | `/feature-requests/{slug}` | Partial | unit tests (BoardTemplates, FeatureBoard); screens only in e2e |
| Standalone board for the board pool: list, one board, login | `/board`, `/board/{slug}`, `/board/login` | Covered | board M |
| Administration → Privacy & access → Boards: company domains, board list, editor open / back | `/admin?tab=access&section=boards[&board=<id>]` | Covered | feedback-boards M, surfaces M |
| Boards admin writes: create, save fields / statuses / audience, archive, delete, 409s | `?tab=access&section=boards` | Partial | unit tests (BoardEditor, BoardsSection); e2e is read-only here (every board save rewrites the shared board-pool sign-up audience row) |
| Memory: personal add / forget / restore, review queue errors | `/memory?tab=personal\|company\|review\|imports` | Covered | memory M, error-states M |
| Memory imports, company memory curation | `?tab=imports\|review` | Partial | screens only |
| Company: vision, design system; `?tab=mine` redirect | `/company?tab=vision\|design` | Covered | surfaces M, account M |
| Company design system from a website / GitHub (5.21) | `?tab=design` | Missing | third-party fetch, which the suite never does |
| Autonomous agents: create, edit, workflow editor, run, cancel, duplicate, export | `/agents`, `/agents/{id}?tab=…` | Covered | s2-agents, s2-workflow-rebuild M, concurrency M |
| Agents view tabs, Workflow library (admin) | `/agents?tab=workflows` | Covered | surfaces M, s2-workflow-rebuild M |
| Workflow page and revision History (5.30) | `/agents/workflows/{id}` | Covered | workflow-history M, workflow-custom-arrows |
| Connect: mint, use, revoke a global MCP token | `/connect` | Covered | connect M |
| Account: five tabs, legacy `?section=` | `/account?tab=profile\|preferences\|briefing\|objectives\|access` | Covered | surfaces M |
| Account: My objectives & KPIs saved and restored | `?tab=objectives` | Covered | account M, unsaved-guard |
| Account: language (9 locales) | `?tab=preferences` | Covered | i18n-smoke M, surfaces M (de: participants, featureRequests) |
| Administration: every tab and section | `/admin?tab=…&section=…` | Covered | surfaces M (renders, canonical URL, version string) |
| Admin: plugins status, users + category access, logs sub-tabs | `/admin` | Covered | request-counts M, modals M, in-page-tabs M |
| Admin: Logs → Alerts, inbox, radar brands, dimensions, policies, erasure | `/admin` | Partial | render only: each is a deployment-wide setting, never written by the suite |
| Admin: AI models test / capacity | `?tab=ai` | Partial | screens only (a model test spends Bedrock) |

## Public pages (no session)

| Feature | Location | Status | Spec |
|---|---|---|---|
| Login, session expiry, silent refresh | `/login` | Covered | auth.setup, auth-session M |
| Unsubscribe: no POST on load, invalid token, incomplete link | `/unsubscribe` | Covered | unsubscribe M |
| Board with the app session | `/board` | Covered | board M |
| Board sign-in form, refused domain (no code ever requested) | `/board/login` | Covered | board M (prod: only with a board pool) |
| Board sign-in with a real code | `/board/login` | Missing | needs a mailbox; the suite never requests a code |
| Public feedback form config / iframe | API | Covered | writes, security-probes |
| Public ballot | `/vote/:id` | Covered | prioritization M |

## Cross-cutting

| Check | Spec |
|---|---|
| Every inventory location, both roles, themes, latency budgets, axe | screens, design-screens |
| Error states (500, 403, timeout) on five screens | error-states M |
| Bad networks (slow 3G, offline, a cut stream) | network M |
| Unsaved-changes guard | unsaved-guard |
| Security probes (CORS, SSRF, error bodies, admin gates) | security-probes |
| GET of every endpoint | api-sweep |
| Ops: Lambda sizing, queues, alarms | ops-capacity, ops-postdeploy |
| Cleanup proof for every ledger kind | cleanup |
