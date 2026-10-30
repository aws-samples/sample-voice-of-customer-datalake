# Feedback boards

Boards where people file requests, issues or feedback and add their support (a +1). Admins set up several boards,
each for one team or audience (sales feature requests, customer service issues, a beta programme), and share each
one by its link. Everyone who may use a board sees every request and every support on it; a post shows at once
(there is no moderation). When the team decides to act on a request, an admin **promotes** it into a project:
everyone who supported it (and every contact they named) becomes a [participant](participants.md) of that project,
ready to be emailed for feedback.

Pages: **LISTEN → Feedback boards** (`/feature-requests`, old links keep working) lists the boards as cards for app
users; `/feature-requests/{slug}` is one board. People who only use boards sign in at `/board` (the boards they
may use; one board opens directly) and `/board/{slug}`. An open request is `?request=<id>`; the list's search,
status filter and sort are `?q=`, `?status=` and `?sort=`. Admins create and configure boards in
**Administration → Privacy & access → Boards** (`/admin?tab=access&section=boards`), which also holds the company
domains.

## Templates and fields

A board starts from a template; its fields and statuses stay editable afterwards. Title and description are always
on. Every other field comes from one fixed catalogue (no free-form schemas), switched on per board and optionally
required. The catalogue, the templates and every check live in ONE module, `lambda/shared/feature_board_fields.py`;
the SPA mirrors it in `frontend/src/api/boardFields.ts` with a lockstep test that reads the Python constants.

| Template | Request fields (✓ = required) | +1 fields | Statuses (first = initial) | Totals per request |
|---|---|---|---|---|
| **Sales feature requests** (`sales`) | customer ✓, deal, impact ✓, amount_usd, contact_email | customer ✓, deal, impact ✓, amount_usd, contact_email, note | new, under_review, planned, shipped, declined | supporters, customers, committed_usd, at_risk_usd |
| **Customer service issues** (`service`) | kind ✓, severity ✓, reference, steps, affected_count | note ("also affected") | new, confirmed, fixed, wont_fix | supporters, affected |
| **Beta feedback** (`beta`) | area ✓, outcome ✓, rating, link | note | new, seen, fixed | supporters, avg_rating |
| **Blank** (`blank`) | none | none | new, done | supporters |

The title is required on every board. The description is always on and **required on `sales` and `service` boards
only** (`DESCRIPTION_REQUIRED_TEMPLATES`; a beta note or a blank-board idea may be just a title): an empty one is
refused with 400 `description is required` on create and on edit. Its hint follows the template: what the customer
needs (sales), what happened and what the customer saw (service), what you tried and what happened (beta), anything
that helps others understand it (blank).

| Field | Value |
|---|---|
| `customer`, `deal` | text ≤ 160 |
| `impact` | `committed`, `at_risk` or `none` |
| `amount_usd` | whole US dollars 0–10,000,000,000; required with a committed / at-risk impact, stored as 0 with `none` |
| `contact_email` | an email address (stored lower-case) |
| `kind` | `bug`, `complaint`, `missing_feature`, `question` |
| `severity` | `low`, `medium`, `high`, `critical` |
| `reference` (booking / order), `area` | text ≤ 80 |
| `steps` | text ≤ 2000 |
| `affected_count` | whole number ≥ 1 |
| `outcome` | `works`, `broken`, `confusing` |
| `rating` | 1–5 |
| `link` | an `https://` URL ≤ 500 |
| `note` (+1 only) | text ≤ 1000 |

A board's `fields` is `{request: {<key>: {enabled, required}}, support: {<key>: {enabled, required}}}` (every
catalogue key present; a required field must be on). Statuses are 1–8 `{key, label}`, keys `^[a-z_]{1,30}$`; a new
request starts in the first one.

**Totals** are recomputed from the supports after every change: `supporters` = distinct supporter emails; sales
adds distinct customers (case-insensitive) and the committed / at-risk dollar sums; service adds `affected` (the
reporter's `affected_count`, at least 1, plus every other supporter); beta adds `avg_rating` (the request's rating).

All text is stored and shown as plain text. Only the `link` field is rendered as a link (https only,
`rel="noopener noreferrer nofollow"`).

## Who sees a board

One function decides, `board_access` in `lambda/shared/feature_boards_access.py`:

