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

1. Navigate to **Settings** → **Feedback Forms**
2. Click **Create New Form**
3. Configure the form settings:
   - **Name**: Internal identifier for the form
   - **Title**: Displayed heading on the form
   - **Description**: Subtitle text
   - **Question**: The main prompt for feedback
   - **Rating Type**: Stars (1-5), Emoji, or Numeric (1-10)
4. Save and enable the form

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

It answers **404 both for a form id the service could not have issued and for one
that is not in the table** — the same answer for either, so the response tells an
anonymous caller nothing about which. This is the only route in the API that
returns HTML, on the API's own origin, and its page is framed on third-party
sites, so the id is format-checked before any read and every value written into
the page's script is serialized with `json.dumps` rather than quoted by hand
(issue #379). If an embed that used to work starts showing an error frame, check
that the form still exists before suspecting the
[rate limits](#rate-limits-on-the-three-public-routes).

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

Customize the form appearance:

```json
{
  "theme": {
    "primary_color": "#3B82F6",
    "background_color": "#FFFFFF",
    "text_color": "#1F2937",
    "border_radius": "8px"
  }
}
```

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
stage method settings in `voc-datalake/lib/stacks/api-stack.ts`. They are worth
knowing before you embed the widget, because they are observable from your page:

<!-- These figures are LOCKSTEPPED against the stack: `the public feedback-form
     routes` in voc-datalake/lib/stacks/api-stack.test.ts parses every line here
     that names a route and states a rate, and fails if it disagrees with what
     api-stack.ts deploys. So edit them only alongside the stack.

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
cheap — one `get_item` each, and for `iframe` a static HTML render on top of it —
so they are held at the higher pair, sized for widget page-view traffic rather
than for submissions.

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
  | `GET /config` | The widget renders a flat `Feedback form unavailable.` in the container, with no retry — the *same* message a deliberately disabled form produces |
  | `POST /submit` | A modal `Failed to submit.` alert instead, with the visitor's typed feedback still in the form. Retryable: they can press submit again |
  | `GET /iframe` | No widget code runs at all — the browser navigates here directly, so this is a raw API Gateway error page inside your `<iframe>`, i.e. a broken frame |

  If a busy page shows any of these intermittently, suspect the rate limit before
  the form's state; the fix is raising the number in `api-stack.ts`, not a change
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

## CORS Configuration

The feedback form endpoints allow cross-origin requests by default to support embedding on external websites. To restrict origins, set the `ALLOWED_ORIGIN` environment variable on the Lambda function.
