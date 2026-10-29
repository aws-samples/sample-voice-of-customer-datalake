# Categories, Products and Access

Categories decide how every review is classified. Each category maps to the
**product** (or product area) it belongs to and the **product owners**
responsible for it: owners automatically see their categories' feedback and are
the people who act on it. Setting categories up is an essential onboarding step
(Home → "Set up your categories", then Administration → Taxonomy → Categories).

## Category configuration

Stored in `voc-aggregates` at `pk=SETTINGS#categories`, `sk=config` as
`{categories, updated_at}`. Each category:

| Field | Limit | Meaning |
|-------|-------|---------|
| `name` | snake_case, ≤64 chars, unique | The id stored on every feedback item (`category`) |
| `description` | ≤500 chars | Human label / explanation; also steers the classifier prompt |
| `product` | optional, ≤120 chars | The product or area the category belongs to |
| `owners` | optional, ≤20 × `{sub, username, email}` | Product owners accountable for the category |
| `subcategories` | optional, `[{id?, name, description}]` | Finer classification within the category |

At most 50 categories. `GET /settings/categories` is open to every signed-in
user; `PUT /settings/categories` is **admin-only** and validates the limits
above. `POST /settings/categories/generate` drafts categories with the model and
is **admin-only** too (it spends Bedrock and feeds the admin-only editor; owner
decision 2026-10-08, #242). Every mutating API route is classified as admin-only
or open-by-decision in `lambda/api/test/test_route_admin_gates.py`.

New feedback is classified against the current configuration by the processor
(prompt helpers in `lambda/shared/categorization.py`). Changing the
configuration does not touch stored feedback — use [reprocessing](#reprocessing-existing-feedback).

## Category access (who sees which reviews)

One row per restricted user in `voc-aggregates`:
`pk=CATEGORY_ACCESS`, `sk=USER#{sub}`, `{categories: ['*'] | [names…], updated_by, updated_at}`.

- **No row = all categories.** Deploying the feature changes nobody's view.
- **Admins** (`admins` group) always see everything.
- A category's **owners** see it even when it is not in their row.
- For a restricted user, an item whose category is outside their scope is hidden —
  including `other` and legacy/unknown categories.

The policy is pure code in `lambda/shared/category_access.py`; the gate reads
the row once per invocation. It is enforced on every metrics route (aggregate
routes drop forbidden per-category partitions; global totals for restricted
users come from the item path), `GET /feedback/{id}` and `/similar` (404 when
forbidden — no existence leak), the legacy chat, feedback-form submissions and
stats, the AI assistant's `search_feedback`, and the context sampled for
research, persona and document jobs (the job captures the starting user's scope).
MCP tokens resolve as their minter, never as admin.

**Restricted totals agree and say when they are partial.** For a caller whose
only restriction is categories (every source), `/metrics/categories` and the
`/metrics/summary` totals both sum the visible categories' pre-computed
`METRIC#daily_category#<name>` counters — the same rows, so the two totals match
exactly for any window, all time included. Summary sentiment and urgency (which
no per-category counter keeps) and every route under a source rule come from
the item walk, which pushes the caller's scope into each day's query
(`shared/category_scope_query.py`) so its cap counts only visible reviews. The
aggregate routes (summary, categories, sentiment, sources, personas, dimensions,
`/feedback/entities`) read slim rows with a cap of 100,000 rows per request and per
import day, the `/feedback/problems` capacity; the list routes (`/feedback`,
`/feedback/search`) keep 5,000. A walk that still stops early answers
`is_partial: true` with `partial_reason` and, when some day was read in full,
`scanned_through` (the oldest day read in full). The reason is `'time_budget'`
when the 20 s walk budget ran out and `'row_cap'` when a row cap cut a day; the
cut day itself is never claimed, so `scanned_through` is the day walked just
before it.

**The "Other" row.** `/metrics/categories` lists `other` — every review no
configured category claims: no category, the classifier's `other` fallback, or a
category since removed from the configuration — whenever it is non-zero and the
caller may see it, so the rows add up to the `/metrics/summary` total. Before
this, the route read only the configured categories' counters (prod all time:
16,295 listed vs 17,066 reviews; 378 `other` + 393 under removed categories).
`shared/other_category.py` holds the rule:

- Unrestricted, counter path: `other` = `METRIC#daily_total` minus the configured
  categories' counters over the window (the aggregator writes one
  `METRIC#daily_category#<stored category>` row per review beside the total, but
  the partitions of removed categories cannot be listed without a scan).
- Restricted: only the partitions the grant names. `other` (and a removed
  category) appear only when granted by name; a restricted user without `other`
  never gets the row.
- Item path (a source rule or filter): items are tallied the same way.
- `category=other` on `/feedback`, `/feedback/urgent`, `/feedback/search` and
  `/metrics/sentiment` selects exactly those reviews, so the row opens its list.
  A removed category's own name still works as a filter.
- The SPA labels the row "Other" (translated; a configured `other` category's own
  name wins), paints it in the neutral colour and lists it last — on the
  Categories breakdown (where it stays visible while the list is collapsed and
  is not counted as a category) and on the Dashboard's top-categories chart.

To fold removed categories back into the taxonomy, run
[reprocessing](#reprocessing-existing-feedback).

| Method | Path | Who | Description |
|--------|------|-----|-------------|
| GET | `/feedback/access` | any signed-in user | The caller's scope: `{all: bool, categories: [names], sources_all, sources, source_rule, sources_denied}` (source half: [source-policies.md](source-policies.md)) |
| GET | `/users/{username}/category-access` | admin | A user's row (`['*']` when none) |
| PUT | `/users/{username}/category-access` | admin | Body `{categories: ['*'] \| [names], sources?: ['*'] \| [ids] \| null}` (sources: [source-policies.md](source-policies.md)) |

Raw S3 data cannot be filtered by category, so the Data Explorer is admin-only.

### Category names stay hidden too

A restricted user never sees another category's reviews, counts **or name** (owner rule 2026-10-21). Beyond the
routes above, text that names a category is filtered for them by `shared/scope_names.py` (ids and display labels,
plus subcategory names, matched case-insensitively on word boundaries; details in
[memory.md → Category access](memory.md#category-access)):

| Where | What a restricted user gets |
|---|---|
| `GET /settings/categories`, the assistant's `list_categories`, MCP `list_categories` | Only their categories |
| Memory: `GET /memory`, `POST /memory/retrieve` (assistant recall, `search_memory`, MCP, plan and agent steps), conflict check, review queue | No memory tagged with, or naming, another category |
| `GET /settings/company-context` (Company page, the assistant's company brief and `get_company_context`, MCP) | Without the vision paragraphs and objectives that name another category |
| `GET /settings/resolved-problems` (Problem Analysis, the assistant's `get_resolved_problems`) | Only problems under their categories |
| Research, documents, personas, the morning brief (grounding) | Memories and company context filtered the same way, as the job's starter |
| The assistant's system prompt | A rule to name and count only the categories they can see, never how many the workspace has |

Admins and unrestricted users are unaffected.

### With the AI assistant (administrators)

On Administration → Privacy & access → Users (`/admin?tab=access&section=users`) the assistant can administer users for you, and you stay in control: it
proposes, an approval card shows exactly what will be saved, and nothing changes until you
approve. Every one of these tools is admin-only — a non-admin's assistant never has them, and
the `/users/*` routes they end in are `require_admin` anyway.

| Tool | Kind | What it does |
|---|---|---|
| `list_users` | read | Every user with email, name, role groups, status and enabled state (never a user's Cognito `sub` or flags). The assistant reads it first and identifies people by email; it never guesses a username. |
| `get_user_access` | read | One user's category and source grant, as `GET /users/{username}/category-access` returns it. |
| `create_user` | write | A new account with `POST /users`: email, role (`admins` or `users`, always stated — never defaulted), optional first and last name. Cognito emails the temporary password; nothing else is created. A duplicate email is refused before the card and again right before saving. |
| `create_users` | write | Several new accounts in ONE approval (up to 25, e.g. a list the admin pasted or attached as a CSV or spreadsheet): the card lists every person with their role. Every email is checked first — one already registered refuses the whole card — then they are created in order with `POST /users`; the first failure stops the rest and the result names who was created and who was not. |
| `update_user` | write | Name, role or enabled state of an existing user, shown as a before → after diff. Applied in that order (`PUT /users/{u}`, `/group`, `/enable` or `/disable`) and stopped at the first failure, reporting what was applied. The assistant cannot change the signed-in administrator's own role or enabled state; if the user changed since the card was shown, the save is refused. |
| `set_user_access` | write | The grant above, with `PUT /users/{u}/category-access`: `["*"]` or configured category names; sources omitted (unchanged), `null` (default rule), `["*"]` or configured profile ids. Refused for administrators (they always see everything) and for an unconfigured name; refused on approve if the grant changed since the card was shown. |

Not available through the assistant, on purpose: deleting a user, password resets and the user
flags (fallback owner, memory reviewer) — use Administration → Privacy & access → Users. These tools are not on the global
MCP server (`/mcp/global`).

## Correcting a review's category

`PUT /feedback/{id}/category` with body `{category, subcategory?}` — from the
Feedback detail "Change category" control, or from the AI assistant's
`set_feedback_category` tool after the user approves the card. `{id}` is the
feedback id.

- The caller must be able to see the item's current category **and** the new one;
  otherwise 404.
- The new category must exist in the configuration (400); a subcategory must
  belong to it when the category lists subcategories (400).
- The update is conditional and in place: `category`, `subcategory`,
  `gsi2pk=CATEGORY#{new}` (keys and `gsi2sk` unchanged), `category_source='manual'`
  and `category_override={previous_category, previous_subcategory, by_sub, by_username, at}`.
  A concurrent change returns 409. The aggregator's MODIFY path moves the counters.

Served by its own Lambda, `voc-feedback-edit-api`, whose role holds only
GetItem/Query/UpdateItem on the feedback table and read access to aggregates —
the only feedback write path reachable from the browser.

## Reprocessing existing feedback

When the categories change, an admin can re-categorise what is already stored
(Administration → Taxonomy → Categories → "Reprocess existing feedback").
Every mode also rates each review's usefulness band, which backfills reviews stored
before the band existed ([data quality](data-quality.md#backfill-optional-field-not-rated)).

| Method | Path | Description |
|--------|------|-------------|
| POST | `/settings/categories/reprocess` | Start: `{mode: 'processed'\|'raw', days: 0–9999 (0 = all), include_manual?: false}` → 202 `{job}`; 409 while one is queued/running |
| GET | `/settings/categories/reprocess` | Latest job (`{job: Job \| null}`) |
| POST | `/settings/categories/reprocess/{job_id}/cancel` | Cancel |

Modes:

- **`processed`** — re-classify `category`/`subcategory` from the stored
  (translated) text with the current configuration. One small model call per review.
- **`raw`** — reload the original from `s3_raw_uri` and re-run the full enrichment
  (language, translation, sentiment, one full model call). Costlier; use it when the
  enrichment itself should be redone.

Reviews corrected by a person (`category_source='manual'`) are skipped unless
`include_manual` is set. Items are always updated in place — never deleted, never
replaced — and stamped `category_source='reprocess'`, `category_reprocessed_at`.

The work runs in the `voc-category-reprocess` worker (VocProcessingStack, 15-minute
timeout): it scans `voc-feedback` page by page, checkpoints counters and its cursor
on the job row (`pk=JOB#category_reprocess`, `sk=rp_<12 hex>`) every page, honours
cancel between pages, and re-invokes itself before it runs out of time. Job fields:
`job_id, status (queued|running|completed|failed|cancelled), mode, days, include_manual,
scanned, updated, unchanged, skipped_manual, failed, started_by, created_at, updated_at,
finished_at?, error?`.

The worker's role: Scan/GetItem/UpdateItem on feedback, GetItem/PutItem/UpdateItem/Query
on aggregates, read on `raw/*`, Bedrock (model allowlist), Comprehend, Translate, KMS,
and invoke on itself only. The settings Lambda receives its name as
`CATEGORY_REPROCESS_FUNCTION` and may invoke exactly that function.

## Never delete

Category changes, corrections and reprocessing only ever rewrite classification
fields on existing items. Feedback, aggregates, projects and raw data have no
expiry and survive stack deletion — see
[Deployment → Data Retention](deployment.md#data-retention-nothing-is-ever-deleted).
