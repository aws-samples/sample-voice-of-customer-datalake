# Feedback Forms

Feedback Forms collect customer feedback directly, through a form you embed on your website or in your
application. Signed-in users create and manage forms on the **Feedback Forms** page; customers fill them in
without signing in, and each response goes through the same enrichment pipeline as every other source.

## Overview

Since 7.55.00 a form is a flow of questions (schema version 2): a welcome screen, 1 to 30 questions of ten
types, logic that jumps forward to a later question or to one of up to five endings, hidden fields the link
or the app fills in, and texts in any of the app's nine languages. A form:

- embeds on any website, through its iframe page or the script embed, or opens from a link ([Embedding
  Forms](#embedding-forms));
- routes each response to the processing pipeline, its category taken from the answered option that maps one;
- has a test link whose responses never count;
- has per-question results, and an AI that drafts a form from a description.

A form saved before 7.55.00 (schema version 1: a title, an optional rating, one text question) is migrated
when it is read and written back as version 2 on its next save ([Migration from version
1](#migration-from-version-1)). The schema's one definition is `lambda/shared/forms_v2.py`; a response's
checks are `lambda/shared/forms_v2_responses.py`, the results `lambda/shared/forms_v2_results.py`.

## Creating a Feedback Form

1. Open **Feedback Forms** in the sidebar.
2. Click **New form**, then pick a template, start blank, or describe the form and let the AI draft it
   ([AI drafts](#ai-drafts)).
3. Edit the questions, their logic, the endings, the hidden fields and the languages, then save.
4. Publish (enable) the form.

**The list (7.55.01).** Each form is one card, a link to its builder as a whole: its name, its state (Live, Off,
Test link on), its questions and languages, its responses and when the last one came ("Last response: 2 hr. ago",
from the list stats' `last_response_at`, the latest counted response's `source_created_at`, absent when none
carries one), and the first measuring question's figure as a number ("+32" NPS, "84 %" CSAT, "4.2 / 5" average;
from the list stats' `headline`, test responses never counted).
Turning a Live form that has responses Off asks first ("Its link and embeds will show 'Feedback form
unavailable.' to the next respondents"); turning a form on needs no question, only a form without problems. From
seven forms the list gets a search, a state filter and a sort (Newest, Last response, Name, Responses). "How
feedback forms work" can be dismissed (per person, remembered in the browser), and the empty list offers Describe
your form and three templates. Under the last response the card names the ways the form was answered in the last
30 days, as labels ("Link · Website script · Embedded"; nothing when no response said), from the list stats'
`channels` ([Responses](#responses)).

**Where it was answered.** Each response the widget sends says how the widget ran, `channel`: `link` (the API's own
page opened as it is: a link, a QR code, a mobile WebView), `iframe` (that page framed in another, the iframe
snippet) or `script` (a script embed on a customer's own page). It is optional (a widget from before 7.55.01 sends
none) and one of those three, in the API's request model (`schemas/public-body-models.json`) and the handler's
check alike; it is kept with the response (`metadata.form_channel`) and never names the person. The list stats
derive `channels: {link?, iframe?, script?}`, each channel's latest response time, when they are read, in the same
pass as `last_response_at`, so a submit writes nothing besides its response (the form's record is written once,
for `has_responses`, never per submission). Test responses never count: they are not feedback items.

**The builder (7.55.01).** The Questions tab is three panes from xl (the cards, the selected card's editor, the
preview), each scrolling on its own in a full-height page. Question cards sit 8 px apart; between two cards,
hovering or focusing shows an insertion line with a "+" that opens the type menu (on touch, the card's ⋯ › Add
question below), and the type menu and every ⋯ menu open in a portal, never clipped by their pane. The welcome
screen is a card with its On / Off state, a missing translation is one line under the Question field ("English: 2
texts missing · Translate"), and the Routing view stacks each option's Category and Go to when the editor column is
narrower than 40 rem. Flow notes a rule "has no effect" only when everyone it catches would go to the same place
without it (the question's Otherwise target when it has one, else the next question) and no later rule could send
them elsewhere. The floating assistant button steps beside a form's preview instead of covering its Next; on a
phone the builder hides it and its ⋯ menu has **Ask the assistant**, and the save bar sits at the bottom of the
tab only when there is something to save. A form that could not load has a link back to Feedback Forms.

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
| `hidden_fields` | At most 20 `{id, label?}`: `id` matches `^[a-z][a-z0-9_]{0,39}$` and is not `constructor` or `prototype` ([Hidden fields](#hidden-fields)), `label` at most 64 characters |
| `endings` | 1 to 5 `{id, title, description?, button?: {label, url}}`: `id` matches `^end_[a-z0-9_]{1,40}$` |
| `settings.test` | `{link_enabled, record: tag \| drop}` ([Test mode](#test-mode)); the token is issued by its own route |
| `theme` | Colours and radius (see [Theming](#theming)) |
| `category`, `subcategory` | The form's own category routing, used when no answered option maps one |
| `project_id`, `document_id` | Optional. The project (and the PRD or PR/FAQ within it) this form validates; `''` validates nothing. Internal: never served publicly |
| `dimension_defaults`, `tags` | Optional. Dimension values ([dimensions.md](dimensions.md)) and tags every response gets. The defaults **win** over the embed's `dimensions` option |
| `custom_fields` | Kept as before |
| `expected_revision` | Optional on a `PUT`: the `revision` the editor loaded. Another one answers `409` (`code: revision_conflict`, with the current `revision`, `updated_by` and `updated_at`) |
| `removes` | Optional on a `PUT` of an answered form: `{questions?: [ids], options?: {question_id: [codes]}, rows?: {question_id: [codes]}, columns?: {question_id: [codes]}}`, every question, option code and matrix row or column code the save removes on purpose ([The lock of an answered form](#the-lock-of-an-answered-form)) |

A text is an **I18nText**, `{"<locale>": "text"}`: the primary language's text is required, the others fall back
to it, and a blank translation is dropped. Its limits: a headline or title 500 characters, a description,
subheader or consent text 2000, a label or placeholder 200, a button label 80.

The form API answers the form as `item_to_form` projects it: the fields above plus `form_id`, `schema_version`
(2), `revision`, `language_assumed`, `settings.test` as `{link_enabled, record, token_issued, token_issued_at?}`
(never the token), `form_type`, `brand_name`, `created_at`, `updated_at` and `updated_by`, and:

- `has_responses`: a real response was accepted. The submit route marks the form on its first one (from 7.55.00:
  one write per form, never one per submission; a test response never marks it). From then on its question ids,
  their types and ranges, and its option codes are locked, in the builder and on the server
  ([below](#the-lock-of-an-answered-form));
- `retired_ids` (7.58.00): the ids of the questions the form had and removed. No question may take one again (a
  save that does is a `400` `question_id_reused` with its `question_id`), so the builder never gives one to a new
  question, a copy or the NPS helper's follow-ups, and words that refusal with the id;
- `write_count` (7.58.00): how many saves the form row has taken (0 for a row written before). Every `PUT` counts one,
  whatever it changes; a `PUT` with `expected_write_count` is a `409` `revision_conflict` once another save came in
  between ([Revisions](#revisions));
- `migrated_from: 1` while the form is still stored as version 1 ([below](#migration-from-version-1)).

`GET /feedback-forms/{id}` answers `{form}`, one form as the list shows it plus `response_count`: its stored
responses as `GET …/stats` counts them (the caller's category access and source access applied), with `has_responses` true also when
that count is not 0 (a form answered only before 7.55.00). A count that cannot be read is left out, with
`stats_error`. A save validates the whole definition and answers a `400` naming the field and the rule.

### The lock of an answered form

A form's answers are stored under its question ids and option codes, and read on its questions' types and ranges,
so once it `has_responses` none of them may change in place. The builder locks the id and code fields, the type
select ("Answers are stored for this type…", offering only a way back to the stored type) and a rating's points (and
Faces when the stored rating has more than 5), and removes a question or an option only after saying that its answers
stay in Results. The server enforces the same rule (TENETS.md, tenet 4), so a headless client cannot do more than the
builder:

- A `PUT` whose definition drops a question id the stored form has, or drops an option code from a question it keeps
  (a rename is a drop plus an add, and so is a question that stops being a choice), must name each one in
  `removes`. Otherwise it answers `409` `answers_locked` with what it would drop (`questions`, `options:
  {question_id: [codes]}`) and writes nothing. A matrix's row and column codes lock the same way (7.61.00): a dropped
  row is named in `removes.rows`, a dropped column in `removes.columns` (`{question_id: [codes]}` each), else the `409`
  names them as `rows` and `columns`.
- A `PUT` that keeps a question with another type or range (a CSAT or a 5-star rating made an NPS, a rating's points
  changed) is that `409` `answers_locked` too, with `changed: [question ids]`, whatever `removes` names: its old
  answers would be read on the new scale. To ask it another way, remove the question and add a new one.
- A named removal is saved as the builder saves it. The question id is retired for good (a later save that brings it
  back answers `400` `question_id_reused`), and its answers stay in Results under "Removed questions", a removed
  option's under `removed_options`.
- A form without a real response changes freely, and a save that leaves the definition alone (the name, Enable, the
  theme) needs no `removes`. The builder sends `removes` itself, computed from the form it loaded.
- `removes` and the `409` stay although the builder already locks all of this, because they are what holds the line
  for a writer that has no builder: the assistant's `update_feedback_form` (turning a version 1 form's rating off),
  a script on the API.
- The server's lock reads the stored `has_responses`. A form answered only before 7.55.00 has none, so a save that
  changes its definition reads first whether the form has a real response stored (every one, not only those the
  saver may see, and failing closed: a read that fails refuses the save) and marks the form when it has. The
  builder locks such a form at once, because it reads `has_responses` from the response count.

### Questions

Every question is `{id, type, headline, subheader?, required, button_label?, logic?}` plus its type's fields; a
field another type has is refused. `id` matches `^q_[a-z0-9_]{1,40}$`, is unique in the form and is **never
reused**: a save that brings back the id of a removed question is a `400` `question_id_reused`, so old answers never
attach to a new question.

| `type` | Its fields | Its answer |
|---|---|---|
| `open_text` | `long`, `input_type` (`text`, `email`, `number`, `phone`, `url`; always `text` when `long`, the box the widget draws), `placeholder?`, `max_chars?` (1–5000) | a string |
| `single_select` | `options`, `other`, `shuffle`, `display` | `{code}` or `{other: "…"}` |
| `multi_select` | the same, plus `none` and `min?` / `max?` | `{codes: [...], other?: "…"}` |
| `rating` | `scale` (`star`, `number`, `smiley`), `range` (3, 4, 5, 7 or 10), `lower_label?`, `upper_label?` | a whole number from 1 to `range` |
| `nps` | `lower_label?`, `upper_label?` | 0–10 |
| `csat` | the same | 1–5 |
| `ces` | the same | 1–7 |
| `statement` | `cta?: {label, url?}` | none (it is never required) |
| `consent` | `label` | `true` (an unticked box is no answer; a required consent must be ticked) |
| `contact_info` | `fields: {name, email, phone, company}: {show, required}` (at least one shown) | `{name?, email?, phone?, company?}` |
| `matrix` (7.61.00) | `rows`, `columns`, `shuffle_rows`, `display`, `min_rows?` ([below](#matrix)) | `{rows: {<row code>: <column code>}}` |

A choice question's `options` are 1 to 50 `{code, label, category?}`: `code` matches `^[a-z0-9_]{1,40}$`, and
`category` is `{category, subcategory?}`, the routing the option files a response under (never served
publicly). `other` is `{enabled, label?, placeholder?}`, `none` is `{enabled, label?}` (multi only, exclusive),
`shuffle` is `none`, `all` or `except_last`, and `display` is `auto` (a list for 6 options or fewer, a dropdown
above), `list`, `dropdown` or `chips`. The codes **`other` and `none` are reserved** while the question enables
them: they name the Other and None rows, and a None answer is `{codes: ["none"]}`.

Every address (a statement's button, an ending's button) must be `https://` with a host, no user name or
password and no spaces or control characters. A whole definition is at most 300 KB.

#### Matrix

Several rows rated on one scale (each workshop phase: Needs improvement, Satisfactory, Very effective, Exceptional),
one choice per row:

- `rows`: 1 to 20 `{code, label}` (what is rated), `columns`: 2 to 10 `{code, label, score?}` (the scale). A code
  matches `^[a-z0-9_]{1,40}$`, is unique among the rows (or the columns), and is never `__proto__`, `constructor` or
  `prototype` (an answer is an object keyed by row code). `score` is an optional whole number from -100 to 100: Results
  average it per row over the answers whose column has one.
- `shuffle_rows` (`false` by default): the rows in a random order per respondent (the preview's seeded order).
- `display`: `auto` (a grid where the form is at least 600 px wide and has at most 7 columns, else stacked rows),
  `grid` or `stacked`. The widget draws each row as its own radio group (labelled by the row, the arrow keys move
  within it), with the row and the column in each radio's name; stacked on a phone.
- `required` asks for every row. An optional matrix may set `min_rows` (1 to the number of rows): once any row is
  answered, at least that many are (`400` when a required matrix sets it). An answer naming a row or a column the
  question does not have is refused (`answer_invalid`); a required matrix with a row left out is `answer_required`,
  too few rows `selection_count`, each with its `question_id`.
- Logic: `submitted` and `skipped`. A matrix is never recalled ([Recall](#recall)).
- The item's text, for a response without free text: one line per answered row, `Headline — Row: Column`.

### Logic

A rule is `{when: {op, value?}, then: {jump_to}}`. A question's first matching rule wins; with no match the form
goes on to the next question, and after the last one it reaches the first ending. `jump_to` names a **later**
question or an ending, so no logic can loop, and it must exist.

| Type | Ops (`value`) |
|---|---|
| `open_text` | `equals`, `not_equals` (a text, compared ignoring case: both sides lower-cased as JavaScript's `toLowerCase` does, so the widget and the server take the same path; `ß` is not `ss`), `submitted`, `skipped` |
| `single_select` | `equals`, `not_equals` (a code), `includes_any` (codes), `submitted`, `skipped` |
| `multi_select` | `includes_any`, `includes_all` (codes), `submitted`, `skipped` |
| `rating`, `nps`, `csat`, `ces` | `equals`, `not_equals`, `lt`, `lte`, `gt`, `gte` (a number in the range), `submitted`, `skipped` |
| `consent`, `contact_info`, `matrix` | `submitted`, `skipped` |
| `statement` | `submitted` (always true once shown: an unconditional jump) |

At most 20 rules per question. "Otherwise go to" is written as trailing `submitted` and `skipped` rules.

### Hidden fields

Values the link (`hf_<id>=<value>`) or the app (`hidden: {…}`) passes with each response; respondents never
see them. Only declared ids are accepted, each a text of at most 200 characters. A value is stored with the
response as `metadata.form_hidden.<id>`, is a Results filter and a Responses column, and fills a configured
dimension ([dimensions.md](dimensions.md)) when the id is that dimension's key and the value is one of its
values (after the form's `dimension_defaults` and the embed's `dimensions`, which win). Pass ids, not personal
data.

No hidden field is `__proto__`, `constructor` or `prototype` (7.58.00): the widget never fills those names, so the
builder and the API refuse them ("‹id› is a reserved name; choose another", a 400). A form saved earlier with one
still opens and is served as it is; the next save that changes its definition asks for another name.

### Recall

A text can show a hidden field's value, or an earlier answer, where it stands (7.61.00): **`{{id}}`**, or
**`{{id|fallback}}`** to show `fallback` when there is no value ("How was {{event|the event}}?"). A placeholder is
`{{` and `}}` around a text with no brace in it; the text before its first `|` is the id, the rest the fallback (both
trimmed). One grammar, three implementations pinned by `schemas/form-recall-cases.json`:
`lambda/shared/forms_recall.py` (the server's checks), `frontend/src/pages/FeedbackForms/model/recall.ts` (the builder)
and the widget.

- **Where.** The welcome's title and description, every question's headline and subheader (a statement's included),
  and every ending's title and description. Never an option, row or column label, a button, a placeholder, an end
  label or an address: there a placeholder is shown as it is written (so a live form cannot hold one, below).
- **What.** `id` names a declared hidden field (looked up first), or a question placed **before** the text whose
  answer is a score (a `rating`, `nps`, `csat` or `ces`: its number) or a `single_select` (the chosen option's label in
  the respondent's language; an "Other" text is never shown). Never an open text, a contact, a multiple choice, a
  consent or a matrix: what a respondent typed is never echoed. The welcome has no question before it; an ending has
  them all. An answer counts only when its question is on the respondent's path.
- **A missing value** (no hidden value from the link, a question skipped or not shown) renders the fallback, or
  nothing: the widget then tidies the text around the gap (no doubled space, no space or comma left before `?`, `!`,
  `.`, no empty brackets, no separator at either end), so "How was {{event}}?" reads "How was?" and "Thanks,
  {{name}}!" reads "Thanks!".
- **Safe.** Values go in as text, never as markup, and an id is looked up only among the form's own fields (`{{constructor}}`
  is an unknown id: nothing). `__proto__`, `constructor` and `prototype` stay reserved for hidden fields.
- **A save refuses** (`400`, with `where`, `placeholder` and `id`) a recall text whose placeholder names no hidden
  field and no question (`recall_unknown`), a question at or after the text (`recall_not_before`), or a question whose
  answer is never recalled (`recall_type`). A form saved before 7.61.00 whose text happens to hold `{{…}}` still reads
  and is served (the widget shows an unknown placeholder as nothing); its next save that changes its definition asks
  for a fix, the 7.58.00 reserved-name precedent.
- **Publishing.** A write that leaves a form live (a `PUT` or `POST` with `enabled: true`, or any save of a live form)
  answers **`409` `unresolved_placeholder`** `{texts: [{where, placeholder}]}` (at most 20) when any text respondents
  can be shown holds a `{{…}}` they would see as written: one recall cannot fill there, or any placeholder where recall
  never works. Turning a form Off always works. So a live form saved before 7.61.00 with such a text keeps serving
  but cannot be re-enabled, or saved live, until it is fixed. The builder's Problems list shows the same texts and
  Publish waits for them.
- **Results and exports** show a text with placeholders as `[id]` (a CSV header, a question's headline in Results,
  the item's text for the processor), never a respondent's value.
- **The builder** offers "Insert a value" in each recall text (the hidden fields, then the earlier questions it may
  recall) and previews the text with and without the value.

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
(`form_revision`), so a respondent who opened the form before an edit is checked against what they saw, and Results
score it against that revision's question; a revision the form has not reached, or one with no snapshot, answers
`409` (`code: form_changed`): the widget asks the respondent to reload. A save is conditional on the revision and the
save count (`write_count`) it read, so two saves never overwrite each other silently. A save may also send the ones
its editor loaded (`expected_revision`, `expected_write_count`; the builder sends both): another one is a `409`
`revision_conflict` with the stored `revision`, `write_count`, `updated_by` and `updated_at`, so an editor opened
before the form was turned Off (or renamed, or restyled) cannot turn it back on with a stale copy.

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

A form reaches respondents three ways, each ready to copy on the builder's **Share** tab (Live | Test swaps the
live link for the [test link](#test-mode) in every one of them):

- **the link**: the form's own page on the API, `…/feedback-forms/{form_id}/iframe`, for an email, a QR code or a
  mobile app's WebView;
- **the iframe**: that page framed in yours, the form fully apart from your page's CSS and script
  ([The iframe](#the-iframe));
- **the script embed**: the widget drawn in your page, from a static file this app serves
  ([The script embed](#the-script-embed)).

Hidden fields › **Use them** gives the same snippets with a placeholder for each hidden field.

### The iframe

```html
<iframe
  id="voc-form-{form_id}"
  src="https://your-api.execute-api.region.amazonaws.com/v1/feedback-forms/{form_id}/iframe"
  style="width: 100%; height: 480px; border: none;"
  title="{form name}"
></iframe>
<script>
  (function (frame) {
    window.addEventListener('message', function (event) {
      var data = event.data;
      if (event.source !== frame.contentWindow || event.origin !== 'https://your-api.execute-api.region.amazonaws.com') return;
      if (data && data.type === 'voc-form-height' && data.height > 0) {
        frame.style.height = Math.max(320, Math.ceil(data.height)) + 'px';
      }
    });
  })(document.getElementById('voc-form-{form_id}'));
</script>
```

**The resizer (7.55.01).** On its own page, when framed, the widget posts `{type: 'voc-form-height', height}` to
the parent page whenever its height changes (a `ResizeObserver` on the form, at most once per animation frame;
never in the editor's preview, never from a script embed). The target origin is `'*'`: the parent is your page,
whatever its origin, and the message carries the height and nothing else. The script after the frame takes a
message only from that frame's own window (`event.source`) and the API's origin (`event.origin`), and sets the
frame's height to it, at least 320 px so a short screen never collapses the frame. Without the script (a site
builder that strips scripts) the frame stays 480 px tall and the form scrolls inside it, as before 7.55.01. For a
form that fills its own page, `height: 100dvh` without the script works as well. The Share tab builds the snippet
with the form's id, its name as the frame's `title`, and the API's origin filled in (`tabs/snippets.ts`,
`iframeSnippet`).

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

### The script embed

```html
<div id="voc-feedback-form"></div>
<script src="https://{app domain}/widget/feedback-widget.js"></script>
<script>
  VoCFeedbackForm.init({
    container: '#voc-feedback-form',
    apiEndpoint: 'https://your-api.execute-api.region.amazonaws.com/v1',
    formId: '{form_id}',
    // language: 'en', // optional: one language for every visitor (else their browser's)
    hidden: { user_id: '{USER_ID}' },
    test: '{test token}',
  });
</script>
```

The Share tab gives the three parts whole for each form: the element the form renders into, the widget file from
this app's own address, and the `init` call with a placeholder per hidden field (`hidden`, only when the form has
hidden fields: replace each `'{…}'` with your value; pasted as it is, the form still renders), in Test mode only the
test token, and the form's primary language as a comment (since 7.58.00): without `language` the widget shows each
visitor the language of their browser when the form offers it, else the primary, so pinning one is your choice. The
**In-app SDK** snippet (Hidden fields › Use them) is the same file loaded once in your app's page, then the same
`init` call when the person takes the action the form asks about. Values the snippets carry are written as
JavaScript strings that cannot end their `<script>` (`tabs/snippets.ts`).

**Where the file comes from (7.55.01).** `/widget/feedback-widget.js` is a static file of the app, served by the
app's own CloudFront distribution, not an API route (the REST API is at its resource ceiling, and a public script
gains nothing from a Lambda call):

- **Built.** `frontend/widgetAssetPlugin.ts`, a Vite plugin, writes the one source,
  `lambda/api/static/feedback-widget.js`, into `frontend/dist/widget/feedback-widget.js`, after a first line that
  names the release: `/*! VoC feedback widget <version> (<commit>), served at /widget/feedback-widget.js. … */`.
  No copy is kept by hand. The dev server answers the same address with the file as it is on disk, read on each
  request (a new Vite plugin needs a dev server restart once).
- **Deployed** with the frontend, by either path: CDK's `BucketDeployment` of `frontend/dist`, or
  `npm run deploy:frontend` (`frontend/scripts/deploy.sh`, whose pass for everything outside `assets/` uploads it).
  The synth-time freshness check (`lib/utils/assert-frontend-build.ts`) counts the widget source as a frontend
  input, so a widget edit without a frontend rebuild fails `cdk synth` as a stale build instead of shipping a file a
  release behind.
- **Served** by the `/widget/*` behavior of the SPA distribution (`lib/stacks/core-cdn.ts`): the SPA bucket, read
  through the default behavior's own origin, GET and HEAD only, HTTPS, with its own response headers policy:

| Header | Value | Why |
|---|---|---|
| `Access-Control-Allow-Origin` | `*`, for GET and HEAD; credentials never allowed | `<script crossorigin>`, and an `integrity` you add, work from any site |
| `Cross-Origin-Resource-Policy` | `cross-origin` | a page with `Cross-Origin-Embedder-Policy: require-corp` can load it |
| `Cache-Control` | `public, max-age=300` | below; set at the edge, whatever metadata the deploy path wrote on the object |
| `X-Content-Type-Options` | `nosniff` | |
| `Strict-Transport-Security`, `Referrer-Policy`, `X-Frame-Options`, `Content-Security-Policy`, `Permissions-Policy` | the SPA's own, unchanged | [A missing or mistyped address](#a-missing-or-mistyped-address) |

The app's own pages keep their policy exactly as it was: no CORS, the same CSP.

**Caching and versions.** The address is stable and carries no version on purpose. A customer pastes it once and
it must keep working after every deploy, and both deploy paths remove a file the new build does not have
(`BucketDeployment` prunes, `deploy.sh --delete`s), so a versioned or hashed file name would disappear with the
next release and break every page that pasted it. Instead the file is replaced in place on each deploy, each
deploy invalidates the distribution, and browsers revalidate their copy after 5 minutes (by ETag, so an unchanged
file costs a `304`): within 5 minutes of a deploy every page runs the new widget. Which release a page has is the
file's first line. A `?v=` on the address would change nothing, because the cache key ignores query strings: every
`?v=` gets the current file.

**Subresource Integrity (SRI).** The app puts no `integrity` on its own scripts (Vite emits none), and the snippet
has none either: a fixed hash cannot go with a file that changes with each release, so a pinned hash would make
browsers refuse the widget after the next deploy and the form would vanish from the page. A site whose policy
requires SRI can host its own copy (download the file, serve it from its own origin with `integrity`, and update it
on purpose, keeping `apiEndpoint` as it is), or add `integrity="sha384-…" crossorigin="anonymous"` for the current
file, accepting that the form stops loading at the next release until the hash is updated (the open CORS above is
what makes `crossorigin` work).

**A Content-Security-Policy on your page.** The widget needs:

- `script-src <app origin>` for the file, and for the inline `init` call `'unsafe-inline'`, a nonce or a hash
  (or move the call into a script file of your own);
- `connect-src <api origin>`: it fetches the form's config and posts the response and the two funnel beacons
  (`navigator.sendBeacon`, else `fetch`);
- nothing for styles where the browser has constructed stylesheets: the widget adopts one in its shadow root,
  which a CSP does not block, and sets its inline styles through the CSSOM, which a CSP does not block either.
  Only a browser without them falls back to a `<style>` element, which needs `style-src 'unsafe-inline'`.

Under the script embed the Share tab says the first two, with this app's and the API's origins filled in.

#### A missing or mistyped address

CloudFront's custom error responses apply to the whole distribution (they cannot be scoped to a behavior), and the
SPA maps `404` to `index.html` for its deep links. So a key that does not exist under `/widget/` answers `200` with
the app's `index.html`. That never runs as script: it is `text/html` sent with `nosniff`, so the browser refuses it
("Refused to execute script … because its MIME type ('text/html') is not executable"), the `<script>` fails, and
the `init` after it throws `VoCFeedbackForm is not defined`. The page itself keeps every protection it has at any
other address (the SPA's CSP, `frame-ancestors 'none'`, `X-Frame-Options: DENY`), which is why the widget's policy
repeats the SPA's security headers. The one address the snippet names is always in the build.

#### Who can fetch what

`/widget/*` is public by design, like the login page: anyone, signed in or not, from any site, can fetch the
widget file anonymously, and no key group or sign-in goes on it (a gate would lock out the respondents it exists
for). What it serves is build output from the SPA bucket, the same bucket the public login page is read from; it
holds no customer data and grants nothing on the API, whose form routes keep their own checks (the four public
routes and their [rate limits](#rate-limits-on-the-four-public-routes); everything else needs Cognito). The
raw-data paths on the same distribution (`/avatars/*`, `/prototypes/*`) still need a signed URL, and
`lib/stacks/core-stack.test.ts` fails if another unsigned path appears or if a public path reads anything but the
SPA bucket (`lib/stacks/core-cdn-widget.test.ts` pins the headers).

### Isolation from the host page

Since 7.55.01 the widget draws the form in an open shadow root of its container (`container.shadowRoot`), so the
page's CSS and ids never reach it: a site's `h2 { color: #fff }`, a forms reset (Tailwind forms, Bootstrap) or
`button { text-transform: uppercase }` leaves the form as its theme draws it, and the iframe page, a script embed,
the editor's preview and the preview window draw the same form.

- Inside the shadow root are the widget's own reset (`:host { all: initial; display: block }` and the rest, an
  adopted constructed stylesheet where the browser has them, else a `<style>`) and one inner root, `.voc-root`,
  holding the strip, the progress bar, the live region and the screen; every id, `aria-describedby` and `<label
  for>` resolves there.
- Every colour and inherited text property is also set inline, so a browser without Shadow DOM, a container that
  cannot host a shadow root (a `<form>`, a `<td>`: the form is then drawn in the container's light DOM), or a page
  whose CSP blocks the stylesheet still gets the theme's form.
- Checkboxes and radios are drawn by the widget (a 20 px box in the option-edge colour, the primary fill and an
  on-primary tick when checked); the real inputs stay, visually hidden, for the keyboard and screen readers.
- Keys are handled inside the form only. The widget leaves the container's styles and classes alone (it sets only
  its `lang`), and a page rule for the container beats the widget's `:host` defaults. On the iframe page the page
  keeps no reset of its own, only `html, body { margin: 0 }` and the container's `min-height: 100vh`; there the
  widget gives `<html>` the theme's background and `color-scheme`.
- The class names inside stay (`.voc-nav-bar`, `.voc-next`, `fieldset.voc-question`, `.voc-ending-title`, …): reach
  them through `container.shadowRoot` (Playwright locators pierce open shadow roots); `document.querySelector`
  does not.
- On a phone the Back / Next bar (`.voc-nav-bar`) is sticky at the bottom of the screen, so Next is in view on a
  long question.

With the font **Same as your page** (`theme.font: 'inherit'`) a script embed takes your page's font from its
container; on the iframe page and in the preview that font is the system one.

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
| `goTo(target)` | shows a question (its id), the welcome screen (`'welcome'`) or an ending (`'end:<ending id>'`) (preview) |
| `restart()` | starts again (preview) |
| `setScheme('light' \| 'dark' \| null)` | shows the light or the dark palette whatever the device says; `null`: the device's (preview) |
| `destroy()` | removes the widget and its listeners |

A hidden value comes from the link, then `hidden`, then `setHiddenFields`.

**The editor's preview.** `init({container, language, preview: {config, seed?, scheme?}})` renders the given
draft and never fetches, submits or counts anything. `seed` keeps Shuffle's order for the whole preview session
(Restart included); `scheme` forces the light or the dark palette. Its handle drives it, and so do `postMessage`s
from the page's own origin (`e.origin === window.location.origin`, from its parent frame): `{type:
'voc-form-preview', action: 'config', config}`, `{…, action: 'goTo', questionId}` (or `target`), `{…, action:
'restart'}`, `{…, action: 'language', language}` and `{…, action: 'scheme', scheme}`.

**In the builder (7.55.01).** The Questions tab shows the draft in the real widget as a phone: 390 px wide, scaled
to the pane and as tall as the window leaves (at least 320 px in the full-height builder, 480 elsewhere), with its
size and zoom shown ("Phone · 390 × 610 · 90 %"). It follows the selected question, the welcome screen (while it is
on) or an ending, updates within 150 ms of typing (on the next frame for a colour or a slider) and never submits.
Options set to Shuffle keep one order for the session ("Shuffled for each respondent"). **Style** opens the form's
theme beside the preview ([Theming](#theming)); while you edit the dark palette the preview shows it ("Showing:
Dark"). On a phone, Preview opens the preview window in a new tab. The old full-screen page
`/feedback-forms/{id}/preview` now opens the builder.

**Room for the editor.** From lg, **Hide preview** in the preview's toolbar gives the editor its width, and **Show
preview** over the editor brings it back; the choice is remembered in this browser (`localStorage`). While the
preview window is open the in-pane preview collapses on its own ("The preview is open in its window.") and comes
back when the window closes: the window says `alive` every 1.5 s and `closed` when it goes, and 5 s of silence (a
window killed with its tab) counts as closed. Show preview brings the in-pane one back beside the open window too,
until the next window opens.

### The preview window

The builder's **Open in window** opens `frontend/form-preview.html`, the build's second HTML page: the same widget
file in preview mode, a small toolbar of its own (size presets Phone 390 × 844, Rotate, Tablet 768 × 1024, Desktop
1280 × 800 and "Embedded, 480 px tall"; Restart; Language) and no app CSS, so the window is a real viewport (the
widget's width rules, the pointer and the sticky Next bar behave as on the device). The builder sends the draft as
it changes over `BroadcastChannel('voc-form-preview:<session>')`, same-origin by construction, with
`{type: 'voc-form-preview', action: 'ready' | 'config' | 'goTo' | 'restart' | 'language' | 'scheme', …}`:

- the builder opens `/form-preview.html#s=<session>&ui=<language>&p=<preset>` in the click itself (a window named
  `voc-form-preview`, `popup=yes` at the preset's size; a blocked pop-up is said in words);
- the window says `ready` every 1.5 s until a draft arrives; the builder answers with `config` (the draft, the
  preview's shuffle seed, the form's name and languages), then `language`, `scheme` and `goTo`;
- after that the builder posts `config` on each change (the same 150 ms, the next frame for a theme-only change),
  and `goTo`, `restart`, `language` and `scheme` as they happen;
- the session is kept per form in `sessionStorage`, so a builder reload talks to the window it opened, and a new
  form's first save keeps it;
- the window's words come from the app's own catalogs (`/locales/<language>/feedbackForms.json`, `previewWindow.*`),
  English where one is missing;
- from the forms list, ⋯ › Preview opens the window on the saved form (read when the window says `ready`).

It never submits, holds no data of its own and renders through the widget's `textContent`. A pop-up is a top-level
window, so CloudFront's `frame-ancestors 'none'` does not apply to it and `script-src 'self'` allows its bundled
script (the built page has no inline script): it needs no CloudFront or CSP change.

**The `dimensions` embed option.** `VoCFeedbackForm.init({..., dimensions: {user_type:
'partner'}})` sends up to 10 string/number values with each submission. The embed runs on
a page anyone can edit, so it may only fill keys the form has **no** `dimension_defaults`
for: a key the form sets keeps the form's value. Unknown keys and disallowed values are
dropped by the processor. It is separate from hidden fields.

The submitter's `email` is stored lower-cased, so an erasure by email matches however it
was typed.

The API serves no widget file: the script embed loads it from the app's own address,
`https://{app domain}/widget/feedback-widget.js` ([The script embed](#the-script-embed)). A
`<script src=".../feedback-forms/{id}/widget.js">` on the API gets an API Gateway error instead of the widget:
since 7.55.00 a signed-in proxy serves the form's other signed-in routes under `/feedback-forms/{id}/`, so an
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

### Mode, dark palette, font and size (7.55.01)

All optional, with defaults, so a theme saved before 7.55.01 reads as it always did:

```json
{
  "theme": {
    "primary_color": "#8e48ff",
    "background_color": "#ffffff",
    "text_color": "#19161d",
    "border_radius": "8px",
    "mode": "auto",
    "dark": { "primary_color": "#bd8fff", "background_color": "#19161d", "text_color": "#f2f1f4" },
    "font": "system",
    "text_size": "default"
  }
}
```

- The three top-level colours are the **light** palette (`#rgb` or `#rrggbb`; `#rrggbbaa` is still read from
  older forms), `dark` the **dark** one (VoC dark by default). `mode` picks the one shown: `light` (the default),
  `dark`, or `auto`, the respondent's `prefers-color-scheme`, followed live. The widget sets `color-scheme` to match,
  so native selects and scrollbars follow.
- `border_radius`: `0px` to `99px`, as the API stores it and the widget draws it (before 7.58.00 the widget drew
  only 0 to 39 px); `0px` to `24px` in the editor (presets 0, 4, 8 and 16, and a slider).
- `font`: system stacks only, never a web font: `system`, `inherit` ("Same as your page", for the script embed;
  the system font on the iframe page and in the preview), `serif`, `rounded`, `mono`.
- `text_size`: `default` or `large` (18 px body text).
- Presets in the editor: VoC light, VoC dark, High contrast (both palettes, mode `auto`), and **Your brand**, a
  workspace theme an admin saves; a new form starts on the brand when there is one, else VoC light.

A theme stored before 7.55.01 is answered with the defaults filled in (`form_theme.with_defaults`: the GET of a form
and the public config) and written back whole on its next save.

**Where it is edited.** The same editor (`pages/FeedbackForms/theme/ThemeEditor.tsx`) opens two ways: **Style** in
the Questions tab's preview toolbar (from xl it takes the editor column while the preview stays; below xl a side
sheet with the phone preview at its top), and **Settings › Appearance**, the second card, with its own preview. It
offers the presets; Mode (Light | Dark | Auto, and in Auto which palette you are editing); the three colours, each a
swatch and a hex field that says why it refuses a value ("Use a hex colour like #8e48ff."); the derived option
edge; Corners (0, 4, 8, 16 px and a 0–24 px slider); Font; Size (Default | Large); and the live contrast table
below.

**Your brand.** A workspace's admins save the current style as its form brand ("Save as brand…"; for anyone else the
button is off and says why). It is stored as `form_theme` on the workspace's `/settings/brand` row (outside a
workspace, the deployment's): `GET /settings/brand` answers it (`null` when none), and a `PUT` whose body holds only
`form_theme` sets just that (`null` removes it), while a brand `PUT` without it keeps it. The forms picker's
templates, Blank, Describe your form and the assistant's form drafts start on it.

### Contrast checks

One set of rules, the same in the editor, on the server (`lambda/shared/form_theme.py`) and in the widget, for every
palette that can be shown (light for `light`, dark for `dark`, both for `auto`). An old form's `#rrggbbaa` colour is
judged as the widget draws it, opaque with its alpha dropped (since 7.58.00; the editor and the server composited it
before, so they could refuse a colour the widget showed readable, or pass one it did not); one vector,
`#19161d80` on `#ffffff00` at 17.89:1, is pinned in the three suites:

| Pair | Minimum | Below it |
|---|---|---|
| Text on background | 4.5:1 | under 3:1 an error that blocks Publish and a live form's colour change (Save still works); on a live form kept on the theme it already has, a warning; 3 to 4.5:1 a warning |
| Primary on background (focus ring, progress, selected edge, checked box) | 3:1 | a warning; the widget draws the ring and selected edges in the text colour instead |
| Button label on primary (white or `#19161d`, whichever contrasts more) | 4.5:1 | a warning |
| Option edge (the text colour at 55 % over the background) | 3:1 | derived: the widget raises the alpha until it holds |

The widget's last line of defence: text under 3:1 on its background is drawn in the readable one of white and
`#19161d` instead. The editor's one-click suggestions move a colour in OKLCH lightness only (hue and chroma kept),
to the nearest darker and the nearest lighter value that pass ("Use #6f7681 (4.6:1)"). The editor's table shows each
pair with an icon, its ratio and "AA" or "Below AA" in words, never colour alone; the problems chip lists the same
pairs, and an unreadable text keeps Publish, and Update live form after a colour change, off with the reason ("Fix 1
problem to publish. Saving still works."). A live form kept on the unreadable theme it already has (one saved
before 7.55.01) is only warned about: its Style panel shows the text pair as a warning ("This form's text is hard to
read (2.5:1, under 3:1). Fix its colours; until then, your other changes still go live."), the header's save status
says "This form's text is hard to read. Fix its colours", and Update live form goes through.

**On the server** the rule lives in the shared forms module: `shared/forms_v2.py` `validate_publishable(theme,
live=…, was_live=…, theme_changed=…)`, built on `shared/form_theme.py`'s contrast helpers. The handler applies it to
a create whose `enabled` is true and to an update that leaves the form live (its `enabled`, else the stored one; its
`theme`, else the stored one). With text under 3:1 in a palette respondents can be shown:

- **refused**, `400 theme_unreadable`: a write that turns a form live (a new form, a draft or an Off form
  published), and a write to a live form that changes its theme (`same_theme`: the two themes read with their
  defaults differ), so a colour change never leaves a live form unreadable and an API caller cannot publish an
  illegible form either;
- **saved, with a warning**: any other write to a live form whose stored theme is already under 3:1 (a question
  edit, Update live form with the theme as it is). The answer is `{success: true, form, warnings:
  ['theme_unreadable']}`; the widget's `safeContrast` keeps what its respondents see readable meanwhile.

```json
{"success": false, "code": "theme_unreadable", "minimum": 3.0, "palettes": [{"palette": "light", "ratio": 2.54}],
 "error": "The text on the light background is 2.5:1, under 3:1: respondents could not read it. …"}
```

A save that leaves the form Off, or turns it off, always works, without a warning, so nothing is lost.

**Publishing with a language half translated.** Publish and Update live form ask first when a language the form
offers is incomplete ("English respondents will see 5 texts in Polski."), with Publish anyway and a Translate
button per language.

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
| GET | `/feedback-forms/{id}/responses` | The responses, paged, or as CSV (`format=csv`, `layout=familiar\|detailed`, `ids=true`; [below](#results-and-responses)) |
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
  `headline: answer` lines (choices by their primary-language labels, scores as `n/max`, a matrix one `headline —
  row: column` line per answered row); contact details never. A headline's recall placeholders read `[id]`, never the
  respondent's value (since 7.61.00).
- The processor's ingest schema takes a matrix answer (`{rows: {row: column}}`) in `form_answers` since 7.61.00.
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
`ending_id`, `session` ([The funnel](#the-funnel)), `channel` (`link`, `iframe` or `script`: how the widget ran,
[The list](#creating-a-feedback-form)), `test`, `form_id`, `page_url`, `dimensions`, `participant_token` and
`custom_fields`; any other key
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
  token leaves the server only here; the form API shows `token_issued` instead. The builder's **Make the test
  link** and **Reset test link** send the saved form's `link_enabled` and `record` back as they are, so the saved
  link turns on, off or records otherwise only on Save; Make the test link never rotates (a form that has a token
  keeps it, so a link in use never stops working) and is not offered while the token is still being read. A make,
  a reset or a delete of the test responses that fails says so, its dialog left open.
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
  delete of nothing records nothing, and each delete is its own row. Deleting the form itself takes its test responses
  with it, counted on the form's own row (`test_responses_deleted`, [Deleting a form](#deleting-a-form)). Real
  responses are feedback items of the lake and are never deleted there.
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
(its `source_channel` in its brand's partition) and, with `include_test`, its test responses. In a workspace its
editors and admins may read them (a viewer gets `403`); deployment-wide, whoever manages forms. Each caller sees only
what both of their scopes admit, as on every feedback read route: **category access** (an item's `category`) AND
**source access** (its `source_platform`, `feedback_form`: no `sources` grant means every source that is not
`restricted`; `shared/category_access.py` `admits_item`), against the workspace's categories and source profiles in
a workspace. A test response has neither of its own, so it is judged as the form files its responses: source
`feedback_form` under the form's own category (`other` when it routes to none). So where `feedback_form` is
restricted, a caller without a grant for it gets empty Results, Responses and CSV (no answers, no contact details, no
test responses), never a 403, as the stats route counts nothing for them; an admin, or a caller granted the source,
sees them. A failed read of either scope is a 500, never everything. Both take `from` and `to` (ISO dates or times),
`language`, `ending` and `hidden.<id>=<value>`.

**Results** (`include_test=false` by default): `{responses, test_responses, last_response_at, questions,
endings: {id: n}, hidden: {id: n}, removed_questions: [{id, answered}], funnel, link_health}`. `test_responses` counts the test
responses the view admits (its filters and the caller's access) whether or not they are included (since 7.58.00;
before, 0 whenever they were left out), so the page can say "3 test responses are hidden"; `responses` adds them only
with `include_test=true`. Each question of the current revision has `shown` (the responses whose path showed it),
`answered`, `skipped`, `not_shown` (the logic jumped past it), `drop_off_rate` (skipped / shown) and, when there are
any, `earlier_version` (answers to a revision where the question had another type or range, counted nowhere else),
and by type:

| Type | Adds |
|---|---|
| choices | `options: {code: n}`, `other` with `other_latest`, `none`, `removed_options` (codes the revision no longer has) |
| `rating`, `nps`, `csat`, `ces` | `histogram`, `average`, `scale_max`; `nps: {score, promoters, passives, detractors}` (promoters 9–10 minus detractors 0–6, in points), `csat: {score, satisfied}` (the share of 4–5), `ces: {score, easy}` (the share of 5–7) |
| `open_text` | `count` and `latest`: the ten newest `{value, response_id, created_at, is_test, sentiment?}` |
| `consent` | `accepted` |
| `contact_info` | `contacts` (never the values) |
| `matrix` (7.61.00) | `rows: [{code, answered, counts: {column: n}, average}]` in the question's row order (`average`: the mean `score` of the row's answers whose column has one, `null` without), `scored` (whether any column has a score), and, when there are any, `removed_rows: {code: n}` and `removed_columns: {code: n}` (answers naming a row or a column the revision no longer has) |

Each question's `headline` is its primary-language text with any placeholder shown as `[id]` ([Recall](#recall)).

**Link checks** (`link_health`, 7.61.00): whether the links that bring respondents fill the form's hidden fields.
`{responses, hidden: {id: {filled, missing}}, by_channel: {link | iframe | script | unknown: {responses, hidden}},
warnings: [{id, kind, filled, total}]}` over the view's responses (its filters, and test responses only with
`include_test=true`), per declared hidden field. A warning is `never_filled` once at least 5 responses came in and none
had the field, and `mostly_missing` once at least 10 came in and 80 % or more lacked it ("0 of 26 responses had
`customer`: check your link"). Results and the Share tab show them with the link's `hf_<id>=` parameter; the Share
tab's link builder also warns about a hidden field the form recalls that the copied link leaves empty. A hidden value
is never part of the funnel's beacons.

A question id is stable across revisions, so a response to an older revision counts towards the same question,
scored against the question as its own revision had it (the form's `FORMREV#` snapshots, read once per view; since
7.58.00): a rating of 5 given while the question was a 5-star rating is never read as an NPS 5 once it became one,
and an answer to a 1–10 rating since made 1–5 is neither a 1–5 answer nor a skip. Both count under that question's
`earlier_version`, and the card says how many it leaves out. A response that names no revision (a version 1 widget's)
answered revision 1; without a snapshot of its revision a response is read on the current question. A value of
another shape is left out. A version 1 submission always counts as the answers of `q_rating` and `q_text`, the
questions its form became, even once they are removed (then under "Removed questions") or changed. The forms list's
`?include=stats` adds `headline` to each form's stats: its first `nps`, `csat`, `ces` or `rating` question's score
(`{question_id, type, value, count, scale_max}`, `null` without one), read on the current question only (the list
reads no snapshots), and, since
7.55.01, `last_response_at`, the latest counted response's `source_created_at` (absent when none carries one),
and `channels`, per channel a response named (`link`, `iframe`, `script`) its latest one (absent when none did).
`GET /feedback-forms/{id}/stats` answers the same fields.

**Responses**, newest first: `{total, responses: [{response_id, feedback_id?, is_test, created_at, revision,
language, ending_id, answers, hidden, path, sentiment?}], next_cursor}`, 50 per page (`limit` up to 100) from
`cursor`; `include_test` is `false`, `true` or `only` (the Test tab's list). `format=csv` answers the matching
responses (the newest 10,000) as a CSV file, the Results tab's **Download**, in one of two layouts
(`layout=familiar|detailed`, 7.61.00):

- **`familiar`** (the default since 7.61.00): the file Excel and Sheets open as they are. It starts with a UTF-8 BOM
  (accents intact) and has one header row: `Submission ID`, `Submitted On` (ISO 8601, UTC: `2026-11-20T09:30:00Z`),
  `Locale`, `Tags` (the form's tags, and `test` for a test response, joined with `;`), one column per hidden field
  (its label, else its id), then one per question by its primary-language headline (a placeholder shown as `[id]`):
  a matrix one per row (`Headline - Row`), a contact question one per field it shows (`Headline - Name`, `- Email`,
  `- Phone`, `- Company`), and none for a statement. Choices are their labels in the primary language joined with
  `;`, an "Other" text as `Other: …` (the question's Other label, else the localized "Other"); a matrix row's cell is
  its column's label, a consent `Yes`, a score its number. `ids=true` adds a second header row of ids
  (`submission_id`, `submitted_on`, `locale`, `tags`, `hidden.<id>`, `<question id>`, `<question id>.<row code>`,
  `<question id>.<field>`). The file is named `<form-name-slug>-responses-<yyyy-mm-dd>.csv` (the date in UTC; the
  form id when the name gives no slug).
- **`detailed`**: 7.55.00's layout, unchanged for the scripts that read it (no BOM): the time, ids, `is_test`,
  revision, language and ending, one column per question (headlines in the first header row, ids in the second;
  choices by their labels; a matrix as `row: column` pairs) and one per hidden field, named `<form id>-responses.csv`.
  A script that read `format=csv` before 7.61.00 asks for `layout=detailed`.

The Results tab's **Download** takes the familiar file with the view's filters; its menu also offers "Detailed CSV
(for scripts)" and "CSV with a row of ids". A browser cannot read the answer's `Content-Disposition` across origins
(the API exposes only `Content-Type` and `ETag`), so the app names the file itself by the same rule
(`frontend/src/api/feedbackFormsCsv.ts`), a detailed one `<form-name-slug>-responses-<yyyy-mm-dd>-detailed.csv`.

In both, a cell that would start a spreadsheet formula, a header included, is prefixed with `'`. Any other `layout`,
or an `ids` that is not `true` or `false`, is a `400`. Contact details are in Responses and the CSV (as the
submissions route shows text), never in Results.

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
  hidden or left, naming the furthest question shown; sent again only when the respondent came back and reached
  further (since 7.58.00; before, one per page load, so the server never saw them go further), never once per tab
  switch. A respondent who submits sends their path with the response instead.

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
`funnel: {opened, left: {question_id: n}, completed}` (a question whose total is not above 0 is left out), its counts
within the view's dates. Under a language, ending or hidden-value filter they answer `funnel: null` (since 7.58.00):
the counters know none of them, and filtered completions against every visit's opens would read as a drop. The page
then shows neither the funnel nor Completion; Reach says why.

The funnel is advisory. Both signals come from a public route, so anyone who can open the form can add opens and
`left` counts under made-up sessions, within the events route's throttle. That is also its cost bound: an
anonymous caller can write at most one visit row per beacon, so 100 req/s sustained is about 8.6 million visit rows a
day (pay-per-use writes and storage, gone after 7 days) and the counters of the forms it names; nothing it sends is
ever read back, queued or sent to a model. A per-form cap would bound it further (a follow-up, like the submit
route's). A counter and its visit row are two writes, best effort, so one that fails costs a count. Read the
drop-off as a trend next to the responses, not as an audited count.

**Reading it with logic (7.55.01).** Results' summary line gives the completion and the largest drop ("Completion
48 % · largest drop at Q2", a link to the funnel). A drop is measured only between steps every path passes
(`results/funnelSteps.ts`: a question whose ways in times ways out equal all the form's paths); a question that only
some paths show says "on some paths only" and never carries a drop, since few people reach it by design. Its count
is the people it was shown to, a lower bound, because the paths of those who left are not recorded past it.

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
prompt carries the schema's types (the matrix since 7.61.00), ops, limits and recall, and the templates' flows as
examples (a workshop's feedback with a matrix and `{{event}}` among them); the person's text
travels in a `form_brief` DATA block and their form in a `current_form` one, never as instructions. Its answer
goes through the same validator as a save, after the server has made the ids and option codes itself (slugged,
accents folded, de-duplicated, `other` / `none` renamed; since 7.61.00 a matrix's row and column codes too; the rules,
and every recall placeholder, re-pointed at them) and dropped every address
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
  failed half-way is retried, with the first attempt's count. The deployment's delete stays idempotent: an unknown
  id answers success and records nothing.

Both rows also say how many of the form's test responses the delete removes with it: `test_responses_deleted` (0
when it has none; never their content). Their keys are read first, counted on the row, and then those same keys are
deleted. The delete then removes the form's revision snapshots, test responses and funnel rows, and the form. Its real
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

The widget file a script embed loads is not an API route: it is a static file of the app's own CloudFront distribution, with its own CORS (any origin, GET and HEAD, no credentials; [The script embed](#the-script-embed)).

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
