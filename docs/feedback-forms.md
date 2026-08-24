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
