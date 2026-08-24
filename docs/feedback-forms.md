# Feedback Forms

Feedback Forms allow you to collect customer feedback directly through embeddable forms on your website or application.

## Overview

The VoC platform provides a customizable feedback form system that:

- Embeds on any website via iframe or JavaScript widget
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

### Option 1: Iframe

```html
<iframe 
  src="https://your-api.execute-api.region.amazonaws.com/v1/feedback-forms/{form_id}/iframe"
  width="100%" 
  height="500" 
  frameborder="0">
</iframe>
```

### Option 2: JavaScript Widget

```html
<div id="voc-feedback-form"></div>
<script src="https://your-api.execute-api.region.amazonaws.com/v1/feedback-forms/{form_id}/widget.js"></script>
<script>
  VoCFeedbackForm.init({
    container: '#voc-feedback-form',
    apiEndpoint: 'https://your-api.execute-api.region.amazonaws.com/v1',
    formId: '{form_id}'
  });
</script>
```

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

| Route | Rate / burst |
|-------|--------------|
| `GET /feedback-forms/{id}/config` | 100 req/s, burst 200 |
| `GET /feedback-forms/{id}/iframe` | 100 req/s, burst 200 |
| `POST /feedback-forms/{id}/submit` | 20 req/s, burst 40 |

`submit` is the tighter one because each submission enqueues a record that drives
Comprehend, Translate and a Bedrock model invocation downstream. The two reads are
cheap — one `get_item`, and a static HTML render — so they are held at the higher
pair, sized for widget page-view traffic rather than for submissions.

Two properties surprise people:

- **A limit is per route, not per form or per caller.** The method setting keys on
  the path with the form id left as a variable, so one ceiling is shared across
  every form in the deployment and every visitor. 100 req/s is therefore the
  *aggregate* widget page-view rate a deployment supports, across all embeds.
- **A throttled request looks like a disabled form.** On a 429 the widget renders
  a flat `Feedback form unavailable.` with no retry, which is the same message a
  deliberately disabled form produces. If a busy page shows that intermittently,
  suspect the rate limit before the form's state; the fix is raising the number in
  `api-stack.ts`, not a change on the page.

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
