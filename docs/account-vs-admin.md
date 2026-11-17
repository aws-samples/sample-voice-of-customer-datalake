# Account or Administration: where a setting lives

Two pages hold every setting in the app. **Administration** (`/admin`) holds the settings of the **software** and
is for administrators. **Account** (`/account`) holds **my** personal preferences and is open to every signed-in
user. This page lists what is on each, and the rule that decides where a new setting goes.

| | **Administration** (`/admin`) | **Account** (`/account`) |
|---|---|---|
| What | How the **software** behaves for everyone: people, sources, logs, categories, boards, models, brand, privacy | **My** preferences: how the app looks, behaves and reports to me |
| Who | Admins only (`AdminRoute`; every write is `require_admin` server-side) | Every signed-in user; every route is self-scoped (`USER#{sub}`, `/settings/my-*`) |
| Effect of a change | Every user, every agent, the ingestion and processing pipeline | Only the person who made it |
| Typical store | `voc-aggregates` `SETTINGS#*`, Secrets Manager, Cognito groups, CloudWatch/SNS | `/settings/my-*` rows keyed by the caller's sub, or this browser's local storage |

Open Administration from the sidebar (Administration section) and Account from the account menu (**My profile**).

## Administration: a home and nine tabs (7.54.00)

`/admin` is the **home** (`frontend/src/pages/Settings/SettingsHome.tsx`): the search (`/` focuses it on every
Administration page), **Needs attention** (the sources a circuit breaker paused, the people with no way of working
saved, the AI models this account cannot call; nothing while nothing does), the four groups below (Everyday as cards
with a count, the others as links), what lives elsewhere (Agents → Spend and Connections, Account → Preferences), and
the footer **Version X · Release notes** (`/admin/version`). Below `lg` the home is Administration's navigation.

