# The morning brief

Home is each user's own morning brief: a greeting, three metric tiles, the brief's cards,
"Things to do", the setup checklist and "How it works". The brief's settings live on
**Account → Morning brief** (`/account?tab=briefing`), with every other personal preference
([Account or Administration](account-vs-admin.md)). The brief is
**off until the user subscribes or presses Refresh**. Nobody subscribed and nobody pressing
Refresh means no model call and no build.

## Home layout

- **Header**: the greeting, the brief's freshness, **Refresh** and **Settings** (a link to
  Account → Morning brief), and "Show setup checklist" once the checklist is off Home. The
  dashboard is one click away in the sidebar; "Open the dashboard when I sign in" is set on
  Account → Preferences.
- **Agent decisions** (live, not part of the brief build): one warn card per autonomous agent
  whose last run stopped for a person (`stats.last_run_status = needs_human`), with the reason,
  the step and when it stopped. Admins get **Make the decision**, everyone else **Review the run**
  (deciding is admin-only); both open `/agents/<id>?tab=runs`. Home reads the same `/agents`
  query as the sidebar badge (refreshed every minute) and each waiting run. While these cards
  show, the brief's "agent runs waiting" row is left out of "Things to do". Each card has an
  **X** that closes it for that waiting run, for this user on every browser
  (`PUT /settings/my-onboarding {dismiss_decision_run: <run id>}`). Closing decides nothing: the
  run still waits on the agent's Runs tab and the sidebar badge still counts it, and a later run
  that stops for a person shows a new card.
- **Subscribe** (only while the user is not subscribed): a one-click "Subscribe to the morning
  brief" card above the brief — the default hour (8:00, or the stored one) in the browser's time
  zone — with a "Customise in Account" link; no settings fields on Home. Once subscribed it disappears.
  Its **X** closes it for good (`{subscribe_prompt: dismissed}`); Account → Morning brief still
  subscribes.
- **Brief settings** live on Account → Morning brief. Until the reader subscribes it shows
  the Subscribe control (pick the hour, then Subscribe) and the brief language; once subscribed:
  on/off (off unsubscribes), time, brief language, custom instructions and email.

## Which language

The brief is written in the language the reader uses the app in, unless they explicitly chose a
brief language. The preferences row carries `language` and `language_source`:

- `ui` (the default): follow the app. Refresh sends the app's language (`POST
  .../refresh {language}`); when it differs from the stored one, the server stores it on the row
  (`language_source: 'ui'`) before the build, so the build, the next scheduled brief and the email
  use it. Subscribe records the app's language as `ui`. For a **subscribed** reader the SPA also
  moves a `ui` language when the app's language changes, without a Refresh (one `PUT
  {language, language_source: 'ui'}` when Home or Account loads the preferences).
- `chosen`: picked in **Brief language** on Account → Morning brief (shown to unsubscribed readers
  too). It wins for Refresh, the scheduled brief and the email. **Same as the app (<language>)**
  goes back to `ui`.

A row stored before 5.17 has no `language_source` and counts as `ui`: Subscribe wrote every such
row with the reader's UI language, or the row holds the `en` default. A `PUT` naming `language`
without `language_source` is an explicit choice (`chosen`). The scheduled worker has nobody in
front of the screen and always uses the stored language.
- **Collapsible sections**: "Your setup checklist" and "How it works" have a
  chevron heading and start expanded. The checklist's and "How it works"' **Skip** are stored per
  user (`PUT /settings/my-onboarding {state: skipped}` / `{guide: skipped}`): a skipped section
  starts collapsed on every browser, and expanding it un-skips it (`state: active` /
  `guide: open`). "Hide for now" (one-day snooze) and "Don't show again" still take the checklist
  off Home; the hero's "Show setup checklist" brings it back.

`GET|PUT /settings/my-onboarding` (`lambda/shared/onboarding.py`): `{state: active | hidden |
dismissed | skipped, start_page: home | dashboard, guide: open | skipped, subscribe_prompt: shown |
dismissed, dismiss_decision_run: <agent run id>}`, each optional, at least one; a PUT changes only
the fields it names. The GET adds `hidden_until`, `updated_at`, `visible` (computed on the server
clock), `dismissed_decision_runs` (the 50 newest closed run ids) and the first-run `signals`.

## How a brief is built

The `voc-briefing` worker (VocProcessingStack, `lambda/briefing/`) builds one user's brief:

1. **Reader.** The user is re-checked in Cognito: the account must exist, be enabled and match
   the sub. Their scope comes from their current groups and category/source access (the same
   rules as `/feedback/access`). A demoted admin gets a restricted brief straight away.
2. **Org layer, once per scope group per day.** A *scope group* is all the users whose category
   and source access is identical (`scope_hash`). The layer is stored at
   `BRIEFORG#{scope_hash}` / `{UTC day}` in the aggregates table and reused by every user of the
   group. It is rebuilt only when it is missing for the day, or when reviews arrived and it is more
   than 3 hours old.
   - **Facts come from code** (card providers, `lambda/briefing/providers.py PROVIDERS`). They read
     only the categories the scope admits: the per-category counters when every source is visible,
     otherwise the reviews themselves, filtered review by review (at most 3,000).
   - Code cards: *what's new*, *trending topic* (with up to 3 PII-redacted quotes), *sentiment
     shift*, and two **code-only alerts**: a category spike (today at least 5 reviews and twice its
     usual day) and an urgent jump (at least 3 urgent reviews this week, more than the week before).
   - **One model call** (`utility` surface, `shared/converse.py`) writes the words for the non-alert
     cards, using only their facts, plus at most 2 "idea to investigate" cards tied to them. It is
     grounded with SHARED company knowledge (company context and company memories,
     `shared/grounding.py`).
