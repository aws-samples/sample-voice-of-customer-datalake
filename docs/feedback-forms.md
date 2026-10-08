# Feedback Forms

Feedback Forms allow you to collect customer feedback directly through embeddable forms on your website or application.

## Overview

The VoC platform provides a customizable feedback form system that:

- Embeds on any website via an iframe
- Supports multiple forms with different configurations
- Routes feedback directly to the processing pipeline
- Allows pre-categorization for targeted feedback collection

## Creating a Feedback Form

### Via the Dashboard

1. Navigate to **Feedback Forms** in the main sidebar
2. Click **Create New Form**
3. Configure the form settings:
   - **Name**: Internal identifier for the form
   - **Title**: Displayed heading on the form
   - **Description**: Subtitle text
   - **Question**: The main prompt for feedback
   - **Rating Type**: Stars (1-5), Emoji, or Numeric (1-10)
4. Save, then enable the form

New forms are created **disabled** on purpose: nothing is public until the owner
says so. Until it is enabled, the form's link, iframe and embed render
`Feedback form unavailable.`, and `POST /submit` refuses submissions. The page
says this right after the create (a notice naming the form, with **Enable now**),
and every disabled form's card repeats it with an **Enable now** button; the
toggle on the card does the same.

### Form Configuration Options

| Option | Description |
|--------|-------------|
| `title` | Main heading displayed on the form |
| `description` | Subtitle or context text |
| `question` | The feedback prompt |
| `placeholder` | Placeholder text in the textarea |
| `rating_enabled` | Show/hide rating input |
| `rating_type` | `stars`, `emoji`, or `numeric` |
| `rating_max` | Maximum rating value (default: 5) |
| `collect_email` | Ask for email address |
| `collect_name` | Ask for name |
| `category` | Pre-assign category for all submissions |
| `subcategory` | Pre-assign subcategory |
| `success_message` | Message shown after submission |
| `theme` | Color and styling options |
| `project_id` | Optional. The project this form collects feedback about. Empty string means the form validates nothing in particular — a standalone website survey. |
| `dimension_defaults` | Optional. `{key: value}` dimension values every submission gets ([dimensions.md](dimensions.md)). These **win** over the embed's `dimensions` option for every key they set |
| `tags` | Optional. Tags every submission gets |
| `document_id` | Optional. A specific PRD or PR/FAQ within that project. Empty string means the whole project, which is also what keeps the link alive across a regeneration (regenerating a document mints a new `document_id`). |