Each tab is ONE page, `/admin/<tab>` (`frontend/src/pages/Settings/adminTabs.ts`, `adminPaths.ts`;
[Addresses](document-canvas.md#addresses)), ordered by the job an administrator comes to do and how often. Its
sections are **cards** on it: a path naming one, `/admin/<tab>/<section>`, scrolls that card into view and focuses it.
There is no second row of tabs. A tab's page has a header (a link **← Administration** to the home, the tab's name as
its heading, its job in one line); from `lg` up the groups and their tabs are on its left (`AdminNav.tsx`, the open
tab's link `aria-current="page"`). There is **no page-level Save**: every card saves itself and says "Saved" until its
next edit (`components/SavedStatus`).

| Group | Tab (`/admin/<tab>`) | Cards (`/admin/<tab>/<section>`) |
|---|---|---|
| Everyday | People (`people`) | One table of everyone who can sign in (name, role, way of working, flags, status) and **Invite person** (`/admin/people/invite`); a person's editor, a side sheet at `/admin/people/<username>`: role, category and source access, way of working with AI, fallback owner, memory reviewer, platform admin (platform admins only), name, reset password, disable / enable, and Delete at its foot |
| Everyday | Data sources (`sources`) | The source cards, paused or failing first (credentials, schedules, circuit breakers), one opened at `/admin/sources/<source>`; inside a workspace, for a platform admin, the scope switch **This workspace \| Deployment** (`?scope=deployment`: the deployment's own sources, [multi-workspace.md](multi-workspace.md#the-deployments-data-sources-75000)); **Advanced** (folded, administrators, this workspace's view): Email inbox (`inbox`), Radar (`radar`), Design-system tokens (`tokens`: the Figma and GitHub tokens) |
| Everyday | Logs (`logs`) | Summary; System errors, validation failures, processing errors, scraper runs; Alerts |
| Regularly | Categories (`categories`) | Categories (AI generation, reprocess); Dimensions (`dimensions`) |
| Regularly | Feedback boards (`boards`) | The [feedback boards](feature-requests.md) (a board's editor: `/admin/boards/<boardId>`); Company domains (`domains`); Participant email (`participants`) |
| Set up once | AI models (`ai`) | Per-surface model picker, model test, capacity |
| Set up once | Brand & appearance (`brand`) | Brand (names, handles, hashtags, URLs); Default theme (`theme`: the colour theme everyone starts with). Local dev builds only: the API endpoint, under Advanced |
| Rare | Privacy (`privacy`) | Source policies (profiles, PII, retention, restriction); the erasure panels (`erasure`) |
| Rare | Platform (`platform`, platform admins only) | Workspaces; Deployment brand (`deployment-brand`) |
| (none) | Version (`version`, from the home's footer) | The build stamps and the release notes |

Platform is shown to platform admins only (an administrator in `platform-admins`); an address of a tab or a card
hidden from the caller falls back like an unknown one.

No query names a tab or a section, and **no path of before 7.54.00 is aliased**: an unknown tab, every old one, is
replaced by the home `/admin`; an unknown or hidden section by its tab's path; an extra segment by the place's own
path (the query kept, a scope the caller may not use dropped). The `?tab=&section=` links of before 7.49.00 are not
read either. `/settings` stays an alias of `/admin` (the assistant's navigation links it).

| Before 7.54.00 | Since |
|---|---|
| `/admin` General (`/admin/brand`) | `/admin/brand` Brand & appearance; `/admin` is the home |
| `/admin/sources/plugins` Sources → Source settings | `/admin/sources` Data sources |
| `/admin/sources/integrations` Sources → Integrations | `/admin/sources/tokens` Data sources → Design-system tokens |
| `/admin/sources/inbox`, `/admin/sources/radar` | the same paths, in Data sources → Advanced |
| `/admin/data-sources[/<source>]` (platform admins, 7.50.00) | `/admin/sources[/<source>]?scope=deployment` |
| `/admin/taxonomy/categories`, `/admin/taxonomy/dimensions` | `/admin/categories`, `/admin/categories/dimensions` |
| `/admin/access/policies` Privacy & access → Source policies | `/admin/privacy` Privacy |
| `/admin/access/users` Privacy & access → Users | `/admin/people` People |
| `/admin/access/boards[/<id>]` Privacy & access → Boards | `/admin/boards[/<id>]` Feedback boards |
| `/admin/access/workspaces` Privacy & access → Workspaces | `/admin/platform` Platform |
| `/admin/system/logs`, `/admin/system/version` | `/admin/logs`, `/admin/version` |

Inside a workspace every path is prefixed `/workspace/<slug>` as before (`/workspace/acme/admin/platform`).

### Users

The users API behind People (`lambda/api/users_handler.py`, rules in `lambda/shared/user_admin_guard.py`) keeps a deployment
administrable for every client (the SPA, the AI assistant, a plan step, a script). It answers **409**, and changes
nothing, when:

- an administrator changes their OWN role to non-admin (`PUT /users/{username}/group`), disables
  (`PUT /users/{username}/disable`) or deletes (`DELETE /users/{username}`) their own account:
  `You cannot change the role of your own account. Ask another administrator.` (`disable` / `delete` in place of
  `change the role of`);
- the target is the LAST enabled member of the `admins` group and the request demotes, disables or deletes it:
  `This is the last enabled administrator: make another user an administrator first.`;
- the target is the LAST enabled member of `platform-admins` and the request demotes, disables, deletes or revokes
  it (`PUT /users/{username}/platform-admin` with `{"platform_admin": false}`, the caller's own revoke included):
  `This is the last enabled platform admin: make another administrator a platform admin first.`;
- since 6.11.00, the request deletes the LAST member admin of a workspace and the caller is not a platform admin:
  `This user is the last admin of the workspace "…": make another member an admin there first, or ask a platform
  admin to delete the user and name a new admin afterwards.` A delete that passes removes the user's workspace
  memberships, each audited, before the Cognito account ([multi-workspace.md](multi-workspace.md#invites) → Invites).

It answers **403** when a caller outside `platform-admins` demotes, disables, enables, deletes or resets the password
of a platform admin (`Only a platform admin can disable a platform admin.`, and so on), or calls
`PUT /users/{username}/platform-admin` at all. That route grants (`true`, only to an administrator: 400 otherwise) or
revokes (`false`) the group; a demotion to `users` revokes it too. Every grant and revoke, a delete of a platform
admin included, first writes an `AUDIT#platform-admins` row in `voc-aggregates`, which records the attempt (a change
that then fails leaves the row) ([multi-workspace.md](multi-workspace.md) → Control plane). `GET /users` reports `platform_admin` per user.

The SPA and the assistant's `update_user` card check the own-account and last-admin rules before asking (the
platform-admin rules only the API checks); the API is the rule (TENETS.md tenet 4). A Cognito fault during the check answers the route's own fixed error message (500). Cognito has no
conditional write, so the last-admin and last-platform-admin checks read before they write: two administrators who
demote, disable or delete each other at the same moment can both pass them. An account administrator can always restore an admin in the AWS
console.

## Account: five tabs

Each tab is a path, `/account/<id>` (`frontend/src/pages/Account/accountSections.ts`). `/account` opens Preferences
(7.54.00), the tab people come for most; the tab bar keeps its order, Profile first. An unknown id opens Preferences
too. The query links of before (`?tab=<id>`, the 5.09–5.11 `?section=<id>`, Company's `?tab=mine`) are not
redirected (7.49.00, a pre-release change).

| Tab (`/account/<id>`) | Cards | Store |
|---|---|---|
| Profile (`profile`) | Profile: name, email, username, role, groups (read-only); Change password; Sign out | Cognito |
| Preferences (`preferences`) | Language & theme (language, light or dark, colour theme: Workspace default or one of the themes); Setup checklist "Show on Home", start page ("Open the dashboard when I sign in"), "How it works" (`guide`); Assistant: desktop notifications (the same setting as the panel bell), "Reset bubble position"; This browser: the API endpoint (read-only), "Reset local settings" | `voc-language`, `voc-theme`; `/settings/my-onboarding`; `voc-assistant-ui` `notify`, `voc-assistant-bubble`; `voc-config` |
| Morning brief (`briefing`) | On/off, time, brief language, custom instructions, email to my verified address ([briefing.md](briefing.md)) | `/settings/my-briefing` |
| Objectives (`objectives`) | My own objectives and KPIs ([company-context.md](company-context.md)) | `/settings/my-context` |
| Access & tokens (`access`) | My access: role, category and source scope (read-only; an admin changes it in Administration → People); MCP tokens: a link to Connect, where tokens are created, audited and revoked ([mcp.md](mcp.md)) | `GET /feedback/access`; `/connect/tokens` |

Home's Settings button links to `/account/briefing`. The "Go to settings" buttons shown when no API endpoint is set
(Dashboard, Feedback Forms, Scrapers) link to `/account/preferences`, where This browser sits, because `/admin` would
turn a non-admin away.

Language, theme, the assistant settings and `voc-config` (the API endpoint, the header's time range and date basis)
live in this browser's local storage. They do not follow a user to another device, and `voc-config` is shared by
everyone who uses the same browser.

## Where each setting lives

| Setting | Home | Notes |
|---|---|---|
| Profile (name, email, role, groups), password | Account → Profile | |
| Language, light or dark, colour theme | Account → Preferences | the header theme toggle is a shortcut to the same light/dark preference; the colour theme "Workspace default" follows Administration → Brand & appearance → Default theme |
| My objectives and KPIs | Account → Objectives | |
| Morning brief: on/off, time, language, instructions, email | Account → Morning brief | Home keeps the brief, Refresh, the card actions and, while not subscribed, a one-click Subscribe with a "Customise in Account" link |
| Setup checklist, start page, "How it works" | Account → Preferences | Home keeps its in-place controls (Skip, Hide, Show setup checklist); both read the same preference |
| Assistant desktop notifications, bubble position | Account → Preferences → Assistant | the panel bell is a shortcut to the same setting |
| My category and source access | Account → Access & tokens (read-only) | set by an admin in Administration → People (the person's editor) |
| Reset local settings | Account → Preferences → This browser | clears only this browser's `voc-config` |
| API endpoint | Administration → Brand & appearance → Advanced (local dev builds only) | Account → Preferences → This browser shows it read-only |
| MCP tokens, signed-in assistants | Connect (`/connect`) | Account → Access & tokens links there |
| Assistant web search | the assistant composer toggle | a per-conversation choice |
| Time range and date basis | the header selector on data pages | stored in `voc-config`; the default is the last 14 days by imported date |
| Personal memories | Memory → Personal | a working tool, not a setting |
| My conversations | the assistant sidebar | content, not a setting |
| Brand (name, handles, hashtags, URLs) | Administration → Brand & appearance | |
| Default theme (the colour theme everyone sees until they pick their own) | Administration → Brand & appearance → Default theme | `GET /settings/appearance` (everyone) / `PUT` (platform admins, checked live: one colour scheme for the whole deployment, [Multi-workspace](multi-workspace.md#per-workspace-configuration)); everyone else, a plain admin included, sees it read-only |
| Data sources, credentials, schedules, circuit breakers | Administration → Data sources | the deployment's own: its Deployment scope (platform admins) |
| Design-system tokens (Figma and GitHub), Email inbox, Radar | Administration → Data sources → Advanced | |
| Categories, AI generation, reprocess; Dimensions | Administration → Categories | |
| Source profiles (PII, retention, restricted), erasure | Administration → Privacy | |
| People: invite, roles, category and source access, flags (fallback owner, memory reviewer), way of working with AI, platform admin | Administration → People (a person's editor) | it is about other users |
| Feedback boards, company domains, participant email | Administration → Feedback boards | |
| Workspaces, the deployment's brand | Administration → Platform | platform admins only |
| AI models per surface, model test, capacity | Administration → AI models | per-agent models are on the agent's Models tab |
| Logs, alerting, alert email recipients | Administration → Logs | ops recipients for the deployment, not personal notifications |
| App version and changelog | Administration → Version | the home's footer links it |
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

In Administration a new setting is a card on the tab whose job it serves (the groups above, `adminTabs.ts`), with
its own Save and its own "Saved"; a card a link must open gets a section id (`/admin/<tab>/<section>`).

A personal setting has one home, on Account. A feature page may keep a **shortcut** in place (the assistant's
notification bell, Home's subscribe card, the header theme toggle), and both places read the same preference, so
they never disagree. The brief email goes only to the account's own verified address.
