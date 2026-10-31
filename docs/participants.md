# Participants

Lists of people the team can email to ask for feedback: employees, paid participants, beta customers, sales
people, customers. People can be brought into a project (directly or through a list), and an **ask** emails
them a feedback form or a link. Answers to a form link are attributed to the person and the ask.

Pages: **LISTEN → Participants** (`/participants`), and a project's participants. The unsubscribe page is
`/unsubscribe` (public).

## Setup

| What | Where |
|---|---|
| Sending email | Deploy with `-c emailFrom=noreply@your-domain.example`. The SES identity of that domain must be **verified**, and the account **out of the SES sandbox** in the deployment region; otherwise SES refuses every send. Without `emailFrom`, everything works except asks (`409 email_not_configured`) and the feedback boards' own sign-in. |
| External people, daily cap, sender name | Administration → Privacy & access → Users → participant email card, or `PUT /participants/settings` (admin) |
| Company domains | Administration → Privacy & access → **Boards** (moved there in 5.36, same setting), or `PUT /participants/settings` (admin) |

Settings (`SETTINGS` / `engagement` in the participants table):

| Field | Default | Rule |
|---|---|---|
| `company_domains` | `[]` | Up to 20 lower-case domains. Also the audience of every `company` [feedback board](feature-requests.md#who-sees-a-board) and part of the boards' sign-up rule (an exact domain match; a subdomain is a different domain). Edited with the boards in the UI. |
| `allow_external_people` | `true` | When false, a NEW person must have a company-domain address. Existing people are never removed. |
| `daily_send_cap` | `500` | 1–5000 emails per UTC day, for the whole deployment. A non-administrator's own asks also stop at **50 emails a UTC day** (fixed; an administrator, who sets this cap, is bounded by it alone; `PER_SENDER_DAILY_CAP` in `shared/participants_asks.py`): checked before queueing (429 `sender_daily_cap`) and on every send (that recipient fails with `sender_daily_cap`), counted in `SENDCOUNT#{day}` / `SENDER#{sub}` |
| `sender_name` | the brand name | Up to 80 characters, the From display name |

## API

All routes need the app's Cognito sign-in (`/participants/*` is behind the main authorizer), except
`POST /unsubscribe`. Errors use the API's usual `{success: false, error}` body. Access is "every signed-in
user" unless the table says otherwise. Project routes use the project's access (view for reads, edit for
writes; 404 without view).