- **App users** (the app's own pool) use every non-archived board. **App admins** (`admins`) also see archived
  boards and are every board's admin; a board-pool token is never admin, whatever groups it claims.
- **Board-pool users** use a non-archived board whose audience admits their verified email:

| Audience | Admits |
|---|---|
| `company` | an email whose domain is one of the company domains (exact match: `eu.example.com` is not `example.com`) |
| `list` | a domain in the board's `domains` (≤ 50) OR an exact address in its `emails` (≤ 500) |
| `anyone` | any email address that verified itself with the emailed code or link |

A board someone may not use is invisible: every board and request route answers **404**, never 403, so its
existence does not leak. Non-admins see a board's audience mode only, never its lists.

Only admins create, configure, pause, archive and delete boards.

**Pause** is the temporary stop: a paused board stays visible to its audience exactly as before (they still
sign in, it still counts in the sign-up audience, its requests and +1s stay readable), but nobody can post a
request, add or change a +1, or edit a request until an admin resumes it. Every such write answers
**409 `board_paused`**, admins' own included. Admins can still triage a paused board: change a status, delete a
request or a +1, promote a request. The board, its cards and its request dialogs say "Paused: new requests and
votes are closed for now". Pause asks for a confirm; Resume does not. The board records `paused`, `paused_at`
and `paused_by` (the admin; shown to admins only).

**Archive** is the permanent step before delete: it hides a board from everyone but admins and from the
sign-up audience, keeps its requests and stops new posts (`409 board_archived`). The archive confirm says so.
An admin can restore (unarchive) it. In the app, **Delete is offered only on an archived board** (the API
still deletes an empty board, and `?with_requests=true` archives first, below). Deleting an empty board is one
confirm; a board with requests is deleted together with its requests and every +1 on them, after the admin
types the board's name (the card's Delete on Feedback boards, or Administration → Privacy & access → Boards →
the editor's Delete). The dialog shows how many requests are gone so far; if it stops, pressing Delete
again continues (the API: `?with_requests=true`, below). Projects already created from its requests are kept. Admins can delete any request or
support.

**A request never moves to another board.** No route or tool changes a request's `board_id`: an edit
(`PUT /feature-requests/{id}`) that names `board` or `board_id` is refused with 400 `A request cannot be moved
to another board`. To move one, file it again on the other board.

## Rate limits (`anyone` boards)

A board open to any email has no moderation, so it is capped instead (`lambda/shared/feature_boards_limits.py`):
per poster per board per UTC day at most **20 new requests** and **100 +1s**; per board at most **500 new requests**
a day. Over a limit the route answers **429 `rate_limited`**. Admins are not limited, nor are boards of the other
audiences. The counters are rows `RATE#{board_id}#{sha256(email)}#{day}` / `COUNT` (the board-wide one uses `*`)
with a `ttl` two days out (the table's TTL attribute, enabled in 5.36.00 as an in-place update); a new request charges the poster and the board in one transaction.

## Sign-in: a separate user pool

Board-only users are NOT app users. They live in their own Cognito user pool, `voc-board-user-pool-<suffix>`,
created on every deployment since 5.45.00 (it also signs in [document review](document-review.md) reviewers).
With `-c emailFrom=…` it emails through SES with Email OTP; without it, with Cognito's own sender
(`no-reply@verificationemail.com`, 50 emails a day per account) and a password-reset code as the returning
person's sign-in code ([deployment.md](deployment.md#participant-email-and-the-feature-request-board--c-emailfrom)):

- **Sign-up rule:** an email may create a board account when ANY non-archived board would admit it, or an active
  document review link named in the sign-up does. The PreSignUp
  trigger (`lambda/auth/board_triggers.py`) reads two items of the participants table: the engagement settings'
  `company_domains`, and the boards' derived row `SETTINGS` / `board_audience` =
  `{company, anyone, domains, emails}` (the union over the non-archived boards; `company`: some board admits the
  company domains). Every board save, archive and delete rewrites that row, so the trigger never reads the boards.
  A review link is one more item read (`DOCSHARE#{id}` / `META` in the projects table). Without the row (no board
  saved yet) the company domains alone decide, as before boards. Everyone else is refused with `domain_not_allowed`.
- **No auto-confirm (5.45.00):** a new account is confirmed only by the code Cognito emails to it. Before, the
  trigger confirmed every admitted sign-up at once, so a sign-up that chose its own password could sign in as an
  address it did not own (the pool must allow the password factor). Accounts created that way before 5.45.00 stay.
- **An `anyone` board lets any email address sign up** to the board pool. Such an account can only ever reach the
  board routes (below), and only the boards that admit it.
- A refused sign-up appears as ONE `[ERROR] SignUpRefusedError: domain_not_allowed` line (with the runtime's
  traceback) in the `voc-board-pre-sign-up` function's logs, and as one Lambda `Errors` datapoint. That is by
  design: raising is the only way a PreSignUp trigger can refuse, and the trigger fails closed. The line names
  no address, and no VoC ops alarm watches this function, so it is not a fault to investigate.
- Sign-in is by email: Cognito sends a code (a sign-up confirmation for a new person; an Email OTP or, without
  SES, a password-reset code for a returning one), and the email also carries a link
  (`/board/login?email=…&code=…`) that completes the sign-in in the browser that asked for it. No password is
  ever shown or kept. Once read, the page drops `email` and `code` from the address.
- A board share link (`/board/<slug>`) opened signed out returns to that board after sign-in, also by the emailed
  link (which carries only `email` + `code`): the slug is kept with the pending sign-in in this browser
  (localStorage `voc-board-otp`, same browser only, like the code) and followed only when it is a well-formed slug;
  the board page itself says when that board does not exist or is not shared with the person.
- Why a separate pool: a board token is accepted ONLY by the board routes. Every other API route's authorizer
  knows the app pool alone, so a board user can never read feedback, projects, participants or anything else,
  however their token is used.

## API

Behind the board authorizer (app pool + board pool), all on the engagement Lambda (`voc-engagement-api`) under
`/feature-requests` and its `{proxy+}`. The caller is the token's verified, lower-cased `email` claim (no email or
an unverified one: 403); `name` comes from the token when there is one, else from the body. Errors are
`{success: false, error}`; the stable codes are `slug_taken`, `board_limit`, `status_in_use`, `board_not_empty`,
`already_supported`, `board_archived`, `board_paused` (409) and `rate_limited` (429).

| Method | Path | Access | Body → answer |
|---|---|---|---|
| GET | `/feature-requests/boards` | any | `{boards: [Board], viewer}`, by name. The first call on a table that was never seeded creates the Sales board (once: see below); with zero boards the list is `[]` |
| POST | `/feature-requests/boards` | **admin** | `{name (≤ 80), template, slug?, description? (≤ 1000), audience?}` → 201 `{board}` (slug from the name when absent; a taken one gets a short suffix; an explicit taken slug is 409 `slug_taken`; at most 100 boards) |
| GET | `/feature-requests/boards/{slug_or_id}` | a user of the board | `{board}` |
| PUT | `/feature-requests/boards/{slug_or_id}` | **admin** | any of `name`, `slug`, `description`, `fields`, `statuses`, `audience`, `archived`, `paused` (booleans) → `{board}`; pausing stamps `paused_at` / `paused_by`, resuming clears them; dropping a status some request is in: 409 `status_in_use` |
| DELETE | `/feature-requests/boards/{slug_or_id}[?with_requests=true]` | **admin** | `{success, done, deleted, remaining}`. Without `with_requests` (or `false` / `0`): an empty board only (409 `board_not_empty`) → `{done: true, deleted: 0, remaining: 0}`. With `true` / `1` (any case): the board and its requests, resumably (below); any other value is a 400 |
| GET | `/feature-requests?board={slug_or_id}` | a user of the board | `{requests, board, viewer: {email, name, is_admin, pool}}` (≤ 1000 of THIS board's, newest first); no `board` = the seeded board (404 once it was deleted) |
| POST | `/feature-requests` | a user of the board | `{board?, title (≤ 160), description (≤ 4000; required on sales and service boards), fields, name?}` → 201 `{request, supports}` (the reporter's +1 is created with it and carries the request values its board's +1s ask for) |
| GET | `/feature-requests/{id}` | a user of its board | `{request, supports}` |
| PUT | `/feature-requests/{id}` | reporter or admin | `{title?, description?, fields?}` (`fields` replaces all request values) → `{request}`; `board` / `board_id` in the body: 400 (a request never changes board) |
| PUT | `/feature-requests/{id}/status` | **admin** | `{status}`: one of the board's status keys → `{request}` |
| DELETE | `/feature-requests/{id}` | **admin** | the request and every support |
| POST | `/feature-requests/{id}/supports` | a user of its board who does not support it yet | `{fields, name?}` → 201 `{support, request}`; one +1 per person per request (the reporter's own included, emails compared case-insensitively): a second answers 409 `already_supported` (also when two arrive at once: the +1's id is derived from the request and the email, and the write is conditional), and the board offers "Edit my +1" instead of "+1" |
| PUT, DELETE | `/feature-requests/{id}/supports/{support_id}` | its owner or admin | PUT replaces the support's fields → `{request}` |
| POST | `/feature-requests/{id}/promote` | **admin** with edit on the project | `{project_id}` → `{request, list, added, skipped: [{email, reason}]}` |

**Board** = `{board_id, slug, name, description, template, fields, statuses, audience, archived, paused,
request_count, share_url ({FRONTEND_URL}/board/{slug}), created_at, updated_at}` (+ `paused_at` while paused;
+ `created_by`, `paused_by` and the full audience for admins; others get `audience: {mode}`). **Request** carries `board_id`, `status`, `fields` (values by key) and
`totals` (the template's keys). **Support** carries its values both as `fields` and at the top level.

`fields` is checked against the board's enabled fields: an unknown or switched-off key, a missing required one or a
bad value is a 400. A client from before boards that sends the sales values at the top level of the body (no
`fields`, no `board`) still works on the seeded board.

**Deleting a board with its requests** (`DELETE …?with_requests=true`, `lambda/shared/feature_boards_delete.py`):
before the first request goes, the board is archived (unless it already is), so only admins can post while it
empties. Its requests are then deleted oldest first, each with every support (and one off the board's
`request_count`), for at most **20 seconds** per call (`DELETE_BUDGET_SECONDS`, under API Gateway's 29 s cut).
When requests remain, the board is kept and the answer is `{success: true, done: false, deleted: <this call>,
remaining: <still on the board>}`: call again until `done: true`. Each call is idempotent and resumes where the last
one stopped. When none remain the board and its slug are deleted: `{success: true, done: true, deleted, remaining:
0}`. The seeded board also takes the requests filed before boards (no `board_id`). A board's requests are found
by paging the whole request index with a filter on the board, so a board whose requests are older than 1000 other
boards' still reads as non-empty. Each call logs one line, `Board deleted` or `Board emptying`, with the board id,
the counts and the admin's id (never a request's text or an email).

**The Sales board is seeded once.** Seeding writes the marker `BOARDS#SEEDED` / `META` with the board, and every
board delete writes it too (covering deployments seeded before the marker). A table with the marker is never
seeded again: deleting the last board leaves zero boards, the list is `[]`, the routes that default to the
seeded board answer 404, and the sign-up row admits nobody until an admin creates a board.

**Promote** creates (once) the list `Requests: {title}` (kind `requesters`), adds a person for every distinct
supporter and contact email (origin `feature_request`; known addresses are reused), links the list to the
project, records `project_id` / `list_id` on the request and, on a board with a `planned` status, moves it there
when it was in the board's first status or `under_review`. Contacts outside the company domains are skipped
(reason `external_not_allowed`) when external people are turned off. Promoting again reuses the list.

## Data model

Table `voc-feature-requests-<suffix>` (pk/sk, index `gsi1`, the Core KMS key, point-in-time recovery). Layout:
`lambda/shared/feature_boards_store.py`, `lambda/shared/feature_requests_store.py`.

| pk | sk | Item |
|---|---|---|
| `BOARD#{id}` | `META` | `brd_` + 8 hex (the seeded board: `brd_sales`), slug, name, description, template, fields, statuses, audience, archived, paused (+ paused_at, paused_by while paused; absent on boards from before 5.48 = not paused), request_count, created/updated; gsi1pk `BOARDS`, gsi1sk the lower-cased name |
| `SLUG#{slug}` | `BOARD` | board_id: the slug's uniqueness guard, written in one transaction with META |
| `BOARDS#SEEDED` | `META` | nothing but the key: the Sales board was seeded (no gsi1pk, never listed); never seed again |
| `FR#{id}` | `META` | title, description, status, `board_id` (absent = the seeded board), `fields`, reporter email and name, totals, project_id?, list_id?, `version` (conditional writes); gsi1pk `FRS` |
| `FR#{id}` | `SUP#{id}` | email, name, the +1's field values, is_reporter, created/updated. Since 5.54.01 the id is `sup_` + the first 16 hex of sha256(request id, lowercased email); older supports keep random ids |
| `RATE#{board_id}#{hash}#{day}` | `COUNT` | `requests`, `supports` counters of an `anyone` board, `ttl` |

The participants table holds the derived sign-up row `SETTINGS` / `board_audience` (above).

**Migration (forward-only, no script):** requests filed before boards have no `board_id` and read as the seeded
Sales board's; their customer, deal and impact stay on the reporter's support and show as the request's `fields`
in the request's detail (`GET /feature-requests/{id}`; the listing shows `fields: {}` for them).
The seeded board's `request_count` starts at the number of requests found when it is created.

## Privacy

A board holds the emails and names of the people who use it, and whatever they type into its fields (customer and
deal names, amounts, booking references, contact emails). All of it is visible to every user of that board, by
design. Nothing on a board reaches the rest of the app until an admin promotes a request; promoted people are then
ordinary participants, with the unsubscribe and erasure of [participants](participants.md#privacy). Deleting a
request deletes its supports. Rate-limit rows keep only a hash of the poster's email and expire.