3. **Personal layer, one model call per build.** The "Things to do" cards are computed in code:
   - agent runs waiting in `needs_human` (admins see all agents, other users only their own);
   - memories waiting for review (the company queue for curators, the user's own memories for
     everyone);
   - the user's own MCP tokens expiring within 7 days.

   Then one call re-words and orders every card for the reader, in their language, and may add up
   to 2 personal notes. It uses their custom instructions, their own objectives and personal
   memories (PRIVATE grounding), and the names of the projects they own or are a member of.
4. **Scope check.** Before anything is stored, every card that names a category the reader cannot
   see is dropped. Quotes are only ever read from admitted reviews.
5. **Storage.** The brief is stored at `BRIEF#{sub}` / `{local day}` with `status`
   (`pending | ready | failed`), the cards and `card_state` (`seen | dismissed | acted` per card).
   Card ids are stable for the same fact on the same day, so the state survives a same-day refresh.

If a model call fails, the cards keep their code-written English titles: a brief is never lost to
the model. All text that came from people (quotes, instructions, memories, company context) goes to
the model as DATA blocks (`brief_facts`, `brief_instructions`, `memory`, `company_context`).

Card providers follow the contract in `lambda/shared/brief_cards.py`: `(BriefContext) ->
list[BriefCard]`, code only, no model. A provider that raises is dropped and the rest are kept.
Release watch (`shared/release_watch.py`) plugs into `PROVIDERS` as one more provider.

### Radar cards

`radar_cards` (`lambda/briefing/radar_cards.py`) is one more provider. It adds **at most 3 cards**
about the other brands Radar tracks ([radar.md](radar.md)), one of each kind, facts from code only:

| Card | When | Facts |
|---|---|---|
| `radar_release` | A tracked brand had a release filed since the scope group's previous brief (the org layer of an earlier day; at most 7 days back) | The brand with the newest one: up to 5 new releases (feature, release day, official or press), its cited URLs in `urls` |
| `radar_complaints` | A brand's share of negative reviews rose by at least 10 points, this week against the week before, with at least 10 reviews in each | Review and negative counts of both weeks, both shares, the top complaint theme (category / subcategory and count) |
| `radar_beats_us` | In the last 30 days a brand's positive share leads ours by the Radar page's 10-point margin, on at least 10 of its reviews | Up to 3 such categories, both positive shares and volumes |

Visibility is the Radar API's: a brand is used only when the reader may see **every** source tracking
it; themes and comparisons name only categories the scope admits (and the brief's scope check drops a
card naming any other); "where they beat us" is left out when the reader's source rule hides one of our
own sources. The brand list comes from one function, `effective_brands`. The worker reads `voc-radar`
(`RADAR_TABLE`) with GetItem and Query only. A deployment with no Radar brands gets no Radar card and
pays nothing more.

On Home a card's `urls` render as **Sources** links (absolute `http`/`https` only, new tab), and every
Radar card has **Open Radar**, which opens `/radar?brand=<key>`.

## Triggers

| Trigger | What runs |
|---|---|
| **Schedule.** EventBridge every 15 minutes runs `voc-briefing` (dispatch) | Reads only the `BRIEFSUB` partition (one row per subscribed user). Each user whose local hour (`hour` + IANA `time_zone`) has passed today is claimed for the day with a conditional write and queued once. A missed tick is caught up later the same local day. |
| **Refresh** (`POST /settings/my-briefing/refresh`) | Anyone, no cap. Rebuilds only the caller's brief, and their group's org layer only if it is stale. **Free debounce:** if no review was processed since the last brief, that brief is less than 15 minutes old and the brief's language and custom instructions are unchanged, the answer is `up_to_date` with no work. A build that is already running answers `pending`. |

Builds run from the SQS queue `voc-briefing` (KMS, DLQ `voc-briefing-dlq` after 3 tries). They are
one message at a time, **at most 2 at once**, so briefs never crowd the shared Bedrock quota.
A `pending` build older than 15 minutes reads as `failed`.

## Cost

