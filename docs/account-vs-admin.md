# Account or Administration: where a setting lives

Two pages hold every setting in the app. **Administration** (`/admin`) holds the settings of the **software** and
is for administrators. **Account** (`/account`) holds **my** personal preferences and is open to every signed-in
user. This page lists what is on each, and the rule that decides where a new setting goes.

| | **Administration** (`/admin`) | **Account** (`/account`) |
|---|---|---|
| What | How the **software** behaves for everyone: sources, taxonomy, privacy, users, models, operations | **My** preferences: how the app looks, behaves and reports to me |
| Who | Admins only (`AdminRoute`; every write is `require_admin` server-side) | Every signed-in user; every route is self-scoped (`USER#{sub}`, `/settings/my-*`) |
| Effect of a change | Every user, every agent, the ingestion and processing pipeline | Only the person who made it |
| Typical store | `voc-aggregates` `SETTINGS#*`, Secrets Manager, Cognito groups, CloudWatch/SNS | `/settings/my-*` rows keyed by the caller's sub, or this browser's local storage |

Open Administration from the sidebar (Administration section) and Account from the account menu (**My profile**).

## Administration: six tabs

Each tab and section is a deep link, `/admin?tab=<tab>&section=<section>`
(`frontend/src/pages/Settings/adminTabs.ts`).

| Tab (`?tab=`) | Sections (`&section=`) |
|---|---|
| General (`brand`) | Brand (names, handles, hashtags, URLs). Local dev builds only: API configuration |
| Sources (`sources`) | Data sources (`plugins`), Integrations (`integrations`), Email inbox (`inbox`), Radar (`radar`) |
| Taxonomy (`taxonomy`) | Categories (`categories`), Dimensions (`dimensions`) |
| Privacy & access (`access`) | Source policies (`policies`: profiles, PII, retention, restriction, erasure), Users (`users`: roles, category and source access, flags, way of working with AI, participant email), Boards (`boards`: company domains and the [feedback boards](feature-requests.md)) |
| AI models (`ai`) | Per-surface model picker, model test, capacity |
| System (`system`) | Logs (`logs`, incl. Alerts), Version (`version`) |

Links written for releases before 5.09.00 still work and are replaced by their canonical URL: `?tab=plugins`,
`integrations`, `radar` open Sources; `categories`, `dimensions` open Taxonomy; `users` opens Privacy & access;
`logs`, `version` open System. The old `/settings` path redirects to `/admin`.

## Account: five tabs

Each tab is a deep link, `/account?tab=<id>` (`frontend/src/pages/Account/accountSections.ts`). An unknown id opens
Profile. The `?section=<id>` links of releases 5.09 to 5.11 open the tab that holds that card, and Company's old
`?tab=mine` lands on Objectives.

| Tab (`?tab=`) | Cards | Store |
|---|---|---|
| Profile (`profile`) | Profile: name, email, username, role, groups (read-only); Change password; Sign out | Cognito |
| Preferences (`preferences`) | Language & theme; Setup checklist "Show on Home", start page ("Open the dashboard when I sign in"), "How it works" (`guide`); Assistant: desktop notifications (the same setting as the panel bell), "Reset bubble position"; This browser: the API endpoint (read-only), "Reset local settings" | `voc-language`, `voc-theme`; `/settings/my-onboarding`; `voc-assistant-ui` `notify`, `voc-assistant-bubble`; `voc-config` |
| Morning brief (`briefing`) | On/off, time, brief language, custom instructions, email to my verified address ([briefing.md](briefing.md)) | `/settings/my-briefing` |
| Objectives (`objectives`) | My own objectives and KPIs ([company-context.md](company-context.md)) | `/settings/my-context` |
| Access & tokens (`access`) | My access: role, category and source scope (read-only; an admin changes it in Privacy & access → Users); MCP tokens: a link to Connect, where tokens are created, audited and revoked ([mcp.md](mcp.md)) | `GET /feedback/access`; `/connect/tokens` |

