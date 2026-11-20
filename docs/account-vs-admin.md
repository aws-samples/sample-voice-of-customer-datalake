# Account or Administration: where a setting lives

Two pages hold every setting in the app. **Administration** (`/admin`) holds the settings of the **software** and
is for administrators. **Account** (`/account`) holds **my** personal preferences and is open to every signed-in
user. This page lists what is on each, and the rule that decides where a new setting goes.

| | **Administration** (`/admin`) | **Account** (`/account`) |
|---|---|---|
| What | How the **software** behaves for everyone: brand, sources, taxonomy, privacy and access, models, workspaces, engineering agents, logs | **My** preferences: how the app looks, behaves and reports to me |
| Who | Admins only (`AdminRoute`; every write is `require_admin` server-side) | Every signed-in user; every route is self-scoped (`USER#{sub}`, `/settings/my-*`) |
| Effect of a change | Every user, every agent, the ingestion and processing pipeline | Only the person who made it |
| Typical store | `voc-aggregates` `SETTINGS#*`, Secrets Manager, Cognito groups, CloudWatch/SNS | `/settings/my-*` rows keyed by the caller's sub, or this browser's local storage |

Open Administration from the sidebar (Administration section) and Account from the account menu (**My profile**).

## Administration: main's tabs (7.59.00)

