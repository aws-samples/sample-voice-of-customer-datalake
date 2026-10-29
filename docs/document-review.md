# Review a PR/FAQ or PRD: margin comments, persona review, share link

A PR/FAQ or PRD in a project shows its comment threads in the margin, like comments in a word
processor. The team comments, asks the project's personas to review, and shares a review link with
people outside the app. Nothing here edits the document, so every
[way of working with AI](ways-of-working.md) has all of it.

## Comments

- **Select text and press Comment.** The thread is anchored to that quote (a
  [W3C text-quote selector](https://www.w3.org/TR/annotation-model/#text-quote-selector): the exact
  text plus 32 characters before and after, and the heading above it). **Comment on the whole
  document** starts a thread with no quote.
- On a wide screen each thread is a bubble beside its passage and the passage is highlighted.
  On a phone the threads form one list under the document, in reading order.
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
| Thread | `DCOMMENTS#{project}#{series}` / `C#{comment_id}` | Version, anchor, author (`user` / `persona` / `reviewer`), status, replies |
| Series' current link | `DCOMMENTS#{project}#{series}` / `SHARE` | Points at the link |
| Link | `DOCSHARE#{share_id}` / `META` | Audience, expiry, revoked; `ttl` 30 days past expiry |
| Reviewer's daily writes | `DCRATE#{share_id}#{email digest}` / `{day}` | `ttl` 2 days |

Deleting a document or a project does not delete its threads yet. They are unreachable once
the series has no version left.