Home's Settings button links to `?tab=briefing`. The "Go to settings" buttons shown when no API endpoint is set
(Dashboard, Feedback Forms, Scrapers) link to `?tab=preferences`, where This browser sits, because `/admin` would
turn a non-admin away.

Language, theme, the assistant settings and `voc-config` (the API endpoint, the header's time range and date basis)
live in this browser's local storage. They do not follow a user to another device, and `voc-config` is shared by
everyone who uses the same browser.

## Where each setting lives

| Setting | Home | Notes |
|---|---|---|
| Profile (name, email, role, groups), password | Account → Profile | |
| Language, theme | Account → Preferences | the header theme toggle is a shortcut to the same preference |
| My objectives and KPIs | Account → Objectives | |
| Morning brief: on/off, time, language, instructions, email | Account → Morning brief | Home keeps the brief, Refresh, the card actions and, while not subscribed, a one-click Subscribe with a "Customise in Account" link |
| Setup checklist, start page, "How it works" | Account → Preferences | Home keeps its in-place controls (Skip, Hide, Show setup checklist); both read the same preference |
| Assistant desktop notifications, bubble position | Account → Preferences → Assistant | the panel bell is a shortcut to the same setting |
| My category and source access | Account → Access & tokens (read-only) | set by an admin in Administration → Privacy & access → Users |
| Reset local settings | Account → Preferences → This browser | clears only this browser's `voc-config` |
| API endpoint | Administration → General (local dev builds only) | Account → Preferences → This browser shows it read-only |
| MCP tokens, signed-in assistants | Connect (`/connect`) | Account → Access & tokens links there |
| Assistant web search | the assistant composer toggle | a per-conversation choice |
| Time range and date basis | the header selector on data pages | stored in `voc-config`; the default is the last 14 days by imported date |
| Personal memories | Memory → Personal | a working tool, not a setting |
| My conversations | the assistant sidebar | content, not a setting |
| Brand (name, handles, hashtags, URLs) | Administration → General | |
| Data sources, credentials, schedules, circuit breakers | Administration → Sources | |
| Integrations (Figma and GitHub tokens), Email inbox, Radar | Administration → Sources | |
| Categories, AI generation, reprocess; Dimensions | Administration → Taxonomy | |
| Source profiles (PII, retention, restricted), erasure | Administration → Privacy & access → Source policies | |
| Users, roles, category and source access, user flags, way of working with AI | Administration → Privacy & access → Users | it is about other users |
| Feedback boards and company domains | Administration → Privacy & access → Boards | |
| AI models per surface, model test, capacity | Administration → AI models | per-agent models are on the agent's Models tab |
| Logs, alerting, alert email recipients | Administration → System → Logs | ops recipients for the deployment, not personal notifications |
| App version and changelog | Administration → System → Version | |
| Company vision and objectives, design system, company personas | Company (`/company`) | shared knowledge: admins edit, everyone reads |
| Resolved problem marks | Problem Analysis | shared team state |
| Scrapers, feedback forms, agents and workflows | their own pages | feature objects, not settings |
| Plugin and menu visibility | `cdk.context.json` | deploy-time configuration, no UI |

## Placing a new setting

Ask three questions, in order:

1. **Does it change what other people see or what the platform does?** Administration.
2. **Is it about me (my profile, my language, my brief, my notifications, my tokens, my objectives)?** Account.
3. **Is it a working tool or shared content rather than a setting** (data explorer, scrapers, forms, memory,
   company context, projects, agents)? It keeps its own page; neither settings page duplicates it, at most it links
   there.

A personal setting has one home, on Account. A feature page may keep a **shortcut** in place (the assistant's
notification bell, Home's subscribe card, the header theme toggle), and both places read the same preference, so
they never disagree. The brief email goes only to the account's own verified address.
