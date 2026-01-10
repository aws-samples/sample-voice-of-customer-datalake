# Scrapers

The Scrapers feature allows you to collect customer feedback from web pages using configurable extraction rules.

## Overview

Scrapers provide a way to:

- Extract reviews and feedback from web pages
- Use CSS selectors or JSON-LD structured data
- Schedule automatic data collection
- Auto-detect extraction patterns using AI

## Creating a Scraper

### Via the Dashboard

1. Navigate to **Scrapers** in the sidebar
2. Click **Create Scraper**
3. Choose a template or start from scratch
4. Configure the extraction rules
5. Test and save

### Scraper Configuration

```json
{
  "id": "unique_scraper_id",
  "name": "My Scraper",
  "url": "https://example.com/reviews",
  "enabled": true,
  "extraction_method": "css",
  "container_selector": ".review-item",
  "text_selector": ".review-text",
  "rating_selector": ".star-rating",
  "author_selector": ".reviewer-name",
  "date_selector": ".review-date",
  "pagination": {
    "enabled": true,
    "param": "page",
    "max_pages": 10,
    "start": 1
  }
}
```

## Extraction Methods

### CSS Selectors

Use CSS selectors to target specific elements:

| Selector | Description |
|----------|-------------|
| `container_selector` | Parent element containing each review |
| `text_selector` | Element with the review text |
| `rating_selector` | Element with the rating value |
| `author_selector` | Element with the author name |
| `date_selector` | Element with the review date |

### JSON-LD Structured Data

Many sites include structured data in JSON-LD format. The scraper can automatically extract reviews from this data:

```json
{
  "extraction_method": "jsonld",
  "template": "review_jsonld"
}
```

## Templates

Pre-configured templates for common patterns:

| Template | Description |
|----------|-------------|
| `review_jsonld` | Extract from JSON-LD structured data |
| `custom_css` | Custom CSS selector configuration |

## AI-Assisted Configuration

The **Analyze URL** feature uses AI to automatically detect CSS selectors:

1. Enter the URL you want to scrape
2. Click **Analyze**
3. The system fetches the page and uses an LLM to identify review patterns
4. Review and adjust the suggested selectors

## Pagination

Configure pagination to collect reviews across multiple pages:

```json
{
  "pagination": {
    "enabled": true,
    "param": "page",
    "max_pages": 10,
    "start": 1
  }
}
```

This appends `?page=1`, `?page=2`, etc. to the URL.

## Running Scrapers

### Manual Run

Click **Run Now** on any scraper to trigger immediate execution.

### Scheduled Runs

Scrapers run automatically based on the webscraper plugin schedule (configured in the plugin manifest).

## Run History

View the history of scraper runs including:

- **Status**: Running, completed, or failed
- **Pages scraped**: Number of pages processed
- **Items found**: Number of reviews extracted
- **Errors**: Any issues encountered

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/scrapers` | List all scrapers |
| POST | `/scrapers` | Create/update scraper |
| DELETE | `/scrapers/{id}` | Delete scraper |
| GET | `/scrapers/templates` | Get available templates |
| POST | `/scrapers/{id}/run` | Trigger manual run |
| GET | `/scrapers/{id}/status` | Get latest run status |
| GET | `/scrapers/{id}/runs` | Get run history |
| POST | `/scrapers/analyze-url` | AI-assisted selector detection |

## Processing Pipeline

Scraped data follows the standard processing pipeline:

1. **Extraction** → Scraper fetches and parses web pages
2. **Normalization** → Data converted to standard format
3. **Queue** → Sent to SQS processing queue
4. **Enrichment** → LLM analysis adds insights
5. **Storage** → Saved to DynamoDB and S3

## Deduplication

The system uses deterministic IDs to prevent duplicate entries:

- If the source provides an ID, it's used directly
- Otherwise, a hash is generated from: `created_at + text_hash + url`

This ensures the same review scraped on different days is deduplicated.

## Security

URL validation prevents SSRF (Server-Side Request Forgery) attacks:

- Only `http://` and `https://` schemes allowed
- Blocked: localhost, private IP ranges, link-local addresses
- Hostname resolution checked against blocked ranges

## Best Practices

1. **Respect rate limits**: Don't scrape too frequently
2. **Check robots.txt**: Ensure scraping is allowed
3. **Use specific selectors**: More specific = more reliable
4. **Test before scheduling**: Verify extraction works correctly
5. **Monitor run history**: Check for errors and adjust as needed
