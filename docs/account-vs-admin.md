# Account or Administration: where a setting lives

Two pages hold every setting in the app. **Administration** is protected and holds the settings of the
**software**. **Account** holds **my** personal preferences. The rule that decides between them:

| | **Administration** (`/admin`) | **Account** (`/account`) |
|---|---|---|
| What | How the **software** behaves for everyone: sources, taxonomy, privacy, users, models, operations | **My** preferences: how the app looks, behaves and reports to me |
| Who | Admins only (`AdminRoute`; every write is `require_admin` server-side) | Every signed-in user; every route is self-scoped (`USER#{sub}`, `/settings/my-*`) |
| Effect of a change | Every user, every agent, the ingestion and processing pipeline | Only the person who made it |
| Typical store | `voc-aggregates` `SETTINGS#*`, Secrets Manager, Cognito groups, CloudWatch/SNS | `/settings/my-*` rows keyed by the caller's sub, or this browser's local storage |

Three tests, in order:

1. **Does it change what other people see or what the platform does?** Administration.
2. **Is it about me (my profile, my language, my brief, my notifications, my tokens, my objectives)?** Account.
3. **Is it a working tool or shared content rather than a setting** (data explorer, scrapers, forms, memory,
   company context, projects, agents)? It keeps its own page; neither settings page duplicates it, at most it
   links there.

A personal setting has ONE home, on Account. A feature page may keep a **shortcut** in place (the assistant's
notification bell, Home's subscribe call to action, the header theme toggle), and both places read the same
preference, so they never disagree.

## Administration: six tabs (5.09)

| Tab (`?tab=`) | Sections (`&section=`) | Admin-only |
|---|---|---|
| General (`brand`) | Brand (names, handles, hashtags, URLs). Local dev only: API configuration | Edit admin; non-admins see it read-only |
| Sources (`sources`) | Data sources (`plugins`), Integrations, Email inbox (`inbox`), Radar | Integrations, Email inbox, Radar |
| Taxonomy (`taxonomy`) | Categories, Dimensions | Dimensions |
| Privacy & access (`access`) | Source policies (`policies`: profiles, PII, retention, restriction, erasure), Users (roles, category and source access, flags, participant email), Boards (`boards`: company domains and the [feedback boards](feature-requests.md)) | All (tab hidden otherwise) |
| AI models (`ai`) | Per-surface model picker, model test, capacity | Edit admin |
| System (`system`) | Logs (incl. Alerts), Version | Version |

Every pre-5.09 tab id still deep-links and is replaced by its canonical URL (`frontend/src/pages/Settings/adminTabs.ts`):
`plugins`, `integrations`, `radar` → Sources; `categories`, `dimensions` → Taxonomy; `users` → Privacy & access;
`logs`, `version` → System. `sources` is the Sources tab's own id now, so `?tab=sources` without a section (or with an
unknown one) opens its first section; the pre-5.09 "Sources & privacy" alias is gone (use
`?tab=access&section=policies` for Source policies). General holds software settings only: the
per-browser "Reset local settings" (the old Danger zone) moved to Account → Preferences → This browser.

## Account: five tabs (5.12)

The same top tab bar as Company, Memory and the project pages (design system "Tabs (segmented pill)": `tabs-rail`
/ `tabs-track` / `tab`), one tab at a time, each a deep link `/account?tab=<id>`
(`frontend/src/pages/Account/accountSections.ts`). A switch replaces the query, like the other pages' tabs. Unknown
ids open Profile. The 5.09–5.11 `?section=<id>` links map to the tab that holds that card and are replaced by the
canonical `?tab=` URL; Company's `?tab=mine` lands on Objectives.

| Tab (`?tab=`) | Cards | Store | Was (`?section=`) |
|---|---|---|---|
| Profile (`profile`) | Profile: name, email, username, role, groups (read-only); Change password; Sign out | Cognito | `profile`, `password`, `signout` |
| Preferences (`preferences`) | Language & theme; Setup checklist "Show on Home", start page, "How it works" (`guide`); Assistant: desktop notifications (the same setting as the panel bell), "Reset bubble position"; This browser: the API endpoint, "Reset local settings" | `voc-language`, `voc-theme`; `/settings/my-onboarding`; `voc-assistant-ui` `notify`, `voc-assistant-bubble`; `voc-config` | `preferences`, `assistant`, `browser` |
| Morning brief (`briefing`) | On/off, time, brief language, custom instructions, email to my verified address | `/settings/my-briefing` | `briefing` |
| Objectives (`objectives`) | My own objectives and KPIs | `/settings/my-context` | `objectives` |
| Access & tokens (`access`) | My access: role, category and source scope (read-only; an admin changes it in Privacy & access → Users); MCP tokens: pointer to Connect, where tokens are minted, audited and revoked | `GET /feedback/access`; `/connect/tokens` | `access`, `mcp` |

Why five: the 5.09 rail had ten one-card sections in a left column, a layout no other page uses. Cards that
answer the same question now share a tab: who I am and how I sign in (Profile), how the app behaves for me in
this browser (Preferences), and what I can reach (Access & tokens).

Home links its Settings button to `?tab=briefing`; the "Go to settings" buttons shown when no API endpoint is
set (Dashboard, Feedback Forms, Scrapers) link to `?tab=preferences`, where This browser sits (`/admin` would
bounce a non-admin).

