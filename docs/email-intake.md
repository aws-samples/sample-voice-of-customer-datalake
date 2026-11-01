# Email inbox

Customers, staff and partners can email feedback to the platform: `feedback@`, `ideas@`, `bugs@`
and `reviews@` your inbox domain. Each email is checked, deduplicated, its attachments are read, and
it becomes at most one feedback item with source `email_intake`. An operator turns the inbox on at
deploy time; administrators then watch it and set its caps in **Administration → Sources → Email inbox**.
The inbox is **off by default**: without `-c inboundEmailDomain` nothing is deployed and nothing costs
anything.

## How it works

```
any sender ─► MX ─► Amazon SES receiving (spam + virus scan)
           ─► S3 voc-inbound-email-<acct>-<region>/inbound/   (KMS, private, versioned)
           ─► S3 event ─► SQS voc-email-intake (+ DLQ voc-email-intake-dlq)
           ─► Lambda voc-email-intake (lambda/email_intake/)
                1. guards           (verdicts, automatic / bulk mail, system senders)
                2. parse            (stdlib email, text/plain or HTML converted to text)
                3. forward          (the forwarded original; author = the customer)
                4. dedupe + thread  (Message-ID, thread, new text only, forwards)
                5. caps             (per day, per sender)
                6. relevance gate   (replies only)
                7. attachments      (one model call reads all of them)
                8. source policy    (pii: redact by default) + queue schema
           ─► the processing queue ─► processor (categories, sentiment, dimensions, ...)
           original kept under inbound-raw/<item id>/message.eml for 90 days
```

Email items use the standard ingest contract (`IngestMessage`). An email item carries:

| Field | Value |
|---|---|
| `id` | `em_` + a hash of the `Message-ID` (a forwarded original: a hash of its text) |
| `title` | The subject |
| `text` | The new text only, then an `Attachments:` section (one line per attachment: name and summary, "not relevant" or "not read") |
| `source_channel` | The alias it was sent to (`feedback`, `ideas`, ...) |
| `dimensions.feedback_type` | From the alias or a subject tag (below); none for `feedback@` (the processor infers it) |
| `metadata` | `email` (the sender, lower-cased; redacted under `pii: redact`), `thread_id`, `message_hash`, `attachment_count`, `attachments_key` (the `inbound-raw/` prefix of the original), `is_reply`, `forwarded`, `spf_verdict` / `dkim_verdict` / `dmarc_verdict` |

### Aliases and subject tags

| Address or tag | `feedback_type` |
|---|---|
| `feedback@` | none: the processor decides |
| `ideas@`, `[idea]`, `[feature]`, `[request]` | `feature_request` |
| `bugs@`, `[bug]` | `bug` |
| `reviews@`, `[review]` | none: the processor decides (`review` is not a type) |
| `[question]` | `question` |
| `[praise]`, `[kudos]` | `praise` |

