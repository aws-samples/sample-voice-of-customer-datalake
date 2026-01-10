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
| GET | `/feedback-forms/{id}/config` | Public config endpoint |
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
