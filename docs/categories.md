# Categories, Products and Access

Categories decide how every review is classified. Each category maps to the
**product** (or product area) it belongs to and the **product owners**
responsible for it: owners automatically see their categories' feedback and are
the people who act on it. Setting categories up is an essential onboarding step
(Home → "Set up your categories", then Settings → Categories).

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
above. `POST /settings/categories/generate` drafts categories with the model.

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

| Method | Path | Who | Description |
|--------|------|-----|-------------|
| GET | `/feedback/access` | any signed-in user | The caller's scope: `{all: bool, categories: [names], sources_all, sources, source_rule, sources_denied}` (source half: [source-policies.md](source-policies.md)) |
| GET | `/users/{username}/category-access` | admin | A user's row (`['*']` when none) |
| PUT | `/users/{username}/category-access` | admin | Body `{categories: ['*'] \| [names], sources?: ['*'] \| [ids] \| null}` (sources: [source-policies.md](source-policies.md)) |

Raw S3 data cannot be filtered by category, so the Data Explorer is admin-only.

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
(Settings → Categories → "Reprocess existing feedback").

| Method | Path | Description |
|--------|------|-------------|
| POST | `/settings/categories/reprocess` | Start: `{mode: 'processed'\|'raw', days: 0–9999 (0 = all), include_manual?: false}` → 202 `{job}`; 409 while one is queued/running |
| GET | `/settings/categories/reprocess` | Latest job (`{job: Job \| null}`) |
| GET | `/settings/categories/reprocess/{job_id}` | One job |
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