`project_id` and `document_id` are internal identifiers. They exist so the
Prioritization page can show the ratings a form collected next to the document
being scored. Both are accepted by `POST`/`PUT` and returned by
`GET /feedback-forms/{id}`, but deliberately **never** by the public config
endpoint — see the note in [API Endpoints](#api-endpoints).

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
needs loading.

The page is only served for a form that exists (an unknown id is a `404`, a
disabled form still gets its page so the widget can say it is unavailable), every
value placed in its `<script>` is serialised with `json.dumps` and HTML-inert
escaping rather than interpolated, and it is sent with a
`Content-Security-Policy` (`default-src 'none'`, inline script/style only,
`connect-src 'self'`; no `frame-ancestors`, because the page exists to be
framed) plus `X-Content-Type-Options: nosniff` and `Referrer-Policy: no-referrer`.
See [Public route input limits](#public-route-input-limits) for the id format.

**The `dimensions` embed option.** `VoCFeedbackForm.init({..., dimensions: {user_type:
'partner'}})` sends up to 10 string/number values with each submission. The embed runs on
a page anyone can edit, so it may only fill keys the form has **no** `dimension_defaults`
for: a key the form sets keeps the form's value. Unknown keys and disallowed values are
dropped by the processor.

The submitter's `email` is stored lower-cased, so an erasure by email matches however it
was typed.

There is no standalone `widget.js` script to load. That path is registered
nowhere — not by the handler and not by the API — so a
`<script src=".../widget.js">` tag never reaches the application at all and gets
a `403 Missing Authentication Token` back from API Gateway, not the widget. The
403 means "no such route" here rather than "not allowed": per-form paths are
declared one by one instead of behind a catch-all, so an unregistered one has
nothing to answer it.

## Pre-Categorization

Forms can be configured to automatically assign a category to all submissions. This is useful for:

- **Product-specific forms**: Embed on product pages with category pre-set
- **Support forms**: Route directly to support category
- **Feature request forms**: Categorize as feature requests

Set the `category` and `subcategory` fields in the form configuration.

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
| GET | `/feedback-forms` | List all forms |
| POST | `/feedback-forms` | Create a new form |
| GET | `/feedback-forms/{id}` | Get form details |
| PUT | `/feedback-forms/{id}` | Update form |
| DELETE | `/feedback-forms/{id}` | Delete form |
| GET | `/feedback-forms/{id}/config` | Public config endpoint. **Unauthenticated** and fetched cross-origin by the embedded widget, so it returns only the widget-rendering fields, via a separate allowlist (`item_to_widget_config` in `lambda/api/feedback_form_handler.py`) rather than the projection the authenticated routes use. It never returns internal identifiers such as `project_id` / `document_id`. |
| POST | `/feedback-forms/{id}/submit` | Submit feedback |
| GET | `/feedback-forms/{id}/iframe` | Embeddable HTML page |

### Rate limits on the three public routes

The three unauthenticated routes carry per-method rate limits, set as API Gateway
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

`submit` is the tighter one because each submission enqueues a record that drives
Comprehend, Translate and a Bedrock model invocation downstream. The two reads are
cheap — one `get_item`, and a static HTML render — so they are held at the higher
pair, sized for widget page-view traffic rather than for submissions.

These figures are **pinned against the synthesized template** by a lockstep case in
`voc-datalake/lib/stacks/api-stack.test.ts`, so tuning the numbers in `api-stack.ts`
without updating this table fails the CDK suite. The stack is the source of truth;
this table cannot silently go stale.

Two properties surprise people:

- **A limit is per route, not per form or per caller.** The method setting keys on
  the path with the form id left as a variable, so one ceiling is shared across
  every form in the deployment and every visitor. 100 req/s is therefore the
  *aggregate* widget page-view rate a deployment supports, across all embeds.
- **A throttled request never names the limit, and each of the three routes fails
  differently.** Nothing surfaces "429" to the visitor, so all three symptoms are
  easy to misattribute:

  | Route | What a 429 looks like |
  |-------|-----------------------|
  | `GET /config` | The widget renders a flat `Failed to load form.` in the container, with no retry. The gateway's 429 carries your deployment's frontend origin, not `*`, so the widget on a customer's site cannot read it and treats it as a network failure (a dev deployment, whose origin is `*`, shows `Feedback form unavailable.` instead — the same message a disabled form produces) |
  | `POST /submit` | A modal `Failed to submit.` alert instead, with the visitor's typed feedback still in the form. Retryable: they can press submit again |
  | `GET /iframe` | No widget code runs at all — the browser navigates here directly, so this is a raw API Gateway error page inside your `<iframe>`, i.e. a broken frame |

  If a busy page shows any of these intermittently, suspect the rate limit before
  the form's state; the fix is raising the number in `api-gateway.ts`, not a change
  on the page.

## Processing Pipeline

Submitted feedback follows the same processing pipeline as other data sources:

1. **Submission** → Form validates and sends to SQS queue
2. **Processing** → Lambda enriches with LLM analysis
3. **Storage** → Saved to DynamoDB with full metadata
4. **Display** → Appears in dashboard with `feedback_form` source

The `source_channel` field identifies which form the feedback came from (e.g., `form_abc123`).

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

The three public routes check their input before reading the table, so a
malformed request costs no DynamoDB read, no queue message and no Bedrock call.

**Form id** (`config`, `submit`, `iframe`): 1–64 characters from
`[0-9A-Za-z_.-]`, and not exactly `.` or `..`. Anything else is a `404 Form not
found`, the same answer as an unknown id. Every id the service mints matches: the
8-hex-character ids of dashboard forms and the `pf_…` ids of prototype pin forms,
and so do hand-seeded ids such as `website-form` or `acme.website`. If you seeded
a form row by hand with any other character in its id (a space, `:`, `@`, `+`,
`%`, `~`, a quote or a non-ASCII letter), rename it before upgrading: its public
routes now answer `404`.

**Submission body** (`POST /submit`). Each limit is checked separately, and a
`400` names the field and the limit:

| Field | Limit |
|---|---|
| `text` | required, a string, at most 10,000 characters after trimming |
| `name` | optional (`null` allowed), a string of at most 200 characters |
| `email` | optional (`null` allowed), a string of at most 254 characters |
| `page_url` | optional (`null` allowed), a string of at most 4,096 characters |
| `custom_fields` | optional, an object of at most 20 entries; keys 1–64 characters; values a string of at most 1,000 characters, a number, a boolean or `null` |

The form configuration has no text-length setting of its own, so these constants
(`MAX_SUBMISSION_TEXT_CHARS` and the others in `feedback_form_handler.py`) are the
only limit. The bundled widget sends `text`, `rating`, `name`, `email` and
`page_url`, all well inside them. Prototype pin submissions also have the tighter
caps in `shared/prototype_pins.py`.

## Access to form management

Any authenticated user may create, update and delete feedback forms. This is the
owner's decision, because the Feedback Forms page is open to every user. The routes
are deliberately not admin-gated, and they have no per-form ownership check. The
public routes are protected by the input validation above.

## CORS Configuration

The three public endpoints intentionally allow cross-origin requests from any origin so the widget can be embedded on customer-owned sites. `FeedbackFormApi` therefore uses `ALLOWED_ORIGIN=*`; changing the Lambda environment variable alone is not a supported per-form origin policy.

The security boundary is the narrow public route set (`config`, `iframe`, and `submit`), strict response projection, input validation, and the per-route throttles above. All form management, submission reads, and statistics routes require Cognito authentication. If a deployment needs an origin allowlist, implement and test it as an API change that preserves the intended embed sites rather than editing the deployed environment by hand.

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
(`lambda/shared/static/prototype-pin-widget.js`: no third-party code, no network) that
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
in the widget and again on the server.

The prototype's CSP has no `connect-src`, so the widget cannot reach the API itself.
It hands the pin to its host frame with `postMessage` (same origin only). The VoC
prototype viewer validates the message and submits it through the **existing public
submit route**, under that route's existing rate limit. The limits did not change.
The consequence is that a tester leaves pins from inside the app. A prototype opened
standalone shows a notice saying where to open it.

**Storage.** A pin goes to the aggregates table (`PINS#{form_id}` / `PIN#{pin_id}`).
The public route's Lambda already had read-write access there, and it is deliberately
not granted the projects table. Pins are never sent to the processing queue (a tester
is not customer voice, and a pin should not cost a model call), and their content is
never logged. The server type-checks and size-caps every field, rejects bodies over
24 KB, and screens the comment for prompt injection. A flagged pin is stored but
kept away from the agents.

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

Known limits: duplicating a prototype document copies its HTML, so pins on the copy
go to the original's form. No screenshots are captured.