| Method | Path | Access | Body → answer |
|---|---|---|---|
| GET | `/participants/settings` | any | `{settings, email_enabled, board_enabled, board_url}` |
| PUT | `/participants/settings` | **admin** | any settings fields → `{settings}` |
| GET | `/participants/lists` | any | `{lists}` (by name) |
| POST | `/participants/lists` | any | `{name, description?, kind}` → 201 `{list}`. `kind`: `employees`, `paid`, `beta`, `sales`, `customers`, `requesters`, `custom` |
| GET | `/participants/lists/{list_id}` | any | `{list, members}` (up to 2000) |
| PUT | `/participants/lists/{list_id}` | any | `{name?, description?, kind?}` → `{list}` |
| DELETE | `/participants/lists/{list_id}` | **admin** | the list, its memberships and project links. The people stay. |
| POST | `/participants/lists/{list_id}/members` | any | `{person_ids?, people?: [{email, name?, company?, title?, tags?}], origin?: 'manual' \| 'assistant'}` (≤ 200; `origin` of the people it creates, default `manual`, the assistant's card sends `assistant`, anything else 400 — `feature_request` is set by the board only) → `{added, already, created, rejected: [{email, reason}]}` |
| DELETE | `/participants/lists/{list_id}/members/{person_id}` | any | `{success: true}` |
| GET | `/participants/people?q=&list_id=` | any | `{people}` (≤ 500; `q` matches email, name, company) |
| POST | `/participants/people` | any | `{email, name?, company?, title?, notes?, tags?, list_ids?}` → 201 `{person}`; 409 for a known email; 400 `external_not_allowed` |
| GET | `/participants/people/{person_id}` | any | `{person, lists, asks}` |
| PUT | `/participants/people/{person_id}` | any | `{name?, company?, title?, notes?, tags?}` → `{person}`. The email cannot change. |
| DELETE | `/participants/people/{person_id}` | **admin** | erasure (below) |
| GET | `/participants/projects/{project_id}` | view | `{lists, people, reach}`. `reach` = distinct active people across the linked lists and people. |
| POST | `/participants/projects/{project_id}` | edit | `{list_ids?, person_ids?, people?}` → the GET shape + `created`, `rejected` |
| DELETE | `/participants/projects/{project_id}/lists/{list_id}`, `/people/{person_id}` | edit | `{success: true}` |
| POST | `/participants/asks` | any (edit when `project_id`) | `{project_id?, list_ids?, person_ids?, subject (≤ 160), message (≤ 4000), link: {kind: 'form', form_id} \| {kind: 'url', url}}` → 202 `{ask}` |
| GET | `/participants/asks?project_id=` | any (a project's asks need view) | `{asks}` (newest first, ≤ 200) |
| GET | `/participants/asks/{ask_id}` | any (view when it has a project) | `{ask, recipients: [{person_id, email, name, status, sent_at, responded_at, error}]}` |
| POST | `/unsubscribe` | **public** | `{token}` or `?t=` → always 200 `{success: true}` |

Every Person carries `list_ids`. `rejected` / `skipped` reasons: `invalid_email`, `external_not_allowed`. An address that is already known
resolves to that person, unsubscribed or not; they stay a member and are skipped when an ask is sent.

Ask refusals: `409 email_not_configured`, `400 no_recipients` (nobody active), `400 too_many_recipients`
(more than 500 after de-duplication), `400 form_not_found`, `429 daily_cap` (today's sends plus the active
recipients would pass the cap; logged at info level, it is not a fault).

## With the AI assistant

Bulk entry goes through the assistant, not an importer. On Participants, the assistant can read your lists
(`list_participant_lists`), create one (`create_participant_list` {name, kind, description?}) and add people
(`add_participants` {list_id, people: [{email, name?, company?, title?, tags?}]}, up to 200 per card). Paste or
attach a list and ask, for example "make a beta list and add these". Each write is an approval card. The add card
names the list and shows every row, scrollable; a repeated email collapses to its first row with a note. Invalid
addresses, more than 200 rows and an unknown list are refused before any card. After approval the card reports
added, already on the list, created and rejected (with the reason). Known addresses are reused and nobody is
emailed. Every signed-in user can use these tools; they are not plan steps and not on `/mcp/global`. Removing
people, deleting lists and sending asks stay on the page. `voc-chat-stream` invokes `voc-engagement-api` as the
caller for them (`ENGAGEMENT_FUNCTION`).

## Sending

`POST /participants/asks` writes the ask and one `queued` recipient row per person, then the engagement
Lambda invokes itself asynchronously to send. Each invocation sends at most 200 emails, at most 10 per second,
and continues in a new invocation from the last recipient it handled. Per recipient:

| Recipient | Status (error) |
|---|---|
| Unsubscribed | `skipped_unsubscribed` |
| Erased since the ask was made | `failed` (`erased`) |
| Today's cap reached while sending | `failed` (`daily_cap`) |
| SES refused the email | `failed` with the SES error code only (for example `MessageRejected`), never the message |
| Sent | `sent`, then `responded` when they answer the form |

The ask ends `sent`, or `failed` when nothing was sent and something failed. A recipient moves out of
`queued` only once, so a repeated job never emails anyone twice.

## The email

One email per recipient, through Amazon SES v2 (`SendEmail`):

- From `"{sender_name}" <emailFrom>`, Reply-To the asker's verified email.
- Subject = the ask's subject. A text and an HTML body: the message (HTML-escaped), one button to the link,
  and the footer "You get this because {sender_name} added you to a participant list. Unsubscribe: …".
- `List-Unsubscribe: <{api}/unsubscribe?t=…>` and `List-Unsubscribe-Post: List-Unsubscribe=One-Click`
  (RFC 8058), so mail clients show their own unsubscribe button. The footer links the app's `/unsubscribe` page.
- A form link opens the form's public widget page, `{api}/feedback-forms/{form_id}/iframe?r={token}`. The page
  passes the token to the widget and removes it from the address. The answer is stored with
  `metadata.participant = {person_id, ask_id, project_id?}`, and the recipient becomes `responded` (counted
  once). A URL link is sent as given and is not attributed.

**Bounces and complaints**: the SES account-level suppression list stops further sends to an address that
bounced or complained. Those sends then fail with an SES error code on the recipient row. Turn the list on for
bounces and complaints in the SES console (Configuration → Suppression list) if it is not already on.

## Data model

Table `voc-participants-<suffix>` (pk/sk, index `gsi1`, TTL `ttl`, the Core KMS key, point-in-time recovery):

| pk | sk | Item |
|---|---|---|
| `PERSON#{id}` | `META` | the person: email (as given), name, company, title, notes, tags, status `active`/`unsubscribed`, origin `manual`/`assistant`/`feature_request`, created/updated, `list_ids` (kept with every membership change, so lists show without a query per person). Bookkeeping: `project_ids`, `token_hashes`, `unsub_token_hash` |
| `EMAIL#{sha256(lower-case email)}` | `PERSON` | uniqueness guard, written in the same transaction as the person |
| `PERSON#{id}` | `LIST#{list}` / `ASK#{ask}` | the person's memberships and asks |
| `LIST#{id}` | `META` / `MEMBER#{person}` | the list (with `member_count`, `project_ids`) and its members |
| `PROJECT#{project}` | `LIST#{list}` / `PERSON#{person}` | the project's linked lists and people |
| `ASK#{id}` | `META` / `RCPT#{person}` | the ask (with `counts`) and each recipient's status |
| `TOKEN#{sha256(token)}` | `RESPONSE` / `UNSUB` | what a token in an email may do |
| `SETTINGS` | `engagement` | the settings above |
| `SENDCOUNT#{day}` | `COUNT` | emails sent that UTC day (expires after 3 days) |

## Privacy

- **Personal data**: people's emails, names, companies, titles, notes and tags. Readable by every signed-in app
  user (participants are shared team state), never by a feedback board. Logs carry ids and counts,
  never an address or a token.
- **Tokens**: each email carries two random tokens (32 characters): one unsubscribes the person, one attributes a
  form answer to the recipient. They grant nothing else and are not sign-in credentials. Only their SHA-256 is
  stored; the plaintext exists only in the email.
- **Unsubscribe**: always answers 200, whatever the token, so it never says whether an address is known. An
  unsubscribed person stays visible (marked) and is skipped by every later ask. They are never re-subscribed by
  being added again.
- **Erasure** (`DELETE /participants/people/{id}`, admin) deletes the person, the email guard, every
  membership (both sides, `member_count` adjusted), the project links, every token and the person's ask mirrors.
  Each recipient row keeps only `person_id` and its status, so an ask's counts stay correct while nothing on it
  identifies the person. Answers already submitted are feedback data: erase them with Administration → Privacy
  ([docs/source-policies.md](source-policies.md)).