Administration is one page with **main's tabbed layout** (`frontend/src/pages/Settings/Settings.tsx`,
`adminTabs.ts`, `adminPaths.ts`; [Addresses](document-canvas.md#addresses)): a header (**Administration**, its one
line, the workspace the app is in, and the **search**: `/` focuses it), a row of tabs, and on a tab with several
sections the **section switch** under it (`SectionSwitch.tsx`), one section at a time. From `md` up the tabs are a
WAI-ARIA tablist (arrow keys, Home and End move and select; it scrolls sideways when it does not fit); below `md` they
are a select. A tab's panel starts with its one line; on **General**, the first tab, a compact **Needs attention**
strip (the sources a circuit breaker paused, the people with no way of working saved, the AI models this account
cannot call, and since 7.60.00 the fine-grained tokens to replace while the Engineering agents tab is shown; nothing
while nothing does), and the tabs concerned carry a count badge. There is **no page-level
Save**: every card saves itself and says "Saved" until its next edit (`components/SavedStatus`), and its
unsaved-changes guard asks before its section (General's brand and theme: the tab) is left.

The tabs are main's six, in main's order, then the two voc-multiplayer added (System stays last):

| Tab (`/admin/<tab>`) | Sections (`/admin/<tab>/<section>`) and cards (`#<card>`) |
|---|---|
| General (`general`) | Brand (`#brand`: names, handles, hashtags, URLs; says where the form brand is set); Default theme (`#theme`: the colour theme everyone starts with). Local dev builds only: the API endpoint, under Advanced (`#api`) |
| Sources (`sources`) | Source settings (`plugins`: the source cards, paused or failing first, credentials, schedules, circuit breakers, one opened at `/admin/sources/plugins/<source>`; inside a workspace, for a platform admin, the scope switch **This workspace \| Deployment**, `?scope=deployment`: the deployment's own sources, [multi-workspace.md](multi-workspace.md#the-deployments-data-sources-75000)); Integrations (`integrations`: the Figma and GitHub tokens); Email inbox (`inbox`); Radar (`radar`) |
| Taxonomy (`taxonomy`) | Categories (`categories`: AI generation, reprocess); Dimensions (`dimensions`) |
| Privacy & access (`access`) | Source policies (`policies`: profiles, PII, retention, restriction; the erasure panels `#erasure`); Users (`users`: one table of everyone who can sign in and **Invite person**, `/admin/access/users/invite`; a person's editor, a side sheet at `/admin/access/users/<username>`); Boards (`boards`: the [feedback boards](feature-requests.md), a board's editor at `/admin/access/boards/<boardId>`; Company domains `#domains`; Participant email `#participants`) |
| AI models (`ai`) | Per-surface model picker, model test, capacity |
| Workspaces (`workspaces`) | Inside a workspace: This workspace (`settings`: its name, brand, plugins, categories, dimensions, source policies, export and delete, the cards of its Workspace settings page) and Members (`members`); platform admins: All workspaces (`all`) and Deployment brand (`deployment-brand`) |
| Engineering agents (`agents`) | While the Agents page and the engineering module are on: Hard cap (`#hard-cap`, Agents › Spend's switch); Roles' models (`#models`: each role, the harness it runs on, Kiro or native, and its model, linked to its Registry card where it is chosen); GitHub connections (`#connections`: Connections, where a repository is added through the App, a fine-grained token or a fork, Spend, the setup guide, and since 7.60.00 the fine-grained tokens to replace, each with its expiry chip) |
| System (`system`) | Logs (`logs`: summary; system errors, validation failures, processing errors, scraper runs; alerts); Version (`version`: the build stamps and the release notes) |

A tab or a section hidden from the caller falls back like an unknown one: an unknown tab opens General, an unknown
section its tab's first. No query names a place (only Source settings' `?scope=`). The Workspace settings and Members
pages (`/workspace-settings`, `/members`) stay for every member of a workspace: Administration is the deployment's
administrators' only.

Addresses of before keep working; each is replaced in place by its new form (the query kept):

| Address | Now |
|---|---|
| `/settings[/<rest>]` (the assistant's navigation links it) | `/admin[/<rest>]` |
| `/admin` (7.54.00's home) | `/admin/general` |
| `/admin/<tab>#<section>` | `/admin/<tab>/<section>` |
| `/admin/people[/<username>\|/invite]` | `/admin/access/users[/<username>\|/invite]` |
| `/admin/sources[/<source>]`, `/admin/sources/tokens` | `/admin/sources/plugins[/<source>]`, `/admin/sources/integrations` |
| `/admin/logs`, `/admin/version` | `/admin/system/logs`, `/admin/system/version` |
| `/admin/categories[/dimensions]` | `/admin/taxonomy/categories`, `/admin/taxonomy/dimensions` |
| `/admin/boards[/<id>]`, `/admin/boards/domains`, `/admin/boards/participants` | `/admin/access/boards[/<id>]`, `…/boards#domains`, `…/boards#participants` |
| `/admin/brand[/theme]` (General before 7.54.00, Brand & appearance in it) | `/admin/general[#theme]` |
| `/admin/privacy[/erasure]` | `/admin/access/policies[#erasure]` |
| `/admin/platform[/deployment-brand]`, `/admin/access/workspaces` (before 7.54.00) | `/admin/workspaces/all`, `/admin/workspaces/deployment-brand` |
| `/admin/data-sources[/<source>]` (7.50.00) | `/admin/sources/plugins[/<source>]` |

The paths of 7.49.00 to 7.53.00 (`/admin/access/users`, `/admin/taxonomy/categories`, `/admin/system/logs`, …) are
this form already. Inside a workspace every path is prefixed `/workspace/<slug>` as before
(`/workspace/acme/admin/workspaces/all`).

### Users

The users API behind Privacy & access → Users (`lambda/api/users_handler.py`, rules in `lambda/shared/user_admin_guard.py`) keeps a deployment
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
| Access & tokens (`access`) | My access: role, category and source scope (read-only; an admin changes it in Administration → Privacy & access → Users); MCP tokens: a link to Connect, where tokens are created, audited and revoked ([mcp.md](mcp.md)) | `GET /feedback/access`; `/connect/tokens` |

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
| Language, light or dark, colour theme | Account → Preferences | the header theme toggle is a shortcut to the same light/dark preference; the colour theme "Workspace default" follows Administration → General → Default theme |
| My objectives and KPIs | Account → Objectives | |
| Morning brief: on/off, time, language, instructions, email | Account → Morning brief | Home keeps the brief, Refresh, the card actions and, while not subscribed, a one-click Subscribe with a "Customise in Account" link |
| Setup checklist, start page, "How it works" | Account → Preferences | Home keeps its in-place controls (Skip, Hide, Show setup checklist); both read the same preference |
| Assistant desktop notifications, bubble position | Account → Preferences → Assistant | the panel bell is a shortcut to the same setting |
| My category and source access | Account → Access & tokens (read-only) | set by an admin in Administration → Privacy & access → Users (the person's editor) |
| Reset local settings | Account → Preferences → This browser | clears only this browser's `voc-config` |
| API endpoint | Administration → General → Advanced (local dev builds only) | Account → Preferences → This browser shows it read-only |
| MCP tokens, signed-in assistants | Connect (`/connect`) | Account → Access & tokens links there |
| Assistant web search | the assistant composer toggle | a per-conversation choice |
| Time range and date basis | the header selector on data pages | stored in `voc-config`; the default is the last 14 days by imported date |
| Personal memories | Memory → Personal | a working tool, not a setting |
| My conversations | the assistant sidebar | content, not a setting |
| Brand (name, handles, hashtags, URLs) | Administration → General | |
| Default theme (the colour theme everyone sees until they pick their own) | Administration → General → Default theme | `GET /settings/appearance` (everyone) / `PUT` (platform admins, checked live: one colour scheme for the whole deployment, [Multi-workspace](multi-workspace.md#per-workspace-configuration)); everyone else, a plain admin included, sees it read-only |
| Data sources, credentials, schedules, circuit breakers | Administration → Sources → Source settings | the deployment's own: its Deployment scope (platform admins) |
| Design-system tokens (Figma and GitHub), Email inbox, Radar | Administration → Sources → Integrations, Email inbox, Radar | |
| Categories, AI generation, reprocess; Dimensions | Administration → Taxonomy → Categories, Dimensions | |
| Source profiles (PII, retention, restricted), erasure | Administration → Privacy & access → Source policies | |
| People: invite, roles, category and source access, flags (fallback owner, memory reviewer), way of working with AI, platform admin | Administration → Privacy & access → Users (a person's editor) | it is about other users |
| Feedback boards, company domains, participant email | Administration → Privacy & access → Boards | |
| Workspaces, the deployment's brand | Administration → Workspaces → All workspaces, Deployment brand | platform admins only |
| This workspace's own settings and members | Administration → Workspaces → This workspace, Members | also the Workspace settings and Members pages, for every member |
| The engineering agents' hard cap, each role's model, GitHub connections | Administration → Engineering agents | the hard cap is also on Agents › Spend; a role's model is chosen on its Registry card |
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

In Administration a new setting is a card on the tab whose job it serves (the groups above, `adminTabs.ts`), with
its own Save and its own "Saved"; a card a link must open gets a section id (`/admin/<tab>/<section>`).

A personal setting has one home, on Account. A feature page may keep a **shortcut** in place (the assistant's
notification bell, Home's subscribe card, the header theme toggle), and both places read the same preference, so
they never disagree. The brief email goes only to the account's own verified address.
