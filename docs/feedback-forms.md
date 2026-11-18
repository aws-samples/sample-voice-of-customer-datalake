# Feedback Forms

Feedback Forms collect customer feedback directly, through a form you embed on your website or in your
application. Signed-in users create and manage forms on the **Feedback Forms** page; customers fill them in
without signing in, and each response goes through the same enrichment pipeline as every other source.

## Overview

Since 7.55.00 a form is a flow of questions (schema version 2): a welcome screen, 1 to 30 questions of ten
types, logic that jumps forward to a later question or to one of up to five endings, hidden fields the link
or the app fills in, and texts in any of the app's nine languages. A form:

- embeds on any website, or opens from a link, through its iframe page;
- routes each response to the processing pipeline, its category taken from the answered option that maps one;
- has a test link whose responses never count;
- has per-question results, and an AI that drafts a form from a description.

A form saved before 7.55.00 (schema version 1: a title, an optional rating, one text question) is migrated
when it is read and written back as version 2 on its next save ([Migration from version
1](#migration-from-version-1)). The schema's one definition is `lambda/shared/forms_v2.py`; a response's
checks are `lambda/shared/forms_v2_responses.py`, the results `lambda/shared/forms_v2_results.py`.

## Creating a Feedback Form

1. Open **Feedback Forms** in the sidebar.
2. Click **Create Form**, then pick a template, start blank, or describe the form and let the AI draft it
   ([AI drafts](#ai-drafts)).
3. Edit the questions, their logic, the endings, the hidden fields and the languages, then save.
4. Publish (enable) the form.

New forms are created **disabled** on purpose: nothing is public until someone
enables the form. Until it is enabled, the form's link, iframe and embed render
`Feedback form unavailable.`, and `POST /submit` refuses responses (`code: form_off`), except through the
form's [test link](#test-mode).

## The form (schema version 2)

`POST /feedback-forms` and `PUT /feedback-forms/{id}` take these fields. A create body without `questions`
is a version 1 body: its fields (`title`, `question`, `rating_enabled`…) are migrated first.

| Field | What it holds |
|---|---|
| `name` | The internal name. Never served by the public config |
| `language` | The primary locale, one of `en es fr de pt ja zh ko pl` |
| `languages` | The primary plus any translations |
| `welcome` | `{enabled, title?, description?, button_label?}` (the title is required while it is enabled) |
| `questions` | 1 to 30 questions ([below](#questions)) |
| `hidden_fields` | At most 20 `{id, label?}`: `id` matches `^[a-z][a-z0-9_]{0,39}$`, `label` at most 64 characters |
| `endings` | 1 to 5 `{id, title, description?, button?: {label, url}}`: `id` matches `^end_[a-z0-9_]{1,40}$` |
| `settings.test` | `{link_enabled, record: tag \| drop}` ([Test mode](#test-mode)); the token is issued by its own route |
| `theme` | Colours and radius (see [Theming](#theming)) |
| `category`, `subcategory` | The form's own category routing, used when no answered option maps one |
| `project_id`, `document_id` | Optional. The project (and the PRD or PR/FAQ within it) this form validates; `''` validates nothing. Internal: never served publicly |
| `dimension_defaults`, `tags` | Optional. Dimension values ([dimensions.md](dimensions.md)) and tags every response gets. The defaults **win** over the embed's `dimensions` option |
| `custom_fields` | Kept as before |
| `expected_revision` | Optional on a `PUT`: the `revision` the editor loaded. Another one answers `409` (`code: revision_conflict`, with the current `revision`, `updated_by` and `updated_at`) |
| `removes` | Optional on a `PUT` of an answered form: `{questions?: [ids], options?: {question_id: [codes]}}`, every question and option code the save removes on purpose ([The lock of an answered form](#the-lock-of-an-answered-form)) |

A text is an **I18nText**, `{"<locale>": "text"}`: the primary language's text is required, the others fall back
to it, and a blank translation is dropped. Its limits: a headline or title 500 characters, a description,
subheader or consent text 2000, a label or placeholder 200, a button label 80.

The form API answers the form as `item_to_form` projects it: the fields above plus `form_id`, `schema_version`
(2), `revision`, `language_assumed`, `settings.test` as `{link_enabled, record, token_issued, token_issued_at?}`
(never the token), `form_type`, `brand_name`, `created_at`, `updated_at` and `updated_by`, and:

- `has_responses`: a real response was accepted. The submit route marks the form on its first one (from 7.55.00:
  one write per form, never one per submission; a test response never marks it). From then on its question ids and
  option codes are locked, in the builder and on the server ([below](#the-lock-of-an-answered-form));
- `migrated_from: 1` while the form is still stored as version 1 ([below](#migration-from-version-1)).

`GET /feedback-forms/{id}` answers `{form}`, one form as the list shows it plus `response_count`: its stored
responses as `GET …/stats` counts them (the caller's category scope applied), with `has_responses` true also when
that count is not 0 (a form answered only before 7.55.00). A count that cannot be read is left out, with
`stats_error`. A save validates the whole definition and answers a `400` naming the field and the rule.

### The lock of an answered form

A form's answers are stored under its question ids and option codes, so once it `has_responses` neither may change
in place. The builder locks the id and code fields, and removes a question or an option only after saying that its
answers stay in Results. The server enforces the same rule (TENETS.md, tenet 4), so a headless client cannot do more
than the builder:

- A `PUT` whose definition drops a question id the stored form has, or drops an option code from a question it keeps
  (a rename is a drop plus an add, and so is a question that stops being a choice), must name each one in
  `removes`. Otherwise it answers `409` `answers_locked` with what it would drop (`questions`, `options:
  {question_id: [codes]}`) and writes nothing.
- A named removal is saved as the builder saves it. The question id is retired for good (a later save that brings it
  back answers `400` `question_id_reused`), and its answers stay in Results under "Removed questions", a removed
  option's under `removed_options`.
- A form without a real response changes freely, and a save that leaves the definition alone (the name, Enable, the
  theme) needs no `removes`. The builder sends `removes` itself, computed from the form it loaded.
- The server's lock reads the stored `has_responses`, which a form answered only before 7.55.00 gets on its next real
  response. The builder locks such a form at once, because it reads `has_responses` from the response count.

### Questions

Every question is `{id, type, headline, subheader?, required, button_label?, logic?}` plus its type's fields; a
field another type has is refused. `id` matches `^q_[a-z0-9_]{1,40}$`, is unique in the form and is **never
reused**: a save that brings back the id of a removed question is a `400` `question_id_reused`, so old answers never
attach to a new question.

| `type` | Its fields | Its answer |
|---|---|---|
| `open_text` | `long`, `input_type` (`text`, `email`, `number`, `phone`, `url`), `placeholder?`, `max_chars?` (1–5000) | a string |
| `single_select` | `options`, `other`, `shuffle`, `display` | `{code}` or `{other: "…"}` |
| `multi_select` | the same, plus `none` and `min?` / `max?` | `{codes: [...], other?: "…"}` |
| `rating` | `scale` (`star`, `number`, `smiley`), `range` (3, 4, 5, 7 or 10), `lower_label?`, `upper_label?` | a whole number from 1 to `range` |
| `nps` | `lower_label?`, `upper_label?` | 0–10 |
| `csat` | the same | 1–5 |
| `ces` | the same | 1–7 |
| `statement` | `cta?: {label, url?}` | none (it is never required) |
| `consent` | `label` | `true` (an unticked box is no answer; a required consent must be ticked) |
| `contact_info` | `fields: {name, email, phone, company}: {show, required}` (at least one shown) | `{name?, email?, phone?, company?}` |

A choice question's `options` are 1 to 50 `{code, label, category?}`: `code` matches `^[a-z0-9_]{1,40}$`, and
`category` is `{category, subcategory?}`, the routing the option files a response under (never served
publicly). `other` is `{enabled, label?, placeholder?}`, `none` is `{enabled, label?}` (multi only, exclusive),
`shuffle` is `none`, `all` or `except_last`, and `display` is `auto` (a list for 6 options or fewer, a dropdown
above), `list`, `dropdown` or `chips`. The codes **`other` and `none` are reserved** while the question enables
them: they name the Other and None rows, and a None answer is `{codes: ["none"]}`.

Every address (a statement's button, an ending's button) must be `https://` with a host, no user name or
password and no spaces or control characters. A whole definition is at most 300 KB.

### Logic

A rule is `{when: {op, value?}, then: {jump_to}}`. A question's first matching rule wins; with no match the form
goes on to the next question, and after the last one it reaches the first ending. `jump_to` names a **later**
question or an ending, so no logic can loop, and it must exist.

| Type | Ops (`value`) |
|---|---|
| `open_text` | `equals`, `not_equals` (a text, compared ignoring case), `submitted`, `skipped` |
| `single_select` | `equals`, `not_equals` (a code), `includes_any` (codes), `submitted`, `skipped` |
| `multi_select` | `includes_any`, `includes_all` (codes), `submitted`, `skipped` |
| `rating`, `nps`, `csat`, `ces` | `equals`, `not_equals`, `lt`, `lte`, `gt`, `gte` (a number in the range), `submitted`, `skipped` |
| `consent`, `contact_info` | `submitted`, `skipped` |
| `statement` | `submitted` (always true once shown: an unconditional jump) |

At most 20 rules per question. "Otherwise go to" is written as trailing `submitted` and `skipped` rules.

### Hidden fields

Values the link (`hf_<id>=<value>`) or the app (`hidden: {…}`) passes with each response; respondents never
see them. Only declared ids are accepted, each a text of at most 200 characters. A value is stored with the
response as `metadata.form_hidden.<id>`, is a Results filter and a Responses column, and fills a configured
dimension ([dimensions.md](dimensions.md)) when the id is that dimension's key and the value is one of its
values (after the form's `dimension_defaults` and the embed's `dimensions`, which win). Pass ids, not personal
data.

### Languages

`languages` lists the primary and its translations. The respondent's language is the link's `lang=` (or the
widget's `language` option) when the form has it, else the browser's first language the form has, else the
primary; the response records the one used (`language`).

### Revisions

A form's `revision` starts at 1 and goes up by one on every save that changes its definition (`language`,
`languages`, `welcome`, `questions`, `hidden_fields`, `endings`). The other fields (name, enabled, theme, routing,
links, labels, dimension defaults, tags, test settings) change in place, without a revision: the form row keeps only
who saved it last and when (`updated_by`, `updated_at`). That is a recorded gap of TENETS.md D1 (its table). Each
response keeps what those fields decided for it (its `preset_category`, dimensions and tags are on the item), so a
later change rewrites no stored response, but the form keeps no earlier copy of them.

Before a save replaces a revision, its definition is kept as a snapshot row (`FORMREV#{form_id}#{revision}` in the
forms partition). A response names the revision it answered
(`form_revision`), so a respondent who opened the form before an edit is checked against what they saw; a
revision the form has not reached, or one with no snapshot, answers `409` (`code: form_changed`): the widget
asks the respondent to reload. A save is conditional on the revision it read, so two saves never overwrite each
other silently.

### Migration from version 1

A version 1 form is served as revision 1 of version 2, migrated on every read (with `migrated_from: 1`), and
written back as version 2 on its next save (its version 1 fields removed). Nothing is lost: that first save keeps revision 1's snapshot with
the version 1 fields as stored (`v1`).

| Version 1 | Version 2 |
|---|---|
| `language` (7.54.00) | `language` and `languages`. Empty or unknown: the deployment's `primaryLanguage` (else `en`), and the form says `language_assumed: true` until it is saved |
| `title`, `description` | the welcome screen (none when the title is empty) |
| `rating_enabled`, `rating_type`, `rating_max`, `question` | a `rating` question `q_rating` headed by `question`: stars → `star` with the next range that fits `rating_max`, emoji → `smiley` 1–5, numeric → `number` 1–10 |
| `text_question`, `question`, `placeholder` | an `open_text` question `q_text` with `long: true`, headed by `text_question` when the rating is on and by `question` when it is off (7.54.00's rendering), else the localized "Tell us more"; its placeholder kept |
| `collect_name`, `collect_email` | a `contact_info` question `q_contact` showing (and requiring) those fields |
| `success_message` | the first ending, `end_thanks` (the localized "Thank you!" when empty) |
| `submit_button_text` | not carried over: the version 1 widget never showed it, and its untouched English default would land on a form in another language (it stays in the snapshot) |

A version 1 `PUT` (the fields of the pre-7.55 API) is applied to a version 1 form before its migration. On a
version 2 form `title`, `description` and `success_message` set the welcome screen and the first ending in the
primary language, and `submit_button_text` the last question's button; `question`, `text_question`,
`placeholder`, the rating and the `collect_*` fields answer `400` (edit `questions` instead).

The assistant's `update_feedback_form` sends only what every form takes: `enabled`, `name`, `dimension_defaults`,
`tags` and those four mapped texts (`success_message` never empty: the first ending needs a title). Questions,
logic, endings, languages and hidden fields change in the builder (whose **Improve with AI** redrafts the form);
the assistant drafts a new form with `draft_feedback_form` ([AI drafts](#ai-drafts)). Its `list_feedback_forms`
reads each form's settings and a summary of its definition in the primary language: the questions (id, type,
headline, required, option codes, how many rules), the endings, the hidden field ids, the welcome title and the
test link's state, never the option routing or a token.

## Embedding Forms

Embed the form with an iframe. This is the snippet to hand to customers:

```html
<iframe 
  src="https://your-api.execute-api.region.amazonaws.com/v1/feedback-forms/{form_id}/iframe"
  width="100%" 
  height="500" 
  frameborder="0">
</iframe>
```

The iframe route returns a self-contained HTML page: the Lambda inlines
`lambda/api/static/feedback-widget.js` into it and calls `VoCFeedbackForm.init`
with the form's `config` and `submit` endpoints already wired, so nothing else
needs loading. The page's `<html lang>` is the form's primary language and its `<title>` the welcome title.

The page is only served for a form that exists (an unknown id is a `404`, a
disabled form still gets its page so the widget can say it is unavailable), every
value placed in its `<script>` is serialised with `json.dumps` and HTML-inert
escaping rather than interpolated, and it is sent with a
`Content-Security-Policy` (`default-src 'none'`, inline script/style only,
`connect-src 'self'`; no `frame-ancestors`, because the page exists to be
framed) plus `X-Content-Type-Options: nosniff` and `Referrer-Policy: no-referrer`.
See [Public route input limits](#public-route-input-limits) for the id format.

### Link parameters

The iframe page reads its own address (only this page: a widget embedded on a customer's page never reads that
page's address) and hands the widget, before `init`:

| Parameter | Set on `VoCFeedbackForm` | Use |
|---|---|---|
| `hf_<id>=<value>` | `linkHidden` (`{id: value}`) | hidden-field values; the widget posts the declared ones as `hidden` |
| `lang=<locale>` | `linkLanguage` | the respondent's language, when the form has it |
| `test=<token>` | `testToken` | the [test link](#test-mode) |
| `r=<token>` | `participantToken` | a participant ask's link ([participants.md](participants.md)) |

A token (`test`, `r`) is dropped from the address once read, so neither `page_url` nor a Referer carries it.

### The widget's options and handle

`VoCFeedbackForm.init(options)` takes `container` (a selector or an element), `apiEndpoint`, `formId`,
`configEndpoint`, `submitEndpoint` and `eventsEndpoint` (optional; the beacons' route,
`/feedback-forms/<formId>/events` by default), `language`, `hidden` (`{id: value}`: undeclared ids are
dropped, values cut to 200 characters), `test` (the test token), `dimensions` (below) and `preview`. It returns
a handle:

| Method | Does |
|---|---|
| `setHiddenFields(values)` | adds hidden values (`VoCFeedbackForm.setHiddenFields(...)` does it for every form on the page, those loaded later included) |
| `setLanguage(locale)` | switches the respondent's language |
| `update(config)` | renders another config (the editor's preview) |
| `goTo(questionId)` | shows that question (preview) |
| `restart()` | starts again (preview) |
| `destroy()` | removes the widget and its listeners |

A hidden value comes from the link, then `hidden`, then `setHiddenFields`.

**The editor's preview.** `init({container, preview: {config}})` renders the given draft and never fetches,
submits or counts anything; its handle drives it, and so do `postMessage`s from the page's own origin
(`e.origin === window.location.origin`, from its parent frame): `{type: 'voc-form-preview', action: 'config',
config}`, `{…, action: 'goTo', questionId}`, `{…, action: 'restart'}` and `{…, action: 'language', language}`.

**The `dimensions` embed option.** `VoCFeedbackForm.init({..., dimensions: {user_type:
'partner'}})` sends up to 10 string/number values with each submission. The embed runs on
a page anyone can edit, so it may only fill keys the form has **no** `dimension_defaults`
for: a key the form sets keeps the form's value. Unknown keys and disallowed values are
dropped by the processor. It is separate from hidden fields.

The submitter's `email` is stored lower-cased, so an erasure by email matches however it
was typed.

There is no standalone `widget.js` script to load. That path is not a route of the handler, so a
`<script src=".../feedback-forms/{id}/widget.js">` tag gets an API Gateway error instead of the widget: since
7.55.00 a signed-in proxy serves the form's other signed-in routes under `/feedback-forms/{id}/`, so an
anonymous request there is refused by the Cognito authorizer (`401`) before any code runs, and any other path
answers `403 Missing Authentication Token`. Either way it means "no such route" here, not "not allowed".

## Pre-Categorization

A response is filed under the category of the **first answered option that maps one** (in the order of the
logic path, then of the question's options): an option's `category` (`{category, subcategory?}`). Without one,
the form's own `category` and `subcategory` apply, as before. Category ids of a form saved before 5.25 are
read as names, both for the form and for its options. This is useful for:

- **Product-specific forms**: Embed on product pages with category pre-set
- **Support forms**: Route directly to support category
- **Drop-off reasons**: each reason option files its response under its own category

## Theming

Customize the form appearance. The defaults (a form saved without a theme, and
the widget's own fallbacks) are the Kiro Light palette from
[kiro-design-system.md](kiro-design-system.md); the built-in templates use Kiro
Light accent and tone colours:

```json
{
  "theme": {
    "primary_color": "#8e48ff",
    "background_color": "#ffffff",
    "text_color": "#19161d",
    "border_radius": "8px"
  }
}
```

Your own colours are always kept. The label on the start, next and selected
rating buttons is white or `#19161d`, whichever contrasts more with your
`primary_color`, so a light brand colour still gets a readable label. The iframe
page renders the widget inside a `<main>` landmark.

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/feedback-forms` | List all forms (`?include=stats`: each form's card stats, its headline figure included) |
| GET | `/feedback-forms/{id}` | One form (`{form}`), as the list shows it, with its `response_count` and `can_delete_test_responses` |
| POST | `/feedback-forms` | Create a new form (schema version 2; a version 1 body is migrated) |
| PUT | `/feedback-forms/{id}` | Update form (`expected_revision` optional; `removes` on an answered form, [The lock of an answered form](#the-lock-of-an-answered-form)) |
| DELETE | `/feedback-forms/{id}` | Delete form, with its revision snapshots, test responses and funnel rows; recorded first ([Deleting a form](#deleting-a-form)) |
| GET | `/feedback-forms/{id}/config` | Public config endpoint. **Unauthenticated** and fetched cross-origin by the embedded widget, so it returns only the widget-rendering fields, via a separate allowlist (`item_to_widget_config` in `lambda/api/feedback_form_handler.py`) rather than the projection the authenticated routes use: schema version 2 without the name, the option categories, the hidden fields' labels, the links, the labels or the test settings. `?test=<token>` adds `test: {valid, record?}` beside the config. It only reads: the funnel's open is the widget's `opened` beacon on `…/events` ([The funnel](#the-funnel)) |
| POST | `/feedback-forms/{id}/submit` | Submit a response (or the version 1 widget's body); responses only |
| POST | `/feedback-forms/{id}/events` | **Unauthenticated**, like `submit`: the widget's funnel beacons (`opened`, `left`), on their own throttle ([The funnel](#the-funnel)) |
| GET | `/feedback-forms/{id}/iframe` | Embeddable HTML page |
| GET | `/feedback-forms/{id}/results` | Per-question results ([Results](#results-and-responses)) |
| GET | `/feedback-forms/{id}/responses` | The responses, paged, or as CSV |
| DELETE | `/feedback-forms/{id}/responses?test=true` | Delete the form's test responses (an admin or the form's creator); recorded first ([Test mode](#test-mode)) |
| POST | `/feedback-forms/{id}/test-link` | Issue or rotate the test link (admins) |
| POST | `/settings/form-drafts` | Start an AI draft of a form ([AI drafts](#ai-drafts)); the settings API's |
| GET | `/settings/form-drafts/{job_id}` | One of the caller's AI drafts; the settings API's |

The signed-in routes since 7.55.00 (`results`, `responses`, `test-link`) ride one Cognito-authorized proxy under
`/feedback-forms/{id}/` serving GET, POST and DELETE only. The AI draft's two routes are the settings API's, on its own
`/settings/{proxy+}` (Cognito-authorized too), served by its Lambda (`lambda/shared/forms_v2_draft_routes.py`), not
the forms Lambda: that one also serves the four public routes, so its role holds no worker invoke and no jobs-table
access (TENETS.md tenet 6). Before the AI review's round 1 they were `POST /feedback-forms/draft` and `GET
/feedback-forms/draft/{job_id}` on the forms Lambda; those paths now answer `404` (a static `draft` resource for them
would take the API stack past its resource gate). API Gateway sends every method of these routes through the
authorizer.

### Rate limits on the four public routes

The four unauthenticated routes carry per-method rate limits, set as API Gateway
stage method settings in `voc-datalake/lib/stacks/api-gateway.ts`. They are worth
knowing before you embed the widget, because they are observable from your page:

<!-- These figures are LOCKSTEPPED against the stack: `the public feedback-form
     routes` in voc-datalake/lib/stacks/api-stack.test.ts parses every line here
     that names a route and states a rate, and fails if it disagrees with what
     api-gateway.ts deploys. So edit them only alongside the stack.

     Write a pair as `<rate> req/s, burst <burst>` or `<rate> rps / <burst>`. The
     parser anchors the burst to the `, burst ` or the `/` immediately after the
     rate, deliberately, so that a row stating no burst yields nothing and fails
     loudly rather than adopting an unrelated later number. `(burst N)` or "with a
     burst of N" will NOT parse and the failure will say the row states no pair.

     Prose ABOUT throughput is fine and is not judged — a line is only checked if
     it carries digits immediately before a per-second unit. -->

| Route | Rate / burst |
|-------|--------------|
| `GET /feedback-forms/{id}/config` | 100 req/s, burst 200 |
| `GET /feedback-forms/{id}/iframe` | 100 req/s, burst 200 |
| `POST /feedback-forms/{id}/submit` | 20 req/s, burst 40 |
| `POST /feedback-forms/{id}/events` | 100 req/s, burst 200 |

`submit` is the tighter one because each submission enqueues a record that drives
Comprehend, Translate and a Bedrock model invocation downstream, and it takes real
responses only. The two reads are cheap (one `get_item`, and a static HTML render),
so they are held at the higher pair, sized for widget page-view traffic rather than
for submissions. The funnel's beacons (`events`, since 7.55.00) have that page-view
demand too (at most two per visit) and cost one or two `UpdateItem`s each, so they
get their own pair of the same size: a busy embed's beacons never spend the
responses' limit.

These figures are **pinned against the synthesized template** by a lockstep case in
`voc-datalake/lib/stacks/api-stack.test.ts`, so tuning the numbers in `api-stack.ts`
without updating this table fails the CDK suite. The stack is the source of truth;
this table cannot silently go stale.

Two properties surprise people:

- **A limit is per route, not per form or per caller.** The method setting keys on
  the path with the form id left as a variable, so one ceiling is shared across
  every form in the deployment and every visitor. 100 req/s is therefore the
  *aggregate* widget page-view rate a deployment supports, across all embeds.
- **A throttled request never names the limit, and each route fails differently.**
  Nothing surfaces "429" to the visitor, so the symptoms are easy to misattribute:

  | Route | What a 429 looks like |
  |-------|-----------------------|
  | `GET /config` | The widget renders a flat `Failed to load form.` in the container, with no retry. The gateway's 429 carries your deployment's frontend origin, not `*`, so the widget on a customer's site cannot read it and treats it as a network failure (a dev deployment, whose origin is `*`, shows `Feedback form unavailable.` instead, the same message a disabled form produces) |
  | `POST /submit` | An inline `Failed to submit. Please try again.` notice beside the arrows (an alert region, so it is announced; when the API refused the submission with a reason, e.g. a text past the length bound, that reason is shown instead), with the visitor's typed feedback still in the form. Retryable: pressing Next submits again and clears the notice |
  | `GET /iframe` | No widget code runs at all: the browser navigates here directly, so this is a raw API Gateway error page inside your `<iframe>`, i.e. a broken frame |
  | `POST /events` | Nothing at all: the widget sends a beacon and ignores the answer, so a throttled one costs one funnel count |

  If a busy page shows any of these intermittently, suspect the rate limit before
  the form's state; the fix is raising the number in `api-gateway.ts`, not a change
  on the page.

## Processing Pipeline

Submitted feedback follows the same processing pipeline as other data sources:

1. **Submission**: the route validates the body (a version 2 response against the revision it answered,
   [Responses](#responses)), keeps the validated fields in the raw lake
   (`raw/feedback_form/{y}/{m}/{d}/<feedback id>/<sha16>.json`, connector `feedback_form`;
   opt-in: only once an admin saves a `feedback_form` source profile that permits a raw copy,
   [source-policies.md](source-policies.md)), applies the source policy and sends the item, with
   `s3_raw_uri` naming that copy, to the SQS queue. The copy holds the item's `text` and `dimensions` as
   validated, the checked response (`form_revision`, `language`, `answers`, `hidden`, `ending_id`, `path`) or
   the version 1 body's `rating`, plus `page_url` and `custom_fields`; a version 1 body's `email` / `name` only
   when the form asks for them. Any other body field and the participant link token are never kept. A failed
   raw write is logged and the submission is queued all the same.
2. **Processing**: the processor enriches it (Comprehend, Translate, Bedrock).
3. **Storage**: the item is saved to `voc-feedback` with its metadata.
4. **Display**: it appears in the dashboard with the `feedback_form` source.

The `source_channel` field identifies which form the feedback came from (e.g., `form_abc123`).

**What a version 2 response becomes** (`_ingest` in the handler, shared/forms_v2_responses.py):

- `text`: each free-text answer (an open text, or a choice's "Other") under its question's headline in the
  primary language, in the order of the logic path. A response without free text gets its structured answers as
  `headline: answer` lines (choices by their primary-language labels, scores as `n/max`); contact details never.
- `metadata.form_answers`: the answers by question id, as checked; `form_hidden`, `form_path` (the questions its
  logic showed), `form_revision`, `form_language`, `form_ending_id`, and `form_version: '3.0'`. `form_version`
  versions the layout of this metadata, not the form: `'2.0'` is the version 1 widget's item (as before 7.55.00),
  `'3.0'` a response to a form of `schema_version` 2 (the form's own schema). A contact answer's
  email and name are also `submitter_email` / `submitter_name` (an erasure by email finds them); under a
  `redact` or `summary_only` profile the contact's name is not kept at all, and every metadata text is redacted
  and cut to 1,000 characters (the item's `text` keeps the whole redacted answers).
- `rating`: the first answered `rating` question, else the first CSAT (NPS and CES stay in `form_answers`).
- `preset_category` / `preset_subcategory`: the first answered option that maps one, else the form's routing.
- `language`: the response's language.
- The hidden fields fill configured dimensions as [above](#hidden-fields).

A form's [test responses](#test-mode) never take this path.

## Responses

`POST /feedback-forms/{id}/submit` takes a version 2 response:

```json
{"form_revision": 3, "language": "pl", "answers": {"q_reason": {"code": "missing"}, "q_which": "Bulk export"},
 "hidden": {"app_version": "5.0.3"}, "ending_id": "end_thanks", "page_url": "https://…", "test": "<token>"}
```

Its keys are `answers` (required), `hidden`, `form_revision` (the current revision when absent), `language`,
`ending_id`, `session` ([The funnel](#the-funnel)), `test`, `form_id`, `page_url`, `dimensions`,
`participant_token` and `custom_fields`; any other key
is refused. Every answer is checked against the form's revision: its type and shape, a range, an option code,
the characters of an open text (its `max_chars`, else 5,000) and its `input_type`, a multi-select's `min` / `max`,
a contact's required fields, the hidden ids (declared only, 200 characters each), the language (one of the
form's), the ending (the one the logic reaches), and the **logic path**: a required question on the path must be
answered, and an answer to a question the logic skipped is refused. An empty answer (`null`, `""`, no choice, an
unticked consent) counts as no answer. All the free text of a response together is at most 20,000 characters.

The answer is `{success, feedback_id, message, ending_id}` (`message`: the ending's title in the response's
language). A refusal is a `400` `{success: false, error, code, question_id?}`, so the widget words it in the
respondent's language and goes back to that question:

| `code` | Means |
|---|---|
| `answer_invalid` | an answer of the wrong type, range, code, length or format |
| `answer_required` | a required question (or contact field) on the path is unanswered |
| `answer_skipped` | an answer to a question the logic skipped |
| `answer_unknown` | an answer to no question of this revision |
| `selection_count` | a multi-select outside its `min` / `max` |
| `empty_response`, `response_too_long` | no answer at all, or too much text |
| `hidden_unknown`, `hidden_invalid` | an undeclared hidden id, or a value that is not a text of 200 characters |
| `language_invalid`, `ending_mismatch`, `submission_invalid` | the language, the ending, or the body's shape |
| `form_off` | the form is disabled |

A `409` `form_changed` means the revision is gone (reload); a `403` `test_link_invalid` a wrong or turned-off
test token. The version 1 widget's body (`text`, `rating`, `name`, `email`) is still accepted, as before.

## Test mode

A form's **test link** opens it, even while it is disabled, and its responses never count:

- `POST /feedback-forms/{id}/test-link` (admins: of the workspace, acting as themselves, else the deployment's
  `admins`) issues the token, or keeps it, and answers `{test: {link_enabled, record, token, token_issued_at},
  test_link, test_query}` (`test_link` is the iframe page with `?test=<token>`). Body (optional): `rotate: true`
  (a new token: the old link stops working), `link_enabled` (default `true`), `record` (`tag` or `drop`). The
  token leaves the server only here; the form API shows `token_issued` instead.
- `settings.test.link_enabled` turns the link off and on (the same link); `settings.test.record` chooses:
  - `tag`: the response is checked like any other, then kept **apart from the form** (a `{form_id}#…` row of the
    test responses' own partition beside its forms partition, `FEEDBACK_FORM_TEST`, a workspace's
    `WS#{ws}#FEEDBACK_FORM_TEST`; `is_test: true`), never queued, archived, attributed to an ask or counted;
  - `drop`: the response is checked, then nothing is stored. Both answer `200` with `test: tag | drop`.
- `GET …/config?test=<token>` answers `test: {valid, record}` (or `{valid: false}`) beside the config, so the
  widget shows its TEST strip, or "This test link no longer works", before anyone answers.
- `DELETE /feedback-forms/{id}/responses?test=true` deletes the form's test responses and the test link's funnel
  counters (its visit rows expire on their own, [The funnel](#the-funnel)). **Test
  responses are kept until an admin or the form's creator deletes them** (the owner's decision of 2026-11-18): an
  admin of the workspace (acting as themselves), else of the deployment (`admins`), or the person who created the
  form (its `created_by`, never a delegated caller); anyone else gets `403` (`code: test_responses_admin_or_creator`).
  A form created before 7.55.00 has no `created_by`, so its admins only. `GET /feedback-forms/{id}` answers
  `can_delete_test_responses` for the caller, and the builder's Test tab offers **Delete all** to those people only
  (the others read who can). Every delete that removes a row is recorded first, like a form's delete ([Deleting a
  form](#deleting-a-form)): a workspace's form in its audit partition `AUDIT#WS#{ws}` of voc-workspaces (kind
  `feedback_form_test_responses`, the caller's sub, the form id, `count` and the time), a deployment form as one
  `AUDIT#delete` row of voc-aggregates (the same kind, the form id, the caller as `{sub, kind}`, `count` and the
  time); `count` is the test responses removed, never their content. A row that cannot be written deletes nothing, a
  delete of nothing records nothing, and each delete is its own row. Real responses are feedback items of the lake and
  are never deleted there.
- A tagged test response is kept as answered, without the source's PII policy (it never becomes a feedback item):
  test with sample data, and delete the test responses when you are done. The deployment's legal deletes still
  reach it (`voc-retention`, [source-policies.md](source-policies.md#retention-and-erasure)), in the scopes they reach
  feedback items in: an erasure by email or by name finds the contact answer of a test response (the row keeps
  `submitter_email`, lower-cased, and `submitter_name`; one written before the AI review's round 1 has them only in
  its answers, which the erasure reads too), an erasure of the whole `feedback_form` source deletes the deployment's
  test responses, and the `feedback_form` source's retention period deletes the older ones. An erasure by email and
  the retention period reach every workspace's forms too, a workspace's own erasure only that workspace's; an
  erasure that deletes a workspace's test response clears that workspace's exports, which hold its test responses. Each one
  leaves a tombstone first. Keeping them unredacted is a recorded gap (TENETS.md, the D5 row).

Test responses are in no metric, NPS, dashboard, Prioritization evidence or processing: they never reach
`voc-feedback` or the queue. Two guards hold that even for one that would: the processor drops a message marked
`is_test` before validation, and the aggregator skips a stream record of an item marked `is_test`. Results and
Responses show them only with `include_test`. The editor's preview never submits.

## Results and responses

`GET /feedback-forms/{id}/results` and `GET /feedback-forms/{id}/responses` read the form's feedback items
(its `source_channel` in its brand's partition, the caller's category scope applied, as the stats route does)
and, with `include_test`, its test responses. In a workspace its editors and admins may read them (a viewer
gets `403`); deployment-wide, whoever manages forms. Both take `from` and `to` (ISO dates or times), `language`,
`ending` and `hidden.<id>=<value>`.

**Results** (`include_test=false` by default): `{responses, test_responses, last_response_at, questions,
endings: {id: n}, hidden: {id: n}, removed_questions: [{id, answered}], funnel}`. Each question of the current
revision has `shown` (the responses whose path showed it), `answered`, `skipped`, `not_shown` (the logic jumped
past it) and `drop_off_rate` (skipped / shown), and by type:

| Type | Adds |
|---|---|
| choices | `options: {code: n}`, `other` with `other_latest`, `none`, `removed_options` (codes the revision no longer has) |
| `rating`, `nps`, `csat`, `ces` | `histogram`, `average`, `scale_max`; `nps: {score, promoters, passives, detractors}` (promoters 9–10 minus detractors 0–6, in points), `csat: {score, satisfied}` (the share of 4–5), `ces: {score, easy}` (the share of 5–7) |
| `open_text` | `count` and `latest`: the ten newest `{value, response_id, created_at, is_test, sentiment?}` |
| `consent` | `accepted` |
| `contact_info` | `contacts` (never the values) |

A question id is stable across revisions, so a response to an older revision counts towards the same question;
a value of another shape is left out. A version 1 submission counts as the answers of its migrated `q_rating` and
`q_text`. The forms list's `?include=stats` adds `headline` to each form's stats: its first `nps`, `csat`, `ces`
or `rating` question's score (`{question_id, type, value, count, scale_max}`, `null` without one).

**Responses**, newest first: `{total, responses: [{response_id, feedback_id?, is_test, created_at, revision,
language, ending_id, answers, hidden, path, sentiment?}], next_cursor}`, 50 per page (`limit` up to 100) from
`cursor`; `include_test` is `false`, `true` or `only` (the Test tab's list). `format=csv` answers the matching
responses (the newest 10,000) as a CSV file: the time, ids, `is_test`, revision, language and ending, one column
per question (headlines in the first header row, ids in the second; choices by their labels) and one per hidden
field. A cell that would start a spreadsheet formula, a header's headline included, is prefixed with `'`. Contact
details are in Responses (as the submissions route shows text), never in Results.

### The funnel

Two signals per respondent, never an answer, a hidden value, an address or a user agent, both on their own public
route, `POST /feedback-forms/{id}/events`, which has its own rate limit ([above](#rate-limits-on-the-four-public-routes))
and its own strict model (`FeedbackFormEvent`): a beacon never spends the submit route's limit, which is for real
responses only, and the submit route refuses a beacon (`400 submission_invalid`). A workspace's form is found by its
lookup row, exactly as on submit, and its rows are written in that workspace's forms partition.

- **opened**: `{event: {kind: 'opened', session, revision?}, test?}`, sent with `navigator.sendBeacon` once per page
  load of a form the widget shows (never in the preview), only for a form that is on, or through a valid test link
  (else `400 form_off`, like the submit). The config read itself never writes, so a cached or retried read counts
  nothing;
- **left**: `{event: {kind: 'left', question_id, session, revision?}, test?}`, sent the same way when the page is
  hidden or left, naming the furthest question shown. A respondent who submits sends their path with the response
  instead.

`session` is the widget's random id of the visit (8 to 64 letters, digits, `_` or `-`; the widget sends 24 hex
digits), no person's data. The response carries it too (`session`, kept as `metadata.form_session`).

What is kept, and for how long (TENETS.md D2):

- **The record: bounded counters, kept.** One row per form per day (`FORMFUNNEL#{form_id}#{day}`, the test link's
  apart with `#test`) holds `opened` and one `left:{question_id}` counter per question. It carries no expiry and
  goes with the form's delete (the test link's with its test responses' delete). Results read only these rows, so a
  view costs one row per day, however many people visited.
- **The dedupe: one short-lived row per visit.** `FORMSESSION#{form_id}#{session}` keeps the question that visit's
  `left` is counted at, the day it is counted on and whether the visit then submitted, and expires 7 days after its
  last write (`ttl`). A `left` further on moves the count (the earlier question −1, the new one +1, on the same day's
  row); a response with the same `session` takes the count back and closes the row, so a respondent who switched
  tabs, then answered, counts once, as a response, and a `left` sent after the response counts nothing. A question
  the form no longer has is not counted. Past its 7 days a visit's row is gone: a response more than a week after
  its `left` leaves that `left` counted. A form's delete leaves these rows to expire.

Both live in the form's own forms partition (a workspace's form: `WS#{ws}#FEEDBACK_FORM`). Results answer
`funnel: {opened, left: {question_id: n}, completed}` (a question whose total is not above 0 is left out).

The funnel is advisory. Both signals come from a public route, so anyone who can open the form can add opens and
`left` counts under made-up sessions, within the events route's throttle. That is also its cost bound: an
anonymous caller can write at most one visit row per beacon, so 100 req/s sustained is about 8.6 million visit rows a
day (pay-per-use writes and storage, gone after 7 days) and the counters of the forms it names; nothing it sends is
ever read back, queued or sent to a model. A per-form cap would bound it further (a follow-up, like the submit
route's). A counter and its visit row are two writes, best effort, so one that fails costs a count. Read the
drop-off as a trend next to the responses, not as an audited count.

## AI drafts

"Describe your form" in the template picker, "Improve with AI" in the builder, and the assistant's
`draft_feedback_form` tool. `POST /settings/form-drafts` takes `{description, language, channel, base_form?,
instruction?}`: a description (at most 2,000 characters) to draft a new form, or an instruction (at most 2,000)
with the form being edited (`base_form`) to change it; `language` is the primary locale and `channel` is
`link`, `embed` or `in_app`. It is for whoever manages forms: **any signed-in editor of the workspace may draft**
(and its admins; a viewer gets `403`), deployment-wide any signed-in user (the owner's decision of
2026-11-18), 20 per person per hour (`429` `rate_limited` with `retry_after` in seconds), and not gated by the
person's way of working (a form is not a gated document type). It answers `202 {job_id, status}`: the draft runs
as an assist job on the settings API's assist worker, which holds the deployment's Bedrock grant. Both draft routes
are the settings API's (`lambda/shared/forms_v2_draft_routes.py`, since the AI review's round 1; before it they were
`/feedback-forms/draft` on the forms Lambda), whose role already owns the job rows and that worker, so the forms
Lambda, which serves the public routes, has no model, worker or jobs-table access at all. With `X-Workspace-Id` the
draft is the workspace's, resolved as the settings API resolves every route: its job row (`WS#{ws}#ASSIST#{sub}`) and
hourly counter (`FORMDRAFT#{sub}#{hour}` in `WS#{ws}#FEEDBACK_FORM`, two days' TTL) are in its partitions and its
model calls count to it. `GET /settings/form-drafts/{job_id}` reads the caller's own job in the same scope (another
person's, or one from another workspace, is a `404`) until `status` is `completed`. When the job ends, the worker
sends the person a `job` notice on their own channel (`/jobs/<sub>`, the same for a draft started in a workspace;
[realtime.md](realtime.md)), with the poll's `job_id`, and the builder reads the job at once; polling is only the
fallback (every 1.5 s without push, every 10 s with it), and the browser gives up after 3 minutes. Its `result` is:

- `{success: true, form: {name, language, languages, welcome, questions, hidden_fields, endings}, notes,
  warnings}`, or
- `{success: false, code: 'invalid_draft', error, errors}`: the answer failed the validator, then failed again
  after one repair with the validator's error (the synchronous API's `422`), or
- `{success: false, code: 'no_model', error}`: no model is available to this deployment.

**Stop.** While a draft is generating, the picker's "Describe your form" and the builder's "Improve with AI" show
**Stop**; it asks "Stop drafting?" first and, confirmed, ends the browser's wait: the poll stops at once and the
answer is dropped, nothing opens (the owner's decision of 2026-11-18). The job is not cancelled on the server (an
assist job has no cancel, shared/assist_jobs.py): it finishes on its own, nobody reads its result, and its row
expires with the other assist jobs.

**It never saves.** The model is the deployment's configured one on the `utility` surface (shared/converse.py:
the same client, model fallback and Bedrock usage metering as every AI feature, counted to the workspace). Its
prompt carries the schema's types, ops and limits and the twelve templates' flows as examples; the person's text
travels in a `form_brief` DATA block and their form in a `current_form` one, never as instructions. Its answer
goes through the same validator as a save, after the server has made the ids and option codes itself (slugged,
accents folded, de-duplicated, `other` / `none` renamed, the rules re-pointed at them) and dropped every address
that is not https (each one a warning: the person adds an address only after checking it).

The assistant's `draft_feedback_form` (the `forms` pack, any caller) proposes a whole version 2 form, shown on an
approval card the person edits (its name, a question left out) before **Approve** creates it disabled
(`POST /feedback-forms`, `enabled: false`); it is card-only, never a plan step. Its arguments are `{form, notes?,
warnings?, channel?}`: the form (`name`, `language`, `languages`, `welcome`, `questions`, `hidden_fields`,
`endings`), the model's notes and warnings (a sentence, or `{message, target?}` naming a question or ending id),
and where it runs (`link`, `embed` or `in_app`).

## Custom Fields

Add custom fields to collect additional information:

```json
{
  "custom_fields": [
    {
      "key": "product_id",
      "label": "Product",
      "type": "select",
      "options": [
        {"value": "product_a", "label": "Product A"},
        {"value": "product_b", "label": "Product B"}
      ]
    },
    {
      "key": "order_number",
      "label": "Order Number",
      "type": "text",
      "placeholder": "ORD-12345"
    }
  ]
}
```

Custom field values are stored in the feedback metadata.

## Public route input limits

The four public routes check their input before reading the table, so a
malformed request costs no DynamoDB read, no queue message and no Bedrock call.

**Form id** (`config`, `submit`, `events`, `iframe`): 1–64 characters from
`[0-9A-Za-z_.-]`, and not exactly `.` or `..`. Anything else is a `404 Form not
found`, the same answer as an unknown id. Every id the service mints matches: a new
deployment form's `fd_` and 32 hex characters, a new workspace form's `ff_` and 32 hex
characters ([Form ids](#form-ids)), the 8-hex-character ids of forms created before
7.06.00, the `pf_…` ids of prototype pin forms, and hand-seeded ids such as
`website-form` or `acme.website`. Only an `ff_` id is looked up in `voc-workspaces`
(its `FORM#{id}` row); every other id is a deployment form's. If you seeded
a form row by hand with any other character in its id (a space, `:`, `@`, `+`,
`%`, `~`, a quote or a non-ASCII letter), rename it before upgrading: its public
routes now answer `404`.

**Submission body** (`POST /submit`), the version 1 widget's (a version 2 response's are in
[Responses](#responses)). Each limit is checked separately, and a `400` names the field and the limit:

| Field | Limit |
|---|---|
| `text` | required, a string, at most 10,000 characters after trimming |
| `name` | optional (`null` allowed), a string of at most 200 characters |
| `email` | optional (`null` allowed), a string of at most 254 characters |
| `page_url` | optional (`null` allowed), a string of at most 4,096 characters |
| `custom_fields` | optional, an object of at most 20 entries; keys 1–64 characters; values a string of at most 1,000 characters, a number, a boolean or `null` |

Before the Lambda, API Gateway checks the body against the `FeedbackFormSubmission` model
(`lib/stacks/api-request-models.ts`, never stricter than the handler): no field is required (a version 2
response has no `text`), `answers` keys are question ids (at most 30), `hidden` keys hidden-field ids (at most
20) with text values, `form_revision` a whole number from 1, `language` one of the nine, `ending_id` at most 44
and `test` at most 64 characters, and `session` the beacon's format. `POST …/events` has its own model,
`FeedbackFormEvent`, strict: exactly `{event: {kind: 'left' | 'opened', question_id?, session, revision?}, test?}`
and nothing else (the handler also requires `question_id` on a `left` and refuses it on an `opened`). The widget
sends its beacons as `text/plain` (`sendBeacon`), which a model keyed by `application/json` does not judge, so the
handler checks the same fields before any read.

The version 1 form configuration has no text-length setting of its own, so these constants
(`MAX_SUBMISSION_TEXT_CHARS` and the others in `feedback_form_handler.py`) are the
only limit. The bundled widget sends `text`, `rating`, `name`, `email` and
`page_url`, all well inside them. Prototype pin submissions also have the tighter
caps in `shared/prototype_pins.py`.

## Access to form management

Without `X-Workspace-Id`, any authenticated user may create, update and delete any of
the deployment's forms and read their submissions. Those routes are deliberately not
admin-gated, because the Feedback Forms page is open to every user, and they have no
per-form ownership check: give app accounts only to people you trust with every
deployment form. They never reach a workspace's form: an update or delete of an id a
workspace's lookup row holds answers 404.

With `X-Workspace-Id` the routes act in that workspace only ([Workspaces](#workspaces-since-70600)):
any member reads its forms, only its editors and admins create, update and delete
them (a viewer gets 403), and anyone else gets the one 404. Since 7.55.00 the results, the responses and the AI
drafts (the settings API's `/settings/form-drafts`, with the same rule) are for its editors and admins too, the test link for its admins (acting as themselves), and the test
responses' delete for its admins and the form's creator; deployment-wide the test link needs the `admins` group, and
that delete the `admins` group or the form's creator. The public routes are
protected by the input validation above, and choose a form's workspace only from its
lookup row.

## Deleting a form

Every delete of a form writes an audit row first (TENETS.md D5; the owner's decision of 2026-11-18), under the
audit-row guard, so no role can change or remove it; when it cannot be written, nothing is deleted:

- a workspace's form: in that workspace's audit partition (`AUDIT#WS#{ws}` in `voc-workspaces`, kind
  `form_deleted`; [Workspaces](#workspaces-since-70600));
- a deployment form: as the deployment's other deletes are recorded (`lambda/shared/delete_audit.py`
  `record_delete_once`): `AUDIT#delete` / `feedback_form#{form_id}` in `voc-aggregates`, kind `feedback_form`, the
  form id, the actor `{sub, kind}` (never an email) and `deleted_at`; one row per form however often a delete that
  failed half-way is retried. The deployment's delete stays idempotent: an unknown id answers success and records
  nothing.

The delete then removes the form's revision snapshots, test responses and funnel rows, and the form. Its real
responses are feedback items of the lake and stay there. A delete of a form's test responses alone is recorded the
same way, in the same partition, with kind `feedback_form_test_responses` and the `count` removed (a deployment
form's through `record_delete_first`: a new row each time, since each delete is its own event; [Test
mode](#test-mode)).

## Form ids

A new form's id is 32 hexadecimal characters (128 random bits, `new_form_id` in
`lambda/api/feedback_form_handler.py`) after a prefix, `fd_` for a deployment form (`ff_`
for a workspace's, below), so nobody can guess the id of a form they were not given.
Forms created before this change keep their 8-character ids, and every route still
serves them; prototype pin forms keep their `pf_` ids. `PUT /feedback-forms/{id}`
updates only a form that exists: an unknown id answers 404 and creates nothing.

## Workspaces (since 7.06.00)

Inside a workspace the web app sends `X-Workspace-Id` ([multi-workspace.md](multi-workspace.md)), so a form
created there is that workspace's, and since 7.14.00 (the ingestion hold lifted,
[multi-workspace.md](multi-workspace.md#per-workspace-configuration)) its submissions are ingested into that
workspace. From 7.06.00 to 7.13.00 creating a form in a workspace and a submission to one answered 409.

- The signed-in routes (`GET`/`POST /feedback-forms`, `PUT`/`DELETE /feedback-forms/{id}`,
  `GET /feedback-forms/{id}/stats` and `/submissions`, and since 7.55.00 `results`, `responses`, `test-link`
  and the AI drafts) act in the workspace that
  `X-Workspace-Id` names. Any member reads; only the workspace's editors and admins
  create, update and delete (a viewer gets 403). A caller who is not a member, an
  unknown workspace and one being deleted all get the same 404. Without the header the
  routes behave exactly as described above.
- A workspace's form is stored in that workspace's own partition, and gets a lookup row
  `FORM#{id}` / `META` in `voc-workspaces` (`workspace_id`, `created_at`) that names its
  workspace: written, conditionally, before the form, and removed with it. In a workspace, a form id
  of another workspace or of the deployment is not found, and an update never creates
  a form. Its id starts `ff_`; without the header, an update or delete of such an id
  that a workspace's form holds answers 404.
- Deleting a workspace's form first writes an audit row in that workspace's audit
  partition (`AUDIT#WS#{ws}`: kind `form_deleted`, the caller's sub, the form id and the
  time). It records the attempt, and when it cannot be written nothing is deleted. No
  role can change or remove it. An id the workspace does not hold answers 404 and
  records nothing.
- The public `config`, `iframe` and `submit` routes look the id up and never read a
  header or a body field to choose the workspace. A form with a lookup row serves its
  workspace's config, and a submission to it is queued with that workspace and its raw
  copy kept under `ws/{ws}/raw/feedback_form/`. A form without a lookup row is a
  deployment form, exactly as before. A lookup row whose workspace is unknown or being
  deleted, a lookup row without its form, and an unknown id all answer the same 404.
- A workspace's form uses its workspace's own categories (its preset routing) and
  `feedback_form` source profile (its PII policy; its raw copy is opt-in through that
  workspace's own profile), since 7.08.00; the deployment's profile opts no workspace in. Participant
  asks and prototype pins stay deployment features: a workspace's form attributes no
  answer to an ask.

## CORS Configuration

The four public endpoints intentionally allow cross-origin requests from any origin so the widget can be embedded on customer-owned sites. `FeedbackFormApi` therefore uses `ALLOWED_ORIGIN=*`; changing the Lambda environment variable alone is not a supported per-form origin policy.

The security boundary is the narrow public route set (`config`, `iframe`, `submit` and `events`), strict response projection, input validation, and the per-route throttles above. All form management, submission reads, and statistics routes require Cognito authentication. If a deployment needs an origin allowlist, implement and test it as an API change that preserves the intended embed sites rather than editing the deployed environment by hand.

## Prototype pin forms (`form_type: prototype_pin`)

Every prototype document the platform builds gets exactly one feedback form of type
`prototype_pin`, linked to `{project_id, document_id}`. It covers both the UI build
and revise buttons and the autonomous agents' `build_prototype` / `revise_prototype`
nodes, because all of them go through the document generator. The form id is derived
from the document id (`pf_` + 16 hex, `shared/prototype_pins.py::pin_form_id`), and
the form is created with a conditional put, so a retried build creates nothing new.
Nothing deletes these forms. They appear on the Feedback forms page with a
"Prototype pins" badge.

**The widget.** The generated HTML carries a self-contained script
(`lambda/shared/static/prototype-pin-widget.js`: no third-party code) that
adds a floating **Feedback** button. A tester clicks it, clicks an element, and writes
a comment. The pin records:

- a stable CSS selector and the element's text (at most 200 characters);
- its bounding box as a percentage of the viewport, plus the viewport size and the
  scroll position;
- the route inside the prototype (path and hash only, because the signed URL's
  credentials live in the query string);
- the user agent;
- the last 20 console errors and unhandled rejections, caught by the widget's own
  listener, each at most 500 characters.

Emails, tokens, key=value secrets and runs of five or more digits are redacted, first
in the widget and again on the server. On the server that includes the tester's
comment itself, before it is stored (injection screening still reads what was typed).

**Where a pin goes.** Two paths, both ending at the **existing public submit route**
of the prototype's own form, under that route's rate limit (20 rps / 40,
shared across every form).

- **Inside the app** (the VoC prototype viewer frames the prototype), the widget hands
  the pin to its host frame with `postMessage`, targeted at the app's origin. The
  viewer accepts it only from its own frame's window (with origin `null`, because of
  the sandbox below, or its own), validates the message and submits it. Answers and
  markers go back on a private `MessageChannel` port the widget hands over with its
  `ready` message, because nothing can address an opaque-origin window by origin.
  A prototype built before 3.09.01 has no port: its pins are still stored, but it
  shows no "saved" notice and no markers in the app until it is regenerated.
- **Escape**: a key pressed inside the frame never reaches the app, so the
  widget forwards an Escape it does not use itself (no pin being picked, no widget
  panel open) as `{source: 'voc-pin-widget', type: 'escape'}`, posted the same way.
  A dialog around the frame (the Prioritization Enlarge overlay, `ModalShell`'s
  `useFrameEscape`) closes on it, accepting it only from a frame inside that dialog,
  with the prototype's origin and that exact payload. `document.open()` erases the
  widget's listeners; a MutationObserver re-attaches them, so a prototype that
  rewrites its page stays closable. A prototype built before 5.35.00 sends nothing until
  it is regenerated; the overlay's Close button always works.
- **Opened standalone** (a prototype URL in its own tab), the widget posts the pin
  directly to `https://<api>/v1/feedback-forms/<its form_id>/submit`. The request
  sends no credentials, no `Authorization` header and no referrer, because the signed
  prototype URL carries its signature in the query string. Because of the sandbox
  below it arrives with `Origin: null`. The preflight is API Gateway's usual mock
  (`Access-Control-Allow-Origin: *`, no credentials), which a credential-less request
  from any origin passes. The POST answer echoes `Access-Control-Allow-Origin: null`
  with `Vary: Origin` (never `Access-Control-Allow-Credentials`) only when the
  request's Origin is exactly `null` AND the form is a `prototype_pin` form
  (`lambda/shared/null_origin_cors.py`). Every other form and route keeps the
  resolver's CORS unchanged: the form Lambda's `ALLOWED_ORIGIN` is `*`, so a
  standard form keeps answering `*`.

**The sandbox.** Prototypes are served from the same origin as the SPA, whose Cognito
tokens live in `localStorage`. Every prototype's CSP therefore also carries
`sandbox allow-scripts allow-popups` and `form-action 'none'` (no `allow-same-origin`,
no `allow-forms`, no `allow-top-navigation`), and the in-app frame carries the same
`sandbox` attribute. The document gets an opaque origin: its script cannot read the
app's storage or cookies, or reach into the app's window, whether it is framed or
opened in its own tab. A prototype that relied on `localStorage`, cookies or a
`<form>` submit loses that.

Prototypes are served from the same CloudFront origin as the SPA, so their CSP is
strict: `default-src 'none'` and no `connect-src` (`lib/utils/prototype-csp.ts`).
The only widening is one `connect-src` source, the FULL submit URL of that
prototype's own pin form. It is never the API origin or anything broader. A
viewer-response CloudFront Function (`PrototypeCspFunction`, `/prototypes/*` only)
adds it when three things hold:

- the S3 object carries `x-amz-meta-pin-submit-url`, which only the document
  generator writes (model-authored HTML cannot set object metadata);
- the URL has the shape `https://<id>.execute-api.<region>.amazonaws.com/<stage>/feedback-forms/pf_<16 hex>/submit`;
- its form id is the one derived from the document id in the request path.

Every other response gets the strict policy: older prototypes, copies (a copy is
written without metadata), and error responses. The response-headers policy keeps
the strict CSP with `override: false` for the case where the function does not run.
Model-authored script in a standalone prototype can therefore reach exactly one
URL, the public route anyone can already call, and only to leave a pin on that
prototype's own form.

The document generator gets the API base from `PIN_SUBMIT_API_BASE`, which the
stack builds from the RestApi id. Without it (local or mock development), the widget
works only inside the app. A prototype opened standalone then shows a notice
saying where to open it. The same notice appears on prototypes built before
standalone pins existed.

**Storage.** A pin goes to the aggregates table (`PINS#{form_id}` / `PIN#{pin_id}`).
The public route's Lambda already had read-write access there, and it is deliberately
not granted the projects table. Pins are never sent to the processing queue (a tester
is not customer voice, and a pin should not cost a model call), and their content is
never logged. The server type-checks and size-caps every field, rejects bodies over
24 KB, and screens the comment for prompt injection. A flagged pin is stored but
kept away from the agents and the models. The element text, selector and route the browser
sent with the pin are judged one by one in the prototype feedback tools (MCP
`documents_list_prototype_feedback`, the assistant's `get_prototype_feedback`) and the incorporation
block (`incorporation_pins_block`), and a field that reads like an instruction is left out there
(`unsafe_anchor_fields`); the pin itself is not flagged for them. The agents' revision path
(`lambda/agents/pins.py`) does not do this yet: it withholds flagged pins but does not screen the anchor fields.

**Review (authenticated, project EDIT).** The routes ride the Cognito-authorized
`/projects/{proxy+}` and the per-project gate:

| Method | Path | Purpose |
|---|---|---|
| GET | `/projects/{id}/prototypes/{document_id}/pins?status=` | List pins (open / addressed / resolved) |
| POST | `/projects/{id}/prototypes/{document_id}/pins/{pin_id}/replies` | Reply in the pin's thread (≤ 50 replies) |
| POST | `/projects/{id}/prototypes/{document_id}/pins/{pin_id}/resolve` | Resolve |
| POST | `/projects/{id}/prototypes/{document_id}/pins/{pin_id}/reopen` | Reopen |
| POST | `/projects/{id}/prototypes/{document_id}/pins/addressed` | `{pin_ids, revision_document_id}`, used by agents |
| POST | `/projects/{id}/prototypes/{document_id}/pins/resolve` | `{pin_ids}`, resolve addressed pins (agents) |

In the project's Documents tab, **Tester pins** opens the list with threads, resolve
and reopen. **Show pins on the prototype** draws numbered markers inside the frame:
at the element when its selector still matches, otherwise at the recorded position.
Opening a prototype URL with `?review=1` turns both on. Only marker positions are sent
into the frame, never comments.

**Agents.** The workflow node `collect_prototype_feedback` reads the open, unflagged
pins as the agent principal. `revise_prototype` adds them, with their console errors,
to its brief as a `<prototype_pins>` DATA block. Once the revision exists, the pins are
marked **addressed** by it. They are **resolved** only after a later passing review of
the prototype: the persona panel agrees, or the final review passes. In the default
"Reviews → Prototype" template, the node sits between *Rework the PR/FAQ* and
*Rebuild the prototype*.

Known limits: duplicating a prototype document copies its HTML, so pins left on the
copy inside the app go to the original's form, and the copy opened standalone shows
the notice (its CSP gets no `connect-src`). No screenshots are captured.