A subject tag wins over the alias. `feedback_type` is a built-in dimension on every deployment since
5.45.00 ([dimensions.md → Feedback type](dimensions.md#feedback-type-built-in)); the model infers it
when nothing else sets it, so the inbox needs no "Create dimension" step. The older
`POST /settings/email-inbox/feedback-type-dimension` route still exists and answers `created: false`. Mail to any other
local part at the domain is accepted on the channel of that local part.

## Guards

The inbox is public, so every email passes cheap, deterministic checks first. A dropped email is
counted (Administration → Sources → Email inbox → today) and deleted; **nothing is ever sent back**: no bounce, no
auto-reply, no backscatter.

| Reason | Rule |
|---|---|
| `spam`, `virus` | SES's `X-SES-Spam-Verdict` / `X-SES-Virus-Verdict` is not `PASS` (a missing verdict fails). SPF, DKIM and DMARC are recorded, never required: forwarded mail often fails SPF |
| `auto_reply` | `Auto-Submitted` other than `no`, `X-Autoreply` / `X-Autorespond`, `X-Auto-Response-Suppress: OOF`, or an out-of-office subject ("Automatic reply", "Out of office", "Abwesenheit", "Réponse automatique", ...) |
| `bulk` | `Precedence: bulk`, `list` or `junk`, or a `List-Id` header |
| `loop_sender` | mailer-daemon, postmaster, noreply-style senders, the null sender `<>`, no sender, or a sender at the inbox domain itself |
| `sender_cap` | More than the per-sender cap today (default 20). The cap counts the full address when SES's SPF or DKIM verdict is `PASS`; an unauthenticated sender shares ONE bucket with every other unauthenticated sender at the same domain, so rotating `From` addresses does not multiply it |
| `no_text` / `unparseable` / `too_large` | Nothing to read; not an email (also a structure the parser cannot survive: recursion or memory exhausted, or `message/rfc822` nested more than 3 levels deep); over 25 MB (checked from the object's size before it is downloaded) |

Caps are checked before any model call and are admin-editable in Administration → Sources → Email inbox. Days are UTC.

**The overall daily cap (`daily_cap`, default 200) never drops mail.** Past it an email is
**deferred** exactly like a spent model budget (below): it stays in `inbound/` and is retried after
00:00 UTC, so a flood can delay real feedback but not lose it. Each deferral counts as `deferred`,
emits the `EmailDailyCapHit` metric and logs a warning. A flood lasting several days ends in the
intake DLQ (8 receives), with the email still in `inbound/` until its 90-day expiry.

Attachment sizes are taken from the encoded payload before anything is decoded, and only an
attachment that will be read is decoded.

## Deduplication and threads

Cheapest first:

1. **The same email twice** (several aliases, CC'd copies, an SES retry): the item id is a hash of
   the `Message-ID`, and a marker row says it was ingested. Counted as `duplicate_message`.
   A copy re-sent under a NEW `Message-ID` (a client re-send, a relay that rewrites ids; SES itself
   assigns a fresh id to every message it sends) is caught by its text instead: the same sender's
   same new text within 14 days joins its first thread and is counted as `seen_in_thread` (step 3).
2. **Threads.** `thread_id` is a hash of the root `Message-ID` (the first `References` id, else
   `In-Reply-To`). Without those headers, a `Re:` subject joins the thread with the same normalised
   subject (`Re:`, `Fwd:`, `AW:`, `RV:`, `TR:`, `[tags]` stripped) from the same sender domain within 14
   days. A fresh email (no `Re:`) always starts its own thread, so "Question" from two customers never
   merges.
3. **Only the new part counts.** Quoted history is cut (`>` lines, "On ... wrote:" in English, German,
   French, Spanish, Portuguese, Italian, Dutch, Scandinavian and Polish, Outlook `From:` / `Sent:` blocks,
   `-----Original Message-----`), and so are signatures (`-- `, "Sent from my iPhone", a sign-off such as
   "Best regards," near the end). The rest is hashed: a hash already seen in the thread bumps the
   thread's `repeats` counter instead of creating an item (`seen_in_thread`).
4. **Relevance gate**, replies only. A one-liner ("thanks", "+1", "ok") is `no_new_info` without a model
   call. Anything else gets ONE call on the `utility` surface (Flex tier where the model serves it,
   16 output tokens): `new_feedback` becomes a new item in the thread, `no_new_info` is counted and
   dropped. When the gate cannot answer, the reply is kept.
5. **Forwards.** A `Fwd:` / `FW:` / `WG:` / `TR:` email with an inline forward (Gmail's
   `---------- Forwarded message ---------`, an Outlook header block) or an attached `.eml` is read as
   the original: the customer is the author, the forwarder is not. The same original forwarded again,
   by anyone, is one item: the forward row counts `forwards` and keeps `forwarded_by` as a set of
   forwarder **domains** (never addresses), an importance signal.

Feedback items are written once. A reply with new text is a **separate item sharing the
`thread_id`**; the root item never changes.

State lives in `voc-watermarks` (no new table), rows `email_intake#thread#…`, `#subject#…`,
`#message#…`, `#forward#…` and `#sender#…`, each with a `ttl` (thread 90 days, subject 14, message
30, forward 180, sender 2). Daily counters and caps live in `voc-aggregates`
(`EMAIL_INTAKE#stats` / day, `SETTINGS#email_intake` / `config`).

## Attachments

Read before ingest, in **one** Converse call per email on the `utility` surface:

- read (at most 5 per email): PDF, DOC, DOCX, XLS, XLSX, CSV, HTML, TXT, MD (up to 4.5 MB each) and
  PNG, JPEG, GIF, WEBP (up to 3.75 MB each);
- a nested `.eml` is parsed as an email (a forward as attachment);
- listed as "not read": larger files, other types, the sixth attachment onwards;
- skipped silently: inline logos (an image with a Content-ID under 40 KB), calendar invites,
  archives, executables and signatures (`.p7s`, `.asc`).

The model writes, per attachment, a summary of at most 400 characters for the feedback and says
whether it is relevant; an irrelevant attachment is listed by name only. The summaries go into
`text`, so the source policy redacts them with the body. Attachment content reaches the model as
document and image blocks, the subject only inside a `data_block('email', ...)` fence: an
instruction inside an email or a file is data. When the call fails, the names are listed and the
email is still ingested.

## Daily model budget

Every model call (relevance gate, attachment read) takes one from today's budget (`daily_model_calls`,
default 400). Past it, an email that needs a call is **deferred, never dropped**: it stays in `inbound/`,
its SQS message is hidden until shortly after 00:00 UTC (at most 12 hours per receive), and it is
retried then. The intake queue allows 8 receives before the DLQ, so a deferral survives several days.
Set the budget to 0 to read no attachments and gate no replies at all (every such email waits).

## Privacy

- The source profile for `email_intake` defaults to **`pii: redact`** (a built-in default in
  `shared/source_profiles.py`): names, email addresses, phone numbers, IBANs, cards and IPs in the
  subject, text, attachment summaries and every metadata value are replaced before archive or queue,
  and the author is dropped ([source-policies.md](source-policies.md)). Saving a profile for
  `email_intake` in Administration → Privacy & access → Source policies replaces that default.
- **The one exception** to "the redacted message is the only copy": the original email, attachments included, is kept under `inbound-raw/<item id>/message.eml` in the
  inbound bucket for **90 days** (lifecycle rule), KMS-encrypted, never public, reachable only by the
  intake Lambda and account administrators. `metadata.attachments_key` points to it. Dropped and
  deduplicated emails keep no copy. The copy keeps the full attachments, which the item only
  summarises, available for those 90 days. An erasure (`POST /settings/erasure`) does not reach this prefix;
  it expires on its own.
- Customer data under `pii: redact` keeps no sender address, so an erasure by email cannot match it
  (there is nothing to match); under `allow` the lower-cased address is kept and erasure finds it.

## Costs

Pay-per-use only; nothing runs when no mail arrives:

- SES receiving: per 1,000 emails and per 256 KB of incoming mail
  ([pricing](https://aws.amazon.com/ses/pricing/)).
- S3 (≤ 90 days per email), SQS, one Lambda run per batch of up to 5 emails (at most 2 at once).
- Per accepted email: the processor's usual Comprehend, Translate and Bedrock enrichment, plus at most
  two inbox model calls (gate, attachments), bounded by the daily model budget, plus Comprehend PII
  detection for redaction.

## Deploy and configure a custom domain

### Flags

| Flag | Meaning |
|---|---|
| `-c inboundEmailDomain=voc.example.com` | Turns the inbox on: SES receives for this domain |
| `-c inboundEmailHostedZoneId=Z…` | A Route 53 public hosted zone: CDK writes the MX record and the DKIM CNAMEs into it |
| `-c inboundEmailHostedZoneName=example.com` | The zone's name, when it is not the domain's parent |
| `-c inboundEmailRuleSet=<name>` | Add the rule to this EXISTING receipt rule set (normally the region's active one) |
| `-c inboundEmailCreateIdentity=false` | Do not create the SES domain identity (it already exists) |

Example (a Route 53 zone `example.com`, an active rule set already in the region):

```bash
npm run deploy:infra -- -c inboundEmailDomain=voc.example.com \
  -c inboundEmailHostedZoneId=Z0123456789ABCDEFGHIJ \
  -c inboundEmailRuleSet=<the active rule set>
```

### Step by step

1. **Choose a region where SES receives email** (for example us-east-1, us-west-2, eu-west-1; see the
   [SES endpoints](https://docs.aws.amazon.com/general/latest/gr/ses.html)). The MX record points at
   `inbound-smtp.<region>.amazonaws.com`.
2. **Choose the domain.** A subdomain you control (`voc.example.com`) keeps the inbox apart from your
   company mail. Two things cannot be used: `on.aws` is AWS's own domain (nobody can point mail at it),
   and the WorkMail test domain (`*.awsapps.com`) is gone with WorkMail, which stopped taking new customers
   on 2026-04-30 and shuts down on 2027-03-31.
3. **DNS.**
   - Route 53 zone in this account: pass `inboundEmailHostedZoneId`. CDK creates the MX record and the
     three DKIM CNAMEs. Check that no other MX exists for the same name.
   - External DNS: deploy without it. The stack outputs `InboundEmailMxRecord` and
     `InboundEmailDkimRecord1..3`; give them to your DNS admin.
   - No domain yet: `voc-datalake/scripts/register-domain.sh <domain>` prints the Route 53 Domains
     registration command (about USD 15 a year for common TLDs). It never buys anything itself:
     registration costs money, needs contact details and sends a verification email, so you run it
     yourself, once.
4. **Verify the domain in SES.** CDK creates the SES domain identity (Easy DKIM) for the inbox domain;
   with a zone it verifies on its own within minutes. A verified parent domain already covers sending
   from a subdomain; the subdomain identity makes receiving explicit. If the identity already exists,
   pass `inboundEmailCreateIdentity=false`.
5. **The receipt rule set.** Only one rule set is active per region. VoC never activates one:
   - The region already has an active set (Amazon Connect creates one, for example
     `AmazonConnectEnabledRuleSet-DO-NOT-DELETE`): pass `inboundEmailRuleSet=<its name>`. CDK adds ONE rule,
     `voc-email-intake-<account>-<region>`, matching only the inbox domain.
     Find it with `aws ses describe-active-receipt-rule-set --region <region>`.
   - No active set: deploy without the flag. CDK creates `voc-email-intake-<account>-<region>` with the
     rule and outputs `InboundEmailActivateRuleSet`, the command to activate it. Run it only if no other
     receiving rule set is needed; Administration → Sources → Email inbox warns until it is active.
6. **Test** with a sample email (any mailbox, or SES itself when the sender is a verified identity):

   ```bash
   aws sesv2 send-email --region <region> --from-email-address you@<verified domain> \
     --destination ToAddresses=feedback@voc.example.com \
     --content 'Simple={Subject={Data="Checkout keeps failing"},Body={Text={Data="The checkout says card declined."}}}'
   aws logs tail /aws/lambda/voc-email-intake-<account>-<region> --since 5m
   ```

   Administration → Sources → Email inbox shows it under **Accepted**; the item appears in the feedback list with source
   `email_intake` a minute later.

### Removing the inbox

Deploy again without `inboundEmailDomain`: the rule, bucket (and its objects), queues, worker, identity
and records are removed. An own rule set is deleted with it (deactivate it first if you activated it).

## Code

| Part | Where |
|---|---|
| CDK | `lib/stacks/email-intake.ts` (flags: `lib/utils/inbound-email.ts`), VocIngestionStack |
| Worker | `lambda/email_intake/` (`handler.py`, `intake.py`, `guards.py`, `mime.py`, `text_cleanup.py`, `state.py`, `model_calls.py`, `compose.py`); tests and `.eml` fixtures in `lambda/email_intake/test/` |
| Settings API | `GET` / `PUT /settings/email-inbox`, `POST /settings/email-inbox/feedback-type-dimension` (kept for older clients, answers `created: false`) (admin; `settings_handler.py`, `shared/email_intake_settings.py`) |
| UI | `frontend/src/pages/Settings/EmailInboxCard.tsx` (Administration → Sources → Email inbox) |