| | Per user per day |
|---|---|
| Not subscribed, never refreshes | nothing |
| Subscribed | 1 personal call, plus the org call of their group (shared by the whole group: a typical workspace has 1 to 3 groups, so 1 to 3 org calls a day) |
| Each Refresh that is not debounced | 1 personal call, plus 1 org call if the org layer is stale |

DynamoDB reads are bounded: per-category counters for 14 days, or at most 3,000 reviews.
The dispatcher is one Query of an empty partition every 15 minutes when nobody subscribed.
That is 2,880 short Lambda invocations a month, within the free tier. There is no provisioned
capacity and no always-on compute.

## API (settings API, self only)

| Method | Path | |
|---|---|---|
| GET / PUT | `/settings/my-briefing` | Preferences `{enabled, hour (0-23), time_zone (IANA, validated), language (the 9 UI languages), language_source (ui \| chosen; a PUT naming language without it stores chosen), instructions (max 2,000 characters, screened for prompt-injection phrasing), email}` plus `email_status: off \| pending \| confirmed`. A PUT changes only the fields it names. |
| GET | `/settings/my-briefing/brief` | The newest brief (`status: none` before the first one) |
| POST | `/settings/my-briefing/refresh` | Optional body `{language}`, the reader's UI language (one of the 9; anything else, or another field, is a 400 naming the list). Used unless the reader chose a brief language ([Which language](#which-language)). Answers `{status: up_to_date \| pending, brief}` |
| PUT | `/settings/my-briefing/cards` | `{day, states: {card_id: seen \| dismissed \| acted}}` (at most 50) |

These routes live under the existing `/settings/{proxy+}`, so they add no API Gateway resource.
Preferences are stored on the user's own `USERCTX#{sub}` / `briefing` row.

## Email

- One SNS topic, `voc-briefing-<account>-<region>`, encrypted with the platform KMS key.
- Each user has one email subscription with the filter policy `{"sub": ["<sub>"]}`. Every message
  carries that `sub` attribute, so each person gets only their own brief.
- The address is **always the user's own verified Cognito email**, read with `AdminGetUser`. It is
  never taken from the request, so the widget cannot mail a third party. An unverified email is
  refused. The address is not stored: the row keeps the subscription ARN and a hash of the endpoint.
- AWS sends a confirmation email. The widget shows "pending" until the user confirms, then
  "confirmed". If the user clicks the unsubscribe link in an email, the next visit turns email off.
- **Email off, or brief off:** the subscription is removed. A subscription still pending
  confirmation cannot be removed, but nothing is published to a user whose email setting is off.
- Only **scheduled** builds are mailed, never a Refresh. The email is plain text:
  - a fixed ASCII subject (`VoC morning brief - <day>`; SNS needs an ASCII subject);
  - the headline and summary;
  - one line per card;
  - at most 3 PII-redacted quotes, taken from the reader's own cards, so only from categories they
    can see;
  - a link to Home and a line on how to turn it off.

  No HTML and no emojis.

## Act buttons

Each card offers "Investigate", "Draft a PR/FAQ" and "Compare with last month", plus any action the
card carries. A button calls `openAssistant({prompt, context})`, which opens a **new** assistant
conversation with the prompt prefilled and the card's evidence ids on their own line. **Nothing is
sent.** The user reads the prompt and presses send, because a card can lead to a write (plan mode).
The draft lives in memory only (`useAssistantUiStore.pendingDraft`) and is never persisted.

"Things to do" rows link to Agents, Memory or Connect. Dismiss hides a card for the rest of the day; an "Undo" notice right after (8 s, held while hovered or focused) puts it back in its previous state.

## Privacy

- A brief is private to its reader: personal memories, objectives and instructions reach only the
  personal call, never the shared org layer.
- The org layer is shared only by users with exactly the same access.
- Quotes are PII-redacted with the platform's redaction helper before they are stored.
- The worker role reads, and writes only the brief rows. It has no Scan, and no DeleteItem
  anywhere. Its exact DynamoDB grants are pinned in `lib/stacks/memory-agents-dynamodb-grants.json`
  and enforced on every backend test.

## Live test

1. Sign in, open Home, press **Refresh**. The button shows "Generating...", and the cards appear
   when the build ends (polled every 3 seconds).
2. Press **Refresh** again at once: "Your brief is up to date."
   Switch the app to Polski (Account → Language & theme) and press **Refresh**: the brief is
   rebuilt in Polish. On Account → Morning brief, **Brief language** reads "Taki jak w aplikacji
   (Polski)"; pick English, press Refresh on Home: the brief stays English.
3. Press **Investigate** on a card. The assistant opens a new conversation with the prompt
   prefilled. Nothing is sent until you press send.
   On a Radar card, **Open Radar** opens the Radar page for that brand, and a release card's
   **Sources** open the cited pages in a new tab.
4. On Account → Morning brief (`/account?tab=briefing`), **Subscribe** at the next hour, turn
   **Email me the brief** on and confirm the AWS email. The
   brief arrives after the next 15-minute tick past that hour.
