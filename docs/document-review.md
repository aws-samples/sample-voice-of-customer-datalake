# Review a PR/FAQ or PRD: margin comments, persona review, share link

A PR/FAQ or PRD in a project shows its comment threads in the margin, like comments in a word
processor. The team comments, asks the project's personas to review, and shares a review link with
people outside the app. Comments, persona review and the link never edit the document, so every
[way of working with AI](ways-of-working.md) has all of them; **Revise from comments** (below) proposes
or writes changes only as far as the person's way of working allows. The document itself is shown and
edited on the [document canvas](document-canvas.md); the threads sit in its side rail.

## Comments

- **Select text and press Comment.** The thread is anchored to that quote (a
  [W3C text-quote selector](https://www.w3.org/TR/annotation-model/#text-quote-selector): the exact
  text plus 32 characters before and after, and the heading above it). **Comment on the whole
  document** starts a thread with no quote.
- From 1280 px wide each thread is a bubble beside its passage and the passage is highlighted.
  Narrower, the threads form one list under the document, in reading order.
- Threads belong to the document **series** (its type and base title), not one version. A thread
  made on v2 shows on v3 when its quote is still in the text (the quote is located again, with
  the surrounding text breaking ties). A thread whose quote is gone is listed under **Not found in
  this version**. It is kept, and it says which version it was made on.
- **Reply** (at most 50 replies a thread), **Resolve** / **Reopen**, and **Delete** (the author, or
  anyone who can edit the project). **Show resolved** brings resolved threads back. The filter shows
  threads from team members, personas (all, or one), or outside reviewers.
- Text that reads like an instruction to an AI model is kept and marked **Check wording**
  (the same screening as prototype pins).
- Who may comment: anyone who can view the project, viewers included. Comments are at most 2,000
  characters.

## Ask personas to review

**Ask personas to review** (anyone who can edit the project) sends this version to up to six of
the project's personas, three at a time. It is one model call per persona on the `documents`
surface (the model is set in Administration → AI models). Each persona answers with:

- a **verdict** (positive, mixed or negative, with a short reaction), filed as that persona's
  comment on the whole document, and
- at most **8 comments**, each quoting the document.

The server keeps a comment only when its quote is found **verbatim** in the document's text
(whitespace and markdown symbols aside), and files it anchored to that quote. Others are dropped
and counted. Running it again on the same version files nothing twice (same persona, version and
quote). It is an assist job: `POST …/persona-review` answers 202 and the page polls the job.

## Revise from comments

Once threads are answered (resolved, or open with a reply), **Revise from comments** (anyone who can
edit the project) reads them and the document's evidence and suggests changes to the parts the threads
are about. By default it takes every thread of the series that is resolved or replied to, not yet
**addressed**, and either on the whole document or whose quote is found in this version; the canvas, an
API caller or MCP may name up to 50 threads instead. It is one model call on the `documents` surface
(as persona review), an assist job: `POST …/revise-from-comments` answers 202 and the page polls the job.

What it reads: this version's Markdown (at most 60,000 characters; a longer document is refused), each
thread's quote and heading, status, comment and its last 10 replies with their author kind (never a
name or address), and at most 20 of the reviews the document was written from (`input_feedback_ids`,
read under the starter's category access: a review they cannot see never reaches the model). All of it
goes to the model as data, never as instructions. A comment, reply, quote heading or review that reads
like an instruction to the AI (the **Check wording** screen) is withheld from the prompt and says so.

What it answers depends on the person's [way of working](ways-of-working.md#revise-from-comments):

| Outcome | When | What happens |
|---|---|---|
| `recommendations` | The AI may not write this PR/FAQ or PRD for the caller (Human-driven without the unlock, or an agent / MCP token whose person is not AI-driven) | One recommendation per thread; nothing is written |
| `proposal` | The person may have the AI write it and works Human-driven with the unlock or AI-assisted | The changes are shown as a diff on the canvas: accept or reject each, then **Save** (one new version, sent with the pass's job id, `revise_job_id`; when the server's checks pass, History records it like an applied pass: `edit_kind` `revise`, the person in `edited_by`, see [Saving a proposal](#saving-a-proposal)); the canvas then marks the accepted changes' threads addressed by that version |
| `applied` | The person (and, for an agent or MCP token, the project's owner) works AI-driven | The server writes the revised text as the **next version** of the series (never an overwrite; `edit_kind` `revise`, who asked in `edited_by`, what wrote it in `llm_metadata`) and marks the changes' threads addressed by it, best effort: a thread it cannot mark (deleted meanwhile, its history full, a failed write) is logged and left out of `addressed_thread_ids`, and the pass still answers `applied` (mark it from the canvas). **Undo** restores the previous version from History (a new version again) and clears those marks on the restored version (`addressed: false`); when someone saved a version after the revision, it says so first and offers **Undo anyway** or **Keep it**, since the restore would revert that save too. A pass that keeps no change writes nothing and answers `recommendations` |

Every change is **grounded**: its `before` must occur exactly once in the Markdown of the version the
pass read, must not overlap another kept change and must name one of the threads; at most 20 are kept.
The others are dropped and counted (`dropped`). An applied pass on a version someone saved over since
fails with the stale-version message before the model is asked (run it again on the newest version). The way of working is read
once when the pass starts; when it cannot be read the start fails ("Could not check your way of working
with AI. Please retry.", as on every AI-writing route), never a quiet `recommendations`. A job runs once
(assist jobs are claimed once and never retried); its version is written under the pass's own
allocation id (`revise_id`), so the write itself is idempotent.

The job's `result`:

```
{"outcome": "recommendations" | "proposal" | "applied",
 "base_document_id": str, "base_version": int,
 "recommendations": [{"thread_id", "text"}],
 "changes": [{"change_id", "thread_ids", "before", "after", "reason"}],
 "applied_version": {"document_id", "version"} | null,
 "addressed_thread_ids": [str], "dropped": int,
 "model_id": str, "prompt_version": str}
```

`model_id` is the model that answered the pass (the one the call reports, so a capacity fallback
names the fallback; the `documents` surface's model only when a stand-in reports none), and
`prompt_version` is `REVISE_PROMPT_VERSION` (`lambda/shared/document_revision.py`), the version of
the prompts the pass sends. It is bumped with any change to those prompts, and a test pins each
version to a digest of the rendered prompts, so a prompt edit without a bump fails. A version an
applied pass writes carries both as `llm_metadata: {model, prompt_version}` (the shape a generated
persona records), so History can say which model and which prompt wrote it (tenet D4).

A thread answered by a version shows **Addressed in vN** (`addressed: {version, at, by_kind: user | ai}`,
null when none). `POST …/comments/addressed` on that version's path marks it (`addressed: true`, the
default) or clears it (`addressed: false`, the canvas's Undo of an applied pass, on the restored
version). Each call is one append to the thread's history, never written over or trimmed (D1); the
current mark is the newest entry when it is a mark. A thread's history holds at most 100 marks and
clears: one more answers **409** ("This comment has reached its limit of addressed marks; start a new
comment"), as a reply past 50 does. A full thread does not stop the others of the same call: they are
marked, then the call answers 409 saying some comments could not be marked and the others were. That
409 carries the machine-readable `code` `addressed_some_full` beside its `error` (a client reads it,
never the sentence). A reply or a status change clears nothing.

### Saving a proposal

The canvas saves the accepted changes through the normal document save (`PUT …/documents/{doc}`, one
new version) with `revise_job_id`: the job id of the pass whose proposal they came from (the client's
`reviseFromComments` result carries it as `job_id`). The server never takes a "this is a revise" on the
client's word: it records the version as a revise (`edit_kind` `revise`, the person in `edited_by`, and
`revise_job_id`) only when all of these hold, and otherwise answers **400** and writes nothing:

| Check | 400 message |
|---|---|
| The job is a Revise from comments pass of this project (it is read from the project's own job partition; an expired job, a day after it started, is gone) | That revision was not found in this project |
| It completed with outcome `proposal` | That revision has no proposal to save: it is still running, failed or only recommended |
| The person saving started it (the job's starter is the caller's subject) | That revision was started by someone else: save it as your own edit |
| The edited document is a PR/FAQ or PRD of the series the pass read (the pass stores it in its job when it starts) | That revision is of another document (another type: Comments are available on PR/FAQ and PRD documents only) |
| At least one of the pass's changes is **new** in the saved text relative to the version being edited, verbatim or as plain text (markup and whitespace aside, as anchors are found): a change with an `after` when the saved text holds that `after` more often than the edited version did (a text already in the document does not count by itself); a deletion (`after` empty) or a trim (an `after` that is a piece of its `before`) when its `before` occurs in the edited version and less often in the saved text, verbatim and as plain text (other markup on the same words is not a deletion), and its `after`, if any, is in the saved text and does not occur less often | This save does not hold a change from that revision |

Each of these 400s carries the machine-readable `code` `revise_refused` beside its `error` (except the
other document type's, which is the route's own check): the canvas reads the code, never the message,
and only on it keeps the draft, says the server's reason and offers **Save as my own edit** (the same
text as a plain edit). Any other 400 on such a save (a malformed `revise_job_id`, the content's own
checks) has no code and is the save's normal error.

`edit_kind` is the server's to record: one in the body is ignored, like any other key the route does
not read. A save without `revise_job_id` is a plain `edit`. An unchanged save (the same content and
title as the version edited) is the usual no-op (`unchanged: true`, nothing written), whatever pass it
names: the pass is not checked.

A checked save also records what wrote the changes it holds: `llm_metadata: {model,
prompt_version}`, the model and prompt version from the pass's own job `result` (the prompt version
the pass ran under, not the current one; the job itself is the row's `revise_job_id`). A pass whose
result names no model or prompt version (one that finished before passes recorded them) adds no
`llm_metadata`: the server never guesses a model. The person is still the author (`edited_by`);
`llm_metadata` says which AI proposed the text.

## Share for review

**Share for review** (anyone who can edit the project) creates the series' review link,
`https://<your app>/review/<id>`, with a **Copy** button. One link per series at a time.

- **Who may open it:** anyone with the link who confirms an email address with an emailed code
  (the default), or only listed domains and addresses.
- **Expiry:** 7, 30 (default) or 90 days. **Turn off link** revokes it at once. An expired or turned
  off link answers "no longer valid". Its reviewers' comments stay.
- **A reviewer** signs in on the review page with an emailed code (the board pool, below), reads
  the **newest version** and comments or replies. They see only their own threads: never the team's
  internal comments, another reviewer's, or anyone's email address. They cannot resolve, delete or
  edit anything. Each reviewer may write 40 comments and replies a day on one link.
- A teammate signed in to the app who opens the link reviews with their app session.
- In the project, comments from the link are marked **Outside reviewer** with the reviewer's
  verified email address.

### Sign-in and email

Reviewers use the same Cognito user pool as the [feedback boards](feature-requests.md)
(`voc-board-user-pool`). Since 5.45.00 it exists on **every** deployment, with no flag:

| Deployment | Sign-in emails come from | How a person signs in |
|---|---|---|
| `-c emailFrom` set | Your address, through Amazon SES | New person: a confirmation code. Returning person: a one-time sign-in code (Email OTP) and a link. |
| No `-c emailFrom` | Cognito's own sender, `no-reply@verificationemail.com` | New person: a confirmation code. Returning person: a password-reset code; the page sets a fresh random password it never keeps. |

Cognito's own sender is limited to **50 emails a day per AWS account** (every user pool in the
account shares that quota) and may land in spam. Setting `-c emailFrom` lifts it
(see [deployment.md](deployment.md#participant-email-and-the-feature-request-board--c-emailfrom)).

The pool never auto-confirms a sign-up: the emailed code proves the inbox. A new account may be
created only for an email that an active review link (named in the sign-up) or a board admits.
The API re-checks the link and the verified email on every call.

## API

| Method | Path | Who | What |
|---|---|---|---|
| GET | `/projects/{id}/documents/{doc}/comments` | view | Every thread of the series, the link, `can_edit` |
| POST | `/projects/{id}/documents/{doc}/comments` | view | New thread `{text, anchor?: {exact, prefix?, suffix?, heading?}}` on this version |
| POST | `/projects/{id}/documents/{doc}/comments/{cid}/replies` | view | `{text}`; 409 past 50 replies |
| POST | `/projects/{id}/documents/{doc}/comments/{cid}/resolve` · `/reopen` | view | Change the status |
| DELETE | `/projects/{id}/documents/{doc}/comments/{cid}` | view + author or edit | Remove the thread |
| GET · POST · DELETE | `/projects/{id}/documents/{doc}/share` | view · edit · edit | The series' link; create `{audience?: {mode: anyone\|list, domains?, emails?}, expires_in_days?: 1–90}` (an active link is returned as is); turn it off |
| POST | `/projects/{id}/documents/{doc}/persona-review` | edit | `{persona_ids?: [≤ 6]}` → 202 assist job; poll `GET /projects/{id}/jobs/{job_id}` |
| POST | `/projects/{id}/documents/{doc}/revise-from-comments` | edit | `{thread_ids?: [≤ 50]}` → 202 assist job (result above); 400 when no thread is waiting |
| POST | `/projects/{id}/documents/{doc}/comments/addressed` | edit | `{thread_ids: [≤ 50], addressed?: bool = true}` → `{threads}` marked addressed by `{doc}`'s own version (the server reads it), or cleared with `addressed: false`; ids not in the series are skipped, 404 when none is; 409 when a thread's history is full (the others still marked) |
| GET | `/review/{share_id}` | board authorizer | `{share, document, threads (own), viewer}` |
| POST | `/review/{share_id}/comments` | board authorizer | New thread on the newest version; 429 `rate_limited` past 40 a day |
| POST | `/review/{share_id}/comments/{cid}/replies` | board authorizer | A reply on one's own thread |

`/review/*` sits behind the board authorizer (the app pool and the board pool) on its own root
resource, throttled 10 rps / 20. It is served by the projects Lambda
(`lambda/shared/document_review_routes.py`), which needs no new permission.

## Storage

All in the projects table:

| Item | Key | Notes |
|---|---|---|
| Thread | `DCOMMENTS#{project}#{series}` / `C#{comment_id}` | Version, anchor, author (`user` / `persona` / `reviewer`), status, replies, `addressed_history` (append-only, at most 100 entries, never trimmed: `[{version, document_id, at, by_kind, by_sub, addressed: bool}]`, one `list_append` per call so two writers never drop each other's entry; past 100 a 409), `addressed` (the newest entry when it is a mark, else null; the API shows `{version, at, by_kind}`) |
| Revised version | `PROJECT#{project}` / the series' next row | A normal version row with `edit_kind: revise`, `edited_from_id`, `edited_by: {sub, kind}` and `llm_metadata: {model, prompt_version}` (none carried to later versions, nor to a restore): written by an applied pass (who asked) or by the person's save of a proposal (`PUT …/documents/{doc}` with `revise_job_id`, checked by the server; that row also keeps `revise_job_id`, and its `llm_metadata` comes from the pass's job result). `GET …/versions` lists each version's `llm_metadata` (null when no AI wrote it) with the model's display label, `model_label` (null for a model no longer offered); History shows "Revised from comments · <model>" |
| Pass's series | the assist job's `config.series_id` (voc-jobs, `PROJECT#{project}` / `JOB#{job_id}`, 1-day TTL) | The series the pass read, checked when its proposal is saved |
| Series' current link | `DCOMMENTS#{project}#{series}` / `SHARE` | Points at the link |
| Link | `DOCSHARE#{share_id}` / `META` | Audience, expiry, revoked; `ttl` 30 days past expiry |
| Reviewer's daily writes | `DCRATE#{share_id}#{email digest}` / `{day}` | `ttl` 2 days |

Deleting a document or a project does not delete its threads. They are unreachable once the
series has no version left.