## Audit: every setting, where it belongs, and its status

| Setting | Was | Belongs | Status |
|---|---|---|---|
| Profile (name, email, role, groups) | Account | Account → Profile | No change |
| Language, theme | Account (theme also a header toggle) | Account → Preferences; the header toggle stays as a shortcut | No change |
| Change password | Account | Account → Profile → Change password | No change |
| My objectives & KPIs | Account | Account → Objectives | No change (moved from Company earlier) |
| **Morning brief**: on/off, time, language, instructions, email | Home → "Brief settings"; until 5.10 Home's subscribe card also carried a "Time to send" hour picker | **Account → Morning brief** only; Home keeps the brief, Refresh, card actions and, while not subscribed, a one-click Subscribe (the default hour, the browser's time zone) with a "Customise in Account" link to `/account?tab=briefing` — no settings fields on Home | **Done** (5.09; the hour picker left Home in 5.10) |
| Setup checklist "Show on Home", start page | Home + Account | Account → Preferences; Home keeps its in-place controls (Skip, Hide, the start-page switch) | Done (one preference, both places) |
| "How it works" expanded / skipped (`guide`) | Home only | Account → Preferences (switch); Home keeps its collapse and Skip | **Done** (5.09) |
| Assistant desktop notifications | Assistant panel bell only | Account → Preferences → Assistant, reading the same store; the bell stays | **Done** (5.09) |
| Assistant bubble position | Drag only, no reset | Account → Preferences → Assistant → "Reset bubble position" | **Done** (5.09) |
| My category / source access | Admin → Privacy & access → Users (admins only) | Account → Access & tokens → My access, read-only | **Done** (5.09) |
| "Reset local settings" (Danger zone) | Administration → General | **Account → Preferences → This browser**: it clears only this browser's `voc-config`, and non-admins could not reach it | **Done** (5.09) |
| "Go to settings" when no API endpoint | Linked to `/admin` | Account → Preferences (This browser) | **Done** (5.09) |
| API endpoint field | Administration → General (dev builds only) | Stays (developer tool, hidden in production); Account → Preferences → This browser shows it read-only | No change |
| MCP tokens | Connect + Account pointer | Connect stays the full page (endpoint, snippets, audit); Account links to it | No change. Proposed: list my live tokens (count, expiry) in Account → Access & tokens → MCP tokens |
| Assistant web search default | Assistant composer toggle (`voc-assistant-ui` `useWebSearch`) | Account → Preferences → Assistant could show the default; the composer toggle stays | Proposed (a per-conversation choice today; decide whether it is a preference first) |
| Default time range and date basis | Header selector on data pages (`voc-config`, shared by everyone on this browser). The app default is the last 14 days by imported date (5.47.00; was 7 days): a browser still on the old default (7 days, imported date) moves to it once, any other saved choice is kept | Stays in place as a view control; an optional default could live in Account → Preferences | Proposed (needs a per-user store: `voc-config` is not keyed by user) |
| Personal memories | Memory page (scope filter) | Memory (a working tool); Account may link "My memories" | Proposed (link only) |
| My conversations | Assistant sidebar | Content, not a setting | No change |
| App version | Administration → System → Version | Admin; a read-only version line on Account → Profile would help bug reports | Proposed |
| Project Product-tab mode | localStorage per project | View state, not a preference | No change |
| Brand (name, handles, hashtags, URLs) | Administration → General | Administration | No change |
| Data sources, credentials, schedules, circuit breakers | Administration → Sources | Administration | No change |
| Integrations (Figma/GitHub secrets), Email inbox, Radar | Administration → Sources | Administration | No change |
| Categories, AI generate, reprocess; Dimensions | Administration → Taxonomy | Administration | No change |
| Source profiles (PII, retention, restricted), erasure | Administration → Privacy & access | Administration | No change |
| Users, roles, category and source access, user flags | Administration → Privacy & access → Users | Administration (it is about other users) | No change |
| AI models per surface, model test, capacity | Administration → AI models | Administration | No change |
| Logs, alerting, SNS alert recipients | Administration → System → Logs | Administration (ops recipients for the deployment, not personal notifications) | No change |
| Company vision & objectives, design system | Company page (admins edit, everyone reads) | Company (shared knowledge, not settings); Administration may link there | No change. Proposed: an Administration link card "Company context & design" |
| Resolved problems marks | Problem Analysis | Shared team state | No change |
| Scrapers, feedback forms, agents and workflows | Their pages | Feature objects | No change |
| Plugin and menu visibility | `cdk.context.json` (deploy time) | Deploy configuration, no UI | No change |
| Agents' models | Agent detail → Models + AI models defaults | Defaults in Administration, per-agent on the agent | No change |

### Open follow-ups

- **Per-browser vs per-user.** Language, theme, assistant settings and `voc-config` live in this browser's local
  storage: they do not follow the user to another device, and `voc-config` is shared by everyone on a browser. If
  Account is to be "my preferences everywhere", a `/settings/my-preferences` row (local storage as a cache) is the
  next step: a minor version with a new route, its mock and a `mock-coverage.json` entry.
- The brief email goes only to the account's own verified address; keep that rule wherever the setting moves.
